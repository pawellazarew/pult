// Канал обновлений (M8c): голый `pult update` и `pult update --check`.
//
//   latest.json (GitHub Releases) → подпись Ed25519 ключом из keys.ts → версия новее активной →
//   тарбол во `PULT_HOME/downloads` → размер и sha256 из манифеста → тот же путь, что `--from`
//   (lock, .partial, проба, автооткат).
//
// Весь путь — под `run/update.lock`: загрузка и установка одним куском, второй `pult update` (или
// «Обновить» из окна посреди ручного) отказывает сразу, а не после минуты скачивания.
//
// Правила, которые не ослабляются ни для кого (тест подставляет функцию запроса, а не http):
//   * https для адреса latest.json, для адресов из манифеста и для каждого редиректа;
//   * только вперёд: версия из манифеста строго новее активной, иначе «уже последняя»; пререлизы
//     каналом не ходят вовсе (manifest.ts) — старый подписанный манифест не откатит никого назад;
//   * версия, которая уже не прошла пробу на этой машине (bad), сама не ставится повторно — иначе
//     «Обновить» крутило бы установку и откат по кругу;
//   * активная версия — рабочая копия (`daemon install --dev`) — канал её не трогает.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_UPDATE_URL, loadConfig } from '../core/config.js'
import type { PultConfig } from '../core/config.js'
import type { PultPaths } from '../core/paths.js'
import type { UpdateRelease } from '../core/rpc.js'
import { compareVersions } from '../core/semver.js'
import { VERSION } from '../core/version.js'
import type { Io } from '../service/install.js'
import { appDirs } from '../cli/ui.js'
import { downloadTo, fetchBytes, FetchError, httpFor } from './fetch.js'
import type { HttpGet } from './fetch.js'
import { RELEASE_KEYS } from './keys.js'
import type { TrustedKey } from './keys.js'
import { keyIdOf, MANIFEST_MAX_BYTES, ManifestError, rawPublicKey, verifyEnvelope } from './manifest.js'
import type { Manifest } from './manifest.js'
import { installTarball, pruneStaged, stageTarball, stagedReady, switchStaged, withUpdateLock } from './update.js'
import type { UpdateOptions } from './update.js'
import { currentName, isVersionName, packageIn, readState } from './versions.js'
import { readAppState } from './appState.js'
import { plistString } from './plist.js'

/** `pult update --check`: есть что ставить. Не 1–5 (ошибки CLI) — скрипт отличит «есть обновление» от сбоя. */
export const EXIT_UPDATE_AVAILABLE = 10

export class ChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

export interface ChannelOptions {
  env?: NodeJS.ProcessEnv
  config?: PultConfig
  /** Запрос без следования редиректам; по умолчанию — fetch Node (в тестах — PULT_TEST_UPDATE_DIR). */
  http?: HttpGet
  keys?: readonly TrustedKey[]
}

/**
 * Откуда latest.json: PULT_UPDATE_URL → `updates.url` в config.json → релизы GitHub. Только https:
 * подписан и манифест, и всё, что он называет, но по http старый подписанный манифест можно отдавать
 * вечно (заморозка), а тарбол — задерживать. Кривая переменная — отказ, а не тихий откат на GitHub:
 * человек, задавший свой адрес, должен узнать, что его не послушали.
 */
export function updateUrl(config: PultConfig | null, env: NodeJS.ProcessEnv): string {
  const raw = (env['PULT_UPDATE_URL'] ?? '').trim()
  if (raw) {
    let u: URL
    try { u = new URL(raw) } catch { throw new ChannelError(`PULT_UPDATE_URL=${raw.slice(0, 200)}: не адрес`) }
    if (u.protocol !== 'https:') throw new ChannelError(`PULT_UPDATE_URL=${raw.slice(0, 200)}: только https`)
    return u.href
  }
  return config?.updates.url ?? DEFAULT_UPDATE_URL
}

/**
 * Доверенные ключи: зашитые в сборку (keys.ts). Под PULT_TEST=1 — ещё PULT_TEST_RELEASE_KEY: сквозные
 * тесты поднимают Пульт отдельным процессом и подписывают свой latest.json своим ключом. Вне тестового
 * режима переменная не читается вовсе.
 */
export function trustedKeys(env: NodeJS.ProcessEnv): readonly TrustedKey[] {
  const testMode = env['PULT_TEST'] === '1' || process.env['PULT_TEST'] === '1'
  // Только под PULT_TEST: тест «в сборке нет ключа» подставляет пустой список явно, а не рассчитывает на keys.ts.
  if (testMode && env['PULT_TEST_NO_RELEASE_KEYS'] === '1') return []
  const test = testMode ? (env['PULT_TEST_RELEASE_KEY'] ?? '').trim() : ''
  if (!test) return RELEASE_KEYS
  return [...RELEASE_KEYS, { id: keyIdOf(rawPublicKey(test)), publicKey: test }]
}

export function releaseOf(m: Manifest): UpdateRelease {
  return {
    version: m.version,
    released: m.released,
    notes: m.notes,
    ...(m.app ? { app: { version: m.app.version, minVersion: m.app.minVersion } } : {}),
  }
}

/**
 * 404 на latest.json — чаще всего не поломка Пульта: в канале нет релиза или адрес канала не тот
 * (`updates.url`, `PULT_UPDATE_URL`). Говорим, что проверить и как поставить версию руками.
 */
export const CHANNEL_404_HINT = 'релизов в канале нет или адрес недоступен — проверь updates.url; поставить вручную: pult update --from <тарбол>'

/** Скачать и проверить latest.json. Ошибка — ChannelError с причиной в одну строку. */
export async function fetchManifest(opts: ChannelOptions & { url: string }): Promise<Manifest> {
  const env = opts.env ?? process.env
  try {
    const bytes = await fetchBytes(opts.url, { http: opts.http ?? httpFor(env), maxBytes: MANIFEST_MAX_BYTES, what: 'latest.json' })
    return verifyEnvelope(bytes, opts.keys ?? trustedKeys(env))
  } catch (e) {
    if (e instanceof ManifestError || e instanceof FetchError) {
      const hint = e instanceof FetchError && /HTTP 404/.test(e.message) ? ` — ${CHANNEL_404_HINT}` : ''
      throw new ChannelError(e.message + hint)
    }
    throw e
  }
}

/** Активная версия: пакет под `current`; `dev` — рабочая копия (`daemon install --dev`). Нет `current` — null. */
export function installedVersion(paths: PultPaths): { version: string | null; dev: boolean } {
  if (currentName(paths) === null) return { version: null, dev: false }
  const pkg = packageIn(paths.current)
  return pkg ? { version: pkg.version, dev: pkg.layout === 'dev' } : { version: null, dev: false }
}

/**
 * Версия поставленного окна — из Info.plist Pult.app (те же места, что у `pult ui`). Не нашли или
 * plist не XML — null («не знаю»), а не ошибка: окно ставят руками, его может и не быть.
 */
export function installedWindowVersion(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'darwin' && env['PULT_TEST'] !== '1') return null
  for (const dir of appDirs(env)) {
    let text: string
    try { text = readFileSync(join(dir, 'Pult.app', 'Contents', 'Info.plist'), 'utf8') } catch { continue }
    const v = plistString(text, 'CFBundleShortVersionString')
    if (v && v.length <= 40) return v
  }
  return null
}

export interface CheckReport {
  current: string | null
  latest: UpdateRelease
  /** Манифест новее активной версии. */
  newer: boolean
  bad: boolean
  /** Есть что ставить голым `pult update`: новее, не bad, активная — не рабочая копия. */
  available: boolean
  dev: boolean
  url: string
  /**
   * Окно: `outdated` — пакету релиза нужно окно новее стоящего; `latest` — окно релиза; `available` — его можно
   * поставить `pult update --app` (новее стоящего и не bad); `bad` — оно уже не встало на этой машине.
   */
  window: { installed: string | null; minVersion: string | null; outdated: boolean | null; latest: string | null; available: boolean; bad: boolean }
}

function report(paths: PultPaths, m: Manifest, url: string, env: NodeJS.ProcessEnv): CheckReport {
  const inst = installedVersion(paths)
  const current = inst.version ?? (currentName(paths) === null ? null : VERSION)
  const newer = current === null || compareVersions(m.version, current) > 0
  const bad = readState(paths).bad.includes(m.version)
  const win = installedWindowVersion(env)
  const minVersion = m.app?.minVersion ?? null
  const appLatest = m.app?.['darwin-arm64'] ? m.app.version : null
  const appBad = appLatest !== null && readAppState(paths).bad.includes(appLatest)
  const appNewer = appLatest !== null && win !== null && compareVersions(appLatest, win) > 0
  return {
    current,
    latest: releaseOf(m),
    newer,
    bad,
    available: newer && !bad && !inst.dev,
    dev: inst.dev,
    url,
    window: {
      installed: win, minVersion, outdated: win !== null && minVersion !== null ? compareVersions(win, minVersion) < 0 : null,
      latest: appLatest, available: appNewer && !appBad, bad: appBad,
    },
  }
}

function settle(opts: ChannelOptions, paths: PultPaths): { env: NodeJS.ProcessEnv; config: PultConfig } {
  const env = opts.env ?? process.env
  return { env, config: opts.config ?? loadConfig(paths.config).config }
}

const day = (iso: string): string => iso.slice(0, 10)

/** `pult update --check [--json]`: код 0 — ставить нечего, EXIT_UPDATE_AVAILABLE — есть, 1 — проверить не вышло. */
export async function updateCheck(paths: PultPaths, io: Io, opts: ChannelOptions & { json?: boolean } = {}): Promise<number> {
  const { env, config } = settle(opts, paths)
  let r: CheckReport
  try {
    const url = updateUrl(config, env)
    r = report(paths, await fetchManifest({ ...opts, env, url }), url, env)
  } catch (e) {
    if (!(e instanceof ChannelError)) throw e
    if (opts.json) io.out(JSON.stringify({ error: e.message }))
    io.err(`pult update --check: ${e.message}`)
    return 1
  }
  if (opts.json) {
    io.out(JSON.stringify(r))
    return r.available ? EXIT_UPDATE_AVAILABLE : 0
  }
  const v = r.latest.version
  if (r.available) {
    io.out(`доступна ${v} (сейчас ${r.current ?? 'ничего не стоит'}, выпущена ${day(r.latest.released)}) — поставить: pult update`)
  } else if (r.newer && r.bad) {
    io.out(`в канале ${v}, но она уже не прошла пробу на этой машине (bad) — сама не ставится; повторить руками: pult update --to ${v}`)
  } else if (r.newer && r.dev) {
    io.out(`в канале ${v}; активна рабочая копия ${r.current} (daemon install --dev) — канал её не трогает`)
  } else if (r.current !== null && compareVersions(v, r.current) < 0) {
    io.out(`pult ${r.current} новее канала (${v}) — ставить нечего`)
  } else {
    io.out(`pult ${r.current ?? v} — последняя версия`)
  }
  io.out(`что нового: ${r.latest.notes}`)
  // 0.3.16: у окна тот же номер, что у пакета, — строка про окно только когда оно отстало (обновится той же кнопкой).
  const w = r.window
  if (w.installed !== null && w.latest !== null && compareVersions(w.latest, w.installed) > 0) {
    io.out(w.bad
      ? `окно: ${w.installed} → в канале ${w.latest}, но оно уже не встало на этой машине — повторить: pult update --app --force`
      : `окно: ${w.installed} → доступно ${w.latest} — обновится вместе с Пультом («Перезапустить» в окне) или: pult update --app`)
  }
  return r.available ? EXIT_UPDATE_AVAILABLE : 0
}

/** Скачанные тарболы прерванных запусков. Только под update.lock — иначе можно снести чужую идущую загрузку. */
function cleanDownloads(paths: PultPaths): void {
  let names: string[] = []
  try { names = readdirSync(paths.downloads) } catch { return }
  for (const n of names) rmSync(join(paths.downloads, n), { recursive: true, force: true })
}

/** Скачать тарбол релиза в downloads/ (размер и sha256 — из подписанного манифеста). null — не вышло, причина в stderr. */
async function downloadPackage(paths: PultPaths, io: Io, m: Manifest, env: NodeJS.ProcessEnv, http: HttpGet | undefined): Promise<string | null> {
  const v = m.version
  mkdirSync(paths.downloads, { recursive: true, mode: 0o700 })
  chmodSync(paths.downloads, 0o700)
  const partial = join(paths.downloads, `pult-${v}.tgz.partial-${process.pid}`)
  const tgz = join(paths.downloads, `pult-${v}.tgz`)
  try {
    await downloadTo(m.package.url, partial, {
      http: http ?? httpFor(env),
      size: m.package.size,
      sha256: m.package.sha256,
      what: `pult-${v}.tgz`,
    })
  } catch (e) {
    if (!(e instanceof FetchError)) throw e
    io.err(`pult update: ${e.message}`)
    return null
  }
  renameSync(partial, tgz)
  io.out(`скачано: ${m.package.size} байт, sha256 сходится с подписанным манифестом`)
  return tgz
}

/**
 * Голый `pult update`: проверка канала и установка новой версии тем же путём, что `--from`.
 * `expect` — версия, которую видел человек («Перезапустить» в окне передаёт её `--expect`). С 0.3.16 канал, ушедший
 * ВПЕРЁД (вышла версия ещё новее), — не отказ: ставится самая новая, и об этом сказано; ушедший назад — отказ.
 * Версия, подготовленная заранее (`pult update --stage`, та же метка sha256), не качается второй раз; нет сети, а
 * `expect` подготовлена — переключение на неё (её тарбол уже сверен с подписанным манифестом при подготовке).
 */
export async function updateLatest(paths: PultPaths, io: Io, opts: ChannelOptions & UpdateOptions & { expect?: string } = {}): Promise<number> {
  const { env, config } = settle(opts, paths)
  let url: string
  try { url = updateUrl(config, env) } catch (e) {
    if (!(e instanceof ChannelError)) throw e
    io.err(`pult update: ${e.message}`)
    return 1
  }
  // PULT_UPDATE_LOG ставит демон, запуская нас из окна: окно потом укажет на этот файл, а не на терминал.
  const log = (env['PULT_UPDATE_LOG'] ?? '').trim()
  const tail: UpdateOptions = { ...opts, env, action: 'channel', ...(log ? { log } : {}) }
  return withUpdateLock(paths, io, async () => {
    cleanDownloads(paths)
    let m: Manifest
    try {
      m = await fetchManifest({ ...opts, env, url })
    } catch (e) {
      if (!(e instanceof ChannelError)) throw e
      // Те же правила, что у пути с сетью: только вперёд, не bad, не рабочая копия — иначе `--expect <previous>` без
      // сети тихо откатил бы на прежнюю версию (у неё тоже метка канала).
      const exp = opts.expect
      const inst = installedVersion(paths)
      const forward = exp !== undefined && isVersionName(exp) && (inst.version === null || compareVersions(exp, inst.version) > 0)
      if (exp !== undefined && forward && !inst.dev && !readState(paths).bad.includes(exp) && stagedReady(paths, exp)) {
        io.err(`pult update: ${e.message} — ${exp} уже подготовлена заранее, ставлю её`)
        return switchStaged(paths, io, exp, tail)
      }
      io.err(`pult update: ${e.message}`)
      io.err('ничего не поставлено; поставить тарбол руками: pult update --from <pult-x.y.z.tgz>')
      return 1
    }
    const r = report(paths, m, url, env)
    const v = m.version
    if (r.dev) {
      io.err(`pult update: активна рабочая копия ${r.current} (daemon install --dev) — канал её не трогает; релиз ${v} руками: pult update --from <тарбол>`)
      return 1
    }
    if (!r.newer) {
      io.out(r.current !== null && compareVersions(v, r.current) < 0
        ? `pult ${r.current} новее канала (${v}) — ставить нечего`
        : `уже последняя: ${r.current ?? v}`)
      return 0
    }
    if (r.bad) {
      io.err(`pult update: ${v} уже не прошла пробу на этой машине (bad) — сама не ставится; повторить: pult update --to ${v}`)
      return 1
    }
    if (opts.expect !== undefined && opts.expect !== v) {
      if (compareVersions(v, opts.expect) < 0) {
        io.err(`pult update: в канале ${v}, а ставить просили ${opts.expect} — канал старше просимого; проверь заново (pult update --check) и повтори`)
        return 1
      }
      // Пока окно ждало конца ходов (или висело с прошлой проверки), вышла ещё одна версия — ставим её, а не старую.
      io.out(`в канале уже ${v} (просили ${opts.expect}) — ставлю ${v}`)
    }
    if (stagedReady(paths, v, m.package.sha256)) return switchStaged(paths, io, v, { ...tail, expectVersion: v })
    io.out(`доступна ${v} (сейчас ${r.current ?? 'ничего не стоит'}) — скачиваю ${m.package.url}`)
    // Тестовый шов: «долгая загрузка», чтобы сквозной тест окна застал состояние «ставится». Только под PULT_TEST.
    const hold = Number(env['PULT_TEST'] === '1' ? env['PULT_TEST_UPDATE_HOLD_MS'] : NaN)
    if (Number.isFinite(hold) && hold > 0) await new Promise((res) => setTimeout(res, hold))
    const tgz = await downloadPackage(paths, io, m, env, opts.http)
    if (tgz === null) { io.err('ничего не поставлено: current и работающий демон прежние'); return 1 }
    try {
      return await installTarball(paths, io, tgz, { ...tail, expectVersion: v, channelSha: m.package.sha256 })
    } finally {
      try { unlinkSync(tgz) } catch { /* уже нет */ }
    }
  })
}

/**
 * `pult update --stage` (0.3.16, так зовёт демон после проверки): скачать и поставить новую версию в
 * `versions/<v>`, НЕ переключая `current` и не трогая демона. Под тем же update.lock. Код 0 — подготовлено (или
 * готовить нечего), 1 — не вышло (демон молчит и повторит при следующей проверке). Старые подготовленные версии
 * убираются: подготовленная — одна.
 */
export async function updateStage(paths: PultPaths, io: Io, opts: ChannelOptions & UpdateOptions = {}): Promise<number> {
  const { env, config } = settle(opts, paths)
  let url: string
  try { url = updateUrl(config, env) } catch (e) {
    if (!(e instanceof ChannelError)) throw e
    io.err(`pult update --stage: ${e.message}`)
    return 1
  }
  return withUpdateLock(paths, io, async () => {
    cleanDownloads(paths)
    let m: Manifest
    try { m = await fetchManifest({ ...opts, env, url }) } catch (e) {
      if (!(e instanceof ChannelError)) throw e
      io.err(`pult update --stage: ${e.message}`)
      return 1
    }
    const r = report(paths, m, url, env)
    const v = m.version
    if (r.dev || !r.newer || r.bad) {
      io.out(`pult update --stage: готовить нечего (${r.dev ? 'рабочая копия' : r.bad ? `${v} — bad` : `${r.current ?? v} — последняя`})`)
      return 0
    }
    // Прежние подготовленные убираются только ПОСЛЕ удачи: битый релиз не должен стереть годную подготовленную версию.
    const prune = (): void => {
      const removed = pruneStaged(paths, v)
      if (removed.length) io.out(`убраны прежние подготовленные версии: ${removed.join(', ')}`)
    }
    if (stagedReady(paths, v, m.package.sha256)) { io.out(`${v} уже подготовлена`); prune(); return 0 }
    io.out(`готовлю ${v}: скачиваю ${m.package.url}`)
    const tgz = await downloadPackage(paths, io, m, env, opts.http)
    if (tgz === null) return 1
    try {
      const code = stageTarball(paths, io, tgz, { ...opts, env, expectVersion: v, action: 'channel', channelSha: m.package.sha256 })
      if (code === 0) prune()
      return code
    } finally {
      try { unlinkSync(tgz) } catch { /* уже нет */ }
    }
  }, { stage: true })
}
