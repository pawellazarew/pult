// Inbox (справа), диалог «+ Агент», панель doctor и подтверждение. Логика форм и сортировок —
// в model/*.ts; здесь только отрисовка и фокус.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactElement, ReactNode } from 'react'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago, shortPath } from '../model/agents.js'
import type { DoctorGroup } from '../model/health.js'
import { attentionKeys, searchKeys } from '../model/hotkeys.js'
import { ATTENTION_LABEL, INBOX_FILTERS } from '../model/inbox.js'
import type { InboxFilter, InboxItem, SessionCard } from '../model/inbox.js'
import { APPROVAL_FULL_WARNING, APPROVAL_LABEL, APPROVAL_ORDER, approvalHint, homeWarning, prefillForm, promptStats, providerPreset, switchProviderPrefill, validateForm, withFolder } from '../model/newAgent.js'
import type { NewAgentForm, SettingsReply } from '../model/newAgent.js'
import type { NewSessionPrefill } from '../../../shell/src/contract.js'
import type { AgentProvider, DoctorReport, ProviderCatalog } from '../model/types.js'
import { mcpRows, toggleServer } from '../model/mcp.js'
import type { McpListing } from '../model/mcp.js'
import { plural } from '../lib/ru.js'
import { FOLDER_DROP_HINT, folderFromDrop, hasFiles } from '../model/filePathsInput.js'
import type { FilePathSource } from '../model/paths.js'
import { useFilePaths } from './useFilePaths.js'
import { CMD, hhmm, Icon, IS_MAC, Kbd, ProviderTag } from './common.js'
import { PermCard } from './PermCard.js'

// --- Inbox -------------------------------------------------------------------------
// О2 (docs/14): почтовый ящик всего, что требует человека. Фильтр «Все» — запросы и непрочитанные
// ошибки, «Непрочитанные» — все непрочитанные сессии, «Ошибки» — только ошибки.

export function Inbox({ items, cards = [], filter = 'all', counts, agents, focused, busy, retrying, now, onFocus, onApprove, onAnswer, onDeny, onClose, onFilter, onOpen, onRetry, onStop, onWait }: {
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
          <div className="inbox-filter" role="group" aria-label="Что показать">
            {INBOX_FILTERS.map(([f, label]) => (
              <button key={f} type="button" className="btn btn-sm btn-ghost" aria-pressed={filter === f} data-testid={`inbox-filter-${f}`}
                onClick={() => onFilter(f)}>{label}{counts?.[f] ? <span className="n">{counts[f]}</span> : null}</button>
            ))}
          </div>
        ) : <span className="count">{items.length ? `${items.length} ждут` : ''}</span>}
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title={`Скрыть (${CMD}I)`}><Icon name="x" /></button>
      </div>
      <div className="inbox-list">
        {shown === 0 ? (
          <div className="inbox-empty" data-testid="inbox-empty">
            <Icon name="check" />
            {filter === 'unread' ? <>Непрочитанного нет.<br />Здесь появятся сессии, которые закончили ход, упали или спросили, пока ты был не на них.</>
              : filter === 'errors' ? <>Ошибок нет.<br />Упавший ход, исчерпанный лимит, отказ стража и зависший ход появятся здесь.</>
                : <>Никто ничего не ждёт.<br />Запросы разрешений и ошибки всех сессий появятся здесь.</>}
          </div>
        ) : <>
          {cards.filter((c) => c.error).map((c) => <SessionCardView key={`s:${c.name}`} c={c} agent={who(c.name)} now={now}
            retrying={retrying?.has(c.name) ?? false} onOpen={onOpen} onRetry={onRetry} onStop={onStop} onWait={onWait} />)}
          {items.map((p) => (
            <PermCard key={p.id} permId={p.id} toolName={p.toolName} input={p.input} state="pending"
              agent={who(p.sessionId)} createdAt={p.createdAt} now={now}
              focused={focused === p.id} busy={busy.has(p.id)} {...(p.offers ? { offers: p.offers } : {})} {...(p.concealed ? { concealed: true } : {})}
              onFocus={() => onFocus(p.id)} onApprove={(scope) => onApprove(p.id, scope)} onAnswer={(answers) => onAnswer?.(p.id, answers)} onDeny={(r) => onDeny(p.id, r)} />
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
  return (
    <div className="perm inbox-session" data-testid={c.error ? 'inbox-error' : 'inbox-unread'} data-agent={c.name} data-kind={c.kind}
      data-error={c.error ? '1' : '0'}>
      <div className="perm-h">
        <span className="lbl">{ATTENTION_LABEL[c.kind]}</span>
        <span className="who" title={agent.key !== agent.name ? `${agent.name} · имя для CLI: ${agent.key}` : agent.name}>{agent.name}</span>
        <ProviderTag provider={agent.provider} />
        <span className="waited">{ago(c.at, now)}</span>
      </div>
      {c.text && <div className="perm-reason" data-testid="inbox-error-text">{c.text}</div>}
      <div className="perm-actions">
        {c.retryable && onRetry && (
          <button type="button" className="btn btn-sm" disabled={retrying} data-testid="inbox-retry"
            title="Отправить последнюю реплику ещё раз" onClick={() => onRetry(c.name)}><Icon name="refresh" />{retrying ? 'Повторяю…' : 'Повторить'}</button>
        )}
        {/* Сторож тишины (О2): ход сам не обрывается — решает человек. */}
        {c.kind === 'stalled' && onStop && (
          <button type="button" className="btn btn-sm btn-danger" data-testid="inbox-stall-stop"
            title="Остановить зависший ход" onClick={() => onStop(c.name, c.id, c.turnId)}><Icon name="stop" />Прервать</button>
        )}
        {c.kind === 'stalled' && onWait && (
          <button type="button" className="btn btn-sm" data-testid="inbox-stall-wait"
            title="Ход идёт дальше; карточка уйдёт" onClick={() => onWait(c.name, c.id)}>Ждать</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" data-testid="inbox-open" onClick={() => onOpen?.(c.name)}>Открыть</button>
      </div>
    </div>
  )
}

// --- диалог -------------------------------------------------------------------------

export function Dialog({ title, children, footer, onClose, size, testId, extra }: {
  title: string; children: ReactNode; footer: ReactNode; onClose(): void; size?: 'wide' | 'narrow'; testId: string; extra?: ReactNode
}): ReactElement {
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`dlg${size ? ` ${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="dlg-h"><h2>{title}</h2><span className="grow" />{extra}<button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Закрыть"><Icon name="x" /></button></div>
        <div className="dlg-b">{children}</div>
        <div className="dlg-f">{footer}</div>
      </div>
    </div>
  )
}

/** Горячие клавиши окна — то, что раньше стояло строкой под полем ввода (открывается «?» и ⌘/). */
export const HOTKEYS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'отправить реплику · идёт ход — поставить её в очередь'],
  ['Shift+Enter', 'новая строка в реплике'],
  ['Esc', 'стоп хода (подтверждение) · закрыть диалог или меню'],
  [`${CMD}↵`, 'разрешить выделенный запрос в Inbox'],
  // О2: «прервать и сказать» — только в поле реплики и только пока идёт ход.
  [`${CMD}↵ в поле`, 'идёт ход — прервать его и сразу сказать реплику'],
  [`${CMD}N`, 'новая сессия (в проекте текущей)'],
  [`${CMD}1…9`, 'вкладки открытых сессий'],
  [`${CMD}I`, 'показать или спрятать Inbox'],
  // О2: разборка очереди с клавиатуры (как в Conductor и cmux).
  [attentionKeys(IS_MAC).next, 'следующая сессия, которая ждёт тебя: ошибки → запросы → готовые'],
  [attentionKeys(IS_MAC).snooze, 'отложить текущую: в конец очереди и к следующей'],
  [attentionKeys(IS_MAC).unread, 'пометить текущую непрочитанной'],
  // О2 «Поиск, метки» (docs/14).
  [searchKeys(IS_MAC).search, 'поиск по всем разговорам: реплики, ответы, инструменты'],
  [`${searchKeys(IS_MAC).prevUser} ${searchKeys(IS_MAC).nextUser}`, 'предыдущая и следующая твоя реплика в ленте (метки — полоса слева)'],
  [`${CMD}V`, 'вставить: на файлах из Finder — их пути'],
  [`${CMD}/`, 'эта справка'],
  [`${CMD},`, 'настройки: умолчания «+ Сессия», последний выбор'],
  ['правый клик', 'меню сессии или проекта (как «⋯»): переименовать, экспорт в Markdown, архив'],
]

export function HotkeysHelp({ onClose }: { onClose(): void }): ReactElement {
  return (
    <Dialog title="Горячие клавиши" onClose={onClose} size="narrow" testId="hotkeys-help"
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Закрыть <Kbd>Esc</Kbd></button></>}>
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
    <Dialog title="Переименовать сессию" onClose={onClose} size="narrow" testId="rename-dialog"
      footer={<>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Отмена <Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy} data-testid="rename-save">Сохранить <Kbd>↵</Kbd></button>
      </>}>
      <label className="field">
        <span className="lbl">Название</span>
        <input ref={input} value={value} maxLength={60} placeholder={name} data-testid="rename-dialog-input"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
      </label>
      <span className="note">Имя для CLI — <span className="mono">{name}</span> — не меняется. Пустое название — показывать имя.</span>
    </Dialog>
  )
}

export function Confirm({ title, text, action, danger, onOk, onCancel, testId }: {
  title: string; text: ReactNode; action: string; danger?: boolean; onOk(): void; onCancel(): void; testId: string
}): ReactElement {
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => { ok.current?.focus() }, [])
  return (
    <Dialog title={title} onClose={onCancel} size="narrow" testId={testId}
      footer={<>
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel}>Отмена <Kbd>Esc</Kbd></button>
        <button ref={ok} type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onOk} data-testid="confirm-ok">{action} <Kbd>↵</Kbd></button>
      </>}>
      <div>{text}</div>
    </Dialog>
  )
}

// --- «+ Агент» -------------------------------------------------------------------------

function Seg<T extends string>({ value, options, onChange, prov, label }: {
  value: T | null; options: readonly T[]; onChange(v: T): void; prov?: boolean; label: string
}): ReactElement {
  return (
    <div className={`seg${prov ? ' prov' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" data-v={o} aria-pressed={value === o} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  )
}

/**
 * M8d «Как подтверждать действия»: выбор режима, строка о том, что он значит у ЭТОГО провайдера, и красное
 * предупреждение у «Полного доступа». Отдельным компонентом — его состояния проверяются отрисовкой в строку.
 */
export function ApprovalField({ provider, approval, error, onChange }: {
  provider: NewAgentForm['provider']; approval: NewAgentForm['approval']; error?: string; onChange(v: NewAgentForm['approval']): void
}): ReactElement {
  return (
    <div className="field" data-testid="new-agent-approval-field">
      <span className="lbl">подтверждения</span>
      <select value={approval} data-testid="new-agent-approval" onChange={(e) => onChange(e.target.value as NewAgentForm['approval'])}>
        {APPROVAL_ORDER.map((m) => <option key={m} value={m}>{APPROVAL_LABEL[m]}</option>)}
      </select>
      <span className="note" data-testid="new-agent-approval-hint">{approvalHint(provider, approval)}</span>
      {approval === 'full' && <span className="bad" role="alert" data-testid="new-agent-approval-warning">{APPROVAL_FULL_WARNING}</span>}
      {error && <span className="bad" data-testid="new-agent-approval-error">{error}</span>}
    </div>
  )
}

/** Сколько «Завести» заперта в диалоге из ссылки. */
const LINK_SUBMIT_DELAY_MS = 1000
/** Предел высоты поля реплики из ссылки; длиннее — прокрутка, счётчик строк под полем. */
const LINK_PROMPT_MAX_PX = 360

export function NewAgentDialog({ taken, pickFolder, onCreate, onClose, catalog, checking, onCheck, defaultCwd, prefill, settings, filePaths = null }: {
  /** Папка проекта, из которого позвали «+ сессия»: форма открывается уже с ней. */
  defaultCwd?: string | null
  /** M8f: умолчания и последний выбор (`settings.get`); нет — старый демон или оболочка: встроенные умолчания. */
  settings?: SettingsReply | null
  /** Заготовка из ссылки `pult://new` (docs/14 О3): поля заполнены, заводит сессию всё равно человек. */
  prefill?: NewSessionPrefill | null
  catalog?: ProviderCatalog | null
  checking?: boolean
  onCheck?(): void
  taken: readonly string[]
  pickFolder(): Promise<string | null>
  /** Пути перетащенных и скопированных файлов; нет — старая оболочка: перетаскивание и ⌘V файлов как раньше. */
  filePaths?: FilePathSource | null
  onCreate(form: NewAgentForm): Promise<string | null>
  onClose(): void
}): ReactElement {
  // M8f: явный контекст (папка проекта, ссылка) > последний выбор (если включён) > умолчания из Настроек > встроенные.
  const [form, setForm] = useState<NewAgentForm>(() => prefillForm({ cwd: defaultCwd ?? null, prefill: prefill ?? null }, settings ?? null, taken))
  const fromLast = !!(settings?.newSession.rememberLast && settings.lastUsed.provider)
  const [nameTouched, setNameTouched] = useState(false)
  const [tried, setTried] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Диалог из ссылки: первую секунду «Завести» заперта — Enter, нажатый в другом приложении за миг до
  // того, как окно всплыло, не заведёт сессию (docs/14 О3).
  const [armed, setArmed] = useState(!prefill)
  useEffect(() => {
    if (armed) return
    const t = window.setTimeout(() => setArmed(true), LINK_SUBMIT_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [armed])
  const promptBox = useRef<HTMLTextAreaElement>(null)
  // Реплика из ссылки видна целиком: поле растёт по тексту (до предела высоты, дальше — прокрутка и счётчик).
  useLayoutEffect(() => {
    const el = promptBox.current
    if (!prefill || !el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(LINK_PROMPT_MAX_PX, el.scrollHeight + 2)}px`
  }, [form.prompt, prefill])
  const errors = validateForm(form, taken)
  const preset = providerPreset(form.provider, form.model, catalog)
  const readiness = catalog?.[form.provider]
  useEffect(() => {
    if (!preset.efforts.includes(form.effort) && form.effort !== preset.defaultEffort) {
      setForm((f) => ({ ...f, effort: preset.defaultEffort }))
    }
  }, [form.provider, form.model, form.effort, preset.defaultEffort, preset.efforts.join(',')])

  // Папка — системным выбором или перетаскиванием: одинаково, и имя из папки, пока его не трогали.
  const applyFolder = (dir: string): void => {
    setForm((f) => withFolder(f, dir, nameTouched, taken))
  }
  const choose = async (): Promise<void> => {
    const dir = await pickFolder()
    if (!dir) return
    setDropHint(null)
    applyFolder(dir)
  }
  // Файлы в «первую реплику» — пути, как в поле ввода разговора; папка на остальную форму — папка сессии.
  const prompt = useFilePaths({ source: filePaths, box: promptBox, text: form.prompt, setText: (v) => setForm((f) => ({ ...f, prompt: v })), session: form.name })
  const [folderOver, setFolderOver] = useState(false)
  const [dropHint, setDropHint] = useState<string | null>(null)
  const inPrompt = (e: DragEvent<HTMLElement>): boolean => !!promptBox.current?.contains(e.target as Node)
  const folderOverHere = (e: DragEvent<HTMLDivElement>): void => {
    if (inPrompt(e) || !filePaths || !hasFiles(e.dataTransfer.types)) { if (folderOver) setFolderOver(false); return }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!folderOver) setFolderOver(true)
  }
  const folderDrag = {
    // Переход на элемент формы — dragenter, dragover Chromium шлёт со следующего движения: подсветка сразу.
    onDragEnter: folderOverHere,
    onDragOver: folderOverHere,
    onDragLeave: (e: DragEvent<HTMLDivElement>): void => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFolderOver(false)
    },
    onDrop: (e: DragEvent<HTMLDivElement>): void => {
      setFolderOver(false)
      if (inPrompt(e) || !filePaths || !e.dataTransfer.files.length) return
      e.preventDefault()
      // Файлы и записи читаются синхронно, до первого await, — после события DataTransfer пуст.
      void folderFromDrop(e.dataTransfer, filePaths).then((r) => {
        if (r.kind === 'folder') { setDropHint(null); applyFolder(r.path) }
        else if (r.kind === 'files') setDropHint(FOLDER_DROP_HINT)
      })
    },
  }
  const submit = async (): Promise<void> => {
    setTried(true)
    if (Object.keys(errors).length || busy || !armed) return
    setBusy(true)
    setErr(null)
    const e = await onCreate(form)
    setBusy(false)
    if (e) setErr(e)
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void submit() }
  }

  return (
    <Dialog title="Новая сессия" onClose={onClose} testId="new-agent-dialog"
      footer={<>
        {err && <span className="err" role="alert" data-testid="new-agent-error">{err}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Отмена <Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !armed} data-testid="new-agent-submit">
          {busy ? 'Завожу…' : form.prompt.trim() ? 'Завести и отправить' : 'Завести'} <Kbd>{`${CMD}↵`}</Kbd>
        </button>
      </>}>
      <div onKeyDown={onKey} className="form-stack" {...folderDrag}>
        {prefill && (
          <div className="field" data-testid="new-agent-from-link">
            <span className="t-wait">Поля заполнены по ссылке pult:// — проверь папку и реплику. Без «Завести» ничего не запустится.</span>
            {prefill.pathRejected && (
              <span className="bad" data-testid="new-agent-link-path-rejected">папка из ссылки не из твоих проектов — выбери сам</span>
            )}
          </div>
        )}
        {fromLast && !prefill && (
          <span className="note" data-testid="new-agent-prefilled">Подставлен прошлый выбор — сменить поведение: Настройки ({CMD},)</span>
        )}
        <div className="row2">
          <div className="field">
            <span className="lbl">провайдер</span>
            <Seg label="Провайдер" prov value={form.provider} options={['claude', 'codex'] as AgentProvider[]} onChange={(v) => setForm((f) => switchProviderPrefill(f, v, settings ?? null))} />
          </div>
          <div className="field">
            <span className="lbl">имя</span>
            <input className="mono" value={form.name} placeholder="из папки" data-testid="new-agent-name"
              onChange={(e) => { setNameTouched(true); setForm({ ...form, name: e.target.value }) }} />
            {tried && errors.name ? <span className="bad">{errors.name}</span>
              : <span className="note">Латиницей — так сессию зовут демон и CLI. Название для списка задашь и поменяешь потом, в шапке разговора.</span>}
          </div>
        </div>

        <div className="field" data-testid="provider-readiness">
          <span className={readiness?.state === 'ready' ? 't-ok' : 't-wait'}>{checking ? 'Проверяю подключение…' : readiness?.detail ?? 'Подключение ещё не проверено'}</span>
          {readiness?.fixCmd && <code>{readiness.fixCmd}</code>}
          {onCheck && <button type="button" className="btn btn-sm" disabled={checking} onClick={onCheck}><Icon name="refresh" />Проверить</button>}
        </div>

        <div className="field">
          <span className="lbl">папка</span>
          <div className="folder">
            {/* Из ссылки — путь целиком, с переносом: сокращённый путь прячет, какая папка на самом деле. */}
            <span className={`path${form.cwd ? ' set' : ''}${prefill ? ' full' : ''}${folderOver ? ' drop' : ''}`} data-testid="new-agent-cwd" data-path={form.cwd} title={form.cwd}
              data-drop={folderOver ? '1' : undefined}>
              {form.cwd ? (prefill ? form.cwd : shortPath(form.cwd, 64)) : 'не выбрана'}
            </span>
            <button type="button" className="btn" onClick={() => void choose()} data-testid="pick-folder"><Icon name="folder" />Выбрать…</button>
          </div>
          {tried && errors.cwd && <span className="bad">{errors.cwd}</span>}
          {homeWarning(form) && <span className="bad" role="alert" data-testid="new-agent-home-warning">{homeWarning(form)}</span>}
          {dropHint && <span className="note" role="status" data-testid="new-agent-drop-hint">{dropHint}</span>}
        </div>

        <div className="field">
          <span className="lbl">ветка worktree</span>
          <input className="mono" value={form.worktree} placeholder="необязательно — например feat/ui" data-testid="new-agent-worktree"
            onChange={(e) => setForm({ ...form, worktree: e.target.value })} />
          {tried && errors.worktree ? <span className="bad">{errors.worktree}</span>
            : <span className="note">Сессия получит свою копию репозитория в ветке — основная папка не тронута.</span>}
        </div>

        {/* О3: браузер для агента — Playwright MCP, свой профиль на сессию; каждый вызов идёт через Inbox. */}
        <div className="field" data-testid="new-agent-browser-field">
          <span className="lbl">браузер</span>
          <label className="check">
            <input type="checkbox" checked={form.browser} data-testid="new-agent-browser"
              onChange={(e) => setForm({ ...form, browser: e.target.checked })} />
            <span>Браузер для агента — открывать страницы, брать данные, скачивать</span>
          </label>
          {form.browser && (
            <label className="check sub">
              <input type="checkbox" checked={form.browserHeaded} data-testid="new-agent-browser-headed"
                onChange={(e) => setForm({ ...form, browserHeaded: e.target.checked })} />
              <span>Показывать окно браузера (в нём можно войти на сайт руками)</span>
            </label>
          )}
          <span className="note">Свой профиль браузера на сессию, не твой Chrome с его куками. Каждый вызов браузера — через Inbox.</span>
        </div>

        {/* M8d: как подтверждать действия — живёт в записи сессии; у живой сессии меняется из подвала (M8f). */}
        <ApprovalField provider={form.provider} approval={form.approval} {...(tried && errors.approval ? { error: errors.approval } : {})}
          onChange={(approval) => setForm({ ...form, approval })} />

        {/* Друг под другом: шесть уровней усилия в половину ширины диалога не помещаются. */}
        <div className="field">
          <span className="lbl">модель</span>
          {form.provider === 'codex' && preset.models.length
            ? <select value={form.model ?? ''} data-testid="new-agent-model" onChange={(e) => setForm({ ...form, model: e.target.value || null })}>
              <option value="">По умолчанию Codex</option>
              {catalog?.codex.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            : preset.models.length
            ? <Seg label="Модель" value={form.model} options={preset.models} onChange={(v) => setForm({ ...form, model: v })} />
            : <span className="note">по умолчанию codex</span>}
        </div>
        <div className="field">
          <span className="lbl">усилие</span>
          <Seg label="Усилие" value={form.effort} options={preset.efforts} onChange={(v) => setForm({ ...form, effort: v })} />
        </div>

        <div className="field">
          <span className="lbl">первая реплика</span>
          <textarea ref={promptBox} value={form.prompt} placeholder="что сделать — можно оставить пустой и написать потом" data-testid="new-agent-prompt"
            className={prompt.over ? 'drop' : undefined} data-drop={prompt.over ? '1' : undefined}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            onPaste={prompt.onPaste} onDragEnter={prompt.onDragEnter} onDragOver={prompt.onDragOver} onDragLeave={prompt.onDragLeave} onDrop={prompt.onDrop} />
          {prompt.notice && <span className="note" role="status" data-testid="new-agent-paste-notice">{prompt.notice}</span>}
          {prefill && form.prompt && (() => {
            const st = promptStats(form.prompt)
            return <span className="note" data-testid="new-agent-prompt-stats">{`${st.lines} ${plural(st.lines, 'строка', 'строки', 'строк')} · ${st.chars} ${plural(st.chars, 'знак', 'знака', 'знаков')}`}</span>
          })()}
        </div>
      </div>
    </Dialog>
  )
}

// --- doctor -------------------------------------------------------------------------

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
    <Dialog title="Проверка окружения" size="wide" onClose={onClose} testId="doctor-panel"
      extra={report && (
        <span className="doc-sum">
          <span className="chip tone-ok">{report.counts.ok} ок</span>
          {report.counts.warn > 0 && <span className="chip tone-wait">{report.counts.warn} {plural(report.counts.warn, 'предупреждение', 'предупреждения', 'предупреждений')}</span>}
          {report.counts.fail > 0 && <span className="chip tone-fail">{report.counts.fail} {plural(report.counts.fail, 'сбой', 'сбоя', 'сбоев')}</span>}
        </span>
      )}
      footer={<>
        <span className="mut mono small">{report ? `проверено в ${hhmm(report.generatedAt)}` : ''}</span>
        {error && <span className="err">{error}</span>}
        <span className="grow" />
        {onMcp && <button type="button" className="btn" onClick={onMcp} data-testid="open-mcp-settings" title="Свои MCP-серверы в сессиях Claude">MCP-серверы…</button>}
        <button type="button" className="btn" onClick={onRerun} disabled={loading} data-testid="doctor-rerun"><Icon name="refresh" />{loading ? 'проверяю…' : 'Перепроверить'}</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Готово</button>
      </>}>
      {!report && loading && <div className="mut">Проверяю окружение: CLI, вход, сеть, служба…</div>}
      {groups.map((g) => (
        <section key={g.title} className="doc-group">
          <h3 className="lbl">{g.title}</h3>
          {g.items.map((it) => (
            <div key={it.id} className="doc-item" data-testid="doctor-item" data-status={it.status}>
              <span className={`t-${it.status === 'ok' ? 'ok' : it.status === 'warn' ? 'wait' : 'fail'}`}>
                <Icon name={it.status === 'ok' ? 'check' : it.status === 'warn' ? 'alert' : 'x'} />
              </span>
              <span className="title">{it.title}</span>
              <span className="detail">{it.detail}</span>
              {/* Совет словами — обычным текстом; рамка и «копировать» — только у команды, которую
                  можно вставить в терминал (вставленный совет давал `command not found`). */}
              {it.fix && it.fix !== it.fixCmd && <p className="doc-fix-text">{it.fix}</p>}
              {it.fixCmd && (
                <div className="doc-fix">
                  <code>{it.fixCmd}</code>
                  <button type="button" className="btn btn-sm" onClick={() => onCopy(it.fixCmd as string)} data-testid="doctor-copy">
                    <Icon name={copied === it.fixCmd ? 'check' : 'copy'} />{copied === it.fixCmd ? 'скопировано' : 'копировать'}
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
    <Dialog title="MCP-серверы" onClose={onClose} testId="mcp-settings"
      footer={<>
        {error && <span className="err" role="alert" data-testid="mcp-error">{error}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Отмена <Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" disabled={saving || loading || !listing || chosen === null} data-testid="mcp-save"
          onClick={() => onSave(selected)}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
      </>}>
      <span className="note">
        Отмеченные серверы из ~/.claude.json подключаются к сессиям Claude со следующего хода — в тот же MCP-конфиг, что и
        Inbox разрешений. Серверы проекта (.mcp.json) — позже. Codex свои серверы берёт из ~/.codex/config.toml сам.
      </span>
      {loading && !listing && <div className="mut">Читаю ~/.claude.json…</div>}
      {listing?.warnings.map((w) => <div key={w} className="note t-wait" data-testid="mcp-warning">{w}</div>)}
      {listing && !rows.length && <div className="mut" data-testid="mcp-empty">В ~/.claude.json своих MCP-серверов нет.</div>}
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
            <span className="note">выбран, но в ~/.claude.json его нет — не подключается</span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
