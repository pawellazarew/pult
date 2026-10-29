import { t } from '../lib/i18n.js'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PultBridge } from '../../../shell/src/contract.js'
import type { ExternalConversation, ExternalPage, ExternalSession } from '../../../src/sessions/external.js'
import { errorText } from '../bridge.js'
import { shortPath } from '../model/agents.js'
import { suggestName } from '../model/newAgent.js'
import { Dialog } from './Panels.js'
import { Icon } from './common.js'
import { Markdown } from './Markdown.js'

export function ExternalSessions({ bridge, taken, onImported, onClose }: {
  bridge: PultBridge; taken: readonly string[]; onImported(name: string): void; onClose(): void
}): ReactElement {
  const [provider, setProvider] = useState<'claude' | 'codex'>('codex')
  const [page, setPage] = useState<ExternalPage>({ sessions: [], nextCursor: null })
  const [selected, setSelected] = useState<ExternalSession | null>(null)
  const [conversation, setConversation] = useState<ExternalConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError(null); setPage({ sessions: [], nextCursor: null }); setSelected(null); setConversation(null)
    bridge.call('sessions.external.list', { provider }).then((r) => { if (active) setPage(r as ExternalPage) },
      (e) => { if (active) setError(errorText(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, provider, revision])
  useEffect(() => {
    let active = true
    setConversation(null)
    if (!selected) { setReading(false); return }
    setReading(true); setError(null)
    bridge.call('sessions.external.read', { provider: selected.provider, id: selected.id }).then((r) => {
      if (active) setConversation(r as ExternalConversation)
    }, (e) => { if (active) setError(errorText(e)) }).finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [bridge, selected])
  const more = async (): Promise<void> => {
    if (!page.nextCursor || loading) return
    setLoading(true)
    try {
      const next = await bridge.call('sessions.external.list', { provider, cursor: page.nextCursor }) as ExternalPage
      setPage((p) => ({ sessions: [...p.sessions, ...next.sessions.filter((s) => !p.sessions.some((old) => old.id === s.id))], nextCursor: next.nextCursor }))
    } catch (e) { setError(errorText(e)) } finally { setLoading(false) }
  }
  const importSession = async (): Promise<void> => {
    if (!conversation || importing) return
    setImporting(true); setError(null)
    const name = suggestName(`${conversation.session.cwd}-${provider}`, taken)
    try {
      await bridge.call('agent.import', { provider, id: conversation.session.id, name })
      onImported(name)
    } catch (e) { setError(errorText(e)) } finally { setImporting(false) }
  }
  const sessions = page.sessions.filter((s) => `${s.title} ${s.cwd}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Dialog title={t("Существующие чаты")} size="wide" testId="external-sessions" onClose={onClose}
      footer={<>
        {error && <span className="err" role="alert">{error}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t("Закрыть")}</button>
        <button type="button" className="btn btn-primary" disabled={!conversation || importing} onClick={() => void importSession()} data-testid="import-session">
          <Icon name="plus" />{importing ? t('Копирую…') : t('Продолжить копию в Пульте')}
        </button>
      </>}>
      <div className="external-toolbar">
        <div className="seg prov" role="group" aria-label={t("Провайдер чатов")}>
          {(['claude', 'codex'] as const).map((p) => <button key={p} type="button" data-v={p} aria-pressed={provider === p}
            disabled={loading || importing} onClick={() => setProvider(p)}>{p}</button>)}
        </div>
        <input type="search" aria-label={t("Поиск чатов")} placeholder={t("Найти чат или папку")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" className="btn btn-ghost" title={t("Обновить список")} aria-label={t("Обновить список")} disabled={loading || importing} onClick={() => setRevision((n) => n + 1)}><Icon name="refresh" /></button>
      </div>
      <div className="external-grid">
        <div className="external-list" aria-label={t("Существующие разговоры")}>
          {loading && !page.sessions.length && <p className="mut">{t("Загружаю чаты…")}</p>}
          {!loading && !sessions.length && <p className="mut">{t("Чатов не найдено")}</p>}
          {sessions.map((s) => <button key={s.id} type="button" className="external-row" aria-pressed={selected?.id === s.id} disabled={importing}
            onClick={() => setSelected(s)} data-testid="external-session-row">
            <strong>{s.title}</strong><span className="mono mut" title={s.cwd}>{shortPath(s.cwd, 50)}</span>
            <time className="mut">{new Date(s.updatedAt).toLocaleString('ru-RU')}</time>
          </button>)}
          {page.nextCursor && <button type="button" className="btn" disabled={loading || importing} onClick={() => void more()}>{loading ? t('Загружаю…') : t('Ещё чаты')}</button>}
        </div>
        <div className="external-transcript" data-testid="external-transcript">
          {reading ? <p className="mut">{t("Загружаю разговор…")}</p> : conversation ? <>
            <div className="external-meta"><strong>{conversation.session.title}</strong><span className="mono mut">{conversation.session.cwd}</span></div>
            {conversation.truncated && <p className="mut">{t("Показана последняя часть разговора. Копия сохранит полный контекст.")}</p>}
            {conversation.messages.map((m, i) => <div key={i} className={`external-message external-${m.role}`}>
              <span className="lbl">{m.role === 'user' ? t('ты') : provider}</span><Markdown text={m.text} />
            </div>)}
            {!conversation.messages.length && <p className="mut">{t("В этом разговоре нет текстовых сообщений")}</p>}
          </> : <p className="mut">{t("Выбери разговор")}</p>}
        </div>
      </div>
    </Dialog>
  )
}
