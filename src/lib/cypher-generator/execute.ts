/**
 * Safe executor for AI-generated Cypher.
 *
 * - Wraps the validated query inside `CALL { … } RETURN * LIMIT
 *   $maxNodes` so even a forgetful generator can't return a million
 *   rows.
 * - Runs inside `executeRead` with a 5s transaction timeout. A write
 *   that slipped past validation would still be rejected by the driver
 *   here.
 * - Walks every column of every record, collecting Neo4j Node and
 *   Relationship instances. Non-graph columns are silently dropped.
 * - Post-filters the collected nodes against Space-based authorization:
 *   each node is mapped to its enclosing Space, then `canViewContent`
 *   gates access. Nodes the user cannot see are dropped, along with
 *   any relationships that referenced a dropped node.
 *
 * Returns NVL-shape nodes + relationships ready to drop into Bloom.
 */

import neo4j, { type Node, type Relationship } from 'neo4j-driver'
import { driver } from '@/lib/neo4j/driver'
import { canViewContent } from '@/lib/permissions/space-permissions'
import {
  ALLOWED_RELATIONSHIPS,
  type AllowedRelationship,
} from './schema-context'
import { styleFor } from './node-style'
import type { NVLNode, NVLRelationship } from './types'

const MAX_NODES = 60
const MAX_RELS = MAX_NODES * 3
const QUERY_TIMEOUT_MS = 5_000

const SPACE_LABELS = new Set(['MeSpace', 'WeSpace', 'Space'])
/**
 * Labels that are universally visible to every authenticated user
 * regardless of Space-based authorization. Used by the post-execute
 * auth filter as a short-circuit — these nodes need no Space anchor.
 * Communities (a public collective like "GoalPost Core Team") fit
 * this model: the search_community tool already exposes them to any
 * signed-in user, so showing them on the canvas is consistent.
 */
const PUBLIC_LABELS = new Set(['Community'])
/**
 * Synthetic anchor id used by mapNodesToEnclosingSpaces to mark a node
 * as universally visible (no Space membership required). The post-
 * filter accepts the node when this id is in its anchor set without
 * having to look it up against the per-user allowedSpaces set.
 */
const PUBLIC_ANCHOR = '__public__'
const CONTENT_VIA_SPACE = new Set([
  'FieldContext',
  'FieldPulse',
  'GoalPulse',
  'ResourcePulse',
  'StoryPulse',
  'CarePulse',
  'CoreValuePulse',
  // Provenance marker on every migrated core value (GOAL-287/GOAL-333). The
  // driver really does return it FIRST for these nodes
  // (labels = ["CoreValue","FieldPulse","StoryPulse"]), so it must be in this
  // set for the membership test below to classify them as Space-scoped content.
  'CoreValue',
  'ResonanceLink',
])

function captionFor(node: Node): string {
  const p = node.properties as Record<string, unknown>
  const candidates = [
    p.name,
    p.title,
    p.emergentName,
    typeof p.firstName === 'string' && typeof p.lastName === 'string'
      ? `${p.firstName} ${p.lastName}`.trim()
      : null,
    // Document's human label is its filename (only Document carries this
    // prop). Without it a Document would caption as the bare label "Document".
    p.filename,
    p.label,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return node.labels[0] ?? 'Node'
}

function nodeId(node: Node): string | null {
  const id = (node.properties as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

interface CollectedGraph {
  nodes: Map<string, Node>
  rels: Map<string, Relationship>
  capped: boolean
}

/**
 * Walk a result column value and accumulate Neo4j Node / Relationship
 * instances into `acc`. Stops early once the caps are reached so a
 * malicious `RETURN collect(n) AS nodes` (one row carrying thousands
 * of nodes) can't blow past the `LIMIT $maxNodes` cap. The wrapper
 * subquery applies LIMIT at the row level; this caps at the node
 * level for defense in depth.
 */
function collectFromRecord(value: unknown, acc: CollectedGraph): void {
  if (acc.capped) return
  if (value === null || value === undefined) return
  if (neo4j.isNode(value)) {
    const id = nodeId(value)
    if (id && !acc.nodes.has(id)) {
      if (acc.nodes.size >= MAX_NODES) {
        acc.capped = true
        return
      }
      acc.nodes.set(id, value)
    }
    return
  }
  if (neo4j.isRelationship(value)) {
    const id = (value.properties as { id?: unknown }).id
    const key =
      typeof id === 'string' && id
        ? id
        : `${value.startNodeElementId}->${value.type}->${value.endNodeElementId}`
    if (!acc.rels.has(key)) {
      if (acc.rels.size >= MAX_RELS) {
        acc.capped = true
        return
      }
      acc.rels.set(key, value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (acc.capped) return
      collectFromRecord(v, acc)
    }
    return
  }
  if (typeof value === 'object') {
    // Neo4j Path objects expose `.segments` / `.start` / `.end`.
    const obj = value as {
      segments?: Array<{ start?: Node; end?: Node; relationship?: Relationship }>
      start?: Node
      end?: Node
    }
    if (Array.isArray(obj.segments)) {
      if (obj.start) collectFromRecord(obj.start, acc)
      if (obj.end) collectFromRecord(obj.end, acc)
      for (const seg of obj.segments) {
        if (acc.capped) return
        if (seg.start) collectFromRecord(seg.start, acc)
        if (seg.end) collectFromRecord(seg.end, acc)
        if (seg.relationship) collectFromRecord(seg.relationship, acc)
      }
    }
  }
}

/**
 * For each collected node, return every candidate enclosing Space id —
 * any Space whose visibility implies the user may view the node.
 *
 * Multi-candidate (not single) on purpose: a Person who owns their own
 * MeSpace AND is a member of a shared WeSpace has two anchor Spaces.
 * Picking only the first (e.g. their owned MeSpace) would tell the
 * authorization filter to check whether the current user can see
 * *that other person's MeSpace*, which always fails — the Person
 * would be dropped even though the shared WeSpace makes them
 * legitimately visible. Returning all candidates lets the post-filter
 * accept the node if ANY candidate Space is viewable by the user.
 *
 * Every helper query runs through `executeRead` on the session. Bare
 * `session.run` would open an auto-tx in the driver's default access
 * mode (write-capable), so even if a future caller swapped the
 * enclosing transaction we keep these reads on a read tx.
 */
async function mapNodesToEnclosingSpaces(
  session: ReturnType<typeof driver.session>,
  nodes: Node[]
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  if (nodes.length === 0) return result

  const runRead = async (
    query: string,
    params: Record<string, unknown>
  ) => session.executeRead((tx) => tx.run(query, params))

  for (const node of nodes) {
    const id = nodeId(node)
    if (!id) continue
    const labels = node.labels
    const anchors = new Set<string>()

    // Public nodes (Community) need no Space anchor — they're visible
    // to every authenticated user. Use the synthetic "__public__" id
    // so the post-filter recognises them as always-allowed without
    // having to scan the entire allowedSpaces set.
    if (labels.some((l) => PUBLIC_LABELS.has(l))) {
      anchors.add(PUBLIC_ANCHOR)
      result.set(id, anchors)
      continue
    }

    if (labels.some((l) => SPACE_LABELS.has(l))) {
      anchors.add(id)
      result.set(id, anchors)
      continue
    }

    if (labels.includes('FieldContext')) {
      const r = await runRead(
        `MATCH (:FieldContext {id: $id})<-[:HAS_CONTEXT]-(s:Space) RETURN collect(DISTINCT s.id) AS sids`,
        { id }
      )
      const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
      for (const sid of sids) anchors.add(sid)
      result.set(id, anchors)
      continue
    }

    if (labels.includes('PromiseWeave')) {
      // A PromiseWeave is anchored to its FieldContext's Space via the
      // HAS_WEAVE context edge — directly analogous to how a ResonanceLink
      // anchors via HAS_RESONANCE.
      const r = await runRead(
        `MATCH (:PromiseWeave {id: $id})<-[:HAS_WEAVE]-(:FieldContext)<-[:HAS_CONTEXT]-(s:Space) RETURN collect(DISTINCT s.id) AS sids`,
        { id }
      )
      const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
      for (const sid of sids) anchors.add(sid)
      result.set(id, anchors)
      continue
    }

    if (labels.includes('Organization')) {
      // GOAL-298: an Organization is anchored to its FieldContext's Space via
      // the HAS_ORGANIZATION context edge — analogous to PromiseWeave/HAS_WEAVE.
      // Deliberately NOT public (unlike Person/Community): an org extracted into
      // a private MeSpace stays space-scoped, matching its GraphQL type-level
      // auth filter (contexts_SOME). The MENTIONED_IN (s2) branch is one hop
      // wider than that GraphQL filter, but it is safe TODAY because links are
      // co-location-gated (linkEntityToPulseAuthorized requires the org and the
      // pulse to share a context, so s2's space == s1's space) and each candidate
      // space is still independently gated by canViewContent below. If a future
      // write path ever creates a non-co-located MENTIONED_IN, drop the s2 branch
      // to keep this anchor in lockstep with the contexts_SOME GraphQL filter.
      const r = await runRead(
        `
        MATCH (o:Organization {id: $id})
        OPTIONAL MATCH (o)<-[:HAS_ORGANIZATION]-(:FieldContext)<-[:HAS_CONTEXT]-(s1:Space)
        OPTIONAL MATCH (o)-[:MENTIONED_IN]->(:FieldPulse)<-[:HAS_PULSE]-(:FieldContext)<-[:HAS_CONTEXT]-(s2:Space)
        WITH collect(DISTINCT s1.id) + collect(DISTINCT s2.id) AS sids
        RETURN [sid IN sids WHERE sid IS NOT NULL] AS sids
        `,
        { id }
      )
      const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
      for (const sid of sids) anchors.add(sid)
      result.set(id, anchors)
      continue
    }

    // GOAL-354 removed the dedicated :Document branch that used to sit here.
    // A document is a ResourcePulse now, so it is anchored by the
    // CONTENT_VIA_SPACE FieldPulse branch below, through the same HAS_PULSE
    // edge as every other pulse. That branch is equally fail-closed — it
    // anchors strictly via the owning FieldContext and never falls through to
    // the generic *1..3 sweep, which could otherwise reach the uploader's
    // unrelated Spaces through UPLOADED_BY and over-expose the document.

    // `labels.some(...)` rather than `CONTENT_VIA_SPACE.has(labels[0])`: Neo4j
    // gives NO ordering guarantee on a node's labels, and migrated core values
    // demonstrably come back as ["CoreValue","FieldPulse","StoryPulse"] — so the
    // old labels[0] test classified them by whichever label happened to land
    // first. Only the `FieldPulse` disjunct was keeping them out of the
    // permissive generic fallback below, which anchors through ANY Space within
    // 3 undirected hops (e.g. via the pulse's author into that author's own
    // MeSpace) and would surface content from a Space the caller cannot see.
    if (labels.some((l) => CONTENT_VIA_SPACE.has(l))) {
      // Seek the node by its indexed BASE label rather than a label-less
      // `MATCH (p {id})`, which the planner can only satisfy with an
      // AllNodesScan of the whole graph per content node (the id UNIQUE
      // constraint only applies to a labelled pattern). Both base labels this
      // branch handles — FieldPulse (all pulse subtypes) and ResonanceLink —
      // carry a UNIQUE id constraint, so the seek is O(1). The label is taken
      // from the node's OWN labels (never user input), so the seek returns the
      // exact same node; only the plan changes. Fall back to label-less for the
      // unexpected case where neither base label is present.
      const seekLabel = labels.includes('FieldPulse')
        ? 'FieldPulse'
        : labels.includes('ResonanceLink')
          ? 'ResonanceLink'
          : null
      const r = await runRead(
        `
        MATCH (${seekLabel ? `p:${seekLabel}` : 'p'} {id: $id})
        OPTIONAL MATCH (p)<-[:HAS_PULSE]-(:FieldContext)<-[:HAS_CONTEXT]-(s1:Space)
        OPTIONAL MATCH (p)<-[:SOURCE|TARGET]-(:ResonanceLink)<-[:HAS_RESONANCE]-(:FieldContext)<-[:HAS_CONTEXT]-(s2:Space)
        OPTIONAL MATCH (p)<-[:HAS_RESONANCE]-(:FieldContext)<-[:HAS_CONTEXT]-(s3:Space)
        WITH collect(DISTINCT s1.id) + collect(DISTINCT s2.id) + collect(DISTINCT s3.id) AS sids
        RETURN [sid IN sids WHERE sid IS NOT NULL] AS sids
        `,
        { id }
      )
      const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
      for (const sid of sids) anchors.add(sid)
      result.set(id, anchors)
      continue
    }

    if (labels.includes('Person')) {
      // Per kb/02-user-roles.md, Person nodes are readable by ANY
      // authenticated user (no Space filter) — search_person,
      // get_focal_entity, and the profile page all expose a person
      // regardless of Space overlap. The Bloom canvas MUST match that
      // model. The old space/community anchor check broke for a personal
      // contact who is only CONNECTED_TO the user (e.g. a spouse or
      // friend who owns no Space and joins no Community): they have no
      // anchor, so the post-filter dropped them and the user saw a graph
      // with only themselves on it ("the graph is not showing anything").
      // Mark every Person universally visible via the synthetic public
      // anchor, consistent with how Communities are handled above.
      anchors.add(PUBLIC_ANCHOR)
      result.set(id, anchors)
      continue
    }

    if (labels.includes('SpaceMembership')) {
      // A SpaceMembership belongs to EXACTLY the Space that HAS_MEMBER it —
      // anchor there and nowhere else, exactly as Document anchors to its
      // FieldContext's Space above.
      //
      // It must not fall through to the generic sweep below: three undirected
      // hops is precisely enough to escape the membership's own Space and land
      // on a different Space the same person belongs to —
      //   (sm)-[:IS_MEMBER]->(person)<-[:IS_MEMBER]-(sm2)<-[:HAS_MEMBER]-(other)
      // — so a membership held by someone else INSIDE A SPACE THE CALLER CANNOT
      // SEE was anchored through a space they share with that person and kept,
      // while the hidden Space itself was correctly dropped. That disclosed the
      // existence of a cross-boundary membership (and rendered it on the canvas
      // captioned with the raw label, a kb/07 Rule 1 leak). Found by the
      // GOAL-333 security review; fail closed to the owning Space.
      const r = await runRead(
        `MATCH (:SpaceMembership {id: $id})<-[:HAS_MEMBER]-(s:Space) RETURN collect(DISTINCT s.id) AS sids`,
        { id }
      )
      const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
      for (const sid of sids) anchors.add(sid)
      result.set(id, anchors)
      continue
    }

    // FieldResonance / unknown — anchor through any adjacent Space at up to
    // 3 hops.
    const r = await runRead(
      `
      MATCH (n {id: $id})
      OPTIONAL MATCH (n)-[*1..3]-(s:Space)
      RETURN collect(DISTINCT s.id) AS sids
      `,
      { id }
    )
    const sids = (r.records[0]?.get('sids') as string[] | null) ?? []
    for (const sid of sids) anchors.add(sid)
    result.set(id, anchors)
  }

  return result
}

/**
 * Find every whitelisted relationship that exists between any two of
 * `nodeIds` and isn't already in `existingKeys`. Lets the executor
 * rescue the visual when the generator MATCHed edges but forgot to
 * bind / RETURN them. Bounded by `budget` so we honor the row cap.
 *
 * Uses the project's allowed-relationships whitelist as the disjunction
 * filter so the query is safe and bounded regardless of what surprise
 * relationship types might exist in the graph.
 *
 * The seek carries a LABEL EXPRESSION for the same reason branch 7 of
 * `mapNodesToEnclosingSpaces` does: a label-less `MATCH (a {id: aid})` cannot
 * use the per-label `REQUIRE n.id IS UNIQUE` constraints, so the planner falls
 * back to an `AllNodesScan` PER ID — measured at 487k dbHits / 2.4s for 60 ids
 * on a small dev graph, and it grows linearly with total graph size forever.
 * The disjunction below is a fixed, code-controlled list (never user input),
 * so the seek returns exactly the same nodes; only the plan changes —
 * `Union` of `NodeUniqueIndexSeek`s, measured at 2.1k dbHits (−99.6%).
 * Any id whose label is outside this list simply matches nothing here, which
 * costs at most a missing rescued edge — never a wrong one.
 */
const SEEKABLE_LABELS = [
  'FieldPulse',
  'FieldContext',
  'Space',
  'Person',
  'SpaceMembership',
  'ResonanceLink',
  'Document',
  'Organization',
  'Community',
  'PromiseWeave',
].join('|')

async function fillInRelationships(
  session: ReturnType<typeof driver.session>,
  nodeIds: string[],
  budget: number,
  existingKeys: Set<string>
): Promise<NVLRelationship[]> {
  if (nodeIds.length < 2 || budget <= 0) return []
  const allowed: AllowedRelationship[] = [...ALLOWED_RELATIONSHIPS]
  const result = await session.executeRead((tx) =>
    tx.run(
      `
      UNWIND $nodeIds AS aid
      MATCH (a:${SEEKABLE_LABELS} {id: aid})
      MATCH (a)-[r]->(b)
      WHERE b.id IN $nodeIds AND type(r) IN $allowedTypes
      RETURN a.id AS fromId, b.id AS toId, type(r) AS relType, r.id AS relId
      LIMIT $budget
      `,
      {
        nodeIds,
        allowedTypes: allowed,
        budget: neo4j.int(budget),
      }
    )
  )

  const rels: NVLRelationship[] = []
  for (const record of result.records) {
    const fromId = record.get('fromId') as string | null
    const toId = record.get('toId') as string | null
    const relType = record.get('relType') as string | null
    const relPropId = record.get('relId') as string | null
    if (!fromId || !toId || !relType) continue
    // Synthesise a stable key so dedupe works against the originally
    // collected relationships (which key on `id` or `from->type->to`).
    const key =
      typeof relPropId === 'string' && relPropId
        ? relPropId
        : `${fromId}-${relType}->${toId}`
    if (existingKeys.has(key)) continue
    existingKeys.add(key)
    rels.push({
      id: key,
      from: fromId,
      to: toId,
      caption: relType,
    })
  }
  return rels
}

export interface ExecuteArgs {
  cypher: string
  userId: string
  params?: Record<string, unknown>
}

export interface ExecutionFailure {
  ok: false
  reason: string
}

export interface ExecutionSuccess {
  ok: true
  nodes: NVLNode[]
  relationships: NVLRelationship[]
  rawNodeCount: number
  filteredNodeCount: number
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure

export async function executeForBloom(
  args: ExecuteArgs
): Promise<ExecutionResult> {
  const wrapped = `CALL { ${args.cypher} } RETURN * LIMIT $maxNodes`
  const session = driver.session()
  try {
    const collected: CollectedGraph = {
      nodes: new Map(),
      rels: new Map(),
      capped: false,
    }

    const result = await session.executeRead(
      (tx) =>
        tx.run(
          wrapped,
          {
            ...(args.params ?? {}),
            userId: args.userId,
            maxNodes: neo4j.int(MAX_NODES),
          }
        ),
      { timeout: QUERY_TIMEOUT_MS }
    )

    outer: for (const record of result.records) {
      for (const key of record.keys) {
        collectFromRecord(record.get(key as string), collected)
        if (collected.capped) break outer
      }
    }

    const rawNodeCount = collected.nodes.size

    // Authorization post-filter — every kept node must reach at least
    // one Space the user can view.
    const nodeArray = [...collected.nodes.values()]
    const enclosingSpaces = await mapNodesToEnclosingSpaces(session, nodeArray)
    const allCandidateSpaces = new Set<string>()
    for (const candidates of enclosingSpaces.values()) {
      for (const sid of candidates) allCandidateSpaces.add(sid)
    }

    const allowedSpaces = new Set<string>()
    for (const spaceId of allCandidateSpaces) {
      if (spaceId === PUBLIC_ANCHOR) continue // resolved short-circuit, no canViewContent call needed
      // canViewContent opens its own read tx — safe to share the session.
      const allowed = await canViewContent(session, args.userId, spaceId)
      if (allowed) allowedSpaces.add(spaceId)
    }

    const keptNodeIds = new Set<string>()
    for (const node of nodeArray) {
      const id = nodeId(node)
      if (!id) continue
      const candidates = enclosingSpaces.get(id)
      if (!candidates || candidates.size === 0) continue
      let ok = false
      for (const sid of candidates) {
        // PUBLIC_ANCHOR means "node is always visible" (e.g. Community).
        if (sid === PUBLIC_ANCHOR || allowedSpaces.has(sid)) {
          ok = true
          break
        }
      }
      if (ok) keptNodeIds.add(id)
    }

    const nvlNodes: NVLNode[] = nodeArray
      .filter((n) => {
        const id = nodeId(n)
        return id !== null && keptNodeIds.has(id)
      })
      .map((n) => {
        const { color, size } = styleFor(n.labels)
        return {
          id: nodeId(n)!,
          caption: captionFor(n),
          color,
          size,
          labels: n.labels,
        }
      })

    const nvlRels: NVLRelationship[] = []
    // `seenRelKeys` MUST share its key format with `fillInRelationships`,
    // otherwise the fill-in step re-adds every structural edge (HAS_PULSE,
    // HAS_CONTEXT, OWNS, HAS_MEMBER, CREATED_BY, …) that came back from the
    // generator's own query and the canvas renders each edge twice.
    // `collected.rels` was keyed by element-id (which fillIn has no access
    // to), so we re-key here by the property-id format fillIn uses.
    const seenRelKeys = new Set<string>()
    for (const rel of collected.rels.values()) {
      // Resolve from/to ids by walking element ids back to property ids.
      const fromNode = nodeArray.find(
        (n) => n.elementId === rel.startNodeElementId
      )
      const toNode = nodeArray.find(
        (n) => n.elementId === rel.endNodeElementId
      )
      const fromId = fromNode ? nodeId(fromNode) : null
      const toId = toNode ? nodeId(toNode) : null
      if (!fromId || !toId) continue
      if (!keptNodeIds.has(fromId) || !keptNodeIds.has(toId)) continue
      const relPropId = (rel.properties as { id?: unknown }).id
      const dedupKey =
        typeof relPropId === 'string' && relPropId
          ? relPropId
          : `${fromId}-${rel.type}->${toId}`
      if (seenRelKeys.has(dedupKey)) continue
      seenRelKeys.add(dedupKey)
      nvlRels.push({
        id: dedupKey,
        from: fromId,
        to: toId,
        caption: rel.type,
      })
    }

    // Defense in depth: ask Neo4j for every whitelisted relationship
    // between any two kept nodes that the generator didn't already
    // return. This rescues the visual when the LLM matches edges but
    // forgets to bind / RETURN them (you see disconnected nodes
    // floating on the canvas otherwise). Bounded by MAX_RELS minus what
    // we already have so we still honor the row cap.
    const remainingRelBudget = MAX_RELS - nvlRels.length
    if (keptNodeIds.size >= 2 && remainingRelBudget > 0) {
      const filled = await fillInRelationships(
        session,
        [...keptNodeIds],
        remainingRelBudget,
        seenRelKeys
      )
      for (const rel of filled) nvlRels.push(rel)
    }

    return {
      ok: true,
      nodes: nvlNodes,
      relationships: nvlRels,
      rawNodeCount,
      filteredNodeCount: nvlNodes.length,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Unknown execution error',
    }
  } finally {
    await session.close()
  }
}
