// Окно обновляется само (0.3.4): «Настройки» → «Обновления» → «Обновить окно», `update.apply {target: 'app'}`,
// `pult update --app`. Всё делает ДЕМОН, а не окно: окно закрывается посреди обновления, демон и сессии живут.
//
//   подписанный latest.json (тот же канал и ключ, что у пакета) → `app.darwin-arm64` → zip в PULT_HOME/downloads,
//   размер и sha256 = манифест (байты на диске) → разбор каталога zip (только Pult.app/…, без «..», без записей
//   внутри символической ссылки, потолки) → `ditto -x -k` в PULT_HOME/apps/staging-<v> → проверки бандла
//   (ровно один Pult.app, CFBundleIdentifier = стоящего = APP_BUNDLE_ID, версия = манифест, Mach-O arm64, ссылки
//   не выходят из бандла, `codesign --verify --deep --strict`) → окно закрывается SIGTERM (≤ 10 с, не закрылось —
//   отказ, ничего не тронуто) → прежнее окно уезжает в apps/previous-<старая>/Pult.app, новое встаёт на его место
//   (rename; другой том — копия, сверка, rename) → `lsregister -f` → `open` → проба: за 20 с к демону подключается
//   оболочка НОВОЙ версии (hello). Нет — новое окно гасится, прежнее возвращается и запускается, версия — bad.
//
// ЧЕГО НЕ ДЕЛАЕТ: не трогает демона и сессии (агенты работают дальше), не ставит версию старше или равную
// стоящей, не ставит bad без явного `allowBad`, не идёт вместе с обновлением пакета (общий run/update.lock).
// Подпись ad-hoc: `codesign --verify` — про целостность (бандл не испорчен и не дописан после подписи), а не про
// доверие; доверие — подпись latest.json ключом релизов и sha256 zip из него (docs/DEV.md, модель угроз 0.3.4).

import { execFile } from 'node:child_process'
import { appendFileSync, accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { appDirs } from '../cli/ui.js'
import type { PultConfig } from '../core/config.js'
import { acquireLock, isAlive } from '../core/lock.js'
import type { LockHandle } from '../core/lock.js'
import type { Logger } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { AppUpdateAttempt, AppUpdateStatus, AppUpdateStep } from '../core/rpc.js'
import { compareVersions, isStableVersion } from '../core/semver.js'
import { ChannelError, fetchManifest, trustedKeys, updateUrl } from './channel.js'
import { dirHttpGet, downloadTo, FetchError, httpFor } from './fetch.js'
import type { HttpGet } from './fetch.js'
import type { TrustedKey } from './keys.js'
import type { ReleaseAsset } from './manifest.js'
import { bundleStrings, isBinaryPlist } from './plist.js'
import { readAppState, writeAppState } from './appState.js'

/** CFBundleIdentifier окна (shell/package.json → build.appId). Другой id в архиве или на месте — отказ. */
export const APP_BUNDLE_ID = 'io.github.pawellazarew.pult'
/** Потолок zip окна (~120 МБ сейчас): больше — манифест врёт или канал чужой. */
export const APP_ZIP_MAX_BYTES = 200 * 1024 * 1024
/** Потолок распакованного бандла по каталогу zip — защита диска от zip-бомбы до распаковки. */
export const APP_UNPACKED_MAX_BYTES = 1024 * 1024 * 1024
export const APP_MAX_ENTRIES = 50_000
/** Сколько ждать, пока окно закроется по SIGTERM. Дольше — отказ: окно человека не добивается SIGKILL. */
export const QUIT_WAIT_MS = 10_000
/** Сколько ждать hello от оболочки новой версии после `open`. */
export const HELLO_WAIT_MS = 20_000
/** Сколько ждать выхода НОВОГО окна при откате, прежде чем SIGKILL (оно наше, данных человека в нём нет). */
export const KILL_WAIT_MS = 5_000
const POLL_MS = 100

export class AppUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppUpdateError'
  }
}

/** Итог уже записан в app-update.json (откат не прошёл) — общий обработчик его не переписывает. */
class Recorded extends Error {}

// --- швы ------------------------------------------------------------------------------------------

/** Внешний мир обновления окна. В бою — macOS-утилиты по абсолютным путям; тест подставляет свои. */
export interface AppTools {
  platform: NodeJS.Platform
  arch: string
  /** Где искать Pult.app (как у `pult ui`). */
  appDirs(): string[]
  http: HttpGet
  /** `ditto -x -k <zip> <dest>`. */
  unzip(zip: string, dest: string): Promise<void>
  /** `ditto <src> <dest>` — копия бандла на другой том (со ссылками, правами и xattr). */
  copyTree(src: string, dest: string): Promise<void>
  /** `codesign --verify --deep --strict`; провал — исключение с причиной. */
  codesignVerify(app: string): Promise<void>
  /** Бинарный plist → XML (`plutil -convert xml1`); не вышло — null. */
  plistXml(file: string): Promise<string | null>
  /** pid процессов, чей исполняемый файл — ровно `exe`. */
  findPids(exe: string): Promise<number[]>
  signal(pid: number, sig: NodeJS.Signals): void
  alive(pid: number): boolean
  /** `open -a <app> [--env K=V…]`. */
  open(app: string, env: Record<string, string>): Promise<void>
  /** lsregister с аргументами (`-f <app>`, `-u <app>`). */
  lsregister(args: string[]): Promise<void>
}

const SYS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { PATH: SYS_PATH } }, (err, stdout, stderr) => {
      if (!err) { resolve(String(stdout)); return }
      const why = (String(stderr ?? '').trim() || err.message).split('\n')[0] ?? err.message
      reject(new Error(`${path.basename(bin)}: ${why}`))
    })
  })
}

const realpathOr = (p: string): string => { try { return realpathSync(p) } catch { return p } }

/** Настоящие утилиты macOS. Только по абсолютным путям: PATH демона под launchd не наш. */
export function systemTools(env: NodeJS.ProcessEnv): AppTools {
  return {
    platform: process.platform,
    arch: process.arch,
    appDirs: () => appDirs(env),
    http: httpFor(env),
    unzip: async (zip, dest) => { await run('/usr/bin/ditto', ['-x', '-k', zip, dest], 10 * 60_000) },
    copyTree: async (src, dest) => { await run('/usr/bin/ditto', [src, dest], 10 * 60_000) },
    codesignVerify: async (app) => { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 5 * 60_000) },
    plistXml: (file) => run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file]).catch(() => null),
    findPids: async (exe) => {
      const out = await run('/bin/ps', ['-axww', '-o', 'pid=,comm='], 15_000)
      const want = new Set([exe, realpathOr(exe)])
      const pids: number[] = []
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
        if (m && want.has(m[2] as string)) pids.push(Number(m[1]))
      }
      return pids.filter((p) => p !== process.pid)
    },
    signal: (pid, sig) => { process.kill(pid, sig) },
    alive: isAlive,
    open: async (app, e) => {
      const args = ['-a', app]
      for (const [k, v] of Object.entries(e)) args.push('--env', `${k}=${v}`)
      await run('/usr/bin/open', args, 60_000)
    },
    lsregister: async (args) => { await run(LSREGISTER, args, 60_000) },
  }
}

/**
 * Тестовый режим (PULT_TEST=1, e2e окна): ни одного настоящего `open`, `lsregister`, сигнала и поиска процессов —
 * только запись в PULT_HOME/test-app-tools.log. Распаковка — настоящий ditto (e2e идёт только на macOS); подпись
 * фальшивых бандлов не проверить — «верна», а `PULT_TEST_APP_CODESIGN=fail` её роняет.
 */
export function testTools(paths: PultPaths, env: NodeJS.ProcessEnv): Partial<AppTools> {
  const log = (line: string): void => { try { appendFileSync(path.join(paths.home, 'test-app-tools.log'), `${line}\n`) } catch { /* не важно */ } }
  const dir = env['PULT_TEST_UPDATE_DIR']
  return {
    // Только папки теста: настоящий /Applications тестовый демон не видит вовсе (даже если PULT_TEST не в env).
    appDirs: () => (env['PULT_TEST_APP_DIRS'] ?? '').split(':').filter(Boolean),
    http: dir ? dirHttpGet(dir) : async () => { throw new FetchError('PULT_TEST=1: сеть в тестах не трогается — нужен PULT_TEST_UPDATE_DIR') },
    codesignVerify: async (app) => { log(`codesign ${app}`); if (env['PULT_TEST_APP_CODESIGN'] === 'fail') throw new Error('codesign: тестовый провал подписи') },
    plistXml: async () => null,
    findPids: async () => [],
    signal: () => { /* тест не шлёт сигналов */ },
    alive: () => false,
    open: async (app) => { log(`open ${app}`) },
    lsregister: async (args) => { log(`lsregister ${args.join(' ')}`) },
  }
}

// --- чистые проверки ------------------------------------------------------------------------------

const CPU_ARM64 = 0x0100000c
const CPU_X86_64 = 0x01000007

/** Архитектуры Mach-O по заголовку (тонкий или «толстый»); не Mach-O — null. */
export function machOArchs(head: Buffer): string[] | null {
  if (head.length < 8) return null
  const name = (cpu: number): string => (cpu === CPU_ARM64 ? 'arm64' : cpu === CPU_X86_64 ? 'x86_64' : `cpu-${cpu.toString(16)}`)
  const be = head.readUInt32BE(0)
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = head.readUInt32BE(4)
    // Тот же magic у class-файлов Java; «толстый» Mach-O несёт считанные архитектуры.
    const step = be === 0xcafebabf ? 32 : 20
    if (n === 0 || n > 16 || 8 + n * step > head.length) return null
    return Array.from({ length: n }, (_, i) => name(head.readUInt32BE(8 + i * step)))
  }
  const le = head.readUInt32LE(0)
  if (le === 0xfeedfacf || le === 0xfeedface) return [name(head.readUInt32LE(4))]
  return null
}

export interface ZipScan { entries: number; unpacked: number }

/**
 * Каталог zip ДО распаковки: все записи под `Pult.app/`, без абсолютных путей, «..», обратных косых и NUL; ни
 * одна запись не лежит внутри записи-ссылки (запись сквозь ссылку — классический выход из папки распаковки);
 * только файлы, папки и ссылки, без setuid/setgid; число записей и распакованный размер — под потолком. ZIP64 и
 * многотомные архивы — отказ: `ditto -c -k` для окна их не делает.
 */
export function scanZip(file: string, limits: { maxEntries?: number; maxUnpacked?: number } = {}): ZipScan {
  const maxEntries = limits.maxEntries ?? APP_MAX_ENTRIES
  const maxUnpacked = limits.maxUnpacked ?? APP_UNPACKED_MAX_BYTES
  const bad = (why: string): never => { throw new AppUpdateError(`архив окна: ${why}`) }
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < 22) bad('не zip')
    const tailLen = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) bad('не zip (нет конца каталога)')
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) bad('многотомный архив')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) bad('ZIP64 не принимается')
    if (count === 0) bad('пустой')
    if (count > maxEntries) bad(`${count} записей — больше потолка ${maxEntries}`)
    if (cdOff + cdSize > size) bad('каталог за концом файла')
    const cd = Buffer.alloc(cdSize)
    readSync(fd, cd, 0, cdSize, cdOff)
    let p = 0
    let unpacked = 0
    const names: string[] = []
    const links = new Set<string>()
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) bad('каталог испорчен')
      const madeBy = cd.readUInt16LE(p + 4)
      const usize = cd.readUInt32LE(p + 24)
      const nlen = cd.readUInt16LE(p + 28)
      const xlen = cd.readUInt16LE(p + 30)
      const clen = cd.readUInt16LE(p + 32)
      const ext = cd.readUInt32LE(p + 38)
      if (p + 46 + nlen > cd.length) bad('каталог испорчен')
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8')
      p += 46 + nlen + xlen + clen
      if (usize === 0xffffffff) bad('ZIP64 не принимается')
      unpacked += usize
      if (unpacked > maxUnpacked) bad(`распакованный размер больше потолка ${maxUnpacked} байт`)
      if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/')) bad(`запись «${name.slice(0, 120)}» — недопустимое имя`)
      const segs = name.replace(/\/$/, '').split('/')
      if (segs.some((s) => s === '' || s === '.' || s === '..')) bad(`запись «${name.slice(0, 120)}» — недопустимый путь`)
      if (segs[0] !== 'Pult.app') bad(`запись «${name.slice(0, 120)}» вне Pult.app/`)
      const mode = madeBy >> 8 === 3 ? ext >>> 16 : 0
      const type = mode & 0o170000
      if (type === 0o120000) links.add(segs.join('/'))
      else if (type !== 0 && type !== 0o100000 && type !== 0o040000) bad(`запись «${name.slice(0, 120)}» — не файл, не папка и не ссылка`)
      if (mode & 0o6000) bad(`запись «${name.slice(0, 120)}» с setuid/setgid`)
      names.push(segs.join('/'))
    }
    if (links.size) {
      for (const n of names) {
        const segs = n.split('/')
        for (let k = 1; k < segs.length; k++) {
          if (links.has(segs.slice(0, k).join('/'))) bad(`запись «${n.slice(0, 120)}» лежит внутри символической ссылки`)
        }
      }
    }
    return { entries: count, unpacked }
  } finally {
    closeSync(fd)
  }
}

const within = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep)

/**
 * Дерево бандла после распаковки: только файлы, папки и ОТНОСИТЕЛЬНЫЕ ссылки, которые не выходят из бандла; без
 * setuid/setgid. Ссылка, ведущая наружу, после переезда в /Applications указывала бы куда угодно.
 */
export function checkTree(root: string, maxEntries = APP_MAX_ENTRIES): number {
  let n = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (++n > maxEntries) throw new AppUpdateError(`бандл окна: больше ${maxEntries} файлов`)
      const p = path.join(dir, name)
      const st = lstatSync(p)
      const rel = path.relative(root, p)
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p)
        if (path.isAbsolute(target)) throw new AppUpdateError(`бандл окна: ссылка ${rel} → абсолютный путь ${target.slice(0, 200)}`)
        if (!within(path.resolve(path.dirname(p), target), root)) throw new AppUpdateError(`бандл окна: ссылка ${rel} выходит из бандла (${target.slice(0, 200)})`)
        continue
      }
      if (st.mode & 0o6000) throw new AppUpdateError(`бандл окна: ${rel} с setuid/setgid`)
      if (st.isDirectory()) { walk(p); continue }
      if (!st.isFile()) throw new AppUpdateError(`бандл окна: ${rel} — не файл, не папка и не ссылка`)
    }
  }
  walk(root)
  return n
}

/** Список дерева для сверки копии между томами: путь, тип, размер или цель ссылки. */
function treeListing(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const rel = path.relative(root, p)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.push(`${rel}\tl\t${readlinkSync(p)}`)
      else if (st.isDirectory()) { out.push(`${rel}\td`); walk(p) } else out.push(`${rel}\tf\t${st.size}`)
    }
  }
  walk(root)
  return out
}

// --- поставленное окно ----------------------------------------------------------------------------

export interface InstalledApp {
  dir: string
  app: string
  id: string | null
  version: string | null
  executable: string | null
}

async function readBundle(app: string, tools: Pick<AppTools, 'plistXml'>): Promise<{ id: string | null; version: string | null; executable: string | null } | null> {
  const file = path.join(app, 'Contents', 'Info.plist')
  let text: string
  try {
    if (!lstatSync(file).isFile()) return null
    text = readFileSync(file, 'utf8')
  } catch { return null }
  if (isBinaryPlist(text)) {
    const xml = await tools.plistXml(file)
    if (xml === null) return { id: null, version: null, executable: null }
    text = xml
  }
  return bundleStrings(text)
}

/** Поставленный Pult.app — первый в `appDirs` (как у `pult ui`); синхронно, только XML-plist (для статуса). */
export function locateInstalledApp(dirs: string[]): InstalledApp | null {
  for (const dir of dirs) {
    const app = path.join(dir, 'Pult.app')
    let st
    try { st = lstatSync(app) } catch { continue }
    if (!st.isDirectory()) continue
    let text = ''
    try { text = readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8') } catch { /* нет plist */ }
    const b = text && !isBinaryPlist(text) ? bundleStrings(text) : { id: null, version: null, executable: null }
    return { dir, app, ...b }
  }
  return null
}

/** Чем обновить окно руками, если демону нельзя (нет прав на папку). */
export function manualSteps(url: string | null, dir: string): string {
  return `обнови окно вручную: скачай ${url ?? 'Pult-arm64.zip со страницы релиза'}, распакуй, закрой Пульт (⌘Q) и перетащи Pult.app в ${dir} с заменой (нужен пароль администратора) — или положи его в ~/Applications`
}

/** Можно ли демону заменить бандл: запись в папку и в сам бандл (переезд папки меняет её «..»). */
export function writeProblem(app: string): string | null {
  const dir = path.dirname(app)
  try { accessSync(dir, fsConstants.W_OK | fsConstants.X_OK) } catch { return `нет прав на запись в ${dir} (пользователь не администратор?)` }
  try { accessSync(app, fsConstants.W_OK) } catch { return `нет прав на запись в ${app} (окно поставил другой пользователь?)` }
  return null
}

// --- обновлятель (демон) --------------------------------------------------------------------------

export interface ShellHello {
  version: string | null
  execPath: string | null
}

export interface AppUpdaterOptions {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  env?: NodeJS.ProcessEnv
  keys?: readonly TrustedKey[]
  /** Швы; чего нет — из `systemTools` (под PULT_TEST — ещё и `testTools`). */
  tools?: Partial<AppTools>
  testMode?: boolean
  /** Последний подписанный релиз по итогу проверки канала — откуда «доступно окно X». */
  latestApp(): string | null
  /** Почему нельзя сейчас из-за обновления пакета (ставится или ждёт ходов); null — можно. */
  packageBusy(): string | null
  quitWaitMs?: number
  helloWaitMs?: number
  killWaitMs?: number
  pollMs?: number
}

export interface AppApplyRequest {
  /** Версия, которую видел человек; в канале другая — отказ. */
  expect?: string
  /** Поставить и версию, помеченную bad (`pult update --app --force`). */
  allowBad?: boolean
}

export interface AppUpdater {
  status(): AppUpdateStatus
  /** Проверки до первого байта на диске — синхронно с ответом; дальше работа идёт в фоне. */
  apply(req?: AppApplyRequest): Promise<{ applying: true; to: string; target: 'app' }>
  /** Оболочка подключилась (hello): так видно, что новое окно поднялось. */
  onShellHello(h: ShellHello): void
  busy(): boolean
  /** Дождаться конца идущей работы (тесты, остановка). */
  idle(): Promise<void>
  stop(): void
}

export function createAppUpdater(o: AppUpdaterOptions): AppUpdater {
  const env = o.env ?? process.env
  const tools: AppTools = { ...systemTools(env), ...(o.testMode ? testTools(o.paths, env) : {}), ...(o.tools ?? {}) }
  const testHello = Number(o.testMode ? env['PULT_TEST_APP_HELLO_MS'] : NaN)
  const quitWait = o.quitWaitMs ?? QUIT_WAIT_MS
  const helloWait = o.helloWaitMs ?? (Number.isFinite(testHello) && testHello > 0 ? testHello : HELLO_WAIT_MS)
  const killWait = o.killWaitMs ?? KILL_WAIT_MS
  const poll = o.pollMs ?? POLL_MS
  const keys = o.keys ?? trustedKeys(env)
  const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

  let job: { to: string; from: string | null; step: AppUpdateStep; since: string; done: Promise<void> } | null = null
  let preflight: Promise<{ applying: true; to: string; target: 'app' }> | null = null
  let stopped = false
  const helloWaiters = new Set<(h: ShellHello) => void>()

  const unsupported = (loc: InstalledApp | null): string | null => {
    if (tools.platform !== 'darwin') return 'окно само обновляется только на macOS; на Linux окно — из рабочей копии (pult ui --dev)'
    if (tools.arch !== 'arm64') return `окно собирается только под Apple Silicon (arm64), а здесь ${tools.arch}`
    if (!loc) return 'Pult.app не найден в /Applications и ~/Applications — окно ставится руками (README)'
    if (loc.id !== APP_BUNDLE_ID) return `в ${loc.app} не окно Пульта (CFBundleIdentifier ${loc.id ?? 'не прочитан'})`
    if (loc.version === null || !isStableVersion(loc.version)) return `версия окна в ${loc.app} не читается`
    return null
  }

  const status = (): AppUpdateStatus => {
    const loc = locateInstalledApp(tools.appDirs())
    const why = unsupported(loc)
    const st = readAppState(o.paths)
    const latest = o.latestApp()
    const bad = latest !== null && st.bad.includes(latest)
    const newer = latest !== null && loc?.version != null && isStableVersion(loc.version) && compareVersions(latest, loc.version) > 0
    return {
      unsupported: why,
      installed: loc?.version ?? null,
      path: loc?.app ?? null,
      latest,
      available: why === null && newer && !bad && job === null,
      bad,
      applying: job ? { to: job.to, from: job.from, step: job.step, since: job.since } : null,
      last: st.last,
    }
  }

  const record = (last: AppUpdateAttempt, markBad = false): void => {
    const st = readAppState(o.paths)
    st.last = last
    if (markBad && !st.bad.includes(last.to)) st.bad = [...st.bad, last.to].slice(-20)
    try { writeAppState(o.paths, st) } catch (e) { o.logger.warn('app-update.json не записался', { error: (e as Error).message }) }
  }

  /** Переезд папки: тот же том — rename; другой — копия рядом с целью, сверка, rename, удаление исходной. */
  const moveDir = async (src: string, dst: string): Promise<void> => {
    try { renameSync(src, dst); return } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    }
    const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.incoming-${process.pid}`)
    rmSync(tmp, { recursive: true, force: true })
    try {
      await tools.copyTree(src, tmp)
      const a = treeListing(src)
      const b = treeListing(tmp)
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new AppUpdateError(`копия ${src} → ${dst} не совпала с исходной`)
      renameSync(tmp, dst)
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      throw e
    }
    rmSync(src, { recursive: true, force: true })
  }

  const waitGone = async (pids: number[], ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    for (;;) {
      if (pids.every((p) => !tools.alive(p))) return true
      if (Date.now() >= deadline) return false
      await sleep(poll)
    }
  }

  const helloMatches = (h: ShellHello, to: string, app: string): boolean => {
    const appReal = realpathOr(app)
    const inside = h.execPath !== null && (within(h.execPath, app) || within(realpathOr(h.execPath), appReal))
    if (h.version !== null) return h.version === to && (h.execPath === null || inside)
    if (!inside) return false
    const loc = locateInstalledApp([path.dirname(app)])
    return loc?.version === to
  }

  const waitHello = (to: string, app: string, ms: number): { promise: Promise<boolean>; cancel(): void } => {
    let fn: ((h: ShellHello) => void) | null = null
    let timer: NodeJS.Timeout | null = null
    const promise = new Promise<boolean>((resolve) => {
      fn = (h) => { if (helloMatches(h, to, app)) { cleanup(); resolve(true) } }
      timer = setTimeout(() => { cleanup(); resolve(false) }, ms)
      timer.unref?.()
      helloWaiters.add(fn)
    })
    function cleanup(): void { if (fn) helloWaiters.delete(fn); if (timer) clearTimeout(timer) }
    return { promise, cancel: cleanup }
  }

  const openEnv = (): Record<string, string> => {
    const e: Record<string, string> = {}
    if (env['PULT_HOME']?.trim()) e['PULT_HOME'] = path.resolve(env['PULT_HOME'].trim())
    if (env['PULT_TEST'] === '1') e['PULT_TEST'] = '1'
    return e
  }

  const step = (s: AppUpdateStep): void => {
    if (job) job.step = s
    o.logger.info('обновление окна', { step: s, to: job?.to })
  }

  /** Сама работа. Бросает AppUpdateError с итогом для человека; `record` пишется здесь же. */
  const work = async (loc: InstalledApp & { version: string; executable: string }, to: string, asset: ReleaseAsset): Promise<void> => {
    const from = loc.version
    const fail = (message: string): AppUpdateAttempt => ({ to, from, at: new Date().toISOString(), result: 'failed', message })
    mkdirSync(o.paths.downloads, { recursive: true, mode: 0o700 })
    chmodSync(o.paths.downloads, 0o700)
    mkdirSync(o.paths.apps, { recursive: true, mode: 0o700 })
    chmodSync(o.paths.apps, 0o700)
    const zip = path.join(o.paths.downloads, `Pult-${to}-arm64.zip`)
    const partial = `${zip}.partial-${process.pid}`
    const staging = path.join(o.paths.apps, `staging-${to}`)
    let swapped = false
    try {
      // 1. Загрузка: https, потолки, размер и sha256 из ПОДПИСАННОГО манифеста — по байтам на диске.
      rmSync(partial, { force: true })
      rmSync(zip, { force: true })
      await downloadTo(asset.url, partial, { http: tools.http, size: asset.size, sha256: asset.sha256, what: `Pult-${to}-arm64.zip` })
      renameSync(partial, zip)

      // 2. Проверки: каталог zip до распаковки, распаковка в свежую папку, бандл целиком.
      step('verify')
      scanZip(zip)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { mode: 0o700 })
      await tools.unzip(zip, staging)
      const top = readdirSync(staging)
      if (top.length !== 1 || top[0] !== 'Pult.app') throw new AppUpdateError(`в архиве не ровно один Pult.app: ${top.slice(0, 5).join(', ') || 'пусто'}`)
      const staged = path.join(staging, 'Pult.app')
      const sst = lstatSync(staged)
      if (sst.isSymbolicLink() || !sst.isDirectory()) throw new AppUpdateError('Pult.app в архиве — не папка')
      const b = await readBundle(staged, tools)
      if (!b) throw new AppUpdateError('в архиве нет Contents/Info.plist')
      if (b.id !== APP_BUNDLE_ID || b.id !== loc.id) throw new AppUpdateError(`в архиве чужое приложение: CFBundleIdentifier ${b.id ?? 'не прочитан'}, а у окна ${loc.id ?? '?'}`)
      if (b.version !== to) throw new AppUpdateError(`версия в архиве ${b.version ?? 'не прочитана'}, а в подписанном манифесте ${to}`)
      const exe = b.executable
      if (!exe || exe.includes('/') || exe === '.' || exe === '..') throw new AppUpdateError(`CFBundleExecutable «${exe ?? ''}» не годится`)
      const exePath = path.join(staged, 'Contents', 'MacOS', exe)
      let est
      try { est = lstatSync(exePath) } catch { throw new AppUpdateError(`нет исполняемого файла Contents/MacOS/${exe}`) }
      if (!est.isFile() || !(est.mode & 0o111)) throw new AppUpdateError(`Contents/MacOS/${exe} — не исполняемый файл`)
      const head = Buffer.alloc(4096)
      const hfd = openSync(exePath, 'r')
      let got = 0
      try { got = readSync(hfd, head, 0, head.length, 0) } finally { closeSync(hfd) }
      const archs = machOArchs(head.subarray(0, got))
      if (!archs) throw new AppUpdateError(`Contents/MacOS/${exe} — не Mach-O`)
      if (!archs.includes('arm64')) throw new AppUpdateError(`Contents/MacOS/${exe} без arm64 (${archs.join(', ')})`)
      checkTree(staged)
      try { await tools.codesignVerify(staged) } catch (e) { throw new AppUpdateError(`подпись бандла не сходится: ${(e as Error).message}`) }
      // LaunchServices мог заметить бандл в staging — снять, пока путь существует (иначе претендент на pult://).
      await tools.lsregister(['-u', staged]).catch(() => { /* не был на учёте */ })

      // 3. Окно закрывается само (SIGTERM → Electron выходит штатно, окно успевает сохранить черновики).
      if (stopped) throw new AppUpdateError('демон останавливается — окно не тронуто')
      step('quit')
      const oldExe = path.join(loc.app, 'Contents', 'MacOS', loc.executable)
      const pids = await tools.findPids(oldExe)
      for (const pid of pids) { try { tools.signal(pid, 'SIGTERM') } catch { /* уже вышел */ } }
      if (!(await waitGone(pids, quitWait))) {
        throw new AppUpdateError(`окно не закрылось за ${Math.round(quitWait / 1000)} с — закрой его сам (⌘Q) и повтори; ничего не тронуто`)
      }
      const relaunchOld = async (): Promise<void> => { if (pids.length) await tools.open(loc.app, openEnv()).catch(() => { /* ниже — в сообщении */ }) }

      // 4. Замена. Прежнее окно — в apps/previous-<версия> (один цикл), новое — на его место.
      step('swap')
      const prevDir = path.join(o.paths.apps, `previous-${from}`)
      const prevApp = path.join(prevDir, 'Pult.app')
      rmSync(prevDir, { recursive: true, force: true })
      mkdirSync(prevDir, { mode: 0o700 })
      try { await moveDir(loc.app, prevApp) } catch (e) {
        await relaunchOld()
        throw new AppUpdateError(`прежнее окно не сдвинуть (${(e as Error).message}) — ничего не тронуто`)
      }
      try { await moveDir(staged, loc.app) } catch (e) {
        try { await moveDir(prevApp, loc.app) } catch (e2) {
          record(fail(`новое окно не встало (${(e as Error).message}), а прежнее не вернулось (${(e2 as Error).message}) — оно лежит в ${prevApp}: перетащи его в ${loc.dir}`))
          throw new Recorded('итог записан')
        }
        await relaunchOld()
        throw new AppUpdateError(`новое окно не встало на место (${(e as Error).message}) — прежнее вернул`)
      }
      swapped = true
      await tools.lsregister(['-f', loc.app]).catch((e: unknown) => { o.logger.warn('lsregister -f не прошёл', { error: (e as Error).message }) })
      await tools.lsregister(['-u', prevApp]).catch(() => { /* не был на учёте */ })

      // 5. Запуск и проба: оболочка новой версии здоровается с демоном.
      step('launch')
      const hello = waitHello(to, loc.app, helloWait)
      let launched = true
      try { await tools.open(loc.app, openEnv()) } catch (e) {
        launched = false
        hello.cancel()
        o.logger.warn('новое окно не открылось', { error: (e as Error).message })
      }
      step('health')
      const ok = launched && await hello.promise
      if (ok) {
        record({ to, from, at: new Date().toISOString(), result: 'done', message: `окно ${from} → ${to}` })
        // Прежнее окно держим один цикл; более старые — убрать.
        for (const n of readdirSync(o.paths.apps)) {
          if (n.startsWith('previous-') && n !== `previous-${from}`) rmSync(path.join(o.paths.apps, n), { recursive: true, force: true })
        }
        o.logger.info('окно обновлено', { from, to })
        return
      }

      // 6. Откат: новое окно (оно наше) гасится, прежнее возвращается и запускается, версия — bad.
      step('rollback')
      const why = launched ? `окно ${to} не подключилось к демону за ${Math.round(helloWait / 1000)} с` : `окно ${to} не открылось`
      const newPids = await tools.findPids(path.join(loc.app, 'Contents', 'MacOS', exe))
      for (const pid of newPids) { try { tools.signal(pid, 'SIGTERM') } catch { /* уже вышел */ } }
      if (!(await waitGone(newPids, killWait))) {
        for (const pid of newPids) { try { tools.signal(pid, 'SIGKILL') } catch { /* уже вышел */ } }
        await waitGone(newPids, 2000)
      }
      const failedDir = path.join(o.paths.apps, `failed-${to}`)
      const failedApp = path.join(failedDir, 'Pult.app')
      rmSync(failedDir, { recursive: true, force: true })
      mkdirSync(failedDir, { mode: 0o700 })
      try {
        await moveDir(loc.app, failedApp)
        await moveDir(prevApp, loc.app)
      } catch (e) {
        record(fail(`${why}; откат не прошёл (${(e as Error).message}) — прежнее окно в ${prevApp}: перетащи его в ${loc.dir}`), true)
        throw new Recorded('итог записан')
      }
      await tools.lsregister(['-f', loc.app]).catch(() => { /* не страшно */ })
      await tools.lsregister(['-u', failedApp]).catch(() => { /* не страшно */ })
      rmSync(failedDir, { recursive: true, force: true })
      rmSync(prevDir, { recursive: true, force: true })
      await tools.open(loc.app, openEnv()).catch((e: unknown) => { o.logger.warn('прежнее окно не открылось', { error: (e as Error).message }) })
      record({ to, from, at: new Date().toISOString(), result: 'rolled_back', message: `${why} — вернул ${from}; ${to} больше не предлагается само` }, true)
      o.logger.warn('обновление окна откатано', { to, from, why })
    } catch (e) {
      const msg = (e as Error).message
      if (!(e instanceof Recorded)) {
        const text = e instanceof AppUpdateError || e instanceof FetchError ? msg : `обновление окна упало: ${msg}`
        record(fail(swapped ? `${text} (окно уже заменено — проверь ${loc.app})` : text))
      }
      o.logger.warn('обновление окна не удалось', { to, error: msg })
    } finally {
      rmSync(partial, { force: true })
      rmSync(zip, { force: true })
      rmSync(staging, { recursive: true, force: true })
    }
  }

  const start = async (req: AppApplyRequest): Promise<{ applying: true; to: string; target: 'app' }> => {
    const busy = o.packageBusy()
    if (busy) throw new AppUpdateError(busy)
    const loc0 = locateInstalledApp(tools.appDirs())
    const no = unsupported(loc0)
    if (no) throw new AppUpdateError(no)
    const loc = loc0 as InstalledApp
    // Бинарный Info.plist — дочитать через plutil (статус его пропускает).
    const b = await readBundle(loc.app, tools)
    if (!b || b.id !== APP_BUNDLE_ID || !b.version || !b.executable) throw new AppUpdateError(`Info.plist окна ${loc.app} не читается`)
    let m
    try {
      m = await fetchManifest({ env, url: updateUrl(o.config, env), keys, http: tools.http })
    } catch (e) {
      if (e instanceof ChannelError) throw new AppUpdateError(`проверить канал не вышло: ${e.message}`)
      throw e
    }
    const asset = m.app?.['darwin-arm64']
    if (!m.app || !asset) throw new AppUpdateError(`в релизе ${m.version} нет окна для macOS arm64`)
    const to = m.app.version
    if (asset.size > APP_ZIP_MAX_BYTES) throw new AppUpdateError(`архив окна ${asset.size} байт — больше потолка ${APP_ZIP_MAX_BYTES}`)
    if (compareVersions(to, b.version) <= 0) {
      throw new AppUpdateError(compareVersions(to, b.version) < 0 ? `окно ${b.version} новее канала (${to}) — ставить нечего` : `окно ${b.version} — последнее`)
    }
    if (req.expect !== undefined && req.expect !== to) throw new AppUpdateError(`в канале уже окно ${to}, а ставить просили ${req.expect} — проверь заново`)
    if (!req.allowBad && readAppState(o.paths).bad.includes(to)) {
      throw new AppUpdateError(`окно ${to} уже не встало на этой машине — само не ставится; повторить: pult update --app --force`)
    }
    const nw = writeProblem(loc.app)
    if (nw) throw new AppUpdateError(`${nw} — ${manualSteps(asset.url, loc.dir)}`)
    if (stopped) throw new AppUpdateError('демон останавливается — обновление окна не запущено')
    // Пока шла проверка канала, могло начаться обновление пакета.
    const busy2 = o.packageBusy()
    if (busy2) throw new AppUpdateError(busy2)
    const got = acquireLock(o.paths.updateLock)
    if (!got.ok) throw new AppUpdateError(`идёт обновление пакета (pid ${got.holderPid ?? '?'}) — дождись его конца`)
    const lock: LockHandle = got.lock
    const since = new Date().toISOString()
    const j = { to, from: b.version, step: 'download' as AppUpdateStep, since, done: Promise.resolve() }
    job = j
    o.logger.info('обновление окна', { from: b.version, to, app: loc.app })
    j.done = work({ ...loc, version: b.version, executable: b.executable }, to, asset)
      .finally(() => { lock.release(); if (job === j) job = null })
    return { applying: true, to, target: 'app' }
  }

  return {
    status,
    apply(req = {}) {
      if (job) return Promise.resolve({ applying: true, to: job.to, target: 'app' })
      if (preflight) return preflight
      preflight = start(req).finally(() => { preflight = null })
      return preflight
    },
    onShellHello(h) { for (const fn of [...helloWaiters]) fn(h) },
    busy: () => job !== null || preflight !== null,
    idle: async () => { if (preflight) await preflight.catch(() => {}); if (job) await job.done },
    stop() { stopped = true },
  }
}

/** Значения hello оболочки: строки разумной длины, иначе null. */
export function shellHelloOf(raw: unknown): ShellHello {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const s = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
  return { version: s(o['version'], 40), execPath: s(o['execPath'], 4096) }
}

/** Для `pult update --check`: есть ли у окна обновление по манифесту (без сети — по уже прочитанному). */
export function windowLine(installed: string | null, latest: string | null, bad: boolean): string | null {
  if (installed === null || latest === null) return null
  if (compareVersions(latest, installed) <= 0) return `окно: ${installed} — последнее`
  if (bad) return `окно: ${installed} → в канале ${latest}, но оно уже не встало на этой машине — повторить: pult update --app --force`
  return `окно: ${installed} → доступно ${latest} — обновить: pult update --app (или «Настройки» → «Обновления»)`
}
