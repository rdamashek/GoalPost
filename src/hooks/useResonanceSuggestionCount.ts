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

  // Resolves to the number it just fetched (0 on any failure, matching what it
  // renders). Callers that need to hand the fresh number straight on — the
  // field-context page broadcasting it to the studio action bar — can't read it
  // off `count`, which is still the pre-fetch value in their closure.
  const fetchCount = useCallback(async (): Promise<number> => {
    const requestId = ++requestIdRef.current
    const isStale = () => requestId !== requestIdRef.current

    if (!spaceId) {
      setCount(0)
      return 0
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({ spaceId, status })
      if (contextId) params.append('contextId', contextId)

      const response = await fetch(
        `/api/resonance/suggestions/count?${params.toString()}`
      )
      if (isStale()) return 0
      if (!response.ok) {
        // 403 is expected for a caller with no role on the Space — render as
        // "nothing to review" rather than an error.
        setCount(0)
        return 0
      }

      const data: SuggestionCountResponse = await response.json()
      if (isStale()) return 0
      const next = Number(data?.count ?? 0) || 0
      setCount(next)
      return next
    } catch (err) {
      console.error('[useResonanceSuggestionCount] Error:', err)
      if (!isStale()) setCount(0)
      return 0
    } finally {
      if (!isStale()) setLoading(false)
    }
  }, [spaceId, contextId, status])

  useEffect(() => {
    void fetchCount()
  }, [fetchCount])

  return { count, loading, refetch: fetchCount }
}
