/**
 * Notification Panel
 *
 * Recipient-addressed notifications for the bell popover, backed by the
 * Notification node with server-side read state. This is NOT the audit log —
 * the full activity feed lives at /protected/audit. Each item is a thing that
 * concerns the current user specifically (an invite, a role change, a resonance
 * on their pulse, a mention).
 */

'use client'

import { useQuery, useMutation, useApolloClient } from '@apollo/client/react'
import { formatDistanceToNow } from 'date-fns'
import { useRouter } from 'next/navigation'
import {
  MY_NOTIFICATIONS_QUERY,
  UNREAD_NOTIFICATION_COUNT_QUERY,
} from '@/app/graphql/queries/NOTIFICATION_QUERIES'
import {
  MARK_NOTIFICATION_READ,
  MARK_ALL_NOTIFICATIONS_READ,
} from '@/app/graphql/mutations/NOTIFICATION_MUTATIONS'

interface NotificationActor {
  id: string
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  photo?: string | null
}

export interface NotificationItem {
  id: string
  type: string
  title: string
  message: string
  link?: string | null
  read: boolean
  readAt?: string | null
  createdAt: string
  metadata?: string | null
  actor?: NotificationActor[] | null
}

interface MyNotificationsResult {
  myNotifications?: NotificationItem[]
}

interface NotificationPanelProps {
  isOpen: boolean
  onClose: () => void
}

/** Material Symbols glyph for each notification type. */
function iconForType(type: string): string {
  switch (type) {
    case 'INVITE':
    case 'MEMBERSHIP':
      return 'group_add'
    case 'ROLE_CHANGE':
      return 'admin_panel_settings'
    case 'RESONANCE':
      return 'hub'
    case 'MENTION':
      return 'alternate_email'
    default:
      return 'notifications'
  }
}

function actorOf(item: NotificationItem): NotificationActor | undefined {
  return Array.isArray(item.actor) ? item.actor[0] : undefined
}

function actorName(actor?: NotificationActor): string | null {
  if (!actor) return null
  const full = `${actor.firstName || ''} ${actor.lastName || ''}`.trim()
  return actor.name || (full === '' ? null : full) || null
}

export function NotificationPanel({ isOpen, onClose }: NotificationPanelProps) {
  const router = useRouter()
  const client = useApolloClient()

  const { data, loading, error } = useQuery<MyNotificationsResult>(
    MY_NOTIFICATIONS_QUERY,
    {
      variables: { limit: 20 },
      skip: !isOpen,
      // Fresh list each time the panel opens; subsequent reads hit cache until
      // a mark-read refetch updates it.
      fetchPolicy: 'network-only',
      nextFetchPolicy: 'cache-first',
    }
  )

  const [markRead] = useMutation(MARK_NOTIFICATION_READ)
  const [markAllRead] = useMutation(MARK_ALL_NOTIFICATIONS_READ)

  const notifications = data?.myNotifications ?? []

  if (!isOpen) return null

  // Clicking an item marks just that one read (badge ticks down), then routes
  // through. Opening the panel does NOT bulk-clear — unread state is meaningful
  // until the user acts (per-item click or the explicit "Mark all read").
  const handleClickThrough = async (item: NotificationItem) => {
    if (!item.read) {
      markRead({ variables: { id: item.id } })
        .then(() =>
          client.refetchQueries({ include: [UNREAD_NOTIFICATION_COUNT_QUERY] })
        )
        .catch(() => null)
    }
    onClose()
    if (item.link) router.push(item.link)
  }

  const handleMarkAll = () => {
    markAllRead()
      .then(() =>
        client.refetchQueries({
          include: [UNREAD_NOTIFICATION_COUNT_QUERY, MY_NOTIFICATIONS_QUERY],
        })
      )
      .catch((err) => console.warn('Failed to mark all read:', err))
  }

  return (
    // Opaque surface, not `gp-glass`. This panel renders inside the studio
    // header, which is itself `gp-glass` — an ancestor `backdrop-filter`
    // establishes a backdrop root, so a nested `backdrop-filter` has nothing
    // left to sample and silently no-ops. All that survived was the 70%-alpha
    // glass fill, which let the page bleed through the notification text.
    // `--gp-surface-strong` is fully opaque in light and dark across all five
    // themes, and matches the user menu dropdown beside it.
    <div className="bg-gp-surface-strong border border-gp-glass-border fixed inset-x-3 top-20 max-h-[70vh] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 sm:max-h-[28rem] rounded-2xl shadow-xl z-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gp-glass-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-gp-primary text-xl shrink-0">
            notifications
          </span>
          <h2 className="font-semibold text-gp-ink-strong truncate">
            Notifications
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {notifications.length > 0 && (
            <button
              onClick={handleMarkAll}
              className="text-xs font-medium text-gp-primary hover:text-gp-primary/80 transition-colors cursor-pointer px-1.5 py-1 rounded-md"
            >
              Mark all read
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center justify-center size-7 rounded-md text-gp-ink-muted hover:text-gp-ink-strong transition-colors"
            aria-label="Close notifications"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full size-6 border-b-2 border-gp-primary" />
          </div>
        )}

        {error && !loading && (
          <div className="px-4 py-3 text-sm text-destructive">
            Failed to load notifications.
          </div>
        )}

        {!loading && !error && notifications.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center px-4">
            <span className="material-symbols-outlined text-4xl text-gp-ink-soft mb-2">
              notifications_off
            </span>
            <p className="text-sm text-gp-ink-muted">No notifications yet</p>
          </div>
        )}

        {!loading && notifications.length > 0 && (
          <div className="divide-y divide-gp-glass-border">
            {notifications.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onActivate={handleClickThrough}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gp-glass-border">
        <button
          className="text-sm font-medium text-gp-primary hover:text-gp-primary/80 transition-colors cursor-pointer"
          onClick={() => {
            onClose()
            router.push('/protected/audit')
          }}
        >
          View activity log
        </button>
      </div>
    </div>
  )
}

function NotificationRow({
  item,
  onActivate,
}: {
  item: NotificationItem
  onActivate: (item: NotificationItem) => void
}) {
  const timeAgo = formatDistanceToNow(new Date(item.createdAt), {
    addSuffix: true,
  })
  const actor = actorOf(item)
  const name = actorName(actor)

  return (
    <button
      onClick={() => onActivate(item)}
      className="gp-menu-item w-full text-left px-4 py-3 flex gap-3 items-start"
    >
      {/* Type icon */}
      <span className="flex items-center justify-center size-8 rounded-full bg-gp-primary/15 text-gp-primary shrink-0">
        <span className="material-symbols-outlined text-lg">
          {iconForType(item.type)}
        </span>
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gp-ink-strong truncate">
          {item.title}
        </p>
        <p className="text-sm text-gp-ink-muted wrap-break-word whitespace-normal mt-0.5">
          {item.message}
        </p>
        <p className="text-xs text-gp-ink-soft mt-1 truncate">
          {name ? `${name} · ` : ''}
          {timeAgo}
        </p>
      </div>

      {/* Unread dot */}
      {!item.read && (
        <span className="size-2 rounded-full bg-gp-primary shrink-0 mt-1.5" />
      )}
    </button>
  )
}

/**
 * Hook for the bell badge unread count. Server-side, recipient-scoped, polled
 * every 60s. No localStorage — read state lives on the Notification node, so
 * the count is correct across devices and survives reload.
 *
 * Scoping happens via the JWT inside the resolver, so no userId arg is needed.
 */
export function useUnreadCount(): number {
  const { data } = useQuery<{ unreadNotificationCount?: number }>(
    UNREAD_NOTIFICATION_COUNT_QUERY,
    {
      pollInterval: 60000,
      fetchPolicy: 'cache-and-network',
    }
  )
  return Number(data?.unreadNotificationCount || 0)
}
