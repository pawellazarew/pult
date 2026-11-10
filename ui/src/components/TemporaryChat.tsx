import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactElement, ReactNode } from 'react'
import type { TemporaryCapability, TemporaryConfigureRequest, TemporaryDraftRequest, TemporaryIdentity, TemporaryPromptRequest, TemporarySettings, TemporarySnapshot } from '../../../src/temporary/types.js'
import type { Block, Inline } from '../model/markdown.js'
import type { ProviderCatalog } from '../model/types.js'
import { temporaryBusy, TemporaryDraftBuffer, temporaryErrorCode, temporaryErrorMessage, temporaryMarkdown, temporaryPromptId } from '../model/temporary.js'
import { PRESETS } from '../model/newAgent.js'
import { effortOptions } from '../model/sessionSettings.js'
import { FilePreviewContext } from '../model/filePreviewContext.js'
import { t } from '../lib/i18n.js'
import { MdBridgeContext } from './Markdown.js'
import { MessageText } from './MessageText.js'
import { ImageContext } from './Images.js'
import { ProviderIcon } from './ProviderIcon.js'
import { Icon } from './common.js'
import './temporary-chat.css'

export interface TemporaryChatProps {
  chat: TemporarySnapshot
  capabilities: readonly TemporaryCapability[]
  online: boolean
  catalog?: ProviderCatalog | null
  headerActions?: ReactNode
  onDraft(request: TemporaryDraftRequest): Promise<TemporarySnapshot>
  onConfigure(request: TemporaryConfigureRequest): Promise<TemporarySnapshot>
  /** Return an authoritative read after prompt acceptance, including the current draft revision. */
  onPrompt(request: TemporaryPromptRequest): Promise<TemporarySnapshot>
  onStop(identity: TemporaryIdentity): Promise<TemporarySnapshot>
  /** The parent opens a confirmation; switching or unmounting never calls this. */
  onEnd(identity: TemporaryIdentity): void
  copyText?(text: string): Promise<void>
  openExternal?(url: string): Promise<void>
}

interface TextActions { copyText?: TemporaryChatProps['copyText']; openExternal?: TemporaryChatProps['openExternal'] }

function TextInlines({ parts, openExternal }: { parts: readonly Inline[] } & TextActions): ReactElement {
  return <>{parts.map((part, index) => {
    const nested = (c: Inline[]): ReactElement => <TextInlines parts={c} {...(openExternal ? { openExternal } : {})} />
    switch (part.t) {
      case 'text': return <span key={index}>{part.v}</span>
      case 'code': return <code key={index}>{part.v}</code>
      case 'bold': return <strong key={index}>{nested(part.c)}</strong>
      case 'em': return <em key={index}>{nested(part.c)}</em>
      case 'del': return <del key={index}>{nested(part.c)}</del>
      case 'br': return <br key={index} />
      case 'link': return part.href && openExternal ? <a key={index} href={part.href} rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternal(part.href!).catch(() => {}) }}>{nested(part.c)}</a> : <span key={index}>{nested(part.c)}</span>
      // These variants are eliminated by temporaryMarkdown; the renderer still never gives them capabilities.
      case 'file': return <span key={index}>{part.path}</span>
      case 'image': return <span key={index}>{part.alt || part.url}</span>
    }
  })}</>
}

function TextBlocks({ blocks, ...actions }: { blocks: readonly Block[] } & TextActions): ReactElement {
  const inline = (parts: Inline[]): ReactElement => <TextInlines parts={parts} {...actions} />
  return <>{blocks.map((block, index) => {
    switch (block.t) {
      case 'code': return <div key={index} className="md-code"><div className="md-code-head"><span className="lang">{block.lang || t('код')}</span>{actions.copyText && <button type="button" className="md-copy" aria-label={t('Скопировать код')} onClick={() => { void actions.copyText!(block.v).catch(() => {}) }}><Icon name="copy" /></button>}</div><pre><code>{block.v}</code></pre></div>
      case 'p': return <p key={index}>{inline(block.v)}</p>
      case 'h': { const Tag = `h${block.level}` as 'h1'; return <Tag key={index}>{inline(block.v)}</Tag> }
      case 'hr': return <hr key={index} />
      case 'quote': return <blockquote key={index}><TextBlocks blocks={block.c} {...actions} /></blockquote>
      case 'list': {
        const rows = block.items.map((item, itemIndex) => <li key={itemIndex}>{item.task && <input type="checkbox" checked={item.task.checked} readOnly disabled aria-label={t('Пункт списка')} />}<TextBlocks blocks={item.c} {...actions} /></li>)
        return block.ordered ? <ol key={index} start={block.start}>{rows}</ol> : <ul key={index}>{rows}</ul>
      }
      case 'table': return <div key={index} className="md-table"><table><thead><tr>{block.head.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>
    }
  })}</>
}

/** Formatting is shared through the parser, with a render tree that cannot read files or load images. */
export function TemporaryMarkdown({ text, human = false, streaming = false, ...actions }: { text: string; human?: boolean; streaming?: boolean } & TextActions): ReactElement {
  const blocks = useMemo(() => temporaryMarkdown(text, human), [text, human])
  return <div className="md temporary-markdown"><TextBlocks blocks={blocks} {...actions} />{streaming && <span className="caret" aria-label={t('печатает')} />}</div>
}

export function TemporaryChat(props: TemporaryChatProps): ReactElement {
  const { chat, online } = props
  const identity = { epoch: chat.epoch, id: chat.id }
  const buffer = useMemo(() => new TemporaryDraftBuffer(chat, props.onDraft), [chat.epoch, chat.id])
  buffer.setWriter(props.onDraft)
  const draft = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot)
  const [action, setAction] = useState<'send' | 'configure' | 'stop' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const sendLock = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const feed = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const available = props.capabilities.find((capability) => capability.provider === chat.settings.provider)?.available === true
  const busy = temporaryBusy(chat.status)
  const closed = draft.expired || chat.status === 'closed'
  const settingsLocked = closed || busy || chat.messages.length > 0 || action !== null
  const actions = { ...(props.copyText ? { copyText: props.copyText } : {}), ...(props.openExternal ? { openExternal: props.openExternal } : {}) }
  const narrowBridge = useMemo(() => ({ copyText: props.copyText ?? (async () => {}), ...(props.openExternal ? { openExternal: props.openExternal } : {}) }), [props.copyText, props.openExternal])
  useEffect(() => { buffer.observe(chat) }, [buffer, chat])
  useEffect(() => { buffer.setOnline(online) }, [buffer, online])
  useEffect(() => {
    const flush = (): void => { void buffer.flush() }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', flush); void buffer.flush() }
  }, [buffer])
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.max(76, Math.min(210, element.scrollHeight))}px`
  }, [draft.text])
  useLayoutEffect(() => { if (stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [chat.messages, busy])

  const configure = async (settings: TemporarySettings): Promise<void> => {
    if (settingsLocked || !online) return
    setAction('configure'); setError(null)
    try { buffer.observe(await props.onConfigure({ ...identity, settings })) } catch (failure) { setError({ code: temporaryErrorCode(failure) }) }
    finally { setAction(null) }
  }
  const send = async (): Promise<void> => {
    if (sendLock.current || closed || busy || action || !online || !available || !draft.text.trim() || draft.conflict) return
    sendLock.current = true
    setAction('send'); setError(null); setInputNotice(null)
    const text = buffer.getSnapshot().text
    try {
      await buffer.flush()
      const current = buffer.getSnapshot()
      if (current.dirty || current.conflict || current.expired || current.error) return
      if (current.text !== text) { setError({ code: 'draft_changed' }); return }
      const snapshot = await props.onPrompt({ ...identity, text, clientMessageId: temporaryPromptId(current.revision) })
      buffer.observe(snapshot)
      stick.current = true
    } catch (failure) { setError({ code: temporaryErrorCode(failure) }) }
    finally { sendLock.current = false; setAction(null) }
  }
  const stop = async (): Promise<void> => {
    if (action || !online || closed) return
    setAction('stop'); setError(null)
    try { buffer.observe(await props.onStop(identity)) } catch (failure) { setError({ code: temporaryErrorCode(failure) }) }
    finally { setAction(null) }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.shiftKey) return
    event.preventDefault()
    if (!event.altKey) void send()
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    event.stopPropagation()
    if (event.clipboardData.files.length) { event.preventDefault(); setInputNotice(t('Временный чат принимает только текст.')) }
  }
  const models = chat.settings.provider === 'claude' ? PRESETS.claude.models.map((id) => ({ id, label: id })) : props.catalog?.codex.models ?? []
  const selectedModel = chat.settings.model ?? ''
  const modelOptions = selectedModel && !models.some((model) => model.id === selectedModel) ? [{ id: selectedModel, label: selectedModel }, ...models] : models
  const efforts = effortOptions(chat.settings.provider, props.catalog, chat.settings.model)
  const effortValues = chat.settings.effort && !efforts.includes(chat.settings.effort) ? [chat.settings.effort, ...efforts] : efforts
  const failure = error ?? (draft.error ? { code: draft.error } : chat.error)
  return <MdBridgeContext.Provider value={narrowBridge}><ImageContext.Provider value={null}><FilePreviewContext.Provider value={null}>
    <section className="conv temporary-chat" data-testid="temporary-chat" data-temporary-chat="true" data-temporary-id={chat.id} data-status={chat.status}
      onDrop={(event) => { event.stopPropagation(); if (event.dataTransfer.files.length) { event.preventDefault(); setInputNotice(t('Временный чат принимает только текст.')) } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'none' } }}>
      <header className="conv-head temporary-head">
        <div className="temporary-title"><h2>{t('Временный чат')}</h2><details className="temporary-info"><summary aria-label={t('О временном чате')} title={t('О временном чате')}><Icon name="clock" /><span>{t('Временный')}</span></summary><div role="note">{t('Пульт не сохраняет переписку в своей истории и локальной истории CLI. Чат исчезнет после перезапуска демона. У провайдера свои правила хранения данных.')}</div></details></div>
        <div className="temporary-head-actions">{props.headerActions}<button type="button" className="chrome-icon temporary-end" data-testid="temporary-end" title={t('Завершить и удалить')} aria-label={t('Завершить и удалить')} disabled={!online} onClick={() => { void buffer.flush(); props.onEnd(identity) }}><Icon name="trash" /></button></div>
      </header>
      <div className="temporary-feed" ref={feed} data-testid="temporary-feed" role="log" aria-label={t('Временный разговор')} onScroll={() => { const el = feed.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {closed || chat.messages.length === 0 ? <div className="temporary-empty"><Icon name="clock" /><h1>{closed ? t('Временный чат завершён') : t('О чём поговорим?')}</h1><p>{closed ? temporaryErrorMessage({ code: 'temporary_expired' }) : t('Без контекста проекта. Не сохраняется в истории.')}</p></div> : <div className="temporary-messages">{chat.messages.map((message) => <article key={message.id} className={`temporary-message temporary-${message.role}`} data-testid={`temporary-${message.role}`} data-state={message.state}>
          <div className="temporary-message-heading">{message.role === 'assistant' ? <ProviderIcon provider={chat.settings.provider} /> : <span>{t('Ты')}</span>}{props.copyText && <button type="button" aria-label={t('Скопировать сообщение')} className="temporary-copy" onClick={() => { void props.copyText!(message.text).catch(() => {}) }}><Icon name="copy" /></button>}</div>
          <div className="temporary-message-body"><MessageText text={message.text} renderExpanded={() => <TemporaryMarkdown text={message.text} human={message.role === 'user'} streaming={message.state === 'streaming'} {...actions} />} /></div>
        </article>)}</div>}
      </div>
      <div className="temporary-composer">
        {draft.conflict && <div className="temporary-notice" role="alert" data-testid="temporary-draft-conflict"><span>{temporaryErrorMessage({ code: 'draft_conflict' })}</span><div><button type="button" className="btn btn-sm" disabled={!draft.remoteReady} onClick={() => buffer.useRemote()}>{t('Показать текст другого окна')}</button><button type="button" className="btn btn-sm" disabled={!draft.remoteReady || !online} onClick={() => buffer.keepLocal()}>{t('Оставить мой текст')}</button></div></div>}
        {!draft.conflict && failure && <div className="temporary-notice" role="alert" data-testid="temporary-error">{temporaryErrorMessage(failure)}</div>}
        {!available && !closed && <div className="temporary-notice" role="status" data-testid="temporary-provider-unavailable">{t('Этот провайдер пока недоступен для временных чатов.')}</div>}
        {!online && <div className="temporary-notice" role="status">{t('Нет связи с демоном. Новые изменения пока только в этом окне.')}</div>}
        {inputNotice && <div className="temporary-notice" role="status">{inputNotice}</div>}
        <div className="temporary-box"><textarea ref={input} data-testid="temporary-input" value={draft.text} aria-label={t('Сообщение во временный чат')} placeholder={t('Напиши сообщение…')} rows={3} maxLength={100_000} readOnly={closed || action === 'send'}
          onChange={(event) => { setInputNotice(null); setError(null); buffer.edit(event.target.value) }} onKeyDown={onKey} onPaste={onPaste} />
          <div className="temporary-toolbar"><div className="temporary-preferences">
            <select aria-label={t('Провайдер')} data-testid="temporary-provider" value={chat.settings.provider} disabled={settingsLocked || !online} onChange={(event) => { void configure({ provider: event.target.value as TemporarySettings['provider'] }) }}>{(['claude', 'codex'] as const).map((provider) => <option key={provider} value={provider} disabled={!props.capabilities.some((capability) => capability.provider === provider && capability.available)}>{provider === 'claude' ? 'Claude' : 'Codex'}</option>)}</select>
            <select aria-label={t('Модель')} data-testid="temporary-model" value={selectedModel} disabled={settingsLocked || !online} onChange={(event) => { void configure({ ...chat.settings, model: event.target.value || undefined, effort: undefined }) }}><option value="">{t('По умолчанию')}</option>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select>
            <select aria-label={t('Усилие')} data-testid="temporary-effort" value={chat.settings.effort ?? ''} disabled={settingsLocked || !online} onChange={(event) => { void configure({ ...chat.settings, effort: event.target.value || undefined }) }}><option value="">{t('По умолчанию')}</option>{effortValues.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select>
          </div><div className="temporary-send-actions">{busy && <button type="button" className="temporary-stop" data-testid="temporary-stop" aria-label={t('Остановить ответ')} title={t('Остановить ответ')} disabled={!online || action !== null || chat.status === 'stopping'} onClick={() => { void stop() }}><Icon name="stop" /></button>}<button type="button" className="btn btn-primary temporary-send" data-testid="temporary-send" aria-label={t('Отправить')} title={t('Отправить')} disabled={!online || !available || closed || busy || action !== null || !draft.text.trim() || draft.conflict} onClick={() => { void send() }}><Icon name="send" /></button></div></div>
        </div>
      </div>
    </section>
  </FilePreviewContext.Provider></ImageContext.Provider></MdBridgeContext.Provider>
}
