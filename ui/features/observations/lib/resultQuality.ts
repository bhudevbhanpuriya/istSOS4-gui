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
 * @file features/observations/lib/resultQuality.ts
 *
 * The one place that decides what an Observation's `resultQuality` means.
 *
 * The API stores the field as raw `jsonb` with no validation, no default and no
 * declared scale — a bare number with nothing recording which scale it is on.
 * The reading applied here is the istSOS quality index used by the quality
 * tutorial, every API payload example and the docs: **100 is good, and lower
 * values are flag codes**, with 90-93 produced by the SaQC checks the tutorial
 * runs.
 *
 * That reading is a convention, not something the record asserts, and it is not
 * the only one shipped in this project: `ftp2istsos4` packs two bits per check
 * and sends "3" to mean "every check passed", while `mqtt2istsos4` sends "11".
 * Under the index below both would classify as OUT_OF_RANGE. Nothing in a stored
 * value distinguishes the scales, so one had to be assumed; this module is
 * deliberately the only file that assumes it, so that supporting the others
 * later is a change here rather than a hunt through the chart code.
 */

/** At or above this, the reading passed. The whole convention, in one constant. */
export const QUALITY_PASS = 100

/** The SaQC checks the quality tutorial writes back. */
export const QUALITY_CODES = {
  MISSING: 90,
  CONSTANT: 91,
  OUTLIER: 92,
  OUT_OF_RANGE: 93,
} as const

/**
 * What a reading's quality says about it.
 *
 * `none` is not a verdict — it is the absence of one. A reading nothing has
 * checked must never render as passing, and must never be counted against the
 * pass rate either.
 */
export type QualityClass = 'pass' | 'suspect' | 'outlier' | 'range' | 'none'

/** Fixed order for legends and tallies, best-to-worst then the non-verdict. */
export const QUALITY_CLASSES: QualityClass[] = [
  'pass',
  'suspect',
  'outlier',
  'range',
  'none',
]

/**
 * Lane colours.
 *
 * These are *status* roles, not series colours: reserved, never reassigned to a
 * datastream, and always shipped with the label beside them so the lane is never
 * read by hue alone. 90 and 91 deliberately share the warning tone — both mean
 * "suspect, not impossible" — which keeps the lane inside four reserved roles
 * rather than inventing a fifth hue that no longer separates under CVD.
 */
export const QUALITY_COLORS: Record<QualityClass, string> = {
  pass: '#0ca30c',
  suspect: '#fab219',
  outlier: '#ec835a',
  range: '#d03b3b',
  // Matches the tertiary-series grey already used by the chart, and clears the
  // white plotting surface well enough to read as a filled block.
  none: '#94a3b8',
}

/** i18n keys, resolved by the caller that holds `t`. */
export const QUALITY_LABEL_KEYS: Record<QualityClass, string> = {
  pass: 'quality.pass',
  suspect: 'quality.suspect',
  outlier: 'quality.outlier',
  range: 'quality.range',
  none: 'quality.none',
}

/**
 * The quality index behind a raw `resultQuality`, or null when there isn't one.
 *
 * The column is untyped `jsonb`, so this has to cope with whatever an ingest
 * put there:
 *  - a number (`100`) — the shape a JSON literal round-trips as;
 *  - a numeric string (`"100"`), which is what the API examples POST;
 *  - an object, the OGC `DQ_Element` shape, where a numeric `quality` /
 *    `value` / `result` member is the only part this chart can read;
 *  - anything else — a free-text verdict, an array — which is a value the lane
 *    cannot place on the index and so reports as "not checked" rather than
 *    guessing a verdict for it.
 */
export function parseResultQuality(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    for (const key of ['quality', 'value', 'result', 'index']) {
      const nested = parseResultQuality(record[key])
      if (nested !== null) return nested
    }
  }

  return null
}

/** Where an index sits on the lane. */
export function classifyQuality(index: number | null): QualityClass {
  if (index === null) return 'none'
  if (index >= QUALITY_PASS) return 'pass'
  if (index === QUALITY_CODES.OUT_OF_RANGE) return 'range'
  if (index === QUALITY_CODES.OUTLIER) return 'outlier'
  if (
    index === QUALITY_CODES.MISSING ||
    index === QUALITY_CODES.CONSTANT
  ) {
    return 'suspect'
  }
  // Below the pass mark but not one of the codes this project writes: still a
  // failure, and saying so is more useful than dropping it to "not checked".
  return 'range'
}

/** Convenience for callers holding a raw value. */
export function qualityClassOf(raw: unknown): QualityClass {
  return classifyQuality(parseResultQuality(raw))
}

export type QualityTally = Record<QualityClass, number>

export function emptyQualityTally(): QualityTally {
  return { pass: 0, suspect: 0, outlier: 0, range: 0, none: 0 }
}

export function tallyQuality(
  rows: Array<{ qualityClass: QualityClass }>
): QualityTally {
  const tally = emptyQualityTally()
  for (const row of rows) tally[row.qualityClass] += 1
  return tally
}

/**
 * Does anything in this window carry a quality value?
 *
 * The lane is hidden entirely when nothing does. Every observation in a stock
 * istSOS deployment has `resultQuality: null`, and a permanently empty grey
 * strip under every chart would be worse than not shipping the lane at all.
 */
export function hasQualityData(tally: QualityTally): boolean {
  return (
    tally.pass + tally.suspect + tally.outlier + tally.range > 0
  )
}

/** Readings that carry a verdict — the denominator the pass rate is out of. */
export function judgedCount(tally: QualityTally): number {
  return tally.pass + tally.suspect + tally.outlier + tally.range
}

/**
 * A run of consecutive readings sharing one class.
 *
 * `startTs`/`endTs` are the first and last plotted x of the run, in whatever
 * space the axis is in.
 */
export type QualitySegment = {
  qualityClass: QualityClass
  startX: number
  endX: number
}

/**
 * Collapse a series into runs, so a 2000-point window draws a handful of
 * rectangles instead of 2000 abutting ones.
 *
 * Single-reading runs would be zero-width, so each segment is extended by half
 * the gap to its neighbour — the same widening `computeChangeRegions` applies,
 * and for the same reason: a band with no width paints nothing.
 */
export function buildQualitySegments(
  points: Array<{ x: number; qualityClass: QualityClass }>
): QualitySegment[] {
  if (points.length === 0) return []

  const gaps: number[] = []
  for (let i = 1; i < points.length; i++) {
    gaps.push(Math.abs(points[i].x - points[i - 1].x))
  }
  gaps.sort((a, b) => a - b)
  const pad = gaps.length
    ? Math.max(gaps[Math.floor(gaps.length / 2)] / 2, 1)
    : 1

  const segments: QualitySegment[] = []
  let open: QualitySegment | null = null

  for (const point of points) {
    if (open && open.qualityClass === point.qualityClass) {
      open.endX = point.x + pad
      continue
    }
    if (open) segments.push(open)
    open = {
      qualityClass: point.qualityClass,
      startX: point.x - pad,
      endX: point.x + pad,
    }
  }
  if (open) segments.push(open)

  return segments
}
