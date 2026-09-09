import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import {
  appendConversationTurn,
  createConversationThread,
  getConversationThread,
  listConversationThreadsSummary,
} from './conversation-thread.service'
import { seedAndIngest } from '@/lib/ingest/__test-utils__/handle-ingest-document-helper'
import { createMemoryBlobStore } from '@/lib/ingest/blob-store'
import type { ExtractionModelClient } from '@/lib/ingest/extraction-model-invoker'

/**
 * Slice 5 (GOAL-240) — integration tests for the thread-switcher and
 * Standard-mode forcing invariants.
 *
 * Pinned invariants:
 *   1. Every ingest thread is stamped `mode = 'default'` and
 *      `kind = 'ingest'` at creation, regardless of any caller-supplied
 *      mode hint. (Aiden / Braider would otherwise break the synthesized
 *      turn's pre-staged tool-call behaviour.)
 *   2. The reflective (implicit) thread defaults to `mode = 'default'`
 *      and `kind = 'reflective'`.
 *   3. (GOAL-345, replacing the original Slice 5 pin invariant) Nothing pins a
 *      thread as "last viewed". The chat panel opens on an empty conversation
 *      on every initial load, so `createIngestThread` must not stamp
 *      `lastViewedThreadId` — a cron-run ingest would otherwise drop the
 *      member into an "Uploaded ….pdf" thread they never opened. History stays
 *      reachable through `listConversationThreadsSummary`.
 *   4. Threads are User-owned: `getConversationThread` never returns another
 *      member's thread.
 *
 * Skips automatically when no local Neo4j is available so the rest of the
 * suite can still run.
 */

let neo4jAvailable = false
const runId = `slice5_${randomUUID().slice(0, 8)}`
const ids = {
  user: `test_user_${runId}`,
  meSpace: `test_me_${runId}`,
  fieldContext: `test_ctx_${runId}`,
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
      CREATE (u:Person:User {id: $userId, firstName: 'Test', lastName: 'User', name: 'Test User', createdAt: datetime()})
      CREATE (s:Space:MeSpace {id: $spaceId, name: 'Test MeSpace', visibility: 'PRIVATE', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Test Context', createdAt: datetime()})
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
      `MATCH (u:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread)
       OPTIONAL MATCH (t)-[:HAS_TURN]->(turn)
       DETACH DELETE turn, t`,
      { userId: ids.user }
    )
    await session.run(
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_DOCUMENT]->(d:Document) DETACH DELETE d`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person) DETACH DELETE p`,
      { ctxId: ids.fieldContext }
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

describe('GOAL-240 Slice 5 — thread switcher + Standard-mode forcing', () => {
  itIf(true)(
    'ingest thread is stamped mode=default + kind=ingest regardless of the user\'s prior assistant mode',
    async () => {
      if (!neo4jAvailable) return

      // Reflective baseline — the implicit chat thread defaults to default/reflective.
      await appendConversationTurn(ids.user, {
        role: 'user',
        content: 'hi from reflective thread',
      })

      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Layla', lastName: 'Park' }],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Layla Park led the call.', 'utf8'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (u:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
           RETURN t.mode AS mode, t.kind AS kind, t.title AS title, u.lastViewedThreadId AS pin`,
          { userId: ids.user, threadId: result.threadId }
        )
        expect(rows.records).toHaveLength(1)
        const r = rows.records[0]
        expect(r.get('mode')).toBe('default')
        expect(r.get('kind')).toBe('ingest')
        expect(r.get('title')).toBe('Ingest: notes.txt')
        // GOAL-345: ingest must NOT pin the thread. The upload auto-switches
        // in-session via a client event; the next load opens empty.
        expect(r.get('pin')).toBeNull()
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)('reflective threads default to mode=default + kind=reflective', async () => {
    if (!neo4jAvailable) return
    // Ensure the implicit thread exists by appending a turn.
    const { threadId } = await appendConversationTurn(ids.user, {
      role: 'user',
      content: 'reflective check',
    })
    const session = driver.session()
    try {
      const rows = await session.run(
        `MATCH (t:ConversationThread {id: $threadId})
         RETURN t.mode AS mode, t.kind AS kind`,
        { threadId }
      )
      expect(rows.records[0].get('mode')).toBe('default')
      expect(rows.records[0].get('kind')).toBe('reflective')
    } finally {
      await session.close()
    }
  })

  itIf(true)(
    'ingest never pins a thread — a cron-run ingest leaves no lastViewedThreadId, and history stays reachable in the thread list',
    async () => {
      if (!neo4jAvailable) return

      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        assistantText: '',
      })

      // Create an OLDER ingest thread.
      const older = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'older.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('older'),
          hint: null,
        }
      )
      expect(older.ok).toBe(true)
      if (!older.ok) throw new Error('unreachable')

      // Pause briefly so the second thread has a strictly later lastTurnAt.
      await new Promise((r) => setTimeout(r, 25))

      // Create a NEWER ingest thread — this is the "cron ran while the member
      // was away" case that used to hijack the next page load.
      const newer = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'newer.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('newer'),
          hint: null,
        }
      )
      expect(newer.ok).toBe(true)
      if (!newer.ok) throw new Error('unreachable')

      // No pin is left behind by either ingest, so nothing can be restored
      // on top of the empty landing conversation.
      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (u:Person {id: $userId}) RETURN u.lastViewedThreadId AS pin`,
          { userId: ids.user }
        )
        expect(rows.records[0]?.get('pin') ?? null).toBeNull()
      } finally {
        await session.close()
      }

      // Both ingest threads remain one tap away in the switcher, newest first.
      const list = await listConversationThreadsSummary(ids.user)
      const listed = list.map((row) => row.id)
      expect(listed).toContain(older.threadId)
      expect(listed).toContain(newer.threadId)
      expect(listed.indexOf(newer.threadId)).toBeLessThan(
        listed.indexOf(older.threadId)
      )

      // And picking one hydrates its full history.
      const hydrated = await getConversationThread(ids.user, newer.threadId)
      expect(hydrated).not.toBeNull()
      expect(hydrated!.id).toBe(newer.threadId)
    }
  )

  itIf(true)(
    'listConversationThreadsSummary projects mode + kind so the switcher can render the lock badge',
    async () => {
      if (!neo4jAvailable) return
      const list = await listConversationThreadsSummary(ids.user)
      expect(list.length).toBeGreaterThan(0)
      for (const row of list) {
        expect(typeof row.mode).toBe('string')
        expect(['default', 'aiden', 'braider']).toContain(row.mode)
        expect(['reflective', 'ingest']).toContain(row.kind)
      }
      // At least one ingest thread should be present from earlier specs.
      const ingest = list.find((row) => row.kind === 'ingest')
      expect(ingest).toBeDefined()
      expect(ingest!.title?.startsWith('Ingest:')).toBe(true)
    }
  )

  itIf(true)(
    'createConversationThread coexists with the implicit (ownerId-bearing) thread — repeated "+" clicks all succeed',
    async () => {
      if (!neo4jAvailable) return

      // Ensure the implicit thread exists. Before the fix, the UNIQUE
      // constraint on ConversationThread.ownerId made every subsequent
      // createConversationThread call throw.
      await appendConversationTurn(ids.user, {
        role: 'user',
        content: 'seed implicit thread for + button test',
      })
      const session = driver.session()
      try {
        const before = await session.run(
          `MATCH (:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread)
           WHERE t.ownerId IS NOT NULL
           RETURN count(t) AS c`,
          { userId: ids.user }
        )
        expect(before.records[0].get('c').toNumber()).toBe(1)
      } finally {
        await session.close()
      }

      // The "+" button path. The new thread must NOT set ownerId — the
      // ingest thread creator and this creator both rely on ownerId
      // staying unique to the implicit chat thread.
      const { threadId } = await createConversationThread(ids.user)
      expect(typeof threadId).toBe('string')

      const session2 = driver.session()
      try {
        const after = await session2.run(
          `MATCH (:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
           RETURN t.ownerId AS ownerId, t.kind AS kind, t.mode AS mode`,
          { userId: ids.user, threadId }
        )
        expect(after.records).toHaveLength(1)
        expect(after.records[0].get('ownerId')).toBeNull()
        expect(after.records[0].get('kind')).toBe('reflective')
        expect(after.records[0].get('mode')).toBe('default')
      } finally {
        await session2.close()
      }

      // A second "+" click in the same session must also succeed.
      const { threadId: second } = await createConversationThread(ids.user)
      expect(typeof second).toBe('string')
      expect(second).not.toBe(threadId)

      // Both new threads appear in the summary list alongside the implicit one.
      const list = await listConversationThreadsSummary(ids.user)
      const ids2 = new Set(list.map((row) => row.id))
      expect(ids2.has(threadId)).toBe(true)
      expect(ids2.has(second)).toBe(true)
    }
  )

  itIf(true)(
    'getConversationThread never returns another member\u2019s thread (cross-user isolation)',
    async () => {
      if (!neo4jAvailable) return

      const otherUserId = `test_other_${runId}`
      const session = driver.session()
      let otherThreadId = ''
      try {
        await session.run(
          `CREATE (u:Person:User {id: $otherUserId, firstName: 'Other', lastName: 'Member', name: 'Other Member', createdAt: datetime()})`,
          { otherUserId }
        )
        const created = await createConversationThread(otherUserId)
        otherThreadId = created.threadId
        await appendConversationTurn(
          otherUserId,
          { role: 'user', content: 'private to the other member' },
          otherThreadId
        )
      } finally {
        await session.close()
      }

      // The thread exists and its real owner can read it \u2026
      const asOwner = await getConversationThread(otherUserId, otherThreadId)
      expect(asOwner).not.toBeNull()

      // \u2026 but it is invisible to anyone else. Scoping is structural: the
      // Cypher anchors on (:Person:User {id: $userId})-[:HAS_THREAD]->.
      const asStranger = await getConversationThread(ids.user, otherThreadId)
      expect(asStranger).toBeNull()

      // And it never leaks into their thread list.
      const list = await listConversationThreadsSummary(ids.user)
      expect(list.map((row) => row.id)).not.toContain(otherThreadId)

      const cleanup = driver.session()
      try {
        await cleanup.run(
          `MATCH (u:Person {id: $otherUserId})-[:HAS_THREAD]->(t:ConversationThread)
           OPTIONAL MATCH (t)-[:HAS_TURN]->(turn:ConversationTurn)
           DETACH DELETE turn, t, u`,
          { otherUserId }
        )
      } finally {
        await cleanup.close()
      }
    }
  )
})
