import { t } from '../lib/i18n.js'
import { useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { clampSize } from '../model/panelSizes.js'

/** A boundary has the same interaction everywhere: drag, arrows, Home/End and double-click reset. */
export function ResizeHandle({ label, axis = 'x', direction = 1, value, min, max, onChange, onReset, testId, className = '', style, step = 16 }: {
  label: string; axis?: 'x' | 'y'; direction?: 1 | -1; value: number; min: number; max: number
  onChange(n: number): void; onReset(): void; testId: string; className?: string; style?: CSSProperties; step?: number
}): ReactElement {
  const drag = useRef<{ pointer: number; at: number; value: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const reset = (): void => { drag.current = null; setDragging(false) }
  return <div className={`panel-resize panel-resize-${axis} ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={t`${Math.round(value)} пикселей`}
    data-testid={testId} data-dragging={dragging ? '1' : undefined} style={style}
    title={t`${label}. Потяни или используй стрелки. Двойной клик — сбросить.`}
    onPointerDown={(e) => {
      if (e.button !== 0 || drag.current) return
      e.preventDefault(); e.stopPropagation()
      drag.current = { pointer: e.pointerId, at: axis === 'x' ? e.clientX : e.clientY, value }
      setDragging(true); e.currentTarget.setPointerCapture(e.pointerId)
    }}
    onPointerMove={(e) => {
      const d = drag.current
      if (!d || d.pointer !== e.pointerId) return
      const at = axis === 'x' ? e.clientX : e.clientY
      onChange(clampSize(d.value + (at - d.at) * direction, min, max))
    }}
    onPointerUp={(e) => { if (drag.current?.pointer !== e.pointerId) return; reset(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={reset} onLostPointerCapture={reset} onDoubleClick={onReset}
    onKeyDown={(e) => {
      const previous = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', next = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
      if (!['Home', 'End', previous, next].includes(e.key)) return
      e.preventDefault(); e.stopPropagation()
      onChange(e.key === 'Home' ? min : e.key === 'End' ? max : clampSize(value + (e.key === next ? 1 : -1) * direction * step, min, max))
    }}><span /></div>
}
