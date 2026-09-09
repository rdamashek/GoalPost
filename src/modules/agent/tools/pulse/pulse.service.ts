import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph'
import { viewablePulsePredicate } from '@/lib/permissions/pulse-visibility'
import {
  ATTACHED_DOCUMENT_LOCATION,
  toAssistantSafeLocation,
} from '@/lib/ingest/document-download-url'

export type PulseType =
  | 'GoalPulse'
  | 'ResourcePulse'
  | 'StoryPulse'
  | 'CarePulse'
  | 'CoreValuePulse'
  | 'FieldPulse'

export interface PulseRecord {
  id: string
  title: string
  content: string
  type: PulseType
  status?: string | null
  intensity?: number | null
  horizon?: string | null
  resourceType?: string | null
  availability?: number | null
  why?: string | null
  /**
   * Model-facing location. A stored durable document locator is shaped to
   * `ATTACHED_DOCUMENT_LOCATION` by `mapPulseRecord` (GOAL-322); every other
   * location is the stored value verbatim.
   */
  location?: string | null
  time?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  contextId?: string | null
  contextTitle?: string | null
  contextTitles?: string[]
  spaceNames?: string[]
  createdByName?: string | null
  /**
   * Why this pulse is related to the search term when it was surfaced via the
   * person bridge (see `searchPulses`). One of `authored` | `sharedDocument` |
   * `sharedField`; absent for direct title/content text matches.
   */
  relatedVia?: 'authored' | 'sharedDocument' | 'sharedField' | null
  /** The person whose name matched, when surfaced via the person bridge. */
  relatedPersonName?: string | null
}

export interface PulseSearchInput {
  /**
   * Keyword for a title/content search. OPTIONAL: when blank/absent AND a scope
   * (spaceId/spaceName/contextId/contextTitle/pulseType) is present, the search
   * ENUMERATES — it lists every pulse in that scope instead of matching text.
   */
  query?: string
  /**
   * The authenticated caller's id. REQUIRED — results are restricted to pulses
   * in Spaces this user can view. A missing/empty userId returns nothing
   * (fail closed), never the whole graph.
   */
  userId?: string | null
  contextId?: string
  contextTitle?: string
  /** Optional Space id scope — restrict to pulses living in this one Space. */
  spaceId?: string
  /** Optional Space name scope (fuzzy contains) — restrict to Spaces whose name matches. */
  spaceName?: string
  pulseType?: PulseType
  limit?: number
}

export interface PulseSearchResult {
  found: boolean
  count: number
  pulses: PulseRecord[]
  needsDisambiguation: boolean
  message: string
}

export interface UpdatePulseInput {
  pulseId?: string
  currentTitle?: string
  contextId?: string
  newTitle?: string
  newContent?: string
  newStatus?: string
  newIntensity?: number
  newHorizon?: string
  newResourceType?: string
  newAvailability?: number
  newWhy?: string
  newLocation?: string
  newTime?: string
}

export interface UpdatePulseResult {
  success: boolean
  requiresDisambiguation?: boolean
  message: string
  pulse?: PulseRecord
  candidates?: PulseRecord[]
}

export interface PulseContextLinkInput {
  pulseId: string
  contextId?: string
  contextTitle?: string
}

export interface PulseContextLinkResult {
  success: boolean
  requiresDisambiguation?: boolean
  message: string
  pulseId?: string
  contextId?: string
  contextTitle?: string
  candidates?: Array<{ id: string; title: string }>
}

function normalizeLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return 10
  return Math.max(1, Math.min(25, Math.floor(limit)))
}

/**
 * Project a raw Cypher row into the `PulseRecord` every agent tool returns.
 *
 * This is the single funnel for EVERY model-facing pulse in this module —
 * `searchPulses`, the person bridge, update candidates, and the record
 * `updatePulse` hands back through the HITL result — which is why the GOAL-322
 * location shaping belongs here rather than at each call site. The module lives
 * under `modules/agent/tools/`: everything it returns is destined for an LLM,
 * so there is no non-assistant consumer that needs the raw locator (the UI
 * reads pulses through GraphQL, untouched by this).
 */
function mapPulseRecord(raw: Record<string, unknown>): PulseRecord {
  const contextTitles = (
    (raw.contextTitles as string[] | undefined) || []
  ).filter(Boolean)
  const spaceNames = ((raw.spaceNames as string[] | undefined) || []).filter(
    Boolean
  )

  return {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    content: String(raw.content || ''),
    type: (raw.type as PulseType) || 'FieldPulse',
    status: (raw.status as string | null) || null,
    intensity:
      raw.intensity === null || raw.intensity === undefined
        ? null
        : Number(raw.intensity),
    horizon: (raw.horizon as string | null) || null,
    resourceType: (raw.resourceType as string | null) || null,
    availability:
      raw.availability === null || raw.availability === undefined
        ? null
        : Number(raw.availability),
    why: (raw.why as string | null) || null,
    location: toAssistantSafeLocation((raw.location as string | null) || null),
    time: (raw.time as string | null) || null,
    createdAt: (raw.createdAt as string | null) || null,
    updatedAt: (raw.updatedAt as string | null) || null,
    contextId: (raw.contextId as string | null) || null,
    contextTitle: (raw.contextTitle as string | null) || null,
    contextTitles,
    spaceNames,
    createdByName: (raw.createdByName as string | null) || null,
    relatedVia:
      (raw.relatedVia as PulseRecord['relatedVia'] | undefined) || null,
    relatedPersonName: (raw.relatedPersonName as string | null) || null,
  }
}

function typeFilterCypher(): string {
  // The CoreValuePulse branch also matches the legacy `:CoreValue` label. The
  // pre-GOAL-287 migration mapped a prod CoreValue to
  // `FieldPulse:StoryPulse:CoreValue` (no `:CoreValuePulse` label), so a
  // `pulseType='CoreValuePulse'` filter (what "value-like pulses" resolves to)
  // missed every migrated value without this bridge — the captured failure.
  // Backfilled DBs now carry `FieldPulse:CoreValuePulse:CoreValue` (kb/08),
  // but the bridge stays: it is harmless there and still rescues any
  // un-backfilled env (e.g. a stale demo box) holding the legacy shape.
  return `
    (
      $pulseType IS NULL
      OR $pulseType = ''
      OR ($pulseType = 'GoalPulse' AND pulse:GoalPulse)
      OR ($pulseType = 'ResourcePulse' AND pulse:ResourcePulse)
      OR ($pulseType = 'StoryPulse' AND pulse:StoryPulse)
      OR ($pulseType = 'CarePulse' AND pulse:CarePulse)
      OR ($pulseType = 'CoreValuePulse' AND (pulse:CoreValuePulse OR pulse:CoreValue))
      OR ($pulseType = 'FieldPulse' AND pulse:FieldPulse)
    )
  `
}

// In an un-backfilled env, migrated values still carry the legacy
// `:StoryPulse:CoreValue` shape (pre-GOAL-287), so the type CASE below checks
// the `:CoreValue` value-marker BEFORE `:StoryPulse` — a value the user asked
// for is reported as a value, not a story, keeping the projected type
// consistent with the `:CoreValue` bridge in typeFilterCypher(). On backfilled
// DBs (`:CoreValuePulse:CoreValue`, kb/08) the ordering is moot but correct.
// Accepted consequence: a `pulseType='StoryPulse'` enumeration reports a
// legacy-shaped node as 'CoreValuePulse' — a value merged into story is still
// a value.
function pulseProjectionCypher(): string {
  return `
    pulse.id AS id,
    pulse.title AS title,
    pulse.content AS content,
    CASE
      WHEN pulse:GoalPulse THEN 'GoalPulse'
      WHEN pulse:ResourcePulse THEN 'ResourcePulse'
      WHEN pulse:CarePulse THEN 'CarePulse'
      WHEN pulse:CoreValuePulse OR pulse:CoreValue THEN 'CoreValuePulse'
      WHEN pulse:StoryPulse THEN 'StoryPulse'
      ELSE 'FieldPulse'
    END AS type,
    pulse.status AS status,
    pulse.intensity AS intensity,
    pulse.horizon AS horizon,
    pulse.resourceType AS resourceType,
    pulse.availability AS availability,
    pulse.why AS why,
    pulse.location AS location,
    pulse.time AS time,
    toString(pulse.createdAt) AS createdAt,
    toString(pulse.updatedAt) AS updatedAt,
    CASE WHEN size(contextIds) = 0 THEN NULL ELSE contextIds[0] END AS contextId,
    CASE WHEN size(contextTitles) = 0 THEN NULL ELSE contextTitles[0] END AS contextTitle,
    contextTitles AS contextTitles,
    spaceNames AS spaceNames,
    coalesce(createdByA, createdByB) AS createdByName
  `
}

/**
 * Person-bridge fallback for `searchPulses`.
 *
 * A plain title/content text search misses the common case behind a real user
 * complaint: "are there any pulses related to <a person>?" People identified
 * during document ingestion become `:Person:PersonPulse` nodes attached to a
 * FieldContext — they are NOT written into any pulse's title/content, so a text
 * search returns nothing even though the person (and the pulses around them) are
 * plainly in the graph. This bridge finds pulses connected to a Person whose
 * name matches the query, ranked by how directly they relate:
 *   0 `authored`        — the person authored the pulse (INITIATED_BY/CREATED_BY)
 *   1 `sharedDocument`  — pulse + person were extracted from the same Document
 *   2 `sharedField`     — the person is attached (HAS_PERSON) to the pulse's field
 *
 * Every candidate is re-gated by `viewablePulsePredicate($currentUserId)` — the
 * bridge never returns a pulse the caller could not already see, so it cannot
 * leak Spaces or the existence of people in them (fail-closed).
 */
async function searchPulsesByRelatedPerson(
  graph: Neo4jGraph,
  params: {
    query: string
    contextId: string | null
    contextTitle: string | null
    pulseType: PulseType | null
    limit: number
    currentUserId: string
  }
): Promise<PulseRecord[]> {
  const cypher = `
    WITH toLower($query) AS qLower
    MATCH (person:Person)
    WHERE toLower(coalesce(person.name, trim(coalesce(person.firstName, '') + ' ' + coalesce(person.lastName, '')))) CONTAINS qLower
       OR toLower(coalesce(person.lastName, '')) CONTAINS qLower
       OR toLower(coalesce(person.firstName, '')) CONTAINS qLower
    CALL {
      WITH person
      MATCH (pulse:FieldPulse)-[:INITIATED_BY|CREATED_BY]->(person)
      RETURN pulse AS relPulse, 0 AS relRank
      UNION
      WITH person
      MATCH (pulse:FieldPulse)-[:EXTRACTED_FROM]->(:ResourcePulse)<-[:EXTRACTED_FROM]-(person)
      RETURN pulse AS relPulse, 1 AS relRank
      UNION
      WITH person
      MATCH (fc:FieldContext)-[:HAS_PERSON]->(person)
      MATCH (fc)-[:HAS_PULSE]->(pulse:FieldPulse)
      RETURN pulse AS relPulse, 2 AS relRank
    }
    WITH
      relPulse AS pulse,
      relRank,
      coalesce(person.name, trim(coalesce(person.firstName, '') + ' ' + coalesce(person.lastName, ''))) AS personName
    WHERE ${viewablePulsePredicate('pulse', 'currentUserId')}
      AND (
        $contextId IS NULL
        OR EXISTS {
          MATCH (:FieldContext {id: $contextId})-[:HAS_PULSE]->(pulse)
        }
      )
      AND (
        $contextTitle IS NULL
        OR EXISTS {
          MATCH (contextFilter:FieldContext)-[:HAS_PULSE]->(pulse)
          WHERE toLower(coalesce(contextFilter.title, '')) CONTAINS toLower($contextTitle)
        }
      )
      AND ${typeFilterCypher()}
    // Collapse to one row per pulse, keeping the STRONGEST relationship (lowest
    // rank) AND the person who produced it — ordering by relRank before collect
    // makes head() the min-rank element, so relatedPersonName can never be a
    // different person than the one relatedVia describes (honest attribution).
    WITH pulse, relRank, personName
    ORDER BY relRank ASC
    WITH pulse, head(collect({ rank: relRank, name: personName })) AS best
    WITH pulse, best.rank AS bestRank, best.name AS relatedPersonName
    // Rank the candidates and cut to $limit BEFORE the projection expansions, so
    // the four OPTIONAL MATCHes below run for the returned rows only (O(limit)),
    // not for every pulse in a possibly-large field (O(field size)).
    ORDER BY bestRank, pulse.createdAt DESC
    LIMIT toInteger($limit)
    OPTIONAL MATCH (context:FieldContext)-[:HAS_PULSE]->(pulse)
    OPTIONAL MATCH (space:Space)-[:HAS_CONTEXT]->(context)
    OPTIONAL MATCH (pulse)-[:CREATED_BY]->(creatorA:Person)
    OPTIONAL MATCH (pulse)-[:INITIATED_BY]->(creatorB:Person)
    WITH
      pulse,
      bestRank,
      relatedPersonName,
      [id IN collect(DISTINCT context.id) WHERE id IS NOT NULL] AS contextIds,
      [title IN collect(DISTINCT context.title) WHERE title IS NOT NULL] AS contextTitles,
      [name IN collect(DISTINCT space.name) WHERE name IS NOT NULL] AS spaceNames,
      head([name IN collect(DISTINCT creatorA.name) WHERE name IS NOT NULL]) AS createdByA,
      head([name IN collect(DISTINCT creatorB.name) WHERE name IS NOT NULL]) AS createdByB
    RETURN ${pulseProjectionCypher()},
      CASE bestRank WHEN 0 THEN 'authored' WHEN 1 THEN 'sharedDocument' ELSE 'sharedField' END AS relatedVia,
      relatedPersonName AS relatedPersonName
    ORDER BY bestRank, pulse.createdAt DESC
  `

  const raw = await graph.query<Record<string, unknown>>(cypher, {
    query: params.query,
    contextId: params.contextId,
    contextTitle: params.contextTitle,
    pulseType: params.pulseType,
    limit: params.limit,
    currentUserId: params.currentUserId,
  })

  return (raw || []).map(mapPulseRecord)
}

/**
 * Human-readable, honest framing for person-bridge results. It never claims the
 * pulses are "about" the person — it names the actual relationship so the
 * assistant can relay it truthfully (a `sharedField` pulse is a fieldmate, not
 * the person's own contribution).
 */
function buildRelatedPulseMessage(
  query: string,
  pulses: PulseRecord[]
): string {
  // Anchor on the person the query actually named. If a name substring matches
  // more than one person, describe the one with the most related pulses so the
  // counts below never span two different people (honest attribution).
  const nameCounts = new Map<string, number>()
  for (const p of pulses) {
    if (p.relatedPersonName) {
      nameCounts.set(
        p.relatedPersonName,
        (nameCounts.get(p.relatedPersonName) ?? 0) + 1
      )
    }
  }
  const who =
    [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || query

  // Count EACH relationship tier separately, for THIS person only. The returned
  // rows can mix tiers (ORDER BY bestRank), so a single "strongest" label would
  // misattribute fieldmate pulses as authored/extracted — never do that.
  const mine = pulses.filter((p) => p.relatedPersonName === who)
  const authored = mine.filter((p) => p.relatedVia === 'authored').length
  const sharedDocument = mine.filter(
    (p) => p.relatedVia === 'sharedDocument'
  ).length
  const sharedFieldPulses = mine.filter((p) => p.relatedVia === 'sharedField')
  const field = sharedFieldPulses[0]?.contextTitle
  const plural = (n: number) => (n === 1 ? 'pulse' : 'pulses')

  const clauses: string[] = []
  if (authored > 0) {
    clauses.push(`is credited on ${authored} ${plural(authored)}`)
  }
  if (sharedDocument > 0) {
    clauses.push(
      `appears alongside ${sharedDocument} ${plural(sharedDocument)} extracted from the same uploaded document`
    )
  }
  if (sharedFieldPulses.length > 0) {
    clauses.push(
      `shares ${field ? `the "${field}" field` : 'a field'} with ${
        sharedFieldPulses.length
      } ${plural(sharedFieldPulses.length)} that are present alongside them, not specifically about them`
    )
  }

  if (clauses.length === 0) {
    return `No pulse mentions "${query}" by name, but ${who} is connected to ${mine.length} ${plural(mine.length)}.`
  }
  return `No pulse mentions "${query}" by name, but ${who} ${clauses.join('; ')}.`
}

export async function searchPulses(
  graph: Neo4jGraph,
  input: PulseSearchInput
): Promise<PulseSearchResult> {
  const query = input.query?.trim() || ''

  const contextId = input.contextId?.trim() || null
  const contextTitle = input.contextTitle?.trim() || null
  const spaceId = input.spaceId?.trim() || null
  const spaceName = input.spaceName?.trim() || null
  const pulseType = input.pulseType || null
  const limit = normalizeLimit(input.limit)
  const currentUserId = input.userId?.trim() || null

  // Fail closed: without an authenticated caller we never search pulses, so an
  // unauthenticated/spoofed request can't enumerate the graph.
  if (!currentUserId) {
    return {
      found: false,
      count: 0,
      pulses: [],
      needsDisambiguation: false,
      message: 'You need to be signed in to search pulses.',
    }
  }

  // A scope (a Space, a field, or a pulse type) lets us ENUMERATE — list every
  // pulse in it — WITHOUT a keyword. This is what "all value pulses in my Me
  // Space" needs: the member should never have to invent a keyword just to see
  // what a Space holds (the captured failure behind this change). We only refuse
  // a TRULY unscoped blank query, which would otherwise dump every pulse the
  // member can see.
  const hasScope = Boolean(
    spaceId || spaceName || contextId || contextTitle || pulseType
  )
  if (!query && !hasScope) {
    return {
      found: false,
      count: 0,
      pulses: [],
      needsDisambiguation: false,
      message:
        'Please give me a keyword, or name a Space, field, or pulse type so I can list the matching pulses.',
    }
  }

  // Text match only when a keyword is present; a scoped blank query lists every
  // pulse in the scope, newest first. Every result is still gated by
  // viewablePulsePredicate($userId) below, so scoping never widens visibility.
  const textClause = query
    ? `(
        toLower(coalesce(pulse.title, '')) CONTAINS toLower($query)
        OR toLower(coalesce(pulse.content, '')) CONTAINS toLower($query)
        OR toLower(coalesce(pulse.title, '')) STARTS WITH toLower($query)
      )`
    : 'true'

  const orderClause = query
    ? `ORDER BY
        CASE
          WHEN toLower(trim(coalesce(pulse.title, ''))) = toLower(trim($query)) THEN 0
          WHEN toLower(coalesce(pulse.title, '')) STARTS WITH toLower($query) THEN 1
          ELSE 2
        END,
        pulse.createdAt DESC`
    : `ORDER BY pulse.createdAt DESC`

  // The `WITH pulse ... ORDER BY ... LIMIT` sits BEFORE the projection
  // OPTIONAL MATCHes so those four expansions run for the returned rows only
  // (O(limit)), not for every pulse in scope — mirroring
  // searchPulsesByRelatedPerson. The ordering keys (pulse.title/createdAt) are
  // pulse-only, and the final RETURN re-applies orderClause, so it is
  // order-preserving. (Kept as a JS comment, not an inline Cypher `//`, so
  // reformatting the template can never swallow the query.)
  const cypher = `
    MATCH (pulse:FieldPulse)
    WHERE ${textClause}
      AND ${viewablePulsePredicate('pulse', 'currentUserId')}
      AND (
        $contextId IS NULL
        OR EXISTS {
          MATCH (:FieldContext {id: $contextId})-[:HAS_PULSE]->(pulse)
        }
      )
      AND (
        $contextTitle IS NULL
        OR EXISTS {
          MATCH (contextFilter:FieldContext)-[:HAS_PULSE]->(pulse)
          WHERE toLower(coalesce(contextFilter.title, '')) CONTAINS toLower($contextTitle)
        }
      )
      AND (
        $spaceId IS NULL
        OR EXISTS {
          MATCH (spaceFilter:Space {id: $spaceId})-[:HAS_CONTEXT]->(:FieldContext)-[:HAS_PULSE]->(pulse)
        }
      )
      AND (
        $spaceName IS NULL
        OR EXISTS {
          MATCH (spaceFilter:Space)-[:HAS_CONTEXT]->(:FieldContext)-[:HAS_PULSE]->(pulse)
          WHERE toLower(coalesce(spaceFilter.name, '')) CONTAINS toLower($spaceName)
        }
      )
      AND ${typeFilterCypher()}
    WITH pulse
    ${orderClause}
    LIMIT toInteger($limit)
    OPTIONAL MATCH (context:FieldContext)-[:HAS_PULSE]->(pulse)
    OPTIONAL MATCH (space:Space)-[:HAS_CONTEXT]->(context)
    OPTIONAL MATCH (pulse)-[:CREATED_BY]->(creatorA:Person)
    OPTIONAL MATCH (pulse)-[:INITIATED_BY]->(creatorB:Person)
    WITH
      pulse,
      [id IN collect(DISTINCT context.id) WHERE id IS NOT NULL] AS contextIds,
      [title IN collect(DISTINCT context.title) WHERE title IS NOT NULL] AS contextTitles,
      [name IN collect(DISTINCT space.name) WHERE name IS NOT NULL] AS spaceNames,
      head([name IN collect(DISTINCT creatorA.name) WHERE name IS NOT NULL]) AS createdByA,
      head([name IN collect(DISTINCT creatorB.name) WHERE name IS NOT NULL]) AS createdByB
    RETURN ${pulseProjectionCypher()}
    ${orderClause}
  `

  const raw = await graph.query<Record<string, unknown>>(cypher, {
    query,
    contextId,
    contextTitle,
    spaceId,
    spaceName,
    pulseType,
    limit,
    currentUserId,
  })

  const pulses = (raw || []).map(mapPulseRecord)

  if (pulses.length === 0) {
    // A KEYWORD that matched no pulse text may still name a PERSON: people
    // identified during ingestion are graph-related to pulses (authored / same
    // document / same field) but never appear in pulse text, so a "pulses
    // related to <person>" question would otherwise dead-end. Bridge to them —
    // keyword mode only, since an enumeration has no name to resolve. Auth is
    // preserved: the bridge re-gates on $userId.
    if (query) {
      const related = await searchPulsesByRelatedPerson(graph, {
        query,
        contextId,
        contextTitle,
        pulseType,
        limit,
        currentUserId,
      })

      if (related.length > 0) {
        return {
          found: true,
          count: related.length,
          pulses: related,
          // Discovery results, not update candidates — don't prompt for a
          // pulse ID the way a title-collision disambiguation would.
          needsDisambiguation: false,
          message: buildRelatedPulseMessage(query, related),
        }
      }

      return {
        found: false,
        count: 0,
        pulses: [],
        needsDisambiguation: false,
        message: `I could not find pulses matching "${query}".`,
      }
    }

    return {
      found: false,
      count: 0,
      pulses: [],
      needsDisambiguation: false,
      message: 'I did not find any pulses in that scope.',
    }
  }

  // Enumeration (blank query) is a plain listing, not a set of update
  // candidates — don't prompt for a pulse ID the way a keyword collision would.
  if (!query) {
    const noun = pulses.length === 1 ? 'pulse' : 'pulses'
    // A listing that fills the whole page (=limit) is almost certainly
    // truncated, so signal that instead of implying the count is the total —
    // otherwise the model relays "you have 25 values" when there may be more
    // (kb/07 truthfulness). The keyword path keeps its own messaging below.
    const message =
      pulses.length === limit
        ? `Here are ${pulses.length} ${noun} in that scope — there may be more; ask me to narrow the scope or show additional results.`
        : `I found ${pulses.length} ${noun} in that scope.`
    return {
      found: true,
      count: pulses.length,
      pulses,
      needsDisambiguation: false,
      message,
    }
  }

  return {
    found: true,
    count: pulses.length,
    pulses,
    needsDisambiguation: pulses.length > 1,
    message:
      pulses.length === 1
        ? `I found pulse "${pulses[0].title}".`
        : `I found ${pulses.length} matching pulses. Please specify a pulse ID for updates.`,
  }
}

async function resolvePulseCandidates(
  graph: Neo4jGraph,
  input: UpdatePulseInput
): Promise<PulseRecord[]> {
  const pulseId = input.pulseId?.trim() || null
  const currentTitle = input.currentTitle?.trim() || null
  const contextId = input.contextId?.trim() || null

  if (!pulseId && !currentTitle) {
    return []
  }

  const cypher = pulseId
    ? `
      MATCH (pulse:FieldPulse {id: $pulseId})
      OPTIONAL MATCH (context:FieldContext)-[:HAS_PULSE]->(pulse)
      OPTIONAL MATCH (space:Space)-[:HAS_CONTEXT]->(context)
      OPTIONAL MATCH (pulse)-[:CREATED_BY]->(creatorA:Person)
      OPTIONAL MATCH (pulse)-[:INITIATED_BY]->(creatorB:Person)
      WITH
        pulse,
        [id IN collect(DISTINCT context.id) WHERE id IS NOT NULL] AS contextIds,
        [title IN collect(DISTINCT context.title) WHERE title IS NOT NULL] AS contextTitles,
        [name IN collect(DISTINCT space.name) WHERE name IS NOT NULL] AS spaceNames,
        head([name IN collect(DISTINCT creatorA.name) WHERE name IS NOT NULL]) AS createdByA,
        head([name IN collect(DISTINCT creatorB.name) WHERE name IS NOT NULL]) AS createdByB
      RETURN ${pulseProjectionCypher()}
      LIMIT 3
    `
    : `
      MATCH (pulse:FieldPulse)
      WHERE toLower(trim(coalesce(pulse.title, ''))) = toLower(trim($currentTitle))
        AND (
          $contextId IS NULL
          OR EXISTS {
            MATCH (:FieldContext {id: $contextId})-[:HAS_PULSE]->(pulse)
          }
        )
      OPTIONAL MATCH (context:FieldContext)-[:HAS_PULSE]->(pulse)
      OPTIONAL MATCH (space:Space)-[:HAS_CONTEXT]->(context)
      OPTIONAL MATCH (pulse)-[:CREATED_BY]->(creatorA:Person)
      OPTIONAL MATCH (pulse)-[:INITIATED_BY]->(creatorB:Person)
      WITH
        pulse,
        [id IN collect(DISTINCT context.id) WHERE id IS NOT NULL] AS contextIds,
        [title IN collect(DISTINCT context.title) WHERE title IS NOT NULL] AS contextTitles,
        [name IN collect(DISTINCT space.name) WHERE name IS NOT NULL] AS spaceNames,
        head([name IN collect(DISTINCT creatorA.name) WHERE name IS NOT NULL]) AS createdByA,
        head([name IN collect(DISTINCT creatorB.name) WHERE name IS NOT NULL]) AS createdByB
      RETURN ${pulseProjectionCypher()}
      ORDER BY pulse.createdAt DESC
      LIMIT 5
    `

  const raw = await graph.query<Record<string, unknown>>(cypher, {
    pulseId,
    currentTitle,
    contextId,
  })

  return (raw || []).map(mapPulseRecord)
}

function isFiniteNumber(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Drop a `newLocation` that is just the opaque phrase we showed the model.
 *
 * Since GOAL-322 a pulse whose location is a durable document locator READS
 * back as `ATTACHED_DOCUMENT_LOCATION`. A model that carries the fields it read
 * into an update would otherwise write that phrase over the real locator,
 * destroying the link back to the uploaded file. The phrase is a display value,
 * so it is never a legitimate thing to store — treating it as "no change" keeps
 * shaping strictly one-way.
 */
function sanitizeNewLocation(newLocation?: string): string | null {
  const trimmed = newLocation?.trim() || null
  return trimmed === ATTACHED_DOCUMENT_LOCATION ? null : trimmed
}

export async function updatePulse(
  graph: Neo4jGraph,
  input: UpdatePulseInput
): Promise<UpdatePulseResult> {
  const changes = {
    newTitle: input.newTitle?.trim() || null,
    newContent: input.newContent?.trim() || null,
    newStatus: input.newStatus?.trim() || null,
    newIntensity: isFiniteNumber(input.newIntensity)
      ? input.newIntensity
      : null,
    newHorizon: input.newHorizon?.trim() || null,
    newResourceType: input.newResourceType?.trim() || null,
    newAvailability: isFiniteNumber(input.newAvailability)
      ? input.newAvailability
      : null,
    newWhy: input.newWhy?.trim() || null,
    newLocation: sanitizeNewLocation(input.newLocation),
    newTime: input.newTime?.trim() || null,
  }

  const hasAnyChange = Object.values(changes).some((value) => value !== null)
  if (!hasAnyChange) {
    return {
      success: false,
      message:
        'Please provide at least one update value (for example newTitle or newContent).',
    }
  }

  const candidates = await resolvePulseCandidates(graph, input)

  if (candidates.length === 0) {
    return {
      success: false,
      message:
        'I could not find the pulse to update. Provide pulseId or exact currentTitle.',
    }
  }

  if (candidates.length > 1) {
    return {
      success: false,
      requiresDisambiguation: true,
      message: 'Multiple pulses match. Please provide the pulse ID to update.',
      candidates,
    }
  }

  const target = candidates[0]

  const updateCypher = `
    MATCH (pulse:FieldPulse {id: $pulseId})
    SET pulse.updatedAt = datetime()
    FOREACH (_ IN CASE WHEN $newTitle IS NULL THEN [] ELSE [1] END |
      SET pulse.title = $newTitle
    )
    FOREACH (_ IN CASE WHEN $newContent IS NULL THEN [] ELSE [1] END |
      SET pulse.content = $newContent
    )
    FOREACH (_ IN CASE WHEN $newStatus IS NULL THEN [] ELSE [1] END |
      SET pulse.status = $newStatus
    )
    FOREACH (_ IN CASE WHEN $newIntensity IS NULL THEN [] ELSE [1] END |
      SET pulse.intensity = $newIntensity
    )
    FOREACH (_ IN CASE WHEN $newHorizon IS NULL THEN [] ELSE [1] END |
      SET pulse.horizon = $newHorizon
    )
    FOREACH (_ IN CASE WHEN $newResourceType IS NULL THEN [] ELSE [1] END |
      SET pulse.resourceType = $newResourceType
    )
    FOREACH (_ IN CASE WHEN $newAvailability IS NULL THEN [] ELSE [1] END |
      SET pulse.availability = $newAvailability
    )
    FOREACH (_ IN CASE WHEN $newWhy IS NULL THEN [] ELSE [1] END |
      SET pulse.why = $newWhy
    )
    FOREACH (_ IN CASE WHEN $newLocation IS NULL THEN [] ELSE [1] END |
      SET pulse.location = $newLocation
    )
    FOREACH (_ IN CASE WHEN $newTime IS NULL THEN [] ELSE [1] END |
      SET pulse.time = $newTime
    )
    WITH pulse
    OPTIONAL MATCH (context:FieldContext)-[:HAS_PULSE]->(pulse)
    OPTIONAL MATCH (space:Space)-[:HAS_CONTEXT]->(context)
    OPTIONAL MATCH (pulse)-[:CREATED_BY]->(creatorA:Person)
    OPTIONAL MATCH (pulse)-[:INITIATED_BY]->(creatorB:Person)
    WITH
      pulse,
      [id IN collect(DISTINCT context.id) WHERE id IS NOT NULL] AS contextIds,
      [title IN collect(DISTINCT context.title) WHERE title IS NOT NULL] AS contextTitles,
      [name IN collect(DISTINCT space.name) WHERE name IS NOT NULL] AS spaceNames,
      head([name IN collect(DISTINCT creatorA.name) WHERE name IS NOT NULL]) AS createdByA,
      head([name IN collect(DISTINCT creatorB.name) WHERE name IS NOT NULL]) AS createdByB
    RETURN ${pulseProjectionCypher()}
    LIMIT 1
  `

  const updatedRaw = await graph.query<Record<string, unknown>>(updateCypher, {
    pulseId: target.id,
    ...changes,
  })

  if (!updatedRaw || updatedRaw.length === 0) {
    return {
      success: false,
      message: 'Failed to update the pulse. Please try again.',
    }
  }

  const pulse = mapPulseRecord(updatedRaw[0])

  return {
    success: true,
    pulse,
    message: `Updated pulse "${target.title}" successfully.`,
  }
}

async function resolveContextCandidates(
  graph: Neo4jGraph,
  contextId?: string,
  contextTitle?: string
): Promise<Array<{ id: string; title: string }>> {
  const safeContextId = contextId?.trim() || null
  const safeContextTitle = contextTitle?.trim() || null

  if (!safeContextId && !safeContextTitle) {
    return []
  }

  const cypher = safeContextId
    ? `
      MATCH (context:FieldContext {id: $contextId})
      RETURN context.id AS id, context.title AS title
      LIMIT 3
    `
    : `
      MATCH (context:FieldContext)
      WHERE toLower(trim(coalesce(context.title, ''))) = toLower(trim($contextTitle))
         OR toLower(coalesce(context.title, '')) CONTAINS toLower($contextTitle)
      RETURN context.id AS id, context.title AS title
      ORDER BY context.title ASC
      LIMIT 5
    `

  const rows = await graph.query<Record<string, unknown>>(cypher, {
    contextId: safeContextId,
    contextTitle: safeContextTitle,
  })

  return (rows || []).map((row) => ({
    id: String(row.id || ''),
    title: String(row.title || ''),
  }))
}

export async function linkPulseToContext(
  graph: Neo4jGraph,
  input: PulseContextLinkInput
): Promise<PulseContextLinkResult> {
  const pulseId = input.pulseId?.trim()

  if (!pulseId) {
    return {
      success: false,
      message: 'pulseId is required.',
    }
  }

  const contextCandidates = await resolveContextCandidates(
    graph,
    input.contextId,
    input.contextTitle
  )

  if (contextCandidates.length === 0) {
    return {
      success: false,
      message:
        'I could not find the target field context. Provide contextId or exact contextTitle.',
    }
  }

  if (contextCandidates.length > 1) {
    return {
      success: false,
      requiresDisambiguation: true,
      message: 'Multiple field contexts match. Please provide contextId.',
      candidates: contextCandidates,
    }
  }

  const [context] = contextCandidates

  const cypher = `
    MATCH (pulse:FieldPulse {id: $pulseId})
    MATCH (context:FieldContext {id: $contextId})
    OPTIONAL MATCH (context)-[existing:HAS_PULSE]->(pulse)
    WITH pulse, context, existing IS NOT NULL AS alreadyLinked
    MERGE (context)-[:HAS_PULSE]->(pulse)
    RETURN alreadyLinked AS alreadyLinked
  `

  const rows = await graph.query<Record<string, unknown>>(cypher, {
    pulseId,
    contextId: context.id,
  })

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'Failed to link the pulse to the field context.',
    }
  }

  const alreadyLinked = Boolean(rows[0].alreadyLinked)

  return {
    success: true,
    pulseId,
    contextId: context.id,
    contextTitle: context.title,
    message: alreadyLinked
      ? `Pulse is already linked to "${context.title}".`
      : `Linked pulse to "${context.title}" successfully.`,
  }
}

export async function unlinkPulseFromContext(
  graph: Neo4jGraph,
  input: PulseContextLinkInput
): Promise<PulseContextLinkResult> {
  const pulseId = input.pulseId?.trim()

  if (!pulseId) {
    return {
      success: false,
      message: 'pulseId is required.',
    }
  }

  const contextCandidates = await resolveContextCandidates(
    graph,
    input.contextId,
    input.contextTitle
  )

  if (contextCandidates.length === 0) {
    return {
      success: false,
      message:
        'I could not find the field context to unlink from. Provide contextId or exact contextTitle.',
    }
  }

  if (contextCandidates.length > 1) {
    return {
      success: false,
      requiresDisambiguation: true,
      message: 'Multiple field contexts match. Please provide contextId.',
      candidates: contextCandidates,
    }
  }

  const [context] = contextCandidates

  const cypher = `
    MATCH (context:FieldContext {id: $contextId})-[rel:HAS_PULSE]->(pulse:FieldPulse {id: $pulseId})
    DELETE rel
    RETURN count(rel) AS deleted
  `

  const rows = await graph.query<Record<string, unknown>>(cypher, {
    pulseId,
    contextId: context.id,
  })

  const deleted = Number(rows?.[0]?.deleted || 0)

  if (deleted === 0) {
    return {
      success: false,
      pulseId,
      contextId: context.id,
      contextTitle: context.title,
      message: `No HAS_PULSE link existed between the pulse and "${context.title}".`,
    }
  }

  return {
    success: true,
    pulseId,
    contextId: context.id,
    contextTitle: context.title,
    message: `Removed pulse from "${context.title}" successfully.`,
  }
}
