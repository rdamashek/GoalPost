'use client'

import { SectionHeader } from '@/components/persons/section-header'
import { ProfileCard } from '@/components/persons/profile-card'
import type { PulseAuthorLike } from '@/lib/pulse-author'
import { PulsesSection } from './pulses-section'
import { PromiseWeavesSection } from './promise-weaves-section'
import type { WeaveRecord } from './promise-weaves-section'
import { ResonancesSection } from './resonances-section'
import type { ResonanceRecord } from './resonances-section'
import { EmptySection } from './field-section-primitives'

type PulseRecord = {
  __typename: string
  id: string
  title: string
  content: string
  createdAt: string
  initiatedBy?: PulseAuthorLike[] | null
  createdBy?: PulseAuthorLike[] | null
}

type SpaceRecord = {
  __typename?: string | null
  name?: string | null
  visibility?: string | null
}

type PersonRecord = {
  id: string
  firstName: string
  lastName: string
  name: string | null
  email: string | null
  photo: string | null
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' | 'PERSON'
}

type FieldContextSectionsProps = {
  createdDate: string
  pulses: PulseRecord[]
  resonances: ResonanceRecord[]
  weaves?: WeaveRecord[]
  space?: SpaceRecord | null
  people?: PersonRecord[]
  /**
   * GOAL-346: how many attached people are being shown under their source
   * Document instead of in this list. Without it the section says "No people
   * yet" on a field that has dozens of them — true of the list, badly wrong
   * about the field, and it hides where they actually went.
   */
  peopleFromDocumentsCount?: number
  onAddPulse: () => void
  onAddPerson?: () => void
  onAddResonance: () => void
  /** AI resonance discovery entry attached to the Resonances section header.
   *  Scans the parent Space's pulses and opens the suggestions review modal.
   *  Omit to hide the affordance (e.g. surfaces without a resolved Space). */
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
  /** Legacy bulk-share entry attached to the Pulses section header. Used only
   *  when `onOpenShare` is not provided (surfaces not yet wired for the richer
   *  select-and-share flow). Omit to hide. */
  onSharePulses?: () => void
  /** Rich move/share entry. When provided, the Pulses section gains a per-pulse
   *  move/share affordance and a multi-select mode that opens the bulk modal
   *  pre-populated with the chosen pulses on the given tab. */
  onOpenShare?: (pulseIds: string[], mode: 'share' | 'move') => void
  /** Optional upload entry attached to a Documents-related empty state.
   *  Omit when the user lacks edit permission. */
  onUploadDocument?: () => void
  /** Spreadsheet-driven bulk article import (GOAL-317). Omit when the user
   *  lacks edit permission. */
  onImportArticles?: () => void
  onEditPulse: (
    e: React.MouseEvent,
    pulseId: string,
    type: 'goal' | 'resource' | 'story' | 'care' | 'coreValue',
    title: string,
    content: string
  ) => void
  onDeletePulse: (
    e: React.MouseEvent,
    pulseId: string,
    type: 'goal' | 'resource' | 'story' | 'care' | 'coreValue'
  ) => void
  onPulseClick: (pulseId: string) => void
  onResonanceClick: (resonanceId: string) => void
  onWeaveClick?: (weaveId: string) => void
  /** Promise-weave authoring. Omit each to hide its affordance for viewers. */
  onAddWeave?: () => void
  onEditWeave?: (weaveId: string) => void
  onConfirmWeave?: (weaveId: string) => void
  onDismissWeave?: (weaveId: string) => void
  pendingWeaveId?: string | null
  onPersonClick?: (personId: string) => void
}

export function FieldContextSections({
  createdDate,
  pulses,
  resonances,
  weaves = [],
  space,
  people,
  peopleFromDocumentsCount = 0,
  onAddPulse,
  onAddPerson,
  onAddResonance,
  onDiscoverResonances,
  isDiscoveringResonances = false,
  pendingSuggestionCount = 0,
  onReviewSuggestions,
  onSharePulses,
  onOpenShare,
  onUploadDocument,
  onImportArticles,
  onEditPulse,
  onDeletePulse,
  onPulseClick,
  onResonanceClick,
  onWeaveClick,
  onAddWeave,
  onEditWeave,
  onConfirmWeave,
  onDismissWeave,
  pendingWeaveId = null,
  onPersonClick,
}: FieldContextSectionsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 mb-8 sm:mb-12">
      <div className="flex flex-col gap-4">
        <SectionHeader icon="location_on" title="Space" />
        <ProfileCard>
          <div className="space-y-2">
            <div>
              <span className="text-[9px] uppercase font-semibold text-gp-primary block mb-1">
                {space?.__typename || 'Space'}
              </span>
              <h4 className="text-xs font-bold text-gp-ink-strong dark:text-white mb-1">
                {space?.name}
              </h4>
            </div>
            <p className="text-[11px] text-gp-ink-muted dark:text-gp-ink-soft">
              {space?.visibility}
            </p>
          </div>
        </ProfileCard>
      </div>

      <div className="flex flex-col gap-4">
        <SectionHeader icon="info" title="Metadata" />
        <ProfileCard>
          <div className="space-y-2">
            <div>
              <span className="text-[10px] text-gp-ink-muted dark:text-gp-ink-soft">
                Created
              </span>
              <p className="text-xs font-semibold text-gp-ink-strong dark:text-white">
                {createdDate}
              </p>
            </div>
          </div>
        </ProfileCard>
      </div>

      {people && (
        <div className="flex flex-col gap-4 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader icon="groups" title="People" />
            {onAddPerson && (
              <button
                onClick={onAddPerson}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium bg-white/50 dark:bg-white/5 border border-white/60 dark:border-white/10 text-gp-ink-strong dark:text-gp-ink-strong hover:bg-white/80 dark:hover:bg-white/10 transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">
                  person_add
                </span>
                Add Person
              </button>
            )}
          </div>
          {people.length > 0 ? (
            <div className="space-y-3">
              {people.map((person) => (
                <ProfileCard
                  key={person.id}
                  hover={!!onPersonClick}
                  stretch={false}
                  onClick={
                    onPersonClick ? () => onPersonClick(person.id) : undefined
                  }
                >
                  <div className="flex justify-between items-center gap-4">
                    <div>
                      <h4 className="text-xs font-bold text-gp-ink-strong dark:text-white">
                        {person.name ||
                          `${person.firstName} ${person.lastName}`.trim()}
                      </h4>
                      <p className="text-[11px] text-gp-ink-muted dark:text-gp-ink-soft">
                        {person.role}
                      </p>
                    </div>
                    {onPersonClick && (
                      <span className="material-symbols-outlined text-gp-ink-muted dark:text-gp-ink-soft text-sm">
                        arrow_forward_ios
                      </span>
                    )}
                  </div>
                </ProfileCard>
              ))}
            </div>
          ) : (
            <EmptySection
              icon="groups"
              title={
                peopleFromDocumentsCount
                  ? 'No people added yet'
                  : 'No people yet'
              }
              body={
                peopleFromDocumentsCount
                  ? `${peopleFromDocumentsCount} ${peopleFromDocumentsCount === 1 ? 'person was' : 'people were'} named by documents in this field — you'll find them under the document they came from. People you add show up here with their role.`
                  : 'People you add show up here with their role inside this field.'
              }
              cta={
                onAddPerson
                  ? {
                      label: 'Add a person',
                      icon: 'person_add',
                      onClick: onAddPerson,
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}

      <PulsesSection
        pulses={pulses}
        onAddPulse={onAddPulse}
        onUploadDocument={onUploadDocument}
        onImportArticles={onImportArticles}
        onEditPulse={onEditPulse}
        onDeletePulse={onDeletePulse}
        onPulseClick={onPulseClick}
        onOpenShare={onOpenShare}
        onSharePulses={onSharePulses}
      />

      <ResonancesSection
        resonances={resonances}
        pulseCount={pulses.length}
        onAddResonance={onAddResonance}
        onResonanceClick={onResonanceClick}
        onDiscoverResonances={onDiscoverResonances}
        isDiscoveringResonances={isDiscoveringResonances}
        pendingSuggestionCount={pendingSuggestionCount}
        onReviewSuggestions={onReviewSuggestions}
      />

      <PromiseWeavesSection
        weaves={weaves}
        pulseCount={pulses.length}
        onWeaveClick={onWeaveClick}
        onAddWeave={onAddWeave}
        onEditWeave={onEditWeave}
        onConfirmWeave={onConfirmWeave}
        onDismissWeave={onDismissWeave}
        pendingWeaveId={pendingWeaveId}
      />

      <div className="flex flex-col gap-4 md:col-span-2">
        <SectionHeader icon="summarize" title="Summary" />
        <ProfileCard>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs text-gp-ink-muted dark:text-gp-ink-soft">
                Total Pulses
              </span>
              <span className="text-lg font-bold text-gp-primary">
                {pulses.length}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-gp-ink-muted dark:text-gp-ink-soft">
                Total Resonances
              </span>
              <span className="text-lg font-bold text-gp-primary">
                {resonances.length}
              </span>
            </div>
          </div>
        </ProfileCard>
      </div>
    </div>
  )
}
