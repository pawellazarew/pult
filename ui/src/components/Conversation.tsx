// Центр окна: разговор с выбранным агентом (docs/12 §3 п.2). Вся логика ленты — в model/conversation.ts;
// здесь только отрисовка, прокрутка «прилипает» к низу, пока человек сам не отлистал вверх.

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { ConnState, PultEvent } from '../../../shell/src/contract.js'
import type { AgentView } from '../model/agents.js'
import { AGENT_TITLE_MAX, agentLabel, shortPath, statusView } from '../model/agents.js'
import { contextView } from '../model/context.js'
import type { SessionContext } from '../model/context.js'
import type { AgentItem, ConvItem, ItemState, NoticeItem, ToolItem } from '../model/conversation.js'
import { composerCmdEnter, searchKeys } from '../model/hotkeys.js'
import { adjacentUser, itemForEvent, userMarks } from '../model/search.js'
import { formatSeconds, messageSource, resultText, toolSummary } from '../model/conversation.js'
import { obj } from '../model/types.js'
import type { QueueItem } from '../model/types.js'
import type { ProviderUsage } from '../model/usage.js'
import { formatClock, formatResetIn, limitHolds, limitWindowsView } from '../model/usage.js'
import { useFilePaths } from './useFilePaths.js'
import type { FilePathSource } from '../model/paths.js'
import { APPROVAL_FULL_WARNING, approvalFooter, approvalHint } from '../model/newAgent.js'
import { Chip, CMD, hhmm, Icon, IS_MAC, Kbd, ProviderTag } from './common.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import { settingsMenu } from '../model/sessionSettings.js'
import type { SettingsPick } from '../model/sessionSettings.js'
import type { ProviderCatalog } from '../model/types.js'
import { copyToClipboard, Markdown, MdBridgeContext, useFlash } from './Markdown.js'
import { restoreDraft, sendFromComposer } from '../model/pending.js'
import { expireQueueEdit, queueEditKey, saveQueueEdit, startQueueEdit } from '../model/queueEdit.js'
import type { QueueEditApi, QueueEditState, QueueEditStep } from '../model/queueEdit.js'
import { errorText, isBridgeError } from '../bridge.js'
import { PermCard } from './PermCard.js'
import { takeAutoFocus } from '../lib/linkGuard.js'

export interface ConversationProps {
  agent: AgentView
  items: readonly ConvItem[]
  now: number
  usage: ProviderUsage | undefined
  focusedPerm: string | null
  permBusy: Set<string>
  sendError: string | null
  sending: boolean
  /**
   * M8e: реплика ушла, демон ещё не подтвердил — бледный пузырь «отправляется…» в конце ленты
   * (model/pending.ts). Подтверждение — настоящая реплика в ленте; тогда Console присылает `null`.
   */
  pending?: { text: string; ts: string } | null
  /**
   * Связь с демоном (по умолчанию 'up'). Не 'up' — реплика не уйдёт, ввод это говорит, а не зовёт
   * печатать. 'connecting' и 'down' различаем: кнопка «Запустить демона» есть только в 'down'.
   */
  link?: ConnState['state']
  /**
   * Отправить реплику. `mode` (О2): 'queue' — идёт ход, реплика встаёт в очередь демона; 'interrupt' —
   * прервать ход и сразу сказать. Поле чистится сразу (M8e); `false` — не вышло: текст возвращается в поле,
   * если в нём ещё пусто.
   */
  onSend(text: string, mode?: SendMode): Promise<boolean>
  /** Очередь реплик: убрать, переставить, пустить дальше после неудачного хода. Нет — старый демон. */
  onQueueRemove?(id: string): void
  onQueueMove?(id: string, to: number): void
  onQueueResume?(): void
  /**
   * Правка реплики в очереди (0.3.2): «Изменить» держит очередь на реплике, пока правка открыта. Нет — старый
   * демон: кнопки нет.
   */
  onQueueEdit?: QueueEditApi
  /** Лента собирается из истории (`events.history`) — пустая лента ещё не значит «разговор пуст». */
  historyLoading?: boolean
  /** Полные события по номерам (`events.get`): раскрытая строка инструмента из лёгкой истории. */
  loadEvents?(ids: number[]): Promise<PultEvent[]>
  /** Ранние страницы истории: есть ли ещё и идёт ли запрос. */
  earlier?: { more: boolean; loading: boolean } | undefined
  onLoadEarlier?(): void
  /** Открыть справку по горячим клавишам («?» в подвале). */
  onHelp?(): void
  /**
   * Прокрутить ленту к событию (поиск ⌘⇧F) и подсветить его. Новый `nonce` — новый переход; событие ещё
   * не в ленте — ждём, пока оно придёт (Console догружает ранние страницы). Дошли — `onScrolled(nonce)`.
   */
  scrollTo?: { eventId: number; nonce: number; kind?: string; parentId?: string } | null
  onScrolled?(nonce: number): void
  /** ⌥↑/⌥↓: к предыдущей или следующей реплике человека. Новый `nonce` — новое нажатие. */
  userJump?: { dir: -1 | 1; nonce: number } | null
  /** Пути файлов для вставки и перетаскивания в поле реплики; нет — старая оболочка, поле как раньше. */
  filePaths?: FilePathSource | null
  /** Сменить название (пустое — снять). `false` — не вышло: правка остаётся открытой. */
  onRename(title: string): Promise<boolean>
  onStop(): void
  onRemove(): void
  onReveal(path: string): void
  /** Без `scope` — один раз; `session` / `rule` — кнопки M8d. */
  onApprove(permId: string, scope?: 'session' | 'rule'): void
  onAnswer?(permId: string, answers: Record<string, { answers: string[] }>): void
  onDeny(permId: string, reason: string): void
  onFocusPerm(permId: string): void
  /**
   * M8f: подвал «opus · high · спрашивать» — кнопка меню настроек сессии (модель, усилие, режим — со следующего хода).
   * Нет — старая оболочка без `agent.configure` в мосте: подвал как раньше, без меню.
   */
  onConfigure?(pick: SettingsPick): void
  /** Живой список моделей (Codex — `model/list` из «+ Сессия») и окна моделей из прошлых `context.updated`. */
  catalog?: ProviderCatalog | null
  windows?: ReadonlyMap<string, number>
}

/** Как уходит реплика: сразу, в очередь (идёт ход) или «прервать и сказать». */
export type SendMode = 'now' | 'queue' | 'interrupt'

/** Таймеры снятия подсветки по элементам ленты (переход из поиска, метки, ⌥↑/⌥↓). */
const flashTimers = new WeakMap<Element, number>()

export function Conversation(p: ConversationProps): ReactElement {
  const { agent } = p
  const sv = statusView(agent.status)
  const feed = useRef<HTMLDivElement>(null)
  const qe = useQueueEdit(p.onQueueEdit)
  const stick = useRef(true)

  // Своя реплика ушла — лента едет вниз к ней, даже если человек перед этим листал вверх.
  const pendingText = p.pending?.text
  useLayoutEffect(() => { if (pendingText !== undefined) stick.current = true }, [pendingText])
  useLayoutEffect(() => {
    const el = feed.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [p.items, agent.name, pendingText])
  useLayoutEffect(() => { stick.current = true }, [agent.name])

  const onScroll = (): void => {
    const el = feed.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // --- О2: переход к событию, метки реплик человека, ⌥↑/⌥↓ ---------------------------------
  /** Верх элемента в координатах прокрутки ленты. */
  const topIn = (el: Element, box: HTMLElement): number => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
  /** Прокрутить к элементу ленты с этим id и коротко подсветить его. */
  const reveal = useCallback((itemId: number, block: 'center' | 'start'): boolean => {
    const box = feed.current
    const el = box?.querySelector<HTMLElement>(`[data-event-id="${itemId}"]`)
    if (!box || !el) return false
    stick.current = false
    box.scrollTop = Math.max(0, block === 'start' ? topIn(el, box) - 8 : topIn(el, box) - (box.clientHeight - el.offsetHeight) / 2)
    // Повторная подсветка того же элемента: прежний таймер снятия не должен погасить новую раньше срока.
    const prev = flashTimers.get(el)
    if (prev !== undefined) clearTimeout(prev)
    el.classList.remove('it-flash')
    // Перезапуск анимации: класс снят и поставлен в разных кадрах.
    requestAnimationFrame(() => {
      el.classList.add('it-flash')
      flashTimers.set(el, window.setTimeout(() => { el.classList.remove('it-flash'); flashTimers.delete(el) }, 1800))
    })
    return true
  }, [])
  const doneJump = useRef<number | null>(null)
  useLayoutEffect(() => {
    const t = p.scrollTo
    if (!t || doneJump.current === t.nonce) return
    const it = itemForEvent(p.items, t.eventId, { ...(t.kind !== undefined ? { kind: t.kind } : {}), ...(t.parentId !== undefined ? { parentId: t.parentId } : {}) })
    if (it && reveal(it.id, 'center')) {
      doneJump.current = t.nonce
      p.onScrolled?.(t.nonce)
    }
  }, [p.scrollTo, p.items, reveal, p.onScrolled])
  const marks = userMarks(p.items)
  const lastUserJump = useRef<number | null>(null)
  useEffect(() => {
    const j = p.userJump
    const box = feed.current
    if (!j || !box || lastUserJump.current === j.nonce) return
    lastUserJump.current = j.nonce
    const tops = marks.flatMap((m) => {
      const el = box.querySelector(`[data-event-id="${m.id}"]`)
      return el ? [{ id: m.id, top: topIn(el, box) - 8 }] : []
    })
    const id = adjacentUser(tops, box.scrollTop, j.dir)
    if (id !== null) reveal(id, 'start')
    else if (j.dir > 0) { box.scrollTop = box.scrollHeight; stick.current = true }
  }, [p.userJump, marks, reveal])

  const limited = agent.status === 'limited'
  const resetsAt = p.usage?.resetsAt ?? lastLimitReset(p.items)
  const holds = limitHolds(agent.status, resetsAt, p.now)

  return (
    <section className="conv" aria-label={`Разговор с ${agentLabel(agent)}`} data-testid="conversation" data-agent={agent.name}>
      <header className="conv-head">
        <div className="conv-title">
          <div className="top">
            <Title agent={agent} onRename={p.onRename} />
            <ProviderTag provider={agent.provider} />
            <Chip tone={sv.tone} label={sv.label} testId="conv-status" />
          </div>
        </div>
        {sv.busy && (
          <button type="button" className="btn btn-danger" onClick={p.onStop} data-testid="stop-turn" title="Остановить ход">
            <Icon name="stop" />Стоп<Kbd>Esc</Kbd>
          </button>
        )}
        {!sv.busy && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={p.onRemove} data-testid="remove-agent" title="Удалить сессию">
            <Icon name="trash" />удалить
          </button>
        )}
      </header>

      {limited && (
        <div className="strip strip-wait" data-testid="limit-strip">
          <Icon name="clock" />
          <span>{holds
            ? `Лимит ${agent.provider} исчерпан · сброс в ${formatClock((resetsAt as number) * 1000, p.now)} (${formatResetIn(resetsAt, p.now)}) — новая реплика до сброса не пойдёт.`
            : `Лимит ${agent.provider} упирался${resetsAt ? ` — сброс был в ${formatClock(resetsAt * 1000, p.now)}` : ''}. Можно пробовать снова: если лимит ещё держит, демон скажет.`}</span>
        </div>
      )}

      <div className="feed-wrap">
      {marks.length > 0 && <UserRail marks={marks} items={p.items} feed={feed} onJump={(id) => reveal(id, 'start')} />}
      <div className="feed" ref={feed} onScroll={onScroll} data-testid="feed">
        {p.items.length === 0 && !p.pending && p.historyLoading ? (
          <div className="conv-empty" data-testid="history-loading">
            <h3>Загружаю историю…</h3>
          </div>
        ) : p.items.length === 0 && !p.pending ? (
          <div className="conv-empty">
            <h3>Разговор пуст</h3>
            <div>Напиши первую реплику внизу — сессия начнёт работу в <span className="mono">{shortPath(agent.cwd)}</span>.</div>
          </div>
        ) : (
          <div className="feed-inner">
            {p.earlier?.more && (
              <button type="button" className="btn earlier" data-testid="load-earlier" disabled={p.earlier.loading} onClick={() => p.onLoadEarlier?.()}>
                {p.earlier.loading ? 'Загружаю…' : 'Показать раньше'}
              </button>
            )}
            {p.items.map((it) => <Item key={it.key} it={it} {...p} />)}
            {p.pending && (
              // M8e: реплика в пути. Тот же вид, что у реплики человека, но бледнее и без «копировать»;
              // настоящая придёт событием `message.user` и встанет на это место.
              <div className="it it-user it-pending" data-testid="msg-user-pending" aria-busy="true">
                <Gutter who="ты" cls="who-you" ts={p.pending.ts} />
                <div className="body">
                  <Markdown text={p.pending.text} human />
                  <div className="pending-note" role="status">отправляется…</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      <Composer busy={sv.busy} needsYou={sv.needsYou} permFocused={p.focusedPerm !== null} link={p.link ?? 'up'} disabled={holds} sending={p.sending} error={p.sendError} onSend={p.onSend} agentName={agent.name} label={agentLabel(agent)} filePaths={p.filePaths ?? null}
        queueable={!!p.onQueueRemove} inject={qe.inject} />
      {p.onQueueRemove && (agent.queue?.length || agent.queuePaused || qe.edit || qe.notice) ? (
        <QueueList queue={agent.queue ?? []} paused={agent.queuePaused === true} onRemove={p.onQueueRemove}
          onMove={p.onQueueMove ?? (() => {})} onResume={p.onQueueResume ?? (() => {})}
          {...(p.onQueueEdit ? { edit: qe.view } : {})} notice={qe.notice} />
      ) : null}
      <ChatFooter agent={agent} usage={p.usage} now={p.now} onReveal={p.onReveal} {...(p.onHelp ? { onHelp: p.onHelp } : {})}
        {...(p.onConfigure ? { onConfigure: p.onConfigure } : {})} catalog={p.catalog ?? null} windows={p.windows ?? EMPTY_WINDOWS} />
    </section>
  )
}

/**
 * Название в шапке и его правка на месте: карандаш или двойной щелчок, Enter — сохранить,
 * Esc — бросить. Меняется только название: имя агента (ключ для демона и CLI) остаётся прежним.
 */
function Title({ agent, onRename }: { agent: AgentView; onRename(title: string): Promise<boolean> }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const editing = draft !== null
  useLayoutEffect(() => { if (editing) input.current?.select() }, [editing])
  // Правка закрыта клавишей (Enter, Esc) — фокус обратно в поле реплики, а не в никуда.
  // Закрыта уходом фокуса — человек уже щёлкнул куда хотел, фокус у него не отбираем.
  // `leaving`: перевод фокуса ниже сам вызывает blur у ещё живого поля — без флага Esc
  // («бросить») тут же сохранял бы брошенное через onBlur.
  const leaving = useRef(false)
  const open = (): void => { leaving.current = false; setDraft(agentLabel(agent)) }
  const close = (byKey: boolean): void => {
    leaving.current = true
    setDraft(null)
    if (byKey) document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus()
  }

  const save = async (byKey: boolean): Promise<void> => {
    if (draft === null || saving) return
    const t = draft.replace(/\s+/g, ' ').trim()
    // Стёр до пустого или набрал само имя — название снимается: дубль имени в шапке ни к чему.
    const next = t === agent.name ? '' : t
    if (next === (agent.title ?? '')) { close(byKey); return }
    setSaving(true)
    const ok = await onRename(next)
    setSaving(false)
    if (ok) close(byKey)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Набор иероглифов (IME) сам пользуется Enter и Esc — в это время клавиши не наши.
    if (e.nativeEvent.isComposing) return
    // Только «голый» Enter: ⌘Enter — горячая клавиша окна («разрешить запрос»), сохранять заодно и название незачем.
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); void save(true) }
    // Esc здесь — «бросить правку», а не «стоп хода»: до горячих клавиш окна он не доходит.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  }

  if (draft === null) {
    return (
      <>
        <h2 onDoubleClick={open} data-testid="conv-title">{agentLabel(agent)}</h2>
        <button type="button" className="btn btn-ghost btn-sm title-btn" onClick={open}
          data-testid="rename-agent" title="Переименовать" aria-label="Переименовать сессию"><Icon name="edit" /></button>
      </>
    )
  }
  return (
    // `readOnly`, а не `disabled`: выключенное поле теряет фокус, и после неудачного сохранения
    // Esc уходил бы мимо него — в горячие клавиши окна («Остановить ход?»).
    // Уход фокуса сохраняет, но не когда ушло всё окно (⌘Tab за текстом для названия).
    <input ref={input} className="title-edit" value={draft} maxLength={AGENT_TITLE_MAX} readOnly={saving}
      placeholder={agent.name} aria-label="Название сессии" data-testid="rename-input"
      onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
      onBlur={() => { if (!leaving.current && document.hasFocus()) void save(false) }} />
  )
}

/**
 * Занятость контекстного окна сессии: «контекст 48k / 200k · 24%» и тонкая полоска под ним.
 * Точные числа и модель — в подсказке. Замеров ещё не было — не рисуется вовсе.
 */
/**
 * Подвал под полем ввода (07.10.2026, просьба владельца): всё о сессии там, куда смотришь, когда пишешь —
 * папка (клик — Finder), ветка worktree, модель и усилие, имя для CLI, фоновые задачи, контекстное
 * окно сессии и лимиты провайдера со сбросом; «?» — горячие клавиши (раньше их строка стояла здесь же).
 */
const EMPTY_WINDOWS: ReadonlyMap<string, number> = new Map()

function ChatFooter({ agent, usage, now, onReveal, onHelp, onConfigure, catalog, windows: ctxWindows }: {
  agent: AgentView; usage: ProviderUsage | undefined; now: number; onReveal(path: string): void; onHelp?(): void
  onConfigure?(pick: SettingsPick): void; catalog: ProviderCatalog | null; windows: ReadonlyMap<string, number>
}): ReactElement {
  const windows = limitWindowsView(usage, now)
  const provider = agent.provider
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const approvalTitle = `Подтверждения: ${approvalHint(agent.provider, agent.approval ?? 'ask')}${agent.approval === 'full' ? ` — ${APPROVAL_FULL_WARNING}` : ''}`
  const modelSpan = (agent.model || agent.effort)
    ? <span title="модель · усилие" data-testid="conv-model">{[agent.model, agent.effort].filter(Boolean).join(' · ')}</span> : null
  const approvalSpan = (
    <span className={`approval${agent.approval === 'full' ? ' t-fail' : ''}`} data-testid="conv-approval" data-approval={agent.approval ?? 'ask'} title={approvalTitle}>
      {approvalFooter(agent.provider, agent.approval ?? 'ask', agent.claudeMode)}
    </span>
  )
  const menuItems = (): MenuEntry[] => settingsMenu(agent, catalog, ctxWindows).map((r): MenuEntry => {
    if (r.type === 'sep') return 'sep'
    if (r.type === 'heading') return { heading: r.label, ...(r.testId ? { testId: r.testId } : {}) }
    if (r.type === 'note') return { note: r.label, ...(r.testId ? { testId: r.testId } : {}) }
    return { label: r.label, checked: r.checked, testId: r.testId, onSelect: () => onConfigure?.(r.pick), ...(r.danger ? { danger: true } : {}), ...(r.title ? { title: r.title } : {}) }
  })
  return (
    <div className="chat-status" data-testid="chat-status">
      <span className="chat-meta">
        <button type="button" className="path" title={`Показать в Finder: ${agent.cwd}`} onClick={() => onReveal(agent.cwd)} data-testid="conv-path">{shortPath(agent.cwd, 40)}</button>
        {agent.branch && <span className="br" title="ветка worktree" data-testid="conv-branch"><Icon name="branch" />{agent.branch}</span>}
        {/* M8f: модель · усилие · режим — кнопка меню настроек сессии (со следующего хода). Старая оболочка — просто текст. */}
        {onConfigure ? (
          <button type="button" className="settings" data-testid="conv-settings" aria-haspopup="menu" aria-expanded={menuAt !== null}
            title="Сменить модель, усилие или режим подтверждений — со следующего хода"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt(menuAt ? null : { x: r.left, y: r.top - 6 }) }}>
            {modelSpan}{approvalSpan}
          </button>
        ) : <>{modelSpan}{approvalSpan}</>}
        {agent.title && <span title="имя сессии — им её зовут демон и CLI, оно не меняется" data-testid="conv-name">{agent.name}</span>}
        {agent.browser && (
          // О3: браузер для агента — клик показывает папку скачиваний и снимков страниц в Finder.
          <button type="button" className="browser" data-testid="conv-browser" disabled={!agent.browserDownloads}
            title={`Браузер для агента${agent.browser.headed ? ' (окно видно)' : ''}: свой профиль сессии, каждый вызов — через Inbox.${agent.browserDownloads ? `\nСкачивания: ${agent.browserDownloads}` : ''}`}
            onClick={() => { if (agent.browserDownloads) onReveal(agent.browserDownloads) }}>
            браузер{agent.browser.headed ? ' (окно)' : ''} · скачивания
          </button>
        )}
        {agent.background && (
          <span className="bg" data-testid="conv-background" title={`Фоновые задачи доделывают работу; итог придёт отдельным ходом.\n${agent.background.tasks.join('\n')}`}>
            в фоне · {agent.background.count}
          </span>
        )}
      </span>
      <span className="grow" />
      <ContextMeter ctx={agent.context} />
      {windows.length > 0 && (
        <span className="chat-limits" data-testid="chat-limits">
          <span className={`lbl who-${provider}`}>{provider}</span>
          {windows.map((w) => (
            <span key={w.key} className={`chat-limit t-${w.tone}`} title={w.title} data-testid={`chat-limit-${w.key}`}>
              <span className="k">{w.key}</span> {w.pct}{w.reset && <span className="reset"> · {w.reset}</span>}
            </span>
          ))}
        </span>
      )}
      {/* Меню — вне строки .chat-meta: её разделитель «·» встаёт перед каждым ребёнком. */}
      {menuAt && <ContextMenu at={menuAt} items={menuItems()} onClose={closeMenu} testId="settings-menu" label="Настройки сессии" above />}
      {onHelp && <button type="button" className="help-btn" onClick={onHelp} title={`Горячие клавиши (${CMD}/)`} aria-label="Горячие клавиши" data-testid="hotkeys-open">?</button>}
    </div>
  )
}

/**
 * Полоса меток слева от ленты (как метки на полосе прокрутки в cmux): по метке на реплику человека, на
 * её высоте в ленте. Клик — к реплике. Пока ленту не измерили (первый кадр, отрисовка в строку) — метки
 * стоят равномерно по порядку.
 */
export function UserRail({ marks, items, feed, onJump }: {
  marks: ReadonlyArray<{ id: number; key: string; text: string; ts: string }>
  items: readonly ConvItem[]
  feed: { current: HTMLDivElement | null }
  onJump(id: number): void
}): ReactElement {
  const [pos, setPos] = useState<Record<number, number>>({})
  useLayoutEffect(() => {
    const box = feed.current
    if (!box) return
    const measure = (): void => {
      const h = box.scrollHeight || 1
      const next: Record<number, number> = {}
      for (const m of marks) {
        const el = box.querySelector(`[data-event-id="${m.id}"]`)
        if (el) next[m.id] = Math.min(100, Math.max(0, ((el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) / h) * 100))
      }
      setPos((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    measure()
    const inner = box.firstElementChild
    if (typeof ResizeObserver === 'undefined' || !inner) return
    const ro = new ResizeObserver(measure)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [items, marks.length, feed])
  const keys = searchKeys(IS_MAC)
  return (
    <div className="user-rail" aria-label="Реплики человека" data-testid="user-rail">
      {marks.map((m, i) => (
        <button key={m.key} type="button" className="user-mark" data-testid="user-mark" data-event-id={m.id}
          style={{ top: `${pos[m.id] ?? ((i + 0.5) / marks.length) * 100}%` }}
          title={`${hhmm(m.ts)} · ${m.text.replace(/\s+/g, ' ').slice(0, 80)}${m.text.length > 80 ? '…' : ''}\n${keys.prevUser} / ${keys.nextUser} — соседние реплики`}
          aria-label={`Реплика ${i + 1}: ${m.text.slice(0, 40)}`} onClick={() => onJump(m.id)} />
      ))}
    </div>
  )
}

function ContextMeter({ ctx }: { ctx: SessionContext | undefined }): ReactElement | null {
  const v = contextView(ctx)
  if (!v) return null
  return (
    <div className="ctx-meter" title={v.title} aria-label={v.title} data-testid="conv-context" data-tone={v.tone}>
      <span className="ctx-label">{v.label}</span>
      <div className={`bar t-${v.tone}`}><i style={{ width: `${v.barPct}%` }} /></div>
    </div>
  )
}

function lastLimitReset(items: readonly ConvItem[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ConvItem
    if (it.type === 'notice' && it.resetsAt) return it.resetsAt
  }
  return undefined
}

function Gutter({ who, cls, ts, copy }: { who: string; cls: string; ts: string; copy?: { text: string; what: string } }): ReactElement {
  return (
    <div className="gut">
      <span className={`who ${cls}`}>{who}</span><span className="ts">{hhmm(ts)}</span>
      {copy && <MsgCopy text={copy.text} what={copy.what} />}
    </div>
  )
}

/**
 * M8e: «Копировать» у реплики целиком — ИСХОДНЫЙ текст (Markdown как пришёл или как набран), а не то, что
 * нарисовано. Видна при наведении на реплику и при фокусе с клавиатуры (Tab); путь буфера — тот же мост, что у
 * «Копировать» блока кода. Скопировано — галочка и отметка «Скопировано» над кнопкой.
 */
export function MsgCopy({ text, what }: { text: string; what: string }): ReactElement {
  const bridge = useContext(MdBridgeContext)
  const [flash, show] = useFlash()
  const copy = (): void => { void copyToClipboard(bridge, text).then((ok) => { if (ok) show('Скопировано') }) }
  return (
    <button type="button" className={`msg-copy${flash ? ' done md-flash' : ''}`} onClick={copy} data-testid="msg-copy"
      aria-label={flash ? 'Скопировано' : `Копировать ${what}`} title={`Копировать ${what} (исходный Markdown)`}
      {...(flash ? { 'data-flash': flash } : {})}>
      <Icon name={flash ? 'check' : 'copy'} />
    </button>
  )
}

function Item({ it, ...p }: { it: ConvItem } & ConversationProps): ReactElement | null {
  const prov = p.agent.provider
  const src = messageSource(it)
  switch (it.type) {
    case 'user':
      return (
        <div className="it it-user" data-testid="msg-user" data-event-id={it.id}>
          <Gutter who="ты" cls="who-you" ts={it.ts} {...(src !== null ? { copy: { text: src, what: 'реплику' } } : {})} />
          {/* M8e: реплика человека — тот же безопасный Markdown, что у модели (ссылки, код, переносы строк). */}
          <div className="body"><Markdown text={it.text} human /></div>
        </div>
      )
    case 'model':
      return (
        <div className="it it-model" data-testid="msg-model" data-streaming={it.streaming ? '1' : '0'} data-event-id={it.id}>
          <Gutter who={prov} cls={`who-${prov}`} ts={it.ts} {...(src !== null ? { copy: { text: src, what: 'ответ' } } : {})} />
          <div className={`body${it.error ? ' err' : ''}`}><Markdown text={it.text} streaming={it.streaming} /></div>
        </div>
      )
    case 'tool':
      return <ToolRow it={it} {...(p.loadEvents ? { loadEvents: p.loadEvents } : {})} />
    case 'agent':
      return <SubAgent it={it} {...p} />
    case 'perm':
      return (
        <div className="it it-perm" data-event-id={it.id}>
          <Gutter who="запрос" cls="t-wait" ts={it.ts} />
          <PermCard permId={it.permId} toolName={it.toolName} input={it.input} state={it.state} createdAt={it.ts} now={p.now}
            focused={p.focusedPerm === it.permId} {...(it.message ? { message: it.message } : {})} {...(it.by ? { by: it.by } : {})}
            {...(it.offers ? { offers: it.offers } : {})} {...(it.scope ? { scope: it.scope } : {})} {...(it.rule ? { rule: it.rule } : {})}
            busy={p.permBusy.has(it.permId)}
            onFocus={() => p.onFocusPerm(it.permId)} onApprove={(scope) => p.onApprove(it.permId, scope)} onAnswer={(answers) => p.onAnswer?.(it.permId, answers)} onDeny={(r) => p.onDeny(it.permId, r)} />
        </div>
      )
    case 'notice':
      return <Notice it={it} now={p.now} />
  }
}

const stateTone = (s: ItemState): string => (s === 'running' ? 'run' : s === 'ok' ? 'ok' : s === 'stopped' ? 'mut' : 'fail')

/** Значок состояния строки инструмента и субагента. `stopped` — ход прервали, конца не будет: не спиннер. */
function StateMark({ state }: { state: ItemState }): ReactElement {
  if (state === 'running') return <span className="spin" />
  if (state === 'stopped') return <><Icon name="stop" />прерван</>
  return <Icon name={state === 'ok' ? 'check' : 'x'} />
}

/** Полный вход и вывод строки из лёгкой истории — из `tool.called` / `tool.finished` по номерам. */
type ToolDetail = { input: Record<string, unknown>; result?: string } | 'loading' | 'error'

function ToolRow({ it, loadEvents }: { it: ToolItem; loadEvents?: (ids: number[]) => Promise<PultEvent[]> }): ReactElement {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ToolDetail | null>(null)
  useEffect(() => {
    if (!open || !it.elided || detail !== null || !loadEvents) return
    setDetail('loading')
    const ids = [...new Set([it.id, ...(it.endId !== undefined ? [it.endId] : [])])]
    loadEvents(ids).then(
      (evs) => {
        const called = evs.find((e) => e.kind === 'tool.called')
        const finished = evs.find((e) => e.kind === 'tool.finished')
        const result = finished ? resultText(finished.data['content']) : undefined
        setDetail({ input: obj(called?.data['input']) ?? it.input, ...(result !== undefined ? { result } : {}) })
      },
      () => setDetail('error'),
    )
  }, [open, it.elided, it.id, it.endId, it.input, detail, loadEvents])
  // Строку раскрыли, пока инструмент шёл: конец пришёл живьём — догрузить заново, уже с выводом.
  const endSeen = useRef(it.endId)
  useEffect(() => {
    if (endSeen.current === it.endId) return
    endSeen.current = it.endId
    setDetail(null)
  }, [it.endId])
  const result = detail && typeof detail === 'object' ? detail.result ?? it.result : it.result
  const shown = { input: detail && typeof detail === 'object' ? detail.input : it.input, ...(result !== undefined ? { result } : {}) }
  const sum = toolSummary(it.name, it.input)
  const dur = it.endTs ? Math.max(0, Date.parse(it.endTs) - Date.parse(it.ts)) : null
  return (
    <div className="it it-tool" data-testid="tool-row" data-event-id={it.id}>
      <Gutter who="" cls="" ts={it.ts} />
      <div className="body">
        <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chev" className="chev" />
          <span className="nm">{it.name}</span>
          <span className="sum">{sum}</span>
          <span className={`st t-${stateTone(it.state)}`}>
            <StateMark state={it.state} />
            {it.state !== 'stopped' && dur !== null && dur >= 100 ? formatSeconds(dur) : ''}
            {it.exitCode !== undefined ? ` код ${it.exitCode}` : ''}
          </span>
        </button>
        {open && (
          <div className="tool-detail">
            <div className="k">вход</div>
            <pre>{JSON.stringify(shown.input, null, 2)}</pre>
            {shown.result !== undefined && <><div className="k">результат</div><pre>{shown.result}</pre></>}
            {detail === 'loading' && <div className="k" data-testid="tool-detail-loading">загружаю полный вход и вывод…</div>}
            {detail === 'error' && <div className="k t-fail">полный вход и вывод не загрузились — показан урезанный</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function SubAgent({ it, ...p }: { it: AgentItem } & ConversationProps): ReactElement {
  return (
    <div className="it it-agent" data-provider={p.agent.provider} data-testid="subagent" data-event-id={it.id}>
      <Gutter who="суб" cls={`who-${p.agent.provider}`} ts={it.ts} />
      <div className="body">
        <div className="sub-head">
          <span className="lbl">субагент</span>
          <strong>{it.subagentType ?? 'agent'}</strong>
          <span className="desc">{it.description ?? ''}</span>
          <span className={`st t-${stateTone(it.state)}`} data-testid="subagent-state" data-state={it.state}><StateMark state={it.state} /></span>
        </div>
        {it.items.length > 0 && (
          <div className="sub-body">
            {it.items.map((c) => <Item key={c.key} it={c} {...p} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function Notice({ it, now }: { it: NoticeItem; now: number }): ReactElement {
  const icon = it.tone === 'info' ? 'info' : it.tone === 'wait' ? 'clock' : 'alert'
  return (
    <div className={`it it-notice n-${it.tone}`} data-testid="notice" data-event-id={it.id}>
      <Gutter who="" cls="" ts={it.ts} />
      <div className="body">
        <Icon name={icon} />
        <div>
          <b>{it.title}</b>
          {it.resetsAt && <div className="txt">сброс в {formatClock(it.resetsAt * 1000, now)} · {formatResetIn(it.resetsAt, now)}</div>}
          {it.text && <div className="txt">{it.text}</div>}
        </div>
      </div>
    </div>
  )
}

/**
 * Подсказка в пустом поле — ЧТО делать сейчас. Порядок важен: «ждёт тебя» — тоже `busy`, но
 * «дождись конца или жми Стоп» уводила от нужного действия (решить запрос выше); без демона
 * реплика не уйдёт вовсе, и поле не должно звать печатать.
 */
function placeholderFor(p: { link: ConnState['state']; needsYou: boolean; busy: boolean; disabled: boolean; label: string; queueable: boolean }): string {
  // 'connecting' — первый вход и ручной запуск/перезапуск: баннера с кнопкой в этот момент нет
  // (connView → banner:null), и «запусти кнопкой сверху» сразу после нажатия этой кнопки врало бы.
  if (p.link === 'connecting') return 'подключаюсь к демону…'
  if (p.link === 'down') return 'демон недоступен — запусти его кнопкой сверху'
  if (p.needsYou) return p.queueable ? 'сессия ждёт твоего решения по запросу выше — реплика встанет в очередь' : 'сессия ждёт твоего решения по запросу выше'
  if (p.busy) return p.queueable ? `идёт ход — Enter поставит реплику в очередь, ${CMD}Enter прервёт ход и скажет` : 'сессия делает ход — дождись конца или нажми «Стоп»'
  if (p.disabled) return 'лимит исчерпан — дождись сброса'
  return `реплика для ${p.label}`
}

/** Что видит список очереди о правке: состояние и действия. */
export interface QueueEditView {
  state: QueueEditState | null
  /** Ждём ответа демона на «Изменить» — у этой реплики. */
  opening: string | null
  onStart(id: string): void
  onChange(text: string): void
  onSave(): void
  onCancel(): void
}

/**
 * Правка реплики очереди: состояние, срок удержания и возврат текста в поле ввода. Живёт в `Conversation`
 * (он пересоздаётся на каждую сессию — уход с сессии отпускает очередь), а не в списке: список пропадает,
 * когда очередь пустеет, а открытая правка с текстом человека пропадать не должна.
 */
function useQueueEdit(api: QueueEditApi | undefined): { view: QueueEditView; notice: string | null; inject: { text: string; nonce: number } | null; edit: boolean } {
  const [state, setState] = useState<QueueEditState | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [inject, setInject] = useState<{ text: string; nonce: number } | null>(null)
  const cur = useRef<QueueEditState | null>(null)
  cur.current = state
  const apiRef = useRef(api)
  apiRef.current = api
  const toComposer = (text: string): void => setInject((p) => ({ text, nonce: (p?.nonce ?? 0) + 1 }))
  const apply = (step: QueueEditStep): void => { setState(step.next); if (step.notice !== null) setNotice(step.notice) }
  // Ушли с сессии или закрыли окно — очередь не ждёт брошенной правки (и той, что ещё берётся: `alive`).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; const st = cur.current; if (st) apiRef.current?.release(st.id) }
  }, [])
  // Срок удержания у демона — тот же, что он назвал; вышел — правка закрыта, исправленное — в поле ввода.
  const holdKey = state ? `${state.id}:${state.holdMs}` : null
  useEffect(() => {
    if (!holdKey || !cur.current) return
    const t = window.setTimeout(() => {
      const st = cur.current
      if (st && apiRef.current) apply(expireQueueEdit(st, { release: apiRef.current.release, toComposer }))
    }, cur.current.holdMs)
    return () => window.clearTimeout(t)
  }, [holdKey])
  // Заметка («уже ушла», «время вышло») гаснет сама.
  useEffect(() => {
    if (notice === null) return
    const t = window.setTimeout(() => setNotice(null), 15_000)
    return () => window.clearTimeout(t)
  }, [notice])
  const errorOf = (e: unknown): { code: string | null; text: string } =>
    (isBridgeError(e) ? { code: e.code, text: e.message } : { code: null, text: errorText(e) })
  const view: QueueEditView = {
    state, opening,
    onStart: (id) => {
      if (!api || opening || cur.current) return
      setNotice(null)
      setOpening(id)
      api.hold(id).then((r) => { if (alive.current) setState(startQueueEdit(id, r)); else api.release(id) }, (e: unknown) => {
        // «Изменить» опоздало: реплика ушла или убрана — править нечего, текст человека ещё не тронут.
        const err = errorOf(e)
        setNotice(err.code === 'queue_item_sent' ? 'Реплика уже ушла' : err.code === 'queue_item_removed' ? 'Реплика уже удалена' : err.text)
      }).finally(() => setOpening(null))
    },
    onChange: (text) => setState((st) => (st ? { ...st, text, error: null } : st)),
    onSave: () => {
      const st = cur.current
      if (!api || !st || st.saving) return
      setState({ ...st, saving: true })
      void saveQueueEdit(st, { save: api.save, release: api.release, toComposer, errorOf }).then(apply)
    },
    onCancel: () => {
      const st = cur.current
      // Сохранение в пути — отмена его не обгоняет (иначе очередь ушла бы раньше, чем дошла правка).
      if (!st || st.saving) return
      api?.release(st.id)
      setState(null)
    },
  }
  return { view, notice, inject, edit: state !== null }
}

function Composer({ busy, needsYou, permFocused, link, disabled, sending, error, onSend, agentName, label, filePaths, queueable, inject }: {
  /** В Inbox есть выделенный запрос (любой сессии): ⌘Enter — его «разрешить», а не «прервать и сказать». */
  permFocused: boolean
  busy: boolean; needsYou: boolean; link: ConnState['state']; disabled: boolean; sending: boolean; error: string | null
  /** `agentName` — ключ (смена агента возвращает фокус в поле), `label` — как агент подписан. */
  agentName: string; label: string
  onSend(text: string, mode?: SendMode): Promise<boolean>
  filePaths: FilePathSource | null
  /** Демон знает очередь (О2): во время хода поле не заперто — Enter ставит в очередь, ⌘Enter прерывает. */
  queueable: boolean
  /**
   * Текст из правки очереди, которую не удалось сохранить (реплика ушла или убрана, вышел срок): в поле по
   * правилу M8e — пустое поле получает его как есть, набранное остаётся под ним через пустую строку.
   */
  inject?: { text: string; nonce: number } | null
}): ReactElement {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const injected = inject?.nonce ?? 0
  useEffect(() => {
    if (!inject || !injected) return
    const r = restoreDraft(ta.current?.value ?? '', inject.text)
    setText(r.text)
    requestAnimationFrame(() => { const el = ta.current; if (el && el.value === r.text) { el.focus(); el.setSelectionRange(r.caret, r.caret) } })
    // Только по новому nonce: тот же текст второй раз в поле не встаёт.
  }, [injected])
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(180, el.scrollHeight + 2)}px`
  }, [text])
  // Сессию открыла ссылка pult:// — фокус в поле не ставим: окно всплыло само, а не по воле человека.
  useLayoutEffect(() => { if (takeAutoFocus(agentName, Date.now())) ta.current?.focus() }, [agentName])

  // Идёт ход: со старым демоном поле заперто, как раньше; с очередью — открыто.
  const blocked = (busy && !queueable) || disabled || sending || link !== 'up'
  // С очередью — всегда `queue`: свободную сессию демон и так пустит сразу, а `busy` в окне мог устареть.
  // M8e: поле чистится СРАЗУ — ответ демона приходит, когда ход запущен (страж сети, resume — до секунд), и
  // окно казалось зависшим. Отказ (`updating`, страж, таймаут «прервать и сказать», очередь) — черновик обратно:
  // в пустое поле как был, к набранному за это время — первым, через пустую строку (model/pending.ts).
  const send = async (mode: SendMode = queueable ? 'queue' : 'now'): Promise<void> => {
    if (blocked) return
    await sendFromComposer(text, {
      clear: () => setText(''),
      send: (t) => onSend(t, mode === 'now' ? undefined : mode),
      current: () => ta.current?.value ?? null,
      restore: (next, caret) => {
        setText(next)
        requestAnimationFrame(() => { const el = ta.current; if (el && el.value === next) el.setSelectionRange(caret, caret) })
      },
    })
  }
  // ⌘V на файлах из Finder и перетаскивание кладут в поле пути (model/filePathsInput.ts).
  const { onPaste, onDragOver, onDrop } = useFilePaths({ source: filePaths, box: ta, text, setText })
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter' || e.shiftKey || e.altKey) return
    const cmd = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (!e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      void send()
      return
    }
    // ⌘Enter во время хода — «прервать и сказать» (О2). Дальше окна не идёт: там ⌘Enter — «разрешить
    // выделенный запрос». Без хода, с пустым полем или со старым демоном — горячая клавиша окна, как раньше.
    // Сессия ждёт тебя (разрешение, вопрос, выделенный запрос) — ⌘Enter остаётся «разрешить запрос».
    if (cmd && composerCmdEnter({ busy, needsYou, permFocused, queueable, hasText: text.trim() !== '', blocked }) === 'interrupt') {
      e.preventDefault()
      e.stopPropagation()
      void send('interrupt')
    }
  }
  return (
    <div className="composer">
      <div className="box">
        <textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          onPaste={onPaste} onDragOver={onDragOver} onDrop={onDrop}
          placeholder={placeholderFor({ link, needsYou, busy, disabled, label, queueable })}
          data-testid="composer" aria-label="Реплика в сессию" />
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={blocked || !text.trim()} data-testid="send"
          title={busy && queueable ? `Идёт ход: реплика уйдёт, когда он кончится. ${CMD}Enter — прервать и сказать` : undefined}>
          <Icon name="send" />{busy && queueable ? 'В очередь' : 'Отправить'}
        </button>
      </div>
      {/* Подсказки клавиш — в справке «?» под полем (⌘/); здесь остаётся только ошибка отправки. */}
      {error && <div className="hint"><span className="err" role="alert" data-testid="send-error">{error}</span></div>}
    </div>
  )
}

/**
 * Очередь реплик под полем ввода (О2, как в Cursor): уйдут сами по одной, когда ход кончится `idle`.
 * × убирает, ↑/↓ переставляют, «Изменить» (0.3.2) открывает правку на месте — пока она открыта, очередь на этой
 * реплике стоит. Ход упал, упёрся в лимит или его прервали — очередь стоит до «Продолжить»: следующая реплика
 * могла держаться на результате упавшего хода.
 */
export function QueueList({ queue, paused, onRemove, onMove, onResume, edit, notice }: {
  queue: readonly QueueItem[]; paused: boolean
  onRemove(id: string): void; onMove(id: string, to: number): void; onResume(): void
  /** Правка реплики; нет — старый демон, кнопки «Изменить» нет. */
  edit?: QueueEditView
  /** Заметка над списком: «Реплика уже ушла…», «Время правки вышло…». */
  notice?: string | null
}): ReactElement {
  const st = edit?.state ?? null
  // Правленую реплику убрали из очереди, пока правка открыта, — правка остаётся (там текст человека) последней строкой.
  const orphan = st !== null && !queue.some((it) => it.id === st.id)
  return (
    <div className="queue" data-testid="queue" data-paused={paused ? '1' : '0'}>
      {paused && (
        <div className="queue-paused" role="status" data-testid="queue-paused">
          <Icon name="alert" />
          <span className="grow">Очередь стоит: ход не удался. Реплики ниже не уйдут, пока не скажешь.</span>
          {queue.length > 0 && <button type="button" className="btn btn-sm" onClick={onResume} data-testid="queue-resume">Продолжить</button>}
        </div>
      )}
      {notice ? <div className="queue-notice" role="status" data-testid="queue-notice">{notice}</div> : null}
      {(queue.length > 0 || orphan) && (
        <ol className="queue-list" aria-label="Очередь реплик">
          {queue.map((it, i) => (st && st.id === it.id && edit ? <QueueEditor key={it.id} n={i + 1} st={st} edit={edit} /> : (
            <li key={it.id} className="queue-item" data-testid="queue-item" data-id={it.id}>
              <span className="n mono">{i + 1}</span>
              <span className="txt" title={it.text}>{it.text}</span>
              {edit && (
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Изменить реплику" title="Изменить: очередь подождёт, пока правишь"
                  disabled={st !== null || edit.opening !== null} aria-busy={edit.opening === it.id ? true : undefined}
                  onClick={() => edit.onStart(it.id)} data-testid="queue-edit">Изменить</button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Выше" title="Выше" disabled={i === 0}
                onClick={() => onMove(it.id, i - 1)} data-testid="queue-up">↑</button>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Ниже" title="Ниже" disabled={i === queue.length - 1}
                onClick={() => onMove(it.id, i + 1)} data-testid="queue-down">↓</button>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Убрать из очереди" title="Убрать из очереди"
                onClick={() => onRemove(it.id)} data-testid="queue-remove"><Icon name="x" /></button>
            </li>
          )))}
          {orphan && st && edit ? <QueueEditor key={st.id} n={null} st={st} edit={edit} /> : null}
        </ol>
      )}
    </div>
  )
}

/**
 * Реплика очереди в правке: поле на месте строки, Enter — сохранить, Shift+Enter — новая строка, Esc — отмена
 * (до горячих клавиш окна Esc не доходит — там он «Стоп»). `n: null` — реплики в очереди уже нет.
 */
function QueueEditor({ n, st, edit }: { n: number | null; st: QueueEditState; edit: QueueEditView }): ReactElement {
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(180, el.scrollHeight + 2)}px`
  }, [st.text])
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const k = queueEditKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing })
    if (k === 'save') { e.preventDefault(); edit.onSave() }
    if (k === 'cancel') {
      e.preventDefault()
      e.stopPropagation()
      edit.onCancel()
      document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus()
    }
  }
  return (
    <li className="queue-item queue-item-edit" data-testid="queue-item-edit" data-id={st.id}>
      <span className="n mono">{n ?? '—'}</span>
      <div className="queue-edit-body">
        {/* `readOnly`, а не `disabled`, пока сохраняется: выключенное поле теряет фокус, и Esc ушёл бы в «Стоп». */}
        <textarea ref={ta} rows={1} value={st.text} readOnly={st.saving} onChange={(e) => edit.onChange(e.target.value)} onKeyDown={onKey}
          aria-label="Изменить реплику в очереди" data-testid="queue-edit-text" />
        {n === null && <div className="queue-edit-note">реплики уже нет в очереди — сохранение вернёт текст в поле ввода</div>}
        {st.error && <div className="queue-edit-err" role="alert" data-testid="queue-edit-error">{st.error}</div>}
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={edit.onSave} disabled={st.saving} data-testid="queue-edit-save">Сохранить</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={edit.onCancel} disabled={st.saving} data-testid="queue-edit-cancel">Отмена</button>
    </li>
  )
}
