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
 * @file features/from-to/components/VersionTimeline.tsx
 *
 * The band of validity periods across the top of the history page.
 *
 * Widths are proportional to how long each version was in force but floored, so
 * a version that lived eight minutes inside a seventeen-day window is still a
 * target — see `timelineBands`. The true duration is printed on every band, so
 * the floor never misleads about how long a version actually lasted.
 *
 * Clicking a band selects it as the right-hand side of the comparison and
 * pushes the previous right-hand side to the left, which is how a reader walks
 * forward through a history one step at a time.
 */

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { useTranslation } from 'react-i18next'

import {
  computeBands,
  formatDuration,
} from '@/features/from-to/lib/timelineBands'
import { validityDurationMs } from '@/lib/systemTimeValidity'
import { versionKey, type EntityVersion } from '@/features/from-to/lib/versionRows'

dayjs.extend(utc)

/** Commit action -> the stripe along the top of a band. */
const ACTION_STRIPE: Record<string, string> = {
  CREATE: 'border-t-success',
  UPDATE: 'border-t-warning',
  DELETE: 'border-t-danger',
}

function stripeFor(actionType?: string): string {
  return ACTION_STRIPE[actionType ?? ''] ?? 'border-t-default-300'
}

export type VersionTimelineProps = {
  versions: EntityVersion[]
  /** End of the window being viewed; open-ended versions are measured to it. */
  windowEnd: string
  indexA: number
  indexB: number
  onPick: (index: number) => void
}

export default function VersionTimeline({
  versions,
  windowEnd,
  indexA,
  indexB,
  onPick,
}: VersionTimelineProps) {
  const { t } = useTranslation()

  if (versions.length === 0) return null

  const widths = computeBands(
    versions.map((version) => version.validity),
    windowEnd,
  )

  return (
    <div className="border-b border-default-100 px-4 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-tiny font-bold uppercase tracking-wider text-default-500">
          {t('from_to.timeline.heading')}
        </span>
        <span className="flex gap-3 text-tiny text-default-400">
          <Legend className="bg-success" label={t('from_to.timeline.create')} />
          <Legend className="bg-warning" label={t('from_to.timeline.update')} />
          <Legend className="bg-danger" label={t('from_to.timeline.delete')} />
        </span>
      </div>

      {/* Bands cannot shrink below their own padding, so past a few dozen
          versions a row of them is wider than the column no matter what
          percentage each is given. Scrolling the track keeps every band
          reachable and stops the page itself scrolling sideways. */}
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {versions.map((version, index) => {
          const isA = index === indexA
          const isB = index === indexB
          const open = version.validity.end === null

          return (
            <button
              key={versionKey(version)}
              type="button"
              onClick={() => onPick(index)}
              // A floor in pixels as well as percent: at a hundred versions the
              // percentage alone rounds to less than the band's own padding,
              // and a band too small to click is not a control.
              style={{ width: `${widths[index]}%`, minWidth: 34, flex: '0 0 auto' }}
              aria-label={t('from_to.timeline.band_label', {
                number: index + 1,
                start: version.validity.start,
              })}
              aria-pressed={isB}
              className={[
                'relative min-w-0 rounded-lg border border-t-[3px] px-2 pb-2 pt-1.5 text-left transition-colors',
                stripeFor(version.commit?.actionType),
                isB
                  ? 'border-primary bg-primary/10 ring-1 ring-primary'
                  : isA
                    ? 'border-default-400 bg-default-100'
                    : 'border-default-200 hover:bg-default-100',
              ].join(' ')}
            >
              {(isA || isB) && (
                <span
                  className={[
                    'absolute -top-2.5 right-1 rounded px-1 font-mono text-[9px] font-bold leading-[14px] text-white',
                    isB ? 'bg-primary' : 'bg-default-500',
                  ].join(' ')}
                >
                  {isB ? 'B' : 'A'}
                </span>
              )}
              <span className="block truncate text-[10.5px] font-bold">
                {t('from_to.timeline.version_n', { number: index + 1 })}
              </span>
              <span className="block truncate font-mono text-[9.5px] text-default-400">
                {dayjs.utc(version.validity.start).format('MM-DD HH:mm')}Z
              </span>
              <span className="block truncate text-[9.5px] text-default-400">
                {t('from_to.timeline.held', {
                  duration: formatDuration(
                    validityDurationMs(version.validity, windowEnd),
                  ),
                })}
                {open ? ` · ${t('from_to.timeline.open')}` : ''}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex justify-between font-mono text-[9.5px] text-default-400">
        <span>{dayjs.utc(versions[0].validity.start).format('YYYY-MM-DD HH:mm:ss')}Z</span>
        <span className="font-semibold text-primary">
          {t('from_to.timeline.present')}
        </span>
      </div>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <i className={`inline-block h-2 w-2 rounded-sm ${className}`} aria-hidden="true" />
      {label}
    </span>
  )
}
