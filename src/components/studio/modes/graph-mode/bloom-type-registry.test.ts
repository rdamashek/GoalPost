/**
 * GOAL-350 — the Bloom canvas type filter.
 *
 * These lock the two invariants the story is actually about, both of which are
 * invisible in a screenshot and easy to regress:
 *
 *   1. Hiding a NODE type cascades to every edge incident to it, so NVL is
 *      never handed an arrow to a node that isn't drawn.
 *   2. Hiding a RELATIONSHIP type hides only edges — its endpoint nodes stay.
 *
 * Plus the property that keeps the toggle list honest: nothing is hidden that
 * the registry cannot name, because "not drawn" must never be mistakable for
 * "not there" or "not permitted" (kb/02-user-roles.md).
 */
import type { Node, Relationship } from '@neo4j-nvl/base'
import {
  BLOOM_NODE_TYPES,
  BLOOM_RELATIONSHIP_TYPES,
  DEFAULT_HIDDEN_TYPE_KEYS,
  DOCUMENT_TYPE_KEY,
  applyBloomTypeFilters,
  nodeTypeKey,
  normalizeColor,
  presentNodeRows,
  presentRelationshipRows,
  relationshipTypeKey,
} from './bloom-type-registry'
import {
  BLOOM_PALETTE_DARK as DARK,
  BLOOM_PALETTE_LIGHT as LIGHT,
} from './bloom-palette'

const node = (id: string, color: string): Node =>
  ({ id, caption: id, color, size: 30 }) as Node

const edge = (
  id: string,
  from: string,
  to: string,
  color: string
): Relationship => ({ id, from, to, color, caption: id }) as Relationship

/**
 * A miniature in-field canvas: two goals and a person, the person authoring
 * both goals, plus a document that named them.
 */
function fieldCanvas() {
  return {
    nodes: [
      node('goal-1', DARK.pulse.goal),
      node('goal-2', DARK.pulse.goal),
      node('person-1', DARK.person),
      node('doc-1', DARK.documentNode),
    ],
    relationships: [
      edge('initiated-1', 'goal-1', 'person-1', DARK.initiatedEdge),
      edge('initiated-2', 'goal-2', 'person-1', DARK.initiatedEdge),
      edge('resonance-1', 'goal-1', 'goal-2', DARK.resonanceEdge),
      edge('extracted-1', 'doc-1', 'person-1', DARK.extractedEdge),
    ],
  }
}

describe('registry integrity', () => {
  it('gives every row a unique key across nodes and relationships', () => {
    // The hidden set is ONE set spanning both tables, so a duplicated key
    // would silently bind two unrelated toggles to each other.
    const keys = [...BLOOM_NODE_TYPES, ...BLOOM_RELATIONSHIP_TYPES].map(
      (r) => r.key
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('opens with nothing hidden', () => {
    // Documents were the one default-off row until GOAL-346 reversed it on
    // `dev`: with the layer off, a person a document named has no other edge
    // and the canvas opened full of edgeless dots. The mechanism stays (the
    // volume argument that motivated it is still live) — the LIST is what has
    // to stay empty, or the reversal is silently undone.
    expect([...DEFAULT_HIDDEN_TYPE_KEYS]).toEqual([])
  })

  it('decodes the Document node colour in BOTH modes', () => {
    // Not covered by the GOAL-288 drift guard (which walks space/field/pulse/
    // person/weave only), and a light-mode miss would drop the Documents
    // toggle entirely for light-mode viewers.
    expect(nodeTypeKey(node('d', DARK.documentNode))).toBe('document')
    expect(nodeTypeKey(node('d', LIGHT.documentNode))).toBe('document')
  })

  it('decodes every native edge colour in both modes', () => {
    const cases: Array<[string, string]> = [
      ['resonates-with', 'resonanceEdge'],
      ['weaves', 'weaveEdge'],
      ['connected-to', 'connectedEdge'],
      ['initiated-by', 'initiatedEdge'],
      ['structural', 'structuralEdge'],
      ['extracted-from', 'extractedEdge'],
    ]
    for (const [key, paletteKey] of cases) {
      const dark = DARK[paletteKey as keyof typeof DARK] as string
      const light = LIGHT[paletteKey as keyof typeof LIGHT] as string
      expect(relationshipTypeKey(edge('e', 'a', 'b', dark))).toBe(key)
      expect(relationshipTypeKey(edge('e', 'a', 'b', light))).toBe(key)
    }
  })
})

describe('presentRows — the toggle list derives from the canvas', () => {
  const asColors = (...c: string[]) => new Set(c.map(normalizeColor))

  it('offers only the types this scope painted', () => {
    const rows = presentNodeRows(asColors(DARK.pulse.goal, DARK.person))
    expect(rows.map((r) => r.key)).toEqual(['goal', 'person'])
  })

  it('surfaces a new type with no per-type work — a colour is enough', () => {
    expect(
      presentNodeRows(asColors(DARK.documentNode)).map((r) => r.key)
    ).toEqual(['document'])
  })

  it('offers the edge rows a field scope paints', () => {
    const rows = presentRelationshipRows(
      asColors(DARK.initiatedEdge, DARK.extractedEdge)
    )
    expect(rows.map((r) => r.key)).toEqual(['initiated-by', 'extracted-from'])
  })

  /**
   * The dead-toggle guard. `Organization` shares the WeSpace field tint, so a
   * presence check against raw `row.colors` would offer an Organization switch
   * that `nodeTypeKey` can never return — it would flip, change nothing, and
   * still bump the legend's hidden-count, telling the viewer a type was hidden
   * when it wasn't. Presence and filtering must resolve identically.
   */
  it('never offers a row the filter cannot act on', () => {
    const offeredButUnreachable = [
      ...BLOOM_NODE_TYPES,
      ...BLOOM_RELATIONSHIP_TYPES,
    ].filter((row) => {
      const colors = asColors(...row.colors)
      const offered = (
        row.kind === 'node'
          ? presentNodeRows(colors)
          : presentRelationshipRows(colors)
      ).some((r) => r.key === row.key)
      if (!offered) return false
      return !row.colors.some(
        (c) =>
          (row.kind === 'node'
            ? nodeTypeKey(node('x', c))
            : relationshipTypeKey(edge('x', 'a', 'b', c))) === row.key
      )
    })
    expect(offeredButUnreachable.map((r) => r.key)).toEqual([])
  })

  it('routes a colour claimed by two rows to exactly one row', () => {
    // '#5eead4' is both the dark WeSpace field tint and the overlay's
    // Organization colour. One row wins; the other is never offered.
    const rows = presentNodeRows(asColors('#5eead4'))
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe(nodeTypeKey(node('x', '#5eead4')))
  })
})

describe('applyBloomTypeFilters', () => {
  it('is a no-op — same object — when nothing is hidden', () => {
    const canvas = fieldCanvas()
    expect(applyBloomTypeFilters(canvas, new Set())).toBe(canvas)
  })

  it('cascades: hiding a node type drops every edge incident to it', () => {
    const { nodes, relationships } = applyBloomTypeFilters(
      fieldCanvas(),
      new Set(['person'])
    )
    expect(nodes.map((n) => n.id)).toEqual(['goal-1', 'goal-2', 'doc-1'])
    // Both `initiated` edges and the `extracted from` edge ended on the
    // person, so all three go. The goal↔goal resonance survives untouched.
    expect(relationships.map((r) => r.id)).toEqual(['resonance-1'])
  })

  it('hiding Documents takes its EXTRACTED_FROM edges with it, and nothing else', () => {
    const { nodes, relationships } = applyBloomTypeFilters(
      fieldCanvas(),
      // The Documents row, named directly: it is no longer a default, and
      // this test is about the cascade, not about what ships switched off.
      new Set([DOCUMENT_TYPE_KEY])
    )
    expect(nodes.map((n) => n.id)).toEqual(['goal-1', 'goal-2', 'person-1'])
    expect(relationships.map((r) => r.id)).toEqual([
      'initiated-1',
      'initiated-2',
      'resonance-1',
    ])
  })

  it('hiding a relationship type leaves its endpoint nodes on canvas', () => {
    const { nodes, relationships } = applyBloomTypeFilters(
      fieldCanvas(),
      new Set(['initiated-by'])
    )
    expect(nodes.map((n) => n.id)).toEqual([
      'goal-1',
      'goal-2',
      'person-1',
      'doc-1',
    ])
    expect(relationships.map((r) => r.id)).toEqual([
      'resonance-1',
      'extracted-1',
    ])
  })

  it('never leaves a dangling edge, whatever combination is hidden', () => {
    const allKeys = [...BLOOM_NODE_TYPES, ...BLOOM_RELATIONSHIP_TYPES].map(
      (r) => r.key
    )
    for (const key of allKeys) {
      const { nodes, relationships } = applyBloomTypeFilters(
        fieldCanvas(),
        new Set([key, 'person'])
      )
      const ids = new Set(nodes.map((n) => String(n.id)))
      for (const r of relationships) {
        expect(ids.has(String(r.from))).toBe(true)
        expect(ids.has(String(r.to))).toBe(true)
      }
    }
  })

  it('keeps anything the registry cannot name', () => {
    const canvas = {
      nodes: [node('mystery', '#123456')],
      relationships: [edge('mystery-edge', 'mystery', 'mystery', '#123456')],
    }
    // Hiding literally every known type must not drop an undecodable node:
    // silently withholding data the filter cannot even label would read as
    // missing content, or as a permission boundary.
    const hidden = new Set(
      [...BLOOM_NODE_TYPES, ...BLOOM_RELATIONSHIP_TYPES].map((r) => r.key)
    )
    const result = applyBloomTypeFilters(canvas, hidden)
    expect(result.nodes).toHaveLength(1)
    expect(result.relationships).toHaveLength(1)
  })
})
