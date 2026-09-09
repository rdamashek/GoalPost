import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'
import { createMemoryBlobStore } from './blob-store'
import { seedAndIngest } from './__test-utils__/handle-ingest-document-helper'
import type { ExtractionModelClient } from './extraction-model-invoker'

/**
 * Integration test for the doc-ingestion route orchestrator. Composes:
 * DocumentStorage → DocumentTextExtractor → FieldContextRoster →
 * ExtractionModelInvoker (mocked) → auto-execute via executeAuthorizedWriteTool
 * → fresh ConversationThread + synthesized assistant turn.
 *
 * Auto-execute (new): the orchestrator runs each proposed tool call inline
 * and stamps the execution result onto the synthesized assistant turn. No
 * HITL approval step. Entities land in the graph during the upload mutation.
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
    // Logs, Documents, Persons, Turns, Threads attached to the test user/context
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
      `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse) DETACH DELETE p`,
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

describe('handleIngestDocument — end-to-end orchestration (Slice 1)', () => {
  itIf(true)('happy path: txt upload → Document node + fresh thread titled "Ingest: <filename>" + synthesized assistant turn', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const modelClient: ExtractionModelClient = async () => ({
      persons: [{ firstName: 'Sarah', lastName: 'Chen' }],
      assistantText: '',
    })

    const result = await seedAndIngest(
      { driver, blobStore, modelClient },
      {
        currentUserId: ids.user,
        fieldContextId: ids.fieldContext,
        filename: 'meeting-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Sarah Chen led the migration.', 'utf8'),
        hint: null,
      }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.documentId.length).toBeGreaterThan(0)
    expect(result.threadId.length).toBeGreaterThan(0)
    // Auto-execute: the proposed tool call ran inline during the upload —
    // result.executedToolCalls reflects what happened, not what's pending.
    expect(result.executedToolCalls).toHaveLength(1)
    expect(result.executedToolCalls[0].tool).toBe('create_person')
    expect(result.executedToolCalls[0].result.success).not.toBe(false)

    const session = driver.session()
    try {
      // Document anchored
      const docRows = await session.run(
        `MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(d:ResourcePulse {id: $docId})-[:UPLOADED_BY]->(u:Person {id: $userId})
         RETURN d.sourceFilename AS filename`,
        { ctxId: ids.fieldContext, docId: result.documentId, userId: ids.user }
      )
      expect(docRows.records).toHaveLength(1)
      expect(docRows.records[0].get('filename')).toBe('meeting-notes.txt')

      // Auto-execute landed the PersonPulse with EXTRACTED_FROM directly —
      // no separate approval step needed.
      const personRows = await session.run(
        `
        MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person:PersonPulse {firstName: 'Sarah', lastName: 'Chen'})
        MATCH (p)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
        RETURN p.id AS personId
        `,
        { ctxId: ids.fieldContext, docId: result.documentId }
      )
      expect(personRows.records).toHaveLength(1)

      // Fresh thread titled "Ingest: <filename>"
      const threadRows = await session.run(
        `MATCH (u:Person {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
         RETURN t.title AS title`,
        { userId: ids.user, threadId: result.threadId }
      )
      expect(threadRows.records).toHaveLength(1)
      expect(threadRows.records[0].get('title')).toBe('Ingest: meeting-notes.txt')

      // Two turns: user (upload summary), assistant (executed trace)
      const turnRows = await session.run(
        `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn)
         RETURN turn.role AS role, turn.content AS content, turn.parts AS parts, turn.order AS order
         ORDER BY turn.order ASC`,
        { threadId: result.threadId }
      )
      expect(turnRows.records).toHaveLength(2)
      expect(turnRows.records[0].get('role')).toBe('user')
      expect(String(turnRows.records[0].get('content'))).toContain('meeting-notes.txt')
      expect(String(turnRows.records[0].get('content'))).not.toMatch(/[a-f0-9-]{36}/)

      expect(turnRows.records[1].get('role')).toBe('assistant')
      const parts = JSON.parse(turnRows.records[1].get('parts') as string) as Array<{
        type: string
        toolCallId?: string
        state?: string
        input?: unknown
        output?: { approvalRequired?: boolean; success?: boolean; personId?: string }
      }>
      // Auto-execute shape: tool-create_person, state output-available, output
      // carries the ToolExecutionResult — NOT approvalRequired.
      const toolPart = parts.find((p) => p.type === 'tool-create_person')
      expect(toolPart).toBeDefined()
      expect(toolPart!.state).toBe('output-available')
      expect(toolPart!.output?.approvalRequired).toBeUndefined()
      expect(toolPart!.output?.success).not.toBe(false)
      // Execution result carries the created entity id.
      expect(typeof toolPart!.output?.personId).toBe('string')
    } finally {
      await session.close()
    }
  })

  itIf(true)('failure path: model error still synthesizes an assistant turn explaining the failure (no pre-staged tool calls)', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const modelClient: ExtractionModelClient = async () => {
      throw new Error('rate limited')
    }

    const result = await seedAndIngest(
      { driver, blobStore, modelClient },
      {
        currentUserId: ids.user,
        fieldContextId: ids.fieldContext,
        filename: 'broken.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('anything'),
        hint: null,
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.executedToolCalls).toHaveLength(0)

    const session = driver.session()
    try {
      // Document still persists
      const docRows = await session.run(
        `MATCH (d:ResourcePulse {id: $docId}) RETURN d.sourceFilename AS filename`,
        { docId: result.documentId }
      )
      expect(docRows.records).toHaveLength(1)

      // Assistant turn carries a failure message, no tool-call parts
      const turnRows = await session.run(
        `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
         RETURN turn.content AS content, turn.parts AS parts`,
        { threadId: result.threadId }
      )
      expect(turnRows.records).toHaveLength(1)
      // The member-facing copy is deliberately generic (b64856b6 —
      // "stop leaking raw extraction errors into member-facing chat"): it names
      // only the filename and a "something went wrong" apology, never the raw
      // provider error. Assert that member-safe failure signal, not internals.
      expect(String(turnRows.records[0].get('content')).toLowerCase()).toMatch(
        /couldn't read|something went wrong/
      )
      const parts = JSON.parse(turnRows.records[0].get('parts') as string) as Array<{ type: string }>
      const toolParts = parts.filter((p) => p.type.startsWith('tool-'))
      expect(toolParts).toHaveLength(0)
    } finally {
      await session.close()
    }
  })

  itIf(true)(
    'empty-result path: extraction returns zero entities → assistant turn carries "didn\'t find anything to extract" prose and no tool-call parts',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        pulses: [],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'silent.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('A short note with no people or actions.', 'utf8'),
          hint: null,
        }
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.executedToolCalls).toHaveLength(0)

      const session = driver.session()
      try {
        // Document persists even though nothing was extracted.
        const docRows = await session.run(
          `MATCH (d:ResourcePulse {id: $docId}) RETURN d.sourceFilename AS filename`,
          { docId: result.documentId }
        )
        expect(docRows.records).toHaveLength(1)

        // Assistant turn lands with the empty-result message and zero
        // tool-call parts — the user's next action is "Re-extract" from the
        // Document list, never a Retry button inside this thread.
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
           RETURN turn.content AS content, turn.parts AS parts`,
          { threadId: result.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        const content = String(turnRows.records[0].get('content')).toLowerCase()
        expect(content).toContain("didn't find anything to extract")
        const parts = JSON.parse(
          turnRows.records[0].get('parts') as string
        ) as Array<{ type: string }>
        const toolParts = parts.filter((p) => p.type.startsWith('tool-'))
        expect(toolParts).toHaveLength(0)
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'persists summary + concepts on the Document when a summarizer is supplied',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        pulses: [],
        assistantText: '',
      })
      const summarizerClient = async () => ({
        summary: 'A planning note about the Q3 migration project.',
        concepts: ['q3 migration', 'team planning', 'cutover risk'],
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient, summarizerClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'summary-test.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Some plan text about Q3.'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (d:ResourcePulse {id: $docId})
           RETURN d.sourceSummary AS summary, d.sourceConcepts AS concepts`,
          { docId: result.documentId }
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('summary')).toBe(
          'A planning note about the Q3 migration project.'
        )
        expect(rows.records[0].get('concepts')).toEqual([
          'q3 migration',
          'team planning',
          'cutover risk',
        ])
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'summarizer failure is non-fatal — the Document still lands with null summary',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [],
        pulses: [],
        assistantText: '',
      })
      const summarizerClient = async () => {
        throw new Error('summarizer rate-limited')
      }

      const result = await seedAndIngest(
        { driver, blobStore, modelClient, summarizerClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'summary-failure.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Text.'),
          hint: null,
        }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      const session = driver.session()
      try {
        const rows = await session.run(
          `MATCH (d:ResourcePulse {id: $docId})
           RETURN d.sourceSummary AS summary, d.sourceConcepts AS concepts`,
          { docId: result.documentId }
        )
        expect(rows.records).toHaveLength(1)
        expect(rows.records[0].get('summary')).toBeNull()
        expect(rows.records[0].get('concepts')).toEqual([])
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)('rejects upload when uploader cannot edit the parent Space', async () => {
    if (!neo4jAvailable) return
    const blobStore = createMemoryBlobStore()
    const modelClient: ExtractionModelClient = async () => ({ persons: [], assistantText: '' })

    const result = await seedAndIngest(
      { driver, blobStore, modelClient },
      {
        currentUserId: `test_outsider_${testRunId}`,
        fieldContextId: ids.fieldContext,
        filename: 'sneaky.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('x'),
        hint: null,
      }
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.toLowerCase()).toMatch(/permission|edit|access|spaces you/i)
  })

  itIf(true)(
    'mixed create/update run: summary line splits created vs updated counts — a roster match is never announced as created (feedback_ada357aa)',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      // Seed a roster person so the extractor's full-name match resolves to
      // update_person instead of create_person.
      const rosterPersonId = `test_roster_${testRunId}`
      const seedSession = driver.session()
      try {
        await seedSession.run(
          `MATCH (c:FieldContext {id: $ctxId})
           CREATE (p:Person:PersonPulse {id: $pid, firstName: 'Priya', lastName: 'Raman', name: 'Priya Raman', createdAt: datetime()})
           CREATE (c)-[:HAS_PERSON]->(p)`,
          { ctxId: ids.fieldContext, pid: rosterPersonId }
        )
      } finally {
        await seedSession.close()
      }

      const modelClient: ExtractionModelClient = async () => ({
        persons: [
          { firstName: 'Priya', lastName: 'Raman' }, // roster match → update
          { firstName: 'Noah', lastName: 'Fields' }, // new → create
        ],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'follow-up-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'Priya Raman synced with Noah Fields about rollout.',
            'utf8'
          ),
          hint: null,
        }
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      const byTool = result.executedToolCalls.reduce<Record<string, number>>(
        (acc, c) => {
          acc[c.tool] = (acc[c.tool] ?? 0) + 1
          return acc
        },
        {}
      )
      expect(byTool.update_person).toBe(1)
      expect(byTool.create_person).toBe(1)
      for (const exec of result.executedToolCalls) {
        expect(exec.result.success).not.toBe(false)
      }

      const session = driver.session()
      try {
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
           RETURN turn.content AS content`,
          { threadId: result.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        const content = String(turnRows.records[0].get('content'))
        // The summary must split creates from updates. Announcing the
        // roster-matched update as "created" sent users hunting the graph
        // for a node that was never minted (feedback_ada357aa).
        expect(content).toContain(
          'Created 1 entity and updated 1 existing entry from this document.'
        )
        expect(content).not.toMatch(/Created 2/)
        // The match sentence reports the update as done, not "proposed" —
        // the ingest pipeline auto-executes.
        expect(content).toContain('you already track: Priya Raman')
        expect(content).toContain('updated that existing entry')
        expect(content).not.toContain('proposed')
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'slice 2 batch — 2 persons + 3 pulses (Goal/Resource/Story) approved together land in the graph with EXTRACTED_FROM; CarePulse is dropped server-side',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      // Cast through unknown to force-feed an out-of-allowlist kind that the
      // Zod schema would normally reject. The CarePulse entry exercises the
      // runtime allowlist filter, not the schema gate.
      const modelClient = (async () => ({
        persons: [
          { firstName: 'Amelia', lastName: 'Stone' },
          { firstName: 'Diego', lastName: 'Rivera' },
        ],
        pulses: [
          {
            kind: 'GoalPulse',
            title: 'Ship the Q3 migration',
            content: 'Move all customer data to the new schema before EOQ.',
            horizon: 'SHORT',
          },
          {
            kind: 'ResourcePulse',
            title: 'Migration credits pool',
            content: 'Shared budget allocated to the migration team.',
            resourceType: 'budget',
          },
          {
            kind: 'StoryPulse',
            title: 'Why we started this',
            content: 'The old system was paging the team weekly.',
          },
          {
            kind: 'CarePulse',
            title: 'Bring soup to Mae',
            content: 'Take soup after surgery.',
          },
        ],
        assistantText: '',
      })) as unknown as ExtractionModelClient

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'planning.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'Amelia Stone and Diego Rivera met about the Q3 migration.',
            'utf8'
          ),
          hint: null,
        }
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      // 2 persons + 3 valid pulses auto-executed; CarePulse dropped server-side.
      expect(result.executedToolCalls).toHaveLength(5)
      const byTool = result.executedToolCalls.reduce<Record<string, number>>(
        (acc, c) => {
          acc[c.tool] = (acc[c.tool] ?? 0) + 1
          return acc
        },
        {}
      )
      expect(byTool.create_person).toBe(2)
      expect(byTool.create_pulse).toBe(3)

      // None of the executed tool calls carry the disallowed pulse type.
      const pulseTypes = result.executedToolCalls
        .filter((c) => c.tool === 'create_pulse')
        .map((c) => c.args.pulseType)
      expect(pulseTypes.sort()).toEqual(['GoalPulse', 'ResourcePulse', 'StoryPulse'])
      expect(pulseTypes).not.toContain('CarePulse')

      // Auto-execute path: every proposed tool call ran inline. No need to
      // simulate Approve — the orchestrator already called executeAuthorizedWriteTool.
      for (const exec of result.executedToolCalls) {
        expect(exec.result.success).not.toBe(false)
      }

      // Graph state: 2 PersonPulse + 3 FieldPulse with correct sub-labels,
      // all with EXTRACTED_FROM edge to the source Document; one Log per
      // entity; no CarePulse anywhere.
      const session = driver.session()
      try {
        const personRows = await session.run(
          `
          MATCH (c:FieldContext {id: $ctxId})-[:HAS_PERSON]->(p:Person:PersonPulse)
          WHERE p.firstName IN ['Amelia', 'Diego']
          MATCH (p)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          RETURN p.firstName AS firstName, p.lastName AS lastName
          ORDER BY p.firstName ASC
          `,
          { ctxId: ids.fieldContext, docId: result.documentId }
        )
        expect(personRows.records).toHaveLength(2)
        expect(personRows.records[0].get('firstName')).toBe('Amelia')
        expect(personRows.records[1].get('firstName')).toBe('Diego')

        const pulseRows = await session.run(
          `
          MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse)
          MATCH (p)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          RETURN p.title AS title, labels(p) AS labels
          ORDER BY p.title ASC
          `,
          { ctxId: ids.fieldContext, docId: result.documentId }
        )
        expect(pulseRows.records).toHaveLength(3)
        const titles = pulseRows.records.map((r) => r.get('title') as string)
        expect(titles).toEqual([
          'Migration credits pool',
          'Ship the Q3 migration',
          'Why we started this',
        ])
        const allLabels = pulseRows.records.flatMap(
          (r) => r.get('labels') as string[]
        )
        expect(allLabels).toEqual(expect.arrayContaining([
          'FieldPulse',
          'GoalPulse',
          'ResourcePulse',
          'StoryPulse',
        ]))
        // CarePulse never lands.
        expect(allLabels).not.toContain('CarePulse')

        // No CarePulse reached the graph even by title.
        const careRows = await session.run(
          `MATCH (p:FieldPulse) WHERE p.title = 'Bring soup to Mae' RETURN p.id AS id`
        )
        expect(careRows.records).toHaveLength(0)

        // One Log per approved entity (5 total) attributed to the uploader.
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:CREATED_BY]->(u:Person {id: $userId})
          WHERE log.description CONTAINS 'Q3 migration'
             OR log.description CONTAINS 'Migration credits pool'
             OR log.description CONTAINS 'Why we started this'
             OR log.description CONTAINS 'Amelia Stone'
             OR log.description CONTAINS 'Diego Rivera'
          RETURN log.description AS description
          `,
          { userId: ids.user }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(5)
        for (const r of logRows.records) {
          const description = String(r.get('description'))
          // Rule 1 — no raw ids and no __typename in activity copy.
          expect(description).not.toContain(ids.fieldContext)
          expect(description).not.toContain(result.documentId)
          expect(description).not.toContain('GoalPulse')
          expect(description).not.toContain('ResourcePulse')
          expect(description).not.toContain('StoryPulse')
        }
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'attribution: pulses with authorName land INITIATED_BY the created person — not the uploader — while the Log stays CREATED_BY the uploader',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Gurindereet', lastName: 'Singh' }],
        pulses: [
          {
            kind: 'GoalPulse',
            title: 'Launch the seed library',
            content: 'Open a community seed library by spring.',
            authorName: 'Gurindereet Singh',
          },
          {
            kind: 'StoryPulse',
            title: 'How the garden began',
            content: 'It started with three neighbours and a shared plot.',
            // Case-insensitive resolution against the extracted person.
            authorName: 'gurindereet singh',
          },
        ],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'garden-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'Gurindereet Singh wrote about the seed library and how the garden began.',
            'utf8'
          ),
          hint: null,
        }
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.executedToolCalls).toHaveLength(3)

      const personExec = result.executedToolCalls.find(
        (c) => c.tool === 'create_person'
      )
      expect(personExec).toBeDefined()
      expect(personExec!.result.success).not.toBe(false)
      const personId = personExec!.result.personId as string
      expect(typeof personId).toBe('string')
      expect(personId).not.toBe(ids.user)

      const pulseExecs = result.executedToolCalls.filter(
        (c) => c.tool === 'create_pulse'
      )
      expect(pulseExecs).toHaveLength(2)
      for (const exec of pulseExecs) {
        expect(exec.result.success).not.toBe(false)
        // The orchestrator resolved the validated author name to the live
        // person id created moments earlier in the same run.
        expect(exec.args.attributedToPersonId).toBe(personId)
        // Execution reports attribution by display name (Rule 1).
        expect(exec.result.attributedTo).toBe('Gurindereet Singh')
      }

      const session = driver.session()
      try {
        const rows = await session.run(
          `
          MATCH (c:FieldContext {id: $ctxId})-[:HAS_PULSE]->(p:FieldPulse)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          MATCH (p)-[:INITIATED_BY]->(author)
          RETURN p.title AS title, author.id AS authorId,
                 size([(p)-[:INITIATED_BY]->() | 1]) AS initiatedByCount
          ORDER BY p.title ASC
          `,
          { ctxId: ids.fieldContext, docId: result.documentId }
        )
        expect(rows.records).toHaveLength(2)
        for (const r of rows.records) {
          // The canonical author edge targets the extracted person, NOT the
          // uploader — this is the captured failure the fix closes.
          expect(r.get('authorId')).toBe(personId)
          expect(r.get('authorId')).not.toBe(ids.user)
          // Exactly one INITIATED_BY per pulse either way.
          expect(Number(r.get('initiatedByCount'))).toBe(1)
        }

        // Audit trail unchanged: every pulse Log is CREATED_BY the uploader
        // and carries the attribution by name only.
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:LOGGED_FOR]->(p:FieldPulse)-[:EXTRACTED_FROM]->(d:ResourcePulse {id: $docId})
          MATCH (log)-[:CREATED_BY]->(creator)
          RETURN creator.id AS creatorId, log.description AS description
          `,
          { docId: result.documentId }
        )
        expect(logRows.records).toHaveLength(2)
        for (const r of logRows.records) {
          expect(r.get('creatorId')).toBe(ids.user)
          const description = String(r.get('description'))
          expect(description).toContain('attributed to Gurindereet Singh')
          // Rule 1 — no raw person id in activity copy.
          expect(description).not.toContain(personId)
        }
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'attribution copy: the synthesized assistant turn reports "attributed to <Name>" with names only — no raw ids',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()
      const modelClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Amara', lastName: 'Okafor' }],
        pulses: [
          {
            kind: 'GoalPulse',
            title: 'Start a repair cafe',
            content: 'Host a monthly fix-it evening at the hall.',
            authorName: 'Amara Okafor',
          },
        ],
        assistantText: '',
      })

      const result = await seedAndIngest(
        { driver, blobStore, modelClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'repair-cafe.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'Amara Okafor proposed a monthly repair cafe.',
            'utf8'
          ),
          hint: null,
        }
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      const session = driver.session()
      try {
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
           RETURN turn.content AS content`,
          { threadId: result.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        const content = String(turnRows.records[0].get('content'))
        // The attribution sentence is built from EXECUTED create_pulse
        // results only — title(s) quoted, author by display name.
        expect(content).toContain(
          '"Start a repair cafe" is attributed to Amara Okafor'
        )
        expect(content).toContain('stay connected to them in the graph')
        // Rule 1 — names only in chat copy: no uuids, no entity-id prefixes,
        // no test fixture ids.
        expect(content).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        )
        expect(content).not.toContain(result.documentId)
        expect(content).not.toContain(ids.fieldContext)
        expect(content).not.toContain(ids.user)
        expect(content).not.toContain('person_')
        expect(content).not.toContain('pulse_')
      } finally {
        await session.close()
      }
    }
  )

  itIf(true)(
    'GOAL-318: a second upload matching an existing pulse (update_pulse) corrects default uploader attribution to the credited author',
    async () => {
      if (!neo4jAvailable) return
      const blobStore = createMemoryBlobStore()

      // Run 1: the document names the person but no author — the pulse lands
      // INITIATED_BY the uploader (default attribution).
      const firstClient: ExtractionModelClient = async () => ({
        persons: [{ firstName: 'Farida', lastName: 'Noor' }],
        pulses: [
          {
            kind: 'GoalPulse',
            title: 'Weave the mutual aid roster',
            content: 'Coordinate the neighbourhood support roster.',
          },
        ],
        assistantText: '',
      })
      const first = await seedAndIngest(
        { driver, blobStore, modelClient: firstClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'roster-v1.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Roster notes mentioning Farida Noor.', 'utf8'),
          hint: null,
        }
      )
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error('unreachable')
      const firstPulseExec = first.executedToolCalls.find(
        (c) => c.tool === 'create_pulse'
      )
      const pulseId = firstPulseExec!.result.pulseId as string
      const personExec = first.executedToolCalls.find(
        (c) => c.tool === 'create_person'
      )
      const faridaId = personExec!.result.personId as string

      // Run 2: a revision of the document carries the byline. The roster now
      // holds both the pulse and Farida, so the model emits update_pulse with
      // the live existingId + a roster-resolvable authorName.
      const secondClient: ExtractionModelClient = async (input) => {
        const rosterPulse = input.roster.pulses.find(
          (p) => p.title === 'Weave the mutual aid roster'
        )
        return {
          persons: [],
          pulses: [
            {
              kind: 'GoalPulse',
              title: 'Weave the mutual aid roster',
              content: 'Coordinate the neighbourhood support roster, weekly.',
              existingId: rosterPulse?.id,
              authorName: 'Farida Noor',
            },
          ],
          assistantText: '',
        }
      }
      const second = await seedAndIngest(
        { driver, blobStore, modelClient: secondClient },
        {
          currentUserId: ids.user,
          fieldContextId: ids.fieldContext,
          filename: 'roster-v2.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('By Farida Noor. Roster notes, revised.', 'utf8'),
          hint: null,
        }
      )
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error('unreachable')

      const updateExec = second.executedToolCalls.find(
        (c) => c.tool === 'update_pulse'
      )
      expect(updateExec).toBeDefined()
      expect(updateExec!.result.success).not.toBe(false)
      // The invoker stamped the roster author's live id on the update args.
      expect(updateExec!.args.attributedToPersonId).toBe(faridaId)
      // Execution reports the corrected attribution by display name (Rule 1).
      expect(updateExec!.result.attributedTo).toBe('Farida Noor')

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
        // Re-pointed: the author edge now targets Farida, not the uploader.
        expect(rows.records[0].get('authorId')).toBe(faridaId)
        expect(Number(rows.records[0].get('initiatedByCount'))).toBe(1)

        // The update Log is CREATED_BY the uploader and names the author.
        const logRows = await session.run(
          `
          MATCH (log:Log)-[:LOGGED_FOR]->(:FieldPulse {id: $pulseId})
          MATCH (log)-[:CREATED_BY]->(creator)
          WHERE log.description CONTAINS 'attributed to Farida Noor'
          RETURN creator.id AS creatorId, log.description AS description
          `,
          { pulseId }
        )
        expect(logRows.records.length).toBeGreaterThanOrEqual(1)
        expect(logRows.records[0].get('creatorId')).toBe(ids.user)
        expect(String(logRows.records[0].get('description'))).not.toContain(
          faridaId
        )

        // The synthesized turn for run 2 reports the corrected attribution.
        const turnRows = await session.run(
          `MATCH (t:ConversationThread {id: $threadId})-[:HAS_TURN]->(turn:ConversationTurn {role: 'assistant'})
           RETURN turn.content AS content`,
          { threadId: second.threadId }
        )
        expect(turnRows.records).toHaveLength(1)
        const content = String(turnRows.records[0].get('content'))
        expect(content).toContain(
          '"Weave the mutual aid roster" is attributed to Farida Noor'
        )
        expect(content).not.toContain(faridaId)
        expect(content).not.toContain(pulseId)
      } finally {
        await session.close()
      }
    }
  )
})
