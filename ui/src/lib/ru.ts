import { getLanguage } from '../../../src/i18n/core.js'
// Русские числительные: «1 сбой, 3 сбоя, 5 сбоев». Без помощника счётчик с фиксированным словом
// читался неграмотно для любого числа, кроме единицы («3 сбой»).

/** Форма слова для `n`: `one` — 1, 21, 101…; `few` — 2–4, 22–24…; `many` — остальное (5–20, 11–14…). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (getLanguage() === 'en') return Math.abs(n) === 1 ? one : many
  const a = Math.abs(Math.trunc(n))
  const d = a % 10
  const dd = a % 100
  if (d === 1 && dd !== 11) return one
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few
  return many
}
