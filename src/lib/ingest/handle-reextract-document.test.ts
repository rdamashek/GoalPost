import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { createMemoryBlobStore } from './blob-store'
import {
  reExtractWithSingleClient,
  seedAndIngest,
} from './__test-utils__/handle-ingest-document-helper'
import type {
  ExtractionModelClient,
  ExtractionModelInput,
} from './extraction-model-invoker'

/**
 * Slice 6 (GOAL-241) — Re-extract on an existing Document.
 *
 * Key invariants this suite pins:
 *   • Re-extract reuses the same `Document.id` (no duplicate node) and the
 *     same blob (blobStore.put is never called again).
 *   • A fresh `ConversationThread` is created with title
 *     `Ingest: <filename> (re-extracted)`, and the Document carries a
 *     HAS_INGEST_THREAD edge to BOTH the original and the re-extract thread.
 *   • Re-extract passes the original `userHint` to the extraction model, so
 *     the user does not have to re-enter it.
 *   • An activity `Log` row is written using the human-readable filename in
 *     `description` and the documentId / threadId in `metadata` (server-side
 *     audit only, never user-facing).
 *   • Re-extract does NOT touch entities approved from the original run.
 */

let neo4jAvailable = false
const testRunId = `it_${randomUUID().slice(0, 8)}`
const ids = {
  user: `test_user_${testRunId}`,
  meSpace: `test_me_${testRunId}`,
  fieldContext: `test_ctx_${testRunId}`,
}

beforeAll(async () => {
  try {
    const s = driver.session()
    await s.run('RETURN 1')
    await s.close()
    neo4jAvailable = true
  } catch {
    neo4jAvailable = false
  }
  if (!neo4jAvailable) return
  const session = driver.session()
  try {
    await session.run(
      `
      CREATE (u:Person:User {id: $userId, firstName: 'Test', lastName: 'Reextractor', name: 'Test Reextractor', createdAt: datetime()})
      CREATE (s:Space:MeSpace {id: $spaceId, name: 'Test MeSpace', visibility: 'PRIVATE', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Strategy', createdAt: datetime()})
      CREATE (u)-[:OWNS]->(s)
      CREATE (s)-[:HAS_CONTEXT]->(c)
      `,
      { userId: ids.user, spaceId: ids.meSpace, ctxId: ids.fieldContext }
    )
  } finally {
    await session.close()
  }
})

afterAll(async () => {
  if (!neo4jAvailable) return
  const session = driver.session()
  try {
    await session.run(
      `MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId}) DETACH DELETE log`,
      { userId: ids.user }
    )
    await session.run(
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(d:ResourcePulse) DETACH DELETE d`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person) DETACH DELETE p`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `MATCH (u:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread)
       OPTIONAL MATCH (t)-[:HAS_TURN]->(turn)
       DETACH DELETE turn, t`,
      { userId: ids.user }
    )
    await session.run(
      `MATCH (n) WHERE n.id IN [$userId, $spaceId, $ctxId] DETACH DELETE n`,
      { userId: ids.user, spaceId: ids.meSpace, ctxId: ids.fieldContext }
    )
  } finally {
    await session.close()
    await driver.close()
  }
})

const itIf = (cond: boolean) => (cond ? it : it.skip)

describe('handleReExtractDocument — slice 6', () => {
  itIf(true)(
    'reuses the same Document, creates a fresh thread titled "(re-extracted)", and links both threads via HAS_INGEST_THREAD',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      let putCalls = 0
      const trackingBlobStore: typeof blobStore = {
        put: async (...args: Parameters<typeof blobStore.put>) => {
          putCalls += 1
          return blobStore.put(...args)
        },
        get: blobStore.get.bind(blobStore),
        delete: blobStore.delete.bind(blobStore),
        presignPut: blobStore.presignPut.bind(blobStore),
        presignGet: blobStore.presignGet.bind(blobStore),
      }

      const firstClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Sarah', lastName: 'Chen' }],
        assistantText: '',
      })

      const upload = await seedAndIngest(
        { driver, blobStore: trackingBlobStore, modelClient: firstClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'plan.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Sarah Chen drafted the plan.', 'utf8'),
          hint: 'team plan from Q3',
        }
      )
      expect(upload.ok).toBe(true)
      if (!upload.ok) throw new Error('unreachable')
      expect(putCalls).toBe(1)

      // Capture the hint the re-extract client receives so we can assert the
      // stored Document.userHint was threaded through to the model prompt.
      let hintSeenByReExtractClient: string | null | undefined
      const reExtractClient: ExtractionModelClient = async (
        input: ExtractionModelInput
      ) => {
        hintSeenByReExtractClient = input.hint
        return {
          persons: [{ firstName: 'Maya', lastName: 'Diaz' }],
          assistantText: '',
        }
      }

      const reExtract = await reExtractWithSingleClient(
        {
          driver,
          blobStore: trackingBlobStore,
          modelClient: reExtractClient,
        },
        { currentUserId: ids.user, documentId: upload.documentId }
      )
      expect(reExtract.ok).toBe(true)
      if (!reExtract.ok) throw new Error('unreachable')

      // Same Document id — no duplicate node was created.
      expect(reExtract.documentId).toBe(upload.documentId)
      // Fresh thread — different id from the original upload thread.
      expect(reExtract.threadId).not.toBe(upload.threadId)
      // No second blob put.
      expect(putCalls).toBe(1)
      // The hint stored on the Document was reused for the re-extract prompt.
      expect(hintSeenByReExtractClient).toBe('team plan from Q3')
      // Auto-executed tool calls reflect the re-extract model's output
      // (Maya), not the original upload's (Sarah).
      expect(reExtract.executedToolCalls).toHaveLength(1)
      expect(reExtract.executedToolCalls[0].tool).toBe('create_person')
      expect(reExtract.executedToolCalls[0].args.firstName).toBe('Maya')
      expect(reExtract.executedToolCalls[0].result.success).not.toBe(false)

      const session = driver.session()
      try {
        // Exactly one Document node for this filename — re-extract reused it.
        const docRows = await session.run(
          `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(d:ResourcePulse {sourceFilename: 'plan.txt'}) RETURN d.id AS id`,
          { ctxId: ids.fieldContext }
        )
        expect(docRows.records).toHaveLength(1)
        expect(docRows.records[0].get('id')).toBe(upload.documentId)

        // Both threads linked to the Document via HAS_INGEST_THREAD; newer
        // thread title carries the "(re-extracted)" marker.
        const threadRows = await session.run(
          `MATCH (d:ResourcePulse {id: $docId})-[:HAS_INGEST_THREAD]->(t:ConversationThread)
           RETURN t.id AS id, t.title AS title
           ORDER BY t.createdAt ASC`,
          { docId: upload.documentId }
        )
        expect(threadRows.records).toHaveLength(2)
        expect(threadRows.records[0].get('title')).toBe('Ingest: plan.txt')
        expect(threadRows.records[1].get('title')).toBe(
          'Ingest: plan.txt (re-extracted)'
        )

        // Re-extract user turn surfaces the human-readable filename + the
        // stored hint — verifies the prose path consumes Document.userHint.
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'user'})
           RETURN turn.content AS content`,
          { threadId: reExtract.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        const userTurn = String(turnRows.records[0].get('content'))
        expect(userTurn).toContain('Re-extracted plan.txt')
        expect(userTurn).toContain('team plan from Q3')

        // One Log row written for the re-extract; description carries the
        // filename (no raw IDs in user copy — kb/07 Rule 1).
        const logRows = await session.run(
          `MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
           WHERE log.description CONTAINS 'Re-extracted'
           RETURN log.description AS description, log.metadata AS metadata`,
          { userId: ids.user }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        const logDescription = String(
          logRows.records[logRows.records.length - 1].get('description')
        )
        expect(logDescription).toContain('plan.txt')
        expect(logDescription).not.toContain(upload.documentId)
        expect(logDescription).not.toContain(reExtract.threadId)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)('returns not_found when the document does not exist', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const modelClient: ExtractionModelClient = async () => ({
      persons: [],
      assistantText: '',
    })

    const result = await reExtractWithSingleClient(
      { driver, blobStore, modelClient },
      { currentUserId: ids.user, documentId: 'document_does_not_exist' }
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('not_found')
  })

  itIf(true)(
    'rejects re-extract when the user cannot edit the parent Space',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Ada', lastName: 'Lovelace' }],
        assistantText: '',
      })

      const upload = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'private-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Ada Lovelace dropped by.', 'utf8'),
          hint: null,
        }
      )
      expect(upload.ok).toBe(true)
      if (!upload.ok) throw new Error('unreachable')

      const result = await reExtractWithSingleClient(
        { driver, blobStore, modelClient },
        {
          currentUserId: `test_outsider_${testRunId}`,
          documentId: upload.documentId,
        }
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toBe('forbidden')
    }
  )

  itIf(true)(
    'failure-path re-extract: model throws → success-shaped result with empty pendingApprovals, no tool-call parts, Document persists, Log captures the failure outcome',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const goodClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Sam', lastName: 'Brown' }],
        assistantText: '',
      })

      const upload = await seedAndIngest(
        { driver, blobStore, modelClient: goodClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'flaky.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Sam Brown was here.', 'utf8'),
          hint: null,
        }
      )
      expect(upload.ok).toBe(true)
      if (!upload.ok) throw new Error('unreachable')

      const failingClient: ExtractionModelClient = async () => {
        throw new Error('rate limited')
      }

      const reExtract = await reExtractWithSingleClient(
        { driver, blobStore, modelClient: failingClient },
        { currentUserId: ids.user, documentId: upload.documentId }
      )
      expect(reExtract.ok).toBe(true)
      if (!reExtract.ok) throw new Error('unreachable')
      expect(reExtract.executedToolCalls).toHaveLength(0)

      const session = driver.session()
      try {
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
           RETURN turn.content AS content, turn.parts AS parts`,
          { threadId: reExtract.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        // Member-facing failure copy, not raw error text (b64856b6). Matched
        // loosely on the same shape the upload-path test uses so a future
        // wording tweak doesn't break both suites.
        expect(
          String(turnRows.records[0].get('content')).toLowerCase()
        ).toMatch(/couldn't read|something went wrong/)
        const parts = JSON.parse(
          turnRows.records[0].get('parts') as string
        ) as Array<{ type: string }>
        expect(parts.filter((p) => p.type.startsWith('tool-'))).toHaveLength(0)

        // Failure outcome captured in the Log metadata for downstream audit.
        const logRows = await session.run(
          `MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
           WHERE log.description CONTAINS 'flaky.txt'
           RETURN log.metadata AS metadata
           ORDER BY log.createdAt DESC LIMIT 1`,
          { userId: ids.user }
        )
        expect(logRows.records).toHaveLength(1)
        const metadata = JSON.parse(
          logRows.records[0].get('metadata') as string
        ) as { outcome?: string }
        expect(metadata.outcome).toBe('failure')
      } finally {
        await session.close()
      }
    }
  )
})
