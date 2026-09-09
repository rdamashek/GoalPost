import type { Session } from 'neo4j-driver'
import { GraphQLError } from 'graphql'
import { after } from 'next/server'
import { driver } from '@/lib/neo4j/driver'
import { handleReExtractDocument } from '@/lib/ingest/handle-reextract-document'
import { runContextResonanceDiscovery } from '@/lib/resonance/discovery/on-upload-discovery'
import { createOpenAIExtractionModelClient } from '@/lib/ingest/openai-extraction-model-client'
import { createGeminiExtractionModelClient } from '@/lib/ingest/gemini-extraction-model-client'
import { RESOURCE_TYPE_DOCUMENT } from '@/lib/ingest/source-resource-node'
import {
  createOpenAIDocumentSummarizer,
  createGeminiDocumentSummarizer,
} from '@/lib/ingest/document-summarizer'
import { createS3BlobStore } from '@/lib/ingest/s3-blob-store'
import { createMemoryBlobStore } from '@/lib/ingest/blob-store'
import { handleDeleteDocument } from '@/lib/ingest/handle-delete-document'
import { buildDocumentDownloadUrl } from '@/lib/ingest/document-download-url'
import { DOCUMENT_INGEST_STATUS } from '@/lib/ingest/document-ingest-queue'
import { projectedList } from './projection'

/**
 * GraphQL surface for the doc-ingestion epic.
 *
 *   mutation reExtractDocument(documentId: ID!) -> IngestDocumentResponse
 *   mutation deleteDocument(documentId: ID!) -> DocumentDeleted
 *   query documentsByFieldContext(fieldContextId: ID!) -> [Document!]!
 *
 * The initial-upload mutation has been replaced by the REST direct-to-S3
 * flow at POST /api/ingest/document/presign + /process — the browser
 * uploads the file straight to S3 and only then triggers extraction. The
 * GraphQL surface here is for post-upload operations only.
 */

interface ResolverContext {
  jwt?: { user?: { id?: string } }
  executionContext?: { session?: () => Session }
}

function resolveBlobStore() {
  if (process.env.INGEST_BLOB_BACKEND === 'memory') {
    return createMemoryBlobStore()
  }
  return createS3BlobStore()
}

function requireUserId(context: ResolverContext): string {
  const userId = context.jwt?.user?.id?.trim() || ''
  if (!userId) {
    throw new GraphQLError('Authentication required.', {
      extensions: { code: 'UNAUTHENTICATED' },
    })
  }
  return userId
}

export const documentMutations = {
  reExtractDocument: async (
    _parent: unknown,
    args: { documentId: string },
    context: ResolverContext
  ) => {
    const userId = requireUserId(context)
    const documentId = String(args.documentId ?? '').trim()
    if (!documentId) {
      throw new GraphQLError('documentId is required.', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }

    const result = await handleReExtractDocument(
      {
        driver,
        blobStore: resolveBlobStore(),
        pdfExtractionClient: createGeminiExtractionModelClient(),
        textExtractionClient: createOpenAIExtractionModelClient(),
        pdfSummarizerClient: createGeminiDocumentSummarizer(),
        textSummarizerClient: createOpenAIDocumentSummarizer(),
      },
      { currentUserId: userId, documentId }
    )

    if (!result.ok) {
      const code =
        result.reason === 'forbidden'
          ? 'FORBIDDEN'
          : result.reason === 'not_found'
            ? 'NOT_FOUND'
            : 'BAD_USER_INPUT'
      throw new GraphQLError(result.error, {
        extensions: { code, reason: result.reason },
      })
    }

    // Post-run resonance discovery + embedding backfill (GOAL-318). The
    // initial-upload route schedules the same pass; without this, a
    // re-extract that mints the document's author (create_person) or a new
    // pulse would leave them unembedded until the nightly cron. Same
    // predicate as the upload route; `after()` runs it once the response is
    // sent, and `runContextResonanceDiscovery` never throws.
    const createdAPulseOrPerson = result.executedToolCalls.some(
      (c) =>
        (c.tool === 'create_pulse' || c.tool === 'create_person') &&
        c.result.success !== false
    )
    if (createdAPulseOrPerson) {
      after(async () => {
        await runContextResonanceDiscovery({
          contextId: result.fieldContextId,
          actorUserId: userId,
        })
      })
    }

    return {
      documentId: result.documentId,
      threadId: result.threadId,
      createdEntityCount: result.executedToolCalls.filter(
        (c) => c.result.success !== false
      ).length,
      failedEntityCount: result.executedToolCalls.filter(
        (c) => c.result.success === false
      ).length,
    }
  },

  deleteDocument: async (
    _parent: unknown,
    args: { documentId: string },
    context: ResolverContext
  ) => {
    const userId = requireUserId(context)
    const documentId = String(args.documentId ?? '').trim()
    if (!documentId) {
      throw new GraphQLError('documentId is required.', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }

    // Orchestrator does gate + Log + DETACH DELETE + dangling-locator
    // clearing (GOAL-321) in a single transaction, then a best-effort blob
    // cleanup. A missing document and a forbidden access return the same
    // `forbidden` failure to avoid leaking document existence to
    // non-members.
    const result = await handleDeleteDocument(
      { driver, blobStore: resolveBlobStore() },
      { currentUserId: userId, documentId }
    )

    if (!result.ok) {
      const code =
        result.reason === 'forbidden' ? 'FORBIDDEN' : 'BAD_USER_INPUT'
      throw new GraphQLError(result.error, {
        extensions: { code, reason: result.reason },
      })
    }

    return { documentId: result.documentId, deleted: true }
  },
}

/**
 * Field resolvers on the `Document` type. The list query bypasses
 * neo4j-graphql's OGM with a hand-rolled Cypher projection (so the Space
 * membership gate stays inline), which means relationship fields like
 * `extractedPeople`, `extractedPulses`, and `ingestThreads` need their own
 * resolvers — neo4j-graphql doesn't chain @relationship resolvers onto
 * objects produced by a custom Query resolver.
 *
 * Each resolver re-derives state from the source document id; cost is one
 * Cypher round-trip per field per row, which is acceptable for the < 20
 * documents/list expected in v1.
 *
 * They must NOT run when the library resolved the parent itself (the
 * `documents` root, `fieldContexts { documents { … } }`, …): there the
 * projection is already on `source`, authorization-filtered and complete, and
 * replacing it with these three-column re-queries drops every nested field the
 * caller selected. `projectedList` is that guard — see ./projection.ts.
 */
export const documentTypeResolvers = {
  /**
   * GOAL-283: the durable, Space-scoped link to open/download the uploaded
   * file. Computed from the document id — the route re-checks access and mints
   * a fresh presigned URL on every hit, so we never persist an expiring URL.
   * Deriving it (rather than storing an absolute URL on the node) also avoids
   * baking the current deploy domain into the graph.
   */
  downloadUrl: (source: { id?: string }): string | null =>
    source?.id ? buildDocumentDownloadUrl(source.id) : null,
  extractedPeople: async (source: Record<string, unknown>) => {
    const projected = projectedList(source, 'extractedPeople')
    if (projected) return projected
    if (!source?.id) return []
    const session = driver.session()
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `
          MATCH (p:Person)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $documentId})
          RETURN p.id AS id, p.firstName AS firstName, p.lastName AS lastName
          ORDER BY p.firstName ASC
          `,
          { documentId: source.id }
        )
      )
      return result.records.map((r) => ({
        __typename: 'Person',
        id: r.get('id'),
        firstName: r.get('firstName') ?? '',
        lastName: r.get('lastName') ?? '',
      }))
    } finally {
      await session.close()
    }
  },
  extractedPulses: async (source: Record<string, unknown>) => {
    const projected = projectedList(source, 'extractedPulses')
    if (projected) return projected
    if (!source?.id) return []
    const session = driver.session()
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `
          MATCH (p:FieldPulse)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $documentId})
          RETURN p.id AS id, p.title AS title, labels(p) AS labels
          ORDER BY p.title ASC
          `,
          { documentId: source.id }
        )
      )
      return result.records.map((r) => {
        const labels = (r.get('labels') as string[] | null) ?? []
        const concrete =
          labels.find((l) =>
            ['GoalPulse', 'ResourcePulse', 'StoryPulse', 'CarePulse', 'CoreValuePulse'].includes(l)
          ) ?? 'StoryPulse'
        return {
          __typename: concrete,
          id: r.get('id'),
          title: r.get('title') ?? '',
        }
      })
    } finally {
      await session.close()
    }
  },
  ingestThreads: async (source: Record<string, unknown>) => {
    const projected = projectedList(source, 'ingestThreads')
    if (projected) return projected
    if (!source?.id) return []
    const session = driver.session()
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `
          MATCH (d:ResourcePulse {id: $documentId})-[:HAS_INGEST_THREAD]->(t:ConversationThread)
          RETURN t.id AS id, t.title AS title, toString(t.createdAt) AS createdAt
          ORDER BY t.createdAt DESC
          `,
          { documentId: source.id }
        )
      )
      return result.records.map((r) => ({
        id: r.get('id'),
        title: r.get('title') ?? '',
        createdAt: r.get('createdAt') ?? '',
      }))
    } finally {
      await session.close()
    }
  },
}

interface DocumentsByFieldContextArgs {
  fieldContextId: string
}

interface DocumentRow {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  pageCount: number | null
  userHint: string | null
  summary: string | null
  concepts: string[]
  uploadedAt: string
  /** Ingest lifecycle (GOAL-292) — drives the upload UI's polling. */
  status: string
  statusMessage: string | null
  ingestCreatedEntityCount: number | null
  ingestFailedEntityCount: number | null
}

/**
 * Neo4j integers arrive as bigint-like objects; a document that has not
 * finished ingesting has no count at all. Normalise both to a plain number or
 * null so the GraphQL Int field never receives an unserialisable value.
 */
function toCountOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const asNumber = Number(value)
  return Number.isFinite(asNumber) ? asNumber : null
}

export const documentQueries = {
  documentsByFieldContext: async (
    _parent: unknown,
    args: DocumentsByFieldContextArgs,
    context: ResolverContext
  ) => {
    const userId = requireUserId(context)

    const session = driver.session()
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `
          MATCH (space:Space)-[:HAS_CONTEXT]->(c:FieldContext {id: $fieldContextId})
          OPTIONAL MATCH (owner:Person {id: $userId})-[:OWNS]->(space)
          OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person {id: $userId})
          WITH c, (owner IS NOT NULL OR member IS NOT NULL) AS allowed
          WHERE allowed
          // GOAL-354: a document is a ResourcePulse. HAS_PULSE reaches every
          // pulse in the context, so the resourceType predicate is what keeps
          // this list to documents rather than every resource in the field.
          MATCH (c)-[:HAS_PULSE]->(d:ResourcePulse)
          WHERE d.resourceType = $resourceType
          RETURN
            d.id AS id,
            d.sourceFilename AS filename,
            d.sourceMimeType AS mimeType,
            d.sourceSizeBytes AS sizeBytes,
            d.sourcePageCount AS pageCount,
            d.sourceUserHint AS userHint,
            d.sourceSummary AS summary,
            d.sourceConcepts AS concepts,
            toString(coalesce(d.uploadedAt, d.createdAt)) AS uploadedAt,
            // Documents predating GOAL-292 carry no status; they are finished
            // uploads, so they read back COMPLETE rather than looking stuck.
            coalesce(d.ingestStatus, $completeStatus) AS status,
            d.ingestStatusMessage AS statusMessage,
            d.ingestCreatedEntityCount AS ingestCreatedEntityCount,
            d.ingestFailedEntityCount AS ingestFailedEntityCount
          ORDER BY coalesce(d.uploadedAt, d.createdAt) DESC
          `,
          {
            fieldContextId: args.fieldContextId,
            userId,
            completeStatus: DOCUMENT_INGEST_STATUS.complete,
            resourceType: RESOURCE_TYPE_DOCUMENT,
          }
        )
      )
      return result.records.map((r): DocumentRow => {
        const rawPageCount = r.get('pageCount') as number | bigint | null
        const rawConcepts = r.get('concepts') as string[] | null
        return {
          id: r.get('id') as string,
          filename: r.get('filename') as string,
          mimeType: r.get('mimeType') as string,
          sizeBytes: Number(r.get('sizeBytes') ?? 0),
          pageCount: rawPageCount === null ? null : Number(rawPageCount),
          userHint: (r.get('userHint') as string | null) ?? null,
          summary: (r.get('summary') as string | null) ?? null,
          concepts: Array.isArray(rawConcepts) ? rawConcepts : [],
          uploadedAt: (r.get('uploadedAt') as string) ?? '',
          status: r.get('status') as string,
          statusMessage: (r.get('statusMessage') as string | null) ?? null,
          ingestCreatedEntityCount: toCountOrNull(
            r.get('ingestCreatedEntityCount')
          ),
          ingestFailedEntityCount: toCountOrNull(
            r.get('ingestFailedEntityCount')
          ),
        }
      })
    } finally {
      await session.close()
    }
  },
}
