'use client'

import type { FC } from 'react'
import { ArrowRight, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GetFieldContextDetailsQuery } from '@/gql/graphql'
import { formatResonanceLabel } from '@/utils/graph-utils'
import { SectionHeader } from './shared'
import { ShowMoreToggle, useExpandableList } from './expandable-list'
import { dispatchOpenInfoDrawer } from './types'

/**
 * The list sections of the FieldContext drawer (GOAL-315). Split out of
 * `field-context-details-body.tsx` so each section owns its own
 * expand/collapse state instead of the body carrying four hooks, and so
 * neither file exceeds the 400-line component budget.
 *
 * Every list renders a capped slice by default and an interactive
 * "+ N more" toggle that reveals the rest in place. Rows keep their existing
 * behaviour: clicking one opens that entity's info drawer.
 */

type FieldContextQuery = GetFieldContextDetailsQuery

export type FieldContextPulse =
  | FieldContextQuery['goalPulses'][number]
  | FieldContextQuery['resourcePulses'][number]
  | FieldContextQuery['storyPulses'][number]
  | FieldContextQuery['carePulses'][number]
  | FieldContextQuery['coreValuePulses'][number]

export type FieldContextResonance = NonNullable<
  FieldContextQuery['fieldContexts'][number]['resonancesInContext']
>[number]

/**
 * Open directory identity only. Email and the rest of the PII sit behind
 * `privateProfile` (GOAL-275); this surface never reads them.
 */
export type FieldContextPerson = {
  id: string
  name: string | null
  firstName: string | null
  lastName: string | null
  photo: string | null
}

export type FieldContextDocument = {
  id: string
  filename: string
  uploadedAt: string
  // GOAL-346: already returned by GET_DOCUMENTS_BY_FIELD_CONTEXT; declared
  // here so the roster filter can tell which attached people arrived through
  // an upload rather than being added by a member.
  extractedPeople?: { id: string }[] | null
}

const PULSE_LIMIT = 8
const RESONANCE_LIMIT = 6
const PEOPLE_LIMIT = 8
const DOCUMENT_LIMIT = 5

const rowClass = cn(
  'group w-full text-left rounded-xl border border-gp-glass-border bg-white/5 dark:bg-white/[0.03]',
  'hover:bg-white/10 dark:hover:bg-white/[0.06] hover:border-white/20',
  'px-3.5 py-2.5 transition-all cursor-pointer'
)

export const PulsesSection: FC<{ pulses: FieldContextPulse[] }> = ({
  pulses,
}) => {
  const { visible, hiddenCount, expanded, toggle } = useExpandableList(
    pulses,
    PULSE_LIMIT
  )
  if (pulses.length === 0) return null

  return (
    <section className="px-6 pb-5">
      <SectionHeader>Recent pulses ({pulses.length})</SectionHeader>
      <ul className="mt-2 space-y-1.5">
        {visible.map((pulse) => (
          <li key={pulse.id}>
            <button
              type="button"
              onClick={() =>
                dispatchOpenInfoDrawer({
                  type: 'Pulse',
                  id: pulse.id,
                  label: pulse.title ?? undefined,
                })
              }
              className={cn(rowClass, 'flex items-center gap-3')}
            >
              <span className="text-[9px] font-bold uppercase tracking-wider text-gp-ink-muted dark:text-white/45 w-14 shrink-0">
                {typenameLabel(pulse.__typename)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gp-ink-strong dark:text-white/90 truncate">
                  {pulse.title || 'Untitled'}
                </p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 group-hover:translate-x-0.5 transition-all" />
            </button>
          </li>
        ))}
        {hiddenCount > 0 && (
          <li className="pt-0.5">
            <ShowMoreToggle
              expanded={expanded}
              hiddenCount={hiddenCount}
              onToggle={toggle}
              itemLabel="pulses"
            />
          </li>
        )}
      </ul>
    </section>
  )
}

// The tint carries the semantic (primary) hue; the INK deliberately does not.
// `--gp-primary` is amber in the warm themes, and amber-on-white at 10px is
// unreadable — so the label uses the surface ink token, which is the only
// foreground guaranteed to contrast in light, dark, and all five themes.
const pendingChipClass = cn(
  'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5',
  'border border-gp-primary/30 bg-gp-primary/10 text-gp-ink-strong',
  'dark:border-gp-primary/45 dark:bg-gp-primary/25 dark:text-white',
  'text-[10px] font-bold uppercase tracking-wider'
)

export const ResonancesSection: FC<{
  resonances: FieldContextResonance[]
  /**
   * GOAL-352: `pending` ResonanceSuggestions anchored in THIS field and
   * waiting for human review (WF-07). Zero renders no affordance at all —
   * never a "0" chip. This mirrors the field page's indicator (GOAL-348) so a
   * reader who reaches the field through the drawer gets the same signal
   * instead of a Resonances list that silently omits what is queued.
   */
  pendingSuggestionCount?: number
  /**
   * Sends the reader to the full field page, which owns the review modal —
   * the drawer is an inspector and deliberately hosts no review workflow.
   * Omit to render the count as a passive, non-interactive chip.
   */
  onReviewSuggestions?: () => void
}> = ({ resonances, pendingSuggestionCount = 0, onReviewSuggestions }) => {
  const { visible, hiddenCount, expanded, toggle } = useExpandableList(
    resonances,
    RESONANCE_LIMIT
  )
  const hasPending = pendingSuggestionCount > 0
  // A field with no confirmed resonances but a full review queue is the exact
  // blind spot this section used to have: it returned null and the queue was
  // invisible from the drawer. Render for either.
  if (resonances.length === 0 && !hasPending) return null

  const pendingSentence = `${pendingSuggestionCount} AI ${
    pendingSuggestionCount === 1 ? 'suggestion is' : 'suggestions are'
  } waiting for review in this field`

  return (
    <section className="px-6 pb-5">
      <div className="flex items-center justify-between gap-2">
        {/* "Resonances (0)" beside a "105 pending" chip reads as a data
            inconsistency, so the count is dropped when the list is empty —
            the paragraph below says what is actually there. */}
        <SectionHeader>
          {resonances.length > 0
            ? `Resonances (${resonances.length})`
            : 'Resonances'}
        </SectionHeader>
        {hasPending &&
          (onReviewSuggestions ? (
            <button
              type="button"
              data-testid="drawer-review-suggestions"
              onClick={() => onReviewSuggestions()}
              className={cn(
                pendingChipClass,
                'hover:bg-gp-primary/20 dark:hover:bg-gp-primary/35 transition-colors cursor-pointer'
              )}
              // An ACTION label, not a restatement: when the field has no
              // confirmed resonances the paragraph below already announces the
              // same count, and a screen reader would otherwise read it twice.
              // It says "where you can review them" rather than promising the
              // review itself — this only navigates; the modal is opened by the
              // field page's own affordance.
              aria-label={`Review ${pendingSuggestionCount} pending AI resonance ${
                pendingSuggestionCount === 1 ? 'suggestion' : 'suggestions'
              } — opens the full field page, where you can review them`}
              title={`${pendingSentence}. Opens the full field page, where you can review them — it runs no new search.`}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px] leading-none"
              >
                rate_review
              </span>
              <span>{pendingSuggestionCount} pending</span>
            </button>
          ) : (
            <span className={pendingChipClass} title={pendingSentence}>
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px] leading-none"
              >
                rate_review
              </span>
              <span>{pendingSuggestionCount} pending</span>
            </span>
          ))}
      </div>
      {resonances.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-gp-ink-muted dark:text-white/55">
          No confirmed resonances yet — {pendingSentence}.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {visible.map((res) => {
            const src = res.source?.[0]
            const tgt = res.target?.[0]
            const srcTitle =
              (src && 'title' in src ? src.title : undefined) ?? 'Pulse'
            const tgtTitle =
              (tgt && 'title' in tgt ? tgt.title : undefined) ?? 'Pulse'
            return (
              <li key={res.id}>
                <button
                  type="button"
                  onClick={() =>
                    dispatchOpenInfoDrawer({
                      type: 'ResonanceLink',
                      id: res.id,
                      label: res.label ?? undefined,
                    })
                  }
                  className={rowClass}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gp-primary truncate">
                      {formatResonanceLabel(res.label ?? null)}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 group-hover:translate-x-0.5 transition-all shrink-0" />
                  </div>
                  <p className="mt-1 text-[11px] text-gp-ink-muted dark:text-white/55 truncate">
                    {srcTitle} ↔ {tgtTitle}
                  </p>
                </button>
              </li>
            )
          })}
          {hiddenCount > 0 && (
            <li className="pt-0.5">
              <ShowMoreToggle
                expanded={expanded}
                hiddenCount={hiddenCount}
                onToggle={toggle}
                itemLabel="resonances"
              />
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

export const PeopleSection: FC<{ people: FieldContextPerson[] }> = ({
  people,
}) => {
  const { visible, hiddenCount, expanded, toggle } = useExpandableList(
    people,
    PEOPLE_LIMIT
  )
  if (people.length === 0) return null

  return (
    <section className="px-6 pb-5">
      <SectionHeader>People ({people.length})</SectionHeader>
      <ul className="mt-2 grid grid-cols-2 gap-1.5">
        {visible.map((person) => {
          const name =
            person.name?.trim() ||
            `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() ||
            'Member'
          return (
            <li key={person.id} className="min-w-0">
              <button
                type="button"
                onClick={() =>
                  dispatchOpenInfoDrawer({
                    type: 'Person',
                    id: person.id,
                    label: name,
                  })
                }
                className="group w-full text-left rounded-lg border border-gp-glass-border bg-white/5 dark:bg-white/[0.03] hover:bg-white/10 dark:hover:bg-white/[0.06] hover:border-white/20 px-2 py-1.5 transition-all cursor-pointer flex items-center gap-2 min-w-0"
              >
                <div className="size-6 shrink-0 rounded-full bg-white/10 border border-white/10 flex items-center justify-center text-[9px] font-bold text-white/80">
                  {name.slice(0, 2).toUpperCase()}
                </div>
                <span className="text-[11px] font-medium text-gp-ink-strong dark:text-white/85 truncate">
                  {name}
                </span>
              </button>
            </li>
          )
        })}
        {hiddenCount > 0 && (
          <li className="col-span-2 pt-0.5">
            <ShowMoreToggle
              expanded={expanded}
              hiddenCount={hiddenCount}
              onToggle={toggle}
              itemLabel="people"
            />
          </li>
        )}
      </ul>
    </section>
  )
}

export const DocumentsSection: FC<{ documents: FieldContextDocument[] }> = ({
  documents,
}) => {
  const { visible, hiddenCount, expanded, toggle } = useExpandableList(
    documents,
    DOCUMENT_LIMIT
  )
  if (documents.length === 0) return null

  return (
    <section className="px-6 pb-5">
      <SectionHeader>Documents ({documents.length})</SectionHeader>
      <ul className="mt-2 space-y-1.5">
        {visible.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              onClick={() =>
                dispatchOpenInfoDrawer({
                  type: 'Document',
                  id: doc.id,
                  label: doc.filename,
                })
              }
              className={cn(rowClass, 'flex items-center gap-3')}
            >
              <FileText className="w-3.5 h-3.5 text-gp-ink-muted dark:text-white/55 shrink-0" />
              <span className="text-xs font-medium text-gp-ink-strong dark:text-white/85 truncate flex-1">
                {doc.filename}
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 group-hover:translate-x-0.5 transition-all" />
            </button>
          </li>
        ))}
        {hiddenCount > 0 && (
          <li className="pt-0.5">
            <ShowMoreToggle
              expanded={expanded}
              hiddenCount={hiddenCount}
              onToggle={toggle}
              itemLabel="documents"
            />
          </li>
        )}
      </ul>
    </section>
  )
}

function typenameLabel(typename: string | null | undefined): string {
  switch (typename) {
    case 'GoalPulse':
      return 'Goal'
    case 'ResourcePulse':
      return 'Resource'
    case 'StoryPulse':
      return 'Story'
    case 'CarePulse':
      return 'Care'
    case 'CoreValuePulse':
      return 'Value'
    default:
      return 'Pulse'
  }
}
