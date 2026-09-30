'use client'

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
 * @file features/observations/components/QualityLegend.tsx
 *
 * The row under the quality lane: what each colour means, and how much of the
 * shown window is in it.
 *
 * It is both legend and summary on purpose. As a legend it is what keeps the
 * lane from being read by hue alone — every colour on screen is named right
 * here. As a summary it answers the question the lane cannot ("how good is this
 * range overall?"), and because it counts the rows the chart is currently
 * holding, it re-tallies whenever the time range changes.
 */

import { useTranslation } from 'react-i18next'

import { formatSnapshotLabel } from '../lib/observationGraphUtils'
import {
  QUALITY_CLASSES,
  QUALITY_COLORS,
  QUALITY_LABEL_KEYS,
  judgedCount,
  type QualityTally,
} from '../lib/resultQuality'

export type QualityLegendLane = {
  /** Row prefix — "A"/"B"/"C"… when there are several lanes, absent when there is one. */
  tag?: string
  /** What the tag stands for — the plotted property, when lanes are lettered by series. */
  label?: string
  tally: QualityTally
  /** ISO-8601 snapshot the lane was read at; null for live data. */
  asOf?: string | null
}

export default function QualityLegend({
  lanes,
}: {
  lanes: QualityLegendLane[]
}) {
  const { t } = useTranslation()

  if (lanes.length === 0) return null

  return (
    // The left inset lines the row up with the plotting area rather than the
    // y-axis labels, so it reads as belonging to the lane above it.
    <div className="flex flex-col gap-0.5 pl-[50px] pr-[50px] text-[11px] leading-tight">
      {lanes.map((lane, index) => {
        const total = QUALITY_CLASSES.reduce(
          (sum, key) => sum + lane.tally[key],
          0
        )
        if (total === 0) return null
        const judged = judgedCount(lane.tally)
        // "0% pass" would be a verdict. A window nothing has checked has not
        // failed — it has not been judged, and the summary has to say so, for
        // the snapshot it describes: a snapshot taken before a QC pass ran has
        // no values even though live data may.
        const summary = judged
          ? t('quality.summary', {
              count: total,
              percent: Math.round((lane.tally.pass / judged) * 100),
            })
          : lane.asOf
            ? t('quality.no_values_as_of', {
                count: total,
                date: formatSnapshotLabel(lane.asOf),
              })
            : t('quality.no_values_live', { count: total })

        return (
          <div
            key={lane.tag ?? index}
            className="flex flex-wrap items-center gap-x-4 gap-y-0.5"
          >
            <span className="font-semibold tabular-nums">
              {lane.tag ? `${lane.tag} — ` : ''}
              {lane.label ? `${lane.label}: ` : ''}
              {summary}
            </span>
            {QUALITY_CLASSES.filter((key) => lane.tally[key] > 0).map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1.5 whitespace-nowrap opacity-80"
              >
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: QUALITY_COLORS[key] }}
                />
                {t(QUALITY_LABEL_KEYS[key])}{' '}
                <span className="font-semibold tabular-nums">
                  {lane.tally[key].toLocaleString()}
                </span>
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}
