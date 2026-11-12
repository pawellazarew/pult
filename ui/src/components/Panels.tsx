import { t } from '../lib/i18n.js'
import { ResizableDialog } from './ResizableDialog.js'
// Inbox (справа), панель doctor и подтверждение. Черновик нового чата — components/Draft.tsx. Логика форм и сортировок —
// в model/*.ts; здесь только отрисовка и фокус.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago } from '../model/agents.js'
import type { DoctorGroup } from '../model/health.js'
import { attentionKeys, searchKeys } from '../model/hotkeys.js'
import { ATTENTION_LABEL, INBOX_FILTERS } from '../model/inbox.js'
import type { InboxFilter, InboxItem, SessionCard } from '../model/inbox.js'
import type { DoctorReport } from '../model/types.js'
import { mcpRows, toggleServer } from '../model/mcp.js'
import type { McpListing } from '../model/mcp.js'
import { plural } from '../lib/ru.js'
import { CMD, hhmm, Icon, IS_MAC, Kbd, ProviderTag } from './common.js'
import { PermCard } from './PermCard.js'
import { explainFailure, exitCodeIn } from '../model/errors.js'

// --- Inbox -------------------------------------------------------------------------
// О2 (docs/14): почтовый ящик всего, что требует человека. Фильтр «Все» — запросы и непрочитанные
// ошибки, «Непрочитанные» — все непрочитанные сессии, «Ошибки» — только ошибки.

export function Inbox({ items, cards = [], filter = 'all', counts, agents, focused, busy, retrying, now, waitingCount = 0, onFocus, onApprove, onAnswer, onDeny, onClose, onFilter, onOpen, onRetry, onStop, onWait, onNextWaiting, onJumpPerm }: {
  items: readonly InboxItem[]
  /** Карточки сессий (ошибки или непрочитанное) — model/inbox.ts `inboxView`. */
  cards?: readonly SessionCard[]
  filter?: InboxFilter
  counts?: Record<InboxFilter, number>
  agents: readonly AgentView[]
  focused: string | null
  busy: Set<string>
  /** Сессии, чей «Повторить» уже ушёл демону. */
  retrying?: ReadonlySet<string>
  now: number
  /** Сколько сессий ждут внимания (очередь ⌘⌥L) — кнопка разбора и подсказка в пустом состоянии. */
  waitingCount?: number
  onFocus(id: string): void
  /** Без `scope` — один раз; `session` / `rule` — кнопки M8d. */
  onApprove(id: string, scope?: 'session' | 'rule'): void
  onAnswer?(id: string, answers: Record<string, { answers: string[] }>): void
  onDeny(id: string, reason: string): void
  onClose(): void
  onFilter?(f: InboxFilter): void
  onOpen?(name: string): void
  onRetry?(name: string): void
  /** «Похоже, завис» → «Прервать»: стоп именно этого хода (`turnId`), карточка прочитана до этого события. */
  onStop?(name: string, upTo: number, turnId?: string): void
  /** «Похоже, завис» → «Ждать»: карточка прочитана до этого события, ход идёт дальше. */
  onWait?(name: string, upTo: number): void
  /** Следующая сессия, которая ждёт тебя (то же, что ⌘⌥L). */
  onNextWaiting?(): void
  /** «в ленту» карточки запроса: открыть разговор и показать запрос (нет события — просто открыть). */
  onJumpPerm?(sessionId: string, eventId?: number): void
}): ReactElement {
  // `name` карточки — подпись (название), `key` — имя сессии: два агента с одним названием различимы по подсказке.
  const who = (name: string): { name: string; provider: string; key: string } => {
    const a = agents.find((x) => x.name === name)
    return { name: a ? agentLabel(a) : name, provider: a?.provider ?? 'pult', key: name }
  }
  const shown = items.length + cards.length
  return (
    <aside className="inbox" aria-label="Inbox" data-testid="inbox" data-filter={filter}>
      <div className="pane-h">
        <span className="lbl">Inbox</span>
        {onFilter ? (
          <div className="inbox-filter" role="group" aria-label={t("Что показать")}>
            {INBOX_FILTERS.map(([f, label]) => (
              <button key={f} type="button" className="btn btn-sm btn-ghost" aria-pressed={filter === f} data-testid={`inbox-filter-${f}`}
                onClick={() => onFilter(f)}>{label}{counts?.[f] ? <span className="n">{counts[f]}</span> : null}</button>
            ))}
          </div>
        ) : <span className="count">{items.length ? t`${items.length} ждут` : ''}</span>}
        <span className="grow" />
        {onNextWaiting && waitingCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm inbox-next" data-testid="inbox-next-waiting"
            title={t`Следующая сессия, которая ждёт тебя: ошибки → запросы → готовые (${attentionKeys(IS_MAC).next})`}
            onClick={onNextWaiting}>{t("ждут ")}{waitingCount}<Kbd>{attentionKeys(IS_MAC).next}</Kbd></button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title={t("Скрыть")} aria-label={t("Скрыть")}><Icon name="x" /></button>
      </div>
      <div className="inbox-list">
        {shown === 0 ? (
          <div className="inbox-empty" data-testid="inbox-empty">
            <Icon name="check" />
            {filter === 'unread' ? <>{t("Непрочитанного нет.")}<br />{t("Здесь появятся сессии, которые закончили ход, упали или спросили, пока ты был не на них.")}</>
              : filter === 'errors' ? <>{t("Ошибок нет.")}<br />{t("Упавший ход, исчерпанный лимит, отказ стража и зависший ход появятся здесь.")}</>
                : <>{t("Никто ничего не ждёт.")}<br />{t("Запросы разрешений и ошибки всех сессий появятся здесь.")}</>}
            {waitingCount > 0 && <p className="inbox-waiting-hint" data-testid="inbox-waiting-hint">
              {waitingCount} {plural(waitingCount, t('сессия ждёт'), t('сессии ждут'), t('сессий ждут'))}{t(" тебя вне этого фильтра — ")}{attentionKeys(IS_MAC).next}{t(" ведёт к ним.")}</p>}
          </div>
        ) : <>
          {cards.filter((c) => c.error).map((c) => <SessionCardView key={`s:${c.name}`} c={c} agent={who(c.name)} now={now}
            retrying={retrying?.has(c.name) ?? false} onOpen={onOpen} onRetry={onRetry} onStop={onStop} onWait={onWait} />)}
          {items.map((p) => (
            <PermCard key={p.id} permId={p.id} toolName={p.toolName} input={p.input} state="pending"
              agent={who(p.sessionId)} createdAt={p.createdAt} now={now}
              focused={focused === p.id} busy={busy.has(p.id)} {...(p.offers ? { offers: p.offers } : {})} {...(p.concealed ? { concealed: true } : {})}
              onFocus={() => onFocus(p.id)} onApprove={(scope) => onApprove(p.id, scope)} onAnswer={(answers) => onAnswer?.(p.id, answers)} onDeny={(r) => onDeny(p.id, r)}
              {...(onJumpPerm ? { onJump: () => onJumpPerm(p.sessionId, p.eventId) } : {})} />
          ))}
          {cards.filter((c) => !c.error).map((c) => <SessionCardView key={`s:${c.name}`} c={c} agent={who(c.name)} now={now}
            retrying={false} onOpen={onOpen} />)}
        </>}
      </div>
    </aside>
  )
}

/**
 * Карточка сессии в Inbox: ошибка — с причиной и «Повторить» (последняя реплика заново, `agent.retry`),
 * непрочитанное — с «Открыть». Разметка шапки — как у карточки запроса (`.perm-h`): одна строка, кто
 * и когда.
 */
export function SessionCardView({ c, agent, now, retrying, onOpen, onRetry, onStop, onWait }: {
  c: SessionCard
  agent: { name: string; provider: string; key: string }
  now: number
  retrying: boolean
  onOpen?(name: string): void
  onRetry?(name: string): void
  onStop?(name: string, upTo: number, turnId?: string): void
  onWait?(name: string, upTo: number): void
}): ReactElement {
  const failure = c.kind === 'failed' ? explainFailure(c.text, { scope: 'agent' }) : null
  return (
    <div className="perm inbox-session" data-testid={c.error ? 'inbox-error' : 'inbox-unread'} data-agent={c.name} data-kind={c.kind}
      data-error={c.error ? '1' : '0'}>
      <div className="perm-h">
        <span className="lbl">{ATTENTION_LABEL[c.kind]}</span>
        <span className="who" title={agent.key !== agent.name ? t`${agent.name} · имя для CLI: ${agent.key}` : agent.name}>{agent.name}</span>
        <ProviderTag provider={agent.provider} />
        <span className="waited">{ago(c.at, now)}</span>
      </div>
      {failure ? <div className="perm-reason failure-message" data-testid="inbox-error-text">
        <strong>{failure.title}</strong><p>{failure.explanation}</p><p>{failure.action}</p>
        {c.text && <details className="error-details"><summary>{t("Технические подробности")}</summary><pre>{c.text}</pre></details>}
      </div> : c.text && <div className="perm-reason" data-testid="inbox-error-text">{c.text}</div>}
      <div className="perm-actions">
        {c.retryable && onRetry && (
          <button type="button" className="btn btn-sm" disabled={retrying} data-testid="inbox-retry"
            title={t("Отправить последнюю реплику ещё раз")} onClick={() => onRetry(c.name)}><Icon name="refresh" />{retrying ? t('Повторяю…') : t('Повторить')}</button>
        )}
        {/* Сторож тишины (О2): ход сам не обрывается — решает человек. */}
        {c.kind === 'stalled' && onStop && (
          <button type="button" className="btn btn-sm btn-danger" data-testid="inbox-stall-stop"
            title={t("Остановить зависший ход")} onClick={() => onStop(c.name, c.id, c.turnId)}><Icon name="stop" />{t("Прервать")}</button>
        )}
        {c.kind === 'stalled' && onWait && (
          <button type="button" className="btn btn-sm" data-testid="inbox-stall-wait"
            title={t("Ход идёт дальше; карточка уйдёт")} onClick={() => onWait(c.name, c.id)}>{t("Ждать")}</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" data-testid="inbox-open" onClick={() => onOpen?.(c.name)}>{t("Открыть")}</button>
      </div>
    </div>
  )
}

// --- диалог -------------------------------------------------------------------------

export function Dialog({ title, children, footer, onClose, size, testId, extra }: {
  title: string; children: ReactNode; footer: ReactNode; onClose(): void; size?: 'wide' | 'narrow'; testId: string; extra?: ReactNode
}): ReactElement {
  const Frame = testId === 'doctor-panel' ? ResizableDialog : 'div'
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <Frame className={`dlg${size ? ` ${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="dlg-h"><h2>{title}</h2><span className="grow" />{extra}<button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("Закрыть")}><Icon name="x" /></button></div>
        <div className="dlg-b">{children}</div>
        <div className="dlg-f">{footer}</div>
      </Frame>
    </div>
  )
}

/** Горячие клавиши окна — то, что раньше стояло строкой под полем ввода (открывается «?» и ⌘/). */
export const HOTKEYS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+Shift+Space', t('удерживать для диктовки · Esc — отменить')],
  [`${CMD}K`, t('найти беседу в списке')],
  [`${CMD}P`, t('файлы текущего проекта')],
  [`${CMD}B`, t('скрыть или показать список бесед')],
  ['Enter', t('отправить реплику · идёт ход — поставить её в очередь')],
  ['Shift+Enter', t('новая строка в реплике')],
  ['Esc', t('стоп хода (подтверждение) · закрыть диалог или меню')],
  [`${CMD}↵`, t('разрешить выделенный запрос в Inbox')],
  // О2: «прервать и сказать» — только в поле реплики и только пока идёт ход.
  [t`${CMD}↵ в поле`, t('идёт ход — прервать его и сразу сказать реплику')],
  [`${CMD}N`, t('новый разговор без проекта')],
  [`${CMD}1…9`, t('первые беседы в списке слева')],
  [`${CMD}I`, t('показать или спрятать Inbox')],
  // О2: разборка очереди с клавиатуры (как в Conductor и cmux).
  [attentionKeys(IS_MAC).next, t('следующая сессия, которая ждёт тебя: ошибки → запросы → готовые')],
  [attentionKeys(IS_MAC).snooze, t('отложить текущую: в конец очереди и к следующей')],
  [attentionKeys(IS_MAC).unread, t('пометить текущую непрочитанной')],
  // О2 «Поиск, метки» (docs/14).
  [searchKeys(IS_MAC).search, t('поиск по всем разговорам: реплики, ответы, инструменты')],
  [`${searchKeys(IS_MAC).prevUser} ${searchKeys(IS_MAC).nextUser}`, t('предыдущая и следующая твоя реплика в ленте (метки — полоса слева)')],
  [`${CMD}V`, t('вставить: на файлах из Finder — их пути')],
  [`${CMD}/`, t('эта справка')],
  [`${CMD},`, t('настройки: умолчания «+ Сессия», последний выбор')],
  [t('правый клик'), t('меню сессии или проекта (как «⋯»): переименовать, экспорт в Markdown, архив')],
]

export function HotkeysHelp({ onClose }: { onClose(): void }): ReactElement {
  return (
    <Dialog title={t("Горячие клавиши")} onClose={onClose} size="narrow" testId="hotkeys-help"
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>{t("Закрыть ")}<Kbd>Esc</Kbd></button></>}>
      <dl className="hotkeys">
        {HOTKEYS.map(([k, v]) => <div key={k} className="hotkey"><dt><Kbd>{k}</Kbd></dt><dd>{v}</dd></div>)}
      </dl>
    </Dialog>
  )
}

/** Переименовать сессию из меню: поле с текущим названием, Enter — сохранить, пусто — снять. */
export function RenameDialog({ name, title, onSave, onClose }: {
  name: string; title: string; onSave(title: string): Promise<boolean>; onClose(): void
}): ReactElement {
  const [value, setValue] = useState(title)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const ok = await onSave(value.replace(/\s+/g, ' ').trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={t("Переименовать сессию")} onClose={onClose} size="narrow" testId="rename-dialog"
      footer={<>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t("Отмена ")}<Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy} data-testid="rename-save">{t("Сохранить ")}<Kbd>↵</Kbd></button>
      </>}>
      <label className="field">
        <span className="lbl">{t("Название")}</span>
        <input ref={input} value={value} maxLength={60} placeholder={name} data-testid="rename-dialog-input"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
      </label>
      <span className="note">{t("Имя для CLI — ")}<span className="mono">{name}</span>{t(" — не меняется. Пустое название — показывать имя.")}</span>
    </Dialog>
  )
}

export function Confirm({ title, text, action, danger, onOk, onCancel, testId, cancelFirst }: {
  title: string; text: ReactNode; action: string; danger?: boolean; cancelFirst?: boolean; onOk(): void; onCancel(): void; testId: string
}): ReactElement {
  const ok = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { (cancelFirst ? cancel : ok).current?.focus() }, [cancelFirst])
  return (
    <Dialog title={title} onClose={onCancel} size="narrow" testId={testId}
      footer={<>
        <span className="grow" />
        <button type="button" className="btn" ref={cancel} onClick={onCancel}>{t("Отмена ")}<Kbd>Esc</Kbd></button>
        <button ref={ok} type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onOk} data-testid="confirm-ok">{action} <Kbd>↵</Kbd></button>
      </>}>
      <div>{text}</div>
    </Dialog>
  )
}

// --- doctor -------------------------------------------------------------------------

/** Диагностика уже содержит отдельную команду исправления; поясняем код, не заменяя её догадкой. */
function DoctorDetail({ text, failed }: { text: string; failed: boolean }): ReactElement {
  if (!failed || exitCodeIn(text) === undefined) return <>{text}</>
  const failure = explainFailure(text, { scope: 'check' })
  return <span className="failure-message">
    <span>{failure.explanation}</span>
    <details className="error-details"><summary>{t("Технические подробности")}</summary><pre>{text}</pre></details>
  </span>
}

export function DoctorPanel({ report, groups, loading, error, copied, onRerun, onCopy, onClose, onMcp }: {
  report: DoctorReport | null
  groups: readonly DoctorGroup[]
  loading: boolean
  error: string | null
  copied: string | null
  onRerun(): void
  onCopy(text: string): void
  onClose(): void
  /** О3: открыть «MCP-серверы». Нет — старая оболочка без `mcp.*` в белом списке. */
  onMcp?(): void
}): ReactElement {
  return (
    <Dialog title={t("Проверка окружения")} size="wide" onClose={onClose} testId="doctor-panel"
      extra={report && (
        <span className="doc-sum">
          <span className="chip tone-ok">{report.counts.ok}{t(" ок")}</span>
          {report.counts.warn > 0 && <span className="chip tone-wait">{report.counts.warn} {plural(report.counts.warn, t('предупреждение'), t('предупреждения'), t('предупреждений'))}</span>}
          {report.counts.fail > 0 && <span className="chip tone-fail">{report.counts.fail} {plural(report.counts.fail, t('сбой'), t('сбоя'), t('сбоев'))}</span>}
        </span>
      )}
      footer={<>
        <span className="mut mono small">{report ? t`проверено в ${hhmm(report.generatedAt)}` : ''}</span>
        {error && <span className="err">{error}</span>}
        <span className="grow" />
        {onMcp && <button type="button" className="btn" onClick={onMcp} data-testid="open-mcp-settings" title={t("Свои MCP-серверы в сессиях Claude")}>{t("MCP-серверы…")}</button>}
        <button type="button" className="btn" onClick={onRerun} disabled={loading} data-testid="doctor-rerun"><Icon name="refresh" />{loading ? t('проверяю…') : t('Перепроверить')}</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>{t("Готово")}</button>
      </>}>
      {!report && loading && <div className="mut">{t("Проверяю окружение: CLI, вход, сеть, служба…")}</div>}
      {groups.map((g) => (
        <section key={g.title} className="doc-group">
          <h3 className="lbl">{g.title}</h3>
          {g.items.map((it) => (
            <div key={it.id} className="doc-item" data-testid="doctor-item" data-status={it.status}>
              <span className={`t-${it.status === 'ok' ? 'ok' : it.status === 'warn' ? 'wait' : 'fail'}`}>
                <Icon name={it.status === 'ok' ? 'check' : it.status === 'warn' ? 'alert' : 'x'} />
              </span>
              <span className="title">{it.title}</span>
              <span className="detail"><DoctorDetail text={it.detail} failed={it.status !== 'ok'} /></span>
              {/* Совет словами — обычным текстом; рамка и «копировать» — только у команды, которую
                  можно вставить в терминал (вставленный совет давал `command not found`). */}
              {it.fix && it.fix !== it.fixCmd && <p className="doc-fix-text">{it.fix}</p>}
              {it.fixCmd && (
                <div className="doc-fix">
                  <code>{it.fixCmd}</code>
                  <button type="button" className="btn btn-sm" onClick={() => onCopy(it.fixCmd as string)} data-testid="doctor-copy">
                    <Icon name={copied === it.fixCmd ? 'check' : 'copy'} />{copied === it.fixCmd ? t('скопировано') : t('копировать')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </Dialog>
  )
}

// --- О3: свои MCP-серверы -------------------------------------------------------------

/**
 * «MCP-серверы»: какие серверы из `~/.claude.json` подключать к сессиям Claude. Выбор — явный список имён
 * (`mcp.select`), действует со следующего хода. Серверы проекта (.mcp.json) — позже. Логика — model/mcp.ts.
 */
export function McpServersDialog({ listing, loading, error, saving, onSave, onClose }: {
  listing: McpListing | null
  loading: boolean
  error: string | null
  saving: boolean
  onSave(names: string[]): void
  onClose(): void
}): ReactElement {
  const [chosen, setChosen] = useState<string[] | null>(null)
  const selected = chosen ?? listing?.selected ?? []
  const rows = mcpRows(listing, selected)
  return (
    <Dialog title={t("MCP-серверы")} onClose={onClose} testId="mcp-settings"
      footer={<>
        {error && <span className="err" role="alert" data-testid="mcp-error">{error}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>{t("Отмена ")}<Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" disabled={saving || loading || !listing || chosen === null} data-testid="mcp-save"
          onClick={() => onSave(selected)}>{saving ? t('Сохраняю…') : t('Сохранить')}</button>
      </>}>
      <span className="note">
        {t("Отмеченные серверы из ~/.claude.json подключаются к сессиям Claude со следующего хода — в тот же MCP-конфиг, что и Inbox разрешений. Серверы проекта (.mcp.json) — позже. Codex свои серверы берёт из ~/.codex/config.toml сам.")}</span>
      {loading && !listing && <div className="mut">{t("Читаю ~/.claude.json…")}</div>}
      {listing?.warnings.map((w) => <div key={w} className="note t-wait" data-testid="mcp-warning">{w}</div>)}
      {listing && !rows.length && <div className="mut" data-testid="mcp-empty">{t("В ~/.claude.json своих MCP-серверов нет.")}</div>}
      <div className="mcp-list">
        {rows.map((r) => (
          <label key={r.name} className="check mcp-row" data-testid="mcp-row" data-name={r.name}>
            <input type="checkbox" checked={r.checked} data-testid={`mcp-check-${r.name}`}
              onChange={() => setChosen(toggleServer(selected, r.name))} />
            <span className="mono">{r.name}</span>
            <span className="mut small">{r.transport} · {r.detail}</span>
          </label>
        ))}
        {(listing?.missing ?? []).filter((n) => selected.includes(n)).map((n) => (
          <label key={`missing:${n}`} className="check mcp-row" data-testid="mcp-missing" data-name={n}>
            <input type="checkbox" checked onChange={() => setChosen(toggleServer(selected, n))} />
            <span className="mono">{n}</span>
            <span className="note">{t("выбран, но в ~/.claude.json его нет — не подключается")}</span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
