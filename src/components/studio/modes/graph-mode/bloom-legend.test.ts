/**
 * Drift guard for GOAL-288 — every node color either paint source can put on
 * the Bloom canvas must be decodable by a row in the legend.
 *
 * The canvas has two paint sources:
 *   - the native views (bloom-view.tsx) paint with `bloom-palette.ts`, and
 *   - the AI-Companion overlay (query_for_bloom → execute.ts) paints with
 *     `node-style.ts` (NODE_STYLE / UNKNOWN_NODE_STYLE).
 * The legend (BLOOM_NODE_TYPES in bloom-type-registry.ts) decodes rendered
 * colors back into labeled rows. GOAL-288 happened because the legend
 * hand-mirrored the overlay hexes and PromiseWeave's fuchsia was missing —
 * assistant-rendered weaves showed no legend row. This test fails the moment a
 * palette entry is added (or recolored) without a legend row that lists its
 * color.
 *
 * Since GOAL-350 those rows are also the canvas's type toggles, so an
 * undecodable color now costs more than a missing legend entry: a node of that
 * type would have no control at all (and `applyBloomTypeFilters` would always
 * keep it, by design — it never hides what it cannot name).
 */
import { BLOOM_NODE_TYPES as LEGEND_NODES } from './bloom-type-registry'
import {
  NODE_STYLE,
  UNKNOWN_NODE_STYLE,
  lightColorFor,
} from '@/lib/cypher-generator/node-style'
import {
  BLOOM_PALETTE_DARK,
  BLOOM_PALETTE_LIGHT,
  type BloomPalette,
} from './bloom-palette'

/** Mirrors the component's own `norm` — legend matching is done on this. */
const norm = (c: string): string => c.toLowerCase().replace(/\s+/g, '')

/** Every color any LEGEND_NODES row can decode, normalized. */
const decodableColors = new Set(
  LEGEND_NODES.flatMap((row) => row.colors.map(norm))
)

/** Asserts with a message that names the undecodable label + color. */
function expectDecodable(source: string, color: string): void {
  if (!decodableColors.has(norm(color))) {
    throw new Error(
      `${source} paints "${color}" but no LEGEND_NODES row in bloom-legend.tsx ` +
        `lists that color — nodes of this type would render with no legend row ` +
        `(the GOAL-288 drift). Add "${color}" to an existing row's \`colors\` ` +
        `or add a new row for it.`
    )
  }
}

/** Every node color one palette can paint, labelled by where it comes from. */
function nodeCasesFor(
  mode: string,
  palette: BloomPalette
): Array<[source: string, color: string]> {
  return [
    ...Object.entries(palette.space).map(
      ([k, v]): [string, string] => [`${mode}.space.${k}`, v]
    ),
    ...Object.entries(palette.field).map(
      ([k, v]): [string, string] => [`${mode}.field.${k}`, v]
    ),
    ...Object.entries(palette.pulse).map(
      ([k, v]): [string, string] => [`${mode}.pulse.${k}`, v]
    ),
    [`${mode}.person`, palette.person],
    [`${mode}.weaveNode`, palette.weaveNode],
  ]
}

describe('Bloom legend decodes every paintable node color (GOAL-288 drift guard)', () => {
  describe('overlay palette (cypher-generator node-style)', () => {
    it.each(Object.entries(NODE_STYLE))(
      'NODE_STYLE.%s color has a legend row',
      (label, style) => {
        expectDecodable(`NODE_STYLE.${label}`, style.color)
      }
    )

    it('UNKNOWN_NODE_STYLE fallback color has a legend row', () => {
      expectDecodable('UNKNOWN_NODE_STYLE', UNKNOWN_NODE_STYLE.color)
    })

    // The canvas repaints overlay nodes with their light-mode counterparts
    // (bloom-view.tsx), so the legend has to decode those too — otherwise the
    // whole legend empties out the moment a chat custom view is viewed in
    // light mode.
    it.each(Object.entries(NODE_STYLE))(
      'NODE_STYLE.%s light-mode repaint has a legend row',
      (label, style) => {
        expectDecodable(
          `lightColorFor(NODE_STYLE.${label})`,
          lightColorFor(style.color)
        )
      }
    )

    it('UNKNOWN_NODE_STYLE light-mode repaint has a legend row', () => {
      expectDecodable(
        'lightColorFor(UNKNOWN_NODE_STYLE)',
        lightColorFor(UNKNOWN_NODE_STYLE.color)
      )
    })
  })

  describe('native Bloom palette (bloom-palette)', () => {
    it.each([
      ...nodeCasesFor('BLOOM_PALETTE_DARK', BLOOM_PALETTE_DARK),
      ...nodeCasesFor('BLOOM_PALETTE_LIGHT', BLOOM_PALETTE_LIGHT),
    ])('%s has a legend row', (source, color) => {
      expectDecodable(source, color)
    })
  })
})
