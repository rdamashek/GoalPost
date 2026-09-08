import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { driver } from '@/lib/neo4j/driver'
import { initGraph } from '@/modules/graph'
import { resolveAuthenticatedUserId } from '@/app/api/auth/utils'
import { rateLimit, rateLimited } from '@/lib/auth/rate-limit'
import { loadEditableContext } from '@/lib/imports/article-import-service'
import {
  IMPORT_FORBIDDEN_MESSAGE,
  createArticleImportJob,
  listArticleImportJobsForRequester,
} from '@/lib/imports/article-import-queue'
import { kickQueueWorker } from '@/lib/jobs/kick-queue-worker'
import {
  ARTICLE_EMAIL_SHAPE,
  ARTICLE_FIELD_LIMITS,
  ARTICLE_IMPORT_STATUS,
  MAX_ARTICLE_IMPORT_ROWS,
  buildArticleImportMessage,
  summarizeArticleOutcomes,
  type ArticleImportJobListItem,
} from '@/lib/imports/article-import'

/**
 * GOAL-317 — spreadsheet-driven bulk upload of articles as pulses.
 * GOAL-326 — the batch is queued, not run inline.
 *
 *   POST /api/import/articles
 *   { fieldContextId, rows: [{ row, title, author, date, url, ... }] }
 *   → 202 { jobId, status: 'PENDING', totalRows }
 *
 * The client parses the CSV/XLSX locally (preview + confirm step), then
 * submits the typed rows. This request authenticates, rate-limits, validates,
 * gates on `canEditContent`, and anchors an `:ArticleImportJob` as PENDING.
 * `/api/cron/process-article-imports` mints the pulses; the client polls
 * `GET /api/import/articles/<jobId>` for progress and the per-row result.
 *
 * Previously this route ran the whole row loop inline under `maxDuration = 300`
 * and scheduled the embedding/resonance sweep in a fire-and-forget `after()` —
 * a 300-row batch raced the serverless ceiling, and the sweep (real OpenAI
 * spend) was neither durable, retried, nor observable. Same failure mode
 * GOAL-292 fixed for document ingestion, and the same fix: enqueue + worker.
 * Nothing here is slow any more, so the raised `maxDuration` is gone.
 */

const articleRowSchema = z.object({
  row: z.number().int().min(2),
  title: z.string().trim().min(1).max(ARTICLE_FIELD_LIMITS.title),
  author: z.string().trim().min(1).max(ARTICLE_FIELD_LIMITS.author),
  authorEmail: z
    .string()
    .trim()
    .regex(ARTICLE_EMAIL_SHAPE, 'Invalid author email.')
    .max(ARTICLE_FIELD_LIMITS.authorEmail)
    .optional(),
  date: z.string().trim().min(1).max(ARTICLE_FIELD_LIMITS.date),
  url: z.string().trim().min(1).max(ARTICLE_FIELD_LIMITS.url),
  pulseType: z.enum(['GoalPulse', 'ResourcePulse', 'StoryPulse']),
  description: z
    .string()
    .trim()
    .max(ARTICLE_FIELD_LIMITS.description)
    .optional(),
  // GOAL-355 — optional by construction: a sheet in the pre-GOAL-355 format
  // submits neither key and validates exactly as it did before.
  // No `.min(1)`: an empty string is tolerated here exactly as `description`
  // tolerates one, so a client sending `resourceType: ''` cannot 400 the whole
  // batch over a cell the preview would simply have treated as absent.
  resourceType: z
    .string()
    .trim()
    .max(ARTICLE_FIELD_LIMITS.resourceType)
    .optional(),
  sourceUrl: z
    .string()
    .trim()
    .max(ARTICLE_FIELD_LIMITS.sourceUrl)
    .optional(),
})

const articleImportSchema = z.object({
  fieldContextId: z.string().trim().min(1),
  rows: z
    .array(articleRowSchema)
    .min(1, 'At least one row is required.')
    .max(
      MAX_ARTICLE_IMPORT_ROWS,
      `A single import is capped at ${MAX_ARTICLE_IMPORT_ROWS} rows — split larger sheets into batches.`
    ),
})

/**
 * GOAL-336 — the requester's own import jobs for one FieldContext.
 *
 *   GET /api/import/articles?fieldContextId=<id>
 *   → 200 { jobs: ArticleImportJobListItem[] }   (newest first)
 *
 * The field-context page renders this as the durable status surface: closing
 * the import modal, a new tab, or another device can all rediscover a queued
 * import and its receipt without the sessionStorage job id (which stays as an
 * accelerator only). Summaries only — the full per-row receipt is fetched per
 * job from `GET /api/import/articles/<jobId>`, keeping this poll cheap.
 *
 * Scoped to the requester alone via the `REQUESTED_BY` edge, exactly like the
 * jobId route: a WeSpace member who did not queue an import sees an empty
 * list, and a missing, soft-deleted, or not-visible context answers
 * identically — the response cannot be used to probe other people's Spaces.
 */
export async function GET(req: Request) {
  const currentUserId = resolveAuthenticatedUserId(req)
  if (!currentUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const fieldContextId = new URL(req.url).searchParams
    .get('fieldContextId')
    ?.trim()
  if (!fieldContextId) {
    return Response.json(
      { error: 'fieldContextId is required.' },
      { status: 400 }
    )
  }

  const entries = await listArticleImportJobsForRequester(
    driver,
    fieldContextId,
    currentUserId
  )
  const jobs: ArticleImportJobListItem[] = entries.map((entry) => {
    const summary = summarizeArticleOutcomes(entry.outcomes, entry.totalRows)
    return {
      jobId: entry.jobId,
      status: entry.status,
      statusMessage: entry.statusMessage,
      processedRows: entry.outcomes.length,
      // Same batch semantics as the jobId route: true only once the job
      // finished AND every row landed.
      success:
        entry.status === ARTICLE_IMPORT_STATUS.complete &&
        summary.failed === 0,
      message: buildArticleImportMessage(summary),
      summary,
      createdAtMs: entry.createdAtMs,
      statusUpdatedAtMs: entry.statusUpdatedAtMs,
    }
  })

  // Per-user authenticated payload — never let a shared cache hold it,
  // matching the jobId route.
  return Response.json(
    { jobs },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}

export async function POST(req: Request) {
  const currentUserId = resolveAuthenticatedUserId(req)
  if (!currentUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Bound how often one account can queue 300-row batches (each ends in an
  // embedding + resonance sweep with real OpenAI spend).
  const { allowed, retryAfter } = await rateLimit({
    policy: 'bulk-import',
    key: currentUserId,
  })
  if (!allowed) return rateLimited(retryAfter)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected JSON body.' }, { status: 400 })
  }

  const parsed = articleImportSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      {
        error: 'Invalid import payload.',
        details: parsed.error.flatten(),
      },
      { status: 400 }
    )
  }

  // Permission gate BEFORE any write. The synchronous path could leave this to
  // `processArticleImport`, which ran in the same request; now the worker acts
  // on the persisted REQUESTED_BY edge, so an unauthorized caller must never
  // get a job at all. Missing and forbidden share one message so the response
  // cannot be used to probe for contexts in other people's Spaces.
  const graph = await initGraph()
  const context = await loadEditableContext(
    graph,
    currentUserId,
    parsed.data.fieldContextId
  )
  if (!context.found || !context.allowed) {
    return Response.json(
      { error: IMPORT_FORBIDDEN_MESSAGE, reason: 'forbidden' },
      { status: 403 }
    )
  }

  // Enqueueing is cheap now, which removes the synchronous design's accidental
  // throttle (the member had to wait for one import before starting another).
  // The `bulk-import` rate limit is the primary bound but fails OPEN when Redis
  // is unreachable, so the in-flight cap is the one that has to hold — which is
  // why it is enforced INSIDE the enqueue write rather than as a read before
  // it. A count-then-create would be a check-then-act, and N concurrent
  // requests would all see zero in flight and all enqueue.
  const jobId = `import_${randomUUID()}`
  const enqueued = await createArticleImportJob(driver, {
    jobId,
    fieldContextId: parsed.data.fieldContextId,
    requesterUserId: currentUserId,
    rows: parsed.data.rows,
  })
  if (!enqueued.created) {
    return Response.json(
      {
        error: `You have ${enqueued.inFlight} imports still being processed. Wait for those to finish before starting another.`,
        reason: 'queue_full',
      },
      { status: 429 }
    )
  }

  // The batch is durable in the queue either way; the kick starts a worker
  // sweep as soon as the 202 is on the wire instead of waiting for a
  // scheduler tick, which on dev/demo can be the better part of an hour away.
  kickQueueWorker(req, 'article-imports')

  // 202 Accepted: the batch is queued, nothing has been written into the field
  // yet. The client polls the job for progress rather than waiting here.
  return Response.json(
    {
      jobId,
      status: ARTICLE_IMPORT_STATUS.pending,
      totalRows: parsed.data.rows.length,
    },
    { status: 202 }
  )
}
