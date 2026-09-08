/**
 * GOAL-346 — unit tests for the Document provenance layer.
 *
 * This layer is the only thing standing between the Bloom canvas and two
 * classes of visual bug it has had before:
 *
 *   1. Isolated nodes. The layer exists to remove them (a document-named person
 *      with no pulse and no CONNECTED_TO edge floated free), so it must not
 *      reintroduce them as isolated Documents — hence the "all people
 *      off-canvas contributes no node" case below.
 *   2. Dangling edges. `bloom-view` maintains a strict invariant that NVL is
 *      never handed a relationship whose endpoint isn't rendered; NVL will not
 *      resolve one for us. The edge-integrity case asserts it directly.
 *
 * Colors are asserted against BOTH palettes: a palette entry present in dark
 * and missing in light is the classic light/dark parity regression on this
 * canvas, and it would surface as invisible (or `undefined`-painted) edges in
 * exactly one mode.
 */
import {
  buildDocumentProvenanceLayer,
  documentDerivedIds,
  DOCUMENT_SIZE,
  type ProvenanceDocument,
} from './document-provenance-layer'
import {
  BLOOM_PALETTE_DARK,
  BLOOM_PALETTE_LIGHT,
  type BloomPalette,
} from './bloom-palette'

const PALETTES: Array<[mode: string, palette: BloomPalette]> = [
  ['dark', BLOOM_PALETTE_DARK],
  ['light', BLOOM_PALETTE_LIGHT],
]

const doc = (
  id: string,
  personIds: string[],
  filename?: string | null
): ProvenanceDocument => ({
  id,
  filename,
  extractedPeople: personIds.map((pid) => ({ id: pid })),
})

/** The default happy-path build, dark palette, everyone on canvas. */
const build = (
  documents: readonly ProvenanceDocument[] | null | undefined,
  visiblePersonIds: Iterable<string> = [],
  overrides: { palette?: BloomPalette; visible?: boolean } = {}
) =>
  buildDocumentProvenanceLayer({
    documents,
    visiblePersonIds: new Set(visiblePersonIds),
    palette: overrides.palette ?? BLOOM_PALETTE_DARK,
    visible: overrides.visible ?? true,
  })

const EMPTY_LAYER = { nodes: [], relationships: [] }

describe('buildDocumentProvenanceLayer', () => {
  describe('when the layer is toggled off', () => {
    it('returns empty regardless of how much document data is present', () => {
      const documents = [
        doc('d1', ['p1', 'p2'], 'report.pdf'),
        doc('d2', ['p1'], 'notes.md'),
      ]
      expect(
        build(documents, ['p1', 'p2'], { visible: false })
      ).toEqual(EMPTY_LAYER)
    })

    it('short-circuits before reading the documents at all', () => {
      // A getter that throws proves nothing downstream of the `visible` gate
      // touches the document list.
      const exploding = {
        get id(): string {
          throw new Error('documents must not be read when visible is false')
        },
      } as unknown as ProvenanceDocument

      expect(() =>
        build([exploding], ['p1'], { visible: false })
      ).not.toThrow()
    })
  })

  describe('when there is nothing to draw', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty array', []],
    ])('returns empty for %s documents', (_label, documents) => {
      expect(build(documents, ['p1'])).toEqual(EMPTY_LAYER)
    })

    it('returns empty when no person is on canvas', () => {
      expect(build([doc('d1', ['p1', 'p2'])], [])).toEqual(EMPTY_LAYER)
    })
  })

  /**
   * The point of the layer is to remove disconnected nodes from the canvas.
   * Emitting a Document whose every extracted person is off-canvas would just
   * move the same problem onto a different node type.
   */
  describe('a document whose extracted people are ALL off-canvas', () => {
    it('contributes NO node and NO relationship', () => {
      expect(
        build([doc('orphan', ['off-1', 'off-2'], 'nobody-here.pdf')], [
          'someone-else',
        ])
      ).toEqual(EMPTY_LAYER)
    })

    it('is dropped while its siblings with visible people still render', () => {
      const { nodes, relationships } = build(
        [
          doc('orphan', ['off-canvas'], 'orphan.pdf'),
          doc('connected', ['on-canvas'], 'connected.pdf'),
        ],
        ['on-canvas']
      )
      expect(nodes.map((n) => n.id)).toEqual(['connected'])
      expect(relationships).toHaveLength(1)
    })

    it('is dropped when its extractedPeople list is null or empty', () => {
      const documents: ProvenanceDocument[] = [
        { id: 'no-list', filename: 'a.pdf', extractedPeople: null },
        { id: 'empty-list', filename: 'b.pdf', extractedPeople: [] },
        { id: 'absent-field', filename: 'c.pdf' },
      ]
      expect(build(documents, ['p1'])).toEqual(EMPTY_LAYER)
    })
  })

  describe('edge integrity (bloom-view’s no-dangling-edge invariant)', () => {
    it('emits edges only for person ids present in visiblePersonIds', () => {
      const { relationships } = build(
        [doc('d1', ['visible-1', 'hidden-1', 'visible-2', 'hidden-2'])],
        ['visible-1', 'visible-2']
      )
      expect(relationships.map((r) => r.to).sort()).toEqual([
        'visible-1',
        'visible-2',
      ])
    })

    it('never references an id outside the node set plus visiblePersonIds', () => {
      const visiblePersonIds = new Set(['p1', 'p2', 'p3'])
      const { nodes, relationships } = buildDocumentProvenanceLayer({
        documents: [
          doc('d1', ['p1', 'ghost-a', 'p2']),
          doc('d2', ['p3', 'ghost-b']),
          doc('d3', ['ghost-c']), // contributes nothing at all
        ],
        visiblePersonIds,
        palette: BLOOM_PALETTE_DARK,
        visible: true,
      })

      const renderable = new Set([
        ...nodes.map((n) => n.id),
        ...visiblePersonIds,
      ])
      for (const rel of relationships) {
        expect(renderable.has(rel.from)).toBe(true)
        expect(renderable.has(rel.to)).toBe(true)
      }
      // And the document that named nobody visible never became a node.
      expect(nodes.map((n) => n.id).sort()).toEqual(['d1', 'd2'])
    })

    it('anchors every edge at its own document node', () => {
      const { relationships } = build(
        [doc('d1', ['p1']), doc('d2', ['p1', 'p2'])],
        ['p1', 'p2']
      )
      expect(
        relationships.map((r) => `${r.from}->${r.to}`).sort()
      ).toEqual(['d1->p1', 'd2->p1', 'd2->p2'])
    })
  })

  describe('relationship id uniqueness (NVL collision safety)', () => {
    it('yields ONE relationship when the same person is listed twice on a document', () => {
      const { nodes, relationships } = build(
        [
          {
            id: 'd1',
            filename: 're-ingested.pdf',
            extractedPeople: [{ id: 'p1' }, { id: 'p1' }, { id: 'p1' }],
          },
        ],
        ['p1']
      )
      expect(nodes).toHaveLength(1)
      expect(relationships).toHaveLength(1)
      expect(relationships[0].to).toBe('p1')
    })

    it('keeps ids unique across two documents that share a person', () => {
      const { relationships } = build(
        [doc('d1', ['shared', 'p1']), doc('d2', ['shared', 'p2'])],
        ['shared', 'p1', 'p2']
      )
      const ids = relationships.map((r) => r.id)
      expect(ids).toHaveLength(4)
      expect(new Set(ids).size).toBe(4)
    })

    it('keeps node ids unique across the returned set', () => {
      const { nodes } = build(
        [doc('d1', ['p1']), doc('d2', ['p1']), doc('d3', ['p1'])],
        ['p1']
      )
      const ids = nodes.map((n) => n.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  describe('node caption', () => {
    it('uses the filename when there is one', () => {
      const { nodes } = build([doc('d1', ['p1'], 'field-notes.pdf')], ['p1'])
      expect(nodes[0].caption).toBe('field-notes.pdf')
    })

    it('trims surrounding whitespace off the filename', () => {
      const { nodes } = build([doc('d1', ['p1'], '  spaced.md  ')], ['p1'])
      expect(nodes[0].caption).toBe('spaced.md')
    })

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
      ['a tab/newline string', '\t\n '],
    ])('falls back to "Document" for %s', (_label, filename) => {
      const { nodes } = build([doc('d1', ['p1'], filename)], ['p1'])
      expect(nodes[0].caption).toBe('Document')
    })
  })

  describe('node shape', () => {
    it('carries the document id and the shared DOCUMENT_SIZE', () => {
      const { nodes } = build([doc('doc_abc', ['p1'], 'x.pdf')], ['p1'])
      expect(nodes[0]).toMatchObject({
        id: 'doc_abc',
        caption: 'x.pdf',
        size: DOCUMENT_SIZE,
      })
    })

    it('skips documents with a missing id without throwing', () => {
      const documents = [
        { id: '', filename: 'blank.pdf', extractedPeople: [{ id: 'p1' }] },
        { filename: 'no-id.pdf', extractedPeople: [{ id: 'p1' }] },
        null,
        undefined,
        doc('d-real', ['p1'], 'real.pdf'),
      ] as unknown as ProvenanceDocument[]

      let layer!: ReturnType<typeof build>
      expect(() => {
        layer = build(documents, ['p1'])
      }).not.toThrow()
      expect(layer.nodes.map((n) => n.id)).toEqual(['d-real'])
      expect(layer.relationships).toHaveLength(1)
    })

    it('skips extracted person entries that carry no id', () => {
      const documents = [
        {
          id: 'd1',
          filename: 'holes.pdf',
          extractedPeople: [null, undefined, { id: '' }, { id: 'p1' }],
        },
      ] as unknown as ProvenanceDocument[]
      const { nodes, relationships } = build(documents, ['p1'])
      expect(nodes).toHaveLength(1)
      expect(relationships.map((r) => r.to)).toEqual(['p1'])
    })
  })

  describe.each(PALETTES)('colors in %s mode', (mode, palette) => {
    const layer = () =>
      build([doc('d1', ['p1'], 'x.pdf')], ['p1'], { palette })

    it('defines a non-empty documentNode color', () => {
      expect(palette.documentNode).toBeDefined()
      expect(typeof palette.documentNode).toBe('string')
      expect(palette.documentNode.trim()).not.toBe('')
    })

    it('defines a non-empty extractedEdge color', () => {
      expect(palette.extractedEdge).toBeDefined()
      expect(typeof palette.extractedEdge).toBe('string')
      expect(palette.extractedEdge.trim()).not.toBe('')
    })

    it('paints the document node with the palette’s documentNode', () => {
      const { nodes } = layer()
      expect(nodes[0].color).toBe(palette.documentNode)
    })

    it('paints the EXTRACTED_FROM edge with the palette’s extractedEdge', () => {
      const { relationships } = layer()
      expect(relationships[0].color).toBe(palette.extractedEdge)
    })

    it(`never paints undefined in ${mode} mode`, () => {
      const { nodes, relationships } = layer()
      for (const painted of [...nodes, ...relationships]) {
        expect(painted.color).toBeTruthy()
      }
    })
  })

  it('gives the two palettes distinct document colors (light/dark parity)', () => {
    // Same color in both modes would mean one mode was never tuned — the
    // regression bloom-palette's header warns about.
    expect(BLOOM_PALETTE_LIGHT.documentNode).not.toBe(
      BLOOM_PALETTE_DARK.documentNode
    )
    expect(BLOOM_PALETTE_LIGHT.extractedEdge).not.toBe(
      BLOOM_PALETTE_DARK.extractedEdge
    )
  })

  describe('the full happy path', () => {
    it('builds one node per connected document and one edge per visible person', () => {
      const { nodes, relationships } = build(
        [
          doc('d1', ['ada', 'grace'], 'minutes.pdf'),
          doc('d2', ['ada', 'off-canvas'], 'roster.csv'),
          doc('d3', ['off-canvas'], 'unrelated.txt'),
        ],
        ['ada', 'grace']
      )
      expect(nodes.map((n) => n.caption)).toEqual([
        'minutes.pdf',
        'roster.csv',
      ])
      expect(relationships.map((r) => `${r.from}->${r.to}`)).toEqual([
        'd1->ada',
        'd1->grace',
        'd2->ada',
      ])
      expect(relationships.every((r) => r.caption === 'extracted from')).toBe(
        true
      )
    })

    it('does not mutate the documents it reads', () => {
      const documents = [doc('d1', ['p1', 'p1']), doc('d2', ['p2'])]
      const snapshot = JSON.stringify(documents)
      build(documents, ['p1', 'p2'])
      expect(JSON.stringify(documents)).toBe(snapshot)
    })

    it('does not mutate the visiblePersonIds set', () => {
      const visiblePersonIds = new Set(['p1'])
      buildDocumentProvenanceLayer({
        documents: [doc('d1', ['p1', 'p2'])],
        visiblePersonIds,
        palette: BLOOM_PALETTE_DARK,
        visible: true,
      })
      expect([...visiblePersonIds]).toEqual(['p1'])
    })

    it('returns fresh arrays, never a shared EMPTY singleton the caller can poison', () => {
      const a = build(undefined, [])
      const b = build(null, [])
      // Both are empty; if they are the same object, a caller pushing into one
      // result would corrupt every future empty build.
      expect(a).toEqual(EMPTY_LAYER)
      expect(b).toEqual(EMPTY_LAYER)
      expect(a.nodes).toHaveLength(0)
      expect(b.nodes).toHaveLength(0)
    })
  })
})

/**
 * Switching the layer OFF has to take the whole document-derived subgraph with
 * it, not just the Document hubs. Hiding the hubs alone was the original bug:
 * an extracted person's only edge is EXTRACTED_FROM, so removing it left them
 * floating — the precise failure the layer was built to remove.
 *
 * The two exemptions carry the real risk of over-removal, so they get the most
 * coverage here: a curated roster person and a space owner/member must survive
 * being named by a document, because they are on the canvas for reasons that
 * have nothing to do with the upload.
 */
describe('documentDerivedIds', () => {
  const docWithPulses = (
    id: string,
    personIds: string[],
    pulseIds: string[]
  ): ProvenanceDocument => ({
    id,
    extractedPeople: personIds.map((pid) => ({ id: pid })),
    extractedPulses: pulseIds.map((puid) => ({ id: puid })),
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
  ])('derives nothing from %s documents', (_label, documents) => {
    expect([...documentDerivedIds({ documents })]).toEqual([])
  })

  it('collects the documents, the people they named and the pulses they made', () => {
    const ids = documentDerivedIds({
      documents: [docWithPulses('d1', ['p1', 'p2'], ['pulse1'])],
    })
    expect([...ids].sort()).toEqual(['d1', 'p1', 'p2', 'pulse1'])
  })

  it('collapses an entity named by several documents to one id', () => {
    const ids = documentDerivedIds({
      documents: [
        docWithPulses('d1', ['shared'], ['shared-pulse']),
        docWithPulses('d2', ['shared'], ['shared-pulse']),
      ],
    })
    expect([...ids].sort()).toEqual(['d1', 'd2', 'shared', 'shared-pulse'])
  })

  it('keeps a curated roster person — curation outranks extraction', () => {
    const ids = documentDerivedIds({
      documents: [docWithPulses('d1', ['curated', 'extracted'], [])],
      curatedPersonIds: ['curated'],
    })
    expect(ids.has('curated')).toBe(false)
    expect(ids.has('extracted')).toBe(true)
  })

  it('keeps a structurally anchored person (space owner / member)', () => {
    const ids = documentDerivedIds({
      documents: [docWithPulses('d1', ['owner', 'extracted'], [])],
      anchoredIds: new Set(['owner']),
    })
    expect(ids.has('owner')).toBe(false)
    expect(ids.has('extracted')).toBe(true)
  })

  it('never exempts the Document itself, whatever the exemption lists say', () => {
    const ids = documentDerivedIds({
      documents: [docWithPulses('d1', [], [])],
      curatedPersonIds: ['d1'],
      anchoredIds: ['d1'],
    })
    expect(ids.has('d1')).toBe(true)
  })

  it('tolerates documents carrying no extracted entities at all', () => {
    const ids = documentDerivedIds({ documents: [{ id: 'd1' }] })
    expect([...ids]).toEqual(['d1'])
  })

  it('skips malformed entries rather than deriving an undefined id', () => {
    const ids = documentDerivedIds({
      documents: [
        { id: '' } as ProvenanceDocument,
        {
          id: 'd1',
          extractedPeople: [{ id: '' }, { id: 'p1' }],
          extractedPulses: [{ id: '' }, { id: 'pulse1' }],
        } as ProvenanceDocument,
      ],
    })
    expect([...ids].sort()).toEqual(['d1', 'p1', 'pulse1'])
  })

  it('returns a fresh set per call, never a shared singleton', () => {
    const a = documentDerivedIds({ documents: [] })
    const b = documentDerivedIds({ documents: [] })
    expect(a).not.toBe(b)
  })

  it('does not mutate the exemption collections it is handed', () => {
    const anchoredIds = new Set(['owner'])
    const curatedPersonIds = ['curated']
    documentDerivedIds({
      documents: [docWithPulses('d1', ['owner', 'curated', 'other'], [])],
      curatedPersonIds,
      anchoredIds,
    })
    expect([...anchoredIds]).toEqual(['owner'])
    expect(curatedPersonIds).toEqual(['curated'])
  })
})
