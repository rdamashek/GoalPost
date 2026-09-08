'use client'

import { type FC, useEffect, useState, useCallback } from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  fetchThreadList,
  type ThreadSummary,
} from '@/lib/simulation/conversation-thread-client'
import {
  onAssistantMessageSent,
  onAssistantThreadUpdated,
} from '@/lib/simulation/assistant-panel-events'

interface ThreadsSidebarProps {
  activeThreadId: string | null
  onSelectThread: (id: string, opts?: { isNew?: boolean }) => void
  /**
   * Create a new thread ("+" button). Resolves to the new threadId on
   * success, or `null` if the create failed.
   */
  onNewThread: () => Promise<string | null>
}

const COLLAPSED_KEY = 'goalpost.studio.threadsSidebarCollapsed'

/**
 * Relative "time ago" label for a thread's last activity. Granular at the
 * bottom (seconds/minutes) so a just-created or just-answered thread reads
 * "just now" / "2 minutes ago" instead of a flat "Today", then coarsens to
 * hours, days, and finally an absolute date past a week. Re-evaluated on the
 * sidebar's `nowTick` so labels age in place while the panel stays open.
 */
function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const diffMs = Date.now() - then
    // Guard against clock skew / future timestamps — never show "-3s ago".
    if (diffMs < 0) return 'just now'
    const sec = Math.floor(diffMs / 1000)
    if (sec < 5) return 'just now'
    if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'} ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
    const days = Math.floor(hr / 24)
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    return new Date(then).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

export const ThreadsSidebar: FC<ThreadsSidebarProps> = ({
  activeThreadId,
  onSelectThread,
  onNewThread,
}) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // Re-render every 10s so the relative "time ago" labels age in place — a
  // thread that read "just now" becomes "2 minutes ago" without needing a
  // refetch or a new turn. `formatDate` reads the wall clock on each render.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 10_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored === 'true') setCollapsed(true)
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        localStorage.setItem(COLLAPSED_KEY, String(next))
      }
      return next
    })
  }, [])

  const fetchThreads = useCallback(async () => {
    try {
      const list = await fetchThreadList()
      setThreads(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchThreads() }, [fetchThreads])

  // Refetch on each assistant-thread-updated signal. The chat route persists
  // the new turn + auto-generates the thread title fire-and-forget after the
  // stream ends, so we refetch on a schedule: immediately (to surface the
  // thread), +2.5s, and +6s. The gpt-4o-mini title call can take 1–4s after
  // the stream completes, and a single 2.5s retry was missing the title
  // write in the e2e measurements — the third refetch closes that window.
  useEffect(() => {
    const timeouts = new Set<number>()
    const scheduleRefetch = (delay: number) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id)
        void fetchThreads()
      }, delay)
      timeouts.add(id)
    }
    const unsubscribe = onAssistantThreadUpdated(() => {
      void fetchThreads()
      scheduleRefetch(2500)
      scheduleRefetch(6000)
    })
    return () => {
      unsubscribe()
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [fetchThreads])

  // Once the user asks a question, collapse into focus mode so the chat gets
  // the room. We set state directly (not via toggleCollapsed) so this does NOT
  // persist to localStorage — it's a per-session focus behavior that leaves the
  // user's stored expand/collapse default untouched.
  useEffect(() => {
    return onAssistantMessageSent(() => setCollapsed(true))
  }, [])

  const handleNewThread = useCallback(async (): Promise<string | null> => {
    setCreating(true)
    try {
      const id = await onNewThread()
      await fetchThreads()
      return id
    } finally {
      setCreating(false)
    }
  }, [onNewThread, fetchThreads])

  // GOAL-345: there is deliberately NO auto-create here. A member with zero
  // threads used to have one minted on first load purely so this sidebar
  // wasn't empty — which persisted a `New thread` node into the graph on a
  // page load that never sent a message. The empty landing conversation is now
  // the intended first-run state, so the placeholder row below stands in for it
  // visually and the thread is created lazily on the member's first send.

  if (collapsed) {
    return (
      <aside className="flex flex-col h-full w-10 shrink-0 gp-glass border-r border-gp-glass-border items-center py-3 gap-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand threads"
          title="Expand threads"
          className="flex items-center justify-center size-7 rounded-md text-gp-ink-muted dark:text-white/55 hover:text-gp-ink-strong dark:hover:text-white hover:bg-white/40 dark:hover:bg-white/10 transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => void handleNewThread()}
          disabled={creating}
          aria-label="New conversation"
          title="New conversation"
          className={cn(
            'flex items-center justify-center size-7 rounded-full transition-all cursor-pointer',
            'bg-gp-primary/10 hover:bg-gp-primary/20 text-gp-primary',
            'disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          {creating ? (
            <span className="material-symbols-outlined text-[18px] leading-none animate-spin">
              progress_activity
            </span>
          ) : (
            <Plus className="w-4 h-4" />
          )}
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex flex-col h-full w-60 shrink-0 gp-glass border-r border-gp-glass-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="section-title text-xs font-bold uppercase tracking-widest text-gp-accent-glow">
          Threads
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleNewThread()}
            disabled={creating}
            title="New conversation"
            aria-label="New conversation"
            className={cn(
              'flex items-center justify-center size-7 rounded-full transition-all cursor-pointer',
              'bg-gp-primary/10 hover:bg-gp-primary/20 text-gp-primary',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            <span
              className={cn(
                'material-symbols-outlined text-[16px] leading-none',
                creating && 'animate-spin'
              )}
            >
              {creating ? 'progress_activity' : 'add'}
            </span>
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Collapse threads"
            title="Collapse threads"
            className="flex items-center justify-center size-7 rounded-md text-gp-ink-muted dark:text-white/55 hover:text-gp-ink-strong dark:hover:text-white hover:bg-white/40 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mx-3 h-px bg-gp-glass-border mb-1" />

      {/* List */}
      <nav className="flex-1 overflow-y-auto py-1 space-y-0.5 px-2">
        {loading && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gp-primary/40" />
          </div>
        )}

        {/* The empty landing conversation (GOAL-345), or a member with no
            threads at all. This row is purely visual — nothing is persisted
            until the first send, at which point the real thread replaces it. */}
        {!loading && threads.length === 0 && (
          <div
            aria-current="true"
            className="nav-item active w-full text-left rounded-lg px-3 py-2.5 bg-white/80 dark:bg-white/8 text-gp-ink-strong dark:text-white"
          >
            <p className="text-xs leading-snug line-clamp-2 font-medium">
              New thread
            </p>
            <p className="text-[10px] mt-1 opacity-60">Type to begin</p>
          </div>
        )}

        {!loading && threads.map((t) => {
          const isActive = activeThreadId === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectThread(t.id)}
              className={cn(
                'nav-item w-full text-left rounded-lg px-3 py-2.5 transition-all cursor-pointer',
                isActive
                  ? 'active bg-white/80 dark:bg-white/8 text-gp-ink-strong dark:text-white'
                  : 'text-gp-ink-muted dark:text-white/55 hover:bg-white/40 dark:hover:bg-white/5 hover:text-gp-ink-strong dark:hover:text-white/80'
              )}
            >
              <p className="text-xs leading-snug line-clamp-2 font-medium">
                {/* `||` (not `??`) so an empty string snippet (a "+"-created
                    thread with no turns yet) falls through to "New thread"
                    instead of rendering a blank row. */}
                {t.title?.trim() || t.snippet?.trim() || 'New thread'}
              </p>
              <p className="text-[10px] mt-1 opacity-60">
                {formatDate(t.lastTurnAt ?? t.createdAt)}
                {t.turnCount > 0 && ` · ${t.turnCount} msg${t.turnCount !== 1 ? 's' : ''}`}
              </p>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
