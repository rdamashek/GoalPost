'use client'

import { useState, type FC } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { Plus, PlusCircle, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GET_ALL_ME_SPACES } from '@/app/graphql/queries'
import { LOG_SPACE_ACTIVITY } from '@/app/graphql/mutations/ACTIVITY_LOG_MUTATIONS'
import { useApp, useFocalEntity } from '@/contexts'
import { CreateSpaceModal } from '@/components/canvas/create-space-modal'
import {
  emitOpenAddFieldContextModal,
  emitOpenAddPulseModal,
  emitOpenAddSpaceMembersModal,
} from '@/lib/simulation/pulse-creation-events'
import { useStudioCanvas, type CanvasView } from './studio-canvas-context'
import { routeHasCanvasScope } from './canvas-scope'
import { FieldContextUploadAction } from './field-context-upload-action'
import { NestedFieldAction } from './nested-field-action'
import { ResonanceSuggestionsAction } from './resonance-suggestions-action'
import { Divider, ViewToggle } from './canvas-view-toggle'

/**
 * Floating action bar pinned to the bottom-center of the canvas pane.
 *
 * The right-hand "create" cluster is contextual — it surfaces the
 * single action that makes sense at the user's current level:
 *  - Inside a FieldContext → Upload document + Add pulse + Add nested field
 *    (plus the review-suggestions entry, when any are pending)
 *  - Inside a Space (MeSpace/WeSpace) → Add field context
 *  - Anywhere else → Create MeSpace / WeSpace
 *
 * Context is read from focal-entity `source === 'route'` so a persisted
 * focal (set in localStorage / server for assistant continuity) doesn't
 * spill FieldContext-only actions onto neutral surfaces like the
 * top-level dashboard.
 */
export const StudioCanvasActionBar: FC = () => {
  const router = useRouter()
  const pathname = usePathname()
  const { canvasView, setCanvasView } = useStudioCanvas()
  const { focalEntity } = useFocalEntity()

  // `canvasView` is the sticky preference; the *effective* view is what the
  // canvas actually shows. On routes the bloom surface can't scope to
  // (persons, profile, settings, search) the canvas falls back to dashboard
  // for display, so the toggle highlights dashboard and Bloom is disabled
  // there — selecting it would be a no-op against the route.
  const scopeAvailable = routeHasCanvasScope(pathname)
  const effectiveView: CanvasView = scopeAvailable ? canvasView : 'dashboard'

  // Zoom controls apply to the Bloom Exploration NVL surface.
  const inGraphSurface = effectiveView === 'bloom'

  // Route-sourced focal is the only signal we trust here. Manual /
  // persisted focals are valid for assistant scope but don't imply the
  // matching page is mounted to receive open-modal events.
  const isRouteFocal = focalEntity?.source === 'route'
  const inFieldContext = isRouteFocal && focalEntity?.type === 'FieldContext'
  const inSpace =
    isRouteFocal &&
    (focalEntity?.type === 'MeSpace' || focalEntity?.type === 'WeSpace')

  const dispatchZoom = (action: 'in' | 'out' | 'fit') => {
    window.dispatchEvent(new CustomEvent(`goalpost:graph-zoom-${action}`))
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
      {/* Wraps rather than overflows: the in-field cluster is the widest case
          and the review entry (GOAL-348) pushes it past 390px on a phone.
          Wrapping stacks the bar upward from the bottom edge instead of
          clipping controls off the side. */}
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 md:gap-4">
        {inGraphSurface && (
          <div className="flex items-center gap-2 p-1.5 rounded-full gp-glass border border-gp-glass-border shadow-xl">
            {/* Zoom in/out are desktop affordances — on phones the canvas
                gestures cover them, and the bar must fit 390px alongside
                the in-field create cluster (GOAL-339). Fit-to-view stays:
                it's the recovery control when a member pans the cluster
                off-screen. */}
            <div className="hidden sm:flex items-center gap-2">
              <ZoomButton
                label="Zoom out"
                icon="remove"
                onClick={() => dispatchZoom('out')}
              />
              <Divider />
              <ZoomButton
                label="Zoom in"
                icon="add"
                onClick={() => dispatchZoom('in')}
              />
              <Divider />
            </div>
            <ZoomButton
              label="Fit to view"
              icon="fit_screen"
              onClick={() => dispatchZoom('fit')}
            />
          </div>
        )}

        <ViewToggle
          activeView={effectiveView}
          scopeAvailable={scopeAvailable}
          onChange={setCanvasView}
        />

        {/* Review before create: the suggestions waiting on this field are
            about content that already exists. Self-gates on a route-sourced
            FieldContext with a resolved Space and a non-zero pending count, so
            it costs nothing on every other surface — and unlike the in-page
            badge it is reachable from Bloom Exploration too (GOAL-348). */}
        <ResonanceSuggestionsAction />

        {/* Always mounted — the component self-gates on focal source and
            also keeps its own `pinnedFieldContextId` so an in-flight upload
            survives mid-flow navigation away from the FieldContext. */}
        <FieldContextUploadAction />

        {/* Always mounted for the same reason — an open create dialog
            survives mid-flow navigation via its pinned parent id
            (GOAL-339). */}
        <NestedFieldAction />

        {inFieldContext ? (
          <div className="flex items-center gap-2 md:gap-3">
            <PrimaryAddButton
              label="Add pulse"
              ariaLabel="Add pulse to this field context"
              iconTint="text-teal-600 dark:text-teal-300"
              onClick={() => emitOpenAddPulseModal(focalEntity!.id)}
            />
          </div>
        ) : inSpace ? (
          <SpaceActions spaceId={focalEntity!.id} />
        ) : (
          <DefaultActions router={router} />
        )}
      </div>
    </div>
  )
}

const SpaceActions: FC<{ spaceId: string }> = ({ spaceId }) => (
  <div className="flex items-center gap-2 md:gap-3">
    <PrimaryAddButton
      label="Add field context"
      ariaLabel="Add field context to this space"
      iconTint="text-teal-600 dark:text-teal-300"
      onClick={() => emitOpenAddFieldContextModal(spaceId)}
    />
    {/* MeSpace owners see this too — first member add auto-converts the
        space to a WeSpace per the addSpaceMember resolver. The dashboard
        view enforces the actual permission (owner-only) on mount. */}
    <SecondaryActionButton
      label="Add person"
      ariaLabel="Add a person to this space"
      icon={<UserPlus className="w-4 h-4" />}
      onClick={() => emitOpenAddSpaceMembersModal(spaceId)}
    />
  </div>
)

const DefaultActions: FC<{ router: ReturnType<typeof useRouter> }> = ({
  router,
}) => {
  // One MeSpace per user is a domain invariant (see kb/03-workflows.md and
  // kb/05-data-entities.md). Suppress the create-MeSpace shortcut once the
  // user has one; the @authorization filter only returns the caller's own
  // MeSpaces so this count is the right gate.
  const { data: meSpacesData } = useQuery(GET_ALL_ME_SPACES, {
    fetchPolicy: 'cache-and-network',
  })
  const canCreateMeSpace = (meSpacesData?.meSpaces?.length ?? 0) === 0

  const { user } = useApp()
  const apolloClient = useApolloClient()
  const [logSpaceActivity] = useMutation(LOG_SPACE_ACTIVITY)
  const [showCreateWeSpaceModal, setShowCreateWeSpaceModal] = useState(false)
  const [isCreatingWeSpace, setIsCreatingWeSpace] = useState(false)

  const handleCreateWeSpace = async ({ name }: { name: string }) => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Space name is required')
      return
    }
    if (!user?.id) {
      toast.error('You must be signed in to create a WeSpace')
      return
    }

    setIsCreatingWeSpace(true)
    try {
      const res = await fetch('/api/we-space/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, userId: user.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to create WeSpace')
        return
      }

      if (data.weSpace?.id) {
        logSpaceActivity({
          variables: {
            input: {
              action: 'created',
              spaceId: data.weSpace.id,
              spaceType: 'WeSpace',
              spaceName: trimmed,
            },
          },
        }).catch((err) => {
          console.error('Error logging space creation:', err)
        })
      }

      toast.success('WeSpace created')
      setShowCreateWeSpaceModal(false)
      // Drop the user straight into the space they just created — creating
      // one implies wanting to be in it.
      if (data.weSpace?.id) {
        router.push(`/protected/dashboard/space/${data.weSpace.id}`)
      }
      // Refresh active WeSpace lists (dashboard overview + WeSpace page) in
      // the background so they're current on return — don't block the
      // redirect on it.
      apolloClient
        .refetchQueries({ include: ['GetAllWeSpaces', 'GetUserWeSpaces'] })
        .catch((err) => console.error('Error refetching WeSpace lists:', err))
    } catch (err) {
      toast.error(
        `Failed to create WeSpace${err instanceof Error ? `: ${err.message}` : ''}`
      )
    } finally {
      setIsCreatingWeSpace(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 md:gap-3">
        {canCreateMeSpace && (
          <button
            type="button"
            onClick={() => router.push('/protected/dashboard')}
            className="gp-glass-hover cursor-pointer flex items-center gap-2 px-4 md:px-5 h-10 md:h-11 rounded-full gp-glass border border-gp-glass-border hover:border-gp-primary/40 hover:shadow-[0_0_50px_color-mix(in_srgb,var(--gp-primary)_35%,transparent)] transition-all group"
            aria-label="Create MeSpace"
          >
            {/* MeSpace amber. No `--gp-mespace` token exists, and amber-300 is
                ~1.4:1 on light glass, so the light value is a darker step. */}
            <PlusCircle className="w-5 h-5 text-amber-600 dark:text-amber-300 transition-colors" />
            <span className="hidden sm:inline text-sm font-semibold text-gp-ink-strong">
              MeSpace
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowCreateWeSpaceModal(true)}
          data-tour="create-wespace-button"
          className="gp-glass-hover cursor-pointer flex items-center gap-2 px-4 md:px-5 h-10 md:h-11 rounded-full gp-glass border border-gp-glass-border hover:border-gp-primary/40 hover:shadow-[0_0_50px_color-mix(in_srgb,var(--gp-primary)_35%,transparent)] transition-all group"
          aria-label="Create WeSpace"
        >
          {/* WeSpace teal — darker step in light mode, same rationale as above. */}
          <PlusCircle className="w-5 h-5 text-teal-600 dark:text-teal-300 transition-colors" />
          <span className="hidden sm:inline text-sm font-semibold text-gp-ink-strong">
            WeSpace
          </span>
        </button>
      </div>

      {showCreateWeSpaceModal && (
        <CreateSpaceModal
          isOpen={showCreateWeSpaceModal}
          onClose={() => setShowCreateWeSpaceModal(false)}
          onCreate={handleCreateWeSpace}
          isLoading={isCreatingWeSpace}
          title="Create New WeSpace"
          subtitle="Start a collaborative space with your community"
        />
      )}
    </>
  )
}

const PrimaryAddButton: FC<{
  label: string
  ariaLabel: string
  iconTint: string
  onClick: () => void
}> = ({ label, ariaLabel, iconTint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="gp-glass-hover cursor-pointer flex items-center gap-2 px-4 md:px-5 h-10 md:h-11 rounded-full gp-glass border border-gp-glass-border hover:border-gp-primary/40 hover:shadow-[0_0_50px_color-mix(in_srgb,var(--gp-primary)_35%,transparent)] transition-all group"
    aria-label={ariaLabel}
  >
    <Plus className={cn('w-5 h-5 transition-colors', iconTint)} />
    <span className="hidden sm:inline text-sm font-semibold text-gp-ink-strong">
      {label}
    </span>
  </button>
)

const SecondaryActionButton: FC<{
  label: string
  ariaLabel: string
  icon: React.ReactNode
  onClick: () => void
}> = ({ label, ariaLabel, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    title={label}
    // `.gp-menu-item` owns the color + hover tint (a themed --gp-primary wash)
    // so the affordance is visible on light glass, dark glass, and every theme
    // variant. Hand-rolled `hover:bg-gp-ink-strong/10` was near-invisible on a
    // near-white surface — see the design skill's menu/popover note.
    className="gp-menu-item cursor-pointer flex items-center gap-2 px-3 md:px-4 h-10 md:h-11 rounded-full"
  >
    {icon}
    <span className="hidden sm:inline text-sm font-medium">{label}</span>
  </button>
)

const ZoomButton: FC<{
  label: string
  icon: string
  onClick: () => void
}> = ({ label, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="gp-menu-item cursor-pointer size-9 md:size-10 flex items-center justify-center rounded-full"
  >
    <span className="material-symbols-outlined">{icon}</span>
  </button>
)
