import { t } from '../lib/i18n.js'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
const MIN = .18, MAX = .55, DEFAULT = .30
const key = 'pult.sidebarRecentShare.v1'
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n))

/** A proportional split survives window resizing; pointer and keyboard share the same limits. */
export function SidebarSplit({ projects, recent }: { projects: ReactNode; recent: ReactNode }): ReactElement {
  const [share, setShare] = useState(() => {
    try { const saved = window.localStorage.getItem(key); const n = Number(saved); return saved && Number.isFinite(n) ? clamp(n) : DEFAULT } catch { return DEFAULT }
  })
  const [minimum, setMinimum] = useState(MIN)
  const actual = Math.max(minimum, share)
  const value = useRef(actual)
  value.current = actual
  const dragging = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(() => { const height = element.clientHeight; if (height) setMinimum(Math.min(MAX, Math.max(MIN, 104 / height))) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const update = (n: number): void => { value.current = Math.max(minimum, clamp(n)); setShare(value.current) }
  const save = (): void => { try { window.localStorage.setItem(key, String(value.current)) } catch { /* private storage may be disabled */ } }
  return <div className="tree project-sidebar" ref={root} data-testid="agent-list" style={{ '--recent-share': `${actual * 100}%` } as CSSProperties}>
    {projects}
    <div className="sidebar-splitter" role="separator" tabIndex={0} aria-label={t("Высота списка недавних")} aria-orientation="horizontal"
      aria-valuemin={Math.round(minimum * 100)} aria-valuemax={MAX * 100} aria-valuenow={Math.round(actual * 100)} data-testid="recent-resize"
      title={t("Потяни, чтобы изменить высоту недавних. Двойной клик — сбросить.")}
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (!dragging.current || !root.current) return; const box = root.current.getBoundingClientRect(); if (box.height) update((box.bottom - e.clientY) / box.height) }}
      onPointerUp={(e) => { if (!dragging.current) return; dragging.current = false; save(); e.currentTarget.releasePointerCapture(e.pointerId) }}
      onLostPointerCapture={() => { if (dragging.current) { dragging.current = false; save() } }}
      onDoubleClick={() => { update(DEFAULT); save() }}
      onKeyDown={(e) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        update(e.key === 'Home' ? minimum : e.key === 'End' ? MAX : value.current + (e.key === 'ArrowUp' ? .04 : -.04)); save()
      }}><span /></div>
    {recent}
  </div>
}
