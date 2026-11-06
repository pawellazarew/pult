// Каталог «/»-команд чата: скиллы и команды, которые видят харнесс и модель для провайдера и папки сессии.
// Факты и замеры — docs/19-SPIKE-slash-skills.md. Здесь чистые функции (разбор ответов CLI, фильтр
// неработающих без терминала) и кэш на (провайдер, папка, источники настроек).
//
// Claude: список берётся управляющим запросом `initialize` у `claude -p --input-format stream-json` — без хода
// модели, за 1–3 с, с описаниями и `argumentHint`. Вызов в чате — текстом `/имя аргументы` (скилл, команда,
// встроенная — всё исполняется в stream-json). `system/init` каждого хода приносит только имена — им кэш
// сверяется (новое имя добавляется, пропавшее уходит).
// Codex: `skills/list` у app-server. Вызов — текстом `$имя аргументы`: сервер сам вкладывает тело скилла в ход
// (ИЗМЕРЕНО, codex-cli 0.166: ответ из тела скилла без чтения файла). `/имя` модель понимает лишь догадкой — читает
// SKILL.md через shell. Встроенные «/»-команды TUI Codex через app-server текстом не работают — их нет в списке.

import type { SessionProvider } from '../sessions/registry.js'

export type SlashSource = 'skill' | 'command' | 'plugin' | 'builtin'

export interface SlashCommand {
  /** Имя без префикса: `brainstorming`, `engineering:debug`, `compact`. */
  name: string
  description: string
  /** Подсказка аргументов из CLI (`<PR URL, diff, or file path>`); пустой — нет. */
  argumentHint?: string
  source: SlashSource
  provider: SessionProvider
  /** Что вставить в поле ввода: `/name ` у Claude, `$name ` у Codex. С пробелом в конце. */
  insert: string
}

export interface CommandListing {
  provider: SessionProvider
  cwd: string
  commands: SlashCommand[]
  /** Когда список снят (мс эпохи). */
  at: number
  /** Список не снят: слова для человека (страж сети, CLI не ответил). Тогда `commands` — что было в кэше или пусто. */
  error?: string
}

/**
 * Встроенные команды Claude, которые в чате Пульта не показываются. ИЗМЕРЕНО на CLI 2.1.318 (`-p`, stream-json):
 *   * `clear` (`reset`, `new`) — `conversation_reset` и НОВЫЙ session_id: Пульт возобновлял бы старый разговор;
 *   * `focus` — «isn't available here yet»; `color`, `doctor`, `reload-plugins` — `terminal_slash_commands` из
 *     `system/init`, смысл только в терминале;
 *   * `model`, `effort`, `fast` — «for this session only»: спорят с моделью и усилием из подвала Пульта, а
 *     процесс со следующего хода может смениться; `rename` — имя чата держит Пульт; `output-style` — состояние
 *     процесса, которого Пульт не видит;
 *   * `heapdump` — пишет снимок кучи на Рабочий стол; `auto-mode-setup` — мастер с обязательными флагами;
 *     `usage-credits`, `extra-usage` — настройка оплаты; `__remote-workflow`, `workflow-launch-exec` — только
 *     для сессий, запущенных сервером.
 */
export const CLAUDE_HIDDEN: ReadonlySet<string> = new Set([
  'clear', 'reset', 'new', 'focus', 'color', 'doctor', 'reload-plugins', 'model', 'effort', 'fast', 'rename',
  'output-style', 'heapdump', 'auto-mode-setup', 'usage-credits', 'extra-usage', 'workflow-launch-exec',
])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** Имя годится для «/»-строки: без пробелов и управляющих знаков, не служебное (`__…`), разумной длины. */
export function usableName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && !name.startsWith('__') && /^[^\s/$"'`<>]+$/u.test(name)
}

/** Хвост описания, который CLI дописывает сам: `(project)`, `(user)`, `(claude.ai sync)`, `(dynamic workflow)`. */
const TAIL_MARK = /\s*\((?:project|user|claude\.ai sync|dynamic workflow)\)\s*$/u
/** Голова описания у команд плагина: `(engineering) …`. */
const PLUGIN_HEAD = /^\(([^()]+)\)\s*/u

export function cleanDescription(d: string): string {
  return d.replace(TAIL_MARK, '').replace(PLUGIN_HEAD, '').replace(/\s+/gu, ' ').trim().slice(0, 600)
}

export interface ClaudeClassifyHints {
  /** Имена из `system/init.skills` (если ход уже был). */
  skills?: ReadonlySet<string>
  /** Имена файлов `.claude/commands/**.md` (папка и домашняя), `sub/x.md` → `sub:x`. */
  commandFiles?: ReadonlySet<string>
  /** `system/init.terminal_slash_commands` — тоже скрыть. */
  terminalOnly?: ReadonlySet<string>
}

function classifyClaude(c: Record<string, unknown>, name: string, hints: ClaudeClassifyHints): SlashSource {
  if (c['builtin'] === true) return 'builtin'
  const description = str(c['description'])
  if (hints.commandFiles?.has(name)) return 'command'
  if (name.includes(':') || PLUGIN_HEAD.test(description)) return 'plugin'
  if (hints.skills && !hints.skills.has(name) && !hints.skills.has(`anthropic-skills:${name}`)) return 'command'
  return 'skill'
}

/** Скрыть ли команду Claude в чате Пульта. */
export function claudeHidden(name: string, description: string, terminalOnly?: ReadonlySet<string>): boolean {
  if (!usableName(name) || CLAUDE_HIDDEN.has(name) || terminalOnly?.has(name)) return true
  // CLI держит в списке убранные и переименованные: «(removed) …», «Renamed to /…».
  return /^\(removed\)|^Renamed to /iu.test(description.trim())
}

/** Ответ `initialize` (`response.response.commands`) → строки каталога. Порядок — как у CLI; повторы — первый. */
export function claudeCommandsFromInitialize(response: unknown, hints: ClaudeClassifyHints = {}): SlashCommand[] {
  const r = obj(response)
  const list = Array.isArray(r?.['commands']) ? (r['commands'] as unknown[]) : []
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const c = obj(item)
    if (!c) continue
    const name = str(c['name']).trim()
    const raw = str(c['description'])
    if (seen.has(name) || claudeHidden(name, raw, hints.terminalOnly)) continue
    seen.add(name)
    const hint = str(c['argumentHint']).trim()
    out.push({
      name, description: cleanDescription(raw), ...(hint ? { argumentHint: hint.slice(0, 200) } : {}),
      source: classifyClaude(c, name, hints), provider: 'claude', insert: `/${name} `,
    })
  }
  return out
}

/** Что `system/init` говорит о командах: только имена. */
export interface ClaudeInitCommands {
  slashCommands: readonly string[]
  skills: readonly string[]
  terminalOnly: readonly string[]
}

/**
 * Сверить снятый список с `system/init` хода: имени нет в init — команда ушла (скилл удалили), новое имя — пришло
 * без описания (скилл добавили на диск). `anthropic-skills:x` в init и `x` в `initialize` — одно и то же.
 */
export function reconcileClaudeInit(current: readonly SlashCommand[], init: ClaudeInitCommands): SlashCommand[] {
  const strip = (n: string): string => n.replace(/^anthropic-skills:/u, '')
  const names = new Set(init.slashCommands.map(strip))
  const terminal = new Set(init.terminalOnly)
  const skills = new Set(init.skills.map(strip))
  const kept = current.filter((c) => names.has(c.name) && !terminal.has(c.name))
  const have = new Set(kept.map((c) => c.name))
  for (const raw of init.slashCommands) {
    const name = strip(raw)
    if (have.has(name) || claudeHidden(name, '', terminal)) continue
    have.add(name)
    kept.push({
      name, description: '', provider: 'claude', insert: `/${name} `,
      source: name.includes(':') ? 'plugin' : skills.has(name) ? 'skill' : 'command',
    })
  }
  return kept
}

/** Ответ `skills/list` app-server Codex → строки каталога. Выключенные скиллы (`enabled: false`) не показываются. */
export function codexCommandsFromSkills(response: unknown, cwd?: string): SlashCommand[] {
  const r = obj(response)
  const entries = Array.isArray(r?.['data']) ? (r['data'] as unknown[]) : []
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  // Ответ на один cwd — одна запись; если записей несколько, берётся та, что про нашу папку, иначе все.
  const mine = entries.map(obj).filter((e): e is Record<string, unknown> => e !== null)
  const pick = cwd && mine.some((e) => str(e['cwd']) === cwd) ? mine.filter((e) => str(e['cwd']) === cwd) : mine
  for (const e of pick) {
    for (const item of Array.isArray(e['skills']) ? (e['skills'] as unknown[]) : []) {
      const s = obj(item)
      if (!s || s['enabled'] === false) continue
      const name = str(s['name']).trim()
      if (seen.has(name) || !usableName(name)) continue
      seen.add(name)
      const ui = obj(s['interface'])
      const short = str(ui?.['shortDescription']) || str(s['shortDescription'])
      out.push({
        name,
        description: cleanDescription(short || str(s['description'])),
        source: s['pluginId'] ? 'plugin' : 'skill',
        provider: 'codex',
        insert: `$${name} `,
      })
    }
  }
  return out
}

/** Имена команд из `.claude/commands`: `a.md` → `a`, `sub/b.md` → `sub:b` (как их зовёт CLI). */
export function commandNamesFromFiles(relPaths: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const p of relPaths) {
    if (!p.endsWith('.md')) continue
    out.add(p.slice(0, -3).split('/').filter(Boolean).join(':'))
  }
  return out
}

// --- кэш --------------------------------------------------------------------------------------------------------

export interface CatalogKey { provider: SessionProvider; cwd: string; settingSources?: string }

export interface CommandCatalogOptions {
  /** Снять список заново (`force` — мимо кэша самого провайдера). Бросает — человеку текст ошибки, кэш остаётся. */
  probe(key: CatalogKey, force: boolean): Promise<SlashCommand[]>
  now?: () => number
  /** Сколько список считается свежим. По умолчанию 10 минут: скиллы на диске меняются редко, а `init` сверяет. */
  ttlMs?: number
  /** Сколько папок держать (старые выталкиваются). */
  maxEntries?: number
}

export interface CommandCatalog {
  list(key: CatalogKey, opts?: { force?: boolean }): Promise<CommandListing>
  /** `system/init` хода Claude в этой папке: сверить кэш по именам (без нового снятия). */
  seenClaudeInit(key: CatalogKey, init: ClaudeInitCommands): void
  /** Скиллы на диске сменились (Codex `skills/changed`) — забыть провайдера целиком. */
  invalidate(provider?: SessionProvider): void
}

const keyOf = (k: CatalogKey): string => `${k.provider}\0${k.cwd}\0${k.settingSources ?? ''}`

export function createCommandCatalog(opts: CommandCatalogOptions): CommandCatalog {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? 10 * 60_000
  const max = opts.maxEntries ?? 32
  const cache = new Map<string, { at: number; commands: SlashCommand[] }>()
  const flights = new Map<string, Promise<CommandListing>>()
  const terminal = new Map<string, Set<string>>()
  const put = (k: string, v: { at: number; commands: SlashCommand[] }): void => {
    cache.delete(k)
    cache.set(k, v)
    while (cache.size > max) cache.delete(cache.keys().next().value as string)
  }
  return {
    async list(key, o = {}) {
      const k = keyOf(key)
      const hit = cache.get(k)
      if (hit && !o.force && now() - hit.at < ttl) return { provider: key.provider, cwd: key.cwd, commands: hit.commands, at: hit.at }
      const inflight = flights.get(k)
      if (inflight) return inflight
      const run = (async (): Promise<CommandListing> => {
        try {
          let commands = await opts.probe(key, o.force === true)
          const hide = terminal.get(k)
          if (hide) commands = commands.filter((c) => !hide.has(c.name))
          const at = now()
          put(k, { at, commands })
          return { provider: key.provider, cwd: key.cwd, commands, at }
        } catch (e) {
          const message = (e instanceof Error ? e.message : String(e)).slice(0, 300)
          return { provider: key.provider, cwd: key.cwd, commands: hit?.commands ?? [], at: hit?.at ?? 0, error: message }
        } finally {
          flights.delete(k)
        }
      })()
      flights.set(k, run)
      return run
    },
    seenClaudeInit(key, init) {
      const k = keyOf(key)
      if (init.terminalOnly.length) terminal.set(k, new Set(init.terminalOnly))
      const hit = cache.get(k)
      if (!hit || !init.slashCommands.length) return
      put(k, { at: hit.at, commands: reconcileClaudeInit(hit.commands, init) })
    },
    invalidate(provider) {
      for (const k of [...cache.keys()]) if (!provider || k.startsWith(`${provider}\0`)) cache.delete(k)
    },
  }
}
