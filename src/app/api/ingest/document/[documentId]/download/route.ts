import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { driver } from '@/lib/neo4j/driver'
import { resolveAuthenticatedUserId } from '@/app/api/auth/utils'
import { createS3BlobStore } from '@/lib/ingest/s3-blob-store'
import { createMemoryBlobStore } from '@/lib/ingest/blob-store'

/**
 * Durable, Space-scoped download for an uploaded Document's file (GOAL-283).
 *
 *   GET /api/ingest/document/<documentId>/download
 *
 * This is the stable locator persisted into `ResourcePulse.location` at
 * extraction time. Unlike the presigned PUT/GET URLs (minted on demand,
 * minutes-long TTL) this path never expires and re-checks authorization on
 * every hit, so a member — and only members of the document's Space — can open
 * or share the actual file long after the upload completed.
 *
 * Flow: authenticate → Space read gate (owner OR any member, mirroring
 * `documentsByFieldContext`) → mint a fresh short-lived presigned GET from the
 * document's `blobKey` → 302 redirect to it. The blobKey is never exposed to
 * the client; a missing document and a forbidden one return the SAME 404 so we
 * don't leak document existence across Spaces.
 */

const DOWNLOAD_TTL_SECONDS = 60 * 5

/**
 * A top-level browser navigation (clicking/sharing the durable link) sends an
 * `Accept: text/html` request. For such a request a raw JSON body is a dead
 * end, so the route redirects instead: an unauthenticated visitor — a
 * logged-out recipient, or a member whose short-lived accessToken cookie has
 * lapsed — goes to login (GOAL-316); an authenticated caller whose document
 * can't be resolved goes to /document-unavailable (GOAL-321).
 * Programmatic/API callers (fetch/XHR, which don't ask for HTML) still get
 * the JSON envelope.
 */
function prefersHtml(req: NextRequest): boolean {
  return (req.headers.get('accept') || '').includes('text/html')
}

function resolveBlobStore() {
  if (process.env.INGEST_BLOB_BACKEND === 'memory') {
    return createMemoryBlobStore()
  }
  return createS3BlobStore()
}

/**
 * Read gate: the caller must own or be a member (any role) of the Space that
 * owns the document's FieldContext. Returns the blobKey when access is granted,
 * `null` when the document is missing OR the caller lacks access — the caller
 * maps both to 404 so existence never leaks to non-members.
 */
async function resolveAuthorizedBlobKey(
  userId: string,
  documentId: string
): Promise<string | null> {
  const session = driver.session()
  try {
    const result = await session.executeRead(async (tx) =>
      tx.run(
        `
        MATCH (space:Space)-[:HAS_CONTEXT]->(c:FieldContext)-[:HAS_PULSE]->(d:FieldPulse {id: $documentId})
        WHERE d:ResourcePulse
        OPTIONAL MATCH (owner:Person {id: $userId})-[:OWNS]->(space)
        OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person {id: $userId})
        WITH d, (owner IS NOT NULL OR member IS NOT NULL) AS allowed
        WHERE allowed
        RETURN d.sourceBlobKey AS blobKey
        LIMIT 1
        `,
        { userId, documentId }
      )
    )
    const blobKey = result.records[0]?.get('blobKey') as string | null
    return blobKey && blobKey.trim() ? blobKey : null
  } finally {
    await session.close()
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const userId = resolveAuthenticatedUserId(req)
  if (!userId) {
    // Browser navigation → send the visitor to log in and come back to the
    // link, rather than dead-ending on a raw JSON body. API callers get JSON.
    if (prefersHtml(req)) {
      const returnTo = new URL(req.url).pathname
      return NextResponse.redirect(
        new URL(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, req.url),
        { status: 302 }
      )
    }
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const { documentId: rawId } = await params
  const documentId = String(rawId ?? '').trim()
  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required.' }, { status: 400 })
  }

  const blobKey = await resolveAuthorizedBlobKey(userId, documentId)
  if (!blobKey) {
    // Missing document OR no access — same response, no existence leak.
    // A browser navigation (a member clicking "Open document" on a pulse
    // whose source document was deleted — GOAL-321) gets a human-readable
    // dead-end instead of a raw JSON body, mirroring the unauthenticated
    // login redirect above. The target page carries no document id, so the
    // redirect stays identical for missing and forbidden alike.
    // Never cacheable: a replayed dead-end 302/404 would outlive a later
    // access grant (defense in depth — these are dynamic responses anyway).
    if (prefersHtml(req)) {
      const res = NextResponse.redirect(
        new URL('/document-unavailable', req.url),
        { status: 302 }
      )
      res.headers.set('Cache-Control', 'private, no-store')
      return res
    }
    return NextResponse.json(
      { error: 'Document not found.' },
      { status: 404, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }

  let downloadUrl: string
  try {
    const store = resolveBlobStore()
    downloadUrl = await store.presignGet({
      key: blobKey,
      ttlSeconds: DOWNLOAD_TTL_SECONDS,
    })
  } catch (err) {
    console.error('[ingest/document/download] failed to mint download URL:', err)
    return NextResponse.json(
      {
        error:
          'This document is temporarily unavailable. Please try again later.',
        reason: 'storage_unavailable',
      },
      { status: 503 }
    )
  }

  // 302 so the browser follows to the short-lived presigned GET. The durable
  // link the member keeps is THIS route; the presigned URL is ephemeral, so the
  // redirect must not be cached — a replayed 302 could point at an expired URL.
  const res = NextResponse.redirect(downloadUrl, { status: 302 })
  res.headers.set('Cache-Control', 'private, no-store')
  return res
}
