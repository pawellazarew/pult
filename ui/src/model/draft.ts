// Черновик нового чата (быстрый старт, шаг B; design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.1–§3.8). Модала
// «Новая сессия» больше нет: ⌘N, «Новый чат», «+» у проекта и ссылка `pult://new` сразу открывают черновик с
// умолчаниями; настройки — чипами под полем. Здесь — чистые функции черновика: резолвер (общий с демоном и CLI,
// src/sessions/resolve.ts), выбор в чипах, снимок для демона, параметры `agent.start`, единый submit-guard и порядок Esc.
// Проверяются в ui/test/draft.test.ts без окна.

import { t as tr } from '../lib/i18n.js'
import type { ApprovalMode } from '../../../src/adapters/types.js'
import { isServiceTier } from '../../../src/adapters/types.js'
import type { ServiceTier } from '../../../src/adapters/types.js'
import { isApprovalMode } from '../../../src/adapters/types.js'
import { resolveNewChat, shouldRemember } from '../../../src/sessions/resolve.js'
import type { FieldOrigin, ResolveNote } from '../../../src/sessions/resolve.js'
import { isFullLevel } from '../../../src/sessions/access.js'
import { consentGrants } from './access.js'
import type { ConsentView } from './access.js'
import { approvalBlocksBrowser, providerPreset } from './newAgent.js'
import type { SettingsReply } from './newAgent.js'
import type { AgentProvider, ProviderCatalog } from './types.js'
import type { SavedAttachment } from '../../../shell/src/contract.js'

export type { ResolveNote }

/** Что демон сказал о папке до отправки (`agent.preflight`): можно ли здесь завести чат и что Пульт о ней помнит. */
export interface FolderInfo {
  cwd: string
  ok: boolean
  /** `missing` — папки нет; `covers_pult_home` — папка покрывает PULT_HOME (без worktree чат не заведётся). */
  refusal?: 'missing' | 'covers_pult_home'
  /** PULT_HOME — для текста отказа. */
  home?: string
  /** Память папки и её идентичность (ключ realpath, `dev`, `ino`) — для снимка черновика и сверки демоном на старте. */
  folder?: { access?: ApprovalMode; changed?: boolean; key?: string; dev?: string; ino?: string; mapped?: boolean } | null
  /** Действующий `defaultMode` Claude ЭТОЙ папки (с её .claude/settings*.json) — уровень «Как в настройках Claude». */
  inheritMode?: string | null
}

/** Идентичность папки, при которой собран черновик: заменили папку или перенаправили симлинк — снимок не годится. */
export interface FolderStamp { key: string; dev: string; ino: string }

export function folderStamp(info: FolderInfo | null | undefined): FolderStamp | null {
  const f = info?.folder
  return f && f.key && f.dev && f.ino ? { key: f.key, dev: f.dev, ino: f.ino } : null
}

export const sameStamp = (a: FolderStamp | null | undefined, b: FolderStamp | null | undefined): boolean =>
  !!a && !!b && a.key === b.key && a.dev === b.dev && a.ino === b.ino

export type DraftOrigin = { kind: 'user' } | { kind: 'link'; provider?: AgentProvider; pathRejected?: boolean }

/** Поля, выбранные человеком в этом черновике: они сильнее памяти папки и умолчаний и переживают смену папки. */
export interface DraftPicked { provider?: true; model?: true; effort?: true; approval?: true; browser?: true; worktree?: true }

export interface DraftChat {
  /** uuid черновика — он же `requestId` старта (§3.3). */
  id: string
  /** Номер записи у демона; 0 — ещё не сохранён (пустой черновик не сохраняется). */
  rev: number
  cwd: string | null
  /** general не требует папку; старые снимки определяют scope по наличию cwd. */
  scope: 'project' | 'general'
  provider: AgentProvider
  model: string | null
  effort: string
  serviceTier?: ServiceTier
  approval: ApprovalMode
  browser: boolean
  browserHeaded: boolean
  worktree: boolean
  /** Имя ветки worktree; пусто — `pult/<имя чата>`, его даст демон. */
  branch: string
  mode: 'turn' | 'warm'
  text: string
  origin: DraftOrigin
  picked: DraftPicked
  /** «Только этот чат»: выбор доступа не пишется в память папки. */
  chatOnly: boolean
  /** Номер согласия, при котором выбран полный доступ: сменился — полный снимается (§3.2). */
  consentRev: number | null
  /** Происхождение доступа (для «изменено» и записи памяти). */
  approvalOrigin: FieldOrigin
  notes: ResolveNote[]
  /** Уровень, который дала бы память или умолчание, пока поправка не опустила его до «Спрашивать». */
  blockedApproval?: ApprovalMode
  /** Восстановлен из снимка демона: неявные поля не пересчитываются, пока человек не сменит папку или провайдера. */
  restored?: boolean
  /** Папка, при которой собран доступ черновика (из `agent.preflight`); на старте демон сверяет её (`folder_changed`). */
  folder?: FolderStamp | null
  /** Метаданные вложений черновика (сами файлы — в `attachments/draft-…`): черновик с одними вложениями — не пустой. */
  attachments?: SavedAttachment[]
  /** Текст, пришедший по ссылке: пока его не трогали, под полем — счётчик строк и знаков (ревью M5). */
  linkText?: string
  createdAt: string
}

export interface DraftEnv {
  settings: SettingsReply | null
  consent: ConsentView | null
  /** `agent.preflight` для папки черновика; нет — ещё не пришёл. */
  folder: FolderInfo | null
  inheritMode: string | null
}

/** uuid v4: `crypto.randomUUID`, а где его нет — из `getRandomValues`. */
export function newDraftId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = ((b[6] as number) & 0x0f) | 0x40
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const folderAccessOf = (d: Pick<DraftChat, 'cwd'>, env: DraftEnv): ApprovalMode | null =>
  d.cwd && env.folder && env.folder.cwd === d.cwd ? env.folder.folder?.access ?? null : null

/**
 * Пересчитать неявные поля по резолверу (§3.7): явно выбранные человеком остаются, остальное — из памяти папки и
 * умолчаний. Зовётся при заведении, когда пришла память папки, при смене папки, провайдера и согласия.
 */
export function resolveDraft(d: DraftChat, env: DraftEnv): DraftChat {
  const linkProvider = d.origin.kind === 'link' ? d.origin.provider : undefined
  const r = resolveNewChat({
    entry: d.origin.kind === 'link' ? 'link' : 'user',
    ...(d.picked.provider ? { provider: d.provider, providerOrigin: 'explicit' as const } : linkProvider ? { provider: linkProvider, providerOrigin: 'link' as const } : {}),
    defaults: env.settings?.newSession.defaults ?? null,
    folderAccess: folderAccessOf(d, env),
    explicit: {
      ...(d.picked.model ? { model: d.model } : {}),
      ...(d.picked.effort ? { effort: d.effort } : {}),
      ...(d.picked.approval ? { approval: d.approval } : {}),
      ...(d.picked.browser ? { browser: d.browser } : {}),
      ...(d.picked.worktree ? { worktree: d.worktree } : {}),
    },
    fullAllowed: (p) => consentGrants(env.consent, p),
    inheritMode: env.inheritMode,
  })
  const stamp = d.cwd && env.folder?.cwd === d.cwd ? folderStamp(env.folder) : null
  const next: DraftChat = {
    ...d, provider: r.provider, model: r.model, effort: r.effort, approval: r.approval, browser: r.browser, worktree: r.worktree,
    mode: r.mode, approvalOrigin: r.origin.approval, notes: r.notes, browserHeaded: r.browser && d.browserHeaded,
    ...(stamp ? { folder: stamp } : {}),
  }
  if (r.blockedApproval) next.blockedApproval = r.blockedApproval
  else delete next.blockedApproval
  // Явный полный доступ, а согласие тем временем отозвали (или дали снова под другим номером) — «Спрашивать» (§3.2).
  // Ревью m2 / Codex 3 и перепроверка 3: согласие с тех пор дали ЗАНОВО (другой номер) — полный доступ, выбранный ИЛИ
  // унаследованный при прежнем, не переносится: «Спрашивать» и «Включить снова». Номера ещё не было — берём текущий.
  const revMoved = d.consentRev !== null && env.consent !== null && env.consent.rev !== d.consentRev
  if (d.consentRev === null && env.consent) next.consentRev = env.consent.rev
  if (isFullLevel(next.provider, next.approval, env.inheritMode) && (revMoved || (d.picked.approval && !consentGrants(env.consent, next.provider)))) {
    next.blockedApproval = next.approval
    next.approval = 'ask'
    next.picked = { ...next.picked }
    delete next.picked.approval
    next.approvalOrigin = 'default'
    next.notes = [...next.notes.filter((n) => n !== 'full-revoked'), 'full-revoked']
  }
  if (d.scope === 'general') {
    if (!d.picked.approval) { next.approval = 'ask'; next.approvalOrigin = 'builtin'; delete next.blockedApproval }
    next.worktree = false
    if (!d.picked.browser) next.browser = false
    next.folder = null
  }
  return next
}

/** Новый черновик: папка (или нет), откуда пришёл, текст и провайдер ссылки; поля — по резолверу. */
export function createDraft(ctx: { id?: string; cwd: string | null; origin?: DraftOrigin; text?: string; now?: Date }, env: DraftEnv): DraftChat {
  const base: DraftChat = {
    id: ctx.id ?? newDraftId(), rev: 0, cwd: ctx.cwd, scope: ctx.cwd || (ctx.origin?.kind === 'link' && ctx.origin.pathRejected) ? 'project' : 'general', provider: 'claude', model: null, effort: '', approval: 'ask',
    browser: false, browserHeaded: false, worktree: false, branch: '', mode: 'turn', text: ctx.text ?? '',
    origin: ctx.origin ?? { kind: 'user' }, picked: {}, chatOnly: false, consentRev: env.consent?.rev ?? null,
    approvalOrigin: 'builtin', notes: [], createdAt: (ctx.now ?? new Date()).toISOString(),
    ...(ctx.origin?.kind === 'link' && ctx.text ? { linkText: ctx.text } : {}),
  }
  return resolveDraft(base, env)
}

/** Сменить папку: неявные поля пересчитываются (память новой папки), явный выбор остаётся (§3.7). */
export function withDraftFolder(d: DraftChat, cwd: string | null, env: DraftEnv): DraftChat {
  const origin = d.origin.kind === 'link' ? { ...d.origin, pathRejected: false } : d.origin
  const { restored: _r, folder: _f, ...rest } = d
  return resolveDraft({ ...rest, cwd, scope: cwd ? 'project' : 'general', origin }, env)
}

/**
 * Модель из меню — вместе с провайдером (меню моделей по провайдерам, кадр 02). Смена провайдера сбрасывает явное
 * усилие, если новая модель его не знает; «Как в настройках Claude» у других — «Спрашивать».
 */
export function pickModel(d: DraftChat, provider: AgentProvider, model: string | null, env: DraftEnv, catalog: ProviderCatalog | null): DraftChat {
  const switched = provider !== d.provider
  const picked: DraftPicked = { ...d.picked, provider: true, model: true }
  const { restored: _r, ...rest } = d
  let next: DraftChat = { ...rest, provider, model, picked }
  if (provider !== 'codex') delete next.serviceTier
  if (switched && next.picked.approval && next.approval === 'inherit' && provider !== 'claude') {
    next = { ...next, approval: 'ask' }
  }
  next = resolveDraft(next, env)
  return fitEffort(next, catalog)
}

/** Усилие, которого модель не знает, — на умолчание модели (явный выбор снимается: человек увидит новое значение). */
export function fitEffort(d: DraftChat, catalog: ProviderCatalog | null): DraftChat {
  if (d.provider === 'zcode') return d.effort ? { ...d, effort: '' } : d
  const preset = providerPreset(d.provider, d.model, catalog)
  if (preset.efforts.includes(d.effort)) return d
  const picked = { ...d.picked }
  delete picked.effort
  return { ...d, effort: preset.defaultEffort, picked }
}

export function pickEffort(d: DraftChat, effort: string): DraftChat {
  return { ...d, effort, picked: { ...d.picked, effort: true } }
}

/** Уровень доступа выбран человеком. Согласие на полный — забота вызывающего (диалог); здесь только поля. */
export function pickApproval(d: DraftChat, approval: ApprovalMode, consentRev: number | null): DraftChat {
  const browser = d.browser && !approvalBlocksBrowser(d.provider, approval)
  const notes = d.notes.filter((n) => n !== 'full-revoked' && n !== 'link-full-blocked' && (browser || n !== 'browser-off'))
  const next: DraftChat = {
    ...d, approval, browser, browserHeaded: browser && d.browserHeaded, consentRev,
    picked: { ...d.picked, approval: true }, approvalOrigin: 'explicit',
    notes: d.browser && !browser ? [...notes, 'browser-off'] : notes,
  }
  delete next.blockedApproval
  return next
}

export function toggleBrowser(d: DraftChat, on: boolean, headed = d.browserHeaded): DraftChat {
  if (on && approvalBlocksBrowser(d.provider, d.approval)) return d
  return { ...d, browser: on, browserHeaded: on && headed, picked: { ...d.picked, browser: true }, notes: d.notes.filter((n) => n !== 'browser-off') }
}

export function toggleWorktree(d: DraftChat, on: boolean): DraftChat {
  return { ...d, worktree: on, picked: { ...d.picked, worktree: true } }
}

/** Ветка worktree: пусто — демон назовёт `pult/<имя>`. Плохое имя — текст ошибки. */
export function branchError(branch: string): string | null {
  const b = branch.trim()
  if (!b) return null
  return /[\s~^:?*[\\]/.test(b) || b.startsWith('-') || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')
    ? tr('недопустимое имя ветки git') : null
}

/** Полный доступ (или «как в настройках Claude» при bypass) — для красной рамки и чипа. */
export function draftFull(d: Pick<DraftChat, 'provider' | 'approval'>, inheritMode: string | null): boolean {
  return isFullLevel(d.provider, d.approval, inheritMode)
}

/** Пишет ли старт память доступа папки (§3.7): явный выбор, не «Только этот чат», не полный из ссылки. */
export function remembersAccess(d: DraftChat, inheritMode: string | null): boolean {
  return d.scope !== 'general' && shouldRemember({ approvalOrigin: d.approvalOrigin, chatOnly: d.chatOnly, entry: d.origin.kind === 'link' ? 'link' : 'user', full: draftFull(d, inheritMode) })
}

/**
 * Параметры `agent.start` (§3.3): `requestId` = id черновика, имя выделяет демон, первая реплика — в том же вызове.
 * Полный доступ — с `confirm` и номером согласия, который видело окно.
 */
export function draftStartParams(d: DraftChat, opts: { prompt: string; consentRev?: number | null; inheritMode: string | null; owner?: string }): Record<string, unknown> {
  const full = d.approval === 'full' || d.approval === 'inherit'
  // Полный доступ — с номером согласия, при котором черновик его получил (выбором или из памяти папки; ревью m2,
  // перепроверка 3): демон сверит и скажет `consent_changed`, если согласие с тех пор отозвали и дали снова.
  const rev = d.consentRev !== null ? d.consentRev : opts.consentRev
  return {
    requestId: d.id,
    kind: d.provider,
    ...(d.scope === 'general' ? { scope: 'general' } : { cwd: d.cwd ?? '' }),
    ...(d.provider !== 'zcode' && d.model ? { model: d.model } : {}),
    ...(d.provider !== 'zcode' && d.effort ? { effort: d.effort } : {}),
    ...(d.provider === 'codex' && d.serviceTier ? { serviceTier: d.serviceTier } : {}),
    ...(d.worktree ? { worktree: d.branch.trim() || true } : {}),
    ...(d.browser ? { browser: d.browserHeaded ? { headed: true } : true } : {}),
    approval: d.approval,
    ...(full ? { confirm: true, ...(rev !== undefined && rev !== null ? { consentRev: rev } : {}) } : {}),
    ...(d.mode === 'warm' ? { mode: 'warm' } : {}),
    ...(opts.prompt.trim() ? { prompt: opts.prompt } : {}),
    origin: d.origin.kind,
    ...(d.approvalOrigin === 'explicit' ? { approvalOrigin: 'explicit' } : {}),
    ...(d.scope !== 'general' && d.folder ? { folder: d.folder } : {}),
    ...(opts.owner && d.rev > 0 ? { draft: { id: d.id, rev: d.rev, owner: opts.owner } } : {}),
    ...(remembersAccess(d, opts.inheritMode) ? { rememberAccess: true } : {}),
  }
}

// --- снимок у демона (§3.2) -----------------------------------------------------------------------------------

/** Снимок для `draft.put`: полный набор полей, происхождение, источник и номер согласия — не отличия. */
export function draftSnapshot(d: DraftChat): Record<string, unknown> {
  return {
    v: 1, scope: d.scope, ...(d.provider === 'codex' && d.serviceTier ? { serviceTier: d.serviceTier } : {}), cwd: d.cwd, provider: d.provider, model: d.model, effort: d.effort, approval: d.approval, browser: d.browser,
    browserHeaded: d.browserHeaded, worktree: d.worktree, branch: d.branch, mode: d.mode, text: d.text, origin: d.origin,
    picked: d.picked, chatOnly: d.chatOnly, consentRev: d.consentRev, approvalOrigin: d.approvalOrigin, createdAt: d.createdAt,
    ...(d.scope !== 'general' && d.folder ? { folder: d.folder } : {}), ...(d.attachments?.length ? { attachments: d.attachments } : {}),
    ...(d.linkText !== undefined ? { linkText: d.linkText } : {}),
  }
}

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'zcode']
const ORIGINS: readonly FieldOrigin[] = ['explicit', 'link', 'folder', 'default', 'builtin']

/**
 * Черновик из снимка демона — без доверия: кривое поле — умолчание. Полный доступ переживает восстановление, только если
 * согласие действует и его номер не сменился (§3.8 «Восстановленный черновик»).
 */
export function draftFromSnapshot(id: string, rev: number, raw: unknown, env: DraftEnv): DraftChat | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const str = (k: string, dflt = ''): string => (typeof o[k] === 'string' ? o[k] as string : dflt)
  const provider = PROVIDERS.includes(o['provider'] as AgentProvider) ? o['provider'] as AgentProvider : 'claude'
  const og = o['origin'] && typeof o['origin'] === 'object' ? o['origin'] as Record<string, unknown> : {}
  const origin: DraftOrigin = og['kind'] === 'link'
    ? { kind: 'link', ...(PROVIDERS.includes(og['provider'] as AgentProvider) ? { provider: og['provider'] as AgentProvider } : {}), ...(og['pathRejected'] === true ? { pathRejected: true } : {}) }
    : { kind: 'user' }
  const pk = o['picked'] && typeof o['picked'] === 'object' ? o['picked'] as Record<string, unknown> : {}
  const picked: DraftPicked = {}
  for (const k of ['provider', 'model', 'effort', 'approval', 'browser', 'worktree'] as const) if (pk[k] === true) picked[k] = true
  const cwd = typeof o['cwd'] === 'string' && o['cwd'].startsWith('/') ? o['cwd'] : null
  const scope = o['scope'] === 'general' ? 'general' : o['scope'] === 'project' ? 'project' : cwd || (origin.kind === 'link' && origin.pathRejected) ? 'project' : 'general'
  const consentRev = typeof o['consentRev'] === 'number' ? o['consentRev'] : null
  let approval: ApprovalMode = scope === 'general' && !picked.approval ? 'ask' : isApprovalMode(o['approval']) ? o['approval'] : 'ask'
  const notes: ResolveNote[] = []
  let blockedApproval: ApprovalMode | undefined
  let downgraded = false
  if (isFullLevel(provider, approval, env.inheritMode) && (!consentGrants(env.consent, provider) || consentRev !== (env.consent?.rev ?? null))) {
    blockedApproval = approval
    approval = 'ask'
    notes.push('full-revoked')
    delete picked.approval
    downgraded = true
  }
  const d: DraftChat = {
    id, rev, cwd: scope === 'general' ? null : cwd, scope, provider, ...(provider === 'codex' && isServiceTier(o['serviceTier']) ? { serviceTier: o['serviceTier'] } : {}), model: typeof o['model'] === 'string' ? o['model'] : null, effort: str('effort'), approval,
    browser: o['browser'] === true && (scope !== 'general' || picked.browser === true) && !approvalBlocksBrowser(provider, approval), browserHeaded: o['browserHeaded'] === true,
    worktree: scope === 'project' && o['worktree'] === true, branch: str('branch'), mode: o['mode'] === 'warm' ? 'warm' : 'turn', text: str('text'), origin, picked,
    // Опущенный до «Спрашивать» уровень человек не выбирал (ревью m1): в память папки он не пойдёт.
    chatOnly: o['chatOnly'] === true, consentRev,
    approvalOrigin: downgraded ? 'default' : ORIGINS.includes(o['approvalOrigin'] as FieldOrigin) ? o['approvalOrigin'] as FieldOrigin : 'default',
    notes, restored: true, createdAt: str('createdAt', new Date(0).toISOString()),
  }
  const fo = o['folder'] && typeof o['folder'] === 'object' ? o['folder'] as Record<string, unknown> : null
  if (scope === 'project' && fo && typeof fo['key'] === 'string' && typeof fo['dev'] === 'string' && typeof fo['ino'] === 'string') d.folder = { key: fo['key'], dev: fo['dev'], ino: fo['ino'] }
  if (Array.isArray(o['attachments'])) {
    d.attachments = (o['attachments'] as unknown[]).flatMap((x): SavedAttachment[] => {
      const a = x && typeof x === 'object' ? x as Record<string, unknown> : null
      if (!a || typeof a['path'] !== 'string' || !a['path'].startsWith('/') || typeof a['name'] !== 'string') return []
      if (typeof a['bytes'] !== 'number' || typeof a['mime'] !== 'string' || (a['kind'] !== 'file' && a['kind'] !== 'directory')) return []
      return [{ path: a['path'], name: a['name'], bytes: a['bytes'], mime: a['mime'], kind: a['kind'] }]
    }).slice(0, 20)
  }
  if (typeof o['linkText'] === 'string') d.linkText = o['linkText']
  if (blockedApproval) d.blockedApproval = blockedApproval
  return d
}

// --- вид -------------------------------------------------------------------------------------------------------

/** Последняя часть пути — так папку зовут в чипе и в заголовке «Что делаем в …?». */
export function folderName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/** Подпись черновика в сайдбаре: первая строка текста или «Новый чат». */
export function draftLabel(d: Pick<DraftChat, 'text'>): string {
  const line = d.text.split('\n').map((l) => l.trim()).find(Boolean)
  return line ? [...line].slice(0, 80).join('') : tr('Новый чат')
}

/** Готовность провайдера для отправки (§4, ревью Codex № 19). */
export type Readiness = 'checking' | 'ready' | 'login-required' | 'catalog-error' | 'unavailable' | 'stale'

/** Проверка старше — перепроверить в фоне при открытии черновика и при отправке. */
export const READINESS_STALE_MS = 5 * 60_000

export function readinessOf(catalog: ProviderCatalog | null, provider: AgentProvider, checking: boolean, now: number): Readiness {
  if (checking || !catalog) return 'checking'
  const r = catalog[provider]
  if (r.state === 'login_required') return 'login-required'
  if (r.state === 'unavailable') return 'unavailable'
  if (r.state === 'error') return 'catalog-error'
  const at = Date.parse(catalog.checkedAt)
  return Number.isFinite(at) && now - at > READINESS_STALE_MS ? 'stale' : 'ready'
}

/** Отправку держат только «нужен вход» и «CLI не запускается»; остальное — с пометкой (§4). */
export const readinessBlocks = (r: Readiness): boolean => r === 'login-required' || r === 'unavailable'

/** Модели нет в каталоге провайдера (ID сохраняется, чип жёлтый «нет в списке», без автозамены — §4). */
export function modelUnlisted(d: Pick<DraftChat, 'provider' | 'model'>, catalog: ProviderCatalog | null): boolean {
  if (!d.model || d.provider !== 'codex') return false
  const list = catalog?.codex.models ?? []
  return list.length > 0 && !list.some((m) => m.id === d.model)
}

// --- клавиатура (§3.5) ------------------------------------------------------------------------------------------

export interface SubmitState {
  /** Набор IME: `isComposing` или keyCode 229. */
  composing: boolean
  /** Автоповтор клавиши. */
  repeat: boolean
  busy: boolean
  /** Замок ссылки (1 с после черновика из ссылки) — для всех путей отправки. */
  linkLocked: boolean
  hasFolder: boolean
  scope?: 'project' | 'general'
  hasText: boolean
  /** Отправка выключена по другой причине (папка нельзя, провайдер без входа, демон не на связи, вложения пишутся). */
  blocked: boolean
}

/**
 * Единый submit-guard (кнопка, ↵, ⌘↵): `send` — отправлять; `folder` — без папки ↵ открывает меню папки; `null` —
 * ничего (и клавиша не уходит дальше).
 */
export function submitDecision(s: SubmitState): 'send' | 'folder' | null {
  if (s.composing || s.repeat || s.busy || s.linkLocked) return null
  if (!s.hasFolder && s.scope !== 'general') return 'folder'
  if (!s.hasText || s.blocked) return null
  return 'send'
}

/** Esc по порядку (§3.5): меню → диалог → убрать пустой черновик или подтвердить закрытие непустого. */
export function escDecision(s: { menuOpen: boolean; dialogOpen: boolean; empty: boolean }): 'menu' | 'dialog' | 'discard' | 'confirm' {
  if (s.menuOpen) return 'menu'
  if (s.dialogOpen) return 'dialog'
  return s.empty ? 'discard' : 'confirm'
}

/** Черновик пуст: ни текста, ни вложений. Пустой при уходе исчезает, с текстом — остаётся у демона. */
export const draftEmpty = (d: Pick<DraftChat, 'text'> & { attachments?: DraftChat['attachments'] }, attachments = d.attachments?.length ?? 0): boolean =>
  !d.text.trim() && attachments === 0

/**
 * Перед отправкой: черновик собран при этой же папке? Восстановленный снимок или черновик, отправленный быстрее, чем
 * пришла память папки (ревью m3, Codex 2), пересчитывается по свежему `agent.preflight`. Если от этого сменился доступ —
 * отправлять нельзя молча: человек должен увидеть новый уровень.
 */
export function refreshBeforeStart(d: DraftChat, env: DraftEnv): { draft: DraftChat; changed: boolean } {
  const fresh = folderStamp(env.folder)
  const stale = !!d.folder && !!fresh && !sameStamp(d.folder, fresh)
  if (d.restored && !stale) return { draft: { ...d, ...(fresh ? { folder: fresh } : {}) }, changed: false }
  const { restored: _r, ...rest } = d
  // Папку подменили (перепроверка Codex 2): полный уровень не переносится на другую папку, даже выбранный явно, —
  // человек увидит пересчитанный доступ и выберет снова. Прочий явный выбор остаётся.
  const fullBefore = isFullLevel(rest.provider, rest.approval, env.inheritMode)
  const base = stale && fullBefore ? { ...rest, folder: null, picked: { ...rest.picked, approval: undefined } } : stale ? { ...rest, folder: null } : rest
  if (base.picked.approval === undefined) delete base.picked.approval
  const next = resolveDraft(base, env)
  return { draft: next, changed: stale || next.approval !== d.approval }
}

/** Короткие подписи чипа доступа (ревью: полные — в меню). «Как в настройках Claude» — с действующим режимом папки. */
export function accessChipLabel(d: Pick<DraftChat, 'approval'>, inheritMode: string | null): string {
  switch (d.approval) {
    case 'read-only': return tr('Только чтение')
    case 'ask': return tr('Спрашивать')
    case 'workspace': return tr('Правки в папке')
    case 'full': return tr('Полный доступ')
    case 'inherit': return inheritMode ? tr`Настройки Claude · ${inheritMode}` : tr('Настройки Claude')
  }
}

/** Строки «N строк · M знаков» для текста из ссылки — пока его не правили (ревью M5). */
export function linkPromptStats(d: Pick<DraftChat, 'origin' | 'text' | 'linkText'>): { lines: number; chars: number } | null {
  if (d.origin.kind !== 'link' || d.linkText === undefined || d.text !== d.linkText || !d.text) return null
  return { lines: d.text.split('\n').length, chars: [...d.text].length }
}
