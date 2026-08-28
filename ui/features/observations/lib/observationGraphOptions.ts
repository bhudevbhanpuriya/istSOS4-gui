import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import * as echarts from 'echarts'

import {
  GraphSeriesEntry,
  resolvePrimaryAndSecondarySeries,
  withAlpha,
  type ChangeRegion,
} from './observationGraphUtils'

dayjs.extend(utc)

/** Snapshot chrome — the markLine, matching the amber As-Of badge and banner. */
const SNAPSHOT_COLOR = '#f59e0b'

/**
 * Series B when comparing two snapshots.
 *
 * Amber is the As-Of mode's own colour (badge, banner, map pins, the snapshot
 * markLine right here on this chart), so an amber *series* reads as chrome
 * rather than as data.
 *
 * A light orange, chosen for how it reads against the teal primary. Separation
 * from teal is comfortable (worst-case CVD ΔE 16.4, normal-vision 31.2), but at
 * 2.2:1 it sits under the 3:1 floor for a mark on this white surface, so B is
 * drawn a little heavier to stay legible. `#ea580c` is the drop-in if it ever
 * needs to clear 3:1 on its own.
 */
const COMPARE_B_COLOR = '#fb923c'

/**
 * B's stroke in compare mode.
 *
 * B is the *reference* being checked against, so it sits under A, thinner and
 * slightly transparent. The payoff is that agreement and disagreement look
 * different without reading anything: where the snapshots match, B hides
 * exactly under A and the chart shows one clean line; where they diverge, B
 * separates out and becomes visible on its own.
 */
const COMPARE_B_WIDTH = 1.5
const COMPARE_B_OPACITY = 0.9

/** Wash marking spans where the two snapshots disagree. */
const CHANGE_BAND_COLOR = '#ef4444'

export type SnapshotMarker = {
  /** x-coordinate in the axis' own space (offset ms when aligned, else epoch ms) */
  value: number
  label: string
}

export function buildObservationGraphOption({
  seriesEntries,
  activeDatastreamIds,
  primaryColor,
  t,
  onDownloadAllDatastreams,
  snapshotMarkers = [],
  windowStart,
  windowEnd,
  alignedAxis = false,
  isCompare = false,
  changeRegions = [],
}: {
  seriesEntries: GraphSeriesEntry[]
  activeDatastreamIds: string[]
  primaryColor: string
  t: (key: string) => string
  onDownloadAllDatastreams?: () => Promise<{
    filename: string
    bytes: ArrayBuffer
  } | null>
  /** Amber dashed vertical lines. In As-Of compare mode there are two (one per
   *  snapshot) on the real-date axis, and one (at offset 0) on the aligned axis. */
  snapshotMarkers?: SnapshotMarker[]
  /** Pins the x-axis to the queried window so sparse/empty data still renders
   *  the full range and a markLine can't stretch the axis. Same space as the
   *  axis: offset ms when `alignedAxis`, epoch ms otherwise. */
  windowStart?: number | null
  windowEnd?: number | null
  /**
   * As-Of compare mode, default state: each series is anchored to its own
   * snapshot, so points are plotted as `ts - anchorTs` (−7d → 0) and two
   * different 7-day windows lie on top of each other. Off once the user picks
   * an explicit range — both series then share one real window.
   */
  alignedAxis?: boolean
  /**
   * As-Of compare mode. Both series are the same datastream at two snapshots:
   * same unit, so they share ONE y-axis (dual axes would fake a difference),
   * and the second is dashed so a perfect overlap is still readable.
   */
  isCompare?: boolean
  /**
   * Spans (epoch ms) where the two snapshots disagree, shaded so the eye lands
   * on the change instead of scanning the series. Only ever populated on a
   * shared window — aligned mode has no comparable timestamps.
   */
  changeRegions?: ChangeRegion[]
}): echarts.EChartsOption {
  const tableBorderColor = withAlpha(primaryColor, 0.35)
  const tableHeaderBg = withAlpha(primaryColor, 0.12)
  const tableRowAltBg = withAlpha(primaryColor, 0.06)
  const { primarySeries, secondarySeries } = resolvePrimaryAndSecondarySeries(
    seriesEntries,
    activeDatastreamIds
  )

  const yLabel = primarySeries?.unit
    ? `${primarySeries.observedProperty} (${primarySeries.unit})`
    : (primarySeries?.observedProperty ?? '')
  // Compare mode plots one datastream at two snapshots — same observed property,
  // same unit — so a right-hand axis would invent a distinction that isn't there.
  const secondaryYLabel =
    secondarySeries && !isCompare
      ? secondarySeries.unit
        ? `${secondarySeries.observedProperty} (${secondarySeries.unit})`
        : secondarySeries.observedProperty
      : ''
  const showSecondaryAxis = !!secondarySeries && !isCompare
  // Live property comparison keeps amber; only snapshot-vs-snapshot goes red,
  // where amber would collide with this chart's own snapshot markLine.
  const secondaryColor = isCompare ? COMPARE_B_COLOR : SNAPSHOT_COLOR

  const seriesDataRows: Array<{ date: string; stream: string; value: string }> =
    []
  for (const entry of seriesEntries) {
    for (const row of entry.rows) {
      seriesDataRows.push({
        // Always the real timestamp — the aligned axis is a display device, the
        // exported/tabulated data must stay in absolute time.
        date: dayjs.utc(row.ts).format('YYYY-MM-DD HH:mm'),
        stream: entry.name,
        value: entry.unit ? `${row.value} ${entry.unit}` : String(row.value),
      })
    }
  }
  seriesDataRows.sort(
    (a, b) => dayjs.utc(a.date).valueOf() - dayjs.utc(b.date).valueOf()
  )

  return {
    animation: false,
    grid: {
      left: 50,
      right: 50,
      top: 30,
      bottom: 110,
    },
    tooltip: {
      trigger: 'axis',
      borderColor: primaryColor,
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as Array<{
          axisValueLabel?: string
          seriesName?: string | number
          marker?: unknown
          data?: unknown
          value?: unknown
        }>
        const axisLabel = rows[0]?.axisValueLabel ?? ''
        const lines = rows
          .map((row) => {
            const entry = seriesEntries.find(
              (item) => item.id === String(row?.seriesName ?? '')
            )
            const displayName = entry?.name ?? String(row?.seriesName ?? '')
            const value = Array.isArray(row?.data) ? row.data[1] : row?.value
            // On the aligned axis the shared header is an offset ("−3d"), which
            // is the same for both series but corresponds to a DIFFERENT real
            // instant in each snapshot's window — so each line carries its own.
            if (alignedAxis && entry?.anchorTs != null) {
              const offset = Array.isArray(row?.data) ? Number(row.data[0]) : NaN
              const realTs = Number.isFinite(offset)
                ? entry.anchorTs + offset
                : null
              const stamp = realTs
                ? ` <span style="opacity:0.65">(${dayjs
                    .utc(realTs)
                    .format('MMM D, HH:mm')})</span>`
                : ''
              return `${String(row?.marker ?? '')}${displayName}: ${value ?? ''}${stamp}`
            }
            return `${String(row?.marker ?? '')}${displayName}: ${value ?? ''}`
          })
          .join('<br/>')
        return `${axisLabel}<br/>${lines}`
      },
      axisPointer: {
        type: 'line',
        lineStyle: {
          color: primaryColor,
          width: 1,
        },
      },
    },
    toolbox: {
      bottom: 'bottom',
      feature: {
        dataView: {
          title: 'DataView',
          readOnly: true,
          lang: ['\u200B', t('general.close'), ''],
          backgroundColor: '#ffffff',
          textareaColor: '#ffffff',
          textareaBorderColor: tableBorderColor,
          textColor: primaryColor,
          buttonColor: primaryColor,
          buttonTextColor: '#ffffff',
          iconStyle: {
            borderColor: primaryColor,
          },
          emphasis: {
            iconStyle: {
              borderColor: primaryColor,
            },
          },
          optionToContent: () => {
            const groupedRows = new Map<
              string,
              Array<{ date: string; value: string }>
            >()
            for (const row of seriesDataRows) {
              const group = groupedRows.get(row.stream) ?? []
              group.push({ date: row.date, value: row.value })
              groupedRows.set(row.stream, group)
            }

            const datastreamNames = Array.from(groupedRows.keys())
            const wrapper = document.createElement('div')
            wrapper.style.display = 'flex'
            wrapper.style.flexDirection = 'column'
            wrapper.style.gap = '10px'

            const tabs = document.createElement('div')
            tabs.style.display = 'flex'
            tabs.style.flexWrap = 'wrap'
            tabs.style.gap = '6px'

            const tableContainer = document.createElement('div')

            const renderTable = (stream: string) => {
              const rows = (groupedRows.get(stream) ?? [])
                .map((row, index) => {
                  const rowBg = index % 2 === 0 ? 'transparent' : tableRowAltBg
                  return `<tr>
                    <td style="padding:6px 10px;border:1px solid ${tableBorderColor};background:${rowBg};">${row.date}</td>
                    <td style="padding:6px 10px;border:1px solid ${tableBorderColor};background:${rowBg};">${row.value}</td>
                  </tr>`
                })
                .join('')

              tableContainer.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;color:${primaryColor};">
                <thead>
                  <tr>
                    <th style="padding:6px 10px;border:1px solid ${tableBorderColor};text-align:left;background:${tableHeaderBg};">Date</th>
                    <th style="padding:6px 10px;border:1px solid ${tableBorderColor};text-align:left;background:${tableHeaderBg};">Value</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>`
            }

            let activeStream = datastreamNames[0] ?? ''
            for (const stream of datastreamNames) {
              const btn = document.createElement('button')
              btn.type = 'button'
              btn.textContent = stream
              btn.style.padding = '4px 10px'
              btn.style.border = `1px solid ${tableBorderColor}`
              btn.style.borderRadius = '9999px'
              btn.style.fontSize = '12px'
              btn.style.cursor = 'pointer'
              btn.style.background = stream === activeStream ? tableHeaderBg : '#fff'
              btn.style.color = primaryColor
              btn.onclick = () => {
                activeStream = stream
                for (const child of Array.from(tabs.children)) {
                  const element = child as HTMLButtonElement
                  element.style.background =
                    element.textContent === activeStream ? tableHeaderBg : '#fff'
                }
                renderTable(activeStream)
              }
              tabs.appendChild(btn)
            }

            if (activeStream) renderTable(activeStream)
            wrapper.appendChild(tabs)
            wrapper.appendChild(tableContainer)
            return wrapper
          },
        },
        dataZoom: {
          xAxisIndex: 0,
          yAxisIndex: 'none',
          iconStyle: {
            borderColor: primaryColor,
          },
          emphasis: {
            iconStyle: {
              borderColor: primaryColor,
            },
          },
        },
        myDownloadCsv: {
          show: true,
          title: t('chart.download_xlsx'),
          icon: 'path://M512 64c26.5 0 48 21.5 48 48v432h120c19.4 0 29 23.4 15.3 37.1l-184 184c-8.8 8.8-23 8.8-31.8 0l-184-184C281 567.4 290.6 544 310 544h120V112c0-26.5 21.5-48 48-48h34zM176 848h672c17.7 0 32 14.3 32 32s-14.3 32-32 32H176c-17.7 0-32-14.3-32-32s14.3-32 32-32z',
          iconStyle: {
            borderColor: primaryColor,
          },
          emphasis: {
            iconStyle: {
              borderColor: primaryColor,
            },
          },
          onclick: async () => {
            if (!onDownloadAllDatastreams) return
            const payload = await onDownloadAllDatastreams()
            if (!payload?.bytes) return
            const blob = new Blob([payload.bytes], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            })
            const url = window.URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = payload.filename || 'datastreams.xlsx'
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.URL.revokeObjectURL(url)
          },
        },
      },
    },
    legend: {
      top: 0,
      formatter: (id: string) =>
        seriesEntries.find((entry) => entry.id === id)?.name ?? id,
      selected: Object.fromEntries(
        seriesEntries.map((entry) => [
          entry.id,
          activeDatastreamIds.length
            ? activeDatastreamIds.includes(entry.id)
            : entry.id === primarySeries?.id,
        ])
      ),
    },
    xAxis: {
      // Aligned mode plots offsets from each series' own snapshot, not instants,
      // so the axis is a plain value scale there.
      type: alignedAxis ? 'value' : 'time',
      ...(windowStart != null ? { min: windowStart } : {}),
      ...(windowEnd != null ? { max: windowEnd } : {}),
      ...(alignedAxis
        ? { name: t('as_of.chart.aligned_axis_name'), nameLocation: 'middle' as const, nameGap: 46 }
        : {}),
      minInterval: 60 * 60 * 1000,
      ...(alignedAxis ? {} : { maxInterval: 60 * 60 * 1000 }),
      axisLine: {
        lineStyle: {
          color: primaryColor,
        },
      },
      axisLabel: {
        hideOverlap: true,
        rotate: alignedAxis ? 0 : 35,
        interval: 'auto',
        margin: 16,
        formatter: (value: number) => {
          if (alignedAxis) {
            // Offsets run −7d → 0; label whole days only, 0 being the snapshot.
            const hours = Math.round(value / (60 * 60 * 1000))
            if (hours % 24 !== 0) return ''
            const days = hours / 24
            return days === 0 ? '0' : `${days}d`
          }
          const d = dayjs.utc(value)
          if (d.hour() % 6 !== 0) return ''
          return d.format('DD/MM HH:mm')
        },
      },
    },
    yAxis: [
      {
        type: 'value',
        name: yLabel,
        nameLocation: 'middle',
        nameGap: 42,
        scale: true,
        position: 'left',
        axisLine: {
          lineStyle: {
            color: primaryColor,
          },
        },
        splitLine: {
          lineStyle: {
            color: withAlpha(primaryColor, 0.2),
          },
        },
      },
      {
        type: 'value',
        name: secondaryYLabel,
        nameLocation: 'middle',
        nameGap: 48,
        scale: true,
        position: 'right',
        show: showSecondaryAxis,
        axisLine: {
          lineStyle: {
            color: secondaryColor,
          },
        },
        splitLine: {
          show: false,
        },
      },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
    series: seriesEntries.map((entry) => {
      const isPrimary = entry.id === primarySeries?.id
      const isSecondary = entry.id === secondarySeries?.id
      const color = isPrimary ? primaryColor : isSecondary ? secondaryColor : '#94a3b8'
      return {
        name: entry.id,
        type: 'line' as const,
        data: entry.rows.map((row) => [
          alignedAxis && entry.anchorTs != null ? row.ts - entry.anchorTs : row.ts,
          row.value,
        ]),
        showSymbol: false,
        sampling: 'lttb' as const,
        smooth: false,
        // B above A. Where the two agree exactly, A's solid stroke would hide a
        // lower B completely and the chart would claim there is only one series
        // — indistinguishable from a comparison that failed to load. Riding B's
        // dashes on top instead makes a perfect overlap legible AS an overlap.
        z: isCompare && isSecondary ? 4 : 3,
        lineStyle: {
          color,
          width: isCompare && isSecondary ? COMPARE_B_WIDTH : 2,
          ...(isCompare && isSecondary ? { opacity: COMPARE_B_OPACITY } : {}),
          // Compare mode: the two snapshots often agree exactly, and two solid
          // lines at identical coordinates are indistinguishable from one. The
          // dash lets the overlap itself be read off the chart.
          ...(isCompare && isSecondary ? { type: 'dashed' as const } : {}),
        },
        itemStyle: {
          color,
        },
        // Compare mode keeps both snapshots on the shared left axis.
        yAxisIndex: isSecondary && !isCompare ? 1 : 0,
        // Amber dashed vertical lines at the snapshot dates — drawn once on the
        // primary series (avoids N overlapping lines/labels).
        markLine:
          snapshotMarkers.length > 0 && isPrimary
            ? {
                silent: true,
                symbol: 'none',
                data: snapshotMarkers.map((marker) => ({
                  xAxis: marker.value,
                  label: {
                    show: true,
                    formatter: marker.label,
                    position: 'insideStartTop' as const,
                    color: '#b45309',
                    fontSize: 11,
                  },
                })),
                lineStyle: {
                  color: SNAPSHOT_COLOR,
                  type: 'dashed' as const,
                  width: 2,
                },
              }
            : undefined,
        // Wash over the spans where the two snapshots disagree. Drawn once, on
        // the primary series, and behind both lines so it never obscures them.
        markArea:
          changeRegions.length > 0 && isPrimary
            ? {
                silent: true,
                itemStyle: {
                  color: withAlpha(CHANGE_BAND_COLOR, 0.12),
                  borderColor: withAlpha(CHANGE_BAND_COLOR, 0.35),
                  borderWidth: 1,
                },
                data: changeRegions.map((region) => [
                  { xAxis: region.start },
                  { xAxis: region.end },
                ]),
              }
            : undefined,
      }
    }),
  }
}
