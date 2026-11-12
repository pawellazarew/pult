// Реестр сессий: PULT_HOME/sessions.json.
//
// ПОЧЕМУ один файл, а не файл на сессию: сессий десятки, а не тысячи, и единственная операция,
// которая должна быть быстрой, — «покажи все». Один файл ещё и делает запись атомарной целиком:
// после `kill -9` посреди сохранения на диске либо старый список, либо новый, но никогда
// половина. Приём тот же, что у любого «журнала с переименованием»: пишем во временный файл
// рядом, fsync, потом rename — rename внутри одного каталога атомарен и на APFS, и на ext4.
//
// ПОЧЕМУ статус хранится, хотя его же считает свёртка событий (sessions/status.ts): свёртка
// отвечает «что происходит ПРЯМО СЕЙЧАС» по потоку, а реестр — «что было, когда демона не
// было». После рестарта демона ни один процесс провайдера не жив, поэтому при старте каждая
// незавершённая сессия становится `cold` (инвариант «без шторма перезапусков»).

import { closeSync, copyFileSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { readMigrationMarker, writeMigrationMarker } from '../core/config.js'
import { isServiceTier } from '../adapters/types.js'
import type { ServiceTier } from '../adapters/types.js'
import type { PromptAttachment } from '../core/promptAttachments.js'
import { isApprovalMode } from '../adapters/types.js'
import type { ApprovalMode } from '../adapters/types.js'
import { parseSessionContext } from './context.js'
import type { SessionContext } from './context.js'

export type SessionMode = 'turn' | 'warm'
export type SessionScope = 'project' | 'general'
export type SessionProvider = 'claude' | 'codex' | 'zcode'

/** Словарь статусов — план Ф1 §3 и §6. Порядок в массиве смысла не несёт. */
export const SESSION_STATUSES = [
  'cold',
  'idle',
  'working',
  'blocked_permission',
  'blocked_question',
  'limited',
  'interrupted',
  'failed',
  'done',
] as const

export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** Статусы, после которых сессия не оживает сама: рестарт демона их не трогает. */
export const ENDED_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['done', 'failed'])

export const SESSION_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

export function isSessionName(x: unknown): x is string {
  return typeof x === 'string' && SESSION_NAME_RE.test(x)
}

/** Предел длины названия — в знаках, не в байтах: «Починить VPN» не должно упираться в кириллицу. */
export const SESSION_TITLE_MAX = 60

/**
 * Название в одну строку: управляющие знаки и переводы строк — в пробел, пробелы схлопнуты.
 * Управляющие — потому что название печатает `pult agent list`: ESC в нём перекрасил бы терминал.
 * Невидимые знаки формата (нулевой ширины, мягкий перенос, управление направлением письма)
 * выбрасываются: из одних таких получалась пустая строка в списке, а U+202E разворачивал
 * остаток фразы «Агент … исчезнет из списка». ZWJ/ZWNJ остаются — на них держатся составные эмодзи.
 * Пустое или без единого видимого знака — `null` («названия нет»). Длину НЕ режет: молча
 * обрезать то, что написал человек, хуже отказа — её проверяет тот, кто принимает название.
 */
export function normalizeTitle(x: unknown): string | null {
  if (typeof x !== 'string') return null
  const s = x
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    // …и «пустые буквы»: заполнители хангыля и пустой шрифт Брайля числятся буквами и символами, а на вид — ничего.
    .replace(/[\u00ad\u061c\u115f\u1160\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2800\u3164\ufeff\uffa0]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(s) ? s : null
}

export function titleLength(title: string): number {
  return [...title].length
}

export interface SessionWorktree {
  /** Папка worktree в PULT_HOME/worktrees/…. */
  path: string
  branch: string
  /** Корень исходного репозитория (реальный путь). */
  repo: string
}

function parseWorktree(x: unknown): SessionWorktree | null {
  if (x === null || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o['path'] !== 'string' || !o['path']) return null
  if (typeof o['branch'] !== 'string' || !o['branch']) return null
  if (typeof o['repo'] !== 'string' || !o['repo']) return null
  return { path: o['path'], branch: o['branch'], repo: o['repo'] }
}

export interface SessionRecord {
  /** Ключ сессии: на нём стоят журнал, брокер разрешений и адаптеры. Не меняется никогда. */
  name: string
  /**
   * Название для людей — свободный текст, меняется когда угодно (`agent.rename`). Именно оно,
   * а не `name`, потому что переименовать ключ значило бы переписать журнал: события прошлых
   * ходов подписаны старым именем. Нет названия — показывается `name`.
   */
  title?: string
  provider: SessionProvider
  /** Отсутствие у старых записей означает проект; general — управляемая нейтральная папка. */
  scope?: SessionScope
  cwd: string
  model?: string
  effort?: string
  serviceTier?: ServiceTier
  /** Rust-owned policy/markers: preserve opaque data on rollback, never execute it here. */
  memory?: unknown
  private?: unknown
  temporary?: unknown
  mode: SessionMode
  /**
   * `--setting-sources` хода: какие наборы настроек CLI вообще разрешено читать.
   * ХРАНИТСЯ ИМЕННО ЗДЕСЬ, потому что это граница доступа, а не украшение: сессия,
   * заведённая с урезанным набором, после рестарта демона восстанавливалась бы с полным —
   * то есть тише и шире, чем просил человек. На этом же поле стоит мини-сессия Ф5.
   */
  settingSources?: string
  /** Rust native input reserved before init: opaque unknown-send evidence, never execution authority. */
  claudeReservedSessionId?: unknown
  /** Rust Route A unknown-send evidence, preserved opaquely on Node rollback. */
  zcodePendingInput?: unknown
  /** Идентификатор сессии на стороне провайдера: у Claude — uuid для `--resume`. */
  providerSessionId?: string
  /** Copy an imported Claude conversation on its first resumed turn. */
  forkOnResume?: boolean
  /**
   * Worktree агента, если он заведён с `--worktree` (docs/08 §6). `cwd` выше уже указывает
   * ВНУТРЬ него, поэтому ленивый resume после рестарта демона попадает в ту же папку без
   * особого случая; само поле нужно `agent list`/`agent read` и `agent rm --worktree`.
   */
  worktree?: SessionWorktree
  /** В архиве: окно прячет сессию из дерева проектов в секцию «Архив». Реплика возвращает её. */
  archived?: boolean
  /**
   * Автоназвание уже пробовали (07.10.2026): по первой реплике сессия без названия получает его
   * сама — один раз. Стёр название руками — оно не вернётся.
   */
  autoTitled?: boolean
  createdAt: string
  /**
   * Быстрый старт, шаг B: `requestId` старта из черновика окна (`agent.start {requestId}`). Связь журнала стартов с ЭТИМ
   * экземпляром сессии: повтор запроса после рестарта демона находит сессию по нему, а не по имени — имя могли удалить
   * и отдать другой сессии (ревью Codex 6, 7).
   */
  startRequest?: string
  /**
   * Начало последнего хода человека (`message.user` из `agent.prompt`: реплика из окна, из очереди или из CLI).
   * По нему окно ставит беседу наверх списка — один раз, в момент старта хода. События хода, субагенты, фон,
   * смена статуса и сторож тишины его не трогают: строка не прыгает, пока идёт ход. Нет поля — ходов ещё не
   * было (или запись старше поля): порядок по `createdAt`.
   */
  lastTurnAt?: string
  lastStatus: SessionStatus
  /** Номер последнего события этой сессии в общем журнале. */
  lastEventId: number
  /**
   * Последнее известное контекстное окно (`context.updated`): чтобы `agent list` показывал его и
   * после рестарта демона. Пишется НЕ на каждое событие, а вместе со сменой статуса (см.
   * `emit` в manager.ts) — лишних fsync-ов от него нет.
   */
  context?: SessionContext
  /**
   * О2 «внимание»: номер события журнала, до которого человек сессию видел (`agent.seen`). Событие
   * внимания с номером больше — «непрочитано» (src/sessions/attention.ts). Хранится в демоне, а не в
   * окне: непрочитанное одинаково видят окно, строка меню, док и CLI.
   */
  lastSeenEventId?: number
  /** Помечена непрочитанной руками (⌥⌘U): держится, пока сессию снова не покажут. */
  markedUnread?: boolean
  /**
   * О2, очередь реплик во время хода (docs/14, как в Cursor): реплики, сказанные, пока шёл ход. Когда ход
   * кончился `idle`, демон сам отправляет следующую. Живёт в реестре, а не в окне: переживает закрытие окна
   * и рестарт демона. Нет поля — очередь пуста.
   */
  queue?: QueueItem[]
  /**
   * Очередь стоит: ход упал, упёрся в лимит или его прервали (или демон перезапустился посреди хода). Сама
   * не тронется — только `agent.queue.resume`: следующая реплика могла держаться на результате упавшего хода.
   */
  queuePaused?: boolean
  /** Rust/Node rollback guard: native delivery has not been confirmed. */
  queueDispatch?: { id: string; at: string }
  /**
   * О3, браузер для агента (src/mcp/browser.ts): Playwright MCP в MCP-конфиге сессии, свой профиль и
   * скачивания в `PULT_HOME/browser/<имя>`. `headed` — окно браузера видно (по умолчанию без окна).
   * Нет поля — браузера нет. Меняется `agent.browser` и действует со следующего хода.
   */
  browser?: SessionBrowser
  /**
   * M8d: как подтверждать действия (src/adapters/types.ts `ApprovalMode`). Граница доступа, как
   * `settingSources`: хранится здесь, чтобы resume после рестарта демона поднимал сессию с ТЕМ ЖЕ режимом,
   * а не тише или шире. Нет поля — `ask` (так жили все сессии до M8d); незнакомое значение — `read-only`. С M8f
   * меняется у живой сессии (`agent.configure`) — со следующего хода.
   */
  approval?: ApprovalMode
  /**
   * Быстрый старт, шаг A: полный доступ этой сессии дан разово из CLI (`--yes`) — согласие окна
   * (`PULT_HOME/consent.json`) ему не нужно. Снимается сменой режима на любой другой. Нет поля — полный доступ
   * живёт только на согласии.
   */
  grant?: 'cli-once'
  /**
   * Шаг A: с чем запущен текущий или последний процесс провайдера (`applied` в спецификации) — уровень из снимка хода
   * и то, что подтвердил сам провайдер (`system/init.permissionMode` у Claude, `sandbox`/`approvalPolicy` ответа
   * `thread/start|resume` у Codex). Нет поля — ни одного хода ещё не было («ожидается»).
   */
  applied?: AppliedAccess
  /**
   * Ревью PR #39, M1: режим, который Claude САМ сказал в `system/init` хода без флага (`inherit`). Прогноз по файлам
   * настроек может ошибиться (MDM-профиль, источник, которого Пульт не читает); сказанное `bypassPermissions` —
   * правда, и без согласия такой чат дальше идёт в «Спрашивать», пока человек не выберет уровень заново.
   */
  inheritSeen?: string
  /**
   * M8f: браузер, который выключила смена режима (Claude `full`, Codex `workspace`/`full` — вызовы шли бы без
   * вопроса). Возврат в режим, где браузер можно, включает его обратно — как было у человека.
   */
  browserSuspended?: SessionBrowser
}

export interface SessionBrowser {
  headed?: boolean
}

/** Шаг A: действующий доступ процесса (см. `SessionRecord.applied`). */
export interface AppliedAccess {
  /** Уровень, с которым процесс запущен (снимок хода после проверки согласия). */
  approval: ApprovalMode
  /** Что сказал провайдер: Claude — `permissionMode`; Codex — `<sandbox.type>/<approvalPolicy>`. `null` — не сказал. */
  reported: string | null
  /** Провайдер подтвердил режим (`reported` пришёл от него), а не только Пульт его отправил. */
  confirmed: boolean
  /** Процесс идёт с полными правами (по ответу провайдера, если он есть; иначе по отправленному). */
  full: boolean
  at: string
}

export function parseApplied(x: unknown): AppliedAccess | null {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  if (!isApprovalMode(o['approval'])) return null
  return {
    approval: o['approval'],
    reported: typeof o['reported'] === 'string' ? o['reported'] : null,
    confirmed: o['confirmed'] === true,
    full: o['full'] === true,
    at: typeof o['at'] === 'string' ? o['at'] : new Date(0).toISOString(),
  }
}

/**
 * Версия файла реестра. 2 — быстрый старт, шаг A: у Claude «Спрашивать» стало явным `--permission-mode manual`, а
 * запись без `approval` теперь значит именно его. Записи Claude из файла версии 1 без `approval` жили «без флага»
 * (действовал `defaultMode` владельца) — миграция переводит их в `inherit`, чтобы поведение идущих чатов не сменилось
 * молча (§5 п. 8 спецификации).
 */
export const SESSIONS_VERSION = 2

/** Поле `browser` из файла или параметров: `true` — без окна, объект — с `headed`; прочее — нет браузера. */
export function parseBrowser(x: unknown): SessionBrowser | null {
  if (x === true) return {}
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return null
  return (x as Record<string, unknown>)['headed'] === true ? { headed: true } : {}
}

export interface QueueItem {
  id: string
  text: string
  attachments?: PromptAttachment[]
  /** Когда встала в очередь (ISO). */
  at: string
}

/** Предел очереди одной сессии: дальше — отказ, а не тихий рост sessions.json. */
export const QUEUE_MAX = 20

function storedAttachments(raw: unknown): PromptAttachment[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 20) return null
  const out: PromptAttachment[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const a = value as Record<string, unknown>
    if (typeof a['path'] !== 'string' || !a['path'].startsWith('/') || a['path'].length > 16384
      || typeof a['name'] !== 'string' || !a['name'] || a['name'].length > 512
      || typeof a['bytes'] !== 'number' || !Number.isSafeInteger(a['bytes']) || a['bytes'] < 0 || a['bytes'] > 25 * 1024 * 1024
      || typeof a['mime'] !== 'string' || !a['mime'] || a['mime'].length > 128 || (a['kind'] !== 'file' && a['kind'] !== 'directory')) return null
    out.push({ path: a['path'], name: a['name'], bytes: a['bytes'], mime: a['mime'], kind: a['kind'] })
  }
  return out
}

function parseQueue(x: unknown): QueueItem[] {
  if (!Array.isArray(x)) return []
  const out: QueueItem[] = []
  const ids = new Set<string>()
  for (const it of x) {
    if (it === null || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (typeof o['id'] !== 'string' || !o['id'] || ids.has(o['id'])) continue
    const attachments = storedAttachments(o['attachments'])
    if (!attachments || typeof o['text'] !== 'string' || (!o['text'].trim() && !attachments.length)) continue
    ids.add(o['id'])
    out.push({ id: o['id'], text: o['text'], ...(attachments.length ? { attachments } : {}), at: typeof o['at'] === 'string' ? o['at'] : new Date(0).toISOString() })
  }
  return out.slice(0, QUEUE_MAX)
}

export interface SessionRegistry {
  list(): SessionRecord[]
  get(name: string): SessionRecord | null
  /** Заводит запись. Отдаёт false, если имя занято. */
  create(rec: SessionRecord): boolean
  /** Поле со значением `undefined` в `patch` УДАЛЯЕТСЯ из записи (так снимается название). */
  update(name: string, patch: Partial<Omit<SessionRecord, 'name'>>): SessionRecord | null
  remove(name: string): boolean
  /** Все незавершённые сессии становятся `cold`. Вызывается один раз при старте демона. */
  coolDown(): number
  /**
   * Разовая миграция О2 при старте демона: записи без `lastSeenEventId` получают `lastId` (последний
   * номер журнала). Иначе после обновления непрочитанной стала бы каждая старая сессия — её последний
   * ход старше любой отметки. Заодно отметка впереди журнала опускается до `lastId`. Отдаёт число
   * исправленных записей.
   */
  seedSeen(lastId: number): number
  /**
   * Разовая миграция порядка бесед при старте демона: записи без `lastTurnAt` получают время от `lookup` (последняя
   * реплика человека в журнале сессии), а без него — `createdAt`. Иначе после обновления «Недавние» встали бы по
   * дате создания, и беседа, заведённая месяц назад, но живая вчера, утонула бы. Пишется сразу, один раз на запись:
   * следующий старт журнал уже не читает. Отдаёт число исправленных записей.
   */
  seedLastTurn(lookup: (rec: SessionRecord) => string | undefined): number
}

function isStatus(x: unknown): x is SessionStatus {
  return typeof x === 'string' && (SESSION_STATUSES as readonly string[]).includes(x)
}

/** Чтение не верит файлу: он мог быть отредактирован руками или обрезан. */
export function parseSessions(raw: unknown): SessionRecord[] {
  if (raw === null || typeof raw !== 'object') return []
  const list = (raw as { sessions?: unknown }).sessions
  if (!Array.isArray(list)) return []
  const out: SessionRecord[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (!isSessionName(o['name'])) continue
    if (o['provider'] !== 'claude' && o['provider'] !== 'codex' && o['provider'] !== 'zcode') continue
    if (typeof o['cwd'] !== 'string' || !o['cwd']) continue
    const mode = o['mode'] === 'warm' ? 'warm' : 'turn'
    const worktree = parseWorktree(o['worktree'])
    const context = parseSessionContext(o['context'])
    // Файл могли править руками: название чистится так же, как на входе, а длинное режется —
    // отказать тут некому.
    const title = normalizeTitle(o['title'])
    out.push({
      name: o['name'],
      ...(title ? { title: [...title].slice(0, SESSION_TITLE_MAX).join('') } : {}),
      provider: o['provider'],
      ...(o['scope'] === 'general' ? { scope: 'general' as const } : {}),
      cwd: o['cwd'],
      ...(typeof o['model'] === 'string' ? { model: o['model'] } : {}),
      ...(typeof o['effort'] === 'string' ? { effort: o['effort'] } : {}),
      ...(o['provider'] === 'codex' && isServiceTier(o['serviceTier']) ? { serviceTier: o['serviceTier'] } : {}),
      mode,
      ...(Object.hasOwn(o, 'memory') ? { memory: o['memory'] } : {}),
      ...(Object.hasOwn(o, 'private') ? { private: o['private'] } : {}),
      ...(Object.hasOwn(o, 'temporary') ? { temporary: o['temporary'] } : {}),
      ...(typeof o['settingSources'] === 'string' ? { settingSources: o['settingSources'] } : {}),
      ...(Object.hasOwn(o, 'claudeReservedSessionId') ? { claudeReservedSessionId: o['claudeReservedSessionId'] } : {}),
      ...(Object.hasOwn(o, 'zcodePendingInput') ? { zcodePendingInput: o['zcodePendingInput'] } : {}),
      ...(typeof o['providerSessionId'] === 'string' ? { providerSessionId: o['providerSessionId'] } : {}),
      ...(o['forkOnResume'] === true ? { forkOnResume: true } : {}),
      ...(worktree ? { worktree } : {}),
      ...(o['archived'] === true ? { archived: true } : {}),
      ...(o['autoTitled'] === true ? { autoTitled: true } : {}),
      createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : new Date(0).toISOString(),
      ...(typeof o['startRequest'] === 'string' && /^[0-9a-f-]{36}$/.test(o['startRequest']) ? { startRequest: o['startRequest'] } : {}),
      ...(typeof o['lastTurnAt'] === 'string' && Number.isFinite(Date.parse(o['lastTurnAt'])) ? { lastTurnAt: o['lastTurnAt'] } : {}),
      lastStatus: (Object.hasOwn(o, 'claudeReservedSessionId') || Object.hasOwn(o, 'zcodePendingInput')) ? 'failed' : isStatus(o['lastStatus']) ? o['lastStatus'] : 'cold',
      lastEventId: typeof o['lastEventId'] === 'number' && Number.isSafeInteger(o['lastEventId']) ? o['lastEventId'] : 0,
      ...(context ? { context } : {}),
      ...(typeof o['lastSeenEventId'] === 'number' && Number.isSafeInteger(o['lastSeenEventId']) && o['lastSeenEventId'] >= 0
        ? { lastSeenEventId: o['lastSeenEventId'] } : {}),
      ...(o['markedUnread'] === true ? { markedUnread: true } : {}),
      ...((): { queue?: QueueItem[] } => { const q = parseQueue(o['queue']); return q.length ? { queue: q } : {} })(),
      ...(o['queuePaused'] === true || Object.hasOwn(o, 'claudeReservedSessionId') || Object.hasOwn(o, 'zcodePendingInput') ? { queuePaused: true } : {}),
      ...((): { queueDispatch?: { id: string; at: string }; queuePaused?: boolean } => {
        const m = o['queueDispatch'] as Record<string, unknown> | undefined
        return m && typeof m['id'] === 'string' && typeof m['at'] === 'string'
          ? { queueDispatch: { id: m['id'], at: m['at'] }, queuePaused: true } : {}
      })(),
      ...((): { browser?: SessionBrowser } => { const b = parseBrowser(o['browser']); return b ? { browser: b } : {} })(),
      ...((): { browserSuspended?: SessionBrowser } => { const b = parseBrowser(o['browserSuspended']); return b ? { browserSuspended: b } : {} })(),
      // Неизвестный режим из файла (правили руками, файл от демона новее) — САМЫЙ строгий, `read-only` (ревью M8d):
      // гадать в сторону шире нельзя. Поля нет — `ask`, как у всех записей до M8d.
      ...(o['approval'] === undefined || o['approval'] === 'ask' ? {}
        : { approval: isApprovalMode(o['approval']) ? o['approval'] : 'read-only' as const }),
      ...(o['grant'] === 'cli-once' ? { grant: 'cli-once' as const } : {}),
      ...((): { applied?: AppliedAccess } => { const a = parseApplied(o['applied']); return a ? { applied: a } : {} })(),
      ...(typeof o['inheritSeen'] === 'string' && o['inheritSeen'] ? { inheritSeen: o['inheritSeen'] } : {}),
    })
  }
  return out
}

/**
 * Атомарная запись: временный файл в ТОМ ЖЕ каталоге (rename через границу файловых систем
 * не атомарен), fsync данных, rename, и только после этого временный файл считается отданным.
 * Имя временного файла содержит pid: два демона тут не встречаются (их держит lock), но
 * `pult` и тест в одном каталоге — встречаются.
 */
export function writeSessionsAtomic(file: string, list: SessionRecord[]): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.sessions.${process.pid}.${Date.now()}.tmp`)
  const body = JSON.stringify({ version: SESSIONS_VERSION, sessions: list }, null, 2) + '\n'
  const fd = openSync(tmp, 'w', 0o600)
  try {
    const buf = Buffer.from(body, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* уже нет */ }
    throw e
  }
}

/** Имя маркера миграции уровней доступа в `config.json → migrations` (не `quickStart`: тот — у миграции пресетов). */
export const ACCESS_MIGRATION = 'accessLevels'

/**
 * Шаг A: записи Claude из реестра версии 1 без `approval` → `inherit` (см. `SESSIONS_VERSION`). Отдаёт число
 * исправленных. Файл версии 2 и новее не трогается: там отсутствие поля — уже явный «Спрашивать».
 *
 * `markerAt` (ревью PR #39, M2) — миграция уже была. Файл версии 1 после неё — след отката: прежний демон переписал
 * реестр своей версией. `inherit` тогда получают только записи, заведённые ДО миграции (`createdAt` раньше маркера):
 * у них «без флага» и было поведением. Запись новее маркера — «Спрашивать» нового демона (или сессия прежнего демона
 * после отката) — остаётся явным «Спрашивать»: молча расширять её до `defaultMode` владельца нельзя.
 */
export function migrateLegacyAsk(raw: unknown, list: SessionRecord[], markerAt?: string): number {
  const v = raw !== null && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
  if (typeof v === 'number' && v >= SESSIONS_VERSION) return 0
  const cut = markerAt !== undefined ? Date.parse(markerAt) : null
  let n = 0
  for (const s of list) {
    if (s.provider !== 'claude' || s.approval !== undefined) continue
    if (cut !== null) {
      const at = Date.parse(s.createdAt)
      if (!Number.isFinite(at) || at >= cut) continue
    }
    s.approval = 'inherit'
    n++
  }
  return n
}

export function createRegistry(paths: PultPaths): SessionRegistry {
  let list: SessionRecord[]
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(paths.sessions, 'utf8'))
    list = parseSessions(raw)
  } catch {
    list = []
  }

  const save = (): void => { writeSessionsAtomic(paths.sessions, list) }
  // Миграция — сразу на диск: иначе запись, заведённая до первого сохранения, ушла бы в файл версии 2 рядом с
  // НЕмигрированными старыми, и следующий старт уже не отличил бы их от явного «Спрашивать».
  const v = raw !== null && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
  if (raw !== null && !(typeof v === 'number' && v >= SESSIONS_VERSION)) {
    // Ревью PR #39, M2 (спецификация §5 п. 1–2): копия файла до миграции и маркер в config.json. Копия — одна, первая:
    // она и есть «как было до обновления»; повторные миграции (после отката) её не затирают.
    const marker = readMigrationMarker(paths.config, ACCESS_MIGRATION)
    try { copyFileSync(paths.sessions, `${paths.sessions}.bak-v1`, fsConstants.COPYFILE_EXCL) } catch { /* уже есть или не вышло — миграция не ждёт */ }
    const n = migrateLegacyAsk(raw, list, marker?.at)
    if (!marker) {
      try { writeMigrationMarker(paths.config, ACCESS_MIGRATION, new Date().toISOString()) } catch { /* без маркера следующий старт мигрирует ещё раз — те же записи */ }
    }
    if (n > 0) {
      try { save() } catch { /* не записалось — повторится на следующем старте: файл всё ещё версии 1 */ }
    }
  } else if (raw !== null && !readMigrationMarker(paths.config, ACCESS_MIGRATION)) {
    // Перепроверка ревью (M2): версия 2 без маркера — только у сборок 03e03e8 (не выпускались). Маркер ставится сейчас:
    // записи, заведённые дальше, после отката не станут `inherit`.
    try { writeMigrationMarker(paths.config, ACCESS_MIGRATION, new Date().toISOString()) } catch { /* следующий старт */ }
  }
  const find = (name: string): SessionRecord | undefined => list.find((s) => s.name === name)

  return {
    list: () => list.map((s) => ({ ...s })),
    get: (name) => {
      const s = find(name)
      return s ? { ...s } : null
    },
    create(rec) {
      if (find(rec.name)) return false
      list.push({ ...rec })
      try {
        save()
      } catch (e) {
        // Диск кончился: сессии, которой нет на диске, не должно быть и в памяти — иначе
        // следующий демон её не увидит, а этот будет врать, что она есть.
        const i = list.findIndex((s) => s.name === rec.name)
        if (i >= 0) list.splice(i, 1)
        throw e
      }
      return true
    },
    update(name, patch) {
      const s = find(name)
      if (!s) return null
      const rec = s as unknown as Record<string, unknown>
      // Патч применяется в памяти ДО записи на диск. Если `save` упал (ENOSPC и т.п.), запись
      // обязана вернуться к прежнему виду: иначе «неудачная» смена режима подтверждений
      // (`approval: full` при отказавшем диске) молча действовала бы со следующего хода,
      // хотя человек увидел ошибку (ревью 28.10.2026).
      const prev = new Map<string, { had: boolean; value: unknown }>()
      for (const [k, v] of Object.entries(patch)) {
        prev.set(k, { had: Object.prototype.hasOwnProperty.call(rec, k), value: rec[k] })
        if (v === undefined) delete rec[k]
        else rec[k] = v
      }
      try {
        save()
      } catch (e) {
        for (const [k, old] of prev) {
          if (old.had) rec[k] = old.value
          else delete rec[k]
        }
        throw e
      }
      return { ...s }
    },
    remove(name) {
      const i = list.findIndex((s) => s.name === name)
      if (i < 0) return false
      const [removed] = list.splice(i, 1)
      try {
        save()
      } catch (e) {
        if (removed) list.splice(i, 0, removed)
        throw e
      }
      return true
    },
    coolDown() {
      let n = 0
      for (const s of list) {
        if (ENDED_STATUSES.has(s.lastStatus) || s.lastStatus === 'cold') continue
        s.lastStatus = 'cold'
        n++
      }
      if (n) save()
      return n
    },
    seedLastTurn(lookup) {
      let n = 0
      for (const s of list) {
        if (s.lastTurnAt !== undefined) continue
        const found = lookup({ ...s })
        s.lastTurnAt = found && Number.isFinite(Date.parse(found)) ? found : s.createdAt
        n++
      }
      if (n) save()
      return n
    },
    seedSeen(lastId) {
      let n = 0
      for (const s of list) {
        // Отметка не может быть впереди журнала: журнал обрезали или подменили — иначе всё новое,
        // что придёт до этого номера, считалось бы прочитанным.
        if (s.lastSeenEventId !== undefined && s.lastSeenEventId <= lastId) continue
        s.lastSeenEventId = lastId
        n++
      }
      if (n) save()
      return n
    },
  }
}
