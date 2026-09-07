'use client'

import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useApolloClient, useQuery, useMutation } from '@apollo/client/react'
import { useEffect, useState, useMemo, useCallback, type FC } from 'react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { dispatchOpenInfoDrawer } from '@/components/dashboard/entity-info-drawer'
import { OfferingModal } from '@/components/ui/offering-modal'
import { OfferingInput } from '@/components/ui/offering-input'
import { PulseEditModal } from '@/components/ui/pulse-edit-modal'
import { ResonanceLinkModal } from '@/components/ui/resonance-link-modal'
import { ResonanceSuggestionsModal } from '@/components/ui/resonance-suggestions-modal'
import { BulkPulseShareModal } from '@/components/ui/bulk-pulse-share-modal'
import { PersonPanel } from '@/components/ui/person-panel'
import { resolveRelationshipWhy } from '@/lib/people/resolve-relationship-why'
import { partitionFieldRoster } from '@/lib/field-roster-visibility'
import {
  AddPersonToFieldModal,
  type CreateFieldPersonInput,
} from '@/components/ui/add-person-to-field-modal'
import {
  UploadDocumentModal,
  type UploadDocumentSubmitInput,
} from '@/components/ui/upload-document-modal'
// Dynamic + conditionally mounted: the modal pulls in SheetJS (~hundreds of
// KB), which must not land in the dashboard bundle for members who never
// open the import flow.
const ImportArticlesModal = dynamic(
  () =>
    import('@/components/fields/import-articles-modal').then(
      (mod) => mod.ImportArticlesModal
    ),
  { ssr: false }
)
import type { NodeType } from '@/components/ui/pulse-node'
import { GET_FIELD_CONTEXT_DETAILS } from '@/app/graphql/queries/FIELD_CONTEXT_DETAILS_QUERIES'
import {
  GET_FIELD_CONTEXT_PEOPLE,
  GET_DOCUMENTS_BY_FIELD_CONTEXT,
} from '@/app/graphql/queries'
import {
  ADD_PERSON_TO_FIELD_CONTEXT_MUTATION,
  REMOVE_PERSON_FROM_FIELD_CONTEXT_MUTATION,
  CREATE_PEOPLE_MUTATION,
  CREATE_GOAL_PULSE_MUTATION,
  CREATE_RESOURCE_PULSE_MUTATION,
  CREATE_STORY_PULSE_MUTATION,
  CREATE_CARE_PULSE_MUTATION,
  CREATE_CORE_VALUE_PULSE_MUTATION,
  UPDATE_GOAL_PULSE_MUTATION,
  UPDATE_RESOURCE_PULSE_MUTATION,
  UPDATE_STORY_PULSE_MUTATION,
  UPDATE_CARE_PULSE_MUTATION,
  UPDATE_CORE_VALUE_PULSE_MUTATION,
  DELETE_GOAL_PULSE_MUTATION,
  DELETE_RESOURCE_PULSE_MUTATION,
  DELETE_STORY_PULSE_MUTATION,
  DELETE_CARE_PULSE_MUTATION,
  DELETE_CORE_VALUE_PULSE_MUTATION,
  DELETE_RESONANCES_BY_PULSE_MUTATION,
  UPDATE_FIELD_CONTEXT_MUTATION,
  DELETE_FIELD_CONTEXT_MUTATION,
  LOG_FIELD_ACTIVITY,
  LOG_PULSE_ACTIVITY,
  CREATE_RESONANCE_LINK_MUTATION,
  SHARE_PULSE_WITH_CONTEXT_MUTATION,
  REMOVE_PULSE_FROM_CONTEXT_MUTATION,
} from '@/app/graphql/mutations'
import { LOG_RESONANCE_ACTIVITY } from '@/app/graphql/mutations/ACTIVITY_LOG_MUTATIONS'
import { PromiseWeaveModal } from '@/components/fields/promise-weave-modal'
import { usePromiseWeaves } from '@/hooks/usePromiseWeaves'
import { WEAVE_STATUS } from '@/lib/promise-weave'
import { cn } from '@/lib/utils'
import { useApp, useFocalEntity, usePageContext } from '@/contexts'
import { usePulseSharing } from '@/hooks/usePulseSharing'
import { FieldContextSections } from '@/components/fields/field-context-sections'
import { ArticleImportStatusSection } from '@/components/fields/article-import-status-section'
import {
  DocumentList,
  type DocumentRecord,
} from '@/components/fields/document-list'
import { SubContextsSection } from '@/components/fields/sub-contexts-section'
import { MoveFieldModal } from '@/components/fields/move-field-modal'
import { runDocumentUploadFlow } from '@/lib/ingest/upload-document-flow'
import {
  emitImportArticlesModalClosed,
  onOpenAddPulseModal,
  onOpenImportArticlesModal,
} from '@/lib/simulation/pulse-creation-events'
import { deriveCanEditContent } from '@/hooks/use-field-context-permissions'
import { useRouteFocalScope } from '@/lib/focal-entity/use-route-focal-scope'
import { useResonanceDiscovery } from '@/hooks/useResonanceDiscovery'
import { useResonanceSuggestions } from '@/hooks/useResonanceSuggestions'
import { useResonanceSuggestionCount } from '@/hooks/useResonanceSuggestionCount'

export default function FieldContextDetailsPage() {
  const router = useRouter()
  const { setPageTitle } = usePageContext()
  const { setFocalLabel, setFocalParents } = useFocalEntity()
  const { user } = useApp()
  // Scope is derived from the URL through the shared `useRouteFocalScope`
  // hook — the same single source the Bloom canvas reads — so the Dashboard
  // and Bloom views can never resolve to different Fields after a view
  // switch (GOAL-271).
  const { activeFieldId } = useRouteFocalScope()
  const contextId = activeFieldId ?? ''
  const [isCreatePulseModalOpen, setIsCreatePulseModalOpen] = useState(false)
  const [editingPulseId, setEditingPulseId] = useState<string | null>(null)
  const [editingPulseData, setEditingPulseData] = useState<{
    type: NodeType
    name: string
    content: string
  } | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editEmergentName, setEditEmergentName] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isPulseSubmitting, setIsPulseSubmitting] = useState(false)
  const [pulseSubmitError, setPulseSubmitError] = useState<string | null>(null)
  const [pulseSubmitSuccess, setPulseSubmitSuccess] = useState(false)
  const [isEditLoading, setIsEditLoading] = useState(false)
  const [isDeleteLoading, setIsDeleteLoading] = useState(false)
  const [showPulseDeleteConfirm, setShowPulseDeleteConfirm] = useState(false)
  const [pulseToDelete, setPulseToDelete] = useState<{
    id: string
    type: NodeType
    title: string
  } | null>(null)
  const [isResonanceLinkModalOpen, setIsResonanceLinkModalOpen] =
    useState(false)
  const [isDiscoverModalOpen, setIsDiscoverModalOpen] = useState(false)
  const [isResonanceSubmitting, setIsResonanceSubmitting] = useState(false)
  const [resonanceSubmitError, setResonanceSubmitError] = useState<
    string | null
  >(null)
  const [isBulkShareModalOpen, setIsBulkShareModalOpen] = useState(false)
  const [bulkInitialPulseIds, setBulkInitialPulseIds] = useState<string[]>([])
  const [bulkInitialMode, setBulkInitialMode] = useState<'share' | 'move'>(
    'share'
  )
  const [isAddPersonModalOpen, setIsAddPersonModalOpen] = useState(false)
  const [isAddingPersonToField, setIsAddingPersonToField] = useState(false)
  const [isRemovingPersonFromField, setIsRemovingPersonFromField] =
    useState(false)
  const [isUploadDocumentModalOpen, setIsUploadDocumentModalOpen] =
    useState(false)
  // Bumped on every open so the modal remounts with clean state (GOAL-337).
  // The shared upload flow releases the modal at the 202 while its ingest
  // watch keeps the `onSubmit` promise pending for minutes, so the modal's
  // own post-await reset can land long after — or into — the next upload.
  // Mirrors the studio action bar's `uploadSessionKey`.
  const [uploadSessionKey, setUploadSessionKey] = useState(0)
  const [isMoveFieldModalOpen, setIsMoveFieldModalOpen] = useState(false)
  const [isUploadingDocument, setIsUploadingDocument] = useState(false)
  const [isImportArticlesModalOpen, setIsImportArticlesModalOpen] =
    useState(false)
  // Bumped when the import modal closes or reports landed rows, so the
  // GOAL-336 status section refetches its job list immediately instead of
  // waiting for its own poll.
  const [importStatusVersion, setImportStatusVersion] = useState(0)
  const [isPersonPanelOpen, setIsPersonPanelOpen] = useState(false)
  const [selectedPerson, setSelectedPerson] = useState<{
    id: string
    firstName: string
    lastName: string
    name: string | null
    email: string | null
    photo: string | null
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' | 'PERSON'
    description: string | null
    relationshipWhy: string | null
  } | null>(null)

  // Set page title
  useEffect(() => {
    setPageTitle('Dashboard')
  }, [setPageTitle])

  // The studio-shell action bar fires this event when the user clicks
  // "Add pulse" from outside the dashboard subtree. The detail's
  // `fieldContextId` must match this page's contextId so a stale
  // listener (e.g. previously-visited field still mounted in another
  // browser tab) doesn't steal the open request.
  useEffect(() => {
    if (!contextId) return
    return onOpenAddPulseModal((detail) => {
      if (detail.fieldContextId !== contextId) return
      setIsCreatePulseModalOpen(true)
    })
  }, [contextId])

  const { data, loading, error, refetch } = useQuery(
    GET_FIELD_CONTEXT_DETAILS,
    {
      variables: { contextId },
      skip: !contextId,
      // cache-and-network (matching GET_SPACE_DETAILS): moving or deleting a
      // nested field only refetches the nested field's own query, so the former
      // parent's cached subContexts would otherwise stay stale when the user
      // navigates back to it (GOAL-295).
      fetchPolicy: 'cache-and-network',
    }
  )

  const { data: fieldPeopleData, refetch: refetchFieldPeople } = useQuery(
    GET_FIELD_CONTEXT_PEOPLE,
    {
      variables: { contextId },
      skip: !contextId,
    }
  )

  const {
    data: documentsData,
    refetch: refetchDocuments,
    // GOAL-346: the People section now depends on this query to know which
    // attached people arrived through an upload. Without holding the page on
    // it, People resolves first and paints every extracted person for a frame
    // before they vanish — the exact content this change exists to remove,
    // shown and then retracted. Folded into the gate below rather than given
    // its own skeleton, and it runs in parallel with the slower details
    // query, so it is rarely the long pole.
    loading: documentsLoading,
  } = useQuery(GET_DOCUMENTS_BY_FIELD_CONTEXT, {
    variables: { fieldContextId: contextId },
    skip: !contextId,
  })

  // For the shared document-upload flow (GOAL-337), whose refetches and
  // ingest watch run against the client directly rather than a single query.
  const apolloClient = useApolloClient()
  const documents = useMemo<DocumentRecord[]>(() => {
    const raw = (
      documentsData as
        | { documentsByFieldContext?: DocumentRecord[] }
        | undefined
    )?.documentsByFieldContext
    return raw ?? []
  }, [documentsData])

  // Setup mutations
  const [createGoalPulse] = useMutation(CREATE_GOAL_PULSE_MUTATION)
  const [createResourcePulse] = useMutation(CREATE_RESOURCE_PULSE_MUTATION)
  const [createStoryPulse] = useMutation(CREATE_STORY_PULSE_MUTATION)
  const [createCarePulse] = useMutation(CREATE_CARE_PULSE_MUTATION)
  const [createCoreValuePulse] = useMutation(CREATE_CORE_VALUE_PULSE_MUTATION)
  const [updateGoalPulse] = useMutation(UPDATE_GOAL_PULSE_MUTATION)
  const [updateResourcePulse] = useMutation(UPDATE_RESOURCE_PULSE_MUTATION)
  const [updateStoryPulse] = useMutation(UPDATE_STORY_PULSE_MUTATION)
  const [updateCarePulse] = useMutation(UPDATE_CARE_PULSE_MUTATION)
  const [updateCoreValuePulse] = useMutation(UPDATE_CORE_VALUE_PULSE_MUTATION)
  const [deleteGoalPulse] = useMutation(DELETE_GOAL_PULSE_MUTATION)
  const [deleteResourcePulse] = useMutation(DELETE_RESOURCE_PULSE_MUTATION)
  const [deleteStoryPulse] = useMutation(DELETE_STORY_PULSE_MUTATION)
  const [deleteCarePulse] = useMutation(DELETE_CARE_PULSE_MUTATION)
  const [deleteCoreValuePulse] = useMutation(DELETE_CORE_VALUE_PULSE_MUTATION)
  const [deleteResonancesByPulse] = useMutation(
    DELETE_RESONANCES_BY_PULSE_MUTATION
  )
  const [updateFieldContext] = useMutation(UPDATE_FIELD_CONTEXT_MUTATION)
  const [deleteFieldContext] = useMutation(DELETE_FIELD_CONTEXT_MUTATION)
  const [logFieldActivity] = useMutation(LOG_FIELD_ACTIVITY)
  const [logPulseActivity] = useMutation(LOG_PULSE_ACTIVITY)
  const [createResonanceLink] = useMutation(CREATE_RESONANCE_LINK_MUTATION)
  const [logResonanceActivity] = useMutation(LOG_RESONANCE_ACTIVITY)
  const [sharePulseWithContext] = useMutation(SHARE_PULSE_WITH_CONTEXT_MUTATION)
  const [removePulseFromContext] = useMutation(
    REMOVE_PULSE_FROM_CONTEXT_MUTATION
  )
  const [addPersonToFieldContext] = useMutation(
    ADD_PERSON_TO_FIELD_CONTEXT_MUTATION
  )
  const [removePersonFromFieldContext] = useMutation(
    REMOVE_PERSON_FROM_FIELD_CONTEXT_MUTATION
  )
  const [createPerson] = useMutation(CREATE_PEOPLE_MUTATION)

  const context = data?.fieldContexts?.[0]
  const space = context?.space?.[0]
  const subContextCount = context?.subContexts?.length ?? 0
  // Resonance discovery is Space-scoped (WF-06): it scans the parent Space's
  // pulses and writes `pending` ResonanceSuggestions for human review (WF-07).
  // Empty until the field's parent Space resolves — the hooks no-op on a blank
  // id, and the Discover affordance stays hidden until then.
  const spaceId = space?.id ?? ''

  const {
    suggestions: resonanceSuggestions,
    loading: resonanceSuggestionsLoading,
    refetch: refetchSuggestions,
    acceptSuggestion,
    acceptAllAboveConfidence,
    declineSuggestion,
  } = useResonanceSuggestions({ spaceId, filter: 'all', enabled: false })

  // GOAL-348: the pending count IS the passive indicator, so it must load with
  // the page. It is deliberately a separate, count-only request — the list hook
  // above stays lazy because its payload embeds both pulses' full content for
  // every suggestion, which is the modal's need, not a badge's.
  const {
    count: pendingSuggestionCount,
    refetch: refetchPendingSuggestionCount,
  } = useResonanceSuggestionCount({
    spaceId,
    // `spaceId` is read off the field query, which is skipped while `contextId`
    // is empty — so there is no render where the id below is blank but the hook
    // still fires. The `|| undefined` is belt-and-braces for that ordering, NOT
    // a guard in its own right: an empty contextId would widen the count to the
    // whole Space, which is why the id must never reach here unresolved.
    contextId: contextId || undefined,
    status: 'pending',
  })

  // Opening the review modal must NEVER imply a discovery sweep (WF-06/WF-07
  // are separate steps): this only pulls the suggestions that already exist.
  const openSuggestionsModal = useCallback(() => {
    setIsDiscoverModalOpen(true)
    void refetchSuggestions()
  }, [refetchSuggestions])

  const { triggerDiscovery, isLoading: isDiscoveringResonances } =
    useResonanceDiscovery({
      spaceId,
      onSuccess: () => {
        setIsDiscoverModalOpen(true)
        void refetchSuggestions()
        // A sweep mints new `pending` suggestions — keep the badge honest.
        void refetchPendingSuggestionCount()
      },
    })

  // Supply the resolved FieldContext title to the focal-entity primitive so the
  // assistant can speak of it by name.
  useEffect(() => {
    if (!context?.id || !context?.title) return
    setFocalLabel(context.id, context.title, 'FieldContext')
  }, [context?.id, context?.title, setFocalLabel])

  // Declare the parent Space — and, for a nested field (GOAL-295), the
  // ancestor field chain (root → immediate parent) — for the breadcrumb.
  // `ancestorContexts` comes pre-ordered from the server; StudioBreadcrumb
  // already renders N parents and folds the middle ones on phones.
  const ancestorContexts = context?.ancestorContexts
  const ancestorsKey = (ancestorContexts ?? [])
    .map((a) => `${a.id}::${a.title}`)
    .join('|')
  useEffect(() => {
    if (!context?.id) return
    if (!space?.id || !space?.name) {
      setFocalParents(context.id, [])
      return
    }
    const spaceType = space.__typename === 'MeSpace' ? 'MeSpace' : 'WeSpace'
    setFocalParents(context.id, [
      { type: spaceType, id: space.id, label: space.name },
      ...(ancestorContexts ?? []).map((ancestor) => ({
        type: 'FieldContext' as const,
        id: ancestor.id,
        label: ancestor.title,
      })),
    ])
    // `ancestorContexts` intentionally omitted — `ancestorsKey` is its
    // content-stable proxy (Apollo returns a fresh array per cache refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context?.id,
    space?.id,
    space?.name,
    space?.__typename,
    ancestorsKey,
    setFocalParents,
  ])
  const peopleContext = (
    fieldPeopleData as
      | {
          fieldContexts?: Array<{
            // GOAL-346: ids of people a human deliberately put on the roster.
            // Everyone else attached by document ingestion is shown under the
            // document that named them instead of in the People section.
            curatedPersonIds?: string[] | null
            people?: Array<{
              id: string
              firstName?: string | null
              lastName?: string | null
              name?: string | null
              photo?: string | null
              // GOAL-275: email / description / the connection graph read
              // through the single type-level gate. Null when this caller is
              // not authorized for that person — the roster then shows the
              // open directory identity only.
              privateProfile?: {
                email?: string | null
                description?: string | null
                connectionEdges?: Array<{
                  connectedPersonId?: string | null
                  why?: string | null
                }> | null
              } | null
            }>
            meSpace?: Array<{
              owner?: Array<{ id: string }>
              members?: Array<{
                role?: 'ADMIN' | 'MEMBER' | 'GUEST' | null
                member?: Array<{ id: string }>
              }>
            }>
            weSpace?: Array<{
              owner?: Array<{ id: string }>
              members?: Array<{
                role?: 'ADMIN' | 'MEMBER' | 'GUEST' | null
                member?: Array<{ id: string }>
              }>
            }>
          }>
        }
      | undefined
  )?.fieldContexts?.[0]

  const people = useMemo(() => {
    if (!peopleContext) return []

    type FieldMembership = {
      role?: 'ADMIN' | 'MEMBER' | 'GUEST' | null
      member?: Array<{ id: string }>
    }

    const roleById = new Map<
      string,
      'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' | 'PERSON'
    >()
    const ownerId =
      peopleContext.meSpace?.[0]?.owner?.[0]?.id ||
      peopleContext.weSpace?.[0]?.owner?.[0]?.id

    if (ownerId) {
      roleById.set(ownerId, 'OWNER')
    }

    ;(
      peopleContext.meSpace?.[0]?.members as FieldMembership[] | undefined
    )?.forEach((membership) => {
      const member = membership.member?.[0]
      if (member?.id) {
        roleById.set(
          member.id,
          (membership.role || 'MEMBER') as 'ADMIN' | 'MEMBER' | 'GUEST'
        )
      }
    })
    ;(
      peopleContext.weSpace?.[0]?.members as FieldMembership[] | undefined
    )?.forEach((membership) => {
      const member = membership.member?.[0]
      if (member?.id) {
        roleById.set(
          member.id,
          (membership.role || 'MEMBER') as 'ADMIN' | 'MEMBER' | 'GUEST'
        )
      }
    })

    // GOAL-346: people the extractor pulled out of a document are attached to
    // the field by the same HAS_PERSON edge that means "on the roster", so
    // without this split the People section is swamped by names nobody added.
    // They stay reachable — and better explained — under the document they
    // came from, and `curatedPersonIds` brings back anyone a member promoted.
    const { roster } = partitionFieldRoster(
      peopleContext.people || [],
      documents,
      peopleContext.curatedPersonIds
    )

    return roster.map((person) => ({
      id: person.id,
      firstName: person.firstName || '',
      lastName: person.lastName || '',
      name: person.name || null,
      email: person.privateProfile?.email || null,
      photo: person.photo || null,
      role: roleById.get(person.id) || ('PERSON' as const),
      description: person.privateProfile?.description || null,
      relationshipWhy: resolveRelationshipWhy(
        person.privateProfile?.connectionEdges,
        user?.id
      ),
    }))
  }, [peopleContext, documents, user?.id])

  // The other half of the same split. Drives the People empty state, so a
  // field whose roster is empty *because* its people came from uploads says
  // where they went instead of claiming there are none.
  const peopleFromDocumentsCount = useMemo(
    () =>
      partitionFieldRoster(
        peopleContext?.people || [],
        documents,
        peopleContext?.curatedPersonIds
      ).fromDocuments.length,
    [peopleContext, documents]
  )

  // Slice 7 (GOAL-242) — UI permission gate for the upload control. We mirror
  // `canEditContent` from kb/02-user-roles.md: OWNER + ADMIN + MEMBER pass,
  // GUEST and non-members do not. The route boundary re-checks this server-side
  // (see `enqueueDocumentIngest`), so this is purely a "don't show a control
  // the user cannot use" measure — never a security boundary on its own.
  //
  // The rule itself lives in `deriveCanEditContent` so the floating canvas
  // action bar gates its Upload menu on exactly the same predicate (GOAL-327).
  const canEditContent = useMemo(
    () => deriveCanEditContent(peopleContext, user?.id),
    [peopleContext, user?.id]
  )

  // Same bus as add-pulse, for the bulk spreadsheet import offered by the
  // action bar's Upload menu (GOAL-327). The modal stays owned by this page
  // because the post-import refetch wiring (`refetch` / `refetchFieldPeople`)
  // lives here. Re-check `canEditContent` rather than trusting the event: the
  // emitter already hides itself for GUESTs, but a window event is forgeable
  // and this keeps the client gate consistent with the in-page trigger below.
  useEffect(() => {
    if (!contextId || !canEditContent) return
    return onOpenImportArticlesModal((detail) => {
      if (detail.fieldContextId !== contextId) return
      setIsImportArticlesModalOpen(true)
    })
  }, [contextId, canEditContent])
  // Memoized because `weavePulseOptions` derives from it — a fresh
  // spread-and-sort literal every render would defeat that memo entirely.
  const pulses = useMemo(
    () =>
      [
        ...(data?.goalPulses || []),
        ...(data?.resourcePulses || []),
        ...(data?.storyPulses || []),
        ...(data?.carePulses || []),
        ...(data?.coreValuePulses || []),
      ].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime()
      ),
    [
      data?.goalPulses,
      data?.resourcePulses,
      data?.storyPulses,
      data?.carePulses,
      data?.coreValuePulses,
    ]
  )
  const resonances = context?.resonancesInContext || []
  // Memoized because `weaveById` below derives from it — a fresh `[]` literal
  // every render would rebuild that map on every render.
  const weaves = useMemo(() => context?.weaves || [], [context?.weaves])

  const promiseWeaves = usePromiseWeaves({
    contextId,
    currentUserId: user?.id,
    refetch,
  })

  // Candidates the weave modal offers. Pulses are this field's own; people are
  // every Person attached to it, so a weave can only be woven for someone
  // inside this field.
  //
  // GOAL-346 deliberately reads the UNFILTERED attach list here, not the
  // `people` roster below. The roster filter is presentation-only — hiding
  // extracted people from a list must not withdraw the ability to weave a
  // promise for them, which would turn a display change into a removed
  // capability. On a document-heavy field the filtered list is nearly empty,
  // so this is the difference between a working modal and a dead one.
  const weavePulseOptions = useMemo(
    () =>
      pulses.map((pulse) => ({
        id: pulse.id,
        __typename: pulse.__typename ?? '',
        title: pulse.title ?? '',
      })),
    [pulses]
  )
  const weavePeopleOptions = useMemo(
    () =>
      (peopleContext?.people ?? []).map((person) => ({
        id: person.id,
        name:
          person.name?.trim() ||
          `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() ||
          'Unnamed person',
      })),
    [peopleContext]
  )
  const weaveById = useMemo(
    () => new Map(weaves.map((weave) => [weave.id, weave])),
    [weaves]
  )

  const handleEditStart = () => {
    setEditTitle(context?.title || '')
    setEditEmergentName(context?.emergentName || '')
    setIsEditMode(true)
  }

  const handleEditCancel = () => {
    setIsEditMode(false)
    setEditTitle('')
    setEditEmergentName('')
  }

  const handleEditSave = async () => {
    try {
      setIsEditLoading(true)
      const updateInput: Record<string, string | undefined> = {}
      if (editTitle) updateInput.title_SET = editTitle
      if (editEmergentName) updateInput.emergentName_SET = editEmergentName

      const where = { id_EQ: contextId }

      await updateFieldContext({
        variables: { where, update: updateInput },
        refetchQueries: [
          {
            query: GET_FIELD_CONTEXT_DETAILS,
            variables: { contextId },
          },
        ],
      })

      // Log field context update activity
      logFieldActivity({
        variables: {
          input: {
            action: 'updated',
            fieldId: contextId,
            fieldName: editTitle || context?.title,
            contextId,
            spaceName: space?.name,
          },
        },
      }).catch((err) => console.warn('Failed to log field update:', err))

      setIsEditMode(false)
      setEditTitle('')
      setEditEmergentName('')
    } catch (err) {
      console.error('Failed to update context:', err)
    } finally {
      setIsEditLoading(false)
    }
  }

  const handleDelete = async () => {
    try {
      if (!context) return

      setIsDeleteLoading(true)

      // Deletion cascades server-side (GOAL-319 + GOAL-295): the field, its
      // nested fields, and all of their pulses are soft deleted together, and
      // the server writes the activity Log in the same transaction — no
      // client-side log call here.
      const result = await deleteFieldContext({
        variables: { id: contextId },
      })

      const deletedSubFields =
        result.data?.deleteFieldContext?.deletedSubContextCount ?? 0
      toast.success(
        deletedSubFields > 0
          ? `Field deleted along with ${deletedSubFields} nested field${deletedSubFields === 1 ? '' : 's'}`
          : 'Field deleted successfully'
      )
      // Land on the parent field (for a nested field) or the owning
      // Space — not the dashboard root.
      const parentFieldId = context.parentContext?.[0]?.id
      router.push(
        parentFieldId
          ? `/protected/dashboard/field-context/${parentFieldId}`
          : spaceBackHref
      )
    } catch (err) {
      console.error('Failed to delete context:', err)
      toast.error('Failed to delete field. Please try again.')
      setShowDeleteConfirm(false)
    } finally {
      setIsDeleteLoading(false)
    }
  }

  const handleCreatePulse = async (
    value: string,
    type: string,
    name: string
  ) => {
    if (!user) {
      setPulseSubmitError('User not authenticated')
      return
    }

    setIsPulseSubmitting(true)
    setPulseSubmitError(null)
    setPulseSubmitSuccess(false)

    try {
      const pulseTypeMap = {
        goal: 'goal',
        resource: 'resource',
        story: 'story',
        care: 'care',
        coreValue: 'coreValue',
      } as const

      const pulseType =
        pulseTypeMap[type as keyof typeof pulseTypeMap] || 'goal'

      if (editingPulseId) {
        const editUpdate = {
          where: { id_EQ: editingPulseId },
          update: {
            title_SET: name,
            content_SET: value,
          },
        }
        if (pulseType === 'goal') {
          await updateGoalPulse({ variables: editUpdate })
        } else if (pulseType === 'resource') {
          await updateResourcePulse({ variables: editUpdate })
        } else if (pulseType === 'care') {
          await updateCarePulse({ variables: editUpdate })
        } else if (pulseType === 'coreValue') {
          await updateCoreValuePulse({ variables: editUpdate })
        } else {
          await updateStoryPulse({ variables: editUpdate })
        }

        const currentPulse = pulses.find((pulse) => pulse.id === editingPulseId)
        const snapshotName = currentPulse?.title ?? name

        logPulseActivity({
          variables: {
            input: {
              action: 'updated',
              pulseId: editingPulseId,
              pulseType:
                pulseType.charAt(0).toUpperCase() +
                pulseType.slice(1) +
                'Pulse',
              pulseName: snapshotName,
              contextId,
            },
          },
        }).catch((err) => console.warn('Failed to log pulse update:', err))
      } else {
        const baseInput = {
          title: name,
          content: value,
          intensity: 1.0,
          createdAt: new Date().toISOString(),
          context: {
            connect: [{ where: { node: { id_EQ: contextId } } }],
          },
          createdBy: {
            connect: [{ where: { node: { id_EQ: user.id } } }],
          },
        }

        let createdPulseId: string | undefined

        if (pulseType === 'goal') {
          const { data: response } = await createGoalPulse({
            variables: {
              input: [
                {
                  ...baseInput,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  status: 'ACTIVE' as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  horizon: 'MID' as any,
                },
              ],
            },
          })
          createdPulseId = response?.createGoalPulses?.goalPulses?.[0]?.id
        } else if (pulseType === 'resource') {
          const { data: response } = await createResourcePulse({
            variables: {
              input: [
                {
                  ...baseInput,
                  resourceType: 'general',
                  availability: 1.0,
                },
              ],
            },
          })
          createdPulseId =
            response?.createResourcePulses?.resourcePulses?.[0]?.id
        } else if (pulseType === 'care') {
          const { data: response } = await createCarePulse({
            variables: {
              input: [baseInput],
            },
          })
          createdPulseId = response?.createCarePulses?.carePulses?.[0]?.id
        } else if (pulseType === 'coreValue') {
          const { data: response } = await createCoreValuePulse({
            variables: {
              input: [baseInput],
            },
          })
          createdPulseId =
            response?.createCoreValuePulses?.coreValuePulses?.[0]?.id
        } else {
          const { data: response } = await createStoryPulse({
            variables: {
              input: [baseInput],
            },
          })
          createdPulseId = response?.createStoryPulses?.storyPulses?.[0]?.id
        }

        if (createdPulseId) {
          logPulseActivity({
            variables: {
              input: {
                action: 'created',
                pulseId: createdPulseId,
                pulseType:
                  pulseType.charAt(0).toUpperCase() +
                  pulseType.slice(1) +
                  'Pulse',
                pulseName: name,
                contextId,
              },
            },
          }).catch((err) => console.warn('Failed to log pulse creation:', err))
        }
      }

      setPulseSubmitSuccess(true)

      await refetch()

      setTimeout(() => {
        setIsCreatePulseModalOpen(false)
        setPulseSubmitSuccess(false)
        setPulseSubmitError(null)
        setEditingPulseId(null)
        setEditingPulseData(null)
      }, 1500)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create pulse'
      console.error('Error creating pulse:', error)
      setPulseSubmitError(errorMessage)
    } finally {
      setIsPulseSubmitting(false)
    }
  }

  const handleEditPulse = (
    e: React.MouseEvent,
    pulseId: string,
    type: NodeType,
    title: string,
    content: string
  ) => {
    e.stopPropagation()
    setEditingPulseId(pulseId)
    setEditingPulseData({
      type,
      name: title,
      content,
    })
    setIsCreatePulseModalOpen(true)
  }

  const handleDeletePulse = async (
    e: React.MouseEvent,
    pulseId: string,
    type: NodeType,
    skipConfirm = false
  ) => {
    e.stopPropagation()

    const currentPulse = pulses.find((pulse) => pulse.id === pulseId)

    if (!skipConfirm) {
      setPulseToDelete({
        id: pulseId,
        type,
        title: currentPulse?.title ?? '',
      })
      setShowPulseDeleteConfirm(true)
      return
    }

    if (!user) {
      setPulseSubmitError('User not authenticated')
      return
    }

    setIsPulseSubmitting(true)
    setPulseSubmitError(null)

    try {
      await deleteResonancesByPulse({ variables: { pulseId } })

      if (type === 'goal') {
        await deleteGoalPulse({ variables: { where: { id_EQ: pulseId } } })
      } else if (type === 'resource') {
        await deleteResourcePulse({ variables: { where: { id_EQ: pulseId } } })
      } else if (type === 'care') {
        await deleteCarePulse({ variables: { where: { id_EQ: pulseId } } })
      } else if (type === 'coreValue') {
        await deleteCoreValuePulse({ variables: { where: { id_EQ: pulseId } } })
      } else {
        await deleteStoryPulse({ variables: { where: { id_EQ: pulseId } } })
      }

      logPulseActivity({
        variables: {
          input: {
            action: 'deleted',
            pulseId,
            pulseType: type.charAt(0).toUpperCase() + type.slice(1) + 'Pulse',
            pulseName: currentPulse?.title ?? '',
            contextId,
          },
        },
      }).catch((err) => console.warn('Failed to log pulse deletion:', err))

      toast.success('Pulse deleted successfully')
      setShowPulseDeleteConfirm(false)
      setPulseToDelete(null)
      await refetch()
    } catch (error) {
      console.error('Error deleting pulse:', error)
      setPulseSubmitError(
        error instanceof Error ? error.message : 'Failed to delete pulse'
      )
      toast.error('Failed to delete pulse')
    } finally {
      setIsPulseSubmitting(false)
    }
  }

  const confirmDeletePulse = async () => {
    if (!pulseToDelete) return

    await handleDeletePulse(
      new MouseEvent('click') as unknown as React.MouseEvent,
      pulseToDelete.id,
      pulseToDelete.type,
      true
    )
  }

  const handleResonanceLinkSubmit = async (data: {
    label: string
    confidence: number
    description: string
    sourceId: string
    targetId: string
    sourceType: NodeType
    targetType: NodeType
  }) => {
    setIsResonanceSubmitting(true)
    setResonanceSubmitError(null)

    try {
      const response = await createResonanceLink({
        variables: {
          input: [
            {
              label: data.label,
              confidence: data.confidence,
              description: data.description,
              createdAt: new Date().toISOString(),
              source: {
                connect: [{ where: { node: { id_EQ: data.sourceId } } }],
              },
              target: {
                connect: [{ where: { node: { id_EQ: data.targetId } } }],
              },
              context: {
                connect: [{ where: { node: { id_EQ: contextId } } }],
              },
            },
          ],
        },
      })

      const createdResonanceId =
        response.data?.createResonanceLinks?.resonanceLinks?.[0]?.id

      if (createdResonanceId) {
        logResonanceActivity({
          variables: {
            input: {
              action: 'created',
              resonanceId: createdResonanceId,
              sourceId: data.sourceId,
              targetId: data.targetId,
              label: data.label,
              contextId,
            },
          },
        }).catch((err) =>
          console.warn('Failed to log resonance creation:', err)
        )
      }

      toast.success('Resonance link created successfully')

      setIsResonanceLinkModalOpen(false)
      await refetch()
    } catch (error) {
      console.error('Error with resonance link:', error)
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create resonance'
      setResonanceSubmitError(errorMessage)
      toast.error(errorMessage)
    } finally {
      setIsResonanceSubmitting(false)
    }
  }

  const handleAddPersonToField = async (input: CreateFieldPersonInput) => {
    setIsAddingPersonToField(true)
    try {
      const personInput = {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        pronouns: input.pronouns,
        location: input.location,
        photo: input.photo,
        avatar: input.avatar,
        status: input.status,
        gender: input.gender,
        careManual: input.careManual,
        favorites: input.favorites,
        passions: input.passions,
        traits: input.traits,
        fieldsOfCare: input.fieldsOfCare,
        interests: input.interests,
      }

      const { data: createResponse } = await createPerson({
        variables: {
          input: [
            {
              ...personInput,
              createdBy: user?.id
                ? {
                    connect: [{ where: { node: { id_EQ: user.id } } }],
                  }
                : undefined,
            },
          ],
        },
      })

      const personId = createResponse?.createPeople?.people?.[0]?.id
      if (!personId) {
        throw new Error('Person creation failed')
      }

      // The custom mutation reports authorization failures as
      // success: false rather than a thrown GraphQL error.
      const { data: attachResponse } = await addPersonToFieldContext({
        variables: {
          contextId,
          personId,
        },
      })
      const attachResult = attachResponse?.addPersonToFieldContext
      if (!attachResult?.success) {
        throw new Error(attachResult?.message || 'Failed to add person')
      }

      await refetchFieldPeople()
      setIsAddPersonModalOpen(false)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to add person'
      toast.error(errorMessage)
      throw error
    } finally {
      setIsAddingPersonToField(false)
    }
  }

  const handleUploadDocument = async (input: UploadDocumentSubmitInput) => {
    setIsUploadingDocument(true)
    try {
      // Shared with the studio action-bar entry point (GOAL-337): presign →
      // S3 PUT → enqueue, then follow the ingest to a terminal status with an
      // evolving toast and open the ingest thread when it lands. The flow
      // settles its own toasts (including errors) and rethrows, so the
      // modal's catch renders the same message inline; this page's active
      // documents/details/people queries are refreshed by its refetches.
      await runDocumentUploadFlow(apolloClient, {
        fieldContextId: contextId,
        input,
        onQueued: () => {
          setIsUploadDocumentModalOpen(false)
          setIsUploadingDocument(false)
        },
      })
    } finally {
      setIsUploadingDocument(false)
    }
  }

  const handlePersonClick = (personId: string) => {
    const person = people.find((entry) => entry.id === personId)
    if (!person) return

    setSelectedPerson(person)
    setIsPersonPanelOpen(true)
  }

  const handleRemovePersonFromField = async (personId: string) => {
    setIsRemovingPersonFromField(true)
    try {
      await removePersonFromFieldContext({
        variables: {
          contextId,
          personId,
        },
      })

      setIsPersonPanelOpen(false)
      setSelectedPerson(null)
      await refetchFieldPeople()
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to remove person'
      toast.error(errorMessage)
    } finally {
      setIsRemovingPersonFromField(false)
    }
  }

  // `documentsLoading && !documentsData` joins the gate for GOAL-346 — see the
  // query above. Both halves are needed: a refetch after an upload sets
  // `loading` true again while data is already present, and re-throwing the
  // page into a skeleton on every upload would be a worse regression than the
  // flash this prevents.
  if ((loading && !data) || (documentsLoading && !documentsData)) {
    return <FieldContextSkeleton />
  }

  if (error || !context) {
    return (
      <FieldContextError
        error={error}
        onRetry={error ? () => refetch() : undefined}
        onBack={() => router.push('/protected/dashboard')}
      />
    )
  }

  const createdAt = context.createdAt ? new Date(context.createdAt) : null
  const createdDate = createdAt
    ? createdAt.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Unknown'
  const createdLabel =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? formatDistanceToNow(createdAt, { addSuffix: true })
      : '—'

  const isMe = space?.__typename === 'MeSpace'
  const spaceBackHref = space?.id
    ? `/protected/dashboard/space/${space.id}`
    : '/protected/dashboard'
  const spaceLabel = space?.__typename
    ? space.__typename === 'MeSpace'
      ? 'Me Space'
      : 'We Space'
    : 'Space'

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* Backdrop — mirrors the in-space dashboard so a Field reads as a
          continuation of its owning Space. Warm (amber) accent for
          MeSpace, cool (teal) for WeSpace. */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.8),transparent_70%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.03),transparent_70%)]" />
        <div
          className="absolute top-[10%] left-[10%] w-125 h-125 rounded-full blur-[120px] animate-blob"
          style={{
            backgroundColor: isMe
              ? 'color-mix(in srgb, var(--gp-accent-glow) 12%, transparent)'
              : 'color-mix(in srgb, var(--gp-primary) 12%, transparent)',
          }}
        />
        <div
          className="absolute bottom-[10%] right-[10%] w-100 h-100 rounded-full blur-[100px] animate-blob [animation-delay:2s]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--gp-accent-glow) 10%, transparent)',
          }}
        />
        <div
          className="absolute top-[40%] left-[60%] w-75 h-75 rounded-full blur-[100px] animate-blob [animation-delay:4s]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--gp-goal) 10%, transparent)',
          }}
        />
      </div>

      {/* Edit Modal */}
      {isEditMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="relative bg-gp-surface dark:bg-gp-surface-dark rounded-2xl shadow-2xl max-w-2xl w-full mx-4 p-5 sm:p-8 border border-gp-glass-border">
            <button
              onClick={handleEditCancel}
              className="absolute top-4 right-4 text-gp-ink-muted hover:text-gp-ink-strong transition-colors"
            >
              <span className="material-symbols-outlined">close</span>
            </button>

            <h2 className="text-2xl font-semibold text-gp-ink-strong dark:text-white mb-6">
              Edit Field Context
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gp-ink-strong dark:text-white mb-2">
                  Title
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gp-glass-border bg-gp-glass-bg dark:bg-gp-glass-bg/50 text-gp-ink-strong dark:text-white focus:outline-none focus:ring-2 focus:ring-gp-primary"
                  placeholder="Context title"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gp-ink-strong dark:text-white mb-2">
                  Emergent Name (Optional)
                </label>
                <input
                  type="text"
                  value={editEmergentName}
                  onChange={(e) => setEditEmergentName(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gp-glass-border bg-gp-glass-bg dark:bg-gp-glass-bg/50 text-gp-ink-strong dark:text-white focus:outline-none focus:ring-2 focus:ring-gp-primary"
                  placeholder="AI-generated emergent name"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  onClick={handleEditCancel}
                  disabled={isEditLoading}
                  className="px-6 py-2 rounded-lg border border-gp-glass-border text-gp-ink-strong dark:text-white hover:bg-gp-glass-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleEditSave}
                  disabled={isEditLoading}
                  className="px-6 py-2 rounded-lg bg-gp-primary text-white font-medium hover:shadow-lg hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isEditLoading && (
                    <span
                      className={cn(
                        'material-symbols-outlined text-base',
                        'motion-safe:animate-spin'
                      )}
                    >
                      hourglass_bottom
                    </span>
                  )}
                  {isEditLoading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="relative bg-gp-surface dark:bg-gp-surface-dark rounded-2xl shadow-2xl max-w-md w-full mx-4 p-5 sm:p-8 border border-gp-glass-border">
            <h2 className="text-2xl font-semibold text-gp-ink-strong dark:text-white mb-3">
              Delete Field?
            </h2>

            <p className="text-sm text-gp-ink-muted dark:text-gp-ink-soft mb-3">
              Are you sure you want to delete this field? This action cannot be
              undone.
              {pulses && pulses.length > 0 && (
                <span className="text-xs mt-2 block">
                  This will also delete its {pulses.length} pulse
                  {pulses.length !== 1 ? 's' : ''}.
                </span>
              )}
              {subContextCount > 0 && (
                <span className="text-xs mt-2 block">
                  This will also delete its {subContextCount} nested field
                  {subContextCount !== 1 ? 's' : ''} and their pulses.
                </span>
              )}
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleteLoading || loading}
                className="px-6 py-2 rounded-lg border border-gp-glass-border text-gp-ink-strong dark:text-white hover:bg-gp-glass-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleteLoading || loading}
                className="px-6 py-2 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isDeleteLoading && (
                  <span
                    className={cn(
                      'material-symbols-outlined text-base',
                      'motion-safe:animate-spin'
                    )}
                  >
                    hourglass_bottom
                  </span>
                )}
                {isDeleteLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable content — pb-40 leaves a clear lane for the
          floating StudioCanvasActionBar at the bottom of the canvas so
          page content never sits directly under it at scroll end. */}
      <main className="flex-1 min-w-0 relative z-10 overflow-y-auto overflow-x-hidden scroller p-4 sm:p-8 pb-40">
        <div className="max-w-5xl mx-auto space-y-5 sm:space-y-6 animate-fade-in">
          {/* Top bar — back to the owning Space on the left; page-local
              actions on the right as pill buttons. On md+ the pills
              expand to show their labels; on narrower screens they
              compact to icon-only chips of the same height. Share lives
              on the section itself (not up here), so this bar only
              carries the always-applicable verbs. */}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => router.push(spaceBackHref)}
              className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gp-ink-muted hover:text-gp-ink-strong transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">
                arrow_back
              </span>
              {space?.name || 'Space'}
            </button>
            <div className="flex items-center gap-2">
              <TopBarPill
                icon="info"
                label="Info"
                onClick={() =>
                  dispatchOpenInfoDrawer({
                    type: 'FieldContext',
                    id: contextId,
                  })
                }
              />
              <TopBarPill icon="edit" label="Edit" onClick={handleEditStart} />
              {canEditContent && (
                <TopBarPill
                  icon="move_down"
                  label="Move"
                  onClick={() => setIsMoveFieldModalOpen(true)}
                  disabled={loading}
                />
              )}
              <TopBarPill
                icon="delete"
                label="Delete"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={loading}
                variant="danger"
              />
            </div>
          </div>

          {/* Hero — identity block. Sized to anchor the page without
              dominating it; the read-heavy sections below the fold
              (pulses, resonances, docs) are where the user spends most
              of their time. */}
          <header className="flex flex-col items-center text-center gap-3 sm:gap-4 pt-1">
            <div
              className={cn(
                'size-12 sm:size-14 rounded-2xl border flex items-center justify-center shadow-lg backdrop-blur-sm',
                isMe
                  ? 'bg-amber-500/20 border-amber-300/40 text-amber-600 dark:text-amber-200'
                  : 'bg-teal-500/20 border-teal-300/40 text-teal-600 dark:text-teal-200'
              )}
            >
              <span className="material-symbols-outlined text-2xl sm:text-3xl">
                category
              </span>
            </div>
            <div className="space-y-1.5 sm:space-y-2 max-w-3xl">
              <span
                className={cn(
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-[0.18em] border',
                  isMe
                    ? 'bg-amber-500/20 border-amber-400/40 text-amber-700 dark:text-amber-100'
                    : 'bg-teal-500/20 border-teal-400/40 text-teal-700 dark:text-teal-100'
                )}
              >
                {spaceLabel}
                {space?.name ? ` · ${space.name}` : ''}
              </span>
              <h1 className="text-xl sm:text-3xl md:text-4xl font-bold tracking-tight text-gp-ink-strong leading-tight break-words">
                {context.title || 'Untitled field'}
              </h1>
              {context.emergentName && (
                <p className="text-sm sm:text-base italic text-gp-ink-muted max-w-2xl mx-auto">
                  &quot;{context.emergentName}&quot;
                </p>
              )}
              <p className="text-[10px] uppercase tracking-[0.2em] text-gp-ink-muted">
                Created {createdLabel}
              </p>
            </div>

            {/* At-a-glance counters — each tile gets its own accent so
                the row reads as a quick visual scan rather than a
                uniform stat block. */}
            <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 w-full max-w-3xl">
              <Stat
                icon="graphic_eq"
                label="Pulses"
                value={pulses.length}
                accent="goal"
              />
              <Stat
                icon="hub"
                label="Resonances"
                value={resonances.length}
                accent="primary"
              />
              <Stat
                icon="groups"
                label="People"
                value={people.length}
                accent="care"
              />
              <Stat
                icon="description"
                label="Documents"
                value={documents.length}
                accent="story"
              />
            </div>
          </header>

          <SubContextsSection
            parentContextId={contextId}
            parentTitle={context.title || 'Untitled field'}
            subContexts={[...(context.subContexts ?? [])]
              // Stable order — Neo4j guarantees none without a sort.
              .sort((a, b) =>
                String(a.createdAt ?? '').localeCompare(
                  String(b.createdAt ?? '')
                )
              )
              .map((sub) => ({
                id: sub.id,
                title: sub.title,
                emergentName: sub.emergentName,
                createdAt: sub.createdAt,
                pulseCount: sub.pulses?.length ?? 0,
                subContextCount: sub.subContexts?.length ?? 0,
              }))}
            isMe={isMe}
            canEdit={canEditContent}
            onChanged={() => refetch()}
          />

          <DocumentList documents={documents} onRefetch={refetchDocuments} />

          {/* GOAL-336 — server-driven import status. Renders nothing unless
              this member has queued imports for this field, so it costs no
              space for everyone else. */}
          <ArticleImportStatusSection
            fieldContextId={contextId}
            refreshKey={importStatusVersion}
            onRowsLanded={() => {
              void refetch()
              void refetchFieldPeople()
            }}
          />

          <FieldContextSections
            createdDate={createdDate}
            pulses={pulses}
            resonances={resonances}
            weaves={weaves}
            people={people}
            peopleFromDocumentsCount={peopleFromDocumentsCount}
            space={space}
            onAddPulse={() => setIsCreatePulseModalOpen(true)}
            onAddPerson={() => setIsAddPersonModalOpen(true)}
            onAddResonance={() => setIsResonanceLinkModalOpen(true)}
            onDiscoverResonances={
              canEditContent && spaceId
                ? () => void triggerDiscovery()
                : undefined
            }
            isDiscoveringResonances={isDiscoveringResonances}
            pendingSuggestionCount={pendingSuggestionCount}
            // Reviewing is a read-then-decide step open to any Space role
            // (kb/02) — the accept/decline routes re-gate the write on
            // canEditContent, so a GUEST can look without being able to act.
            onReviewSuggestions={spaceId ? openSuggestionsModal : undefined}
            onOpenShare={(pulseIds, mode) => {
              setBulkInitialPulseIds(pulseIds)
              setBulkInitialMode(mode)
              setIsBulkShareModalOpen(true)
            }}
            onUploadDocument={
              canEditContent
                ? () => {
                    setUploadSessionKey((key) => key + 1)
                    setIsUploadDocumentModalOpen(true)
                  }
                : undefined
            }
            onImportArticles={
              canEditContent
                ? () => setIsImportArticlesModalOpen(true)
                : undefined
            }
            onEditPulse={handleEditPulse}
            onDeletePulse={handleDeletePulse}
            onPersonClick={handlePersonClick}
            onPulseClick={(pulseId) =>
              dispatchOpenInfoDrawer({ type: 'Pulse', id: pulseId })
            }
            onWeaveClick={(weaveId) =>
              dispatchOpenInfoDrawer({
                type: 'PromiseWeave',
                id: weaveId,
              })
            }
            onAddWeave={canEditContent ? promiseWeaves.openCreate : undefined}
            onEditWeave={
              canEditContent
                ? (weaveId) => {
                    const weave = weaveById.get(weaveId)
                    if (weave) promiseWeaves.openEdit(weave)
                  }
                : undefined
            }
            onConfirmWeave={
              canEditContent
                ? (weaveId) => {
                    const weave = weaveById.get(weaveId)
                    if (weave)
                      void promiseWeaves.setStatus(weave, WEAVE_STATUS.ACTIVE)
                  }
                : undefined
            }
            onDismissWeave={
              canEditContent
                ? (weaveId) => {
                    const weave = weaveById.get(weaveId)
                    if (weave)
                      void promiseWeaves.setStatus(
                        weave,
                        WEAVE_STATUS.DISSOLVED
                      )
                  }
                : undefined
            }
            pendingWeaveId={promiseWeaves.pendingWeaveId}
            onResonanceClick={(resonanceId) =>
              dispatchOpenInfoDrawer({
                type: 'ResonanceLink',
                id: resonanceId,
              })
            }
          />
        </div>
      </main>

      <OfferingModal
        isOpen={isCreatePulseModalOpen && !editingPulseId}
        onClose={() => {
          setIsCreatePulseModalOpen(false)
          setPulseSubmitError(null)
          setPulseSubmitSuccess(false)
          setEditingPulseId(null)
          setEditingPulseData(null)
        }}
        position="center"
      >
        <div className="w-full max-w-160">
          {pulseSubmitError && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:bg-red-500/20 dark:text-red-300">
              {pulseSubmitError}
            </div>
          )}
          {pulseSubmitSuccess && (
            <div className="mb-4 rounded-xl border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-700 dark:bg-green-500/20 dark:text-green-300">
              Pulse created successfully!
            </div>
          )}
          <OfferingInput
            onSubmit={(value: string, type: string, name: string) => {
              handleCreatePulse(value, type, name)
            }}
            isLoading={isPulseSubmitting}
          />
        </div>
      </OfferingModal>

      {editingPulseId && editingPulseData && (
        <PulseEditModal
          isOpen={isCreatePulseModalOpen && !!editingPulseId}
          onClose={() => {
            setIsCreatePulseModalOpen(false)
            setPulseSubmitError(null)
            setEditingPulseId(null)
            setEditingPulseData(null)
          }}
          onSubmit={(type: NodeType, name: string, content: string) => {
            handleCreatePulse(content, type, name)
          }}
          isLoading={isPulseSubmitting}
          initialType={editingPulseData.type}
          initialName={editingPulseData.name}
          initialContent={editingPulseData.content}
          error={pulseSubmitError}
          onDelete={async () => {
            await handleDeletePulse(
              new MouseEvent('click') as unknown as React.MouseEvent,
              editingPulseId,
              editingPulseData.type,
              true
            )
            setIsCreatePulseModalOpen(false)
            setEditingPulseId(null)
            setEditingPulseData(null)
          }}
        />
      )}

      <OfferingModal
        isOpen={showPulseDeleteConfirm}
        onClose={() => {
          setShowPulseDeleteConfirm(false)
          setPulseToDelete(null)
        }}
        position="center"
      >
        <div className="relative z-10 w-full">
          <div className="glass-panel rounded-3xl p-5 sm:p-8 md:p-12 border border-gp-glass-border dark:border-white/10 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/20 dark:bg-red-500/10 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-red-500/20 dark:bg-red-500/10 rounded-full blur-[80px] translate-y-1/2 -translate-x-1/2 pointer-events-none" />

            <div className="flex flex-col items-center text-center relative z-10">
              <div className="mb-8 relative group">
                <div className="absolute inset-0 bg-red-500/30 rounded-full blur-xl" />
                <div className="size-16 rounded-full bg-linear-to-br from-red-100 to-red-50 dark:from-red-500/20 dark:to-red-500/10 border border-red-200 dark:border-red-500/30 flex items-center justify-center backdrop-blur-xl shadow-md dark:shadow-inner">
                  <span className="material-symbols-outlined text-3xl text-red-600 dark:text-red-400">
                    delete
                  </span>
                </div>
              </div>

              <h2 className="text-3xl md:text-4xl font-light dark:font-extralight text-gp-ink-strong dark:text-white mb-2 tracking-tight leading-tight">
                Delete Pulse
              </h2>
              <p className="text-sm mb-8">
                <span className="text-red-700 dark:text-red-400">
                  Are you sure? This action cannot be undone. The pulse will be
                  permanently deleted.
                </span>
              </p>

              <div className="flex gap-4 w-full">
                <button
                  onClick={() => {
                    setShowPulseDeleteConfirm(false)
                    setPulseToDelete(null)
                  }}
                  disabled={isPulseSubmitting}
                  className="flex-1 px-6 py-3 rounded-xl bg-gp-surface-soft dark:bg-gp-surface-strong text-gp-ink-strong dark:text-gp-ink-strong hover:bg-gp-surface-strong dark:hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDeletePulse}
                  disabled={isPulseSubmitting}
                  className="flex-1 px-6 py-3 rounded-xl bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isPulseSubmitting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </OfferingModal>

      <ResonanceLinkModal
        isOpen={isResonanceLinkModalOpen}
        onClose={() => {
          setIsResonanceLinkModalOpen(false)
          setResonanceSubmitError(null)
        }}
        pulses={pulses.map((pulse) => ({
          id: pulse.id,
          title: pulse.title,
          content: pulse.content,
          type:
            (pulse.__typename
              ?.replace('Pulse', '')
              .toLowerCase() as NodeType) || 'goal',
        }))}
        onSubmit={handleResonanceLinkSubmit}
        isLoading={isResonanceSubmitting}
      />

      {canEditContent && promiseWeaves.isModalOpen && (
        <PromiseWeaveModal
          // Mount controls open/close, and the key makes each open a fresh
          // instance — so an edit never shows the previous weave's values and a
          // create never inherits the last edit's.
          key={promiseWeaves.editingWeave?.id ?? 'new-weave'}
          onClose={promiseWeaves.closeModal}
          pulses={weavePulseOptions}
          people={weavePeopleOptions}
          editingWeave={promiseWeaves.editingWeave}
          onSubmit={promiseWeaves.submit}
          onDelete={promiseWeaves.remove}
          isSubmitting={promiseWeaves.isSubmitting}
        />
      )}

      <BulkPulseShareModal
        isOpen={isBulkShareModalOpen}
        onClose={() => {
          setIsBulkShareModalOpen(false)
        }}
        currentContextId={contextId}
        initialSelectedPulseIds={bulkInitialPulseIds}
        initialMode={bulkInitialMode}
        pulses={pulses.map((pulse) => ({
          id: pulse.id,
          title: pulse.title || '',
          content: pulse.content || '',
          type:
            (pulse.__typename
              ?.replace('Pulse', '')
              .toLowerCase() as NodeType) || 'goal',
        }))}
        onOperationComplete={async () => {
          toast.success('Pulse shared/moved successfully')
          setIsBulkShareModalOpen(false)
          await refetch()
        }}
      />

      <PersonPanel
        isOpen={isPersonPanelOpen}
        onClose={() => {
          setIsPersonPanelOpen(false)
          setSelectedPerson(null)
        }}
        person={selectedPerson}
        connectedPersons={[]}
        description={selectedPerson?.description ?? null}
        relationshipWhy={selectedPerson?.relationshipWhy ?? null}
        onRemoveFromField={handleRemovePersonFromField}
        isRemovingFromField={isRemovingPersonFromField}
        onPersonUpdated={() => {
          refetchFieldPeople()
        }}
      />

      <AddPersonToFieldModal
        isOpen={isAddPersonModalOpen}
        isSubmitting={isAddingPersonToField}
        onClose={() => setIsAddPersonModalOpen(false)}
        onCreatePerson={handleAddPersonToField}
      />

      <UploadDocumentModal
        key={uploadSessionKey}
        isOpen={isUploadDocumentModalOpen}
        isSubmitting={isUploadingDocument}
        onClose={() => setIsUploadDocumentModalOpen(false)}
        onSubmit={handleUploadDocument}
      />

      <MoveFieldModal
        isOpen={isMoveFieldModalOpen}
        onClose={() => setIsMoveFieldModalOpen(false)}
        contextId={contextId}
        contextTitle={context.title || 'Untitled field'}
        spaceId={spaceId}
        currentParentId={context.parentContext?.[0]?.id ?? null}
        excludedIds={(context.subContexts ?? []).map((sub) => sub.id)}
        onMoved={() => refetch()}
      />

      {isImportArticlesModalOpen && (
        <ImportArticlesModal
          isOpen
          fieldContextId={contextId}
          onClose={() => {
            setIsImportArticlesModalOpen(false)
            // A just-queued job should appear in the status section the
            // moment the modal hides, not a poll later.
            setImportStatusVersion((version) => version + 1)
            // Lets the studio action bar — which suppressed Radix's focus
            // restore so this dialog could take focus — put focus back on
            // its trigger (GOAL-328). No-op when opened from this page.
            emitImportArticlesModalClosed()
          }}
          onImported={() => {
            // Imported pulses land in the Pulses section; new/matched authors
            // land in the People section.
            void refetch()
            void refetchFieldPeople()
            setImportStatusVersion((version) => version + 1)
          }}
        />
      )}

      {spaceId ? (
        <ResonanceSuggestionsModal
          isOpen={isDiscoverModalOpen}
          onClose={() => setIsDiscoverModalOpen(false)}
          spaceId={spaceId}
          suggestions={resonanceSuggestions}
          loading={resonanceSuggestionsLoading}
          // Reviewing is open to every Space role, but CONFIRMING or REJECTING
          // needs canEditContent (kb/02-user-roles.md). The accept/decline
          // routes enforce that server-side, and the modal hides a control whose
          // handler is undefined — so omitting these for a GUEST is what stops
          // them being shown buttons that can only ever 403. Before GOAL-348 the
          // modal was unreachable without edit permission, so this gate had no
          // client-side counterpart to be missing.
          //
          // Accepting a suggestion writes a real ResonanceLink server-side, so
          // refetch the field details to surface it in the Resonances section.
          onAccept={
            canEditContent
              ? async (id) => {
                  await acceptSuggestion(id)
                  await refetch()
                }
              : undefined
          }
          onAcceptAll={
            canEditContent
              ? async (minConfidence) => {
                  const accepted = await acceptAllAboveConfidence(minConfidence)
                  // Newly-created ResonanceLinks surface in the Resonances
                  // section.
                  await refetch()
                  return accepted
                }
              : undefined
          }
          onDecline={canEditContent ? declineSuggestion : undefined}
          // The modal awaits onRefresh after EVERY accept / decline / bulk
          // accept, so this is the single place the badge needs re-counting —
          // duplicating it inside each handler above just doubled the request
          // (and the list refetch it rides along with) per reviewed card.
          onRefresh={async () => {
            await refetchSuggestions()
            await refetchPendingSuggestionCount()
          }}
        />
      ) : null}
    </div>
  )
}

const TopBarPill: FC<{
  icon: string
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'danger'
}> = ({ icon, label, onClick, disabled, variant = 'default' }) => {
  const isDanger = variant === 'danger'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 h-9 px-3 md:px-3.5 rounded-full border text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
        isDanger
          ? 'bg-red-500/10 dark:bg-red-500/15 border-red-400/30 dark:border-red-400/30 text-red-600 dark:text-red-300 hover:bg-red-500/20 dark:hover:bg-red-500/25 focus-visible:ring-red-400/60'
          : 'bg-white/60 dark:bg-white/5 border-white/50 dark:border-white/15 text-gp-ink-strong hover:bg-white/80 dark:hover:bg-white/10 focus-visible:ring-gp-primary/60'
      )}
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      <span className="hidden md:inline">{label}</span>
    </button>
  )
}

type StatAccent = 'primary' | 'goal' | 'care' | 'story' | 'resource'

const STAT_ACCENT: Record<StatAccent, string> = {
  primary: 'bg-gp-primary/15 text-gp-primary border-gp-primary/30',
  goal: 'bg-gp-goal/15 text-gp-goal border-gp-goal/30',
  care: 'bg-gp-care/15 text-gp-care border-gp-care/30',
  story: 'bg-gp-story/15 text-gp-story border-gp-story/30',
  resource: 'bg-gp-resource/15 text-gp-resource border-gp-resource/30',
}

const Stat: FC<{
  icon: string
  label: string
  value: string | number
  accent: StatAccent
}> = ({ icon, label, value, accent }) => (
  <div className="group flex items-center gap-2.5 rounded-xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/[0.04] px-2.5 py-2 text-left backdrop-blur-sm shadow-sm hover:bg-white/70 dark:hover:bg-white/[0.06] transition-colors">
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center size-7 rounded-lg border',
        STAT_ACCENT[accent]
      )}
    >
      <span className="material-symbols-outlined text-[15px]">{icon}</span>
    </span>
    <div className="min-w-0">
      <p className="text-base sm:text-lg font-bold text-gp-ink-strong tabular-nums leading-none">
        {value}
      </p>
      <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] font-semibold text-gp-ink-muted truncate">
        {label}
      </p>
    </div>
  </div>
)

const FieldContextSkeleton: FC = () => (
  <div className="relative flex h-full w-full overflow-hidden">
    <div className="absolute inset-0 pointer-events-none z-0">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.8),transparent_70%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.03),transparent_70%)]" />
      <div
        className="absolute top-[10%] left-[10%] w-125 h-125 rounded-full blur-[120px] animate-blob"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--gp-primary) 10%, transparent)',
        }}
      />
      <div
        className="absolute bottom-[10%] right-[10%] w-100 h-100 rounded-full blur-[100px] animate-blob [animation-delay:2s]"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--gp-accent-glow) 10%, transparent)',
        }}
      />
      <div
        className="absolute top-[40%] left-[60%] w-75 h-75 rounded-full blur-[100px] animate-blob [animation-delay:4s]"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--gp-goal) 10%, transparent)',
        }}
      />
    </div>
    <main className="flex-1 min-w-0 relative z-10 overflow-y-auto overflow-x-hidden scroller p-4 sm:p-8 pb-40">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="h-4 w-32 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
          <div className="flex items-center gap-2">
            <div className="h-9 w-20 md:w-24 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
            <div className="h-9 w-20 md:w-24 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
            <div className="h-9 w-20 md:w-24 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
          </div>
        </div>
        <div className="flex flex-col items-center gap-4 pt-1">
          <div className="size-14 rounded-2xl bg-white/30 dark:bg-white/5 animate-pulse" />
          <div className="h-4 w-32 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
          <div className="h-8 w-72 rounded-md bg-white/30 dark:bg-white/5 animate-pulse" />
          <div className="h-3 w-48 rounded-full bg-white/30 dark:bg-white/5 animate-pulse" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 max-w-3xl w-full mt-1">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-12 rounded-xl bg-white/30 dark:bg-white/5 animate-pulse"
              />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-32 rounded-2xl bg-white/30 dark:bg-white/5 border border-white/15 dark:border-white/10 animate-pulse"
            />
          ))}
          {[3, 4].map((i) => (
            <div
              key={i}
              className="md:col-span-2 h-44 rounded-2xl bg-white/30 dark:bg-white/5 border border-white/15 dark:border-white/10 animate-pulse"
            />
          ))}
        </div>
      </div>
    </main>
  </div>
)

const FieldContextError: FC<{
  /** When provided, renders the actual fetch error instead of the
   *  generic "not found" copy. Distinguishing the two cases is the
   *  whole point — empty-result and real-failure are different UX. */
  error?: unknown
  onRetry?: () => void
  onBack: () => void
}> = ({ error, onRetry, onBack }) => {
  const errorMessage = extractErrorMessage(error)
  const hasError = Boolean(error)

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div className="text-center space-y-4 max-w-lg px-6">
        <div className="size-14 mx-auto rounded-2xl border border-red-300/40 bg-red-500/15 flex items-center justify-center text-red-600 dark:text-red-300">
          <span className="material-symbols-outlined text-3xl">
            {hasError ? 'cloud_off' : 'error'}
          </span>
        </div>
        <div className="space-y-2">
          <h2 className="text-base font-bold text-gp-ink-strong">
            {hasError
              ? "We couldn't load this field context"
              : 'This field context is no longer available'}
          </h2>
          <p className="text-sm text-gp-ink-muted">
            {hasError
              ? 'Something went wrong while fetching the data. The details below may help diagnose the cause.'
              : 'It may have been deleted, or you no longer have access.'}
          </p>
        </div>
        {hasError && errorMessage && (
          <pre className="text-left text-[11px] leading-relaxed text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {errorMessage}
          </pre>
        )}
        <div className="flex flex-col sm:flex-row gap-2 justify-center pt-1">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center justify-center gap-2 px-4 h-9 rounded-full bg-gp-primary text-white text-xs font-semibold shadow-md shadow-gp-primary/20 hover:bg-gp-primary/90 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">
                refresh
              </span>
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center justify-center gap-2 px-4 h-9 rounded-full bg-white/40 dark:bg-white/10 border border-white/40 dark:border-white/15 text-xs font-semibold text-gp-ink-strong hover:bg-white/60 dark:hover:bg-white/20 transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">
              arrow_back
            </span>
            Back to dashboard
          </button>
        </div>
      </div>
    </div>
  )
}

// Pull the most useful diagnostic string out of whatever Apollo/JS gives
// us. ApolloError carries `graphQLErrors[].message` which is what makes
// schema/network failures actionable (e.g. "Cannot return null for
// non-nullable field ResonanceLink.label").
function extractErrorMessage(error: unknown): string | null {
  if (!error) return null
  if (typeof error === 'string') return error

  // ApolloError shape — graphQLErrors is the real signal.
  if (typeof error === 'object' && error !== null) {
    const apolloLike = error as {
      graphQLErrors?: Array<{ message?: string }>
      networkError?: { message?: string } | null
      message?: string
    }
    const graphQLMessages = apolloLike.graphQLErrors
      ?.map((gqlError) => gqlError.message)
      .filter(Boolean)
    if (graphQLMessages && graphQLMessages.length > 0) {
      return graphQLMessages.join('\n')
    }
    if (apolloLike.networkError?.message) {
      return apolloLike.networkError.message
    }
    if (apolloLike.message) return apolloLike.message
  }

  if (error instanceof Error) return error.message
  return null
}
