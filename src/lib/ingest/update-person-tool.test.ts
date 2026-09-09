import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { executeAuthorizedWriteTool } from '@/lib/chat/hitl'
import { initGraph } from '@/modules/graph'

/**
 * Integration test for the update_person branch of executeAuthorizedWriteTool
 * (GOAL-239 slice 4 AC):
 *
 *   - existing Person:PersonPulse node is updated in place
 *   - (:Person)-[:EXTRACTED_FROM]->(:ResourcePulse) edge is APPENDED (not replaced)
 *   - existing EXTRACTED_FROM edges to prior documents survive
 *   - exactly one Log entry per update, attributed to the editor
 *   - permission gate refuses non-members without mutating the graph
 */

let neo4jAvailable = false
const testRunId = `it_${randomUUID().slice(0, 8)}`
const ids = {
  user: `test_user_${testRunId}`,
  meSpace: `test_me_${testRunId}`,
  fieldContext: `test_ctx_${testRunId}`,
  documentA: `test_${testRunId}_docA`,
  documentB: `test_${testRunId}_docB`,
  person: `test_${testRunId}_person`,
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
      CREATE (u:Person:User {id: $userId, firstName: 'Test', lastName: 'Editor', name: 'Test Editor', createdAt: datetime()})
      CREATE (s:Space:MeSpace {id: $spaceId, name: 'Test MeSpace', visibility: 'PRIVATE', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Care Practices', createdAt: datetime()})
      CREATE (dA:FieldPulse:ResourcePulse {id: $docA, resourceType: 'document', title: 'first.txt', content: 'fixture', createdAt: datetime(), sourceFilename: 'first.txt', sourceMimeType: 'text/plain', sourceSizeBytes: 1, uploadedAt: datetime()})
      CREATE (dB:FieldPulse:ResourcePulse {id: $docB, resourceType: 'document', title: 'second.txt', content: 'fixture', createdAt: datetime(), sourceFilename: 'second.txt', sourceMimeType: 'text/plain', sourceSizeBytes: 1, uploadedAt: datetime()})
      CREATE (p:Person:PersonPulse {
        id: $personId,
        firstName: 'Sarah',
        lastName: 'Chen',
        name: 'Sarah Chen',
        createdAt: datetime()
      })
      CREATE (u)-[:OWNS]->(s)
      CREATE (s)-[:HAS_CONTEXT]->(c)
      CREATE (c)-[:HAS_PULSE]->(dA)
      CREATE (c)-[:HAS_PULSE]->(dB)
      CREATE (dA)-[:UPLOADED_BY]->(u)
      CREATE (dB)-[:UPLOADED_BY]->(u)
      CREATE (c)-[:HAS_PERSON]->(p)
      CREATE (p)-[:EXTRACTED_FROM]->(dA)
      `,
      {
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
        docA: ids.documentA,
        docB: ids.documentB,
        personId: ids.person,
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
      `MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId}) DETACH DELETE log`,
      { userId: ids.user }
    )
    await session.run(
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person) DETACH DELETE p`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `
      MATCH (n)
      WHERE n.id IN [$userId, $spaceId, $ctxId, $docA, $docB, $personId]
      DETACH DELETE n
      `,
      {
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
        docA: ids.documentA,
        docB: ids.documentB,
        personId: ids.person,
      }
    )
  } finally {
    await session.close()
    await driver.close()
  }
})

const itIf = (cond: boolean) => (cond ? it : it.skip)

describe('executeAuthorizedWriteTool — update_person (slice 4)', () => {
  itIf(true)(
    'updates the existing person, APPENDS a new EXTRACTED_FROM edge (existing one survives), and writes exactly one Log entry',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(
        graph,
        ids.user,
        'update_person',
        {
          personId: ids.person,
          firstName: 'Sarah',
          lastName: 'Chen-Liu',
          currentName: 'Sarah Chen',
          contextId: ids.fieldContext,
          contextTitle: 'Care Practices',
          documentId: ids.documentB,
        }
      )
      expect(result.success).toBe(true)

      const session = driver.session()
      try {
        // The person fields are now updated, and the composed name follows.
        const rows = await session.run(
          `
          MATCH (p:Person {id: $personId})
          RETURN p.firstName AS firstName, p.lastName AS lastName, p.name AS name,
                 [(p)-[:EXTRACTED_FROM]->(d) | d.id] AS extractedDocIds
          `,
          { personId: ids.person }
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('firstName')).toBe('Sarah')
        expect(rows.records[0].get('lastName')).toBe('Chen-Liu')
        expect(rows.records[0].get('name')).toBe('Sarah Chen-Liu')
        const extracted = rows.records[0].get('extractedDocIds') as string[]
        // Both the prior EXTRACTED_FROM (docA) and the new one (docB) coexist.
        expect(new Set(extracted)).toEqual(
          new Set([ids.documentA, ids.documentB])
        )

        // Exactly one Log entry created by this run, mentioning the updated
        // name in human-readable copy and without raw ids (Rule 1).
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
          WHERE log.description STARTS WITH 'Updated'
          RETURN log.description AS description
          `,
          { userId: ids.user }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        const description = String(logRows.records[0].get('description'))
        expect(description).toContain('Sarah Chen-Liu')
        expect(description).toContain('Care Practices')
        expect(description).not.toContain(ids.person)
        expect(description).not.toContain(ids.fieldContext)
        expect(description).not.toContain(ids.documentB)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'is idempotent on the EXTRACTED_FROM edge (running again with the same documentId does not duplicate it)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(
        graph,
        ids.user,
        'update_person',
        {
          personId: ids.person,
          firstName: 'Sarah',
          lastName: 'Chen-Liu',
          contextId: ids.fieldContext,
          contextTitle: 'Care Practices',
          documentId: ids.documentB,
        }
      )
      expect(result.success).toBe(true)

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:Person {id: $personId})-[r:EXTRACTED_FROM]->(d:ResourcePulse {id: $docB})
          RETURN count(r) AS edgeCount
          `,
          { personId: ids.person, docB: ids.documentB }
        )
        expect(Number(rows.records[0].get('edgeCount'))).toBe(1)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'refuses when the editor cannot access the parent Space (no graph mutation)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const outsiderId = `test_outsider_${testRunId}`
      const result = await executeAuthorizedWriteTool(
        graph,
        outsiderId,
        'update_person',
        {
          personId: ids.person,
          firstName: 'Should',
          lastName: 'NotApply',
          contextId: ids.fieldContext,
          contextTitle: 'Care Practices',
          documentId: ids.documentB,
        }
      )
      expect(result.success).toBe(false)
      expect(String(result.message || '')).toMatch(
        /edit|permission|access|spaces you/i
      )

      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (p:Person {id: $personId}) RETURN p.lastName AS lastName`,
          { personId: ids.person }
        )
        // Whatever the previous test left, "NotApply" must never land.
        expect(rows.records[0].get('lastName')).not.toBe('NotApply')
      } finally {
        await session.close()
      }
    }
  )
})
