// Мелкие общие куски: иконки (свой набор, без шрифтов-иконок и сети), чип статуса, метка провайдера.

import type { ReactElement } from 'react'
import type { Tone } from '../model/types.js'

const PATHS: Record<string, ReactElement> = {
  'folder-open': <><path d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13v2M2 12.5l2-6h10l-2 6z" /></>,
  expand: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  collapse: <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" />,
  file: <><path d="M3.5 1.5h5l4 4v9h-9zM8.5 1.5v4h4M5.5 8h5M5.5 10.5h4" /></>,
  sidebar: <><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chev: <path d="M6 3l5 5-5 5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  branch: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" /></>,
  alert: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></>,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 4.9v.1" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  inbox: <><path d="M2 9.5l1.8-6h8.4l1.8 6V13H2z" /><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" /></>,
  pulse: <path d="M1.5 8.5h3l1.5-4 2.5 8 2-5.5 1 1.5h3" />,
  send: <path d="M2.5 8L13.5 3l-3 10.5-2.5-4.5z" />,
  edit: <><path d="M3 13l.6-2.9 7.3-7.3 2.3 2.3-7.3 7.3z" /><path d="M9.5 4.2l2.3 2.3" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></>,
  refresh: <><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></>,
  // О2 «Поиск»: лупа, человек, ответ модели, инструмент.
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  you: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /></>,
  model: <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  tool: <path d="M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2 4.8 13l4.7-4.7a3 3 0 0 0 4-2.8l-1.8 1.8-1.7-.4-.4-1.7z" />,
  mark: <><rect x="1.5" y="1.5" width="13" height="13" rx="2" /><path d="M4.5 10.5l2-2 2 1.5 3-4.5" /></>,
}

export function Icon({ name, className = 'ic' }: { name: keyof typeof PATHS | string; className?: string }): ReactElement {
  return (
    // Размер по умолчанию — атрибутами (16×16): без правила CSS для своего места значок остаётся значком, а не
    // растягивается на всю ширину родителя (так было с плашкой «Очередь стоит»). CSS места их перекрывает.
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  )
}

export function Chip({ tone, label, testId }: { tone: Tone; label: string; testId?: string }): ReactElement {
  return (
    <span className={`chip tone-${tone}`} data-testid={testId}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  )
}

export function ProviderTag({ provider }: { provider: string }): ReactElement {
  return <span className={`tag tag-${provider}`}>{provider}</span>
}

export function Kbd({ children }: { children: string }): ReactElement {
  return <span className="kbd">{children}</span>
}

/** Часы:минуты по местному времени из ISO — для колонки времени в ленте. */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
export const CMD = IS_MAC ? '⌘' : 'Ctrl+'
