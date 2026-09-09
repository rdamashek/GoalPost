'use client'

import type { UIMessage } from 'ai'
import { authorizationHeaders } from '@/lib/auth/access-token-client'

/**
 * Auth headers for chat-thread API calls. Delegates to the shared
 * `authorizationHeaders` helper so concurrent callers (Apollo, focal-entity,
 * onboarding) all dedupe through the same in-flight refresh — without this
 * a single page mount could fire 5+ parallel `/api/auth/refresh-token` calls
 * and the rotating-token race would 401 most of them.
 */
export const chatApiAuthHeaders = authorizationHeaders
const authHeaders = chatApiAuthHeaders

/**
 * Client helpers for hydrating the AI assistant panel from the
 * `/api/chat/simulation/thread(s)` endpoints.
 *
 * Conversion target: the AI SDK `UIMessage` shape that `useChatRuntime`
 * accepts as its initial `messages` option. We restore the original `parts`
 * tree verbatim when the server has one (preserving tool calls + results so
 * the chat is replayed faithfully); otherwise we synthesise a single text
 * part from the stored `content` so older or text-only turns still render.
 *
 * Slice 5 (GOAL-240) adds `mode`, `kind`, and `title` to the hydrated shape
 * so the assistant panel can lock the mode selector on ingest threads and
 * render thread titles in the switcher without exposing raw IDs.
 */

export interface StoredTurn {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts: unknown[] | null
  order: number
  createdAt: string
}

export interface HydratedThread {
  id: string
  createdAt: string
  lastTurnAt: string | null
  /** 'default' | 'aiden' | 'braider'. Source of truth for which assistant mode this thread runs in. */
  mode: string
  /** 'reflective' | 'ingest'. UI uses this to lock the mode selector on ingest threads. */
  kind: string
  /** Human-readable title (e.g. "Ingest: meeting-notes.pdf"). Null for the implicit reflective thread. */
  title: string | null
  messages: UIMessage[]
}

export interface ThreadSummary {
  id: string
  createdAt: string
  lastTurnAt: string | null
  turnCount: number
  snippet: string
  title: string | null
  mode: string
  kind: string
}

interface ThreadFetchResponse {
  thread: {
    id: string
    createdAt: string
    lastTurnAt: string | null
    mode?: string
    kind?: string
    title?: string | null
    turns: StoredTurn[]
  } | null
}

interface ThreadsListResponse {
  threads: ThreadSummary[]
}

function turnToUIMessage(turn: StoredTurn): UIMessage {
  const parts =
    Array.isArray(turn.parts) && turn.parts.length > 0
      ? (turn.parts as UIMessage['parts'])
      : ([{ type: 'text', text: turn.content }] as UIMessage['parts'])
  return {
    id: turn.id,
    role: turn.role,
    parts,
  } as UIMessage
}

/**
 * Fetch one thread by id and convert it to the runtime's UIMessage[] shape.
 * Returns `null` when the thread is gone OR the fetch failed — the caller
 * should treat both as "start with an empty conversation."
 *
 * `threadId` is required (GOAL-345). There is deliberately no "just give me
 * whatever thread was most recent" mode: the chat panel opens empty on every
 * initial load, and hydration only ever happens for a thread the member
 * explicitly picked.
 */
export async function fetchHydratedThread(
  threadId: string,
  signal?: AbortSignal
): Promise<HydratedThread | null> {
  try {
    const url = `/api/chat/simulation/thread?id=${encodeURIComponent(threadId)}`
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: await authHeaders(),
      signal,
    })
    if (!response.ok) return null
    const data = (await response.json()) as ThreadFetchResponse
    if (!data.thread) return null
    return {
      id: data.thread.id,
      createdAt: data.thread.createdAt,
      lastTurnAt: data.thread.lastTurnAt,
      mode: typeof data.thread.mode === 'string' ? data.thread.mode : 'default',
      kind: typeof data.thread.kind === 'string' ? data.thread.kind : 'reflective',
      title: typeof data.thread.title === 'string' ? data.thread.title : null,
      messages: data.thread.turns
        .filter((turn) => turn && typeof turn.id === 'string')
        .map(turnToUIMessage),
    }
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') return null
    console.warn(
      '[conversation-thread-client] Hydration failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}

/**
 * List the user's recent threads for the switcher. Newest first. Returns an
 * empty array on auth / network failure so the switcher can render an empty
 * state instead of crashing.
 */
export async function fetchThreadList(
  signal?: AbortSignal
): Promise<ThreadSummary[]> {
  try {
    const response = await fetch('/api/chat/simulation/threads', {
      method: 'GET',
      credentials: 'include',
      headers: await authHeaders(),
      signal,
    })
    if (!response.ok) return []
    const data = (await response.json()) as ThreadsListResponse
    return Array.isArray(data.threads) ? data.threads : []
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') return []
    console.warn(
      '[conversation-thread-client] Thread list fetch failed:',
      error instanceof Error ? error.message : error
    )
    return []
  }
}

/**
 * Create a new empty thread server-side. Returns the new thread id, or `null`
 * if the request failed (e.g. unauthenticated). Callers should treat null as
 * "stay on the current thread."
 */
export async function createConversationThread(): Promise<string | null> {
  try {
    const res = await fetch('/api/chat/simulation/threads', {
      method: 'POST',
      credentials: 'include',
      headers: await authHeaders(),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { threadId?: string }
    return typeof data.threadId === 'string' ? data.threadId : null
  } catch (error) {
    console.warn(
      '[conversation-thread-client] createConversationThread failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}
