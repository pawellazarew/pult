// M8e: реплика «отправляется…». Поле ввода чистится сразу по Enter, а реплика встаёт в ленту бледным пузырём,
// пока демон её не подтвердит. Почему не ждать ответа `agent.prompt`: демон отвечает, когда ход ЗАПУЩЕН —
// после проверки стража сети (curl до api.anthropic.com, 0,25–0,4 с, раз в минуту простоя; висящий прокси —
// до 8 с), `resume` и у Codex рукопожатия app-server (0,3–1 с холодным) и `thread/resume`. А `message.user`
// демон пишет в журнал ДО всего этого — оно и есть подтверждение. Чистые функции; состояние держит Console.

import type { PromptAttachment } from '../../../src/core/promptAttachments.js'
import type { ConvItem } from './conversation.js'

/** Отправленная окном реплика, которую демон ещё не подтвердил. */
export interface PendingSend {
  /** Сессия. */
  name: string
  /** Текст, как ушёл (без обрезки по краям). */
  text: string
  attachments?: readonly PromptAttachment[]
  /** Время нажатия — подпись пузыря. */
  ts: string
  /**
   * Последний номер журнала, известный окну в момент отправки. Подтверждение — реплика человека этой сессии
   * с номером больше: в ленте она уже настоящая, бледный пузырь убирается (дубля нет).
   */
  afterId: number
  /** `sending` — `agent.prompt` в пути; `sent` — демон ответил «принято», ждём только событие. */
  phase: 'sending' | 'sent'
  /** Рисовать ли в ленте. Реплика, которая встанет в очередь демона, ждёт в очереди под полем, а не в ленте. */
  inFeed: boolean
  /** Номер отправки: ответ старой отправки не трогает новую. */
  nonce: number
}

/** `sent`, а события так и нет (старый демон, обрыв потока): столько ждём и убираем пузырь. */
export const PENDING_SENT_MAX_MS = 5000

/**
 * Пришла ли в ленту реплика человека новее `afterId`. Лента идёт по возрастанию номеров (ранние страницы
 * истории — в голове), реплика человека — всегда в корне: смотрим с хвоста до первого старого номера.
 */
export function pendingConfirmed(items: readonly ConvItem[], afterId: number): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ConvItem
    if (it.id <= afterId) return false
    if (it.type === 'user') return true
  }
  return false
}

/** Бледный пузырь в ленте этой сессии — или `null`: нет отправки, чужая сессия, очередь, уже подтверждена. */
export function pendingBubble(p: PendingSend | null, name: string, items: readonly ConvItem[]): { text: string; ts: string; attachments?: readonly PromptAttachment[] } | null {
  if (!p || p.name !== name || !p.inFeed || pendingConfirmed(items, p.afterId)) return null
  return { text: p.text, ts: p.ts, ...(p.attachments?.length ? { attachments: p.attachments } : {}) }
}

/**
 * Встанет ли реплика в очередь демона, а не в ход сразу (`manager.say`: `queue` и сессия занята — ход, ждёт
 * человека — или очередь не пуста и не стоит). Только чтобы не рисовать пузырь в ленте: решает всё равно демон.
 */
export function willQueue(mode: 'queue' | 'interrupt' | undefined, s: { busy: boolean; needsYou: boolean; queueLen: number; queuePaused: boolean }): boolean {
  return mode === 'queue' && (s.busy || s.needsYou || (s.queueLen > 0 && !s.queuePaused))
}

/**
 * Отказ демона (`updating`, страж, таймаут «прервать и сказать», очередь): отвергнутый текст НЕ теряется никогда.
 * Поле пустое — черновик возвращается как был; в поле уже набрано новое — отвергнутое встаёт ПЕРВЫМ, через пустую
 * строку, а набранное остаётся под ним. `caret` — конец возвращённого куска (там человек и продолжит).
 */
export function restoreDraft(current: string, draft: string): { text: string; caret: number } {
  if (current.trim() === '') return { text: draft, caret: draft.length }
  return { text: `${draft}\n\n${current}`, caret: draft.length }
}

/**
 * Отправка из поля (M8e): поле чистится СРАЗУ, реплика уходит; отказ — `restoreDraft` от того, что в поле СЕЙЧАС.
 * Вынесено из компонента ради теста без DOM: `io` — поле ввода и отправка.
 */
export async function sendFromComposer(
  draft: string,
  io: { clear(): void; send(text: string): Promise<boolean>; current(): string | null; restore(text: string, caret: number): void },
): Promise<boolean> {
  const t = draft.trim()
  if (!t) return false
  io.clear()
  if (await io.send(t)) return true
  const cur = io.current()
  // Поля нет (ушёл на другую сессию — у неё своё поле): возвращать некуда, ошибка видна под полем.
  if (cur !== null) { const r = restoreDraft(cur, draft); io.restore(r.text, r.caret) }
  return false
}
