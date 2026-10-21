// Меню действий «как везде»: правый клик по строке или кнопка «⋯». Закрывается кликом мимо,
// Esc, прокруткой и потерей фокуса окна; не вылезает за край окна.
// M8f: ещё заголовки разделов, строки-пояснения и пункты с галочкой (меню настроек сессии в подвале).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

export type MenuEntry =
  | { label: string; onSelect(): void; danger?: boolean; disabled?: boolean; testId?: string; checked?: boolean; title?: string }
  | { heading: string; testId?: string }
  | { note: string; testId?: string }
  | 'sep'

export function ContextMenu({ at, items, onClose, testId, label, above }: {
  at: { x: number; y: number }
  items: readonly MenuEntry[]
  onClose(): void
  testId?: string
  /** Подпись меню для чтеца экрана. */
  label?: string
  /** Открыть НАД точкой (кнопка в подвале): `at.y` — низ меню. */
  above?: boolean
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const y0 = above ? at.y - r.height : at.y
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y0, window.innerHeight - r.height - 4)) })
    // Фокус — на отмеченный пункт, если он есть (меню выбора), иначе на первый.
    const checked = el.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not([disabled])')
    ;(checked ?? el.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus()
  }, [at.x, at.y, above])
  useEffect(() => {
    const down = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
      const i = btns.indexOf(document.activeElement as HTMLButtonElement)
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    // Прокрутка самого меню (длинный список моделей) его не закрывает — только прокрутка страницы под ним.
    // И только та, что случилась ПОСЛЕ открытия: событие `scroll` браузер доставляет на следующем кадре,
    // поэтому прокрутка, которая была до правого клика (список докрутили до строки у нижнего края окна),
    // приходит, когда меню уже открыто, и закрывала его на миг. Метка события — время самой прокрутки.
    const openedAt = performance.now()
    const scroll = (e: Event): void => {
      if (e.timeStamp < openedAt) return
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [onClose])
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} data-testid={testId ?? 'context-menu'}>
      {items.map((it, i) => {
        if (it === 'sep') return <div key={`s${i}`} className="ctx-sep" role="separator" />
        if ('heading' in it) return <div key={`h${i}`} className="ctx-head" role="presentation" data-testid={it.testId}>{it.heading}</div>
        if ('note' in it) return <div key={`n${i}`} className="ctx-note" role="note" data-testid={it.testId}>{it.note}</div>
        const radio = it.checked !== undefined
        return (
          <button key={`i${i}`} type="button" role={radio ? 'menuitemradio' : 'menuitem'} {...(radio ? { 'aria-checked': it.checked } : {})}
            className={`ctx-item${it.danger ? ' danger' : ''}${radio ? ' radio' : ''}`} disabled={it.disabled} title={it.title}
            data-testid={it.testId} onClick={() => { onClose(); it.onSelect() }}>
            {radio && <span className="ctx-check" aria-hidden="true">{it.checked ? '✓' : ''}</span>}{it.label}
          </button>
        )
      })}
    </div>
  )
}
