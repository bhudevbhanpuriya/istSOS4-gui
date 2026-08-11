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

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

/** Width of the snapshot observation window, in days, ending at the as-of date. */
export const SNAPSHOT_WINDOW_DAYS = 7

/**
 * The one definition of a snapshot's observation window: [asOfDate-7d, asOfDate].
 *
 * In As-Of mode the chart is strictly bounded to this window — data outside it
 * belongs to a different point in time than the snapshot the user is viewing,
 * so silently drifting there would misrepresent the snapshot. Both the fetch
 * layer and the date picker derive their bounds from here so they can never
 * disagree.
 */
export function getSnapshotWindow(asOfDate: string) {
  const end = dayjs.utc(asOfDate)
  return {
    startIso: end.subtract(SNAPSHOT_WINDOW_DAYS, 'day').toISOString(),
    endIso: end.toISOString(),
  }
}

/**
 * Clamps a requested range into the snapshot window. A missing, invalid or
 * out-of-window bound collapses to the window edge, so no caller — a stale
 * range left over from an earlier selection, a hand-built query, or the date
 * picker — can pull the chart outside [asOfDate-7d, asOfDate].
 */
export function clampToSnapshotWindow(
  asOfDate: string,
  start?: string | null,
  end?: string | null
) {
  const window = getSnapshotWindow(asOfDate)
  const lower = dayjs.utc(window.startIso)
  const upper = dayjs.utc(window.endIso)

  // A range that does not overlap the window at all (e.g. one left over from a
  // different snapshot) carries no usable intent — clamping it would collapse
  // it to a zero-width sliver. Fall back to the full window instead, so the
  // user sees the snapshot they actually selected.
  const requestedStart = start ? dayjs.utc(start) : null
  const requestedEnd = end ? dayjs.utc(end) : null
  const overlapsWindow =
    !requestedStart ||
    !requestedEnd ||
    !requestedStart.isValid() ||
    !requestedEnd.isValid() ||
    (!requestedEnd.isBefore(lower) && !requestedStart.isAfter(upper))
  if (!overlapsWindow) return window

  const clamp = (value: string | null | undefined, fallback: string) => {
    if (!value) return fallback
    const parsed = dayjs.utc(value)
    if (!parsed.isValid()) return fallback
    if (parsed.isBefore(lower)) return window.startIso
    if (parsed.isAfter(upper)) return window.endIso
    return parsed.toISOString()
  }

  const startIso = clamp(start, window.startIso)
  const endIso = clamp(end, window.endIso)

  // An inverted range (start after end) carries no usable intent — fall back to
  // the full window rather than fetching an empty slice the user never asked for.
  if (dayjs.utc(startIso).isAfter(dayjs.utc(endIso))) return window

  return { startIso, endIso }
}
