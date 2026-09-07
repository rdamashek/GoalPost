'use client'

import { useState, type FC } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  ArrowRight,
  FileText,
  Layers,
  Sparkles,
  Users,
  Waves,
} from 'lucide-react'
import { GET_FIELD_CONTEXT_DETAILS } from '@/app/graphql/queries/FIELD_CONTEXT_DETAILS_QUERIES'
import { GET_FIELD_CONTEXT_PEOPLE } from '@/app/graphql/queries/FIELD_CONTEXT_PEOPLE_QUERIES'
import { GET_DOCUMENTS_BY_FIELD_CONTEXT } from '@/app/graphql/queries/DOCUMENT_QUERIES'
import {
  UPDATE_FIELD_CONTEXT_MUTATION,
  LOG_FIELD_ACTIVITY,
} from '@/app/graphql/mutations'
import {
  BodySkeleton,
  EditCta,
  EditFooter,
  EditTextInput,
  ErrorBody,
  NotFoundBody,
  PrimaryCta,
  StatCell,
} from './shared'
import {
  DocumentsSection,
  PeopleSection,
  PulsesSection,
  ResonancesSection,
  type FieldContextDocument,
  type FieldContextPerson,
} from './field-context-sections'
import { dispatchOpenInfoDrawer } from './types'
import { partitionFieldRoster } from '@/lib/field-roster-visibility'
import { useResonanceSuggestionCount } from '@/hooks/useResonanceSuggestionCount'

/**
 * Field context inspection — pulse counts, recent pulses, resonances,
 * people, documents, parent space. This drawer is a lightweight inspector;
 * the heavy mutation surfaces (create-pulse, add-person, doc-upload,
 * resonance discovery) live on the full-page route
 * /protected/dashboard/field-context/[id], which is the entry point for
 * those workflows (alongside the assistant).
 */
export const FieldContextDetailsBody: FC<{
  contextId: string
  label?: string
}> = ({ contextId, label }) => {
  const router = useRouter()
  const [isEditMode, setIsEditMode] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const { data, loading, error, refetch } = useQuery(GET_FIELD_CONTEXT_DETAILS, {
    variables: { contextId },
    fetchPolicy: 'cache-and-network',
  })
  const [updateFieldContext] = useMutation(UPDATE_FIELD_CONTEXT_MUTATION)
  const [logFieldActivity] = useMutation(LOG_FIELD_ACTIVITY)

  const { data: peopleData } = useQuery<{
    fieldContexts?: {
      id: string
      // GOAL-346: ids of people a member deliberately put on the roster.
      curatedPersonIds?: string[] | null
      // Only the open directory identity is read here. Email and the rest of
      // the PII live behind `privateProfile` (GOAL-275) and this surface has
      // no need for them, so it does not declare them.
      people?: FieldContextPerson[]
    }[]
  }>(GET_FIELD_CONTEXT_PEOPLE, {
    variables: { contextId },
    fetchPolicy: 'cache-and-network',
  })

  const { data: docsData, loading: docsLoading } = useQuery<{
    documentsByFieldContext?: FieldContextDocument[]
  }>(GET_DOCUMENTS_BY_FIELD_CONTEXT, {
    variables: { fieldContextId: contextId },
    fetchPolicy: 'cache-and-network',
  })

  // GOAL-352: the same passive pending-suggestion indicator the field page
  // carries (GOAL-348). Read before the early returns below because it is a
  // hook — it no-ops on a blank spaceId and re-runs once the field query
  // resolves its parent Space. Scoped to THIS field: an empty contextId would
  // silently widen the number to the whole Space.
  const { count: pendingSuggestionCount } = useResonanceSuggestionCount({
    spaceId: data?.fieldContexts?.[0]?.space?.[0]?.id ?? '',
    contextId: contextId || undefined,
    status: 'pending',
  })

  // GOAL-346: the People section below is filtered against the documents
  // query, so painting before it resolves would show every extracted person
  // for a frame and then retract them. Guarded on `!docsData` so a
  // cache-and-network revalidation doesn't throw the drawer back to skeleton.
  if ((loading && !data) || (docsLoading && !docsData))
    return <BodySkeleton label={label} />

  const context = data?.fieldContexts?.[0]
  if (!context) {
    if (error) return <ErrorBody detail={error.message} onRetry={() => refetch()} />
    return <NotFoundBody />
  }

  const goal = data?.goalPulses ?? []
  const resource = data?.resourcePulses ?? []
  const story = data?.storyPulses ?? []
  const care = data?.carePulses ?? []
  const coreValue = data?.coreValuePulses ?? []
  const allPulses = [...goal, ...resource, ...story, ...care, ...coreValue].sort(
    (a, b) =>
      new Date(b.createdAt ?? 0).getTime() -
      new Date(a.createdAt ?? 0).getTime()
  )

  const resonances = context.resonancesInContext ?? []
  const space = context.space?.[0]
  const isMe = space?.__typename === 'MeSpace'
  const documents = docsData?.documentsByFieldContext ?? []
  // GOAL-346: same split the field page applies — people an upload named are
  // shown under their document (the Documents section below), not in People,
  // unless a member promoted them onto the roster.
  const { roster: people } = partitionFieldRoster(
    peopleData?.fieldContexts?.[0]?.people ?? [],
    documents,
    peopleData?.fieldContexts?.[0]?.curatedPersonIds
  )

  const handleEditStart = () => {
    setEditTitle(context.title ?? '')
    setIsEditMode(true)
  }

  const handleEditCancel = () => {
    setIsEditMode(false)
    setEditTitle('')
  }

  const handleEditSave = async () => {
    const trimmedTitle = editTitle.trim()
    if (!trimmedTitle) {
      toast.error('Title is required.')
      return
    }
    try {
      setIsSaving(true)
      // emergentName is AI-surfaced from resonance discovery — not user-editable
      // here. Title is the human-owned label.
      const update: Record<string, string | null> = {
        title_SET: trimmedTitle,
      }
      await updateFieldContext({
        variables: { where: { id_EQ: contextId }, update },
        refetchQueries: [
          { query: GET_FIELD_CONTEXT_DETAILS, variables: { contextId } },
        ],
      })
      logFieldActivity({
        variables: {
          input: {
            action: 'updated',
            fieldId: contextId,
            fieldName: trimmedTitle,
            contextId,
            spaceName: space?.name,
          },
        },
      }).catch((err) => console.warn('Failed to log field update:', err))
      toast.success('Field context updated.')
      setIsEditMode(false)
    } catch (err) {
      console.error('Failed to update field context:', err)
      toast.error(
        err instanceof Error
          ? err.message
          : 'Could not update field context. Please try again.'
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col">
      <section className="relative px-6 pt-7 pb-7 border-b border-gp-glass-border bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-transparent">
        <div className="flex items-start gap-4">
          <div className="shrink-0 size-14 rounded-2xl border flex items-center justify-center shadow-md bg-indigo-500/20 border-indigo-300/40 text-indigo-700 dark:text-indigo-200">
            <Layers className="w-7 h-7" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            {isEditMode ? (
              <EditTextInput
                id="fc-edit-title"
                label="Title"
                value={editTitle}
                onChange={setEditTitle}
                placeholder="Field context title"
                autoFocus
                disabled={isSaving}
              />
            ) : (
              <h2 className="text-2xl font-black tracking-tight text-gp-ink-strong dark:text-white break-words leading-tight">
                {context.title || context.emergentName || 'Untitled field'}
              </h2>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-[0.16em] border bg-indigo-500/20 border-indigo-400/40 text-indigo-700 dark:text-indigo-100">
                Field context
              </span>
              {space?.name && (
                <button
                  type="button"
                  onClick={() =>
                    dispatchOpenInfoDrawer({
                      type: isMe ? 'MeSpace' : 'WeSpace',
                      id: space.id,
                      label: space.name,
                    })
                  }
                  className="text-[11px] uppercase tracking-[0.16em] text-gp-ink-muted dark:text-white/50 hover:text-gp-ink-strong dark:hover:text-white/80 transition-colors cursor-pointer"
                  title={`Open ${space.name}`}
                  disabled={isEditMode}
                >
                  {isMe ? 'Me Space' : 'We Space'} · {space.name}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-5 grid grid-cols-2 gap-3">
        <StatCell
          icon={<Sparkles className="w-3.5 h-3.5" />}
          label="Pulses"
          value={String(allPulses.length)}
        />
        <StatCell
          icon={<Waves className="w-3.5 h-3.5" />}
          label="Resonances"
          value={String(resonances.length)}
        />
        <StatCell
          icon={<Users className="w-3.5 h-3.5" />}
          label="People"
          value={String(people.length)}
        />
        <StatCell
          icon={<FileText className="w-3.5 h-3.5" />}
          label="Documents"
          value={String(documents.length)}
        />
      </section>

      <PulsesSection pulses={allPulses} />

      <ResonancesSection
        resonances={resonances}
        pendingSuggestionCount={pendingSuggestionCount}
        // The drawer is an inspector — the review modal lives on the full
        // field page (WF-07), so the chip hands the reader off there rather
        // than duplicating the queue here. Any Space role may review-read, so
        // this is not gated on edit permission.
        onReviewSuggestions={() =>
          router.push(`/protected/dashboard/field-context/${context.id}`)
        }
      />

      <PeopleSection people={people} />

      <DocumentsSection documents={documents} />

      <footer className="mt-auto px-6 py-5 border-t border-gp-glass-border bg-white/[0.02] dark:bg-white/[0.02]">
        {isEditMode ? (
          <EditFooter
            onCancel={handleEditCancel}
            onSave={handleEditSave}
            saving={isSaving}
          />
        ) : (
          <div className="flex items-center gap-2">
            <PrimaryCta
              onClick={() =>
                router.push(`/protected/dashboard/field-context/${context.id}`)
              }
              className="flex-1"
            >
              Open full page
              <ArrowRight className="w-4 h-4" />
            </PrimaryCta>
            <EditCta onClick={handleEditStart} />
          </div>
        )}
      </footer>
    </div>
  )
}
