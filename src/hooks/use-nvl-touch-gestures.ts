'use client'

import { useCallback, useEffect, useRef, type RefObject } from 'react'

interface Point {
  x: number
  y: number
}

/** State captured when a one-finger pan begins, so each move resolves the pan
 *  absolutely from the gesture's start rather than from the previous frame. */
interface PanAnchor {
  /** NVL pan (world coords) at gesture start. */
  panX: number
  panY: number
  /** Touch position (client/CSS px) at gesture start. */
  clientX: number
  clientY: number
  /** NVL scale at gesture start (a one-finger pan can't also zoom). */
  scale: number
}

/** State captured when a one-finger node drag begins. */
interface NodeDragAnchor {
  /** The node being dragged. */
  id: string
  /** Node position (NVL world coords) at gesture start. */
  worldX: number
  worldY: number
  /** Touch position (client/CSS px) at gesture start. */
  clientX: number
  clientY: number
  /**
   * NVL scale at gesture start. A one-finger drag can't zoom itself, so this
   * is stable for the gesture in practice — same assumption the pan anchor
   * above makes.
   */
  scale: number
  /** Flips true once the finger has travelled far enough to be a drag, not a tap. */
  moved: boolean
}

/** One node hit returned by NVL's `getHits`. */
interface NvlNodeHit {
  data?: { id?: string | number }
  /** The node's own position in NVL world coordinates. */
  targetCoordinates?: { x: number; y: number }
}

/** Minimal shape of the hit-test result we read from NVL's `getHits`. */
interface NvlHitResult {
  nvlTargets?: {
    nodes?: NvlNodeHit[]
    relationships?: unknown[]
  }
}

/**
 * The slice of an NVL instance (or our structural `NvlRefHandle`) this hook
 * drives. Both the raw `@neo4j-nvl` instance (NvlCanvas) and the studio's
 * `NvlRefHandle` (GraphVisualizer) expose these, so the hook is agnostic to
 * which one it's handed. All methods are optional and feature-detected so an
 * older/partial handle simply no-ops the gesture rather than throwing.
 */
interface TouchableNvl {
  getScale?: () => number
  setZoom?: (zoom: number) => void
  getPan?: () => Point
  setPan?: (panX: number, panY: number) => void
  getHits?: (
    evt: { clientX: number; clientY: number },
    targets?: ('node' | 'relationship')[]
  ) => NvlHitResult
  /**
   * Moves nodes in world space. `pinned` is what stops the force simulation
   * from dragging a dropped node back to where it was.
   */
  setNodePositions?: (
    positions: Array<{ id: string; x: number; y: number; pinned?: boolean }>,
    updateLayout?: boolean
  ) => void
}

interface UseNvlTouchGesturesOptions {
  /** Ref holding the live NVL instance / handle to drive. */
  nvlRef: RefObject<TouchableNvl | null>
  /** Reports the scale NVL actually settled on after each pinch step. */
  onScaleChange?: (scale: number) => void
}

// Below this ratio change we treat a pinch frame as resting-finger jitter.
const PINCH_JITTER = 0.005

// How far (CSS px) a finger must travel off a node before we call it a drag
// rather than a tap. Below this the gesture stays a tap and still drills /
// opens the drawer; above it we take the gesture and move the node.
//
// Deliberately small. NVL's mouse equivalent (`isDraggingMovement`) is
// effectively √10 ≈ 3.2px — its `DRAG_THRESHOLD = 10` is compared against a
// SQUARED distance — and browsers cancel the synthesized click somewhere
// around 8–15px of tap slop. A threshold above that slop window would open a
// dead band where a small wobble on a node neither drills nor drags, so we sit
// below it, close to the mouse.
const NODE_DRAG_THRESHOLD = 5

/**
 * Bridge touch gestures into NVL on touch devices (iPad / phones):
 *   - **Two fingers** → pinch-to-zoom (NVL's built-in zoom only listens to
 *     `wheel`, which touch never emits, so without this pinch zoom is dead).
 *   - **One finger on a node** → drag that node to a new position (GOAL-351).
 *     NVL's `DragNodeInteraction` is mouse-only (`mousedown`/`mousemove`), so
 *     on touch a node could not be moved at all — the finger did nothing,
 *     because the pan below correctly refuses to hijack a node gesture.
 *   - **One finger on empty canvas** → pan the viewport. NVL pans on mouse
 *     drag but does not translate a single-finger touch drag into a pan, so
 *     on touch the canvas is stuck unless you have a trackpad/Pencil.
 *
 * A one-finger drag that starts on a *relationship* is still left alone, so
 * edge interactions keep working and we never hijack them into a pan
 * (GOAL-276 acceptance criteria).
 *
 * We keep NVL as the single source of truth for the viewport transform: pinch
 * drives `setZoom()` and pan drives `setPan()` (no DOM transforms of our own).
 * Node drags go through NVL's own `setNodePositions(..., pinned: true)` — the
 * same call its mouse handler makes — so a dropped node holds its place
 * instead of being pulled back by the force simulation.
 *
 * Returns a **callback ref** to spread onto the element wrapping the NVL
 * canvas. A callback ref (rather than a plain ref + effect) is deliberate: the
 * surface element is often rendered conditionally (e.g. the studio Bloom view
 * only mounts its canvas once data loads), and a callback ref attaches the
 * listeners the moment that element mounts and detaches when it unmounts —
 * a plain-ref effect would run once at mount when the element is still absent
 * and never re-attach. The wrapped element must also carry `touch-action: none`
 * so the browser hands us the gesture instead of page-zooming/scrolling first.
 *
 * Pan converts a screen-pixel drag delta into NVL's world-space pan with the
 * inverse of NVL's own screen→world map (`world = pan + dpr·(client−center) /
 * scale`): `Δpan = −dpr·Δclient / scale`. Dividing by `scale` keeps the grabbed
 * point pinned under the finger at every zoom level. A node drag uses the same
 * conversion with the opposite sign (`Δworld = +dpr·Δclient / scale`) — moving
 * the node with the finger instead of the viewport against it. Zoom
 * deliberately isn't pre-clamped — NVL enforces its own bounds inside
 * `setZoom`, matching the +/− zoom buttons.
 */
export function useNvlTouchGestures({
  nvlRef,
  onScaleChange,
}: UseNvlTouchGesturesOptions): (el: HTMLElement | null) => void {
  // Read the latest callback inside the live listeners without re-attaching
  // them every time the caller passes a new inline function.
  const onScaleChangeRef = useRef(onScaleChange)
  useEffect(() => {
    onScaleChangeRef.current = onScaleChange
  }, [onScaleChange])

  // Last finger-spread distance during an active pinch (null = no pinch).
  const pinchDistRef = useRef<number | null>(null)
  // Anchor captured when a one-finger pan begins (null = not panning, e.g. the
  // gesture started on a node or with multiple fingers). Resolving each move
  // absolutely from this anchor keeps panning immune to NVL's deferred
  // setPan/getPan (flushed on the next frame), which would otherwise drop
  // deltas and drift on fast multi-touch bursts (120 Hz ProMotion).
  const panAnchorRef = useRef<PanAnchor | null>(null)
  // Anchor captured when a one-finger drag begins ON a node (null = not
  // dragging a node). Anchored rather than accumulated for the same reason as
  // the pan above: NVL applies position updates on the next frame, so
  // per-frame deltas drift.
  const nodeDragRef = useRef<NodeDragAnchor | null>(null)
  // The element we're currently bound to + its teardown.
  const boundElRef = useRef<HTMLElement | null>(null)
  const detachRef = useRef<(() => void) | null>(null)

  const attach = useCallback(
    (el: HTMLElement): (() => void) => {
      const distanceBetween = (a: Touch, b: Touch) =>
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

      // One hit-test answers both questions a one-finger touchstart has to
      // resolve — is there a node here to pick up, and if not, is this empty
      // canvas we may pan? Splitting them into two `getHits` calls would be two
      // sources of truth for the same gesture.
      //
      //   `node`           the node under the finger plus the world position to
      //                    drag it from (null when the finger missed every node,
      //                    or the handle can't move nodes).
      //   `onGraphElement` true when the finger landed on a node OR a
      //                    relationship, in which case the gesture belongs to
      //                    the graph and must not become a pan (GOAL-276).
      //
      // On any failure we report empty and allow panning — a stationary tap
      // still drills via the synthesized click on touchend.
      const graphHitAt = (
        touch: Touch
      ): { node: NodeDragAnchor | null; onGraphElement: boolean } => {
        const miss = { node: null, onGraphElement: false }
        const nvl = nvlRef.current
        if (!nvl || typeof nvl.getHits !== 'function') return miss
        try {
          const { nvlTargets } = nvl.getHits(
            { clientX: touch.clientX, clientY: touch.clientY },
            ['node', 'relationship']
          )
          const nodes = nvlTargets?.nodes ?? []
          const onGraphElement =
            nodes.length > 0 || (nvlTargets?.relationships?.length ?? 0) > 0
          const scale = nvl.getScale?.()
          if (
            typeof nvl.setNodePositions !== 'function' ||
            typeof scale !== 'number' ||
            !scale
          ) {
            return { node: null, onGraphElement }
          }
          const hit = nodes.find(
            (n) => n?.data?.id != null && n?.targetCoordinates
          )
          if (!hit?.targetCoordinates) return { node: null, onGraphElement }
          return {
            node: {
              id: String(hit.data?.id),
              worldX: hit.targetCoordinates.x,
              worldY: hit.targetCoordinates.y,
              clientX: touch.clientX,
              clientY: touch.clientY,
              scale,
              moved: false,
            },
            onGraphElement,
          }
        } catch (error) {
          console.warn('NVL hit-test failed; allowing pan:', error)
          return miss
        }
      }

      const handleTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          // Two fingers down → pinch; cancel any in-flight pan or node drag.
          pinchDistRef.current = distanceBetween(e.touches[0], e.touches[1])
          panAnchorRef.current = null
          nodeDragRef.current = null
          return
        }
        if (e.touches.length === 1) {
          pinchDistRef.current = null
          panAnchorRef.current = null
          nodeDragRef.current = null
          const touch = e.touches[0]
          const { node, onGraphElement } = graphHitAt(touch)
          // A drag that starts ON a node moves that node (GOAL-351).
          if (node) {
            nodeDragRef.current = node
            return
          }
          // Only pan when the drag begins on empty canvas — a drag starting on
          // a relationship belongs to NVL.
          if (onGraphElement) return
          const nvl = nvlRef.current
          const pan = nvl?.getPan?.()
          const scale = nvl?.getScale?.()
          if (pan && typeof scale === 'number' && scale) {
            panAnchorRef.current = {
              panX: pan.x,
              panY: pan.y,
              clientX: touch.clientX,
              clientY: touch.clientY,
              scale,
            }
          }
          return
        }
        panAnchorRef.current = null
        nodeDragRef.current = null
      }

      const handlePinch = (e: TouchEvent) => {
        // We own any two-finger gesture on this surface — suppress the
        // browser's native page zoom even on the bootstrap frame before we
        // have a delta.
        e.preventDefault()

        const nvl = nvlRef.current
        if (
          !nvl ||
          typeof nvl.getScale !== 'function' ||
          typeof nvl.setZoom !== 'function'
        ) {
          return
        }

        const dist = distanceBetween(e.touches[0], e.touches[1])
        const last = pinchDistRef.current
        if (last == null || last === 0) {
          pinchDistRef.current = dist
          return
        }

        const ratio = dist / last
        pinchDistRef.current = dist
        // Ignore sub-pixel jitter so resting fingers don't drift the zoom.
        if (Math.abs(ratio - 1) < PINCH_JITTER) return

        try {
          const currentScale = nvl.getScale()
          if (typeof currentScale === 'number') {
            nvl.setZoom(currentScale * ratio)
            // Report what NVL actually applied (it clamps to its own bounds),
            // not our requested target.
            const applied = nvl.getScale?.()
            if (typeof applied === 'number') onScaleChangeRef.current?.(applied)
          }
        } catch (error) {
          console.warn('Pinch zoom failed:', error)
        }
      }

      const handlePan = (e: TouchEvent) => {
        const anchor = panAnchorRef.current
        if (!anchor) return

        const nvl = nvlRef.current
        if (!nvl || typeof nvl.setPan !== 'function') return

        // We're driving the pan, so stop any native scroll/refresh.
        e.preventDefault()

        const touch = e.touches[0]
        // Resolve the pan absolutely from the gesture's start anchor, inverting
        // NVL's screen→world map (`world = pan + dpr·(client−center) / scale`)
        // so the grabbed point tracks the finger at any zoom:
        // Δpan = −dpr·Δclient / scale. Anchoring (vs. accumulating per frame)
        // sidesteps NVL flushing setPan only on the next animation frame.
        const dpr = window.devicePixelRatio || 1
        try {
          nvl.setPan(
            anchor.panX - (dpr * (touch.clientX - anchor.clientX)) / anchor.scale,
            anchor.panY - (dpr * (touch.clientY - anchor.clientY)) / anchor.scale
          )
        } catch (error) {
          console.warn('Touch pan failed:', error)
        }
      }

      const handleNodeDrag = (e: TouchEvent) => {
        const anchor = nodeDragRef.current
        if (!anchor) return

        const nvl = nvlRef.current
        if (!nvl || typeof nvl.setNodePositions !== 'function') return

        const touch = e.touches[0]
        const deltaX = touch.clientX - anchor.clientX
        const deltaY = touch.clientY - anchor.clientY
        // Until the finger clears the tap threshold, leave the gesture alone:
        // no preventDefault, no move. That keeps the synthesized click on
        // touchend intact, so tap-to-drill / tap-to-open-drawer still work.
        if (!anchor.moved) {
          if (Math.hypot(deltaX, deltaY) < NODE_DRAG_THRESHOLD) return
          anchor.moved = true
        }

        // We're driving the gesture now — stop native scroll AND the
        // synthesized click that would otherwise drill into the node we just
        // repositioned.
        e.preventDefault()

        // Resolve absolutely from the anchor, inverting NVL's screen→world map
        // (`world = pan + dpr·(client−center) / scale`) so the node tracks the
        // finger at any zoom: Δworld = +dpr·Δclient / scale.
        //
        // Exactly one node moves, even if others are selected. NVL's mouse
        // DragNodeInteraction moves the whole selection when the grabbed node
        // is part of it; neither consumer of this hook enables `selectOnClick`,
        // so there is never a selection to honour. Revisit if that changes.
        const dpr = window.devicePixelRatio || 1
        try {
          nvl.setNodePositions(
            [
              {
                id: anchor.id,
                x: anchor.worldX + (dpr * deltaX) / anchor.scale,
                y: anchor.worldY + (dpr * deltaY) / anchor.scale,
                // `pinned` is what makes the drop stick: without it the force
                // simulation pulls the node straight back.
                pinned: true,
              },
            ],
            // Keep the layout update live rather than terminating it, matching
            // NVL's own mouse DragNodeInteraction — the neighbours re-settle
            // around the moved node and its edges follow it.
            true
          )
        } catch (error) {
          // Abort the gesture rather than retrying (and re-warning) on every
          // frame — a persistent failure here means the node went away
          // mid-drag, and it is not coming back within this gesture.
          nodeDragRef.current = null
          console.warn('Touch node drag failed:', error)
        }
      }

      const handleTouchMove = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          handlePinch(e)
        } else if (e.touches.length === 1) {
          // A node drag and a pan are mutually exclusive: touchstart anchors
          // exactly one of them.
          if (nodeDragRef.current) handleNodeDrag(e)
          else handlePan(e)
        }
      }

      const handleTouchEnd = (e: TouchEvent) => {
        if (e.touches.length < 2) pinchDistRef.current = null
        // Clear the anchors on full lift. A leftover finger after a pinch is
        // intentionally NOT re-anchored (its gesture was never node-gated), so
        // panning or dragging always requires a fresh single-finger touch.
        if (e.touches.length === 0) {
          panAnchorRef.current = null
          nodeDragRef.current = null
        }
      }

      // Non-passive so preventDefault() actually suppresses native page
      // zoom/scroll during our gestures.
      el.addEventListener('touchstart', handleTouchStart, { passive: false })
      el.addEventListener('touchmove', handleTouchMove, { passive: false })
      el.addEventListener('touchend', handleTouchEnd, { passive: false })
      el.addEventListener('touchcancel', handleTouchEnd, { passive: false })

      return () => {
        el.removeEventListener('touchstart', handleTouchStart)
        el.removeEventListener('touchmove', handleTouchMove)
        el.removeEventListener('touchend', handleTouchEnd)
        el.removeEventListener('touchcancel', handleTouchEnd)
      }
    },
    [nvlRef]
  )

  // Stable callback ref: re-binds whenever the surface element mounts/unmounts.
  const surfaceRef = useCallback(
    (el: HTMLElement | null) => {
      if (boundElRef.current === el) return
      detachRef.current?.()
      detachRef.current = null
      boundElRef.current = el
      if (el) detachRef.current = attach(el)
    },
    [attach]
  )

  // Detach on unmount (React doesn't always call the callback ref with null
  // before teardown for a stable callback identity).
  useEffect(() => {
    return () => {
      detachRef.current?.()
      detachRef.current = null
      boundElRef.current = null
    }
  }, [])

  return surfaceRef
}
