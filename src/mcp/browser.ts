import { t } from '../cli/i18n.js'
// Браузер для агента (О3, docs/14): Playwright MCP (`@playwright/mcp`) в MCP-конфиге сессии.
//
// УСТАНОВКА. Пакет ставится по требованию в `PULT_HOME/mcp/playwright-mcp-<версия>/` npm-ом своего node
// Пульта (src/update/runtime.ts; нет его — npm рядом с node демона). Версия ПРИБИТА гвоздём вместе с
// зависимостями: `mcp/playwright-mcp/{package.json,package-lock.json}` в пакете Пульта (суммы sha512 всех
// трёх тарболов) и `npm ci` по нему — `@latest` или свежий `npm install` значили бы, что любой следующий
// выпуск чужого пакета (или его зависимости) исполняется у владельца без его ведома.
//   * `--ignore-scripts`: install-скриптов у @playwright/mcp 0.0.83 и его зависимостей нет (проверено
//     `npm view` 14.10.2026), а браузеры Playwright Пульт не качает вовсе — работает системный Chrome
//     (`--browser chrome`). PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — пояс к подтяжкам;
//   * `--registry=https://registry.npmjs.org/`, `npm_config_globalconfig` = /dev/null, `npm_config_userconfig` — пустой файл,
//     `HOME=PULT_HOME`, кэш npm в `PULT_HOME/npm-cache`: чужой .npmrc (зеркало, токен) не читается, ~/.npm
//     не трогается;
//   * в `<каталог>.partial-<pid>`, проверка версии и cli.js, затем rename: полуразложенный пакет пакетом не
//     считается; следы убитых установок (`.partial-*`, `.old-*`) убирает следующая — под lock;
//   * одна установка за раз — `run/mcp-install.lock` (CLI `pult browser install` и демон);
//   * событийный цикл демона не стоит: npm — асинхронный ребёнок (env/exec.ts);
//   * под PULT_TEST=1 сеть не трогается: lock-файл — только из PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR (`--offline`).
//
// СЕССИЯ. Свой профиль браузера на сессию (`PULT_HOME/browser/<сессия>/profile`, 0700) — не Chrome владельца
// с его куками; войти на нужный сайт можно руками в окне этого профиля (режим «показывать окно»), вход
// переживает перезапуск. Скачивания и снимки страниц — в `PULT_HOME/browser/<сессия>/downloads`; сервер
// запускается С ЭТОЙ ПАПКОЙ КАК cwd: Playwright MCP пускает к файлам (загрузка на сайт, file://) только внутри
// корней рабочей области (без корней от клиента — cwd), пока не передан `--allow-unrestricted-file-access`.
// Каждый вызов инструмента браузера идёт через Inbox: у Claude — правило `permissions.ask`, у Codex —
// `default_tools_approval_mode = "prompt"` и запрос `mcpServer/elicitation/request`. Инструменты, исполняющие
// произвольный код (`browser_run_code_unsafe` — код Playwright в node, `browser_evaluate` — JS страницы),
// запрещены у обоих.
//
// ИМЯ СЕРВЕРА — `pult_browser`, а не `browser`: у Codex конфиг треда сливается с ~/.codex/config.toml, и свой
// `browser` владельца смешался бы с нашим.

import { existsSync, mkdirSync, chmodSync, copyFileSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventDraft } from '../core/events.js'
import { DAEMON_SESSION } from '../core/events.js'
import { acquireLock, isAlive } from '../core/lock.js'
import type { Logger } from '../core/log.js'
import { redactString } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import { buildChildEnv } from '../env/allowlist.js'
import { execAsync } from '../env/exec.js'
import { isExecutableFile, readActiveRuntime } from '../env/nodeBin.js'
import { locateToolPath } from '../env/locate.js'
import { proxyEnv } from '../update/runtime.js'
import type { McpServerSpec } from './servers.js'

export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp'
/** Прибитая версия. Новую — только руками: lock-файл, install-скрипты, флаги (`cli.js --help`), `tools/list`. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.83'
export const BROWSER_SERVER_NAME = 'pult_browser'
/**
 * Инструменты 0.0.83, исполняющие произвольный код (`tools/list`, 14.10.2026): `browser_run_code_unsafe` —
 * код Playwright в процессе node (то есть на машине), `browser_evaluate` — JavaScript в странице.
 * `browser_run_code` — прежнее имя первого: на случай, если пакет обновят, а список забудут.
 */
export const DENIED_BROWSER_TOOLS: readonly string[] = ['browser_run_code_unsafe', 'browser_run_code', 'browser_evaluate']
/** npm с холодным кэшем тянет ~18 МБ (playwright-core); потолок с запасом на медленный канал. */
export const BROWSER_INSTALL_TIMEOUT_MS = 5 * 60_000
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
const PARTIAL = '.partial-'
const OLD = '.old-'
const DEAD = '.dead-'

/** Где Chrome стоит штатно: `--browser chrome` у Playwright ищет его ровно здесь. */
export const STANDARD_CHROME: Readonly<Record<string, string>> = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/opt/google/chrome/chrome',
}

export class BrowserInstallError extends Error {
  /** `busy` — идёт чужая установка (lock занят): её стоит подождать, а не считать провалом. */
  readonly code: 'busy' | 'failed'
  constructor(message: string, code: 'busy' | 'failed' = 'failed') {
    super(message)
    this.name = 'BrowserInstallError'
    this.code = code
  }
}

export const browserPrefix = (paths: PultPaths): string => join(paths.mcp, `playwright-mcp-${PLAYWRIGHT_MCP_VERSION}`)
const packageDirIn = (prefix: string): string => join(prefix, 'node_modules', '@playwright', 'mcp')
export const browserCli = (paths: PultPaths): string => join(packageDirIn(browserPrefix(paths)), 'cli.js')
/** `mcp/playwright-mcp/` пакета Пульта: package.json + package-lock.json с суммами. */
export const PACKAGED_LOCK_DIR = fileURLToPath(new URL('../../mcp/playwright-mcp/', import.meta.url))

/** Версия пакета в каталоге или null (нет, не разбирается, нет cli.js). */
function installedVersionIn(prefix: string): string | null {
  const dir = packageDirIn(prefix)
  if (!existsSync(join(dir, 'cli.js'))) return null
  try {
    const v = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** Стоит ли прибитая версия. Только чтение двух файлов: зовётся перед каждым ходом. */
export function browserInstalled(paths: PultPaths): boolean {
  return installedVersionIn(browserPrefix(paths)) === PLAYWRIGHT_MCP_VERSION
}

/** Chrome: штатное место, у macOS ещё `~/Applications`. null — не найден. */
export function findChrome(opts: { platform?: string; home?: string; exists?: (p: string) => boolean } = {}): string | null {
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? isExecutableFile
  const home = opts.home ?? homedir()
  const list: string[] = []
  if (platform === 'darwin') {
    list.push(STANDARD_CHROME['darwin'] as string, join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  } else if (platform === 'linux') {
    list.push(STANDARD_CHROME['linux'] as string, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable')
  }
  return list.find((p) => exists(p)) ?? null
}

export interface BrowserDirs {
  root: string
  profile: string
  downloads: string
}

export const browserDirs = (paths: PultPaths, session: string): BrowserDirs => {
  const root = join(paths.browser, session)
  return { root, profile: join(root, 'profile'), downloads: join(root, 'downloads') }
}

/** Каталоги сессии — 0700 явным chmod (у mkdir режим маскируется umask): в профиле живут куки входа. */
export function ensureBrowserDirs(paths: PultPaths, session: string): BrowserDirs {
  const d = browserDirs(paths, session)
  for (const dir of [paths.browser, d.root, d.profile, d.downloads]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  return d
}

/**
 * Убрать каталог, не держа событийный цикл: rename в `<путь>.dead-<время>` (мгновенно — дальше по старому
 * пути ничего нет), удаление — асинхронно. Профиль Chrome — тысячи файлов. Нет каталога — ничего.
 */
export async function discardDir(path: string): Promise<void> {
  if (!existsSync(path)) return
  const dead = `${path}${DEAD}${Date.now()}-${process.pid}`
  renameSync(path, dead)
  await rm(dead, { recursive: true, force: true })
}

/**
 * Жив ли Chrome на профиле: он держит `SingletonLock` — симлинк `<хост>-<pid>`. Нет ссылки или pid мёртв —
 * профиль свободен.
 */
export function profileBusy(profile: string): boolean {
  let target: string
  try { target = readlinkSync(join(profile, 'SingletonLock')) } catch { return false }
  const pid = Number.parseInt(target.slice(target.lastIndexOf('-') + 1), 10)
  return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)
}

/**
 * `agent rm`: профиль (куки входа) уходит вместе с сессией. Сначала ждём (до `waitMs`), пока Chrome сессии
 * выйдет — его гасит Playwright MCP, когда claude закрывает ему stdin, — иначе Chrome дописывал бы в
 * удаляемый каталог. Скачивания остаются: это результат работы, его человек мог ещё не забрать.
 */
export async function removeBrowserProfile(paths: PultPaths, session: string, waitMs = 5000): Promise<void> {
  const { profile } = browserDirs(paths, session)
  const deadline = Date.now() + waitMs
  while (profileBusy(profile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await discardDir(profile)
}

/** Новая сессия со старым именем: всё от прежней (профиль и скачивания) — прочь, до первого хода. */
export async function resetBrowserDirs(paths: PultPaths, session: string): Promise<void> {
  await discardDir(browserDirs(paths, session).root)
}

/** Старт демона: добить `*.dead-*`, которые не успели удалиться (демон убили посреди удаления). */
export async function sweepDeadBrowserDirs(paths: PultPaths): Promise<number> {
  let n = 0
  let names: string[]
  try { names = readdirSync(paths.browser) } catch { return 0 }
  for (const name of names) {
    const root = join(paths.browser, name)
    const targets = name.includes(DEAD) ? [root] : (() => { try { return readdirSync(root).filter((x) => x.includes(DEAD)).map((x) => join(root, x)) } catch { return [] } })()
    for (const t of targets) { await rm(t, { recursive: true, force: true }); n++ }
  }
  return n
}

export interface BrowserSpecOptions {
  nodeBin: string
  cli: string
  dirs: BrowserDirs
  headed: boolean
  /** Найденный Chrome; не на штатном месте — уходит `--executable-path`. */
  chrome: string | null
  platform?: string
}

/** Аргументы Playwright MCP. Флаги сверены с `cli.js --help` версии 0.0.83. */
export function browserArgs(o: BrowserSpecOptions): string[] {
  const standard = STANDARD_CHROME[o.platform ?? process.platform]
  return [
    o.cli,
    '--browser', 'chrome',
    ...(o.chrome && o.chrome !== standard ? ['--executable-path', o.chrome] : []),
    '--user-data-dir', o.dirs.profile,
    '--output-dir', o.dirs.downloads,
    // Снимок страницы `browser_navigate` кладёт файлом — путь в ответе абсолютный, иначе он
    // считается от рабочей папки сессии, а файл лежит в PULT_HOME.
    '--file-paths', 'absolute',
    ...(o.headed ? [] : ['--headless']),
  ]
}

/**
 * Команда сервера: `/bin/sh` заходит в папку скачиваний и `exec`-ом отдаёт процесс node. Ни claude, ни
 * обёртка не знают ключа `cwd` для stdio-сервера, а рабочая папка — это корень доступа Playwright MCP к
 * файлам. Аргументы идут позиционно (`$1` — папка, дальше — команда): кавычки и пробелы в путях не важны.
 */
export function browserCommand(o: BrowserSpecOptions): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', 'cd -- "$1" && shift && exec "$@"', 'pult-browser', o.dirs.downloads, o.nodeBin, ...browserArgs(o)] }
}

/** Запись сервера для `--mcp-config` Claude. */
export function browserServerSpec(o: BrowserSpecOptions): McpServerSpec {
  return { type: 'stdio', ...browserCommand(o) }
}

/**
 * То же для `mcp_servers` конфига треда Codex. `default_tools_approval_mode = "prompt"`: спрашивать на
 * КАЖДЫЙ вызов (иначе Codex сам решает по аннотациям инструментов, и «только чтение» прошло бы мимо Inbox).
 * Значения ключа — `auto | prompt | writes | approve` (ответ app-server 0.162 на неверное значение).
 * `disabled_tools` — инструменты, исполняющие код: Codex их модели не показывает вовсе.
 */
export function browserCodexSpec(o: BrowserSpecOptions): McpServerSpec {
  return { ...browserCommand(o), default_tools_approval_mode: 'prompt', disabled_tools: [...DENIED_BROWSER_TOOLS] }
}

/** Правила Claude для сессии с браузером: спрашивать всегда, код — нельзя, скачивания — читать без вопроса. */
export function browserPermissions(dirs: BrowserDirs): { allow: string[]; ask: string[]; deny: string[] } {
  return {
    // `//` — абсолютный путь в правилах Claude Code; только чтение, записи это правило не даёт.
    allow: [`Read(/${dirs.downloads}/**)`],
    ask: [`mcp__${BROWSER_SERVER_NAME}`],
    deny: DENIED_BROWSER_TOOLS.map((t) => `mcp__${BROWSER_SERVER_NAME}__${t}`),
  }
}

/**
 * Режим разрешений Claude по умолчанию из настроек владельца (пользователь, проект, локальные проекта —
 * старшие перекрывают младшие). `bypassPermissions` — браузер не включаем: правило «спрашивать» в этом режиме
 * может не сработать, а браузер с куками без вопросов — слишком. `auto` проверен (smoke-browser, 14.10.2026).
 */
export function claudeDefaultMode(files: readonly string[]): string | null {
  let mode: string | null = null
  for (const f of files) {
    try {
      const v = (JSON.parse(readFileSync(f, 'utf8')) as { permissions?: { defaultMode?: unknown } }).permissions?.defaultMode
      if (typeof v === 'string') mode = v
    } catch { /* нет файла или кривой — не наш */ }
  }
  return mode
}

export function bypassRefusal(): string {
  return t('в настройках Claude стоит permissions.defaultMode = "bypassPermissions": вызовы браузера могли бы идти без вопроса — ')
  + t('браузер для агента не включается. Поменяй режим (например, на "auto") в ~/.claude/settings.json')
}
/** Legacy Russian source retained for callers that imported the old constant. */
export const BYPASS_REFUSAL = 'в настройках Claude стоит permissions.defaultMode = "bypassPermissions": вызовы браузера могли бы идти без вопроса — '
  + 'браузер для агента не включается. Поменяй режим (например, на "auto") в ~/.claude/settings.json'

/**
 * M8d: режим подтверждений сессии, при котором браузер для агента не включается (тот же принцип, что у
 * `bypassPermissions` в настройках владельца: браузер с куками без вопросов — слишком):
 *   * Claude `full` — это и есть `--permission-mode bypassPermissions`;
 *   * Codex `workspace` и `full` — тред идёт с `approvalPolicy: never`: вопрос о вызове инструмента не дошёл бы
 *     до Inbox (как у сессии без брокера — у той браузера нет по той же причине).
 * Отдаёт причину отказа или `null`.
 */
export function approvalBrowserRefusal(provider: string, approval: string | undefined): string | null {
  if (provider === 'claude' && approval === 'full') {
    return t('сессия в режиме «полный доступ» (bypassPermissions): вызовы браузера шли бы без вопроса — браузер для агента не включается')
  }
  if (provider === 'codex' && (approval === 'workspace' || approval === 'full')) {
    return t`у Codex в режиме «${approval === 'full' ? t('полный доступ') : t('правки в папке без вопросов')}» спрашивать некого (approvalPolicy never): `
      + t('вызов браузера не дошёл бы до Inbox — браузер для агента не включается. Нужен браузер — режим «спрашивать» или «только чтение»')
  }
  return null
}

// --- установка ---------------------------------------------------------------

export interface InstallOptions {
  env?: NodeJS.ProcessEnv
  progress?: (s: string) => void
  /** Подмена npm в тестах (путь к исполняемому). */
  npm?: string
  /** Каталог с package.json и package-lock.json (по умолчанию — из пакета Пульта). */
  lockDir?: string
}

export interface InstallResult {
  /** false — уже стояло, ничего не делали. */
  installed: boolean
  version: string
  path: string
}

/** npm своего node Пульта, иначе сосед node демона, иначе найденный в системе. */
export function npmFor(paths: PultPaths): { npm: string; nodeDir: string } {
  const own = readActiveRuntime(paths.runtimeActive)
  for (const node of [own, process.execPath]) {
    if (!node) continue
    const npm = join(dirname(node), 'npm')
    if (existsSync(npm)) return { npm, nodeDir: dirname(node) }
  }
  const found = locateToolPath('npm').path
  if (found) return { npm: found, nodeDir: dirname(process.execPath) }
  throw new BrowserInstallError(t('npm не найден ни у своего node Пульта, ни рядом с node демона — поставь свой node: pult runtime install'))
}

/** Следы прерванных установок в `mcp/` — убирать только под lock: иначе можно снести чужую идущую. */
function sweepPartials(paths: PultPaths): void {
  let names: string[]
  try { names = readdirSync(paths.mcp) } catch { return }
  for (const n of names) {
    if (n.includes(PARTIAL) || n.includes(OLD)) rmSync(join(paths.mcp, n), { recursive: true, force: true })
  }
}

/**
 * Поставить прибитый Playwright MCP по lock-файлу. Уже стоит — ничего не делает. Чужая установка в этот миг —
 * `BrowserInstallError('busy')` (`run/mcp-install.lock`): демон её подождёт, CLI скажет человеку.
 */
export async function installBrowser(paths: PultPaths, opts: InstallOptions = {}): Promise<InstallResult> {
  const env = opts.env ?? process.env
  const prefix = browserPrefix(paths)
  if (browserInstalled(paths)) return { installed: false, version: PLAYWRIGHT_MCP_VERSION, path: prefix }
  const test = env['PULT_TEST'] === '1' || process.env['PULT_TEST'] === '1'
  let lockDir = opts.lockDir ?? PACKAGED_LOCK_DIR
  if (test && !opts.lockDir) {
    const fake = env['PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR']
    if (!fake) throw new BrowserInstallError(t('PULT_TEST=1: сеть в тестах не трогается — нужен PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR'))
    lockDir = fake
  }
  for (const f of ['package.json', 'package-lock.json']) {
    if (!existsSync(join(lockDir, f))) throw new BrowserInstallError(t`нет ${join(lockDir, f)} — пакет Пульта собран без lock-файла браузера`)
  }
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  mkdirSync(paths.mcp, { recursive: true, mode: 0o700 })
  chmodSync(paths.mcp, 0o700)
  const got = acquireLock(paths.mcpInstallLock)
  if (!got.ok) {
    throw new BrowserInstallError(t`уже идёт другая установка (pid ${got.holderPid ?? '?'}${got.holderCmd ? `, ${got.holderCmd}` : ''}) — дождись её конца`, 'busy')
  }
  const work = `${prefix}${PARTIAL}${process.pid}`
  try {
    // Под lock: пока мы ждали его, установку мог закончить сосед.
    if (browserInstalled(paths)) return { installed: false, version: PLAYWRIGHT_MCP_VERSION, path: prefix }
    sweepPartials(paths)
    mkdirSync(work, { recursive: true, mode: 0o700 })
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(lockDir, f), join(work, f))
    // Пустой пользовательский .npmrc: глобальный — /dev/null, а один файл дважды npm не принимает
    // («double-loading config "/dev/null"»).
    const userrc = join(work, '.npmrc-user')
    writeFileSync(userrc, '', { mode: 0o600 })
    const { npm, nodeDir } = opts.npm ? { npm: opts.npm, nodeDir: dirname(process.execPath) } : npmFor(paths)
    opts.progress?.(t`ставлю ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} по lock-файлу в ${prefix}`)
    const args = ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'warn', `--registry=${NPM_REGISTRY}`,
      ...(test ? ['--offline'] : [])]
    const r = await execAsync(npm, args, {
      timeoutMs: BROWSER_INSTALL_TIMEOUT_MS,
      cwd: work,
      env: buildChildEnv({ ...env, HOME: paths.home }, {
        path: `${nodeDir}:${env['PATH'] ?? ''}:/usr/bin:/bin`,
        extra: {
          ...proxyEnv(env),
          npm_config_cache: paths.npmCache,
          npm_config_globalconfig: '/dev/null',
          npm_config_userconfig: userrc,
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        },
      }),
    })
    if (r.status !== 0) {
      const tail = `${r.stderr}\n${r.stdout}`.trim().split('\n').filter(Boolean).slice(-6).join('\n')
      throw new BrowserInstallError(t`npm ci не удался (${r.error ?? t`код ${r.status}`})${tail ? `:\n${redactString(tail)}` : ''}`)
    }
    const v = installedVersionIn(work)
    if (v !== PLAYWRIGHT_MCP_VERSION) {
      throw new BrowserInstallError(t`после npm ci нет ${PLAYWRIGHT_MCP_PACKAGE} ${PLAYWRIGHT_MCP_VERSION} (нашлось: ${v ?? t('ничего')})`)
    }
    if (existsSync(prefix)) {
      // Каталог есть, а годной версии в нём нет (раз мы здесь): отодвигаем и удаляем после подмены.
      const old = `${prefix}${OLD}${process.pid}`
      renameSync(prefix, old)
      renameSync(work, prefix)
      rmSync(old, { recursive: true, force: true })
    } else {
      renameSync(work, prefix)
    }
    return { installed: true, version: PLAYWRIGHT_MCP_VERSION, path: prefix }
  } finally {
    rmSync(work, { recursive: true, force: true })
    got.lock.release()
  }
}

// --- установка в демоне ----------------------------------------------------

export type InstallState =
  | { state: 'missing' }
  | { state: 'installing'; since: string }
  | { state: 'installed' }
  | { state: 'failed'; at: string; error: string }

export interface BrowserInstaller {
  /** Что сейчас: стоит, ставится, упало (с причиной), нет. */
  state(): InstallState
  /**
   * Поставить, если нет; идущая установка — дождаться её. true — стоит. Не бросает: провал — false и
   * состояние `failed`, следующий вызов пробует снова.
   */
  ensure(why: string): Promise<boolean>
}

export interface InstallerOptions {
  paths: PultPaths
  logger: Logger
  /** Событие `browser.install` в журнал (сессия демона). */
  emit(draft: EventDraft): void
  env?: NodeJS.ProcessEnv
  /** Подмена установки в тестах. */
  install?: (paths: PultPaths) => Promise<InstallResult>
  /** Сколько ждать чужую установку (`busy`), прежде чем попробовать самим ещё раз. */
  busyWaitMs?: number
}

/** Одна установка на демона за раз: все, кому нужен браузер, ждут одно и то же обещание. */
export function createBrowserInstaller(o: InstallerOptions): BrowserInstaller {
  let inflight: Promise<boolean> | null = null
  let since = ''
  let failed: { at: string; error: string } | null = null
  const install = o.install ?? ((p: PultPaths) => installBrowser(p, { ...(o.env ? { env: o.env } : {}) }))
  const busyWaitMs = o.busyWaitMs ?? BROWSER_INSTALL_TIMEOUT_MS
  const emit = (data: Record<string, unknown>): void => {
    try {
      o.emit({ sessionId: DAEMON_SESSION, provider: 'pult', kind: 'browser.install', data: { version: PLAYWRIGHT_MCP_VERSION, ...data } })
    } catch (e) {
      o.logger.warn(t('событие browser.install не записалось'), { error: (e as Error).message })
    }
  }
  /**
   * Чужая установка (`pult browser install` в терминале) держит lock — ждём, пока он освободится, и пробуем ОДИН
   * раз ещё: она, скорее всего, уже всё поставила. Ход от этого не становится «упавшим».
   */
  const installOnceMore = async (): Promise<InstallResult> => {
    try {
      return await install(o.paths)
    } catch (e) {
      if (!(e instanceof BrowserInstallError) || e.code !== 'busy') throw e
      o.logger.info(t('браузер агента: идёт чужая установка — жду её'), {})
      const deadline = Date.now() + busyWaitMs
      while (existsSync(o.paths.mcpInstallLock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
      if (browserInstalled(o.paths)) return { installed: false, version: PLAYWRIGHT_MCP_VERSION, path: browserPrefix(o.paths) }
      return await install(o.paths)
    }
  }
  return {
    state() {
      if (inflight) return { state: 'installing', since }
      if (browserInstalled(o.paths)) return { state: 'installed' }
      if (failed) return { state: 'failed', ...failed }
      return { state: 'missing' }
    },
    ensure(why) {
      if (browserInstalled(o.paths)) return Promise.resolve(true)
      if (inflight) return inflight
      since = new Date().toISOString()
      o.logger.info(t('браузер агента: ставлю Playwright MCP'), { why, version: PLAYWRIGHT_MCP_VERSION })
      emit({ state: 'started', why })
      inflight = installOnceMore().then(
        () => {
          failed = null
          o.logger.info(t('браузер агента: Playwright MCP поставлен'), { version: PLAYWRIGHT_MCP_VERSION })
          emit({ state: 'done' })
          return true
        },
        (e: unknown) => {
          const error = redactString((e as Error).message).slice(0, 2000)
          failed = { at: new Date().toISOString(), error }
          o.logger.warn(t('браузер агента: Playwright MCP не поставился'), { error })
          emit({ state: 'failed', error })
          return false
        },
      ).finally(() => { inflight = null })
      return inflight
    },
  }
}
