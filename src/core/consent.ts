// Согласие на полный доступ (быстрый старт, шаг A; design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.6).
//
// ЗАЧЕМ ФАЙЛ, А НЕ ФЛАГ ОКНА. Раньше «полный доступ» подтверждался на каждом чате: окно слало `confirm: true`, а
// демон верил булеву флагу (ревью Codex B2). Теперь человек соглашается ОДИН раз, и это согласие лежит у демона
// (`PULT_HOME/consent.json`, 0600). Демон сам сверяется с ним в каждой точке применения — `agent.start`,
// `agent.configure`, снимок каждого хода, resume, — поэтому устаревшее окно или отзыв в «Настройках» не дают
// полному доступу «дожить» до следующего хода.
//
// ЧЕГО ФАЙЛ НЕ ДЕЛАЕТ. Это не граница безопасности против локальных процессов: сокет демона доступен любому процессу
// владельца, а `client: 'shell'` — самоназвание (docs/DEV.md, «модель угроз»). Согласие защищает от опечатки и от
// устаревшего окна, как и `--yes` у CLI. Разовое `--yes` сюда не пишется (`grant: 'cli-once'` в записи сессии).
//
// `rev` растёт на каждой записи: окно передаёт `consentRev`, который видело, и при расхождении получает
// `consent_changed` — то есть «согласие дали или отозвали, пока ты смотрел старую картинку».

import { readFileSync, statSync } from 'node:fs'
import { atomicWrite } from '../service/fsutil.js'

/** Версия текста согласия. Поднимается, когда диалог обещает другое: старое согласие тогда не действует. */
export const CONSENT_VERSION = 1

export type ConsentProvider = 'claude' | 'codex'

/** Провайдеры, которых называет диалог согласия: одно согласие на обоих (решение лида 3). */
export const CONSENT_PROVIDERS: readonly ConsentProvider[] = ['claude', 'codex']

export interface Consent {
  version: number
  /** Номер записи файла: растёт на каждом согласии и отзыве. Нет файла — 0. */
  rev: number
  /** Охваченные провайдеры; после отзыва — пусто. */
  providers: ConsentProvider[]
  grantedAt?: string
  revokedAt?: string
}

const isProvider = (x: unknown): x is ConsentProvider => x === 'claude' || x === 'codex'

/** Разбор не верит файлу: кривое поле — согласия нет (тише, а не шире). `rev` берётся, если он целый. */
export function parseConsent(raw: unknown): Consent {
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const rev = typeof o['rev'] === 'number' && Number.isSafeInteger(o['rev']) && o['rev'] >= 0 ? o['rev'] : 0
  const version = typeof o['version'] === 'number' && Number.isSafeInteger(o['version']) ? o['version'] : 0
  const providers = Array.isArray(o['providers']) ? [...new Set(o['providers'].filter(isProvider))] : []
  const at = (k: string): string | undefined => (typeof o[k] === 'string' && Number.isFinite(Date.parse(o[k] as string)) ? o[k] as string : undefined)
  const grantedAt = at('grantedAt')
  const revokedAt = at('revokedAt')
  return { version, rev, providers, ...(grantedAt ? { grantedAt } : {}), ...(revokedAt ? { revokedAt } : {}) }
}

/** Действует ли согласие для провайдера: текущая версия, провайдер назван, не отозвано. */
export function consentCovers(c: Consent, provider: ConsentProvider): boolean {
  return !c.revokedAt && !!c.grantedAt && c.version >= CONSENT_VERSION && c.providers.includes(provider)
}

/** Как окно и CLI видят согласие (без лишнего): действует ли, для кого, с какого времени, номер записи. */
export interface ConsentView {
  rev: number
  version: number
  current: number
  granted: boolean
  providers: ConsentProvider[]
  grantedAt?: string
  revokedAt?: string
}

export function consentView(c: Consent): ConsentView {
  const granted = !c.revokedAt && !!c.grantedAt && c.version >= CONSENT_VERSION && c.providers.length > 0
  return {
    rev: c.rev, version: c.version, current: CONSENT_VERSION, granted, providers: granted ? [...c.providers] : [],
    ...(c.grantedAt ? { grantedAt: c.grantedAt } : {}), ...(c.revokedAt ? { revokedAt: c.revokedAt } : {}),
  }
}

export interface ConsentStore {
  /** Согласие с диска: перечитывается, когда файл сменился, — ручная правка или удаление действуют сразу. */
  read(): Consent
  grant(providers: readonly ConsentProvider[], now?: Date): Consent
  revoke(now?: Date): Consent
}

export function createConsentStore(file: string): ConsentStore {
  // Наибольший виденный номер записи: файл удалили или испортили — следующая запись всё равно получит номер больше,
  // и окно со старым `consentRev` не совпадёт с новым согласием случайно.
  let seenRev = 0
  // Ревью PR #39, m5: `agent.list` раз в 4 с спрашивает согласие у каждой сессии — файл перечитывается, только когда
  // сменился (inode, размер, mtime/ctime в наносекундах): ручная правка или удаление по-прежнему действуют сразу.
  let cached: { key: string; c: Consent } | null = null
  const read = (): Consent => {
    let key = 'none'
    try {
      const st = statSync(file, { bigint: true })
      key = `${st.ino}|${st.size}|${st.mtimeNs}|${st.ctimeNs}`
    } catch { /* нет файла */ }
    if (cached && cached.key === key) return cached.c
    let c: Consent
    try { c = parseConsent(JSON.parse(readFileSync(file, 'utf8'))) } catch { c = { version: 0, rev: 0, providers: [] } }
    if (c.rev > seenRev) seenRev = c.rev
    cached = { key, c }
    return c
  }
  const write = (c: Consent): Consent => {
    atomicWrite(file, JSON.stringify(c, null, 2) + '\n', 0o600)
    seenRev = c.rev
    cached = null
    return c
  }
  return {
    read,
    grant(providers, now = new Date()) {
      const prev = read()
      const list = CONSENT_PROVIDERS.filter((p) => providers.includes(p))
      return write({ version: CONSENT_VERSION, rev: Math.max(prev.rev, seenRev) + 1, providers: list, grantedAt: now.toISOString() })
    },
    revoke(now = new Date()) {
      const prev = read()
      return write({ version: prev.version || CONSENT_VERSION, rev: Math.max(prev.rev, seenRev) + 1, providers: [], revokedAt: now.toISOString() })
    },
  }
}
