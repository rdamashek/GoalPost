import { randomUUID } from 'node:crypto'
import type { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph'
import { executeAuthorizedWriteTool } from '@/lib/chat/hitl'
import { normalizeEmail } from '@/lib/auth/normalize-email'
import {
  type ArticleImportRowInput,
  type ArticleRowExtraction,
  type PersistedArticleRowOutcome,
  DEFAULT_ARTICLE_RESOURCE_TYPE,
  buildArticleRowContent,
  normalizeArticleDate,
  normalizeArticleResourceType,
  normalizeArticleUrl,
} from './article-import'
import {
  ARTICLE_EXTRACTION_FAILED_MESSAGE,
  type ArticleContentIngestor,
} from './article-content-ingest'

/** Member-safe copy when the row's pulse landed without an id to attach to. */
const ARTICLE_NOT_ATTEMPTED_MESSAGE =
  'The article could not be read for this row, so it was imported from the sheet details only.'

/**
 * GOAL-317 — server-side orchestration for the article import batch.
 * GOAL-326 — now driven by `/api/cron/process-article-imports` rather than the
 * request, so it also owns resume and yield.
 *
 * Every write goes through `executeAuthorizedWriteTool` (the same audited
 * path chat HITL and document ingestion use), so each row inherits the
 * canEditContext gate, the enrich-don't-duplicate idempotency, the
 * INITIATED_BY attribution guard, and per-entity activity Logs. Rows are
 * processed independently — one failing row never aborts the batch.
 *
 * The context gate is NOT run here: the worker resolves it once (and must
 * re-validate it live at claim time regardless), then hands the title in.
 *
 * GOAL-344: once a row's pulse has landed, the optional `ingestArticle` hook
 * reads the row's link into the field (fetch → Document → the document ingest
 * pipeline) and reports what it yielded on the outcome. The hook is injected
 * rather than imported so this module stays free of blob-store and model
 * dependencies, and so a caller without them (tests, the legacy inline path)
 * gets exactly the pre-GOAL-344 behavior.
 */

export interface ProcessArticleImportParams {
  graph: Neo4jGraph
  currentUserId: string
  fieldContextId: string
  /** Resolved by the caller via `loadEditableContext`. */
  contextTitle: string
  rows: ArticleImportRowInput[]
  /**
   * Resume cursor: rows before this index already have durable outcomes and are
   * skipped entirely. `size(rowOutcomes)` on the job node.
   */
  startIndex?: number
  /**
   * Persist one row's outcome before the next row is attempted. Awaited, so a
   * worker killed mid-batch loses at most the row it was in the middle of.
   *
   * Returns false when the write did not land because this run no longer holds
   * the job's claim (it was reclaimed as stalled and re-claimed elsewhere). The
   * loop stops immediately on false: a zombie worker that kept minting pulses
   * alongside the new claimant would double-write every remaining row.
   */
  onRowOutcome?: (outcome: PersistedArticleRowOutcome) => Promise<boolean>
  /**
   * Checked before each row. Returning true stops the run cleanly and leaves
   * the remainder for the next tick — the run's time budget, not an error.
   */
  shouldYield?: () => boolean
  /**
   * GOAL-344 — reads the row's article into the field after its pulse lands.
   * Never throws by contract; a throw is still caught and reported as a
   * member-safe extraction failure so the row's pulse outcome stands.
   */
  ingestArticle?: ArticleContentIngestor
}

export type ProcessArticleImportStop =
  /** Every row from `startIndex` onward has an outcome. */
  | 'complete'
  /** Out of time; the remaining rows belong to the next tick. */
  | 'yielded'
  /** This run lost its claim mid-batch and must touch nothing further. */
  | 'lost_claim'

export interface ProcessArticleImportRun {
  /** Outcomes produced by THIS run — earlier rows are already persisted. */
  outcomes: PersistedArticleRowOutcome[]
  /** Index of the next unprocessed row; `rows.length` when the batch finished. */
  nextIndex: number
  stopReason: ProcessArticleImportStop
}

interface ResolvedAuthor {
  personId: string
  authorName: string
}

type AuthorResolution =
  | (ResolvedAuthor & { ok: true; isNewPerson: boolean; wasMatched: boolean })
  | { ok: false; failureMessage: string }

const ALLOWED_ARTICLE_PULSE_TYPES = new Set([
  'GoalPulse',
  'ResourcePulse',
  'StoryPulse',
])

/** Member-safe copy — raw errors are logged server-side only (kb/07 Rule 1). */
const ROW_WRITE_FAILED_MESSAGE =
  'Something went wrong while saving this row. Please try again.'

function buildImportLogMetadata(fieldContextId: string): string {
  return JSON.stringify({ source: 'article-import', fieldContextId })
}

/**
 * Resolve the context's title and whether the caller may contribute to it —
 * owner or ADMIN/MEMBER on the parent Space (GUEST is view-only). Same gate
 * shape as the ingest presign route.
 *
 * Exported because it is run twice (GOAL-326): once at enqueue, so a caller
 * without permission never gets a job, and again by the worker at claim time —
 * the gap can be minutes, and the requester may since have been removed from
 * the Space or demoted to GUEST.
 */
export async function loadEditableContext(
  graph: Neo4jGraph,
  currentUserId: string,
  fieldContextId: string
): Promise<{ found: boolean; allowed: boolean; title: string }> {
  // EXISTS-wrapped so an anomalous context with two HAS_CONTEXT parents can
  // neither fan out into rows nor let LIMIT 1 pick the wrong parent — same
  // shape as addPersonToFieldContext's edit gate.
  const rows = await graph.query<{ title: string | null; allowed: boolean }>(
    `
    MATCH (c:FieldContext {id: $fieldContextId})
    // Soft-deleted contexts (GOAL-319) are unreachable by every transition
    // path: the drain skips them, the in-flight cap skips them, and the
    // stale-claim sweep only matches PROCESSING. A job enqueued into one would
    // therefore sit PENDING forever and the modal would poll it forever. When
    // the import was synchronous this was harmless; now it has to fail here.
    WHERE c.deletedAt IS NULL
    RETURN c.title AS title,
      EXISTS {
        MATCH (space:Space)-[:HAS_CONTEXT]->(c)
        WHERE (:Person {id: $userId})-[:OWNS]->(space)
           OR EXISTS {
             MATCH (space)-[:HAS_MEMBER]->(sm:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $userId})
             WHERE sm.role IN ['ADMIN', 'MEMBER']
           }
      } AS allowed
    LIMIT 1
    `,
    { fieldContextId, userId: currentUserId }
  )
  const record = rows?.[0]
  if (!record) return { found: false, allowed: false, title: '' }
  return {
    found: true,
    allowed: Boolean(record.allowed),
    title: record.title?.trim() || '',
  }
}

/**
 * Email-first author match, scoped to the caller's relational world: their
 * own account, people already attached to this context, then their
 * CONNECTED_TO contacts. A connection match is attached to the context
 * (HAS_PERSON) so the attribution guard in create_pulse can credit them;
 * the attach writes one Log, only when the edge is actually new.
 */
async function matchAuthorByEmail(
  graph: Neo4jGraph,
  currentUserId: string,
  fieldContextId: string,
  contextTitle: string,
  email: string
): Promise<ResolvedAuthor | null> {
  const rows = await graph.query<{
    isSelf: boolean
    contextPersonId: string | null
    contextPersonName: string | null
    connectionPersonId: string | null
    connectionPersonName: string | null
  }>(
    `
    MATCH (me:Person {id: $currentUserId})
    OPTIONAL MATCH (:FieldContext {id: $fieldContextId})-[:HAS_PERSON]->(cp:Person)
      WHERE toLower(trim(coalesce(cp.email, ''))) = $email
    WITH me, collect(DISTINCT cp)[0] AS contextMatch
    OPTIONAL MATCH (me)-[:CONNECTED_TO]-(conn:Person)
      WHERE toLower(trim(coalesce(conn.email, ''))) = $email
    WITH me, contextMatch, collect(DISTINCT conn)[0] AS connectionMatch
    RETURN
      toLower(trim(coalesce(me.email, ''))) = $email AS isSelf,
      contextMatch.id AS contextPersonId,
      coalesce(contextMatch.name, trim(coalesce(contextMatch.firstName, '') + ' ' + coalesce(contextMatch.lastName, ''))) AS contextPersonName,
      connectionMatch.id AS connectionPersonId,
      coalesce(connectionMatch.name, trim(coalesce(connectionMatch.firstName, '') + ' ' + coalesce(connectionMatch.lastName, ''))) AS connectionPersonName
    LIMIT 1
    `,
    { currentUserId, fieldContextId, email }
  )

  const match = rows?.[0]
  if (!match) return null

  if (match.isSelf) {
    // Attribution to the acting user is the create_pulse default — no
    // HAS_PERSON attach needed.
    return { personId: currentUserId, authorName: 'you' }
  }

  if (match.contextPersonId) {
    return {
      personId: match.contextPersonId,
      authorName: match.contextPersonName?.trim() || 'person',
    }
  }

  if (match.connectionPersonId) {
    const name = match.connectionPersonName?.trim() || 'person'
    const attached = await graph.query<{ id: string }>(
      `
      MATCH (c:FieldContext {id: $fieldContextId})
      // The target gate below is an ALL() over the Spaces that reach this
      // context, and ALL() over an EMPTY list is TRUE — so on a context whose
      // HAS_CONTEXT edge has been re-pointed by a soft delete (GOAL-319) the
      // consent gate would open instead of closing. Anchoring on a live parent
      // Space first makes the list non-empty by construction. The worker
      // widened this window: enqueue and the row write are now minutes apart,
      // so the context can be deleted in between.
      MATCH (:Space)-[:HAS_CONTEXT]->(c)
      MATCH (u:Person {id: $currentUserId})
      MATCH (p:Person {id: $personId})
      // Target gate (mirrors addPersonToFieldContext): attaching unlocks the
      // person's gated PII to EVERY Space that can reach this context, so a
      // registered User may only be attached when they are the caller or
      // already belong to ALL exposing Spaces. CONNECTED_TO alone is NOT a
      // consent signal — without this clause a caller could force-attach any
      // registered user by email and expose their PII to the whole Space.
      WHERE (NOT p:User)
         OR p.id = $currentUserId
         OR ALL(space IN [(s:Space)-[:HAS_CONTEXT]->(c) | s] WHERE
              (p)-[:OWNS]->(space)
              OR EXISTS {
                MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(p)
              })
      OPTIONAL MATCH (c)-[existing:HAS_PERSON]->(p)
      WITH c, u, p, existing IS NOT NULL AS alreadyAttached
      MERGE (c)-[hp:HAS_PERSON]->(p)
      // GOAL-346: same reasoning as the create_person branch above — an
      // article's author belongs on the roster. Plain SET, since this MERGE
      // routinely matches an edge that already exists.
      SET hp.curated = true
      FOREACH (_ IN CASE WHEN alreadyAttached THEN [] ELSE [1] END |
        CREATE (log:Log {
          id: $logId,
          description: $description,
          metadata: $metadata,
          createdAt: datetime()
        })
        CREATE (log)-[:CREATED_BY]->(u)
      )
      RETURN p.id AS id
      `,
      {
        fieldContextId,
        currentUserId,
        personId: match.connectionPersonId,
        logId: `log_${Date.now()}_${randomUUID().slice(0, 8)}`,
        description: contextTitle
          ? `Added ${name} to ${contextTitle}`
          : `Added ${name}`,
        metadata: buildImportLogMetadata(fieldContextId),
      }
    )
    // Guard rejected (e.g. a registered User outside this Space): no attach,
    // no match — fall through to the name path, which creates a distinct
    // PersonPulse in the caller's relational world instead.
    if (!attached?.[0]?.id) return null
    return { personId: match.connectionPersonId, authorName: name }
  }

  return null
}

/**
 * Resolve a row's author to a Person id: email match first (when the sheet
 * carries one), then the name-in-context path via the authorized
 * create_person tool (self-link / enrich / create PersonPulse). Results are
 * cached per batch so a 50-row sheet by one author resolves once.
 */
async function resolveRowAuthor(
  graph: Neo4jGraph,
  currentUserId: string,
  fieldContextId: string,
  contextTitle: string,
  row: ArticleImportRowInput,
  cache: Map<string, ResolvedAuthor>
): Promise<AuthorResolution> {
  const email = row.authorEmail ? normalizeEmail(row.authorEmail) : ''
  const cacheKey = email
    ? `email:${email}`
    : `name:${row.author.trim().toLowerCase()}`

  const cached = cache.get(cacheKey)
  if (cached) {
    return { ok: true, ...cached, isNewPerson: false, wasMatched: false }
  }

  if (email) {
    const emailMatch = await matchAuthorByEmail(
      graph,
      currentUserId,
      fieldContextId,
      contextTitle,
      email
    )
    if (emailMatch) {
      cache.set(cacheKey, emailMatch)
      return { ok: true, ...emailMatch, isNewPerson: false, wasMatched: true }
    }
  }

  // "Last, First" bylines (common in article exports) split on the comma;
  // everything else splits on whitespace with the first token as firstName.
  const trimmedAuthor = row.author.trim()
  const commaParts = trimmedAuthor.split(',')
  let firstName: string
  let lastName: string | undefined
  if (commaParts.length === 2 && commaParts[1].trim()) {
    firstName = commaParts[1].trim()
    lastName = commaParts[0].trim()
  } else {
    const nameTokens = trimmedAuthor.split(/\s+/)
    firstName = nameTokens[0]
    lastName = nameTokens.slice(1).join(' ') || undefined
  }
  const personResult = await executeAuthorizedWriteTool(
    graph,
    currentUserId,
    'create_person',
    {
      firstName,
      lastName,
      contextId: fieldContextId,
      contextTitle,
      // GOAL-346: an article's author is roster membership, not an incidental
      // mention — the member's own spreadsheet named them, and create_pulse's
      // attribution guard requires them attached. Without this they would be
      // evicted from the People list the moment the row's link runs through
      // the ingest pipeline and the extractor re-encounters the byline,
      // stamping EXTRACTED_FROM on them.
      curatedRoster: true,
    }
  )

  if (personResult.success === false || !personResult.personId) {
    return {
      ok: false,
      failureMessage:
        personResult.message?.trim() ||
        `Could not resolve the author "${row.author}".`,
    }
  }

  const resolved: ResolvedAuthor = {
    personId: String(personResult.personId),
    authorName:
      (typeof personResult.name === 'string' && personResult.name.trim()) ||
      row.author.trim(),
  }
  cache.set(cacheKey, resolved)
  return {
    ok: true,
    ...resolved,
    isNewPerson: personResult.alreadyExisted !== true,
    wasMatched: personResult.alreadyExisted === true,
  }
}

/** Server-side re-validation — never trust the client's parse. */
function validateTypedRow(row: ArticleImportRowInput): string | null {
  if (!row.title?.trim()) return 'Article title is required.'
  if (!row.author?.trim()) return 'Author name is required.'
  if (!row.date?.trim()) return 'Date is required.'
  if (!row.url?.trim() || !normalizeArticleUrl(row.url)) {
    return 'A valid http(s) URL is required.'
  }
  if (!ALLOWED_ARTICLE_PULSE_TYPES.has(row.pulseType)) {
    return 'Unsupported pulse type — use goal, resource, or story.'
  }
  // GOAL-355 — optional, so only a value that is present and unusable fails.
  // Rejected loudly rather than dropped: a member who supplied a source link
  // must never get a pulse that silently lost it.
  if (row.sourceUrl?.trim() && !normalizeArticleUrl(row.sourceUrl)) {
    return 'The source URL must be a valid http(s) link.'
  }
  // Mirrors the preview gate: only ResourcePulse declares these two, so a
  // non-resource row carrying them would have them silently dropped below.
  if (
    row.pulseType !== 'ResourcePulse' &&
    (row.resourceType?.trim() || row.sourceUrl?.trim())
  ) {
    return 'resource_type and source_url only apply to resource rows.'
  }
  return null
}

/**
 * Resolve one row to its outcome. Never throws: a row's failure is a reported
 * outcome, not an exception, so the caller can persist exactly one outcome per
 * row without a second error path that could double-write.
 */
async function resolveRowOutcome({
  graph,
  currentUserId,
  fieldContextId,
  contextTitle,
  row,
  authorCache,
  ingestArticle,
}: {
  graph: Neo4jGraph
  currentUserId: string
  fieldContextId: string
  contextTitle: string
  row: ArticleImportRowInput
  authorCache: Map<string, ResolvedAuthor>
  ingestArticle?: ArticleContentIngestor
}): Promise<PersistedArticleRowOutcome> {
  const validationProblem = validateTypedRow(row)
  if (validationProblem) {
    return {
      row: row.row,
      title: row.title?.trim() ?? '',
      status: 'failed',
      message: validationProblem,
    }
  }

  try {
    const author = await resolveRowAuthor(
      graph,
      currentUserId,
      fieldContextId,
      contextTitle,
      row,
      authorCache
    )
    if (!author.ok) {
      return {
        row: row.row,
        title: row.title.trim(),
        status: 'failed',
        message: author.failureMessage,
      }
    }
    const personEvent = author.isNewPerson
      ? ('created' as const)
      : author.wasMatched
        ? ('matched' as const)
        : undefined

    const pulseResult = await executeAuthorizedWriteTool(
      graph,
      currentUserId,
      'create_pulse',
      {
        contextId: fieldContextId,
        contextTitle,
        title: row.title.trim(),
        content: buildArticleRowContent(row),
        pulseType: row.pulseType,
        // GOAL-355 — the sheet's `resource_type` column wins; the pre-GOAL-355
        // hardcoded default stands in when the column is absent or blank, so a
        // sheet in the old format is unaffected. Only ResourcePulse rows carry
        // the property — it is the only pulse type that declares it.
        resourceType:
          row.pulseType === 'ResourcePulse'
            ? (normalizeArticleResourceType(row.resourceType) ??
              DEFAULT_ARTICLE_RESOURCE_TYPE)
            : undefined,
        // GOAL-355 — a property of its own, never the pulse body: the article
        // read (GOAL-344) may replace a placeholder `content` with the
        // AI-generated summary, which is exactly how the source link kept
        // getting lost when members carried it in the description column.
        // Gated on ResourcePulse for the same reason as `resourceType` above:
        // it is the only pulse type that declares the property. Writing it onto
        // a GoalPulse/StoryPulse would store member data the SDL then drops at
        // serialization — invisible, unreadable, and outside the documented
        // model (kb/05-data-entities.md).
        sourceUrl:
          row.pulseType === 'ResourcePulse' && row.sourceUrl
            ? (normalizeArticleUrl(row.sourceUrl) ?? undefined)
            : undefined,
        location: normalizeArticleUrl(row.url) ?? undefined,
        time: normalizeArticleDate(row.date ?? '') || undefined,
        attributedToPersonId: author.personId,
        attributedToName: author.authorName,
      }
    )

    if (pulseResult.success === false) {
      return {
        row: row.row,
        title: row.title.trim(),
        status: 'failed',
        message: pulseResult.message?.trim() || ROW_WRITE_FAILED_MESSAGE,
        personEvent,
      }
    }

    // The row's pulse is durable from here — the article read that follows
    // can only add to it, never take it away.
    const extraction = ingestArticle
      ? await readRowArticle(ingestArticle, {
          fieldContextId,
          contextTitle,
          requesterUserId: currentUserId,
          row,
          rowPulseId: String(pulseResult.pulseId ?? ''),
          authorName: author.authorName,
        })
      : null

    if (pulseResult.alreadyExisted === true) {
      return {
        row: row.row,
        title: row.title.trim(),
        status: 'skipped_existing',
        message:
          'A pulse with this title already exists in the field — kept it and filled in any missing details.',
        authorName: author.authorName,
        personEvent,
        extraction,
      }
    }

    return {
      row: row.row,
      title: row.title.trim(),
      status: 'created',
      message: 'Created.',
      authorName: author.authorName,
      personEvent,
      extraction,
    }
  } catch (error) {
    // Raw driver/Cypher error text never reaches the member — log it
    // server-side for diagnosis and report fixed copy.
    console.error(
      `[article-import] row ${row.row} failed for context ${fieldContextId}:`,
      error
    )
    return {
      row: row.row,
      title: row.title?.trim() ?? '',
      status: 'failed',
      message: ROW_WRITE_FAILED_MESSAGE,
    }
  }
}

/**
 * Run the article read for one row, converting a thrown error into the
 * member-safe failure shape so the row's pulse outcome is never lost to it.
 */
async function readRowArticle(
  ingestArticle: ArticleContentIngestor,
  input: Parameters<ArticleContentIngestor>[0]
): Promise<ArticleRowExtraction> {
  if (!input.rowPulseId) {
    return {
      status: 'extraction_failed',
      message: ARTICLE_NOT_ATTEMPTED_MESSAGE,
      created: 0,
      updated: 0,
    }
  }
  try {
    return await ingestArticle(input)
  } catch (error) {
    console.error(
      `[article-import] article read failed for row ${input.row.row} in context ${input.fieldContextId}:`,
      error
    )
    return {
      status: 'extraction_failed',
      message: ARTICLE_EXTRACTION_FAILED_MESSAGE,
      created: 0,
      updated: 0,
    }
  }
}

/**
 * Walk `rows` from `startIndex`, minting one pulse per row through the
 * authorized write path and reporting each row's outcome as it lands.
 *
 * Resume semantics: rows before `startIndex` are not re-read, not re-validated,
 * and not re-written. The per-author cache starts empty on a resumed run, so
 * the first row for an already-created author reports `personEvent: 'matched'`
 * rather than `'created'` — accurate for that run, since by then the person
 * genuinely did already exist.
 */
export async function processArticleImport({
  graph,
  currentUserId,
  fieldContextId,
  contextTitle,
  rows,
  startIndex = 0,
  onRowOutcome,
  shouldYield,
  ingestArticle,
}: ProcessArticleImportParams): Promise<ProcessArticleImportRun> {
  const outcomes: PersistedArticleRowOutcome[] = []
  const authorCache = new Map<string, ResolvedAuthor>()
  let index = startIndex
  let claimHeld = true

  const record = async (outcome: PersistedArticleRowOutcome) => {
    outcomes.push(outcome)
    // Awaited before the next row starts: the durable outcome is what makes a
    // resume skip this row, so it has to be committed before more work runs.
    if (onRowOutcome) claimHeld = await onRowOutcome(outcome)
  }

  for (; index < rows.length; index += 1) {
    // Checked at the top of the next iteration rather than inline after
    // `record`, so each condition has exactly one exit point. For 'lost_claim'
    // `nextIndex` therefore points one past the row whose append was rejected;
    // the worker doesn't use it in that branch (it re-reads the durable cursor).
    if (!claimHeld) {
      return { outcomes, nextIndex: index, stopReason: 'lost_claim' }
    }
    if (shouldYield?.()) {
      return { outcomes, nextIndex: index, stopReason: 'yielded' }
    }
    const row = rows[index]

    // Resolve the outcome first, persist it second — deliberately NOT one
    // `record()` call per branch inside the try/catch. If `record` itself
    // throws (a driver blip on the append), a `catch` that also records would
    // write a SECOND outcome for this row, and the invariant the whole resume
    // design rests on is "exactly one outcome per processed row, so the list
    // length IS the cursor". Two outcomes for one row silently skips an
    // unprocessed row on the next tick.
    const outcome = await resolveRowOutcome({
      graph,
      currentUserId,
      fieldContextId,
      contextTitle,
      row,
      authorCache,
      ingestArticle,
    })
    await record(outcome)
  }

  return {
    outcomes,
    nextIndex: rows.length,
    stopReason: claimHeld ? 'complete' : 'lost_claim',
  }
}
