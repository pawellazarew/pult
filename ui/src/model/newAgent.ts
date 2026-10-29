import { t as tr } from '../lib/i18n.js'
// Форма «+ Агент» (docs/12 §3 п.5): пресеты модели и усилия, имя из папки, проверка, параметры
// `agent.start`. Чистые функции.

import type { GuardRule } from '../../../src/core/guard.js'
import type { CodexRulesList } from './rules.js'
import type { NewSessionPrefill } from '../../../shell/src/contract.js'
import type { ApprovalMode } from '../../../src/adapters/types.js'
import { CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS_FALLBACK, homeCwdWarning, modeBlocksBrowser } from '../../../src/sessions/settings.js'
import type { LastUsed, NewSessionSettings, ProviderDefaults } from '../../../src/sessions/settings.js'
import type { AgentProvider } from './types.js'
import type { ProviderCatalog } from './types.js'

export function providerPreset(provider: AgentProvider, model: string | null, catalog?: ProviderCatalog | null): ProviderPreset {
  const available = catalog?.[provider].models ?? []
  if (!available.length) return PRESETS[provider]
  const selected = available.find((m) => m.id === model) ?? available.find((m) => m.isDefault) ?? available[0]
  return { models: available.map((m) => m.id), efforts: selected.efforts, defaultModel: selected.id, defaultEffort: selected.defaultEffort }
}

/** То же правило, что у демона (`SESSION_NAME_RE` в src/sessions/registry.ts; тест сверяет). */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

export interface ProviderPreset {
  /** Пусто — модель выбирает сам CLI (у codex так и задумано). */
  models: readonly string[]
  efforts: readonly string[]
  defaultModel: string | null
  defaultEffort: string
}

// Значения — дословно те, что принимает сам CLI (демон их не проверяет и передаёт как есть):
//   claude 2.1.283 — `--model` знает псевдонимы haiku/sonnet/opus/fable, `--effort` —
//     low, medium, high, xhigh, max (`claude --help`);
//   codex 0.158 — уровни объявляет модель (`~/.codex/models_cache.json`): у модели по умолчанию
//     это low…ultra. Модель без `max`/`ultra` откажет на ходу, и отказ будет в ленте.
// Один источник с демоном (src/sessions/settings.ts): смена модели у живой сессии сверяется с теми же пресетами.
export const PRESETS: Readonly<Record<AgentProvider, ProviderPreset>> = {
  claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS, defaultModel: CLAUDE_DEFAULT_MODEL, defaultEffort: CLAUDE_DEFAULT_EFFORT },
  codex: { models: [], efforts: CODEX_EFFORTS_FALLBACK, defaultModel: null, defaultEffort: 'medium' },
}

export interface NewAgentForm {
  provider: AgentProvider
  cwd: string
  name: string
  worktree: string
  model: string | null
  effort: string
  prompt: string
  /** О3: браузер для агента с первого хода. */
  browser: boolean
  /** Окно браузера видно (иначе без окна). Имеет смысл только с `browser`. */
  browserHeaded: boolean
  /** M8d: как подтверждать действия; по умолчанию `ask` — как у всех сессий до M8d. */
  approval: ApprovalMode
  /** M8f: процесс на ход (по умолчанию) или тёплый — из настроек «Новая сессия»; в форме поля нет. */
  mode: 'turn' | 'warm'
}

/** M8d: режимы подтверждений по порядку «тише → шире» и что они значат у каждого провайдера — одной строкой. */
export const APPROVAL_ORDER: readonly ApprovalMode[] = ['read-only', 'ask', 'workspace', 'full']
export const APPROVAL_LABEL: Readonly<Record<ApprovalMode, string>> = {
  'read-only': tr('Только чтение'),
  ask: tr('Спрашивать'),
  workspace: tr('Правки в папке без вопросов'),
  full: tr('Полный доступ'),
}
const APPROVAL_HINT: Readonly<Record<AgentProvider, Record<ApprovalMode, string>>> = {
  claude: {
    'read-only': tr('правки запрещены, каждую команду спросит (manual без Write/Edit)'),
    ask: tr('по твоим настройкам Claude (defaultMode): что он спросит — придёт в Inbox'),
    workspace: tr('правки файлов без вопросов (acceptEdits), команды — через Inbox'),
    full: tr('что угодно без вопросов (bypassPermissions); браузер для агента не включается'),
  },
  codex: {
    'read-only': tr('песочница read-only: читает папку, всё прочее — через Inbox'),
    ask: tr('правит рабочую папку сам, всё шире — через Inbox'),
    workspace: tr('правит рабочую папку без вопросов, шире песочница не пустит — не спрашивая; твои MCP-серверы тоже без вопросов (браузер выключен)'),
    full: tr('что угодно без вопросов, песочницы нет (danger-full-access); твои MCP-серверы тоже без вопросов (браузер выключен)'),
  },
}
/** Подсказка под выбором режима — для провайдера формы. */
export function approvalHint(provider: AgentProvider, mode: ApprovalMode): string {
  return APPROVAL_HINT[provider][mode]
}
/**
 * Подвал разговора: режим словами. У Claude в `ask` флага нет — решают его настройки, и демон присылает действующий
 * `defaultMode` (`claudeMode`): «спрашивать — у Claude по твоим настройкам: auto».
 */
export function approvalFooter(provider: AgentProvider, mode: ApprovalMode, claudeMode?: string): string {
  const label = APPROVAL_LABEL[mode].toLowerCase()
  return provider === 'claude' && mode === 'ask' && claudeMode ? tr`${label} — у Claude по твоим настройкам: ${claudeMode}` : label
}

/** Красное предупреждение у `full` (одинаково у обоих провайдеров). */
export const APPROVAL_FULL_WARNING = tr('агент делает что угодно без вопросов, песочницы нет')

/**
 * Папка — домашняя или выше: `/`, `/Users`, `/home`, `/Users/<имя>`, `/home/<имя>`. Окну домашнюю папку никто не
 * сообщает — угадываем по форме пути, как `shortPath` (model/agents.ts).
 */
export function cwdCoversHome(cwd: string): boolean {
  const p = cwd.replace(/\/+$/, '') || '/'
  return /^(\/|\/Users|\/home|\/Users\/[^/]+|\/home\/[^/]+)$/.test(p)
}

/**
 * Предупреждение (не отказ) в «+ Сессия»: папка — дом или выше, режим шире «Только чтение». С веткой worktree агент
 * живёт в папке worktree, а не здесь, — предупреждать не о чем.
 */
export function homeWarning(form: Pick<NewAgentForm, 'cwd' | 'approval' | 'worktree'>): string | null {
  if (!form.cwd || form.approval === 'read-only' || form.worktree.trim()) return null
  return cwdCoversHome(form.cwd) ? homeCwdWarning() : null
}

/**
 * Режим, при котором браузер для агента не включается (тот же список, что у демона — src/mcp/browser.ts
 * `approvalBrowserRefusal`): Claude `full`; Codex `workspace` и `full` (спрашивать некого).
 */
export function approvalBlocksBrowser(provider: AgentProvider, mode: ApprovalMode): boolean {
  return provider === 'claude' ? mode === 'full' : mode === 'workspace' || mode === 'full'
}

export function defaultForm(provider: AgentProvider = 'claude'): NewAgentForm {
  const p = PRESETS[provider]
  return { provider, cwd: '', name: '', worktree: '', model: p.defaultModel, effort: p.defaultEffort, prompt: '', browser: false, browserHeaded: false, approval: 'ask', mode: 'turn' }
}

/** Ответ `settings.get` (M8f). */
export interface SettingsReply {
  language?: 'auto' | 'ru' | 'en'
  newSession: NewSessionSettings
  lastUsed: LastUsed
  /** Флаг автопроверки обновлений (с 0.3.3); нет — старый демон. */
  updates?: { check: boolean }
  /** Страж сети (с 0.3.6): правило и последние известные выходы провайдеров; нет — старый демон. */
  network?: {
    guard: GuardRule
    exits?: Record<string, { loc?: string | null; path?: string; reason?: string; checkedAt?: string } | undefined>
  }
  /** Правила «Всегда» Codex с меткой Пульта (план 16, № 11); нет — старый демон, раздела нет. */
  codexRules?: CodexRulesList
}

/** Поля провайдера поверх формы: модель, усилие, режим, процесс, браузер, предложенная ветка. */
function applyProviderDefaults(f: NewAgentForm, d: ProviderDefaults | undefined, fromLast: boolean, safe: ProviderDefaults | undefined): NewAgentForm {
  if (!d) return f
  let approval = f.approval
  if (d.approval !== undefined) approval = d.approval
  // `full` из последнего выбора не подставляется НИКОГДА (файл его и не хранит — это вторая линия): умолчание или «спрашивать».
  if (fromLast && (approval as string) === 'full') approval = safe?.approval ?? 'ask'
  const out: NewAgentForm = {
    ...f,
    ...(d.model !== undefined ? { model: d.model } : {}),
    ...(d.effort !== undefined ? { effort: d.effort } : {}),
    approval,
    ...(d.mode !== undefined ? { mode: d.mode } : {}),
    ...(d.browser !== undefined ? { browser: d.browser && !modeBlocksBrowser(f.provider, approval) } : {}),
  }
  return d.worktree !== undefined ? { ...out, worktree: d.worktree && out.name ? `pult/${out.name}` : '' } : out
}

/**
 * M8f: форма «+ Сессия» по слоям — встроенные умолчания < `newSession.defaults` < последний выбор окна (если
 * «Подставлять последний выбор») < явный контекст (папка проекта, ссылка). Реплика не подставляется никогда;
 * папка из последнего выбора — только когда форму открыли без папки. `full` из последнего выбора — никогда.
 */
export function prefillForm(ctx: { cwd?: string | null; prefill?: NewSessionPrefill | null }, settings: SettingsReply | null, taken: readonly string[]): NewAgentForm {
  const ns = settings?.newSession
  const last = ns?.rememberLast ? settings?.lastUsed : undefined
  const explicitProvider = ctx.prefill?.provider
  const provider: AgentProvider = explicitProvider ?? last?.provider ?? ns?.defaults.provider ?? 'claude'
  let f = defaultForm(provider)
  const cwd = ctx.prefill ? (ctx.prefill.pathRejected ? undefined : ctx.prefill.path) : ctx.cwd ?? (last?.cwd || undefined)
  if (cwd) f = { ...f, cwd, name: suggestName(cwd, taken) }
  if (ctx.prefill?.prompt) f = { ...f, prompt: ctx.prefill.prompt }
  const defaults = ns ? (provider === 'codex' ? ns.defaults.codex : ns.defaults.claude) : undefined
  f = applyProviderDefaults(f, defaults, false, undefined)
  if (last) f = applyProviderDefaults(f, provider === 'codex' ? last.codex : last.claude, true, defaults)
  return f
}

// Те же правила, что у main (shell/src/pultUrl.ts): в папке — ни управляющих, ни невидимых символов,
// в реплике — только перевод строки и таб.
const PATH_BAD_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const PROMPT_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u
/** Реплика из ссылки — не длиннее (строки), как в main. */
export const LINK_PROMPT_MAX_LINES = 200

/**
 * Заготовка из ссылки `pult://new` (docs/14 О3) или `null`. Main уже проверил поля и сверил папку с
 * проектами и сессиями (shell/src/pultUrl.ts); здесь — вторая, дешёвая линия: кадр мог прийти от
 * оболочки другой версии. Плохое поле не попадает в форму.
 */
export function linkPrefill(x: unknown): NewSessionPrefill | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  const out: NewSessionPrefill = {}
  const p = o['path']
  if (typeof p === 'string' && p.startsWith('/') && p.length <= 4096 && !PATH_BAD_RE.test(p) && !p.split('/').includes('..')) out.path = p
  if (o['pathRejected'] === true) { out.pathRejected = true; delete out.path }
  const t = o['prompt']
  // 10 000 знаков в main — до 20 000 единиц UTF-16 здесь.
  if (typeof t === 'string' && t.length <= 20_000 && !PROMPT_BAD_RE.test(t) && t.split('\n').length <= LINK_PROMPT_MAX_LINES) out.prompt = t
  const v = o['provider']
  if (v === 'claude' || v === 'codex') out.provider = v
  return out
}

/** Форма по ссылке: провайдер, папка (и имя из неё), первая реплика. Модель, усилие, ветка — по умолчанию. */
export function linkForm(p: NewSessionPrefill, taken: readonly string[]): NewAgentForm {
  const f = defaultForm(p.provider ?? 'claude')
  const path = p.pathRejected ? undefined : p.path
  return { ...f, ...(path ? { cwd: path, name: suggestName(path, taken) } : {}), ...(p.prompt ? { prompt: p.prompt } : {}) }
}

/** Счётчик под репликой из ссылки: сколько в ней строк и знаков — длинный хвост не спрячется за краем поля. */
export function promptStats(text: string): { lines: number; chars: number } {
  return { lines: text ? text.split('\n').length : 0, chars: [...text].length }
}

/** M8f: смена провайдера в форме — его умолчания и последний выбор (тот же порядок слоёв, что у `prefillForm`). */
export function switchProviderPrefill(form: NewAgentForm, provider: AgentProvider, settings: SettingsReply | null): NewAgentForm {
  let f = switchProvider(form, provider)
  const ns = settings?.newSession
  if (!ns) return f
  const defaults = provider === 'codex' ? ns.defaults.codex : ns.defaults.claude
  f = applyProviderDefaults(f, defaults, false, undefined)
  const last = ns.rememberLast ? settings?.lastUsed : undefined
  if (last) f = applyProviderDefaults(f, provider === 'codex' ? last.codex : last.claude, true, defaults)
  return f
}

/** Смена провайдера: модель и усилие — из его пресета, остальное как было. */
export function switchProvider(form: NewAgentForm, provider: AgentProvider): NewAgentForm {
  const p = PRESETS[provider]
  return { ...form, provider, model: p.defaultModel, effort: p.efforts.includes(form.effort) ? form.effort : p.defaultEffort }
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Имя агента из папки: латиница, `[a-z][a-z0-9_-]{0,31}`, свободное (суффикс -2, -3…). */
export function suggestName(folder: string, taken: readonly string[]): string {
  const base = folder.split('/').filter(Boolean).pop() ?? ''
  let s = [...base.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
  s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_0-9]+/, '').replace(/[-_]+$/, '')
  if (!s) s = 'agent'
  s = s.slice(0, 28).replace(/[-_]+$/, '')
  const busy = new Set(taken)
  if (!busy.has(s)) return s
  for (let i = 2; i < 100; i++) {
    const c = `${s}-${i}`
    if (!busy.has(c)) return c
  }
  return `${s.slice(0, 20)}-${Date.now().toString(36).slice(-6)}`
}

/** Папка выбрана (системным диалогом или перетаскиванием): `cwd` и имя из папки, пока имя не трогали руками. */
export function withFolder(form: NewAgentForm, dir: string, nameTouched: boolean, taken: readonly string[]): NewAgentForm {
  return { ...form, cwd: dir, name: nameTouched ? form.name : suggestName(dir, taken) }
}

export type FormErrors = Partial<Record<'name' | 'cwd' | 'worktree' | 'approval', string>>

export function validateForm(form: NewAgentForm, taken: readonly string[]): FormErrors {
  const err: FormErrors = {}
  if (!form.cwd) err.cwd = tr('выбери папку')
  if (!AGENT_NAME_RE.test(form.name)) err.name = tr('латиница, цифры, - и _; с буквы; до 32 знаков')
  else if (taken.includes(form.name)) err.name = tr('такая сессия уже есть')
  const b = form.worktree.trim()
  if (b && (/[\s~^:?*[\\]/.test(b) || b.startsWith('-') || b.includes('..') || b.endsWith('/') || b.endsWith('.lock'))) {
    err.worktree = tr('недопустимое имя ветки git')
  }
  // Демон такой старт всё равно отверг бы — говорим заранее и по-человечески.
  if (form.browser && approvalBlocksBrowser(form.provider, form.approval)) {
    err.approval = tr('в этом режиме браузер для агента не включается — сними галочку браузера или выбери режим тише')
  }
  return err
}

/** Параметры `agent.start` из формы (без пустых полей). */
export function startParams(form: NewAgentForm): Record<string, unknown> {
  const b = form.worktree.trim()
  return {
    name: form.name,
    kind: form.provider,
    cwd: form.cwd,
    ...(form.model ? { model: form.model } : {}),
    ...(form.effort ? { effort: form.effort } : {}),
    ...(b ? { worktree: b } : {}),
    ...(form.browser ? { browser: form.browserHeaded ? { headed: true } : true } : {}),
    // `ask` не шлём: так и старый демон (без M8d) примет параметры, и запись останется без поля.
    ...(form.approval !== 'ask' ? { approval: form.approval } : {}),
    // «Полный доступ» демон заводит только с подтверждением: человек видел красное предупреждение в форме.
    ...(form.approval === 'full' ? { confirm: true } : {}),
    ...(form.mode === 'warm' ? { mode: 'warm' } : {}),
  }
}
