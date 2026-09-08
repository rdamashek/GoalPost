'use client'

/**
 * Cross-component bus for the resonance-suggestion REVIEW step (WF-07).
 *
 * GOAL-348 surfaced the pending count inside the field-context page's
 * Resonances section — which is only reachable in the Dashboard view. In Bloom
 * Exploration the routed page is still mounted but hidden, so that affordance
 * is invisible exactly where a member is most likely to be looking at the
 * field's connections. The studio-shell action bar (visible in BOTH canvas
 * views) therefore carries its own review button, and needs a way to ask the
 * page — which owns `ResonanceSuggestionsModal` and all of its accept/decline
 * wiring — to open it.
 *
 * Same primitive and same reasoning as [pulse-creation-events.ts]: window
 * events keep the action bar decoupled from each page's modal-state shape.
 *
 * Open subscribers:
 *   - /protected/dashboard/field-context/[id]/page.tsx
 *
 * Changed producers:
 *   - the same page, after a discovery sweep or any accept / decline, so the
 *     action bar's independently-fetched count stays honest.
 *
 * Opening the modal must NEVER imply a discovery sweep — `discoverResonances`
 * stays a separate, explicit action (ADR-004, WF-06).
 */

const OPEN_RESONANCE_SUGGESTIONS_EVENT =
  'gp:open-resonance-suggestions-modal' as const
const RESONANCE_SUGGESTIONS_CHANGED_EVENT =
  'gp:resonance-suggestions-changed' as const

export interface OpenResonanceSuggestionsDetail {
  /** FieldContext.id the caller expects to review from. */
  fieldContextId: string
}

/** Emit a request to open the suggestions review modal for `fieldContextId`. */
export function emitOpenResonanceSuggestions(fieldContextId: string): void {
  if (typeof window === 'undefined') return
  if (!fieldContextId) return
  window.dispatchEvent(
    new CustomEvent<OpenResonanceSuggestionsDetail>(
      OPEN_RESONANCE_SUGGESTIONS_EVENT,
      { detail: { fieldContextId } }
    )
  )
}

/** Subscribe to review-modal open requests. Returns an unsubscribe function. */
export function onOpenResonanceSuggestions(
  handler: (detail: OpenResonanceSuggestionsDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => {}
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<OpenResonanceSuggestionsDetail>).detail
    if (!detail || typeof detail.fieldContextId !== 'string') return
    handler(detail)
  }
  window.addEventListener(OPEN_RESONANCE_SUGGESTIONS_EVENT, wrapped)
  return () =>
    window.removeEventListener(OPEN_RESONANCE_SUGGESTIONS_EVENT, wrapped)
}

export interface ResonanceSuggestionsChangedDetail {
  /** FieldContext the emitter's count is scoped to. */
  fieldContextId: string
  /** That field's owning Space. */
  spaceId: string
  /**
   * The emitter's freshly-fetched `pending` count for that pair. Listeners
   * scoped to the same field adopt it instead of issuing their own request —
   * the modal fires a refresh after EVERY accept / decline, so a listener that
   * re-fetched each time would double the count queries per reviewed card.
   * Listeners scoped elsewhere must ignore it and re-fetch: it is one field's
   * number, not theirs.
   */
  pendingCount: number
}

/**
 * Announce that the set of `pending` ResonanceSuggestions changed — a sweep
 * minted new ones, or a member confirmed / rejected some.
 *
 * Scoped like the open event above rather than broadcast bare: a Space-level
 * review surface would otherwise make every mounted counter refetch on any
 * field's change.
 */
export function emitResonanceSuggestionsChanged(
  detail: ResonanceSuggestionsChangedDetail
): void {
  if (typeof window === 'undefined') return
  if (!detail?.fieldContextId || !detail?.spaceId) return
  window.dispatchEvent(
    new CustomEvent<ResonanceSuggestionsChangedDetail>(
      RESONANCE_SUGGESTIONS_CHANGED_EVENT,
      { detail }
    )
  )
}

/** Subscribe to suggestion-set change notifications. Returns an unsubscribe. */
export function onResonanceSuggestionsChanged(
  handler: (detail: ResonanceSuggestionsChangedDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => {}
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<ResonanceSuggestionsChangedDetail>)
      .detail
    if (!detail || typeof detail.fieldContextId !== 'string') return
    handler(detail)
  }
  window.addEventListener(RESONANCE_SUGGESTIONS_CHANGED_EVENT, wrapped)
  return () =>
    window.removeEventListener(RESONANCE_SUGGESTIONS_CHANGED_EVENT, wrapped)
}
