'use client'

import type { FC } from 'react'
import { LayoutGrid, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasView } from './studio-canvas-context'

/**
 * The Dashboard ↔ Bloom selector in the floating canvas action bar, plus the
 * hairline the bar uses between its clustered controls.
 *
 * Split out of `canvas-action-bar.tsx` purely to keep that file under the
 * 400-line component ceiling (CLAUDE.md) — same reason `resonances-section.tsx`
 * was split out of `field-context-sections.tsx`.
 */
export const Divider: FC = () => <div className="w-px h-4 bg-gp-glass-border" />

export const ViewToggle: FC<{
  activeView: CanvasView
  /**
   * Whether the current route can render the bloom surface. When false
   * (persons, profile, settings, search) only the dashboard view is selectable
   * — Bloom is disabled so the toggle never dead-clicks against a route it
   * can't scope to.
   */
  scopeAvailable: boolean
  onChange: (view: CanvasView) => void
}> = ({ activeView, scopeAvailable, onChange }) => {
  // Order + labels follow the kb canonical names (kb/01-glossary.md):
  // Dashboard View → Bloom Exploration.
  const items: { id: CanvasView; label: string; Icon: typeof LayoutGrid }[] = [
    { id: 'dashboard', label: 'Dashboard view', Icon: LayoutGrid },
    { id: 'bloom', label: 'Bloom exploration', Icon: Workflow },
  ]

  return (
    <div
      role="tablist"
      aria-label="Canvas view"
      className="flex items-center gap-1 p-1 rounded-full gp-glass border border-gp-glass-border shadow-xl"
    >
      {items.map(({ id, label, Icon }, idx) => {
        const active = activeView === id
        const disabled = !scopeAvailable && id !== 'dashboard'
        const isLast = idx === items.length - 1
        return (
          <span key={id} className="flex items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => onChange(id)}
              aria-label={label}
              title={
                disabled ? `${label} — open a space to use this view` : label
              }
              className={cn(
                'size-9 md:size-10 flex items-center justify-center rounded-full transition-all duration-200',
                disabled
                  ? 'opacity-40 cursor-not-allowed text-gp-ink-muted'
                  : active
                    ? 'cursor-pointer bg-gp-primary/20 text-gp-primary'
                    : 'gp-menu-item cursor-pointer'
              )}
            >
              <Icon className="w-4 h-4" />
            </button>
            {!isLast && <Divider />}
          </span>
        )
      })}
    </div>
  )
}
