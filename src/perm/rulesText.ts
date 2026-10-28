// Тексты правил «Всегда» для CLI и окна — без зависимостей от node: этот модуль берёт и бандл интерфейса.

/** Что стало с Codex после отзыва: перезапущен сразу, перезапустится после ходов, не был запущен. */
export type CodexReload = 'restarted' | 'deferred' | 'not_running'

export interface RevokeOutcome {
  rule: { id: string; kind: 'execpolicy' | 'network'; label: string }
  /** Сколько других строк (в этом файле и в соседних *.rules) всё ещё разрешают то же самое. */
  stillAllowedBy: number
  codex: CodexReload
}

/** Правило словами кнопки, которой его завели. */
export function ruleWords(r: { kind: string; label: string }): string {
  return r.kind === 'network' ? `пускать в сеть к ${r.label}` : `команды, начинающиеся с «${r.label}»`
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** Что сказать человеку после отзыва — точное поведение Codex, а не «может помнить». */
export function revokeSummary(o: RevokeOutcome): string {
  const codex = o.codex === 'restarted'
    ? 'Codex перезапущен — правило больше не действует; разговоры продолжатся с того же места.'
    : o.codex === 'deferred'
      ? 'Идёт ход Codex: до его конца правило ещё действует, потом Пульт перезапустит Codex сам.'
      : 'Codex не запущен — правило больше не действует.'
  const still = o.stillAllowedBy > 0
    ? ` Но то же самое ещё разрешено ${o.stillAllowedBy} ${plural(o.stillAllowedBy, 'другой строкой', 'другими строками', 'другими строками')} правил Codex — их Пульт не трогает.`
    : ''
  return `Отозвано: ${ruleWords(o.rule)}. ${codex}${still}`
}
