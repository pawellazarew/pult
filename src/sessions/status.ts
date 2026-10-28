// Свёртка потока событий в статус сессии. ЧИСТАЯ функция: вход — статус и событие, выход —
// статус. Ни одного обращения к файлам, процессам и времени.
//
// ПОЧЕМУ чистая: статус показывают минимум три места (CLI `agent list`, ответ `agent.wait`,
// будущая доска Ф2), и все три обязаны получить одинаковый ответ на одинаковых событиях.
// Единственный способ это гарантировать — одна функция без состояния и табличный тест на неё.
//
// ПРАВИЛО СТАРШИНСТВА. `provider.blocked` и `net.blocked` бьют всё: сессия, которой запрещено
// ходить в сеть, не «работает». Дальше — блокировки на человеке (`blocked_permission`,
// `blocked_question`), потом `limited`, потом рабочие состояния. `session.ended` завершает
// сессию из любого состояния.

import type { PultEvent } from '../core/events.js'
import type { SessionStatus } from './registry.js'

/** Явный статус в `status.changed` — единственный способ адаптера сказать «я знаю точно». */
/**
 * Предупреждение о лимите (`allowed_warning`) до 0.2.10 писалось как лимит: `limit.hit` и
 * `status.changed limited`. Такие события уже лежат в журналах — их свёртка пропускает, иначе
 * окно, доигрывая журнал, снова запирало бы ввод «лимитом», которого не было.
 */
const warningOnly = (ev: PultEvent): boolean =>
  (ev.data as { status?: unknown; rateLimitStatus?: unknown }).rateLimitStatus === 'allowed_warning'
  || (ev.kind === 'limit.hit' && (ev.data as { status?: unknown }).status === 'allowed_warning')

function explicit(ev: PultEvent): SessionStatus | null {
  if (ev.kind !== 'status.changed') return null
  if (warningOnly(ev)) return null
  const s = (ev.data as { status?: unknown }).status
  return typeof s === 'string' && (
    s === 'cold' || s === 'idle' || s === 'working' || s === 'blocked_permission'
    || s === 'blocked_question' || s === 'limited' || s === 'interrupted'
    || s === 'failed' || s === 'done'
  ) ? s : null
}

export function reduceStatusEvent(prev: SessionStatus, ev: PultEvent): SessionStatus {
  const forced = explicit(ev)
  if (forced !== null) return forced

  switch (ev.kind) {
    case 'session.started':
      // `system/init` claude приходит ПОСЛЕ `status.changed working`: адаптер ставит working
      // до спавна, а init — первая строка потока уже идущего хода. Сбросить здесь в idle —
      // значит показывать «готов» всё время, пока модель думает до первой дельты (замер Ф2 О1:
      // e2e «Стоп» падал, окно и agent.list видели idle посреди хода).
      return prev === 'working' ? 'working' : 'idle'
    case 'session.ended':
      return 'done'
    case 'provider.blocked':
    case 'net.blocked':
      return 'failed'
    case 'permission.requested':
      return 'blocked_permission'
    case 'permission.resolved':
      // Решение принято — значит ход продолжается. Вопрос, заданный ВНЕ хода (субагент Codex, переживший
      // ход), после ответа возвращает менеджер: он видит, что хода нет, и пишет `status.changed idle`.
      return prev === 'blocked_permission' ? 'working' : prev
    case 'question.asked':
      return 'blocked_question'
    case 'limit.hit':
      return warningOnly(ev) ? prev : 'limited'
    case 'message.delta':
    case 'message.done':
    case 'tool.called':
    case 'tool.finished':
    case 'agent.spawned':
    case 'agent.finished':
      // АКТИВНОСТЬ СТАТУС НЕ ДВИГАЕТ (28.10.2026). Ход начинает только явный `status.changed working`
      // адаптера (Claude — до спавна и на фоновый ход, Codex — на `turn/start`), а внутри хода статус и так
      // `working`. Раньше дельта, вызов или конец инструмента без `parentId` поднимали сессию в `working` из
      // `idle`/`failed`/`interrupted`/`done`: Codex даёт субагентам и фоновым командам пережить ход, их конец
      // приходил верхним `agent.finished`/`tool.finished` уже ПОСЛЕ хода — сессия «воскресала» без хода, поле
      // ввода запиралось, а через 10 мин сторож тишины кричал «Похоже, завис» (4 из 4 разобранных случаев).
      // Правка 07.10 закрыла только события с `parentId`. Фоновую работу показывает `background.changed`
      // («фон · N»), а не статус.
      return prev
    case 'usage.updated':
    // Контекстное окно — справка о разговоре, а не признак работы: статус не трогает.
    case 'context.updated':
    // Реплика человека пишется ДО хода: статус двигает сам ход (`status.changed working`),
    // а упавший на входе ход не должен оставить сессию «работающей».
    case 'message.user':
    default:
      return prev
  }
}

/** Свёртка всей истории. `cold` — начальное состояние: процесса нет, ходов не было. */
export function reduceStatus(events: readonly PultEvent[], start: SessionStatus = 'cold'): SessionStatus {
  let s = start
  for (const ev of events) s = reduceStatusEvent(s, ev)
  return s
}

/** Статусы, в которых ждать бессмысленно: `agent wait` выходит сразу. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['done', 'failed'])

/** Статусы, которые означают «дальше нужен человек» — код выхода 3. */
export const HUMAN_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'blocked_permission',
  'blocked_question',
])
