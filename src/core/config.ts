// PULT_HOME/config.json. Единственный источник профиля сети: в логин-шелле владельца
// прокси-переменных нет вообще, он живёт в функции zsh (DELTA v0.4 §4), поэтому «нашли
// прокси в окружении» — не вариант.
// Разбор мягкий: кривое поле заменяется значением по умолчанию и даёт предупреждение,
// демон из-за одной опечатки в конфиге не падает.

import { readFileSync, writeFileSync } from 'node:fs'
import { atomicWrite } from '../service/fsutil.js'
import { defaultNewSession, parseNewSession } from '../sessions/settings.js'
import type { NewSessionSettings } from '../sessions/settings.js'

export type NetMode = 'auto' | 'required' | 'off'
export type ProviderName = 'claude' | 'codex' | 'opencode'

export const PROVIDERS: readonly ProviderName[] = ['claude', 'codex', 'opencode']

export interface NetworkProfile {
  mode: NetMode
  /**
   * URL прокси; используется в режимах auto и required. Пустая строка — прокси нет: тогда режим
   * всегда `off` (это гарантирует `validateConfig`, а `checkNetwork` страхует ещё раз).
   */
  proxy: string
  /**
   * Адреса мимо прокси для ребёнка — добавка к localhost в `NO_PROXY`. Нужна, когда агент ходит
   * в сервисы, которые пускают только с другого выхода (корпоративные JIRA и git за VPN компании).
   * Формат `.domain`: `*.domain` Python и requests не понимают, поэтому разбор переводит его в `.domain`.
   */
  noProxy?: string[]
}

export interface PultConfig {
  version: 1
  network: Record<ProviderName, NetworkProfile>
  /** Консервативный список-страж Пульта, НЕ официальный список Anthropic (DELTA v0.5 §1). */
  guardCountries: string[]
  /** Сколько тёплый процесс (`--warm`) живёт без реплик, потом его снимает жнец. */
  warmTtlMs: number
  /** Сколько брокер ждёт человека, прежде чем ответить ОТКАЗОМ (инвариант 5). */
  permTimeoutMs: number
  /**
   * Тишина перед закрытием процесса, когда фоновых задач уже нет. Измерено 21.09.2026: итог
   * фонового субагента приходит в открытую сессию отдельным ходом через миллисекунды после его
   * конца. Ход человека этой отсрочки не ждёт (07.10.2026): он закрывается по своему ответу.
   */
  subagentGraceMs: number
  /**
   * Сколько процесс Claude живёт ради фоновых задач после ответа на реплику (07.10.2026). Пока
   * задачи идут, процесс не снимается — раньше отсрочка убивала их вместе с работой. Потолок —
   * страховка от вечного фонового процесса.
   */
  backgroundMaxMs: number
  /** Автоназвание сессии по первой реплике (дешёвый запрос к haiku, без него — первые слова). */
  autoTitle: boolean
  /**
   * Правила уведомлений (О2, docs/14 «Правила уведомлений»). Читает окно через `daemon.status`, а
   * `minTurnSeconds` — ещё и `notifyCommand` демона: короткий ход «готово» не шлёт ни туда, ни туда.
   */
  notify: NotifySettings
  /**
   * Своя команда оболочки на каждое событие внимания (готово, упал, вопрос, лимит, страж, завис):
   * `/bin/sh -c`, переменные PULT_SESSION, PULT_TITLE, PULT_KIND, PULT_TEXT. Работает и без окна —
   * например, `curl` в Telegram. `null` — выключено. Так у cmux «Notification Command».
   */
  notifyCommand: string | null
  /** Сторож тишины: ход `working` без единого события столько минут — «похоже, завис». 0 — выключен. */
  watchdog: { silenceMinutes: number }
  /**
   * О3: свои MCP-серверы владельца в сессиях Claude. `servers` — ИМЕНА из `mcpServers` в `~/.claude.json`
   * и `.mcp.json` папки сессии (src/mcp/servers.ts). Набор явный: подключается только названное здесь, и
   * `--strict-mcp-config` остаётся. Пишет `mcp.select` (окно — «MCP-серверы») или руками.
   */
  mcp: { servers: string[] }
  /**
   * M8c, канал обновлений: `check` — демон сам проверяет latest.json (через минуту после старта, потом
   * раз в сутки); `url` — откуда (только https; PULT_UPDATE_URL перебивает). Одна проверка — один GET
   * к GitHub, ничего не ставится без «Обновить» в окне или `pult update`.
   */
  updates: { check: boolean; url: string }
  /**
   * M8f: «+ Сессия» — умолчания по провайдерам и «подставлять последний выбор» (src/sessions/settings.ts).
   * Пишет `settings.set` (окно → «Настройки», ⌘,) — только этот раздел, остальной файл не трогается.
   * `pult agent start` без флагов берёт отсюда умолчания (не последний выбор: скрипты должны быть предсказуемы).
   */
  newSession: NewSessionSettings
}

/** latest.json последнего релиза: GitHub сам ведёт `releases/latest` на свежий не-пререлиз. */
export const DEFAULT_UPDATE_URL = 'https://github.com/pawellazarew/pult/releases/latest/download/latest.json'

export interface NotifySettings {
  /** Конец хода короче этого — без уведомления (порог Ghostty `notify-on-command-finish-after`). */
  minTurnSeconds: number
  /** Звук системного уведомления по виду: вопрос громче, чем «готово». false — тихо. */
  sound: boolean
}

/**
 * Профиль сети по умолчанию — ПРЯМОЙ путь без прокси (M8b, 20.10.2026). Раньше по умолчанию стоял
 * `auto` через локальный смешанный порт прокси владельца (DELTA v0.3): у чужого человека
 * Пульт пробовал бы его порт перед каждым ходом. Страж страны выхода от этого не зависит: он
 * действует и на прямом пути. Свой прокси — `network.<провайдер>.proxy` в config.json (README).
 */
export const DEFAULT_NETWORK_PROFILE: Readonly<NetworkProfile> = { mode: 'off', proxy: '' }
export const DEFAULT_GUARD_COUNTRIES = ['RU', 'BY', 'CN', 'IR', 'KP', 'SY', 'CU']
// 20 минут: спайк S1 показал живой процесс и тёплый серверный кэш и через час, так что
// держать дольше нет смысла — выигрыш тёплой сессии всего 1–2 с на реплику (DELTA v0.5 §3).
export const DEFAULT_WARM_TTL_MS = 1_200_000
export const DEFAULT_PERM_TIMEOUT_MS = 600_000
export const DEFAULT_SUBAGENT_GRACE_MS = 30_000
export const DEFAULT_BACKGROUND_MAX_MS = 3 * 3_600_000
export const DEFAULT_NOTIFY_MIN_TURN_SECONDS = 20
export const DEFAULT_SILENCE_MINUTES = 10
/**
 * Имя MCP-сервера, которое Пульт принимает в `mcp.servers`. Шире имён сессий (в `~/.claude.json` бывают
 * заглавные и точки), но без пробелов и управляющих: имя уходит ключом в `--mcp-config` и в префикс
 * инструментов `mcp__<имя>__…`.
 */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** Сколько своих серверов можно выбрать: каждый — процесс на каждый ход сессии. */
export const MCP_SERVERS_MAX = 32

export function defaultConfig(): PultConfig {
  return {
    version: 1,
    network: {
      claude: { ...DEFAULT_NETWORK_PROFILE },
      codex: { ...DEFAULT_NETWORK_PROFILE },
      opencode: { ...DEFAULT_NETWORK_PROFILE },
    },
    guardCountries: [...DEFAULT_GUARD_COUNTRIES],
    warmTtlMs: DEFAULT_WARM_TTL_MS,
    permTimeoutMs: DEFAULT_PERM_TIMEOUT_MS,
    subagentGraceMs: DEFAULT_SUBAGENT_GRACE_MS,
    backgroundMaxMs: DEFAULT_BACKGROUND_MAX_MS,
    autoTitle: true,
    notify: { minTurnSeconds: DEFAULT_NOTIFY_MIN_TURN_SECONDS, sound: true },
    notifyCommand: null,
    watchdog: { silenceMinutes: DEFAULT_SILENCE_MINUTES },
    mcp: { servers: [] },
    updates: { check: true, url: DEFAULT_UPDATE_URL },
    newSession: defaultNewSession(),
  }
}

/** Список имён серверов из конфига: только годные имена, без повторов, не длиннее предела. null — не список строк. */
export function parseMcpServerNames(x: unknown): string[] | null {
  if (!Array.isArray(x) || !x.every((v) => typeof v === 'string')) return null
  const out: string[] = []
  for (const v of x as string[]) {
    const n = v.trim()
    if (MCP_SERVER_NAME_RE.test(n) && !out.includes(n)) out.push(n)
  }
  return out.slice(0, MCP_SERVERS_MAX)
}

const MODES: readonly string[] = ['auto', 'required', 'off']

export interface LoadedConfig {
  config: PultConfig
  warnings: string[]
  /** false — файла нет, работаем на значениях по умолчанию. */
  fromFile: boolean
}

/**
 * Разбор `network.<провайдер>.noProxy`: список хостов, доменов или подсетей. `*.domain` становится
 * `.domain`; запятые и пробелы внутри записи ломают `NO_PROXY` целиком, такие записи отбрасываются.
 */
export function parseNoProxy(raw: unknown): { entries: string[]; rejected: string[] } {
  if (!Array.isArray(raw)) return { entries: [], rejected: ['не список строк'] }
  const entries: string[] = []
  const rejected: string[] = []
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s || /[\s,]/.test(s)) {
      rejected.push(JSON.stringify(item))
      continue
    }
    const entry = s.startsWith('*.') ? s.slice(1) : s
    if (!entries.includes(entry)) entries.push(entry)
  }
  return { entries, rejected }
}

export function validateConfig(raw: unknown): { config: PultConfig; warnings: string[] } {
  const warnings: string[] = []
  const cfg = defaultConfig()
  if (raw === null || typeof raw !== 'object') {
    warnings.push('config.json: корень не объект — взяты значения по умолчанию')
    return { config: cfg, warnings }
  }
  const o = raw as Record<string, unknown>

  const net = o['network']
  if (net !== undefined) {
    if (net === null || typeof net !== 'object') {
      warnings.push('config.json: network не объект — профиль по умолчанию')
    } else {
      for (const p of PROVIDERS) {
        const entry = (net as Record<string, unknown>)[p]
        if (entry === undefined) continue
        if (entry === null || typeof entry !== 'object') {
          warnings.push(`config.json: network.${p} не объект — профиль по умолчанию`)
          continue
        }
        const e = entry as Record<string, unknown>
        // Сначала прокси: от него зависит, что значит пропущенный или кривой режим.
        const proxy = e['proxy']
        if (typeof proxy === 'string' && proxy.trim()) {
          cfg.network[p].proxy = proxy.trim()
        } else if (proxy !== undefined) {
          warnings.push(`config.json: network.${p}.proxy не непустая строка — прокси нет, прямой путь`)
        }
        const hasProxy = cfg.network[p].proxy !== ''
        const mode = e['mode']
        if (typeof mode === 'string' && MODES.includes(mode)) {
          cfg.network[p].mode = mode as NetMode
        } else {
          // Прокси указан, режим нет — человек хочет прокси: auto (прокси, при его смерти — напрямую).
          cfg.network[p].mode = hasProxy ? 'auto' : 'off'
          if (mode !== undefined) {
            warnings.push(`config.json: network.${p}.mode = ${JSON.stringify(mode)} — не auto|required|off, взят ${cfg.network[p].mode}`)
          }
        }
        if (cfg.network[p].mode !== 'off' && !hasProxy) {
          warnings.push(`config.json: network.${p}.mode = ${cfg.network[p].mode} без proxy — прокси нет, взят off (прямой путь)`)
          cfg.network[p].mode = 'off'
        }
        const noProxy = e['noProxy']
        if (noProxy !== undefined) {
          const parsed = parseNoProxy(noProxy)
          if (parsed.entries.length > 0) cfg.network[p].noProxy = parsed.entries
          for (const bad of parsed.rejected) {
            warnings.push(`config.json: network.${p}.noProxy: ${bad} — пропущено`)
          }
        }
      }
    }
  }

  const guard = o['guardCountries']
  if (guard !== undefined) {
    if (Array.isArray(guard) && guard.every((x) => typeof x === 'string')) {
      cfg.guardCountries = (guard as string[]).map((s) => s.trim().toUpperCase()).filter(Boolean)
    } else {
      warnings.push('config.json: guardCountries не список строк — взят список по умолчанию')
    }
  }

  if (o['autoTitle'] !== undefined) {
    if (typeof o['autoTitle'] === 'boolean') cfg.autoTitle = o['autoTitle']
    else warnings.push('config.json: autoTitle не true/false — взято значение по умолчанию')
  }

  const notify = o['notify']
  if (notify !== undefined) {
    if (notify === null || typeof notify !== 'object' || Array.isArray(notify)) {
      warnings.push('config.json: notify не объект — правила уведомлений по умолчанию')
    } else {
      const n = notify as Record<string, unknown>
      const min = n['minTurnSeconds']
      if (typeof min === 'number' && Number.isFinite(min) && min >= 0) cfg.notify.minTurnSeconds = min
      else if (min !== undefined) warnings.push(`config.json: notify.minTurnSeconds не неотрицательное число — взято ${DEFAULT_NOTIFY_MIN_TURN_SECONDS}`)
      const sound = n['sound']
      if (typeof sound === 'boolean') cfg.notify.sound = sound
      else if (sound !== undefined) warnings.push('config.json: notify.sound не true/false — звук включён')
    }
  }

  const cmd = o['notifyCommand']
  if (cmd !== undefined && cmd !== null) {
    if (typeof cmd === 'string') cfg.notifyCommand = cmd.trim() ? cmd : null
    else warnings.push('config.json: notifyCommand не строка — своя команда уведомлений выключена')
  }

  const wd = o['watchdog']
  if (wd !== undefined) {
    const mins = wd !== null && typeof wd === 'object' && !Array.isArray(wd) ? (wd as Record<string, unknown>)['silenceMinutes'] : null
    if (typeof mins === 'number' && Number.isFinite(mins) && mins >= 0) cfg.watchdog.silenceMinutes = mins
    else if (mins !== undefined) warnings.push(`config.json: watchdog.silenceMinutes не неотрицательное число — взято ${DEFAULT_SILENCE_MINUTES}`)
  }

  const mcp = o['mcp']
  if (mcp !== undefined) {
    const names = mcp !== null && typeof mcp === 'object' && !Array.isArray(mcp) ? parseMcpServerNames((mcp as Record<string, unknown>)['servers']) : null
    const raw = names !== null ? ((mcp as Record<string, unknown>)['servers'] as unknown[]) : null
    if (names === null) warnings.push('config.json: mcp.servers не список строк — свои MCP-серверы не подключаются')
    else {
      cfg.mcp.servers = names
      if (raw && names.length !== raw.length) warnings.push('config.json: mcp.servers — часть имён отброшена (повтор, пусто или недопустимые знаки)')
    }
  }

  const upd = o['updates']
  if (upd !== undefined) {
    if (upd === null || typeof upd !== 'object' || Array.isArray(upd)) {
      warnings.push('config.json: updates не объект — проверка обновлений по умолчанию')
    } else {
      const u = upd as Record<string, unknown>
      if (typeof u['check'] === 'boolean') cfg.updates.check = u['check']
      else if (u['check'] !== undefined) warnings.push('config.json: updates.check не true/false — проверка включена')
      // http-адрес не берём даже по просьбе: latest.json подписан, но тарбол по http можно задержать или
      // подменить на старый подписанный — правило «только https» одно для конфига, окружения и редиректов.
      if (typeof u['url'] === 'string' && /^https:\/\/[^\s]+$/.test(u['url'].trim())) cfg.updates.url = u['url'].trim()
      else if (u['url'] !== undefined) warnings.push(`config.json: updates.url не https-адрес — взят ${DEFAULT_UPDATE_URL}`)
    }
  }

  if (o['newSession'] !== undefined) {
    const ns = parseNewSession(o['newSession'], false)
    cfg.newSession = ns.value
    warnings.push(...ns.warnings)
  }

  for (const key of ['warmTtlMs', 'permTimeoutMs', 'subagentGraceMs', 'backgroundMaxMs'] as const) {
    const v = o[key]
    if (v === undefined) continue
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[key] = v
    else warnings.push(`config.json: ${key} не неотрицательное число — взято значение по умолчанию`)
  }

  return { config: cfg, warnings }
}

export function loadConfig(file: string): LoadedConfig {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { config: defaultConfig(), warnings: [], fromFile: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      config: defaultConfig(),
      warnings: [`config.json не разбирается (${(e as Error).message}) — взяты значения по умолчанию`],
      fromFile: true,
    }
  }
  const { config, warnings } = validateConfig(parsed)
  return { config, warnings, fromFile: true }
}

export function writeConfig(file: string, cfg: PultConfig): void {
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

/**
 * О3, `mcp.select`: записать выбор своих MCP-серверов, НЕ трогая остального в config.json. Файл читается
 * как есть (а не через `validateConfig`): иначе запись выбора заодно переписала бы поля человека
 * значениями по умолчанию и выбросила бы незнакомые ключи. Файла нет — заводится `{mcp: …}`; файл не
 * разбирается — отказ: чинить чужой текст молча нельзя. Запись — tmp + rename, 0600.
 */
export function writeMcpSelection(file: string, servers: readonly string[]): void {
  writeConfigSubtree(file, 'mcp', (prev) => ({ ...prev, servers: [...servers] }), 'выбор серверов не записан')
}

/**
 * M8f, `settings.set`: заменить раздел `newSession` целиком, НЕ трогая остального (сеть, прокси, команды
 * уведомлений окно не пишет никогда). Те же правила, что у выбора MCP-серверов.
 */
export function writeNewSession(file: string, value: NewSessionSettings): void {
  writeConfigSubtree(file, 'newSession', () => JSON.parse(JSON.stringify(value)) as Record<string, unknown>, 'настройки новой сессии не записаны')
}

function writeConfigSubtree(file: string, key: string, next: (prev: Record<string, unknown>) => Record<string, unknown>, what: string): void {
  let raw: Record<string, unknown> = {}
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text !== null && text.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`${file} не разбирается (${(e as Error).message}) — поправь файл руками, ${what}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file}: корень не объект — ${what}`)
    }
    raw = parsed as Record<string, unknown>
  }
  const prev = raw[key] !== null && typeof raw[key] === 'object' && !Array.isArray(raw[key]) ? raw[key] as Record<string, unknown> : {}
  raw[key] = next(prev)
  atomicWrite(file, JSON.stringify(raw, null, 2) + '\n', 0o600)
}
