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
 * @file features/from-to/hooks/useRelatedEntities.ts
 *
 * Loads the entity rail.
 *
 * Kept separate from `useEntityHistory` on purpose: the rail costs one read per
 * relation plus one count per related entity, so it is slower than the history
 * itself. The page renders its timeline, versions and diff from the history
 * response, and the rail fills in when it arrives — a failure here leaves the
 * page working.
 */

import { useEffect, useState } from 'react'

import { normalizedBasePath } from '@/app/home/utils'
import type { HistoryWindow } from '@/features/from-to/lib/historyWindow'

const RELATED_API = `${normalizedBasePath}/api/from-to/related`

export type RelatedEntity = {
  path: string
  id: string
  name: string
  /** Versions in the window, or `null` when the count could not be read. */
  count: number | null
}

export type RelatedGroup = {
  relation: string
  set: string
  /** How many related entities exist, regardless of how many are listed. */
  total: number | null
  /** True when the relation is too large to list — a Datastream's 2016 Observations. */
  tooMany: boolean
  items: RelatedEntity[]
}

export function useRelatedEntities(
  path: string,
  window: HistoryWindow | null,
): { groups: RelatedGroup[]; loading: boolean } {
  const [groups, setGroups] = useState<RelatedGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!path || !window) {
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)

    fetch(RELATED_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, from: window.from, to: window.to }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null)
        if (!active) return
        setGroups(payload?.ok && Array.isArray(payload.groups) ? payload.groups : [])
      })
      .catch(() => {
        if (active) setGroups([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [path, window?.from, window?.to])

  return { groups, loading }
}
