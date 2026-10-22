// Окно обновляется само (0.3.4): «Настройки» → «Обновления» → «Обновить окно», `update.apply {target: 'app'}`,
// `pult update --app`. Всё делает ДЕМОН, а не окно: окно закрывается посреди обновления, демон и сессии живут.
//
//   подписанный latest.json (тот же канал и ключ, что у пакета) → `app.darwin-arm64` → zip в PULT_HOME/downloads,
//   размер и sha256 = манифест (байты на диске) → разбор каталога zip (только Pult.app/…, без «..», без записей
//   внутри символической ссылки, потолки) → `ditto -x -k` в PULT_HOME/apps/staging-<v> → проверки бандла
//   (ровно один Pult.app, CFBundleIdentifier = стоящего = APP_BUNDLE_ID, версия = манифест, Mach-O arm64, ссылки
//   не выходят из бандла, `codesign --verify --deep --strict`) → новое окно кладётся РЯДОМ со старым
//   (`<папка>/.Pult.app.incoming-<v>`, тот же том; другой — копия со сверкой) → другое открытое окно (не из этого
//   бандла) — отказ → окно закрывается SIGTERM (≤ 10 с, не закрылось — отказ, ничего не тронуто) → журнал
//   apps/swap.json → два rename на одном томе (старое → `.Pult.app.old-<v>`, новое → на место) → старое уезжает в
//   apps/previous-<v> → `lsregister -f` → окно было открыто — `open` и проба: за 60 с готово окно НОВОГО бандла
//   (hello с pid, процесс из нового бандла, запущен после замены, интерфейс сделал первый вызов). Нет — новое окно
//   гасится, прежнее возвращается и открывается, версия — bad. Оборвалось (демон убит) — старт доводит по журналу.
//
// ЧЕГО НЕ ДЕЛАЕТ: не трогает демона и сессии (агенты работают дальше), не ставит версию старше или равную
// стоящей, не ставит bad без явного `allowBad`, не идёт вместе с обновлением пакета (общий run/update.lock).
// Подпись ad-hoc: `codesign --verify` — про целостность (бандл не испорчен и не дописан после подписи), а не про
// доверие; доверие — подпись latest.json ключом релизов и sha256 zip из него (docs/DEV.md, модель угроз 0.3.4).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, accessSync, existsSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { appDirs } from '../cli/ui.js'
import type { PultConfig } from '../core/config.js'
import { acquireLock } from '../core/lock.js'
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
import type { AppPending } from './appState.js'
import { atomicWrite } from '../service/fsutil.js'

/** CFBundleIdentifier окна (shell/package.json → build.appId). Другой id в архиве или на месте — отказ. */
export const APP_BUNDLE_ID = 'io.github.pawellazarew.pult'
/** Потолок zip окна (~120 МБ сейчас): больше — манифест врёт или канал чужой. */
export const APP_ZIP_MAX_BYTES = 200 * 1024 * 1024
/** Потолок распакованного бандла по каталогу zip — защита диска от zip-бомбы до распаковки. */
export const APP_UNPACKED_MAX_BYTES = 1024 * 1024 * 1024
export const APP_MAX_ENTRIES = 50_000
/** Сколько ждать, пока окно закроется по SIGTERM. Дольше — отказ: окно человека не добивается SIGKILL. */
export const QUIT_WAIT_MS = 10_000
/**
 * Сколько ждать готовое новое окно после `open`: сессии от окна не зависят, а первый запуск свежего бандла macOS
 * держит долго (проверка подписи) — лучше подождать, чем откатить годное.
 */
export const HELLO_WAIT_MS = 60_000
/** Сколько остановка демона ждёт работу, уже меняющую бандл: launchd добивает службу через 5 с. */
export const STOP_WAIT_MS = 3_000
/** Старт после обрыва на пробе: столько ждать, не поднимется ли новое окно само (оно переподключится к демону). */
export const RECOVER_WAIT_MS = 15_000
/** Первый запуск окна, заменённого закрытым: столько от hello до готовности интерфейса. */
export const FIRST_RUN_WAIT_MS = 60_000
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
  /** pid процессов ЭТОГО пользователя, чей исполняемый файл — ровно `exe`. */
  findPids(exe: string): Promise<number[]>
  /** Владелец, исполняемый файл и время старта процесса (`ps`); нет процесса — null. */
  procInfo(pid: number): Promise<{ uid: number; exe: string; startedAt: number } | null>
  signal(pid: number, sig: NodeJS.Signals): void
  /** Жив ли процесс; чужой (EPERM) — не «жив»: он не наш и закрытия окна не задерживает. */
  alive(pid: number): boolean
  /** `open -a <app> [--env K=V…]`. */
  open(app: string, env: Record<string, string>): Promise<void>
  /** lsregister с аргументами (`-f <app>`, `-u <app>`). */
  lsregister(args: string[]): Promise<void>
  /** rename(2) — шов, чтобы тест ронял отдельные шаги замены (EXDEV, EACCES). */
  rename(src: string, dst: string): void
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

/** `ps -o etime`: «[[dd-]hh:]mm:ss» → секунды; не то — null. */
export function etimeSeconds(v: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(v.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** Метка этого PULT_HOME в именах рядом с окном: уборка трогает только свои `.Pult.app.*-<метка>`. */
export function homeTag(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 8)
}

const realpathOr = (p: string): string => { try { return realpathSync.native(p) } catch { return p } }

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
    findPids: async (exe) => {
      const out = await run('/bin/ps', ['-axww', '-o', 'pid=,uid=,comm='], 15_000)
      const want = new Set([exe, realpathOr(exe)])
      const uid = process.getuid?.() ?? -1
      const pids: number[] = []
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (m && Number(m[2]) === uid && want.has(m[3] as string)) pids.push(Number(m[1]))
      }
      return pids.filter((p) => p !== process.pid)
    },
    procInfo: async (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null
      // `etime` ([[dd-]hh:]mm:ss) — сколько процесс живёт: старт = сейчас − etime, без разбора даты и перевода
      // часов (lstart — местное время). `etimes` у ps macOS нет.
      const out = await run('/bin/ps', ['-ww', '-o', 'uid=,etime=,comm=', '-p', String(pid)], 15_000).catch(() => '')
      const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(out.split('\n')[0] ?? '')
      const secs = m ? etimeSeconds(m[2] as string) : null
      return m && secs !== null ? { uid: Number(m[1]), exe: m[3] as string, startedAt: Date.now() - secs * 1000 } : null
    },
    signal: (pid, sig) => { process.kill(pid, sig) },
    alive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
    open: async (app, e) => {
      const args = ['-a', app]
      for (const [k, v] of Object.entries(e)) args.push('--env', `${k}=${v}`)
      await run('/usr/bin/open', args, 60_000)
    },
    lsregister: async (args) => { await run(LSREGISTER, args, 60_000) },
    rename: (src, dst) => { renameSync(src, dst) },
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
    findPids: async () => [],
    procInfo: async () => null,
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
    /** Начало и конец каждой локальной записи (заголовок, имя, extra, данные, дескриптор). */
    const spans: Array<{ start: number; end: number; name: string }> = []
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) bad('каталог испорчен')
      const madeBy = cd.readUInt16LE(p + 4)
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const csize = cd.readUInt32LE(p + 20)
      const usize = cd.readUInt32LE(p + 24)
      const localOff = cd.readUInt32LE(p + 42)
      const nlen = cd.readUInt16LE(p + 28)
      const xlen = cd.readUInt16LE(p + 30)
      const clen = cd.readUInt16LE(p + 32)
      const ext = cd.readUInt32LE(p + 38)
      if (p + 46 + nlen > cd.length) bad('каталог испорчен')
      const rawName = cd.subarray(p + 46, p + 46 + nlen)
      const name = rawName.toString('utf8')
      p += 46 + nlen + xlen + clen
      // Локальный заголовок — то, что прочтёт распаковщик: то же имя, метод и размеры, что в каталоге (каталог
      // проверяем мы, а ditto идёт по локальным записям — расхождение и есть подмена).
      const lh = Buffer.alloc(30)
      if (localOff + 30 > cdOff || readSync(fd, lh, 0, 30, localOff) !== 30 || lh.readUInt32LE(0) !== 0x04034b50) bad(`запись «${name.slice(0, 120)}»: нет локального заголовка`)
      const lnlen = lh.readUInt16LE(26)
      const lxlen = lh.readUInt16LE(28)
      const lname = Buffer.alloc(lnlen)
      if (lnlen !== nlen || readSync(fd, lname, 0, lnlen, localOff + 30) !== lnlen || !lname.equals(rawName)) bad(`запись «${name.slice(0, 120)}»: имя в локальном заголовке другое`)
      if (lh.readUInt16LE(8) !== method) bad(`запись «${name.slice(0, 120)}»: метод сжатия в локальном заголовке другой`)
      const lflags = lh.readUInt16LE(6)
      const lcs = lh.readUInt32LE(18)
      const lus = lh.readUInt32LE(22)
      // Бит 3 — размеры в дескрипторе после данных (так пишет ditto): в заголовке нули или те же числа.
      const sizesOk = (lcs === csize && lus === usize) || ((lflags & 8) !== 0 && (flags & 8) !== 0 && lcs === 0 && lus === 0)
      if (!sizesOk) bad(`запись «${name.slice(0, 120)}»: размеры в локальном заголовке другие`)
      let end = localOff + 30 + lnlen + lxlen + csize
      if (lflags & 8) {
        // Дескриптор данных: необязательная подпись 0x08074b50, затем crc, сжатый и полный размеры (не ZIP64).
        const dd = Buffer.alloc(16)
        const got = readSync(fd, dd, 0, 16, end)
        const signed = got >= 4 && dd.readUInt32LE(0) === 0x08074b50
        const base = signed ? 4 : 0
        if (got < base + 12) bad(`запись «${name.slice(0, 120)}»: нет дескриптора данных`)
        if (dd.readUInt32LE(base + 4) !== csize || dd.readUInt32LE(base + 8) !== usize) bad(`запись «${name.slice(0, 120)}»: размеры в дескрипторе другие`)
        end += base + 12
      }
      if (end > cdOff) bad(`запись «${name.slice(0, 120)}» заходит на каталог`)
      spans.push({ start: localOff, end, name })
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
    // Локальные записи — встык, от нуля до каталога: запись, которой нет в каталоге (её распакует ditto, но не
    // проверим мы), или две записи поверх друг друга — отказ.
    spans.sort((a, b) => a.start - b.start)
    let at = 0
    for (const sp of spans) {
      if (sp.start !== at) bad(sp.start > at ? `перед записью «${sp.name.slice(0, 120)}» лишние байты (запись не из каталога?)` : `запись «${sp.name.slice(0, 120)}» наложена на предыдущую`)
      at = sp.end
    }
    if (at !== cdOff) bad('между записями и каталогом лишние байты (запись не из каталога?)')
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
  const rootReal = realpathSync.native(root)
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
        // Цепочка ссылок (`D -> ..`, `C -> D/..`) по буквам внутри, а на деле — снаружи: сверяем настоящий путь.
        // `.native` — realpath(3) системы: JS-вариант Node сводит «D/..» по буквам и цепочку не видит. Ссылка в никуда
        // — отказ: по буквам её не проверить (`F -> D/../nonexist` укажет наружу, когда цель появится).
        let real: string
        try { real = realpathSync.native(p) } catch { throw new AppUpdateError(`бандл окна: ссылка ${rel} ведёт в никуда (${target.slice(0, 200)})`) }
        if (!within(real, rootReal)) throw new AppUpdateError(`бандл окна: ссылка ${rel} выходит из бандла через цепочку ссылок`)
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

/** Список дерева для сверки копии между томами: путь, тип, права, размер или цель ссылки. */
function treeListing(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const rel = path.relative(root, p)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.push(`${rel}\tl\t${readlinkSync(p)}`)
      else if (st.isDirectory()) { out.push(`${rel}\td\t${(st.mode & 0o7777).toString(8)}`); walk(p) } else out.push(`${rel}\tf\t${(st.mode & 0o7777).toString(8)}\t${st.size}`)
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

/**
 * Строки Info.plist бандла. Только XML (так пишет electron-builder): бинарный plist — «не читается», без plutil,
 * одинаково для статуса и для работы. Нет файла — null.
 */
function readBundle(app: string): { id: string | null; version: string | null; executable: string | null } | null {
  const file = path.join(app, 'Contents', 'Info.plist')
  let text: string
  try {
    if (!lstatSync(file).isFile()) return null
    text = readFileSync(file, 'utf8')
  } catch { return null }
  return isBinaryPlist(text) ? { id: null, version: null, executable: null } : bundleStrings(text)
}

/** Бандл, которому принадлежит исполняемый файл (`…/X.app/Contents/MacOS/…` → `…/X.app`); не бандл — сам путь. */
export function bundleOf(exe: string): string {
  return /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] ?? exe
}

/** Лежит ли `p` внутри бандла `app` (по буквам или по настоящему пути). */
export function insideApp(p: string, app: string): boolean {
  return within(p, app) || within(realpathOr(p), realpathOr(app))
}

/**
 * Поставленный Pult.app — первый в `appDirs` (как у `pult ui`). Стоят два (в /Applications и ~/Applications) — тот,
 * чьё окно сейчас открыто (`prefer` — пути исполняемых файлов подключённых окон).
 */
export function locateInstalledApp(dirs: string[], prefer: readonly string[] = []): InstalledApp | null {
  const found: InstalledApp[] = []
  for (const dir of dirs) {
    const app = path.join(dir, 'Pult.app')
    let st
    try { st = lstatSync(app) } catch { continue }
    if (!st.isDirectory()) continue
    found.push({ dir, app, ...(readBundle(app) ?? { id: null, version: null, executable: null }) })
  }
  return found.find((f) => prefer.some((e) => insideApp(e, f.app))) ?? found[0] ?? null
}

/** Чем обновить окно руками, если демону нельзя (нет прав на папку). */
export function manualSteps(url: string | null, dir: string): string {
  const zip = url ?? 'Pult-arm64.zip со страницы релиза'
  // `pult ui` и обновление ищут окно сначала в /Applications: положить новое в ~/Applications мало — старое надо убрать.
  const alt = dir === '/Applications'
    ? ' — или удали /Applications/Pult.app (тоже нужен пароль администратора) и положи новое в ~/Applications'
    : ''
  return `обнови окно вручную: скачай ${zip}, распакуй, закрой Пульт (⌘Q) и перетащи Pult.app в ${dir} с заменой (нужен пароль администратора)${alt}`
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
  /** pid главного процесса оболочки — демон сверяет по нему, что поднялось окно из НОВОГО бандла. */
  pid: number | null
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
  /** Подключённые окна (hello клиентов `shell`): другое окно не из поставленного бандла — отказ до закрытия. */
  shells?(): ShellHello[]
  quitWaitMs?: number
  helloWaitMs?: number
  killWaitMs?: number
  pollMs?: number
  /** Сколько `stop()` ждёт работу, начавшую менять бандл. */
  stopWaitMs?: number
  /** Сколько старт демона после обрыва на пробе ждёт готовность нового окна, прежде чем откатить. */
  recoverWaitMs?: number
  /** Сколько первый запуск окна, заменённого закрытым, ждёт готовности после hello. */
  firstRunWaitMs?: number
  /** Как часто, пока ждём первый запуск, смотреть процессы нового бандла (ps). */
  firstRunPollMs?: number
}

export interface AppApplyRequest {
  /** Версия, которую видел человек; в канале другая — отказ. */
  expect?: string
  /** Поставить и версию, помеченную bad (`pult update --app --force`). */
  allowBad?: boolean
  /** Вернуть прежнее окно: новое, заменённое закрытым, не заработало при первом запуске. */
  rollback?: boolean
}

export interface AppUpdater {
  status(): AppUpdateStatus
  /** Проверки до первого байта на диске — синхронно с ответом; дальше работа идёт в фоне. */
  apply(req?: AppApplyRequest): Promise<{ applying: true; to: string; target: 'app' }>
  /**
   * Окно готово: оболочка поздоровалась И её интерфейс сделал первый вызов (`settings.get`, `events.snapshot`…).
   * Так видно, что новое окно не только запустилось, но и работает с этим пакетом.
   */
  onShellReady(h: ShellHello): void
  /** Оболочка поздоровалась (main): первый запуск окна, заменённого закрытым, — пошёл отсчёт готовности. */
  onShellHello(h: ShellHello): void
  busy(): boolean
  /** Восстановление после обрыва прошлой замены (журнал apps/swap.json) — при старте. */
  ready: Promise<void>
  /** Дождаться конца идущей работы (тесты). */
  idle(): Promise<void>
  /** Остановка демона: новых шагов нет; работа, уже меняющая бандл, дожидается (не дольше stopWaitMs). */
  stop(): Promise<void>
}

/** Журнал замены: пишется ДО первого rename и по каждому шагу; по нему старт демона доводит или откатывает. */
interface SwapJournal {
  schema: 1
  app: string
  dir: string
  /** Прежнее окно рядом с местом (`<dir>/.Pult.app.old-<from>`), пока не уехало в PULT_HOME. */
  old: string
  /** Новое окно рядом с местом до замены (`<dir>/.Pult.app.incoming-<to>`). */
  incoming: string
  /** Где прежнее окно сейчас (old или apps/previous-<from>/Pult.app). */
  prev: string
  from: string
  to: string
  phase: 'swap' | 'swapped' | 'health' | 'rollback'
  wasRunning: boolean
  at: string
  /** Когда новое окно встало на место (мс): готовым считается только процесс, запущенный после. */
  swapAt?: number
}

/** Шаги, после которых бандл уже меняется: остановка демона их дожидается. */
const PAST_QUIT: ReadonlySet<AppUpdateStep> = new Set<AppUpdateStep>(['swap', 'launch', 'health', 'rollback'])

export function createAppUpdater(o: AppUpdaterOptions): AppUpdater {
  const env = o.env ?? process.env
  const tools: AppTools = { ...systemTools(env), ...(o.testMode ? testTools(o.paths, env) : {}), ...(o.tools ?? {}) }
  const testHello = Number(o.testMode ? env['PULT_TEST_APP_HELLO_MS'] : NaN)
  const quitWait = o.quitWaitMs ?? QUIT_WAIT_MS
  const helloWait = o.helloWaitMs ?? (Number.isFinite(testHello) && testHello > 0 ? testHello : HELLO_WAIT_MS)
  const killWait = o.killWaitMs ?? KILL_WAIT_MS
  const poll = o.pollMs ?? POLL_MS
  const stopWait = o.stopWaitMs ?? STOP_WAIT_MS
  const recoverWait = o.recoverWaitMs ?? RECOVER_WAIT_MS
  const firstRunWait = o.firstRunWaitMs ?? FIRST_RUN_WAIT_MS
  const firstRunPollEvery = o.firstRunPollMs ?? 10_000
  const tag = homeTag(o.paths.home)
  const near = (dir: string, kind: 'incoming' | 'old' | 'failed', v: string): string => path.join(dir, `.Pult.app.${kind}-${v}-${tag}`)
  const keys = o.keys ?? trustedKeys(env)
  const myUid = process.getuid?.() ?? -1
  const shells = (): ShellHello[] => o.shells?.() ?? []
  const preferred = (): string[] => shells().map((h) => h.execPath).filter((x): x is string => x !== null)
  // Таймеры ожидания НЕ unref: идущая работа обязана держать процесс (в демоне его держит сокет, а в CLI-тесте и
  // на Node 22 цикл без ссылок выходил посреди ожидания окна).
  const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
  const journalFile = path.join(o.paths.apps, 'swap.json')

  let job: { to: string; from: string | null; step: AppUpdateStep; since: string; done: Promise<void> } | null = null
  let preflight: Promise<{ applying: true; to: string; target: 'app' }> | null = null
  let stopped = false
  /** Остановка демона будит ожидания пробы: оборванную пробу доведёт старт по журналу, а не таймер в умирающем процессе. */
  let wakeStop: () => void = () => {}
  const stopSignal = new Promise<void>((r) => { wakeStop = r })
  const readyWaiters = new Set<(h: ShellHello) => void>()

  /** Уборка не роняет демона: ошибка — в журнал, и всё. */
  const safe = (what: string, fn: () => void): void => {
    try { fn() } catch (e) { o.logger.warn(`обновление окна: ${what} не вышло`, { error: (e as Error).message }) }
  }

  const unsupported = (loc: InstalledApp | null): string | null => {
    if (tools.platform !== 'darwin') return 'окно само обновляется только на macOS; на Linux окно — из рабочей копии (pult ui --dev)'
    if (tools.arch !== 'arm64') return `окно собирается только под Apple Silicon (arm64), а здесь ${tools.arch}`
    if (!loc) return 'Pult.app не найден в /Applications и ~/Applications — окно ставится руками (README)'
    if (loc.id !== APP_BUNDLE_ID) return `в ${loc.app} не окно Пульта (CFBundleIdentifier ${loc.id ?? 'не прочитан'}; бинарный Info.plist не читается)`
    if (loc.version === null || !isStableVersion(loc.version)) return `версия окна в ${loc.app} не читается`
    return null
  }

  const status = (): AppUpdateStatus => {
    const loc = locateInstalledApp(tools.appDirs(), preferred())
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
      available: why === null && newer && !bad && job === null && !st.pending,
      bad,
      applying: job ? { to: job.to, from: job.from, step: job.step, since: job.since } : null,
      last: st.last,
      firstRun: st.pending ? { to: st.pending.to, from: st.pending.from, state: st.pending.failed ? 'failed' : 'waiting' } : null,
    }
  }

  const record = (last: AppUpdateAttempt | null, markBad = false, pending?: AppPending | null): void => {
    try {
      const st = readAppState(o.paths)
      if (last) st.last = last
      if (last && markBad && !st.bad.includes(last.to)) st.bad = [...st.bad, last.to].slice(-20)
      if (pending !== undefined) st.pending = pending
      writeAppState(o.paths, st)
    } catch (e) { o.logger.warn('app-update.json не записался', { error: (e as Error).message }) }
  }

  const writeJournal = (j: SwapJournal): void => { atomicWrite(journalFile, JSON.stringify(j, null, 2) + '\n', 0o600) }
  const readJournal = (): SwapJournal | null => {
    try {
      const j = JSON.parse(readFileSync(journalFile, 'utf8')) as SwapJournal
      return j && typeof j.app === 'string' && typeof j.prev === 'string' && typeof j.to === 'string' && typeof j.from === 'string' ? j : null
    } catch { return null }
  }
  const dropJournal = (): void => { safe('журнал замены не удалён', () => rmSync(journalFile, { force: true })) }

  /** Копия бандла с проверкой дерева; не совпала — копии нет. Никогда не для живого окна: только staging и прежнее. */
  const copyVerified = async (src: string, dst: string): Promise<void> => {
    rmSync(dst, { recursive: true, force: true })
    try {
      await tools.copyTree(src, dst)
      const a = treeListing(src)
      const b = treeListing(dst)
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new AppUpdateError(`копия ${src} → ${dst} не совпала с исходной`)
    } catch (e) {
      safe('неудачная копия не убрана', () => rmSync(dst, { recursive: true, force: true }))
      throw e
    }
  }

  /**
   * Положить бандл в `dst` (рядом с местом окна): тот же том — rename, другой — копия, сверка дерева (пути, типы,
   * права, размеры, ссылки) и `codesign --verify` копии: запускаться будет она.
   */
  const stageNear = async (src: string, dst: string): Promise<void> => {
    rmSync(dst, { recursive: true, force: true })
    try { tools.rename(src, dst); return } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    }
    await copyVerified(src, dst)
    try { await tools.codesignVerify(dst) } catch (e) {
      safe('копия с неверной подписью не убрана', () => rmSync(dst, { recursive: true, force: true }))
      throw new AppUpdateError(`подпись копии ${dst} не сходится: ${(e as Error).message}`)
    }
  }

  /** Годное прежнее окно: та версия, дерево без ссылок наружу, подпись сходится (кандидата при восстановлении). */
  const validPrev = async (p: string, from: string): Promise<boolean> => {
    try {
      if (readBundle(p)?.version !== from) return false
      checkTree(p)
      await tools.codesignVerify(p)
      return true
    } catch { return false }
  }

  const waitGone = async (pids: number[], ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    for (;;) {
      if (pids.every((p) => !tools.alive(p))) return true
      if (Date.now() >= deadline) return false
      await sleep(poll)
    }
  }

  /** Погасить окна из бандла (они наши — новое окно или осиротевшее после обрыва): SIGTERM, потом SIGKILL. */
  const killApp = async (exe: string, found?: number[]): Promise<number> => {
    const pids = found ?? await tools.findPids(exe)
    for (const pid of pids) { try { tools.signal(pid, 'SIGTERM') } catch { /* уже вышел */ } }
    if (!(await waitGone(pids, killWait))) {
      for (const pid of pids) { try { tools.signal(pid, 'SIGKILL') } catch { /* уже вышел */ } }
      await waitGone(pids, 2000)
    }
    return pids.length
  }

  /**
   * Готовое окно — НОВОЕ: pid из hello — процесс этого пользователя, его исполняемый файл внутри поставленного
   * бандла, запущен после замены; бандл на месте — новой версии. Версия из hello (если есть) — та же.
   */
  const readyOk = async (h: ShellHello, to: string, app: string, swapAt: number): Promise<boolean> => {
    if (h.pid === null || (h.version !== null && h.version !== to)) return false
    const info = await tools.procInfo(h.pid).catch(() => null)
    if (!info || info.uid !== myUid || !insideApp(info.exe, app)) return false
    // etime — с точностью до секунды.
    if (info.startedAt < swapAt - 2000) return false
    return readBundle(app)?.version === to
  }

  /** Ждать готовое новое окно. Подождать можно дважды: проба и последняя сверка перед тем, как гасить. */
  const watchReady = (to: string, app: string, swapAt: number): { wait(ms: number): Promise<boolean>; seen(): boolean; cancel(): void } => {
    let seen = false
    let wake: ((v: boolean) => void) | null = null
    const fn = (h: ShellHello): void => {
      void readyOk(h, to, app, swapAt).then((ok) => { if (ok) { seen = true; wake?.(true) } })
    }
    readyWaiters.add(fn)
    return {
      wait: (ms) => new Promise<boolean>((resolve) => {
        if (seen || stopped) { resolve(seen); return }
        const t = setTimeout(() => { wake = null; resolve(seen) }, ms)
        wake = (v) => { clearTimeout(t); wake = null; resolve(v) }
        void stopSignal.then(() => { if (wake) { clearTimeout(t); wake = null; resolve(seen) } })
      }),
      seen: () => seen,
      cancel: () => { readyWaiters.delete(fn) },
    }
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

  /**
   * Вернуть прежнее окно на место: прежнее — рядом (`.incoming-<from>`: rename или копия из PULT_HOME), новое —
   * в `.failed-<to>`, прежнее — на место. Живое окно между томами не копируется никогда.
   */
  const putBack = async (j: Pick<SwapJournal, 'app' | 'dir' | 'prev' | 'from' | 'to'>, onStaged?: (back: string) => void): Promise<void> => {
    const back = near(j.dir, 'incoming', j.from)
    const failed = near(j.dir, 'failed', j.to)
    if (j.prev !== back) await stageNear(j.prev, back)
    // Прежнее теперь рядом с окном: журнал и pending — до первого rename (обрыв не должен потерять единственную копию).
    onStaged?.(back)
    rmSync(failed, { recursive: true, force: true })
    let movedNew = false
    try { lstatSync(j.app); tools.rename(j.app, failed); movedNew = true } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    try { tools.rename(back, j.app) } catch (e) {
      if (movedNew) safe('новое окно не вернулось на место', () => tools.rename(failed, j.app))
      throw e
    }
    await tools.lsregister(['-f', j.app]).catch(() => { /* не страшно */ })
    await tools.lsregister(['-u', failed]).catch(() => { /* не страшно */ })
    safe('неудачное окно не удалено', () => rmSync(failed, { recursive: true, force: true }))
    safe('previous не удалён', () => rmSync(path.join(o.paths.apps, `previous-${j.from}`), { recursive: true, force: true }))
  }

  /** Где прежнее окно сейчас: после оборванного отката оно могло уже лежать рядом (`.incoming-<from>`). */
  const whereNow = (prev: string, dir: string, from: string): string => {
    const back = near(dir, 'incoming', from)
    for (const p of [prev, back]) { try { lstatSync(p); return p } catch { /* нет */ } }
    return prev
  }

  /** Убрать apps/previous-* кроме прежнего окна этого цикла и (если есть) прежнего окна, ждущего первого запуска. */
  const cleanPrevious = (keepFrom: string, alsoKeep: string | null): void => {
    safe('старые previous не убраны', () => {
      for (const n of readdirSync(o.paths.apps)) {
        if (n.startsWith('previous-') && n !== `previous-${keepFrom}` && (alsoKeep === null || n !== `previous-${alsoKeep}`)) {
          rmSync(path.join(o.paths.apps, n), { recursive: true, force: true })
        }
      }
    })
  }

  // --- окно, заменённое закрытым: первый запуск -------------------------------------------------------
  let pendingWatch: ((h: ShellHello) => void) | null = null
  const pendingTimers = new Map<number, NodeJS.Timeout>()
  const clearPendingTimers = (): void => { for (const t of pendingTimers.values()) clearTimeout(t); pendingTimers.clear() }

  /** Следить за первым запуском: готовность нового окна — прежнее больше не держим. */
  const armPending = (): void => {
    if (pendingWatch) readyWaiters.delete(pendingWatch)
    pendingWatch = null
    const pd = readAppState(o.paths).pending
    if (!pd) { stopFirstRunPoll(); return }
    if (!pd.failed) startFirstRunPoll()
    const fn = (h: ShellHello): void => {
      void readyOk(h, pd.to, pd.app, pd.swapAt).then((ok) => {
        if (!ok) return
        const cur = readAppState(o.paths).pending
        if (!cur || cur.to !== pd.to || cur.swapAt !== pd.swapAt) return
        record(null, false, null)
        clearPendingTimers()
        stopFirstRunPoll()
        readyWaiters.delete(fn)
        if (pendingWatch === fn) pendingWatch = null
        // Прежнее лежало рядом с окном (в PULT_HOME не уехало) — больше не нужно.
        if (path.basename(pd.prev).startsWith('.Pult.app.old-')) safe('прежнее окно рядом не удалено', () => rmSync(pd.prev, { recursive: true, force: true }))
        cleanPrevious(pd.from, null)
        o.logger.info('первый запуск нового окна — готово', { to: pd.to })
      })
    }
    pendingWatch = fn
    readyWaiters.add(fn)
  }

  /** Процесс из нового бандла замечен (hello или ps): не готов за firstRunWait — «не заработало», предложить вернуть. */
  const startFirstRunTimer = (pid: number, pd: AppPending): void => {
    if (pendingTimers.has(pid)) return
    const t = setTimeout(() => {
      pendingTimers.delete(pid)
      const cur = readAppState(o.paths).pending
      if (!cur || cur.failed || cur.to !== pd.to || cur.swapAt !== pd.swapAt) return
      record({
        to: pd.to, from: pd.from, at: new Date().toISOString(), result: 'failed',
        message: `окно ${pd.to} не заработало при первом запуске за ${Math.round(firstRunWait / 1000)} с — вернуть ${pd.from}: «Вернуть ${pd.from}» в «Настройках» или pult update --app --rollback`,
      }, false, { ...cur, failed: true })
      o.logger.warn('первый запуск нового окна не заработал', { to: pd.to })
    }, firstRunWait)
    t.unref?.()
    pendingTimers.set(pid, t)
  }

  /** Hello из нового бандла при первом запуске. */
  const firstRunHello = async (h: ShellHello): Promise<void> => {
    const pd = readAppState(o.paths).pending
    if (!pd || pd.failed || h.pid === null || pendingTimers.has(h.pid)) return
    const info = await tools.procInfo(h.pid).catch(() => null)
    if (!info || info.uid !== myUid || !insideApp(info.exe, pd.app) || info.startedAt < pd.swapAt - 2000) return
    startFirstRunTimer(h.pid, pd)
  }

  /**
   * Окно, упавшее до подключения к демону, hello не пришлёт: пока ждём первый запуск, раз в firstRunPoll смотрим
   * процессы нового бандла (ps) — замеченный тоже запускает отсчёт.
   */
  let firstRunPoll: NodeJS.Timeout | null = null
  const stopFirstRunPoll = (): void => { if (firstRunPoll) { clearInterval(firstRunPoll); firstRunPoll = null } }
  const startFirstRunPoll = (): void => {
    stopFirstRunPoll()
    firstRunPoll = setInterval(() => {
      const pd = readAppState(o.paths).pending
      if (!pd || pd.failed || stopped) { stopFirstRunPoll(); return }
      const exe = path.join(pd.app, 'Contents', 'MacOS', readBundle(pd.app)?.executable ?? 'Pult')
      void tools.findPids(exe).then((pids) => { for (const pid of pids) startFirstRunTimer(pid, pd) }, () => { /* ps не ответил — в следующий раз */ })
    }, firstRunPollEvery)
    firstRunPoll.unref?.()
  }

  /** Вернуть прежнее окно, ждущее первого запуска нового (по просьбе человека). */
  const rollbackPending = async (pd: AppPending): Promise<void> => {
    const at = (): string => new Date().toISOString()
    try {
      if (!(await validPrev(pd.prev, pd.from))) throw new AppUpdateError(`прежнее окно ${pd.from} в ${pd.prev} не годится (нет, другая версия или подпись не сходится)`)
      const exe = readBundle(pd.app)?.executable ?? 'Pult'
      const dir = path.dirname(pd.app)
      // Журнал — ДО первого шага, как у отката после пробы: обрыв или сбой rename доведёт старт демона.
      const jr: SwapJournal = {
        schema: 1, app: pd.app, dir, old: near(dir, 'old', pd.from), incoming: near(dir, 'incoming', pd.to), prev: pd.prev,
        from: pd.from, to: pd.to, phase: 'rollback', wasRunning: true, at: at(), swapAt: pd.swapAt,
      }
      writeJournal(jr)
      await killApp(path.join(pd.app, 'Contents', 'MacOS', exe))
      await putBack({ app: pd.app, dir, prev: pd.prev, from: pd.from, to: pd.to }, (back) => {
        writeJournal({ ...jr, prev: back })
        record(null, false, { ...pd, prev: back })
      })
      dropJournal()
      clearPendingTimers()
      stopFirstRunPoll()
      if (pendingWatch) { readyWaiters.delete(pendingWatch); pendingWatch = null }
      record({ to: pd.to, from: pd.from, at: at(), result: 'rolled_back', message: `вернул окно ${pd.from} по просьбе — ${pd.to} больше не предлагается само` }, true, null)
      await tools.open(pd.app, openEnv()).catch(() => { /* откроет человек */ })
    } catch (e) {
      // Журнал (если был записан) остаётся: следующий старт доведёт возврат.
      record({ to: pd.to, from: pd.from, at: at(), result: 'failed', message: `вернуть окно ${pd.from} не вышло: ${(e as Error).message} — прежнее окно в ${whereNow(pd.prev, path.dirname(pd.app), pd.from)}; перезапуск демона доведёт возврат` })
    }
  }

  /** Сама работа. Итог — в `record`; наружу не бросает ничего. */
  const work = async (loc: InstalledApp & { version: string; executable: string }, to: string, asset: ReleaseAsset): Promise<void> => {
    const from = loc.version
    const fail = (message: string): AppUpdateAttempt => ({ to, from, at: new Date().toISOString(), result: 'failed', message })
    const zip = path.join(o.paths.downloads, `Pult-${to}-arm64.zip`)
    const partial = `${zip}.partial-${process.pid}`
    const staging = path.join(o.paths.apps, `staging-${to}`)
    const incoming = near(loc.dir, 'incoming', to)
    const old = near(loc.dir, 'old', from)
    const prevDir = path.join(o.paths.apps, `previous-${from}`)
    const prevApp = path.join(prevDir, 'Pult.app')
    let swapped = false
    try {
      for (const d of [o.paths.downloads, o.paths.apps]) {
        mkdirSync(d, { recursive: true, mode: 0o700 })
        chmodSync(d, 0o700)
      }
      // 1. Загрузка: https, потолки, размер и sha256 из ПОДПИСАННОГО манифеста — по байтам на диске.
      rmSync(partial, { force: true })
      rmSync(zip, { force: true })
      await downloadTo(asset.url, partial, { http: tools.http, size: asset.size, sha256: asset.sha256, what: `Pult-${to}-arm64.zip` })
      tools.rename(partial, zip)

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
      const b = readBundle(staged)
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

      // 3. Новое окно — рядом со старым, на том же томе, ДО закрытия окна: замена потом — два rename, и живое окно
      //    между томами не копируется никогда. Копия сверяется деревом.
      step('stage')
      await stageNear(staged, incoming)
      await tools.lsregister(['-u', staged]).catch(() => { /* не был на учёте */ })
      await tools.lsregister(['-u', incoming]).catch(() => { /* не был на учёте */ })

      // 4. Другое окно (из ~/Applications, рабочей копии) пережило бы замену и заняло замок одного экземпляра —
      //    новое окно не поднялось бы, а откат пометил бы годную версию bad. Пусть его закроют.
      const other = shells().find((h) => h.execPath !== null && !insideApp(h.execPath, loc.app))
      if (other?.execPath) throw new AppUpdateError(`закрой окно из ${bundleOf(other.execPath)} и повтори — пока оно открыто, новое окно не запустится; ничего не тронуто`)

      // 5. Окно закрывается само (SIGTERM → Electron выходит штатно, окно успевает сохранить черновики).
      if (stopped) throw new AppUpdateError('демон останавливается — окно не тронуто')
      step('quit')
      const oldExe = path.join(loc.app, 'Contents', 'MacOS', loc.executable)
      const pids = await tools.findPids(oldExe)
      const wasRunning = pids.length > 0
      for (const pid of pids) { try { tools.signal(pid, 'SIGTERM') } catch { /* уже вышел */ } }
      if (!(await waitGone(pids, quitWait))) {
        throw new AppUpdateError(`окно не закрылось за ${Math.round(quitWait / 1000)} с — закрой его сам (⌘Q) и повтори; ничего не тронуто`)
      }
      const relaunchOld = async (): Promise<void> => { if (wasRunning) await tools.open(loc.app, openEnv()).catch(() => { /* ниже — в сообщении */ }) }
      if (stopped) { await relaunchOld(); throw new AppUpdateError('демон останавливается — окно не тронуто') }

      // 6. Замена: два rename на одном томе; журнал — до первого.
      step('swap')
      const jr: SwapJournal = { schema: 1, app: loc.app, dir: loc.dir, old, incoming, prev: old, from, to, phase: 'swap', wasRunning, at: new Date().toISOString() }
      writeJournal(jr)
      rmSync(old, { recursive: true, force: true })
      try { tools.rename(loc.app, old) } catch (e) {
        dropJournal()
        await relaunchOld()
        throw new AppUpdateError(`прежнее окно не сдвинуть (${(e as Error).message}) — ничего не тронуто`)
      }
      try { tools.rename(incoming, loc.app) } catch (e) {
        try { tools.rename(old, loc.app) } catch (e2) {
          record(fail(`новое окно не встало (${(e as Error).message}), а прежнее не вернулось (${(e2 as Error).message}) — оно лежит в ${old}: переименуй его обратно в ${loc.app}`))
          throw new Recorded('итог записан')
        }
        dropJournal()
        await relaunchOld()
        throw new AppUpdateError(`новое окно не встало на место (${(e as Error).message}) — прежнее вернул`)
      }
      swapped = true
      const swapAt0 = Date.now()
      writeJournal({ ...jr, phase: 'swapped', swapAt: swapAt0 })
      // Прежнее — в PULT_HOME (между томами — копия: живое окно уже на месте). Не вышло — остаётся рядом.
      let prev = old
      try {
        rmSync(prevDir, { recursive: true, force: true })
        mkdirSync(prevDir, { mode: 0o700 })
        try { tools.rename(old, prevApp); prev = prevApp } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          await copyVerified(old, prevApp)
          prev = prevApp
          // Журнал — ДО удаления `.old`: обрыв между ними оставит журнал на живой копии.
          writeJournal({ ...jr, phase: 'swapped', prev })
          safe('прежнее окно рядом не удалено после копии', () => rmSync(old, { recursive: true, force: true }))
        }
      } catch (e) {
        o.logger.warn('прежнее окно осталось рядом с новым', { at: old, error: (e as Error).message })
      }
      writeJournal({ ...jr, phase: 'swapped', prev, swapAt: swapAt0 })
      await tools.lsregister(['-f', loc.app]).catch((e: unknown) => { o.logger.warn('lsregister -f не прошёл', { error: (e as Error).message }) })
      await tools.lsregister(['-u', prev]).catch(() => { /* не был на учёте */ })
      const finishDone = (message: string, pending: AppPending | null): void => {
        dropJournal()
        // Новое уже работало — скрытая копия прежнего рядом с окном не нужна. Не запускалось — держим до первой готовности.
        if (prev === old && !pending) safe('прежнее окно рядом не удалено', () => rmSync(old, { recursive: true, force: true }))
        const keep = readAppState(o.paths).pending
        record({ to, from, at: new Date().toISOString(), result: 'done', message }, false, pending)
        // Прежнее окно держим один цикл; более старые — убрать (кроме прежнего окна, которое ждёт первого запуска).
        // Новое снова не запускалось, а прошлое «ждущее» тоже не запускалось — держим и последнее проверенное окно.
        cleanPrevious(from, pending && keep ? keep.from : null)
        if (pending) armPending()
        o.logger.info('окно обновлено', { from, to })
      }

      // 7. Окно не было открыто — не открываем (проверит первый запуск); было — открыть и ждать готовое новое.
      if (!wasRunning) {
        finishDone(`${from} → ${to}; окно не было открыто — ещё не запускалось, открой его: pult ui`, { to, from, prev, app: loc.app, swapAt: swapAt0, failed: false })
        return
      }
      step('launch')
      const swapAt = Date.now()
      writeJournal({ ...jr, phase: 'health', prev, swapAt })
      const ready = watchReady(to, loc.app, swapAt)
      let launched = true
      try { await tools.open(loc.app, openEnv()) } catch (e) {
        launched = false
        o.logger.warn('новое окно не открылось', { error: (e as Error).message })
      }
      step('health')
      let ok = launched && await ready.wait(helloWait)
      if (!ok && stopped) {
        // Демон останавливается посреди пробы: не гасить окно в спешке — журнал (фаза health) остаётся, старт
        // подождёт новое окно и только потом решит.
        ready.cancel()
        o.logger.info('остановка посреди пробы окна — доведёт старт по журналу', { to })
        throw new Recorded('журнал оставлен')
      }
      if (!ok) {
        step('rollback')
        writeJournal({ ...jr, phase: 'rollback', prev })
        // Последняя сверка: готовность, пришедшая до того, как гасим, — засчитывается.
        ok = ready.seen()
      }
      if (ok) { ready.cancel(); finishDone(`${from} → ${to}`, null); return }

      // 8. Откат: новое окно (оно наше) гасится, прежнее возвращается и открывается, версия — bad.
      const why = launched ? `окно ${to} не подключилось к демону за ${Math.round(helloWait / 1000)} с` : `окно ${to} не открылось`
      const newExe = path.join(loc.app, 'Contents', 'MacOS', exe)
      const newPids = await tools.findPids(newExe)
      // Готовность, проверка которой ещё шла, пока искали процессы, — засчитывается: годное окно не гасим.
      if (ready.seen()) { finishDone(`${from} → ${to}`, null); return }
      ready.cancel()
      await killApp(newExe, newPids)
      try { await putBack({ app: loc.app, dir: loc.dir, prev, from, to }, (back) => { writeJournal({ ...jr, phase: 'rollback', prev: back }) }) } catch (e) {
        record(fail(`${why}; откат не прошёл (${(e as Error).message}) — прежнее окно в ${whereNow(prev, loc.dir, from)}: перетащи его в ${loc.app}`), true)
        throw new Recorded('итог записан')
      }
      dropJournal()
      await relaunchOld()
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
      safe('недокачанный zip не убран', () => rmSync(partial, { force: true }))
      safe('zip не убран', () => rmSync(zip, { force: true }))
      safe('staging не убран', () => rmSync(staging, { recursive: true, force: true }))
      safe('новое окно рядом не убрано', () => rmSync(incoming, { recursive: true, force: true }))
    }
  }

  /**
   * Старт демона: журнал замены есть — прошлая замена оборвалась (демон убит, сбой питания).
   *   * места пусто между двумя rename — прежнее на место (`failed`, не bad);
   *   * новое стоит и окно уже открывали (фаза health) — до RECOVER_WAIT_MS ждём, не поднимется ли оно (окно само
   *     переподключится к демону): поднялось — `done`; нет — откат и bad (проба честно не прошла);
   *   * новое стоит, а окно ещё не открывали (обрыв наш) — откат БЕЗ bad (повторить можно);
   *   * оборван откат — довести, bad.
   * Прежнее окно ищется везде, где оно может быть, и проверяется (версия, дерево, подпись). Потом уборка своих
   * (метка PULT_HOME) `.Pult.app.{incoming,failed,old}-*` рядом с окном и `staging-*`, `failed-*` в apps/.
   */
  const recover = async (): Promise<void> => {
    const j = readJournal()
    if (j) {
      o.logger.warn('обновление окна оборвалось — восстанавливаю', { phase: j.phase, to: j.to, from: j.from })
      try {
        const exists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }
        const at = new Date().toISOString()
        const appV = exists(j.app) ? readBundle(j.app)?.version ?? null : null
        let prev: string | null = null
        for (const c of [j.prev, j.old, path.join(o.paths.apps, `previous-${j.from}`, 'Pult.app'), near(j.dir, 'incoming', j.from)]) {
          if (c !== j.app && exists(c) && await validPrev(c, j.from)) { prev = c; break }
        }
        const rollBack = async (bad: boolean, message: string, result: 'rolled_back' | 'failed' = 'rolled_back'): Promise<void> => {
          if (!prev) throw new AppUpdateError(`прежнего окна ${j.from} не нашёл (стоит ${appV ?? 'ничего'})`)
          if (appV !== null) await killApp(path.join(j.app, 'Contents', 'MacOS', readBundle(j.app)?.executable ?? 'Pult'))
          await putBack({ app: j.app, dir: j.dir, prev, from: j.from, to: j.to }, (back) => { writeJournal({ ...j, prev: back }) })
          // Окно было открыто до замены — открыть прежнее (и только тогда).
          if (j.wasRunning) await tools.open(j.app, openEnv()).catch(() => { /* откроет человек */ })
          // Возврат окна, ждавшего первого запуска (pending той же версии), — ожидание закончено.
          const pd = readAppState(o.paths).pending
          record({ to: j.to, from: j.from, at, result, message }, bad, pd && pd.to === j.to ? null : undefined)
        }
        if (appV === j.from) {
          // Замены не было или откат дошёл до конца — окно прежнее.
          record(j.phase === 'rollback'
            ? { to: j.to, from: j.from, at, result: 'rolled_back', message: `окно ${j.to} не встало — вернул ${j.from}; ${j.to} больше не предлагается само` }
            : { to: j.to, from: j.from, at, result: 'failed', message: 'обновление окна оборвалось до замены — окно прежнее' }, j.phase === 'rollback')
        } else if (appV === null && j.phase === 'swap') {
          await rollBack(false, 'обновление окна оборвалось посреди замены — прежнее окно вернул на место', 'failed')
        } else if (appV === j.to && j.phase === 'health') {
          const w = watchReady(j.to, j.app, j.swapAt ?? Date.parse(j.at))
          const ok = await w.wait(recoverWait)
          w.cancel()
          if (ok) {
            record({ to: j.to, from: j.from, at, result: 'done', message: `${j.from} → ${j.to} (окно поднялось после перезапуска демона)` })
            if (prev && path.basename(prev).startsWith('.Pult.app.old-')) safe('прежнее окно рядом не удалено', () => rmSync(prev as string, { recursive: true, force: true }))
            cleanPrevious(j.from, null)
          } else {
            await rollBack(true, `окно ${j.to} не подключилось к демону и после его перезапуска — вернул ${j.from}; ${j.to} больше не предлагается само`)
          }
        } else if (j.phase === 'rollback') {
          await rollBack(true, `окно ${j.to} не встало — вернул ${j.from}; ${j.to} больше не предлагается само`)
        } else {
          // Новое встало, но окно ещё не открывали: обрыв наш, версия не виновата.
          await rollBack(false, `обновление окна до ${j.to} оборвалось (демон остановлен) до запуска нового окна — вернул ${j.from}; можно повторить`)
        }
        dropJournal()
      } catch (e) {
        record({ to: j.to, from: j.from, at: new Date().toISOString(), result: 'failed', message: `восстановление после обрыва не прошло (${(e as Error).message}) — проверь ${j.app}; прежнее окно: ${whereNow(j.prev, j.dir, j.from)}` })
        o.logger.error('восстановление обновления окна не прошло', { error: (e as Error).message })
        return // журнал и файлы оставлены: человеку и следующему старту есть от чего оттолкнуться
      }
    }
    safe('уборка apps/', () => {
      for (const n of readdirSync(o.paths.apps)) {
        if (n.startsWith('staging-') || n.startsWith('failed-')) rmSync(path.join(o.paths.apps, n), { recursive: true, force: true })
      }
    })
    // Рядом с окном — только СВОИ (метка этого PULT_HOME) и не прежнее окно, ждущее первого запуска нового.
    // Ждущее первого запуска: прежнее окно — где оно записано И рядом с окном (куда его кладёт возврат).
    const pdk = readAppState(o.paths).pending
    const keep = new Set<string>(pdk ? [pdk.prev, near(path.dirname(pdk.app), 'incoming', pdk.from)] : [])
    const mine = new RegExp(`^\\.Pult\\.app\\.(incoming|failed|old)-.+-${tag}$`)
    for (const dir of tools.appDirs()) {
      safe(`уборка ${dir}`, () => {
        for (const n of readdirSync(dir)) {
          const p = path.join(dir, n)
          if (mine.test(n) && !keep.has(p)) rmSync(p, { recursive: true, force: true })
        }
      })
    }
  }
  const ready: Promise<void> = (existsSync(o.paths.apps) ? recover() : Promise.resolve())
    .catch((e: unknown) => { o.logger.error('восстановление обновления окна упало', { error: (e as Error).message }) })
    .then(() => { armPending() })

  const takeLock = (): LockHandle => {
    const got = acquireLock(o.paths.updateLock)
    if (!got.ok) throw new AppUpdateError(`идёт обновление пакета (pid ${got.holderPid ?? '?'}) — дождись его конца`)
    return got.lock
  }
  const runJob = (j: { to: string; from: string | null; step: AppUpdateStep; since: string; done: Promise<void> }, lock: LockHandle, fn: () => Promise<void>): void => {
    job = j
    j.done = fn()
      .catch((e: unknown) => { o.logger.error('обновление окна упало', { error: (e as Error).message }) })
      .finally(() => {
        safe('update.lock не снят', () => lock.release())
        if (job === j) job = null
      })
  }

  const start = async (req: AppApplyRequest): Promise<{ applying: true; to: string; target: 'app' }> => {
    await ready
    // Журнал прошлой замены не разобран (восстановление не прошло) — поверх него не начинаем.
    if (existsSync(journalFile)) throw new AppUpdateError(`прошлое обновление окна не доведено (${journalFile}) — перезапусти демона (pult daemon stop): старт доведёт или откатит его; итог — в «Настройки» → «Обновления»`)
    const busy = o.packageBusy()
    if (busy) throw new AppUpdateError(busy)
    const pendingNow = readAppState(o.paths).pending
    if (pendingNow && !req.rollback) {
      throw new AppUpdateError(`новое окно ${pendingNow.to} ещё не запускалось: открой его (pult ui) или верни ${pendingNow.from} (pult update --app --rollback)`)
    }
    if (req.rollback) {
      const pd = readAppState(o.paths).pending
      if (!pd) throw new AppUpdateError('возвращать нечего: новое окно уже запускалось (или обновления не было)')
      if (stopped) throw new AppUpdateError('демон останавливается')
      const lock = takeLock()
      runJob({ to: pd.to, from: pd.from, step: 'rollback', since: new Date().toISOString(), done: Promise.resolve() }, lock, () => rollbackPending(pd))
      return { applying: true, to: pd.to, target: 'app' }
    }
    const loc0 = locateInstalledApp(tools.appDirs(), preferred())
    const no = unsupported(loc0)
    if (no) throw new AppUpdateError(no)
    const loc = loc0 as InstalledApp
    if (!loc.version || !loc.executable) throw new AppUpdateError(`Info.plist окна ${loc.app} не читается`)
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
    if (compareVersions(to, loc.version) <= 0) {
      throw new AppUpdateError(compareVersions(to, loc.version) < 0 ? `окно ${loc.version} новее канала (${to}) — ставить нечего` : `окно ${loc.version} — последнее`)
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
    const lock = takeLock()
    o.logger.info('обновление окна', { from: loc.version, to, app: loc.app })
    const version = loc.version
    const executable = loc.executable
    runJob({ to, from: loc.version, step: 'download', since: new Date().toISOString(), done: Promise.resolve() }, lock,
      () => work({ ...loc, version, executable }, to, asset))
    return { applying: true, to, target: 'app' }
  }

  return {
    status,
    ready,
    apply(req = {}) {
      if (job) return Promise.resolve({ applying: true, to: job.to, target: 'app' })
      if (preflight) return preflight
      preflight = start(req).finally(() => { preflight = null })
      return preflight
    },
    onShellReady(h) { for (const fn of [...readyWaiters]) fn(h) },
    onShellHello(h) { void firstRunHello(h).catch(() => { /* не важно */ }) },
    busy: () => job !== null || preflight !== null,
    idle: async () => { await ready; if (preflight) await preflight.catch(() => {}); if (job) await job.done },
    async stop() {
      stopped = true
      wakeStop()
      clearPendingTimers()
      stopFirstRunPoll()
      const j = job
      // Бандл уже меняется — дать довести (не дольше stopWaitMs); иначе — журнал и восстановление при старте.
      if (j && PAST_QUIT.has(j.step)) {
        o.logger.info('остановка ждёт обновление окна', { step: j.step, to: j.to })
        let t: NodeJS.Timeout | null = null
        await Promise.race([j.done, new Promise<void>((r) => { t = setTimeout(r, stopWait) })])
        if (t) clearTimeout(t)
      }
    },
  }
}

/** Значения hello оболочки: строки разумной длины, иначе null. */
export function shellHelloOf(raw: unknown): ShellHello {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const s = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
  const pid = o['pid']
  return { version: s(o['version'], 40), execPath: s(o['execPath'], 4096), pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null }
}

/** Для `pult update --check`: есть ли у окна обновление по манифесту (без сети — по уже прочитанному). */
export function windowLine(installed: string | null, latest: string | null, bad: boolean): string | null {
  if (installed === null || latest === null) return null
  if (compareVersions(latest, installed) <= 0) return `окно: ${installed} — последнее`
  if (bad) return `окно: ${installed} → в канале ${latest}, но оно уже не встало на этой машине — повторить: pult update --app --force`
  return `окно: ${installed} → доступно ${latest} — обновить: pult update --app (или «Настройки» → «Обновления»)`
}
