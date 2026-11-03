// Резолвер настроек нового чата — один на все входы (быстрый старт, шаг B; design/2026-11-02-quick-start §3.7, §3.8).
//
// ЗАЧЕМ ОДИН. Черновик по ⌘N, «+» у проекта, ссылка `pult://new`, восстановленный черновик и `pult agent start`
// раньше собирали настройки каждый по-своему (форма окна — слоями с «последним выбором», CLI — умолчаниями провайдера).
// Ревью Codex (№ 9, 11) нашло, что из-за этого полный доступ мог прийти обходным путём — например, по ссылке через
// память папки. Здесь одно правило, и окно, и CLI зовут его.
//
// ЧТО ОТКУДА (шаг B, без пресетов — они придут шагом C):
//   * провайдер — явный (`provider=` ссылки, выбор в чипе) > `newSession.defaults.provider` > claude; CLI умолчание
//     провайдера НЕ берёт (скрипт не должен молча сменить провайдера);
//   * модель, усилие, режим процесса, браузер, ветка — явный выбор > умолчания ЭТОГО провайдера > встроенные;
//   * доступ — явный выбор > память папки (`folders.json`, не у CLI) > «Доступ по умолчанию» провайдера в Настройках >
//     «Правки в папке» (решение Павла 02.11.2026: умолчание для новой папки). У CLI последняя ступень — «Спрашивать»,
//     как было.
//
// ПОПРАВКИ ДОСТУПА (сам полный доступ не включается никогда):
//   * полный уровень (и «как в настройках Claude» при bypass) без действующего согласия → «Спрашивать», заметка
//     `full-revoked` («отозвано · Включить снова»);
//   * полный уровень в черновике из ссылки, если его выбрал не человек в этом черновике → «Спрашивать», заметка
//     `link-full-blocked` («Включить для этого чата»);
//   * полный доступ гасит встроенный браузер Пульта, у Codex — и «Правки в папке» (`modeBlocksBrowser`).
//
// Модуль чистый и без node: его собирает и окно (esbuild), и демон/CLI (tsc).

import type { ApprovalMode } from '../adapters/types.js'
import { isFullLevel } from './access.js'
import { CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, modeBlocksBrowser } from './settings.js'
import type { NewSessionSettings, ProviderDefaults } from './settings.js'

export type ResolveProvider = 'claude' | 'codex' | 'zcode'

/**
 * Откуда поле черновика: выбрал человек, пришло из ссылки, из памяти папки, из умолчаний Настроек, встроенное. CLI
 * встроенное не шлёт: модель и усилие тогда выбирает сам CLI провайдера, как было.
 */
export type FieldOrigin = 'explicit' | 'link' | 'folder' | 'default' | 'builtin'

/** Вход: черновик окна (`user`), черновик из ссылки (`link`), `pult agent start` (`cli`). */
export type ResolveEntry = 'user' | 'link' | 'cli'

/** Решение Павла 02.11.2026: новая папка без памяти — «Правки в папке». */
export const FOLDER_DEFAULT_ACCESS: ApprovalMode = 'workspace'

/** Встроенные умолчания, если в Настройках ничего нет (как у старой формы «Новая сессия»). */
export const BUILTIN: Readonly<Record<ResolveProvider, { model: string | null; effort: string }>> = {
  claude: { model: CLAUDE_DEFAULT_MODEL, effort: CLAUDE_DEFAULT_EFFORT },
  codex: { model: null, effort: 'medium' },
  // ZCode (маршрут A): модели и усилия у CLI нет — их задаёт аккаунт Z.AI.
  zcode: { model: null, effort: '' },
}

export interface ResolveExplicit {
  model?: string | null
  effort?: string
  approval?: ApprovalMode
  browser?: boolean
  worktree?: boolean
  mode?: 'turn' | 'warm'
}

export interface ResolveInput {
  entry: ResolveEntry
  /** Провайдер, выбранный явно (чип) или из ссылки (`provider=`). */
  provider?: ResolveProvider
  /** Откуда явный провайдер: `link` — из ссылки, иначе выбор человека. */
  providerOrigin?: 'explicit' | 'link'
  /** `newSession.defaults` из config.json; нет — старый демон или не прочитались. */
  defaults?: NewSessionSettings['defaults'] | null
  /** Память доступа папки (`folders.json`); уже проверена демоном по ключу и `(dev, ino)`. CLI её не передаёт. */
  folderAccess?: ApprovalMode | null
  /** Поля, выбранные человеком в этом черновике (или флагами CLI). Они сильнее всего остального. */
  explicit?: ResolveExplicit
  /** Полный доступ разрешён провайдеру сейчас (действующее согласие или разовое `--yes` CLI). */
  fullAllowed(provider: ResolveProvider): boolean
  /** Действующий `defaultMode` Claude владельца — для уровня «Как в настройках Claude». */
  inheritMode?: string | null
}

export type ResolveNote =
  /** Полный уровень без согласия — «Спрашивать»; строка «отозвано · Включить снова». */
  | 'full-revoked'
  /** Полный уровень в черновике из ссылки — «Спрашивать»; строка «Включить для этого чата». */
  | 'link-full-blocked'
  /** Браузер Пульта погашен выбранным доступом. */
  | 'browser-off'

export interface Resolved {
  provider: ResolveProvider
  model: string | null
  effort: string
  approval: ApprovalMode
  browser: boolean
  worktree: boolean
  mode: 'turn' | 'warm'
  origin: { provider: FieldOrigin; model: FieldOrigin; effort: FieldOrigin; approval: FieldOrigin; browser: FieldOrigin }
  /** Какой уровень хотела бы дать память или умолчание, пока поправка не опустила его до «Спрашивать». */
  blockedApproval?: ApprovalMode
  notes: ResolveNote[]
}

const pick = (d: NewSessionSettings['defaults'] | null | undefined, p: ResolveProvider): ProviderDefaults =>
  (d ? d[p] : undefined) ?? {}

export function resolveNewChat(input: ResolveInput): Resolved {
  const notes: ResolveNote[] = []
  const cli = input.entry === 'cli'
  const provider: ResolveProvider = input.provider ?? (cli ? undefined : input.defaults?.provider) ?? 'claude'
  const providerOrigin: FieldOrigin = input.provider ? (input.providerOrigin === 'link' ? 'link' : 'explicit') : 'default'
  const d = pick(input.defaults, provider)
  const x = input.explicit ?? {}
  const builtin = BUILTIN[provider]

  const model = x.model !== undefined ? x.model : d.model ?? builtin.model
  const effort = x.effort !== undefined ? x.effort : d.effort ?? builtin.effort
  const mode = x.mode ?? d.mode ?? 'turn'

  // Доступ: явный > память папки (не у CLI) > умолчание провайдера > «Правки в папке» (у CLI — «Спрашивать»).
  let approval: ApprovalMode
  let aOrigin: FieldOrigin
  if (x.approval !== undefined) { approval = x.approval; aOrigin = 'explicit' }
  else if (!cli && input.folderAccess) { approval = input.folderAccess; aOrigin = 'folder' }
  else if (d.approval !== undefined) { approval = d.approval; aOrigin = 'default' }
  else { approval = cli ? 'ask' : FOLDER_DEFAULT_ACCESS; aOrigin = 'builtin' }
  // «Как в настройках Claude» есть только у Claude: у других — явный «Спрашивать», не шире.
  if (approval === 'inherit' && provider !== 'claude') approval = 'ask'

  let blockedApproval: ApprovalMode | undefined
  if (isFullLevel(provider, approval, input.inheritMode ?? null) && aOrigin !== 'explicit') {
    // Ссылка полный доступ не даёт ни из какого источника — только клик человека в этом черновике (B3).
    if (input.entry === 'link') { blockedApproval = approval; approval = 'ask'; notes.push('link-full-blocked') }
    else if (!input.fullAllowed(provider)) { blockedApproval = approval; approval = 'ask'; notes.push('full-revoked') }
  }

  const wantBrowser = x.browser !== undefined ? x.browser : d.browser === true
  const browser = wantBrowser && !modeBlocksBrowser(provider, approval)
  if (wantBrowser && !browser) notes.push('browser-off')
  const worktree = x.worktree !== undefined ? x.worktree : d.worktree === true

  const origin = (has: boolean, fromDefaults: boolean): FieldOrigin => (has ? 'explicit' : fromDefaults ? 'default' : 'builtin')
  return {
    provider, model, effort, approval, browser, worktree, mode,
    origin: {
      provider: providerOrigin,
      model: origin(x.model !== undefined, d.model !== undefined),
      effort: origin(x.effort !== undefined, d.effort !== undefined),
      approval: aOrigin,
      browser: origin(x.browser !== undefined, d.browser !== undefined),
    },
    ...(blockedApproval ? { blockedApproval } : {}),
    notes,
  }
}

/**
 * Память доступа пишется (§3.7): при реальном старте или смене доступа в живом чате, если уровень выбран ЯВНО и не
 * включён «Только этот чат». Полный доступ из черновика по ссылке не запоминается никогда: «Включить для этого чата» —
 * разовое разрешение этого чата.
 */
export function shouldRemember(opts: { approvalOrigin: FieldOrigin; chatOnly: boolean; entry: ResolveEntry; full: boolean }): boolean {
  if (opts.entry === 'cli' || opts.chatOnly || opts.approvalOrigin !== 'explicit') return false
  return !(opts.entry === 'link' && opts.full)
}
