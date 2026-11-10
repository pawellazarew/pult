import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnState, DaemonStatus, MaintenanceInfo, ProviderAction, ProviderOperation, ProviderTool, PultBridge } from '../../../shell/src/contract.js'
import type { DoctorReport } from '../model/types.js'
import { errorText } from '../bridge.js'
import { getLanguage, t } from '../lib/i18n.js'
import { formatUptime } from '../lib/conn.js'
import { Dialog } from './Panels.js'
import { Icon } from './common.js'

const sourceLabel = (source: ProviderTool['source']): string => ({ missing: t('не установлен'), application: t('из приложения'), homebrew: 'Homebrew', npm: 'npm', native: t('нативная установка'), unknown: t('способ установки неизвестен') })[source]
const reportText = (report: DoctorReport): string => JSON.stringify({ generatedAt: report.generatedAt, home: report.home, counts: report.counts,
  items: report.items.map(({ id, title, status, detail, fix, fixCmd }) => ({ id, title, status, detail, fix, fixCmd })) }, null, 2)

export function MaintenancePanel({ bridge, conn, status, doctor, starting, onStart, onDoctor, onRunDoctor, onCopy, onUpdates, onClose }: {
  bridge: PultBridge
  conn: ConnState
  status: DaemonStatus | null
  doctor: { report: DoctorReport | null; loading: boolean; error: string | null }
  starting: boolean
  onStart(): void
  onDoctor(): void
  onRunDoctor(): Promise<void>
  onCopy(text: string): void
  onUpdates(): void
  onClose(): void
}): ReactElement {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null)
  const [tools, setTools] = useState<ProviderTool[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [operation, setOperation] = useState<ProviderOperation | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const up = conn.state === 'up'
  const native = !!bridge.maintenanceInfo && !!bridge.providerTools && !!bridge.providerAction
  const refreshTools = async (): Promise<void> => { if (bridge.providerTools) setTools(await bridge.providerTools()) }
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null
    first.current?.focus()
    let alive = true
    if (bridge.maintenanceInfo) void bridge.maintenanceInfo().then(value => {
      if (!alive) return
      setInfo(value)
      const current = value.operations?.find(job => job.state === 'running' || job.state === 'unknown') ?? value.operations?.at(-1)
      if (current) {
        setOperation(current)
        if (current.state !== 'running' && current.state !== 'unknown') void onRunDoctor()
      }
    }, e => { if (alive) setError(errorText(e)) })
    if (bridge.providerTools) void bridge.providerTools().then(value => { if (alive) setTools(value) }, e => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [bridge])
  useEffect(() => {
    if (!operation || (operation.state !== 'running' && operation.state !== 'unknown') || !bridge.providerOperation) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const value = await bridge.providerOperation!(operation.id)
        if (!alive) return
        setOperation(value)
        if (value.state === 'running' || value.state === 'unknown') timer = setTimeout(() => { void poll() }, value.state === 'unknown' ? 5_000 : 1_000)
        else { await refreshTools(); await onRunDoctor() }
      } catch (e) { if (alive) { setError(errorText(e)); setOperation(null) } }
    }
    timer = setTimeout(() => { void poll() }, 500)
    return () => { alive = false; clearTimeout(timer) }
  }, [bridge, operation?.id, operation?.state, onRunDoctor])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const root = document.querySelector<HTMLElement>('[data-testid="maintenance-panel"]')
      const targets = root ? Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')).filter(el => el.getClientRects().length > 0) : []
      const firstTarget = targets[0], lastTarget = targets.at(-1)
      if (event.shiftKey && document.activeElement === firstTarget) { event.preventDefault(); lastTarget?.focus() }
      else if (!event.shiftKey && document.activeElement === lastTarget) { event.preventDefault(); firstTarget?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); if (previousFocus.current?.isConnected) previousFocus.current.focus() }
  }, [onClose])
  const act = async (name: 'stop' | 'restart'): Promise<void> => {
    setBusy(name); setError(null)
    try { if (name === 'stop') await bridge.stopDaemon(); else await bridge.restartDaemon?.() }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(null) }
  }
  const providerAction = async (provider: 'claude' | 'codex', action: ProviderAction): Promise<void> => {
    setBusy(provider); setError(null)
    try { const value = await bridge.providerAction?.(provider, action); if (value) { setOperation(value); if (value.state !== 'running') { await refreshTools(); await onRunDoctor() } } }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(null) }
  }
  const blocked = busy !== null || starting
  const operationText = operation?.state === 'running' ? t('Выполняется в Терминале. Заверши действие в открытом окне.')
    : operation?.state === 'succeeded' ? t('Команда завершилась успешно. Статус CLI обновлён.')
    : operation?.state === 'handoff' ? t('Приложение открыто. Проверь обновления в его меню, затем перепроверь CLI.')
    : operation?.state === 'unknown' ? t('Результат неизвестен. Проверь Терминал и запусти диагностику.')
    : operation ? t`Команда завершилась с ошибкой ${operation.exitCode ?? '—'}. Подробности в Терминале.` : null
  return <Dialog title={t('Управление Пультом и CLI')} testId="maintenance-panel" size="wide" onClose={onClose}
    footer={<><span className="grow" /><button type="button" className="btn" disabled={!up} onClick={onUpdates}>{t('Обновления Пульта')}</button><button ref={first} type="button" className="btn btn-primary" onClick={onClose}>{t('Готово')}</button></>}>
    <div className="maintenance-stack">
      <section className="maintenance-section" aria-labelledby="maintenance-daemon-h">
        <div className="maintenance-heading"><h3 id="maintenance-daemon-h">{t('Демон')}</h3><span className={`chip tone-${up ? 'ok' : conn.state === 'connecting' ? 'run' : 'wait'}`} data-testid="maintenance-daemon-state">{up ? t('Работает') : conn.state === 'connecting' ? t('Подключение…') : t('Остановлен или недоступен')}</span></div>
        {up && <p className="mut mono small">{conn.daemon.version} · PID {conn.daemon.pid}{status ? ` · ${formatUptime(status.uptimeMs)}` : ''}</p>}
        {!up && conn.state === 'down' && <p className="mut small">{conn.reason}</p>}
        <div className="maintenance-actions">
          <button type="button" className="btn" disabled={blocked || conn.state !== 'down'} onClick={onStart} data-testid="maintenance-start"><Icon name="play" />{starting ? t('запускаю…') : t('Запустить')}</button>
          <button type="button" className="btn" disabled={blocked || !up || !bridge.restartDaemon} onClick={() => void act('restart')} data-testid="maintenance-restart"><Icon name="refresh" />{busy === 'restart' ? t('Перезапускаю…') : t('Перезапустить')}</button>
          <button type="button" className="btn" disabled={blocked || !up} onClick={() => void act('stop')} data-testid="maintenance-stop"><Icon name="stop" />{busy === 'stop' ? t('Останавливаю…') : t('Остановить')}</button>
        </div>
        <p className="mut small">{t('При остановке или перезапуске текущие ходы прервутся. Разговоры сохранятся.')}</p>
      </section>
      <section className="maintenance-section" aria-labelledby="maintenance-cli-h">
        <div className="maintenance-heading"><h3 id="maintenance-cli-h">{t('CLI Claude и Codex')}</h3><button type="button" className="btn btn-sm" disabled={!native || blocked} onClick={() => { void refreshTools().then(() => onRunDoctor(), e => setError(errorText(e))) }}>{t('Перепроверить')}</button></div>
        <p className="mut small">{t('Установка, обновление и вход выполняются на этом Mac в отдельном окне Терминала. Вход подтверждается в браузере провайдера.')}</p>
        <p className="mut small">{t('CLI использует сетевой профиль Пульта. Страница входа использует сеть твоего браузера.')}</p>
        {(busy === 'claude' || busy === 'codex') && <p role="status" className="mut small">{t('Проверяю сеть и готовлю действие…')}</p>}
        {!native && <p className="mut">{t('Для управления CLI обнови окно Пульта.')}</p>}
        {native && !tools && <p className="mut">{t('Ищу установленные CLI…')}</p>}
        {tools?.map(tool => {
          const checked = doctor.report?.items.find(item => item.id === `cli.${tool.provider}`)?.data
          const sameInstallation = !!tool.path && (checked?.path === tool.path || (!!tool.realpath && checked?.realpath === tool.realpath))
          const auth = sameInstallation ? doctor.report?.items.find(item => item.id === `login.${tool.provider}`) : undefined
          const jobBusy = operation?.state === 'running' && operation.provider === tool.provider
          return <article key={tool.provider} className="maintenance-cli" data-testid={`maintenance-cli-${tool.provider}`}>
            <div className="maintenance-heading"><strong>{tool.provider === 'claude' ? 'Claude Code' : 'Codex'}</strong><span className="mut small">{sourceLabel(tool.source)}</span></div>
            <div className="mono small">{tool.version ?? t('версия неизвестна')}</div>
            <p className="maintenance-path mono" data-testid={`maintenance-path-${tool.provider}`}>{tool.path ?? t('CLI не найден')}</p>
            {tool.realpath && tool.realpath !== tool.path && <p className="maintenance-path mono mut">→ {tool.realpath}</p>}
            <p className="mut small">{auth ? auth.status === 'ok' ? t('Вход подтверждён') : t('Проверка входа требует внимания') : t('Вход ещё не проверен')}{auth ? ` · ${auth.detail}` : ''}</p>
            <div className="maintenance-actions">
              <button type="button" className="btn btn-sm" disabled={blocked || jobBusy || !!tool.path} onClick={() => void providerAction(tool.provider, 'install')} data-testid={`maintenance-install-${tool.provider}`}>{t('Установить')}</button>
              <button type="button" className="btn btn-sm" disabled={blocked || jobBusy || !tool.path || tool.source === 'unknown'} onClick={() => void providerAction(tool.provider, 'update')} data-testid={`maintenance-update-${tool.provider}`}>{tool.source === 'application' ? t('Открыть приложение') : t('Обновить')}</button>
              <button type="button" className="btn btn-sm" disabled={blocked || jobBusy || !tool.path} onClick={() => void providerAction(tool.provider, 'login')} data-testid={`maintenance-login-${tool.provider}`}>{t('Войти')}</button>
              {tool.path && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { void bridge.revealPath(tool.path!).catch(e => setError(errorText(e))) }}>{t('Показать файл')}</button>}
            </div>
          </article>
        })}
        {operation && <div className={`maintenance-operation${operation.state === 'failed' ? ' err' : ''}`} role="status" data-testid="maintenance-operation" data-state={operation.state}><strong>{operation.provider}</strong> · {operationText}{operation.message && <p>{operation.message}</p>}<code>{operation.command}</code></div>}
      </section>
      <section className="maintenance-section" aria-labelledby="maintenance-doctor-h">
        <div className="maintenance-heading"><h3 id="maintenance-doctor-h">{t('Диагностика')}</h3>{doctor.report && <span className="mut small">{doctor.report.counts.ok} ok · {doctor.report.counts.warn} warn · {doctor.report.counts.fail} fail · <time dateTime={doctor.report.generatedAt} data-testid="maintenance-report-time">{new Date(doctor.report.generatedAt).toLocaleTimeString(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB')}</time></span>}</div>
        <p className="mut small">{up ? t('CLI, вход, сеть, служба и версии Пульта.') : t('Без демона доступны локальные проверки CLI, входа, службы и файлов. Сеть проверяется после запуска демона.')}</p>
        <div className="maintenance-actions"><button type="button" className="btn" disabled={doctor.loading || (!up && !bridge.runDoctor)} onClick={() => void onRunDoctor()} data-testid="maintenance-doctor"><Icon name="pulse" />{doctor.loading ? t('проверяю…') : t('Запустить диагностику')}</button><button type="button" className="btn" disabled={!doctor.report} onClick={onDoctor}>{t('Показать отчёт')}</button><button type="button" className="btn" disabled={!doctor.report} onClick={() => doctor.report && onCopy(reportText(doctor.report))} data-testid="maintenance-copy-report"><Icon name="copy" />{t('Скопировать отчёт')}</button></div>
        {doctor.error && <p role="alert" className="err">{doctor.error}</p>}
      </section>
      {info && <section className="maintenance-section"><h3>{t('Файлы Пульта')}</h3><p className="maintenance-path mono">{info.home}</p><div className="maintenance-actions"><button type="button" className="btn" onClick={() => { void bridge.revealPath(info.home).catch(e => setError(errorText(e))) }}>{t('Папка данных')}</button><button type="button" className="btn" onClick={() => { void bridge.revealPath(info.logs).catch(e => setError(errorText(e))) }} data-testid="maintenance-logs">{t('Журналы')}</button><button type="button" className="btn" onClick={() => onCopy(info.serviceLog)}>{t('Скопировать путь журнала службы')}</button></div><p className="mut small maintenance-path">Node · {info.node ?? t('не найден')}</p></section>}
      {error && <p className="err" role="alert" data-testid="maintenance-error">{error}</p>}
    </div>
  </Dialog>
}
