'use client'

import { forwardRef } from 'react'
import type { ExternalCallbacks, Node, Relationship } from '@neo4j-nvl/base'
import type { MouseEventCallbacks } from '@neo4j-nvl/react'
import { InteractiveNvlWrapper } from '@neo4j-nvl/react'

interface GraphVisualizerProps {
  nodes: Node[]
  relationships: Relationship[]
  mouseEventCallbacks?: MouseEventCallbacks
  nvlOptions?: Record<string, unknown>
  nvlCallbacks?: Partial<ExternalCallbacks>
}

/**
 * Public subset of the underlying NVL instance methods the studio relies on.
 * Typed structurally so we don't depend on which copy of `@neo4j-nvl/base`
 * the resolver picks (the react package ships its own nested copy).
 */
export interface NvlRefHandle {
  getScale: () => number
  setZoom: (zoom: number) => void
  /** Current viewport pan in world coordinates. */
  getPan: () => { x: number; y: number }
  /** Sets the viewport pan in world coordinates. */
  setPan: (panX: number, panY: number) => void
  /**
   * Hit-tests a pointer position against nodes/relationships (touch pan
   * gating, touch node drag). Node hits carry the node's own world position in
   * `targetCoordinates`, which is where a drag starts from.
   */
  getHits: (
    evt: { clientX: number; clientY: number },
    targets?: ('node' | 'relationship')[]
  ) => {
    nvlTargets: {
      nodes: Array<{
        data?: { id?: string | number }
        targetCoordinates?: { x: number; y: number }
      }>
      relationships: unknown[]
    }
  }
  /**
   * Moves nodes in world space. `pinned` keeps the force simulation from
   * pulling a dropped node back to where it was. Argument names mirror NVL's
   * own `setNodePositions(data, updateLayout?)` — this interface is a
   * hand-maintained mirror that nothing type-checks against upstream.
   */
  setNodePositions: (
    positions: Array<{ id: string; x: number; y: number; pinned?: boolean }>,
    updateLayout?: boolean
  ) => void
  fit: (nodeIds: string[], opts?: Record<string, unknown>) => void
  getNodes: () => Node[]
  /** Re-kicks the layout simulation. Required after mount because NVL's force layout doesn't always converge from a cold start without an explicit nudge. */
  restart: (opts?: Record<string, unknown>, retainPositions?: boolean) => void
  /** Updates layout-specific options (gravity, linkDistance, simulationIterations, etc.) on the live NVL instance. */
  setLayoutOptions: (opts: Record<string, unknown>) => void
}

/**
 * Client-side only graph visualizer wrapper
 * Prevents @neo4j-nvl/react from being imported on the server
 *
 * Forwards the underlying NVL instance so callers can drive pan/zoom/fit
 * programmatically (e.g. the studio's floating zoom controls).
 */
export const GraphVisualizer = forwardRef<NvlRefHandle, GraphVisualizerProps>(
  function GraphVisualizer(
    { nodes, relationships, mouseEventCallbacks, nvlOptions, nvlCallbacks },
    ref
  ) {
    return (
      <InteractiveNvlWrapper
        // The NVL type identity differs between the top-level and nested
        // copies of `@neo4j-nvl/base`; cast through `never` so our structural
        // ref handle stays the public surface.
        ref={ref as never}
        nodes={nodes}
        rels={relationships}
        mouseEventCallbacks={mouseEventCallbacks}
        nvlOptions={nvlOptions}
        nvlCallbacks={nvlCallbacks as never}
      />
    )
  }
)
