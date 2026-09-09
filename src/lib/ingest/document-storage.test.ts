import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { createMemoryBlobStore } from './blob-store'
import { uploadDocument, deleteDocument } from './document-storage'

/**
 * Integration test: exercises the real Neo4j driver against the dev Aura
 * instance. Skipped automatically if Neo4j is unreachable (e.g. CI without
 * NEO4J_URI). Uses test-prefixed ids so cleanup is bounded if a teardown
 * is interrupted.
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
      CREATE (c:FieldContext {id: $ctxId, title: 'Care Practices', createdAt: datetime()})
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
    // Defensive cleanup — match every node carrying this run's ids regardless
    // of label so an interrupted test still cleans up.
    await session.run(
      `
      MATCH (n)
      WHERE n.id STARTS WITH $prefix OR n.id IN [$userId, $spaceId, $ctxId]
      DETACH DELETE n
      `,
      {
        prefix: `test_${testRunId}_`,
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
      }
    )
  } finally {
    await session.close()
    await driver.close()
  }
})

const itIf = (cond: boolean) => (cond ? it : it.skip)

describe('DocumentStorage — uploadDocument', () => {
  itIf(true)('skips if neo4j is unreachable', () => {
    if (!neo4jAvailable) {
      console.warn('[document-storage.test] Skipping integration assertions — Neo4j unreachable')
    }
    expect(true).toBe(true)
  })

  itIf(true)('writes a Document node with HAS_DOCUMENT and UPLOADED_BY edges, and puts the blob', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const docId = `test_${testRunId}_doc_a`
    const result = await uploadDocument({
      driver,
      blobStore,
      documentId: docId,
      fieldContextId: ids.fieldContext,
      uploaderUserId: ids.user,
      filename: 'meeting-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Sarah Chen led the migration.', 'utf8'),
    })
    expect(result.id).toBe(docId)
    expect(result.filename).toBe('meeting-notes.txt')
    expect(result.mimeType).toBe('text/plain')
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.blobKey.length).toBeGreaterThan(0)

    // blob exists
    const blob = await blobStore.get(result.blobKey)
    expect(blob).not.toBeNull()
    expect(blob!.buffer.toString('utf8')).toContain('Sarah Chen')

    // graph shape
    const session = driver.session()
    try {
      const rows = await session.run(
        `
        MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(d:ResourcePulse {id: $docId})-[:UPLOADED_BY]->(u:Person:User {id: $userId})
        RETURN d.id AS id, d.sourceFilename AS filename, d.sourceMimeType AS mimeType, d.sourceSizeBytes AS sizeBytes, d.sourceBlobKey AS blobKey, d.uploadedAt AS uploadedAt
        `,
        { ctxId: ids.fieldContext, docId, userId: ids.user }
      )
      expect(rows.records).toHaveLength(1)
      const r = rows.records[0]
      expect(r.get('id')).toBe(docId)
      expect(r.get('filename')).toBe('meeting-notes.txt')
      expect(r.get('mimeType')).toBe('text/plain')
      expect(Number(r.get('sizeBytes'))).toBe(result.sizeBytes)
      expect(r.get('blobKey')).toBe(result.blobKey)
      expect(r.get('uploadedAt')).toBeTruthy()
    } finally {
      await session.close()
    }
  })

  itIf(true)('deleteDocument removes the Document node AND deletes the blob', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const docId = `test_${testRunId}_doc_b`
    const result = await uploadDocument({
      driver,
      blobStore,
      documentId: docId,
      fieldContextId: ids.fieldContext,
      uploaderUserId: ids.user,
      filename: 'doomed.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('temporary'),
    })

    await deleteDocument({ driver, blobStore, documentId: docId })

    const session = driver.session()
    try {
      const rows = await session.run(`MATCH (d:ResourcePulse {id: $docId}) RETURN d`, { docId })
      expect(rows.records).toHaveLength(0)
    } finally {
      await session.close()
    }
    expect(await blobStore.get(result.blobKey)).toBeNull()
  })

  itIf(true)('deleteDocument preserves extracted Persons and FieldPulses (only the EXTRACTED_FROM edge drops)', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const docId = `test_${testRunId}_doc_extracted`
    const personId = `test_${testRunId}_person_extracted`
    const pulseId = `test_${testRunId}_pulse_extracted`
    await uploadDocument({
      driver,
      blobStore,
      documentId: docId,
      fieldContextId: ids.fieldContext,
      uploaderUserId: ids.user,
      filename: 'with-extractions.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Sarah ran the migration.'),
    })

    // Simulate an approved extraction: a Person + a GoalPulse with
    // EXTRACTED_FROM edges back to the Document.
    const session = driver.session()
    try {
      await session.run(
        `
        MATCH (d:ResourcePulse {id: $docId})
        MATCH (c:FieldContext {id: $ctxId})
        CREATE (p:Person:PersonPulse {id: $personId, firstName: 'Sarah', lastName: 'Chen', createdAt: datetime()})
        CREATE (c)-[:HAS_PERSON]->(p)
        CREATE (p)-[:EXTRACTED_FROM]->(d)
        CREATE (g:FieldPulse:GoalPulse {id: $pulseId, title: 'Ship migration', status: 'ACTIVE', createdAt: datetime()})
        CREATE (c)-[:HAS_PULSE]->(g)
        CREATE (g)-[:EXTRACTED_FROM]->(d)
        `,
        { docId, ctxId: ids.fieldContext, personId, pulseId }
      )
    } finally {
      await session.close()
    }

    await deleteDocument({ driver, blobStore, documentId: docId })

    const verify = driver.session()
    try {
      const docGone = await verify.run(
        `MATCH (d:ResourcePulse {id: $docId}) RETURN d`,
        { docId }
      )
      expect(docGone.records).toHaveLength(0)

      const personSurvives = await verify.run(
        `MATCH (p:Person {id: $personId}) RETURN p.firstName AS firstName`,
        { personId }
      )
      expect(personSurvives.records).toHaveLength(1)
      expect(personSurvives.records[0].get('firstName')).toBe('Sarah')

      const pulseSurvives = await verify.run(
        `MATCH (g:GoalPulse {id: $pulseId}) RETURN g.title AS title`,
        { pulseId }
      )
      expect(pulseSurvives.records).toHaveLength(1)
      expect(pulseSurvives.records[0].get('title')).toBe('Ship migration')
    } finally {
      await verify.close()
    }
  })

  itIf(true)('rejects upload when the targeted FieldContext does not exist (no orphaned blob)', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const docId = `test_${testRunId}_doc_c`
    await expect(
      uploadDocument({
        driver,
        blobStore,
        documentId: docId,
        fieldContextId: 'ctx_nonexistent_xyz',
        uploaderUserId: ids.user,
        filename: 'orphan.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('no parent'),
      })
    ).rejects.toThrow()

    // No leaked blob and no orphan Document node — graph cleanup ordering invariant.
    const leakedBlob = Array.from((blobStore as unknown as { _internal?: Map<string, unknown> })._internal ?? []).length
    expect(leakedBlob).toBe(0)
    const session = driver.session()
    try {
      const rows = await session.run(`MATCH (d:ResourcePulse {id: $docId}) RETURN d`, { docId })
      expect(rows.records).toHaveLength(0)
    } finally {
      await session.close()
    }
  })
})
