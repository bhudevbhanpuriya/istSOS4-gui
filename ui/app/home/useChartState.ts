import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { useEffect, useMemo, useRef, useState } from 'react'

import { siteConfig } from '@/config/site'
import { clampToSnapshotWindow, getSnapshotWindow } from '@/features/as-of/lib/snapshotWindow'
import { getDataSourceToken } from '@/lib/dataSourceTokens'
import { getObservationsByDatastream } from '@/services/observations'
import { Datastream, Observation, Thing } from '@/types/domain'

import { getThingKey } from './utils'

dayjs.extend(utc)

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

export function useChartState({
  localThings,
  token,
  asOfDate,
}: {
  localThings: Thing[]
  token?: string | null
  asOfDate?: string | null
}) {
  const [selectedThingId, setSelectedThingId] = useState<string | null>(null)
  const [selectedObservedPropertyName, setSelectedObservedPropertyName] =
    useState<string | null>(null)
  const [tableObservedPropertyFilter, setTableObservedPropertyFilter] =
    useState<string | null>(null)
  const [selectedThingKeysForChart, setSelectedThingKeysForChart] = useState<
    string[]
  >([])
  const [
    selectedObservedPropertyNamesForChart,
    setSelectedObservedPropertyNamesForChart,
  ] = useState<string[]>([])
  const [isChartOpen, setIsChartOpen] = useState(false)
  const [selectedDatastream, setSelectedDatastream] =
    useState<Datastream | null>(null)
  const [comparisonDatastream, setComparisonDatastream] =
    useState<Datastream | null>(null)
  const [activeDatastreamIds, setActiveDatastreamIds] = useState<string[]>([])
  const [obsLoading, setObsLoading] = useState(false)
  const [obsError, setObsError] = useState<string | null>(null)
  const [obsStart, setObsStart] = useState<string | null>(null)
  const [obsEnd, setObsEnd] = useState<string | null>(null)
  const obsCacheRef = useRef<Map<string, Observation[]>>(new Map())
  // Tracks the asOfDate context that obsStart/obsEnd + cache belong to, so a
  // range left over from a different snapshot (or from live mode) is never
  // reused when the snapshot context changes.
  const prevAsOfRef = useRef(asOfDate)
  // Trailing-edge timer for the open-chart refetch (keeps continuous scrubber
  // dragging from firing a network request on every tick).
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [comparisonObservations, setComparisonObservations] = useState<
    Observation[]
  >([])
  const [allSeries, setAllSeries] = useState<
    Array<{ datastream: Datastream; observations: Observation[] }>
  >([])

  const selectedThing = useMemo(() => {
    if (!selectedThingId) return null
    return localThings.find((thing) => getThingKey(thing) === selectedThingId) ?? null
  }, [localThings, selectedThingId])

  const isPanelOpen = !!selectedThing
  const thingKeyFor = (thing: Thing) =>
    `${String(thing?.__sourceId ?? thing?.__sourceEndpoint ?? '0')}::${String(
      thing?.['@iot.id'] ?? thing?.id ?? thing?.name ?? ''
    )}`

  const resetChartState = () => {
    setIsChartOpen(false)
    setSelectedDatastream(null)
    setComparisonDatastream(null)
    setActiveDatastreamIds([])
    setObservations([])
    setComparisonObservations([])
    setAllSeries([])
    setObsError(null)
    setObsLoading(false)
    setObsStart(null)
    setObsEnd(null)
    // Cancel any pending trailing-edge refetch so it can't fire after close
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current)
      refetchTimerRef.current = null
    }
    // Clear cache so snapshot results never bleed into live mode and vice versa
    obsCacheRef.current.clear()
  }

  const closePanel = () => {
    setSelectedThingId(null)
    setSelectedObservedPropertyName(null)
    setTableObservedPropertyFilter(null)
    resetChartState()
  }

  const fetchObservations = async (
    datastreamId: string,
    phenomenonTime?: string,
    range?: { start?: string | null; end?: string | null },
    sourceEndpoint?: string
  ) => {
    let startIso = range?.start ?? null
    let endIso = range?.end ?? null
    const resolvedEndpoint =
      sourceEndpoint?.trim().replace(/\/+$/, '') ?? siteConfig.api_root

    if (asOfDate) {
      // Snapshot mode: the window is strictly [asOfDate-7d, asOfDate], clamped on
      // BOTH ends. Anything outside it belongs to a different point in time than
      // the snapshot being viewed, so a stale range (e.g. one left over from an
      // earlier selection in this same snapshot) must never silently pull the
      // chart to another date — when the window is empty the user is told so
      // instead. Clamping here makes that invariant hold for every caller.
      const clamped = clampToSnapshotWindow(asOfDate, startIso, endIso)
      startIso = clamped.startIso
      endIso = clamped.endIso
    } else if (!startIso || !endIso) {
      // Live mode: default window is [lastObs-7d, lastObs]
      const [, endRaw] = phenomenonTime?.split('/') ?? []
      const end = endRaw ? dayjs.utc(endRaw) : dayjs.utc()
      const start = end.subtract(7, 'day')
      endIso = end.toISOString()
      startIso = start.toISOString()
    }

    // Namespace cache key by asOfDate so snapshot/live results never collide
    const cacheKey = `${resolvedEndpoint}|${datastreamId}|${startIso}|${endIso}|${asOfDate ?? 'live'}`
    const cached = obsCacheRef.current.get(cacheKey)
    if (cached) return { data: cached, startIso, endIso }

    const sourceToken = getDataSourceToken(resolvedEndpoint)
    const { observationData } = await getObservationsByDatastream(
      sourceToken ?? token ?? undefined,
      datastreamId,
      startIso ?? undefined,
      endIso ?? undefined,
      resolvedEndpoint,
      asOfDate ?? null
    )
    obsCacheRef.current.set(cacheKey, observationData)
    return { data: observationData, startIso, endIso }
  }

  const loadPrimaryObservations = async (
    datastreamId: string,
    phenomenonTime?: string,
    range?: { start?: string | null; end?: string | null },
    sourceEndpoint?: string
  ) => {
    setObsLoading(true)
    setObsError(null)
    try {
      const result = await fetchObservations(
        datastreamId,
        phenomenonTime,
        range,
        sourceEndpoint
      )
      setObservations(result.data)
      setObsStart(result.startIso)
      setObsEnd(result.endIso)
    } catch (error: unknown) {
      setObsError(toErrorMessage(error, 'Failed to load observations'))
      setObservations([])
    } finally {
      setObsLoading(false)
    }
  }

  const loadComparisonObservations = async (
    ds: Datastream | null,
    range?: { start?: string | null; end?: string | null }
  ) => {
    if (!ds) {
      setComparisonObservations([])
      return
    }
    const dsId = String(ds?.['@iot.id'] ?? ds?.id ?? '')
    if (!dsId) {
      setComparisonObservations([])
      return
    }
    const sourceEndpoint = String(
      ds?.__sourceEndpoint ?? selectedThing?.__sourceEndpoint ?? siteConfig.api_root
    )
    const result = await fetchObservations(
      dsId,
      ds?.phenomenonTime,
      range,
      sourceEndpoint
    )
    setComparisonObservations(result.data)
  }

  const loadAllDatastreamObservationsForThing = async (
    thing: Thing,
    range?: { start?: string | null; end?: string | null },
    options?: { observedPropertyNameFilter?: string | null }
  ) => {
    const allThingDatastreams = Array.isArray(thing?.Datastreams) ? thing.Datastreams : []
    const filterName = String(options?.observedPropertyNameFilter ?? '')
      .trim()
      .toLowerCase()
    const thingDatastreams = filterName
      ? allThingDatastreams.filter((ds) =>
          String(ds?.ObservedProperty?.name ?? '')
            .trim()
            .toLowerCase()
            .includes(filterName)
        )
      : allThingDatastreams
    const entries = await Promise.all(
      thingDatastreams.map(async (ds) => {
        const dsId = String(ds?.['@iot.id'] ?? ds?.id ?? '')
        if (!dsId) return { datastream: ds, observations: [] as Observation[] }
        const sourceEndpoint = String(
          ds?.__sourceEndpoint ?? thing?.__sourceEndpoint ?? siteConfig.api_root
        )
        const result = await fetchObservations(
          dsId,
          ds?.phenomenonTime,
          range,
          sourceEndpoint
        )
        return { datastream: ds, observations: result.data }
      })
    )
    setAllSeries(entries)
  }

  const openChartForThingAndObservedProperties = async (
    thingKeys: string[],
    observedPropertyNames: string[],
    preferredDatastreamId?: string,
    // When provided, overrides the current obsStart/obsEnd for the fetch — used
    // by the asOfDate effect to force a fresh default window (null range) on the
    // whole selection instead of reusing a range from the previous snapshot.
    rangeOverride?: { start?: string | null; end?: string | null },
    // When provided, keeps this active datastream selection instead of
    // collapsing to the primary (preserves comparisons across snapshot changes).
    activeIdsOverride?: string[]
  ) => {
    setIsChartOpen(true)
    const keys = Array.from(new Set(thingKeys)).filter(Boolean)
    const ops = Array.from(new Set(observedPropertyNames.map((name) => name.trim()).filter(Boolean)))
    setSelectedThingKeysForChart(keys)
    setSelectedObservedPropertyNamesForChart(ops)

    const selectedThingsForChart = localThings.filter((thing) =>
      keys.includes(thingKeyFor(thing))
    )
    const primaryThing = selectedThingsForChart[0] ?? null
    setSelectedThingId(primaryThing ? getThingKey(primaryThing) : null)
    setSelectedObservedPropertyName(ops[0] ?? null)

    const datastreamCandidates = selectedThingsForChart.flatMap((thing) =>
      (Array.isArray(thing?.Datastreams) ? thing.Datastreams : []).filter(
        (ds) =>
          ops.length === 0 ||
          ops.some(
            (op) =>
              String(ds?.ObservedProperty?.name ?? '').trim().toLowerCase() ===
              op.toLowerCase()
          )
      )
    )
    const preferredId = String(preferredDatastreamId ?? '').trim()
    const primaryDatastream =
      (preferredId
        ? datastreamCandidates.find(
            (ds) =>
              String(ds?.['@iot.id'] ?? ds?.id ?? '').trim() === preferredId
          )
        : null) ??
      datastreamCandidates[0] ??
      null
    // Preserve an existing active selection (e.g. a two-datastream comparison)
    // when the caller passes one — used by the asOfDate refetch so moving the
    // snapshot re-fetches every series without collapsing back to the primary.
    const overrideActiveIds = (activeIdsOverride ?? [])
      .map((id) => String(id).trim())
      .filter(Boolean)
    const findCandidateById = (id: string) =>
      datastreamCandidates.find(
        (ds) => String(ds?.['@iot.id'] ?? ds?.id ?? '').trim() === id
      ) ?? null
    const secondaryDatastream =
      overrideActiveIds[1] ? findCandidateById(overrideActiveIds[1]) : null
    setSelectedDatastream(primaryDatastream)
    setComparisonDatastream(secondaryDatastream)
    setComparisonObservations([])
    setActiveDatastreamIds(
      overrideActiveIds.length
        ? overrideActiveIds
        : primaryDatastream
          ? [String(primaryDatastream?.['@iot.id'] ?? primaryDatastream?.id ?? '')]
          : []
    )

    const nextSeries: Array<{
      datastream: Datastream
      observations: Observation[]
    }> = []
    let resolvedStart: string | null = null
    let resolvedEnd: string | null = null
    const primaryId = String(
      primaryDatastream?.['@iot.id'] ?? primaryDatastream?.id ?? ''
    ).trim()

    for (const ds of datastreamCandidates) {
      const dsId = String(ds?.['@iot.id'] ?? ds?.id ?? '').trim()
      if (!dsId) continue
      const sourceEndpoint = String(
        ds?.__sourceEndpoint ?? primaryThing?.__sourceEndpoint ?? siteConfig.api_root
      )
      const result = await fetchObservations(
        dsId,
        ds?.phenomenonTime,
        rangeOverride ?? { start: obsStart, end: obsEnd },
        sourceEndpoint
      )
      nextSeries.push({ datastream: ds, observations: result.data })
      if (dsId === primaryId) {
        resolvedStart = result.startIso ?? null
        resolvedEnd = result.endIso ?? null
      }
    }
    setAllSeries(nextSeries)
    setObservations(nextSeries[0]?.observations ?? [])
    if (resolvedStart && resolvedEnd) {
      setObsStart(resolvedStart)
      setObsEnd(resolvedEnd)
    }
  }

  const openChartForDatastream = async (ds: Datastream) => {
    const dsId = String(ds?.['@iot.id'] ?? ds?.id ?? '').trim()
    if (!dsId) {
      setObsError('Missing datastream id')
      setObservations([])
      return
    }
    const thingKeys =
      selectedThing && thingKeyFor(selectedThing) ? [thingKeyFor(selectedThing)] : []
    const opName = String(ds?.ObservedProperty?.name ?? '').trim()
    const observedPropertyNames =
      tableObservedPropertyFilter && tableObservedPropertyFilter.trim()
        ? [tableObservedPropertyFilter.trim()]
        : opName
          ? [opName]
          : []
    await openChartForThingAndObservedProperties(
      thingKeys,
      observedPropertyNames,
      dsId
    )
  }

  const applyObservationRange = async (start?: string | null, end?: string | null) => {
    const dsId = String(selectedDatastream?.['@iot.id'] ?? selectedDatastream?.id ?? '')
    if (!dsId) return
    const sourceEndpoint = String(
      selectedDatastream?.__sourceEndpoint ??
        selectedThing?.__sourceEndpoint ??
        siteConfig.api_root
    )
    await loadPrimaryObservations(
      dsId,
      selectedDatastream?.phenomenonTime,
      { start, end },
      sourceEndpoint
    )
    if (comparisonDatastream) {
      try {
        await loadComparisonObservations(comparisonDatastream, { start, end })
      } catch (error: unknown) {
        setObsError(toErrorMessage(error, 'Failed to load observations'))
      }
    }
    if (selectedThing) {
      await loadAllDatastreamObservationsForThing(
        selectedThing,
        { start, end },
        { observedPropertyNameFilter: selectedObservedPropertyName }
      )
    }
  }

  const changeActiveDatastreams = async (nextDatastreamIds: string[]) => {
    const normalizedIdsRaw = Array.from(
      new Set(nextDatastreamIds.map((id) => String(id).trim()).filter(Boolean))
    ).slice(0, 2)
    const currentPrimaryId = String(activeDatastreamIds[0] ?? '')
    const normalizedIds = [...normalizedIdsRaw]
    if (
      currentPrimaryId &&
      normalizedIds.length > 1 &&
      normalizedIds.includes(currentPrimaryId) &&
      normalizedIds[0] !== currentPrimaryId
    ) {
      normalizedIds.splice(normalizedIds.indexOf(currentPrimaryId), 1)
      normalizedIds.unshift(currentPrimaryId)
    }
    setActiveDatastreamIds(normalizedIds)

    const getById = (id: string) =>
      allSeries.find(
        (entry) =>
          String(entry?.datastream?.['@iot.id'] ?? entry?.datastream?.id ?? '') ===
          id
      )?.datastream ?? null

    const primary = normalizedIds[0] ? getById(normalizedIds[0]) : null
    const secondary = normalizedIds[1] ? getById(normalizedIds[1]) : null
    setSelectedDatastream(primary)
    setComparisonDatastream(secondary)
    const activeObservedPropertyNames = [primary, secondary]
      .map((ds) => String(ds?.ObservedProperty?.name ?? '').trim())
      .filter(Boolean)
    const uniqueActiveObservedPropertyNames = Array.from(
      new Set(activeObservedPropertyNames)
    )
    setSelectedObservedPropertyNamesForChart(uniqueActiveObservedPropertyNames)
    setSelectedObservedPropertyName(uniqueActiveObservedPropertyNames[0] ?? null)

    if (!primary) {
      setSelectedDatastream(null)
      setComparisonDatastream(null)
      setObservations([])
      setComparisonObservations([])
      return
    }

    const primaryId = String(primary?.['@iot.id'] ?? primary?.id ?? '')
    const primarySeries =
      allSeries.find(
        (entry) =>
          String(entry?.datastream?.['@iot.id'] ?? entry?.datastream?.id ?? '') ===
          primaryId
      ) ?? null
    setObservations(primarySeries?.observations ?? [])

    if (!secondary) {
      setComparisonObservations([])
      return
    }

    const secondaryId = String(secondary?.['@iot.id'] ?? secondary?.id ?? '')
    const secondarySeries =
      allSeries.find(
        (entry) =>
          String(entry?.datastream?.['@iot.id'] ?? entry?.datastream?.id ?? '') ===
          secondaryId
      ) ?? null
    setComparisonObservations(secondarySeries?.observations ?? [])
  }

  const onMapThingSelect = (
    thing: Thing,
    selection?: { observedPropertyName?: string }
  ) => {
    setSelectedThingId(getThingKey(thing))
    setSelectedObservedPropertyName(selection?.observedPropertyName?.trim() || null)
    setTableObservedPropertyFilter(selection?.observedPropertyName?.trim() || null)
    setSelectedDatastream(null)
    setComparisonDatastream(null)
    setObservations([])
    setComparisonObservations([])
    setObsError(null)
  }

  // When the snapshot context (asOfDate) changes, the persisted chart range and
  // cache belong to the *old* context and must not be reused. Re-anchor the
  // range to the new default window immediately, and — only if a chart is open —
  // refetch its data on the trailing edge so continuous scrubber dragging does
  // not fire a request per tick.
  useEffect(() => {
    if (prevAsOfRef.current === asOfDate) return
    prevAsOfRef.current = asOfDate

    // Stale results must never bleed across snapshot (or live) contexts
    obsCacheRef.current.clear()

    // Fresh default window: [asOfDate-7d, asOfDate] in snapshot mode; in live
    // mode leave it empty so the phenomenonTime-based default takes over.
    const snapshotWindow = asOfDate ? getSnapshotWindow(asOfDate) : null
    const [nextStart, nextEnd] = snapshotWindow
      ? [snapshotWindow.startIso, snapshotWindow.endIso]
      : [null, null]

    // Re-anchor the displayed range right away (fixes the stale "Time range")
    setObsStart(nextStart)
    setObsEnd(nextEnd)

    if (isChartOpen && selectedDatastream) {
      refetchTimerRef.current = setTimeout(() => {
        // Refetch the WHOLE current selection (all things / observed properties)
        // with a fresh null range, so every series re-anchors to the new
        // snapshot window — not just the primary datastream.
        void openChartForThingAndObservedProperties(
          selectedThingKeysForChart,
          selectedObservedPropertyNamesForChart,
          activeDatastreamIds[0],
          { start: null, end: null },
          activeDatastreamIds
        )
      }, 300)
    }

    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current)
        refetchTimerRef.current = null
      }
    }
    // Only react to asOfDate; other values are read from the current closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOfDate])

  return {
    selectedThing,
    isPanelOpen,
    selectedObservedPropertyName,
    tableObservedPropertyFilter,
    selectedThingKeysForChart,
    selectedObservedPropertyNamesForChart,
    isChartOpen,
    selectedDatastream,
    observations,
    comparisonDatastream,
    comparisonObservations,
    allSeries,
    obsLoading,
    obsError,
    obsStart,
    obsEnd,
    activeDatastreamIds,
    setIsChartOpen,
    setSelectedDatastream,
    setComparisonDatastream,
    setActiveDatastreamIds,
    setObservations,
    setComparisonObservations,
    setAllSeries,
    setObsError,
    setObsLoading,
    setObsStart,
    setObsEnd,
    fetchObservations,
    closePanel,
    resetChartState,
    onMapThingSelect,
    openChartForDatastream,
    openChartForThingAndObservedProperties,
    applyObservationRange,
    changeActiveDatastreams,
  }
}
