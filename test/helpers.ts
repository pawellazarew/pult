// Общая обвязка тестов. Два правила на весь набор:
//   1. PULT_HOME только во временной папке — настоящий ~/.pult не трогается никогда;
//   2. путь сокета короткий: на macOS у sun_path предел 104 байта, и mkdtemp в /var/folders
//      вместе с именем теста туда почти упирается.

import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import type { PultConfig } from '../dist/core/config.js'
import { createLogger } from '../dist/core/log.js'
import type { Logger } from '../dist/core/log.js'
import { encodeLine } from '../dist/core/ndjson.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { startDaemon } from '../dist/daemon/server.js'
import type { DaemonHandle, DaemonOptions } from '../dist/daemon/server.js'

/** Фальшивый `claude`: проигрывает записанные потоки. Ни одного настоящего хода в тестах. */
export const FAKE_CLAUDE = fileURLToPath(new URL('../test/fakes/fake-claude.mjs', import.meta.url))
/** Фальшивый `codex app-server`: тот же приём — записанный протокол вместо модели. */
export const FAKE_CODEX = fileURLToPath(new URL('../test/fakes/fake-codex-app-server.mjs', import.meta.url))
/**
 * ПРОГРАММИРУЕМЫЙ фальшивый app-server: для случаев, которых в записи нет и быть не может
 * (повторный id запроса, запрос по чужому треду, запрос, которого Пульт не умеет).
 */
export const FAKE_CODEX_SCRIPTED = fileURLToPath(new URL('../test/fakes/fake-codex-scripted.mjs', import.meta.url))
/** Собранный CLI: его же запускает заглушка разрешений по --mcp-config. */
export const CLI_ENTRY = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

export interface TempHome {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  remove(): void
}

export function tempHome(): TempHome {
  const dir = mkdtempSync(join(tmpdir(), 'pt-'))
  const paths = layout(dir)
  ensureLayout(paths)
  const logger = createLogger(paths.logFile)
  return {
    paths,
    config: defaultConfig(),
    logger,
    remove() {
      logger.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function startTestDaemon(
  home: TempHome,
  opts: {
    testMode?: boolean; writeBacklogLimit?: number; claudeBin?: string; codexBin?: string; cliEntry?: string
    doctor?: DaemonOptions['doctor']
    titler?: DaemonOptions['titler']
    browserInstall?: DaemonOptions['browserInstall']
    findChrome?: DaemonOptions['findChrome']
    updates?: DaemonOptions['updates']
    codexModels?: DaemonOptions['codexModels']
    queueEditHoldMs?: DaemonOptions['queueEditHoldMs']
  } = {},
): Promise<DaemonHandle> {
  const started = await startDaemon({
    paths: home.paths,
    config: home.config,
    logger: home.logger,
    testMode: opts.testMode ?? true,
    claudeBin: opts.claudeBin ?? FAKE_CLAUDE,
    codexBin: opts.codexBin ?? FAKE_CODEX,
    cliEntry: opts.cliEntry ?? CLI_ENTRY,
    ...(opts.writeBacklogLimit !== undefined ? { writeBacklogLimit: opts.writeBacklogLimit } : {}),
    ...(opts.doctor !== undefined ? { doctor: opts.doctor } : {}),
    ...(opts.titler !== undefined ? { titler: opts.titler } : {}),
    ...(opts.browserInstall !== undefined ? { browserInstall: opts.browserInstall } : {}),
    ...(opts.findChrome !== undefined ? { findChrome: opts.findChrome } : {}),
    ...(opts.updates !== undefined ? { updates: opts.updates } : {}),
    ...(opts.codexModels !== undefined ? { codexModels: opts.codexModels } : {}),
    ...(opts.queueEditHoldMs !== undefined ? { queueEditHoldMs: opts.queueEditHoldMs } : {}),
  })
  if (!started.ok) throw new Error(`демон не стартовал: держит pid ${started.holderPid}`)
  return started.daemon
}

/** Сырое соединение без рукопожатия — им проверяются режимы отказа. */
export interface RawConn {
  socket: net.Socket
  lines: string[]
  next(timeoutMs?: number): Promise<Record<string, unknown>>
  send(obj: unknown): void
  closed: Promise<void>
  end(): void
}

export function rawConnect(paths: PultPaths): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.sock)
    const lines: string[] = []
    const waiters: Array<(line: string) => void> = []
    let buf = ''
    let closedResolve: () => void = () => {}
    const closed = new Promise<void>((r) => { closedResolve = r })

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else lines.push(line)
      }
    })
    socket.on('close', () => closedResolve())
    socket.on('error', () => { /* тест смотрит на close */ })
    socket.once('connect', () => resolve({
      socket,
      lines,
      next(timeoutMs = 3000) {
        const ready = lines.shift()
        if (ready) return Promise.resolve(JSON.parse(ready) as Record<string, unknown>)
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('кадр не пришёл за отведённое время')), timeoutMs)
          waiters.push((line) => { clearTimeout(timer); res(JSON.parse(line) as Record<string, unknown>) })
        })
      },
      send(obj: unknown) { socket.write(encodeLine(obj)) },
      closed,
      end() { socket.destroy() },
    }))
    socket.once('error', reject)
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Ждёт условия, опрашивая его каждые 20 мс. Возвращает false по таймауту. */
export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(20)
  }
  return false
}
