import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import type { ImageBridge } from './Images.js'
import { ImagePreview, isImagePath } from './Images.js'
import { parseMarkdown, safeHref } from '../model/markdown.js'
import type { Align, Block, Inline, ListItem } from '../model/markdown.js'

/**
 * Что реплике нужно от моста: буфер обмена и внешний браузер. `openExternal` необязателен —
 * интерфейс ездит отдельно от Pult.app, и в старой оболочке его нет: тогда ссылка копируется.
 */
export interface MdBridge extends ImageBridge {
  copyText(text: string): Promise<void>
  openExternal?(url: string): Promise<void>
}

/** Мост для реплик. Нет провайдера (тесты, окно вне оболочки) — кнопки рисуются, но молчат. */
export const MdBridgeContext = createContext<MdBridge | null>(null)

const FLASH_MS = 1500

/** Короткая отметка «сделано» у элемента; таймер гаснет вместе с компонентом. */
export function useFlash(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = (t: string): void => {
    setText(t)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setText(null), FLASH_MS)
  }
  return [text, show]
}

/**
 * Клик по коду или ссылке — действие, только если человек не выделяет текст: протянул мышью
 * (выделение не пусто) или щёлкнул дважды (выделяет слово) — выделение важнее.
 */
export function clickActs(selection: string, clicks: number): boolean {
  return selection === '' && clicks <= 1
}

/**
 * Скопировать текст через мост (тот же путь, что у «Копировать» блока кода): `true` — в буфере.
 * Моста нет (тесты, окно вне оболочки) или буфер отказал — `false`, без исключения.
 */
export async function copyToClipboard(bridge: MdBridge | null, text: string): Promise<boolean> {
  if (!bridge) return false
  try { await bridge.copyText(text); return true } catch { return false }
}

const selectionText = (): string => window.getSelection?.()?.toString() ?? ''

/**
 * Переход по ссылке: системный браузер через мост; старая оболочка (нет `openExternal`) или отказ
 * браузера — адрес в буфер, чтобы человек открыл его сам.
 */
export async function followLink(bridge: MdBridge, href: string, url: string): Promise<'opened' | 'copied' | 'failed'> {
  if (bridge.openExternal) {
    try { await bridge.openExternal(href); return 'opened' } catch { /* копируем ниже */ }
  }
  try { await bridge.copyText(url); return 'copied' } catch { return 'failed' }
}

function InlineCode({ v }: { v: string }): ReactElement {
  const bridge = useContext(MdBridgeContext)
  const [flash, show] = useFlash()
  const onClick = (e: MouseEvent): void => {
    if (!bridge || !clickActs(selectionText(), e.detail)) return
    bridge.copyText(v).then(() => show('Скопировано'), () => { /* буфер недоступен */ })
  }
  return (
    <code className={`md-icode${flash ? ' md-flash' : ''}`} title="Нажми — скопировать" onClick={onClick}
      {...(flash ? { 'data-flash': flash } : {})}>{v}</code>
  )
}

function Link({ href, url, title, children }: { href: string; url: string; title?: string; children: ReactNode }): ReactElement {
  const bridge = useContext(MdBridgeContext)
  const [flash, show] = useFlash()
  const onClick = (e: MouseEvent): void => {
    // Окно само никуда не ходит (оболочка режет навигацию): адрес уходит в системный браузер.
    e.preventDefault()
    if (!bridge || !clickActs(selectionText(), e.detail)) return
    void followLink(bridge, href, url).then((r) => { if (r === 'copied') show('Ссылка скопирована') })
  }
  return (
    <a href={href} className={`md-a${flash ? ' md-flash' : ''}`} title={title ? `${title}\n${url}` : url} rel="noreferrer"
      onClick={onClick} {...(flash ? { 'data-flash': flash } : {})}>{children}</a>
  )
}

function Inl({ parts }: { parts: Inline[] }): ReactElement {
  return <>{parts.map((p, i) => {
    switch (p.t) {
      case 'text': return <span key={i}>{p.v}</span>
      case 'code': return <InlineCode key={i} v={p.v} />
      case 'bold': return <strong key={i}><Inl parts={p.c} /></strong>
      case 'em': return <em key={i}><Inl parts={p.c} /></em>
      case 'del': return <del key={i}><Inl parts={p.c} /></del>
      case 'br': return <br key={i} />
      case 'image': {
        const href = safeHref(p.url)
        return href ? <Link key={i} href={href} url={p.url}>{p.alt || 'Открыть изображение'}</Link> : <ImagePreview key={i} source={p.url} label={p.alt} />
      }
      case 'link':
        if (isImagePath(p.url)) return <ImagePreview key={i} source={p.url} label={p.c.map((c) => c.t === 'text' ? c.v : '').join('') || undefined} />
        return p.href
          ? <Link key={i} href={p.href} url={p.url} {...(p.title ? { title: p.title } : {})}><Inl parts={p.c} /></Link>
          // Схема не из белого списка (javascript:, file:, путь в репозитории) — просто текст.
          : <span key={i} className="md-link-off" title={p.url}><Inl parts={p.c} /></span>
    }
  })}</>
}

function CodeBlock({ lang, v }: { lang: string; v: string }): ReactElement {
  const bridge = useContext(MdBridgeContext)
  const [flash, show] = useFlash()
  const copy = (): void => {
    bridge?.copyText(v).then(() => show('Скопировано'), () => { /* буфер недоступен */ })
  }
  return (
    <div className="md-code" data-testid="md-code">
      <div className="md-code-head">
        <span className="lang">{lang || 'код'}</span>
        <button type="button" className={`md-copy${flash ? ' done' : ''}`} onClick={copy} data-testid="md-copy">{flash ?? 'Копировать'}</button>
      </div>
      <pre><code>{v}</code></pre>
    </div>
  )
}

const alignClass = (a: Align): string | undefined => (a ? `al-${a}` : undefined)

function Table({ b }: { b: Block & { t: 'table' } }): ReactElement {
  return (
    // Широкая таблица листается сама, а не раздвигает колонку разговора.
    <div className="md-table">
      <table>
        <thead><tr>{b.head.map((c, k) => <th key={k} className={alignClass(b.align[k] ?? null)}><Inl parts={c} /></th>)}</tr></thead>
        {b.rows.length > 0 && (
          <tbody>{b.rows.map((r, j) => (
            <tr key={j}>{r.map((c, k) => <td key={k} className={alignClass(b.align[k] ?? null)}><Inl parts={c} /></td>)}</tr>
          ))}</tbody>
        )}
      </table>
    </div>
  )
}

/** Пункт списка: первый абзац — прямо в строке пункта, остальное (вложенные списки, код) — блоками. */
function Item({ it }: { it: ListItem }): ReactElement {
  const [head, ...rest] = it.c
  const lead = head?.t === 'p' ? head : null
  const tail = lead ? rest : it.c
  return (
    <li className={it.task ? 'md-task-li' : undefined}>
      {it.task && <span className={`md-task${it.task.checked ? ' on' : ''}`} role="img" aria-label={it.task.checked ? 'сделано' : 'не сделано'} />}
      {lead && <Inl parts={lead.v} />}
      {tail.length > 0 && <Blocks blocks={tail} />}
    </li>
  )
}

function Heading({ level, children }: { level: number; children: ReactNode }): ReactElement {
  switch (level) {
    case 1: return <h1>{children}</h1>
    case 2: return <h2>{children}</h2>
    case 3: return <h3>{children}</h3>
    case 4: return <h4>{children}</h4>
    case 5: return <h5>{children}</h5>
    default: return <h6>{children}</h6>
  }
}

function Blocks({ blocks, caret }: { blocks: Block[]; caret?: boolean }): ReactElement {
  return <>{blocks.map((b, i) => {
    switch (b.t) {
      case 'code': return <CodeBlock key={i} lang={b.lang} v={b.v} />
      case 'h': return <Heading key={i} level={b.level}><Inl parts={b.v} /></Heading>
      case 'hr': return <hr key={i} />
      case 'table': return <Table key={i} b={b} />
      case 'list': {
        const items = b.items.map((it, j) => <Item key={j} it={it} />)
        return b.ordered ? <ol key={i} {...(b.start !== 1 ? { start: b.start } : {})}>{items}</ol> : <ul key={i}>{items}</ul>
      }
      case 'quote': return <blockquote key={i}><Blocks blocks={b.c} /></blockquote>
      case 'p': {
        const content = b.v.filter((p) => !(p.t === 'text' && !p.v.trim()) && p.t !== 'br')
        const gallery = content.length > 0 && content.every((p) =>
          (p.t === 'image' && !safeHref(p.url)) || (p.t === 'link' && isImagePath(p.url)))
        // Курсор «печатает» — в конце последнего абзаца, а не отдельной строкой под ним.
        const tail = caret && i === blocks.length - 1
        return <p key={i} className={gallery ? 'image-gallery' : undefined}><Inl parts={gallery ? content : b.v} />{tail && <span className="caret" aria-label="печатает" />}</p>
      }
    }
  })}</>
}

/**
 * Реплика модели или человека (`human`, M8e): разбор — чистая функция, здесь только элементы React (без
 * innerHTML) — текст обоих чужой (импорт, чужие сессии), правила ссылок одни.
 */
export function Markdown({ text, streaming, human }: { text: string; streaming?: boolean; human?: boolean }): ReactElement {
  const blocks = useMemo(() => parseMarkdown(text, human ? { human: true } : {}), [text, human])
  return (
    <div className="md">
      <Blocks blocks={blocks} caret={!!streaming} />
      {streaming && blocks[blocks.length - 1]?.t !== 'p' && <span className="caret" aria-label="печатает" />}
    </div>
  )
}
