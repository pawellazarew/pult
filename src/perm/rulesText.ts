import { t } from '../cli/i18n.js'
import { getLanguage } from '../i18n/core.js'
// Тексты правил «Всегда» для CLI и окна — без зависимостей от node: этот модуль берёт и бандл интерфейса.

/** Что стало с Codex после отзыва: перезапущен сразу, перезапустится после ходов, не был запущен. */
export type CodexReload = 'restarted' | 'deferred' | 'not_running'

export interface RevokeOutcome {
  rule: { id: string; kind: 'execpolicy' | 'network'; label: string }
  /** Сколько других строк (в этом файле и в соседних *.rules) всё ещё разрешают то же самое. */
  stillAllowedBy: number
  codex: CodexReload
  /** `deferred`: что держит Codex словами (ход, фон, вопрос, спавн). */
  busy?: string
}

/** Правило словами кнопки, которой его завели. */
export function ruleWords(r: { kind: string; label: string }): string {
  return r.kind === 'network' ? t`пускать в сеть к ${r.label}` : t`команды, начинающиеся с «${r.label}»`
}

const plural = (n: number, one: string, few: string, many: string): string => {
  if (getLanguage() === 'en') return n === 1 ? one : many
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** Что сказать человеку после отзыва — точное поведение Codex, а не «может помнить». */
export function revokeSummary(o: RevokeOutcome): string {
  // Перезапуск сбрасывает и «в этой сессии» у всех сессий Codex; codex вне Пульта Пульт не перезапускает (ревью #30).
  const caveat = t('разрешения «в этой сессии» у всех сессий Codex сброшены — Codex спросит заново')
  const outside = t('codex, запущенный вне Пульта (терминал, IDE), держит правило до своего перезапуска')
  const codex = o.codex === 'restarted'
    ? t`Codex в Пульте перезапущен — правило больше не действует; разговоры продолжатся с того же места, но ${caveat}; ${outside}.`
    : o.codex === 'deferred'
      ? t`Codex занят (${o.busy ?? t('идёт ход')}): пока он не освободится, правило в нём ещё действует; потом Пульт перезапустит Codex, и ${caveat}.`
      : t`Codex в Пульте не запущен — правило больше не действует; ${outside}.`
  const still = o.stillAllowedBy > 0
    ? t` Но то же самое ещё разрешено ${o.stillAllowedBy} ${plural(o.stillAllowedBy, t('другой строкой'), t('другими строками'), t('другими строками'))} правил Codex — их Пульт не трогает.`
    : ''
  return t`Отозвано: ${ruleWords(o.rule)}. ${codex}${still}`
}
