'use client'

import { Button } from '@heroui/button'
import { DateRangePicker } from '@heroui/date-picker'
import { Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/modal'
import { Select, SelectItem } from '@heroui/select'
import {
  getLocalTimeZone,
  parseAbsoluteToLocal,
} from '@internationalized/date'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { useTranslation } from 'react-i18next'

dayjs.extend(utc)

import { CloseIcon } from '@/components/icons'
import { getSnapshotWindow } from '@/features/as-of/lib/snapshotWindow'
import { Datastream, Observation, Thing } from '@/types/domain'

import ObservationGraph from './ObservationGraph'

type ChartModalProps = {
  isOpen: boolean
  onClose: () => void
  things?: Thing[]
  thing?: Thing | null
  selectedObservedPropertyName?: string | null
  selectedThingKeys?: string[]
  selectedObservedPropertyNames?: string[]
  datastream?: Datastream | null
  observations?: Observation[]
  comparisonDatastream?: Datastream | null
  comparisonObservations?: Observation[]
  allSeries?: Array<{ datastream: Datastream; observations: Observation[] }>
  loading?: boolean
  error?: string | null
  start?: string | null
  end?: string | null
  onApplyRange?: (start?: string | null, end?: string | null) => void
  onResetRange?: () => void
  onDownloadAllDatastreams?: () => Promise<{ filename: string; bytes: ArrayBuffer } | null>
  activeDatastreamIds?: string[]
  onActiveDatastreamsChange?: (datastreamIds: string[]) => void
  onThingKeysChange?: (thingKeys: string[]) => void
  onObservedPropertyNamesChange?: (observedPropertyNames: string[]) => void
  /** True when the app is in As-Of snapshot mode */
  isSnapshot?: boolean
  /** ISO-8601 snapshot datetime — anchors the default window and shows the badge */
  asOfDate?: string | null
  /**
   * True when the snapshot window held no observations and the chart fell back
   * to the live-mode window (the 7 days ending at the last measurement that
   * existed at the snapshot).
   */
  isAsOfFallback?: boolean
}

type DateRangeChangeValue = {
  start: { toDate: (timeZone?: string) => Date } | null
  end: { toDate: (timeZone?: string) => Date } | null
} | null

function toRangeValue(start?: string | null, end?: string | null) {
  if (!start || !end) return null

  return {
    start: parseAbsoluteToLocal(start),
    end: parseAbsoluteToLocal(end),
  }
}

/**
 * Builds a human-readable reason for why the shown window is empty, using the
 * datastream's own phenomenonTime extent ("isoStart/isoEnd").
 *
 * Purely informational — it never changes the as-of state. It is reached only
 * when the datastream has no observations at this point in time at all (an
 * empty [as_of-7d, as_of] window falls back to the live-mode window before the
 * chart ever renders empty).
 */
function describeSnapshotGap(
  datastream: Datastream | null,
  start: string | null | undefined,
  end: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const fmt = (d: dayjs.Dayjs) => d.utc().format('MMM D, YYYY')
  const [dataStartIso, dataEndIso] = String(datastream?.phenomenonTime ?? '').split('/')
  const dataStart = dataStartIso ? dayjs.utc(dataStartIso) : null
  const dataEnd = dataEndIso ? dayjs.utc(dataEndIso) : null
  const winStart = start ? dayjs.utc(start) : null
  const winEnd = end ? dayjs.utc(end) : null

  if (dataEnd && winStart && dataEnd.isBefore(winStart)) {
    return t('as_of.chart.no_data_ends_before', { date: fmt(dataEnd) })
  }
  if (dataStart && winEnd && dataStart.isAfter(winEnd)) {
    return t('as_of.chart.no_data_starts_after', { date: fmt(dataStart) })
  }
  return t('as_of.chart.no_data_in_window')
}

export default function ChartModal({
  isOpen,
  onClose,
  things = [],
  thing = null,
  selectedObservedPropertyName = null,
  selectedThingKeys = [],
  selectedObservedPropertyNames = [],
  datastream = null,
  observations = [],
  comparisonDatastream = null,
  comparisonObservations = [],
  allSeries = [],
  loading = false,
  error = null,
  start = null,
  end = null,
  onApplyRange,
  onResetRange,
  onDownloadAllDatastreams,
  activeDatastreamIds = [],
  onActiveDatastreamsChange,
  onThingKeysChange,
  onObservedPropertyNamesChange,
  isSnapshot = false,
  asOfDate = null,
  isAsOfFallback = false,
}: ChartModalProps) {
  const { t } = useTranslation()
  const rangeValue = toRangeValue(start, end)
  const timeZone = getLocalTimeZone()
  // The default window a snapshot opens on. It is an anchor, not a bound: the
  // date picker is free to leave it, exactly as in live mode.
  const snapshotWindow = asOfDate ? getSnapshotWindow(asOfDate) : null
  const sameInstant = (a?: string | null, b?: string | null) =>
    !!a && !!b && dayjs.utc(a).valueOf() === dayjs.utc(b).valueOf()
  // True only while the chart shows the as-of anchored window — the one case
  // where the x-axis is pinned, so a sparse snapshot still draws its full 7 days.
  const isAsOfDefaultWindow =
    isSnapshot &&
    sameInstant(start, snapshotWindow?.startIso) &&
    sameInstant(end, snapshotWindow?.endIso)
  // The snapshot marker is drawn only when as_of falls inside the shown window;
  // outside it, it would stretch the axis across the gap and squash the data.
  const isAsOfInsideWindow =
    !!asOfDate &&
    !!start &&
    !!end &&
    !dayjs.utc(asOfDate).isBefore(dayjs.utc(start)) &&
    !dayjs.utc(asOfDate).isAfter(dayjs.utc(end))
  // Snapshot-mode notices: informational only, they never mutate as-of.
  const hasData =
    observations.length > 0 ||
    allSeries.some((series) => series.observations.length > 0)
  const showSnapshotNoData =
    isSnapshot && !loading && !error && !!datastream && !hasData
  const snapshotNoDataMessage = showSnapshotNoData
    ? describeSnapshotGap(datastream, start, end, t)
    : null
  // Says that the snapshot window was empty and the chart moved to the latest
  // data that existed at the snapshot, so the dates on screen are never a surprise.
  const fallbackMessage =
    isSnapshot && isAsOfFallback && !loading && !error && hasData && asOfDate
      ? t('as_of.chart.fallback_notice', {
          date: dayjs.utc(asOfDate).format('MMM D, YYYY HH:mm'),
        })
      : null
  // The window currently on screen, restated alongside a notice so the message
  // is unambiguously tied to the dates being shown.
  const shownWindowLabel =
    start && end
      ? `${dayjs.utc(start).format('MMM D, YYYY HH:mm')} — ${dayjs
          .utc(end)
          .format('MMM D, YYYY HH:mm')} UTC`
      : null
  const noticeMessage = snapshotNoDataMessage ?? fallbackMessage
  const thingOptions = things.map((entry) => {
    const key = `${String(entry?.__sourceId ?? entry?.__sourceEndpoint ?? '0')}::${String(
      entry?.['@iot.id'] ?? entry?.id ?? entry?.name ?? ''
    )}`
    return { key, label: String(entry?.name ?? key) }
  })
  const selectedThings = things.filter((entry) =>
    selectedThingKeys.includes(
      `${String(entry?.__sourceId ?? entry?.__sourceEndpoint ?? '0')}::${String(
        entry?.['@iot.id'] ?? entry?.id ?? entry?.name ?? ''
      )}`
    )
  )
  const observedPropertySourceThings =
    selectedThings.length > 0 ? selectedThings : thing ? [thing] : []
  const observedPropertyOptions = Array.from(
    new Set(
      observedPropertySourceThings
        .flatMap((entry) =>
          Array.isArray(entry?.Datastreams) ? entry.Datastreams : []
        )
        .map((ds) => String(ds?.ObservedProperty?.name ?? '').trim())
        .filter(Boolean)
    )
  )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ key: name, label: name }))

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      hideCloseButton
      placement="center"
      scrollBehavior="inside"
      size="5xl"
      backdrop="blur"
      classNames={{
        wrapper: 'z-[6000]',
        base: 'z-[6001] h-[62vh] min-h-[62vh] max-h-[62vh] w-[94vw] max-w-[1440px]',
        backdrop: 'z-[5999]',
      }}
    >
      <ModalContent>
        <ModalHeader className="flex items-center justify-between gap-3 pb-0">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">Observations</div>
          </div>
          {/* Snapshot badge — only visible in As-Of mode */}
          {isSnapshot && asOfDate && (
            <div
              className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium"
              style={{
                background: 'rgba(251,191,36,0.15)',
                border: '1px solid rgba(251,191,36,0.4)',
                color: '#b45309',
              }}
            >
              <span>⏱</span>
              <span>
                Snapshot — {dayjs.utc(asOfDate).format('MMM D, YYYY HH:mm')} UTC
              </span>
            </div>
          )}
          <Button
            isIconOnly
            size="sm"
            className="h-6 w-6 min-w-6"
            radius="none"
            variant="light"
            aria-label={t('general.close')}
            onPress={onClose}
          >
            <CloseIcon size={18} />
          </Button>
        </ModalHeader>
        <ModalBody className="h-full overflow-hidden p-4 pt-2">
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-4 grid w-full shrink-0 grid-cols-1 gap-3 md:grid-cols-3">
            <Select
              label="Thing"
              labelPlacement="inside"
              placeholder="Select thing(s)"
              variant="bordered"
              radius="sm"
              size="sm"
              color="primary"
              className="w-full"
              selectionMode="multiple"
              selectedKeys={new Set(selectedThingKeys)}
              onSelectionChange={(keys) =>
                onThingKeysChange?.(Array.from(keys as Set<string>))
              }
            >
              {thingOptions.map((entry) => (
                <SelectItem key={entry.key}>{entry.label}</SelectItem>
              ))}
            </Select>
            <Select
              label="Observed Property"
              labelPlacement="inside"
              placeholder="Select observed property(ies)"
              variant="bordered"
              radius="sm"
              size="sm"
              color="primary"
              className="w-full"
              selectionMode="multiple"
              selectedKeys={new Set(selectedObservedPropertyNames)}
              onSelectionChange={(keys) =>
                onObservedPropertyNamesChange?.(Array.from(keys as Set<string>))
              }
            >
              {observedPropertyOptions.map((entry) => (
                <SelectItem key={entry.key}>{entry.label}</SelectItem>
              ))}
            </Select>
            <DateRangePicker
              value={rangeValue as never}
              onChange={(value) => {
                const nextValue = value as unknown as DateRangeChangeValue

                if (!nextValue) {
                  onResetRange?.()
                  return
                }

                if (nextValue.start && nextValue.end) {
                  // The picked range is used as-is in both modes — As-Of mode
                  // adds no bounds of its own. Fetches keep sending `$as_of`,
                  // so any range still shows the data as of the snapshot.
                  onApplyRange?.(
                    nextValue.start.toDate(timeZone).toISOString(),
                    nextValue.end.toDate(timeZone).toISOString()
                  )
                }
              }}
              variant="bordered"
              label={t('chart.time_range')}
              className="w-full"
              showMonthAndYearPickers
              hideTimeZone
              visibleMonths={2}
              selectorButtonPlacement="start"
              color="primary"
              size="sm"
            />
            </div>
            {noticeMessage && (
              <div
                className="mb-2 flex shrink-0 items-start gap-2 rounded px-3 py-2 text-xs"
                role="status"
                style={{
                  background: 'rgba(251,191,36,0.12)',
                  border: '1px solid rgba(251,191,36,0.4)',
                  color: '#b45309',
                }}
              >
                <span aria-hidden>{snapshotNoDataMessage ? '⚠' : '⏱'}</span>
                <span>
                  {noticeMessage}
                  {shownWindowLabel && (
                    <>
                      {' '}
                      <span className="whitespace-nowrap opacity-80">
                        ({shownWindowLabel})
                      </span>
                    </>
                  )}
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <ObservationGraph
                thing={thing}
                datastream={datastream}
                observations={observations}
                comparisonDatastream={comparisonDatastream}
                comparisonObservations={comparisonObservations}
                allSeries={allSeries}
                activeDatastreamIds={activeDatastreamIds}
                onActiveDatastreamsChange={onActiveDatastreamsChange}
                loading={loading}
                error={error}
                onDownloadAllDatastreams={onDownloadAllDatastreams}
                snapshotDate={isAsOfInsideWindow ? asOfDate : undefined}
                windowStart={isAsOfDefaultWindow ? start : null}
                windowEnd={isAsOfDefaultWindow ? end : null}
                height="100%"
              />
            </div>
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
