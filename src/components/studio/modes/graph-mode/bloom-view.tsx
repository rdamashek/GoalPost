'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import {
  dispatchOpenInfoDrawer,
  dispatchCloseInfoDrawer,
  type InfoEntityType,
} from '@/components/dashboard/entity-info-drawer'
import { useQuery } from '@apollo/client/react'
import type {
  ExternalCallbacks,
  HitTargets,
  Node,
  Relationship,
} from '@neo4j-nvl/base'
import type { MouseEventCallbacks } from '@neo4j-nvl/react'
import { GET_ALL_ME_SPACES, GET_ALL_WE_SPACES } from '@/app/graphql/queries'
import { GET_SPACE_DETAILS } from '@/app/graphql/queries/SPACE_DETAILS_QUERIES'
import { GET_FIELD_CONTEXT_DETAILS } from '@/app/graphql/queries/FIELD_CONTEXT_DETAILS_QUERIES'
import { GET_FIELD_CONTEXT_PEOPLE } from '@/app/graphql/queries/FIELD_CONTEXT_PEOPLE_QUERIES'
import { GET_DOCUMENTS_BY_FIELD_CONTEXT } from '@/app/graphql/queries/DOCUMENT_QUERIES'
import { useFocalEntity } from '@/contexts'
import { useIsDarkMode, useNvlTouchGestures } from '@/hooks'
import { useRouteFocalScope } from '@/lib/focal-entity/use-route-focal-scope'
import type { FocalEntityType } from '@/lib/focal-entity/types'
import type { NvlRefHandle } from '@/components/graph/visualizer'
import { GraphLoadingState } from './graph-loading-state'
import { BloomLegend } from './bloom-legend'
import { getBloomPalette } from './bloom-palette'
import {
  buildBloomCanvas,
  type BloomGraphInput,
  type FieldContextRecord,
  type NamedEntity,
  type PersonRecord,
  type PulseAuthorRecord,
  type PulseRecord,
  type ResonanceRecord,
  type SpacePersonRecord,
  type SpaceRecord,
  type WeaveRecord,
} from './bloom-graph-builder'
import {
  applyBloomTypeFilters,
  DOCUMENT_TYPE_KEY,
} from './bloom-type-registry'
import { useBloomTypeFilters } from './use-bloom-type-filters'
import {
  buildDocumentProvenanceLayer,
  documentDerivedIds,
  type ProvenanceDocument,
} from './document-provenance-layer'
import { applyDocumentHiding } from './document-visibility'
import { isAwaitingReview } from '@/lib/promise-weave'
import { useBloomOverlay, type BloomOverlay } from '../../bloom-overlay-context'
import {
  useVisibleEntities,
  type VisibleEntity,
} from '../../visible-entities-context'

/**
 * Bloom Exploration — the native NVL rendering of the user's spaces.
 *
 * Per kb/01-glossary.md: "A separate, more open-ended graph surface that
 * exposes native Neo4j NVL exploration capabilities ... with minimal
 * GoalPost-specific opinionation."
 *
 * Architectural rule (set by the user): Bloom does NOT fetch — it is a
 * pure visual transform of the same Apollo-cached data the Dashboard
 * cards already loaded. Toggling between the two canvas views is
 * therefore a zero-network frontend change.
 *
 * Bloom renders native NVL nodes (caption + color + size only), letting
 * NVL render and interact with them as it would by default. (The former
 * Graph View, which mounted custom `EntityBubble` HTML nodes, has been
 * deprecated and removed; Bloom is now the sole graph surface.)
 */

// NVL renders only in the browser — `@neo4j-nvl/base` references `document` at
// module-evaluation, so its module must never load on the server. Keep the
// import INSIDE the dynamic() factory, which `ssr: false` skips server-side. A
// previous module-level `const visualizerChunk = import('.../visualizer')` (to
// warm the chunk) defeated `ssr: false` — it executed during SSR too and threw
// "ReferenceError: document is not defined" on every protected route. next/dynamic
// already lazy-loads + caches the chunk on first client render, so the warm was
// redundant. (GOAL-280 investigation.)
const GraphVisualizer = dynamic(
  () => import('@/components/graph/visualizer').then((mod) => mod.GraphVisualizer),
  {
    ssr: false,
    loading: () => (
      <div className="relative w-full h-full bg-gp-surface dark:bg-gp-surface-dark">
        <GraphLoadingState label="Preparing canvas" />
      </div>
    ),
  }
)

/**
 * Stable identity for "nothing is hidden". It is what lets
 * `applyDocumentHiding` return the built graph by identity when the Documents
 * row is switched on, which in turn keeps the fit-to-scope effects keyed on
 * `nodes` from re-firing on every render.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

// How long to wait after a single click before treating it as a drill — long
// enough for a double-click (drawer) to arrive and cancel it.
const SINGLE_CLICK_DELAY = 250

/**
 * Map a Neo4j label (as carried on `NVLNode.labels` from the cypher
 * generator) to the drawer's `InfoEntityType`.
 *
 * Every pulse subtype collapses to 'Pulse' — `PulseDetailsBody` resolves
 * the concrete __typename itself. Person/User/PersonPulse collapse to
 * 'Person' for the same reason. Anything we don't recognise (e.g. the
 * `Community` anchor, or a label the generator started returning before
 * this map caught up) returns null — Bloom falls back to its inline
 * minimal panel for those, which is strictly safer than dispatching the
 * drawer with a bogus type.
 */
const LABEL_TO_INFO_TYPE: Record<string, InfoEntityType> = {
  MeSpace: 'MeSpace',
  WeSpace: 'WeSpace',
  FieldContext: 'FieldContext',
  GoalPulse: 'Pulse',
  ResourcePulse: 'Pulse',
  StoryPulse: 'Pulse',
  CarePulse: 'Pulse',
  CoreValuePulse: 'Pulse',
  FieldPulse: 'Pulse',
  Pulse: 'Pulse',
  Person: 'Person',
  User: 'Person',
  PersonPulse: 'Person',
  Document: 'Document',
  ResonanceLink: 'ResonanceLink',
  PromiseWeave: 'PromiseWeave',
  Organization: 'Organization',
}

function labelsToInfoEntityType(
  labels: string[] | undefined
): InfoEntityType | null {
  if (!labels) return null
  for (const l of labels) {
    const mapped = LABEL_TO_INFO_TYPE[l]
    if (mapped) return mapped
  }
  return null
}

/**
 * Heuristic fallback when an overlay node arrives without `labels` (older
 * chat threads cached from before the labels-on-NVLNode patch, or an
 * occasional model emission that prunes the field from the BLOOM_GRAPH_OVERLAY
 * JSON). GoalPost id prefixes are stable conventions written by the
 * server-side creation paths:
 *   - `me_`       lib/validation/space-validation.ts (app-created MeSpace)
 *   - `mespace_`  scripts/migrate-prod-to-dev.ts (prod-migrated MeSpace)
 *   - `context_`  lib/chat/hitl.ts (FieldContext) — production path
 *   - `ctx_`      legacy / fixture data only; kept as a safety net
 *   - `pulse_`    api/pulse/create-from-conversation
 *   - `rl_`       api/resonance/suggestions/[id]/accept (ResonanceLink)
 *   - `document_` lib/ingest/document-storage.ts (Document) — production path
 *   - `doc_`      chat-overlay Documents only; NOT a prefix of `document_`
 *   - `person_`   lib/chat/hitl.ts (Person — HITL-created profiles)
 *
 * Ambiguity: legacy Persons and all WeSpaces use bare UUIDs (no prefix).
 * For those, we return null and let the caller fall back to the inline
 * minimal panel rather than guessing wrong and opening the drawer at
 * the wrong entity. (`chunk_` and `log_` exist elsewhere in the codebase
 * but are not exposed as Bloom entities, so they're intentionally
 * absent from this table.)
 */
function idPrefixToInfoEntityType(id: string): InfoEntityType | null {
  if (id.startsWith('me_') || id.startsWith('mespace_')) return 'MeSpace'
  if (id.startsWith('ctx_') || id.startsWith('context_')) return 'FieldContext'
  if (id.startsWith('pulse_')) return 'Pulse'
  if (id.startsWith('rl_')) return 'ResonanceLink'
  // BOTH prefixes are load-bearing. Documents are minted `document_<uuid>`
  // (document-storage.ts), and `'document_'.startsWith('doc_')` is FALSE —
  // 'docu' is not 'doc_' — so the shorter check alone silently resolved every
  // real Document to null and dropped the click. `doc_` stays for the chat
  // overlay, which was the only path that put a Document on this canvas
  // before the GOAL-346 provenance layer put real ones there.
  if (id.startsWith('document_') || id.startsWith('doc_')) return 'Document'
  if (id.startsWith('person_')) return 'Person'
  if (id.startsWith('organization_')) return 'Organization'
  return null
}

/**
 * Final fallback: derive the entity type from the NVL node's color. The
 * cypher generator's `styleFor` (lib/cypher-generator/execute.ts) encodes
 * the entity type via a stable color palette — so even when `labels` is
 * missing AND the id is a bare UUID (legacy Users, all WeSpaces), the
 * color hint is still present on the overlay node. (The removed Graph
 * View's neighborhood route used the same palette; execute.ts is the sole
 * source of truth now.)
 *
 * MeSpace vs WeSpace cannot be distinguished by color alone (both
 * '#86efac'); we resolve that ambiguity by treating bare-UUID green
 * nodes as WeSpaces (the only Space type that uses bare UUIDs in prod
 * — MeSpaces are always prefixed `me_*` or `mespace_*` and would have
 * been caught by the prefix table above).
 *
 * Pulse subtypes have distinct colors but all collapse to the 'Pulse'
 * drawer type — `PulseDetailsBody` resolves the concrete __typename
 * via its own GraphQL query.
 */
function colorToInfoEntityType(
  color: string | undefined
): InfoEntityType | null {
  if (!color) return null
  switch (color.toLowerCase()) {
    case '#86efac':
      return 'WeSpace'
    case '#fde68a':
      return 'FieldContext'
    case '#f9a8d4':
      return 'Person'
    case '#93c5fd':
    case '#a7f3d0':
    case '#c4b5fd':
    case '#fca5a5':
    case '#fcd34d':
      return 'Pulse'
    case '#d8b4fe':
    case '#e9d5ff':
      return 'ResonanceLink'
    case '#2dd4bf': // native weave teal (bloom-palette WEAVE_NODE_COLOR)
    case '#f0abfc': // overlay weave fuchsia (node-style.ts, GOAL-288)
      return 'PromiseWeave'
    case '#5eead4':
      // Organization — the cypher generator's styleFor color (GOAL-298).
      return 'Organization'
    case '#94a3b8':
      // Document — the cypher generator's styleFor color (GOAL-288).
      return 'Document'
    default:
      return null
  }
}

/**
 * Resolve an overlay node's id to an InfoEntityType using the three-tier
 * cascade (precise labels → stable id prefix → last-resort color). Shared by
 * `handleNodeClick` (which drawer-type it maps to) and `handleNodeNavigate`
 * (whether it has a drill route) so the two paths can never disagree on what
 * an overlay node *is*.
 */
function resolveOverlayEntityType(
  overlay: BloomOverlay,
  id: string
): InfoEntityType | null {
  const overlayNode = overlay.nodes.find((n) => n.id === id)
  return (
    labelsToInfoEntityType(overlayNode?.labels) ??
    idPrefixToInfoEntityType(id) ??
    colorToInfoEntityType(overlayNode?.color)
  )
}

// Minimal read shape for the owner/member person fields on the space
// queries — the generated MeSpace | WeSpace union is awkward to narrow inline.
type RawPersonLite = {
  id: string
  firstName?: string | null
  lastName?: string | null
  name?: string | null
}

// Neo4j-GraphQL relationship fields can arrive as a single object or a
// single-element array depending on the selection — normalize both.
function firstOf<T>(v: T | T[] | null | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : (v ?? undefined)
}

function composeName(p: {
  firstName?: string | null
  lastName?: string | null
  name?: string | null
}): string {
  const composed = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
  return p.name?.trim() || composed || 'Unnamed'
}

export const BloomView: FC = () => {
  const { setFocalEntity } = useFocalEntity()
  // NVL paints to a <canvas> from resolved color strings, so it can't consume
  // the `--gp-*` tokens every other surface themes with — the canvas palette
  // is the documented exception that has to be picked in JS. Everything else
  // in this component (backdrop, empty state, panels) uses tokens.
  const isDark = useIsDarkMode()
  const palette = getBloomPalette(isDark)
  const { overlay, clearOverlay } = useBloomOverlay()
  const { publish: publishVisibleEntities } = useVisibleEntities()
  const nvlRef = useRef<NvlRefHandle | null>(null)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  // Hover-driven cursor. NVL renders native canvas nodes, so there's no
  // HTML element we can put `cursor: pointer` on. We bind a wrapper ref +
  // an `onHover`
  // callback and mutate `style.cursor` directly when the mouse is over
  // a node — going through React state for every mousemove would
  // re-render the canvas chunk on every pixel.
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)
  const isHoveringNodeRef = useRef(false)
  const router = useRouter()
  // Single-click drills, double-click opens the drawer. NVL has no built-in
  // single-vs-double debounce — it emits raw DOM events, so a double-click
  // fires two `onNodeClick`s then `onNodeDoubleClick`. A naive single=drill
  // wiring would navigate away on the first click before the double-click
  // drawer intent registers. So we hold the drill in a timer
  // (`clickTimerRef`): if a second click (or `onNodeDoubleClick`) arrives
  // first, we cancel the pending drill and open the drawer instead.
  const clickTimerRef = useRef<number | null>(null)

  // "In-space" / "in-field" are URL concepts, not focal-entity concepts.
  // Reading `sessionContext.activeSpaceId` would conflate the user's
  // *persisted* last-space with the *current route* — at the dashboard
  // root that would render field contexts when we should be showing
  // top-level spaces. Drive the scope strictly from the pathname, through
  // the shared `useRouteFocalScope` hook so this surface and the Dashboard
  // pages derive scope from one source and can't diverge (GOAL-271).
  // Overlay still takes priority over both modes.
  const { activeSpaceId, activeFieldId } = useRouteFocalScope()
  const inSpace = !!activeSpaceId && !overlay
  const inField = !!activeFieldId && !overlay

  // Identical Apollo queries to SpacesOverview. `cache-first`
  // hits the warm cache on every flip — zero network round-trip.
  const { data: meData, loading: meLoading } = useQuery(GET_ALL_ME_SPACES, {
    fetchPolicy: 'cache-first',
  })
  const { data: weData, loading: weLoading } = useQuery(GET_ALL_WE_SPACES, {
    fetchPolicy: 'cache-first',
  })

  // In-space details — `cache-first` is intentional even on cold load:
  // `CanvasHost` keeps `SpaceDashboardView` mounted at this route (under
  // `visibility:hidden`) regardless of canvas view, and that component
  // always fires the `cache-and-network` `GET_SPACE_DETAILS` fetch.
  // Apollo dedupes our read against that in-flight request — Bloom gets
  // the result the moment it resolves with no double round-trip.
  const { data: spaceDetailsData, loading: spaceDetailsLoading } = useQuery(
    GET_SPACE_DETAILS,
    {
      variables: { spaceId: activeSpaceId ?? '' },
      skip: !activeSpaceId,
      fetchPolicy: 'cache-first',
    }
  )

  // In-field details — `cache-first` mirrors the in-space rationale above.
  // The FieldContext detail page already fires `GET_FIELD_CONTEXT_DETAILS`
  // because `CanvasHost` keeps the route content mounted under
  // `visibility:hidden` regardless of the active canvas view, so flipping
  // into Bloom reads the cached result with no extra round-trip.
  const { data: fieldDetailsData, loading: fieldDetailsLoading } = useQuery(
    GET_FIELD_CONTEXT_DETAILS,
    {
      variables: { contextId: activeFieldId ?? '' },
      skip: !activeFieldId,
      fetchPolicy: 'cache-first',
    }
  )

  // People in the active field — the parent space's owner + every Person
  // attached via HAS_PERSON. `cache-first` reads the warm cache when the
  // route has already loaded these (Apollo dedupes a cold load against the
  // in-flight request). Bloom needs these to render the INITIATED_BY edges
  // with a real person endpoint to point at.
  const { data: fieldPeopleData } = useQuery(GET_FIELD_CONTEXT_PEOPLE, {
    variables: { contextId: activeFieldId ?? '' },
    skip: !activeFieldId,
    fetchPolicy: 'cache-first',
  })

  // GOAL-346: documents of the active field, for the provenance layer below.
  // `cache-first` and the same skip guard as its siblings — the field route
  // has usually already loaded this exact query for its document list, so
  // flipping into Bloom costs no round-trip (ADR-011).
  const { data: fieldDocumentsData } = useQuery(
    GET_DOCUMENTS_BY_FIELD_CONTEXT,
    {
      variables: { fieldContextId: activeFieldId ?? '' },
      skip: !activeFieldId,
      fetchPolicy: 'cache-first',
    }
  )

  // Per-type visibility (GOAL-350). Every node and relationship type on the
  // canvas is independently switchable from the legend; Documents is simply
  // the row that starts off (GOAL-346's default, now expressed through this
  // model rather than as its own boolean). Purely presentational — nothing
  // here changes what is fetched or what the viewer is authorized to see.
  //
  // `applyDefaults` is off under an overlay: the Documents default exists for
  // the volume of the NATIVE in-field layer, whereas an overlay is a subgraph
  // the member explicitly asked the assistant for — pruning Documents out of
  // it before they touch a control would discard what was requested.
  const typeFilters = useBloomTypeFilters({ applyDefaults: !overlay })

  const loading = inField
    ? fieldDetailsLoading
    : inSpace
      ? spaceDetailsLoading
      : meLoading || weLoading

  const spaces: SpaceRecord[] = useMemo(() => {
    const me = (meData?.meSpaces ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      type: 'MeSpace' as const,
    }))
    const we = (weData?.weSpaces ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      type: 'WeSpace' as const,
    }))
    return [...me, ...we]
  }, [meData, weData])

  const fieldContexts: FieldContextRecord[] = useMemo(() => {
    if (!inSpace) return []
    const space = spaceDetailsData?.spaces?.[0]
    if (!space) return []
    const spaceKind = space.__typename === 'MeSpace' ? 'MeSpace' : 'WeSpace'
    const contexts = ('contexts' in space ? space.contexts : undefined) ?? []
    return contexts.map((ctx) => ({
      id: ctx.id,
      name: ctx.title || 'Untitled field',
      spaceKind,
      parentId: firstOf(ctx.parentContext)?.id ?? null,
    }))
  }, [inSpace, spaceDetailsData])

  const pulses: PulseRecord[] = useMemo(() => {
    if (!inField || !fieldDetailsData) return []
    const make = (
      list: Array<{ id: string; title?: string | null }> | undefined,
      pulseType: PulseRecord['pulseType'],
      focalType: FocalEntityType
    ): PulseRecord[] =>
      (list ?? []).map((pulse) => ({
        id: pulse.id,
        name: pulse.title || 'Untitled pulse',
        pulseType,
        focalType,
      }))
    return [
      ...make(fieldDetailsData.goalPulses, 'goal', 'GoalPulse'),
      ...make(fieldDetailsData.resourcePulses, 'resource', 'ResourcePulse'),
      ...make(fieldDetailsData.storyPulses, 'story', 'StoryPulse'),
      ...make(fieldDetailsData.carePulses, 'care', 'CarePulse'),
      ...make(fieldDetailsData.coreValuePulses, 'coreValue', 'CoreValuePulse'),
    ]
  }, [inField, fieldDetailsData])

  // Nested fields (GOAL-295 / GOAL-339): the active field's direct
  // sub-contexts, rendered in-field as field bubbles hanging off a field
  // anchor so members can see and drill into nesting without leaving the
  // canvas. Read off the same GET_FIELD_CONTEXT_DETAILS payload the
  // dashboard page warmed — Bloom never fetches its own data (ADR-011).
  const subContexts = useMemo<NamedEntity[]>(() => {
    if (!inField || !fieldDetailsData) return []
    const context = fieldDetailsData.fieldContexts?.[0]
    const list = (context?.subContexts ?? []) as Array<{
      id: string
      title?: string | null
    }>
    return list.map((sub) => ({
      id: sub.id,
      name: sub.title || 'Untitled field',
    }))
  }, [inField, fieldDetailsData])

  // The active field itself, rendered as the anchor its nested fields hang
  // off. Only materialized when there is nesting to show — a field with no
  // sub-contexts keeps the classic free-floating pulse cloud.
  const fieldAnchor = useMemo(() => {
    if (!inField || !activeFieldId || subContexts.length === 0) return null
    const context = fieldDetailsData?.fieldContexts?.[0]
    if (!context) return null
    return { id: activeFieldId, name: context.title || 'Untitled field' }
  }, [inField, activeFieldId, subContexts, fieldDetailsData])

  // Which space kind tints the in-field field bubbles. A field belongs to
  // exactly one space; default to MeSpace while the people query resolves.
  const inFieldSpaceKind = useMemo<'MeSpace' | 'WeSpace'>(() => {
    const fieldCtx = (
      fieldPeopleData as
        | { fieldContexts?: Array<{ weSpace?: Array<unknown> }> }
        | undefined
    )?.fieldContexts?.[0]
    return fieldCtx?.weSpace?.[0] ? 'WeSpace' : 'MeSpace'
  }, [fieldPeopleData])

  // People to render alongside the pulses in-field: the parent space's
  // owner + every member of that space + any Person attached to the field.
  // These are the endpoints the INITIATED_BY edges point at — without them
  // NVL would drop every initiated edge as dangling.
  const persons: PersonRecord[] = useMemo(() => {
    if (!inField) return []
    type RawPerson = {
      id: string
      name?: string | null
      firstName?: string | null
      lastName?: string | null
    }
    const toRecord = (
      p: RawPerson,
      focalType: PersonRecord['focalType']
    ): PersonRecord => {
      const composed = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
      return {
        id: p.id,
        name: p.name?.trim() || composed || 'Unnamed',
        focalType,
      }
    }
    const fieldCtx = (
      fieldPeopleData as
        | {
            fieldContexts?: Array<{
              people?: RawPerson[]
              meSpace?: Array<{
                owner?: RawPerson[]
                members?: Array<{ member?: RawPerson[] } | null>
              }>
              weSpace?: Array<{
                owner?: RawPerson[]
                members?: Array<{ member?: RawPerson[] } | null>
              }>
            }>
          }
        | undefined
    )?.fieldContexts?.[0]
    if (!fieldCtx) return []
    // A field belongs to exactly one space (MeSpace or WeSpace).
    const space = fieldCtx.weSpace?.[0] ?? fieldCtx.meSpace?.[0] ?? null
    const owner = space?.owner?.[0] ?? null
    const seen = new Set<string>()
    const records: PersonRecord[] = []
    if (owner?.id) {
      seen.add(owner.id)
      records.push(toRecord(owner, 'User'))
    }
    // Parent-space members participate in the field too — surface them so they
    // appear and so member-authored pulses keep their INITIATED_BY edge (NVL
    // drops any edge whose person endpoint isn't a visible node).
    for (const m of space?.members ?? []) {
      const mm = m?.member?.[0]
      if (!mm?.id || seen.has(mm.id)) continue
      seen.add(mm.id)
      records.push(toRecord(mm, 'User'))
    }
    for (const p of fieldCtx.people ?? []) {
      if (!p?.id || seen.has(p.id)) continue
      seen.add(p.id)
      records.push(toRecord(p, 'PersonPulse'))
    }
    return records
  }, [inField, fieldPeopleData])

  // Ids of the people the canvas keeps regardless of what the Documents layer
  // is doing. The parent space's owner and members are rendered because they
  // belong to the space; a document naming one of them must not evict them,
  // and evicting the owner would strip the author edge off every pulse they
  // wrote by hand. `persons` tags exactly these two groups 'User' — everyone
  // reached through the field's HAS_PERSON roster is tagged 'PersonPulse'.
  const anchoredPersonIds = useMemo(
    () =>
      new Set(
        persons.filter((p) => p.focalType === 'User').map((p) => p.id)
      ),
    [persons]
  )

  // GOAL-346: people a human deliberately promoted onto the field roster.
  // Already selected by GET_FIELD_CONTEXT_PEOPLE for the roster filter, and
  // read here so both surfaces apply the same "curation outranks extraction"
  // precedence (src/lib/field-roster-visibility.ts).
  //
  // The two rules are NOT identical, deliberately: the roster has no notion of
  // `anchoredPersonIds`, so an extracted, uncurated space member is dropped
  // from the dashboard roster but kept on the canvas. The canvas needs them —
  // they are the endpoint every author edge points at — and the roster does
  // not.
  const curatedPersonIds = useMemo<string[]>(() => {
    const fieldCtx = (
      fieldPeopleData as
        | { fieldContexts?: Array<{ curatedPersonIds?: string[] | null }> }
        | undefined
    )?.fieldContexts?.[0]
    return fieldCtx?.curatedPersonIds ?? []
  }, [fieldPeopleData])

  // Everything the canvas drops when the Documents row is switched OFF: the
  // documents, the people they named, and the pulses they produced. See
  // `documentDerivedIds` for why "off" is the whole subgraph and not just the
  // Document hubs.
  //
  // GOAL-350 moved the on/off decision into the per-type filter, but the RULE
  // stays here and stays id-based: `applyBloomTypeFilters` hides a type by
  // colour, which reaches the Document hubs and their EXTRACTED_FROM edges but
  // not the people and pulses those documents produced — those are painted as
  // ordinary people and pulses. Only provenance knows which ones they are.
  const hiddenDocumentIds = useMemo<ReadonlySet<string>>(() => {
    if (!inField || !typeFilters.hidden.has(DOCUMENT_TYPE_KEY)) return EMPTY_IDS
    const documents = (
      fieldDocumentsData as
        | { documentsByFieldContext?: ProvenanceDocument[] }
        | undefined
    )?.documentsByFieldContext
    return documentDerivedIds({
      documents,
      curatedPersonIds,
      anchoredIds: anchoredPersonIds,
    })
  }, [
    inField,
    typeFilters.hidden,
    fieldDocumentsData,
    curatedPersonIds,
    anchoredPersonIds,
  ])

  // GOAL-346: Document nodes + EXTRACTED_FROM edges. Built here so both
  // builders below consume one derivation and cannot disagree about which
  // documents made it onto the canvas — the invariant that keeps NVL from
  // being handed an edge to a node that isn't rendered.
  //
  // Built whenever the scope is in-field, NOT only when Documents are switched
  // on: since GOAL-350 the on/off decision belongs to the type filter, and a
  // type has to be on the built canvas for the legend to derive a toggle for
  // it at all. The layer is cheap — a node per document plus edges to people
  // already rendered, with no extra fetch behind it (ADR-011).
  const documentProvenance = useMemo(() => {
    const documents = (
      fieldDocumentsData as
        | { documentsByFieldContext?: ProvenanceDocument[] }
        | undefined
    )?.documentsByFieldContext
    return buildDocumentProvenanceLayer({
      documents,
      visiblePersonIds: new Set(persons.map((p) => p.id)),
      palette,
      // Applied once, further down, as a visibility pass over the finished
      // graph — and that pass needs the EXTRACTED_FROM edges present to see
      // which people it strands by removing them.
      visible: inField,
    })
  }, [fieldDocumentsData, persons, palette, inField])

  // CONNECTED_TO edges among the field's people. The relationship lives on the
  // edge (connectionEdges → connectedPersonId + why); each field person carries
  // the edges they're part of. We collect ordered id-pairs here and draw them
  // in the in-field relationships memo, filtered to people actually on canvas
  // (the owner/user is rendered as a field person too, so a user↔person
  // relationship — e.g. "your wife" — has both endpoints visible).
  const connections: Array<{ fromId: string; toId: string; why: string | null }> =
    useMemo(() => {
      if (!inField) return []
      const fieldCtx = (
        fieldPeopleData as
          | {
              fieldContexts?: Array<{
                people?: Array<{
                  id: string
                  // GOAL-275: the connection graph reads through the single
                  // type-level gate; null when this caller isn't authorized
                  // for that person, in which case they contribute no edges.
                  privateProfile?: {
                    connectionEdges?: Array<{
                      connectedPersonId?: string | null
                      why?: string | null
                    }> | null
                  } | null
                }>
              }>
            }
          | undefined
      )?.fieldContexts?.[0]
      if (!fieldCtx?.people) return []
      const seenPairs = new Set<string>()
      const out: Array<{ fromId: string; toId: string; why: string | null }> = []
      for (const p of fieldCtx.people) {
        if (!p?.id) continue
        for (const edge of p.privateProfile?.connectionEdges ?? []) {
          const other = edge?.connectedPersonId
          if (!other || other === p.id) continue
          // CONNECTED_TO is undirected — key on the sorted id-pair so the same
          // relationship surfaced from both endpoints is drawn once.
          const key = [p.id, other].sort().join('::')
          if (seenPairs.has(key)) continue
          seenPairs.add(key)
          out.push({ fromId: p.id, toId: other, why: edge?.why?.trim() || null })
        }
      }
      return out
    }, [inField, fieldPeopleData])

  // Resonance edges between pulses inside the active field. The Apollo
  // payload only resolves `source`/`target` when both pulse subtype
  // fragments matched (i.e. both endpoints are pulse entities), so we
  // filter to entries with both ids present — that drops any edge whose
  // endpoint is a non-pulse / inaccessible node without breaking the
  // visualisation.
  const resonances: ResonanceRecord[] = useMemo(() => {
    if (!inField || !fieldDetailsData) return []
    const context = fieldDetailsData.fieldContexts?.[0]
    const links = (context?.resonancesInContext ?? []) as Array<{
      id: string
      label?: string | null
      source?: Array<{ id?: string | null } | null> | null
      target?: Array<{ id?: string | null } | null> | null
    }>
    return links.flatMap((link) => {
      const sourceId = link.source?.[0]?.id
      const targetId = link.target?.[0]?.id
      if (!sourceId || !targetId) return []
      return [
        {
          id: link.id,
          sourceId,
          targetId,
          label: link.label ?? '',
        },
      ]
    })
  }, [inField, fieldDetailsData])

  // PromiseWeaves anchored in the active field. Each becomes a teal hub node
  // with WEAVES spokes to the pulses it connects (built in the memos below).
  // Read off the same GET_FIELD_CONTEXT_DETAILS payload as pulses/resonances.
  const weaves: WeaveRecord[] = useMemo(() => {
    if (!inField || !fieldDetailsData) return []
    const context = fieldDetailsData.fieldContexts?.[0]
    const list = (context?.weaves ?? []) as Array<{
      id: string
      title?: string | null
      status?: string | null
      weaves?: Array<{ id?: string | null } | null> | null
    }>
    return list.map((w) => ({
      id: w.id,
      name: w.title || 'Promise weave',
      wovenPulseIds: (w.weaves ?? []).flatMap((p) => (p?.id ? [p.id] : [])),
      // `status` was already in the GET_FIELD_CONTEXT_DETAILS payload and was
      // being discarded here — read it through the shared helper rather than
      // comparing the raw string (legacy migration values, null-reads-as-active).
      awaitingReview: isAwaitingReview(w.status),
    }))
  }, [inField, fieldDetailsData])

  // The current user — owner of the (single) MeSpace per the one-MeSpace
  // invariant. Drives the root "You" hub node and its owns/member edges out
  // to every space.
  const currentUserId = useMemo<string | null>(() => {
    const owner = firstOf(
      (
        meData?.meSpaces?.[0] as
          | { owner?: RawPersonLite | RawPersonLite[] | null }
          | undefined
      )?.owner
    )
    return owner?.id ?? null
  }, [meData])

  // In-space scope: the active space's owner + members, rendered as person
  // spokes off the space hub. Each carries its role so the edge reads
  // "owns" or "member".
  const inSpacePeople = useMemo<SpacePersonRecord[]>(() => {
    if (!inSpace) return []
    const space = spaceDetailsData?.spaces?.[0] as
      | {
          owner?: RawPersonLite | RawPersonLite[] | null
          members?: Array<{
            member?: RawPersonLite | RawPersonLite[] | null
          } | null> | null
        }
      | undefined
    if (!space) return []
    const out: SpacePersonRecord[] = []
    const seen = new Set<string>()
    const owner = firstOf(space.owner)
    if (owner?.id) {
      seen.add(owner.id)
      out.push({ id: owner.id, name: composeName(owner), role: 'OWNER' })
    }
    for (const m of space.members ?? []) {
      const mm = firstOf(m?.member)
      if (!mm?.id || seen.has(mm.id)) continue
      seen.add(mm.id)
      out.push({ id: mm.id, name: composeName(mm), role: 'MEMBER' })
    }
    return out
  }, [inSpace, spaceDetailsData])

  // The space itself, rendered as the central hub in its in-space view.
  const spaceAnchor = useMemo(() => {
    if (!inSpace || !activeSpaceId) return null
    const space = spaceDetailsData?.spaces?.[0]
    if (!space) return null
    const kind: 'MeSpace' | 'WeSpace' =
      space.__typename === 'MeSpace' ? 'MeSpace' : 'WeSpace'
    return { id: activeSpaceId, name: space.name || 'Space', kind }
  }, [inSpace, activeSpaceId, spaceDetailsData])

  // The author of each in-field pulse. Authorship lives on TWO live edges
  // (INITIATED_BY: assistant/doc-ingest paths; CREATED_BY: dashboard flow,
  // imports), so mirror resolvePulseAuthor (src/lib/pulse-author.ts): prefer
  // initiatedBy, fall back to createdBy — else dashboard-created pulses render
  // authorless. The generated GraphQL types don't surface these fields, so we
  // read them through a narrow cast.
  const pulseAuthors: PulseAuthorRecord[] = useMemo(() => {
    if (!inField || !fieldDetailsData) return []
    type PulseWithAuthorIds = {
      id: string
      initiatedBy?: Array<{ id: string }> | null
      createdBy?: Array<{ id: string }> | null
    }
    const allPulses = [
      ...((fieldDetailsData.goalPulses ?? []) as PulseWithAuthorIds[]),
      ...((fieldDetailsData.resourcePulses ?? []) as PulseWithAuthorIds[]),
      ...((fieldDetailsData.storyPulses ?? []) as PulseWithAuthorIds[]),
      ...((fieldDetailsData.carePulses ?? []) as PulseWithAuthorIds[]),
      ...((fieldDetailsData.coreValuePulses ?? []) as PulseWithAuthorIds[]),
    ]
    return allPulses.flatMap((pulse) => {
      const authorId = pulse.initiatedBy?.[0]?.id ?? pulse.createdBy?.[0]?.id
      return authorId ? [{ pulseId: pulse.id, authorId }] : []
    })
  }, [inField, fieldDetailsData])

  // Spaces the current user owns — their MeSpace plus any WeSpace they
  // created. Drives whether a root spoke reads `owns` or `member`.
  const ownedSpaceIds = useMemo<ReadonlySet<string>>(() => {
    return new Set<string>([
      ...(meData?.meSpaces ?? []).map((s) => s.id),
      ...(weData?.weSpaces ?? [])
        .filter(
          (s) =>
            firstOf(
              (s as { owner?: RawPersonLite | RawPersonLite[] | null }).owner
            )?.id === currentUserId
        )
        .map((s) => s.id),
    ])
  }, [meData, weData, currentUserId])

  // Everything the canvas is built from, in one bag. Construction itself lives
  // in `bloom-graph-builder.ts` as a pure derivation — see that module's
  // header for why it is not inline here.
  const graphInput: BloomGraphInput = useMemo(
    () => ({
      overlay,
      isDark,
      palette,
      inField,
      inSpace,
      pulses,
      persons,
      weaves,
      resonances,
      connections,
      pulseAuthors,
      subContexts,
      fieldAnchor,
      inFieldSpaceKind,
      documentProvenance,
      fieldContexts,
      spaceAnchor,
      inSpacePeople,
      spaces,
      currentUserId,
      ownedSpaceIds,
    }),
    [
      overlay,
      isDark,
      palette,
      inField,
      inSpace,
      pulses,
      persons,
      weaves,
      resonances,
      connections,
      pulseAuthors,
      subContexts,
      fieldAnchor,
      inFieldSpaceKind,
      documentProvenance,
      fieldContexts,
      spaceAnchor,
      inSpacePeople,
      spaces,
      currentUserId,
      ownedSpaceIds,
    ]
  )

  // The full canvas, before any type filter. The legend derives its rows from
  // THIS — a type you switch off has to keep its row, or there is no way back.
  const builtCanvas = useMemo(() => buildBloomCanvas(graphInput), [graphInput])

  // Documents are hidden by ID, not by colour, and that pass runs FIRST.
  //
  // `applyBloomTypeFilters` resolves a type from a node's paint, which reaches
  // the Document hubs and their EXTRACTED_FROM edges but not the people and
  // pulses those documents produced — those are painted as ordinary people and
  // pulses (GOAL-346). Sweeping before the type filter is also what keeps the
  // stranding rule honest: `applyDocumentHiding` decides who was left hanging
  // by comparing against the edges that existed BEFORE the hiding, so it has
  // to see the EXTRACTED_FROM edges still in place.
  const sweptCanvas = useMemo(
    () =>
      applyDocumentHiding({
        nodes: builtCanvas.nodes,
        relationships: builtCanvas.relationships,
        hiddenIds: hiddenDocumentIds,
        // The field's own pulses are never swept for being stranded. A pulse
        // that ingestion did NOT create can still have an extracted person as
        // its only edge — a member crediting someone a document named — and it
        // would otherwise vanish when documents are switched off. It belongs to
        // the field whoever is credited on it, so it stays, unattached.
        protectedIds: new Set(pulses.map((p) => p.id)),
      }),
    [builtCanvas, hiddenDocumentIds, pulses]
  )

  // What NVL actually paints. A pure presentational transform: it drops the
  // types switched off in the legend and re-guards every surviving edge
  // against the surviving nodes, so hiding a node type cascades to its edges
  // and NVL is never handed a dangling arrow. Nothing is refetched (ADR-011),
  // and nothing here is an authorization decision (kb/02-user-roles.md).
  const { nodes, relationships } = useMemo(
    () => applyBloomTypeFilters(sweptCanvas, typeFilters.hidden),
    [sweptCanvas, typeFilters.hidden]
  )

  // Publish whatever Bloom is currently rendering so the assistant can
  // recognise entities by name (e.g. "show me what is in JD's Tech Lab"
  // resolves to the WeSpace already on screen instead of fail-searching).
  // Each precedence branch maps to a typed entity list:
  //   - overlay   → its own bag (type inferred from caption since the
  //                 overlay payload does not carry a GoalPost type)
  //   - in-field  → the active FieldContext's pulses (typed by subtype)
  //   - in-space  → the active Space's field contexts
  //   - default   → the user's MeSpace + WeSpace cluster
  useEffect(() => {
    const bloomEntities: VisibleEntity[] = (() => {
      if (overlay) {
        return overlay.nodes.map((n) => ({
          id: n.id,
          name: n.caption ?? n.id,
          // Overlay payloads do not carry a typed label — surface as
          // "OverlayNode" so the model still has a hint.
          type: 'OverlayNode',
          source: 'bloom' as const,
        }))
      }
      if (inField) {
        // Pulses + the people now rendered as person nodes. Publishing
        // people lets the assistant resolve someone who is visibly on the
        // Bloom canvas by name instead of fail-searching. Keyed off the
        // rendered node ids, so a pulse or person the Documents toggle just
        // removed stops being resolvable by name too — the assistant should
        // never claim to see something the canvas isn't showing.
        const rendered = new Set(nodes.map((n) => n.id))
        return [
          ...pulses
            .filter((p) => rendered.has(p.id))
            .map((p) => ({
              id: p.id,
              name: p.name,
              type: p.focalType as VisibleEntity['type'],
              source: 'bloom' as const,
            })),
          ...persons
            .filter((p) => rendered.has(p.id))
            .map((p) => ({
              id: p.id,
              name: p.name,
              type: p.focalType as VisibleEntity['type'],
              source: 'bloom' as const,
            })),
          // Nested fields on canvas resolve by name too (GOAL-339). Not
          // filtered against `rendered`: a sub-context is never document-
          // derived and always keeps its `nested` edge to the field anchor, so
          // the hiding pass cannot reach it.
          ...subContexts.map((sub) => ({
            id: sub.id,
            name: sub.name,
            type: 'FieldContext' as VisibleEntity['type'],
            source: 'bloom' as const,
          })),
        ]
      }
      if (inSpace) {
        return fieldContexts.map((f) => ({
          id: f.id,
          name: f.name,
          type: 'FieldContext',
          source: 'bloom' as const,
        }))
      }
      return spaces.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        source: 'bloom' as const,
      }))
    })()
    publishVisibleEntities('bloom', bloomEntities)
  }, [
    overlay,
    inField,
    nodes,
    pulses,
    persons,
    subContexts,
    inSpace,
    fieldContexts,
    spaces,
    publishVisibleEntities,
  ])

  const handleNodeClick = useCallback(
    (node: Node) => {
      const id = String(node.id)
      const label = typeof node.caption === 'string' ? node.caption : undefined
      // Overlay nodes carry their Neo4j labels through from the cypher
      // generator (NVLNode.labels). If we can map the primary label to
      // an InfoEntityType, open the unified drawer just like a default
      // Bloom node click. If not (e.g. `Community` anchor, or any label
      // that's not in our entity vocabulary), fall back to the inline
      // minimal panel — strictly safer than dispatching the drawer with
      // a guessed type.
      if (overlay) {
        // Three-tier resolution (labels → id prefix → color) lives in
        // `resolveOverlayEntityType`. Color works for legacy bare-UUID
        // Persons + WeSpaces that arrived through chat overlays before the
        // labels-on-NVLNode patch landed, so a chat user clicking an old
        // node still gets the unified drawer instead of the minimal inline
        // panel.
        const drawerType = resolveOverlayEntityType(overlay, id)
        if (drawerType) {
          dispatchOpenInfoDrawer({ type: drawerType, id, label })
          return
        }
        setSelectedNode(node)
        return
      }

      if (inField) {
        const pulse = pulses.find((p) => p.id === id)
        if (pulse) {
          setFocalEntity({
            type: pulse.focalType,
            id: pulse.id,
            focusedAt: new Date().toISOString(),
            source: 'manual',
          })
          dispatchOpenInfoDrawer({ type: 'Pulse', id: pulse.id, label })
          return
        }
        const person = persons.find((p) => p.id === id)
        if (person) {
          setFocalEntity({
            type: person.focalType,
            id: person.id,
            focusedAt: new Date().toISOString(),
            source: 'manual',
          })
          dispatchOpenInfoDrawer({ type: 'Person', id: person.id, label })
          return
        }
        // PromiseWeave hub — open the read-only weave drawer. Not a focal
        // entity type (drill-into-weave is a later slice), so no setFocalEntity.
        const weave = weaves.find((w) => w.id === id)
        if (weave) {
          dispatchOpenInfoDrawer({ type: 'PromiseWeave', id: weave.id, label })
          return
        }
        // Document provenance hub (GOAL-346). Matched against the rendered
        // nodes rather than an id prefix, so only a document actually ON the
        // canvas can open — the provenance layer is built regardless of the
        // toggle now, so matching against IT would resolve a document the
        // canvas is not currently showing. The drawer this opens carries the
        // document's extracted people and the promote action, which makes the
        // canvas a way into that flow rather than a dead end. Not a focal
        // entity type, so no setFocalEntity — same treatment as a weave hub.
        if (
          documentProvenance.nodes.some((n) => n.id === id) &&
          nodes.some((n) => n.id === id)
        ) {
          dispatchOpenInfoDrawer({ type: 'Document', id, label })
          return
        }
        // Nested field bubble — open the FieldContext drawer (rename lives
        // behind its Edit CTA), same treatment as an in-space field node.
        const sub = subContexts.find((sc) => sc.id === id)
        if (sub) {
          setFocalEntity({
            type: 'FieldContext',
            id: sub.id,
            focusedAt: new Date().toISOString(),
            source: 'manual',
          })
          dispatchOpenInfoDrawer({ type: 'FieldContext', id: sub.id, label })
          return
        }
        // The field anchor is the field the canvas is already scoped to —
        // no focal change, just its drawer.
        if (fieldAnchor && id === fieldAnchor.id) {
          dispatchOpenInfoDrawer({ type: 'FieldContext', id, label })
        }
        return
      }
      if (inSpace) {
        if (spaceAnchor && id === spaceAnchor.id) {
          setFocalEntity({
            type: spaceAnchor.kind,
            id: spaceAnchor.id,
            focusedAt: new Date().toISOString(),
            source: 'manual',
          })
          dispatchOpenInfoDrawer({
            type: spaceAnchor.kind,
            id: spaceAnchor.id,
            label,
          })
          return
        }
        const person = inSpacePeople.find((p) => p.id === id)
        if (person) {
          dispatchOpenInfoDrawer({ type: 'Person', id: person.id, label })
          return
        }
        const ctx = fieldContexts.find((f) => f.id === id)
        if (ctx) {
          setFocalEntity({
            type: 'FieldContext',
            id: ctx.id,
            focusedAt: new Date().toISOString(),
            source: 'manual',
          })
          dispatchOpenInfoDrawer({
            type: 'FieldContext',
            id: ctx.id,
            label,
          })
        }
        return
      }
      // Root scope. The "You" hub opens the current user's Person drawer.
      if (currentUserId && id === currentUserId) {
        dispatchOpenInfoDrawer({ type: 'Person', id: currentUserId, label })
        return
      }
      const space = spaces.find((s) => s.id === id)
      if (space) {
        setFocalEntity({
          type: space.type,
          id: space.id,
          focusedAt: new Date().toISOString(),
          source: 'manual',
        })
        dispatchOpenInfoDrawer({ type: space.type, id: space.id, label })
      }
    },
    [
      overlay,
      inField,
      nodes,
      pulses,
      persons,
      weaves,
      documentProvenance,
      subContexts,
      fieldAnchor,
      inSpace,
      spaceAnchor,
      inSpacePeople,
      currentUserId,
      fieldContexts,
      spaces,
      setFocalEntity,
    ]
  )

  // A single click drills *into* the entity by changing the route, which
  // re-scopes the canvas (scope is derived strictly from the pathname via
  // focalEntityFromRoute): a top-level space → its field contexts, an
  // in-space field → its pulses. These are the same dashboard routes the
  // drawer's "Open full page" CTA uses, so the studio canvas stays mounted
  // and re-scopes inward. A click on an overlay (chat custom-view) node that
  // resolves to a Space/FieldContext drills the same way (and clears the
  // overlay); pulses and people have no page route, so a click on them falls
  // back to opening the drawer. We close any drawer left open (e.g. from a
  // prior double-click) before navigating so it doesn't linger over the
  // freshly drilled-in scope.
  const handleNodeNavigate = useCallback(
    (node: Node) => {
      const id = String(node.id)
      // A chat-driven custom view is a *starting point* for exploration, not
      // a dead end. When a click lands on an overlay node that resolves to a
      // navigable entity (a Space or a FieldContext), drill into its dashboard
      // route — the same routes the default Bloom cluster and the drawer's
      // "Open full page" CTA use — and clear the overlay so the user lands in
      // the consistent default navigation canvas rather than staying trapped
      // in the frozen subgraph. Nodes with no page route (pulses, people,
      // resonance links, documents) keep drawer-on-click. Resolution mirrors
      // handleNodeClick's three tiers: labels → id prefix → color.
      if (overlay) {
        const entityType = resolveOverlayEntityType(overlay, id)
        if (entityType === 'FieldContext') {
          dispatchCloseInfoDrawer()
          clearOverlay()
          router.push(`/protected/dashboard/field-context/${id}`)
          return
        }
        if (entityType === 'MeSpace' || entityType === 'WeSpace') {
          dispatchCloseInfoDrawer()
          clearOverlay()
          router.push(`/protected/dashboard/space/${id}`)
          return
        }
        handleNodeClick(node)
        return
      }
      if (inField) {
        // A nested field is a navigable entity — a single click drills into
        // it, same as an in-space field click (GOAL-339). Everything else
        // in-field keeps drawer-on-click.
        const sub = subContexts.find((sc) => sc.id === id)
        if (sub) {
          dispatchCloseInfoDrawer()
          router.push(`/protected/dashboard/field-context/${sub.id}`)
          return
        }
        handleNodeClick(node)
        return
      }
      if (inSpace) {
        const ctx = fieldContexts.find((f) => f.id === id)
        if (ctx) {
          dispatchCloseInfoDrawer()
          router.push(`/protected/dashboard/field-context/${ctx.id}`)
          return
        }
        // Space anchor / person spoke — no drill route, open the drawer.
        handleNodeClick(node)
        return
      }
      const space = spaces.find((s) => s.id === id)
      if (space) {
        dispatchCloseInfoDrawer()
        router.push(`/protected/dashboard/space/${space.id}`)
        return
      }
      // Root "You" hub — no drill route, open the drawer.
      handleNodeClick(node)
    },
    [
      overlay,
      inField,
      subContexts,
      inSpace,
      fieldContexts,
      spaces,
      router,
      handleNodeClick,
      clearOverlay,
    ]
  )

  // First click schedules a drill; if a second click lands before it fires,
  // that's a double-click → cancel the drill and open the drawer instead.
  const handleSingleClick = useCallback(
    (node: Node) => {
      if (clickTimerRef.current !== null) {
        // Second click of a double-click — drill is still pending, swap to
        // the drawer.
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
        handleNodeClick(node)
        return
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null
        handleNodeNavigate(node)
      }, SINGLE_CLICK_DELAY)
    },
    [handleNodeClick, handleNodeNavigate]
  )

  // Fallback for NVL builds that surface `onNodeDoubleClick` without a second
  // `onNodeClick`: cancel the pending drill and open the drawer. If the drill
  // was already cancelled by the second click above, the drawer is already
  // open — re-dispatching the same entity is idempotent and harmless.
  const handleDoubleClick = useCallback(
    (node: Node) => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      handleNodeClick(node)
    },
    [handleNodeClick]
  )

  // Cancel a pending drill if the view unmounts mid-debounce so we never
  // router.push after teardown.
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current)
      }
    }
  }, [])

  // Clicking a relationship opens its inspection drawer. Two edge kinds are
  // addressable:
  //   - `connected-*`  → the interpersonal CONNECTED_TO Connection drawer
  //                       (replaces the legacy ConnectionPanel). The edge id
  //                       encodes both person ids; we re-sort them into the
  //                       composite key the drawer expects.
  //   - `resonance-*`  → the ResonanceLink drawer, keyed by the suffix id.
  // Structural edges (owns/member/has/initiated/weaves) have no inspection
  // target, so they stay inert.
  const handleRelationshipClick = useCallback((rel: Relationship) => {
    const id = String(rel.id ?? '')
    const from = String(rel.from ?? '')
    const to = String(rel.to ?? '')
    if (id.startsWith('connected-') && from && to) {
      dispatchOpenInfoDrawer({
        type: 'Connection',
        id: [from, to].sort().join('__'),
      })
      return
    }
    if (id.startsWith('resonance-')) {
      const resonanceId = id.slice('resonance-'.length)
      if (resonanceId) {
        dispatchOpenInfoDrawer({ type: 'ResonanceLink', id: resonanceId })
      }
    }
  }, [])

  const mouseEventCallbacks: MouseEventCallbacks = useMemo(
    () => ({
      onNodeClick: (node) => handleSingleClick(node),
      onNodeDoubleClick: (node) => handleDoubleClick(node),
      onRelationshipClick: (rel) => handleRelationshipClick(rel),
      onCanvasClick: () => setSelectedNode(null),
      onHover: (_element, hitTargets: HitTargets) => {
        const hoveringNode = hitTargets.nodes.length > 0
        if (hoveringNode === isHoveringNodeRef.current) return
        isHoveringNodeRef.current = hoveringNode
        const wrapper = canvasWrapperRef.current
        if (wrapper) wrapper.style.cursor = hoveringNode ? 'pointer' : ''
      },
      onDrag: true,
      onPan: true,
      onZoom: true,
    }),
    [handleSingleClick, handleDoubleClick, handleRelationshipClick]
  )

  // Bloom is a force-directed exploration surface. The pre-computed (x, y)
  // values on each node act as seed positions for NVL's force simulation —
  // it settles from there rather than starting cold, which keeps the
  // post-mount `fit()` from landing on whitespace.
  // `layoutOptions` is what actually drives the force simulation. Without
  // these tuned values NVL's defaults produce a degenerate layout (nodes
  // all collapsed near the gravity center) — that's why on first load you
  // only saw one node and had to nudge to "wake up" the sim. These match
  // the proven settings in `src/components/canvas/nvl-canvas.tsx:124-136`.
  const nvlOptions = useMemo(
    () => ({
      layout: 'forceDirected',
      initialZoom: 0.7,
      // NVL's real clamp keys are minZoom/maxZoom — minScale/maxScale are
      // silently ignored, leaving the permissive 0.075–10 defaults in force.
      minZoom: 0.2,
      maxZoom: 3,
      layoutOptions: {
        simulationIterations: 400,
        gravity: 25,
        linkDistance: 1,
        charge: 0,
        linkStrength: 1.0,
      },
    }),
    []
  )

  // Scope key identifies "which cluster is currently being rendered":
  //   - overlay generation (assistant-pushed subgraph)
  //   - activeSpaceId (top-level vs in-space)
  // Both side-panel selection and the auto-fit need to react when the
  // scope flips. The side-panel clear uses the "compare against previous
  // state during render" pattern (matches FocalEntityContext) to avoid
  // cascading renders. The fit uses a per-scope ref so it only fires
  // once per (scope, nodes-ready) pair without a setState round-trip.
  const scopeKey = `${overlay?.generation ?? 'none'}|${
    activeFieldId
      ? `field:${activeFieldId}`
      : activeSpaceId
        ? `space:${activeSpaceId}`
        : 'root'
  }`
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey)
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey)
    setSelectedNode(null)
  }

  // A stable string for the current filter state. Only the layout-restart key
  // below consumes it — the fit is deliberately NOT re-keyed on it, so
  // toggling a type re-settles the simulation without yanking the viewer's
  // pan and zoom back to a full-graph fit.
  const filterSignature = useMemo(
    () => [...typeFilters.hidden].sort().join(','),
    [typeFilters.hidden]
  )

  // Fit once per scope. The force simulation calls `onLayoutDone` when it
  // settles — that's when fit() lands on real positions instead of
  // whitespace. A long fallback timeout covers the edge case where the
  // callback never fires (e.g. single-node scope with no simulation).
  const lastFitScopeRef = useRef<string | null>(null)
  const isInitialLayoutRef = useRef(true)
  useEffect(() => {
    isInitialLayoutRef.current = true
  }, [scopeKey])

  // Kick the force simulation whenever the scope's node set is first
  // populated. Without this, NVL's force layout can stay quiescent on a
  // cold mount and the canvas shows a single overlapping cluster until
  // the user drags a node — `restart()` is what that drag implicitly does.
  const lastKickedScopeRef = useRef<string | null>(null)
  useEffect(() => {
    // Key on the node count as well as the scope: a node arriving in the
    // SAME scope (e.g. a nested field created from the action bar landing
    // via the background refetch) must also wake the simulation, or the
    // new bubble sits wherever NVL dropped it without settling (GOAL-339).
    //
    // The filter signature is part of the key too (GOAL-350). Count alone
    // collides: hide a 2-node type, hide another 2-node type, switch the first
    // back on, and the count returns to a value already kicked — so the
    // re-added nodes would never get their simulation pass and would sit
    // stacked wherever NVL dropped them.
    const kickKey = `${scopeKey}|${nodes.length}|${filterSignature}`
    if (lastKickedScopeRef.current === kickKey) return
    if (nodes.length === 0) return
    const ref = nvlRef.current
    if (!ref || typeof ref.restart !== 'function') return
    lastKickedScopeRef.current = kickKey
    // A short delay lets the NVL wrapper finish wiring up the new nodes
    // (`addAndUpdateElementsInGraph` happens in a separate effect) before
    // we restart the simulation against them. We retry with a longer
    // delay on failure because the first `restart()` can throw on a cold
    // mount when the NVL instance is wired up but the simulation context
    // isn't ready yet — the symptom is a chip showing "Custom view from
    // chat" with a completely empty canvas because nodes never get a
    // position. Logging the warning lets us tell that case apart from
    // a torn-down-instance race during fast nav.
    const timers: number[] = []
    const tryRestart = (attempt: number) => {
      try {
        nvlRef.current?.restart?.()
      } catch (err) {
        console.warn(
          `[bloom-view] NVL restart() failed (attempt ${attempt})`,
          err instanceof Error ? err.message : err
        )
        if (attempt < 2) {
          timers.push(window.setTimeout(() => tryRestart(attempt + 1), 400))
        }
      }
    }
    timers.push(window.setTimeout(() => tryRestart(1), 50))
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [nodes, scopeKey, filterSignature])

  const fitToScope = useCallback(() => {
    if (lastFitScopeRef.current === scopeKey) return
    const ref = nvlRef.current
    if (!ref) return
    lastFitScopeRef.current = scopeKey
    isInitialLayoutRef.current = false
    if (nodes.length === 0) return
    if (nodes.length === 1) {
      ref.setZoom?.(1)
      return
    }
    if (typeof ref.fit !== 'function') return
    ref.fit(
      nodes.map((n) => n.id),
      { animated: false, maxZoom: 1.4 }
    )
  }, [nodes, scopeKey])

  useEffect(() => {
    if (nodes.length === 0) return
    const fallback = window.setTimeout(() => {
      if (!isInitialLayoutRef.current) return
      fitToScope()
    }, 2500)
    return () => window.clearTimeout(fallback)
  }, [nodes, scopeKey, fitToScope])

  const nvlCallbacks: Partial<ExternalCallbacks> = useMemo(
    () => ({
      onLayoutDone: () => {
        if (!isInitialLayoutRef.current) return
        fitToScope()
      },
    }),
    [fitToScope]
  )

  // Touch gestures for iPad/phone: two-finger pinch-to-zoom and one-finger
  // pan on empty canvas. The floating action bar's zoom buttons cover
  // desktop/click; NVL ignores touch pinches and single-finger pans on its
  // own, so this hook bridges them into the same setZoom()/setPan() the mouse
  // path uses. The returned callback ref attaches to the canvas wrapper (which
  // is rendered conditionally once data loads — a callback ref binds the
  // listeners the moment that element mounts).
  const touchSurfaceRef = useNvlTouchGestures({ nvlRef })

  // Listen for zoom commands from the floating canvas action bar
  // (`goalpost:graph-zoom-*` events).
  useEffect(() => {
    const adjust = (factor: number) => {
      const ref = nvlRef.current
      if (!ref || typeof ref.getScale !== 'function') return
      const current = ref.getScale()
      if (typeof current === 'number') ref.setZoom?.(current * factor)
    }
    const fit = () => {
      const ref = nvlRef.current
      if (
        !ref ||
        typeof ref.getNodes !== 'function' ||
        typeof ref.fit !== 'function'
      )
        return
      const allNodes = ref.getNodes()
      const ids = allNodes.map((n) => n.id)
      if (ids.length <= 1) {
        ref.setZoom?.(1)
        return
      }
      ref.fit(ids, { animated: true, maxZoom: 1.4 })
    }
    const onIn = () => adjust(1.2)
    const onOut = () => adjust(0.8)
    const onFit = () => fit()
    window.addEventListener('goalpost:graph-zoom-in', onIn)
    window.addEventListener('goalpost:graph-zoom-out', onOut)
    window.addEventListener('goalpost:graph-zoom-fit', onFit)
    return () => {
      window.removeEventListener('goalpost:graph-zoom-in', onIn)
      window.removeEventListener('goalpost:graph-zoom-out', onOut)
      window.removeEventListener('goalpost:graph-zoom-fit', onFit)
    }
  }, [])

  // Deliberately read off the SOURCE records, never off the painted `nodes`:
  // a canvas emptied by the type filter is not an empty field, and telling a
  // member "this field has no pulses yet" because they switched Goal off would
  // be the canvas lying about what is there.
  const isEmpty =
    !overlay &&
    !loading &&
    (inField
      ? // "There is nothing to build a canvas from", read off the BUILT graph
        // rather than the painted one. The old form counted pulses and weaves
        // only, so a field carrying just people and documents replaced its
        // canvas with "no pulses yet"; reading the painted `nodes` instead
        // would swing the other way and say the same thing about a field whose
        // types are merely switched off — that case is `isFilteredToNothing`.
        builtCanvas.nodes.length === 0
      : inSpace
        ? fieldContexts.length === 0
        : spaces.length === 0)

  // The other half of that: there IS something to draw, but every type of it
  // is switched off. Says so plainly and offers the way back, so a filtered
  // canvas can never be mistaken for missing data — or for a permission
  // boundary, which it is not (kb/02-user-roles.md).
  const isFilteredToNothing =
    !isEmpty && builtCanvas.nodes.length > 0 && nodes.length === 0

  return (
    <div className="relative w-full h-full bg-gp-surface dark:bg-gp-surface-dark flex">
      {/* Themed canvas backdrop. NVL renders on a transparent canvas, so this
          is what the graph floats over. Built from `gp-*` tokens via
          color-mix so it re-tints with light/dark AND with every theme
          variant — it used to be a hardcoded slate-950 gradient, which is why
          Bloom stayed night-dark while the rest of the app was in light mode.
          Absolutely positioned, so it takes no part in the flex row. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 gp-dot-grid opacity-40 dark:opacity-20"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            radial-gradient(at 18% 20%, color-mix(in srgb, var(--gp-primary) 10%, transparent) 0, transparent 55%),
            radial-gradient(at 82% 16%, color-mix(in srgb, var(--gp-accent-glow) 10%, transparent) 0, transparent 55%),
            radial-gradient(at 78% 84%, color-mix(in srgb, var(--gp-goal) 9%, transparent) 0, transparent 55%),
            radial-gradient(at 16% 86%, color-mix(in srgb, var(--gp-resource) 10%, transparent) 0, transparent 55%)
          `,
        }}
      />

      <div ref={canvasWrapperRef} className="flex-1 relative">
        {!overlay && loading && builtCanvas.nodes.length === 0 ? (
          <GraphLoadingState
            label="Bloom is gathering"
            subtitle={
              inField
                ? 'A live canvas of this field’s pulses.'
                : inSpace
                  ? 'A live canvas of this space’s field contexts.'
                  : 'A live canvas of your spaces.'
            }
          />
        ) : isEmpty ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
            <span className="material-symbols-outlined text-5xl text-gp-ink-soft/70 mb-3">
              {inField ? 'graphic_eq' : inSpace ? 'category' : 'hub'}
            </span>
            <p className="text-sm text-gp-ink-muted max-w-md">
              {inField
                  ? 'This field has no pulses yet. Add one from the dashboard view and it will appear here on the canvas.'
                  : inSpace
                    ? 'This space has no field contexts yet. Create one from the dashboard view and it will appear here on the canvas.'
                    : 'Nothing to render yet. Create a MeSpace or WeSpace from the dashboard and they will appear here on the canvas.'}
            </p>
          </div>
        ) : (
          // touch-action:none lets the touch-gesture handler claim pinch and
          // single-finger pan before the browser turns them into a native page
          // zoom/scroll; NVL drives pan/drag/zoom in JS so disabling native
          // touch scrolling here is correct.
          <div
            ref={touchSurfaceRef}
            className="absolute inset-0"
            style={{ touchAction: 'none' }}
          >
            <GraphVisualizer
              ref={nvlRef}
              nodes={nodes}
              relationships={relationships}
              mouseEventCallbacks={mouseEventCallbacks}
              nvlOptions={nvlOptions}
              nvlCallbacks={nvlCallbacks}
            />
          </div>
        )}

        {isFilteredToNothing && (
          /* pointer-events-none on the wrapper, matching the empty state
             above: this is a full-bleed overlay, and without it the canvas
             underneath would stop taking pan, zoom and drag. Only the reset
             button takes clicks back. */
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-6 text-center">
            <span className="material-symbols-outlined mb-3 text-5xl text-gp-ink-soft/70">
              filter_alt_off
            </span>
            <p className="max-w-md text-sm text-gp-ink-muted">
              Everything on this canvas is switched off. That includes a field
              whose content all came from its documents, when the Documents row
              is off.
            </p>
            <button
              type="button"
              onClick={typeFilters.showAll}
              className="gp-glass-hover pointer-events-auto mt-4 cursor-pointer rounded-full gp-glass border border-gp-primary/40 px-4 py-2 text-xs font-semibold text-gp-primary"
            >
              Show all types
            </button>
          </div>
        )}

        {/* Decodes the bare colored NVL circles — and, since GOAL-350, switches
            each type on and off. Rows come from the UNFILTERED canvas so a type
            you hide keeps its row and its way back. */}
        <BloomLegend
          nodes={builtCanvas.nodes}
          relationships={builtCanvas.relationships}
          filters={typeFilters}
        />
      </div>

      {/* Inline panel only for overlay nodes (chat artifacts with no
          persisted entity behind them). Real node clicks open the
          unified EntityInfoDrawer mounted in CanvasHost. */}
      {selectedNode && overlay && (
        <div className="w-80 h-full bg-gp-glass-bg backdrop-blur-xl border-l border-gp-glass-border overflow-y-auto z-20 p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gp-ink-muted">
                Node
              </p>
              <h3 className="mt-1 text-xl font-bold text-gp-ink-strong">
                {selectedNode.caption}
              </h3>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="gp-menu-item shrink-0 p-1 rounded-full cursor-pointer"
              aria-label="Close details"
            >
              <span className="material-symbols-outlined text-lg leading-none">
                close
              </span>
            </button>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: selectedNode.color }}
              aria-hidden="true"
            />
            <span className="text-xs text-gp-ink-muted uppercase tracking-wider">
              From chat
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
