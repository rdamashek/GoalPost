import { randomUUID } from 'node:crypto'
import type { Driver } from 'neo4j-driver'
import type { BlobStore } from './blob-store'
import { parseDocumentDownloadLocation } from './document-download-url'
import { RESOURCE_TYPE_DOCUMENT } from './source-resource-node'

/**
 * Document deletion orchestrator (PRD `docs/prd/document-ingestion.md` § Out
 * of Scope — extracted entities survive). Mirrors `handleIngestDocument`'s
 * shape:
 *
 *   permission gate ──┐
 *   activity Log      ├─ single write transaction (atomic)
 *   DETACH DELETE     ┘
 *   best-effort blob cleanup
 *
 * Authorization semantics match `userCanEditContext` in
 * `handle-ingest-document.ts`: OWNER + ADMIN + MEMBER pass, GUEST + non-member
 * fail. To avoid leaking document existence to non-members, a missing
 * document and a forbidden access return the SAME `forbidden` failure.
 *
 * Logging: writes one `:Log` per delete attributed to the caller via
 * `CREATED_BY` (parallel to `createPersonAuthorized` / `createPulseAuthorized`
 * in `src/lib/chat/hitl.ts`). Description carries the human-readable
 * filename so the activity feed can render without a follow-up read. The
 * blob cleanup happens AFTER the transaction commits — a blob delete failure
 * leaves an orphan blob, not a dangling graph reference (safer failure mode).
 *
 * Dangling locators (GOAL-321): extraction stamps surviving pulses' `location`
 * with the durable download URL for this document (GOAL-283/316). After the
 * delete that locator dead-ends forever (v1 has no restore), so the same
 * transaction nulls `location` on pulses whose stored value parses — via
 * `parseDocumentDownloadLocation`, the ONE recognizer, so there is no
 * Cypher/TS drift — to the deleted document's id. The match is on the location
 * VALUE, never provenance edges: an extracted pulse whose location a member
 * later replaced by hand keeps its edit, and only values pointing at THIS
 * document are cleared. Candidates are read in-transaction (context pulses ∪
 * `EXTRACTED_FROM` pulses, the only places extraction writes the locator),
 * and the clearing writes its own attributed `:Log`.
 */

/**
 * Coarse in-Cypher prefilter for candidate locations; the exact verdict is
 * always `parseDocumentDownloadLocation` in JS. Matches both the absolute URL
 * persisted at extraction time and a bare relative path.
 */
const DOCUMENT_LOCATOR_MARKER = '/api/ingest/document/'

export interface DeleteDocumentDependencies {
  driver: Driver
  blobStore: BlobStore
}

export interface DeleteDocumentInput {
  currentUserId: string
  documentId: string
}

export type DeleteFailureReason = 'forbidden' | 'invalid_input'

export interface DeleteSuccess {
  ok: true
  documentId: string
  /** Pulses whose dangling document-locator `location` was cleared (GOAL-321). */
  clearedPulseIds: string[]
}

export interface DeleteFailure {
  ok: false
  reason: DeleteFailureReason
  error: string
}

export type DeleteDocumentResult = DeleteSuccess | DeleteFailure

export async function handleDeleteDocument(
  deps: DeleteDocumentDependencies,
  input: DeleteDocumentInput
): Promise<DeleteDocumentResult> {
  const documentId = input.documentId?.trim() || ''
  if (!documentId) {
    return {
      ok: false,
      reason: 'invalid_input',
      error: 'documentId is required.',
    }
  }
  const userId = input.currentUserId?.trim() || ''
  if (!userId) {
    return {
      ok: false,
      reason: 'forbidden',
      error: 'You do not have permission to delete this document.',
    }
  }

  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const metadata = JSON.stringify({ documentId })

  const session = deps.driver.session()
  let blobKey: string | null = null
  let clearedPulseIds: string[] = []
  try {
    // Single write transaction: resolves the Document, gates on
    // canEditContent, writes the Log, runs DETACH DELETE, and clears the
    // dangling document-locator locations. A missing document and an
    // unauthorized user both produce zero rows — callers can't distinguish
    // them — and in that case nothing is written, cleared included.
    const outcome = await session.executeWrite(async (tx) => {
      // 1. Candidate locations, behind the same gate as the delete. Read
      //    BEFORE the DETACH DELETE so the EXTRACTED_FROM edges still exist.
      //    Coarse CONTAINS prefilter only — the exact match happens in JS.
      const candidatesResult = await tx.run(
        `
        MATCH (space:Space)-[:HAS_CONTEXT]->(c:FieldContext)-[:HAS_PULSE]->(d:FieldPulse {id: $documentId})
        // resourceType narrowing is load-bearing, not decoration. This gate
        // admits OWNER + ADMIN + MEMBER, but the DELETE matrix in
        // kb/02-user-roles.md reserves deleting someone else's resource for
        // creator/ADMIN/owner. While the target was (:Document) via
        // HAS_DOCUMENT that gap was unreachable — only ingest ever created
        // those nodes. HAS_PULSE reaches EVERY resource in the context, so
        // without this predicate a plain MEMBER could pass an ordinary
        // member-authored resource id and hard-delete content the GraphQL path
        // forbids them to touch.
        WHERE d:ResourcePulse AND d.resourceType = $resourceType
        OPTIONAL MATCH (owner:Person {id: $userId})-[:OWNS]->(space)
        OPTIONAL MATCH (space)-[:HAS_MEMBER]->(sm:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $userId})
          WHERE sm.role IN ['ADMIN', 'MEMBER']
        WITH d, c, (owner IS NOT NULL OR sm IS NOT NULL) AS allowed
        WHERE allowed
        OPTIONAL MATCH (c)-[:HAS_PULSE]->(cp:FieldPulse)
          WHERE cp.location CONTAINS $locatorMarker
        OPTIONAL MATCH (ep:FieldPulse)-[:EXTRACTED_FROM]->(d)
          WHERE ep.location CONTAINS $locatorMarker
        RETURN
          collect(DISTINCT cp { .id, .location }) +
          collect(DISTINCT ep { .id, .location }) AS candidates
        `,
        {
          documentId,
          userId,
          locatorMarker: DOCUMENT_LOCATOR_MARKER,
          resourceType: RESOURCE_TYPE_DOCUMENT,
        }
      )
      const candidates = (candidatesResult.records[0]?.get('candidates') ??
        []) as Array<{ id: string; location: string | null }>
      // Exact verdict + dedup (the ∪ of the two branches can repeat a pulse).
      // Keep the {id, location} PAIR: the clearing statement compares on the
      // value it read, so a location a member re-edits between this read and
      // the write is never destroyed (lost-update guard).
      const pairsToClear: Array<{ id: string; location: string }> = []
      for (const p of candidates) {
        if (
          parseDocumentDownloadLocation(p.location)?.documentId ===
            documentId &&
          p.location != null &&
          !pairsToClear.some((seen) => seen.id === p.id)
        ) {
          pairsToClear.push({ id: p.id, location: p.location })
        }
      }

      // 2. Gate + Log + DETACH DELETE (unchanged contract). Zero rows =
      //    missing-or-forbidden; the callback returns before any clearing.
      const result = await tx.run(
        `
        MATCH (space:Space)-[:HAS_CONTEXT]->(c:FieldContext)-[:HAS_PULSE]->(d:FieldPulse {id: $documentId})
        // resourceType narrowing is load-bearing, not decoration. This gate
        // admits OWNER + ADMIN + MEMBER, but the DELETE matrix in
        // kb/02-user-roles.md reserves deleting someone else's resource for
        // creator/ADMIN/owner. While the target was (:Document) via
        // HAS_DOCUMENT that gap was unreachable — only ingest ever created
        // those nodes. HAS_PULSE reaches EVERY resource in the context, so
        // without this predicate a plain MEMBER could pass an ordinary
        // member-authored resource id and hard-delete content the GraphQL path
        // forbids them to touch.
        WHERE d:ResourcePulse AND d.resourceType = $resourceType
        OPTIONAL MATCH (owner:Person {id: $userId})-[:OWNS]->(space)
        OPTIONAL MATCH (space)-[:HAS_MEMBER]->(sm:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $userId})
          WHERE sm.role IN ['ADMIN', 'MEMBER']
        WITH d, c, (owner IS NOT NULL OR sm IS NOT NULL) AS allowed
        WHERE allowed
        MATCH (u:Person:User {id: $userId})
        WITH d, c, u, d.sourceBlobKey AS blobKey, d.sourceFilename AS filename
        CREATE (log:Log {
          id: $logId,
          description: 'Deleted document "' + coalesce(filename, '') + '"' +
            CASE WHEN c.title IS NOT NULL AND c.title <> ''
              THEN ' from ' + c.title
              ELSE ''
            END,
          metadata: $metadata,
          createdAt: datetime()
        })
        CREATE (log)-[:CREATED_BY]->(u)
        WITH d, blobKey, filename
        // A document is a pulse now, so it enters the resonance pipeline like
        // any other: on-upload-discovery embeds every FieldPulse under the
        // context that lacks an embedding, and ResonanceLink / ResonanceSuggestion
        // nodes then attach via SOURCE/TARGET. A bare DETACH DELETE drops those
        // edges and leaves the link nodes half-connected — an orphan suggestion
        // surfacing in the canvas action bar pointing at a pulse that is gone.
        // purgeDeletedFieldContexts already collects and deletes them; this path
        // has to as well, and it is now the ONLY path, since the SDL forbids the
        // generated delete for resourceType 'document'.
        OPTIONAL MATCH (conn)-[:SOURCE|TARGET]->(d)
          WHERE conn:ResonanceLink OR conn:ResonanceSuggestion
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(chunk:ConversationChunk)
        WITH d, blobKey, filename,
             collect(DISTINCT conn) AS conns, collect(DISTINCT chunk) AS chunks
        FOREACH (n IN conns | DETACH DELETE n)
        FOREACH (n IN chunks | DETACH DELETE n)
        DETACH DELETE d
        RETURN blobKey, filename
        LIMIT 1
        `,
        { documentId, userId, logId, metadata, resourceType: RESOURCE_TYPE_DOCUMENT }
      )
      const record = result.records[0]
      if (!record) {
        return null
      }

      // 3. Null the dangling locators + one attributed Log for the clearing
      //    (GOAL-321). Same transaction as the delete: both land or neither.
      //    Compare-and-clear on the value read in step 1, and derive the Log
      //    from the pulses that actually matched — so the Log never claims
      //    more than what was cleared.
      let clearedIds: string[] = []
      if (pairsToClear.length > 0) {
        const clearResult = await tx.run(
          `
          UNWIND $pairs AS pair
          MATCH (p:FieldPulse {id: pair.id})
          WHERE p.location = pair.location
          SET p.location = null, p.modifiedAt = datetime()
          RETURN collect(p.id) AS clearedIds
          `,
          { pairs: pairsToClear }
        )
        clearedIds = (clearResult.records[0]?.get('clearedIds') ??
          []) as string[]
      }
      if (clearedIds.length > 0) {
        const filename = ((record.get('filename') as string | null) ?? '').trim()
        const documentLabel = filename ? `document "${filename}"` : 'a document'
        const clearLogId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
        await tx.run(
          `
          MATCH (u:Person:User {id: $userId})
          MATCH (p:FieldPulse)
          WHERE p.id IN $pulseIds
          WITH u, collect(p) AS pulses
          CREATE (clearLog:Log {
            id: $clearLogId,
            description: $description,
            metadata: $clearMetadata,
            createdAt: datetime()
          })
          CREATE (clearLog)-[:CREATED_BY]->(u)
          WITH clearLog, pulses
          UNWIND pulses AS p
          CREATE (clearLog)-[:LOGGED_FOR]->(p)
          `,
          {
            userId,
            pulseIds: clearedIds,
            clearLogId,
            description:
              `Removed the link to deleted ${documentLabel} from ` +
              `${clearedIds.length} pulse${clearedIds.length === 1 ? '' : 's'}`,
            clearMetadata: JSON.stringify({
              documentId,
              clearedPulseIds: clearedIds,
            }),
          }
        )
      }

      return {
        blobKey: (record.get('blobKey') as string | null) ?? null,
        clearedPulseIds: clearedIds,
      }
    })

    if (!outcome) {
      return {
        ok: false,
        reason: 'forbidden',
        error: 'You do not have permission to delete this document.',
      }
    }
    blobKey = outcome.blobKey
    clearedPulseIds = outcome.clearedPulseIds
  } finally {
    await session.close()
  }

  // Best-effort blob cleanup — the graph is already consistent. A failure
  // here leaves an orphan blob, never a dangling Document.
  if (blobKey) {
    try {
      await deps.blobStore.delete(blobKey)
    } catch (err) {
      console.warn(
        `[handle-delete-document] best-effort blob cleanup failed for ${blobKey}:`,
        err
      )
    }
  }

  return { ok: true, documentId, clearedPulseIds }
}
