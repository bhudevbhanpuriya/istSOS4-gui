// Copyright 2026 SUPSI
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @file asOfAdapter.ts
 *
 * Adapter layer for the As-Of (time-travel) feature.
 *
 * This file provides a single `activeAdapter` that is used by `useAsOfThing`
 * and `useAsOfCommits`. It abstracts two implementations:
 *
 *  - `mockAdapter`  — resolves data from local dummy things (for dev/demo).
 *  - `apiAdapter`   — calls the real backend `$as_of` API endpoint.
 *
 * To switch from mock → real:
 *   Set `NEXT_PUBLIC_VERSIONING_ENABLED=true` in your `.env` file.
 *
 * No hook code needs to change — only this env variable.
 */

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

import type { Thing } from '@/types/domain'
import { getDataSourceToken } from '@/lib/dataSourceTokens'
import {
  localDummyThings,
  type LocalTimeTravelVersion,
} from '@/config/local-dummy-things'

dayjs.extend(utc)

// ---------------------------------------------------------------------------
// Shared Types (re-exported so hooks import from one place)
// ---------------------------------------------------------------------------

export type AsOfCommit = {
  id: string
  /** ISO-8601 UTC datetime of this commit */
  authoredAt: string
  message: string
}

export type ExistenceState = 'exists' | 'not-yet-created' | 'deleted'

export type ResolvedThing = {
  thing: Thing | null
  existenceState: ExistenceState
  existenceRange: { createdAt: string | null; deletedAt: string | null }
}

// ---------------------------------------------------------------------------
// Adapter Interface
// ---------------------------------------------------------------------------

export interface AsOfAdapter {
  /**
   * Resolve a Thing's state at a given point in time.
   *
   * @param thing     - The live Thing object (needed for endpoint URL and
   *                    fallback data when real API is unavailable).
   * @param asOfDate  - ISO-8601 UTC date string to resolve state at.
   * @returns A `ResolvedThing` describing what existed at that moment.
   */
  resolveThing(thing: Thing, asOfDate: string): Promise<ResolvedThing>

  /**
   * Fetch the ordered commit history for a Thing.
   * Used to populate timeline scrubber tick marks.
   *
   * @param thing - The live Thing object.
   * @returns Commits sorted oldest → newest.
   */
  fetchCommits(thing: Thing): Promise<AsOfCommit[]>
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function thingId(thing: Thing): string {
  return String(thing['@iot.id'] ?? thing.id ?? '')
}

/** Build auth headers if a token is stored for this endpoint. */
function buildHeaders(endpoint: string): HeadersInit {
  const token = getDataSourceToken(endpoint)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ---------------------------------------------------------------------------
// Version resolution helpers (used by mockAdapter)
// ---------------------------------------------------------------------------

function resolveVersionForDate(
  versions: LocalTimeTravelVersion[],
  asOfDate: string
): LocalTimeTravelVersion | null {
  const target = dayjs.utc(asOfDate)
  if (!target.isValid()) return null

  for (const version of versions) {
    const [from, to] = version.systemTimeValidity
    const fromDt = dayjs.utc(from)
    const toDt = to ? dayjs.utc(to) : null
    const afterFrom = target.isAfter(fromDt) || target.isSame(fromDt)
    const beforeTo = toDt ? target.isBefore(toDt) : true
    if (afterFrom && beforeTo) return version
  }
  return null
}

function resolveExistenceState(
  versions: LocalTimeTravelVersion[],
  asOfDate: string
): ExistenceState {
  if (versions.length === 0) return 'exists'
  const target = dayjs.utc(asOfDate)
  const earliest = dayjs.utc(versions[0].systemTimeValidity[0])
  if (target.isBefore(earliest)) return 'not-yet-created'
  const last = versions[versions.length - 1]
  const lastEnd = last.systemTimeValidity[1]
  if (lastEnd && target.isAfter(dayjs.utc(lastEnd))) return 'deleted'
  return 'exists'
}

function extractExistenceRange(
  versions: LocalTimeTravelVersion[]
): { createdAt: string | null; deletedAt: string | null } {
  if (versions.length === 0) return { createdAt: null, deletedAt: null }
  const createdAt = versions[0].systemTimeValidity[0] ?? null
  const lastEnd = versions[versions.length - 1].systemTimeValidity[1] ?? null
  return { createdAt, deletedAt: lastEnd }
}

function applyVersionToThing(baseThing: Thing, version: LocalTimeTravelVersion): Thing {
  const versionStart = dayjs.utc(version.systemTimeValidity[0])
  const patchedDatastreams = (baseThing.Datastreams ?? []).map((ds) => {
    const filteredObs = (ds.Observations ?? []).filter((obs) => {
      const t = dayjs.utc(obs.phenomenonTime ?? obs.resultTime ?? '')
      return t.isValid() && (t.isBefore(versionStart) || t.isSame(versionStart))
    })
    const patchedSensor =
      version.sensor && ds.Sensor ? { ...ds.Sensor, name: version.sensor } : ds.Sensor

    return {
      ...ds,
      Sensor: patchedSensor,
      Observations: filteredObs.length > 0 ? filteredObs : ds.Observations?.slice(-1) ?? [],
    }
  })

  return {
    ...baseThing,
    name: version.name ?? baseThing.name,
    description: version.description ?? baseThing.description,
    Datastreams: patchedDatastreams,
  }
}

/** Infer existence range from datastream phenomenonTime when no version history exists. */
function inferExistenceRange(
  thing: Thing
): { createdAt: string | null; deletedAt: string | null } {
  const datastreams = thing.Datastreams ?? []
  let earliest: ReturnType<typeof dayjs.utc> | null = null
  for (const ds of datastreams) {
    const pt = ds.phenomenonTime
    if (!pt) continue
    const startRaw = pt.split('/')[0]
    if (!startRaw) continue
    const start = dayjs.utc(startRaw)
    if (start.isValid() && (!earliest || start.isBefore(earliest))) earliest = start
  }
  return { createdAt: earliest ? earliest.toISOString() : null, deletedAt: null }
}

// ---------------------------------------------------------------------------
// mockAdapter — reads from local-dummy-things.ts
// ---------------------------------------------------------------------------

const mockAdapter: AsOfAdapter = {
  async resolveThing(thing, asOfDate) {
    const id = thingId(thing)
    const dummyMatch = localDummyThings.find(
      (d) => String(d['@iot.id'] ?? d.id ?? '') === id
    )

    if (dummyMatch?.properties?.timeTravel?.versions) {
      const versions = dummyMatch.properties.timeTravel.versions
      const version = resolveVersionForDate(versions, asOfDate)
      const existenceRange = extractExistenceRange(versions)

      if (version) {
        return {
          thing: applyVersionToThing(thing, version),
          existenceState: 'exists',
          existenceRange,
        }
      }

      return {
        thing: { ...thing, Datastreams: [] },
        existenceState: resolveExistenceState(versions, asOfDate),
        existenceRange,
      }
    }

    // Real thing in mock mode — infer range from phenomenonTime
    const existenceRange = inferExistenceRange(thing)
    if (existenceRange.createdAt) {
      const target = dayjs.utc(asOfDate)
      const earliest = dayjs.utc(existenceRange.createdAt)
      if (target.isBefore(earliest)) {
        return {
          thing: { ...thing, Datastreams: [] },
          existenceState: 'not-yet-created',
          existenceRange,
        }
      }
    }

    return { thing, existenceState: 'exists', existenceRange }
  },

  async fetchCommits(thing) {
    const id = thingId(thing)
    const dummyMatch = localDummyThings.find(
      (d) => String(d['@iot.id'] ?? d.id ?? '') === id
    )

    if (dummyMatch?.properties?.timeTravel?.commits) {
      return [...dummyMatch.properties.timeTravel.commits].sort(
        (a, b) => dayjs.utc(a.authoredAt).valueOf() - dayjs.utc(b.authoredAt).valueOf()
      )
    }

    return []
  },
}

// ---------------------------------------------------------------------------
// apiAdapter — calls the real backend $as_of endpoint
//
// Backend Commit shape (from GET /Things(id)/Commit):
//   { "@iot.id": 2, "author": "/Users(1)", "message": "...", "date": "...", "actionType": "CREATE" }
//
// NOTE: Backend uses `date`, frontend type uses `authoredAt`. We map here.
// ---------------------------------------------------------------------------

type BackendCommit = {
  '@iot.id': number | string
  message: string
  /** ISO date string — maps to AsOfCommit.authoredAt */
  date: string
  actionType: string
}

/**
 * Fetch a Thing's commit history (transaction-time events). Prefers the plural
 * `/Commits` collection (full history) and falls back to the singular `/Commit`
 * (creation commit only) on backends that don't expose the collection.
 */
async function fetchThingCommits(
  endpoint: string,
  id: string
): Promise<BackendCommit[]> {
  const pluralUrl = `${endpoint}/Things(${id})/Commits?$select=@iot.id,message,date,actionType`
  try {
    const res = await fetch(pluralUrl, {
      headers: buildHeaders(endpoint),
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data?.value)) return data.value as BackendCommit[]
    }
  } catch {
    // Ignore and try the singular endpoint below.
  }

  const singularUrl = `${endpoint}/Things(${id})/Commit`
  try {
    const res = await fetch(singularUrl, {
      headers: buildHeaders(endpoint),
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    if (Array.isArray(data?.value)) return data.value as BackendCommit[]
    if (data?.['@iot.id'] != null) return [data as BackendCommit]
    return []
  } catch {
    return []
  }
}

/**
 * Derive a Thing's existence range from its COMMIT history — i.e. transaction
 * time, which is the axis `$as_of` filters on. This is the correct source for
 * "not-yet-created vs deleted", unlike phenomenonTime (when measurements were
 * taken), which can be years off from when the row was actually written.
 */
function existenceRangeFromCommits(commits: BackendCommit[]): {
  createdAt: string | null
  deletedAt: string | null
} {
  if (commits.length === 0) return { createdAt: null, deletedAt: null }
  const sorted = [...commits].sort(
    (a, b) => dayjs.utc(a.date).valueOf() - dayjs.utc(b.date).valueOf()
  )
  const createdAt = sorted[0]?.date ?? null
  const deleteCommit = [...sorted]
    .reverse()
    .find((c) => String(c.actionType).toUpperCase() === 'DELETE')
  return { createdAt, deletedAt: deleteCommit?.date ?? null }
}

const apiAdapter: AsOfAdapter = {
  async resolveThing(thing, asOfDate) {
    const id = thingId(thing)
    const endpoint = (thing.__sourceEndpoint ?? '').replace(/\/$/, '')
    if (!endpoint) {
      return { thing, existenceState: 'exists', existenceRange: { createdAt: null, deletedAt: null } }
    }

    const expand = [
      'Datastreams($expand=Network,Sensor,ObservedProperty,Observations($top=1;$orderby=phenomenonTime desc))',
      'Locations',
    ].join(',')

    const url = `${endpoint}/Things(${id})?$as_of=${encodeURIComponent(asOfDate)}&$expand=${expand}`

    try {
      const res = await fetch(url, {
        headers: buildHeaders(endpoint),
        cache: 'no-store',
      })

      if (res.status === 404) {
        // The backend returns 404 when the thing didn't exist at that time.
        // Determine "not-yet-created vs deleted" from the COMMIT history
        // (transaction time — the axis $as_of filters on), NOT phenomenonTime.
        // Falls back to phenomenonTime only when no commit history is available.
        const commits = await fetchThingCommits(endpoint, id)
        const existenceRange =
          commits.length > 0
            ? existenceRangeFromCommits(commits)
            : inferExistenceRange(thing)
        const target = dayjs.utc(asOfDate)
        const createdAt = existenceRange.createdAt
          ? dayjs.utc(existenceRange.createdAt)
          : null
        const existenceState: ExistenceState =
          createdAt && target.isBefore(createdAt) ? 'not-yet-created' : 'deleted'
        return { thing: { ...thing, Datastreams: [] }, existenceState, existenceRange }
      }

      if (!res.ok) {
        // Unexpected error — fall back to live thing to avoid blank UI
        console.warn(`[asOfAdapter] $as_of fetch failed (${res.status}) for Thing(${id})`)
        return { thing, existenceState: 'exists', existenceRange: { createdAt: null, deletedAt: null } }
      }

      const data = await res.json()
      return {
        thing: data as Thing,
        existenceState: 'exists',
        existenceRange: inferExistenceRange(data as Thing),
      }
    } catch (err) {
      console.warn('[asOfAdapter] Network error resolving thing:', err)
      return { thing, existenceState: 'exists', existenceRange: { createdAt: null, deletedAt: null } }
    }
  },

  async fetchCommits(thing) {
    const id = thingId(thing)
    const endpoint = (thing.__sourceEndpoint ?? '').replace(/\/$/, '')
    if (!endpoint) return []

    // Full history via the plural /Commits collection (falls back to the
    // singular creation commit on older backends). Mapped oldest → newest so
    // the scrubber can place a tick per commit.
    const commits = await fetchThingCommits(endpoint, id)
    return commits
      .filter((commit) => !!commit?.date)
      .map((commit) => ({
        id: String(commit['@iot.id']),
        // Backend field is `date`, our type uses `authoredAt`
        authoredAt: commit.date,
        message: commit.message,
      }))
      .sort(
        (a, b) => dayjs.utc(a.authoredAt).valueOf() - dayjs.utc(b.authoredAt).valueOf()
      )
  },
}

// ---------------------------------------------------------------------------
// Active adapter — controlled by env variable
// ---------------------------------------------------------------------------

/**
 * Set `NEXT_PUBLIC_VERSIONING_ENABLED=true` in `.env` to switch from
 * mock data to the real backend `$as_of` API.
 *
 * Default: `false` (mock mode — works with no backend).
 */
const VERSIONING_ENABLED =
  process.env.NEXT_PUBLIC_VERSIONING_ENABLED === 'true'

export const activeAdapter: AsOfAdapter = VERSIONING_ENABLED ? apiAdapter : mockAdapter

/** Expose flag so components can show debug hints in development. */
export const isVersioningEnabled = VERSIONING_ENABLED
