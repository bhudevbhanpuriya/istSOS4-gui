import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { Datastream, Observation } from '@/types/domain'

dayjs.extend(utc)

export type GraphSeriesEntry = {
  id: string
  name: string
  unit: string
  observedProperty: string
  rows: Array<{ ts: number; value: number }>
  /**
   * ISO-8601 snapshot this series was read at — set only in As-Of *compare*
   * mode, where two series share one datastream and differ only by `$as_of`.
   * Null everywhere else (live mode, and plain As-Of property comparison).
   */
  asOf?: string | null
  /**
   * Epoch ms of `asOf`. In compare mode each series is anchored to its own
   * snapshot, so the aligned x-axis can plot `ts - anchorTs` and lay two
   * different 7-day windows on top of each other.
   */
  anchorTs?: number | null
}

/** One fetched series, before it is turned into a `GraphSeriesEntry`. */
export type SeriesSource = {
  datastream: Datastream
  observations: Observation[]
  /** ISO-8601 snapshot this series was read at (As-Of compare mode only). */
  asOf?: string | null
  /**
   * ISO-8601 instant the aligned x-axis pins this series' right edge to.
   *
   * Defaults to `asOf`, and must differ whenever the snapshot's own window came
   * up empty and fell back to the latest data available at that snapshot: the
   * points then sit weeks before `asOf`, and anchoring there would push them off
   * the −7d…0 axis instead of laying the two windows on top of each other.
   */
  anchorIso?: string | null
}

/**
 * Series identity.
 *
 * Everything downstream — legend keys, `activeDatastreamIds`, tooltip lookup,
 * y-axis assignment — addresses a series by this id. Keying on the datastream
 * id alone is enough while every series is a *different* datastream, but in
 * As-Of compare mode both series ARE the same datastream and would collide,
 * silently dropping one. Qualifying by `$as_of` keeps them distinct.
 */
export function makeSeriesId(datastreamId: string, asOf?: string | null) {
  const id = String(datastreamId ?? '')
  return asOf ? `${id}@${asOf}` : id
}

/** The datastream id behind a (possibly snapshot-qualified) series id. */
export function datastreamIdFromSeriesId(seriesId: string) {
  return String(seriesId ?? '').split('@')[0] ?? ''
}

/** Legend/tooltip label for a snapshot — both series share a datastream name. */
export function formatSnapshotLabel(asOf: string) {
  return `${dayjs.utc(asOf).format('MMM D, YYYY HH:mm')} UTC`
}

/** A span of phenomenon time where two snapshots disagree. Epoch ms. */
export type ChangeRegion = { start: number; end: number }

/**
 * Where two snapshots of one datastream disagree.
 *
 * Only meaningful on a SHARED window: aligned mode puts each series on its own
 * date range, so equal timestamps are not comparable and the caller must not
 * ask. A timestamp counts as changed when the values differ or when the reading
 * exists in only one snapshot (inserted or deleted between them).
 *
 * Consecutive changed timestamps collapse into one region so the chart shades a
 * span rather than N stripes. Isolated points are widened to half a sample
 * interval either side — a zero-width band would paint nothing.
 */
export function computeChangeRegions(
  primaryRows: Array<{ ts: number; value: number }>,
  compareRows: Array<{ ts: number; value: number }>
): { unchanged: boolean; regions: ChangeRegion[] } {
  const a = new Map(primaryRows.map((r) => [r.ts, r.value]))
  const b = new Map(compareRows.map((r) => [r.ts, r.value]))
  const stamps = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)
  if (stamps.length === 0) return { unchanged: false, regions: [] }

  // Half the median gap, used to give isolated changed points a visible width.
  const gaps: number[] = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  gaps.sort((x, y) => x - y)
  const pad = gaps.length ? Math.max(gaps[Math.floor(gaps.length / 2)] / 2, 1) : 1

  const regions: ChangeRegion[] = []
  let open: number | null = null
  let last = 0
  for (const ts of stamps) {
    const differs = !a.has(ts) || !b.has(ts) || a.get(ts) !== b.get(ts)
    if (differs) {
      if (open === null) open = ts
      last = ts
    } else if (open !== null) {
      regions.push({ start: open - pad, end: last + pad })
      open = null
    }
  }
  if (open !== null) regions.push({ start: open - pad, end: last + pad })

  return { unchanged: regions.length === 0, regions }
}

export function toNumber(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string') {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function extractTimestamp(obs: Observation): number | null {
  const raw = obs?.phenomenonTime
  const d = dayjs.utc(raw)
  const ts = d.valueOf()
  return Number.isFinite(ts) ? ts : null
}

export function withAlpha(color: string, alpha: number) {
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const isShort = hex.length === 3
    const isLong = hex.length === 6
    if (!isShort && !isLong) return color

    const normalized = isShort
      ? hex
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : hex
    const int = Number.parseInt(normalized, 16)
    const r = (int >> 16) & 255
    const g = (int >> 8) & 255
    const b = int & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

export function buildRows(observations: Observation[]) {
  const rows: Array<{ ts: number; value: number }> = []
  for (const obs of Array.isArray(observations) ? observations : []) {
    const ts = extractTimestamp(obs)
    const value = toNumber(obs?.result)
    if (ts === null || value === null) continue
    rows.push({ ts, value })
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

export function buildSeriesEntries({
  allSeries,
  datastream,
  comparisonDatastream,
  chartData,
  comparisonChartData,
}: {
  allSeries: SeriesSource[]
  datastream: Datastream | null
  comparisonDatastream: Datastream | null
  chartData: Array<{ ts: number; value: number }>
  comparisonChartData: Array<{ ts: number; value: number }>
}): GraphSeriesEntry[] {
  if (Array.isArray(allSeries) && allSeries.length > 0) {
    return allSeries.map((entry) => {
      const ds = entry?.datastream
      const dsId = String(ds?.['@iot.id'] ?? ds?.id ?? '')
      const dsUnit = String(ds?.unitOfMeasurement?.symbol ?? '')
      const dsObservedProperty = String(ds?.ObservedProperty?.name ?? '')
      const asOf = entry?.asOf ?? null
      // In compare mode both series carry the same datastream name, so the
      // snapshot is what tells them apart in the legend and tooltip.
      const dsName = asOf
        ? formatSnapshotLabel(asOf)
        : String(ds?.name ?? dsId)
      // The aligned axis pins each series' right edge to its own window end,
      // which is `asOf` unless that snapshot fell back to older data.
      const anchorIso = entry?.anchorIso ?? asOf
      return {
        id: makeSeriesId(dsId, asOf),
        name: dsName,
        unit: dsUnit,
        observedProperty: dsObservedProperty,
        rows: buildRows(entry?.observations),
        asOf,
        anchorTs: anchorIso ? dayjs.utc(anchorIso).valueOf() : null,
      }
    })
  }

  return [
    {
      id: String(datastream?.['@iot.id'] ?? datastream?.id ?? ''),
      name: String(datastream?.name ?? ''),
      unit: String(datastream?.unitOfMeasurement?.symbol ?? ''),
      observedProperty: String(datastream?.ObservedProperty?.name ?? ''),
      rows: chartData,
    },
    ...(comparisonDatastream
      ? [
          {
            id: String(
              comparisonDatastream?.['@iot.id'] ??
                comparisonDatastream?.id ??
                ''
            ),
            name: String(comparisonDatastream?.name ?? ''),
            unit: String(comparisonDatastream?.unitOfMeasurement?.symbol ?? ''),
            observedProperty: String(
              comparisonDatastream?.ObservedProperty?.name ?? ''
            ),
            rows: comparisonChartData,
          },
        ]
      : []),
  ]
}

export function resolvePrimaryAndSecondarySeries(
  seriesEntries: GraphSeriesEntry[],
  activeDatastreamIds: string[]
) {
  const selectedSeries = seriesEntries.filter((entry) =>
    activeDatastreamIds.includes(entry.id)
  )
  const primarySeries =
    selectedSeries[0] ??
    seriesEntries.find((entry) => activeDatastreamIds.includes(entry.id)) ??
    seriesEntries[0]
  const secondarySeries = selectedSeries[1] ?? null
  return { primarySeries, secondarySeries }
}
