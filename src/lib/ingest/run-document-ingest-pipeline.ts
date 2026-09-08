import { randomUUID } from 'node:crypto'
import type { Driver } from 'neo4j-driver'
import type { BlobStore } from './blob-store'
import {
  loadDocumentRecord,
  setDocumentPageCount,
  setDocumentSummary,
  type DocumentRecord,
} from './document-storage'
import { prepareExtractionInputs } from './extraction-input-preparer'
import { loadFieldContextRoster } from './field-context-roster'
import {
  extractEntities,
  type ExtractionModelClient,
  type ExtractionResult,
} from './extraction-model-invoker'
import {
  summarizeDocument,
  type DocumentSummarizerClient,
} from './document-summarizer'
import type {
  ExecutedToolCallRecord,
  ExecutedToolResult,
  SynthesizedToolCall,
} from './synthesized-turn-appender'
import { buildExecutedAssistantTurnParts } from './synthesized-turn-appender'
import { appendConversationTurn } from '@/lib/simulation/conversation-thread.service'
import { executeAuthorizedWriteTool } from '@/lib/chat/hitl'
import { initGraph } from '@/modules/graph'

/**
 * The heavy half of document ingestion, against an already-anchored Document:
 * prepare inputs → extract entities + summarize → persist summary → open an
 * ingest thread → auto-execute the proposed writes.
 *
 * GOAL-292 pulled this out of `handleIngestDocument` so three callers can share
 * one implementation:
 *
 *   - `/api/cron/process-document-ingestion` — the background worker, which is
 *     now the only path the browser upload takes.
 *   - `handleReExtractDocument` — a fresh pass against the current roster.
 *   - `handleIngestDocument` — the synchronous compose-both entry point, kept
 *     for the server-side upload path and integration tests.
 *
 * Everything here is keyed off the Document node, so the pipeline needs no
 * request context and can run under CRON_SECRET on behalf of a persisted
 * uploader. It deliberately re-runs `prepareExtractionInputs` on every attempt
 * rather than carrying prepared inputs across the queue boundary: the
 * multimodal route's presigned URL is short-lived (15 min), and re-deriving
 * from the stored `blobKey` keeps a retry hours later just as valid as the
 * first try — the same reasoning re-extract has always relied on.
 */

export interface DocumentIngestPipelineDependencies {
  driver: Driver
  blobStore: BlobStore
  /**
   * Multimodal extractor (Gemini) used for the `multimodal` route — PDFs and
   * images. Reads the file by presigned URL.
   */
  pdfExtractionClient: ExtractionModelClient
  /**
   * Text extractor (OpenAI) used for the `text` and `office` routes. Reads the
   * document body that was decoded (text) or extracted in-process (office).
   */
  textExtractionClient: ExtractionModelClient
  /**
   * Optional summarizers — one per modality. Failure is non-fatal.
   * Tests can omit both to keep the entity-extraction surface in isolation.
   */
  pdfSummarizerClient?: DocumentSummarizerClient | null
  textSummarizerClient?: DocumentSummarizerClient | null
}

/**
 * Creates a fresh ConversationThread for this ingest run, plus a
 * HAS_INGEST_THREAD edge from the source Document so slice 6's Document
 * detail view can list every thread the document has been processed in.
 * Both the original upload and every subsequent re-extract land here.
 *
 * Slice 5 (GOAL-240) — write-time invariant: every ingest thread is born with
 * `kind = 'ingest'` and `mode = 'default'`. Aiden / Braider are non-action
 * modes, so they cannot drive the tool calls the synthesized turn already
 * pre-staged. Forcing `default` at creation guarantees subsequent replies in
 * the thread route through the standard tool-execution path regardless of
 * the user's prior global mode.
 *
 * GOAL-345 — this deliberately does NOT pin the thread as "last viewed". The
 * cron worker runs ingests while the member is away, and stamping a pin here
 * meant every subsequent load dropped them into an "Uploaded ….pdf" thread
 * they never opened. The in-session auto-switch after an upload (kb/03 WF-10
 * step 7) is a client-side event and is unaffected; on the next load the panel
 * opens empty and this thread is simply first in the switcher.
 */
export async function createIngestThread(
  driver: Driver,
  userId: string,
  documentId: string,
  title: string
): Promise<string> {
  const threadId = `thread_${randomUUID()}`
  const session = driver.session()
  try {
    await session.executeWrite(async (tx) =>
      tx.run(
        `
        MATCH (p:Person:User {id: $userId})
        MATCH (d:Document {id: $documentId})
        CREATE (p)-[:HAS_THREAD]->(t:ConversationThread {
          id: $threadId,
          createdAt: datetime(),
          lastTurnAt: datetime(),
          turnCount: 0,
          title: $title,
          mode: 'default',
          kind: 'ingest'
        })
        CREATE (d)-[:HAS_INGEST_THREAD]->(t)
        `,
        { userId, documentId, threadId, title }
      )
    )
  } finally {
    await session.close()
  }
  return threadId
}

/**
 * Auto-executes the proposed tool calls server-side and writes both turns
 * of the synthesized assistant trace into a thread the caller has already
 * created. Shared between the initial upload path and the re-extract path
 * so the turn shape (user "Uploaded X" / "Re-extracted X" + executed
 * assistant parts) stays identical across both surfaces.
 *
 * Auto-approve rationale (see PRD § revised flow): doc ingestion historically
 * pre-staged HITL tool calls and waited for the user to click Approve. That
 * left "I uploaded a document but no pulses appeared" as the most common
 * failure mode — the work was done but invisible. The upload itself already
 * gates on `canEditContent`, so re-asking for approval was a UX wall, not a
 * second security layer. Auto-execute closes the loop while keeping the
 * audit trail (one `:Log` per created entity, written inline by the same
 * `executeAuthorizedWriteTool` path manual creation uses).
 *
 * That audit trail is why the background worker calls straight into this
 * function rather than re-implementing the writes (GOAL-292): moving ingestion
 * to a cron must not drop a single `:Log` row.
 *
 * Each tool call's args are still enriched with `conversationThreadId` so
 * the Log row's metadata can carry both `documentId` and the originating
 * thread — closing the audit loop end-to-end.
 */
export async function appendSynthesizedIngestTurns(
  userId: string,
  threadId: string,
  userTurnContent: string,
  extraction: ExtractionResult
): Promise<ExecutedToolCallRecord[]> {
  await appendConversationTurn(
    userId,
    {
      role: 'user',
      content: userTurnContent,
      parts: [{ type: 'text', text: userTurnContent }],
    },
    threadId
  )

  const toolCalls: SynthesizedToolCall[] =
    extraction.kind === 'ok'
      ? extraction.toolCalls.map((call) => ({
          ...call,
          args: { ...call.args, conversationThreadId: threadId },
        }))
      : []

  // Execute each proposed tool call against the live graph. A failure on
  // one entity does not abort the rest — partial success is recorded in
  // the assistant turn so the user can see which entities landed and
  // which need manual follow-up.
  //
  // Attribution wiring: roster-matched authors already ride in with their
  // live id stamped by the invoker (they may get no person call this run).
  // For persons minted or enriched THIS run, the invoker orders person calls
  // before pulse calls, and the name→id map below closes the loop from their
  // executed results. A failed person call (with no roster id to fall back
  // on) simply leaves the pulse attributed to the uploader.
  const executed: ExecutedToolCallRecord[] = []
  const personIdByName = new Map<string, string>()
  // GOAL-298: name→id for extracted organizations, and (pulseType|title)→id for
  // created/updated pulses. Both are populated as create_*/update_* results
  // land, so the trailing link_entity_to_pulse calls (emitted last by the
  // invoker) can resolve their MENTIONED_IN endpoints by name/title.
  const orgIdByName = new Map<string, string>()
  const pulseIdByKey = new Map<string, string>()
  const registerPulseId = (
    args: Record<string, unknown>,
    result: ExecutedToolResult
  ): void => {
    const pulseId =
      typeof result.pulseId === 'string' && result.pulseId
        ? result.pulseId
        : typeof (result.pulse as { id?: string } | undefined)?.id === 'string'
          ? (result.pulse as { id?: string }).id!
          : ''
    if (!pulseId) return
    const pulseType = String(args.pulseType ?? result.pulseType ?? '')
    const titles = [
      typeof result.title === 'string' ? result.title : '',
      String(args.title ?? ''),
      String(args.newTitle ?? ''),
      String(args.currentTitle ?? ''),
    ]
    for (const t of titles) {
      const title = t.trim().toLowerCase()
      if (!title) continue
      pulseIdByKey.set(`${pulseType}|${title}`, pulseId)
      // Keyless fallback so a link whose pulseType drifted still resolves.
      if (!pulseIdByKey.has(title)) pulseIdByKey.set(title, pulseId)
    }
  }
  if (toolCalls.length > 0) {
    const graph = await initGraph()
    for (const call of toolCalls) {
      let args = call.args
      if (call.tool === 'create_pulse' || call.tool === 'update_pulse') {
        const attributedToName =
          typeof args.attributedToName === 'string'
            ? args.attributedToName.trim().toLowerCase()
            : ''
        const attributedToPersonId = attributedToName
          ? personIdByName.get(attributedToName)
          : undefined
        if (attributedToPersonId) {
          args = { ...args, attributedToPersonId }
        }
      } else if (call.tool === 'link_entity_to_pulse') {
        // Resolve the MENTIONED_IN endpoints by name/title from entities that
        // executed earlier this run. Any id the invoker already knew (a roster
        // match) is preserved.
        const next = { ...args }
        const entityKey =
          typeof next.entityName === 'string'
            ? next.entityName.trim().toLowerCase()
            : ''
        if (next.entityType === 'organization') {
          if (!next.organizationId && entityKey) {
            const id = orgIdByName.get(entityKey)
            if (id) next.organizationId = id
          }
        } else if (!next.personId && entityKey) {
          const id = personIdByName.get(entityKey)
          if (id) next.personId = id
        }
        if (!next.pulseId) {
          const pulseType = String(next.pulseType ?? '')
          const title =
            typeof next.pulseTitle === 'string'
              ? next.pulseTitle.trim().toLowerCase()
              : ''
          const id =
            pulseIdByKey.get(`${pulseType}|${title}`) ??
            (title ? pulseIdByKey.get(title) : undefined)
          if (id) next.pulseId = id
        }
        args = next
      }
      let result: ExecutedToolResult
      try {
        result = (await executeAuthorizedWriteTool(
          graph,
          userId,
          call.tool,
          args
        )) as ExecutedToolResult
      } catch (err) {
        result = {
          success: false,
          message:
            err instanceof Error
              ? err.message
              : 'Tool execution failed unexpectedly.',
        }
      }
      if (
        (call.tool === 'create_person' || call.tool === 'update_person') &&
        result.success !== false &&
        typeof result.personId === 'string' &&
        result.personId
      ) {
        // Key by both the graph's canonical name and the extractor's
        // firstName+lastName — the two can differ (e.g. enrich returns the
        // existing node's richer name) and attribution must match either.
        const keys = [
          typeof result.name === 'string' ? result.name : '',
          `${String(args.firstName ?? '')} ${String(args.lastName ?? '')}`,
        ]
        for (const key of keys) {
          const normalized = key.trim().toLowerCase()
          if (normalized) personIdByName.set(normalized, result.personId)
        }
      }
      if (
        call.tool === 'create_organization' &&
        result.success !== false &&
        typeof result.organizationId === 'string' &&
        result.organizationId
      ) {
        const keys = [
          typeof result.name === 'string' ? result.name : '',
          String(args.name ?? ''),
        ]
        for (const key of keys) {
          const normalized = key.trim().toLowerCase()
          if (normalized) orgIdByName.set(normalized, result.organizationId)
        }
      }
      if (
        (call.tool === 'create_pulse' || call.tool === 'update_pulse') &&
        result.success !== false
      ) {
        registerPulseId(args, result)
      }
      executed.push({ tool: call.tool, args, result })
    }
  }

  const succeededCalls = executed.filter((e) => e.result.success !== false)
  const failed = executed.length - succeededCalls.length
  // The extractor emits a free-text reply explaining what it proposed.
  // Prepend a one-line execution summary so the thread reads as a record
  // of what happened, not a record of what was proposed. Count creates and
  // updates separately — a roster match that only updated an existing
  // person must not be announced as "created", or the user goes hunting
  // the graph for a new node that was never minted.
  // A MENTIONED_IN link is a connection, not a created/updated entity — count
  // it on its own axis so the summary never claims a link is a new node.
  const linkedCount = succeededCalls.filter(
    (e) => e.tool === 'link_entity_to_pulse'
  ).length
  const entityCalls = succeededCalls.filter(
    (e) => e.tool !== 'link_entity_to_pulse'
  )
  // A `create_*` tool that hit its idempotency path (enrich-don't-duplicate)
  // returns `alreadyExisted: true` — that's an update, not a mint. Counting it
  // as "created" sends the user hunting the graph for a node that was never
  // added (the same invariant the person path preserves via update_person).
  const createdCount = entityCalls.filter(
    (e) => e.tool.startsWith('create_') && e.result.alreadyExisted !== true
  ).length
  const updatedCount = entityCalls.length - createdCount
  const outcome = [
    createdCount > 0
      ? `created ${createdCount} ${createdCount === 1 ? 'entity' : 'entities'}`
      : '',
    updatedCount > 0
      ? `updated ${updatedCount} existing ${updatedCount === 1 ? 'entry' : 'entries'}`
      : '',
    linkedCount > 0
      ? `made ${linkedCount} ${linkedCount === 1 ? 'connection' : 'connections'}`
      : '',
  ]
    .filter(Boolean)
    .join(' and ')
  const capitalizedOutcome = outcome.charAt(0).toUpperCase() + outcome.slice(1)
  const summaryLine =
    executed.length === 0
      ? ''
      : failed === 0
        ? `${capitalizedOutcome} from this document.`
        : outcome
          ? `${capitalizedOutcome} from this document; ${failed} of ${executed.length} proposed didn't land — see details above.`
          : `None of the ${executed.length} proposed entities landed — see details above.`
  // Attribution is reported from EXECUTED results, never from the proposal —
  // a pulse only counts as attributed when the write actually linked it to
  // the person (names only in chat copy, per kb/07 Rule 1).
  const pulsesByAuthor = new Map<string, string[]>()
  for (const e of executed) {
    // update_pulse counts too (GOAL-318): a re-extract that corrected a
    // pulse's default uploader attribution reports the credited author the
    // same way a fresh create does.
    if (
      (e.tool !== 'create_pulse' && e.tool !== 'update_pulse') ||
      e.result.success === false
    )
      continue
    const author =
      typeof e.result.attributedTo === 'string'
        ? e.result.attributedTo.trim()
        : ''
    // update_pulse nests the title under result.pulse (updatePulse service
    // shape); create_pulse reports it top-level. Fall back to the args the
    // invoker sent so a rename-free update still reports a title.
    const nestedTitle = (e.result.pulse as { title?: string } | undefined)
      ?.title
    const title =
      (typeof e.result.title === 'string' && e.result.title.trim()) ||
      (typeof nestedTitle === 'string' && nestedTitle.trim()) ||
      String(e.args.newTitle ?? e.args.currentTitle ?? '').trim()
    if (!author || !title) continue
    pulsesByAuthor.set(author, [...(pulsesByAuthor.get(author) ?? []), title])
  }
  const attributionLine = Array.from(pulsesByAuthor.entries())
    .map(
      ([author, titles]) =>
        `${titles.map((t) => `"${t}"`).join(', ')} ${titles.length === 1 ? 'is' : 'are'} attributed to ${author}, so their contributions stay connected to them in the graph.`
    )
    .join(' ')
  const assistantText = [
    [summaryLine, attributionLine].filter((s) => s.length > 0).join(' '),
    extraction.assistantText,
  ]
    .filter((s) => s.length > 0)
    .join('\n\n')

  const parts = buildExecutedAssistantTurnParts({
    toolCalls: executed,
    assistantText,
  })
  await appendConversationTurn(
    userId,
    { role: 'assistant', content: assistantText, parts },
    threadId
  )
  return executed
}

/**
 * Split executed tool calls into landed vs failed. One helper so the cron
 * worker, the inline path, and the UI copy can never disagree about what
 * "created 3 entities" means. A `link_entity_to_pulse` call counts here — from
 * the user's point of view a connection that failed to write is still something
 * that didn't land.
 */
export function countExecutedToolCalls(
  executedToolCalls: ExecutedToolCallRecord[]
): { createdEntityCount: number; failedEntityCount: number } {
  const createdEntityCount = executedToolCalls.filter(
    (call) => call.result.success !== false
  ).length
  return {
    createdEntityCount,
    failedEntityCount: executedToolCalls.length - createdEntityCount,
  }
}

async function getFieldContextTitle(
  driver: Driver,
  fieldContextId: string
): Promise<string> {
  const session = driver.session()
  try {
    const result = await session.executeRead(async (tx) =>
      tx.run(
        `MATCH (c:FieldContext {id: $fieldContextId}) RETURN c.title AS title LIMIT 1`,
        { fieldContextId }
      )
    )
    return (result.records[0]?.get('title') as string | null) ?? ''
  } finally {
    await session.close()
  }
}

export type DocumentIngestPipelineFailureReason =
  | 'not_found'
  | 'blob_missing'
  | 'unsupported_mime'
  | 'parse_failure'
  | 'oversize_pages'
  | 'oversize_chars'

export interface DocumentIngestPipelineSuccess {
  ok: true
  documentId: string
  fieldContextId: string
  threadId: string
  filename: string
  executedToolCalls: ExecutedToolCallRecord[]
  /**
   * True when the extractor itself failed (as opposed to individual writes
   * failing). The run still produced a thread documenting the attempt, so it is
   * not a pipeline failure — but callers surface it differently.
   */
  extractionFailed: boolean
}

export interface DocumentIngestPipelineFailure {
  ok: false
  reason: DocumentIngestPipelineFailureReason
  error: string
}

export type DocumentIngestPipelineResult =
  | DocumentIngestPipelineSuccess
  | DocumentIngestPipelineFailure

export interface RunDocumentIngestPipelineInput {
  documentId: string
  /**
   * Whose identity the entity writes and the ingest thread are attributed to.
   * For the worker this is the persisted uploader (the authorization decision
   * captured at enqueue time); for re-extract it is the re-extracting user.
   */
  actingUserId: string
  /** Leading verb of the synthesized user turn — "Uploaded" / "Re-extracted". */
  userTurnVerb: string
  /** Appended to the thread title, e.g. " (re-extracted)". */
  threadTitleSuffix?: string
  /** Pre-loaded record, when the caller has already read it. */
  record?: DocumentRecord
  /**
   * Bounds both model calls (GOAL-344). The article-import worker runs many
   * pipelines per invocation and must keep each inside its row budget; the
   * document cron leaves it unset.
   */
  modelAbortSignal?: AbortSignal
}

export async function runDocumentIngestPipeline(
  deps: DocumentIngestPipelineDependencies,
  input: RunDocumentIngestPipelineInput
): Promise<DocumentIngestPipelineResult> {
  const record =
    input.record ?? (await loadDocumentRecord(deps.driver, input.documentId))
  if (!record) {
    return { ok: false, reason: 'not_found', error: 'Document not found.' }
  }
  if (!record.blobKey) {
    return {
      ok: false,
      reason: 'blob_missing',
      error: 'The original file for this document is no longer available.',
    }
  }

  // Prepare extractor + summarizer inputs by route (multimodal / office /
  // text). Re-derived per attempt — see the module header.
  const prepared = await prepareExtractionInputs(deps, {
    mimeType: record.mimeType,
    blobKey: record.blobKey,
    filename: record.filename,
  })
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason, error: prepared.error }
  }
  const {
    extractionModelInputExtras,
    summarizerExtras,
    modelClient,
    summarizerClient,
    pageCount,
  } = prepared

  const fieldContextTitle = await getFieldContextTitle(
    deps.driver,
    record.fieldContextId
  )
  const roster = await loadFieldContextRoster({
    driver: deps.driver,
    fieldContextId: record.fieldContextId,
  })

  const [extraction, summary] = await Promise.all([
    extractEntities(
      {
        ...extractionModelInputExtras,
        filename: record.filename,
        hint: record.userHint,
        roster,
        fieldContextId: record.fieldContextId,
        fieldContextTitle,
        documentId: record.id,
        sourceUrl: record.sourceUrl,
        userId: input.actingUserId,
        abortSignal: input.modelAbortSignal,
      },
      modelClient
    ),
    summarizeDocument(summarizerClient, {
      ...summarizerExtras,
      filename: record.filename,
      hint: record.userHint,
      fieldContextTitle,
      userId: input.actingUserId,
      abortSignal: input.modelAbortSignal,
    }),
  ])

  await setDocumentSummary({
    driver: deps.driver,
    documentId: record.id,
    summary: summary.summary,
    concepts: summary.concepts,
  })
  // Page count is only knowable once the blob has been read, which is here and
  // not at anchor time (GOAL-292).
  await setDocumentPageCount({
    driver: deps.driver,
    documentId: record.id,
    pageCount,
  })

  const threadId = await createIngestThread(
    deps.driver,
    input.actingUserId,
    record.id,
    `Ingest: ${record.filename}${input.threadTitleSuffix ?? ''}`
  )

  const userTurnContent = record.userHint
    ? `${input.userTurnVerb} ${record.filename}. Hint: ${record.userHint}`
    : `${input.userTurnVerb} ${record.filename}`
  const executedToolCalls = await appendSynthesizedIngestTurns(
    input.actingUserId,
    threadId,
    userTurnContent,
    extraction
  )

  return {
    ok: true,
    documentId: record.id,
    fieldContextId: record.fieldContextId,
    threadId,
    filename: record.filename,
    executedToolCalls,
    extractionFailed: extraction.kind === 'failure',
  }
}
