import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { loadDocumentRecord } from './document-storage'
import {
  DOCUMENT_INGEST_STATUS,
  INGEST_ABANDONED_MESSAGE,
  MAX_INGEST_ATTEMPTS,
  STALE_PROCESSING_MINUTES,
  claimDocumentForIngest,
  findPendingDocumentIds,
  markDocumentIngestComplete,
  markDocumentIngestFailed,
  reclaimStalledIngests,
  type ReclaimResult,
} from './document-ingest-queue'

/**
 * Integration test for the GOAL-292 document-ingestion queue. Exercises the
 * real Neo4j driver against the dev Aura instance and skips itself when Neo4j
 * is unreachable (CI without NEO4J_*), the same shape as
 * `document-storage.test.ts`.
 *
 * Run with the repo's own env wiring — `jest.config.js` uses
 * `setupFiles: ['dotenv/config']`, which loads `.env`, and this repo only has
 * `.env.local`:
 *
 *     pnpm test -- src/lib/ingest/document-ingest-queue.test.ts
 *     # or: DOTENV_CONFIG_PATH=.env.local npx jest src/lib/ingest/document-ingest-queue.test.ts
 *
 * A plain `npx jest` sees empty NEO4J_* and every assertion below silently
 * self-skips.
 *
 * SHARED-DATABASE DISCIPLINE. The dev instance is shared and, once GOAL-292
 * ships, `/api/cron/process-document-ingestion` runs against it every minute
 * looking for exactly the PENDING documents this suite creates. So:
 *   - every fixture id is namespaced with a per-run prefix,
 *   - the tests that need PENDING/PROCESSING rows delete them in their own
 *     `afterAll` rather than waiting for the suite to finish,
 *   - the suite-level teardown first neutralises any surviving fixture to
 *     COMPLETE and only then deletes it, so a fixture that somehow outlives
 *     cleanup can never be picked up as real work,
 *   - teardown asserts that nothing is left behind.
 *
 * `findPendingDocumentIds` and `reclaimStalledIngests` are deliberately
 * database-wide (that is what the worker calls), so assertions filter to this
 * run's prefix and compare counts with `toBeGreaterThanOrEqual` instead of
 * assuming this suite owns every Document in the instance.
 */

let neo4jAvailable = false

const testRunId = `iq_${randomUUID().slice(0, 8)}`
const prefix = `test_${testRunId}_`

const ids = {
  user: `${prefix}user`,
  meSpace: `${prefix}me`,
  fieldContext: `${prefix}ctx_live`,
  deletedFieldContext: `${prefix}ctx_deleted`,
}

/** Every Document id minted by this run, for the belt-and-braces teardown. */
const createdDocumentIds: string[] = []

interface CreateDocumentOptions {
  /** Suffix appended to the run prefix. */
  key: string
  /**
   * Ingest status to stamp. Pass `null` to create the node with **no** `status`
   * property at all — the pre-GOAL-292 legacy shape.
   */
  status?: string | null
  /** Defaults to the live FieldContext. */
  fieldContextId?: string
  /** Drives the `ORDER BY d.uploadedAt ASC` fairness assertion. */
  uploadedMinutesAgo?: number
  /** Drives the stale-claim window in `reclaimStalledIngests`. */
  statusMinutesAgo?: number
  ingestAttempts?: number
  ingestClaimedBy?: string | null
}

async function createDocument(options: CreateDocumentOptions): Promise<string> {
  const documentId = `${prefix}doc_${options.key}`
  const session = driver.session()
  try {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (c:FieldContext {id: $fieldContextId})
        MATCH (u:Person:User {id: $userId})
        CREATE (d:FieldPulse:ResourcePulse {
          id: $documentId,
          sourceFilename: $filename,
          sourceMimeType: 'text/plain',
          sourceSizeBytes: 29,
          sourcePageCount: 1,
          sourceUserHint: null,
          sourceBlobKey: 'documents/' + $documentId + '/notes.txt',
          sourceBlobUrl: 'memory://' + $documentId,
          ingestStatusMessage: null,
          ingestStatusUpdatedAt: datetime() - duration({minutes: $statusMinutesAgo}),
          ingestAttempts: $ingestAttempts,
          ingestClaimedBy: $ingestClaimedBy,
          uploadedAt: datetime() - duration({minutes: $uploadedMinutesAgo})
        })
        CREATE (c)-[:HAS_PULSE]->(d)
        CREATE (d)-[:UPLOADED_BY]->(u)
        // A legacy document carries no status property at all, so the SET has
        // to be conditional rather than writing an explicit null.
        FOREACH (_ IN CASE WHEN $status IS NULL THEN [] ELSE [1] END |
          SET d.ingestStatus = $status
        )
        RETURN d.id AS id
        `,
        {
          documentId,
          filename: `${options.key}.txt`,
          fieldContextId: options.fieldContextId ?? ids.fieldContext,
          userId: ids.user,
          status: options.status === undefined ? DOCUMENT_INGEST_STATUS.pending : options.status,
          statusMinutesAgo: options.statusMinutesAgo ?? 0,
          uploadedMinutesAgo: options.uploadedMinutesAgo ?? 0,
          ingestAttempts: options.ingestAttempts ?? 0,
          ingestClaimedBy: options.ingestClaimedBy ?? null,
        }
      )
    )
    if (result.records.length === 0) {
      throw new Error(`createDocument: fixture ${documentId} was not created`)
    }
  } finally {
    await session.close()
  }
  createdDocumentIds.push(documentId)
  return documentId
}

interface DocumentState {
  status: string | null
  statusMessage: string | null
  statusUpdatedAt: string | null
  ingestAttempts: number
  ingestClaimedBy: string | null
  createdEntityCount: number | null
  failedEntityCount: number | null
}

async function readDocumentState(documentId: string): Promise<DocumentState> {
  const session = driver.session()
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (d:ResourcePulse {id: $documentId})
        RETURN d.ingestStatus AS status,
               d.ingestStatusMessage AS statusMessage,
               toString(d.ingestStatusUpdatedAt) AS statusUpdatedAt,
               coalesce(d.ingestAttempts, 0) AS ingestAttempts,
               d.ingestClaimedBy AS ingestClaimedBy,
               d.ingestCreatedEntityCount AS createdEntityCount,
               d.ingestFailedEntityCount AS failedEntityCount
        `,
        { documentId }
      )
    )
    const record = result.records[0]
    if (!record) throw new Error(`readDocumentState: ${documentId} not found`)
    const createdEntityCount = record.get('createdEntityCount')
    const failedEntityCount = record.get('failedEntityCount')
    return {
      status: record.get('status') as string | null,
      statusMessage: record.get('statusMessage') as string | null,
      statusUpdatedAt: record.get('statusUpdatedAt') as string | null,
      ingestAttempts: Number(record.get('ingestAttempts')),
      ingestClaimedBy: record.get('ingestClaimedBy') as string | null,
      createdEntityCount:
        createdEntityCount === null ? null : Number(createdEntityCount),
      failedEntityCount:
        failedEntityCount === null ? null : Number(failedEntityCount),
    }
  } finally {
    await session.close()
  }
}

/**
 * Removes fixture documents as soon as the test that needed them is done, so a
 * PENDING or PROCESSING fixture is never visible to the every-minute worker for
 * longer than the test itself.
 */
async function deleteDocuments(documentIds: string[]): Promise<void> {
  const session = driver.session()
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (d:ResourcePulse)
        WHERE d.id IN $documentIds
        DETACH DELETE d
        `,
        { documentIds }
      )
    )
  } finally {
    await session.close()
  }
}

beforeAll(async () => {
  try {
    const session = driver.session()
    await session.run('RETURN 1')
    await session.close()
    neo4jAvailable = true
  } catch {
    neo4jAvailable = false
  }
  if (!neo4jAvailable) return

  const session = driver.session()
  try {
    await session.run(
      `
      CREATE (u:Person:User {id: $userId, firstName: 'Test', lastName: 'Uploader', name: 'Test Uploader', createdAt: datetime()})
      CREATE (s:Space:MeSpace {id: $spaceId, name: 'Test MeSpace', visibility: 'PRIVATE', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Ingest Queue', createdAt: datetime()})
      CREATE (u)-[:OWNS]->(s)
      CREATE (s)-[:HAS_CONTEXT]->(c)
      // GOAL-319 soft delete: the edge is re-pointed and deletedAt stamped.
      CREATE (dc:FieldContext {id: $deletedCtxId, title: 'Retired Field', createdAt: datetime(), deletedAt: datetime()})
      CREATE (s)-[:HAS_DELETED_CONTEXT]->(dc)
      `,
      {
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
        deletedCtxId: ids.deletedFieldContext,
      }
    )
  } finally {
    await session.close()
  }
})

afterAll(async () => {
  if (!neo4jAvailable) {
    await driver.close()
    return
  }
  const session = driver.session()
  try {
    // Step 1 — neutralise before deleting. If the DETACH DELETE below were to
    // fail partway (or a fixture escaped `createdDocumentIds`), a leftover
    // PENDING row would be claimed by the real worker and run the LLM pipeline
    // against a blob that does not exist. Parking everything in COMPLETE first
    // makes that impossible regardless of what happens next.
    await session.run(
      `
      MATCH (d:ResourcePulse)
      WHERE d.id STARTS WITH $prefix
      SET d.ingestStatus = $complete,
          d.ingestClaimedBy = null
      `,
      { prefix, complete: DOCUMENT_INGEST_STATUS.complete }
    )

    // Step 2 — drop every node this run minted, whatever its label, so an
    // interrupted test still cleans up after itself.
    await session.run(
      `
      MATCH (n)
      WHERE n.id STARTS WITH $prefix
      DETACH DELETE n
      `,
      { prefix }
    )

    // Step 3 — prove the shared instance is clean again.
    const leftovers = await session.run(
      `
      MATCH (n)
      WHERE n.id STARTS WITH $prefix
      RETURN n.id AS id
      `,
      { prefix }
    )
    const leaked = leftovers.records.map((record) => record.get('id') as string)
    if (leaked.length > 0) {
      throw new Error(
        `document-ingest-queue.test leaked ${leaked.length} fixture node(s): ${leaked.join(', ')}`
      )
    }
  } finally {
    await session.close()
    await driver.close()
  }
})

/**
 * Neo4j reachability is only known once `beforeAll` has run, which is after
 * every `describe` body has been evaluated — so tests are always registered and
 * bail out from the inside, matching `document-storage.test.ts`.
 */
function neo4jReady(): boolean {
  if (!neo4jAvailable) {
    console.warn(
      '[document-ingest-queue.test] Skipping integration assertions — Neo4j unreachable'
    )
    return false
  }
  return true
}

describe('claimDocumentForIngest', () => {
  it('reports whether the integration assertions actually ran', () => {
    if (!neo4jReady()) return
    expect(neo4jAvailable).toBe(true)
  })

  it('lets exactly one of 8 racing workers win, incrementing ingestAttempts once', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({ key: 'race' })
    const workerRunIds = Array.from(
      { length: 8 },
      (_, index) => `${prefix}worker_${index}`
    )

    // The whole point of the write-then-guard shape in the queue: without the
    // `SET d.ingestClaimedBy` that takes the write lock *before* the
    // `WHERE d.ingestStatus = 'PENDING'` re-check, Neo4j's read-committed isolation
    // lets overlapping claims all pass a predicate they evaluated before
    // holding the lock — a lost update that runs the LLM pipeline twice and
    // double-creates entities. Measured at 11/12 trials with the naive shape.
    const outcomes = await Promise.all(
      workerRunIds.map((workerRunId) =>
        claimDocumentForIngest(driver, documentId, workerRunId)
      )
    )

    const winners = outcomes.filter((outcome) => outcome !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.id).toBe(documentId)
    expect(winners[0]!.filename).toBe('race.txt')

    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.processing)
    expect(state.ingestAttempts).toBe(1)
    expect(state.statusMessage).toBeNull()
    // `ingestClaimedBy` is stamped unconditionally by every claimant — that
    // unconditional SET is what takes the lock — so the surviving value is
    // whichever transaction committed last, not necessarily the winner. It is a
    // diagnostic breadcrumb, never the ownership decision; the returned row is.
    expect(workerRunIds).toContain(state.ingestClaimedBy)

    await deleteDocuments([documentId])
  })

  it('returns null for a second claim once the document is PROCESSING', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({ key: 'second_claim' })

    const first = await claimDocumentForIngest(
      driver,
      documentId,
      `${prefix}worker_first`
    )
    expect(first).not.toBeNull()
    expect(first!.id).toBe(documentId)

    const second = await claimDocumentForIngest(
      driver,
      documentId,
      `${prefix}worker_second`
    )
    expect(second).toBeNull()

    // The losing claim must not have bumped the attempt counter or moved the
    // status — otherwise a hot loop of losers would exhaust MAX_INGEST_ATTEMPTS.
    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.processing)
    expect(state.ingestAttempts).toBe(1)

    await deleteDocuments([documentId])
  })

  it('returns null for a document that does not exist', async () => {
    if (!neo4jReady()) return
    const claimed = await claimDocumentForIngest(
      driver,
      `${prefix}doc_missing`,
      `${prefix}worker_ghost`
    )
    expect(claimed).toBeNull()
  })
})

describe('findPendingDocumentIds', () => {
  let oldest = ''
  let middle = ''
  let newest = ''
  let inDeletedContext = ''
  let processing = ''

  beforeAll(async () => {
    if (!neo4jAvailable) return
    oldest = await createDocument({ key: 'pending_oldest', uploadedMinutesAgo: 300 })
    middle = await createDocument({ key: 'pending_middle', uploadedMinutesAgo: 200 })
    newest = await createDocument({ key: 'pending_newest', uploadedMinutesAgo: 100 })
    inDeletedContext = await createDocument({
      key: 'pending_soft_deleted_ctx',
      uploadedMinutesAgo: 400,
      fieldContextId: ids.deletedFieldContext,
    })
    processing = await createDocument({
      key: 'already_processing',
      uploadedMinutesAgo: 500,
      status: DOCUMENT_INGEST_STATUS.processing,
    })
  })

  afterAll(async () => {
    if (!neo4jAvailable) return
    // Drop the PENDING fixtures immediately — the every-minute worker scans for
    // exactly this shape.
    await deleteDocuments([oldest, middle, newest, inDeletedContext, processing])
  })

  it('returns PENDING documents oldest-upload-first so the queue drains fairly', async () => {
    if (!neo4jReady()) return
    const all = await findPendingDocumentIds(driver, 500)
    const mine = all.filter((id) => id.startsWith(prefix))
    expect(mine).toEqual([oldest, middle, newest])
  })

  it('skips documents whose parent FieldContext is soft-deleted', async () => {
    if (!neo4jReady()) return
    const all = await findPendingDocumentIds(driver, 500)
    // Oldest upload of the whole fixture set, so it would sort first if the
    // `c.deletedAt IS NULL` guard were missing.
    expect(all).not.toContain(inDeletedContext)
  })

  it('never returns a document that is not PENDING', async () => {
    if (!neo4jReady()) return
    const all = await findPendingDocumentIds(driver, 500)
    expect(all).not.toContain(processing)
  })

  it('honours the limit, truncating the same oldest-first ordering', async () => {
    if (!neo4jReady()) return
    // Three PENDING fixtures guarantee the instance has at least two, so a
    // limit of 2 must come back full — and must be the head of the unlimited
    // ordering rather than an arbitrary pair.
    const all = await findPendingDocumentIds(driver, 500)
    const limited = await findPendingDocumentIds(driver, 2)
    expect(limited).toHaveLength(2)
    expect(limited).toEqual(all.slice(0, 2))
  })
})

describe('reclaimStalledIngests', () => {
  let staleUnderCeiling = ''
  let staleAtCeiling = ''
  let freshClaim = ''
  let freshClaimStatusUpdatedAt: string | null = null
  let result: ReclaimResult | null = null

  beforeAll(async () => {
    if (!neo4jAvailable) return
    staleUnderCeiling = await createDocument({
      key: 'stale_retry',
      status: DOCUMENT_INGEST_STATUS.processing,
      statusMinutesAgo: STALE_PROCESSING_MINUTES + 45,
      ingestAttempts: MAX_INGEST_ATTEMPTS - 1,
      ingestClaimedBy: `${prefix}worker_dead`,
    })
    staleAtCeiling = await createDocument({
      key: 'stale_exhausted',
      status: DOCUMENT_INGEST_STATUS.processing,
      statusMinutesAgo: STALE_PROCESSING_MINUTES + 45,
      ingestAttempts: MAX_INGEST_ATTEMPTS,
      ingestClaimedBy: `${prefix}worker_dead`,
    })
    // A claim taken seconds ago — i.e. a live 300s worker run. The 15-minute
    // window exists precisely so this one is never stolen mid-pipeline.
    freshClaim = await createDocument({
      key: 'fresh_claim',
      status: DOCUMENT_INGEST_STATUS.processing,
      statusMinutesAgo: 0,
      ingestAttempts: 1,
      ingestClaimedBy: `${prefix}worker_live`,
    })
    freshClaimStatusUpdatedAt = (await readDocumentState(freshClaim))
      .statusUpdatedAt

    // One sweep, exactly as the cron does it, then assert on the resulting
    // graph state.
    result = await reclaimStalledIngests(driver)
  })

  afterAll(async () => {
    if (!neo4jAvailable) return
    // The requeued fixture is PENDING now — get it out of the worker's sight.
    await deleteDocuments([staleUnderCeiling, staleAtCeiling, freshClaim])
  })

  it('requeues a stale claim below the attempt ceiling back to PENDING', async () => {
    if (!neo4jReady()) return
    const state = await readDocumentState(staleUnderCeiling)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.pending)
    expect(state.statusMessage).toBeNull()
    expect(state.ingestClaimedBy).toBeNull()
    // Reclaiming is not an attempt; the next successful claim is.
    expect(state.ingestAttempts).toBe(MAX_INGEST_ATTEMPTS - 1)
  })

  it('parks a stale claim at the attempt ceiling in FAILED with member-safe copy', async () => {
    if (!neo4jReady()) return
    const state = await readDocumentState(staleAtCeiling)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.failed)
    expect(state.statusMessage).toBe(INGEST_ABANDONED_MESSAGE)
    expect(state.ingestClaimedBy).toBeNull()
  })

  it('leaves a fresh PROCESSING claim untouched', async () => {
    if (!neo4jReady()) return
    const state = await readDocumentState(freshClaim)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.processing)
    expect(state.ingestClaimedBy).toBe(`${prefix}worker_live`)
    expect(state.statusUpdatedAt).toBe(freshClaimStatusUpdatedAt)
  })

  it('reports one requeued and one abandoned document for the sweep', () => {
    if (!neo4jReady()) return
    // Database-wide sweep on a shared instance, so a foreign stalled document
    // may legitimately inflate these — the per-document assertions above are
    // the exact ones.
    expect(result!.requeued).toBeGreaterThanOrEqual(1)
    expect(result!.abandoned).toBeGreaterThanOrEqual(1)
  })
})

describe('markDocumentIngestComplete', () => {
  it('lands COMPLETE with the run counts and clears the claim', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({
      key: 'complete',
      status: DOCUMENT_INGEST_STATUS.processing,
      ingestAttempts: 1,
      ingestClaimedBy: `${prefix}worker_done`,
    })

    await markDocumentIngestComplete({
      driver,
      documentId,
      createdEntityCount: 7,
      failedEntityCount: 2,
    })

    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.complete)
    expect(state.statusMessage).toBeNull()
    expect(state.createdEntityCount).toBe(7)
    expect(state.failedEntityCount).toBe(2)
    // Cleared so a stale breadcrumb can never make a finished document look
    // in-flight to whoever is diagnosing the queue.
    expect(state.ingestClaimedBy).toBeNull()

    await deleteDocuments([documentId])
  })

  it('defaults both counts to zero when the pipeline reports none', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({
      key: 'complete_no_counts',
      status: DOCUMENT_INGEST_STATUS.processing,
      ingestClaimedBy: `${prefix}worker_done`,
    })

    await markDocumentIngestComplete({ driver, documentId })

    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.complete)
    expect(state.createdEntityCount).toBe(0)
    expect(state.failedEntityCount).toBe(0)

    await deleteDocuments([documentId])
  })
})

describe('markDocumentIngestFailed', () => {
  it('lands FAILED with the trimmed member-safe message and clears the claim', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({
      key: 'failed',
      status: DOCUMENT_INGEST_STATUS.processing,
      ingestAttempts: 1,
      ingestClaimedBy: `${prefix}worker_crashed`,
    })

    await markDocumentIngestFailed({
      driver,
      documentId,
      statusMessage: `  ${INGEST_ABANDONED_MESSAGE}  `,
    })

    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.failed)
    expect(state.statusMessage).toBe(INGEST_ABANDONED_MESSAGE)
    expect(state.ingestClaimedBy).toBeNull()
    // The attempt counter survives the failure — that is what the reclaim path
    // reads to decide between another retry and parking the document.
    expect(state.ingestAttempts).toBe(1)

    await deleteDocuments([documentId])
  })

  it('stores null rather than an empty banner when there is no message', async () => {
    if (!neo4jReady()) return
    const documentId = await createDocument({
      key: 'failed_blank_message',
      status: DOCUMENT_INGEST_STATUS.processing,
      ingestClaimedBy: `${prefix}worker_crashed`,
    })

    await markDocumentIngestFailed({
      driver,
      documentId,
      statusMessage: '   ',
    })

    const state = await readDocumentState(documentId)
    expect(state.status).toBe(DOCUMENT_INGEST_STATUS.failed)
    expect(state.statusMessage).toBeNull()

    await deleteDocuments([documentId])
  })
})

describe('loadDocumentRecord — legacy backlog', () => {
  it('reads a Document with no status property back as COMPLETE', async () => {
    if (!neo4jReady()) return
    // Pre-GOAL-292 uploads have no `status` at all. Coalescing to COMPLETE is
    // what keeps the backlog out of the queue and out of the stuck-spinner UI.
    const documentId = await createDocument({ key: 'legacy', status: null })

    const rawStatus = (await readDocumentState(documentId)).status
    expect(rawStatus).toBeNull()

    const record = await loadDocumentRecord(driver, documentId)
    expect(record).not.toBeNull()
    expect(record!.id).toBe(documentId)
    expect(record!.status).toBe(DOCUMENT_INGEST_STATUS.complete)
    expect(record!.fieldContextId).toBe(ids.fieldContext)
    expect(record!.uploaderUserId).toBe(ids.user)

    // A legacy document must also be invisible to the queue scan.
    const pending = await findPendingDocumentIds(driver, 500)
    expect(pending).not.toContain(documentId)

    await deleteDocuments([documentId])
  })
})
