'use client'

import { useState, type ReactNode } from 'react'
import {
  ARTICLE_TEMPLATE_COLUMNS,
  ARTICLE_TEMPLATE_SAMPLE_ROW,
  MAX_ARTICLE_IMPORT_ROWS,
} from '@/lib/imports/article-import'

/**
 * Step 1 of the article import modal (GOAL-317): the drop zone and the CSV
 * template link. Split out of the modal shell so it stays under the 400-line
 * component budget once GOAL-326 added the queued/progress state.
 */

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function downloadCsvTemplate() {
  const csv = [
    ARTICLE_TEMPLATE_COLUMNS.join(','),
    ARTICLE_TEMPLATE_SAMPLE_ROW.map(csvCell).join(','),
  ].join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'article-import-template.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * A spreadsheet column name inside prose (GOAL-355). The *tint* comes from
 * `--gp-primary` so the chip re-themes, but the TEXT is ink, not the primary
 * color: `--gp-primary` at this size fails WCAG AA on a light surface (#137fec
 * on white is ~3.98:1, and `theme-warm`'s #ffc233 is ~1.6:1). Same reasoning
 * the preview card's metadata lines use.
 */
function ColumnName({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-gp-primary/10 px-1 py-px font-mono text-[11px] text-gp-ink-strong dark:text-white">
      {children}
    </code>
  )
}

interface ImportArticlesPickerProps {
  onFileSelected: (file: File | null) => void
}

export function ImportArticlesPicker({
  onFileSelected,
}: ImportArticlesPickerProps) {
  const [isDragging, setIsDragging] = useState(false)

  return (
    <>
      <p className="text-sm text-gp-ink-muted dark:text-gp-ink-soft shrink-0">
        Upload a spreadsheet where each row is an article — title, author, date,
        and URL, plus optional <ColumnName>resource_type</ColumnName> and{' '}
        <ColumnName>source_url</ColumnName> columns. Each row becomes a pulse in
        this field, attributed to its author, and the link is opened and read so
        the article&apos;s details land in the field too.
      </p>

      <label
        htmlFor="import-articles-file"
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return
          setIsDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          onFileSelected(event.dataTransfer.files?.[0] ?? null)
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors cursor-pointer hover:border-gp-primary ${
          isDragging
            ? 'border-gp-primary bg-gp-primary/10 dark:bg-gp-primary/15'
            : 'border-gp-glass-border bg-gp-glass-bg/40'
        }`}
      >
        <span
          className={`material-symbols-outlined text-3xl transition-colors ${
            isDragging ? 'text-gp-primary' : 'text-gp-ink-muted'
          }`}
        >
          newspaper
        </span>
        <span className="text-sm text-gp-ink-strong dark:text-white font-medium">
          {isDragging
            ? 'Drop to preview'
            : 'Drag a spreadsheet here, or click to choose'}
        </span>
        <span className="text-xs text-gp-ink-muted">
          Accepts .csv and .xlsx — up to {MAX_ARTICLE_IMPORT_ROWS} rows per
          import
        </span>
        <input
          id="import-articles-file"
          type="file"
          accept=".csv,.xlsx"
          className="sr-only"
          onChange={(event) => {
            onFileSelected(event.target.files?.[0] ?? null)
            event.target.value = ''
          }}
        />
      </label>

      <button
        type="button"
        onClick={downloadCsvTemplate}
        className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-gp-primary hover:underline cursor-pointer"
      >
        <span className="material-symbols-outlined text-[14px]">download</span>
        Download the CSV template
      </button>
    </>
  )
}
