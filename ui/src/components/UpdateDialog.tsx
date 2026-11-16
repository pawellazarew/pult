import { createElement, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { UpdateStatus } from '../../../src/core/rpc.js'
import { getLanguage, t } from '../lib/i18n.js'
import { appUpdateView, localizedReleaseNotes, officialReleaseNotesUrl, updateActivity, updateBanner, updateSection } from '../model/update.js'
import type { UpdateAction } from '../model/update.js'
import { parseMarkdown, safeHref } from '../model/markdown.js'
import type { Block, Inline } from '../model/markdown.js'
import { Dialog } from './Panels.js'

/** Release notes reuse the safe parser, with no image loading, file actions or raw HTML. */
export function ReleaseNotes({ text, onExternal }: { text: string; onExternal(url: string): void }): ReactElement {
  const inline = (parts: Inline[]): ReactNode => parts.map((p, i) => {
    switch (p.t) {
      case 'text': return <span key={i}>{p.v}</span>
      case 'code': return <code key={i}>{p.v}</code>
      case 'br': return <br key={i} />
      case 'bold': return <strong key={i}>{inline(p.c)}</strong>
      case 'em': return <em key={i}>{inline(p.c)}</em>
      case 'del': return <del key={i}>{inline(p.c)}</del>
      case 'file': return <code key={i}>{p.path}</code>
      case 'image': return <span key={i}>{p.alt || p.url}</span>
      case 'link': {
        const href = safeHref(p.url)
        return href ? <a key={i} href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); onExternal(href) }}>{inline(p.c)}</a> : <span key={i}>{inline(p.c)}</span>
      }
    }
  })
  const blocks = (values: Block[]): ReactNode => values.map((b, i) => {
    switch (b.t) {
      case 'p': return <p key={i}>{inline(b.v)}</p>
      case 'h': return createElement(`h${Math.min(6, b.level + 1)}`, { key: i }, inline(b.v))
      case 'hr': return <hr key={i} />
      case 'code': return <pre key={i}><code>{b.v}</code></pre>
      case 'quote': return <blockquote key={i}>{blocks(b.c)}</blockquote>
      case 'list': return createElement(b.ordered ? 'ol' : 'ul', { key: i, ...(b.ordered ? { start: b.start } : {}) }, b.items.map((item, j) => <li key={j}>{item.task && <span aria-hidden="true">{item.task.checked ? '☑ ' : '☐ '}</span>}{blocks(item.c)}</li>))
      case 'table': return <div className="md-table" key={i}><table><thead><tr>{b.head.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{b.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>
    }
  })
  return <div className="md release-notes" data-testid="release-notes">{blocks(parseMarkdown(text))}</div>
}

export function UpdateDialog(p: {
  status: UpdateStatus | null | undefined; windowVersion: string | null; busy: boolean; checking: boolean; error: string | null; applyError: string | null; now: number
  onAction(action: UpdateAction): void; onCheck(): void; onExternal(url: string): void; onClose(): void
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const close = useRef(p.onClose); close.current = p.onClose
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = host.current?.querySelector<HTMLElement>('[role="dialog"]')
    const focusable = (): HTMLElement[] => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((el) => el.checkVisibility())
    const focus = (): void => { (dialog?.querySelector<HTMLElement>('[data-testid="update-dialog-apply"]:not(:disabled)') ?? focusable()[0])?.focus() }
    focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close.current(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); return }
      if (e.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items[items.length - 1]
      if (!first || !last) { e.preventDefault(); return }
      if (!dialog?.contains(document.activeElement) || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus()
      }
    }
    const keepFocus = (e: FocusEvent): void => { if (e.target instanceof Node && !dialog?.contains(e.target)) focus() }
    window.addEventListener('keydown', key, true)
    document.addEventListener('focusin', keepFocus)
    return () => {
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('focusin', keepFocus)
      requestAnimationFrame(() => {
        const visibleDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((el) => el.checkVisibility())
        if (previous?.isConnected && previous.checkVisibility() && (!visibleDialog || visibleDialog.contains(previous))) previous.focus()
      })
    }
  }, [])
  useEffect(() => { const dialog = host.current?.querySelector<HTMLElement>('[role="dialog"]'); if (!dialog?.contains(document.activeElement)) dialog?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  const section = updateSection(p.status, p.windowVersion, { checking: p.checking, error: p.error }, p.now)
  const banner = updateBanner(p.status, p.windowVersion)
  const app = appUpdateView(p.status, p.windowVersion)
  const activity = updateActivity(p.status)
  const action = activity?.state === 'installing' || activity?.state === 'verifying' ? null : banner ? banner.action : section.action ?? app.action
  const actionLabel = banner?.kind === 'available' && action && !action.force && !action.rollback ? t('Перезапустить и обновить') : action?.label
  const stateText = (banner?.kind === 'waiting' ? banner.text : activity?.text) ?? banner?.text ?? (app.state !== 'none' ? app.text : section.text)
  const notes = localizedReleaseNotes(p.status?.latest?.changelog)
  const version = p.status?.latest?.version ?? p.status?.current
  const released = p.status?.latest?.released
  const date = released && Number.isFinite(Date.parse(released)) ? new Intl.DateTimeFormat(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(released)) : null
  const apply = (): void => { if (action && (!action.confirm || window.confirm(action.confirm))) p.onAction(action) }
  return <div ref={host} className="update-dialog-host"><Dialog title={t('Что нового')} testId="update-dialog" onClose={p.onClose} footer={<>
    <button type="button" className="btn btn-ghost" onClick={() => p.onExternal(officialReleaseNotesUrl(p.status?.latest?.version))} data-testid="update-release-page">{t('Страница релиза на GitHub')}</button>
    <span className="grow" />
    <button type="button" className="btn" onClick={p.onClose} data-testid="update-dialog-close">{t('Закрыть')}</button>
    {action ? <button type="button" className={`btn${action.force ? '' : ' btn-primary'}`} disabled={p.busy} onClick={apply} data-testid="update-dialog-apply">{actionLabel}</button>
      : section.canCheck && <button type="button" className="btn" disabled={p.checking} onClick={p.onCheck} data-testid="update-dialog-check">{p.checking ? t('Проверяю…') : t('Проверить сейчас')}</button>}
  </>}>
    <div className="release-heading"><strong>{version ? t`Пульт ${version}` : t('Обновления Пульта')}</strong>{date && <time dateTime={released}>{date}</time>}</div>
    <div className="release-status" role="status" aria-live="polite" data-testid="update-dialog-state" data-state={banner?.kind === 'waiting' ? 'waiting' : activity?.state ?? section.state}>
      <span>{stateText}{banner?.kind === 'waiting' && activity && <small className="release-activity">{activity.text}</small>}</span>{activity?.percent !== null && activity?.percent !== undefined && <strong data-testid="update-dialog-percent">{activity.percent}%</strong>}
      {activity?.state === 'downloading' && <progress max="100" {...(activity.percent !== null ? { value: activity.percent, 'aria-valuenow': activity.percent } : {})} aria-label={activity.text} data-testid="update-dialog-progress" />}
    </div>
    {(p.applyError || p.error || section.note) && <p className="err" role="alert" data-testid="update-dialog-error">{p.applyError || p.error || section.note}</p>}
    {notes ? <ReleaseNotes text={notes} onExternal={p.onExternal} /> : <p className="note" data-testid="update-notes-unavailable">{t('Описание изменений не передано каналом обновлений. Открой страницу релиза на GitHub.')}</p>}
  </Dialog></div>
}
