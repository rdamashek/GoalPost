'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ResonanceSuggestionItemProps {
  id: string
  label: string
  description: string
  confidence: number
  evidence: string
  sourcePulseId: string
  sourcePulseContent: string
  targetPulseId: string
  targetPulseContent: string
  contextTitle: string
  /** Omit BOTH to render the suggestion read-only — a viewer without
   *  `canEditContent` (a WeSpace GUEST) may read the review queue but cannot
   *  act on it, and must not be shown controls that can only 403. */
  onAccept?: (id: string) => Promise<void>
  onDecline?: (id: string) => Promise<void>
  isLoading?: boolean
}

// Confidence color mapping
function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8)
    return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300'
  if (confidence >= 0.5)
    return 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-300'
}

function getConfidenceIcon(confidence: number): string {
  if (confidence >= 0.8) return '●'
  if (confidence >= 0.5) return '◐'
  return '○'
}

export function ResonanceSuggestionItem({
  id,
  label,
  description,
  confidence,
  evidence,
  sourcePulseContent,
  targetPulseContent,
  contextTitle,
  onAccept,
  onDecline,
  isLoading = false,
}: ResonanceSuggestionItemProps) {
  const canReview = Boolean(onAccept || onDecline)

  const handleAccept = async () => {
    if (!onAccept) return
    try {
      await onAccept(id)
    } catch (error) {
      console.error('Failed to accept suggestion:', error)
    }
  }

  const handleDecline = async () => {
    if (!onDecline) return
    try {
      await onDecline(id)
    } catch (error) {
      console.error('Failed to decline suggestion:', error)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
      {/* Header: Pattern Label + Confidence */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {label}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {contextTitle}
          </p>
        </div>
        <div
          className={cn(
            'flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap',
            getConfidenceColor(confidence)
          )}
        >
          <span>{getConfidenceIcon(confidence)}</span>
          <span>{Math.round(confidence * 100)}%</span>
        </div>
      </div>

      {/* Description */}
      <p className="mb-4 text-sm text-slate-700 dark:text-slate-300">
        {description}
      </p>

      {/* Pulse Excerpts — stacked on phones, side by side once the dialog
          widens (GOAL-353), which is where the extra horizontal space actually
          buys back vertical scrolling instead of just lengthening lines. */}
      <div className="mb-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div className="rounded bg-slate-50/50 p-3 dark:bg-slate-800/50">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
            Pulse 1
          </p>
          <p className="text-sm text-slate-700 dark:text-slate-300 line-clamp-2">
            {sourcePulseContent}
          </p>
        </div>
        <div className="rounded bg-slate-50/50 p-3 dark:bg-slate-800/50">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
            Pulse 2
          </p>
          <p className="text-sm text-slate-700 dark:text-slate-300 line-clamp-2">
            {targetPulseContent}
          </p>
        </div>
      </div>

      {/* Evidence */}
      <div className="mb-5 rounded-lg bg-blue-50/50 p-3 dark:bg-blue-900/20">
        <p className="text-xs font-medium text-blue-900 dark:text-blue-300 mb-1">
          Why they resonate:
        </p>
        <p className="text-sm text-blue-800 dark:text-blue-200">{evidence}</p>
      </div>

      {/* Actions — hidden entirely for a read-only viewer */}
      {canReview && (
        <div className="flex gap-3">
          {onDecline && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDecline}
              disabled={isLoading}
              className="flex-1"
            >
              Decline
            </Button>
          )}
          {onAccept && (
            <Button
              size="sm"
              onClick={handleAccept}
              disabled={isLoading}
              className="flex-1"
            >
              {isLoading ? 'Processing...' : 'Accept'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
