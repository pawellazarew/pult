// Конверт события и словарь видов — план Ф1 §3.
// Вид события — строковый союз, а не enum: он уезжает в JSON и обратно, и лишний слой
// преобразования только мешает сверять поток глазами.

export type Provider = 'claude' | 'codex' | 'pult'

export const EVENT_KINDS = [
  'session.started',
  'session.ended',
  'message.delta',
  'message.done',
  /**
   * Реплика человека (Ф2, О1): `{text}` — уже отредактированный текст промпта. Появилась ради
   * окна: лента разговора после повторного открытия обязана показать и вопрос, а не только
   * ответ. На статус сессии не влияет (свёртка статусов её пропускает).
   */
  'message.user',
  'tool.called',
  'tool.finished',
  'agent.spawned',
  'agent.finished',
  'permission.requested',
  'permission.resolved',
  'question.asked',
  'usage.updated',
  /**
   * Контекстное окно сессии: `{used, window, model}` — сколько токенов разговор занимает в окне
   * модели после последнего обращения к ней. Только СВОЙ разговор сессии: реплики субагентов
   * (у них своё окно) сюда не идут. `window: null` — размер окна ещё не известен. Шлётся,
   * только когда `used` или `window` изменились. Разбор и слияние — src/sessions/context.ts.
   */
  'context.updated',
  'limit.hit',
  'net.blocked',
  'provider.blocked',
  /**
   * Общий процесс провайдера умер или поднят заново. Отдельный вид, а не `status.changed`,
   * по двум причинам: он про ПРОВАЙДЕРА, а не про сессию (у Codex один app-server на всех),
   * и по нему В5 считает перезапуски прямо из журнала. Появился по ревью В3: смерть
   * ПРОСТАИВАЮЩЕГО процесса не оставляла в журнале ни строчки — между `idle` и следующим
   * `working` не было ничего, и объяснить потерю контекста было нечем.
   */
  'provider.restarted',
  /**
   * Фоновые задачи сессии (07.10.2026): `{count, tasks: [{id, type, description}]}` — дословный
   * список `system/background_tasks_changed` у Claude. Пока он не пуст, процесс сессии живёт и
   * после ответа на реплику: фоновые субагенты доделывают работу, а итог приходит отдельным ходом.
   */
  'background.changed',
  'status.changed',
  /**
   * Сторож тишины (О2, docs/14): ход в `working` давно молчит — `{turnId?, silentForMs}`. Пишет демон,
   * один раз на ход; ход сам не обрывается. Статус сессии не двигает — это вывод о ходе, а не новое
   * состояние. Внимание вида `stalled` (src/sessions/attention.ts): карточка «Похоже, завис» в Inbox.
   */
  'turn.stalled',
  /**
   * Браузер агента (О3, src/mcp/browser.ts): установка Playwright MCP — `{state: started|done|failed,
   * version, error?}` у сессии демона. У сессии — `{state: 'skipped', reason}`: ход пошёл без браузера
   * (не поставился или нет node), лента показывает это заметкой.
   */
  'browser.install',
  /** Attached target, control transfer or setup request; never screen frames or typed text. */
  'runtime.changed',
  /**
   * M8f: модель, усилие или режим подтверждений сессии сменили (`agent.configure`) — `{changes: {model?: {from,
   * to}, effort?, approval?, browser?: 'off'|'on'}, when: 'next_turn'|'after_background'}`. Действует со
   * следующего хода (идущий ход не трогается). Статус не двигает; лента — тихой строкой. `{changes: {}, notice}` —
   * заметка адаптера Claude: ход идёт на прежних настройках или ждёт конца фоновых задач (ревью M8f).
   */
  'session.configured',
  /**
   * Реплику в очереди исправили (`agent.queue.move {text}`) — `{id}`: место и id прежние. Текста нет: реплика
   * очереди попадает в журнал, как и прямая, отредактированным `message.user` в момент отправки. Статус не двигает.
   */
  'queue.updated',
  /**
   * План 16, № 11: правило «Всегда» Codex отозвано (`perm.rules.revoke`, «Настройки» → «Правила „Всегда“») —
   * `{id, kind: execpolicy|network, label, session, at, by}`. Пишется в сессию демона: правило общее на все сессии
   * Codex, `session` — откуда его когда-то разрешили. Строка уже убрана из `default.rules`; ходы не трогаются.
   */
  'rule.revoked',
  'daemon.started',
  'daemon.stopping',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

export interface PultEvent {
  /** Монотонный номер события демона. Переживает рестарт: восстанавливается из журнала. */
  id: number
  ts: string
  sessionId: string
  parentId?: string
  provider: Provider
  kind: EventKind
  data: Record<string, unknown>
}

/** Всё, кроме номера и времени, — их проставляет журнал. */
export interface EventDraft {
  sessionId: string
  parentId?: string
  provider: Provider
  kind: EventKind
  data?: Record<string, unknown>
  ts?: string
}

export function isEventKind(x: unknown): x is EventKind {
  return typeof x === 'string' && (EVENT_KINDS as readonly string[]).includes(x)
}

/** Сессия самого демона: события, которые не принадлежат ни одному агенту. */
export const DAEMON_SESSION = 'daemon'
