/**
 * Unit tests for the Documents visibility pass.
 *
 * The pass exists because removing the document-derived subgraph is only half
 * of what "switch documents off" has to mean: the removal strands whatever was
 * hanging off it, and a stranded node is the exact floating dot the Document
 * layer was built to eliminate. So the cases that matter here are the ones
 * where a node SURVIVES the hiding rule and is stranded anyway — the curated
 * roster person, the space owner whose only pulses came from an upload, the
 * PromiseWeave that wove only extracted pulses.
 *
 * The mirror-image risk gets equal weight: a node that was already alone
 * before anything was hidden must be left standing. Sweeping those would
 * silently delete real content (a pulse nobody is credited for) on a toggle
 * that never touched it.
 */
import type { Node, Relationship } from '@neo4j-nvl/base'
import { applyDocumentHiding } from './document-visibility'

const node = (id: string): Node => ({ id, caption: id }) as Node

const edge = (from: string, to: string): Relationship =>
  ({ id: `${from}->${to}`, from, to }) as Relationship

const ids = (nodes: Node[]) => nodes.map((n) => n.id).sort()
const edgeIds = (rels: Relationship[]) => rels.map((r) => r.id).sort()

const apply = (
  nodes: Node[],
  relationships: Relationship[],
  hidden: string[],
  protectedIds: string[] = []
) =>
  applyDocumentHiding({
    nodes,
    relationships,
    hiddenIds: new Set(hidden),
    protectedIds: new Set(protectedIds),
  })

describe('applyDocumentHiding', () => {
  describe('with nothing hidden', () => {
    it('returns the very same arrays, by identity', () => {
      const nodes = [node('a'), node('b')]
      const relationships = [edge('a', 'b')]
      const result = applyDocumentHiding({
        nodes,
        relationships,
        hiddenIds: new Set(),
      })
      // Identity, not just equality: the default view is documents-ON, and
      // downstream memos keyed on these arrays must not invalidate.
      expect(result.nodes).toBe(nodes)
      expect(result.relationships).toBe(relationships)
    })
  })

  describe('removing the hidden nodes', () => {
    it('drops them and every edge that touched them', () => {
      const { nodes, relationships } = apply(
        [node('doc'), node('person'), node('pulse')],
        [edge('doc', 'person'), edge('pulse', 'person')],
        ['doc']
      )
      expect(ids(nodes)).toEqual(['person', 'pulse'])
      expect(edgeIds(relationships)).toEqual(['pulse->person'])
    })

    it('never leaves an edge whose endpoint is gone — the NVL invariant', () => {
      const { nodes, relationships } = apply(
        [node('doc'), node('p1'), node('p2'), node('keep')],
        [edge('doc', 'p1'), edge('doc', 'p2'), edge('keep', 'p1')],
        ['doc', 'p1']
      )
      const rendered = new Set(nodes.map((n) => n.id))
      for (const rel of relationships) {
        expect(rendered.has(rel.from)).toBe(true)
        expect(rendered.has(rel.to)).toBe(true)
      }
    })

    it('tolerates a hidden id that is not on the canvas at all', () => {
      const { nodes } = apply([node('a')], [], ['ghost'])
      expect(ids(nodes)).toEqual(['a'])
    })
  })

  describe('sweeping what the removal stranded', () => {
    /**
     * The curated roster person: spared by the hiding rule, but EXTRACTED_FROM
     * was the only edge they had. This is the original bug arriving through
     * the escape hatch meant to protect them.
     */
    it('sweeps a spared person whose only edge was to a hidden document', () => {
      const { nodes } = apply(
        [node('doc'), node('curated'), node('pulse'), node('author')],
        [edge('doc', 'curated'), edge('pulse', 'author')],
        ['doc']
      )
      expect(ids(nodes)).toEqual(['author', 'pulse'])
    })

    /** The space owner whose every pulse came from an upload. */
    it('sweeps an anchored person left with no visible pulse to author', () => {
      const { nodes } = apply(
        [node('doc'), node('owner'), node('extracted-pulse')],
        [edge('doc', 'owner'), edge('extracted-pulse', 'owner')],
        ['doc', 'extracted-pulse']
      )
      expect(ids(nodes)).toEqual([])
    })

    it('keeps that person when they still author something of their own', () => {
      const { nodes } = apply(
        [
          node('doc'),
          node('owner'),
          node('extracted-pulse'),
          node('hand-written'),
        ],
        [
          edge('extracted-pulse', 'owner'),
          edge('hand-written', 'owner'),
          edge('doc', 'owner'),
        ],
        ['doc', 'extracted-pulse']
      )
      expect(ids(nodes)).toEqual(['hand-written', 'owner'])
    })

    it('sweeps a weave whose every woven pulse was hidden', () => {
      const { nodes } = apply(
        [node('doc'), node('p1'), node('p2'), node('weave')],
        [edge('weave', 'p1'), edge('weave', 'p2'), edge('doc', 'p1')],
        ['doc', 'p1', 'p2']
      )
      expect(ids(nodes)).toEqual([])
    })

    it('keeps a weave that still holds one visible pulse', () => {
      const { nodes } = apply(
        [node('p1'), node('mine'), node('weave')],
        [edge('weave', 'p1'), edge('weave', 'mine')],
        ['p1']
      )
      expect(ids(nodes)).toEqual(['mine', 'weave'])
    })

    /**
     * A node that lost SOME edges but not all of them is not stranded. This is
     * the boundary of the degree rule, and it is also why a single pass is
     * enough: nothing survives with degree 0 while still holding something
     * else up, so stranding cannot cascade to a second rank.
     */
    it('keeps a node that lost one edge but kept another', () => {
      const { nodes, relationships } = apply(
        [node('hidden'), node('a'), node('b')],
        [edge('hidden', 'a'), edge('a', 'b')],
        ['hidden']
      )
      expect(ids(nodes)).toEqual(['a', 'b'])
      expect(edgeIds(relationships)).toEqual(['a->b'])
    })

    it('sweeps every node a single removal strands, in one pass', () => {
      const { nodes } = apply(
        [node('hidden'), node('a'), node('b'), node('paired')],
        [edge('hidden', 'a'), edge('hidden', 'b'), edge('paired', 'a')],
        ['hidden']
      )
      // 'b' hung off 'hidden' alone → swept. 'a' and 'paired' hold each other
      // up → both stand.
      expect(ids(nodes)).toEqual(['a', 'paired'])
    })
  })

  /**
   * The over-removal guard. A pulse is a first-class contribution that belongs
   * to the field whoever is credited on it, so the sweep must never take one —
   * even when hiding its author is what stranded it.
   */
  describe('protectedIds', () => {
    it('keeps a protected node the removal stranded', () => {
      const { nodes } = apply(
        [node('extracted-author'), node('hand-written')],
        [edge('hand-written', 'extracted-author')],
        ['extracted-author'],
        ['hand-written']
      )
      expect(ids(nodes)).toEqual(['hand-written'])
    })

    it('still hides a protected node that is explicitly hidden', () => {
      // Protection guards against the SWEEP, never against the hiding rule —
      // an extracted pulse is document content and goes with the documents.
      const { nodes } = apply(
        [node('extracted-pulse'), node('other')],
        [edge('extracted-pulse', 'other')],
        ['extracted-pulse'],
        ['extracted-pulse']
      )
      expect(ids(nodes)).toEqual([])
    })

    it('does not extend protection to the unprotected nodes beside it', () => {
      const { nodes } = apply(
        [node('doc'), node('person'), node('pulse')],
        [edge('doc', 'person'), edge('doc', 'pulse')],
        ['doc'],
        ['pulse']
      )
      // The same removal strands both. The pulse is protected and stands;
      // the person is not, and goes.
      expect(ids(nodes)).toEqual(['pulse'])
    })
  })

  describe('leaving alone what was already alone', () => {
    it('keeps a node that never had an edge', () => {
      const { nodes } = apply(
        [node('doc'), node('person'), node('lonely-pulse')],
        [edge('doc', 'person')],
        ['doc']
      )
      // 'person' is swept (it lost its only edge); 'lonely-pulse' stands,
      // because the toggle did not strand it — it was always on its own, and
      // deleting standing content on an unrelated switch would hide real
      // pulses with no way to bring them back.
      expect(ids(nodes)).toEqual(['lonely-pulse'])
    })

    it('keeps an edgeless graph completely intact', () => {
      const { nodes } = apply([node('a'), node('b')], [], ['ghost'])
      expect(ids(nodes)).toEqual(['a', 'b'])
    })
  })

  describe('purity', () => {
    it('does not mutate the arrays or the hidden set it is given', () => {
      const nodes = [node('doc'), node('person')]
      const relationships = [edge('doc', 'person')]
      const hiddenIds = new Set(['doc'])
      applyDocumentHiding({ nodes, relationships, hiddenIds })
      expect(ids(nodes)).toEqual(['doc', 'person'])
      expect(edgeIds(relationships)).toEqual(['doc->person'])
      expect([...hiddenIds]).toEqual(['doc'])
    })

    it('returns no edge whose endpoint is missing from the input nodes', () => {
      // The caller today never builds such an edge, but this is the primitive
      // GOAL-350's per-type visibility list will reuse, and the invariant is
      // the whole point of the pass.
      const { nodes, relationships } = apply(
        [node('a'), node('doc')],
        [edge('a', 'never-rendered'), edge('doc', 'a')],
        ['doc']
      )
      const rendered = new Set(nodes.map((n) => n.id))
      for (const rel of relationships) {
        expect(rendered.has(rel.from)).toBe(true)
        expect(rendered.has(rel.to)).toBe(true)
      }
    })

    it('preserves the styling on every node and edge it keeps', () => {
      const styled = { id: 'keep', caption: 'Keep', color: '#abcdef' } as Node
      const styledEdge = {
        id: 'keep->other',
        from: 'keep',
        to: 'other',
        caption: 'weaves',
        color: '#123456',
      } as Relationship
      const { nodes, relationships } = apply(
        [styled, node('other'), node('doc')],
        [styledEdge, edge('doc', 'other')],
        ['doc']
      )
      expect(nodes).toContain(styled)
      expect(relationships).toContain(styledEdge)
    })
  })
})
