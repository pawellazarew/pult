import { tr } from '../i18n/shared.js'
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
  const list = rule.countries.length ? rule.countries.join(', ') : tr('(пусто)')
  return rule.mode === 'allow' ? tr`разрешать только: ${list}` : tr`запрещать: ${list}`
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

/** Закрытое правило: allow без стран — каждый ход получает отказ. Так разбор файла отвечает на кривой `network.guard`. */
export function closedGuard(): GuardRule {
  return { mode: 'allow', countries: [] }
}

/**
 * Строгая форма правила: ровно `{mode, countries}` (собственные ключи; `__proto__`/`constructor` — лишние поля),
 * режим deny|allow, коды — из COUNTRY_CODES заглавными (повторы схлопываются). Пустой allow ЗДЕСЬ допустим: так
 * `settings.set` читает `expect` — правило, которое окно видело (оно может быть и закрытым).
 */
export function parseGuardShape(x: unknown, what = 'network.guard'): GuardRule {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new GuardError(tr`${what} — объект {mode, countries}`)
  const o = x as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => k !== 'mode' && k !== 'countries')
  if (extra.length) throw new GuardError(tr`${what}: лишние поля ${extra.join(', ')} — только mode и countries`)
  if (!Object.prototype.hasOwnProperty.call(o, 'mode') || !Object.prototype.hasOwnProperty.call(o, 'countries')) {
    throw new GuardError(tr`${what} — нужны оба поля: mode и countries`)
  }
  const mode = o['mode']
  if (mode !== 'deny' && mode !== 'allow') throw new GuardError(`${what}.mode — deny | allow`)
  const list = o['countries']
  if (!Array.isArray(list)) throw new GuardError(tr`${what}.countries — список кодов стран ISO 3166-1 (DE, FI, …)`)
  if (list.length > COUNTRY_CODES.length) throw new GuardError(tr`${what}.countries — слишком длинный список`)
  const countries: string[] = []
  for (const c of list) {
    if (!isCountryCode(c)) throw new GuardError(tr`${what}.countries: ${JSON.stringify(c)} — не код страны ISO 3166-1 alpha-2 (заглавными, например DE)`)
    if (!countries.includes(c)) countries.push(c)
  }
  return { mode, countries }
}

/**
 * Строгий разбор для `settings.set` и `pult net guard`: форма `parseGuardShape` плюс allow без стран — отказ. Любое
 * отклонение — GuardError, и тогда файл не трогается.
 */
export function parseGuardStrict(x: unknown): GuardRule {
  const rule = parseGuardShape(x)
  if (rule.mode === 'allow' && !rule.countries.length) throw new GuardError(tr('network.guard: в режиме allow нужна хотя бы одна страна — иначе ходы не пойдут никогда'))
  return rule
}

/** deny с пустым списком — страж выключен: пускается любая известная страна (неизвестная — по-прежнему нет). */
export function guardOff(rule: GuardRule): boolean {
  return rule.mode === 'deny' && rule.countries.length === 0
}

/**
 * Мягкий разбор `network.guard` из config.json: регистр и пробелы режима и кодов прощаются, незнакомые коды
 * отбрасываются с предупреждением. Всё, что правилом не разобрать (не объект, режим не deny|allow, `countries` не
 * список), — ЗАКРЫТО (`closedGuard`): человек написал правило стража, и тихий откат на запретительный список мог бы
 * пустить ходы оттуда, откуда он их не ждёт. allow, в котором не осталось стран, — тоже закрыто. Так же, как
 * `required` без прокси: все ходы получают отказ, `pult doctor` — fail, пока правило не поправят.
 */
export function parseGuardLenient(x: unknown): { rule: GuardRule; warnings: string[] } {
  const closed = (why: string): { rule: GuardRule; warnings: string[] } =>
    ({ rule: closedGuard(), warnings: [tr`config.json: network.guard ${why} — страж закрыт, все ходы запрещены, пока правило не поправят («Настройки» → «Страж сети» или pult net guard)`] })
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return closed(tr('не объект {mode, countries}'))
  const o = x as Record<string, unknown>
  const rawMode = typeof o['mode'] === 'string' ? (o['mode'] as string).trim().toLowerCase() : o['mode']
  if (rawMode !== 'deny' && rawMode !== 'allow') return closed(tr`: mode = ${JSON.stringify(o['mode'])} — не deny|allow`)
  const raw = o['countries']
  if (!Array.isArray(raw)) return closed(tr(': countries не список'))
  const warnings: string[] = []
  const countries: string[] = []
  for (const c of raw) {
    const code = typeof c === 'string' ? c.trim().toUpperCase() : ''
    if (!isCountryCode(code)) { warnings.push(tr`config.json: network.guard.countries: ${JSON.stringify(c)} — не код страны ISO 3166-1, пропущено`); continue }
    if (!countries.includes(code)) countries.push(code)
  }
  if (rawMode === 'allow' && !countries.length) {
    warnings.push(tr('config.json: network.guard — режим allow без стран: все ходы запрещены, пока не добавишь страну («Настройки» → «Страж сети»)'))
  }
  return { rule: { mode: rawMode, countries }, warnings }
}
