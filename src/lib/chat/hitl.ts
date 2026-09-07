import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph'
import {
  updateFieldContext,
  type UpdateFieldContextInput,
} from '@/modules/agent/tools/field-context/field-context.service'
import {
  updatePulse,
  linkPulseToContext,
  unlinkPulseFromContext,
  type UpdatePulseInput,
  type PulseContextLinkInput,
} from '@/modules/agent/tools/pulse/pulse.service'
import { createHash, randomUUID } from 'crypto'
import { driver } from '@/lib/neo4j/driver'
import { softDeleteFieldContext } from '@/lib/field-context/soft-delete-field-context'
import { isAwaitingReview, NOT_LIVE_WEAVE_STATUSES } from '@/lib/promise-weave'

export type WriteToolName =
  | 'rename_space'
  | 'create_field_context'
  | 'delete_field_context'
  | 'update_field_context'
  | 'create_pulse'
  | 'delete_pulse'
  | 'update_pulse'
  | 'edit_pulse_context_link'
  | 'update_my_profile'
  | 'delete_my_profile'
  | 'create_person'
  | 'update_person'
  | 'create_organization'
  | 'link_entity_to_pulse'
  | 'create_connection'
  | 'create_resonance'
  | 'create_resonant_pulse'
  | 'propose_promise_weave'

export interface ApprovedAction {
  tool: WriteToolName
  args: Record<string, unknown>
}

interface ToolExecutionResult {
  success?: boolean
  message?: string
  [key: string]: unknown
}

const WRITE_TOOL_NAMES = new Set<WriteToolName>([
  'rename_space',
  'create_field_context',
  'delete_field_context',
  'update_field_context',
  'create_pulse',
  'delete_pulse',
  'update_pulse',
  'edit_pulse_context_link',
  'update_my_profile',
  'delete_my_profile',
  'create_person',
  'update_person',
  'create_organization',
  'link_entity_to_pulse',
  'create_connection',
  'create_resonance',
  'create_resonant_pulse',
  'propose_promise_weave',
])

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b)
  )

  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(',')}}`
}

export function isWriteToolName(name: string): name is WriteToolName {
  return WRITE_TOOL_NAMES.has(name as WriteToolName)
}

export function createApprovalHash(
  tool: WriteToolName,
  args: Record<string, unknown>
): string {
  const payload = `${tool}:${stableStringify(args)}`
  return createHash('sha256').update(payload).digest('hex')
}

function pulseTypeLabel(rawType: unknown): string {
  const type = typeof rawType === 'string' ? rawType.trim() : ''
  switch (type) {
    case 'GoalPulse':
      return 'goal'
    case 'ResourcePulse':
      return 'resource'
    case 'StoryPulse':
      return 'story'
    case 'CarePulse':
      return 'care note'
    case 'CoreValuePulse':
      return 'core value'
    default:
      return 'pulse'
  }
}

export function describeWriteAction(
  tool: WriteToolName,
  args: Record<string, unknown>
): string {
  switch (tool) {
    case 'rename_space':
      return `Rename space \"${String(args.currentName || '')}\" to \"${String(args.newName || '')}\"`
    case 'update_field_context':
      return `Update field context ${String(args.contextId || args.currentTitle || 'target')}`
    case 'create_field_context':
      // Rule 1: never surface the raw spaceId — prefer the resolved name, fall
      // back to a generic phrase rather than an id.
      return `Create field context "${String(args.title || '')}" in ${String(args.spaceName || 'the selected space')}`
    case 'delete_field_context': {
      // Rule 1: never surface the raw contextId — prefer the human title,
      // fall back to a generic phrase rather than an id. Deletion cascades
      // over nested fields (GOAL-295), so the approval copy says so.
      const title = String(args.contextTitle || args.currentTitle || '').trim()
      return title
        ? `Delete field context "${title}" and its nested fields and pulses`
        : 'Delete the selected field context and its nested fields and pulses'
    }
    case 'update_pulse': {
      const title = String(args.currentTitle || args.newTitle || '').trim()
      const where = String(args.contextTitle || args.contextName || '').trim()
      const label = pulseTypeLabel(args.pulseType)
      const titleClause = title ? ` "${title}"` : ''
      const whereClause = where ? ` in ${where}` : ''
      // Rule 1: attribution by name only, never an id (GOAL-318 — the ingest
      // update path carries the document's author just like create_pulse).
      const updateBy = String(args.attributedToName || '').trim()
      const updateByClause = updateBy ? ` — attributed to ${updateBy}` : ''
      if (title || where || args.pulseType) {
        return `Update ${label}${titleClause}${whereClause}${updateByClause}`
      }
      // Fallback for callers that don't carry the doc-ingest enrichment.
      return `Update pulse ${String(args.pulseId || 'target')}`
    }
    case 'create_pulse': {
      const title = String(args.title || '').trim()
      const where =
        String(args.contextTitle || args.contextName || '').trim()
      const label = pulseTypeLabel(args.pulseType)
      const titleClause = title ? ` "${title}"` : ''
      const whereClause = where ? ` in ${where}` : ''
      // Rule 1: attribution by name only, never an id.
      const by = String(args.attributedToName || '').trim()
      const byClause = by ? ` — attributed to ${by}` : ''
      return `Add ${label}${titleClause}${whereClause}${byClause}`
    }
    case 'delete_pulse':
      return `Delete pulse ${String(args.pulseId || args.currentTitle || 'target pulse')}`
    case 'edit_pulse_context_link':
      return `${String(args.action || 'Edit')} pulse/context link for pulse ${String(args.pulseId || 'unknown')}`
    case 'update_my_profile':
      return `Update your profile name to \"${String(args.newName || '')}\"`
    case 'delete_my_profile':
      return 'Deactivate your own user profile'
    case 'create_person': {
      const first = String(args.firstName || '').trim()
      const last = String(args.lastName || '').trim()
      const full = [first, last].filter(Boolean).join(' ') || 'person'
      const where =
        String(args.contextTitle || args.contextName || '').trim() ||
        'this field context'
      // Rule 1: surface the relationship in plain words, never an id.
      const why = String(args.relationshipWhy || '').trim()
      const whyClause = why ? ` — connected to you as "${why}"` : ''
      return `Add ${full} to ${where}${whyClause}`
    }
    case 'create_organization': {
      // Rule 1: name only, never an id.
      const name = String(args.name || '').trim() || 'organization'
      const where =
        String(args.contextTitle || args.contextName || '').trim() ||
        'this field context'
      return `Add organization ${name} to ${where}`
    }
    case 'link_entity_to_pulse': {
      // Rule 1: names/titles only, never ids.
      const who = String(args.entityName || '').trim() || 'someone'
      const what = String(args.pulseTitle || '').trim()
      const whatClause = what ? ` "${what}"` : ' a pulse'
      return `Connect ${who} to${whatClause}`
    }
    case 'create_connection': {
      // Names only (Rule 1). The model passes person NAMES; never echo an id.
      const to =
        String(args.toPersonName || args.toName || '').trim() || 'someone'
      const fromRaw = String(args.fromPersonName || '').trim()
      const fromClause =
        fromRaw && fromRaw.toLowerCase() !== 'you' && fromRaw.toLowerCase() !== 'me'
          ? `${fromRaw} with `
          : 'you with '
      const why = String(args.why || '').trim()
      const whyClause = why ? ` — "${why}"` : ''
      return `Connect ${fromClause}${to}${whyClause}`
    }
    case 'create_resonance': {
      // Names only (Rule 1). The suggestion card resolves pulse titles and
      // passes them as sourceName/targetName; never echo a pulse id.
      const source = String(args.sourceName || '').trim() || 'a pulse'
      const target = String(args.targetName || '').trim() || 'another pulse'
      const why = String(args.why || args.label || '').trim()
      const whyClause = why ? ` — "${why}"` : ''
      return `Connect "${source}" and "${target}" as a resonance${whyClause}`
    }
    case 'create_resonant_pulse': {
      // Names only (Rule 1). The card resolves the existing pulse title and
      // carries the new pulse's title; never echo an id.
      const newName =
        String(args.title || args.newPulseName || '').trim() || 'a new pulse'
      const existing =
        String(args.resonateWithName || '').trim() || 'another pulse'
      const kind = pulseTypeLabel(args.pulseType)
      const why = String(args.why || args.label || '').trim()
      const whyClause = why ? ` — "${why}"` : ''
      return `Capture ${kind} "${newName}" and connect it to "${existing}" as a resonance${whyClause}`
    }
    case 'propose_promise_weave': {
      // Names only (Rule 1). The model passes pulse titles and the person's
      // name alongside the ids; never echo an id, and never the `weave_*` this
      // will mint. The copy says out loud that approving here only creates a
      // PROPOSAL — the second gate (Confirm / Dismiss in the field's Promise
      // weaves section) is what makes it an established connection, and an
      // approval card that read "Weave X" would misdescribe what it does.
      const name = String(args.title || '').trim()
      const nameClause = name ? ` "${name}"` : ''
      const who = String(args.wovenForName || '').trim()
      const forClause = who ? ` for ${who}` : ''
      const titles = Array.isArray(args.pulseTitles)
        ? (args.pulseTitles as unknown[])
            .map((title) => String(title ?? '').trim())
            .filter(Boolean)
        : []
      const ids = Array.isArray(args.pulseIds)
        ? (args.pulseIds as unknown[])
            .map((id) => String(id ?? '').trim())
            .filter(Boolean)
        : []
      // The titles are display-only and unverified; the IDS are what get woven.
      // Name titles ONLY when there is one per id, so the card cannot say
      // `holding "A", "B"` over a five-pulse weave, or name pulses that are not
      // in the write at all. Otherwise fall back to an honest count. This card
      // IS the gate — it has to describe the action being approved.
      const named =
        titles.length > 0 && titles.length === ids.length
          ? titles
              .slice(0, 3)
              .map((title) => `"${title}"`)
              .join(', ')
          : ''
      const unnamed = Math.max(0, titles.length - 3)
      const holdingClause = named
        ? ` holding ${named}${unnamed > 0 ? ` and ${unnamed} more` : ''}`
        : ids.length > 0
          ? ` holding ${ids.length} ${ids.length === 1 ? 'pulse' : 'pulses'}`
          : ''
      const where = String(args.contextTitle || '').trim()
      const whereClause = where ? ` in ${where}` : ''
      return `Propose promise weave${nameClause}${forClause}${holdingClause}${whereClause} — it arrives as a proposal for you to confirm or dismiss`
    }
    case 'update_person': {
      const first = String(args.firstName || '').trim()
      const last = String(args.lastName || '').trim()
      const full =
        [first, last].filter(Boolean).join(' ') ||
        String(args.currentName || '').trim() ||
        'person'
      const where =
        String(args.contextTitle || args.contextName || '').trim() ||
        'this field context'
      return `Update ${full} in ${where}`
    }
    default:
      return `Run ${tool}`
  }
}

type PulseCreationType =
  | 'GoalPulse'
  | 'ResourcePulse'
  | 'StoryPulse'
  | 'CarePulse'
  | 'CoreValuePulse'
  | 'FieldPulse'

interface SpaceLocatorInput {
  spaceId?: string
  spaceName?: string
}

interface ContextLocatorInput {
  contextId?: string
  contextTitle?: string
  spaceName?: string
}

interface CreateFieldContextInput extends SpaceLocatorInput {
  title?: string
  emergentName?: string
}

interface DeleteFieldContextInput extends ContextLocatorInput {
  currentTitle?: string
  deletePulses?: boolean
}

interface CreatePulseInput extends ContextLocatorInput {
  title?: string
  content?: string
  pulseType?: PulseCreationType
  status?: string
  intensity?: number
  horizon?: string
  resourceType?: string
  availability?: number
  why?: string
  location?: string
  time?: string
  /**
   * GOAL-355 — where the resource was *found* (a LinkedIn post, a newsletter),
   * as distinct from `location`, which is the resource itself. Written by the
   * bulk article import from the sheet's `source_url` column. A property of its
   * own precisely so it survives the doc-ingest pass that may replace a
   * placeholder `content` with an AI-generated summary.
   */
  sourceUrl?: string
  /** Optional source Document — when present, EXTRACTED_FROM edge is created (ADR-0002). */
  documentId?: string
  /** Optional ingest thread — slice 7: stamps the Log.metadata audit trail. */
  conversationThreadId?: string
  /**
   * Doc-ingest attribution: the extracted person whose voice/authorship this
   * pulse carries. When the id resolves to a person attached (HAS_PERSON) to
   * the same FieldContext, the canonical INITIATED_BY author edge points at
   * them instead of the acting user — the pulse is theirs, the upload merely
   * carried it in. The activity Log stays CREATED_BY the acting user either
   * way, so the audit trail is unchanged.
   */
  attributedToPersonId?: string
  /** Display name for the attributed person — approval-card copy only (Rule 1). */
  attributedToName?: string
}

interface DeletePulseInput {
  pulseId?: string
  currentTitle?: string
  contextId?: string
}

const ALLOWED_PULSE_TYPES = new Set<PulseCreationType>([
  'GoalPulse',
  'ResourcePulse',
  'StoryPulse',
  'CarePulse',
  'CoreValuePulse',
  'FieldPulse',
])

/**
 * Slice 7 (GOAL-242) — look up a Document's filename so per-entity Log rows
 * can reference it in user-readable copy. Returns null when the document is
 * missing or the lookup fails (the description simply omits the suffix —
 * never blocks the write).
 */
async function lookupDocumentFilename(
  graph: Neo4jGraph,
  documentId: string
): Promise<string | null> {
  try {
    const rows = await graph.query<{ filename: string | null }>(
      `MATCH (d:Document {id: $documentId}) RETURN d.filename AS filename LIMIT 1`,
      { documentId }
    )
    const value = rows?.[0]?.filename
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * Slice 7 (GOAL-242) — server-side audit trail JSON for ingest-path Log rows.
 * Returns null when no provenance applies, so the Cypher conditional SET stays
 * a no-op for manual creates/updates (existing behavior preserved).
 */
function buildIngestLogMetadata(
  documentId: string | null,
  conversationThreadId: string | null
): string | null {
  if (!documentId && !conversationThreadId) return null
  const payload: Record<string, string> = {}
  if (documentId) payload.documentId = documentId
  if (conversationThreadId) payload.conversationThreadId = conversationThreadId
  return JSON.stringify(payload)
}

/**
 * The single source of truth for the "pending HITL approval" tool-result
 * shape. Both the runtime gate (runWriteTool in chat-tools.ts) and the
 * doc-ingestion synthesized-turn appender must call this exact factory so
 * the HITL Dialog hydrates either path identically. Drift here silently
 * breaks approval — pinned by hitl.test.ts.
 */
export interface PendingApprovalResult {
  success: false
  approvalRequired: true
  approvalHash: string
  tool: WriteToolName
  args: Record<string, unknown>
  summary: string
  message: string
}

export function buildPendingApprovalResult(
  tool: WriteToolName,
  args: Record<string, unknown>
): PendingApprovalResult {
  return {
    success: false,
    approvalRequired: true,
    approvalHash: createApprovalHash(tool, args),
    tool,
    args,
    summary: describeWriteAction(tool, args),
    message: 'This action needs your approval before I can execute it.',
  }
}

export function buildApprovedActionHashSet(
  approvedActions: ApprovedAction[] | undefined
): Set<string> {
  if (!approvedActions || approvedActions.length === 0) {
    return new Set<string>()
  }

  const hashes = approvedActions
    .filter(
      (item): item is ApprovedAction =>
        Boolean(item?.tool) && isWriteToolName(item.tool)
    )
    .map((item) => createApprovalHash(item.tool, item.args || {}))

  return new Set(hashes)
}

async function getEditableSpaceMatchesByName(
  graph: Neo4jGraph,
  currentUserId: string,
  currentName: string
): Promise<Array<{ id: string; graphId: string; name: string }>> {
  const query = `
    MATCH (space:Space)
    WHERE toLower(trim(coalesce(space.name, ''))) = toLower(trim($currentName))
    WITH DISTINCT space
    OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
    OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person)
    WITH space,
      [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
      [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
    WHERE $currentUserId IN ownerIds OR $currentUserId IN memberIds
    RETURN
      coalesce(space.id, '') AS id,
      elementId(space) AS graphId,
      space.name AS name
    LIMIT 10
  `

  return await graph.query<{ id: string; graphId: string; name: string }>(
    query,
    {
      currentName,
      currentUserId,
    }
  )
}

async function resolveEditableSpace(
  graph: Neo4jGraph,
  currentUserId: string,
  input: SpaceLocatorInput
): Promise<
  | { ok: true; spaceId: string; spaceName: string }
  | { ok: false; result: ToolExecutionResult }
> {
  const spaceId = input.spaceId?.trim() || null
  const spaceName = input.spaceName?.trim() || null

  if (!spaceId && !spaceName) {
    return {
      ok: false,
      result: {
        success: false,
        message:
          'Please provide spaceId or spaceName to identify where to apply this change.',
      },
    }
  }

  if (spaceId) {
    const query = `
      MATCH (space:Space {id: $spaceId})
      OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
      OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person)
      WITH space,
        [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
        [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
      WHERE $currentUserId IN ownerIds OR $currentUserId IN memberIds
      RETURN space.id AS id, space.name AS name
      LIMIT 1
    `

    const rows = await graph.query<{ id: string; name: string }>(query, {
      spaceId,
      currentUserId,
    })

    if (!rows || rows.length === 0) {
      return {
        ok: false,
        result: {
          success: false,
          message: 'You can only modify spaces you own or are a member of.',
        },
      }
    }

    return { ok: true, spaceId: rows[0].id, spaceName: rows[0].name }
  }

  const matches = await getEditableSpaceMatchesByName(
    graph,
    currentUserId,
    spaceName as string
  )

  if (matches.length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        message: `No editable space found for "${spaceName}".`,
      },
    }
  }

  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        success: false,
        requiresDisambiguation: true,
        message:
          'Multiple editable spaces match that name. Please provide spaceId.',
        candidates: matches,
      },
    }
  }

  return {
    ok: true,
    spaceId: matches[0].id,
    spaceName: matches[0].name,
  }
}

async function canEditContext(
  graph: Neo4jGraph,
  currentUserId: string,
  contextId: string
): Promise<boolean> {
  const query = `
    MATCH (space:Space)-[:HAS_CONTEXT]->(context:FieldContext {id: $contextId})
    OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
    // Only ADMIN/MEMBER can edit — GUEST is view-only (kb/02). Mirrors the
    // canonical canEditContent in space-permissions.ts.
    OPTIONAL MATCH (space)-[:HAS_MEMBER]->(sm:SpaceMembership)-[:IS_MEMBER]->(member:Person)
    WHERE sm.role IN ['ADMIN', 'MEMBER']
    WITH [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
         [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
    RETURN ($currentUserId IN ownerIds OR $currentUserId IN memberIds) AS allowed
    LIMIT 1
  `

  const rows = await graph.query<{ allowed: boolean }>(query, {
    contextId,
    currentUserId,
  })

  return Boolean(rows?.[0]?.allowed)
}

async function canEditPulse(
  graph: Neo4jGraph,
  currentUserId: string,
  pulseId: string
): Promise<boolean> {
  const query = `
    MATCH (space:Space)-[:HAS_CONTEXT]->(:FieldContext)-[:HAS_PULSE]->(pulse:FieldPulse {id: $pulseId})
    OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
    // Only ADMIN/MEMBER can edit — GUEST is view-only (kb/02). Mirrors the
    // canonical canEditContent in space-permissions.ts.
    OPTIONAL MATCH (space)-[:HAS_MEMBER]->(sm:SpaceMembership)-[:IS_MEMBER]->(member:Person)
    WHERE sm.role IN ['ADMIN', 'MEMBER']
    WITH [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
         [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
    RETURN ($currentUserId IN ownerIds OR $currentUserId IN memberIds) AS allowed
    LIMIT 1
  `

  const rows = await graph.query<{ allowed: boolean }>(query, {
    pulseId,
    currentUserId,
  })

  return Boolean(rows?.[0]?.allowed)
}

async function resolveAuthorizedContextId(
  graph: Neo4jGraph,
  currentUserId: string,
  input: UpdateFieldContextInput
): Promise<
  { ok: true; contextId: string } | { ok: false; result: ToolExecutionResult }
> {
  if (input.contextId?.trim()) {
    const allowed = await canEditContext(graph, currentUserId, input.contextId)
    if (!allowed) {
      return {
        ok: false,
        result: {
          success: false,
          message: 'You can only edit field contexts in spaces you belong to.',
        },
      }
    }

    return { ok: true, contextId: input.contextId }
  }

  const title = input.currentTitle?.trim()
  if (!title) {
    return {
      ok: false,
      result: {
        success: false,
        message:
          'Please provide contextId or currentTitle so I can identify the field context.',
      },
    }
  }

  const query = `
    MATCH (space:Space)-[:HAS_CONTEXT]->(context:FieldContext)
    WHERE (
      toLower(trim(coalesce(context.title, ''))) = toLower(trim($title))
      OR toLower(trim(coalesce(context.emergentName, ''))) = toLower(trim($title))
    )
      AND (
        $spaceName IS NULL
        OR toLower(coalesce(space.name, '')) CONTAINS toLower($spaceName)
      )
    OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
    OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person)
    WITH context,
      [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
      [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
    WHERE $currentUserId IN ownerIds OR $currentUserId IN memberIds
    RETURN context.id AS contextId
    LIMIT 5
  `

  const rows = await graph.query<{ contextId: string }>(query, {
    title,
    spaceName: input.spaceName?.trim() || null,
    currentUserId,
  })

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        message: 'No editable field context matched your request.',
      },
    }
  }

  if (rows.length > 1) {
    return {
      ok: false,
      result: {
        success: false,
        requiresDisambiguation: true,
        message:
          'Multiple editable field contexts match your request. Please provide contextId.',
        candidates: rows,
      },
    }
  }

  return { ok: true, contextId: rows[0].contextId }
}

async function resolveAuthorizedPulseId(
  graph: Neo4jGraph,
  currentUserId: string,
  input: UpdatePulseInput
): Promise<
  { ok: true; pulseId: string } | { ok: false; result: ToolExecutionResult }
> {
  if (input.pulseId?.trim()) {
    const allowed = await canEditPulse(graph, currentUserId, input.pulseId)
    if (!allowed) {
      return {
        ok: false,
        result: {
          success: false,
          message: 'You can only edit pulses in spaces you belong to.',
        },
      }
    }

    return { ok: true, pulseId: input.pulseId }
  }

  const title = input.currentTitle?.trim()
  if (!title) {
    return {
      ok: false,
      result: {
        success: false,
        message:
          'Please provide pulseId or currentTitle so I can identify the pulse.',
      },
    }
  }

  const query = `
    MATCH (space:Space)-[:HAS_CONTEXT]->(context:FieldContext)-[:HAS_PULSE]->(pulse:FieldPulse)
    WHERE toLower(trim(coalesce(pulse.title, ''))) = toLower(trim($title))
      AND (
        $contextId IS NULL
        OR context.id = $contextId
      )
    OPTIONAL MATCH (owner:Person)-[:OWNS]->(space)
    OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person)
    WITH pulse,
      [id IN collect(DISTINCT owner.id) WHERE id IS NOT NULL] AS ownerIds,
      [id IN collect(DISTINCT member.id) WHERE id IS NOT NULL] AS memberIds
    WHERE $currentUserId IN ownerIds OR $currentUserId IN memberIds
    RETURN pulse.id AS pulseId
    LIMIT 5
  `

  const rows = await graph.query<{ pulseId: string }>(query, {
    title,
    contextId: input.contextId?.trim() || null,
    currentUserId,
  })

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        message: 'No editable pulse matched your request.',
      },
    }
  }

  if (rows.length > 1) {
    return {
      ok: false,
      result: {
        success: false,
        requiresDisambiguation: true,
        message:
          'Multiple editable pulses match your request. Please provide pulseId.',
        candidates: rows,
      },
    }
  }

  return { ok: true, pulseId: rows[0].pulseId }
}

async function renameSpaceAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const currentName = String(args.currentName || '').trim()
  const newName = String(args.newName || '').trim()

  if (!currentName || !newName) {
    return {
      success: false,
      message: 'Both currentName and newName are required for rename_space.',
    }
  }

  const matches = await getEditableSpaceMatchesByName(
    graph,
    currentUserId,
    currentName
  )

  if (matches.length === 0) {
    return {
      success: false,
      message: 'No editable space matched that name.',
    }
  }

  if (matches.length > 1) {
    return {
      success: false,
      requiresDisambiguation: true,
      message:
        'Multiple editable spaces have that name. Please rename using a unique space name first.',
      candidates: matches,
    }
  }

  const target = matches[0]
  const updateQuery = `
    MATCH (space:Space)
    WHERE elementId(space) = $graphId
    SET space.name = $newName,
        space.updatedAt = datetime()
    RETURN coalesce(space.id, '') AS id, space.name AS name
    LIMIT 1
  `

  const updated = await graph.query<{ id: string; name: string }>(updateQuery, {
    graphId: target.graphId,
    newName,
  })

  if (!updated || updated.length === 0) {
    return {
      success: false,
      message: 'Failed to rename the space.',
    }
  }

  return {
    success: true,
    spaceId: updated[0].id,
    oldName: currentName,
    newName: updated[0].name,
    message: `Renamed \"${currentName}\" to \"${updated[0].name}\" successfully.`,
  }
}

async function updateMyProfileAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const newName = String(args.newName || '').trim()

  if (!newName) {
    return {
      success: false,
      message: 'Please provide newName to update your profile.',
    }
  }

  const query = `
    MATCH (p:Person {id: $currentUserId})
    SET p.name = $newName,
        p.updatedAt = datetime()
    RETURN p.id AS id, p.name AS name
    LIMIT 1
  `

  const rows = await graph.query<{ id: string; name: string }>(query, {
    currentUserId,
    newName,
  })

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Could not update your profile. Please verify your session.',
    }
  }

  return {
    success: true,
    personId: rows[0].id,
    name: rows[0].name,
    message: `Updated your display name to \"${rows[0].name}\".`,
  }
}

async function createFieldContextAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreateFieldContextInput
  const title = input.title?.trim() || ''
  const emergentName = input.emergentName?.trim() || null

  if (!title) {
    return {
      success: false,
      message: 'title is required to create a field context.',
    }
  }

  const space = await resolveEditableSpace(graph, currentUserId, input)
  if (!space.ok) return space.result

  const query = `
    MATCH (space:Space {id: $spaceId})
    CREATE (context:FieldContext {
      id: 'context_' + randomUUID(),
      title: $title,
      createdAt: datetime(),
      updatedAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $emergentName IS NULL THEN [] ELSE [1] END |
      SET context.emergentName = $emergentName
    )
    CREATE (space)-[:HAS_CONTEXT]->(context)
    RETURN context.id AS id, context.title AS title, context.emergentName AS emergentName
    LIMIT 1
  `

  const rows = await graph.query<{
    id: string
    title: string
    emergentName?: string | null
  }>(query, {
    spaceId: space.spaceId,
    title,
    emergentName,
  })

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to create the field context.',
    }
  }

  return {
    success: true,
    contextId: rows[0].id,
    title: rows[0].title,
    emergentName: rows[0].emergentName || null,
    spaceId: space.spaceId,
    spaceName: space.spaceName,
    message: `Created field context "${rows[0].title}" in "${space.spaceName}".`,
  }
}

async function deleteFieldContextAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as DeleteFieldContextInput
  const resolved = await resolveAuthorizedContextId(graph, currentUserId, {
    contextId: input.contextId,
    currentTitle: input.currentTitle || input.contextTitle,
    spaceName: input.spaceName,
  })

  if (!resolved.ok) return resolved.result

  const contextId = resolved.contextId
  // GOAL-295: deletion cascades over the nested field subtree, so the consent
  // gate must count pulses across the WHOLE live subtree — a parent with 0
  // direct pulses can still take 40 nested field pulses down with it.
  const detailsQuery = `
    MATCH (context:FieldContext {id: $contextId})
    OPTIONAL MATCH (context)-[:HAS_SUBCONTEXT*0..10]->(sc:FieldContext)-[:HAS_PULSE]->(pulse:FieldPulse)
    WHERE sc.deletedAt IS NULL
    WITH context, count(DISTINCT pulse) AS pulseCount
    OPTIONAL MATCH (context)-[:HAS_SUBCONTEXT*1..10]->(child:FieldContext)
    WHERE child.deletedAt IS NULL
    RETURN context.title AS title, pulseCount,
           count(DISTINCT child) AS subContextCount
    LIMIT 1
  `

  const details = await graph.query<{
    title: string
    pulseCount: number
    subContextCount: number
  }>(detailsQuery, { contextId })

  if (!details || details.length === 0) {
    return {
      success: false,
      message: 'Field context not found.',
    }
  }

  const pulseCount = Number(details[0].pulseCount || 0)
  const subContextCount = Number(details[0].subContextCount || 0)
  const deletePulses = Boolean(input.deletePulses)

  if (pulseCount > 0 && !deletePulses) {
    const subFieldClause =
      subContextCount > 0
        ? ` across it and its ${
            subContextCount === 1
              ? 'nested field'
              : `${subContextCount} nested fields`
          } (deleting the field deletes its nested fields too)`
        : ''
    return {
      success: false,
      requiresClarification: true,
      message: `This field context has ${pulseCount} pulse${pulseCount === 1 ? '' : 's'}${subFieldClause}. Confirm deletePulses=true if you want to delete the context and its pulses.`,
    }
  }

  // Shared soft-delete orchestrator (GOAL-319) — the same path as the
  // GraphQL deleteFieldContext mutation. One transaction: owner-or-ADMIN
  // gate, deletedAt stamps on the context + its pulses, suggestion cleanup,
  // Space edge re-pointed to HAS_DELETED_CONTEXT, activity Log. The 90-day
  // purge cron hard-deletes later. Note the gate is stricter than
  // resolveAuthorizedContextId's edit gate: per kb/02, MEMBERs can edit
  // fields but only the owner or an ADMIN may delete one.
  const outcome = await softDeleteFieldContext(
    { driver },
    { currentUserId, contextId }
  )

  if (!outcome.ok) {
    return {
      success: false,
      message:
        outcome.reason === 'forbidden'
          ? 'Only the space owner or an admin can delete a field context.'
          : outcome.error,
    }
  }

  const deletedPulseCount = outcome.deletedPulseCount
  const deletedSubContextCount = outcome.deletedSubContextCount
  const deletedParts = [
    deletedSubContextCount > 0
      ? deletedSubContextCount === 1
        ? 'its nested field'
        : `its ${deletedSubContextCount} nested fields`
      : null,
    deletedPulseCount > 0
      ? deletedPulseCount === 1
        ? 'its pulse'
        : `its ${deletedPulseCount} pulses`
      : null,
  ].filter(Boolean)
  return {
    success: true,
    contextId,
    deletedPulseCount,
    deletedSubContextCount,
    message:
      deletedParts.length > 0
        ? `Deleted field context "${outcome.title}" and ${deletedParts.join(' and ')}.`
        : `Deleted field context "${outcome.title}".`,
  }
}

/**
 * GOAL-318: conservative author re-attribution for the ingest update/enrich
 * paths. A re-extract (or a second document matching an existing pulse) lands
 * on update_pulse / the create_pulse enrich branch, where the original write
 * may have defaulted INITIATED_BY to the uploader. Re-point the canonical
 * author edge at the credited person ONLY when the pulse's current displayed
 * author (initiatedBy[0], else createdBy[0] — resolvePulseAuthor's
 * precedence) is the acting user or absent: correcting default uploader
 * attribution is the goal; authorship a different person already holds is
 * never stolen. Same-context HAS_PERSON gate as createPulseAuthorized,
 * atomic with the edge write. Returns the credited author's display name,
 * or null when nothing changed.
 */
async function reattributeIngestPulseAuthor(
  graph: Neo4jGraph,
  currentUserId: string,
  params: {
    pulseId: string
    contextId: string
    attributedToPersonId?: unknown
    attributedToName?: unknown
  }
): Promise<string | null> {
  const authorId =
    typeof params.attributedToPersonId === 'string'
      ? params.attributedToPersonId.trim()
      : ''
  if (!authorId || authorId === currentUserId) return null
  if (!params.pulseId || !params.contextId) return null

  const rows = await graph.query<{ name: string | null }>(
    `
    MATCH (context:FieldContext {id: $contextId})-[:HAS_PULSE]->(pulse:FieldPulse {id: $pulseId})
    MATCH (context)-[:HAS_PERSON]->(author:Person {id: $authorId})
    // Conservative gate: only when the current displayed author is the acting
    // user or absent. INITIATED_BY wins the display (resolvePulseAuthor), so
    // any INITIATED_BY to someone else blocks; with no INITIATED_BY at all,
    // a CREATED_BY to someone else blocks instead.
    WHERE NOT EXISTS {
        // Untyped on purpose: any non-self INITIATED_BY target blocks, even a
        // malformed non-Person node — "never steal" stays robust to bad data.
        // The IS NULL arm keeps an id-less target blocking too (NULL <> x
        // would otherwise evaluate to NULL and drop the row).
        MATCH (pulse)-[:INITIATED_BY]->(cur)
        WHERE cur.id IS NULL OR cur.id <> $currentUserId
      }
      AND (
        EXISTS { (pulse)-[:INITIATED_BY]->(:Person {id: $currentUserId}) }
        OR NOT EXISTS {
          MATCH (pulse)-[:CREATED_BY]->(cb)
          WHERE cb.id IS NULL OR cb.id <> $currentUserId
        }
      )
    WITH pulse, author LIMIT 1
    OPTIONAL MATCH (pulse)-[old:INITIATED_BY]->()
    DELETE old
    // Exactly one INITIATED_BY after the write — resolvePulseAuthor reads
    // initiatedBy[0], so the edge must stay single (DISTINCT collapses the
    // per-deleted-edge rows before CREATE).
    WITH DISTINCT pulse, author
    CREATE (pulse)-[:INITIATED_BY]->(author)
    RETURN coalesce(author.name, trim(coalesce(author.firstName, '') + ' ' + coalesce(author.lastName, ''))) AS name
    LIMIT 1
    `,
    {
      contextId: params.contextId,
      pulseId: params.pulseId,
      authorId,
      currentUserId,
    }
  )
  if (!rows?.[0]) return null
  return (
    rows[0].name?.trim() ||
    (typeof params.attributedToName === 'string'
      ? params.attributedToName.trim()
      : '') ||
    'person'
  )
}

async function createPulseAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreatePulseInput
  const title = input.title?.trim() || ''
  // A title is the only hard requirement — the UI lets users create a
  // title-only goal/pulse. When the user gave no body, seed content from the
  // title so the create succeeds (GOAL-261: an empty content used to fail the
  // write, which then re-triggered the approval prompt in a loop).
  const content = input.content?.trim() || title

  if (!title) {
    return {
      success: false,
      message: 'A title is required to create a pulse.',
    }
  }

  const resolvedContext = await resolveAuthorizedContextId(
    graph,
    currentUserId,
    {
      contextId: input.contextId,
      currentTitle: input.contextTitle,
      spaceName: input.spaceName,
    }
  )
  if (!resolvedContext.ok) return resolvedContext.result

  const pulseType = ALLOWED_PULSE_TYPES.has(
    (input.pulseType as PulseCreationType) || 'FieldPulse'
  )
    ? (input.pulseType as PulseCreationType) || 'FieldPulse'
    : 'FieldPulse'
  const pulseLabel = pulseType === 'FieldPulse' ? '' : `:${pulseType}`

  // Idempotency (enrich, don't duplicate): a pulse with the same title AND type
  // already in this context is enriched (fill-gaps-only), never duplicated.
  // Dedup is deliberately TYPE-scoped ($pulseType IN labels(p)) — a Goal and a
  // Story that happen to share a title are different pulses and must NOT merge.
  // (Consequence: a generic FieldPulse add matches any same-titled pulse, while
  // a typed add only matches its own subtype — intentional, not a bug.)
  const existingPulseRows = await graph.query<{
    id: string
    title: string | null
  }>(
    `
    MATCH (c:FieldContext {id: $contextId})-[:HAS_PULSE]->(p:FieldPulse)
    WHERE toLower(trim(coalesce(p.title, ''))) = toLower(trim($title))
      AND $pulseType IN labels(p)
    RETURN p.id AS id, p.title AS title
    LIMIT 1
    `,
    { contextId: resolvedContext.contextId, title, pulseType }
  )
  if (existingPulseRows?.[0]) {
    const ep = existingPulseRows[0]
    // GOAL-318: an ingest proposal that lands on an already-existing pulse
    // still carries the document's author — correct default uploader
    // attribution before composing the Log, so a re-upload attributes the
    // pulse the same way a fresh create would have.
    const reattributedTo = await reattributeIngestPulseAuthor(
      graph,
      currentUserId,
      {
        pulseId: ep.id,
        contextId: resolvedContext.contextId,
        attributedToPersonId: input.attributedToPersonId,
        attributedToName: input.attributedToName,
      }
    )
    const enrichWhere = input.contextTitle?.trim() || ''
    const humanLabelExisting = pulseTypeLabel(pulseType)
    const enrichLogId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
    const enrichAttribution = reattributedTo
      ? ` — attributed to ${reattributedTo}`
      : ''
    const enrichDescription =
      (enrichWhere
        ? `Updated ${humanLabelExisting} "${ep.title ?? title}" in ${enrichWhere}`
        : `Updated ${humanLabelExisting} "${ep.title ?? title}"`) +
      enrichAttribution
    // Only a substantive body fills a gap — never the title-seeded placeholder.
    const newContent = input.content?.trim() || null
    await graph.query(
      `
      MATCH (p:FieldPulse {id: $existingId})
      MATCH (u:Person {id: $currentUserId})
      // Fill the body only when the existing one is empty or was just the title
      // (the title-seeded placeholder) — never overwrite a real existing body.
      FOREACH (_ IN CASE
        WHEN $newContent IS NULL
          OR (trim(coalesce(p.content, '')) <> ''
              AND toLower(trim(coalesce(p.content, ''))) <> toLower(trim(coalesce(p.title, ''))))
        THEN [] ELSE [1] END |
        SET p.content = $newContent
      )
      SET p.status = coalesce(p.status, $status),
          p.intensity = coalesce(p.intensity, $intensity),
          p.horizon = coalesce(p.horizon, $horizon),
          p.resourceType = coalesce(p.resourceType, $resourceType),
          p.availability = coalesce(p.availability, $availability),
          p.why = coalesce(p.why, $why),
          p.location = coalesce(p.location, $location),
          p.time = coalesce(p.time, $time),
          p.sourceUrl = coalesce(p.sourceUrl, $sourceUrl),
          p.updatedAt = datetime()
      CREATE (log:Log {
        id: $enrichLogId,
        description: $enrichDescription,
        createdAt: datetime()
      })
      CREATE (log)-[:CREATED_BY]->(u)
      CREATE (log)-[:LOGGED_FOR]->(p)
      `,
      {
        existingId: ep.id,
        currentUserId,
        newContent,
        status:
          input.status?.trim() ||
          (pulseType === 'GoalPulse' ? 'ACTIVE' : null),
        intensity:
          typeof input.intensity === 'number' &&
          Number.isFinite(input.intensity)
            ? input.intensity
            : null,
        horizon: input.horizon?.trim() || null,
        resourceType: input.resourceType?.trim() || null,
        availability:
          typeof input.availability === 'number' &&
          Number.isFinite(input.availability)
            ? input.availability
            : null,
        why: input.why?.trim() || null,
        location: input.location?.trim() || null,
        time: input.time?.trim() || null,
        sourceUrl: input.sourceUrl?.trim() || null,
        enrichLogId,
        enrichDescription,
      }
    )
    return {
      success: true,
      pulseId: ep.id,
      title: ep.title ?? title,
      pulseType,
      contextId: resolvedContext.contextId,
      alreadyExisted: true,
      // Human label for the credited author (Rule 3) — null when attribution
      // was absent or the existing author (someone else) was left in place.
      attributedTo: reattributedTo ?? null,
      message:
        `${humanLabelExisting} "${ep.title ?? title}" is already in ${
          enrichWhere || 'this field'
        } — I kept it and filled in any missing details rather than adding a duplicate.` +
        (reattributedTo ? ` It is attributed to ${reattributedTo}.` : ''),
    }
  }

  const documentId = input.documentId?.trim() || null
  const conversationThreadId = input.conversationThreadId?.trim() || null
  const documentFilename = documentId
    ? await lookupDocumentFilename(graph, documentId)
    : null

  // Attribution guard: only a person already attached (HAS_PERSON) to THIS
  // context can be credited as the pulse's author — an arbitrary id cannot
  // pull authorship from outside the Space the canEditContext gate above
  // authorized. Unresolvable ids fall back silently to the acting user.
  const attributedToPersonId = input.attributedToPersonId?.trim() || null
  let attributedAuthor: { id: string; name: string } | null = null
  if (attributedToPersonId && attributedToPersonId !== currentUserId) {
    const authorRows = await graph.query<{ id: string; name: string | null }>(
      `
      MATCH (:FieldContext {id: $contextId})-[:HAS_PERSON]->(p:Person {id: $attributedToPersonId})
      RETURN p.id AS id,
             coalesce(p.name, trim(coalesce(p.firstName, '') + ' ' + coalesce(p.lastName, ''))) AS name
      LIMIT 1
      `,
      { contextId: resolvedContext.contextId, attributedToPersonId }
    )
    if (authorRows?.[0]) {
      attributedAuthor = {
        id: authorRows[0].id,
        name:
          authorRows[0].name?.trim() ||
          input.attributedToName?.trim() ||
          'person',
      }
    }
  }

  const pulseId = `pulse_${randomUUID()}`
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const where = input.contextTitle?.trim() || ''
  const humanLabel = pulseTypeLabel(pulseType)
  const filenameSuffix = documentFilename ? ` (from ${documentFilename})` : ''
  const attributionSuffix = attributedAuthor
    ? ` — attributed to ${attributedAuthor.name}`
    : ''
  const description =
    (where
      ? `Added ${humanLabel} "${title}" to ${where}`
      : `Added ${humanLabel} "${title}"`) +
    filenameSuffix +
    attributionSuffix
  // Slice 7: server-side audit metadata. Never user-facing; surfaced only via
  // the Log row's metadata field for downstream audits.
  const metadata = buildIngestLogMetadata(documentId, conversationThreadId)

  const query = `
    MATCH (context:FieldContext {id: $contextId})
    MATCH (person:Person {id: $currentUserId})
    // Re-verify context attachment atomically with the write ($authorId was
    // pre-verified above, but the guard ran in a separate transaction).
    OPTIONAL MATCH (author:Person {id: $authorId})
      WHERE EXISTS { (context)-[:HAS_PERSON]->(author) }
    OPTIONAL MATCH (doc:Document {id: $documentId})
    CREATE (pulse:FieldPulse${pulseLabel} {
      id: $pulseId,
      title: $title,
      content: $content,
      createdAt: datetime(),
      updatedAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $status IS NULL THEN [] ELSE [1] END |
      SET pulse.status = $status
    )
    FOREACH (_ IN CASE WHEN $intensity IS NULL THEN [] ELSE [1] END |
      SET pulse.intensity = $intensity
    )
    FOREACH (_ IN CASE WHEN $horizon IS NULL THEN [] ELSE [1] END |
      SET pulse.horizon = $horizon
    )
    FOREACH (_ IN CASE WHEN $resourceType IS NULL THEN [] ELSE [1] END |
      SET pulse.resourceType = $resourceType
    )
    FOREACH (_ IN CASE WHEN $availability IS NULL THEN [] ELSE [1] END |
      SET pulse.availability = $availability
    )
    FOREACH (_ IN CASE WHEN $why IS NULL THEN [] ELSE [1] END |
      SET pulse.why = $why
    )
    FOREACH (_ IN CASE WHEN $location IS NULL THEN [] ELSE [1] END |
      SET pulse.location = $location
    )
    FOREACH (_ IN CASE WHEN $time IS NULL THEN [] ELSE [1] END |
      SET pulse.time = $time
    )
    FOREACH (_ IN CASE WHEN $sourceUrl IS NULL THEN [] ELSE [1] END |
      SET pulse.sourceUrl = $sourceUrl
    )
    CREATE (context)-[:HAS_PULSE]->(pulse)
    // Canonical author edge: the attributed person when one was verified
    // above, otherwise the acting user. Exactly one INITIATED_BY either way —
    // resolvePulseAuthor reads initiatedBy[0], so the edge must stay single.
    FOREACH (a IN CASE WHEN author IS NULL THEN [person] ELSE [author] END |
      CREATE (pulse)-[:INITIATED_BY]->(a)
    )
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
      SET log.metadata = $metadata
    )
    CREATE (log)-[:CREATED_BY]->(person)
    CREATE (log)-[:LOGGED_FOR]->(pulse)
    FOREACH (_ IN CASE WHEN doc IS NULL THEN [] ELSE [1] END |
      CREATE (pulse)-[:EXTRACTED_FROM]->(doc)
    )
    RETURN pulse.id AS id, pulse.title AS title
    LIMIT 1
  `

  const rows = await graph.query<{ id: string; title: string }>(query, {
    contextId: resolvedContext.contextId,
    currentUserId,
    authorId: attributedAuthor?.id ?? null,
    documentId,
    pulseId,
    logId,
    description,
    metadata,
    title,
    content,
    // GoalPulse.status is non-nullable (GoalStatus!) in the schema. A GoalPulse
    // created without an explicit status must default to ACTIVE, otherwise the
    // node has no status property and every later query of it fails with
    // "Cannot return null for non-nullable field GoalPulse.status".
    status:
      input.status?.trim() ||
      (pulseType === 'GoalPulse' ? 'ACTIVE' : null),
    intensity:
      typeof input.intensity === 'number' && Number.isFinite(input.intensity)
        ? input.intensity
        : null,
    horizon: input.horizon?.trim() || null,
    resourceType: input.resourceType?.trim() || null,
    availability:
      typeof input.availability === 'number' &&
      Number.isFinite(input.availability)
        ? input.availability
        : null,
    why: input.why?.trim() || null,
    location: input.location?.trim() || null,
    time: input.time?.trim() || null,
    sourceUrl: input.sourceUrl?.trim() || null,
  })

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to create pulse.',
    }
  }

  const attributionClause = attributedAuthor
    ? `, attributed to ${attributedAuthor.name}`
    : ''
  return {
    success: true,
    pulseId: rows[0].id,
    title: rows[0].title,
    pulseType,
    contextId: resolvedContext.contextId,
    documentId,
    // Human label for the credited author (Rule 3) — null when the pulse is
    // simply the acting user's own.
    attributedTo: attributedAuthor?.name ?? null,
    message: where
      ? `Added ${humanLabel} "${rows[0].title}" to ${where}${attributionClause}.`
      : `Added ${humanLabel} "${rows[0].title}"${attributionClause}.`,
  }
}

async function deletePulseAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as DeletePulseInput
  const resolved = await resolveAuthorizedPulseId(graph, currentUserId, {
    pulseId: input.pulseId,
    currentTitle: input.currentTitle,
    contextId: input.contextId,
  })
  if (!resolved.ok) return resolved.result

  const pulseId = resolved.pulseId
  const query = `
    MATCH (pulse:FieldPulse {id: $pulseId})
    OPTIONAL MATCH (pulse)-[:HAS_CHUNK]->(chunk:ConversationChunk)
    WITH pulse, pulse.title AS title, collect(DISTINCT chunk) AS chunks
    FOREACH (c IN chunks | DETACH DELETE c)
    DETACH DELETE pulse
    RETURN title, size(chunks) AS deletedChunkCount
  `

  const rows = await graph.query<{ title: string; deletedChunkCount: number }>(
    query,
    { pulseId }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to delete pulse.',
    }
  }

  return {
    success: true,
    pulseId,
    title: rows[0].title,
    deletedChunkCount: Number(rows[0].deletedChunkCount || 0),
    message: `Deleted pulse "${rows[0].title}".`,
  }
}

interface CreatePersonAuthorizedInput {
  firstName?: string
  lastName?: string
  contextId?: string
  contextTitle?: string
  documentId?: string
  conversationThreadId?: string
  /**
   * The current user's relationship to this person, captured at creation and
   * persisted as the `why` on a CONNECTED_TO edge from the user to the new
   * person (GOAL-XXX). Optional — the approval card always ASKS for it, but the
   * user may skip it, in which case no connection edge is created.
   */
  relationshipWhy?: string
  /** Optional shared interests, persisted as CONNECTED_TO.interests. */
  interests?: string
  /**
   * A short relational note about who this person is — persisted on the
   * PersonPulse node's `description`. Distinct from `relationshipWhy` (which
   * captures how the user relates to them). Optional.
   */
  description?: string
  /**
   * GOAL-346: mark the HAS_PERSON edge `curated`, so this person shows on the
   * field's People roster rather than being filed under a source document.
   *
   * Set ONLY by callers where the person is roster membership rather than an
   * incidental mention — today that is the bulk article import crediting a
   * row's AUTHOR, which the member's own spreadsheet named and which
   * `create_pulse`'s attribution guard needs attached. The document
   * extractor's own `create_person` calls must leave this unset; that is the
   * whole distinction the roster filter runs on.
   *
   * It matters because the flag is not otherwise recoverable: since the
   * article import began reading each row's link through the ingest pipeline,
   * the extractor re-encounters the byline and `update_person` stamps
   * EXTRACTED_FROM onto the author, which would evict an uncurated author
   * from the roster of the very field they were imported into.
   */
  curatedRoster?: boolean
}

async function createPersonAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreatePersonAuthorizedInput
  const firstName = input.firstName?.trim() || ''
  const lastName = input.lastName?.trim() || ''
  const contextId = input.contextId?.trim() || ''
  const contextTitle = input.contextTitle?.trim() || ''
  const documentId = input.documentId?.trim() || null
  const conversationThreadId = input.conversationThreadId?.trim() || null
  // GOAL-346 — see CreatePersonAuthorizedInput.curatedRoster. Defaults false,
  // so every existing caller (the assistant, the document extractor) keeps
  // producing uncurated edges and nothing about their behaviour changes.
  const curatedRoster = input.curatedRoster === true
  // The user's relationship to this person — modeled as CONNECTED_TO.why from
  // the current user to the new person. Skippable (null = no edge created).
  const relationshipWhy = input.relationshipWhy?.trim() || null
  const relationshipInterests = input.interests?.trim() || null
  // A short note describing who this person is, stored on the node itself.
  // (Named distinctly from the activity-log `description` built below.)
  const personDescription = input.description?.trim() || null

  if (!firstName) {
    return {
      success: false,
      message: 'create_person requires at least a firstName.',
    }
  }
  if (!contextId) {
    return {
      success: false,
      message: 'create_person requires a contextId.',
    }
  }

  const allowed = await canEditContext(graph, currentUserId, contextId)
  if (!allowed) {
    return {
      success: false,
      message: 'You can only add people to field contexts in spaces you belong to.',
    }
  }

  const name = lastName ? `${firstName} ${lastName}` : firstName
  const where = contextTitle || 'this field context'

  // Self-link (don't duplicate yourself): a document the user uploads almost
  // always names the uploader. The current user already exists as their own
  // Person node, but it's reached through OWNS / INITIATED — not necessarily
  // HAS_PERSON — so the roster-based matcher upstream can't see it and the
  // model proposes a fresh create_person. Catch that here: if the extracted
  // name is the current user, attach THEIR existing node to this context
  // instead of minting a duplicate. We never mutate the account's identity
  // fields and never self-connect (no CONNECTED_TO from you to you). Name match
  // falls back to firstName+lastName because account nodes can have a null
  // `name`. This branch runs before the in-context check so you always win.
  //
  // Authorization note: the `canEditContext` gate above is load-bearing for
  // this write — the self-match query is a global lookup by id with no edge to
  // the context, so a reorder that dropped the gate would let a write land in a
  // context the caller can't edit. Keep the gate first.
  const selfRows = await graph.query<{ id: string; name: string }>(
    `
    MATCH (u:Person {id: $currentUserId})
    WITH u, toLower(trim(coalesce(u.name, trim(coalesce(u.firstName, '') + ' ' + coalesce(u.lastName, ''))))) AS userKey
    WHERE userKey <> '' AND trim($name) <> '' AND userKey = toLower(trim($name))
    RETURN u.id AS id,
           coalesce(u.name, trim(coalesce(u.firstName, '') + ' ' + coalesce(u.lastName, ''))) AS name
    LIMIT 1
    `,
    { currentUserId, name }
  )
  const self = selfRows?.[0] ?? null

  if (self) {
    const selfDocumentFilename = documentId
      ? await lookupDocumentFilename(graph, documentId)
      : null
    const selfFilenameSuffix = selfDocumentFilename
      ? ` (from ${selfDocumentFilename})`
      : ''
    const selfLogId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
    const selfDescription = `Linked ${self.name} (you) to ${where}${selfFilenameSuffix}`
    const selfMetadata = buildIngestLogMetadata(documentId, conversationThreadId)
    await graph.query(
      `
      MATCH (c:FieldContext {id: $contextId})
      MATCH (u:Person {id: $currentUserId})
      OPTIONAL MATCH (d:Document {id: $documentId})
      MERGE (c)-[hp:HAS_PERSON]->(u)
      // GOAL-346: this is the acting user's OWN account being linked to the
      // field they uploaded into — an identity attach, not an extracted
      // mention. It is marked curated so the roster filter keeps them
      // visible: the EXTRACTED_FROM edge stamped just below would otherwise
      // satisfy the hide predicate and remove the uploader from the roster
      // of their own field.
      SET hp.curated = true
      FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
        MERGE (u)-[:EXTRACTED_FROM]->(d)
      )
      CREATE (log:Log {
        id: $selfLogId,
        description: $selfDescription,
        createdAt: datetime()
      })
      FOREACH (_ IN CASE WHEN $selfMetadata IS NULL THEN [] ELSE [1] END |
        SET log.metadata = $selfMetadata
      )
      CREATE (log)-[:CREATED_BY]->(u)
      `,
      {
        contextId,
        currentUserId,
        documentId,
        selfLogId,
        selfDescription,
        selfMetadata,
      }
    )
    return {
      success: true,
      personId: self.id,
      name: self.name,
      contextId,
      documentId,
      alreadyExisted: true,
      // Tell the model this is the uploader's own profile so it confirms a link
      // ("that's you, linked it here") rather than claiming a new person.
      message: `That's you — I linked your profile to ${where} instead of adding a duplicate.`,
    }
  }

  // Idempotency (enrich, don't duplicate): if a person with this name already
  // lives in the target field context, ENRICH them instead of creating a second
  // node. Re-adding "Naa" to North Star twice must not produce two Naa nodes.
  // Matched by canonical name within the context (the unit a person is added to).
  // Falls back to firstName+lastName so migrated nodes with a null `name` match.
  const existingRows = await graph.query<{
    id: string
    name: string | null
    hasDescription: boolean
    hasWhy: boolean
  }>(
    `
    MATCH (c:FieldContext {id: $contextId})-[:HAS_PERSON]->(p:Person:PersonPulse)
    WHERE toLower(trim(coalesce(p.name, trim(coalesce(p.firstName, '') + ' ' + coalesce(p.lastName, ''))))) = toLower(trim($name))
    OPTIONAL MATCH (u:Person {id: $currentUserId})-[rc:CONNECTED_TO]-(p)
    RETURN p.id AS id, p.name AS name,
           (p.description IS NOT NULL AND trim(p.description) <> '') AS hasDescription,
           (rc.why IS NOT NULL AND trim(rc.why) <> '') AS hasWhy
    LIMIT 1
    `,
    { contextId, name, currentUserId }
  )
  const existing = existingRows?.[0] ?? null

  if (existing) {
    // Fill-gaps-only enrichment: only set the description when the existing node
    // has none, and only fill the connection `why`/`interests` when absent
    // (coalesce) — never overwrite a richer existing note with a terser re-add.
    // The CONNECTED_TO edge is ensured either way.
    const setDescription = Boolean(personDescription) && !existing.hasDescription
    const enrichLogId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
    const enrichDescription = `Updated ${existing.name ?? name} in ${where}`
    await graph.query(
      `
      MATCH (p:Person:PersonPulse {id: $existingId})
      MATCH (u:Person {id: $currentUserId})
      FOREACH (_ IN CASE WHEN $setDescription THEN [1] ELSE [] END |
        SET p.description = $personDescription
      )
      SET p.updatedAt = datetime()
      FOREACH (_ IN CASE WHEN $relationshipWhy IS NULL THEN [] ELSE [1] END |
        MERGE (u)-[rc:CONNECTED_TO]-(p)
        SET rc.why = coalesce(rc.why, $relationshipWhy),
            rc.interests = coalesce(rc.interests, $relationshipInterests)
      )
      CREATE (log:Log {
        id: $enrichLogId,
        description: $enrichDescription,
        createdAt: datetime()
      })
      CREATE (log)-[:CREATED_BY]->(u)
      `,
      {
        existingId: existing.id,
        currentUserId,
        setDescription,
        personDescription,
        relationshipWhy,
        relationshipInterests,
        enrichLogId,
        enrichDescription,
      }
    )
    const connectedNow = Boolean(relationshipWhy) || existing.hasWhy
    return {
      success: true,
      personId: existing.id,
      name: existing.name ?? name,
      contextId,
      alreadyExisted: true,
      connectedToYou: connectedNow,
      // Tell the model the person already existed so it confirms an enrichment
      // ("already here, kept their details") rather than a fresh add — and never
      // claims a duplicate was created.
      message: `${existing.name ?? name} is already in ${where}${
        connectedNow ? ' and connected to you' : ''
      } — I kept their existing details rather than adding a duplicate.`,
    }
  }

  const documentFilename = documentId
    ? await lookupDocumentFilename(graph, documentId)
    : null
  const personId = `person_${randomUUID()}`
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  // `name` (canonical display string) and `where` are computed above the
  // idempotency check so both the enrich and create paths share them.
  const filenameSuffix = documentFilename ? ` (from ${documentFilename})` : ''
  // Fold the relationship into the activity log so the audit trail records why
  // the person matters to the user, not just that they were added.
  const connectionClause = relationshipWhy
    ? ` (connected to you as "${relationshipWhy}")`
    : ''
  const description = `Added ${name} to ${where}${filenameSuffix}${connectionClause}`
  const metadata = buildIngestLogMetadata(documentId, conversationThreadId)

  const rows = await graph.query<{ id: string; name: string }>(
    `
    MATCH (c:FieldContext {id: $contextId})
    MATCH (u:Person {id: $currentUserId})
    OPTIONAL MATCH (d:Document {id: $documentId})
    CREATE (p:Person:PersonPulse {
      id: $personId,
      firstName: $firstName,
      lastName: $lastName,
      name: $name,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $personDescription IS NULL THEN [] ELSE [1] END |
      SET p.description = $personDescription
    )
    CREATE (c)-[hp:HAS_PERSON]->(p)
    // GOAL-346: only a caller that says so explicitly (the article import
    // crediting a row's author) marks the edge curated. The document
    // extractor leaves it unset, which is what files its people under the
    // document they came from instead of on the roster.
    FOREACH (_ IN CASE WHEN $curatedRoster THEN [1] ELSE [] END |
      SET hp.curated = true
    )
    // Model the user's relationship to the new person as a CONNECTED_TO edge
    // carrying the why. Only when a relationship was provided — a skipped
    // relationship leaves the person unconnected (per the always-ask-but-
    // skippable decision). MERGE keeps it idempotent on accidental re-runs.
    FOREACH (_ IN CASE WHEN $relationshipWhy IS NULL THEN [] ELSE [1] END |
      MERGE (u)-[rc:CONNECTED_TO]-(p)
      SET rc.why = $relationshipWhy,
          rc.interests = coalesce($relationshipInterests, rc.interests)
    )
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
      SET log.metadata = $metadata
    )
    CREATE (log)-[:CREATED_BY]->(u)
    FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
      CREATE (p)-[:EXTRACTED_FROM]->(d)
    )
    RETURN p.id AS id, p.name AS name
    LIMIT 1
    `,
    {
      contextId,
      currentUserId,
      documentId,
      personId,
      firstName,
      lastName,
      name,
      logId,
      description,
      personDescription,
      metadata,
      relationshipWhy,
      relationshipInterests,
      curatedRoster,
    }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to create the person.',
    }
  }

  return {
    success: true,
    personId: rows[0].id,
    name: rows[0].name,
    contextId,
    documentId,
    connectedToYou: Boolean(relationshipWhy),
    relationshipWhy,
    message: relationshipWhy
      ? `Added ${rows[0].name} to ${where} and connected them to you as "${relationshipWhy}".`
      : `Added ${rows[0].name} to ${where}.`,
  }
}

interface UpdatePersonAuthorizedInput {
  personId?: string
  firstName?: string
  lastName?: string
  currentName?: string
  /**
   * GOAL-314: an optional role/bio phrase for this person carried in from a
   * document. Filled in only when the existing node has no description (never
   * overwrites a richer note).
   */
  description?: string
  contextId?: string
  contextTitle?: string
  documentId?: string
  conversationThreadId?: string
}

async function updatePersonAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as UpdatePersonAuthorizedInput
  const personId = input.personId?.trim() || ''
  const firstName = input.firstName?.trim() || ''
  const lastName = input.lastName?.trim() || ''
  const contextId = input.contextId?.trim() || ''
  const contextTitle = input.contextTitle?.trim() || ''
  const documentId = input.documentId?.trim() || null
  const conversationThreadId = input.conversationThreadId?.trim() || null

  if (!personId) {
    return {
      success: false,
      message: 'update_person requires a personId.',
    }
  }

  // Auth check: the user must be able to edit *some* FieldContext that
  // hosts this person. Passing the contextId from the synthesized turn keeps
  // the gate aligned with the ingest path (the document was uploaded into
  // that FieldContext, so it is also where the existing person lives).
  if (contextId) {
    const allowed = await canEditContext(graph, currentUserId, contextId)
    if (!allowed) {
      return {
        success: false,
        message:
          'You can only edit people in field contexts in spaces you belong to.',
      }
    }
  } else {
    const allowedRows = await graph.query<{ allowed: boolean }>(
      `
      MATCH (space:Space)-[:HAS_CONTEXT]->(:FieldContext)-[:HAS_PERSON]->(p:Person {id: $personId})
      OPTIONAL MATCH (owner:Person {id: $currentUserId})-[:OWNS]->(space)
      OPTIONAL MATCH (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(member:Person {id: $currentUserId})
      WITH (owner IS NOT NULL OR member IS NOT NULL) AS allowed
      RETURN allowed
      LIMIT 1
      `,
      { personId, currentUserId }
    )
    if (!allowedRows?.[0]?.allowed) {
      return {
        success: false,
        message:
          'You can only edit people in field contexts in spaces you belong to.',
      }
    }
  }

  const newFirstName = firstName || null
  const newLastName = lastName || null
  const hasNameChange = Boolean(newFirstName || newLastName)
  // GOAL-314: fill-gaps-only — a description from this document is applied only
  // when the node currently has none, so a richer existing note is never lost.
  const newDescription = input.description?.trim() || null

  const documentFilename = documentId
    ? await lookupDocumentFilename(graph, documentId)
    : null
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const composedName = [firstName, lastName].filter(Boolean).join(' ').trim()
  const displayName =
    composedName || input.currentName?.trim() || 'person'
  const where = contextTitle || 'this field context'
  const filenameSuffix = documentFilename ? ` (from ${documentFilename})` : ''
  const description = `Updated ${displayName} in ${where}${filenameSuffix}`
  const metadata = buildIngestLogMetadata(documentId, conversationThreadId)

  const rows = await graph.query<{
    id: string
    firstName: string | null
    lastName: string | null
    name: string | null
  }>(
    `
    MATCH (p:Person {id: $personId})
    MATCH (u:Person {id: $currentUserId})
    OPTIONAL MATCH (d:Document {id: $documentId})
    FOREACH (_ IN CASE WHEN $newFirstName IS NULL THEN [] ELSE [1] END |
      SET p.firstName = $newFirstName
    )
    FOREACH (_ IN CASE WHEN $newLastName IS NULL THEN [] ELSE [1] END |
      SET p.lastName = $newLastName
    )
    FOREACH (_ IN CASE WHEN NOT $hasNameChange THEN [] ELSE [1] END |
      SET p.name = trim(coalesce(p.firstName, '') + ' ' + coalesce(p.lastName, ''))
    )
    // Fill-gaps-only: set the description from this document only when the
    // person has none, so a re-encountered contact gains detail without a
    // terser re-mention clobbering a richer existing note.
    FOREACH (_ IN CASE WHEN $newDescription IS NOT NULL AND (p.description IS NULL OR trim(p.description) = '') THEN [1] ELSE [] END |
      SET p.description = $newDescription
    )
    SET p.updatedAt = datetime()
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
      SET log.metadata = $metadata
    )
    CREATE (log)-[:CREATED_BY]->(u)
    FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
      MERGE (p)-[:EXTRACTED_FROM]->(d)
    )
    RETURN p.id AS id, p.firstName AS firstName, p.lastName AS lastName, p.name AS name
    LIMIT 1
    `,
    {
      personId,
      currentUserId,
      documentId,
      newFirstName,
      newLastName,
      hasNameChange,
      newDescription,
      logId,
      description,
      metadata,
    }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to update the person.',
    }
  }

  return {
    success: true,
    personId: rows[0].id,
    name: rows[0].name || displayName,
    contextId,
    documentId,
    message: `Updated ${rows[0].name || displayName} in ${where}.`,
  }
}

interface PersonLocatorInput {
  personId?: string
  personName?: string
}

/**
 * Resolve a Person the current user is allowed to connect, by id or name.
 * "Allowed" = the current user THEMSELVES (the from-endpoint default), OR a
 * `PersonPulse` (a relational-world person, never another registered User)
 * attached (HAS_PERSON) to a FieldContext inside a Space the user owns or is a
 * member of. Restricting non-self targets to `PersonPulse` keeps the assistant
 * from writing an undirected CONNECTED_TO edge onto another real account that
 * never consented — and matches the scoping suggest_connections already uses.
 *
 * Two query shapes: an index-seek by id (the hot path — the suggestion-accept
 * card always passes resolved ids) and a name scan (PersonPulse only) that also
 * returns the owning Space name so same-name matches can be disambiguated by
 * the model (Rule 1 — names only, never ids).
 */
async function resolveEditablePerson(
  graph: Neo4jGraph,
  currentUserId: string,
  input: PersonLocatorInput
): Promise<
  | { ok: true; personId: string; name: string }
  | { ok: false; result: ToolExecutionResult }
> {
  const personId = input.personId?.trim() || null
  const personName = input.personName?.trim() || null

  if (!personId && !personName) {
    return {
      ok: false,
      result: {
        success: false,
        message: 'Provide a person id or name to identify who to connect.',
      },
    }
  }

  if (personId) {
    const rows = await graph.query<{ id: string; name: string | null }>(
      `
      MATCH (target:Person {id: $personId})
      WHERE target.id = $currentUserId
         OR (target:PersonPulse AND EXISTS {
              MATCH (target)<-[:HAS_PERSON]-(:FieldContext)<-[:HAS_CONTEXT]-(space:Space)
              WHERE (space)<-[:OWNS]-(:Person {id: $currentUserId})
                 OR (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $currentUserId})
            })
      RETURN target.id AS id, target.name AS name
      LIMIT 1
      `,
      { personId, currentUserId }
    )
    if (!rows || rows.length === 0) {
      return {
        ok: false,
        result: {
          success: false,
          message:
            'That person could not be found, or you do not have access to them.',
        },
      }
    }
    return { ok: true, personId: rows[0].id, name: rows[0].name || 'person' }
  }

  const rows = await graph.query<{
    id: string
    name: string | null
    spaceName: string | null
  }>(
    `
    MATCH (target:Person:PersonPulse)
    WHERE toLower(trim(coalesce(target.name, ''))) = toLower(trim($personName))
    MATCH (target)<-[:HAS_PERSON]-(:FieldContext)<-[:HAS_CONTEXT]-(space:Space)
    WHERE (space)<-[:OWNS]-(:Person {id: $currentUserId})
       OR (space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $currentUserId})
    WITH target, head(collect(DISTINCT space.name)) AS spaceName
    RETURN target.id AS id, target.name AS name, spaceName
    LIMIT 5
    `,
    { personName, currentUserId }
  )

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        message: `No person named "${personName}" that you can connect was found.`,
      },
    }
  }

  if (rows.length > 1) {
    return {
      ok: false,
      result: {
        success: false,
        requiresDisambiguation: true,
        message: `More than one person named "${personName}" — tell me which one (e.g. the one in a particular space) or open their profile and connect from there.`,
        // Names + owning-space names only (Rule 1 — never ids) so the model can
        // help the user pick between same-named people.
        candidates: rows.map((r) => ({ name: r.name, space: r.spaceName })),
      },
    }
  }

  return { ok: true, personId: rows[0].id, name: rows[0].name || 'person' }
}

interface CreateConnectionAuthorizedInput {
  fromPersonId?: string
  fromPersonName?: string
  toPersonId?: string
  toPersonName?: string
  why?: string
  interests?: string
}

interface CreateOrganizationAuthorizedInput {
  name?: string
  description?: string
  contextId?: string
  contextTitle?: string
  documentId?: string
  conversationThreadId?: string
}

/**
 * GOAL-298 — create a first-class :Organization:LifeSensor:RelationalEntity
 * (an org/group/company/cooperative named in an uploaded document) and attach
 * it to the FieldContext via HAS_ORGANIZATION, so members can discover and
 * connect with it. Mirrors createPersonAuthorized: `canEditContext` gate,
 * name-in-context idempotency (enrich, don't duplicate), one :Log per write,
 * and EXTRACTED_FROM provenance to the source Document.
 */
async function createOrganizationAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreateOrganizationAuthorizedInput
  const name = input.name?.trim() || ''
  const contextId = input.contextId?.trim() || ''
  const contextTitle = input.contextTitle?.trim() || ''
  const documentId = input.documentId?.trim() || null
  const conversationThreadId = input.conversationThreadId?.trim() || null
  const orgDescription = input.description?.trim() || null

  if (!name) {
    return { success: false, message: 'create_organization requires a name.' }
  }
  if (!contextId) {
    return { success: false, message: 'create_organization requires a contextId.' }
  }

  const allowed = await canEditContext(graph, currentUserId, contextId)
  if (!allowed) {
    return {
      success: false,
      message:
        'You can only add organizations to field contexts in spaces you belong to.',
    }
  }

  const where = contextTitle || 'this field context'

  // Idempotency (enrich, don't duplicate): a same-named org already attached to
  // this context is enriched (fill-gaps-only description) rather than duplicated.
  const existingRows = await graph.query<{
    id: string
    name: string | null
    hasDescription: boolean
  }>(
    `
    MATCH (c:FieldContext {id: $contextId})-[:HAS_ORGANIZATION]->(o:Organization)
    WHERE toLower(trim(coalesce(o.name, ''))) = toLower(trim($name))
    RETURN o.id AS id, o.name AS name,
           (o.description IS NOT NULL AND trim(o.description) <> '') AS hasDescription
    LIMIT 1
    `,
    { contextId, name }
  )
  const existing = existingRows?.[0] ?? null

  if (existing) {
    const setDescription = Boolean(orgDescription) && !existing.hasDescription
    const enrichLogId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
    const enrichDescription = `Updated organization ${existing.name ?? name} in ${where}`
    const enrichMetadata = buildIngestLogMetadata(documentId, conversationThreadId)
    await graph.query(
      `
      MATCH (o:Organization {id: $existingId})
      MATCH (u:Person {id: $currentUserId})
      OPTIONAL MATCH (d:Document {id: $documentId})
      FOREACH (_ IN CASE WHEN $setDescription THEN [1] ELSE [] END |
        SET o.description = $orgDescription
      )
      SET o.updatedAt = datetime()
      FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
        MERGE (o)-[:EXTRACTED_FROM]->(d)
      )
      CREATE (log:Log {
        id: $enrichLogId,
        description: $enrichDescription,
        createdAt: datetime()
      })
      FOREACH (_ IN CASE WHEN $enrichMetadata IS NULL THEN [] ELSE [1] END |
        SET log.metadata = $enrichMetadata
      )
      CREATE (log)-[:CREATED_BY]->(u)
      `,
      {
        existingId: existing.id,
        currentUserId,
        documentId,
        setDescription,
        orgDescription,
        enrichLogId,
        enrichDescription,
        enrichMetadata,
      }
    )
    return {
      success: true,
      organizationId: existing.id,
      name: existing.name ?? name,
      contextId,
      documentId,
      alreadyExisted: true,
      message: `${existing.name ?? name} is already in ${where} — I kept its existing details rather than adding a duplicate.`,
    }
  }

  const organizationId = `organization_${randomUUID()}`
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const documentFilename = documentId
    ? await lookupDocumentFilename(graph, documentId)
    : null
  const filenameSuffix = documentFilename ? ` (from ${documentFilename})` : ''
  const description = `Added organization ${name} to ${where}${filenameSuffix}`
  const metadata = buildIngestLogMetadata(documentId, conversationThreadId)

  const rows = await graph.query<{ id: string; name: string }>(
    `
    MATCH (c:FieldContext {id: $contextId})
    MATCH (u:Person {id: $currentUserId})
    OPTIONAL MATCH (d:Document {id: $documentId})
    CREATE (o:Organization:LifeSensor:RelationalEntity {
      id: $organizationId,
      name: $name,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $orgDescription IS NULL THEN [] ELSE [1] END |
      SET o.description = $orgDescription
    )
    CREATE (c)-[:HAS_ORGANIZATION]->(o)
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
      SET log.metadata = $metadata
    )
    CREATE (log)-[:CREATED_BY]->(u)
    FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
      CREATE (o)-[:EXTRACTED_FROM]->(d)
    )
    RETURN o.id AS id, o.name AS name
    LIMIT 1
    `,
    {
      contextId,
      currentUserId,
      documentId,
      organizationId,
      name,
      orgDescription,
      logId,
      description,
      metadata,
    }
  )

  if (!rows || rows.length === 0) {
    return { success: false, message: 'Failed to create the organization.' }
  }

  return {
    success: true,
    organizationId: rows[0].id,
    name: rows[0].name,
    contextId,
    documentId,
    message: `Added ${rows[0].name} to ${where}.`,
  }
}

interface LinkEntityToPulseAuthorizedInput {
  entityType?: 'person' | 'organization'
  personId?: string
  organizationId?: string
  pulseId?: string
  entityName?: string
  pulseTitle?: string
  pulseType?: string
  contextId?: string
  contextTitle?: string
  documentId?: string
  conversationThreadId?: string
}

/**
 * GOAL-298 — link a Person or Organization to a FieldPulse via MENTIONED_IN
 * (the person/org was named in / related to the pulse, but is NOT its author;
 * authorship stays on INITIATED_BY). The ingest orchestrator resolves the live
 * `personId`/`organizationId` + `pulseId` from the earlier create_* results
 * before calling this — the executor runs on exact ids (deterministic HITL).
 *
 * Authorization: the caller must be able to edit the pulse's Space
 * (`canEditPulse`), AND the entity must already be attached
 * (HAS_PERSON / HAS_ORGANIZATION) to a FieldContext that holds the pulse — so a
 * link can never reach across Space boundaries or fabricate a cross-context
 * relationship. Writes one :Log attributed to the acting user.
 */
async function linkEntityToPulseAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as LinkEntityToPulseAuthorizedInput
  const entityType = input.entityType === 'organization' ? 'organization' : 'person'
  const entityId =
    (entityType === 'organization'
      ? input.organizationId?.trim()
      : input.personId?.trim()) || ''
  const pulseId = input.pulseId?.trim() || ''
  const entityName = input.entityName?.trim() || (entityType === 'organization' ? 'organization' : 'person')
  const documentId = input.documentId?.trim() || null
  const conversationThreadId = input.conversationThreadId?.trim() || null

  if (!entityId || !pulseId) {
    return {
      success: false,
      message:
        'link_entity_to_pulse requires a resolved entity id and pulse id.',
    }
  }

  const allowed = await canEditPulse(graph, currentUserId, pulseId)
  if (!allowed) {
    return {
      success: false,
      message: 'You can only connect entities to pulses in spaces you belong to.',
    }
  }

  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const metadata = buildIngestLogMetadata(documentId, conversationThreadId)

  // The MENTIONED_IN edge is only written when the entity is already attached to
  // a context that holds the pulse (co-location guard). MERGE keeps it
  // idempotent across re-extracts.
  //
  // The entity node is matched UNTYPED (`(entity {id: $entityId})`) on purpose:
  // it may be a :Person or an :Organization, and the `HAS_PERSON|HAS_ORGANIZATION`
  // relationship it's reached through already bounds it to exactly those two
  // labels attached to this context — so the untyped match is safe, not a global
  // scan. Do NOT "fix" this by pinning a single label; that would drop org
  // support. (`entityType` is advisory — used only for the return shape/copy;
  // the co-location MATCH is the authority on what may be linked.) This
  // polymorphic-match + same-statement CREATE is the source of an Eager operator
  // in the plan; it's accepted because the materialised set is just this
  // context's roster (bounded), and this is a per-ingest write, not a hot read.
  const rows = await graph.query<{
    entityId: string
    name: string | null
    pulseTitle: string | null
  }>(
    `
    MATCH (pulse:FieldPulse {id: $pulseId})
    MATCH (ctx:FieldContext)-[:HAS_PULSE]->(pulse)
    MATCH (ctx)-[:HAS_PERSON|HAS_ORGANIZATION]->(entity {id: $entityId})
    MATCH (u:Person {id: $currentUserId})
    MERGE (entity)-[:MENTIONED_IN]->(pulse)
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
      SET log.metadata = $metadata
    )
    CREATE (log)-[:CREATED_BY]->(u)
    CREATE (log)-[:LOGGED_FOR]->(pulse)
    RETURN entity.id AS entityId,
           coalesce(entity.name, trim(coalesce(entity.firstName, '') + ' ' + coalesce(entity.lastName, ''))) AS name,
           pulse.title AS pulseTitle
    LIMIT 1
    `,
    {
      pulseId,
      entityId,
      currentUserId,
      logId,
      // The Log description uses the extractor-supplied name/title (Rule-1 safe:
      // names only, never ids). It is intentionally NOT the graph-canonical
      // name resolved in the RETURN below — the LOGGED_FOR edge points at the
      // real pulse, so audit linkage is exact regardless of the display string.
      description: `Connected ${entityName} to "${input.pulseTitle?.trim() || 'a pulse'}"`,
      metadata,
    }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: `Could not connect ${entityName} to the pulse — they must share a field context you can edit.`,
    }
  }

  const linkedName = rows[0].name?.trim() || entityName
  const linkedTitle = rows[0].pulseTitle?.trim() || input.pulseTitle?.trim() || 'the pulse'
  return {
    success: true,
    entityType,
    entityId: rows[0].entityId,
    pulseId,
    name: linkedName,
    title: linkedTitle,
    message: `Connected ${linkedName} to "${linkedTitle}".`,
  }
}

/**
 * Create (or refresh) a CONNECTED_TO edge between two people the current user
 * is allowed to connect. `from` defaults to the current user — the common case
 * is "connect me to <person>" with a relationship why. Both endpoints are
 * authorized via resolveEditablePerson. Writes a single activity Log attributed
 * to the user (the GraphQL connection resolver skips logging; the assistant
 * path must not — activity logging is mandatory on mutations).
 *
 * `why` / `interests` are coalesced, so re-connecting without re-stating the
 * metadata never wipes an existing edge's why.
 */
async function createConnectionAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreateConnectionAuthorizedInput
  const why = input.why?.trim() || null
  const interests = input.interests?.trim() || null

  // `from` defaults to the current user when neither id nor name is given.
  const fromHasLocator = Boolean(
    input.fromPersonId?.trim() || input.fromPersonName?.trim()
  )
  const fromResolved = await resolveEditablePerson(
    graph,
    currentUserId,
    fromHasLocator
      ? { personId: input.fromPersonId, personName: input.fromPersonName }
      : { personId: currentUserId }
  )
  if (!fromResolved.ok) return fromResolved.result

  const toResolved = await resolveEditablePerson(graph, currentUserId, {
    personId: input.toPersonId,
    personName: input.toPersonName,
  })
  if (!toResolved.ok) return toResolved.result

  if (fromResolved.personId === toResolved.personId) {
    return {
      success: false,
      message: 'You cannot connect a person to themselves.',
    }
  }

  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const whyClause = why ? ` — "${why}"` : ''
  const description = `Connected ${fromResolved.name} with ${toResolved.name}${whyClause}`

  const rows = await graph.query<{
    fromName: string | null
    toName: string | null
    why: string | null
  }>(
    // Both endpoint ids are already authorized above via resolveEditablePerson
    // (self or a PersonPulse in an editable Space), so this id-anchored write is
    // safe; it does not re-scope by Space.
    `
    MATCH (from:Person {id: $fromId})
    MATCH (to:Person {id: $toId})
    MATCH (actor:Person {id: $currentUserId})
    MERGE (from)-[r:CONNECTED_TO]-(to)
    SET r.why = coalesce($why, r.why),
        r.interests = coalesce($interests, r.interests)
    CREATE (log:Log {
      id: $logId,
      description: $description,
      createdAt: datetime()
    })
    CREATE (log)-[:CREATED_BY]->(actor)
    RETURN from.name AS fromName, to.name AS toName, r.why AS why
    LIMIT 1
    `,
    {
      fromId: fromResolved.personId,
      toId: toResolved.personId,
      currentUserId,
      why,
      interests,
      logId,
      description,
    }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to create the connection.',
    }
  }

  const fromName = rows[0].fromName || fromResolved.name
  const toName = rows[0].toName || toResolved.name
  return {
    success: true,
    fromName,
    toName,
    why: rows[0].why ?? null,
    message: `Connected ${fromName} with ${toName}.`,
  }
}

interface CreateResonanceAuthorizedInput {
  sourcePulseId?: string
  targetPulseId?: string
  // The active field context — preferred anchor for HAS_RESONANCE so the link is
  // visible through Space-scoped reads. The write falls back to any context that
  // holds both pulses if this is absent or doesn't hold both.
  contextId?: string
  label?: string
  why?: string
  // sourceName/targetName are display-only (used for the approval card copy via
  // describeWriteAction); the write itself reads titles from the graph.
  sourceName?: string
  targetName?: string
}

/**
 * Promote an assistant-surfaced resonance between two existing pulses into a
 * ResonanceLink. Mirrors the accept-suggestion endpoint's link creation, but is
 * driven directly by the HITL card (the card IS the gate) so it does not require
 * a pre-existing ResonanceSuggestion. Both endpoints are authorized via
 * canEditPulse; the write is idempotent (symmetric dedup) and logs an activity
 * entry attributed to the acting user.
 */
async function createResonanceAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreateResonanceAuthorizedInput
  const sourcePulseId = String(input.sourcePulseId || '').trim()
  const targetPulseId = String(input.targetPulseId || '').trim()
  const contextId = String(input.contextId || '').trim() || null
  // ResonanceLink.label is non-null in the schema (String!), so never persist
  // null — fall back to a generic theme when the model gave only a `why`.
  const label = (input.label || '').trim() || 'Resonance'
  const why = (input.why || '').trim() || null

  if (!sourcePulseId || !targetPulseId) {
    return {
      success: false,
      message: 'Two pulses are needed to record a resonance.',
    }
  }
  if (sourcePulseId === targetPulseId) {
    return {
      success: false,
      message: 'A pulse cannot resonate with itself.',
    }
  }

  // Authorize BOTH endpoints — each pulse must live in a Space the user can
  // edit (owner / ADMIN / MEMBER). Same gate every other pulse write uses.
  const [canSource, canTarget] = await Promise.all([
    canEditPulse(graph, currentUserId, sourcePulseId),
    canEditPulse(graph, currentUserId, targetPulseId),
  ])
  if (!canSource || !canTarget) {
    return {
      success: false,
      message: 'You can only connect pulses in spaces you belong to.',
    }
  }

  const linkId = `rl_${randomUUID()}`
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`

  // Resonances are semantically symmetric — dedup in BOTH directions. If a link
  // already exists, treat as an idempotent success rather than duplicating it.
  // The Log description is built from the pulses' own titles server-side so no
  // id ever reaches the activity feed (Rule 1).
  const rows = await graph.query<{
    sourceName: string | null
    targetName: string | null
    alreadyLinked: boolean
    anchored: boolean
  }>(
    `
    MATCH (source:FieldPulse {id: $sourcePulseId})
    MATCH (target:FieldPulse {id: $targetPulseId})
    MATCH (actor:Person {id: $currentUserId})

    // Anchor context for HAS_RESONANCE (required for the link to be visible
    // through Space-scoped reads). Prefer the active context when it holds both
    // pulses, else any context that holds both.
    OPTIONAL MATCH (preferred:FieldContext {id: $contextId})
    WHERE (preferred)-[:HAS_PULSE]->(source) AND (preferred)-[:HAS_PULSE]->(target)
    OPTIONAL MATCH (shared:FieldContext)-[:HAS_PULSE]->(source)
    WHERE (shared)-[:HAS_PULSE]->(target)

    // Symmetric existence check, anchored on the two (index-bound) pulses — a
    // ResonanceLink touching BOTH is a duplicate regardless of direction.
    OPTIONAL MATCH (source)<-[:SOURCE|TARGET]-(existing:ResonanceLink)-[:SOURCE|TARGET]->(target)

    WITH source, target, actor, existing,
         coalesce(preferred, shared) AS ctx,
         coalesce(source.title, source.content, 'a pulse') AS sourceLabel,
         coalesce(target.title, target.content, 'another pulse') AS targetLabel
    FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
      CREATE (link:ResonanceLink {
        id: $linkId,
        label: $label,
        description: $why,
        status: 'confirmed',
        reviewedBy: $currentUserId,
        reviewedAt: datetime(),
        createdAt: datetime(),
        createdVia: 'assistant'
      })
      CREATE (link)-[:SOURCE]->(source)
      CREATE (link)-[:TARGET]->(target)
      // Anchor to the shared context so the resonance is visible (HAS_RESONANCE).
      FOREACH (c IN CASE WHEN ctx IS NULL THEN [] ELSE [ctx] END |
        CREATE (c)-[:HAS_RESONANCE]->(link)
      )
      CREATE (log:Log {
        id: $logId,
        description: 'Recorded a resonance between "' + sourceLabel + '" and "' + targetLabel + '"',
        createdAt: datetime()
      })
      CREATE (log)-[:CREATED_BY]->(actor)
      CREATE (log)-[:LOGGED_FOR]->(source)
      CREATE (log)-[:LOGGED_FOR]->(target)
    )
    RETURN sourceLabel AS sourceName,
           targetLabel AS targetName,
           existing IS NOT NULL AS alreadyLinked,
           ctx IS NOT NULL AS anchored
    LIMIT 1
    `,
    {
      sourcePulseId,
      targetPulseId,
      currentUserId,
      contextId,
      linkId,
      label,
      why,
      logId,
    }
  )

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Could not find both pulses to connect.',
    }
  }

  const sourceName = rows[0].sourceName || 'a pulse'
  const targetName = rows[0].targetName || 'another pulse'
  if (!rows[0].alreadyLinked && !rows[0].anchored) {
    // Created without a HAS_RESONANCE anchor — the two pulses share no common
    // FieldContext, so the link will not surface through Space-scoped reads.
    // Should not happen via suggest_resonances (it resolves both within one
    // context); log for ops if it ever does.
    console.warn(
      `[create_resonance] Linked "${sourceName}" and "${targetName}" with no shared context — resonance will be invisible until anchored.`
    )
  }
  if (rows[0].alreadyLinked) {
    return {
      success: true,
      sourceName,
      targetName,
      alreadyLinked: true,
      message: `"${sourceName}" and "${targetName}" are already connected.`,
    }
  }

  return {
    success: true,
    sourceName,
    targetName,
    why,
    message: `Connected "${sourceName}" and "${targetName}" as a resonance.`,
  }
}

interface CreateResonantPulseAuthorizedInput {
  // New pulse (created via createPulseAuthorized — inherits its validation,
  // type allow-list, idempotency, auth and logging).
  pulseType?: string
  title?: string
  content?: string
  contextId?: string
  contextTitle?: string
  spaceName?: string
  // Existing pulse to resonate the new one with.
  resonateWithPulseId?: string
  resonateWithName?: string
  // Resonance metadata.
  label?: string
  why?: string
}

/**
 * Capture a NEW pulse from the conversation AND connect it as a resonance to an
 * EXISTING pulse, in one human-approved action. Composes the two already-audited
 * authorized writes: createPulseAuthorized (creates/enriches the pulse, gated on
 * the context) then createResonanceAuthorized (links it, gated on both pulses).
 * Both steps log; the resonance is anchored to the context (HAS_RESONANCE).
 *
 * Not atomic by design: if the link step fails the captured pulse still stands
 * (a valid outcome — the user can link it later), and we say so rather than
 * rolling back a legitimately-created pulse.
 */
async function createResonantPulseAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as CreateResonantPulseAuthorizedInput
  const resonateWithPulseId = String(input.resonateWithPulseId || '').trim()
  if (!resonateWithPulseId) {
    return {
      success: false,
      message: 'No existing pulse to connect the new one to.',
    }
  }

  // 1. Create (or idempotently enrich) the new pulse. Pulse-level fields only —
  //    the resonance `why`/`label` belong to the link, not the pulse body.
  const pulseResult = await createPulseAuthorized(graph, currentUserId, {
    pulseType: input.pulseType,
    title: input.title,
    content: input.content,
    contextId: input.contextId,
    contextTitle: input.contextTitle,
    spaceName: input.spaceName,
  })
  if (!pulseResult.success) return pulseResult

  const newPulseId =
    typeof pulseResult.pulseId === 'string' ? pulseResult.pulseId : ''
  const newName =
    typeof pulseResult.title === 'string' && pulseResult.title.trim()
      ? pulseResult.title.trim()
      : (input.title || 'the new pulse').trim()
  if (!newPulseId) {
    return {
      success: false,
      message: 'Could not create the pulse to connect.',
    }
  }

  // 2. Link the new pulse to the existing one via the reviewed resonance write.
  const resoResult = await createResonanceAuthorized(graph, currentUserId, {
    sourcePulseId: newPulseId,
    targetPulseId: resonateWithPulseId,
    contextId: input.contextId,
    label: input.label,
    why: input.why,
  })

  const existingName =
    typeof resoResult.targetName === 'string' && resoResult.targetName.trim()
      ? resoResult.targetName.trim()
      : (input.resonateWithName || 'the other pulse').trim()

  if (!resoResult.success) {
    // Pulse created, link failed — surface the partial outcome honestly.
    return {
      success: true,
      partial: true,
      pulseId: newPulseId,
      sourceName: newName,
      message: `Captured "${newName}", but couldn't connect it as a resonance — you can link it from the field.`,
    }
  }

  return {
    success: true,
    pulseId: newPulseId,
    sourceName: newName,
    targetName: existingName,
    message: `Captured "${newName}" and connected it to "${existingName}" as a resonance.`,
  }
}

interface ProposePromiseWeaveAuthorizedInput {
  /**
   * Anchor FieldContext. The tool wrapper injects it from session state rather
   * than accepting it from the model — but that is model-scoping, NOT the
   * boundary: `fieldContextId` arrives on the request body, and the approval
   * round-trip replays client-supplied args verbatim. **`canEditContext` below
   * is the boundary.** Do not relax it on the strength of the injection.
   */
  contextId?: string
  /** Display-only, for the approval-card copy (Rule 1). */
  contextTitle?: string
  /** Pulses the proposal would weave. Must all hang off `contextId`. */
  pulseIds?: string[]
  /** Display-only pulse titles for the approval card (Rule 1). */
  pulseTitles?: string[]
  /** Optional Person the weave is WOVEN_FOR — must be on the context roster. */
  wovenForPersonId?: string
  /** Display-only, for the approval card (Rule 1). */
  wovenForName?: string
  title?: string
  /** Evidence the assistant cites — persisted as the weave's `description`. */
  why?: string
}

/** Keeps approval cards and Log prose readable, and caps the write's fan-out. */
export const MAX_PROPOSED_WEAVE_PULSES = 10

/**
 * Propose a PromiseWeave over pulses that already share a FieldContext
 * (GOAL-342). Written server-side in raw Cypher rather than through
 * `createPromiseWeaves`, because that mutation's CREATE rule requires a
 * `createdBy` edge pointing at the caller and an AI-proposed weave has no
 * member author — see the note on the type in `schema.gql`.
 *
 * TWO gates stand between the model and an established connection, and both
 * are load-bearing:
 *
 * 1. This only ever runs from `runWriteTool`, so the member approves the
 *    proposal on the HITL card before a node is written at all.
 * 2. What it writes is `status: 'proposed'` / `origin: 'ai'` — never `active`.
 *    A proposal is not an established weave: it renders behind the inline
 *    Confirm / Dismiss gate in the field's "Promise weaves" section
 *    (kb/04-state-machines.md), and only a member's Confirm promotes it.
 *
 * Authorization is re-derived here and never trusted from the caller:
 * `canEditContext` (Owner / ADMIN / MEMBER — a GUEST is refused, kb/02), and
 * then the write itself only reaches pulses this very context `HAS_PULSE` and
 * a person it `HAS_PERSON`. So the weave cannot cross a Space boundary even if
 * the model hands over ids from somewhere else — those ids simply match
 * nothing, rather than being reported as forbidden.
 */
/**
 * Resolve the DISPLAY strings for a weave proposal's approval card — the pulse
 * titles and the person's name — from the graph, scoped to the anchor field.
 *
 * The card is the gate, so it must not be describable by the model. Left to
 * itself the model supplies `pulseTitles` / `wovenForName` freely and nothing
 * cross-checks them against the ids that actually get woven: text reaching it
 * from a field or an ingested document could have it pass ten ids and two
 * titles, and the member would approve a ten-pulse weave having been shown
 * two — or approve one "for Alice" that is woven for Bob. Resolving here means
 * the card can only ever name what the write will actually touch.
 *
 * Gated on `canEditContext` FIRST: `contextId` arrives from the request body,
 * so reading titles out of it unconditionally would itself be a leak. On
 * refusal this returns empty display values and lets the write produce the
 * real refusal, rather than distinguishing "not a member" from "no such field".
 */
export async function resolveWeaveProposalDisplay(
  graph: Neo4jGraph,
  currentUserId: string | null,
  input: { contextId?: string; pulseIds?: string[]; wovenForPersonId?: string }
): Promise<{ pulseTitles: string[]; wovenForName?: string }> {
  const contextId = String(input.contextId || '').trim()
  const pulseIds = (Array.isArray(input.pulseIds) ? input.pulseIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean)
  const wovenForPersonId = String(input.wovenForPersonId || '').trim() || null

  if (!currentUserId || !contextId || pulseIds.length === 0) {
    return { pulseTitles: [] }
  }
  if (!(await canEditContext(graph, currentUserId, contextId))) {
    return { pulseTitles: [] }
  }

  const rows = await graph.query<{
    pulseTitles: string[]
    wovenForName: string | null
  }>(
    `
    MATCH (context:FieldContext {id: $contextId})
    CALL {
      WITH context
      UNWIND $pulseIds AS wantedId
      OPTIONAL MATCH (pulse:FieldPulse {id: wantedId})
      WHERE (context)-[:HAS_PULSE]->(pulse)
      RETURN collect(DISTINCT
        CASE
          WHEN trim(coalesce(pulse.title, '')) <> '' THEN pulse.title
          ELSE coalesce(pulse.content, 'a pulse')
        END
      ) AS pulseTitles
    }
    OPTIONAL MATCH (context)-[:HAS_PERSON]->(person:Person)
    WHERE $wovenForPersonId IS NOT NULL AND person.id = $wovenForPersonId
    RETURN pulseTitles, head(collect(person.name)) AS wovenForName
    LIMIT 1
    `,
    { contextId, pulseIds, wovenForPersonId }
  )

  const row = rows?.[0]
  const titles = Array.isArray(row?.pulseTitles)
    ? row.pulseTitles.filter(
        (title): title is string =>
          typeof title === 'string' && title.trim().length > 0
      )
    : []
  const name = row?.wovenForName?.trim()
  return { pulseTitles: titles, ...(name ? { wovenForName: name } : {}) }
}

async function proposePromiseWeaveAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = args as ProposePromiseWeaveAuthorizedInput
  const contextId = String(input.contextId || '').trim()
  const contextTitle = String(input.contextTitle || '').trim()
  const title = String(input.title || '').trim() || null
  const why = String(input.why || '').trim() || null
  const wovenForPersonId = String(input.wovenForPersonId || '').trim() || null

  // Dedupe before the write, so a repeated id cannot inflate the Log prose or
  // the WEAVES fan-out. The UNCAPPED unique count is kept: ids dropped by the
  // cap are "left out" just as surely as ids from another field, and the member
  // is told about both. (The tool's zod schema rejects >cap first, but
  // executeAuthorizedWriteTool is reachable on its own.)
  const requestedPulseIds = Array.from(
    new Set(
      (Array.isArray(input.pulseIds) ? input.pulseIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    )
  )
  const pulseIds = requestedPulseIds.slice(0, MAX_PROPOSED_WEAVE_PULSES)

  if (!contextId) {
    return {
      success: false,
      message: 'Open a field first — a promise weave is anchored in one.',
    }
  }
  if (pulseIds.length === 0) {
    return {
      success: false,
      message:
        'A promise weave holds at least one pulse — name what it ties together.',
    }
  }

  // First half of the server-side re-authorization: the acting member must be
  // able to EDIT this field (Owner / ADMIN / MEMBER). A GUEST who can read the
  // field gets the same refusal as a non-member — "not a member" and "no such
  // field" are never distinguished.
  const allowed = await canEditContext(graph, currentUserId, contextId)
  if (!allowed) {
    return {
      success: false,
      message: 'You can only propose promise weaves in fields you belong to.',
    }
  }

  const weaveId = `weave_${randomUUID()}`
  const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
  const metadataJson = JSON.stringify({ weaveId, origin: 'ai' })

  // Second half: everything the write touches is reached THROUGH `context`,
  // which the gate above already cleared — `HAS_PULSE` for the woven pulses,
  // `HAS_PERSON` for the person. An id from another Space matches nothing and
  // is simply absent from `pulses` / `wovenFor`, so a cross-Space weave is
  // unreachable rather than merely refused.
  //
  // The pulse and field titles the Log records are read from the graph, so no
  // id ever reaches the activity feed (Rule 1).
  const rows = await graph.query<{
    weaveTitle: string | null
    contextTitle: string | null
    wovenForName: string | null
    wovenPulseTitles: string[]
    alreadyWoven: boolean
    // The EXISTING weave's own title and status, not the proposal's. Without
    // them the "already woven" reply names a weave that does not exist and
    // cannot tell an agreed weave from another unconfirmed proposal.
    existingTitle: string | null
    existingStatus: string | null
    // A person was named but is not on this field's roster. Reported rather
    // than dropped in silence: the approval card said "for <name>".
    wovenForDropped: boolean
  }>(
    `
    MATCH (context:FieldContext {id: $contextId})
    MATCH (actor:Person {id: $currentUserId})

    // Only pulses THIS field holds. Anything else — another field, another
    // Space — never enters "pulses".
    //
    // Seeks each id on the FieldPulse(id) index and then checks the edge,
    // rather than expanding every HAS_PULSE out of the field and filtering:
    // the latter costs ~2 dbHits per pulse IN THE FIELD no matter how few ids
    // the proposal names, and was 92% of the statement on real dev data
    // (120 -> 22 dbHits on a 53-pulse field; 883 -> 83 on a 300-pulse one).
    // DISTINCT is load-bearing — without it a repeated id duplicates a title.
    CALL {
      WITH context
      UNWIND $pulseIds AS wantedId
      OPTIONAL MATCH (pulse:FieldPulse {id: wantedId})
      WHERE (context)-[:HAS_PULSE]->(pulse)
      RETURN collect(DISTINCT pulse) AS pulses
    }
    WITH context, actor, pulses

    // Same rule for the person: this field's roster (HAS_PERSON) only.
    OPTIONAL MATCH (context)-[:HAS_PERSON]->(person:Person)
    WHERE $wovenForPersonId IS NOT NULL AND person.id = $wovenForPersonId
    WITH context, actor, pulses, head(collect(person)) AS wovenFor

    // Idempotence: a LIVE weave in this field already holding every one of
    // these pulses makes the proposal redundant. Only a dissolved one is
    // skipped — a member who dismissed a weave can be offered a fresh one.
    //
    // Stated as an EXCLUSION of $notLiveStatuses (from NOT_LIVE_WEAVE_STATUSES)
    // rather than an allow-list of live ones, so it agrees with
    // normalizeWeaveStatus: null or an unrecognised legacy value reads as
    // "active" there, and must read as live here too. An allow-list looked
    // equivalent but silently classified an unknown value as not-live.
    //
    // The set must match EXACTLY, not merely contain. A containment test reads
    // fine until a field fills up: any live weave holding a superset blocks the
    // proposal, so a single-pulse proposal is refused by ANY weave that happens
    // to touch that pulse — and migration-built weaves wrap single care points,
    // so migrated fields are the worst hit. A different grouping of the same
    // pulses is a different weave. The cardinality clause costs ~0.6% dbHits.
    //
    // size(pulses) > 0 is load-bearing: all() over an empty list is vacuously
    // true, so without it an all-foreign proposal reports "already woven" and
    // names a real unrelated weave.
    OPTIONAL MATCH (context)-[:HAS_WEAVE]->(existing:PromiseWeave)
    WHERE size(pulses) > 0
      AND all(p IN pulses WHERE (existing)-[:WEAVES]->(p))
      AND size([(existing)-[:WEAVES]->(x) | x]) = size(pulses)
      AND NOT toLower(trim(coalesce(existing.status, ''))) IN $notLiveStatuses
    WITH context, actor, pulses, wovenFor, head(collect(existing)) AS existing

    // coalesce() skips null, NOT '' — a blank title would become the weave's
    // persisted name, be stripped by the caller's trim filter (over-counting
    // "left out"), and put the pulse's FULL content into the Log description.
    WITH context, actor, pulses, wovenFor, existing,
         [p IN pulses |
           CASE
             WHEN trim(coalesce(p.title, '')) <> '' THEN p.title
             ELSE coalesce(p.content, 'a pulse')
           END
         ] AS pulseTitles
    WITH context, actor, pulses, wovenFor, existing, pulseTitles,
         CASE
           WHEN $title IS NULL THEN coalesce(head(pulseTitles), 'Promise weave')
           ELSE $title
         END AS weaveTitle
    WITH context, actor, pulses, wovenFor, existing, pulseTitles, weaveTitle,
         reduce(
           acc = '',
           t IN pulseTitles[0..3] |
             CASE WHEN acc = '' THEN '"' + t + '"' ELSE acc + ', "' + t + '"' END
         ) AS namedTitles,
         size(pulseTitles) - size(pulseTitles[0..3]) AS unnamedCount

    FOREACH (_ IN CASE WHEN existing IS NULL AND size(pulses) > 0 THEN [1] ELSE [] END |
      CREATE (weave:PromiseWeave {
        id: $weaveId,
        title: weaveTitle,
        description: $why,
        // NEVER 'active' — the member's Confirm is what promotes it.
        status: 'proposed',
        origin: 'ai',
        createdAt: datetime()
      })
      // The context edge is the visibility anchor AND what every
      // @authorization rule on the type traverses — without it the weave is
      // unreadable and ungoverned, so it is created in the same breath.
      CREATE (context)-[:HAS_WEAVE]->(weave)
      FOREACH (p IN pulses | CREATE (weave)-[:WEAVES]->(p))
      FOREACH (target IN CASE WHEN wovenFor IS NULL THEN [] ELSE [wovenFor] END |
        CREATE (weave)-[:WOVEN_FOR]->(target)
      )
      CREATE (log:Log {
        id: $logId,
        description:
          'Proposed promise weave "' + weaveTitle + '"' +
          CASE WHEN namedTitles = '' THEN '' ELSE ' holding ' + namedTitles END +
          CASE WHEN unnamedCount > 0 THEN ' and ' + toString(unnamedCount) + ' more' ELSE '' END +
          CASE WHEN wovenFor IS NULL THEN '' ELSE ' for ' + coalesce(wovenFor.name, 'someone') END +
          CASE WHEN context.title IS NULL THEN '' ELSE ' in "' + context.title + '"' END,
        createdAt: datetime(),
        // "metadata" only. create-log.ts also writes a "metadataJson" twin,
        // but nothing reads it — it is absent from the GraphQL Log type and
        // from kb/05, and every other Log write in this file sets "metadata".
        // (Backticks are forbidden anywhere in this template literal: they
        // terminate the string and break every route that imports this file.)
        metadata: $metadataJson
      })
      CREATE (log)-[:CREATED_BY]->(actor)
      FOREACH (p IN pulses | CREATE (log)-[:LOGGED_FOR]->(p))
    )

    RETURN
      weaveTitle,
      context.title AS contextTitle,
      wovenFor.name AS wovenForName,
      pulseTitles AS wovenPulseTitles,
      existing IS NOT NULL AS alreadyWoven,
      existing.title AS existingTitle,
      existing.status AS existingStatus,
      ($wovenForPersonId IS NOT NULL AND wovenFor IS NULL) AS wovenForDropped
    LIMIT 1
    `,
    {
      contextId,
      currentUserId,
      pulseIds,
      wovenForPersonId,
      title,
      why,
      weaveId,
      logId,
      metadataJson,
      notLiveStatuses: NOT_LIVE_WEAVE_STATUSES,
    }
  )

  const row = rows?.[0]
  if (!row) {
    return {
      success: false,
      message: 'I could not find that field to weave in.',
    }
  }

  const where = row.contextTitle?.trim() || contextTitle || 'this field'
  const wovenPulseTitles = Array.isArray(row.wovenPulseTitles)
    ? row.wovenPulseTitles.filter(
        (pulseTitle): pulseTitle is string =>
          typeof pulseTitle === 'string' && pulseTitle.trim().length > 0
      )
    : []

  if (wovenPulseTitles.length === 0) {
    // Every id the model offered is outside this field. Name the field, not
    // the ids (Rule 3), and give away nothing about what lives elsewhere.
    return {
      success: false,
      message: `I could not find those pulses in ${where}. A promise weave only holds pulses from the field it is anchored in.`,
    }
  }

  const wovenForName = row.wovenForName?.trim() || null
  const weaveTitle = row.weaveTitle?.trim() || wovenPulseTitles[0]
  // Not an error: ids that partly missed still yield a weave over what DID
  // match, and the member is told plainly rather than silently given less.
  // Counted against the UNCAPPED request, so ids the cap dropped are included.
  const missing = requestedPulseIds.length - wovenPulseTitles.length
  const droppedNote =
    (missing > 0
      ? ` I left out ${missing} ${missing === 1 ? 'pulse' : 'pulses'} that ${
          missing === 1 ? 'is' : 'are'
        } not in ${where}.`
      : '') +
    // The card said "for <name>". If that person is not on the field's roster
    // the weave is woven for nobody, and saying nothing would let a success
    // message imply the card's promise was kept.
    (row.wovenForDropped
      ? ` I did not weave it for anyone — the person you named is not on this field's roster.`
      : '')

  if (row.alreadyWoven) {
    // Report the EXISTING weave's own name and state. Two failures live here:
    // saying "already woven together" about a weave that is itself still
    // `proposed` narrates an unconfirmed proposal as an agreed connection —
    // the exact thing this slice exists to prevent — and naming the proposal's
    // computed title would hand the model a weave name the graph does not hold.
    const existingAwaiting = isAwaitingReview(row.existingStatus)
    const existingTitle =
      row.existingTitle?.trim() || wovenPulseTitles[0] || 'a promise weave'
    return {
      success: true,
      alreadyWoven: true,
      title: existingTitle,
      status: existingAwaiting ? 'Proposed' : 'Active',
      awaitingReview: existingAwaiting,
      contextTitle: where,
      wovenForName,
      wovenPulseTitles,
      message: existingAwaiting
        ? `Those are already held by "${existingTitle}" in ${where} — a proposal that is still waiting on your confirm or dismiss, so I have not added another.${droppedNote}`
        : `Those are already woven together by "${existingTitle}" in ${where}.${droppedNote}`,
    }
  }

  return {
    success: true,
    id: weaveId,
    title: weaveTitle,
    status: 'Proposed',
    awaitingReview: true,
    contextTitle: where,
    wovenForName,
    wovenPulseTitles,
    // The member must be told the proposal is NOT yet an established weave,
    // and where the second gate lives — otherwise the model narrates a
    // confirmed connection that nobody has agreed to.
    message: `I have proposed "${weaveTitle}" in ${where}. It is waiting on you — confirm or dismiss it in that field's Promise weaves section.${droppedNote}`,
  }
}

async function deleteMyProfileAuthorized(
  graph: Neo4jGraph,
  currentUserId: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const confirm = Boolean(args.confirm)
  if (!confirm) {
    return {
      success: false,
      requiresClarification: true,
      message:
        'Set confirm=true to deactivate your profile. This action only applies to your own account.',
    }
  }

  const query = `
    MATCH (p:Person {id: $currentUserId})
    WITH p, coalesce(p.isActive, true) AS wasActive
    SET p.isActive = false,
        p.deactivatedAt = datetime(),
        p.updatedAt = datetime()
    RETURN p.id AS id, p.name AS name, wasActive
    LIMIT 1
  `

  const rows = await graph.query<{
    id: string
    name: string
    wasActive: boolean
  }>(query, { currentUserId })

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Could not find your profile for deactivation.',
    }
  }

  return {
    success: true,
    personId: rows[0].id,
    wasActive: Boolean(rows[0].wasActive),
    message: 'Your profile has been deactivated.',
  }
}

export async function executeAuthorizedWriteTool(
  graph: Neo4jGraph,
  currentUserId: string | null,
  toolName: WriteToolName,
  rawArgs: Record<string, unknown>
): Promise<ToolExecutionResult> {
  if (!currentUserId) {
    return {
      success: false,
      message: 'You must be logged in to perform edits.',
    }
  }

  if (toolName === 'rename_space') {
    return await renameSpaceAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_field_context') {
    return await createFieldContextAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'delete_field_context') {
    return await deleteFieldContextAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'update_field_context') {
    const input = rawArgs as unknown as UpdateFieldContextInput
    const resolved = await resolveAuthorizedContextId(
      graph,
      currentUserId,
      input
    )
    if (!resolved.ok) return resolved.result

    return (await updateFieldContext(graph, {
      ...input,
      contextId: resolved.contextId,
    })) as unknown as ToolExecutionResult
  }

  if (toolName === 'update_pulse') {
    const input = rawArgs as unknown as UpdatePulseInput & {
      documentId?: string
      pulseType?: string
      contextTitle?: string
    }
    const resolved = await resolveAuthorizedPulseId(graph, currentUserId, input)
    if (!resolved.ok) return resolved.result

    const updateResult = (await updatePulse(graph, {
      ...input,
      pulseId: resolved.pulseId,
    })) as unknown as ToolExecutionResult & {
      pulse?: { id?: string; title?: string }
    }

    if (!updateResult.success) return updateResult

    // Doc-ingestion provenance: when the synthesized turn carries a
    // documentId, append EXTRACTED_FROM (idempotent via MERGE) and a single
    // Log entry attributed to the editor — parity with manual create/update.
    const documentId =
      typeof input.documentId === 'string' && input.documentId.trim()
        ? input.documentId.trim()
        : null
    const conversationThreadId =
      typeof (input as { conversationThreadId?: string }).conversationThreadId ===
        'string' &&
      (input as { conversationThreadId?: string }).conversationThreadId!.trim()
        ? (input as { conversationThreadId?: string })
            .conversationThreadId!.trim()
        : null
    if (documentId) {
      // GOAL-318: the ingest update path (a re-extract, or a second document
      // matching an existing pulse via the roster) carries the document's
      // author — correct default uploader attribution before writing the Log.
      // No-op when attribution args are absent (the interactive chat path
      // never sets them) or when a different person already holds authorship.
      // The context is resolved through the same authorization path the
      // create branch uses, so a caller cannot credit a person from a
      // sibling context's roster it isn't allowed to edit.
      let reattributedTo: string | null = null
      const rawAttributedToPersonId = (input as Record<string, unknown>)
        .attributedToPersonId
      if (
        typeof rawAttributedToPersonId === 'string' &&
        rawAttributedToPersonId.trim()
      ) {
        const resolvedCtx = await resolveAuthorizedContextId(
          graph,
          currentUserId,
          {
            contextId: input.contextId,
            currentTitle: input.contextTitle,
          }
        )
        if (resolvedCtx.ok) {
          reattributedTo = await reattributeIngestPulseAuthor(
            graph,
            currentUserId,
            {
              pulseId: resolved.pulseId,
              contextId: resolvedCtx.contextId,
              attributedToPersonId: rawAttributedToPersonId,
              attributedToName: (input as Record<string, unknown>)
                .attributedToName,
            }
          )
        }
      }
      const updatedTitle =
        updateResult.pulse?.title || input.currentTitle || 'pulse'
      const where =
        typeof input.contextTitle === 'string' ? input.contextTitle.trim() : ''
      const humanLabel = pulseTypeLabel(input.pulseType)
      const documentFilename = await lookupDocumentFilename(graph, documentId)
      const filenameSuffix = documentFilename
        ? ` (from ${documentFilename})`
        : ''
      const attributionSuffix = reattributedTo
        ? ` — attributed to ${reattributedTo}`
        : ''
      const description =
        (where
          ? `Updated ${humanLabel} "${updatedTitle}" in ${where}`
          : `Updated ${humanLabel} "${updatedTitle}"`) +
        filenameSuffix +
        attributionSuffix
      if (reattributedTo) {
        // Human label for the credited author (Rule 3) — mirrored from the
        // create path so the synthesized turn reports corrected attribution.
        updateResult.attributedTo = reattributedTo
      }
      const metadata = buildIngestLogMetadata(documentId, conversationThreadId)
      const logId = `log_${Date.now()}_${randomUUID().slice(0, 8)}`
      await graph.query(
        `
        MATCH (pulse:FieldPulse {id: $pulseId})
        MATCH (u:Person {id: $currentUserId})
        OPTIONAL MATCH (d:Document {id: $documentId})
        CREATE (log:Log {
          id: $logId,
          description: $description,
          createdAt: datetime()
        })
        FOREACH (_ IN CASE WHEN $metadata IS NULL THEN [] ELSE [1] END |
          SET log.metadata = $metadata
        )
        CREATE (log)-[:CREATED_BY]->(u)
        CREATE (log)-[:LOGGED_FOR]->(pulse)
        FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END |
          MERGE (pulse)-[:EXTRACTED_FROM]->(d)
        )
        `,
        {
          pulseId: resolved.pulseId,
          currentUserId,
          documentId,
          logId,
          description,
          metadata,
        }
      )
    }

    return updateResult
  }

  if (toolName === 'create_pulse') {
    return await createPulseAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'delete_pulse') {
    return await deletePulseAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'edit_pulse_context_link') {
    const input = rawArgs as unknown as PulseContextLinkInput & {
      action?: 'link' | 'unlink'
    }

    const pulseId = String(input.pulseId || '').trim()
    if (!pulseId) {
      return {
        success: false,
        message: 'pulseId is required.',
      }
    }

    const allowed = await canEditPulse(graph, currentUserId, pulseId)
    if (!allowed) {
      return {
        success: false,
        message: 'You can only edit pulse links in spaces you belong to.',
      }
    }

    const action = input.action === 'unlink' ? 'unlink' : 'link'
    const result =
      action === 'link'
        ? await linkPulseToContext(graph, input)
        : await unlinkPulseFromContext(graph, input)

    return result as unknown as ToolExecutionResult
  }

  if (toolName === 'update_my_profile') {
    return await updateMyProfileAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'delete_my_profile') {
    return await deleteMyProfileAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_person') {
    return await createPersonAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'update_person') {
    return await updatePersonAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_organization') {
    return await createOrganizationAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'link_entity_to_pulse') {
    return await linkEntityToPulseAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_connection') {
    return await createConnectionAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_resonance') {
    return await createResonanceAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'create_resonant_pulse') {
    return await createResonantPulseAuthorized(graph, currentUserId, rawArgs)
  }

  if (toolName === 'propose_promise_weave') {
    return await proposePromiseWeaveAuthorized(graph, currentUserId, rawArgs)
  }

  return {
    success: false,
    message: `Unsupported write tool: ${toolName}`,
  }
}
