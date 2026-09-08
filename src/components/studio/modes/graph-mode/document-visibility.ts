import type { Node, Relationship } from '@neo4j-nvl/base'

/**
 * The second half of the Documents toggle: `documentDerivedIds`
 * (`document-provenance-layer.ts`) names what came from a document, and this
 * takes it off the built canvas.
 *
 * It runs over the FINISHED graph — every node and every edge Bloom would
 * otherwise hand NVL, documents included — rather than filtering each memo at
 * the source. Two reasons:
 *
 *   1. Removing a node is only half the job. The requirement is that switching
 *      documents off leaves NO independent hanging nodes where there used to
 *      be edges, and you cannot see that a node has been stranded until the
 *      whole edge set exists. A curated roster person who survives the hiding
 *      rule still loses their EXTRACTED_FROM edge, which was the only tie they
 *      had; so does a space owner whose every pulse came from an upload. Both
 *      are the exact floating-dot bug the layer was built to remove, arriving
 *      through the escape hatches meant to protect them — which is why those
 *      exemptions spare a node from being treated as document CONTENT, and
 *      never from being swept once it is left with nothing to hang on.
 *   2. One pass over one graph cannot disagree with itself. `bloom-view`
 *      maintains a strict invariant that NVL is never handed a relationship
 *      whose endpoint isn't rendered; filtering nodes and edges in separate
 *      memos is how that invariant gets broken.
 *
 * Nothing here knows what a Document is. It takes a set of ids to remove and
 * answers "what is left standing, and what did that strand?", which is why it
 * generalizes to the per-type visibility list of GOAL-350 without a rewrite.
 */

export interface HiddenGraph {
  nodes: Node[]
  relationships: Relationship[]
}

/**
 * Two rules bound the sweep, and between them they are the whole design:
 *
 *   - Only a node that HAD an edge is swept. A node already sitting on its own
 *     before anything was hidden — a pulse nobody is credited for, a
 *     PromiseWeave that weaves nothing — is left exactly where it was: the
 *     toggle did not strand it, and quietly removing standing content because
 *     a switch was flipped elsewhere is a worse bug than the dot.
 *   - `protectedIds` are never swept at all. The caller passes the field's own
 *     pulses, because a pulse is a first-class contribution that belongs to
 *     the field whoever is credited on it (kb/01-glossary.md). Without this, a
 *     hand-written pulse whose only edge is `initiated` → a person a document
 *     named would vanish from the canvas when documents are switched off: the
 *     pulse is not document content, and losing it is not a trade worth making
 *     to tidy away one dot. It stays, unattached and clickable.
 *
 * A single pass is provably enough. Stranding cannot cascade under a degree-0
 * rule: a stranded node has no surviving edges, so nothing was hanging off it
 * to be stranded in turn. (A rule based on reachability from an anchor would
 * cascade — this one cannot, and a loop here would be dead code.)
 *
 * Returns the input arrays by identity when there is nothing to hide, so the
 * default view (documents ON) pays no allocation and downstream memos keyed on
 * these arrays don't invalidate.
 */
export function applyDocumentHiding(params: {
  nodes: Node[]
  relationships: Relationship[]
  hiddenIds: ReadonlySet<string>
  /** Ids that may be hidden outright, but are never swept for being stranded. */
  protectedIds?: ReadonlySet<string>
}): HiddenGraph {
  const { nodes, relationships, hiddenIds, protectedIds } = params
  if (hiddenIds.size === 0) return { nodes, relationships }

  // Anything with an edge in the graph as built. Membership here is what
  // separates "the toggle stranded this" from "this was always alone".
  const hadEdge = new Set<string>()
  for (const rel of relationships) {
    hadEdge.add(rel.from)
    hadEdge.add(rel.to)
  }

  const survivingEdges = relationships.filter(
    (rel) => !hiddenIds.has(rel.from) && !hiddenIds.has(rel.to)
  )

  const degree = new Set<string>()
  for (const rel of survivingEdges) {
    degree.add(rel.from)
    degree.add(rel.to)
  }

  const survivingNodes = nodes.filter((node) => {
    if (hiddenIds.has(node.id)) return false
    if (protectedIds?.has(node.id)) return true
    // Stranded: it was attached to something, and now it isn't.
    return !(hadEdge.has(node.id) && !degree.has(node.id))
  })

  // Belt and braces on the invariant this pass exists to hold. Today's caller
  // only ever builds edges between nodes it also emits, so this drops nothing
  // — but this is the primitive GOAL-350's per-type visibility list will call,
  // and that caller won't have `bloom-view`'s guards.
  const renderedIds = new Set(survivingNodes.map((node) => node.id))

  return {
    nodes: survivingNodes,
    relationships: survivingEdges.filter(
      (rel) => renderedIds.has(rel.from) && renderedIds.has(rel.to)
    ),
  }
}
