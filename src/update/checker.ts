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

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, renameSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PultConfig } from '../core/config.js'
import type { Logger } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { UpdateApplyState, UpdateFailure, UpdateRelease, UpdateStatus } from '../core/rpc.js'
import { compareVersions } from '../core/semver.js'
import { daemonSpawnEnv } from '../cli/startOnDemand.js'
import { atomicWrite } from '../service/fsutil.js'
import { ChannelError, fetchManifest, installedVersion, releaseOf, trustedKeys, updateUrl } from './channel.js'
import type { HttpGet } from './fetch.js'
import type { TrustedKey } from './keys.js'
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
   * «Ставится» кончилось, а демон жив (ребёнок вышел с ошибкой или не запустился): ходы снова можно, и очереди,
   * притихшие на время обновления, надо разбудить (`SessionManager.resumeQueues`).
   */
  onApplyEnd?: () => void
  /** Запуск `pult update --expect <to>`; тест подставляет свой. */
  spawnApply?: (to: string) => ApplyChild
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
  apply(force: boolean): Promise<{ waiting: number } | { applying: true; to: string }>
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
  let nextAt = now() + firstDelay
  let stopped = false
  /** Когда последний раз ходили в сеть (удачно или нет) — предел частоты проверок по фокусу. */
  const savedAt = saved.checkedAt !== null ? Date.parse(saved.checkedAt) : Number.NaN
  let lastAttemptAt: number | null = Number.isFinite(savedAt) ? savedAt : null
  const auto = (): boolean => enabled && scheduleAllowed && !stopped
  const regularDelay = (): number => interval + Math.round((random() * 2 - 1) * jitter)

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
    }
  }

  const persist = (): void => {
    try {
      atomicWrite(o.paths.updateCheck, JSON.stringify({ schema: 1, ...saved }, null, 2) + '\n', 0o600)
    } catch (e) {
      o.logger.warn('итог проверки обновлений не записался', { error: (e as Error).message })
    }
  }

  const check = (): Promise<UpdateStatus> => {
    if (checking) return checking
    lastAttemptAt = now()
    checking = (async () => {
      try {
        const url = updateUrl(o.config, env)
        const m = await fetchManifest({ env, url, keys, ...(o.http ? { http: o.http } : {}) })
        saved = { checkedAt: new Date(now()).toISOString(), error: null, latest: releaseOf(m) }
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
        void check().then((st) => {
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
    if (turns === 0) { launch(apply.to); return }
    if (turns !== apply.turns) apply = { ...apply, turns }
  }

  const launch = (to: string): void => {
    stopWaitPoll()
    apply = { state: 'applying', since: new Date(now()).toISOString(), to }
    o.logger.info('запускаю pult update', { to, from: o.current })
    const ended = (): void => { try { o.onApplyEnd?.() } catch (e) { o.logger.warn('очереди после обновления не разбудились', { error: (e as Error).message }) } }
    const fail = (error: string): void => { apply = { state: 'failed', at: new Date(now()).toISOString(), error }; ended() }
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
      if (code === 0) { apply = { state: 'idle' }; ended(); return }
      fail(`pult update вышел ${code !== null ? `с кодом ${code}` : `по сигналу ${signal ?? '?'}`} — подробности: ${o.paths.updateLog}`)
      o.logger.warn('pult update не удался', { code, signal })
    })
  }

  /** Одно «Обновить» за раз: второй вызов, пришедший во время первого (там await проверки), получает тот же итог. */
  const applyOnce = async (force: boolean): Promise<{ waiting: number } | { applying: true; to: string }> => {
    if (apply.state === 'applying') return { applying: true, to: apply.to }
    let st = status()
    // Окно жмёт «Обновить» по тому, что видело; итог мог устареть или его ещё не было — проверить заново.
    if (!st.available) st = await check()
    // Пока ждали проверку, состояние могло смениться (запуск из poke) — второй ребёнок не нужен.
    if ((apply as UpdateApplyState).state === 'applying') return { applying: true, to: (apply as { to: string }).to }
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
    check,
    checkIfStale(olderThanMs) {
      if (checking) return checking
      if (!auto()) return Promise.resolve(status())
      const gap = Math.max(MIN_AUTO_GAP_MS, Number.isFinite(olderThanMs) ? olderThanMs : 0)
      if (lastAttemptAt !== null && now() - lastAttemptAt < gap) return Promise.resolve(status())
      return check()
    },
    setEnabled(on) {
      if (on === enabled) return
      enabled = on
      o.logger.info(on ? 'автопроверка обновлений включена' : 'автопроверка обновлений выключена')
      if (on) nextAt = now() + firstDelay
      arm()
    },
    apply(force) {
      if (applyInflight) return applyInflight
      applyInflight = applyOnce(force).finally(() => { applyInflight = null })
      return applyInflight
    },
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
