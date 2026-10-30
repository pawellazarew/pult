// Шапка (docs/12 §3 п.4): демон (версия, режим, аптайм), страж сети (страна выхода, время
// проверки), лимиты claude и codex (окна 5 ч и 7 дн), doctor и Inbox со счётчиком.

import type { ReactElement, ReactNode } from 'react'
import { formatUptime } from '../lib/conn.js'
import type { GuardView } from '../model/health.js'
import { providerStatusView } from '../model/health.js'
import type { ConnState } from '../../../shell/src/contract.js'
import type { AgentProvider, DaemonStatus, Tone, ProviderCatalog } from '../model/types.js'
import type { ProviderUsage, UsageState } from '../model/usage.js'
import { formatClock, formatPct, formatResetIn, usageTone, usageForDisplay } from '../model/usage.js'
import { CMD, hhmm, Icon, Kbd } from './common.js'

export function Header(p: {
  conn: ConnState
  status: DaemonStatus | null
  statusAt: number
  now: number
  guard: GuardView
  usage: UsageState
  providers?: ProviderCatalog | null
  providersChecking?: boolean
  onProvidersCheck?(): void
  doctorTone: Tone
  inboxCount: number
  inboxOpen: boolean
  sidebarHidden?: boolean
  onToggleSidebar?(): void
  onDoctor(): void
  onInbox(): void
  runtimeOpen?: boolean
  runtimeAvailable?: boolean
  onRuntime?(): void
  filesOpen?: boolean
  filesAvailable?: boolean
  onFiles?(): void
}): ReactElement {
  const up = p.conn.state === 'up'
  const uptime = p.status ? p.status.uptimeMs + Math.max(0, p.now - p.statusAt) : null
  const daemonTone: Tone = up ? 'ok' : p.conn.state === 'connecting' ? 'run' : 'fail'
  // Демона нет — страж и лимиты показывают последнее, что было известно, и никто их не
  // обновляет. Зелёный «выход FI» при красном «демон недоступен» читался как «защищено».
  const stale = !up
  const guardTitle = stale
    ? `${p.guard.checkedAt ? `на ${hhmm(p.guard.checkedAt)}` : 'последняя проверка'}, не обновляется — демон недоступен. ${p.guard.detail}`
    : p.guard.detail
  return (
    <header className={`hdr${stale ? ' hdr-stale' : ''}`}>
      <div className="hdr-brand"><Icon name="mark" className="mark" />Пульт</div>

      {p.onToggleSidebar && <button type="button" className="btn btn-ghost sidebar-toggle" data-testid="toggle-sidebar"
        aria-label={p.sidebarHidden ? 'Показать беседы' : 'Скрыть беседы'} aria-expanded={!p.sidebarHidden}
        title={`Список бесед (${CMD}B)`} onClick={p.onToggleSidebar}><Icon name="sidebar" /></button>}
      <details className="health-menu" data-testid="health-menu">
        <summary className={`health-summary t-${!up ? daemonTone : p.doctorTone === 'fail' ? 'fail' : p.guard.tone === 'fail' ? 'fail' : 'ok'}`}>
          <span className="dot" /><span>{!up ? p.conn.state === 'connecting' ? 'Подключение…' : 'Нет соединения' : p.doctorTone === 'fail' ? 'Нужна проверка' : 'Подключено'}</span><Icon name="chev" />
        </summary>
        <div className="health-popover">
      <div className="cell cell-state" data-testid="hdr-daemon">
        <span className="lbl">демон</span>
        <span className={`val t-${daemonTone}`}>
          <span className="dot" />
          {up && p.conn.state === 'up' ? (
            <span data-testid="daemon-meta">
              <span className="ink">{p.conn.daemon.version}</span>
              <span className="sub"> · {p.status ? (p.status.mode === 'service' ? 'служба' : 'по требованию') : '…'}{uptime !== null ? ` · ${formatUptime(uptime)}` : ''}</span>
            </span>
          ) : <span data-testid="conn-state">{p.conn.state === 'connecting' ? 'подключение…' : 'недоступен'}</span>}
        </span>
      </div>

      <div className="cell" data-testid="hdr-guard" title={guardTitle}>
        <span className="lbl">страж сети</span>
        <span className={`val t-${p.guard.tone}`}>
          <span>{p.guard.label}</span>
          {p.guard.checkedAt && <span className="sub">· {hhmm(p.guard.checkedAt)}</span>}
        </span>
      </div>

      {(['claude', 'codex'] as const).map((provider) => {
        const st = providerStatusView(p.providers?.[provider], p.providersChecking ?? false)
        return (
          <UsageCell key={provider} provider={provider} u={p.usage[provider]} now={p.now}>
            <button type="button" className={`pstat t-${st.tone}`} title={st.title}
              disabled={!up || p.providersChecking || !p.onProvidersCheck} onClick={p.onProvidersCheck} data-testid={`provider-status-${provider}`}>
              <span className="dot" />{st.label}
            </button>
          </UsageCell>
        )
      })}

        </div>
      </details>
      {up && p.guard.tone !== 'ok' && <span className={`header-guard-alert t-${p.guard.tone}`} title={guardTitle}>{p.guard.label}</span>}
      <div className="hdr-spacer" />
      <div className="hdr-actions">
        {p.onRuntime && <button type="button" className="btn" aria-pressed={p.runtimeOpen} disabled={!p.runtimeAvailable} onClick={p.onRuntime} data-testid="toggle-runtime" title="Браузер и мобильные устройства">Превью</button>}
        {p.onFiles && <button type="button" className="btn" aria-pressed={p.filesOpen} disabled={!p.filesAvailable} onClick={p.onFiles} data-testid="toggle-files" title={`Файлы проекта (${CMD}P)`}>
          <Icon name="folder" />Файлы
        </button>}
        <button type="button" className="btn" onClick={p.onDoctor} data-testid="open-doctor" title="Проверка окружения">
          <span className={`t-${p.doctorTone} ic-wrap`}><Icon name="pulse" /></span><span className="doctor-label">Диагностика</span>
        </button>
        <button type="button" className="btn" aria-pressed={p.inboxOpen} onClick={p.onInbox} data-testid="toggle-inbox" title={`Inbox (${CMD}I)`}>
          <Icon name="inbox" />Inbox
          <span className={`badge${p.inboxCount ? '' : ' zero'}`} data-testid="inbox-count">{p.inboxCount}</span>
          <Kbd>{`${CMD}I`}</Kbd>
        </button>
      </div>
    </header>
  )
}

function UsageCell({ provider, u: originalUsage, now, children }: { provider: AgentProvider; u: ProviderUsage | undefined; now: number; children?: ReactNode }): ReactElement {
  const u = usageForDisplay(originalUsage, now)
  // Проценты — ИЗРАСХОДОВАННАЯ доля окна; голое «42%» читалось и как «осталось».
  const title = u
    ? `${provider}: 5 ч — использовано ${formatPct(u.fiveHour?.utilization)}${u.fiveHour?.resetsAt ? `, сброс ${formatResetIn(u.fiveHour.resetsAt, now)} (${formatClock(u.fiveHour.resetsAt * 1000, now)})` : ''}; `
      + `7 дн — использовано ${formatPct(u.sevenDay?.utilization)}${u.sevenDay?.resetsAt ? `, сброс ${formatResetIn(u.sevenDay.resetsAt, now)} (${formatClock(u.sevenDay.resetsAt * 1000, now)})` : ''}`
    : `${provider}: лимиты появятся после первого хода`
  return (
    <div className="cell" data-testid={`hdr-usage-${provider}`} title={title}>
      <div className="cell-top"><span className={`lbl who-${provider}`}>{provider}</span>{children}</div>
      <div className="meters">
        <Meter k="5ч" u={u?.fiveHour?.utilization ?? null} status={u?.status} />
        <Meter k="7дн" u={u?.sevenDay?.utilization ?? null} status={u?.status} />
      </div>
    </div>
  )
}

function Meter({ k, u, status }: { k: string; u: number | null; status: string | undefined }): ReactElement {
  const tone = usageTone(u, status === 'limited' || status === 'blocked' ? status : undefined)
  return (
    <div className={`meter t-${tone}`} aria-label={`${k}: использовано ${formatPct(u)}`}>
      <div className="row"><span className="k">{k}</span><span>{formatPct(u)}</span></div>
      <div className="bar"><i style={{ width: `${Math.min(100, Math.round((u ?? 0) * 100))}%` }} /></div>
    </div>
  )
}
