import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { executeAuthorizedWriteTool } from '@/lib/chat/hitl'
import { initGraph } from '@/modules/graph'

/**
 * Integration test for the create_pulse branch of executeAuthorizedWriteTool
 * once it carries the slice-2 doc-ingestion contract:
 *
 *   - new node carries labels ["FieldPulse", "<GoalPulse|ResourcePulse|StoryPulse>"]
 *   - (:FieldContext)-[:HAS_PULSE]->(:FieldPulse)
 *   - (:FieldPulse)-[:EXTRACTED_FROM]->(:ResourcePulse) when documentId is provided
 *   - exactly one Log entry attributed to the uploader (parity with create_person)
 */

let neo4jAvailable = false
const testRunId = `it_${randomUUID().slice(0, 8)}`
const ids = {
  user: `test_user_${testRunId}`,
  meSpace: `test_me_${testRunId}`,
  fieldContext: `test_ctx_${testRunId}`,
  document: `test_${testRunId}_doc`,
  // Attribution fixtures: one PersonPulse attached to the context via
  // HAS_PERSON (valid attribution target) and one deliberately unattached
  // (must fall back to the acting user). The second attached person exercises
  // the GOAL-318 "never steal authorship" gate on the re-attribution paths.
  attachedPerson: `test_attr_${testRunId}`,
  attachedPerson2: `test_attr2_${testRunId}`,
  unattachedPerson: `test_unatt_${testRunId}`,
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
      CREATE (u:Person:User {id: $userId, firstName: 'Test', lastName: 'Uploader', name: 'Test Uploader', createdAt: datetime()})
      CREATE (s:Space:MeSpace {id: $spaceId, name: 'Test MeSpace', visibility: 'PRIVATE', createdAt: datetime()})
      CREATE (c:FieldContext {id: $ctxId, title: 'Care Practices', createdAt: datetime()})
      CREATE (d:FieldPulse:ResourcePulse {resourceType: 'document', title: 'meeting-notes.txt', content: 'fixture', createdAt: datetime(), id: $docId, sourceFilename: 'meeting-notes.txt', mimeType: 'text/plain', sizeBytes: 42, uploadedAt: datetime()})
      CREATE (ap:Person:PersonPulse {id: $attachedPersonId, firstName: 'Nadia', lastName: 'Woods', name: 'Nadia Woods', createdAt: datetime()})
      CREATE (ap2:Person:PersonPulse {id: $attachedPerson2Id, firstName: 'Priya', lastName: 'Raman', name: 'Priya Raman', createdAt: datetime()})
      CREATE (up:Person:PersonPulse {id: $unattachedPersonId, firstName: 'Omar', lastName: 'Haddad', name: 'Omar Haddad', createdAt: datetime()})
      CREATE (u)-[:OWNS]->(s)
      CREATE (s)-[:HAS_CONTEXT]->(c)
      CREATE (c)-[:HAS_PULSE]->(d)
      CREATE (d)-[:UPLOADED_BY]->(u)
      CREATE (c)-[:HAS_PERSON]->(ap)
      CREATE (c)-[:HAS_PERSON]->(ap2)
      `,
      {
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
        docId: ids.document,
        attachedPersonId: ids.attachedPerson,
        attachedPerson2Id: ids.attachedPerson2,
        unattachedPersonId: ids.unattachedPerson,
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
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse) DETACH DELETE p`,
      { ctxId: ids.fieldContext }
    )
    await session.run(
      `
      MATCH (n)
      WHERE n.id IN [$userId, $spaceId, $ctxId, $docId, $attachedPersonId, $attachedPerson2Id, $unattachedPersonId]
      DETACH DELETE n
      `,
      {
        userId: ids.user,
        spaceId: ids.meSpace,
        ctxId: ids.fieldContext,
        docId: ids.document,
        attachedPersonId: ids.attachedPerson,
        attachedPerson2Id: ids.attachedPerson2,
        unattachedPersonId: ids.unattachedPerson,
      }
    )
  } finally {
    await session.close()
    await driver.close()
  }
})

const itIf = (cond: boolean) => (cond ? it : it.skip)

describe('executeAuthorizedWriteTool — create_pulse (slice 2)', () => {
  itIf(true)(
    'creates a GoalPulse with HAS_PULSE, EXTRACTED_FROM, and one Log entry',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'GoalPulse',
        title: 'Ship migration',
        content: 'Cut the data migration over before EOQ.',
        horizon: 'SHORT',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId
      expect(typeof pulseId).toBe('string')

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse {id: $pulseId})
          MATCH (p)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          RETURN labels(p) AS labels, p.title AS title, p.content AS content, p.horizon AS horizon
          `,
          { ctxId: ids.fieldContext, pulseId, docId: ids.document }
        )
        expect(rows.records).toHaveLength(1)
        const labels = rows.records[0].get('labels') as string[]
        expect(labels).toEqual(expect.arrayContaining(['FieldPulse', 'GoalPulse']))
        expect(rows.records[0].get('title')).toBe('Ship migration')
        expect(rows.records[0].get('content')).toBe(
          'Cut the data migration over before EOQ.'
        )
        expect(rows.records[0].get('horizon')).toBe('SHORT')

        const logRows = await session.run(
          `
          MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
          WHERE log.description CONTAINS 'Ship migration'
          RETURN log.id AS id, log.description AS description
          `,
          { userId: ids.user }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        const description = String(logRows.records[0].get('description'))
        expect(description).toContain('Ship migration')
        // Rule 1 — no raw ids leak into the activity feed description
        expect(description).not.toContain(ids.fieldContext)
        expect(description).not.toContain(ids.document)
        // Rule 1 — no __typename like 'GoalPulse' leaks; use human-readable copy
        expect(description).not.toContain('GoalPulse')
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'creates a ResourcePulse with correct sub-label and resourceType',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'ResourcePulse',
        title: 'Shared infra budget',
        content: 'Pool of credits available to the migration team.',
        resourceType: 'budget',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:FieldPulse {id: $pulseId})-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          RETURN labels(p) AS labels, p.resourceType AS resourceType
          `,
          { pulseId, docId: ids.document }
        )
        expect(rows.records).toHaveLength(1)
        const labels = rows.records[0].get('labels') as string[]
        expect(labels).toEqual(
          expect.arrayContaining(['FieldPulse', 'ResourcePulse'])
        )
        expect(rows.records[0].get('resourceType')).toBe('budget')
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'creates a StoryPulse with no documentId (parity with manual creation; no EXTRACTED_FROM edge)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title: 'Manual story entry',
        content: 'Not extracted from any document.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        // no documentId — manual-creation parity
      })
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:FieldPulse {id: $pulseId})
          RETURN labels(p) AS labels,
                 size([(p)-[:EXTRACTED_FROM]->(:ResourcePulse) | 1]) AS extractedFromCount
          `,
          { pulseId }
        )
        expect(rows.records).toHaveLength(1)
        const labels = rows.records[0].get('labels') as string[]
        expect(labels).toEqual(expect.arrayContaining(['FieldPulse', 'StoryPulse']))
        expect(Number(rows.records[0].get('extractedFromCount'))).toBe(0)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'refuses when the user cannot edit the FieldContext (no graph mutation)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const outsiderId = `test_outsider_${testRunId}`
      const result = await executeAuthorizedWriteTool(graph, outsiderId, 'create_pulse', {
        pulseType: 'GoalPulse',
        title: 'Sneaky goal',
        content: 'Should never land in the graph.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(result.success).toBe(false)
      expect(String(result.message || '')).toMatch(
        /edit|permission|access|spaces you/i
      )

      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (p:FieldPulse) WHERE p.title = 'Sneaky goal' RETURN p.id AS id`
        )
        expect(rows.records).toHaveLength(0)
      } finally {
        await session.close()
      }
    }
  )
})

// Doc-ingest attribution: when create_pulse carries attributedToPersonId for
// a person attached (HAS_PERSON) to the SAME FieldContext, the canonical
// (:FieldPulse)-[:INITIATED_BY]->() author edge points at that person instead
// of the acting user — exactly one INITIATED_BY edge either way. The activity
// Log stays CREATED_BY the acting user. An id that is missing, self, or not
// attached to the context falls back silently to the acting user.
describe('executeAuthorizedWriteTool — create_pulse attribution (INITIATED_BY)', () => {
  itIf(true)(
    'points INITIATED_BY at the attributed person attached to the context; Log stays CREATED_BY the acting user',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title: 'Harvest story from the plot',
        content: 'Nadia told the story of the first shared harvest.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson,
        attributedToName: 'Nadia Woods',
      })
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId
      expect(typeof pulseId).toBe('string')
      // Execution result reports the credited author by display name.
      expect((result as { attributedTo?: string | null }).attributedTo).toBe(
        'Nadia Woods'
      )
      expect(String(result.message || '')).toContain('attributed to Nadia Woods')

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:FieldPulse {id: $pulseId})-[:INITIATED_BY]->(author)
          RETURN author.id AS authorId,
                 size([(p)-[:INITIATED_BY]->() | 1]) AS initiatedByCount
          `,
          { pulseId }
        )
        expect(rows.records).toHaveLength(1)
        // The pulse belongs to the attributed person, NOT the acting user.
        expect(rows.records[0].get('authorId')).toBe(ids.attachedPerson)
        expect(rows.records[0].get('authorId')).not.toBe(ids.user)
        // Exactly one canonical author edge.
        expect(Number(rows.records[0].get('initiatedByCount'))).toBe(1)

        // Audit trail unchanged: the Log is CREATED_BY the acting user and
        // its description carries the attribution by name only.
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:LOGGED_FOR]->(p:FieldPulse {id: $pulseId})
          MATCH (log)-[:CREATED_BY]->(creator)
          RETURN creator.id AS creatorId, log.description AS description
          `,
          { pulseId }
        )
        expect(logRows.records).toHaveLength(1)
        expect(logRows.records[0].get('creatorId')).toBe(ids.user)
        const description = String(logRows.records[0].get('description'))
        expect(description).toContain('attributed to Nadia Woods')
        // Rule 1 — no raw person id in activity copy.
        expect(description).not.toContain(ids.attachedPerson)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'falls back to INITIATED_BY the acting user when the attributed person is NOT attached to the context (attributedTo null)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'GoalPulse',
        title: 'Unattached attribution attempt',
        content: 'The claimed author is not part of this field context.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.unattachedPerson,
        attributedToName: 'Omar Haddad',
      })
      // Silent fallback — the write still succeeds, just as the acting user's.
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId
      expect(typeof pulseId).toBe('string')
      expect(
        (result as { attributedTo?: string | null }).attributedTo
      ).toBeNull()
      expect(String(result.message || '')).not.toContain('attributed to')

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:FieldPulse {id: $pulseId})-[:INITIATED_BY]->(author)
          RETURN author.id AS authorId,
                 size([(p)-[:INITIATED_BY]->() | 1]) AS initiatedByCount
          `,
          { pulseId }
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('authorId')).toBe(ids.user)
        expect(Number(rows.records[0].get('initiatedByCount'))).toBe(1)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'self-attribution collapses to plain authorship (INITIATED_BY the acting user, attributedTo null)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()

      const result = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title: 'Self attribution collapses',
        content: 'Attributing a pulse to yourself is just authorship.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        attributedToPersonId: ids.user,
        attributedToName: 'Test Uploader',
      })
      expect(result.success).toBe(true)
      const pulseId = (result as { pulseId?: string }).pulseId
      expect(
        (result as { attributedTo?: string | null }).attributedTo
      ).toBeNull()

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (p:FieldPulse {id: $pulseId})-[:INITIATED_BY]->(author)
          RETURN author.id AS authorId,
                 size([(p)-[:INITIATED_BY]->() | 1]) AS initiatedByCount
          `,
          { pulseId }
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('authorId')).toBe(ids.user)
        expect(Number(rows.records[0].get('initiatedByCount'))).toBe(1)
      } finally {
        await session.close()
      }
    }
  )
})

// GOAL-318 — re-attribution on the ingest update/enrich paths. A re-extract
// (or a second document matching an existing pulse) corrects DEFAULT uploader
// attribution: the write re-points INITIATED_BY at the credited person only
// when the pulse's current author is the acting user or absent — authorship a
// different person already holds is never stolen.
describe('executeAuthorizedWriteTool — ingest re-attribution (GOAL-318)', () => {
  async function readAuthor(pulseId: string) {
    const session = driver.session()
    try {
      const rows = await session.run(
        `
        MATCH (p:FieldPulse {id: $pulseId})-[:INITIATED_BY]->(author)
        RETURN author.id AS authorId,
               size([(p)-[:INITIATED_BY]->() | 1]) AS initiatedByCount
        `,
        { pulseId }
      )
      return rows.records.map((r) => ({
        authorId: r.get('authorId') as string,
        initiatedByCount: Number(r.get('initiatedByCount')),
      }))
    } finally {
      await session.close()
    }
  }

  itIf(true)(
    'create_pulse enrich branch re-points INITIATED_BY from the uploader to the credited author; Log stays CREATED_BY the acting user',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()
      const title = `Re-upload corrects attribution ${testRunId}`

      const first = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title,
        content: 'First upload carried no byline.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(first.success).toBe(true)
      const pulseId = (first as { pulseId?: string }).pulseId as string

      const second = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title,
        content: 'Second upload names the author.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson,
        attributedToName: 'Nadia Woods',
      })
      expect(second.success).toBe(true)
      expect((second as { alreadyExisted?: boolean }).alreadyExisted).toBe(true)
      expect((second as { pulseId?: string }).pulseId).toBe(pulseId)
      expect(
        (second as { attributedTo?: string | null }).attributedTo
      ).toBe('Nadia Woods')
      expect(String(second.message || '')).toContain(
        'attributed to Nadia Woods'
      )

      const authors = await readAuthor(pulseId)
      expect(authors).toHaveLength(1)
      expect(authors[0].authorId).toBe(ids.attachedPerson)
      expect(authors[0].initiatedByCount).toBe(1)

      const session = driver.session()
      try {
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:LOGGED_FOR]->(:FieldPulse {id: $pulseId})
          MATCH (log)-[:CREATED_BY]->(creator)
          WHERE log.description CONTAINS 'attributed to Nadia Woods'
          RETURN creator.id AS creatorId, log.description AS description
          `,
          { pulseId }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        expect(logRows.records[0].get('creatorId')).toBe(ids.user)
        // Rule 1 — no raw person id in activity copy.
        expect(String(logRows.records[0].get('description'))).not.toContain(
          ids.attachedPerson
        )
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'enrich branch never steals authorship a different person already holds (attributedTo null, edge untouched)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()
      const title = `Authorship is never stolen ${testRunId}`

      const first = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title,
        content: 'Nadia authored this one from the start.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson,
        attributedToName: 'Nadia Woods',
      })
      expect(first.success).toBe(true)
      const pulseId = (first as { pulseId?: string }).pulseId as string

      const second = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'StoryPulse',
        title,
        content: 'A later document claims a different author.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson2,
        attributedToName: 'Priya Raman',
      })
      expect(second.success).toBe(true)
      expect((second as { alreadyExisted?: boolean }).alreadyExisted).toBe(true)
      expect(
        (second as { attributedTo?: string | null }).attributedTo
      ).toBeNull()

      const authors = await readAuthor(pulseId)
      expect(authors).toHaveLength(1)
      expect(authors[0].authorId).toBe(ids.attachedPerson)
      expect(authors[0].initiatedByCount).toBe(1)
    }
  )

  itIf(true)(
    'update_pulse re-points INITIATED_BY at the credited author and logs the attribution',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()
      const title = `Update path corrects attribution ${testRunId}`

      const created = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'GoalPulse',
        title,
        content: 'Originally attributed to the uploader by default.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(created.success).toBe(true)
      const pulseId = (created as { pulseId?: string }).pulseId as string

      // Mirror buildUpdatePulseArgs — the shape the ingest orchestrator sends.
      const updated = await executeAuthorizedWriteTool(graph, ids.user, 'update_pulse', {
        pulseId,
        newTitle: title,
        newContent: 'The re-extract read the byline this time.',
        pulseType: 'GoalPulse',
        currentTitle: title,
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson,
        attributedToName: 'Nadia Woods',
      })
      expect(updated.success).toBe(true)
      expect(
        (updated as { attributedTo?: string | null }).attributedTo
      ).toBe('Nadia Woods')

      const authors = await readAuthor(pulseId)
      expect(authors).toHaveLength(1)
      expect(authors[0].authorId).toBe(ids.attachedPerson)
      expect(authors[0].initiatedByCount).toBe(1)

      const session = driver.session()
      try {
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:LOGGED_FOR]->(:FieldPulse {id: $pulseId})
          MATCH (log)-[:CREATED_BY]->(creator)
          WHERE log.description CONTAINS 'attributed to Nadia Woods'
          RETURN creator.id AS creatorId
          `,
          { pulseId }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        expect(logRows.records[0].get('creatorId')).toBe(ids.user)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'update_pulse without attribution args leaves the author edge untouched (interactive chat parity)',
    async () => {
      if (!neo4jAvailable) return
      const graph = await initGraph()
      const title = `Plain update keeps authorship ${testRunId}`

      const created = await executeAuthorizedWriteTool(graph, ids.user, 'create_pulse', {
        pulseType: 'GoalPulse',
        title,
        content: 'Attributed to Nadia from the start.',
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
        attributedToPersonId: ids.attachedPerson,
        attributedToName: 'Nadia Woods',
      })
      expect(created.success).toBe(true)
      const pulseId = (created as { pulseId?: string }).pulseId as string

      const updated = await executeAuthorizedWriteTool(graph, ids.user, 'update_pulse', {
        pulseId,
        newContent: 'A plain edit with no attribution args.',
        pulseType: 'GoalPulse',
        currentTitle: title,
        contextId: ids.fieldContext,
        contextTitle: 'Care Practices',
        documentId: ids.document,
      })
      expect(updated.success).toBe(true)
      expect(
        (updated as { attributedTo?: string | null }).attributedTo
      ).toBeUndefined()

      const authors = await readAuthor(pulseId)
      expect(authors).toHaveLength(1)
      expect(authors[0].authorId).toBe(ids.attachedPerson)
      expect(authors[0].initiatedByCount).toBe(1)
    }
  )
})
