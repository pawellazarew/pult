// Шапка и панель doctor: страж сети, остановленные провайдеры, пункты доктора. Чистые функции.
//
// СТРАЖ (docs/12 §3 п.4): страна выхода и время проверки. Два источника, берётся свежий:
// пункты `net.<провайдер>` из `doctor.run` (data.loc, data.checkedAt) и события `net.blocked`
// (страж отказал ходу — это тоже проверка, и она свежее доктора).

import type { AgentProvider, DoctorItem, DoctorReport, PultEvent, Tone } from './types.js'
import type { ProviderReadiness } from './types.js'
import { str } from './types.js'

export interface GuardCheck {
  provider: string
  loc: string | null
  ok: boolean
  reason: string
  checkedAt: string
}

export interface GuardView {
  tone: Tone
  label: string
  checkedAt: string | null
  detail: string
}

/** Проверки стража из отчёта доктора. */
export function guardFromDoctor(report: DoctorReport | null): GuardCheck[] {
  if (!report) return []
  const out: GuardCheck[] = []
  for (const it of report.items) {
    if (!it.id.startsWith('net.')) continue
    const d = it.data ?? {}
    out.push({
      provider: it.id.slice(4),
      loc: str(d['loc']) ?? null,
      ok: it.status !== 'fail',
      reason: str(d['reason']) ?? (it.status === 'fail' ? 'blocked' : 'ok'),
      checkedAt: str(d['checkedAt']) ?? report.generatedAt,
    })
  }
  return out
}

/** Отказ стража из события `net.blocked`. */
export function guardFromEvent(ev: PultEvent): GuardCheck | null {
  if (ev.kind !== 'net.blocked') return null
  return {
    provider: ev.provider,
    loc: str(ev.data['loc']) ?? null,
    ok: false,
    reason: str(ev.data['reason']) ?? 'blocked',
    checkedAt: ev.ts,
  }
}

/** Свежайшая проверка на провайдера, затем сводка: хоть один отказ — красный. */
export function guardView(checks: readonly GuardCheck[]): GuardView {
  const latest = new Map<string, GuardCheck>()
  for (const c of checks) {
    const had = latest.get(c.provider)
    if (!had || Date.parse(c.checkedAt) >= Date.parse(had.checkedAt)) latest.set(c.provider, c)
  }
  const all = [...latest.values()]
  if (!all.length) return { tone: 'queued', label: 'не проверен', checkedAt: null, detail: 'страж ещё не проверял сеть — открой doctor' }
  const bad = all.filter((c) => !c.ok)
  const newest = all.reduce((a, b) => (Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a))
  const locs = [...new Set(all.map((c) => c.loc ?? '??'))].join('/')
  if (bad.length) {
    const b = bad[0] as GuardCheck
    return {
      tone: 'fail',
      label: `выход ${b.loc ?? '??'} — стоп`,
      checkedAt: b.checkedAt,
      detail: `${bad.map((c) => c.provider).join(', ')}: ${b.reason === 'blocked_country' ? 'страна в списке-страже — подними VPN'
        : b.reason === 'not_allowed_country' ? 'страны нет в списке разрешённых — смени выход или «Настройки» → «Страж сети»' : `${b.reason} — подними VPN`}`,
    }
  }
  return { tone: 'ok', label: `выход ${locs}`, checkedAt: newest.checkedAt, detail: all.map((c) => `${c.provider}: ${c.loc ?? '??'}`).join(' · ') }
}

export interface ProviderBlock { provider: AgentProvider; reason?: string }

/** Остановленные провайдеры из `daemon.status.providers` (у старого демона поля нет — пусто). */
export function blockedProviders(providers: Record<string, { blocked: boolean; reason?: string }> | undefined): ProviderBlock[] {
  if (!providers) return []
  const out: ProviderBlock[] = []
  for (const p of ['claude', 'codex'] as const) {
    const s = providers[p]
    if (s?.blocked) out.push({ provider: p, ...(s.reason ? { reason: s.reason } : {}) })
  }
  return out
}

export interface DoctorGroup { title: string; items: DoctorItem[] }

const GROUPS: Array<[string, (id: string) => boolean]> = [
  ['Требует внимания', () => false],
  ['Сеть', (id) => id.startsWith('net.') || id === 'guard.rule'],
  ['CLI, вход и подписки', (id) => id.startsWith('cli.') || id.startsWith('login.') || id.startsWith('subscription.') || id.startsWith('codex.')],
  ['Демон, служба, версии', (id) => id.startsWith('daemon') || id.startsWith('service') || id.startsWith('version.') || id.startsWith('node.') || id.startsWith('home.')],
]

/** Пункты доктора: сначала провалы и предупреждения (с командой «почини»), потом остальное по группам. */
export function doctorGroups(report: DoctorReport | null): DoctorGroup[] {
  if (!report) return []
  const bad = report.items.filter((i) => i.status !== 'ok')
  const good = report.items.filter((i) => i.status === 'ok')
  const out: DoctorGroup[] = []
  if (bad.length) out.push({ title: (GROUPS[0] as [string, unknown])[0], items: [...bad].sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1)) })
  const rest = [...good]
  for (const [title, match] of GROUPS.slice(1)) {
    const items = rest.filter((i) => match(i.id))
    if (items.length) out.push({ title, items })
    for (const i of items) rest.splice(rest.indexOf(i), 1)
  }
  if (rest.length) out.push({ title: 'Прочее', items: rest })
  return out
}

export function doctorTone(report: DoctorReport | null): Tone {
  if (!report) return 'queued'
  if (report.counts.fail > 0) return 'fail'
  if (report.counts.warn > 0) return 'wait'
  return 'ok'
}

/**
 * Статус провайдера в шапке — одно короткое слово рядом с именем. Полный текст и команда починки —
 * в подсказке: шапка высотой 50 px, длинная строка «Вход выполнен · готов» под шкалами обрезалась.
 */
export interface ProviderStatusView { label: string; tone: Tone | 'mut'; title: string }
const READINESS: Record<ProviderReadiness['state'], { label: string; tone: Tone }> = {
  ready: { label: 'готов', tone: 'ok' },
  login_required: { label: 'нужен вход', tone: 'wait' },
  unavailable: { label: 'нет CLI', tone: 'fail' },
  error: { label: 'ошибка', tone: 'fail' },
}
export function providerStatusView(r: ProviderReadiness | undefined, checking: boolean): ProviderStatusView {
  if (checking) return { label: 'проверяю', tone: 'mut', title: 'Проверяю вход и CLI…' }
  if (!r) return { label: 'проверить', tone: 'mut', title: 'Проверить вход и CLI' }
  const v = READINESS[r.state]
  return { ...v, title: `${r.detail}${r.fixCmd ? ` — починить: ${r.fixCmd}` : ''}. Клик — проверить ещё раз` }
}
