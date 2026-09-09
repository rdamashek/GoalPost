'use client'

import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogPortal,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResonanceSuggestionItem } from '@/components/ui/resonance-suggestion-item'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface Suggestion {
  id: string
  label: string
  description: string
  confidence: number
  evidence: string
  status: 'pending' | 'accepted' | 'declined'
  createdAt: string
  sourcePulseId: string
  sourcePulseContent: string
  targetPulseId: string
  targetPulseContent: string
  contextId: string
  contextTitle: string
}

interface ResonanceSuggestionsModalProps {
  isOpen: boolean
  onClose: () => void
  spaceId: string
  suggestions?: Suggestion[]
  loading?: boolean
  onAccept?: (id: string) => Promise<void>
  onDecline?: (id: string) => Promise<void>
  onRefresh?: () => Promise<void>
  /**
   * Bulk-accept every pending suggestion at or above `minConfidence` (0–1).
   * When provided, the pending tab shows a threshold + "Accept N" control.
   */
  onAcceptAll?: (minConfidence: number) => Promise<number | void>
}

type TabStatus = 'pending' | 'accepted' | 'declined'

export function ResonanceSuggestionsModal({
  isOpen,
  onClose,
  spaceId,
  suggestions = [],
  loading = false,
  onAccept,
  onDecline,
  onRefresh,
  onAcceptAll,
}: ResonanceSuggestionsModalProps) {
  const [activeTab, setActiveTab] = useState<TabStatus>('pending')
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewIndex, setReviewIndex] = useState(0)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(85)
  const [bulkLoading, setBulkLoading] = useState(false)

  // How many pending suggestions clear the current % threshold (confidence is
  // stored 0–1; the control is expressed as a whole percent).
  const eligibleCount = useMemo(
    () =>
      suggestions.filter(
        (s) => s.status === 'pending' && s.confidence * 100 >= threshold
      ).length,
    [suggestions, threshold]
  )

  const handleAcceptAll = async () => {
    if (!onAcceptAll || eligibleCount === 0) return
    setBulkLoading(true)
    try {
      await onAcceptAll(threshold / 100)
      await onRefresh?.()
    } finally {
      setBulkLoading(false)
    }
  }

  // Filter suggestions by status
  const filteredSuggestions = useMemo(() => {
    return suggestions.filter((s) => s.status === activeTab)
  }, [suggestions, activeTab])

  // Get current suggestion in review mode
  const currentSuggestion = reviewMode ? filteredSuggestions[reviewIndex] : null

  // Tab counts
  const tabCounts = {
    pending: suggestions.filter((s) => s.status === 'pending').length,
    accepted: suggestions.filter((s) => s.status === 'accepted').length,
    declined: suggestions.filter((s) => s.status === 'declined').length,
  }

  const handleStartReview = () => {
    if (filteredSuggestions.length > 0) {
      setReviewMode(true)
      setReviewIndex(0)
    }
  }

  const handleNextReview = () => {
    if (reviewIndex < filteredSuggestions.length - 1) {
      setReviewIndex(reviewIndex + 1)
    } else {
      setReviewMode(false)
      setReviewIndex(0)
    }
  }

  const handlePrevReview = () => {
    if (reviewIndex > 0) {
      setReviewIndex(reviewIndex - 1)
    }
  }

  const handleAccept = async (id: string) => {
    if (!onAccept) return
    setActionLoading(id)
    try {
      await onAccept(id)
      await onRefresh?.()
      if (reviewMode && filteredSuggestions.length > 1) {
        handleNextReview()
      }
    } finally {
      setActionLoading(null)
    }
  }

  const handleDecline = async (id: string) => {
    if (!onDecline) return
    setActionLoading(id)
    try {
      await onDecline(id)
      await onRefresh?.()
      if (reviewMode && filteredSuggestions.length > 1) {
        handleNextReview()
      }
    } finally {
      setActionLoading(null)
    }
  }

  const handleClose = () => {
    setReviewMode(false)
    setReviewIndex(0)
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogPortal>
        {/* Each card carries a long description, two pulse excerpts and a "Why
            they resonate" paragraph, so this dialog needs far more horizontal
            room than the primitive's default (GOAL-353). The `sm:` prefix is
            load-bearing: DialogContent ships `sm:max-w-lg`, and only a class in
            that same variant makes twMerge drop it — an unprefixed `max-w-2xl`
            loses to it at every width past 640px, which is why this dialog was
            rendering at 512px on a 1440px screen. Keep the unprefixed
            `max-w-2xl` too: it displaces the primitive's
            `max-w-[calc(100%-2rem)]`, which is what keeps the phone layout
            edge-to-edge and unchanged. */}
        <DialogContent className="max-w-2xl sm:max-w-2xl lg:max-w-4xl xl:max-w-5xl max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="border-b border-slate-200 pb-4 dark:border-slate-700">
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              Resonance Suggestions
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Review and approve discovered connections between your pulses
            </DialogDescription>
          </div>

          {/* Review Mode */}
          {reviewMode && currentSuggestion && (
            <div className="space-y-4">
              {/* Progress */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-400">
                  Reviewing {reviewIndex + 1} of {filteredSuggestions.length}
                </span>
                <div className="h-1 w-32 bg-slate-200 rounded-full dark:bg-slate-700 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{
                      width: `${((reviewIndex + 1) / filteredSuggestions.length) * 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Current Suggestion */}
              <ResonanceSuggestionItem
                id={currentSuggestion.id}
                label={currentSuggestion.label}
                description={currentSuggestion.description}
                confidence={currentSuggestion.confidence}
                evidence={currentSuggestion.evidence}
                sourcePulseId={currentSuggestion.sourcePulseId}
                sourcePulseContent={currentSuggestion.sourcePulseContent}
                targetPulseId={currentSuggestion.targetPulseId}
                targetPulseContent={currentSuggestion.targetPulseContent}
                contextTitle={currentSuggestion.contextTitle}
                // Undefined when the viewer lacks `canEditContent` — the item
                // then renders read-only rather than showing controls the
                // accept/decline routes would reject (kb/02-user-roles.md).
                onAccept={onAccept ? handleAccept : undefined}
                onDecline={onDecline ? handleDecline : undefined}
                isLoading={actionLoading === currentSuggestion.id}
              />

              {/* Navigation */}
              <div className="flex gap-3 justify-between pt-4 border-t border-slate-200 dark:border-slate-700">
                <Button
                  variant="outline"
                  onClick={handlePrevReview}
                  disabled={reviewIndex === 0}
                >
                  ← Previous
                </Button>
                <Button variant="ghost" onClick={() => setReviewMode(false)}>
                  Back to List
                </Button>
                <Button
                  variant="outline"
                  onClick={handleNextReview}
                  disabled={reviewIndex === filteredSuggestions.length - 1}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}

          {/* Tab View */}
          {!reviewMode && (
            <div className="space-y-4">
              {/* Tabs */}
              <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
                {(['pending', 'accepted', 'declined'] as const).map(
                  (status) => (
                    <button
                      key={status}
                      onClick={() => setActiveTab(status)}
                      className={cn(
                        'px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize',
                        activeTab === status
                          ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                          : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                      )}
                    >
                      {status}
                      {/* min-w + horizontal padding, not a fixed w-5: a Space
                          can queue three-digit counts (159 in the GOAL-353
                          report) and a fixed 20px circle clipped them. */}
                      {tabCounts[status] > 0 && (
                        <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-semibold text-white bg-slate-600 rounded-full dark:bg-slate-500">
                          {tabCounts[status]}
                        </span>
                      )}
                    </button>
                  )
                )}
              </div>

              {/* Bulk accept-by-confidence control (pending tab only) */}
              {activeTab === 'pending' &&
                onAcceptAll &&
                tabCounts.pending > 0 && (
                  <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="material-symbols-outlined shrink-0 text-[20px] text-gp-primary">
                        auto_awesome
                      </span>
                      <label
                        htmlFor="resonance-threshold"
                        className="text-sm text-foreground"
                      >
                        Accept all at or above
                      </label>
                      <div className="flex shrink-0 items-center gap-1">
                        <Input
                          id="resonance-threshold"
                          type="number"
                          min={0}
                          max={100}
                          value={Number.isFinite(threshold) ? threshold : ''}
                          onChange={(e) => {
                            const n = Math.round(Number(e.target.value))
                            setThreshold(
                              Number.isFinite(n)
                                ? Math.max(0, Math.min(100, n))
                                : 0
                            )
                          }}
                          className="h-9 w-16 text-center"
                          aria-label="Confidence threshold percentage"
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                      </div>
                    </div>
                    <Button
                      onClick={handleAcceptAll}
                      disabled={eligibleCount === 0 || bulkLoading}
                      className="w-full shrink-0 sm:w-auto"
                    >
                      <span
                        className={cn(
                          'material-symbols-outlined mr-1 text-[18px]',
                          bulkLoading && 'animate-spin'
                        )}
                      >
                        {bulkLoading ? 'progress_activity' : 'done_all'}
                      </span>
                      {bulkLoading ? 'Accepting…' : `Accept ${eligibleCount}`}
                    </Button>
                  </div>
                )}

              {/* Content */}
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-48 rounded-lg" />
                  ))}
                </div>
              ) : filteredSuggestions.length === 0 ? (
                <div className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center dark:border-slate-600 dark:bg-slate-800/50">
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {activeTab === 'pending'
                      ? 'No pending suggestions. Run discovery to find resonances!'
                      : `No ${activeTab} suggestions yet.`}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredSuggestions.map((suggestion) => (
                    <ResonanceSuggestionItem
                      key={suggestion.id}
                      id={suggestion.id}
                      label={suggestion.label}
                      description={suggestion.description}
                      confidence={suggestion.confidence}
                      evidence={suggestion.evidence}
                      sourcePulseId={suggestion.sourcePulseId}
                      sourcePulseContent={suggestion.sourcePulseContent}
                      targetPulseId={suggestion.targetPulseId}
                      targetPulseContent={suggestion.targetPulseContent}
                      contextTitle={suggestion.contextTitle}
                      onAccept={onAccept ? handleAccept : undefined}
                      onDecline={onDecline ? handleDecline : undefined}
                      isLoading={actionLoading === suggestion.id}
                    />
                  ))}
                </div>
              )}

              {/* Review All Button (for pending tab) */}
              {activeTab === 'pending' && filteredSuggestions.length > 0 && (
                <Button
                  onClick={handleStartReview}
                  className="w-full"
                  size="lg"
                >
                  Review All Suggestions
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
