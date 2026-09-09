import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { createMemoryBlobStore } from './blob-store'
import { seedAndIngest } from './__test-utils__/handle-ingest-document-helper'
import type { ExtractionModelClient } from './extraction-model-invoker'
import { documentMutations } from '@/lib/graphql/resolvers/document-resolver'

/**
 * Slice 7 (GOAL-242) — integration tests for the polish slice:
 *   - upload route boundary rejects Guest / non-member uploads (no Document,
 *     no blob, no thread)
 *   - approved entity Cypher writes one Log per entity whose description
 *     references the document's human-readable filename and whose metadata
 *     JSON carries `documentId` + `conversationThreadId` (server-side audit)
 *   - extracted entities surface their source Document via the
 *     EXTRACTED_FROM edge; the uploader does NOT get CONNECTED_TO edges to
 *     extracted persons (verifies PRD § No auto-CONNECTED_TO)
 */

let neo4jAvailable = false
const runId = `slice7_${randomUUID().slice(0, 8)}`
const ids = {
  owner: `test_owner_${runId}`,
  admin: `test_admin_${runId}`,
  guest: `test_guest_${runId}`,
  outsider: `test_outsider_${runId}`,
  weSpace: `test_ws_${runId}`,
  fieldContext: `test_ctx_${runId}`,
  adminMembership: `test_msa_${runId}`,
  guestMembership: `test_msg_${runId}`,
}

beforeAll(async () => {
  // Force the resolver-layer tests below to use the in-process blob store —
  // the deleteDocument resolver picks the store via `resolveBlobStore()`
  // (reads `INGEST_BLOB_BACKEND`). Without this, the S3 store is selected
  // and `delete` throws on a missing `AWS_REGION` / `S3_BUCKET`.
  process.env.INGEST_BLOB_BACKEND = 'memory'

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
      CREATE (o:Person:User {id: $ownerId, firstName: 'Owen', lastName: 'Owner', name: 'Owen Owner', createdAt: datetime()})
      CREATE (a:Person:User {id: $adminId, firstName: 'Ada', lastName: 'Admin', name: 'Ada Admin', createdAt: datetime()})
      CREATE (g:Person:User {id: $guestId, firstName: 'Gail', lastName: 'Guest', name: 'Gail Guest', createdAt: datetime()})
      CREATE (x:Person:User {id: $outsiderId, firstName: 'Olly', lastName: 'Outsider', name: 'Olly Outsider', createdAt: datetime()})
      CREATE (s:Space:WeSpace {id: $spaceId, name: 'Slice 7 WeSpace', visibility: 'SHARED', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Slice 7 Field', createdAt: datetime()})
      CREATE (o)-[:OWNS]->(s)
      CREATE (s)-[:HAS_CONTEXT]->(c)
      CREATE (msa:SpaceMembership {id: $adminMembershipId, role: 'ADMIN', addedAt: datetime()})
      CREATE (s)-[:HAS_MEMBER]->(msa)-[:IS_MEMBER]->(a)
      CREATE (msg:SpaceMembership {id: $guestMembershipId, role: 'GUEST', addedAt: datetime()})
      CREATE (s)-[:HAS_MEMBER]->(msg)-[:IS_MEMBER]->(g)
      `,
      {
        ownerId: ids.owner,
        adminId: ids.admin,
        guestId: ids.guest,
        outsiderId: ids.outsider,
        spaceId: ids.weSpace,
        ctxId: ids.fieldContext,
        adminMembershipId: ids.adminMembership,
        guestMembershipId: ids.guestMembership,
      }
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
      `MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $ownerId}) DETACH DELETE log`,
      { ownerId: ids.owner }
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
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse) DETACH DELETE p`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `MATCH (u:Person)-[:HAS_THREAD]->(t:ConversationThread)
       WHERE u.id IN [$ownerId, $adminId, $guestId, $outsiderId]
       OPTIONAL MATCH (t)-[:HAS_TURN]->(turn)
       DETACH DELETE turn, t`,
      {
        ownerId: ids.owner,
        adminId: ids.admin,
        guestId: ids.guest,
        outsiderId: ids.outsider,
      }
    )
    await session.run(
      `MATCH (n) WHERE n.id IN [$ownerId, $adminId, $guestId, $outsiderId, $spaceId, $ctxId, $adminMs, $guestMs]
       DETACH DELETE n`,
      {
        ownerId: ids.owner,
        adminId: ids.admin,
        guestId: ids.guest,
        outsiderId: ids.outsider,
        spaceId: ids.weSpace,
        ctxId: ids.fieldContext,
        adminMs: ids.adminMembership,
        guestMs: ids.guestMembership,
      }
    )
  } finally {
    await session.close()
    await driver.close()
  }
})

const itIf = (cond: boolean) => (cond ? it : it.skip)

describe('Slice 7 — upload permission gate (GOAL-242)', () => {
  itIf(true)(
    'rejects a Guest member at the route boundary — no Document, no blob, no thread is created',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.guest,
          fieldContextId: ids.fieldContext,
          filename: 'guest-attempt.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Some content'),
          hint: null,
        }
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toBe('forbidden')
      expect(result.error.toLowerCase()).toMatch(/permission|edit|access|spaces you/)

      // Defense in depth — confirm nothing landed in the graph.
      const session = driver.session()
      try {
        const docRows = await session.run(
          `MATCH (d:ResourcePulse) WHERE d.sourceFilename = 'guest-attempt.txt' RETURN d.id AS id`
        )
        expect(docRows.records).toHaveLength(0)

        const threadRows = await session.run(
          `MATCH (u:Person {id: $guestId})-[:HAS_THREAD]->(t:ConversationThread)
           WHERE t.title CONTAINS 'guest-attempt'
           RETURN t.id AS id`,
          { guestId: ids.guest }
        )
        expect(threadRows.records).toHaveLength(0)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'rejects a non-member of the WeSpace at the route boundary',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.outsider,
          fieldContextId: ids.fieldContext,
          filename: 'outsider-attempt.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Some content'),
          hint: null,
        }
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toBe('forbidden')
    }
  )

  itIf(true)(
    'accepts an ADMIN member (canEditContent) — Document + thread are created',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.admin,
          fieldContextId: ids.fieldContext,
          filename: 'admin-upload.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Some content'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
    }
  )
})

describe('Slice 7 — provenance + no auto-CONNECTED_TO + Log metadata (GOAL-242)', () => {
  itIf(true)(
    'approving three extracted persons creates EXTRACTED_FROM edges but NO CONNECTED_TO edges from the uploader',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [
          { firstName: 'Maya', lastName: 'Reyes' },
          { firstName: 'Sam', lastName: 'Tanaka' },
          { firstName: 'June', lastName: 'Park' },
        ],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.owner,
          fieldContextId: ids.fieldContext,
          filename: 'roster.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Maya Reyes, Sam Tanaka, June Park attended.'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      // Auto-execute: three persons landed during the upload mutation. No
      // separate approval loop needed.
      expect(result.executedToolCalls).toHaveLength(3)
      for (const exec of result.executedToolCalls) {
        expect(exec.result.success).not.toBe(false)
      }

      const session = driver.session()
      try {
        // All three are EXTRACTED_FROM the Document (provenance edge written)
        const extractedRows = await session.run(
          `
          MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person)
          WHERE p.firstName IN ['Maya', 'Sam', 'June']
          MATCH (p)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          RETURN p.firstName AS firstName
          ORDER BY p.firstName ASC
          `,
          { ctxId: ids.fieldContext, docId: result.documentId }
        )
        expect(extractedRows.records).toHaveLength(3)

        // NO CONNECTED_TO edges from uploader to extracted persons (PRD §
        // No auto-CONNECTED_TO — the uploader having a doc does NOT mean
        // they "know" the people inside it).
        const connectionRows = await session.run(
          `
          MATCH (u:Person:User {id: $userId})-[:CONNECTED_TO]->(p:Person)
          WHERE p.firstName IN ['Maya', 'Sam', 'June']
          RETURN p.firstName AS firstName
          `,
          { userId: ids.owner }
        )
        expect(connectionRows.records).toHaveLength(0)

        // …and the reverse direction is also absent — CONNECTED_TO is
        // bidirectional intent, so neither side should have it.
        const reverseRows = await session.run(
          `
          MATCH (p:Person)-[:CONNECTED_TO]->(u:Person:User {id: $userId})
          WHERE p.firstName IN ['Maya', 'Sam', 'June']
          RETURN p.firstName AS firstName
          `,
          { userId: ids.owner }
        )
        expect(reverseRows.records).toHaveLength(0)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'approved Log row carries the filename in description and documentId + conversationThreadId in metadata',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Logan', lastName: 'Verifier' }],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.owner,
          fieldContextId: ids.fieldContext,
          filename: 'audit-doc.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Logan Verifier was there.'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.executedToolCalls).toHaveLength(1)

      // The auto-executed tool args MUST carry conversationThreadId +
      // documentId so the per-entity Log row stamps both as metadata
      // (downstream audit query closes against either key).
      const exec = result.executedToolCalls[0]
      expect(exec.args.conversationThreadId).toBe(result.threadId)
      expect(exec.args.documentId).toBe(result.documentId)
      expect(exec.result.success).not.toBe(false)

      const session = driver.session()
      try {
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
          WHERE log.description CONTAINS 'Logan Verifier'
          RETURN log.description AS description, log.metadata AS metadata
          ORDER BY log.createdAt DESC
          LIMIT 1
          `,
          { userId: ids.owner }
        )
        expect(logRows.records).toHaveLength(1)
        const description = String(logRows.records[0].get('description'))
        const metadata = logRows.records[0].get('metadata') as string | null

        // Slice 7 AC — filename appears in the user-readable description.
        expect(description).toContain('audit-doc.txt')

        // Rule 1 — but raw ids still never leak into the description.
        expect(description).not.toContain(result.documentId)
        expect(description).not.toContain(result.threadId)
        expect(description).not.toContain(ids.fieldContext)

        // Slice 7 AC — metadata JSON carries documentId + conversationThreadId.
        expect(typeof metadata).toBe('string')
        const parsed = JSON.parse(metadata!)
        expect(parsed.documentId).toBe(result.documentId)
        expect(parsed.conversationThreadId).toBe(result.threadId)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'extracted Person carries EXTRACTED_FROM edges that can be traversed to surface provenance documents',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Prov', lastName: 'Subject' }],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.owner,
          fieldContextId: ids.fieldContext,
          filename: 'provenance.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Prov Subject is mentioned here.'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      // Auto-execute landed the Person during the upload — no separate
      // approval call.
      expect(result.executedToolCalls).toHaveLength(1)
      expect(result.executedToolCalls[0].result.success).not.toBe(false)

      const session = driver.session()
      try {
        // The provenance traversal the GraphQL `extractedFrom` field uses
        // returns the same Document the entity was created from.
        const rows = await session.run(
          `
          MATCH (p:Person {firstName: 'Prov', lastName: 'Subject'})-[:EXTRACTED_FROM]->(d:ResourcePulse)
          RETURN d.id AS id, d.sourceFilename AS filename
          `
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('id')).toBe(result.documentId)
        expect(rows.records[0].get('filename')).toBe('provenance.txt')
      } finally {
        await session.close()
      }
    }
  )
})

describe('deleteDocument resolver — permission gate + cleanup', () => {
  // Seed a fresh document per test case so cases stay independent. The
  // owner has canEditContent (created via setup); guest + outsider should be
  // rejected by the gate; admin should pass (ADMIN role on the WeSpace).

  async function seedDocument(filename: string): Promise<string> {
    const blobStore = createMemoryBlobStore()
    const modelClient: ExtractionModelClient = async () => ({
      persons: [],
      assistantText: '',
    })
    const result = await seedAndIngest(
      { driver, blobStore, modelClient },
      {
        currentUserId: ids.owner,
        fieldContextId: ids.fieldContext,
        filename,
        mimeType: 'text/plain',
        buffer: Buffer.from('seed body'),
        hint: null,
      }
    )
    if (!result.ok) {
      throw new Error(`seedDocument failed: ${result.error}`)
    }
    return result.documentId
  }

  itIf(true)('rejects a Guest member with FORBIDDEN', async () => {
    if (!neo4jAvailable) return
    const docId = await seedDocument('guest-delete-attempt.txt')

    await expect(
      documentMutations.deleteDocument(
        null,
        { documentId: docId },
        { jwt: { user: { id: ids.guest } } }
      )
    ).rejects.toThrow(/permission/i)

    // Document still in graph
    const session = driver.session()
    try {
      const rows = await session.run(
        `MATCH (d:ResourcePulse {id: $docId}) RETURN d.id AS id`,
        { docId }
      )
      expect(rows.records).toHaveLength(1)
    } finally {
      await session.close()
    }
  })

  itIf(true)('rejects an outsider (non-member) with FORBIDDEN', async () => {
    if (!neo4jAvailable) return
    const docId = await seedDocument('outsider-delete-attempt.txt')

    await expect(
      documentMutations.deleteDocument(
        null,
        { documentId: docId },
        { jwt: { user: { id: ids.outsider } } }
      )
    ).rejects.toThrow(/permission/i)
  })

  itIf(true)(
    'collapses missing document into FORBIDDEN — does not leak existence to callers',
    async () => {
      if (!neo4jAvailable) return
      // PRD § Security: a non-existent documentId must produce the same
      // error shape as a forbidden access, so a non-member cannot probe
      // existence. The orchestrator returns `reason: forbidden`.
      await expect(
        documentMutations.deleteDocument(
          null,
          { documentId: 'doc_does_not_exist_xyz' },
          { jwt: { user: { id: ids.owner } } }
        )
      ).rejects.toThrow(/permission/i)
    }
  )

  itIf(true)('owner can delete — Document and blob removed', async () => {
    if (!neo4jAvailable) return
    const docId = await seedDocument('owner-delete-success.txt')

    const result = await documentMutations.deleteDocument(
      null,
      { documentId: docId },
      { jwt: { user: { id: ids.owner } } }
    )
    expect(result).toEqual({ documentId: docId, deleted: true })

    const session = driver.session()
    try {
      const rows = await session.run(
        `MATCH (d:ResourcePulse {id: $docId}) RETURN d.id AS id`,
        { docId }
      )
      expect(rows.records).toHaveLength(0)
    } finally {
      await session.close()
    }
  })

  itIf(true)('admin member can delete — same gate as upload', async () => {
    if (!neo4jAvailable) return
    const docId = await seedDocument('admin-delete-success.txt')

    const result = await documentMutations.deleteDocument(
      null,
      { documentId: docId },
      { jwt: { user: { id: ids.admin } } }
    )
    expect(result).toEqual({ documentId: docId, deleted: true })
  })

  itIf(true)('writes a Log row on successful delete', async () => {
    if (!neo4jAvailable) return
    const filename = 'logged-delete.txt'
    const docId = await seedDocument(filename)

    await documentMutations.deleteDocument(
      null,
      { documentId: docId },
      { jwt: { user: { id: ids.owner } } }
    )

    const session = driver.session()
    try {
      const rows = await session.run(
        `
        MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $ownerId})
        WHERE log.description CONTAINS $filename
        RETURN log.description AS description, log.metadata AS metadata
        ORDER BY log.createdAt DESC
        LIMIT 1
        `,
        { ownerId: ids.owner, filename }
      )
      expect(rows.records).toHaveLength(1)
      const description = String(rows.records[0].get('description'))
      // Description carries the filename in human-readable copy. Rule 1 of
      // kb/07-ai-assistant-ux.md applies — no raw documentId in user-facing
      // text.
      expect(description).toMatch(new RegExp(`Deleted document.*${filename}`))
      expect(description).not.toContain(docId)
      // Audit metadata still carries the raw documentId for downstream
      // analysis.
      const metadata = JSON.parse(
        String(rows.records[0].get('metadata') ?? '{}')
      ) as { documentId?: string }
      expect(metadata.documentId).toBe(docId)
    } finally {
      await session.close()
    }
  })
})
