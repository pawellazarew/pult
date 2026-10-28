// Демон и канал обновлений (M8c): сам проверяет latest.json и по «Обновить» в окне запускает `pult update`.
//
// РАСПИСАНИЕ: первая проверка через минуту после старта (демон под launchd поднимается вместе с входом
// в систему — сеть к этому моменту обычно уже есть), дальше раз в 6 ч ± 30 мин. Срок считается по
// СТЕННЫМ часам и сверяется раз в 10 минут, а не одним setTimeout на 6 ч: таймер Node идёт по
// монотонным часам, которые на macOS стоят, пока ноутбук спит, — часы «сна» откладывали бы проверку.
// Удачная проверка по любой причине (окно, человек) сдвигает следующую плановую на полный срок.
// `updates.check: false` в config.json — ни одного запроса сам; ручная проверка из окна (`update.check`)
// работает всё равно: её попросил человек. Окно меняет флаг на лету (`settings.set` → `setEnabled`).
//
// ПО ФОКУСУ ОКНА (`update.check {ifOlderThanMs}`): окно вернулось на экран, а последняя проверка старше
// часа — проверить. Сколько бы окон и событий фокуса ни пришло, демон ходит в сеть по таким просьбам не
// чаще раза в 10 минут (`MIN_AUTO_GAP_MS`) и только при включённой автопроверке. Ручная «Проверить сейчас»
// предела не знает: человек нажал — значит, ему нужен свежий ответ, а не прошлый.
//
// «ОБНОВИТЬ» (`update.apply`): обновление перезапускает демона, а с ним обрываются идущие ходы. Поэтому:
// ходы идут — ответ `{waiting: N}`, и обновление начнётся само, когда кончится последний (`poke` на
// каждом событии журнала); `force: true` («Сейчас» в окне) — не ждать. Запуск — ОТСОЕДИНЁННЫЙ процесс
// `pult update` через лаунчер команды (bin/pult): демон, который он остановит, не может ждать его конца.
// Окно переживает рестарт демона само (оболочка переподключается и доигрывает журнал с курсора).
//
// Итог проверки живёт в памяти и в `PULT_HOME/update-check.json`: после рестарта окно сразу видит
// «Доступна …», не дожидаясь минуты до первой проверки. Неудачная проверка повторяется через 15 мин, 1 ч,
// 6 ч и дальше раз в сутки — сеть, пропавшая на минуту, не откладывает обновление на сутки.
//
// ПОКА СТАВИТСЯ (`applying`): ребёнок `pult update` секунды-минуты качает тарбол и ставит npm, а потом
// перезапускает демона — новый ход, начатый в это время, оборвался бы. Поэтому `holdTurns` (менеджер
// сессий) отказывает ходам кодом `updating`, а очередь реплик стоит до рестарта.
//
// ФОНОВАЯ ПОДГОТОВКА (0.3.16): проверка нашла новую подписанную версию — демон сразу, не дожидаясь кнопки, готовит её:
// пакет — ребёнком `pult update --stage` (npm в `versions/<v>`, `current` не трогается; под тем же update.lock), окно —
// своим `app.stage` (zip, проверки, `apps/ready-<v>`). Только если автопроверка включена или человек сам нажал
// «Проверить сейчас». Неудача тихая (`staged.state = failed` — строка в «Настройках»), повтор — 15 мин, 1 ч, 6 ч.
// «Перезапустить», нажатое посреди подготовки, ждёт её конца (`applying`), а `pult update` потом только переключает.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, renameSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PultConfig } from '../core/config.js'
import type { Logger } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { UpdateApplyState, UpdateFailure, UpdateRelease, UpdateStaged, UpdateStatus } from '../core/rpc.js'
import { compareVersions } from '../core/semver.js'
import { daemonSpawnEnv } from '../cli/startOnDemand.js'
import { atomicWrite } from '../service/fsutil.js'
import { ChannelError, fetchManifest, installedVersion, releaseOf, trustedKeys, updateUrl } from './channel.js'
import type { HttpGet } from './fetch.js'
import type { TrustedKey } from './keys.js'
import type { Manifest } from './manifest.js'
import { stagedReady } from './update.js'
import { PROBE_PENDING, readState } from './versions.js'

export const FIRST_CHECK_MS = 60_000
export const CHECK_INTERVAL_MS = 6 * 3_600_000
export const CHECK_JITTER_MS = 30 * 60_000
/** Проверки по просьбе окна (фокус) — не чаще этого, сколько бы окон ни просило. */
export const MIN_AUTO_GAP_MS = 10 * 60_000
/** Как часто сверяться со стенными часами между проверками. */
export const CHECK_TICK_MS = 10 * 60_000
/** Страховка ожидания ходов: пересчитать их, даже если событие конца хода прошло мимо. */
export const WAIT_POLL_MS = 5_000
/** Повторы неудачной проверки; дальше — обычный срок. */
export const CHECK_RETRY_MS: readonly number[] = [15 * 60_000, 3_600_000, 6 * 3_600_000]
/** logs/update.log больше этого — старый уходит в update.log.1 (одна копия), новый начинается с нуля. */
export const UPDATE_LOG_MAX = 1024 * 1024

/** Подготовка окна ничего не сделала (не нужна или нельзя сейчас) — не провал. */
class SkipStage extends Error {}

export class ApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApplyError'
  }
}

/** Ребёнок `pult update`: от него нужны только выход и ошибка спавна. */
export interface ApplyChild {
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (e: Error) => void): unknown
}

export interface CheckerOptions {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  /** Версия этого демона. */
  current: string
  env?: NodeJS.ProcessEnv
  http?: HttpGet
  keys?: readonly TrustedKey[]
  /** Сколько ходов идёт прямо сейчас (working и ждущие человека). */
  runningTurns: () => number
  /**
   * «Ставится» кончилось, а демон жив (ребёнок вышел с ошибкой или не запустился, или ставить оказалось нечего —
   * `ok`): ходы снова можно, и очереди, притихшие на время обновления, надо разбудить (`SessionManager.resumeQueues`).
   */
  onApplyEnd?: (r: { ok: boolean }) => void
  /**
   * 0.3.16: сейчас запустится `pult update` по «Перезапустить и обновить» (`apply(force, true)`) — записать журнал, по
   * которому новый демон доведёт обновление окна.
   */
  onLaunch?: (to: string) => void
  /** Запуск `pult update --expect <to>`; тест подставляет свой. */
  spawnApply?: (to: string) => ApplyChild
  /** 0.3.16: запуск `pult update --stage` (фоновая подготовка пакета); тест подставляет свой. */
  spawnStage?: () => ApplyChild
  /** 0.3.16: готовить ли в фоне вообще (по умолчанию да; тестовый демон без шва канала — нет). */
  stage?: boolean
  /**
   * 0.3.16: окно в фоновой подготовке. `wanted(v)` — окно `v` можно и нужно ставить (новее стоящего, не bad, есть
   * права); `ready(v)` — уже подготовлено; `stage(m)` — скачать и проверить (ошибка — исключением).
   */
  app?: { wanted(v: string): boolean; ready(v: string): boolean; stage(m: Manifest): Promise<boolean> }
  /** Почему «Обновить» пакет сейчас нельзя (идёт обновление окна, 0.3.4); null — можно. */
  blocked?: () => string | null
  /**
   * Можно ли проверять самому (расписание и просьбы окна по фокусу) при `updates.check: true`. По умолчанию —
   * да; тестовый демон без шва канала — нет: сеть в тестах не трогается.
   */
  schedule?: boolean
  firstDelayMs?: number
  intervalMs?: number
  jitterMs?: number
  tickMs?: number
  retryMs?: readonly number[]
  now?: () => number
  random?: () => number
}

export interface UpdateChecker {
  status(): UpdateStatus
  /** Проверить сейчас (повторный вызов во время проверки ждёт ту же). Ручная — без предела частоты. */
  check(): Promise<UpdateStatus>
  /**
   * Просьба окна по фокусу: проверить, если последняя попытка старше `olderThanMs` (не меньше
   * `MIN_AUTO_GAP_MS`) и автопроверка включена; иначе — текущий статус без сети.
   */
  checkIfStale(olderThanMs: number): Promise<UpdateStatus>
  /** `updates.check` сменился на лету: включить или снять расписание. */
  setEnabled(on: boolean): void
  /** `withWindow` (0.3.16) — после пакета довести окно: перед запуском `pult update` зовётся `onLaunch`. */
  apply(force: boolean, withWindow?: boolean): Promise<{ waiting: number } | { applying: true; to: string }>
  /** Идёт подготовка ПАКЕТА (`pult update --stage` держит update.lock) — дождаться её. Окно готовится без lock. */
  staging(): Promise<void>
  /** Что-то в журнале случилось — может быть, кончился последний ход, которого ждёт «Обновить». */
  poke(): void
  /** Идёт `pult update` — демон вот-вот перезапустится; новые ходы не заводятся. */
  applying(): boolean
  stop(): void
}

interface Saved {
  checkedAt: string | null
  error: string | null
  latest: UpdateRelease | null
}

function readSaved(file: string): Saved {
  const empty: Saved = { checkedAt: null, error: null, latest: null }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return empty }
  if (!raw || typeof raw !== 'object') return empty
  const o = raw as Record<string, unknown>
  const l = o['latest'] as Record<string, unknown> | null | undefined
  // Файл пишет только демон, но битый файл не должен ронять старт: проверяем ровно то, что покажет окно.
  const latest = l && typeof l === 'object' && typeof l['version'] === 'string' && typeof l['released'] === 'string'
    && typeof l['notes'] === 'string' && /^https:\/\//.test(l['notes'])
    ? l as unknown as UpdateRelease
    : null
  return {
    checkedAt: typeof o['checkedAt'] === 'string' ? o['checkedAt'] : null,
    error: typeof o['error'] === 'string' ? o['error'] : null,
    latest,
  }
}

/**
 * Командная строка `pult update` из демона:
 *   * лаунчер команды `PULT_HOME/bin/pult` (свой node, активная версия) — так же, как `pult update`
 *     запустил бы человек; нет его (рабочая копия, версия старше 0.2.22) — node демона + свой CLI;
 *   * Linux под службой — через `systemd-run --user --scope`: systemd при рестарте службы гасит ВСЮ её
 *     контрольную группу, и setsid не спасает — `pult update` умер бы посреди собственной пробы. Своя
 *     scope-группа его выводит из-под удара. launchd гасит только группу процессов задачи, а
 *     отсоединённый ребёнок живёт в своей сессии — на macOS обёртка не нужна.
 */
export function applyArgv(i: { launcher: string | null; node: string; cliEntry: string; platform: NodeJS.Platform; service: boolean; systemdRun: string | null; expect: string }): string[] {
  // `--expect`: ребёнок ставит ровно ту версию, что видел человек, нажимая «Обновить». Канал успел
  // смениться (вышла ещё одна) — отказ, а не тихая установка того, о чём окно не говорило.
  const tail = ['update', '--expect', i.expect]
  const cmd = i.launcher ? [i.launcher, ...tail] : [i.node, i.cliEntry, ...tail]
  if (i.platform === 'linux' && i.service && i.systemdRun) return [i.systemdRun, '--user', '--scope', '--collect', '--quiet', '--', ...cmd]
  return cmd
}

const isExec = (p: string): boolean => { try { accessSync(p, fsConstants.X_OK); return true } catch { return false } }

/**
 * Переменные, которые `pult update` нужны сверх окружения демона по требованию: имя и каталог службы,
 * зеркало node и — на Linux — шина пользователя: без XDG_RUNTIME_DIR и DBUS_SESSION_BUS_ADDRESS и
 * `systemd-run --user`, и `systemctl --user restart` падают с «Failed to connect to bus».
 */
export const APPLY_PASS = ['PULT_SERVICE_NAME', 'XDG_CONFIG_HOME', 'PULT_NODE_MIRROR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const
const APPLY_PASS_TEST = ['PULT_SERVICE_DIR', 'PULT_SERVICE_PLATFORM', 'PULT_TEST_NODE_TARBALL', 'PULT_TEST_APP_DIRS', 'PULT_TEST_UPDATE_HOLD_MS'] as const

/** Окружение ребёнка `pult update`: как у демона по требованию плюс APPLY_PASS (и тестовые швы под PULT_TEST). */
export function applyEnv(paths: PultPaths, env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = daemonSpawnEnv(paths, env)
  for (const k of APPLY_PASS) if (env[k]) childEnv[k] = env[k] as string
  if (env['PULT_TEST'] === '1') for (const k of APPLY_PASS_TEST) if (env[k]) childEnv[k] = env[k] as string
  // Вывод ребёнка идёт в logs/update.log — пусть попытка в update.json об этом знает (окно сошлётся на файл).
  childEnv['PULT_UPDATE_LOG'] = paths.updateLog
  return childEnv
}

/** logs/update.log на дозапись; разросся больше `max` — прежний уходит в update.log.1 (затирая старый). */
export function openUpdateLog(paths: PultPaths, max = UPDATE_LOG_MAX): number {
  try {
    if (statSync(paths.updateLog).size > max) renameSync(paths.updateLog, `${paths.updateLog}.1`)
  } catch { /* файла ещё нет */ }
  return openSync(paths.updateLog, 'a', 0o600)
}

/**
 * 0.3.16: `pult update --stage` — фоновая подготовка. Демона не перезапускает, поэтому без scope-группы systemd и не
 * отсоединённый; вывод — в тот же logs/update.log.
 */
export function stageArgv(i: { launcher: string | null; node: string; cliEntry: string }): string[] {
  return i.launcher ? [i.launcher, 'update', '--stage'] : [i.node, i.cliEntry, 'update', '--stage']
}

export function spawnStageProcess(paths: PultPaths, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const argv = stageArgv({
    launcher: isExec(paths.cliLauncher) ? paths.cliLauncher : null,
    node: process.execPath,
    cliEntry: fileURLToPath(new URL('../cli/main.js', import.meta.url)),
  })
  const fd = openUpdateLog(paths)
  try {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', fd, fd], env: applyEnv(paths, env), cwd: paths.home })
    child.unref()
    return child
  } finally {
    closeSync(fd)
  }
}

/** Настоящий запуск: отсоединённый, вывод — в logs/update.log. */
export function spawnUpdateProcess(paths: PultPaths, to: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const argv = applyArgv({
    launcher: isExec(paths.cliLauncher) ? paths.cliLauncher : null,
    node: process.execPath,
    cliEntry: fileURLToPath(new URL('../cli/main.js', import.meta.url)),
    platform: process.platform,
    service: env['PULT_SERVICE'] === '1',
    systemdRun: ['/usr/bin/systemd-run', '/bin/systemd-run'].find(isExec) ?? null,
    expect: to,
  })
  const fd = openUpdateLog(paths)
  try {
    const child = spawn(argv[0] as string, argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: applyEnv(paths, env), cwd: paths.home })
    child.unref()
    return child
  } finally {
    closeSync(fd)
  }
}

/**
 * Последняя попытка из канала, которая не встала (проба и откат, npm, загрузка) — из update.json. После
 * отката демон уже другой процесс, и его `apply` пуст: без этого плашка просто исчезала бы.
 */
export function lastChannelFailure(paths: PultPaths): UpdateFailure | null {
  const last = readState(paths).last
  if (!last || last.action !== 'channel') return null
  if (last.result !== 'rolled_back' && last.result !== 'failed') return null
  if (last.message === PROBE_PENDING) return null // проба ещё идёт (или её убили) — это не итог
  return { to: last.version, back: last.result === 'rolled_back' ? last.was : null, at: last.at, result: last.result, message: last.message ?? '', log: last.log ?? null }
}

export function createUpdateChecker(o: CheckerOptions): UpdateChecker {
  const env = o.env ?? process.env
  const now = o.now ?? Date.now
  const random = o.random ?? Math.random
  let enabled = o.config.updates.check
  const scheduleAllowed = o.schedule ?? true
  const firstDelay = o.firstDelayMs ?? FIRST_CHECK_MS
  const interval = o.intervalMs ?? CHECK_INTERVAL_MS
  const jitter = o.jitterMs ?? CHECK_JITTER_MS
  const tick = o.tickMs ?? CHECK_TICK_MS
  const retry = o.retryMs ?? CHECK_RETRY_MS
  const keys = o.keys ?? trustedKeys(env)

  // Выключенная проверка не тащит старый итог: «Доступна …» месячной давности после `check: false` врало бы.
  let saved: Saved = enabled ? readSaved(o.paths.updateCheck) : { checkedAt: null, error: null, latest: null }
  let checking: Promise<UpdateStatus> | null = null
  let apply: UpdateApplyState = { state: 'idle' }
  let timer: NodeJS.Timeout | null = null
  let waitPoll: NodeJS.Timeout | null = null
  let pokeQueued = false
  let failures = 0
  /** Ребёнок, чей выход что-то значит: выход прежнего (повтор после провала) состояние не трогает. */
  let child: ApplyChild | null = null
  let applyInflight: Promise<{ waiting: number } | { applying: true; to: string }> | null = null
  /** «Перезапустить и обновить» (0.3.16): после пакета — окно; иначе (target 'package') — только пакет. */
  let applyWindow = false
  /** Фоновая подготовка: что готовится или готово (в памяти; после рестарта — с диска, см. `diskStaged`). */
  let staged: UpdateStaged | null = null
  let stagePromise: Promise<void> | null = null
  /** Только ребёнок `pult update --stage`: его ждут «Перезапустить» и окно (update.lock); подготовку окна — нет. */
  let pkgStagePromise: Promise<void> | null = null
  let stageFailures = 0
  let stageRetryAt = 0
  let nextAt = now() + firstDelay
  let stopped = false
  /** Когда последний раз ходили в сеть (удачно или нет) — предел частоты проверок по фокусу. */
  const savedAt = saved.checkedAt !== null ? Date.parse(saved.checkedAt) : Number.NaN
  let lastAttemptAt: number | null = Number.isFinite(savedAt) ? savedAt : null
  const auto = (): boolean => enabled && scheduleAllowed && !stopped
  const regularDelay = (): number => interval + Math.round((random() * 2 - 1) * jitter)

  /** Пакет из канала можно ставить: новее этого демона, не bad, не рабочая копия. */
  const packageWanted = (latest: UpdateRelease | null): boolean => {
    if (latest === null || compareVersions(latest.version, o.current) <= 0) return false
    return !readState(o.paths).bad.includes(latest.version) && !installedVersion(o.paths).dev
  }

  /**
   * Подготовленное на диске (после рестарта демона памяти нет): пакет — `versions/<v>` с меткой канала, окно —
   * `apps/ready-<v>`. Готово, только когда готово всё, что надо ставить.
   */
  const diskStaged = (latest: UpdateRelease | null): UpdateStaged | null => {
    if (latest === null) return null
    const pkg = packageWanted(latest)
    const appV = latest.app?.version ?? null
    const app = appV !== null && (o.app?.wanted(appV) ?? false)
    if (!pkg && !app) return null
    if (pkg && !stagedReady(o.paths, latest.version)) return null
    if (app && !(o.app?.ready(appV as string) ?? false)) return null
    return { to: latest.version, state: 'ready', error: null, at: saved.checkedAt ?? new Date(now()).toISOString() }
  }

  const status = (): UpdateStatus => {
    const latest = saved.latest
    const newer = latest !== null && compareVersions(latest.version, o.current) > 0
    const bad = latest !== null && readState(o.paths).bad.includes(latest.version)
    // Рабочая копия (`daemon install --dev`) каналом не обновляется — и «Доступна» про неё врало бы.
    const dev = installedVersion(o.paths).dev
    return {
      enabled,
      current: o.current,
      checking: checking !== null,
      checkedAt: saved.checkedAt,
      error: saved.error,
      latest,
      available: newer && !bad && !dev,
      bad,
      apply,
      failure: lastChannelFailure(o.paths),
      // «Готово» в памяти сверяется с диском: подготовленное могли израсходовать (замена окна) или убрать.
      staged: staged !== null && staged.to === latest?.version && staged.state !== 'ready' ? staged : diskStaged(latest),
    }
  }

  const persist = (): void => {
    // Проверка, начатая до stop() и кончившаяся после, в PULT_HOME не пишет: демон остановлен, его дом
    // уже могут стирать (тесты) или занимать новой версией (pult update) — запоздалый файл там лишний.
    if (stopped) return
    try {
      atomicWrite(o.paths.updateCheck, JSON.stringify({ schema: 1, ...saved }, null, 2) + '\n', 0o600)
    } catch (e) {
      o.logger.warn('итог проверки обновлений не записался', { error: (e as Error).message })
    }
  }

  /** Ребёнок `pult update --stage` как промис: код 0 — подготовлено, иначе — исключение с путём к журналу. */
  const runStageChild = (): Promise<void> => new Promise<void>((resolve, reject) => {
    let k: ApplyChild
    try { k = (o.spawnStage ?? (() => spawnStageProcess(o.paths, env)))() } catch (e) { reject(new Error(`pult update --stage не запустился: ${(e as Error).message}`)); return }
    k.on('error', (e) => { reject(new Error(`pult update --stage не запустился: ${e.message}`)) })
    k.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`подготовка вышла ${code !== null ? `с кодом ${code}` : `по сигналу ${signal ?? '?'}`} — подробности: ${o.paths.updateLog}`))
    })
  })

  /**
   * Фоновая подготовка по итогу проверки: только при включённой автопроверке или по ручной «Проверить сейчас», не
   * во время установки (`applying`), одна за раз. Ожидание ходов (`waiting`, бывает часами) и прошлый провал её не
   * держат: к концу ходов версия будет готова. Неудача — тихо, повтор не раньше `retry` (ручная проверка — сразу).
   */
  const startStage = (m: Manifest, manual: boolean): void => {
    if (stopped || stagePromise || apply.state === 'applying' || o.stage === false) return
    if (!manual && !(enabled && scheduleAllowed)) return
    if (!manual && now() < stageRetryAt) return
    const latest = releaseOf(m)
    const pkg = packageWanted(latest)
    const app = m.app?.['darwin-arm64'] !== undefined && (o.app?.wanted(m.app.version) ?? false)
    if (!pkg && !app) { staged = null; return }
    if (diskStaged(latest) !== null) { staged = diskStaged(latest); return }
    const to = m.version
    staged = { to, state: 'downloading', error: null, at: new Date(now()).toISOString() }
    o.logger.info('готовлю обновление в фоне', { to, package: pkg, app })
    stagePromise = (async () => {
      if (pkg) {
        pkgStagePromise = runStageChild()
        try { await pkgStagePromise } finally { pkgStagePromise = null }
      }
      // Окно не подготовилось, но и не сломалось (идёт обновление окна, уже не нужно) — не провал и не «готово».
      if (app && o.app && !(await o.app.stage(m))) throw new SkipStage()
    })().then(() => {
      staged = { to, state: 'ready', error: null, at: new Date(now()).toISOString() }
      stageFailures = 0
      stageRetryAt = 0
      o.logger.info('обновление подготовлено', { to })
    }, (e: unknown) => {
      if (e instanceof SkipStage) { staged = null; return }
      const error = (e as Error).message.split('\n')[0] ?? 'ошибка'
      staged = { to, state: 'failed', error, at: new Date(now()).toISOString() }
      stageRetryAt = now() + (retry[Math.min(stageFailures, retry.length - 1)] ?? interval)
      stageFailures++
      // Повтор — следующей плановой проверкой, но не позже срока повтора.
      if (Number.isFinite(nextAt)) nextAt = Math.min(nextAt, stageRetryAt)
      o.logger.warn('подготовка обновления не удалась', { to, error })
    }).finally(() => { stagePromise = null })
  }

  /** Ручная проверка, присоединившаяся к идущей плановой, тоже просит подготовку. */
  let manualJoined = false
  const runCheck = (manual: boolean): Promise<UpdateStatus> => {
    if (checking) { if (manual) manualJoined = true; return checking }
    manualJoined = manual
    lastAttemptAt = now()
    checking = (async () => {
      try {
        const url = updateUrl(o.config, env)
        const m = await fetchManifest({ env, url, keys, ...(o.http ? { http: o.http } : {}) })
        saved = { checkedAt: new Date(now()).toISOString(), error: null, latest: releaseOf(m) }
        if (!stopped) startStage(m, manualJoined)
        o.logger.info('канал обновлений проверен', { latest: m.version, current: o.current })
        // Удача вне расписания (окно, человек) — плановая сдвигается на полный срок. Во время плановой
        // `nextAt` — бесконечность, срок ставит само расписание.
        if (Number.isFinite(nextAt)) { failures = 0; nextAt = now() + regularDelay() }
      } catch (e) {
        if (!(e instanceof ChannelError)) o.logger.error('проверка обновлений упала', { error: (e as Error).message })
        // Прежний `latest` остаётся: сбой сети не должен прятать уже известное обновление.
        saved = { ...saved, checkedAt: new Date(now()).toISOString(), error: (e as Error).message.split('\n')[0] ?? 'ошибка' }
        o.logger.warn('проверка обновлений не удалась', { error: saved.error })
      } finally {
        persist()
      }
      return status()
    })().finally(() => { checking = null })
    return checking
  }

  const arm = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!auto()) return
    const wait = Math.max(0, Math.min(nextAt - now(), tick))
    timer = setTimeout(() => {
      timer = null
      if (now() >= nextAt) {
        nextAt = Number.POSITIVE_INFINITY // пока идёт проверка, второй не будет
        void runCheck(false).then((st) => {
          // Удача — 6 ч ± 30 мин; провал — 15 мин, 1 ч, 6 ч, потом снова обычный срок.
          if (st.error === null) failures = 0
          const backoff = st.error !== null ? retry[failures++] : undefined
          nextAt = now() + (backoff ?? regularDelay())
        }).finally(arm)
        return
      }
      arm()
    }, wait)
    timer.unref?.()
  }

  const stopWaitPoll = (): void => { if (waitPoll) { clearInterval(waitPoll); waitPoll = null } }

  /** Пересчитать ходы, которых ждёт «Обновить»; кончились — запуск. */
  const recount = (): void => {
    if (apply.state !== 'waiting') { stopWaitPoll(); return }
    const turns = o.runningTurns()
    // Ходы кончились, но идёт обновление окна (0.3.4): пакет подождёт его конца — общий run/update.lock.
    if (turns === 0 && o.blocked?.()) return
    if (turns === 0) { launch(apply.to); return }
    if (turns !== apply.turns) apply = { ...apply, turns }
  }

  const launch = (to: string): void => {
    stopWaitPoll()
    apply = { state: 'applying', since: new Date(now()).toISOString(), to }
    // Посреди подготовки пакета — дождаться её (тот же update.lock), потом `pult update` только переключит. Окно,
    // которое ещё качается, не ждём: ходы уже придержаны, а новый демон окно возьмёт готовым или скачает сам.
    const pkgStage = pkgStagePromise
    if (pkgStage) {
      o.logger.info('«Перезапустить» ждёт конца подготовки пакета', { to })
      void pkgStage.catch(() => { /* провал подготовки — `pult update` скачает сам */ }).finally(() => { if (!stopped && apply.state === 'applying' && child === null) spawnApplyChild(to) })
      return
    }
    spawnApplyChild(to)
  }

  const spawnApplyChild = (to: string): void => {
    o.logger.info('запускаю pult update', { to, from: o.current })
    const ended = (ok: boolean): void => { try { o.onApplyEnd?.({ ok }) } catch (e) { o.logger.warn('очереди после обновления не разбудились', { error: (e as Error).message }) } }
    const fail = (error: string): void => { apply = { state: 'failed', at: new Date(now()).toISOString(), error }; ended(false) }
    if (applyWindow) {
      try { o.onLaunch?.(to) } catch (e) { o.logger.warn('журнал обновления не записался — окно придётся обновить отдельно', { error: (e as Error).message }) }
    }
    let k: ApplyChild
    try {
      k = (o.spawnApply ?? ((v: string) => spawnUpdateProcess(o.paths, v, env)))(to)
    } catch (e) {
      fail(`pult update не запустился: ${(e as Error).message}`)
      return
    }
    child = k
    k.on('error', (e) => { if (child === k) fail(`pult update не запустился: ${e.message}`) })
    k.on('exit', (code, signal) => {
      if (child !== k) return
      child = null
      // Удачный `pult update` останавливает этот демон раньше, чем выходит сам, — сюда доходят его
      // провалы: подпись, загрузка, проба с откатом (демон тогда уже новый, но откатный — тот же этот).
      if (code === 0) { apply = { state: 'idle' }; ended(true); return }
      fail(`pult update вышел ${code !== null ? `с кодом ${code}` : `по сигналу ${signal ?? '?'}`} — подробности: ${o.paths.updateLog}`)
      o.logger.warn('pult update не удался', { code, signal })
    })
  }

  /** Одно «Обновить» за раз: второй вызов, пришедший во время первого (там await проверки), получает тот же итог. */
  const applyOnce = async (force: boolean): Promise<{ waiting: number } | { applying: true; to: string }> => {
    if (apply.state === 'applying') return { applying: true, to: apply.to }
    const blocked = o.blocked?.()
    if (blocked) throw new ApplyError(blocked)
    let st = status()
    // Окно жмёт «Обновить» по тому, что видело; итог мог устареть или его ещё не было — проверить заново.
    if (!st.available) st = await runCheck(true)
    // Демон остановили, пока шла проверка: ребёнка `pult update` от остановленного демона не запускать.
    if (stopped) throw new ApplyError('демон останавливается — обновление не запущено')
    // Пока ждали проверку, состояние могло смениться (запуск из poke) — второй ребёнок не нужен.
    if ((apply as UpdateApplyState).state === 'applying') return { applying: true, to: (apply as { to: string }).to }
    const blocked2 = o.blocked?.()
    if (blocked2) throw new ApplyError(blocked2)
    if (!st.available || !st.latest) {
      if (st.bad && st.latest) throw new ApplyError(`${st.latest.version} уже не прошла пробу на этой машине — сама не ставится; повторить: pult update --to ${st.latest.version}`)
      throw new ApplyError(st.error ? `проверить канал не вышло: ${st.error}` : `ставить нечего: ${o.current} — последняя`)
    }
    const to = st.latest.version
    const turns = o.runningTurns()
    if (turns > 0 && !force) {
      apply = { state: 'waiting', turns, since: apply.state === 'waiting' ? apply.since : new Date(now()).toISOString(), to }
      o.logger.info('обновление ждёт конца ходов', { turns, to })
      if (!waitPoll && !stopped) {
        waitPoll = setInterval(recount, WAIT_POLL_MS)
        waitPoll.unref?.()
      }
      return { waiting: turns }
    }
    launch(to)
    return { applying: true, to }
  }

  arm()

  return {
    status,
    check: () => runCheck(true),
    checkIfStale(olderThanMs) {
      if (checking) return checking
      if (!auto()) return Promise.resolve(status())
      const gap = Math.max(MIN_AUTO_GAP_MS, Number.isFinite(olderThanMs) ? olderThanMs : 0)
      if (lastAttemptAt !== null && now() - lastAttemptAt < gap) return Promise.resolve(status())
      return runCheck(false)
    },
    setEnabled(on) {
      if (on === enabled) return
      enabled = on
      o.logger.info(on ? 'автопроверка обновлений включена' : 'автопроверка обновлений выключена')
      if (on) nextAt = now() + firstDelay
      arm()
    },
    apply(force, withWindow = false) {
      if (applyInflight) return applyInflight
      // «Сейчас» поверх ожидания с окном не снимает окно: человек жмёт ту же кнопку быстрее.
      if (apply.state === 'idle' || apply.state === 'failed') applyWindow = withWindow
      else applyWindow = applyWindow || withWindow
      applyInflight = applyOnce(force).finally(() => { applyInflight = null })
      return applyInflight
    },
    staging: () => (pkgStagePromise ?? Promise.resolve()).catch(() => { /* итог подготовки здесь не важен */ }),
    poke() {
      // Демон зовёт poke ИЗ рассылки события, а менеджер сессий обновляет статус хода ПОСЛЕ неё: пересчёт
      // сразу видел бы конец хода ещё «working». Отложить на следующий оборот цикла — и раз на пачку событий.
      if (apply.state !== 'waiting' || pokeQueued) return
      pokeQueued = true
      setImmediate(() => { pokeQueued = false; if (!stopped) recount() })
    },
    applying: () => apply.state === 'applying',
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      stopWaitPoll()
    },
  }
}
