// Быстрый старт, шаг A: доступ чата — желаемый, применённый, ожидающий (design/2026-11-02-quick-start §3.6, ревью
// Codex B1/B4). ЧИСТЫЕ функции: их зовут демон (снимок хода, `agent.list`) и окно (чип, плашка, щит в сайдбаре) —
// чтобы «красная метка» считалась одинаково.
//
// ПОЧЕМУ НЕ ПРОСТО `record.approval`. Запись меняется сразу, а ход идёт по снимку (src/sessions/manager.ts, `prompt`),
// и у Claude процесс живёт ради фоновых задач после хода. Поэтому у чата три состояния:
//   * desired — что выбрал человек (`approval` записи);
//   * applied — с чем запущен текущий или последний процесс (`applied` записи: снимок хода + ответ провайдера);
//   * pending — desired ≠ applied, пока этот процесс жив.
// Красная метка горит, пока desired полный ИЛИ жив процесс, запущенный с полными правами.

import type { ApprovalMode } from '../adapters/types.js'
import type { AppliedAccess } from './registry.js'

export type AccessProvider = 'claude' | 'codex' | 'zcode'

/**
 * Уровень — полный доступ? `full` — всегда; `inherit` у Claude — когда действующий `defaultMode` владельца
 * `bypassPermissions` (`inheritMode` — его значение; неизвестно — не полный, но и согласия не требует до первого хода).
 */
export function isFullLevel(provider: AccessProvider, approval: ApprovalMode | undefined, inheritMode?: string | null): boolean {
  if (approval === 'full') return true
  return provider === 'claude' && approval === 'inherit' && inheritMode === 'bypassPermissions'
}

/**
 * Что провайдер должен сказать о режиме при этом уровне: Claude — `permissionMode` из `system/init` (`manual` он
 * показывает как `default`: ИЗМЕРЕНО S10), Codex — `<sandbox.type>/<approvalPolicy>` ответа `thread/start|resume`
 * (сессии Пульта всегда с брокером разрешений). `null` — сверять не с чем (`inherit` без известного `defaultMode`;
 * ZCode: поток `stream-json` режима не называет — фикстуры CLI 0.17.1, — метка у него всегда «не подтверждено»).
 */
export function expectedReport(provider: AccessProvider, approval: ApprovalMode | undefined, inheritMode?: string | null): string | null {
  const a = approval ?? 'ask'
  if (provider === 'zcode') return null
  if (provider === 'claude') {
    if (a === 'inherit') return inheritMode ?? null
    return a === 'workspace' ? 'acceptEdits' : a === 'full' ? 'bypassPermissions' : 'default'
  }
  return {
    'read-only': 'readOnly/on-request', ask: 'workspaceWrite/on-request', inherit: 'workspaceWrite/on-request',
    workspace: 'workspaceWrite/never', full: 'dangerFullAccess/never',
  }[a]
}

/** Ответ провайдера означает полные права (без песочницы и без вопросов)? */
export function reportIsFull(provider: AccessProvider, reported: string | null): boolean {
  if (reported === null || provider === 'zcode') return false
  return provider === 'claude' ? reported === 'bypassPermissions' : reported.startsWith('dangerFullAccess/')
}

/** Режим словами для ленты: «bypassPermissions», «danger-full-access + never». */
export function reportWords(provider: AccessProvider, reported: string): string {
  if (provider !== 'codex') return reported
  const [sandbox, policy] = reported.split('/')
  const s = sandbox === 'readOnly' ? 'read-only' : sandbox === 'dangerFullAccess' ? 'danger-full-access' : sandbox === 'workspaceWrite' ? 'workspace-write' : sandbox ?? '?'
  return `${s} + ${policy ?? '?'}`
}

/** Доступ чата для окна и CLI (`access` в `agent.list`). */
export interface AccessView {
  /** Что выбрал человек. */
  desired: ApprovalMode
  /** Выбранное — полный доступ (в том числе `inherit` при bypass у владельца). */
  desiredFull: boolean
  /** Полный доступ выбран, но разрешения нет: ход пойдёт в «Спрашивать» (отозвано или не дано). */
  blocked: boolean
  /** Действующий `defaultMode` владельца — только у Claude (для `inherit` и подписи в меню). */
  inheritMode?: string
  /** С чем запущен последний процесс; нет — ходов ещё не было («ожидается»). */
  applied?: AppliedAccess
  /** Процесс с правами `applied` прямо сейчас работает (ход или фоновые задачи). */
  live: boolean
  /** Процесс жив с правами, отличными от выбранных: выбор применится после хода. */
  pending: boolean
  /** Красная метка: выбран полный доступ или жив процесс с полными правами. */
  red: boolean
  /** Полный доступ этой сессии дан разово из CLI (`--yes`). */
  grant?: 'cli-once'
}

export function accessView(o: {
  provider: AccessProvider
  approval?: ApprovalMode
  inheritMode?: string | null
  applied?: AppliedAccess | null
  /** Уровень работающего сейчас процесса; `null` — процесса за работой нет. */
  liveApproval?: ApprovalMode | null
  allowed: boolean
  grant?: 'cli-once'
}): AccessView {
  const desired = o.approval ?? 'ask'
  const desiredFull = isFullLevel(o.provider, desired, o.inheritMode)
  const blocked = desiredFull && !o.allowed
  const live = o.liveApproval !== undefined && o.liveApproval !== null
  const applied = o.applied ?? undefined
  // Полные права живого процесса: по ответу провайдера, а без него — по уровню, с которым процесс запущен.
  const liveFull = live && (applied && applied.approval === o.liveApproval ? applied.full : isFullLevel(o.provider, o.liveApproval ?? undefined, o.inheritMode))
  const pending = live && (o.liveApproval ?? 'ask') !== (blocked ? 'ask' : desired)
  return {
    desired, desiredFull, blocked,
    ...(o.provider === 'claude' && o.inheritMode ? { inheritMode: o.inheritMode } : {}),
    ...(applied ? { applied } : {}),
    live, pending,
    red: (desiredFull && !blocked) || liveFull,
    ...(o.grant ? { grant: o.grant } : {}),
  }
}
