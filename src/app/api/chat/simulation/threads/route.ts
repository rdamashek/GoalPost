/**
 * GET   /api/chat/simulation/threads     — list thread summaries for the user
 * POST  /api/chat/simulation/threads     — create a new empty thread
 *
 * There is no last-viewed PATCH: the chat panel opens on an empty conversation
 * on every initial load (GOAL-345), so there is no pin to record.
 *
 * Auth: requires a valid `accessToken` cookie. All operations are scoped to
 * the caller's own threads (the service-layer Cypher anchors on
 * `(:Person:User {id: $userId})` so cross-user access is structurally
 * impossible).
 *
 * The list/get responses project `mode` ('default' | 'aiden' | 'braider')
 * and `kind` ('reflective' | 'ingest') so the thread switcher can lock the
 * mode selector on ingest threads (GOAL-240 Slice 5).
 */
import { resolveAuthenticatedUserId } from '@/app/api/auth/utils'
import {
  listConversationThreadsSummary,
  createConversationThread,
} from '@/lib/simulation/conversation-thread.service'

export async function GET(req: Request) {
  const userId = resolveAuthenticatedUserId(req)
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const threads = await listConversationThreadsSummary(userId)
  return new Response(JSON.stringify({ threads }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export async function POST(req: Request) {
  const userId = resolveAuthenticatedUserId(req)
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const { threadId } = await createConversationThread(userId)
  return new Response(JSON.stringify({ threadId }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}
