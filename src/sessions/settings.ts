// M8f: настройки сессии после заведения (модель, усилие, режим подтверждений) и настройки «+ Сессия»
// (умолчания и последний выбор). ЧИСТЫЕ функции: их зовут демон (`agent.configure`, `settings.*`), CLI
// (`pult agent set`, умолчания `pult agent start`) и окно (меню подвала, форма, «Настройки») — ответ на
// один и тот же вход обязан быть одним.

import type { ApprovalMode } from '../adapters/types.js'
import { isApprovalMode } from '../adapters/types.js'

export type Provider = 'claude' | 'codex'

/**
 * Пресеты Claude — те, что предлагает форма «+ Сессия» (дословно то, что принимает CLI: `--model` знает
 * псевдонимы haiku/sonnet/opus/fable, `--effort` — low…max; `claude --help` 2.1.283+). Живого списка
 * моделей у Claude нет — сверка смены модели идёт по нему.
 */
export const CLAUDE_MODELS: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_DEFAULT_MODEL = 'sonnet'
export const CLAUDE_DEFAULT_EFFORT = 'medium'
/** Уровни Codex, когда живого списка (`model/list`) нет: модель без `max`/`ultra` откажет на ходу. */
export const CODEX_EFFORTS_FALLBACK: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Имя модели и усилия с входа: без пробелов, управляющих и кавычек — они уходят в argv и в JSON-RPC. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/
export const EFFORT_RE = /^[a-z][a-z0-9-]{0,15}$/

/** Модель в списке выбора: её усилия и усилие по умолчанию. */
export interface ModelChoice {
  id: string
  label?: string
  efforts: readonly string[]
  defaultEffort: string
  isDefault?: boolean
}

export function claudeChoices(): ModelChoice[] {
  return CLAUDE_MODELS.map((id) => ({ id, efforts: CLAUDE_EFFORTS, defaultEffort: CLAUDE_DEFAULT_EFFORT, isDefault: id === CLAUDE_DEFAULT_MODEL }))
}

/** Режимы подтверждений словами — строчными, для строки ленты и CLI. */
export const APPROVAL_WORDS: Readonly<Record<ApprovalMode, string>> = {
  'read-only': 'только чтение',
  ask: 'спрашивать',
  workspace: 'правки в папке без вопросов',
  full: 'полный доступ',
}

/**
 * Папка сессии — домашняя или выше (`/Users`, `/`). Не отказ (PULT_HOME может лежать не в доме, и тогда старт
 * пропустят), а предупреждение в «+ Сессия» и в `pult agent start`: в любом режиме, кроме «Только чтение», агент
 * правит файлы под папкой — а там настройки самих агентов и оболочки.
 */
export const HOME_CWD_WARNING = 'папка — домашняя или выше: агент сможет менять ~/.claude, ~/.codex, ~/.zshrc и др. без вопросов '
  + 'в режимах «Правки в папке без вопросов» и «Полный доступ» (у Codex — и в «Спрашивать»)'

// --- смена модели, усилия и режима у живой сессии -------------------------------------------------

export interface Change<T> { from: T | null; to: T | null }

export interface ConfigureChanges {
  model?: Change<string>
  effort?: Change<string>
  approval?: Change<ApprovalMode>
  /** Браузер для агента выключен режимом (`off`) или возвращён (`on`) — правило О3/M8d. */
  browser?: 'off' | 'on'
}

/** Когда смена вступит в силу: со следующего хода или после фоновых задач тёплого процесса Claude. */
export type ConfigureWhen = 'next_turn' | 'after_background'

export interface ConfigureRequest {
  model?: string
  effort?: string
  approval?: ApprovalMode
  /** Подтверждение: `full` и модель с окном меньше занятого контекста. */
  confirm?: boolean
}

export interface ConfigureTarget {
  provider: Provider
  model?: string
  effort?: string
  approval?: ApprovalMode
  /** Занятый контекст сессии (последний `context.updated`). */
  used?: number | null
}

export class ConfigureError extends Error {
  readonly code: 'invalid_params' | 'needs_confirm'
  constructor(code: 'invalid_params' | 'needs_confirm', message: string) {
    super(message)
    this.code = code
    this.name = 'ConfigureError'
  }
}

/** Токены коротко для отказа и меню: 950 · 48k · 200k · 1M. */
export function tokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  const m = Math.round(n / 100_000) / 10
  return `${String(m).replace('.', ',')}M`
}

/**
 * Окна моделей из прошлых `context.updated` (план 14, камень 2): у Claude размер окна знает только сам CLI,
 * в конце хода. Ключи — и полный id модели из события, и псевдоним сессии (`opus`), если её контекст — этой
 * модели. Свежее значение (по `at`) перебивает старое.
 */
export function modelWindows(entries: ReadonlyArray<{ model?: string | null; context?: { model: string | null; window: number | null; at?: string } | null }>): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = entries.filter((e) => e.context && e.context.window && e.context.window > 0)
    .sort((a, b) => String(a.context?.at ?? '').localeCompare(String(b.context?.at ?? '')))
  for (const e of sorted) {
    const c = e.context as { model: string | null; window: number }
    if (c.model) out.set(c.model, c.window)
    if (e.model && (!c.model || c.model === e.model || c.model.includes(e.model))) out.set(e.model, c.window)
  }
  return out
}

/** «не влезет: 300k > 200k» — или null, если влезает или окно неизвестно. */
export function windowMisfit(used: number | null | undefined, window: number | undefined): string | null {
  if (!used || !window || used <= window) return null
  return `не влезет: ${tokensShort(used)} > ${tokensShort(window)}`
}

/** Модель списка, к которой относится выбор: названная, иначе модель по умолчанию списка. */
function choiceFor(list: readonly ModelChoice[], model: string | null | undefined): ModelChoice | null {
  if (model) return list.find((m) => m.id === model) ?? null
  return list.find((m) => m.isDefault) ?? null
}

/**
 * Проверить смену и посчитать, что на самом деле меняется. `list` — живой список провайдера (у Codex —
 * `model/list`, у Claude — пресеты формы); `null` — списка нет (Codex офлайн): тогда только форма имени.
 * Смена модели без усилия, а нынешнего усилия у новой модели нет, — усилие становится её усилием по
 * умолчанию (это тоже изменение, и лента его покажет). Ничего не меняется — `{}`.
 */
export function planConfigure(cur: ConfigureTarget, req: ConfigureRequest, list: readonly ModelChoice[] | null, windows: ReadonlyMap<string, number>): ConfigureChanges {
  const changes: ConfigureChanges = {}
  if (req.model !== undefined) {
    if (typeof req.model !== 'string' || !MODEL_RE.test(req.model)) throw new ConfigureError('invalid_params', 'модель — непустое имя без пробелов')
    if (list && list.length && req.model !== cur.model && !list.some((m) => m.id === req.model)) {
      throw new ConfigureError('invalid_params', `модели ${req.model} нет у ${cur.provider}: ${list.map((m) => m.id).join(', ')}`)
    }
  }
  if (req.effort !== undefined && (typeof req.effort !== 'string' || !EFFORT_RE.test(req.effort))) {
    throw new ConfigureError('invalid_params', 'усилие — слово латиницей (low, medium, high…)')
  }
  if (req.approval !== undefined && !isApprovalMode(req.approval)) {
    throw new ConfigureError('invalid_params', 'режим подтверждений — read-only | ask | workspace | full')
  }
  const model = req.model ?? cur.model ?? null
  const modelChanged = req.model !== undefined && req.model !== (cur.model ?? null)
  // Усилия целевой модели: из списка; модели нет в списке (своя, заведена из CLI) — любые из списка.
  const choice = list && list.length ? choiceFor(list, model) : null
  const efforts: readonly string[] = choice ? choice.efforts
    : list && list.length ? [...new Set(list.flatMap((m) => m.efforts))]
      : cur.provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS_FALLBACK
  let effort = req.effort
  // Нынешнее усилие при той же модели не спорим (сессию могли завести из CLI с любым); новой модели — только её.
  if (effort !== undefined && efforts.length && !efforts.includes(effort) && (modelChanged || effort !== cur.effort)) {
    throw new ConfigureError('invalid_params', `усилия ${effort} нет у модели ${model ?? 'по умолчанию'}: ${efforts.join(', ')}`)
  }
  if (effort === undefined && modelChanged && cur.effort && choice && !choice.efforts.includes(cur.effort)) effort = choice.defaultEffort
  if (modelChanged) {
    const misfit = windowMisfit(cur.used, model ? windows.get(model) : undefined)
    if (misfit && req.confirm !== true) throw new ConfigureError('needs_confirm', `${misfit} — разговор не поместится в окно модели ${model}; подтверди, если всё равно менять`)
    changes.model = { from: cur.model ?? null, to: model }
  }
  if (effort !== undefined && effort !== (cur.effort ?? null)) changes.effort = { from: cur.effort ?? null, to: effort }
  const approvalNow: ApprovalMode = cur.approval ?? 'ask'
  if (req.approval !== undefined && req.approval !== approvalNow) {
    if (req.approval === 'full' && req.confirm !== true) {
      throw new ConfigureError('invalid_params', 'полный доступ — агент делает что угодно без вопросов, песочницы нет; нужен confirm: true')
    }
    changes.approval = { from: approvalNow, to: req.approval }
  }
  return changes
}

export function hasChanges(c: ConfigureChanges): boolean {
  return c.model !== undefined || c.effort !== undefined || c.approval !== undefined || c.browser !== undefined
}

/** Строка ленты: «модель: opus → sonnet · усилие: high → medium · режим: спрашивать → только чтение — со следующего хода». */
export function describeChanges(c: ConfigureChanges, when: ConfigureWhen = 'next_turn'): string {
  const v = (x: string | null): string => x ?? 'по умолчанию'
  const parts: string[] = []
  if (c.model) parts.push(`модель: ${v(c.model.from)} → ${v(c.model.to)}`)
  if (c.effort) parts.push(`усилие: ${v(c.effort.from)} → ${v(c.effort.to)}`)
  if (c.approval) parts.push(`режим: ${APPROVAL_WORDS[c.approval.from ?? 'ask']} → ${APPROVAL_WORDS[c.approval.to ?? 'ask']}`)
  const tail = when === 'after_background' ? ' — когда доделаются фоновые задачи (процесс Claude ещё жив ради них)' : ' — со следующего хода'
  return parts.length ? `${parts.join(' · ')}${tail}` : ''
}

/** Заметка о браузере после смены режима. */
export function browserNote(c: ConfigureChanges): string | null {
  if (c.browser === 'off') return 'браузер для агента выключен: в этом режиме вызовы браузера шли бы без вопроса'
  if (c.browser === 'on') return 'браузер для агента снова включён — как было до смены режима'
  return null
}

// --- «+ Сессия»: умолчания, последний выбор -------------------------------------------------------

/** Режим подтверждений по умолчанию: `full` сюда не ставится никогда — только явно при заведении. */
export type DefaultApproval = Exclude<ApprovalMode, 'full'>

export interface ProviderDefaults {
  model?: string
  effort?: string
  approval?: DefaultApproval
  mode?: 'turn' | 'warm'
  browser?: boolean
  /** Предлагать ветку worktree в форме (`pult/<имя>`). CLI его не применяет: ветку скрипт называет сам. */
  worktree?: boolean
}

export interface NewSessionSettings {
  /** Подставлять в «+ Сессия» последний выбор окна (иначе — умолчания). */
  rememberLast: boolean
  defaults: { provider?: Provider; claude: ProviderDefaults; codex: ProviderDefaults }
}

/** Последний выбор окна: те же поля плюс папка. `full` не хранится. */
export interface LastUsed {
  provider?: Provider
  claude?: ProviderDefaults
  codex?: ProviderDefaults
  cwd?: string
  at?: string
}

export function defaultNewSession(): NewSessionSettings {
  return { rememberLast: true, defaults: { claude: {}, codex: {} } }
}

const PROVIDER_KEYS = new Set(['model', 'effort', 'approval', 'mode', 'browser', 'worktree'])

/** Блокирует ли режим браузер (тот же список, что `approvalBrowserRefusal` в src/mcp/browser.ts). */
export function modeBlocksBrowser(provider: Provider, mode: ApprovalMode | undefined): boolean {
  return provider === 'claude' ? mode === 'full' : mode === 'workspace' || mode === 'full'
}

function parseProviderDefaults(provider: Provider, x: unknown, path: string, bad: (m: string) => void, strict: boolean): ProviderDefaults {
  if (x === undefined) return {}
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { bad(`${path} — объект`); return {} }
  const o = x as Record<string, unknown>
  const out: ProviderDefaults = {}
  for (const k of Object.keys(o)) if (!PROVIDER_KEYS.has(k)) { if (strict) bad(`${path}.${k} — незнакомое поле`) }
  if (o['model'] !== undefined) {
    if (typeof o['model'] === 'string' && MODEL_RE.test(o['model'])) out.model = o['model']
    else bad(`${path}.model — имя модели без пробелов`)
  }
  if (o['effort'] !== undefined) {
    if (typeof o['effort'] === 'string' && EFFORT_RE.test(o['effort'])) out.effort = o['effort']
    else bad(`${path}.effort — слово латиницей`)
  }
  if (o['approval'] !== undefined) {
    if (o['approval'] === 'full') bad(`${path}.approval — полный доступ по умолчанию не ставится: только явно при заведении`)
    else if (isApprovalMode(o['approval'])) out.approval = o['approval'] as DefaultApproval
    else bad(`${path}.approval — read-only | ask | workspace`)
  }
  if (o['mode'] !== undefined) {
    if (o['mode'] === 'turn' || o['mode'] === 'warm') out.mode = o['mode']
    else bad(`${path}.mode — turn | warm`)
  }
  for (const k of ['browser', 'worktree'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean
    else bad(`${path}.${k} — true | false`)
  }
  if (out.browser && modeBlocksBrowser(provider, out.approval)) {
    bad(`${path}: браузер с режимом «${APPROVAL_WORDS[out.approval ?? 'ask']}» не включается — сними браузер или выбери режим тише`)
    delete out.browser
  }
  return out
}

/**
 * Раздел `newSession` config.json. `strict` (`settings.set` из окна) — любая кривизна = отказ целиком;
 * мягкий (чтение файла) — кривое поле выбрасывается с предупреждением, остальное остаётся.
 */
export function parseNewSession(x: unknown, strict: boolean): { value: NewSessionSettings; warnings: string[] } {
  const warnings: string[] = []
  const bad = (m: string): void => {
    if (strict) throw new ConfigureError('invalid_params', `newSession: ${m}`)
    warnings.push(`config.json: newSession${m.startsWith('.') || m.startsWith(':') ? '' : ' '}${m}`)
  }
  const value = defaultNewSession()
  if (x === undefined) return { value, warnings }
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { bad('— объект'); return { value, warnings } }
  const o = x as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'rememberLast' && k !== 'defaults' && strict) bad(`.${k} — незнакомое поле`)
  if (o['rememberLast'] !== undefined) {
    if (typeof o['rememberLast'] === 'boolean') value.rememberLast = o['rememberLast']
    else bad('.rememberLast — true | false')
  }
  const d = o['defaults']
  if (d !== undefined) {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) bad('.defaults — объект')
    else {
      const dd = d as Record<string, unknown>
      for (const k of Object.keys(dd)) if (k !== 'provider' && k !== 'claude' && k !== 'codex' && strict) bad(`.defaults.${k} — незнакомое поле`)
      if (dd['provider'] !== undefined) {
        if (dd['provider'] === 'claude' || dd['provider'] === 'codex') value.defaults.provider = dd['provider']
        else bad('.defaults.provider — claude | codex')
      }
      value.defaults.claude = parseProviderDefaults('claude', dd['claude'], '.defaults.claude', bad, strict)
      value.defaults.codex = parseProviderDefaults('codex', dd['codex'], '.defaults.codex', bad, strict)
    }
  }
  return { value, warnings }
}

/** Файл последнего выбора: мягко, кривое — пропуск; `full` не читается (и не пишется). */
export function parseLastUsed(x: unknown): LastUsed {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return {}
  const o = x as Record<string, unknown>
  const out: LastUsed = {}
  if (o['provider'] === 'claude' || o['provider'] === 'codex') out.provider = o['provider']
  const soft = (p: Provider): ProviderDefaults | undefined => {
    const v = o[p]
    if (v === undefined) return undefined
    const src = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}
    if (src['approval'] === 'full') delete src['approval']
    try { return parseProviderDefaults(p, src, p, () => { /* мягко */ }, false) } catch { return {} }
  }
  const c = soft('claude'); if (c) out.claude = c
  const x2 = soft('codex'); if (x2) out.codex = x2
  if (typeof o['cwd'] === 'string' && o['cwd'].startsWith('/') && o['cwd'].length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(o['cwd'])) out.cwd = o['cwd']
  if (typeof o['at'] === 'string') out.at = o['at']
  return out
}

/**
 * Последний выбор после `agent.start` из окна: провайдер и его поля (без реплики), папка — только если форма
 * не была открыта с папкой (`rememberCwd`). `full` не запоминается никогда: следующая форма начнётся с
 * умолчания или «спрашивать».
 */
export function nextLastUsed(prev: LastUsed, start: {
  kind: Provider; model?: string; effort?: string; approval?: ApprovalMode; mode?: 'turn' | 'warm'; browser?: boolean; worktree?: boolean; cwd?: string
}, rememberCwd: boolean, at: string): LastUsed {
  const p: ProviderDefaults = {
    ...(start.model && MODEL_RE.test(start.model) ? { model: start.model } : {}),
    ...(start.effort && EFFORT_RE.test(start.effort) ? { effort: start.effort } : {}),
    ...(start.approval && start.approval !== 'full' ? { approval: start.approval } : {}),
    mode: start.mode === 'warm' ? 'warm' : 'turn',
    browser: start.browser === true,
    worktree: start.worktree === true,
  }
  return {
    ...prev,
    provider: start.kind,
    [start.kind]: p,
    ...(rememberCwd && start.cwd ? { cwd: start.cwd } : {}),
    at,
  }
}
