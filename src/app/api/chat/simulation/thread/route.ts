/**
 * GET /api/chat/simulation/thread?id=<threadId>
 *
 * Returns one of the authenticated user's ConversationThreads so the AI
 * assistant panel can hydrate its chat runtime with that thread's prior turns.
 *
 * `id` is required (GOAL-345). The panel opens on an empty conversation on
 * every initial load, so hydration only ever happens for a thread the member
 * explicitly picked from the switcher — there is no "give me whatever thread
 * was most recent" mode.
 *
 * Response shape:
 *
 *   { thread: null }                               // no such thread for them
 *   { thread: { id, createdAt, lastTurnAt,
 *               turns: [{ id, role, content,
 *                         parts, order, createdAt }] } }
 *
 * Auth: accepts JWT via `Authorization: Bearer …` header or `accessToken=`
 * cookie. The handler refuses without one rather than returning an
 * anonymous thread — chat history is private.
 */
import { resolveAuthenticatedUserId } from '@/app/api/auth/utils'
import { getConversationThread } from '@/lib/simulation/conversation-thread.service'

export async function GET(req: Request) {
  const userId = resolveAuthenticatedUserId(req)
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const threadId = new URL(req.url).searchParams.get('id')
  if (!threadId) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const thread = await getConversationThread(userId, threadId)
  return new Response(JSON.stringify({ thread }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Hydration is per-request; never cache.
      'Cache-Control': 'no-store',
    },
  })
}
