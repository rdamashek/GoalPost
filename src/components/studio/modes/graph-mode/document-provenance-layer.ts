import type { Node, Relationship } from '@neo4j-nvl/base'
import type { BloomPalette } from './bloom-palette'

/**
 * GOAL-346: the Document provenance layer for the in-field Bloom view —
 * Document nodes plus the EXTRACTED_FROM edges out to the people each one
 * named.
 *
 * Why this exists: the in-field view builds nodes for pulses, people, weaves,
 * the field anchor and nested sub-contexts, and edges for resonance,
 * authorship, weaves, connections and nesting. Documents were not on the
 * canvas at all and EXTRACTED_FROM was never drawn — so a person a document
 * named, who authored no pulse and has no CONNECTED_TO edge, rendered with no
 * edges whatsoever. That is the "people hovering independently" this fixes.
 *
 * Kept out of `bloom-view.tsx` on purpose: that file is already ~1880 lines
 * against CLAUDE.md's 400-line component rule, so this ships as a pure
 * derivation with no React in it — which also makes it directly unit
 * testable, unlike the memos inside the component.
 *
 * This is the FIRST entry of the per-type visibility model GOAL-350
 * generalizes: `visible` is passed in rather than read from a local boolean,
 * so the layer becomes one row of a type-toggle list without being rewritten.
 */

/** Minimal document shape — matches GET_DOCUMENTS_BY_FIELD_CONTEXT. */
export interface ProvenanceDocument {
  id: string
  filename?: string | null
  extractedPeople?: { id: string }[] | null
  /**
   * The pulses ingestion minted from this document. Only ids are read here;
   * the query already selects them for the field page's document list, so
   * this costs no extra round-trip.
   */
  extractedPulses?: { id: string }[] | null
}

export interface DocumentProvenanceLayer {
  nodes: Node[]
  relationships: Relationship[]
}

/**
 * A FRESH object per call, deliberately not a shared module-level singleton.
 * Every early return below hands its result straight to the caller, so one
 * shared instance would let a single caller that ever mutated `nodes` poison
 * every later empty build for the lifetime of the module — surfacing as
 * documents leaking onto a canvas with the toggle switched off. The
 * allocation is free at this call rate.
 */
const empty = (): DocumentProvenanceLayer => ({ nodes: [], relationships: [] })

/**
 * In scale with PERSON_SIZE (30) and PULSE_SIZE (32) in bloom-view. It was 18
 * — small enough that NVL had nowhere to paint the caption, so every document
 * rendered as an anonymous grey dot while every other node carried its label.
 * A provenance hub whose whole job is to say WHICH document a person came from
 * has to show its filename. Slightly under a person, because a document is
 * the source of the cluster, not a peer in it.
 */
export const DOCUMENT_SIZE = 28

/**
 * Build the layer.
 *
 * `visiblePersonIds` is the set of person nodes already on canvas. Edges are
 * filtered against it because `bloom-view` maintains a strict invariant that
 * NVL is never handed a relationship whose endpoint isn't rendered — a
 * dangling arrow is a visual bug, and NVL will not resolve it for us.
 *
 * A document whose extracted people are ALL off-canvas contributes no node.
 * Rendering it would put an isolated Document on the canvas, which is the
 * same disconnected-node problem this layer set out to remove, merely moved
 * onto a different node type.
 */
export function buildDocumentProvenanceLayer(params: {
  documents: readonly ProvenanceDocument[] | null | undefined
  visiblePersonIds: ReadonlySet<string>
  palette: BloomPalette
  visible: boolean
}): DocumentProvenanceLayer {
  const { documents, visiblePersonIds, palette, visible } = params
  if (!visible || !documents || documents.length === 0) return empty()

  const nodes: Node[] = []
  const relationships: Relationship[] = []

  for (const doc of documents) {
    if (!doc?.id) continue

    // Dedupe within a document: the same person can be returned twice if they
    // were extracted across re-ingests, and two identical relationship ids
    // would collide in NVL.
    const linkedPersonIds = new Set<string>()
    for (const person of doc.extractedPeople ?? []) {
      if (person?.id && visiblePersonIds.has(person.id)) {
        linkedPersonIds.add(person.id)
      }
    }
    if (linkedPersonIds.size === 0) continue

    nodes.push({
      id: doc.id,
      caption: doc.filename?.trim() || 'Document',
      color: palette.documentNode,
      size: DOCUMENT_SIZE,
    } as Node)

    for (const personId of linkedPersonIds) {
      relationships.push({
        id: `extracted-from-${doc.id}-${personId}`,
        from: doc.id,
        to: personId,
        caption: 'extracted from',
        color: palette.extractedEdge,
        width: 1.5,
      } as Relationship)
    }
  }

  return { nodes, relationships }
}

/**
 * Every id on the canvas that exists only because a document put it there —
 * the documents themselves, the people they named, and the pulses ingestion
 * minted from them.
 *
 * Switching the Documents layer OFF used to hide the Document nodes and their
 * EXTRACTED_FROM edges and nothing else, which left the extracted people
 * behind as edgeless dots and the extracted pulses behind as a cloud with no
 * visible source: provenance is the only tie most of them have. That is the
 * "independent hanging nodes" problem, and it is why "off" has to mean the
 * whole document-derived subgraph, not just its hub. This function names that
 * subgraph; `applyDocumentHiding` (document-visibility.ts) takes it off the
 * canvas and sweeps up anything the removal strands, including entities the
 * two exemptions below deliberately spare.
 *
 * Two escape hatches keep the rule from eating things that merely *touch* a
 * document. Both spare a node from counting as document CONTENT; NEITHER
 * spares it from the sweep. An exempt person who is left with no edges at all
 * once the documents go is still removed — being spared here buys them the
 * chance to stand on their own edges, not a seat on an empty canvas.
 *
 *   - `curatedPersonIds` — a person a human deliberately promoted onto the
 *     field roster. Curation wins over extraction here for the same reason it
 *     wins in `partitionFieldRoster` (src/lib/field-roster-visibility.ts):
 *     `update_person` stamps EXTRACTED_FROM onto people who ALREADY existed,
 *     so extraction alone does not mean "arrived via a document".
 *   - `anchoredIds` — nodes with a structural reason to be on canvas
 *     regardless of any document. In practice the parent space's owner and
 *     members: they are rendered because they belong to the space, and a
 *     document happening to name them must not evict them — that would strip
 *     the author edge off every pulse they wrote by hand, which is a real
 *     loss where their own disappearance, once nothing is left attached to
 *     them, is not.
 *
 * Pulses have no curated flag, so a hand-written pulse that a later ingest
 * run enriched (`update_pulse` with a documentId appends EXTRACTED_FROM the
 * same way) counts as document-derived here. That is the intended reading for
 * the case this actually fires on — the GOAL-344 article import, where the
 * document IS the article the pulse came from — and it is recoverable in one
 * click, unlike a hanging node, which the user cannot resolve at all.
 *
 * Returns a fresh Set per call; see the note on `empty()` above for why
 * nothing here is a shared module-level singleton.
 */
export function documentDerivedIds(params: {
  documents: readonly ProvenanceDocument[] | null | undefined
  curatedPersonIds?: readonly string[] | null
  anchoredIds?: Iterable<string> | null
}): Set<string> {
  const { documents, curatedPersonIds, anchoredIds } = params
  const derived = new Set<string>()
  if (!documents || documents.length === 0) return derived

  // Two lists, not one merged set: curation is a fact about a PERSON's place
  // on the roster and must not exempt a pulse that happens to share the id
  // space, while `anchoredIds` is deliberately type-agnostic. Neither can
  // exempt the Document itself — it is the thing being switched off.
  const anchored = new Set<string>(anchoredIds ?? [])
  const curated = new Set<string>(curatedPersonIds ?? [])

  for (const doc of documents) {
    if (!doc?.id) continue
    derived.add(doc.id)
    for (const person of doc.extractedPeople ?? []) {
      if (!person?.id) continue
      if (anchored.has(person.id) || curated.has(person.id)) continue
      derived.add(person.id)
    }
    for (const pulse of doc.extractedPulses ?? []) {
      if (!pulse?.id) continue
      if (anchored.has(pulse.id)) continue
      derived.add(pulse.id)
    }
  }
  return derived
}
