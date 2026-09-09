import type { Driver } from 'neo4j-driver'
import type { BlobStore } from './blob-store'
import {
  DOCUMENT_INGEST_STATUS,
  type DocumentIngestStatus,
} from './document-ingest-queue'
import { RESOURCE_TYPE_DOCUMENT } from './source-resource-node'

/**
 * Owns the lifecycle of `Document` nodes and their backing blob. v1 ships
 * with one mimeType (text/plain) and a flat `documents/<docId>/<filename>`
 * blob key; later slices add PDF/MD and size gating, none of which change
 * the (ResourcePulse, HAS_PULSE, UPLOADED_BY) graph contract pinned here.
 *
 * Order of operations on `uploadDocument`:
 *   1. Reserve the graph: MATCH the FieldContext + uploader, then CREATE
 *      the Document node and edges in one transaction. If the FieldContext
 *      doesn't exist the CREATE pattern returns zero rows and we throw
 *      BEFORE touching blob storage — so a bad upload can never leak a
 *      blob without a parent node.
 *   2. PUT the blob.
 *   3. PATCH the Document with the resolved blobKey + blobUrl.
 *
 * Order of operations on `deleteDocument`:
 *   1. Read blobKey off the Document.
 *   2. DETACH DELETE the Document.
 *   3. Best-effort DELETE the blob (idempotent — a missing blob is fine).
 */

export interface UploadDocumentInput {
  driver: Driver
  blobStore: BlobStore
  documentId: string
  fieldContextId: string
  uploaderUserId: string
  filename: string
  mimeType: string
  buffer: Buffer
  /** Pages in the source document. `1` for .txt/.md, real page count for .pdf. */
  pageCount?: number
  /** Optional one-line "What is this?" hint reused on re-extract (GOAL-241). */
  userHint?: string | null
}

export interface UploadedDocument {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  pageCount: number | null
  blobKey: string
  blobUrl: string
  userHint: string | null
}

export async function uploadDocument(
  input: UploadDocumentInput
): Promise<UploadedDocument> {
  // Server-side upload path: PUT the blob, then anchor the graph node. Kept
  // for tests and any caller that still streams bytes through this process.
  // The browser-direct-upload flow does not use this — it calls `presignPut`
  // on the BlobStore and then `anchorDocument` after the client has uploaded.
  const blobKey = `documents/${input.documentId}/${input.filename}`
  const ref = await input.blobStore.put({
    key: blobKey,
    contentType: input.mimeType,
    buffer: input.buffer,
  })
  await anchorDocument({
    driver: input.driver,
    documentId: input.documentId,
    fieldContextId: input.fieldContextId,
    uploaderUserId: input.uploaderUserId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    pageCount: input.pageCount ?? null,
    userHint: input.userHint ?? null,
    blobKey: ref.key,
    blobUrl: ref.url,
  })
  return {
    id: input.documentId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    pageCount: input.pageCount ?? null,
    blobKey: ref.key,
    blobUrl: ref.url,
    userHint: input.userHint?.trim() ? input.userHint.trim() : null,
  }
}

export interface AnchorDocumentInput {
  driver: Driver
  documentId: string
  fieldContextId: string
  uploaderUserId: string
  filename: string
  mimeType: string
  sizeBytes: number
  pageCount: number | null
  userHint: string | null
  blobKey: string
  blobUrl: string
  /**
   * Where the bytes came from when the Document was not uploaded by a member
   * but fetched server-side from a link (GOAL-344 bulk article import). Null
   * for uploads. Also the idempotency key that stops the same article being
   * fetched twice into one FieldContext.
   */
  sourceUrl?: string | null
  /**
   * Initial ingest status (GOAL-292). The async upload path anchors PENDING so
   * the cron worker picks the document up. Defaults to COMPLETE for callers
   * that run the pipeline themselves and never enqueue — `uploadDocument`'s
   * server-side path and tests — so those documents are not re-ingested.
   */
  status?: DocumentIngestStatus
}

/**
 * Graph-only anchor for a Document whose bytes already live in blob storage
 * (browser-direct-to-S3 upload). Single CREATE — no follow-up SET, because
 * the blob location is known up front.
 *
 * GOAL-292: the node is born with an ingest `status` (PENDING for the async
 * upload path) so `/api/cron/process-document-ingestion` can find it. The
 * `UPLOADED_BY` edge created here is also what captures the authorization
 * decision — the worker runs under CRON_SECRET with no request context, so
 * this uploader identity is who its entity writes are attributed to.
 *
 * Throws if FieldContext or uploader are missing; the caller surfaces this
 * as a 400/404 to the frontend so the user can retry. The blob is left in
 * place — orphan cleanup is a separate concern handled by S3 lifecycle.
 */
export async function anchorDocument(input: AnchorDocumentInput): Promise<void> {
  const session = input.driver.session()
  try {
    const result = await session.executeWrite(async (tx) =>
      tx.run(
        `
        MATCH (c:FieldContext {id: $fieldContextId})
        MATCH (u:Person:User {id: $uploaderUserId})
        // MERGE, not CREATE: the document id is derived from the server-minted
        // blob key, so a retried /process call must re-anchor the same document
        // rather than create a second one over the same blob (GOAL-292). ON
        // CREATE only, so a retry arriving after the worker has already started
        // cannot reset the status machine or the attempt counter. The
        // document_id uniqueness constraint makes this safe under concurrency.
        // MERGE on :FieldPulse, not :ResourcePulse — pulse_id is the
        // uniqueness constraint that makes this safe under concurrency, and it
        // is declared on :FieldPulse. Merging on the subtype would have no
        // constraint behind it and could mint a duplicate on a retry.
        MERGE (d:FieldPulse {id: $documentId})
        ON CREATE SET
          d:ResourcePulse,
          d.resourceType = $resourceType,
          // The Resource is the focal point for resonance and discussion, so it
          // needs a real title/content from the moment it is anchored — the
          // extractor fills sourceSummary later, and the summarizer may fail.
          // title/content are String! and there is no second chance to
          // populate them before the pulse becomes visible.
          d.title = $filename,
          d.content = coalesce($userHint, $filename),
          d.createdAt = datetime(),
          d.modifiedAt = datetime(),
          d.sourceFilename = $filename,
          d.sourceMimeType = $mimeType,
          d.sourceSizeBytes = toInteger($sizeBytes),
          d.sourcePageCount = $pageCount,
          d.sourceUserHint = $userHint,
          d.sourceBlobKey = $blobKey,
          d.sourceBlobUrl = $blobUrl,
          d.sourceUrl = $sourceUrl,
          d.ingestStatus = $status,
          d.ingestStatusMessage = null,
          d.ingestStatusUpdatedAt = datetime(),
          d.ingestAttempts = 0,
          // Retained alongside createdAt as the queue's ordering key, so the
          // drain order survives any later edit to the pulse's createdAt.
          d.uploadedAt = datetime()
        // Guard against adopting an unrelated pulse. The MERGE key is now the
        // shared :FieldPulse id namespace, so a colliding id would MATCH an
        // existing StoryPulse, skip ON CREATE entirely, and then graft document
        // edges onto it — no :ResourcePulse label, no sourceBlobKey, and no
        // error. Impossible while the node was separately typed (:Document).
        // Zero rows here trips the records.length === 0 throw below.
        WITH c, u, d
        WHERE d:ResourcePulse AND d.resourceType = $resourceType
        MERGE (c)-[:HAS_PULSE]->(d)
        MERGE (d)-[:UPLOADED_BY]->(u)
        // The uploader is the pulse's displayed author until the extractor
        // credits a byline; resolvePulseAuthor reads initiatedBy[0] then
        // createdBy[0], so without this the resource renders authorless.
        MERGE (d)-[:CREATED_BY]->(u)
        // Activity Log. This was defensible to omit while the node sat outside
        // the pulse activity model as a (:Document), but anchoring now creates
        // a member-visible ResourcePulse in the field's pulse list, and every
        // other pulse-creation path writes one. Delete and re-extract both log;
        // creation was the gap. Guarded on ON CREATE semantics by MERGE-ing the
        // log id, so a retried /process call does not log twice.
        MERGE (log:Log {id: $logId})
        ON CREATE SET
          log.description = 'Added document "' + $filename + '"' +
            CASE WHEN c.title IS NOT NULL AND c.title <> ''
              THEN ' to ' + c.title
              ELSE ''
            END,
          log.createdAt = datetime()
        MERGE (log)-[:CREATED_BY]->(u)
        RETURN d.id AS id
        `,
        {
          fieldContextId: input.fieldContextId,
          uploaderUserId: input.uploaderUserId,
          documentId: input.documentId,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          pageCount: input.pageCount,
          userHint: input.userHint?.trim() ? input.userHint.trim() : null,
          blobKey: input.blobKey,
          blobUrl: input.blobUrl,
          sourceUrl: input.sourceUrl?.trim() || null,
          status: input.status ?? DOCUMENT_INGEST_STATUS.complete,
          resourceType: RESOURCE_TYPE_DOCUMENT,
          // Derived from the document id, not random, so a retry MERGEs the
          // same Log rather than appending a duplicate to the activity feed.
          logId: `log_anchor_${input.documentId}`,
        }
      )
    )
    if (result.records.length === 0) {
      throw new Error(
        `anchorDocument: could not anchor document resource "${input.documentId}" — FieldContext "${input.fieldContextId}" or uploader "${input.uploaderUserId}" not found, or the id collided with an existing non-document pulse.`
      )
    }
  } finally {
    await session.close()
  }
}

export interface DocumentRecord {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  pageCount: number | null
  blobKey: string
  blobUrl: string
  userHint: string | null
  /** Link the bytes were fetched from (GOAL-344); null for uploads. */
  sourceUrl: string | null
  fieldContextId: string
  uploaderUserId: string
  /**
   * Ingest lifecycle status (GOAL-292). Documents uploaded before that story
   * carry no `status` property; they read back as COMPLETE so the backlog is
   * never re-ingested.
   */
  status: DocumentIngestStatus
}

/**
 * Loads a Document by id along with the ids needed to re-extract: its parent
 * FieldContext (so the permission gate + roster lookup work) and the original
 * uploader (so the new ingest thread can be anchored back to the right
 * Person:User). Returns `null` if the document doesn't exist — callers
 * surface that as a not-found instead of throwing.
 */
export async function loadDocumentRecord(
  driver: Driver,
  documentId: string
): Promise<DocumentRecord | null> {
  const session = driver.session()
  try {
    const result = await session.executeRead(async (tx) =>
      tx.run(
        `
        // A :Document had exactly one HAS_DOCUMENT edge, so LIMIT 1 was
        // unambiguous. A ResourcePulse can legitimately sit in several contexts
        // (purge-deleted-field-contexts.ts is built around that case), and the
        // whole pipeline — extraction target, entity writes, discovery sweep —
        // runs against whichever context this returns. An arbitrary pick could
        // land extracted people and pulses in a different Space than the
        // uploader intended, so order deterministically rather than taking
        // whatever the planner yields first.
        MATCH (c:FieldContext)-[:HAS_PULSE]->(d:FieldPulse {id: $documentId})
        WHERE d:ResourcePulse
        // Collect uploaders rather than OPTIONAL MATCH + LIMIT 1. The cron
        // worker runs AS this user (GOAL-292), so an anomalous document with two
        // UPLOADED_BY edges must not resolve non-deterministically to whichever
        // one the planner happens to return — the caller fails the run instead.
        OPTIONAL MATCH (d)-[:UPLOADED_BY]->(uploader:Person:User)
        WITH c, d, collect(DISTINCT uploader.id) AS uploaderIds
        RETURN
          d.id AS id,
          d.sourceFilename AS filename,
          d.sourceMimeType AS mimeType,
          d.sourceSizeBytes AS sizeBytes,
          d.sourcePageCount AS pageCount,
          d.sourceBlobKey AS blobKey,
          d.sourceBlobUrl AS blobUrl,
          d.sourceUserHint AS userHint,
          d.sourceUrl AS sourceUrl,
          c.id AS fieldContextId,
          uploaderIds,
          coalesce(d.ingestStatus, $completeStatus) AS status
        ORDER BY fieldContextId
        LIMIT 1
        `,
        { documentId, completeStatus: DOCUMENT_INGEST_STATUS.complete }
      )
    )
    const record = result.records[0]
    if (!record) return null
    return {
      id: record.get('id') as string,
      filename: record.get('filename') as string,
      mimeType: record.get('mimeType') as string,
      sizeBytes: Number(record.get('sizeBytes') ?? 0),
      pageCount:
        record.get('pageCount') === null
          ? null
          : Number(record.get('pageCount')),
      blobKey: (record.get('blobKey') as string | null) ?? '',
      blobUrl: (record.get('blobUrl') as string | null) ?? '',
      userHint: (record.get('userHint') as string | null) ?? null,
      sourceUrl: (record.get('sourceUrl') as string | null) ?? null,
      fieldContextId: record.get('fieldContextId') as string,
      // Exactly one uploader, or none. An ambiguous document yields '' so the
      // caller treats it as un-attributable rather than guessing.
      uploaderUserId: (() => {
        const ids = (record.get('uploaderIds') as string[] | null) ?? []
        return ids.length === 1 ? ids[0] : ''
      })(),
      status: record.get('status') as DocumentIngestStatus,
    }
  } finally {
    await session.close()
  }
}

/**
 * Records the page count discovered while preparing extraction inputs.
 *
 * Split out for GOAL-292: page count comes from reading the blob, which now
 * happens in the background worker, while `anchorDocument` runs in the request
 * before any blob has been read. Only paged sources produce a count, so a null
 * simply leaves the property untouched-but-null rather than being an error.
 */
export async function setDocumentPageCount(input: {
  driver: Driver
  documentId: string
  pageCount: number | null
}): Promise<void> {
  if (input.pageCount === null) return
  const session = input.driver.session()
  try {
    await session.executeWrite((tx) =>
      tx.run(
        // toInteger: the driver encodes a plain JS number as a Float64, which
        // would store 3.0 on an int-declared property and render as "3.0".
        `MATCH (d:FieldPulse {id: $documentId}) WHERE d:ResourcePulse
         SET d.sourcePageCount = toInteger($pageCount)`,
        { documentId: input.documentId, pageCount: input.pageCount }
      )
    )
  } finally {
    await session.close()
  }
}

export interface DocumentSummaryInput {
  driver: Driver
  documentId: string
  summary: string | null
  concepts: string[]
}

/**
 * Persists AI-generated summary + concepts on the Document node. Called
 * by the ingest orchestrator after the summarizer model returns. A failed
 * summarizer call is non-fatal — we just skip this write and leave the
 * properties null/empty so the UI degrades gracefully.
 */
export async function setDocumentSummary(
  input: DocumentSummaryInput
): Promise<void> {
  const session = input.driver.session()
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (d:FieldPulse {id: $documentId})
        WHERE d:ResourcePulse
        SET d.sourceSummary = $summary,
            d.sourceConcepts = $concepts,
            d.modifiedAt = datetime()
        `,
        {
          documentId: input.documentId,
          summary: input.summary?.trim() || null,
          concepts: input.concepts.filter((c) => c?.trim().length > 0),
        }
      )
    )
  } finally {
    await session.close()
  }
}

export interface DeleteDocumentInput {
  driver: Driver
  blobStore: BlobStore
  documentId: string
}

export async function deleteDocument(
  input: DeleteDocumentInput
): Promise<void> {
  const session = input.driver.session()
  let blobKey: string | null = null
  try {
    const lookup = await session.executeRead(async (tx) =>
      tx.run(
        `MATCH (d:FieldPulse {id: $documentId})
         WHERE d:ResourcePulse AND d.resourceType = $resourceType
         RETURN d.sourceBlobKey AS blobKey`,
        { documentId: input.documentId, resourceType: RESOURCE_TYPE_DOCUMENT }
      )
    )
    blobKey = (lookup.records[0]?.get('blobKey') as string | null) ?? null

    await session.executeWrite(async (tx) =>
      tx.run(
        // Narrowed to document-backed resources: this helper takes a bare id
        // and applies NO permission gate of its own, so without the predicate
        // it would DETACH DELETE any resource in any Space. The authorized
        // path is handleDeleteDocument.
        `MATCH (d:FieldPulse {id: $documentId})
         WHERE d:ResourcePulse AND d.resourceType = $resourceType
         DETACH DELETE d`,
        {
          documentId: input.documentId,
          resourceType: RESOURCE_TYPE_DOCUMENT,
        }
      )
    )
  } finally {
    await session.close()
  }
  if (blobKey) {
    await input.blobStore.delete(blobKey)
  }
}
