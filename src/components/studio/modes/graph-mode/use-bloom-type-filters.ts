'use client'

import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_HIDDEN_TYPE_KEYS } from './bloom-type-registry'

/**
 * Per-type visibility state for the Bloom canvas (GOAL-350).
 *
 * ## Why this is per-session and not sticky
 *
 * The story raised persistence as an open question — session-only, or sticky
 * in `localStorage` the way the canvas view itself is. This takes the
 * session-only reading, deliberately:
 *
 * A sticky filter is a canvas that can come back empty days later because of
 * something the member set once and forgot, and on this surface an empty
 * canvas is indistinguishable from "there is nothing here" or — worse — from
 * "you are not allowed to see this" (kb/02-user-roles.md). Filters persist
 * across drill-downs within a session, which is what makes "strip this to
 * pulses and resonance" usable while browsing a dense import, and they reset
 * on reload, so a canvas can never open in a state nobody chose today.
 *
 * The legend still surfaces a live count of what is switched off plus a reset,
 * so the affordance the story asked to pair with stickiness is here either
 * way — and it is what a follow-up would build on if sticky wins.
 */
export interface BloomTypeFilters {
  /**
   * Row keys currently switched OFF, with this scope's defaults already
   * resolved in. Both the canvas filter and the legend's switch states read
   * this one set, so they cannot disagree about what is hidden.
   */
  hidden: ReadonlySet<string>
  toggle: (key: string) => void
  /** Clears every filter — the reset behind the legend's "Show all". */
  showAll: () => void
}

export interface BloomTypeFilterOptions {
  /**
   * Whether this scope wants `DEFAULT_HIDDEN_TYPE_KEYS` applied.
   *
   * False for the chat overlay. GOAL-346's Documents default exists because
   * the NATIVE in-field layer adds a node per upload and buries the pulses an
   * unasked-for canvas is meant to show. An overlay is the opposite case — a
   * subgraph the member explicitly asked the assistant for — so pruning
   * Documents out of it before they have touched a control would be the canvas
   * discarding precisely what was requested.
   */
  applyDefaults: boolean
}

export function useBloomTypeFilters({
  applyDefaults,
}: BloomTypeFilterOptions): BloomTypeFilters {
  // Only what the member has explicitly switched off. Defaults are layered on
  // at read time rather than seeded into this set, so they can be scoped
  // without ever overwriting a real choice.
  const [explicitlyHidden, setExplicitlyHidden] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Keys the member has acted on at least once, in either direction. A default
  // stops applying the moment its key is touched — otherwise switching
  // Documents on and then walking into another field would silently switch
  // them back off, and the control would feel like it had been ignored.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())

  const hidden = useMemo<ReadonlySet<string>>(() => {
    if (!applyDefaults) return explicitlyHidden
    const next = new Set(explicitlyHidden)
    for (const key of DEFAULT_HIDDEN_TYPE_KEYS) {
      if (!touched.has(key)) next.add(key)
    }
    return next
  }, [applyDefaults, explicitlyHidden, touched])

  const toggle = useCallback(
    (key: string) => {
      // Resolve against the EFFECTIVE state, so the first click on a
      // still-defaulted row switches it ON rather than re-hiding something
      // that is already hidden.
      const isHidden = hidden.has(key)
      setExplicitlyHidden((prev) => {
        // Un-hiding a key that was only hidden by a default changes nothing
        // here — `touched` below is what releases it. Keep the same set in
        // that case so the canvas memos don't churn on an identity change
        // that carries no new information.
        if (isHidden && !prev.has(key)) return prev
        const next = new Set(prev)
        if (isHidden) next.delete(key)
        else next.add(key)
        return next
      })
      setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    },
    [hidden]
  )

  const showAll = useCallback(() => {
    // Clearing has to mean clearing: the defaults are marked touched too, or
    // "Show all" would leave Documents hidden and read as a broken reset.
    setExplicitlyHidden((prev) => (prev.size === 0 ? prev : new Set<string>()))
    setTouched((prev) => {
      if (DEFAULT_HIDDEN_TYPE_KEYS.every((k) => prev.has(k))) return prev
      const next = new Set(prev)
      for (const key of DEFAULT_HIDDEN_TYPE_KEYS) next.add(key)
      return next
    })
  }, [])

  return useMemo(() => ({ hidden, toggle, showAll }), [hidden, toggle, showAll])
}
