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
 * @file server/as-of/read.ts
 *
 * Server-side reads for the As-Of (time-travel) feature.
 *
 * These run inside the Next server, never in the browser. That is the whole
 * point: the API is reached over the Docker network name configured in
 * NEXT_PUBLIC_ISTSOS4_URL, which a browser cannot resolve, and the API sends no
 * CORS headers — so a direct client-side `$as_of` fetch always fails and the
 * snapshot silently degrades to live data. Route handlers call these instead.
 */

import { cookies } from 'next/headers'

import {
  getPrimaryDataSource,
  readDataSourcesConfigFile,
} from '@/server/data-sources/config'

/** Commit shape as returned by the backend (`date`, not `authoredAt`). */
export type BackendCommit = {
  '@iot.id': number | string
  message: string
  date: string
  actionType: string
}

export const normalizeApiRoot = (value: string) =>
  value.trim().replace(/\/+$/, '')

/** The expand a snapshot Thing needs to fill the datastream table. */
const THING_EXPAND = [
  'Datastreams($expand=Network,Sensor,ObservedProperty,Observations($top=1;$orderby=phenomenonTime desc))',
  'Locations',
].join(',')

/**
 * Resolves a client-supplied endpoint against the configured data sources.
 *
 * Only endpoints this deployment is configured to talk to are accepted — the
 * route must never become an open proxy for arbitrary URLs. Returns null when
 * the endpoint is not one of ours.
 */
export async function resolveConfiguredEndpoint(
  requested?: string | null
): Promise<string | null> {
  const sources = await readDataSourcesConfigFile()
  const normalizedRequested = requested ? normalizeApiRoot(requested) : ''

  if (!normalizedRequested) {
    return normalizeApiRoot(getPrimaryDataSource(sources).apiRoot)
  }

  const match = sources.find(
    (source) => normalizeApiRoot(source.apiRoot) === normalizedRequested
  )
  return match ? normalizeApiRoot(match.apiRoot) : null
}

/** Bearer token for the request: the caller's, falling back to the cookie. */
export async function resolveAuthHeaders(
  token?: string | null
): Promise<Record<string, string>> {
  const explicit = typeof token === 'string' ? token.trim() : ''
  if (explicit) return { Authorization: `Bearer ${explicit}` }

  const cookieStore = await cookies()
  const cookieToken = cookieStore.get('token')?.value ?? ''
  return cookieToken ? { Authorization: `Bearer ${cookieToken}` } : {}
}

export type ThingAsOfResult =
  /** The Thing as it existed at that instant. */
  | { kind: 'thing'; thing: Record<string, unknown> }
  /** The Thing did not exist then; commits say whether it was before or after. */
  | { kind: 'missing'; commits: BackendCommit[] }
  | { kind: 'error'; status: number; error: string }

/**
 * A Thing as it existed at `asOfDate`, expanded for the datastream table.
 *
 * A 404 means the Thing did not exist at that point in transaction time; the
 * commit history is returned with it so the caller can tell "not yet created"
 * from "deleted" without a second round trip.
 */
export async function fetchThingAsOf(
  endpoint: string,
  thingId: string,
  asOfDate: string,
  headers: Record<string, string>
): Promise<ThingAsOfResult> {
  const url =
    `${endpoint}/Things(${encodeURIComponent(thingId)})` +
    `?$as_of=${encodeURIComponent(asOfDate)}` +
    `&$expand=${THING_EXPAND}`

  const response = await fetch(url, { headers, cache: 'no-store' })

  if (response.status === 404) {
    const commits = await fetchThingCommits(endpoint, thingId, headers)
    return { kind: 'missing', commits }
  }

  if (!response.ok) {
    return {
      kind: 'error',
      status: response.status,
      error: `${response.status} ${response.statusText}`.trim(),
    }
  }

  const thing = await response.json().catch(() => null)
  if (!thing || typeof thing !== 'object') {
    return {
      kind: 'error',
      status: 502,
      error: 'Malformed response from data source',
    }
  }

  return { kind: 'thing', thing: thing as Record<string, unknown> }
}

/**
 * A Thing's commit history (transaction-time events) — the axis `$as_of`
 * filters on. Prefers the plural `/Commits` collection and falls back to the
 * singular `/Commit` on backends that only expose the creation commit.
 */
export async function fetchThingCommits(
  endpoint: string,
  thingId: string,
  headers: Record<string, string>
): Promise<BackendCommit[]> {
  const id = encodeURIComponent(thingId)

  try {
    const response = await fetch(
      `${endpoint}/Things(${id})/Commits?$select=@iot.id,message,date,actionType`,
      { headers, cache: 'no-store' }
    )
    if (response.ok) {
      const data = await response.json().catch(() => null)
      if (Array.isArray(data?.value)) return data.value as BackendCommit[]
    }
  } catch {
    // Fall through to the singular endpoint below.
  }

  try {
    const response = await fetch(`${endpoint}/Things(${id})/Commit`, {
      headers,
      cache: 'no-store',
    })
    if (!response.ok) return []
    const data = await response.json().catch(() => null)
    if (Array.isArray(data?.value)) return data.value as BackendCommit[]
    if (data?.['@iot.id'] != null) return [data as BackendCommit]
    return []
  } catch {
    return []
  }
}
