// Тело процесса `pultd`. Точка входа — `main.js`: она ставит обработчики сигналов ДО загрузки
// этого модуля и его графа импортов и передаёт сюда «ворота» с сигналом, пришедшим за это время.
// Процесс ПЕРЕДНЕГО ПЛАНА: отсоединение делает тот, кто его запускает (CLI через detached+unref,
// launchd/systemd). Так демон одинаково ведёт себя под отладкой, под службой и в тестах.
//
// Коды выхода: 0 — штатная остановка · 1 — не смог стартовать · 3 — другой экземпляр жив.

import { loadConfig } from '../core/config.js'
import { createLogger } from '../core/log.js'
import { ensureLayout, paths as resolvePaths } from '../core/paths.js'
import { startDaemon } from './server.js'
import type { DaemonHandle } from './server.js'

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_ALREADY_RUNNING = 3

/** Сигналы, пойманные точкой входа: `pending` — пришедший до `runDaemon`, `handler` — куда слать дальше. */
export interface SignalGate {
  pending: string | null
  handler: ((signal: string) => void) | null
  /** Фатальная ошибка (`uncaughtException`/`unhandledRejection`) после готовности демона — мягкая остановка. */
  fatal: ((origin: string, error: unknown) => void) | null
}

export async function runDaemon(gate: SignalGate): Promise<void> {
  // Остановить просили, пока грузился код: ничего ещё не начато (ни lock, ни сокета) — чистый выход.
  if (gate.pending !== null) {
    process.stderr.write(`pultd: ${gate.pending} до старта — выхожу\n`)
    process.exit(EXIT_OK)
    return
  }
  const paths = resolvePaths(process.env)
  ensureLayout(paths)
  const logger = createLogger(paths.logFile, { echo: process.env['PULT_LOG_ECHO'] === '1' })
  const { config, warnings } = loadConfig(paths.config)
  for (const w of warnings) logger.warn(w)

  // Сигналы ловит точка входа (main.js) с первых строк; здесь решается, что с ними делать.
  // Сокет появляется внутри startDaemon, и SIGTERM в окне «сокет уже есть, обработчика ещё нет» убивал процесс сигналом:
  // под launchd (`KeepAlive.SuccessfulExit=false`) смерть от сигнала — не штатный выход, и служба
  // поднимала бы демона, которого просили остановить. Поймано на прогоне ci-check 23.09.2026:
  // тест «SIGTERM — чистый выход с кодом 0» получил `signal: 'SIGTERM'` под нагрузкой.
  // Сигнал до конца старта запоминается и исполняется, как только демон готов.
  let daemon: DaemonHandle | null = null
  let stopping = false
  let pendingSignal: string | null = null
  const shutdown = (signal: string): void => {
    if (stopping) return
    if (!daemon) { pendingSignal = signal; return }
    stopping = true
    const d = daemon
    d.stop(`сигнал ${signal}`)
      .then(() => {
        logger.close()
        process.exit(EXIT_OK)
      })
      .catch((e) => {
        // Застрявшая остановка не должна оставлять полуживого демона: неудача — тоже выход,
        // только с кодом ошибки, чтобы служба (KeepAlive по неуспеху) подняла процесс заново.
        logger.error('мягкая остановка провалилась — выхожу с ошибкой', { error: (e as Error).message })
        logger.close()
        process.exit(EXIT_ERROR)
      })
  }
  gate.handler = shutdown
  // Фатальная ошибка после готовности: остановку начинаем, но код выхода — ошибка, а не чистый ноль
  // (launchd по `SuccessfulExit: false` должен понять, что это не «попросили и вышли»).
  gate.fatal = (origin, error) => {
    if (stopping) return
    if (!daemon) {
      logger.error('фатальная ошибка до готовности демона — выхожу', { origin, error: error instanceof Error ? error.message : String(error) })
      process.exit(EXIT_ERROR)
      return
    }
    stopping = true
    logger.error('фатальная ошибка — мягкая остановка', { origin, error: error instanceof Error ? error.message : String(error) })
    const d = daemon
    d.stop(`фатальная ошибка: ${origin}`)
      .then(() => { logger.close(); process.exit(EXIT_ERROR) })
      .catch(() => { logger.close(); process.exit(EXIT_ERROR) })
  }

  let started
  try {
    started = await startDaemon({
      paths,
      config,
      logger,
      testMode: process.env['PULT_TEST'] === '1',
    })
  } catch (e) {
    logger.error('старт демона провалился', { error: (e as Error).message })
    process.stderr.write(`pultd: старт провалился — ${(e as Error).message}\n`)
    process.exit(EXIT_ERROR)
    return
  }

  if (!started.ok) {
    logger.warn('другой экземпляр уже жив', { holderPid: started.holderPid, holderCmd: started.holderCmd })
    // Команда держателя в сообщении не для красоты: если lock держит НЕ pultd (переиспользо-
    // ванный pid), человек должен это увидеть, а не гадать над «уже работает (pid 1)».
    process.stderr.write(
      `pultd: другой экземпляр уже работает (pid ${started.holderPid ?? '?'}`
      + `${started.holderCmd ? `, ${started.holderCmd}` : ''})\n`,
    )
    process.exit(EXIT_ALREADY_RUNNING)
    return
  }

  daemon = started.daemon
  // Строка на stdout нужна запускающему CLI: он ждёт сокет, но по этой строке видно и pid,
  // и что старт дошёл до конца, даже когда stdout уехал в файл журнала.
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, sock: paths.sock }) + '\n')

  daemon.onStopped(() => {
    if (stopping) return
    stopping = true
    logger.close()
    process.exit(EXIT_OK)
  })
  if (pendingSignal !== null) shutdown(pendingSignal)
}
