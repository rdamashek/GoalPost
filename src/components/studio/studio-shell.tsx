'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { cn } from '@/lib/utils'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import {
  AssistantChatTransport,
  useChatRuntime,
} from '@assistant-ui/react-ai-sdk'
import type { UIMessage } from 'ai'
import {
  NavigationHistoryProvider,
  useFocalEntity,
  useNavigationHistory,
} from '@/contexts'
import { usePreferences } from '@/contexts/preferences-context'
import type { FocalEntity } from '@/lib/focal-entity/types'
import { routeHasCanvasScope } from './canvas-scope'
import {
  LANDING_THREAD_KEY,
  mountedThreadIdFor,
  resolveOutgoingThreadId,
  shouldSkipHydration,
} from './chat-thread-selection'
import {
  createConversationThread,
  fetchHydratedThread,
  type HydratedThread,
} from '@/lib/simulation/conversation-thread-client'
import {
  emitAssistantThreadUpdated,
  emitAssistantGraphDataChanged,
  emitAssistantMessageSent,
  onOpenAssistantThread,
} from '@/lib/simulation/assistant-panel-events'
import { CanvasGraphSync } from './canvas-graph-sync'
import { TourController } from '@/components/onboarding/TourController'
import { TourOverlay } from '@/components/onboarding/TourOverlay'
import {
  StudioCanvasProvider,
  useStudioCanvas,
  type CanvasView,
} from './studio-canvas-context'
import { BloomOverlayProvider } from './bloom-overlay-context'
import {
  VisibleEntitiesProvider,
  useVisibleEntities,
} from './visible-entities-context'
import { StudioChrome } from './studio-chrome'
import { CanvasHost } from './canvas-host'
import { ChatHost } from './chat-host'
import { FloatingChatTrigger } from './floating-chat-trigger'
import { FloatingChatPanel } from './floating-chat-panel'
import {
  ApprovalActionProvider,
  type ApprovalAction,
} from '@/components/chat/approval-action-context'

const EMPTY_MESSAGES: UIMessage[] = []

export interface StudioShellProps {
  children: ReactNode
}

/**
 * The studio is the protected layout. A primary chat surface sits on the
 * right; a togglable canvas on the left hosts the active route content
 * (dashboard cards, pulse detail, graph, etc.). Either side can be
 * fullscreened.
 */
export const StudioShell: FC<StudioShellProps> = ({ children }) => {
  return (
    <NavigationHistoryProvider>
      <StudioCanvasProvider>
        <BloomOverlayProvider>
          <VisibleEntitiesProvider>
            <StudioBody>{children}</StudioBody>
          </VisibleEntitiesProvider>
        </BloomOverlayProvider>
      </StudioCanvasProvider>
    </NavigationHistoryProvider>
  )
}

const StudioBody: FC<{ children: ReactNode }> = ({ children }) => {
  const {
    canvasOpen,
    chatOpen,
    fullscreenSide,
    chatLayout,
    floatingChatOpen,
    setCanvasOpen,
    setChatOpen,
    toggleCanvas,
    toggleFullscreen,
    exitFullscreen,
    toggleFloatingChat,
    setFloatingChatOpen,
  } = useStudioCanvas()
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  // A thread we just created client-side is known to be empty, so opening it
  // must not trigger a hydration fetch or a loading flash — the chat runtime
  // mounts straight into an empty conversation. We track only the single most
  // recently created thread; it's cleared once a mount has consumed the hint
  // (see `consumeFreshThread`) so re-selecting it later — after it has
  // accumulated turns — hydrates normally.
  const [freshThreadId, setFreshThreadId] = useState<string | null>(null)
  // GOAL-345: the chat runtime's remount key, and the thread it mounts against.
  // It tracks *explicit* thread selection only — 'new' means the empty landing
  // conversation every initial load starts on.
  //
  // This is deliberately separate from `selectedThreadId`, which is only what
  // the sidebar/switcher highlights. When the landing conversation lazily
  // creates its thread on the first send, the shell adopts that id for
  // highlighting (`adoptLazyThread`) but must NOT re-key or re-prop the
  // boundary: doing so would tear the runtime down mid-stream and lose the
  // message the member just sent.
  const [threadKey, setThreadKey] = useState(LANDING_THREAD_KEY)
  const selectThread = useCallback(
    (id: string | null, opts?: { isNew?: boolean }) => {
      if (id && opts?.isNew) setFreshThreadId(id)
      setSelectedThreadId(id)
      setThreadKey(id ?? LANDING_THREAD_KEY)
    },
    []
  )
  const consumeFreshThread = useCallback((id: string) => {
    setFreshThreadId((current) => (current === id ? null : current))
  }, [])
  // The empty landing conversation created its thread on the first send. Adopt
  // the id so the thread list highlights it, leaving `threadKey` untouched so
  // the in-flight runtime survives — see the note above.
  const adoptLazyThread = useCallback((id: string) => {
    setSelectedThreadId((current) => current ?? id)
  }, [])
  // Both docked panels stay mounted at all times; fullscreen/closed states are
  // expressed by *collapsing* a panel rather than swapping the layout tree.
  // That keeps the chat runtime (and the canvas route) alive across every
  // fullscreen toggle — only a thread switch remounts the chat, and only the
  // chat, because the runtime boundary lives inside the chat panel.
  const chatPanelRef = useRef<ImperativePanelHandle>(null)
  const canvasPanelRef = useRef<ImperativePanelHandle>(null)
  const pathname = usePathname()

  // Content routes other than the dashboard root only ever render through the
  // dashboard canvas surface. When the user navigates to one, make sure the
  // canvas is open and un-fullscreened — otherwise the page is hidden behind a
  // closed canvas or a fullscreened chat and the route appears to do nothing.
  //
  // We deliberately do NOT force the canvas *view* back to 'dashboard' here:
  // `canvasView` is a sticky user preference (persisted in
  // studio-canvas-context). Drilling space → field → pulse must keep whatever
  // view the user was already in, and even routes with no graph representation
  // (persons, profile, settings, search) must not clobber the stored
  // preference — `CanvasHost` falls back to the dashboard view for *display*
  // on those routes via `routeHasCanvasScope`, so returning to a Space /
  // FieldContext restores the user's graph/bloom view intact.
  useEffect(() => {
    if (pathname === '/protected/dashboard') return
    setCanvasOpen(true)
    exitFullscreen()
  }, [pathname, setCanvasOpen, exitFullscreen])

  // Below this breakpoint the studio shows only one surface at a time. The
  // canvas takes priority when open; the user closes it to access chat.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 767px)')
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Effective layout: mobile always forces 'floating', regardless of the
  // user's stored desktop preference.
  const effectiveLayout: 'docked' | 'floating' = isMobile
    ? 'floating'
    : chatLayout

  // Open the canvas whenever an external caller wants the assistant to
  // jump into a particular thread or surface — keeps the workflow visible.
  // Doc-ingestion (GOAL-235) emits this with a threadId after upload so the
  // assistant runtime hydrates into the freshly created ingest thread; if
  // the chat is in floating mode we also pop it open so the user actually
  // sees it.
  useEffect(() => {
    return onOpenAssistantThread(({ threadId }) => {
      // `selectThread` (not a bare setter) so the runtime is re-keyed and the
      // ingest thread actually hydrates — from the empty landing conversation
      // the key would otherwise stay 'new' and the panel would show nothing.
      if (threadId) selectThread(threadId)
      setCanvasOpen(true)
      // Whichever layout is active, the assistant has to actually become
      // visible: without this the docked panel stays collapsed at zero width
      // and the requested thread hydrates where nobody can see it, so the
      // doc-ingest flow (GOAL-235) looks like it silently did nothing.
      setChatOpen(true)
      if (effectiveLayout === 'floating') setFloatingChatOpen(true)
    })
  }, [
    setCanvasOpen,
    setChatOpen,
    setFloatingChatOpen,
    effectiveLayout,
    selectThread,
  ])

  // Keyboard shortcuts.
  //   C   → toggle canvas (docked only)
  //   F   → fullscreen the active side (docked) / toggle floating chat
  //   Esc → exit fullscreen / close floating chat
  //   V   → toggle composer mic (forwarded to chat composer)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }

      if (effectiveLayout === 'docked' && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        toggleCanvas()
        return
      }

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        if (effectiveLayout === 'floating') {
          toggleFloatingChat()
        } else if (!chatOpen) {
          // Chat hidden (GOAL-313): the canvas is already the whole studio, so
          // there is no second pane to fullscreen. Treat F as "give me the
          // assistant back" rather than a silent no-op — otherwise the most
          // obvious key to press does nothing at all in this state.
          setChatOpen(true)
        } else {
          toggleFullscreen(canvasOpen ? 'canvas' : 'chat')
        }
        return
      }

      if (e.key === 'Escape') {
        if (effectiveLayout === 'floating' && floatingChatOpen) {
          e.preventDefault()
          setFloatingChatOpen(false)
          return
        }
        if (fullscreenSide !== null) {
          e.preventDefault()
          exitFullscreen()
          return
        }
      }

      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('goalpost:voice-mic-toggle'))
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    effectiveLayout,
    canvasOpen,
    chatOpen,
    fullscreenSide,
    floatingChatOpen,
    toggleCanvas,
    toggleFullscreen,
    exitFullscreen,
    toggleFloatingChat,
    setChatOpen,
    setFloatingChatOpen,
  ])

  // The canvas renders the active route and lives OUTSIDE the assistant
  // runtime boundary: nothing in the canvas tree consumes the chat runtime, so
  // it must never be torn down just because the user switched chat threads.
  const canvasNode = (
    <CanvasHost fullscreen={fullscreenSide === 'canvas'}>{children}</CanvasHost>
  )

  // The runtime boundary is keyed by thread so switching threads re-hydrates
  // the conversation. By wrapping ONLY the chat surface (not the whole body),
  // a thread switch remounts just the chat — the canvas stays put and the
  // loading state is scoped to the chat panel instead of the whole screen.
  //
  // GOAL-345: every initial load lands on an empty conversation. `threadKey`
  // starts at 'new', so there is no thread to mount against and nothing is
  // replayed — the member's previous threads stay one tap away in the switcher
  // rather than being restored on top of them.
  const mountedThreadId = mountedThreadIdFor(threadKey)
  const skipHydration = shouldSkipHydration(mountedThreadId, freshThreadId)

  const chatNode = (
    // `inert` while hidden: a collapsed Panel is only zero-width with
    // `overflow: hidden`, so without this the composer, send button and thread
    // rows stay focusable and screen-reader-visible — tabbing off the canvas
    // would walk into a chat the user deliberately dismissed.
    <div className="relative h-full w-full" inert={!chatOpen}>
      <AssistantRuntimeBoundary
        key={threadKey}
        threadId={mountedThreadId}
        skipHydration={skipHydration}
        onConsumeFresh={consumeFreshThread}
        onThreadCreated={adoptLazyThread}
      >
        <ChatHost
          fullscreen={fullscreenSide === 'chat'}
          selectedThreadId={selectedThreadId}
          onSelectThread={selectThread}
          compact={isMobile}
        />
      </AssistantRuntimeBoundary>
    </div>
  )

  // Reconcile the docked panels with the fullscreen/closed state by collapsing
  // one panel instead of unmounting it. Runs after layout/state changes; no-op
  // in floating layout (the panels aren't mounted there).
  const isDocked = effectiveLayout !== 'floating'
  useEffect(() => {
    if (!isDocked) return
    const chat = chatPanelRef.current
    const canvas = canvasPanelRef.current
    if (!chat || !canvas) return
    if (fullscreenSide === 'canvas' || !chatOpen) {
      chat.collapse()
      canvas.expand()
    } else if (fullscreenSide === 'chat' || !canvasOpen) {
      canvas.collapse()
      chat.expand()
    } else {
      chat.expand()
      canvas.expand()
    }
  }, [isDocked, fullscreenSide, canvasOpen, chatOpen])

  const mainView = (() => {
    // Floating layout (desktop pref OR mobile): canvas always takes the full
    // viewport; chat is summoned via the floating trigger.
    if (effectiveLayout === 'floating') return canvasNode

    // Docked: both panels stay mounted; fullscreen/closed states collapse a
    // panel (see the effect above) so neither the chat runtime nor the canvas
    // route is torn down when the user toggles fullscreen.
    const hideHandle = fullscreenSide !== null || !canvasOpen || !chatOpen
    return (
      <PanelGroup
        direction="horizontal"
        autoSaveId="goalpost.studio.chat35-canvas65.v1"
        className="h-full w-full"
      >
        <Panel
          ref={chatPanelRef}
          defaultSize={35}
          minSize={20}
          collapsible
          collapsedSize={0}
          order={1}
        >
          {chatNode}
        </Panel>
        <PanelResizeHandle
          className={cn(
            'w-1.5 bg-gp-glass-border hover:bg-gp-primary/40 transition-colors data-[resize-handle-state=drag]:bg-gp-primary/60 cursor-col-resize',
            hideHandle && 'hidden'
          )}
        />
        <Panel
          ref={canvasPanelRef}
          defaultSize={65}
          minSize={25}
          collapsible
          collapsedSize={0}
          order={2}
        >
          {canvasNode}
        </Panel>
      </PanelGroup>
    )
  })()

  // `h-dvh` (dynamic viewport height), not `h-screen`/`100vh`: on mobile
  // browsers `100vh` is measured *including* the area behind the bottom browser
  // toolbar, so on load (toolbar at full height) the bottom strip of the studio
  // — the last content row and the floating action bar — is hidden behind the
  // chrome until it collapses on scroll (GOAL-303). `dvh` tracks the *visible*
  // viewport, so the app always fits. On desktop dvh === vh, so no change there.
  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-gp-surface dark:bg-gp-surface-dark">
      <CanvasGraphSync />
      <StudioChrome />

      <div className="relative flex-1 overflow-hidden">
        {mainView}

        {/* Docked layout with the chat hidden (GOAL-313): the same glass pill
            the floating layout uses, wired to bring the docked panel back.
            The panel is only *collapsed*, so restoring it lands the user in
            the thread they left — no remount, no re-hydration. */}
        {effectiveLayout === 'docked' && (
          <FloatingChatTrigger
            hidden={chatOpen}
            onOpen={() => setChatOpen(true)}
            label="Show chat"
          />
        )}

        {effectiveLayout === 'floating' && (
          <>
            {/* The trigger needs no runtime — keep it outside the boundary so
                it stays mounted while the chat thread re-hydrates. */}
            <FloatingChatTrigger
              hidden={floatingChatOpen}
              onOpen={toggleFloatingChat}
              label="Open chat"
            />
            {/* Show the scoped loading spinner only while the mobile
                (fullViewport) panel is OPEN. Mobile now surfaces a thread
                switcher (GOAL-312), so selecting a previous thread re-keys this
                boundary and re-hydrates; without an overlay it would return null
                and the fullscreen panel would blank out, flashing the canvas
                behind it. When the panel is closed (background hydration on load)
                or in the desktop corner-panel layout, keep it null so the
                spinner never covers the canvas. */}
            <AssistantRuntimeBoundary
              key={threadKey}
              threadId={mountedThreadId}
              skipHydration={skipHydration}
              onConsumeFresh={consumeFreshThread}
              onThreadCreated={adoptLazyThread}
              showLoadingOverlay={floatingChatOpen && isMobile}
            >
              <FloatingChatPanel
                fullViewport={isMobile}
                selectedThreadId={selectedThreadId}
                onSelectThread={selectThread}
              />
            </AssistantRuntimeBoundary>
          </>
        )}
      </div>

      <TourController />
      <TourOverlay />
    </div>
  )
}

/**
 * Mounts the AI runtime for the chat surface. Fetches the persisted
 * conversation thread first so messages hydrate before the runtime is
 * created (`useChatRuntime` reads `messages` only at init).
 *
 * With no `threadId` this is the empty landing conversation every initial load
 * opens on (GOAL-345). Nothing is fetched, and the thread is created lazily on
 * the first send — see `resolveBody`.
 */
const AssistantRuntimeBoundary: FC<{
  children: ReactNode
  threadId?: string
  /**
   * Skip the hydration fetch and mount straight into an empty conversation.
   * Set for threads we just created client-side — they have no turns yet, so
   * fetching them is wasted work and the loading flash is pure noise.
   */
  skipHydration?: boolean
  /**
   * Called once, at mount, after a `skipHydration` mount has consumed the
   * hint — lets the parent forget the thread is "fresh" so re-selecting it
   * later (once it has turns) hydrates normally.
   */
  onConsumeFresh?: (threadId: string) => void
  /**
   * Called with the id of the thread lazily created for the empty landing
   * conversation's first send, so the parent can highlight it in the thread
   * list. The parent must not re-key this boundary in response — that would
   * tear down the runtime mid-stream.
   */
  onThreadCreated?: (threadId: string) => void
  /**
   * Render the loading state as an absolute overlay that fills the nearest
   * positioned ancestor. True for the docked chat panel (the overlay is
   * scoped to the panel); false for the floating panel, where the chat is
   * a closed slide-out during initial load and an overlay would cover the
   * canvas behind it.
   */
  showLoadingOverlay?: boolean
}> = ({
  children,
  threadId,
  skipHydration = false,
  onConsumeFresh,
  onThreadCreated,
  showLoadingOverlay = true,
}) => {
  const { aiMode } = usePreferences()
  const { sessionContext } = useFocalEntity()
  const { canvasView } = useStudioCanvas()
  const { entities: visibleEntities } = useVisibleEntities()
  const { history: navigationHistory } = useNavigationHistory()
  const pathname = usePathname()

  // What the canvas actually shows the user — the stored `canvasView`
  // preference falls back to 'dashboard' on routes the graph/bloom surfaces
  // can't scope to (persons, profile, settings, search). The assistant's
  // SESSION CONTEXT must reflect this *effective* view, not the raw
  // preference, so it never tells the user they're "in the graph" while the
  // canvas is showing a dashboard page. Mirrors `CanvasHost`'s effective-view.
  const effectiveCanvasView: CanvasView = routeHasCanvasScope(pathname)
    ? canvasView
    : 'dashboard'

  const sessionContextRef = useRef(sessionContext)
  useEffect(() => {
    sessionContextRef.current = sessionContext
  }, [sessionContext])

  // Mirror the canvas snapshot into refs so `resolveBody` (called by
  // assistant-ui at submit time, outside React's render cycle) reads
  // the latest values without forcing a transport rebuild every time
  // the user clicks a node.
  const canvasViewRef = useRef(effectiveCanvasView)
  useEffect(() => {
    canvasViewRef.current = effectiveCanvasView
  }, [effectiveCanvasView])
  const visibleEntitiesRef = useRef(visibleEntities)
  useEffect(() => {
    visibleEntitiesRef.current = visibleEntities
  }, [visibleEntities])
  const navigationHistoryRef = useRef(navigationHistory)
  useEffect(() => {
    navigationHistoryRef.current = navigationHistory
  }, [navigationHistory])

  const lastSentFocalRef = useRef<FocalEntity | null>(null)
  // One-shot approved write action (GOAL-261). Set when the user clicks Approve
  // on an inline HITL card; read and cleared by resolveBody so it rides exactly
  // one outgoing turn, then the backend executes it verbatim.
  const pendingExecuteActionRef = useRef<ApprovalAction[] | null>(null)
  // Set true by resolveBody whenever the outgoing turn carries approved
  // writes; read-and-cleared by the runtime's onFinish to decide whether to
  // refetch the canvas (so newly created entities surface on the right).
  const turnHadWriteRef = useRef(false)
  // GOAL-345: the thread this runtime lazily created for the empty landing
  // conversation. Survives every send within the mount so turn 2 onwards land
  // in the same thread as turn 1.
  const lazyThreadIdRef = useRef<string | null>(null)

  // Async by design: the transport awaits `body` (AI SDK `Resolvable`), which
  // is what lets the empty landing conversation create its thread immediately
  // before dispatch rather than on page load.
  const resolveBody = useCallback(async () => {
    const snapshot = sessionContextRef.current
    const focalEntity = snapshot.focalEntity
    const previousFocalEntity = lastSentFocalRef.current
    lastSentFocalRef.current = focalEntity

    // The landing conversation has no thread yet. Create one now so the turn
    // carries an explicit id: `appendConversationTurn` with no threadId MERGEs
    // onto the member's implicit ownerId-keyed thread, which would silently
    // bury this message in their oldest conversation's history while the panel
    // shows only the message they just typed.
    //
    // If creation fails (offline, expired session) we fall through with no id
    // rather than dropping the member's message — the request itself is very
    // likely to fail too, and the legacy implicit-thread path is the safer of
    // two bad outcomes.
    let { threadId: outgoingThreadId } = resolveOutgoingThreadId({
      mountedThreadId: threadId,
      lazyThreadId: lazyThreadIdRef.current,
    })
    if (!outgoingThreadId) {
      const created = await createConversationThread()
      if (created) {
        lazyThreadIdRef.current = created
        outgoingThreadId = created
        onThreadCreated?.(created)
      }
    }

    return {
      aiMode,
      currentUserId: snapshot.currentUserId,
      spaceId: snapshot.activeSpaceId,
      fieldContextId: snapshot.activeFieldContextId,
      // Phase 1a: forward the names the client already knows so the chat route
      // can skip its server-side Neo4j name resolve. Cosmetic-only (phrasing,
      // not authz); the route falls back to the DB when any present id lacks a
      // hint, so partial/empty hints are always safe.
      sessionNames: {
        currentUserName: snapshot.currentUserName,
        spaceName: snapshot.activeSpaceName,
        spaceType: snapshot.activeSpaceType,
        fieldContextTitle: snapshot.activeFieldContextTitle,
        spaceOwnedByCurrentUser: snapshot.activeSpaceOwnedByCurrentUser,
      },
      threadId: outgoingThreadId,
      focalEntity: focalEntity
        ? {
            type: focalEntity.type,
            id: focalEntity.id,
            label: focalEntity.label,
          }
        : null,
      previousFocalEntity:
        previousFocalEntity &&
        (!focalEntity ||
          previousFocalEntity.id !== focalEntity.id ||
          previousFocalEntity.type !== focalEntity.type)
          ? {
              type: previousFocalEntity.type,
              id: previousFocalEntity.id,
              label: previousFocalEntity.label,
            }
          : null,
      canvasView: canvasViewRef.current,
      canvasVisibleEntities: visibleEntitiesRef.current,
      navigationHistory: navigationHistoryRef.current
        .filter((entry) => Boolean(entry.label))
        .map((entry) => ({
          type: entry.type,
          id: entry.id,
          label: entry.label,
          visitedAt: entry.visitedAt,
        })),
      // Read-and-clear: queued approvals ride exactly one request, then the
      // ref resets so subsequent turns never re-execute them (mirrors the
      // lastSentFocalRef mutation pattern above). Always an array — a single
      // approval is a one-element batch; multi-select accept sends N together.
      executeActions: (() => {
        const actions = pendingExecuteActionRef.current
        pendingExecuteActionRef.current = null
        // Remember that this turn approved a write so onFinish can refetch the
        // canvas once the server-side mutation has landed.
        if (actions && actions.length > 0) turnHadWriteRef.current = true
        return actions
      })(),
    }
  }, [aiMode, threadId, onThreadCreated])

  // Capture `skipHydration` at mount. The boundary is keyed by thread, so every
  // thread gets a fresh mount with the right value; reading it from a ref keeps
  // the fetch effect from re-running when the parent clears the "fresh" hint.
  const skipHydrationRef = useRef(skipHydration)
  const [hydration, setHydration] = useState<
    | { status: 'loading' }
    | { status: 'ready'; thread: HydratedThread | null }
  >(skipHydration ? { status: 'ready', thread: null } : { status: 'loading' })

  useEffect(() => {
    if (skipHydrationRef.current || !threadId) {
      // Empty conversation — nothing to fetch. Either a thread we just created
      // (let the parent forget it's fresh, so a later re-selection once it has
      // turns hydrates normally) or the landing state, which has no thread at
      // all until the first send creates one.
      if (threadId) onConsumeFresh?.(threadId)
      return
    }
    const controller = new AbortController()
    fetchHydratedThread(threadId, controller.signal).then((thread) => {
      if (controller.signal.aborted) return
      setHydration({ status: 'ready', thread })
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  if (hydration.status === 'loading') {
    if (!showLoadingOverlay) return null
    return (
      // `z-50` matches the floating panel's own stacking level: in the mobile
      // floating layout this overlay shares a stacking context with the canvas
      // `<main class="z-10">`, so without an explicit z-index (auto → 0) the
      // dashboard paints over the spinner and the panel appears to flash the
      // canvas mid thread-switch. In the docked layout the overlay is alone in
      // its panel, so the raised z-index is a harmless no-op there.
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-gp-surface dark:bg-gp-surface-dark">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gp-ink-soft/40" />
      </div>
    )
  }

  return (
    <AssistantRuntimeInner
      initialMessages={hydration.thread?.messages ?? EMPTY_MESSAGES}
      resolveBody={resolveBody}
      pendingActionRef={pendingExecuteActionRef}
      turnHadWriteRef={turnHadWriteRef}
    >
      {children}
    </AssistantRuntimeInner>
  )
}

interface AssistantRuntimeInnerProps {
  initialMessages: UIMessage[]
  resolveBody: () => Promise<Record<string, unknown>>
  pendingActionRef: MutableRefObject<ApprovalAction[] | null>
  turnHadWriteRef: MutableRefObject<boolean>
  children: ReactNode
}

const AssistantRuntimeInner: FC<AssistantRuntimeInnerProps> = ({
  initialMessages,
  resolveBody,
  pendingActionRef,
  turnHadWriteRef,
  children,
}) => {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: '/api/chat/simulation',
        body: resolveBody,
      }),
    [resolveBody]
  )

  const runtime = useChatRuntime({
    transport,
    messages: initialMessages,
    onFinish: () => {
      emitAssistantThreadUpdated()
      // If this turn approved a graph write, the server-side mutation has now
      // landed — refetch the canvas so the new entities appear on the right.
      if (turnHadWriteRef.current) {
        turnHadWriteRef.current = false
        emitAssistantGraphDataChanged()
      }
    },
  })

  // Wake the threads sidebar the moment the user clicks send / hits Enter.
  // `composer.send` fires synchronously on submit — earlier than `runStart`
  // (which only fires once assistant-ui has finished building the request),
  // and far earlier than `onFinish` (which waits for the full stream to
  // complete, leaving the sidebar stuck on "No conversations yet" for 5–10s
  // while the user's message bubble is already visible). The chat route
  // persists the user turn fire-and-forget at request-start, so 600ms is
  // enough headroom for the Neo4j write to land before the refetch hits;
  // the sidebar's existing +2.5s retry catches any final state.
  useEffect(() => {
    const unsubscribe = runtime.thread.composer.unstable_on('send', () => {
      // Collapse the threads sidebar into focus mode the moment a question is
      // asked (fires immediately, ahead of the 600ms thread-list refetch).
      emitAssistantMessageSent()
      window.setTimeout(emitAssistantThreadUpdated, 600)
    })
    return () => unsubscribe()
  }, [runtime])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ApprovalActionProvider pendingActionRef={pendingActionRef}>
        {children}
      </ApprovalActionProvider>
    </AssistantRuntimeProvider>
  )
}
