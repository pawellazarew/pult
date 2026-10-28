// Обвязка e2e окна: Playwright `_electron` против собранной оболочки на фальшивых CLI.
//
// Правила (те же, что у тестов пакета):
//   * PULT_TEST=1, PULT_HOME — короткая временная папка (sun_path на macOS — 104 байта);
//   * ни одного настоящего хода модели: PULT_CLAUDE_BIN / PULT_CODEX_BIN — фальшивки из test/fakes,
//     страж сети отвечает PULT_TEST_NET=ok, служба — швом PULT_SERVICE_DIR во временной папке;
//   * каждый процесс, который поднялся за прогон (Electron, демон, поднятый окном, демон, поднятый
//     тестом), убивается в `close()`; состояние из файлов читается только после `waitFor`.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from 'playwright-core'
import type { ElectronApplication, Page } from 'playwright-core'
import type { Client } from '../../../src/cli/client.js'
import type { PultPaths } from '../../../src/core/paths.js'

import type { PultBridge } from '../../src/contract.js'

declare global {
  interface Window {
    pult?: PultBridge
    __pultDebug?: { eventIds(): number[]; connLog(): Array<{ state: string; at: number }>; bootCursor(): number | null }
  }
}

type ClientModule = typeof import('../../../src/cli/client.js')
type PathsModule = typeof import('../../../src/core/paths.js')

// dist-test/e2e/*.test.js → shell/ → корень рабочей копии.
export const SHELL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REPO = path.resolve(SHELL_DIR, '..')
export const RESULTS = path.join(SHELL_DIR, 'test-results')
const FAKE_CLAUDE = path.join(REPO, 'test', 'fakes', 'fake-claude.mjs')
const FAKE_CODEX = path.join(REPO, 'test', 'fakes', 'fake-codex-app-server.mjs')

const pkg = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(REPO, 'dist', rel)).href)) as T

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* ещё не готово */ }
    await sleep(stepMs)
  }
  return false
}

function electronBinary(): string {
  // Пакет electron сам докачивает бинарь при первом require (npx install-electron).
  return createRequire(import.meta.url)('electron') as string
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Настоящий PNG 1×1 (base64): его понимает `nativeImage.createFromBuffer` — e2e вставки картинки из буфера. */
export const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export interface Harness {
  home: string
  paths: PultPaths
  env: Record<string, string>
  app: ElectronApplication
  win: Page
  /** Отдельное соединение теста с демоном (клиент `cli`): emit, tail, status. */
  client(): Promise<Client>
  /** pid демона из lock-файла (или null). */
  daemonPid(): number | null
  /** Поднять демона так, как его подняла бы служба: отдельным процессом, не окном. */
  startDaemonExternally(): Promise<void>
  shot(name: string): Promise<void>
  /** Полноэкранный снимок окна в test-results/screens/<name>.png. */
  screen(name: string): Promise<string>
  /** Папка агента с настройкой fake-claude (`.pult-fake.json`): через окружение её не передать. */
  workDir(name: string, cfg?: Record<string, unknown>): string
  /** Настройка общего fake codex app-server (`PULT_HOME/.pult-fake-codex.json`). */
  codexConfig(cfg: Record<string, unknown>): void
  /** Системный выбор папки отвечает этим путём (Playwright не умеет кликать нативный диалог). */
  stubPickFolder(dir: string): Promise<void>
  /** Светлая или тёмная тема окна. */
  scheme(s: 'light' | 'dark'): Promise<void>
  /**
   * Закрыть окно (демон и агенты живут дальше), выполнить `between` без окна и открыть заново,
   * как по клику в доке.
   */
  reopen(between?: () => Promise<void>): Promise<Page>
  close(): Promise<void>
}

export async function launch(opts: {
  backoff?: string; name: string; args?: string[]; env?: Record<string, string>
  /** Тот же PULT_HOME (и userData окна), что у прошлого запуска: «перезапуск» окна новым процессом. */
  home?: string
  /** close() не удаляет PULT_HOME — его возьмёт следующий launch({home}). */
  keepHome?: boolean
}): Promise<Harness> {
  const home = opts.home ?? mkdtempSync(path.join(tmpdir(), 'pe-'))
  const svcDir = path.join(home, 'svc')
  mkdirSync(svcDir, { recursive: true })
  const pathsMod = await pkg<PathsModule>('core/paths.js')
  const clientMod = await pkg<ClientModule>('cli/client.js')
  const paths = pathsMod.layout(home)

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? home,
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    LANG: 'ru_RU.UTF-8',
    PULT_TEST: '1',
    PULT_HOME: home,
    PULT_UI_ROOT: REPO,
    PULT_NODE: process.execPath,
    PULT_CLAUDE_BIN: FAKE_CLAUDE,
    PULT_CODEX_BIN: FAKE_CODEX,
    PULT_TEST_NET: 'ok',
    PULT_SERVICE_DIR: svcDir,
    ...(opts.backoff ? { PULT_SHELL_BACKOFF: opts.backoff } : {}),
    ...(opts.env ?? {}),
  }

  const clients: Client[] = []
  const children: ChildProcess[] = []
  const pids = new Set<number>()
  const daemonPid = (): number | null => {
    try {
      const n = (JSON.parse(readFileSync(paths.lock, 'utf8')) as { pid?: unknown }).pid
      return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
    } catch { return null }
  }

  const app = await _electron.launch({
    executablePath: electronBinary(),
    // `args` — хвост командной строки: например, ссылка pult:// холодного старта (как у Linux).
    args: [SHELL_DIR, '--use-mock-keychain', ...(opts.args ?? [])],
    env,
    timeout: 30_000,
  })
  // Playwright может освободить канал после внешнего SIGTERM раньше close().
  const appProcess = app.process()
  // Вывод главного процесса Electron (pult-shell, Chromium) и его выход — улики, если Electron умрёт
  // посреди теста: без них Playwright говорит только «Target page, context or browser has been closed».
  const electronOut: string[] = []
  const keep = (stream: string) => (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) electronOut.push(`${new Date().toISOString()} [${stream}] ${line}`)
    }
    if (electronOut.length > 400) electronOut.splice(0, electronOut.length - 400)
  }
  appProcess.stdout?.on('data', keep('out'))
  appProcess.stderr?.on('data', keep('err'))
  let closing = false
  let electronExit: string | null = null
  appProcess.once('exit', (code, signal) => {
    electronExit = `code=${code} signal=${signal}`
    if (!closing) process.stderr.write(`e2e ${opts.name}: Electron вышел до close() (${electronExit}); хвост вывода:\n${electronOut.slice(-15).join('\n')}\n`)
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  // Размер окна и экрана — в вывод: у раннера CI экран меньше рабочего мака, и окно 1280×820 туда не
  // помещается (macOS ужимает его по экрану). PULT_E2E_SIZE=ШxВ задаёт размер окна руками — так
  // прогон у себя повторяет экран раннера.
  const forced = /^(\d+)x(\d+)$/.exec(process.env['PULT_E2E_SIZE'] ?? '')
  if (forced) {
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows()[0]?.setSize(w, hh) }, [Number(forced[1]), Number(forced[2])] as [number, number])
  }
  const geometry = await app.evaluate(({ BrowserWindow, screen }) => ({
    content: BrowserWindow.getAllWindows()[0]?.getContentBounds(),
    workArea: screen.getPrimaryDisplay().workArea,
  }))
  process.stderr.write(`e2e ${opts.name}: окно ${JSON.stringify(geometry.content)}, экран ${JSON.stringify(geometry.workArea)}\n`)

  // Улики на случай провала (CI выкладывает test-results/ артефактом): консоль окна, кадр перед
  // закрытием и логи демона из PULT_HOME, который close() стирает.
  const consoleLines: string[] = []
  const listen = (p: Page): void => { p.on('console', (m) => { consoleLines.push(`${new Date().toISOString()} ${m.type()} ${m.text()}`) }) }
  listen(win)

  let current = win
  const h: Harness = {
    home,
    paths,
    env,
    app,
    get win() { return current },
    async client() {
      const c = await clientMod.connectClient(paths, { client: 'cli' })
      clients.push(c)
      return c
    },
    daemonPid() {
      const pid = daemonPid()
      if (pid) pids.add(pid)
      return pid
    },
    async startDaemonExternally() {
      const logFd = openSync(path.join(home, 'external-daemon.log'), 'a')
      try {
        const child = spawn(process.execPath, [path.join(REPO, 'dist', 'daemon', 'main.js')], {
          env,
          stdio: ['ignore', logFd, logFd],
        })
        children.push(child)
        if (child.pid) pids.add(child.pid)
      } finally {
        closeSync(logFd)
      }
    },
    async shot(name: string) {
      mkdirSync(RESULTS, { recursive: true })
      await current.screenshot({ path: path.join(RESULTS, `${opts.name}-${name}.png`) })
    },
    async screen(name: string) {
      const dir = path.join(RESULTS, 'screens')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${name}.png`)
      // Шрифты и анимации не должны попасть в кадр наполовину.
      await current.evaluate(() => document.fonts.ready.then(() => true))
      await current.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
      return file
    },
    workDir(name: string, cfg: Record<string, unknown> = {}) {
      const dir = path.join(home, 'w', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, ...cfg }))
      return dir
    },
    codexConfig(cfg: Record<string, unknown>) {
      writeFileSync(path.join(home, '.pult-fake-codex.json'), JSON.stringify(cfg))
    },
    async stubPickFolder(dir: string) {
      await app.evaluate(({ dialog }, d) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as typeof dialog.showOpenDialog
      }, dir)
    },
    async scheme(sch: 'light' | 'dark') {
      await current.emulateMedia({ colorScheme: sch })
    },
    async reopen(between?: () => Promise<void>) {
      await current.close()
      if (between) await between()
      assert.equal(app.windows().length, 0, 'окно не закрылось')
      const next = app.waitForEvent('window', { timeout: 15_000 })
      // Ждём его ниже; без этого отказ, пришедший, пока идёт evaluate, — unhandledRejection без причины.
      next.catch(() => {})
      try {
        // Как клик по иконке в доке: macOS шлёт `activate`, оболочка открывает окно заново.
        await app.evaluate(({ app: a }) => { (a as unknown as { emit(e: string): boolean }).emit('activate') })
        current = await next
      } catch (e) {
        const why = electronExit ? `; Electron вышел до close() (${electronExit}), хвост вывода:\n${electronOut.slice(-15).join('\n')}` : ''
        throw new Error(`окно не открылось заново: ${(e as Error).message.split('\n')[0]}${why}`)
      }
      listen(current)
      await current.waitForLoadState('domcontentloaded')
      return current
    },
    async close() {
      mkdirSync(RESULTS, { recursive: true })
      if (!current.isClosed()) await current.screenshot({ path: path.join(RESULTS, `${opts.name}-at-close.png`), timeout: 5000 }).catch(() => {})
      writeFileSync(path.join(RESULTS, `${opts.name}-console.log`), consoleLines.join('\n') + '\n')
      closing = true
      writeFileSync(path.join(RESULTS, `${opts.name}-electron.log`), electronOut.join('\n') + `\nвыход до close(): ${electronExit ?? 'нет'}\n`)
      try { cpSync(paths.logs, path.join(RESULTS, `${opts.name}-logs`), { recursive: true }) } catch { /* логов нет — и ладно */ }
      for (const c of clients) c.close()
      const last = daemonPid()
      if (last) pids.add(last)
      // `app.close()` ждёт выхода Electron без предела. Изредка (07.10.2026: 1 из ~20 локально,
      // на macOS-раннере CI — до таймаута задания в 20 мин) главный процесс выходит десятки секунд;
      // корень не найден. Тест о выходе не судит — ждём 10 с и добиваем, чтобы набор не висел.
      const proc = appProcess
      const closed = await Promise.race([app.close().then(() => true, () => true), sleep(10_000).then(() => false)])
      if (!closed) {
        process.stderr.write(`e2e: Electron не вышел за 10 с после app.close() — SIGKILL (pid ${proc.pid})\n`)
        try { proc.kill('SIGKILL') } catch { /* уже ушёл */ }
      }
      // Демон переживает окно по замыслу (закрыть окно ≠ остановить агентов) — поэтому гасим сами.
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* уже нет */ } }
      await waitFor(() => [...pids].every((p) => !alive(p)), 5000)
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* уже нет */ } }
      for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }
      if (!opts.keepHome) rmSync(home, { recursive: true, force: true })
    },
  }
  return h
}
