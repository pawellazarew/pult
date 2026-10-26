// Профиль сети и страж страны выхода. Инвариант 2, правило DELTA v0.5 §1.
//
// ДОРОГОЙ УРОК 21.09 (docs/06-DELTA-v0.5-spike-claude.md §1): состояние локального порта НЕ
// говорит о состоянии VPN ни в одну сторону. За один час наблюдались оба расхождения: порт
// открыт, а туннель мёртв; порт закрыт, а выход — Германия. Поэтому:
//   * проба прокси — НАСТОЯЩИЙ запрос через него, не TCP-коннект к порту;
//   * единственная проверка перед ходом — СТРАНА ВЫХОДА тем же путём, которым пойдёт ребёнок;
//   * `loc` неизвестен = заблокировано. Проба, которая не может сказать, где мы, не даёт права тратить ход.
//
// ПОЧЕМУ curl, а не fetch: через прокси должен пойти ТОТ ЖЕ путь, что у дочернего `claude`
// (HTTPS_PROXY → CONNECT), а глобальный fetch в Node без зависимостей прокси не умеет. Проба
// инъецируется — тест не ходит в сеть вообще.

import { spawn } from 'node:child_process'
import type { NetMode, ProviderName } from '../core/config.js'
import { buildChildEnv } from './allowlist.js'

export const EGRESS_URLS = [
  'https://api.anthropic.com/cdn-cgi/trace',
  'https://cloudflare.com/cdn-cgi/trace',
] as const

/** Что ребёнок всегда ходит мимо прокси: свой Пульт и локальные серверы. */
export const BASE_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1']

/** `NO_PROXY` ребёнка: localhost плюс `network.<провайдер>.noProxy`, без повторов. */
export function noProxyValue(extra: readonly string[] = []): string {
  return [...new Set([...BASE_NO_PROXY, ...extra])].join(',')
}

export const PROBE_TIMEOUT_MS = 8000
export const CACHE_TTL_MS = 60_000

export type NetPath = 'proxy' | 'direct' | 'none'
export type NetReason = 'ok' | 'proxy_dead' | 'blocked_country' | 'unknown_location' | 'no_proxy'

export interface ProbeResult {
  status: number | null
  stdout: string
  stderr: string
}

export type ProbeFn = (url: string, proxy: string | null, timeoutMs: number) => Promise<ProbeResult>

export interface NetAttempt {
  path: NetPath
  url: string
  proxy: string | null
  exit: number | null
  loc: string | null
}

export interface NetCheck {
  provider: ProviderName
  mode: NetMode
  /** Каким путём пойдёт ребёнок. `none` — ход запрещён. */
  path: NetPath
  proxy: string | null
  loc: string | null
  /** Разрешает ли страж запускать ход. */
  ok: boolean
  reason: NetReason
  /** Режим auto откатился с прокси на прямой путь. */
  fellBack: boolean
  /** `network.<провайдер>.noProxy` профиля — добавка к localhost в `NO_PROXY` ребёнка. */
  noProxy?: string[]
  guard: string[]
  attempts: NetAttempt[]
  ms: number
  checkedAt: string
  cached: boolean
}

/**
 * Аргументы пробы.
 * `-q` ПЕРВЫМ: без него curl читает `~/.curlrc`, и строка `proxy = …` в нём уводит пробу
 * прямого пути через прокси, о котором Пульт ничего не знает. Страж тогда одобряет страну
 * прокси, а ребёнок идёт напрямую совсем в другую.
 * Прокси задаётся ЯВНО в обоих случаях: пустая строка отключает его насовсем.
 */
export function curlArgs(url: string, proxy: string | null, timeoutMs: number): string[] {
  return ['-q', '-s', '-m', String(Math.ceil(timeoutMs / 1000)), '-x', proxy ?? '', url]
}

/** curl с окружением по белому списку — тем же, что получит ребёнок. */
export const curlProbe: ProbeFn = (url, proxy, timeoutMs) =>
  new Promise<ProbeResult>((resolve) => {
    const args = curlArgs(url, proxy, timeoutMs)
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn('curl', args, { env: buildChildEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: String((e as Error).message) })
      return
    }
    const kill = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* уже мёртв */ } }, timeoutMs + 2000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (e) => { clearTimeout(kill); resolve({ status: null, stdout, stderr: String(e.message) }) })
    child.on('close', (code) => { clearTimeout(kill); resolve({ status: code, stdout, stderr }) })
  })

export function parseLoc(body: string): string | null {
  const m = /^loc=([A-Za-z]{2})\s*$/m.exec(body)
  return m && m[1] ? m[1].toUpperCase() : null
}

export interface NetOptions {
  probe?: ProbeFn
  now?: () => number
  timeoutMs?: number
  urls?: readonly string[]
  /** Пропустить кэш: ручной `pult doctor` всегда хочет свежий ответ. */
  fresh?: boolean
}

interface CacheEntry {
  at: number
  check: NetCheck
}

const cache = new Map<string, CacheEntry>()

export function clearNetCache(): void {
  cache.clear()
}

async function traceVia(
  path: NetPath,
  proxy: string | null,
  probe: ProbeFn,
  timeoutMs: number,
  urls: readonly string[],
  attempts: NetAttempt[],
): Promise<string | null> {
  for (const url of urls) {
    const r = await probe(url, proxy, timeoutMs)
    // Страну засчитываем ТОЛЬКО у пробы, которая доехала целиком. Оборванный ответ (код 28 —
    // таймаут, 56 — разрыв) может содержать строку `loc=` из первой половины тела, и такая
    // «успешная» проба выдавала бы разрешение на ход по мёртвому маршруту.
    const loc = r.status === 0 ? parseLoc(r.stdout) : null
    attempts.push({ path, url, proxy, exit: r.status, loc })
    if (loc) return loc
  }
  return null
}

/**
 * Проверяет сеть для провайдера и решает, можно ли делать ход.
 * Результат кэшируется на 60 с: страж стоит перед каждым ходом после простоя, и платить
 * за 200 мс на каждой реплике незачем.
 */
export async function checkNetwork(
  provider: ProviderName,
  profile: { mode: NetMode; proxy: string; noProxy?: string[] },
  guardCountries: string[],
  opts: NetOptions = {},
): Promise<NetCheck> {
  const now = opts.now ?? Date.now
  const noProxy = profile.noProxy ?? []
  // noProxy в ключе: проба от него не зависит, но результат несёт его ребёнку — правка конфига
  // не должна ждать минуту, пока истечёт кэш.
  const key = `${provider}|${profile.mode}|${profile.proxy}|${guardCountries.join(',')}|${noProxy.join(',')}`
  if (!opts.fresh) {
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_TTL_MS) return { ...hit.check, cached: true }
  }

  const probe = opts.probe ?? curlProbe
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const urls = opts.urls ?? EGRESS_URLS
  const guard = guardCountries.map((c) => c.toUpperCase())
  const t0 = now()
  const attempts: NetAttempt[] = []

  let path: NetPath
  let proxy: string | null
  let loc: string | null = null
  let fellBack = false

  // Профиль без адреса прокси (собран мимо validateConfig): `auto` — прямой путь, а не `curl -x ''`,
  // который пошёл бы напрямую под ярлыком «прокси»; `required` — ниже, проба прокси не найдёт страну.
  if (profile.mode === 'off' || (profile.mode === 'auto' && !profile.proxy)) {
    path = 'direct'
    proxy = null
    loc = await traceVia('direct', null, probe, timeoutMs, urls, attempts)
  } else {
    // `required` без адреса прокси — закрыто, без проб: прямой путь здесь запрещён, а прокси пробовать не на чем.
    if (profile.mode === 'required' && !profile.proxy) {
      const check: NetCheck = {
        provider, mode: profile.mode, path: 'none', proxy: null, loc: null,
        ok: false, reason: 'no_proxy', fellBack: false, guard, attempts, noProxy,
        ms: now() - t0, checkedAt: new Date().toISOString(), cached: false,
      }
      cache.set(key, { at: now(), check })
      return check
    }
    // И в auto, и в required сначала пробуем прокси — НАСТОЯЩИМ запросом.
    loc = profile.proxy ? await traceVia('proxy', profile.proxy, probe, timeoutMs, urls, attempts) : null
    if (loc) {
      path = 'proxy'
      proxy = profile.proxy
    } else if (profile.mode === 'required') {
      const check: NetCheck = {
        provider, mode: profile.mode, path: 'none', proxy: profile.proxy, loc: null,
        ok: false, reason: 'proxy_dead', fellBack: false, guard, attempts, noProxy,
        ms: now() - t0, checkedAt: new Date().toISOString(), cached: false,
      }
      cache.set(key, { at: now(), check })
      return check
    } else {
      // auto: прокси не отвечает — идём напрямую, но страж действует и здесь.
      fellBack = true
      path = 'direct'
      proxy = null
      loc = await traceVia('direct', null, probe, timeoutMs, urls, attempts)
    }
  }

  const blocked = loc === null || guard.includes(loc)
  const check: NetCheck = {
    provider,
    mode: profile.mode,
    path: blocked ? 'none' : path,
    proxy,
    loc,
    ok: !blocked,
    reason: loc === null ? 'unknown_location' : guard.includes(loc) ? 'blocked_country' : 'ok',
    fellBack,
    noProxy,
    guard,
    attempts,
    ms: now() - t0,
    checkedAt: new Date().toISOString(),
    cached: false,
  }
  cache.set(key, { at: now(), check })
  return check
}

/**
 * Отказ хода стражем — для `TurnOutcome.message`. `no_proxy` объясняется словами: код причины сам по себе не говорит,
 * что чинить.
 */
export function netRefusal(c: Pick<NetCheck, 'provider' | 'reason'>): string {
  return c.reason === 'no_proxy'
    ? `страж сети: no_proxy — network.${c.provider}.mode = "required", а proxy не задан; ход запрещён. Укажи network.${c.provider}.proxy или mode "off" в config.json`
    : `страж сети: ${c.reason}`
}

/** Одна строка для человека: `claude: auto → прямой, loc=XX, 412 мс`. */
export function netLine(c: NetCheck): string {
  const via = c.path === 'proxy' ? `прокси ${c.proxy}` : c.path === 'direct' ? 'прямой' : 'ход запрещён'
  const tail = c.ok ? '' : ` — ${c.reason}`
  return `${c.provider}: ${c.mode} → ${via}, loc=${c.loc ?? 'unknown'}, ${c.ms} мс${c.fellBack ? ' (откат с прокси)' : ''}${tail}`
}
