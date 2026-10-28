// План 16, № 11: раздел «Правила „Всегда“» в «Настройках». Данные — `settings.get` → `codexRules` (src/perm/codexRules.ts),
// «Отозвать» — `settings.set {codexRules: {revoke: id}}`: оба метода уже в белом списке оболочки, Pult.app не меняется.

/** Правило с меткой Пульта — как его отдаёт демон (`CodexRule` в src/perm/codexRules.ts). */
export interface CodexRule {
  id: string
  at: string
  session: string
  cwd?: string
  kind: 'execpolicy' | 'network'
  label: string
}

/** `settings.get` → `codexRules`; нет поля — демон без правил «Всегда» (до плана 16, № 11), раздела нет. */
export interface CodexRulesList {
  path: string
  exists: boolean
  rules: CodexRule[]
  unmarked: number
  error?: string
}

/** Что разрешает правило — словами кнопки, которой его когда-то завели. */
export function ruleTitle(r: Pick<CodexRule, 'kind' | 'label'>): string {
  return r.kind === 'network' ? `Пускать в сеть к ${r.label}` : `Команды, начинающиеся с «${r.label}»`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** «29.10.2026 13:05» в часовом поясе машины; кривое время — как есть. */
export function ruleDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Строка под правилом: когда и из какой сессии; сессии уже нет — так и сказано. */
export function ruleMeta(r: CodexRule, sessionLabel?: (name: string) => string | null): string {
  const known = sessionLabel?.(r.session)
  const who = known ? `сессия ${known}` : `сессия ${r.session}${sessionLabel ? ' (удалена)' : ''}`
  return [ruleDate(r.at), who, ...(r.cwd ? [r.cwd] : [])].join(' · ')
}

/** Сколько строк в файле без метки Пульта — честно, что они есть и что Пульт их не трогает. */
export function unmarkedNote(n: number): string | null {
  if (n <= 0) return null
  return `Ещё ${n} ${plural(n, 'строка', 'строки', 'строк')} правил в файле без метки Пульта (их завели руками, codex CLI или прежний Пульт без меток) — их Пульт не показывает и не отзывает; убрать можно только руками.`
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** Параметры «Отозвать» для `settings.set`. */
export const revokeParams = (id: string): { codexRules: { revoke: string } } => ({ codexRules: { revoke: id } })
