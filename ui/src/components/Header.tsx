import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { t } from '../lib/i18n.js'
import type { GuardView } from '../model/health.js'
import { providerStatusView } from '../model/health.js'
import type { ConnState } from '../../../shell/src/contract.js'
import type { DaemonStatus, Tone, ProviderCatalog } from '../model/types.js'
import type { UsageState } from '../model/usage.js'
import { formatUptime } from '../lib/conn.js'
import { hhmm, Icon } from './common.js'
import { ContextMenu } from './ContextMenu.js'

/** Operational details belong to the sidebar footer; service notices stay inside the overlay. */
export function Header(p: {
  children?: ReactNode; noticeTone?: Tone
  conn: ConnState; status: DaemonStatus | null; statusAt: number; now: number; guard: GuardView; usage: UsageState
  providers?: ProviderCatalog | null; providersChecking?: boolean; onProvidersCheck?(): void
  doctorTone: Tone; inboxCount: number; inboxOpen: boolean
  sidebarHidden?: boolean; onToggleSidebar?(): void
  onDoctor(): void; onInbox(): void
  runtimeOpen?: boolean; runtimeAvailable?: boolean; onRuntime?(): void
  filesOpen?: boolean; filesAvailable?: boolean; onFiles?(): void
  onSettings?(): void; onHelp?(): void; onNews?(): void; onExternal?(): void; onAddProject?(): void
}): ReactElement {
  const [help, setHelp] = useState<{ x: number; y: number } | null>(null)
  const closeHelp = useCallback(() => setHelp(null), [])
  const health = useRef<HTMLDetailsElement>(null)
  useEffect(() => { const close = (event: PointerEvent): void => { if (health.current && !health.current.contains(event.target as Node)) health.current.open = false }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close) }, [])
  const up = p.conn.state === 'up'
  const daemonTone: Tone = up ? 'ok' : p.conn.state === 'connecting' ? 'run' : 'fail'
  const tone = !up ? daemonTone : p.noticeTone ?? (p.doctorTone === 'fail' || p.guard.tone === 'fail' ? 'fail' : p.doctorTone === 'wait' ? 'wait' : 'ok')
  const uptime = p.status ? p.status.uptimeMs + Math.max(0, p.now - p.statusAt) : null
  return <footer className="sidebar-footer" aria-label={t('Помощь и настройки')} data-testid="sidebar-footer">
    {p.onAddProject && <button type="button" className="footer-icon" title={t('Добавить проект')} aria-label={t('Добавить проект')} onClick={p.onAddProject}><Icon name="folder-plus" /></button>}
    <button type="button" className="footer-icon" aria-pressed={p.inboxOpen} onClick={p.onInbox} data-testid="toggle-inbox" title="Inbox" aria-label={`Inbox: ${p.inboxCount}`}><Icon name="inbox" />{p.inboxCount > 0 && <span className="footer-badge" data-testid="inbox-count">{p.inboxCount}</span>}</button>
    <details ref={health} className="health-menu" data-testid="health-menu">
      <summary className={`footer-icon health-summary t-${tone}`} title={t('Этот Mac')} aria-label={t('Этот Mac')}><Icon name="machine" /><span className="health-dot" /></summary>
      <div className={`health-popover${up ? '' : ' hdr-stale'}`}>
        <div className="footer-pop-title">{t('Этот Mac')}{!up && <span className="mut"> · {t('Нет соединения')}</span>}</div>
        <div className="footer-health-row" data-testid="hdr-daemon"><span>{t('демон')}</span><span className={`t-${daemonTone}`}>
          {up && p.conn.state === 'up' ? <span data-testid="daemon-meta">{p.conn.daemon.version}{uptime !== null ? ` · ${formatUptime(uptime)}` : ''}</span> : <span data-testid="conn-state">{p.conn.state === 'connecting' ? t('подключение…') : t('недоступен')}</span>}
        </span></div>
        <div className="footer-health-row" data-testid="hdr-guard" title={up ? p.guard.detail : t`Последняя проверка, не обновляется — демон недоступен. ${p.guard.detail}`}><span>{t('страж сети')}</span><span className={`t-${up ? p.guard.tone : 'mut'}`}>{p.guard.label}{p.guard.checkedAt ? ` · ${hhmm(p.guard.checkedAt)}` : ''}</span></div>
        {(['claude','codex','zcode'] as const).map((provider) => { const st = providerStatusView(p.providers?.[provider], p.providersChecking ?? false); return <div key={provider} className="footer-health-row"><span>{provider === 'zcode' ? 'ZCode' : provider === 'claude' ? 'Claude' : 'Codex'}</span><button type="button" className={`link-btn t-${up ? st.tone : 'mut'}`} title={st.title} disabled={!up || p.providersChecking || !p.onProvidersCheck} onClick={p.onProvidersCheck} data-testid={`provider-status-${provider}`}>{st.label}</button></div> })}
        <div className="health-notices">{p.children}</div>
        <button type="button" className="footer-menu-item" onClick={() => { const el = document.querySelector<HTMLDetailsElement>('.health-menu'); if (el) el.open = false; p.onDoctor() }} data-testid="open-doctor"><Icon name="pulse" />{t('Запустить диагностику')}</button>
        {p.onExternal && <button type="button" className="footer-menu-item" disabled={!up} onClick={p.onExternal} data-testid="open-external-sessions"><Icon name="folder" />{t('Существующие чаты')}</button>}
      </div>
    </details>
    <span className="grow" />
    <button type="button" className="footer-icon" aria-label={t('Помощь')} title={t('Помощь')} data-testid="open-help" aria-haspopup="menu" aria-expanded={help !== null} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHelp(help ? null : { x: r.left, y: r.top - 6 }) }}><Icon name="help" /></button>
    <button type="button" className="footer-icon" title={t('Настройки')} aria-label={t('Настройки')} onClick={p.onSettings} data-testid="open-settings"><Icon name="settings" /></button>
    {help && <ContextMenu at={help} above onClose={closeHelp} label={t('Помощь')} testId="help-menu" items={[
      { heading: t('Помощь') },
      { label: t('Сочетания клавиш'), onSelect: () => p.onHelp?.(), testId: 'help-shortcuts' },
      { label: t('Что нового'), onSelect: () => p.onNews?.(), testId: 'help-news' },
      { label: t('Запустить диагностику'), onSelect: p.onDoctor, testId: 'help-diagnostics' },
      'sep', { note: t`Пульт ${up && p.conn.state === 'up' ? p.conn.daemon.version : '—'}` },
    ]} />}
  </footer>
}
