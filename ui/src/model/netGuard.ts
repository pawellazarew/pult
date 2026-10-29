import { getLanguage } from '../../../src/i18n/core.js'
import { t as tr } from '../lib/i18n.js'
// 0.3.6: «Настройки» → «Страж сети». Чистые функции: имена стран, поиск, черновик правила, выходы провайдеров
// под черновиком и предупреждение «с этими правилами сейчас ходы не пойдут». Проверка правила — та же, что у демона
// (`parseGuardStrict`, src/core/guard.ts): окно лишь говорит заранее то, что `settings.set` и так скажет.

import { COUNTRY_CODES, GuardError, guardOff, guardVerdict, parseGuardStrict, sameGuard } from '../../../src/core/guard.js'
import type { GuardMode, GuardRule } from '../../../src/core/guard.js'
import type { GuardCheck } from './health.js'

export type { GuardMode, GuardRule }
export { guardOff, sameGuard }

/** «Проверить сеть» — не чаще раза в столько: каждая проверка — проба к провайдерам по каждому пути. */
export const NET_CHECK_COOLDOWN_MS = 15_000

/** Провайдеры, у которых строка выхода есть всегда (opencode — только если его уже проверяли). */
const SHOWN: readonly string[] = ['claude', 'codex']
const ORDER: readonly string[] = ['claude', 'codex', 'opencode']

const namesByLanguage = new Map<string, { of(code: string): string | undefined } | null>()

/** Имя страны по-русски (`Intl.DisplayNames`); нет ICU или имени — сам код. */
export function countryName(code: string): string {
  const language = getLanguage()
  if (!namesByLanguage.has(language)) {
    try { namesByLanguage.set(language, new Intl.DisplayNames([language], { type: 'region' })) } catch { namesByLanguage.set(language, null) }
  }
  const names = namesByLanguage.get(language)
  let n: string | undefined
  try { n = names?.of(code) } catch { n = undefined }
  return n && n !== code ? n : code
}

/** «Германия (DE)»; имени нет — код. */
export function countryLabel(code: string): string {
  const n = countryName(code)
  return n === code ? code : `${n} (${code})`
}

const norm = (s: string): string => s.toLocaleLowerCase(getLanguage()).replace(/ё/g, 'е').trim()

/**
 * Поиск страны по имени (начало слова и подстрока, «ё» = «е») или по коду. Выбранные не предлагаются. Порядок:
 * точный код, начало имени, начало кода, подстрока имени; внутри — по алфавиту имён.
 */
export function searchCountries(query: string, selected: readonly string[], limit = 40): string[] {
  const q = norm(query)
  const pool = COUNTRY_CODES.filter((c) => !selected.includes(c))
  const byName = (a: string, b: string): number => countryName(a).localeCompare(countryName(b), getLanguage())
  if (!q) return [...pool].sort(byName).slice(0, limit)
  const up = q.toUpperCase()
  const ranked: Array<[number, string]> = []
  for (const c of pool) {
    const name = norm(countryName(c))
    const rank = c === up ? 0
      : name.startsWith(q) || name.split(/[\s-]+/).some((w) => w.startsWith(q)) ? 1
      : q.length <= 2 && c.startsWith(up) ? 2
      : name.includes(q) ? 3 : -1
    if (rank >= 0) ranked.push([rank, c])
  }
  ranked.sort((a, b) => a[0] - b[0] || byName(a[1], b[1]))
  return ranked.slice(0, limit).map(([, c]) => c)
}

/** Списки режимов, которые черновик помнит при переключении (у deny и allow они противоположны по смыслу). */
export type GuardStash = Partial<Record<GuardMode, string[]>>

/**
 * Смена режима. Список НЕ переезжает в другой режим: запретительный список как разрешающий значил бы «работать
 * только из RU, BY…». У каждого режима свой список: впервые выбранный режим — пустой, вернулись — прежний.
 */
export function switchGuardMode(rule: GuardRule, mode: GuardMode, stash: GuardStash): { rule: GuardRule; stash: GuardStash } {
  if (mode === rule.mode) return { rule, stash }
  return { rule: { mode, countries: [...(stash[mode] ?? [])] }, stash: { ...stash, [rule.mode]: [...rule.countries] } }
}

export function addCountry(rule: GuardRule, code: string): GuardRule {
  return rule.countries.includes(code) ? rule : { mode: rule.mode, countries: [...rule.countries, code] }
}

export function removeCountry(rule: GuardRule, code: string): GuardRule {
  return { mode: rule.mode, countries: rule.countries.filter((c) => c !== code) }
}

/** Ошибка черновика словами; `null` — можно сохранять. */
export function guardDraftError(rule: GuardRule): string | null {
  if (rule.mode === 'allow' && !rule.countries.length) return tr('Страж сети: в режиме «Разрешать только» нужна хотя бы одна страна')
  try {
    parseGuardStrict(rule)
    return null
  } catch (e) {
    return e instanceof GuardError ? tr`Страж сети: ${e.message.replace(/^network\.guard[.:]?\s*/, '')}` : String(e)
  }
}

/** Последние выходы из `settings.get` (`network.exits`) — в форме проверок стража. */
export function guardFromExits(exits: Record<string, { loc?: string | null; path?: string; reason?: string; checkedAt?: string } | undefined> | undefined): GuardCheck[] {
  if (!exits) return []
  const out: GuardCheck[] = []
  for (const [provider, e] of Object.entries(exits)) {
    if (!e || typeof e.checkedAt !== 'string') continue
    out.push({ provider, loc: typeof e.loc === 'string' ? e.loc : null, ok: e.reason === 'ok', reason: e.reason ?? 'ok', checkedAt: e.checkedAt })
  }
  return out
}

export interface ExitRow {
  provider: string
  loc: string | null
  /** Пустит ли ЧЕРНОВИК правила ход этим выходом; null — выход ещё не проверялся. */
  ok: boolean | null
  text: string
  checkedAt: string | null
}

const PATH_REASON: Record<string, string> = {
  proxy_dead: tr('прокси не отвечает'),
  no_proxy: tr('режим required без прокси'),
  unknown_location: tr('страну определить не удалось'),
}

/** Строки «claude: выход Германия (DE) — проходит» под черновиком правила; свежайшая проверка на провайдера. */
export function exitRows(rule: GuardRule, checks: readonly GuardCheck[]): ExitRow[] {
  const latest = new Map<string, GuardCheck>()
  for (const c of checks) {
    const had = latest.get(c.provider)
    if (!had || Date.parse(c.checkedAt) >= Date.parse(had.checkedAt)) latest.set(c.provider, c)
  }
  const providers = ORDER.filter((p) => SHOWN.includes(p) || latest.has(p))
  return providers.map((p): ExitRow => {
    const c = latest.get(p)
    if (!c) return { provider: p, loc: null, ok: null, text: tr`${p}: выход не проверялся`, checkedAt: null }
    if (!c.loc) {
      return { provider: p, loc: null, ok: false, text: tr`${p}: выход неизвестен (${PATH_REASON[c.reason] ?? c.reason}) — не проходит`, checkedAt: c.checkedAt }
    }
    const v = guardVerdict(rule, c.loc)
    return { provider: p, loc: c.loc, ok: v.ok, text: tr`${p}: выход ${countryLabel(c.loc)} — ${v.ok ? tr('проходит') : tr('не проходит')}`, checkedAt: c.checkedAt }
  })
}

/** Известный выход, который черновик правила НЕ пустит: «С этими правилами сейчас ходы не пойдут: claude (выход DE)». */
export function refusedWarning(rows: readonly ExitRow[]): string | null {
  const bad = rows.filter((r) => r.loc && r.ok === false)
  if (!bad.length) return null
  return tr`С этими правилами сейчас ходы не пойдут: ${bad.map((r) => tr`${r.provider} (выход ${r.loc})`).join(', ')}`
}

/** «Проверить сеть» доступна: проверка не идёт и прошлая была раньше паузы. */
export function canCheckNet(checking: boolean, cooldownUntil: number, now: number): boolean {
  return !checking && now >= cooldownUntil
}
