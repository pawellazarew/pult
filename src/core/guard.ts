// Правило стража страны выхода (`network.guard` в config.json, 0.3.6). Чистые функции без зависимостей:
// их берут демон (config.ts, env/net.ts, settings.set), CLI и окно (ui/src/model/netGuard.ts).
//
// Два режима:
//   deny  — ход запрещён, если страна выхода В списке (так было всегда, список по умолчанию — DEFAULT_GUARD_COUNTRIES);
//   allow — ход разрешён, ТОЛЬКО если страна выхода в списке.
// Неизвестная страна (`loc` нет) — отказ в обоих режимах: проба, которая не может сказать, где мы, права на ход не даёт.
// Пустой список в allow запретил бы все ходы — `settings.set` такое не принимает (в файле — отказ всем ходам).

export type GuardMode = 'deny' | 'allow'
export const GUARD_MODES: readonly GuardMode[] = ['deny', 'allow']

export interface GuardRule {
  mode: GuardMode
  /** ISO 3166-1 alpha-2, заглавными, без повторов. */
  countries: string[]
}

/** Почему страж не пускает ход (или `ok`). `not_allowed_country` — режим allow, страны нет в списке. */
export type GuardReason = 'ok' | 'blocked_country' | 'not_allowed_country' | 'unknown_location'

/**
 * ISO 3166-1 alpha-2 — все официально назначенные коды (249) плюс `XK`: Cloudflare отдаёт им Косово в `loc=` трейса,
 * а проба стража читает именно его. Список вшит: окно и демон проверяют одно и то же без сети и без ICU.
 */
export const COUNTRY_CODES: readonly string[] = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'XK',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
]

const CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES)

/** Консервативный список-страж Пульта, НЕ официальный список провайдеров (DELTA v0.5 §1). Режим deny. */
export const DEFAULT_GUARD_COUNTRIES: readonly string[] = ['RU', 'BY', 'CN', 'IR', 'KP', 'SY', 'CU']

export function defaultGuard(): GuardRule {
  return { mode: 'deny', countries: [...DEFAULT_GUARD_COUNTRIES] }
}

export function isCountryCode(x: unknown): x is string {
  return typeof x === 'string' && CODE_SET.has(x)
}

/** Пускает ли правило ход с этой страной выхода. `loc` null — неизвестна: отказ в обоих режимах. */
export function guardVerdict(rule: GuardRule, loc: string | null | undefined): { ok: boolean; reason: GuardReason } {
  if (!loc) return { ok: false, reason: 'unknown_location' }
  const c = loc.toUpperCase()
  const listed = rule.countries.includes(c)
  if (rule.mode === 'allow') return listed ? { ok: true, reason: 'ok' } : { ok: false, reason: 'not_allowed_country' }
  return listed ? { ok: false, reason: 'blocked_country' } : { ok: true, reason: 'ok' }
}

export function sameGuard(a: GuardRule, b: GuardRule): boolean {
  return a.mode === b.mode && a.countries.length === b.countries.length && a.countries.every((c, i) => c === b.countries[i])
}

/** Правило одной строкой: `запрещать: RU, BY` / `разрешать только: DE, FI`. */
export function guardLine(rule: GuardRule): string {
  const list = rule.countries.length ? rule.countries.join(', ') : '(пусто)'
  return rule.mode === 'allow' ? `разрешать только: ${list}` : `запрещать: ${list}`
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

/**
 * Строгий разбор для `settings.set` и `pult net guard`: ровно `{mode, countries}`, режим deny|allow, коды — из
 * COUNTRY_CODES заглавными (повторы схлопываются), allow без стран — отказ. Любое отклонение — GuardError,
 * и тогда файл не трогается.
 */
export function parseGuardStrict(x: unknown): GuardRule {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new GuardError('network.guard — объект {mode, countries}')
  const o = x as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => k !== 'mode' && k !== 'countries')
  if (extra.length) throw new GuardError(`network.guard: лишние поля ${extra.join(', ')} — только mode и countries`)
  const mode = o['mode']
  if (mode !== 'deny' && mode !== 'allow') throw new GuardError('network.guard.mode — deny | allow')
  const list = o['countries']
  if (!Array.isArray(list)) throw new GuardError('network.guard.countries — список кодов стран ISO 3166-1 (DE, FI, …)')
  if (list.length > COUNTRY_CODES.length) throw new GuardError('network.guard.countries — слишком длинный список')
  const countries: string[] = []
  for (const c of list) {
    if (!isCountryCode(c)) throw new GuardError(`network.guard.countries: ${JSON.stringify(c)} — не код страны ISO 3166-1 alpha-2 (заглавными, например DE)`)
    if (!countries.includes(c)) countries.push(c)
  }
  if (mode === 'allow' && !countries.length) throw new GuardError('network.guard: в режиме allow нужна хотя бы одна страна — иначе ходы не пойдут никогда')
  return { mode, countries }
}

/**
 * Мягкий разбор `network.guard` из config.json: регистр и пробелы прощаются, незнакомые коды отбрасываются с
 * предупреждением. Режим кривой — null (возьмётся прежний `guardCountries` или умолчание). allow, в котором не
 * осталось стран, НЕ подменяется запретительным списком: человек сказал «только эти», значит закрыто — все ходы
 * получают отказ, пока список не поправят (так же, как `required` без прокси).
 */
export function parseGuardLenient(x: unknown): { rule: GuardRule | null; warnings: string[] } {
  const warnings: string[] = []
  if (x === null || typeof x !== 'object' || Array.isArray(x)) {
    return { rule: null, warnings: ['config.json: network.guard не объект {mode, countries} — правило не взято'] }
  }
  const o = x as Record<string, unknown>
  const mode = o['mode']
  if (mode !== 'deny' && mode !== 'allow') {
    return { rule: null, warnings: [`config.json: network.guard.mode = ${JSON.stringify(mode)} — не deny|allow, правило не взято`] }
  }
  const raw = o['countries']
  const countries: string[] = []
  if (!Array.isArray(raw)) {
    warnings.push('config.json: network.guard.countries не список — стран нет')
  } else {
    for (const c of raw) {
      const code = typeof c === 'string' ? c.trim().toUpperCase() : ''
      if (!isCountryCode(code)) { warnings.push(`config.json: network.guard.countries: ${JSON.stringify(c)} — не код страны ISO 3166-1, пропущено`); continue }
      if (!countries.includes(code)) countries.push(code)
    }
  }
  if (mode === 'allow' && !countries.length) {
    warnings.push('config.json: network.guard — режим allow без стран: все ходы запрещены, пока не добавишь страну («Настройки» → «Страж сети»)')
  }
  return { rule: { mode, countries }, warnings }
}
