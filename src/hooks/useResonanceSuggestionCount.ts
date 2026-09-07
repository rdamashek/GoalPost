import { useCallback, useEffect, useRef, useState } from 'react'

interface SuggestionCountResponse {
  success?: boolean
  count?: number
}

interface UseResonanceSuggestionCountOptions {
  spaceId: string
  /** Narrow the count to one FieldContext. Omit for the whole Space. */
  contextId?: string
  /** Which suggestion status to count. Defaults to `pending` (kb/04). */
  status?: 'pending' | 'accepted' | 'declined' | 'all'
}

/**
 * Passive count of ResonanceSuggestions, fetched on mount (GOAL-348).
 *
 * Deliberately separate from `useResonanceSuggestions`: that hook pulls every
 * suggestion with both pulses' content embedded, which is the payload the
 * review modal needs but far more than a badge does. This one asks the server
 * for the number only, so a FieldContext page can show "N waiting for review"
 * without a discovery sweep and without a heavyweight list fetch.
 *
 * Errors resolve to a count of 0 — a passive indicator must never surface an
 * error state over the section header it decorates.
 */
export function useResonanceSuggestionCount({
  spaceId,
  contextId,
  status = 'pending',
}: UseResonanceSuggestionCountOptions) {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  // Monotonic request id. Navigating between fields client-side re-runs this
  // hook while an earlier request is still in flight; without the guard a slow
  // response for the PREVIOUS field can land last and leave its number on
  // screen. The whole output of this hook is that number, so it has to be the
  // current field's.
  const requestIdRef = useRef(0)

  const fetchCount = useCallback(async () => {
    const requestId = ++requestIdRef.current
    const isStale = () => requestId !== requestIdRef.current

    if (!spaceId) {
      setCount(0)
      return
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({ spaceId, status })
      if (contextId) params.append('contextId', contextId)

      const response = await fetch(
        `/api/resonance/suggestions/count?${params.toString()}`
      )
      if (isStale()) return
      if (!response.ok) {
        // 403 is expected for a caller with no role on the Space — render as
        // "nothing to review" rather than an error.
        setCount(0)
        return
      }

      const data: SuggestionCountResponse = await response.json()
      if (isStale()) return
      setCount(Number(data?.count ?? 0) || 0)
    } catch (err) {
      console.error('[useResonanceSuggestionCount] Error:', err)
      if (!isStale()) setCount(0)
    } finally {
      if (!isStale()) setLoading(false)
    }
  }, [spaceId, contextId, status])

  useEffect(() => {
    void fetchCount()
  }, [fetchCount])

  return { count, loading, refetch: fetchCount }
}
