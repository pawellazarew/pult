import { t } from '../lib/i18n.js'
import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode, RefObject } from 'react'
import { clampSize, savedSize, workspaceSizes } from '../model/panelSizes.js'
import type { WorkspaceFlags } from '../model/panelSizes.js'
import { ResizeHandle } from './ResizeHandle.js'

export function usePanelSize(key: string): [number | null, (value: number | null) => void] {
  const [size, setSize] = useState(() => { try { return savedSize(window.localStorage.getItem(key)) } catch { return null } })
  return [size, (value) => {
    setSize(value)
    try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, String(value)) } catch { /* storage can be unavailable */ }
  }]
}

export function usePanelBox<T extends HTMLElement>(ref: RefObject<T | null>, defaults: { width: number; height: number }) {
  const [size, setSize] = useState(defaults)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => { const box = el.getBoundingClientRect(); if (box.width && box.height) setSize({ width: box.width, height: box.height }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** The separators overlay the existing one-pixel borders instead of taking space from the panels. */
export function WorkspaceLayout({ children, ...flags }: WorkspaceFlags & { children: ReactNode }): ReactElement {
  const root = useRef<HTMLElement>(null)
  const { width } = usePanelBox(root, { width: 1280, height: 720 })
  const [sidebar, setSidebar] = usePanelSize('pult.panel.sidebar.v1')
  const [inbox, setInbox] = usePanelSize('pult.panel.inbox.v1')
  const [files, setFiles] = usePanelSize('pult.panel.files.v1')
  const s = workspaceSizes(width, flags, { sidebar, right: flags.filesOpen ? files : inbox })
  const columns = [!flags.sidebarHidden ? `${s.sidebar}px` : '', 'minmax(0, 1fr)', s.rightShown ? `${s.right}px` : ''].filter(Boolean).join(' ')
  return <main ref={root} className={`grid resizable-workspace${flags.sidebarHidden ? ' sidebar-hidden' : ''}${flags.inboxOpen ? ' with-inbox' : ''}${flags.filesOpen ? ` with-files${flags.filesExpanded ? ' files-focused' : ''}` : ''}`}
    style={{ gridTemplateColumns: columns }}>
    {children}
    {!flags.sidebarHidden && <ResizeHandle label={t("Ширина списка проектов")} value={s.sidebar} min={s.sidebarMin} max={s.sidebarMax}
      onChange={setSidebar} onReset={() => setSidebar(null)} testId="sidebar-resize" className="workspace-boundary" style={{ left: s.sidebar }} />}
    {s.rightShown && <ResizeHandle label={flags.filesOpen ? t('Ширина просмотра файлов') : t('Ширина списка ответов')} direction={-1}
      value={s.right} min={s.rightMin} max={s.rightMax} onChange={flags.filesOpen ? setFiles : setInbox}
      onReset={() => (flags.filesOpen ? setFiles : setInbox)(null)} testId="right-panel-resize" className="workspace-boundary" style={{ right: s.right, transform: 'translateX(50%)' }} />}
  </main>
}

/** A taller input is useful for long requests; the conversation always retains reading space. */
export function ResizableComposer({ children }: { children: ReactNode }): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = usePanelSize('pult.panel.composer.v1')
  const [max, setMax] = useState(300)
  const [measuredInput, setMeasuredInput] = useState(84)
  const automatic = size === null
  useLayoutEffect(() => {
    if (!automatic) return
    const input = root.current?.querySelector('textarea')
    if (!input) return
    // A reset must discard a height computed while manual min/max constraints were active.
    // Subsequent text changes continue to use the composer's existing auto-grow effect.
    input.style.height = 'auto'
    input.style.height = `${Math.max(84, Math.min(240, input.scrollHeight + 2))}px`
  }, [automatic])
  useLayoutEffect(() => {
    const column = root.current?.closest('.conv')
    if (!column) return
    const measure = (): void => {
      const composer = root.current, input = composer?.querySelector('textarea')
      if (!composer || !input) return
      setMeasuredInput(input.getBoundingClientRect().height)
      const other = [...column.children].filter((el) => el !== composer && !el.classList.contains('feed-wrap'))
        .reduce((height, el) => height + el.getBoundingClientRect().height, 0)
      const controls = composer.getBoundingClientRect().height - input.getBoundingClientRect().height
      setMax(Math.max(78, Math.min(500, Math.floor(column.clientHeight * .42), Math.floor(column.clientHeight - other - controls - 96))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    if (root.current) {
      observer.observe(root.current)
      const input = root.current.querySelector('textarea')
      if (input) observer.observe(input)
    }
    const feed = column.querySelector('.feed-wrap')
    if (feed) observer.observe(feed)
    return () => observer.disconnect()
  }, [])
  const actual = clampSize(size ?? measuredInput, 78, max)
  return <div ref={root} className="composer resizable-composer" data-input-resized={automatic ? undefined : '1'}
    style={{ '--composer-input-max': `${max}px`, ...(!automatic ? { '--composer-input-size': `${actual}px` } : {}) } as CSSProperties}>
    <ResizeHandle label={t("Высота поля ввода")} axis="y" direction={-1} value={actual} min={78} max={max} onChange={setSize}
      onReset={() => setSize(null)} testId="composer-resize" className="composer-boundary" />
    {children}
  </div>
}
