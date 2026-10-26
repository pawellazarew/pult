// Протокол демона, версия 1 (план Ф1 §3). Только типы и коды — ни одной функции с побочным
// эффектом: этот файл в Ф2 импортирует интерфейс, и тащить за ним рантайм не нужно.

import type { PultEvent } from './events.js'

// M8c добавил методы `update.*` и необязательное `daemon.status.update` — версия протокола та же:
// рукопожатие сверяет её строгим равенством, и смена отрезала бы прежние окна и CLI от демона ради
// полей, которые они и так пропускают мимо.
export const PROTOCOL_VERSION = 1

export type ClientKind = 'cli' | 'shell' | 'mcp-ask'

export interface HelloMessage {
  type: 'hello'
  token: string
  client: ClientKind
  protocol: number
}

export interface HelloOk {
  type: 'hello_ok'
  protocol: number
  daemon: { version: string; pid: number; startedAt: string }
}

/** Ошибка уровня соединения (до и вне пары запрос/ответ). */
export interface WireError {
  type: 'error'
  code: HandshakeErrorCode | string
  message?: string
}

export type HandshakeErrorCode =
  | 'bad_token'
  | 'handshake_timeout'
  | 'handshake_required'
  | 'bad_json'
  | 'bad_protocol'
  | 'line_too_long'

export interface RpcRequest {
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface RpcError {
  code: string
  message: string
  data?: unknown
}

export interface RpcOk {
  id: number | string
  result: unknown
}

export interface RpcFail {
  id: number | string
  error: RpcError
}

export type RpcResponse = RpcOk | RpcFail

/** Кадр подписки. `sub` — номер подписки внутри соединения. */
export interface SubscriptionFrame {
  sub: number
  event: PultEvent
}

/** Подписка снята демоном (медленный клиент, остановка демона). */
export interface SubscriptionEnd {
  sub: number
  end: { code: string; message: string }
}

export type ServerFrame = HelloOk | WireError | RpcResponse | SubscriptionFrame | SubscriptionEnd

export const ERROR_CODES = {
  notFound: 'not_found',
  invalidParams: 'invalid_params',
  providerUnavailable: 'provider_unavailable',
  blockedNetwork: 'blocked_network',
  timeout: 'timeout',
  /** Ход отменён стопом до того, как успел начаться (процесса ещё не было). */
  interrupted: 'interrupted',
  notImplemented: 'not_implemented',
  internal: 'internal',
  /** Отказ самого git (`worktree add/remove`): в `message` — его текст, CLI выходит с кодом 1. */
  gitFailed: 'git_failed',
  slowConsumer: 'slow_consumer',
  /** M8c: ставится обновление — новый ход не заводится до рестарта демона. */
  updating: 'updating',
  /**
   * M8f: смена нуждается в явном подтверждении (`agent.configure {confirm: true}`): модель с окном меньше
   * занятого контекста. Окно показывает вопрос, CLI — подсказку `--yes`.
   */
  needsConfirm: 'needs_confirm',
  /** Правка реплики очереди: реплика уже ушла в ход — окно возвращает исправленный текст в поле ввода. */
  queueItemSent: 'queue_item_sent',
  /** Правка реплики очереди: реплику убрали из очереди (или сессии больше нет) — текст тоже в поле ввода. */
  queueItemRemoved: 'queue_item_removed',
  /**
   * 0.3.6: `settings.set {network: {guard, expect}}` — правило стража сменилось снаружи (терминал, другое окно) после
   * того, как окно его прочло: запись отказана, окно перечитывает правило.
   */
  guardChanged: 'guard_changed',
} as const

export interface DaemonStatus {
  version: string
  protocol: number
  pid: number
  startedAt: string
  uptimeMs: number
  home: string
  sock: string
  clients: number
  subscriptions: number
  lastEventId: number
  /**
   * Как поднят демон: `service` — под launchd/systemd (лаунчер выставляет PULT_SERVICE=1 из
   * файла службы), `on-demand` — отсоединённым спавном из CLI. Нужно `pult daemon status` и
   * `pult update`: перезапуск под службой идёт через менеджер служб, а не спавном.
   */
  mode: 'service' | 'on-demand'
  /**
   * Провайдер остановлен целиком (`provider.blocked`, инвариант 3) — снимается `provider.reset`.
   * Появилось в Ф2: окну нужен ответ «сейчас», журнал его не даёт. Необязательное — у старого
   * демона поля нет.
   */
  providers?: Record<'claude' | 'codex', { blocked: boolean; reason?: string }>
  /**
   * Node, на котором работает демон (0.2.18). `alive: false` — бинарь удалён из-под живого
   * процесса (brew upgrade node): macOS не пускает его детей в ~/Desktop, ходы claude там падают
   * с «An unknown error occurred (Unexpected)». `own` — свой node Пульта из PULT_HOME/runtime.
   * Необязательное — у старого демона поля нет.
   */
  node?: DaemonNode
  /**
   * Правила уведомлений окна (О2, `notify` в config.json): порог длительности хода и звук. Необязательное —
   * у старого демона поля нет, окно берёт значения по умолчанию.
   */
  notify?: { minTurnSeconds: number; sound: boolean }
  /**
   * О3, браузер агента: состояние установки Playwright MCP (`missing | installing | installed | failed` с
   * причиной), сколько сессий его включили и найден ли Chrome. Необязательное — у старого демона поля нет.
   */
  browser?: DaemonBrowser
  /**
   * M8c, канал обновлений: что лежит в latest.json, новее ли это, ждёт ли «Обновить» конца ходов. Тот же
   * объект отдаёт `update.status`; здесь он — чтобы окно со старой оболочкой (без `update.*` в белом списке
   * моста) всё равно видело «Доступна …». Необязательное — у старого демона поля нет.
   */
  update?: UpdateStatus
  /**
   * Сколько ходов идёт (или заводится) сейчас — тот же счёт, которым «Обновить» в окне ждёт конца ходов
   * (src/update/checker.ts). `pult update` из CLI отказывает, пока он не 0 (или `--force`). Необязательное —
   * у старого демона поля нет.
   */
  turns?: number
}

/** Релиз из проверенного latest.json — то, что нужно окну и CLI (без адресов скачивания). */
export interface UpdateRelease {
  version: string
  released: string
  /** Страница релиза на GitHub — «Что нового». */
  notes: string
  /** Окно этого релиза и минимальная версия окна, с которой работает пакет. */
  app?: { version: string; minVersion: string }
}

/**
 * «Обновить» в окне: `waiting` — идут ходы, обновление начнётся само, когда они кончатся; `applying` —
 * запущен `pult update` (демон сейчас перезапустится); `failed` — он вышел с ошибкой, демон прежний.
 */
export type UpdateApplyState =
  | { state: 'idle' }
  | { state: 'waiting'; turns: number; since: string; to: string }
  | { state: 'applying'; since: string; to: string }
  | { state: 'failed'; at: string; error: string }

/**
 * Последняя установка из канала не встала (update.json, `action: channel`): проба не прошла и откат
 * (`rolled_back`, `back` — на что вернул) или npm / загрузка (`failed`). Окно показывает её, пока не скрыли.
 */
export interface UpdateFailure {
  to: string
  back: string | null
  at: string
  result: 'rolled_back' | 'failed'
  message: string
  /** Где подробности: logs/update.log (запуск из окна); null — `pult update` шёл в терминале, вывод был там. */
  log: string | null
}

export interface UpdateStatus {
  /** `updates.check` в config.json: демон проверяет сам (через минуту после старта, потом раз в 6 ч). */
  enabled: boolean
  /** Версия этого демона. */
  current: string
  checking: boolean
  checkedAt: string | null
  /** Последняя проверка не удалась — почему (одна строка). Прежний `latest` при этом остаётся. */
  error: string | null
  latest: UpdateRelease | null
  /** Есть что ставить: `latest` новее `current` и не помечен bad. */
  available: boolean
  /** `latest` уже не прошла пробу на этой машине — сама не ставится (`pult update --to <v>` — руками). */
  bad: boolean
  apply: UpdateApplyState
  /** Последняя попытка из канала не встала; null — встала или их не было. */
  failure: UpdateFailure | null
  /** Окно (Pult.app) и его обновление (0.3.4); нет — демон старше. */
  app?: AppUpdateStatus
}

/** Шаг обновления окна — что сейчас делает демон. */
export type AppUpdateStep = 'download' | 'verify' | 'stage' | 'quit' | 'swap' | 'launch' | 'health' | 'rollback'

/** Чем кончилась последняя попытка обновить окно (`app-update.json`). */
export interface AppUpdateAttempt {
  to: string
  /** Версия окна до попытки; null — не прочитана. */
  from: string | null
  at: string
  /**
   * `done` — новое окно поднялось и подключилось; `failed` — прервано ДО замены (окно прежнее, ничего не тронуто,
   * или не восстановлено — см. message); `rolled_back` — новое окно не подключилось, прежнее возвращено и запущено.
   */
  result: 'done' | 'failed' | 'rolled_back'
  message: string
}

/**
 * Окно и его обновление из канала (0.3.4): `update.apply {target: 'app'}`. Только macOS arm64; где нельзя —
 * `unsupported` словами (Linux, не найден Pult.app).
 */
export interface AppUpdateStatus {
  /** Почему окно само не обновляется; null — может. */
  unsupported: string | null
  /** CFBundleShortVersionString поставленного Pult.app; null — не найден. */
  installed: string | null
  /** Где он стоит (/Applications/Pult.app или ~/Applications/Pult.app). */
  path: string | null
  /** `app.version` из последнего подписанного latest.json. */
  latest: string | null
  /** Есть что ставить: latest строго новее installed, не bad, поддерживается. */
  available: boolean
  /** latest уже не встала на этой машине — сама не предлагается. */
  bad: boolean
  /** Идёт обновление окна. */
  applying: { to: string; from: string | null; step: AppUpdateStep; since: string } | null
  last: AppUpdateAttempt | null
  /**
   * Спрашивающее окно — из поставленного бандла (`path`)? false — другое окно (рабочая копия, вторая копия
   * Pult.app): «Обновить окно» в нём не показывается. null — не окно или не известно.
   */
  here?: boolean | null
  /** here === false: бандл спрашивающего окна (его надо закрыть). */
  hereFrom?: string | null
  /**
   * Окно заменено, пока было закрыто: `waiting` — ещё не запускалось; `failed` — первый запуск не заработал за 60 с,
   * можно вернуть прежнее (`update.apply {target: 'app', rollback: true}`).
   */
  firstRun?: { to: string; from: string; state: 'waiting' | 'failed' } | null
}

export interface DaemonBrowser {
  state: 'missing' | 'installing' | 'installed' | 'failed'
  version: string
  error?: string
  /** Сессий с включённым браузером. */
  sessions: number
  chrome: string | null
}

export interface DaemonNode {
  path: string
  version: string
  alive: boolean
  own: boolean
}
