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

'use client'

/**
 * @file features/users/components/CommitAuthor.tsx
 *
 * The author of a commit, as a clickable name that opens the user's details.
 *
 * The label is the username once it resolves and `User <id>` until then — or
 * for good, when the caller may not read users. `anonymous` and unrecognised
 * authors render as plain text: there is no one to look up.
 *
 * What the popover can show is decided by the backend: any authenticated user
 * sees username, role and id; only an administrator also receives `contact`.
 * On an API without `GET /Users(id)` only administrators see anything, and on
 * one running without authorization the label is plain text.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@heroui/popover'
import { Spinner } from '@heroui/spinner'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/context/AuthContext'
import { useUser, type UserLookup } from '@/features/users/hooks/useUser'
import { parseAuthorUri } from '@/features/users/lib/authorUri'

export type CommitAuthorProps = {
  /** The commit's `author` field, e.g. `/Users(1)`. */
  author: string | null | undefined
  /** Data source the commit came from; the primary one when omitted. */
  endpoint?: string | null
  /** Classes for the trigger, so it can match the surrounding text. */
  className?: string
}

export default function CommitAuthor({ author, endpoint, className = '' }: CommitAuthorProps) {
  const { t } = useTranslation()
  const parsed = parseAuthorUri(author)
  const lookup = useUser(parsed.kind === 'user' ? parsed.id : null, endpoint)

  if (parsed.kind === 'anonymous') {
    return <span className={className}>{t('users.anonymous')}</span>
  }
  if (parsed.kind === 'unknown') {
    return <span className={className}>{parsed.raw || '—'}</span>
  }

  const label =
    lookup?.kind === 'user'
      ? lookup.user.username
      : t('users.fallback_label', { id: parsed.id })

  // A server running without authorization has no users to show — the author
  // survives only from commits written while it was on. Nothing to open.
  if (lookup?.kind === 'unavailable') {
    return <span className={className}>{label}</span>
  }

  return (
    <Popover placement="bottom-start" offset={6} classNames={{ base: 'z-[4000]' }}>
      <PopoverTrigger>
        <button
          type="button"
          // Rows that host the chip are often clickable themselves.
          onClick={(event) => event.stopPropagation()}
          className={`cursor-pointer underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
          title={t('users.show_details')}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-[280px] p-3">
        <UserCard id={parsed.id} lookup={lookup} />
      </PopoverContent>
    </Popover>
  )
}

function UserCard({ id, lookup }: { id: string; lookup: UserLookup | null }) {
  const { t } = useTranslation()
  const { token } = useAuth()

  if (!lookup || lookup.kind === 'loading') {
    return <Spinner size="sm" />
  }

  if (lookup.kind !== 'user') {
    const message =
      lookup.kind === 'denied'
        ? t(token ? 'users.session_expired' : 'users.denied')
        : lookup.kind === 'forbidden'
          ? t('users.forbidden')
          : lookup.kind === 'missing'
            ? t('users.missing')
            : t('users.error')
    return (
      <div className="w-full text-tiny">
        <p className="font-semibold">{t('users.fallback_label', { id })}</p>
        <p className="mt-1 text-default-500">{message}</p>
      </div>
    )
  }

  const { user } = lookup
  const contact = contactEntries(user.contact)

  return (
    <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-tiny">
      <dt className="text-default-400">{t('users.username')}</dt>
      <dd className="font-semibold [overflow-wrap:anywhere]">{user.username}</dd>
      <dt className="text-default-400">{t('users.role')}</dt>
      <dd>{user.role}</dd>
      <dt className="text-default-400">{t('users.id')}</dt>
      <dd className="font-mono">{user.id}</dd>
      {contact.map(([key, value]) => (
        <ContactRow key={key} label={key} value={value} />
      ))}
    </dl>
  )
}

function ContactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-default-400">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{value}</dd>
    </>
  )
}

/** `contact` is free jsonb: flatten one level for display, stringify the rest. */
function contactEntries(contact: unknown): Array<[string, string]> {
  if (contact == null || contact === '') return []
  if (typeof contact !== 'object' || Array.isArray(contact)) {
    return [['contact', typeof contact === 'string' ? contact : JSON.stringify(contact)]]
  }
  return Object.entries(contact as Record<string, unknown>)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
}
