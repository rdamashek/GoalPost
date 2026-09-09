import type { Driver } from 'neo4j-driver'
import neo4j from 'neo4j-driver'
import type { BlobStore } from '@/lib/ingest/blob-store'

/**
 * 90-day hard purge for soft-deleted FieldContexts (GOAL-319). Consumed by
 * the daily `/api/cron/purge-deleted-contexts` route; exported as a plain
 * function so tests can drive it directly (same split as
 * `classifyUnclassifiedBatch` for the feedback cron).
 *
 * A context qualifies once `deletedAt` is older than the retention window.
 * Matching is by property only — deliberately NOT via the
 * `HAS_DELETED_CONTEXT` edge — so a soft-deleted context whose parent Space
 * was itself deleted afterwards (dropping the edge) still gets purged
 * rather than lingering forever.
 *
 * The cascade removes everything nested under the context, closing the
 * gaps the old assistant-path cascade left:
 *
 *   - FieldPulses + their ConversationChunks
 *   - ResonanceLinks anchored on the context OR touching any of its pulses
 *     (cross-context links must go too, or they dangle on live contexts)
 *   - ResonanceSuggestions, same two-way rule
 *   - PromiseWeaves anchored on the context
 *   - Documents (graph node here, blob best-effort after commit — the same
 *     failure ordering as `handleDeleteDocument`: an orphan blob is safer
 *     than a dangling graph reference)
 *   - Organizations attached ONLY to this context (their read gate is
 *     contexts_SOME, so with no other context they are unreachable forever)
 *   - ArticleImportJobs anchored on the context (GOAL-326) — an unfinished one
 *     still holds the member's uploaded rows, and nothing can reach it once the
 *     context is gone
 *
 * Deliberately kept:
 *   - Person nodes (globally readable relational-world entities, never
 *     owned by one context)
 *   - Log + ContextExtraction nodes (append-only audit events; their edges
 *     to purged nodes drop via DETACH — same convention as deleteDocument)
 *   - ConversationThreads reached via a purged Document's
 *     HAS_INGEST_THREAD (owned by the user's chat sidebar; parity with
 *     deleteDocument)
 *
 * Contexts are purged one per transaction, capped per run — the cron is
 * daily, so a backlog drains across runs instead of risking one huge
 * transaction.
 */

export const FIELD_CONTEXT_RETENTION_DAYS = 90

/** Per-run cap on purged contexts; keeps a single cron run well inside the
 * serverless duration ceiling even when every context is large. */
export const MAX_CONTEXTS_PER_RUN = 25

export interface PurgeDependencies {
  driver: Driver
  blobStore: BlobStore
}

export interface PurgeOptions {
  retentionDays?: number
  maxContexts?: number
}

export interface PurgedContextSummary {
  contextId: string
  title: string
  pulseCount: number
  chunkCount: number
  linkCount: number
  suggestionCount: number
  weaveCount: number
  documentCount: number
  importJobCount: number
  organizationCount: number
}

export interface PurgeResult {
  purgedContexts: PurgedContextSummary[]
  blobFailures: number
}

export async function purgeDeletedFieldContexts(
  deps: PurgeDependencies,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const retentionDays = options.retentionDays ?? FIELD_CONTEXT_RETENTION_DAYS
  const maxContexts = options.maxContexts ?? MAX_CONTEXTS_PER_RUN

  const session = deps.driver.session()
  const purgedContexts: PurgedContextSummary[] = []
  let blobFailures = 0
  try {
    const due = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (c:FieldContext)
        WHERE c.deletedAt IS NOT NULL
          AND c.deletedAt < datetime() - duration({days: $retentionDays})
        RETURN c.id AS id
        ORDER BY c.deletedAt ASC
        LIMIT $maxContexts
        `,
        // LIMIT rejects Neo4j Floats — a plain JS number arrives as Float and
        // throws at runtime, so the cap must be wrapped in neo4j.int().
        { retentionDays: neo4j.int(retentionDays), maxContexts: neo4j.int(maxContexts) }
      )
    )

    for (const dueRecord of due.records) {
      const contextId = dueRecord.get('id') as string
      const result = await session.executeWrite((tx) =>
        tx.run(
          `
          MATCH (c:FieldContext {id: $contextId})
          WHERE c.deletedAt IS NOT NULL
            AND c.deletedAt < datetime() - duration({days: $retentionDays})
          // A pulse shared with ANY other still-existing context (live, or
          // soft-deleted but inside its own retention window) survives this
          // purge — it is hard-deleted with its LAST holding context, the
          // same rule as Organizations below.
          OPTIONAL MATCH (c)-[:HAS_PULSE]->(pulse:FieldPulse)
          WHERE NOT EXISTS {
            MATCH (other:FieldContext)-[:HAS_PULSE]->(pulse)
            WHERE other <> c
          }
          WITH c, collect(DISTINCT pulse) AS pulses
          OPTIONAL MATCH (c)-[:HAS_RESONANCE]->(ctxLink:ResonanceLink)
          WITH c, pulses, collect(DISTINCT ctxLink) AS ctxLinks
          OPTIONAL MATCH (c)-[:HAS_SUGGESTION]->(ctxSug:ResonanceSuggestion)
          WITH c, pulses, ctxLinks, collect(DISTINCT ctxSug) AS ctxSugs
          OPTIONAL MATCH (c)-[:HAS_WEAVE]->(weave:PromiseWeave)
          WITH c, pulses, ctxLinks, ctxSugs, collect(DISTINCT weave) AS weaves
          OPTIONAL MATCH (c)-[:HAS_DOCUMENT]->(doc:Document)
          WITH c, pulses, ctxLinks, ctxSugs, weaves, collect(DISTINCT doc) AS docs
          // Queued/finished bulk-import jobs (GOAL-326). They belong to this
          // context and nothing else can reach them once it is gone, and until
          // they reach a terminal status they still hold the member's uploaded
          // rows — an orphan would keep that content past the retention window.
          OPTIONAL MATCH (c)-[:HAS_IMPORT_JOB]->(job:ArticleImportJob)
          WITH c, pulses, ctxLinks, ctxSugs, weaves, docs,
               collect(DISTINCT job) AS importJobs
          // An organization whose ONLY context is this one becomes forever
          // unreachable after the purge (Organization reads gate on
          // contexts_SOME) — remove it rather than leave an invisible orphan.
          OPTIONAL MATCH (c)-[:HAS_ORGANIZATION]->(org:Organization)
          WHERE NOT EXISTS {
            MATCH (other:FieldContext)-[:HAS_ORGANIZATION]->(org)
            WHERE other <> c
          }
          WITH c, pulses, ctxLinks, ctxSugs, weaves, docs, importJobs,
               collect(DISTINCT org) AS orphanOrgs
          UNWIND (CASE WHEN size(pulses) = 0 THEN [null] ELSE pulses END) AS p
          OPTIONAL MATCH (p)-[:HAS_CHUNK]->(chunk:ConversationChunk)
          OPTIONAL MATCH (conn)-[:SOURCE|TARGET]->(p)
          WHERE conn:ResonanceLink OR conn:ResonanceSuggestion
          WITH c, pulses, ctxLinks, ctxSugs, weaves, docs, importJobs, orphanOrgs,
               collect(DISTINCT chunk) AS chunks,
               collect(DISTINCT conn) AS pulseConns
          WITH c, pulses, weaves, docs, importJobs, orphanOrgs, chunks,
               ctxLinks + [x IN pulseConns WHERE x:ResonanceLink AND NOT x IN ctxLinks] AS links,
               ctxSugs + [x IN pulseConns WHERE x:ResonanceSuggestion AND NOT x IN ctxSugs] AS sugs
          WITH c, pulses, weaves, docs, importJobs, orphanOrgs, chunks, links, sugs,
               c.title AS title,
               // GOAL-354: a document is a ResourcePulse, so its blob key lives
               // on the pulse as sourceBlobKey and it is collected by the
               // pulses branch above, not by docs. Reading only docs here
               // would silently stop cleaning up S3 the moment the migration
               // runs — the purge would delete the graph node and leave the
               // file behind forever, which is the retention guarantee this
               // cron exists to honour. The legacy docs branch is kept until
               // the Document type is retired so a pre-migration environment
               // still cleans up.
               [d IN docs WHERE d.blobKey IS NOT NULL | d.blobKey]
                 + [p IN pulses WHERE p.sourceBlobKey IS NOT NULL | p.sourceBlobKey]
                 AS blobKeys
          FOREACH (n IN chunks | DETACH DELETE n)
          FOREACH (n IN links | DETACH DELETE n)
          FOREACH (n IN sugs | DETACH DELETE n)
          FOREACH (n IN weaves | DETACH DELETE n)
          FOREACH (n IN docs | DETACH DELETE n)
          FOREACH (n IN importJobs | DETACH DELETE n)
          FOREACH (n IN orphanOrgs | DETACH DELETE n)
          FOREACH (n IN pulses | DETACH DELETE n)
          WITH c, title, blobKeys,
               size(pulses) AS pulseCount,
               size(chunks) AS chunkCount,
               size(links) AS linkCount,
               size(sugs) AS suggestionCount,
               size(weaves) AS weaveCount,
               size(docs) AS documentCount,
               size(importJobs) AS importJobCount,
               size(orphanOrgs) AS organizationCount
          DETACH DELETE c
          RETURN title, blobKeys, pulseCount, chunkCount, linkCount,
                 suggestionCount, weaveCount, documentCount, importJobCount,
                 organizationCount
          `,
          { contextId, retentionDays: neo4j.int(retentionDays) }
        )
      )

      const record = result.records[0]
      if (!record) continue

      purgedContexts.push({
        contextId,
        title: (record.get('title') as string | null) ?? '',
        pulseCount: Number(record.get('pulseCount') ?? 0),
        chunkCount: Number(record.get('chunkCount') ?? 0),
        linkCount: Number(record.get('linkCount') ?? 0),
        suggestionCount: Number(record.get('suggestionCount') ?? 0),
        weaveCount: Number(record.get('weaveCount') ?? 0),
        documentCount: Number(record.get('documentCount') ?? 0),
        importJobCount: Number(record.get('importJobCount') ?? 0),
        organizationCount: Number(record.get('organizationCount') ?? 0),
      })

      // Best-effort blob cleanup after the transaction committed — an
      // orphan blob is the safe failure, never a dangling Document node.
      const blobKeys = (record.get('blobKeys') as string[] | null) ?? []
      for (const blobKey of blobKeys) {
        try {
          await deps.blobStore.delete(blobKey)
        } catch (err) {
          blobFailures += 1
          console.warn(
            `[Purge Contexts] best-effort blob cleanup failed for ${blobKey}:`,
            err
          )
        }
      }
    }
  } finally {
    await session.close()
  }

  return { purgedContexts, blobFailures }
}
