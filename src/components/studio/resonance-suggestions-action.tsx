'use client'

import { useEffect, useState, type FC } from 'react'
import { useFocalEntity } from '@/contexts'
import { useResonanceSuggestionCount } from '@/hooks/useResonanceSuggestionCount'
import {
  emitOpenResonanceSuggestions,
  onResonanceSuggestionsChanged,
} from '@/lib/simulation/resonance-review-events'

/**
 * Studio-shell entry into the resonance-suggestion review queue (WF-07).
 *
 * GOAL-348 added a "N Pending" button to the field-context page's Resonances
 * section, but that section only exists in the Dashboard view. In Bloom
 * Exploration the routed page is mounted-but-hidden, so a member looking at the
 * field's graph had no way to reach suggestions waiting on it. This lives in
 * the floating action bar, which renders over BOTH canvas views.
 *
 * Renders only when the focal entity is a route-sourced FieldContext whose
 * parent Space has resolved AND at least one `pending` suggestion is anchored
 * in that field — zero renders nothing at all, never a "0" chip.
 *
 * Reviewing is a read-then-decide step open to every Space role
 * (kb/02-user-roles.md), so unlike the Upload action this is deliberately NOT
 * gated on `canEditContent`; the accept/decline routes re-gate the write, and
 * the modal hides controls a GUEST can't use.
 *
 * Pressing it opens the modal the field-context page owns — it must never
 * trigger `POST /api/resonance/discover`. "Discover" stays a separate,
 * explicit action (ADR-004, WF-06).
 */
export const ResonanceSuggestionsAction: FC = () => {
  // `routeFocalEntity`, not `focalEntity`: tapping a node in Bloom sets a
  // `manual` focal, which would make this button vanish in exactly the flow it
  // exists for. The breadcrumb reads the route-only variant for the same
  // reason. Safe here because this action pins no state of its own — it only
  // ever addresses the field whose page is mounted.
  const { routeFocalEntity } = useFocalEntity()

  const fieldContextId =
    routeFocalEntity?.type === 'FieldContext' ? routeFocalEntity.id : null

  // The enclosing Space comes off the focal parent chain the field-context page
  // pushes via `setFocalParents` (space first, then the ancestor field chain).
  // The count endpoint is Space-gated, so this is required, not decorative.
  const spaceId =
    fieldContextId && routeFocalEntity?.parents
      ? (routeFocalEntity.parents.find(
          (parent) => parent.type === 'MeSpace' || parent.type === 'WeSpace'
        )?.id ?? null)
      : null

  // A second, independent count fetch alongside the page's own (the route is a
  // count-only query with `Cache-Control: no-store`, so there is no shared
  // cache to read like `useFieldContextCanEditContent` gets from Apollo). Kept
  // independent on purpose: this button must render correctly whichever canvas
  // view is up, without depending on the hidden page having published state.
  // Empty ids no-op inside the hook and resolve to 0.
  const { count } = useResonanceSuggestionCount({
    spaceId: spaceId ?? '',
    // Never let a blank id widen this to the whole Space — the number has to be
    // this field's, matching the in-page badge.
    contextId: fieldContextId ?? undefined,
    status: 'pending',
  })

  // The page owns every accept / decline / sweep, so it is the only thing that
  // knows the queue moved. Without this the bar's number would go stale the
  // moment a member reviewed anything.
  //
  // It sends the number it just fetched, so this ADOPTS rather than re-fetches:
  // the modal refreshes after every single accept / decline, and a second count
  // request per reviewed card would double an already-heavy review loop. Keyed
  // by scope so a change announced for another field can never paint this one.
  const scopeKey =
    spaceId && fieldContextId ? `${spaceId}::${fieldContextId}` : null
  const [adopted, setAdopted] = useState<{ key: string; count: number } | null>(
    null
  )
  useEffect(
    () =>
      onResonanceSuggestionsChanged((detail) => {
        const key = `${detail.spaceId}::${detail.fieldContextId}`
        setAdopted({ key, count: detail.pendingCount })
      }),
    []
  )

  const pendingCount =
    adopted && scopeKey && adopted.key === scopeKey ? adopted.count : count

  if (!fieldContextId || !spaceId || pendingCount < 1) return null

  return (
    <button
      type="button"
      onClick={() => emitOpenResonanceSuggestions(fieldContextId)}
      // The NUMBER is this field's; the modal it opens is the Space's whole
      // review queue (the list endpoint takes no per-field filter). Say both,
      // matching the in-page affordance's wording.
      data-testid="review-suggestions-action-bar"
      aria-label={`Review resonance suggestions — ${pendingCount} pending in this field, opens this space's review queue`}
      title={`${pendingCount} AI ${pendingCount === 1 ? 'suggestion is' : 'suggestions are'} waiting in this field. Opens this space's review queue — unlike Discover, it runs no new search.`}
      className="gp-glass-hover cursor-pointer flex items-center gap-1.5 md:gap-2 pl-2.5 pr-2 md:pl-4 md:pr-3 h-10 md:h-11 rounded-full gp-glass border border-gp-glass-border hover:border-gp-primary/40 hover:shadow-[0_0_50px_color-mix(in_srgb,var(--gp-primary)_35%,transparent)] transition-all group"
    >
      {/* A fixed hue pair, not `text-gp-primary`, for the same reason the
          sibling actions use amber-600/amber-300 and teal-600/teal-300: the
          themed primary reaches warm's #ffc233, which is ~1.8:1 on light glass.
          Blue keeps this legible in every theme and reads as review/info
          against those two create actions. */}
      <span
        className="material-symbols-outlined text-[20px] leading-none text-blue-600 dark:text-blue-300"
        aria-hidden="true"
      >
        rate_review
      </span>
      <span className="hidden sm:inline text-sm font-semibold text-gp-ink-strong">
        Suggestions
      </span>
      {/* A primary TINT with ink-strong numerals, not white-on-primary: the
          themed `--gp-primary` ranges from #137fec to warm's #ffc233, so white
          at 11px bold falls under 2:1 there. Ink-strong is the AA text token on
          this glass in every theme, both modes. */}
      <span
        className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-gp-ink-strong text-[11px] font-bold leading-none bg-[color-mix(in_srgb,var(--gp-primary)_22%,transparent)]"
        aria-hidden="true"
      >
        {pendingCount}
      </span>
    </button>
  )
}
