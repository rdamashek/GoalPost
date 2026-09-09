'use client'

import { SectionHeader } from '@/components/persons/section-header'
import { ProfileCard } from '@/components/persons/profile-card'
import { formatResonanceLabel } from '@/utils/graph-utils'
import { cn } from '@/lib/utils'
import { EmptySection, getPulseTypeLabel } from './field-section-primitives'

type ResonancePulseRecord = {
  __typename: string
  id: string
  title: string
  content: string
  createdAt: string
}

export type ResonanceRecord = {
  id: string
  label: string
  description?: string | null
  confidence?: number | null
  evidence?: string | null
  createdAt: string
  source?: ResonancePulseRecord[] | null
  target?: ResonancePulseRecord[] | null
}

type ResonancesSectionProps = {
  resonances: ResonanceRecord[]
  /** Pulse count in this field — manual linking needs at least two. */
  pulseCount: number
  onAddResonance: () => void
  onResonanceClick: (resonanceId: string) => void
  /** AI resonance discovery entry. Scans the parent Space's pulses (WF-06) and
   *  opens the suggestions review modal on success. Omit to hide the
   *  affordance (e.g. viewers, or surfaces without a resolved Space). */
  onDiscoverResonances?: () => void
  /** True while a discovery run is in flight — disables the Discover button and
   *  swaps its icon for a spinner. */
  isDiscoveringResonances?: boolean
  /** GOAL-348: how many `pending` ResonanceSuggestions are anchored in THIS
   *  field and waiting for human review (WF-07). Zero renders no affordance at
   *  all — never a "0" chip. */
  pendingSuggestionCount?: number
  /** Opens the suggestions review modal directly, WITHOUT running a discovery
   *  sweep. Any Space role may review-read, so this is not gated on edit
   *  permission the way `onDiscoverResonances` is. Omit to hide. */
  onReviewSuggestions?: () => void
}

function getResonanceEndpointLabel(pulse?: ResonancePulseRecord): string {
  if (!pulse) return 'Unknown pulse'
  return `${getPulseTypeLabel(pulse.__typename)}: ${pulse.title}`
}

/**
 * The Resonances block of a FieldContext page: confirmed ResonanceLinks, the
 * manual "Link Pulses" entry, the Space-wide "Discover" sweep, and — since
 * GOAL-348 — a passive count of the `pending` ResonanceSuggestions already
 * waiting for review in this field.
 *
 * Split out of `field-context-sections.tsx` to keep both files under the
 * 400-line component ceiling (CLAUDE.md).
 */
export function ResonancesSection({
  resonances,
  pulseCount,
  onAddResonance,
  onResonanceClick,
  onDiscoverResonances,
  isDiscoveringResonances = false,
  pendingSuggestionCount = 0,
  onReviewSuggestions,
}: ResonancesSectionProps) {
  return (
    <div className="flex flex-col gap-4 md:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader icon="hub" title="Resonances" />
        <div className="flex items-center gap-1.5 shrink-0">
          {onReviewSuggestions && pendingSuggestionCount > 0 ? (
            <button
              data-testid="review-suggestions"
              onClick={() => onReviewSuggestions()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gp-primary hover:bg-gp-primary/90 text-white transition-colors text-xs font-semibold cursor-pointer"
              // The NUMBER is this field's; the modal it opens is the Space's
              // whole review queue (the list endpoint takes no per-field
              // filter). Say both rather than promising a field-scoped list we
              // don't deliver — a screen-reader user gets no second cue.
              aria-label={`Review resonance suggestions — ${pendingSuggestionCount} pending in this field, opens this space's review queue`}
              title={`${pendingSuggestionCount} AI ${pendingSuggestionCount === 1 ? 'suggestion is' : 'suggestions are'} waiting in this field. Opens this space's review queue — unlike Discover, it runs no new search.`}
            >
              <span className="material-symbols-outlined text-sm">
                rate_review
              </span>
              <span>{pendingSuggestionCount}</span>
              <span className="hidden sm:inline">Pending</span>
            </button>
          ) : null}
          {onDiscoverResonances ? (
            <button
              onClick={() => onDiscoverResonances()}
              disabled={isDiscoveringResonances}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gp-accent-glow/40 bg-gp-accent-glow/10 hover:bg-gp-accent-glow/20 text-gp-ink-strong dark:text-white transition-colors text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gp-accent-glow/10 cursor-pointer"
              aria-label="Discover resonances"
              // Discovery scans the whole parent Space's pulses (WF-06), so it
              // isn't gated on this field's pulse count the way manual linking
              // is — a field with few pulses can still surface cross-field
              // resonances in the same Space.
              title="Let AI suggest resonances across this space"
            >
              <span
                className={cn(
                  'material-symbols-outlined text-sm',
                  isDiscoveringResonances && 'animate-spin'
                )}
              >
                {isDiscoveringResonances ? 'progress_activity' : 'auto_awesome'}
              </span>
              <span className="hidden sm:inline">
                {isDiscoveringResonances ? 'Discovering…' : 'Discover'}
              </span>
            </button>
          ) : null}
          <button
            onClick={() => onAddResonance()}
            disabled={pulseCount < 2}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gp-primary/30 bg-gp-primary/10 hover:bg-gp-primary/20 text-gp-primary dark:border-gp-primary/40 dark:bg-gp-primary/20 dark:hover:bg-gp-primary/30 transition-colors text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gp-primary/10 cursor-pointer"
            aria-label={
              pulseCount < 2 ? 'Add at least 2 pulses to link' : 'Link pulses'
            }
            title={
              pulseCount < 2
                ? 'Add at least 2 pulses to create a resonance link'
                : ''
            }
          >
            <span className="material-symbols-outlined text-sm">add</span>
            <span className="hidden sm:inline">Link Pulses</span>
          </button>
        </div>
      </div>
      {resonances.length === 0 ? (
        <EmptySection
          icon="hub"
          title="No resonances yet"
          body={
            // GOAL-348: "let the assistant suggest some" is wrong copy on a
            // field that already has suggestions waiting — say so and point at
            // the review step instead of implying another sweep is needed. The
            // count is this field's; the queue it opens is the whole Space's,
            // so the CTA deliberately carries no number.
            onReviewSuggestions && pendingSuggestionCount > 0
              ? `${pendingSuggestionCount} AI ${pendingSuggestionCount === 1 ? 'suggestion is' : 'suggestions are'} waiting for review in this field. Confirm the ones that ring true and they'll appear here.`
              : pulseCount < 2
                ? 'Resonances connect two pulses — add at least two pulses, then link the ones that resonate.'
                : 'Resonances surface meaningful connections between pulses. Link two that go together, or let the assistant suggest some.'
          }
          cta={
            onReviewSuggestions && pendingSuggestionCount > 0
              ? {
                  label: 'Review suggestions',
                  icon: 'rate_review',
                  onClick: onReviewSuggestions,
                }
              : pulseCount >= 2
                ? {
                    label: 'Link pulses',
                    icon: 'add',
                    onClick: onAddResonance,
                  }
                : undefined
          }
        />
      ) : (
        <ProfileCard>
          <div className="space-y-3">
            {resonances.map((resonance, idx) => {
              const source = resonance.source?.[0]
              const target = resonance.target?.[0]

              return (
                <div
                  key={resonance.id}
                  onClick={() => onResonanceClick(resonance.id)}
                  className={
                    idx > 0
                      ? 'border-t border-gp-glass-border pt-3 cursor-pointer hover:bg-gp-glass-bg/50 dark:hover:bg-white/5 transition-colors rounded px-2 -mx-2'
                      : 'cursor-pointer hover:bg-gp-glass-bg/50 dark:hover:bg-white/5 transition-colors rounded px-2 -mx-2'
                  }
                >
                  <div className="flex justify-between items-start gap-4 mb-1">
                    <div className="flex-1 min-w-0 space-y-1">
                      <span className="text-[9px] uppercase font-semibold text-gp-primary block">
                        {formatResonanceLabel(resonance.label)}
                      </span>
                      <h4 className="text-xs font-bold text-gp-ink-strong dark:text-white leading-relaxed break-words">
                        {getResonanceEndpointLabel(source)}
                        <span className="text-gp-ink-muted dark:text-gp-ink-soft font-normal">
                          {' '}
                          →{' '}
                        </span>
                        {getResonanceEndpointLabel(target)}
                      </h4>
                    </div>
                  </div>
                  {resonance.description && (
                    <p className="text-[11px] text-gp-ink-muted dark:text-gp-ink-soft leading-relaxed mt-1">
                      {resonance.description}
                    </p>
                  )}
                  {!resonance.description && resonance.evidence && (
                    <p className="text-[11px] text-gp-ink-muted dark:text-gp-ink-soft leading-relaxed mt-1">
                      {resonance.evidence}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </ProfileCard>
      )}
    </div>
  )
}
