import { t } from '../lib/i18n.js'
// Поиск по всем разговорам — ⌘⇧F (О2, docs/14 «Поиск, метки, экспорт»). Запрос уходит демону
// (`events.search`) через 200 мс после последней буквы; выдача — по сессиям, новые первыми. ↑/↓ —
// по результатам, Enter или клик — открыть сессию на этом месте ленты. Логика — model/search.ts.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { errorText, isBridgeError } from '../bridge.js'
import type { SearchGroup, SearchHit, SearchReply } from '../model/search.js'
import { flatHits, groupHits, kindView, splitSnippet } from '../model/search.js'
import { hhmm, Icon, Kbd } from './common.js'
import { Dialog } from './Panels.js'

export const SEARCH_DEBOUNCE_MS = 200

/**
 * Один поиск с исходом для окна. Демон отменил и ЭТОТ запрос (`superseded`: тот же клиент искал из
 * другого окна, демон останавливается) — ещё раз, один; снова отменён — ошибка «прерван»: выдача не
 * застревает на «ищу…». Старый демон или оболочка без метода — «обнови Пульт».
 */
export async function searchOnce(run: (q: string) => Promise<SearchReply>, q: string): Promise<{ ok: true; reply: SearchReply } | { ok: false; error: string }> {
  for (let i = 0; i < 2; i++) {
    let reply: SearchReply
    try {
      reply = await run(q)
    } catch (e) {
      const old = isBridgeError(e) && (e.code === 'method_not_allowed' || e.code === 'not_found')
      return { ok: false, error: old ? t('Поиск не поддерживается: демон или окно старше — обнови Пульт.') : errorText(e) }
    }
    if (!reply.superseded) return { ok: true, reply }
  }
  return { ok: false, error: t('Поиск прерван — попробуй ещё раз.') }
}

/** Время результата: сегодня — часы, иначе ещё и дата. */
export function whenLabel(ts: string, now: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const n = new Date(now)
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return today ? hhmm(ts) : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(ts)}`
}

/** Выдача: заголовок сессии и её совпадения. Без состояния — её же рисует юнит-тест. */
export function SearchResults({ groups, query, selected, now, onOpen }: {
  groups: readonly SearchGroup[]; query: string; selected: number; now: number; onOpen(hit: SearchHit): void
}): ReactElement {
  let i = -1
  return (
    <div className="search-results" role="listbox" aria-label={t("Результаты поиска")} data-testid="search-results">
      {groups.map((g) => (
        <section key={g.sessionId} className="search-group" data-testid="search-group" data-session={g.sessionId}>
          <div className="search-group-h" title={g.sessionId}>{g.label}<span className="n">{g.hits.length}</span></div>
          {g.hits.map((h) => {
            i += 1
            const k = kindView(h.kind)
            const [pre, hit, post] = splitSnippet(h, query)
            const on = i === selected
            return (
              <button key={h.eventId} type="button" role="option" aria-selected={on} className={`search-hit${on ? ' on' : ''}`}
                data-testid="search-hit" data-session={h.sessionId} data-event-id={h.eventId} data-kind={h.kind}
                onClick={() => onOpen(h)}>
                <span className={`search-kind k-${k.icon}`} title={k.label}><Icon name={k.icon} /></span>
                <span className="search-snip">{pre}{hit && <mark>{hit}</mark>}{post}</span>
                <span className="search-ts">{whenLabel(h.ts, now)}</span>
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}

export function SearchDialog({ run, labelOf, now, onOpen, onClose }: {
  run(query: string): Promise<SearchReply>
  /** Подпись сессии; `null` — окно её не знает (удалена), из выдачи она уходит. */
  labelOf(name: string): string | null
  now: number
  onOpen(hit: SearchHit): void
  onClose(): void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; reply: SearchReply | null; error: string | null; for: string }>(
    { status: 'idle', reply: null, error: null, for: '' })
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  useEffect(() => { input.current?.focus() }, [])

  useEffect(() => {
    const q = query.replace(/\s+/g, ' ').trim()
    const my = ++seq.current
    if (!q) { setState({ status: 'idle', reply: null, error: null, for: '' }); return }
    setState((s) => ({ ...s, status: 'loading' }))
    const t = window.setTimeout(() => {
      void searchOnce(run, q).then((r) => {
        // Ответ на прежний запрос — мимо: выдача только для того, что в поле.
        if (my !== seq.current) return
        if (r.ok) { setState({ status: 'done', reply: r.reply, error: null, for: q }); setSelected(0) }
        else setState({ status: 'error', reply: null, error: r.error, for: q })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, run])

  const groups = useMemo(() => groupHits(state.reply?.results ?? [], labelOf), [state.reply, labelOf])
  const flat = useMemo(() => flatHits(groups), [groups])
  const open = (h: SearchHit | undefined): void => { if (h) onOpen(h) }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!flat.length) return
      setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); open(flat[selected]) }
  }
  // Выделенный результат — в видимой части списка.
  useEffect(() => {
    document.querySelector('.search-hit.on')?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const count = state.reply?.results.length ?? 0
  return (
    <Dialog title={t("Поиск по разговорам")} onClose={onClose} size="wide" testId="search-dialog"
      footer={<>
        <span className="note" data-testid="search-status">
          {state.status === 'loading' ? t('ищу…')
            : state.status === 'error' ? <span className="t-fail">{state.error}</span>
            : state.status === 'done' ? (count ? t`${count}${state.reply?.truncated ? '+' : ''} — самые новые первыми` : t('ничего не нашлось'))
            : t('реплики, ответы модели и вызовы инструментов всех сессий')}
        </span>
        <span className="grow" />
        <span className="note"><Kbd>↑↓</Kbd>{t(" выбрать · ")}<Kbd>↵</Kbd>{t(" открыть · ")}<Kbd>Esc</Kbd>{t(" закрыть")}</span>
      </>}>
      <label className="field search-field">
        <Icon name="search" />
        <input ref={input} value={query} placeholder={t("что искать")} aria-label={t("Что искать")} data-testid="search-input"
          maxLength={200} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </label>
      {groups.length > 0 && <SearchResults groups={groups} query={state.for} selected={selected} now={now} onOpen={open} />}
    </Dialog>
  )
}
