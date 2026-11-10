import './slash.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, RefObject } from 'react'
import { t } from '../lib/i18n.js'
import { applySlash, findSlashToken, rankSlash } from '../model/slash.js'
import type { SlashItem, SlashListing, SlashSource, SlashToken } from '../model/slash.js'

// «/» в поле ввода (docs/19): список скиллов и команд папки чата над полем, в границах его рамки.
// ↑↓ — выбор, Enter/Tab — вставить, Esc — закрыть; мышью — наведение и щелчок. Список даёт демон (`agent.commands`).

/** Откуда окно берёт список: демон через мост. `null` — старая оболочка без метода. */
export type SlashLoader = (force?: boolean) => Promise<SlashListing>

const SOURCE_LABEL: Record<SlashSource, () => string> = {
  skill: () => t('скилл'),
  command: () => t('команда'),
  plugin: () => t('плагин'),
  builtin: () => t('встроенная'),
}

export interface SlashMenuProps {
  id: string
  items: readonly SlashItem[]
  active: number
  loading: boolean
  error: string | null
  query: string
  onPick(item: SlashItem): void
  onHover(index: number): void
}

/** Сам список — без состояния: его рисует render-тест. */
export function SlashMenu({ id, items, active, loading, error, query, onPick, onHover }: SlashMenuProps): ReactElement {
  const list = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, items])
  const status = items.length ? null
    : loading ? t('Загружаю скиллы и команды…')
      : error ? error
        : query ? t`Нет команд по «${query}»` : t('Для этой папки скиллов и команд нет')
  return (
    <div className="slash-menu" data-testid="slash-menu" onMouseDown={(e) => e.preventDefault()}>
      {items.length > 0 && (
        <ul ref={list} id={id} role="listbox" aria-label={t('Скиллы и команды')} className="slash-list">
          {items.map((it, i) => (
            <li key={`${it.source}:${it.name}`} id={`${id}-${i}`} role="option" aria-selected={i === active} data-index={i}
              className={`slash-row${i === active ? ' is-active' : ''}`} data-testid="slash-item"
              onMouseMove={() => { if (i !== active) onHover(i) }} onClick={() => onPick(it)}
              title={it.description || undefined}>
              <span className="slash-name">{it.insert.trimEnd()}</span>
              {it.argumentHint && <span className="slash-hint">{it.argumentHint}</span>}
              <span className="slash-desc">{it.description}</span>
              <span className={`slash-badge is-${it.source}`}>{SOURCE_LABEL[it.source]()}</span>
            </li>
          ))}
        </ul>
      )}
      {status && <div className="slash-status" role="status" data-testid="slash-status">{status}</div>}
      {items.length > 0 && error && <div className="slash-status is-warn" role="status">{error}</div>}
    </div>
  )
}

/** Текст ошибки моста словами: старая оболочка или старый демон метода не знают. */
export function slashErrorText(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? String((e as { code?: unknown }).code ?? '') : ''
  const message = e instanceof Error ? e.message : typeof e === 'object' && e !== null ? String((e as { message?: unknown }).message ?? '') : String(e)
  if (code === 'method_not_allowed' || /неизвестный метод|unknown method/iu.test(message)) return t('Список команд появится после обновления Pult')
  return message ? t`Список команд не загрузился: ${message}` : t('Список команд не загрузился')
}

/**
 * Состояние «/»-меню поля ввода: где набирается команда, что подходит, что выделено. `onKeyDown` зовётся ПЕРВЫМ
 * в обработчике поля; `true` — клавиша съедена меню (Enter не отправит реплику).
 */
export function useSlashMenu({ ta, text, setText, load, scope }: {
  ta: RefObject<HTMLTextAreaElement | null>
  text: string
  setText(next: string): void
  load: SlashLoader | null
  /** Смена чата (папки, провайдера) — список заново. */
  scope: string
}): {
  menu: ReactElement | null
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean
  onCaret(): void
  aria: Record<string, string | boolean | undefined>
} {
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null)
  const [lists, setLists] = useState<Readonly<Record<string, { items: SlashItem[]; error: string | null }>>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const id = useMemo(() => `slash-${Math.random().toString(36).slice(2, 8)}`, [])

  const onCaret = useCallback((): void => {
    const el = ta.current
    if (el) setCaret({ start: el.selectionStart, end: el.selectionEnd })
  }, [ta])
  // Каретку после набора знаем из самого поля: onChange обновляет текст раньше, чем React отдаст onSelect.
  useLayoutEffect(() => { onCaret() }, [text, onCaret])

  const token: SlashToken | null = load && caret ? findSlashToken(text, caret.start, caret.end) : null
  const open = token !== null && dismissed !== token.start
  useEffect(() => { if (!token) setDismissed(null) }, [token === null])

  // Список — при первом открытии в этом чате; потом из памяти (демон и так держит кэш). После ошибки — заново при
  // следующем открытии. Ответ кладётся под свой чат: поздний ответ прежнего чата не подменит список нового.
  const listing = lists[scope]
  useEffect(() => {
    if (!open || !load || (listing && listing.error === null) || loading === scope) return
    const at = scope
    setLoading(at)
    load().then(
      (r) => { setLists((m) => ({ ...m, [at]: { items: r.commands ?? [], error: r.error ? t`Список команд не обновился: ${r.error}` : null } })) },
      (e: unknown) => { setLists((m) => ({ ...m, [at]: { items: m[at]?.items ?? [], error: slashErrorText(e) } })) },
    ).finally(() => { setLoading((cur) => (cur === at ? null : cur)) })
  }, [open, load, scope, listing?.error === null])

  const pool = listing?.items ?? []
  const items = useMemo(() => (open && token ? rankSlash(pool, token.query, token.position) : []), [open, pool, token?.query, token?.position])
  useEffect(() => { setActive(0) }, [token?.query, token?.start, items.length])

  const pick = useCallback((item: SlashItem): void => {
    const el = ta.current
    if (!token) return
    const r = applySlash(el?.value ?? text, token, item.insert)
    setText(r.text)
    setDismissed(null)
    requestAnimationFrame(() => {
      const box = ta.current
      if (box && box.value === r.text) { box.focus(); box.setSelectionRange(r.caret, r.caret); setCaret({ start: r.caret, end: r.caret }) }
    })
  }, [ta, text, token, setText])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !token || e.nativeEvent.isComposing) return false
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(token.start); return true }
    if (!items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + step + items.length) % items.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      const it = items[Math.min(active, items.length - 1)]
      if (it) pick(it)
      return true
    }
    return false
  }

  const menu = open && token
    ? <SlashMenu id={id} items={items} active={active} loading={loading === scope && !items.length} error={listing?.error ?? null}
      query={token.query} onPick={pick} onHover={setActive} />
    : null
  return {
    menu,
    onKeyDown,
    onCaret,
    aria: {
      'aria-autocomplete': 'list',
      'aria-expanded': open && items.length > 0,
      'aria-controls': open && items.length > 0 ? id : undefined,
      'aria-activedescendant': open && items.length > 0 ? `${id}-${active}` : undefined,
    },
  }
}
