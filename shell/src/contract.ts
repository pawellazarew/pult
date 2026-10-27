// Контракт моста `window.pult` (docs/12 §2): то, что видит интерфейс, и белый список методов демона,
// которые main пропускает из окна. Один файл на обе стороны: main и preload реализуют его, ui/
// импортирует ТОЛЬКО типы (import type) — рантайм этого файла в бандл интерфейса не попадает.
//
// Типы протокола берутся из исходников пакета pult (src/), а не переписываются: источник правды
// о конверте события и рукопожатии один.

import type { PultEvent } from '../../src/core/events.js'
import type { DaemonStatus } from '../../src/core/rpc.js'

export type { PultEvent, DaemonStatus }

/** Версия моста. Меняется при несовместимой правке контракта: интерфейс сверяет её на старте. */
export const BRIDGE_VERSION = 1

/**
 * Методы демона, которые окно вправе звать через `call`. Всё прочее main отвергает с кодом
 * `method_not_allowed`, не доходя до демона. Нарочно НЕТ:
 *   - `perm.request` — разрешение просит только заглушка `mcp-ask` под именем живой сессии (инвариант 5);
 *   - `events.emit` — служебный метод тестов, писать в журнал окну незачем;
 *   - `daemon.stop` — только отдельным вызовом моста `stopDaemon()` с подтверждением в системном диалоге.
 */
export const ALLOWED_METHODS = [
  'daemon.status',
  'doctor.run',
  'providers.check',
  'project.list',
  'project.add',
  'project.remove',
  'sessions.external.list',
  'sessions.external.read',
  'agent.import',
  'agent.start',
  'agent.rename',
  'agent.archive',
  'agent.prompt',
  'agent.read',
  'agent.wait',
  'agent.list',
  // О2 «внимание»: отметка «видел» / «непрочитано» и «Повторить» последнюю реплику из карточки ошибки.
  'agent.seen',
  'agent.retry',
  // О2: очередь реплик во время хода — «Продолжить» после неудачи, × и ↑/↓ под полем ввода.
  'agent.queue.resume',
  'agent.queue.remove',
  'agent.queue.move',
  // О3: браузер для агента вкл/выкл (со следующего хода) и свои MCP-серверы владельца — список и выбор.
  'agent.browser',
  'mcp.list',
  'mcp.select',
  'agent.stop',
  'agent.rm',
  'agent.tree',
  // О2 (docs/14 «Поиск, метки, экспорт»): выгрузка сессии в PULT_HOME/exports — ответ путь, не текст.
  'agent.export',
  'perm.list',
  'perm.resolve',
  'events.subscribe',
  'events.unsubscribe',
  'events.tail',
  // Окно на старте и по требованию (0.2.19): снимок вместо доигрывания журнала, лента сессии,
  // полные события раскрытой строки инструмента. Только чтение.
  'events.snapshot',
  'events.history',
  'events.get',
  // О2: поиск ⌘⇧F по разговорам заведённых сессий. Только чтение.
  'events.search',
  'usage.get',
  'provider.reset',
  // M8c, канал обновлений: «Доступна …» (статус есть и в daemon.status), «Проверить», «Обновить» / «Сейчас».
  // `update.apply` ставит только версию из подписанного latest.json, и только новее стоящей (src/update).
  'update.status',
  'update.check',
  'update.apply',
  // M8f: модель, усилие и режим подтверждений живой сессии из подвала (со следующего хода) и «Настройки» (⌘,):
  // `settings.set` пишет только раздел `newSession` config.json — сеть, прокси и команды демон окну не отдаёт.
  'agent.configure',
  'settings.get',
  'settings.set',
] as const

export type AllowedMethod = (typeof ALLOWED_METHODS)[number]

export function isAllowedMethod(m: unknown): m is AllowedMethod {
  return typeof m === 'string' && (ALLOWED_METHODS as readonly string[]).includes(m)
}

/**
 * Методы подписки через `call` окну не нужны — для этого есть `subscribe`, который переживает
 * рестарт демона. Прямой `events.subscribe` через `call` вернул бы номер подписки чужого
 * соединения, кадры которой окну никто не доставит. Поэтому они в белом списке (docs/12 §2),
 * но main отвечает на них отказом `use_subscribe` — честнее, чем молча принять.
 */
export const SUBSCRIBE_VIA_BRIDGE = new Set<string>(['events.subscribe', 'events.unsubscribe'])

/**
 * Поля параметров, которые интерфейс окна не шлёт, а демон принимает и которые РАСШИРЯЮТ права:
 *   - `perm.resolve.updatedInput` — подменил бы вход разрешённого инструмента (разрешили одну
 *     команду, исполнилась другая);
 *   - `agent.start.settingSources` — какие файлы настроек грузит claude (граница доступа CLI).
 * Наименьшие права: main вырезает их до демона. Понадобятся окну — убрать отсюда осознанно.
 */
export const STRIPPED_PARAMS: Readonly<Partial<Record<AllowedMethod, readonly string[]>>> = {
  'perm.resolve': ['updatedInput'],
  'agent.start': ['settingSources'],
}

/** Параметры вызова без вырезанных полей; нечего вырезать — тот же объект. */
export function sanitizeParams(method: AllowedMethod, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const drop = STRIPPED_PARAMS[method]
  if (!params || !drop || !drop.some((k) => k in params)) return params
  const out = { ...params }
  for (const k of drop) delete out[k]
  return out
}

/** CSP окна — дословно docs/12 §2. Тот же текст стоит мета-тегом в ui/index.html (тест сверяет). */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'"

/** Ошибка вызова. Через contextBridge Error теряет всё, кроме message, поэтому отказ — простой объект. */
export interface BridgeError {
  code: string
  message: string
}

/** Состояние связи с демоном, как его видит окно. */
export type ConnState =
  | { state: 'connecting'; attempt: number }
  | { state: 'up'; daemon: { version: string; pid: number; startedAt: string } }
  | { state: 'down'; reason: string; attempt: number; retryInMs: number | null }

/** Вид уведомления — по нему оболочка выбирает звук (shell/src/notifySound.ts). */
export type NotifyKind = 'ask' | 'done' | 'error'

/** Куда вести окно по клику на уведомление. */
export interface NotifyTarget {
  sessionId?: string
  permId?: string
}

/**
 * Заготовка диалога «Новая сессия» по ссылке `pult://new` (docs/14 О3). Поля уже проверены в main
 * (shell/src/pultUrl.ts): реплика не длиннее 10 000 знаков и 200 строк, без невидимых символов,
 * провайдер из белого списка. `path` — только знакомая папка (проект или папка сессии, симлинки
 * раскрыты); чужую main выбрасывает и ставит `pathRejected` — папку человек выбирает сам. Диалог
 * только заполняется — заводит сессию человек.
 */
export interface NewSessionPrefill {
  path?: string
  pathRejected?: boolean
  prompt?: string
  provider?: 'claude' | 'codex'
}

/**
 * Кадр перехода окна: уведомление, строка меню или ссылка `pult://`. `newSession` добавлен в О3 без
 * смены версии моста: старая оболочка его просто не шлёт, старый интерфейс его не читает.
 */
export interface NavTarget extends NotifyTarget {
  newSession?: NewSessionPrefill
  /** Переход пришёл по ссылке `pult://`: окно не ставит фокус в поле ввода и глотает клавиши полсекунды. */
  link?: boolean
}

export interface PultBridge {
  readonly version: number
  /** PULT_TEST=1 у процесса оболочки: интерфейс включает отладочные крючки для e2e. */
  readonly testMode: boolean
  /** Вызов метода демона из белого списка. Отказ — `BridgeError`. */
  call(method: AllowedMethod, params?: Record<string, unknown>): Promise<unknown>
  /**
   * Поток событий с курсора `since` (события с id > since). Переживает рестарт демона: после
   * переподключения main доигрывает пропущенное с последнего доставленного id — без потерь и
   * без повторов. Возвращает отписку.
   */
  subscribe(since: number, onEvent: (ev: PultEvent) => void): () => void
  /** Смена состояния связи; колбэк сразу получает текущее. Возвращает отписку. */
  onConnection(cb: (s: ConnState) => void): () => void
  /** Поднять демона (кнопка «запустить» на плашке «демон недоступен»). */
  startDaemon(): Promise<void>
  /** Остановить демона. main спрашивает подтверждение системным диалогом; отказ человека — `false`. */
  stopDaemon(): Promise<boolean>
  /** Системный выбор папки; `null` — человек передумал. */
  pickFolder(): Promise<string | null>
  /** Показать путь в Finder. */
  revealPath(path: string): Promise<void>
  /**
   * Положить текст в буфер обмена (команды «почини» из doctor). Через main, а не
   * `navigator.clipboard`: окну запрещены все разрешения Chromium, буфер в их числе.
   */
  copyText(text: string): Promise<void>
  /**
   * Уведомление macOS — только пока окно не в фокусе. Клик ведёт окно к `target`. `kind` — звук по виду,
   * `opts.sound: false` — тихо (О2). Старая оболочка лишние аргументы просто не передаёт.
   */
  notify(title: string, body: string, target?: NotifyTarget, kind?: NotifyKind, opts?: { sound?: boolean }): Promise<void>
  /** Клик по уведомлению, пункт строки меню или ссылка `pult://`: куда перейти. Возвращает отписку. */
  onNavigate(cb: (target: NavTarget) => void): () => void
  /**
   * Пути файлов, скопированных в Finder (⌘C на файле): вставка в поле реплики кладёт путь, как в
   * нативных приложениях. Пусто — в буфере не файлы. Необязательный: старая оболочка его не знает.
   */
  clipboardFilePaths?(): Promise<string[]>
  /** Пути перетащенных в окно файлов (`webUtils.getPathForFile`); файл без пути на диске — пропущен. */
  pathsForFiles?(files: File[]): string[]
  /**
   * Открыть ссылку из реплики в системном браузере. Только http(s) и mailto — main проверяет сам
   * (externalUrl.ts), окно ему не указ. Само окно никуда не уходит: навигация по-прежнему режется.
   * Необязательный: старая оболочка его не знает, интерфейс тогда копирует адрес.
   */
  openExternal?(url: string): Promise<void>
  /**
   * Окно 0.1.16: картинка из буфера (скриншот без файла, картинка из браузера) → PNG в
   * `PULT_HOME/attachments/<сессия>/<дата>/paste-<время>-<hex>.png` (shell/src/clipboardImage.ts). Из окна — ТОЛЬКО имя
   * сессии (main проверяет его правилом имён демона): путь выбирает main, байты main читает из системного буфера сам.
   * Своя папка у сессии — claude получает `--add-dir` только на неё. Ответ — путь, который окно вставляет в поле как
   * путь файла, или `{error}` словами. Необязательный: старая оболочка его не знает, интерфейс подсказывает обновить окно.
   */
  clipboardImage?: ClipboardImageBridge
}

/** Ответ `clipboardImage.save()`. */
export type ClipboardImageResult = { path: string; width: number; height: number; bytes: number } | { error: string }

export interface ClipboardImageBridge {
  save(session: string): Promise<ClipboardImageResult>
}

/** Каналы IPC между preload и main. Имена в одном месте: опечатка в строке канала молчит. */
export const IPC = {
  call: 'pult:call',
  subscribe: 'pult:subscribe',
  unsubscribe: 'pult:unsubscribe',
  event: 'pult:event',
  connection: 'pult:connection',
  connectionGet: 'pult:connection-get',
  startDaemon: 'pult:start-daemon',
  stopDaemon: 'pult:stop-daemon',
  pickFolder: 'pult:pick-folder',
  revealPath: 'pult:reveal-path',
  copyText: 'pult:copy-text',
  notify: 'pult:notify',
  clipboardPaths: 'pult:clipboard-paths',
  clipboardImage: 'pult:clipboard-image',
  openExternal: 'pult:open-external',
  navigate: 'pult:navigate',
  testMode: 'pult:test-mode',
} as const

/** Ответ main на `call`: конверт вместо исключения — код ошибки должен доехать до окна целым. */
export type CallReply = { ok: true; result: unknown } | { ok: false; error: BridgeError }
