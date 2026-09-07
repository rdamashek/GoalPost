/**
 * Count resonance suggestions for a Space, optionally narrowed to one FieldContext.
 * GET /api/resonance/suggestions/count?spaceId=<id>&contextId=<id>&status=pending
 *
 * GOAL-348. The FieldContext page needs a PASSIVE indicator that pending
 * suggestions are waiting for review — rendered on load, without running (and
 * paying for) a fresh `discoverResonancesForSpace` sweep. The sibling list
 * route returns every suggestion with both pulses' full content embedded, which
 * is far too heavy to fetch on every field page load just to render a number,
 * so this route returns the count alone.
 *
 * REST rather than GraphQL is deliberate: `ResonanceSuggestion` has no type in
 * the SDL at all, and ADR-005 explicitly reserves `/api/resonance` for exactly
 * this surface. Adding a GraphQL type here would mean re-expressing the
 * cross-context visibility rule below as `@authorization`, where it could drift
 * from the list route it must agree with.
 */

import { NextRequest, NextResponse } from 'next/server'
import { initGraph } from '@/modules/graph'
import { resolveAuthenticatedUserId } from '@/app/api/auth/utils'
import { getSession, initializeDB } from '@/app/api/auth/neo4j'
import { canViewContent } from '@/lib/permissions/space-permissions'
import { viewablePulsePredicate } from '@/lib/permissions/pulse-visibility'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const spaceId = searchParams.get('spaceId')
    const contextId = searchParams.get('contextId')
    const status = searchParams.get('status') || 'pending'

    if (!spaceId) {
      return NextResponse.json(
        { success: false, error: 'spaceId parameter required' },
        { status: 400 }
      )
    }
    // Allowlisted rather than free text: an unrecognised status silently
    // returns 0, which reads as "nothing to review" instead of "bad request".
    const VALID_STATUSES = ['pending', 'accepted', 'declined', 'all']
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { success: false, error: 'invalid status parameter' },
        { status: 400 }
      )
    }

    // Same gate as the list route: a suggestion's existence is Space-scoped
    // information, so an unauthenticated or non-member caller gets nothing —
    // not even a number (kb/02-user-roles.md, ADR-003). Any role may VIEW,
    // including a WeSpace GUEST; confirming/rejecting is gated separately on
    // canEditContent by the accept/decline routes.
    const userId = resolveAuthenticatedUserId(request)
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }
    initializeDB()
    const permSession = getSession()
    try {
      const allowed = await canViewContent(permSession, userId, spaceId)
      if (!allowed) {
        // Don't distinguish "not a member" from "no such space" — both 403.
        return NextResponse.json(
          { success: false, error: 'Forbidden' },
          { status: 403 }
        )
      }
    } finally {
      await permSession.close()
    }

    const graph = await initGraph()

    // Deliberately the same VISIBILITY shape as the list route — same
    // canViewContent gate above, same GOAL-293 predicate on both endpoints — so
    // the two can never disagree about what this caller is allowed to see.
    //
    // The SCOPE differs on purpose: `contextId` narrows the count to one field,
    // which the list route cannot do (it takes no per-field filter). So the
    // badge's number is this field's while the modal it opens lists the whole
    // Space. That is signalled in the affordance's label and title rather than
    // hidden — see `resonances-section.tsx`.
    const rows = await graph.query<{ total: number | string }>(
      `
      MATCH (space:Space {id: $spaceId})-[:HAS_SUGGESTION]->(suggestion:ResonanceSuggestion)
      WHERE $status = 'all' OR suggestion.status = $status
      MATCH (suggestion)-[:SOURCE]->(source:FieldPulse)
      MATCH (suggestion)-[:TARGET]->(target:FieldPulse)
      MATCH (context:FieldContext)-[:HAS_SUGGESTION]->(suggestion)
      // Require the anchoring context to belong to the gated Space. Both
      // suggestion writers already pin that pair, so today this changes no
      // result — it is here so an arbitrary $contextId can never become a
      // cross-Space probe if a future writer stops pinning it.
      WHERE (space)-[:HAS_CONTEXT]->(context)
        AND ($contextId IS NULL OR context.id = $contextId)
        AND ${viewablePulsePredicate('source', 'currentUserId')}
        AND ${viewablePulsePredicate('target', 'currentUserId')}
      RETURN count(DISTINCT suggestion) AS total
      `,
      { spaceId, contextId, status, currentUserId: userId }
    )

    // Neo4j integers can round-trip through the LangChain layer as strings —
    // coerce rather than trusting the shape (see canViewPulse for the same
    // hazard on booleans).
    const count = Number(rows?.[0]?.total ?? 0) || 0

    return NextResponse.json(
      {
        success: true,
        spaceId,
        contextId,
        status,
        count,
        timestamp: new Date().toISOString(),
      },
      // The URL is identical for every caller but the answer is per-caller —
      // never let a shared cache hand one member another member's number.
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error: unknown) {
    // Detail stays in the server log: a Neo4j driver error embeds the failing
    // statement, which would hand the client our label and relationship names.
    console.error('[Resonance Suggestions Count] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to count resonance suggestions',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
