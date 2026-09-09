'use client'

import type {
  ArticleImportRowInput,
  ArticleImportSummary,
  ArticleRowError,
  ArticleRowExtraction,
  ArticleRowOutcome,
} from '@/lib/imports/article-import'
import {
  getPulseTypeClass,
  getPulseTypeLabel,
} from './field-section-primitives'

/**
 * Presentational pieces for the article import modal (GOAL-317): parsed-row
 * preview cards, row-issue cards, per-row outcome rows, and the results
 * summary chips. Kept separate so the modal shell stays under the 400-line
 * component budget.
 */

export function PreviewRowCard({ row }: { row: ArticleImportRowInput }) {
  return (
    <div className="rounded-xl border border-gp-glass-border bg-gp-glass-bg/40 px-3 py-2 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] font-semibold text-gp-ink-soft shrink-0">
          #{row.row}
        </span>
        <span
          className={`text-[9px] uppercase font-semibold shrink-0 ${getPulseTypeClass(row.pulseType)}`}
        >
          {getPulseTypeLabel(row.pulseType)}
        </span>
        <h4 className="text-xs font-bold text-gp-ink-strong dark:text-white truncate min-w-0">
          {row.title}
        </h4>
      </div>
      <div className="mt-1 flex items-center gap-1 text-[10px] text-gp-ink-muted dark:text-gp-ink-soft min-w-0">
        <span className="material-symbols-outlined text-[12px] shrink-0">
          person
        </span>
        <span className="truncate">{row.author}</span>
        {row.date && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{row.date}</span>
          </>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gp-ink-muted dark:text-gp-ink-soft min-w-0">
        <span className="material-symbols-outlined text-[12px] shrink-0">
          link
        </span>
        <span className="truncate">{row.url}</span>
      </div>
      {/*
        GOAL-355 — the two optional columns, shown only when the sheet carried
        them. The preview is the human-in-the-loop gate, so a member who added
        `resource_type` / `source_url` has to be able to see that they were read
        and mapped before confirming. Same ink + 10px metadata treatment as the
        lines above (not the semantic entity color, which fails WCAG AA at this
        size in light mode), and each value truncates so a long URL cannot push
        the card into horizontal overflow at 390px.
      */}
      {row.resourceType && (
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gp-ink-muted dark:text-gp-ink-soft min-w-0">
          <span className="material-symbols-outlined text-[12px] shrink-0">
            label
          </span>
          <span className="truncate">{row.resourceType}</span>
        </div>
      )}
      {row.sourceUrl && (
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gp-ink-muted dark:text-gp-ink-soft min-w-0">
          <span className="material-symbols-outlined text-[12px] shrink-0">
            share
          </span>
          <span className="truncate">{row.sourceUrl}</span>
        </div>
      )}
    </div>
  )
}

export function RowIssueCard({ error }: { error: ArticleRowError }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="material-symbols-outlined text-[14px] text-destructive shrink-0">
          error
        </span>
        <span className="text-[10px] font-semibold text-gp-ink-soft shrink-0">
          Row {error.row}
        </span>
        <span className="text-xs text-gp-ink-strong dark:text-white truncate min-w-0">
          {error.data.title || error.data.url || '—'}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-destructive break-words">
        {error.message}
      </p>
    </div>
  )
}

const OUTCOME_PRESENTATION: Record<
  ArticleRowOutcome['status'],
  { icon: string; className: string }
> = {
  created: { icon: 'check_circle', className: 'text-gp-resource' },
  skipped_existing: {
    icon: 'library_add_check',
    className: 'text-gp-ink-muted',
  },
  failed: { icon: 'error', className: 'text-destructive' },
}

/**
 * GOAL-344 — one line on what reading the row's article yielded. Success is
 * counted, not narrated; the two failure shapes render the member-safe copy
 * the worker persisted. Ink, not the semantic color, for the same WCAG reason
 * as the status labels elsewhere in this modal.
 */
function extractionLine(extraction: ArticleRowExtraction): string {
  switch (extraction.status) {
    case 'extracted': {
      const added =
        extraction.created > 0
          ? `added ${extraction.created} ${extraction.created === 1 ? 'entry' : 'entries'}`
          : ''
      const filled =
        extraction.updated > 0 ? `filled in ${extraction.updated} existing` : ''
      const parts = [added, filled].filter(Boolean).join(' and ')
      return parts ? `Read the article and ${parts}.` : 'Read the article.'
    }
    case 'nothing_extracted':
      return 'Read the article — nothing new to add beyond this row.'
    case 'already_extracted':
    case 'in_progress':
    case 'fetch_failed':
    case 'extraction_failed':
      return extraction.message ?? ''
    default:
      return ''
  }
}

export function OutcomeRow({ outcome }: { outcome: ArticleRowOutcome }) {
  const presentation = OUTCOME_PRESENTATION[outcome.status]
  const extraction =
    outcome.status !== 'failed' && outcome.extraction
      ? extractionLine(outcome.extraction)
      : ''
  return (
    <div className="flex items-start gap-2 rounded-xl border border-gp-glass-border bg-gp-glass-bg/40 px-3 py-2 min-w-0">
      <span
        className={`material-symbols-outlined text-[16px] shrink-0 ${presentation.className}`}
      >
        {presentation.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-semibold text-gp-ink-soft shrink-0">
            #{outcome.row}
          </span>
          <span className="text-xs font-bold text-gp-ink-strong dark:text-white truncate min-w-0">
            {outcome.title || '—'}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-gp-ink-muted dark:text-gp-ink-soft break-words">
          {outcome.message}
          {outcome.authorName && outcome.status !== 'failed'
            ? ` Attributed to ${outcome.authorName}.`
            : ''}
        </p>
        {extraction && (
          <p className="mt-0.5 flex items-start gap-1 text-[11px] text-gp-ink-muted dark:text-gp-ink-soft break-words">
            <span
              className="material-symbols-outlined text-[14px] shrink-0"
              aria-hidden="true"
            >
              {outcome.extraction?.status === 'fetch_failed' ||
              outcome.extraction?.status === 'extraction_failed'
                ? 'link_off'
                : 'article'}
            </span>
            <span className="min-w-0">{extraction}</span>
          </p>
        )}
      </div>
    </div>
  )
}

function SummaryChip({
  icon,
  label,
  value,
  className,
}: {
  icon: string
  label: string
  value: number
  className: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${className}`}
    >
      <span className="material-symbols-outlined text-[14px]">{icon}</span>
      <span className="font-bold">{value}</span>
      <span className="uppercase text-[10px] tracking-wide">{label}</span>
    </span>
  )
}

export function ImportSummaryChips({
  summary,
}: {
  summary: ArticleImportSummary
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SummaryChip
        icon="check_circle"
        label="created"
        value={summary.created}
        className="border-gp-resource/30 bg-gp-resource/10 text-gp-resource"
      />
      {summary.skippedExisting > 0 && (
        <SummaryChip
          icon="library_add_check"
          label="already existed"
          value={summary.skippedExisting}
          className="border-gp-glass-border bg-gp-glass-bg/40 text-gp-ink-muted"
        />
      )}
      {summary.failed > 0 && (
        <SummaryChip
          icon="error"
          label="failed"
          value={summary.failed}
          className="border-destructive/30 bg-destructive/10 text-destructive"
        />
      )}
      {summary.createdPeople > 0 && (
        <SummaryChip
          icon="person_add"
          label="new people"
          value={summary.createdPeople}
          className="border-gp-primary/30 bg-gp-primary/10 text-gp-primary"
        />
      )}
      {summary.articlesRead > 0 && (
        <SummaryChip
          icon="article"
          label={summary.articlesRead === 1 ? 'article read' : 'articles read'}
          value={summary.articlesRead}
          className="border-gp-story/30 bg-gp-story/10 text-gp-story"
        />
      )}
      {summary.articlesUnread > 0 && (
        <SummaryChip
          icon="link_off"
          label="couldn't be read"
          value={summary.articlesUnread}
          className="border-gp-glass-border bg-gp-glass-bg/40 text-gp-ink-muted"
        />
      )}
    </div>
  )
}
