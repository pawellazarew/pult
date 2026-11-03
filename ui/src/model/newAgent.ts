import { t as tr } from '../lib/i18n.js'
// Новый чат: списки моделей и усилий провайдеров, уровни доступа словами, заготовка ссылки `pult://new`. Чистые функции.
// Шаг B (design/2026-11-02-quick-start): формы «Новая сессия» больше нет — черновик и его поля в model/draft.ts, имя
// выделяет демон (src/sessions/naming.ts).

import type { GuardRule } from '../../../src/core/guard.js'
import type { CodexRulesList } from './rules.js'
import type { NewSessionPrefill } from '../../../shell/src/contract.js'
import type { ApprovalMode } from '../../../src/adapters/types.js'
import { CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS_FALLBACK } from '../../../src/sessions/settings.js'
import type { LastUsed, NewSessionSettings } from '../../../src/sessions/settings.js'
export { suggestName } from '../../../src/sessions/naming.js'
import type { AgentProvider } from './types.js'
import type { AccessSettings } from './access.js'
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
  // ZCode (маршрут A): у CLI нет флага --model — модель задаёт аккаунт Z.AI, выбора в форме нет.
  zcode: { models: [], efforts: [], defaultModel: null, defaultEffort: '' },
}

/**
 * M8d: режимы подтверждений по порядку «тише → шире» и что они значат у каждого провайдера — одной строкой. Шаг A:
 * пятый уровень `inherit` («Как в настройках Claude») — только у Claude, в меню отдельно, после четырёх.
 */
export const APPROVAL_ORDER: readonly ApprovalMode[] = ['read-only', 'ask', 'workspace', 'full']
/** Уровни провайдера по порядку меню: у Claude — ещё «Как в настройках Claude». */
export function approvalLevels(provider: AgentProvider): readonly ApprovalMode[] {
  return provider === 'claude' ? [...APPROVAL_ORDER, 'inherit'] : APPROVAL_ORDER
}
export const APPROVAL_LABEL: Readonly<Record<ApprovalMode, string>> = {
  'read-only': tr('Только чтение'),
  ask: tr('Спрашивать'),
  workspace: tr('Правки в папке без вопросов'),
  full: tr('Полный доступ'),
  inherit: tr('Как в настройках Claude'),
}
// Шаг A: пояснения сверены с кодом (ревью Codex № 7): Claude — src/adapters/claude/argv.ts, Codex — `codexThreadPolicy`.
// Вопросы приходят в Inbox; без брокера разрешений всё, что спросило бы, получает отказ (инвариант 5).
const APPROVAL_HINT: Readonly<Record<AgentProvider, Record<ApprovalMode, string>>> = {
  claude: {
    'read-only': tr('правки запрещены; любая команда — вопрос в Inbox'),
    ask: tr('правки и команды — вопрос в Inbox; что разрешено твоими правилами Claude — без вопроса'),
    workspace: tr('правки файлов без вопросов; команды — вопрос в Inbox'),
    full: tr('без вопросов и без песочницы, кроме твоих правил ask/deny; браузер для агента не включается'),
    inherit: tr('Пульт режим не задаёт — действует твой defaultMode'),
  },
  codex: {
    'read-only': tr('песочница только на чтение; шаг за неё — вопрос в Inbox'),
    ask: tr('правит папку сам; шаг за песочницу — вопрос в Inbox'),
    workspace: tr('правит папку сам; шаг за песочницу — отказ без вопроса (браузер выключен)'),
    full: tr('песочницы нет, разрешений не просит (danger-full-access; браузер выключен)'),
    // У Codex уровня нет: демон его не примет. Строка — на случай записи, пришедшей от Claude-формы.
    inherit: tr('у Codex такого уровня нет'),
  },
  zcode: {
    'read-only': tr('режим plan: только чтение и планирование, правки недоступны'),
    ask: tr('guarded: безопасное делает сам, опасное отклоняет; вопросов в Inbox не будет — ограничения объяснит в ответе'),
    workspace: tr('правки файлов применяются сами (edit); остальное — по правилам ZCode'),
    full: tr('что угодно без вопросов (yolo); свой режим ZCode не сообщает — метка «не подтверждено»'),
    inherit: tr('у ZCode такого уровня нет'),
  },
}
/**
 * Подсказка под выбором режима — для провайдера формы. У `inherit` — действующий `defaultMode` словами
 * («…: сейчас auto»), если он известен.
 */
export function approvalHint(provider: AgentProvider, mode: ApprovalMode, inheritMode?: string | null): string {
  const base = APPROVAL_HINT[provider][mode]
  return mode === 'inherit' && inheritMode ? tr`${base}: сейчас ${inheritMode}${inheritMode === 'bypassPermissions' ? tr(' — это полный доступ') : ''}` : base
}
/**
 * Подвал разговора: режим словами. У Claude в `inherit` флага нет — решают его настройки, и демон присылает действующий
 * `defaultMode` (`claudeMode`): «как в настройках Claude: auto».
 */
export function approvalFooter(provider: AgentProvider, mode: ApprovalMode, claudeMode?: string): string {
  const label = APPROVAL_LABEL[mode].toLowerCase()
  return provider === 'claude' && mode === 'inherit' && claudeMode ? `${label}: ${claudeMode}` : label
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
 * Режим, при котором браузер для агента не включается (тот же список, что у демона — src/mcp/browser.ts
 * `approvalBrowserRefusal`): Claude `full`; Codex `workspace` и `full` (спрашивать некого).
 * ZCode (маршрут A) браузера не получает ни в одном режиме: у его CLI нет канала MCP-конфига.
 */
export function approvalBlocksBrowser(provider: AgentProvider, mode: ApprovalMode): boolean {
  if (provider === 'zcode') return true
  return provider === 'claude' ? mode === 'full' : mode === 'workspace' || mode === 'full'
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
  /** Шаг A: согласие на полный доступ и действующий `defaultMode` Claude владельца; нет — старый демон. */
  access?: AccessSettings
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
  if (v === 'claude' || v === 'codex' || v === 'zcode') out.provider = v
  return out
}

/** Счётчик под репликой из ссылки: сколько в ней строк и знаков — длинный хвост не спрячется за краем поля. */
export function promptStats(text: string): { lines: number; chars: number } {
  return { lines: text ? text.split('\n').length : 0, chars: [...text].length }
}

