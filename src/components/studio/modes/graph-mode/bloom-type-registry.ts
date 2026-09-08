import type { Node, Relationship } from '@neo4j-nvl/base'
import {
  BLOOM_PALETTE_DARK as DARK,
  BLOOM_PALETTE_LIGHT as LIGHT,
} from './bloom-palette'
import {
  NODE_STYLE,
  UNKNOWN_NODE_STYLE,
  lightColorFor,
} from '@/lib/cypher-generator/node-style'

/**
 * The Bloom canvas type registry — one row per node type and per relationship
 * type the canvas can paint, and the pure transform that filters the canvas
 * down to the rows a viewer has switched on (GOAL-350).
 *
 * ## Why colour is the type key
 *
 * Bloom paints native NVL nodes as bare coloured circles — `caption`, `color`
 * and `size`, nothing else (kb/01-glossary.md, "Bloom Exploration"). There is
 * no `type` field on a painted node to filter by, so the colour IS the type
 * encoding. `BloomLegend` has always decoded it that way; GOAL-350 promotes
 * that same decoding into the filter key, which is what makes the toggle list
 * derive itself from what is on canvas instead of a hard-coded type list. Add
 * a new node or edge colour with a row here and it becomes a toggle for free —
 * and `bloom-legend.test.ts` already fails on any paintable colour that no row
 * can decode, so the registry cannot silently fall behind the paint.
 *
 * Kept free of React (and of any import that reaches back into the view) so
 * the canvas, the legend and the tests can all consume one derivation. This is
 * also why `bloom-palette.ts` exists as its own module — see its header on the
 * TDZ cycle that a legend↔view import would reintroduce.
 *
 * ## The two paint sources
 *
 * Native scopes (root / in-space / in-field) paint from `bloom-palette.ts`;
 * the AI-Companion overlay paints from the cypher generator's `node-style.ts`
 * and is repainted into its light counterparts by the view. A row therefore
 * lists every colour that should surface it in `colors`, while `swatch` holds
 * the one solid, AA-visible stand-in the legend draws per mode.
 */

export type BloomTypeKind = 'node' | 'relationship'

export interface BloomTypeRow {
  /**
   * Stable filter key. Persisted only in memory, but kept human-readable
   * because it is what `aria-*` state and the tests key off.
   */
  key: string
  label: string
  kind: BloomTypeKind
  /** Solid, AA-visible swatch shown in the row, one per mode. */
  swatch: { dark: string; light: string }
  /** Rendered node/edge colours that should surface this row when present. */
  colors: string[]
}

/**
 * An overlay colour and its light-mode repaint — the canvas may hand the
 * registry either, depending on the mode it painted in.
 */
const ov = (color: string): string[] => [color, lightColorFor(color)]

// Overlay palette — imported from the same module the executor styles its
// nodes with, so every colour the overlay can push is decodable here. Each
// entry expands to the dark colour the executor emits plus the light colour
// the canvas repaints it as.
const OVERLAY_SPACE = ov(NODE_STYLE.MeSpace.color) // Me/We/Space share one colour
const OVERLAY_FIELD = ov(NODE_STYLE.FieldContext.color)
const OVERLAY_PULSE = [
  NODE_STYLE.GoalPulse.color,
  NODE_STYLE.ResourcePulse.color,
  NODE_STYLE.StoryPulse.color,
  NODE_STYLE.CarePulse.color,
  NODE_STYLE.CoreValuePulse.color,
  NODE_STYLE.FieldPulse.color,
].flatMap(ov)
const OVERLAY_RESONANCE = [
  NODE_STYLE.ResonanceLink.color,
  NODE_STYLE.FieldResonance.color,
].flatMap(ov)

/**
 * Node rows. Native scopes carry fine-grained subtype colours from
 * `bloom-palette`; the generic `Pulse` and `Resonance` rows only ever match
 * the coarser overlay palette, so they never double up with the subtype rows
 * above (the two palettes are disjoint apart from Person, whose native and
 * overlay pinks are deliberately identical).
 *
 * Exported for the drift test — every NODE_STYLE colour must be decodable by
 * some row here (`bloom-legend.test.ts`).
 */
export const BLOOM_NODE_TYPES: BloomTypeRow[] = [
  {
    key: 'me-space',
    label: 'Your MeSpace',
    kind: 'node',
    swatch: { dark: DARK.space.MeSpace, light: LIGHT.space.MeSpace },
    colors: [DARK.space.MeSpace, LIGHT.space.MeSpace],
  },
  {
    key: 'we-space',
    label: 'WeSpace',
    kind: 'node',
    swatch: { dark: DARK.space.WeSpace, light: LIGHT.space.WeSpace },
    colors: [DARK.space.WeSpace, LIGHT.space.WeSpace, ...OVERLAY_SPACE],
  },
  {
    key: 'field-context',
    label: 'Field context',
    kind: 'node',
    swatch: { dark: DARK.field.MeSpace, light: LIGHT.field.MeSpace },
    colors: [
      DARK.field.MeSpace,
      DARK.field.WeSpace,
      LIGHT.field.MeSpace,
      LIGHT.field.WeSpace,
      ...OVERLAY_FIELD,
    ],
  },
  {
    key: 'goal',
    label: 'Goal',
    kind: 'node',
    swatch: { dark: DARK.pulse.goal, light: LIGHT.pulse.goal },
    colors: [DARK.pulse.goal, LIGHT.pulse.goal],
  },
  {
    key: 'resource',
    label: 'Resource',
    kind: 'node',
    swatch: { dark: DARK.pulse.resource, light: LIGHT.pulse.resource },
    colors: [DARK.pulse.resource, LIGHT.pulse.resource],
  },
  {
    key: 'story',
    label: 'Story',
    kind: 'node',
    swatch: { dark: DARK.pulse.story, light: LIGHT.pulse.story },
    colors: [DARK.pulse.story, LIGHT.pulse.story],
  },
  {
    key: 'care',
    label: 'Care',
    kind: 'node',
    swatch: { dark: DARK.pulse.care, light: LIGHT.pulse.care },
    colors: [DARK.pulse.care, LIGHT.pulse.care],
  },
  {
    key: 'core-value',
    label: 'Core value',
    kind: 'node',
    swatch: { dark: DARK.pulse.coreValue, light: LIGHT.pulse.coreValue },
    colors: [DARK.pulse.coreValue, LIGHT.pulse.coreValue],
  },
  {
    key: 'pulse',
    label: 'Pulse',
    kind: 'node',
    swatch: { dark: OVERLAY_PULSE[0], light: lightColorFor(OVERLAY_PULSE[0]) },
    colors: OVERLAY_PULSE,
  },
  {
    key: 'resonance-node',
    label: 'Resonance',
    kind: 'node',
    swatch: {
      dark: OVERLAY_RESONANCE[0],
      light: lightColorFor(OVERLAY_RESONANCE[0]),
    },
    colors: OVERLAY_RESONANCE,
  },
  {
    key: 'promise-weave',
    label: 'Promise weave',
    kind: 'node',
    swatch: { dark: DARK.weaveNode, light: LIGHT.weaveNode },
    colors: [
      DARK.weaveNode,
      LIGHT.weaveNode,
      ...ov(NODE_STYLE.PromiseWeave.color),
    ],
  },
  {
    key: 'organization',
    label: 'Organization',
    kind: 'node',
    swatch: {
      dark: NODE_STYLE.Organization.color,
      light: lightColorFor(NODE_STYLE.Organization.color),
    },
    colors: ov(NODE_STYLE.Organization.color),
  },
  {
    key: 'community',
    label: 'Community',
    kind: 'node',
    swatch: {
      dark: NODE_STYLE.Community.color,
      light: lightColorFor(NODE_STYLE.Community.color),
    },
    colors: ov(NODE_STYLE.Community.color),
  },
  {
    key: 'document',
    label: 'Document',
    kind: 'node',
    swatch: {
      dark: NODE_STYLE.Document.color,
      light: lightColorFor(NODE_STYLE.Document.color),
    },
    colors: ov(NODE_STYLE.Document.color),
  },
  {
    key: 'person',
    label: 'Person',
    kind: 'node',
    swatch: { dark: DARK.person, light: LIGHT.person },
    colors: [DARK.person, LIGHT.person, ...ov(NODE_STYLE.Person.color)],
  },
  // Catch-all: SpaceMembership shares the executor's unknown-label fallback
  // slate, so one honest row decodes both.
  {
    key: 'other',
    label: 'Other',
    kind: 'node',
    swatch: {
      dark: UNKNOWN_NODE_STYLE.color,
      light: lightColorFor(UNKNOWN_NODE_STYLE.color),
    },
    colors: ov(UNKNOWN_NODE_STYLE.color),
  },
]

/**
 * Edge rows. The rendered edge colours are translucent rgba — faint by design
 * on the canvas — so the swatch uses a solid, AA-visible stand-in of the same
 * hue that reads on a light- or dark-mode glass panel. `Initiated by` (field
 * view) and `Structure` (space/root view) never co-occur, so a shared slate
 * swatch is unambiguous.
 */
export const BLOOM_RELATIONSHIP_TYPES: BloomTypeRow[] = [
  {
    key: 'resonates-with',
    label: 'Resonance',
    kind: 'relationship',
    swatch: { dark: '#a78bfa', light: '#7245f7' },
    colors: [DARK.resonanceEdge, LIGHT.resonanceEdge],
  },
  {
    key: 'weaves',
    label: 'Weaves',
    kind: 'relationship',
    swatch: { dark: DARK.weaveNode, light: LIGHT.weaveNode },
    colors: [DARK.weaveEdge, LIGHT.weaveEdge],
  },
  {
    key: 'connected-to',
    label: 'Connected',
    kind: 'relationship',
    swatch: { dark: '#f472b6', light: '#ce1073' },
    colors: [DARK.connectedEdge, LIGHT.connectedEdge],
  },
  {
    key: 'initiated-by',
    label: 'Initiated by',
    kind: 'relationship',
    swatch: { dark: '#94a3b8', light: '#5a6d88' },
    colors: [DARK.initiatedEdge, LIGHT.initiatedEdge],
  },
  {
    key: 'structural',
    label: 'Structure',
    kind: 'relationship',
    swatch: { dark: '#94a3b8', light: '#5a6d88' },
    colors: [DARK.structuralEdge, LIGHT.structuralEdge],
  },
  {
    // GOAL-346. The whole point of the Document layer is to explain why a
    // person is on the canvas, so its edge is the one that most needs
    // decoding. Hiding the Document row cascades onto these edges (a document
    // is always one endpoint), which is why switching Documents off still
    // leaves a clean canvas rather than a fan of dangling amber arrows.
    key: 'extracted-from',
    label: 'Named in',
    kind: 'relationship',
    swatch: { dark: '#fbbf24', light: '#9e7303' },
    colors: [DARK.extractedEdge, LIGHT.extractedEdge],
  },
]

/** The Documents row. Its hiding rule is id-based and lives in `bloom-view`. */
export const DOCUMENT_TYPE_KEY = 'document'

/**
 * Rows that are OFF the first time a viewer opens the canvas.
 *
 * Empty, deliberately. Documents shipped default-off to stop a document-heavy
 * field burying its pulses, and GOAL-346 then reversed that: a person a
 * document named has provenance as their ONLY tie to anything, so the canvas
 * opened on a field of edgeless dots — 12 of the 14 people on one real field.
 * The reversal is the current behaviour on `dev` and this list is what would
 * quietly undo it.
 *
 * The default MECHANISM stays because the question is a live one — the volume
 * argument was real, and `applyDocumentHiding` now sweeps the dots the old
 * default produced, so default-off could be re-argued on its merits. Re-adding
 * `DOCUMENT_TYPE_KEY` here is the whole change if it wins.
 *
 * The general rule stands either way: a filter that hides something on first
 * paint, without the viewer ever asking, reads as missing data rather than as
 * a filter.
 */
export const DEFAULT_HIDDEN_TYPE_KEYS: readonly string[] = []

/** Strip whitespace + lowercase so rgba/hex compare regardless of formatting. */
export const normalizeColor = (c: string | undefined): string =>
  (c ?? '').toLowerCase().replace(/\s+/g, '')

/**
 * Colour → row key, built once at module load.
 *
 * FIRST row wins on a collision, which makes resolution deterministic and
 * matches the order rows are listed to the viewer. There is one known
 * collision, inherited from the palettes and documented in
 * `bloom-palette.ts`: the WeSpace field tint is also the overlay's
 * Organization colour, so an Organization node in a chat overlay is governed
 * by the `Field context` toggle, and the `Organization` row is never offered
 * as a control (`presentRowsVia` resolves through this same index precisely so
 * a shadowed row cannot surface as a switch that does nothing). Colour is the
 * only type signal a painted NVL node carries, so this is a limit of the
 * encoding rather than of the filter — giving Organization its own colour in
 * `node-style.ts` is what would restore it as an independent toggle.
 */
function buildColorIndex(rows: BloomTypeRow[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const row of rows) {
    for (const color of row.colors) {
      const key = normalizeColor(color)
      if (!index.has(key)) index.set(key, row.key)
    }
  }
  return index
}

const NODE_COLOR_INDEX = buildColorIndex(BLOOM_NODE_TYPES)
const RELATIONSHIP_COLOR_INDEX = buildColorIndex(BLOOM_RELATIONSHIP_TYPES)

/** The row key a painted node belongs to, or null when nothing decodes it. */
export function nodeTypeKey(node: Node): string | null {
  return NODE_COLOR_INDEX.get(normalizeColor(node.color)) ?? null
}

/** The row key a painted edge belongs to, or null when nothing decodes it. */
export function relationshipTypeKey(rel: Relationship): string | null {
  return (
    RELATIONSHIP_COLOR_INDEX.get(
      normalizeColor((rel as { color?: string }).color)
    ) ?? null
  )
}

/**
 * The rows a given canvas actually needs — the scope-awareness the legend has
 * always had, and now the reason the toggle list differs per scope without
 * anything hard-coding which types each scope renders.
 *
 * Presence is judged against the UNFILTERED canvas, so a type the viewer has
 * switched off keeps its row (and its way back on) instead of vanishing the
 * moment it is hidden.
 *
 * Resolution goes through the SAME winner-takes-all index the filter uses, not
 * through raw `row.colors`. The two differ wherever a colour is claimed by more
 * than one row, and that gap strands the loser: `Organization` shares the
 * WeSpace field tint, so matching on raw colours would offer an `Organization`
 * switch that `nodeTypeKey` can never return — flipping it would change nothing
 * while the legend's hidden-count insisted a type was hidden. That is exactly
 * the dead-control problem the old Documents toggle was careful to avoid.
 * Routing presence and filtering through one index means a row is offered only
 * when it can actually act, and immunises the next collision for free.
 */
function presentRowsVia(
  rows: BloomTypeRow[],
  index: ReadonlyMap<string, string>,
  colors: ReadonlySet<string>
): BloomTypeRow[] {
  const reachable = new Set<string>()
  for (const color of colors) {
    const key = index.get(color)
    if (key) reachable.add(key)
  }
  return rows.filter((row) => reachable.has(row.key))
}

/** Node rows this canvas can actually control. `colors` must be normalized. */
export function presentNodeRows(colors: ReadonlySet<string>): BloomTypeRow[] {
  return presentRowsVia(BLOOM_NODE_TYPES, NODE_COLOR_INDEX, colors)
}

/** Relationship rows this canvas can actually control. */
export function presentRelationshipRows(
  colors: ReadonlySet<string>
): BloomTypeRow[] {
  return presentRowsVia(
    BLOOM_RELATIONSHIP_TYPES,
    RELATIONSHIP_COLOR_INDEX,
    colors
  )
}

export interface BloomCanvas {
  nodes: Node[]
  relationships: Relationship[]
}

/**
 * The whole filter: a pure presentational transform over the canvas the view
 * already built (no refetch, ADR-011).
 *
 * Two invariants it exists to hold:
 *
 *  1. **Hiding a node type cascades to its edges.** Every surviving edge is
 *     re-checked against the surviving node ids, so NVL is never handed an
 *     arrow to a node that isn't drawn. `bloom-view` guards each edge against
 *     its own `visibleIds` when it builds them; this re-applies that same
 *     guard against the post-filter set rather than bypassing it.
 *  2. **Hiding a relationship type hides only edges.** Endpoint nodes stay on
 *     canvas unless their own type is also switched off.
 *
 * A node or edge whose colour no row decodes is always kept. Hiding something
 * the registry cannot name would be the canvas silently dropping data, and on
 * this surface "not drawn" must never be mistaken for "not there" or "not
 * permitted" (kb/02-user-roles.md — this is a view filter, never an
 * authorization decision).
 */
export function applyBloomTypeFilters(
  canvas: BloomCanvas,
  hidden: ReadonlySet<string>
): BloomCanvas {
  if (hidden.size === 0) return canvas

  const nodes = canvas.nodes.filter((n) => {
    const key = nodeTypeKey(n)
    return key === null || !hidden.has(key)
  })

  // Short-circuit the id set only when nothing was actually dropped — the
  // common case is an edge-type toggle, where every endpoint survives.
  const dropped = nodes.length !== canvas.nodes.length
  const visibleIds = dropped ? new Set(nodes.map((n) => String(n.id))) : null

  const relationships = canvas.relationships.filter((r) => {
    const key = relationshipTypeKey(r)
    if (key !== null && hidden.has(key)) return false
    if (!visibleIds) return true
    return visibleIds.has(String(r.from)) && visibleIds.has(String(r.to))
  })

  return { nodes, relationships }
}
