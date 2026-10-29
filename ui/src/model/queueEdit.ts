import { t as tr } from '../lib/i18n.js'
// Правка реплики в очереди под полем ввода (0.3.2). «Изменить» берёт реплику в правку у демона
// (`agent.queue.move {hold: true}`): пока правка открыта, очередь на этой реплике стоит. Enter — сохранить,
// Shift+Enter — новая строка, Esc — отмена. Реплика успела уйти или её убрали — исправленный текст уходит в поле
// ввода по правилу M8e (`restoreDraft`): текст человека не теряется никогда. Без DOM — ради юнит-тестов.

/** Открытая правка: id реплики, текст в поле правки, исходный полный текст и срок удержания у демона. */
export interface QueueEditState {
  id: string
  text: string
  original: string
  holdMs: number
  saving: boolean
  error: string | null
}

/** Ответ демона на «Изменить» (`agent.queue.move {hold: true}`): полный текст (в списке — превью) и срок. */
export interface QueueHoldReply {
  text: string
  holdMs: number
}

/** Действия правки, которые окно отдаёт списку очереди. Нет — старый демон: кнопки «Изменить» нет. */
export interface QueueEditApi {
  hold(id: string): Promise<QueueHoldReply>
  save(id: string, text: string): Promise<void>
  release(id: string): void
}

export const QUEUE_EDIT_EXPIRED = tr('Время правки вышло — реплика осталась как была')
export const QUEUE_EDIT_EXPIRED_KEPT = tr('Время правки вышло — реплика осталась как была, исправленный текст — в поле ввода')

/** Клавиша в поле правки: только «голый» Enter сохраняет (⌘Enter — горячая клавиша окна), Esc бросает правку. */
export function queueEditKey(e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean }): 'save' | 'cancel' | null {
  if (e.isComposing) return null
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'save'
  if (e.key === 'Escape' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'cancel'
  return null
}

/** Реплики уже нет в очереди (код отказа демона) — что сказать человеку; `null` — другая ошибка. */
export function queueGoneText(code: string | null): string | null {
  if (code === 'queue_item_sent') return tr('Реплика уже ушла — исправленный текст в поле ввода')
  if (code === 'queue_item_removed') return tr('Реплика уже удалена — исправленный текст в поле ввода')
  return null
}

export function startQueueEdit(id: string, reply: QueueHoldReply): QueueEditState {
  return { id, text: reply.text, original: reply.text, holdMs: reply.holdMs, saving: false, error: null }
}

/** Итог шага правки: новое состояние (`null` — правка закрыта) и заметка над очередью. */
export interface QueueEditStep {
  next: QueueEditState | null
  notice: string | null
}

/**
 * «Сохранить». Текст не менялся — просто отпустить очередь (событие в журнал ни к чему). Реплика ушла или
 * убрана — правка закрывается, текст уходит в поле ввода (`toComposer`), заметка говорит почему. Другая ошибка
 * (пусто, длинно) — правка остаётся открытой с ошибкой под полем.
 */
export async function saveQueueEdit(
  st: QueueEditState,
  io: { save(id: string, text: string): Promise<void>; release(id: string): void; toComposer(text: string): void; errorOf(e: unknown): { code: string | null; text: string } },
): Promise<QueueEditStep> {
  if (!st.text.trim()) return { next: { ...st, error: tr('Пустая реплика — убери её из очереди крестиком') }, notice: null }
  if (st.text === st.original) { io.release(st.id); return { next: null, notice: null } }
  try {
    await io.save(st.id, st.text)
    return { next: null, notice: null }
  } catch (e) {
    const err = io.errorOf(e)
    const gone = queueGoneText(err.code)
    if (gone !== null) { io.toComposer(st.text); return { next: null, notice: gone } }
    return { next: { ...st, saving: false, error: err.text }, notice: null }
  }
}

/**
 * Срок удержания вышел (демон отпустил очередь сам — реплика уйдёт с прежним текстом). Правка закрывается;
 * исправленный текст, если он менялся, — в поле ввода.
 */
export function expireQueueEdit(st: QueueEditState, io: { release(id: string): void; toComposer(text: string): void }): QueueEditStep {
  io.release(st.id)
  if (st.text.trim() && st.text !== st.original) { io.toComposer(st.text); return { next: null, notice: QUEUE_EDIT_EXPIRED_KEPT } }
  return { next: null, notice: QUEUE_EDIT_EXPIRED }
}
