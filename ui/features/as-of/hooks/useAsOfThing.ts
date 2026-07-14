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

import { useEffect, useState } from 'react'

import type { Thing } from '@/types/domain'
import { activeAdapter, type ExistenceState } from '../adapters/asOfAdapter'

// ---------------------------------------------------------------------------
// Types (re-exported for consumers)
// ---------------------------------------------------------------------------

export type { ExistenceState } from '../adapters/asOfAdapter'

export type AsOfThingResult = {
  /** The thing as it existed at asOfDate (or the live thing when not in snapshot mode) */
  snapshotThing: Thing | null
  isLoading: boolean
  error: string | null
  /**
   * 'exists'          — a valid version was resolved for asOfDate.
   * 'not-yet-created' — asOfDate is before the Thing's earliest version.
   * 'deleted'         — asOfDate is after the Thing's last closed version.
   * Always 'exists' in live mode (asOfDate is null).
   */
  existenceState: ExistenceState
  /** ISO dates of the Thing's creation and (optional) decommission time. */
  existenceRange: { createdAt: string | null; deletedAt: string | null }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Resolves the thing a user sees in the DatastreamTable at a given point in time.
 *
 * - When `asOfDate` is null: returns the live thing unchanged.
 * - Delegates to `activeAdapter.resolveThing()` which handles both mock
 *   (local dummy data) and real API (`$as_of` endpoint) modes transparently.
 *
 * To switch between mock and real modes, set the env variable:
 *   `NEXT_PUBLIC_VERSIONING_ENABLED=true`
 *
 * Re-fires automatically when selectedThing or asOfDate changes.
 */
export function useAsOfThing({
  thing,
  asOfDate,
}: {
  thing: Thing | null
  asOfDate: string | null
}): AsOfThingResult {
  const [snapshotThing, setSnapshotThing] = useState<Thing | null>(thing)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existenceState, setExistenceState] = useState<ExistenceState>('exists')
  const [existenceRange, setExistenceRange] = useState<{
    createdAt: string | null
    deletedAt: string | null
  }>({ createdAt: null, deletedAt: null })

  useEffect(() => {
    // Live mode — always show the thing as-is
    if (!asOfDate || !thing) {
      setSnapshotThing(thing)
      setIsLoading(false)
      setError(null)
      setExistenceState('exists')
      setExistenceRange({ createdAt: null, deletedAt: null })
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    activeAdapter
      .resolveThing(thing, asOfDate)
      .then((result) => {
        if (cancelled) return
        setSnapshotThing(result.thing)
        setExistenceState(result.existenceState)
        setExistenceRange(result.existenceRange)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[useAsOfThing] Error resolving snapshot:', err)
        setError(String(err))
        // Fall back to live thing so UI is never blank
        setSnapshotThing(thing)
        setExistenceState('exists')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [thing, asOfDate])

  return { snapshotThing, isLoading, error, existenceState, existenceRange }
}
