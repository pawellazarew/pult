import { t as tr } from './i18n.js'
// Ссылки `pult://` (docs/14 О3): Raycast, заметки и сообщения открывают окно на сессии или диалог
// новой сессии с заполненными полями. Ссылка приходит снаружи — это недоверенный ввод: всё, что не
// подходит под формат дословно, отвергается целиком, а ссылка `new` только ЗАПОЛНЯЕТ диалог —
// сессию заводит человек кнопкой «Завести». Модуль чистый: тесты — без Electron.
//
//   pult://session/<имя>                                окно на сессии
//   pult://new?path=<папка>&prompt=<текст>&provider=…   диалог «Новая сессия», все параметры необязательны
//
// Папка из ссылки — самое опасное поле: сессия в чужой папке исполняет её хуки и настройки проекта.
// Поэтому её принимают, только если она — уже известная папка (проект или папка живой сессии), после
// раскрытия симлинков с обеих сторон (`matchKnownPath`). Остальное — человек выбирает сам.

import type { NavTarget, NewSessionPrefill } from './contract.js'

export const PULT_SCHEME = 'pult'

/** То же правило, что у демона (`SESSION_NAME_RE` в src/sessions/registry.ts; тест сверяет). */
export const SESSION_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/
/** Первая реплика из ссылки, в знаках (кодовых точках). Длиннее — не задача, а попытка протащить груз. */
export const MAX_PROMPT = 10_000
/** И в строках: длинный хвост ниже края поля человек не увидит. */
export const MAX_PROMPT_LINES = 200
/** PATH_MAX macOS и Linux. */
export const MAX_PATH = 4096
/** Вся ссылка до разбора: 10 000 знаков кириллицы в процентной записи — около 60 000 байт. */
export const MAX_URL_LEN = 128 * 1024
/** Вторая годная ссылка раньше этого — отброшена: серия ссылок подряд — не работа человека. */
export const LINK_GAP_MS = 1500
export const PROVIDERS = ['claude', 'codex'] as const

export type PultLink =
  | { type: 'session'; name: string }
  | ({ type: 'new' } & Pick<NewSessionPrefill, 'path' | 'prompt' | 'provider'>)

/** Разбор с причиной отказа: причину пишем в лог, саму ссылку — нет (в реплике может быть личное). */
export type PultUrlCheck = { ok: true; link: PultLink } | { ok: false; reason: string }

const KNOWN_NEW = ['path', 'prompt', 'provider'] as const

// Сырая ссылка: управляющие C0 и DEL. `new URL` молча выбрасывает табы и переводы строк из середины —
// `ses\nsion` стал бы `session`.
const RAW_CONTROL_RE = /[\u0000-\u001f\u007f]/
// Раскодированные значения: управляющие (C0, DEL, C1), невидимые и форматирующие (U+200B, U+FEFF,
// U+202E — разворот текста), разделители строк и абзацев. В пути они не бывают законно, а глазу
// человека, который смотрит на диалог, показывают не то, что запустится.
const PATH_BAD_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u
// В реплике законны только перевод строки и таб.
const PROMPT_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u

/** Ссылка → цель или причина отказа. Отказ: не строка, длинно, NUL, не `pult:`, логин/порт/якорь, чужой вид, плохой параметр. */
export function checkPultUrl(raw: unknown): PultUrlCheck {
  const no = (reason: string): PultUrlCheck => ({ ok: false, reason })
  if (typeof raw !== 'string' || !raw) return no(tr('не строка'))
  if (raw.length > MAX_URL_LEN) return no(tr('ссылка длиннее предела'))
  if (raw.includes('\0')) return no(tr('NUL в ссылке'))
  if (RAW_CONTROL_RE.test(raw)) return no(tr('управляющий символ в ссылке'))
  let u: URL
  try { u = new URL(raw) } catch { return no(tr('не разбирается как URL')) }
  if (u.protocol !== `${PULT_SCHEME}:`) return no(tr`схема ${u.protocol}`)
  if (u.hash || raw.includes('#')) return no(tr('якорь в ссылке'))
  // `pult:session/x` и `pult:///session/x` — не наш вид: только `pult://<вид>/…`.
  if (!raw.slice(PULT_SCHEME.length + 1).startsWith('//')) return no(tr('нет // после схемы'))
  // Дальше — только сырая строка: URL сворачивает точки (`session/../x` → `/x`), прощает пустой порт
  // (`session:`) и раскодирует `+` в пробел.
  const m = /^([^/?#]*)([^?#]*)(?:\?([^#]*))?$/.exec(raw.slice(PULT_SCHEME.length + 3))
  if (!m) return no(tr('не разбирается как URL'))
  const [, authority = '', rawPath = '', rawQuery = ''] = m
  if (/[:@]/.test(authority)) return no(tr('логин, пароль или порт в ссылке'))
  const kind = authority.toLowerCase()

  if (kind === 'session') {
    // Имя — без процентной записи и без раскодирования: правило имени её и не пропустит.
    const s = /^\/([^/]*)\/?$/.exec(rawPath)
    if (!s || !SESSION_NAME_RE.test(s[1] ?? '')) return no(tr('имя сессии не по правилу'))
    // Параметры у `session` не определены — неизвестное молча пропускаем.
    return { ok: true, link: { type: 'session', name: s[1] as string } }
  }

  if (kind === 'new') {
    if (rawPath !== '' && rawPath !== '/') return no(tr('у new нет пути'))
    const q = parseQuery(rawQuery)
    if (!q) return no(tr('битая процентная запись в параметрах'))
    for (const k of KNOWN_NEW) if ((q.get(k)?.length ?? 0) > 1) return no(tr`параметр ${k} повторён`)
    const one = (k: string): string | null => q.get(k)?.[0] ?? null
    const link: PultLink = { type: 'new' }
    const p = one('path')
    if (p !== null && p !== '') {
      const why = badPath(p)
      if (why) return no(why)
      link.path = p.replace(/\/+$/, '') || '/'
    }
    const t = one('prompt')
    if (t !== null && t !== '') {
      if (PROMPT_BAD_RE.test(t)) return no(tr('управляющий или невидимый символ в prompt'))
      if ([...t].length > MAX_PROMPT) return no(tr`prompt длиннее ${MAX_PROMPT} знаков`)
      if (t.split('\n').length > MAX_PROMPT_LINES) return no(tr`prompt длиннее ${MAX_PROMPT_LINES} строк`)
      link.prompt = t
    }
    const v = one('provider')
    if (v !== null && v !== '') {
      if (!(PROVIDERS as readonly string[]).includes(v)) return no(tr('provider не claude и не codex'))
      link.provider = v as NewSessionPrefill['provider']
    }
    return { ok: true, link }
  }

  return no(tr('неизвестный вид ссылки'))
}

/** Цель или `null` (причина — в `checkPultUrl`). */
export function parsePultUrl(raw: unknown): PultLink | null {
  const r = checkPultUrl(raw)
  return r.ok ? r.link : null
}

/**
 * Параметры запроса без правила форм `+` → пробел: `c++` в реплике остаётся `c++` (пробел в ссылке —
 * `%20`). Битая процентная запись — `null`.
 */
function parseQuery(raw: string): Map<string, string[]> | null {
  const out = new Map<string, string[]>()
  if (!raw) return out
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    let k: string
    let v: string
    try {
      k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq))
      v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1))
    } catch { return null }
    const list = out.get(k)
    if (list) list.push(v)
    else out.set(k, [v])
  }
  return out
}

function badPath(p: string): string | null {
  if (p.length > MAX_PATH) return tr('path длиннее PATH_MAX')
  if (PATH_BAD_RE.test(p)) return tr('управляющий или невидимый символ в path')
  if (!p.startsWith('/')) return tr('path не абсолютный')
  if (p.split('/').includes('..')) return tr('path с ..')
  return null
}

/** Куда вести окно: тот же кадр `navigate`, что и у клика по уведомлению, с пометкой «из ссылки». */
export function linkTarget(link: PultLink): NavTarget {
  if (link.type === 'session') return { sessionId: link.name, link: true }
  const { type: _type, ...prefill } = link
  return { newSession: prefill, link: true }
}

/**
 * Папка из ссылки — только если она уже знакома: равна проекту или папке сессии после раскрытия
 * симлинков с обеих сторон. Возвращает ЗНАКОМЫЙ путь (как его хранит демон), а не путь из ссылки;
 * `null` — папки нет на диске или она чужая. `realpath` — `fs.realpathSync` или `null` на ошибке.
 */
export function matchKnownPath(path: string, known: readonly string[], realpath: (p: string) => string | null): string | null {
  const target = realpath(path)
  if (!target) return null
  for (const k of known) {
    if (typeof k === 'string' && k.startsWith('/') && realpath(k) === target) return k
  }
  return null
}

/** Ссылка из командной строки (Linux: второй экземпляр и холодный старт). Первый аргумент `pult:` или `null`. */
export function linkFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => typeof a === 'string' && a.slice(0, PULT_SCHEME.length + 1).toLowerCase() === `${PULT_SCHEME}:`) ?? null
}

/**
 * Предел частоты: годная ссылка раньше `gapMs` после предыдущей годной — отброшена. Часы любой
 * ссылки, даже отброшенной, сдвигают окно: поток ссылок раз в секунду не пройдёт ни одной.
 */
export class LinkRate {
  private last = -Infinity
  constructor(private readonly gapMs = LINK_GAP_MS) {}
  allow(now: number): boolean {
    const ok = now - this.last >= this.gapMs
    this.last = now
    return ok
  }
}

/**
 * Ссылки, пришедшие до готовности окна (холодный старт: macOS шлёт `open-url` раньше `ready`),
 * держатся до `open()`. Держится одна — последняя: две ссылки за долю секунды до старта — это
 * двойной клик, а не две задачи. Вытесненная и не доставленная (`drop`) — в `onDrop`, для лога.
 */
export class LinkGate<T> {
  private pending: T | null = null
  private isOpen = false
  constructor(private readonly deliver: (t: T) => void, private readonly onDrop: (why: 'overwritten' | 'dropped') => void = () => {}) {}
  offer(t: T): void {
    if (this.isOpen) { this.deliver(t); return }
    if (this.pending !== null) this.onDrop('overwritten')
    this.pending = t
  }
  open(): void {
    this.isOpen = true
    const t = this.pending
    this.pending = null
    if (t !== null) this.deliver(t)
  }
  /** Окно так и не поднялось (boot упал): держимая ссылка потеряна — сказать об этом в лог. */
  drop(): void {
    if (this.pending === null) return
    this.pending = null
    this.onDrop('dropped')
  }
}
