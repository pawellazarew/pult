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

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PultPaths } from '../core/paths.js'
import { isApprovalMode } from '../adapters/types.js'
import type { ApprovalMode } from '../adapters/types.js'
import { parseSessionContext } from './context.js'
import type { SessionContext } from './context.js'

export type SessionMode = 'turn' | 'warm'
export type SessionProvider = 'claude' | 'codex'

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
  cwd: string
  model?: string
  effort?: string
  mode: SessionMode
  /**
   * `--setting-sources` хода: какие наборы настроек CLI вообще разрешено читать.
   * ХРАНИТСЯ ИМЕННО ЗДЕСЬ, потому что это граница доступа, а не украшение: сессия,
   * заведённая с урезанным набором, после рестарта демона восстанавливалась бы с полным —
   * то есть тише и шире, чем просил человек. На этом же поле стоит мини-сессия Ф5.
   */
  settingSources?: string
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
   * M8f: браузер, который выключила смена режима (Claude `full`, Codex `workspace`/`full` — вызовы шли бы без
   * вопроса). Возврат в режим, где браузер можно, включает его обратно — как было у человека.
   */
  browserSuspended?: SessionBrowser
}

export interface SessionBrowser {
  headed?: boolean
}

/** Поле `browser` из файла или параметров: `true` — без окна, объект — с `headed`; прочее — нет браузера. */
export function parseBrowser(x: unknown): SessionBrowser | null {
  if (x === true) return {}
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return null
  return (x as Record<string, unknown>)['headed'] === true ? { headed: true } : {}
}

export interface QueueItem {
  id: string
  text: string
  /** Когда встала в очередь (ISO). */
  at: string
}

/** Предел очереди одной сессии: дальше — отказ, а не тихий рост sessions.json. */
export const QUEUE_MAX = 20

function parseQueue(x: unknown): QueueItem[] {
  if (!Array.isArray(x)) return []
  const out: QueueItem[] = []
  const ids = new Set<string>()
  for (const it of x) {
    if (it === null || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (typeof o['id'] !== 'string' || !o['id'] || ids.has(o['id'])) continue
    if (typeof o['text'] !== 'string' || !o['text'].trim()) continue
    ids.add(o['id'])
    out.push({ id: o['id'], text: o['text'], at: typeof o['at'] === 'string' ? o['at'] : new Date(0).toISOString() })
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
    if (o['provider'] !== 'claude' && o['provider'] !== 'codex') continue
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
      cwd: o['cwd'],
      ...(typeof o['model'] === 'string' ? { model: o['model'] } : {}),
      ...(typeof o['effort'] === 'string' ? { effort: o['effort'] } : {}),
      mode,
      ...(typeof o['settingSources'] === 'string' ? { settingSources: o['settingSources'] } : {}),
      ...(typeof o['providerSessionId'] === 'string' ? { providerSessionId: o['providerSessionId'] } : {}),
      ...(o['forkOnResume'] === true ? { forkOnResume: true } : {}),
      ...(worktree ? { worktree } : {}),
      ...(o['archived'] === true ? { archived: true } : {}),
      ...(o['autoTitled'] === true ? { autoTitled: true } : {}),
      createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : new Date(0).toISOString(),
      ...(typeof o['lastTurnAt'] === 'string' && Number.isFinite(Date.parse(o['lastTurnAt'])) ? { lastTurnAt: o['lastTurnAt'] } : {}),
      lastStatus: isStatus(o['lastStatus']) ? o['lastStatus'] : 'cold',
      lastEventId: typeof o['lastEventId'] === 'number' && Number.isSafeInteger(o['lastEventId']) ? o['lastEventId'] : 0,
      ...(context ? { context } : {}),
      ...(typeof o['lastSeenEventId'] === 'number' && Number.isSafeInteger(o['lastSeenEventId']) && o['lastSeenEventId'] >= 0
        ? { lastSeenEventId: o['lastSeenEventId'] } : {}),
      ...(o['markedUnread'] === true ? { markedUnread: true } : {}),
      ...((): { queue?: QueueItem[] } => { const q = parseQueue(o['queue']); return q.length ? { queue: q } : {} })(),
      ...(o['queuePaused'] === true ? { queuePaused: true } : {}),
      ...((): { browser?: SessionBrowser } => { const b = parseBrowser(o['browser']); return b ? { browser: b } : {} })(),
      ...((): { browserSuspended?: SessionBrowser } => { const b = parseBrowser(o['browserSuspended']); return b ? { browserSuspended: b } : {} })(),
      // Неизвестный режим из файла (правили руками, файл от демона новее) — САМЫЙ строгий, `read-only` (ревью M8d):
      // гадать в сторону шире нельзя. Поля нет — `ask`, как у всех записей до M8d.
      ...(o['approval'] === undefined || o['approval'] === 'ask' ? {}
        : { approval: isApprovalMode(o['approval']) ? o['approval'] : 'read-only' as const }),
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
  const body = JSON.stringify({ version: 1, sessions: list }, null, 2) + '\n'
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

export function createRegistry(paths: PultPaths): SessionRegistry {
  let list: SessionRecord[]
  try {
    list = parseSessions(JSON.parse(readFileSync(paths.sessions, 'utf8')))
  } catch {
    list = []
  }

  const save = (): void => { writeSessionsAtomic(paths.sessions, list) }
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
      save()
      return true
    },
    update(name, patch) {
      const s = find(name)
      if (!s) return null
      const rec = s as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete rec[k]
        else rec[k] = v
      }
      save()
      return { ...s }
    },
    remove(name) {
      const i = list.findIndex((s) => s.name === name)
      if (i < 0) return false
      list.splice(i, 1)
      save()
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
