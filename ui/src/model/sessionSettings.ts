// M8f: настройки сессии после заведения (меню в подвале «opus · high · спрашивать») и экран «Настройки» (⌘,).
// Чистые функции: пункты меню, когда нужен вопрос, параметры `agent.configure`, черновик настроек и `settings.set`.
// Проверки — те же, что у демона (src/sessions/settings.ts): окно лишь говорит заранее то, что демон и так скажет.

import type { ApprovalMode } from '../../../src/adapters/types.js'
import {
  APPROVAL_WORDS, CLAUDE_EFFORTS, CODEX_EFFORTS_FALLBACK, ConfigureError, modeBlocksBrowser, modelWindows, parseNewSession, windowMisfit,
} from '../../../src/sessions/settings.js'
import type { NewSessionSettings, Provider, ProviderDefaults } from '../../../src/sessions/settings.js'
import type { AgentView } from './agents.js'
import { APPROVAL_FULL_WARNING, APPROVAL_LABEL, APPROVAL_ORDER, PRESETS } from './newAgent.js'
import type { ProviderCatalog } from './types.js'
import { compareVersions } from '../../../src/core/semver.js'
import type { GuardRule } from '../../../src/core/guard.js'

export { modelWindows }

/** Что выбрали в меню подвала. */
export type SettingsPick =
  | { kind: 'model'; model: string; misfit?: string }
  | { kind: 'effort'; effort: string }
  | { kind: 'approval'; approval: ApprovalMode }

export type MenuRow =
  | { type: 'heading'; label: string; testId?: string }
  | { type: 'note'; label: string; testId?: string }
  | { type: 'sep' }
  | { type: 'item'; label: string; checked: boolean; pick: SettingsPick; danger?: boolean; title?: string; testId: string }

/** Подпись кнопки подвала: «opus · high · спрашивать». */
export function footerParts(agent: Pick<AgentView, 'provider' | 'model' | 'effort' | 'approval'>): string[] {
  return [agent.model ?? (agent.provider === 'codex' ? 'модель codex' : 'модель по умолчанию'), ...(agent.effort ? [agent.effort] : []), APPROVAL_WORDS[agent.approval ?? 'ask']]
}

/** Модели провайдера для меню: id, подпись, усилия. Текущая модель вне списка — тоже в нём (отмеченной). */
export function modelOptions(provider: Provider, catalog: ProviderCatalog | null | undefined, current: string | undefined): Array<{ id: string; label: string; efforts: readonly string[]; isDefault: boolean }> {
  const out: Array<{ id: string; label: string; efforts: readonly string[]; isDefault: boolean }> = provider === 'claude'
    ? PRESETS.claude.models.map((id) => ({ id, label: id, efforts: CLAUDE_EFFORTS, isDefault: id === PRESETS.claude.defaultModel }))
    : (catalog?.codex.models ?? []).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts, isDefault: m.isDefault }))
  if (current && !out.some((m) => m.id === current)) out.unshift({ id: current, label: current, efforts: provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS_FALLBACK, isDefault: false })
  return out
}

/** Усилия модели сессии (у Codex — по живому списку; модели в нём нет — общий набор). */
export function effortOptions(provider: Provider, catalog: ProviderCatalog | null | undefined, model: string | undefined): readonly string[] {
  if (provider === 'claude') return CLAUDE_EFFORTS
  const list = catalog?.codex.models ?? []
  const m = model ? list.find((x) => x.id === model) : list.find((x) => x.isDefault)
  return m?.efforts.length ? m.efforts : CODEX_EFFORTS_FALLBACK
}

/**
 * Меню подвала: модели (текущая отмечена; окно меньше занятого контекста — «не влезет: 300k > 200k»), усилия
 * текущей модели, режимы подтверждений («Полный доступ» — красный, с вопросом), подсказки.
 */
export function settingsMenu(agent: AgentView, catalog: ProviderCatalog | null | undefined, windows: ReadonlyMap<string, number>): MenuRow[] {
  const rows: MenuRow[] = [{ type: 'heading', label: 'модель — со следующего хода', testId: 'settings-menu-models' }]
  const models = modelOptions(agent.provider, catalog, agent.model)
  const used = agent.context?.used ?? null
  for (const m of models) {
    const misfit = m.id !== agent.model ? windowMisfit(used, windows.get(m.id)) : null
    rows.push({
      type: 'item', label: `${m.label}${misfit ? ` — ${misfit}` : ''}`, checked: m.id === agent.model || (!agent.model && m.isDefault && agent.provider === 'codex'),
      pick: { kind: 'model', model: m.id, ...(misfit ? { misfit } : {}) }, testId: `settings-model-${m.id}`,
      ...(misfit ? { title: `${misfit}: разговор не поместится в окно этой модели — спрошу перед сменой` } : {}),
    })
  }
  if (agent.provider === 'codex' && !(catalog?.codex.models.length)) {
    rows.push({ type: 'note', label: 'список моделей Codex не загружен — «Проверить» в «+ Сессия»', testId: 'settings-menu-no-models' })
  }
  rows.push({ type: 'sep' }, { type: 'heading', label: `усилие${agent.model ? ` · ${agent.model}` : ''}` })
  for (const e of effortOptions(agent.provider, catalog, agent.model)) {
    rows.push({ type: 'item', label: e, checked: e === agent.effort, pick: { kind: 'effort', effort: e }, testId: `settings-effort-${e}` })
  }
  rows.push({ type: 'sep' }, { type: 'heading', label: 'подтверждения' })
  const cur = agent.approval ?? 'ask'
  for (const a of APPROVAL_ORDER) {
    rows.push({
      type: 'item', label: APPROVAL_LABEL[a], checked: a === cur, pick: { kind: 'approval', approval: a }, testId: `settings-approval-${a}`,
      ...(a === 'full' ? { danger: true, title: APPROVAL_FULL_WARNING } : {}),
      ...(a !== 'full' && modeBlocksBrowser(agent.provider, a) && agent.browser ? { title: 'в этом режиме браузер для агента выключится' } : {}),
    })
  }
  rows.push({ type: 'sep' },
    { type: 'note', label: 'Действует со следующего хода: идущий ход и вопросы в Inbox не меняются.', testId: 'settings-menu-next-turn' },
    { type: 'note', label: 'Первый ход после смены модели дороже — кэш промпта у каждой модели свой.', testId: 'settings-menu-cache' })
  return rows
}

/** Выбор, о котором надо спросить: «Полный доступ» и модель, в окно которой разговор не влезет. */
export function confirmNeeded(pick: SettingsPick): 'full' | 'misfit' | null {
  if (pick.kind === 'approval' && pick.approval === 'full') return 'full'
  if (pick.kind === 'model' && pick.misfit) return 'misfit'
  return null
}

/** Выбор текущего значения — ничего не менять. */
export function isNoop(pick: SettingsPick, agent: Pick<AgentView, 'model' | 'effort' | 'approval'>): boolean {
  if (pick.kind === 'model') return pick.model === agent.model
  if (pick.kind === 'effort') return pick.effort === agent.effort
  return pick.approval === (agent.approval ?? 'ask')
}

/** Параметры `agent.configure`. `confirmed` — человек ответил «да» на вопрос (полный доступ, не влезет). */
export function configureParams(name: string, pick: SettingsPick, confirmed: boolean): Record<string, unknown> {
  return {
    name,
    ...(pick.kind === 'model' ? { model: pick.model } : pick.kind === 'effort' ? { effort: pick.effort } : { approval: pick.approval }),
    ...(confirmed ? { confirm: true } : {}),
  }
}

// --- «Настройки» → «Новая сессия» -------------------------------------------------------------------

/** Режимы, которые можно поставить умолчанием: «Полный доступ» — только явно при заведении. */
export const DEFAULT_APPROVALS: ReadonlyArray<Exclude<ApprovalMode, 'full'>> = ['read-only', 'ask', 'workspace']

/** Черновик раздела: то, что редактирует экран, — копия, чтобы «Отмена» ничего не тронула. */
export function settingsDraft(ns: NewSessionSettings | null | undefined): NewSessionSettings {
  const base = ns ?? { rememberLast: true, defaults: { claude: {}, codex: {} } }
  return { rememberLast: base.rememberLast, defaults: { ...(base.defaults.provider ? { provider: base.defaults.provider } : {}), claude: { ...base.defaults.claude }, codex: { ...base.defaults.codex } } }
}

/** Поле умолчания провайдера: `undefined` / пустая строка — снять (форма возьмёт своё). */
export function setDefault<K extends keyof ProviderDefaults>(d: NewSessionSettings, provider: Provider, key: K, value: ProviderDefaults[K] | '' | undefined): NewSessionSettings {
  const p: ProviderDefaults = { ...d.defaults[provider] }
  if (value === undefined || value === '') delete p[key]
  else p[key] = value as ProviderDefaults[K]
  return { ...d, defaults: { ...d.defaults, [provider]: p } }
}

/** Провайдер по умолчанию: пусто — как в форме (claude). */
export function setDefaultProvider(d: NewSessionSettings, provider: Provider | ''): NewSessionSettings {
  const defaults = { ...d.defaults }
  if (provider) defaults.provider = provider
  else delete defaults.provider
  return { ...d, defaults }
}

/** Ошибка черновика словами — та же проверка, что у демона (`settings.set` строгий); `null` — можно сохранять. */
export function draftError(d: NewSessionSettings): string | null {
  try {
    parseNewSession(d, true)
    return null
  } catch (e) {
    return e instanceof ConfigureError ? e.message.replace(/^newSession: /, '') : String(e)
  }
}

/**
 * Параметры `settings.set`; `updatesCheck` — флаг автопроверки обновлений, `guard` — правило стража сети (0.3.6):
 * каждое только когда сменилось (старый демон незнакомые разделы не принимает, и зря трогать файл незачем).
 */
export function settingsParams(d: NewSessionSettings, updatesCheck?: boolean, guard?: GuardRule, expect?: GuardRule): { newSession: NewSessionSettings; updates?: { check: boolean }; network?: { guard: GuardRule; expect?: GuardRule } } {
  const copy = (r: GuardRule): GuardRule => ({ mode: r.mode, countries: [...r.countries] })
  return {
    newSession: d,
    ...(updatesCheck !== undefined ? { updates: { check: updatesCheck } } : {}),
    // `expect` — правило, которое видело окно: правку из терминала, сделанную тем временем, демон не даст затереть.
    ...(guard !== undefined ? { network: { guard: copy(guard), ...(expect ? { expect: copy(expect) } : {}) } } : {}),
  }
}

// --- старое окно -------------------------------------------------------------------------------------

/** Оболочка, в мосте которой есть `agent.configure` и `settings.*`. */
export const SETTINGS_SHELL_VERSION = '0.1.15'

/** Умеет ли окно менять настройки: версия из user agent; неизвестна (рабочая копия в браузере) — да. */
export function shellHasSettings(windowVersion: string | null): boolean {
  return windowVersion === null || compareVersions(windowVersion, SETTINGS_SHELL_VERSION) >= 0
}

/** Отказ словами: старая оболочка отвечает `method_not_allowed` — подсказка про терминал. */
export function settingsErrorText(code: string | null, message: string): string {
  if (code === 'guard_changed') return `${message.replace(/^settings\.set: /, '')}`
  if (code === 'method_not_allowed') return `Это окно не умеет менять настройки (оболочка старше ${SETTINGS_SHELL_VERSION}) — в терминале: pult agent set <имя> --model … / config.json → newSession`
  if (code === 'not_found' && /неизвестный метод/.test(message)) return 'Демон старше 0.3.0 не умеет менять настройки — перезапусти его новой версией'
  return message
}
