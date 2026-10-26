// Окно обновляется само (0.3.4): демон качает zip окна из подписанного манифеста, проверяет его, закрывает окно,
// меняет Pult.app, открывает новое и ждёт его hello; не поднялось — откат. Всё — на фальшивых бандлах во временных
// папках и на швах (распаковка, подпись, процессы, сигналы, open, lsregister, hello): настоящий Pult.app, ~/.pult
// и настоящий демон не трогаются никогда.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, renameSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { ClientError, shellAppInfo } from '../dist/cli/client.js'
import type { AppUpdateStatus, UpdateStatus } from '../dist/core/rpc.js'
import { acquireLock } from '../dist/core/lock.js'
import { readAppState } from '../dist/update/appState.js'
import {
  APP_BUNDLE_ID, AppUpdateError, checkTree, createAppUpdater, etimeSeconds, homeTag, machOArchs, manualSteps, scanZip, shellHelloOf,
} from '../dist/update/appUpdate.js'
import type { AppTools, AppUpdater, AppUpdaterOptions, ShellHello } from '../dist/update/appUpdate.js'
import { APP_UPDATE_MAC_ONLY, updateAppCli } from '../dist/update/appUpdateCli.js'
import type { HttpGet } from '../dist/update/fetch.js'
import { publicOf, signEnvelope } from '../dist/update/manifest.js'
import { plistString } from '../dist/update/plist.js'
import { CLI_ENTRY, rawConnect, startTestDaemon, tempHome, waitFor } from './helpers.js'
import type { TempHome } from './helpers.js'

const { privateKey } = generateKeyPairSync('ed25519')
const pub = publicOf(privateKey)
const KEYS = [{ id: pub.keyId, publicKey: pub.raw.toString('base64') }]
const URL_LATEST = 'https://example.invalid/latest.json'

// --- фальшивый бандл и zip ------------------------------------------------------------------------

const plist = (id: string, version: string, exe = 'Pult'): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${exe}</string>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLSchemes</key><array><string>pult</string></array></dict></array>
</dict>
</plist>
`

/** Заголовок Mach-O: тонкий arm64 (или x86_64) — для проверки архитектуры хватает 8 байт. */
function machO(arch: 'arm64' | 'x86_64' = 'arm64'): Buffer {
  const b = Buffer.alloc(64)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  return b
}

interface BundleOpts { id?: string; version: string; arch?: 'arm64' | 'x86_64'; extra?: (app: string) => void }

/** Pult.app в `dir`: Info.plist, исполняемый «Mach-O», фреймворк с относительной ссылкой Versions/Current. */
function makeBundle(dir: string, o: BundleOpts): string {
  const app = join(dir, 'Pult.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist(o.id ?? APP_BUNDLE_ID, o.version))
  writeFileSync(join(app, 'Contents', 'MacOS', 'Pult'), machO(o.arch), { mode: 0o755 })
  const fw = join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions')
  mkdirSync(join(fw, 'A'), { recursive: true })
  writeFileSync(join(fw, 'A', 'lib'), `lib ${o.version}`)
  symlinkSync('A', join(fw, 'Current'))
  o.extra?.(app)
  return app
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

interface ZEntry { name: string; data: Buffer; mode: number }

/** Zip без сжатия, с unix-режимами в внешних атрибутах — как у `ditto -c -k` по существу. */
function zipOf(entries: ZEntry[], opts: { hide?: number[]; dupFirst?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  let listed = 0
  for (const [i, e] of entries.entries()) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE((e.mode << 16) >>> 0, 38); ch.writeUInt32LE(off, 42)
    // `hide` — локальная запись есть, а в каталоге её нет; `dupFirst` — первая запись в каталоге дважды (наложение).
    if (!opts.hide?.includes(i)) { centrals.push(ch, name); listed++ }
    if (i === 0 && opts.dupFirst) { centrals.push(ch, name); listed++ }
    off += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(listed, 8); eocd.writeUInt16LE(listed, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** Записи zip из папки: имена от её родителя («Pult.app/…»), ссылки — как ссылки. */
function entriesOf(root: string): ZEntry[] {
  const base = dirname(root)
  const out: ZEntry[] = []
  const walk = (p: string): void => {
    const st = lstatSync(p)
    const name = relative(base, p)
    if (st.isSymbolicLink()) { out.push({ name, data: Buffer.from(readlinkSync(p)), mode: 0o120777 }); return }
    if (st.isDirectory()) {
      out.push({ name: `${name}/`, data: Buffer.alloc(0), mode: 0o040755 })
      for (const n of readdirSync(p).sort()) walk(join(p, n))
      return
    }
    out.push({ name, data: readFileSync(p), mode: 0o100000 | (st.mode & 0o777) })
  }
  walk(root)
  return out
}

/** Распаковка нашего zip (шов `unzip` вместо ditto): тот же разбор каталога, ссылки — symlink. */
async function testUnzip(zip: string, dest: string): Promise<void> {
  const b = readFileSync(zip)
  const e = b.length - 22
  const count = b.readUInt16LE(e + 10)
  let p = b.readUInt32LE(e + 16)
  for (let i = 0; i < count; i++) {
    const nlen = b.readUInt16LE(p + 28)
    const xlen = b.readUInt16LE(p + 30)
    const clen = b.readUInt16LE(p + 32)
    const mode = b.readUInt32LE(p + 38) >>> 16
    const off = b.readUInt32LE(p + 42)
    const size = b.readUInt32LE(p + 24)
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    const lnl = b.readUInt16LE(off + 26)
    const lxl = b.readUInt16LE(off + 28)
    const data = b.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size)
    const target = join(dest, name)
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue }
    mkdirSync(dirname(target), { recursive: true })
    if ((mode & 0o170000) === 0o120000) symlinkSync(data.toString('utf8'), target)
    else { writeFileSync(target, data); chmodSync(target, mode & 0o777) }
  }
}

// --- мир теста: поставленное окно, канал, процессы ---------------------------------------------------

interface Proc { exe: string; alive: boolean; startedAt: number; uid?: number }

interface World {
  home: TempHome
  root: string
  appsDir: string
  app: string
  procs: Map<number, Proc>
  signals: Array<[number, string]>
  opens: string[]
  lsreg: string[][]
  /** Окно выходит по SIGTERM. */
  quitOnTerm: boolean
  /** Новое окно после `open` здоровается с демоном. */
  helloOnOpen: boolean
  codesignFail: boolean
  codesignFailFor: (p: string) => boolean
  /** Подключённые окна (hello оболочек) — для отказа «закрой окно из …». */
  shells: ShellHello[]
  /** Сбой rename: вернуть ошибку для пары путей — или null (настоящий rename). */
  renameFail: (src: string, dst: string) => NodeJS.ErrnoException | null
  /** Готовность нового окна: через сколько мс после open и с каким pid (по умолчанию — новый процесс). */
  readyDelayMs: number
  procInfoDelayMs: number
  findPidsDelayMs: number
  /** Новый процесс после open: «возраст» (запущен раньше замены) и чужой uid — для строгой пробы. */
  newProcAgeMs: number
  newProcUid: number | null
  /** Подменить zip до публикации в канале. */
  zip: Buffer
  manifest: { version: string; sha256?: string; size?: number; noApp?: boolean }
  updater: AppUpdater | null
  tools(): Partial<AppTools>
  options(over?: Partial<AppUpdaterOptions>): AppUpdaterOptions
  remove(): void
}

let nextPid = 50_000

function world(o: { installed?: string; release?: BundleOpts; running?: boolean } = {}): World {
  const home = tempHome()
  const root = mkdtempSync(join(tmpdir(), 'pau-'))
  const appsDir = join(root, 'Applications')
  mkdirSync(appsDir)
  const app = makeBundle(appsDir, { version: o.installed ?? '0.1.15' })
  const relDir = join(root, 'release')
  mkdirSync(relDir)
  const relApp = makeBundle(relDir, o.release ?? { version: '0.1.16' })
  const w: World = {
    home, root, appsDir, app,
    procs: new Map(),
    signals: [],
    opens: [],
    lsreg: [],
    quitOnTerm: true,
    helloOnOpen: true,
    codesignFail: false,
    codesignFailFor: () => false,
    shells: [],
    renameFail: () => null,
    readyDelayMs: 20,
    procInfoDelayMs: 0,
    findPidsDelayMs: 0,
    newProcAgeMs: 0,
    newProcUid: null,
    zip: zipOf(entriesOf(relApp)),
    manifest: { version: (o.release ?? { version: '0.1.16' }).version },
    updater: null,
    tools() {
      const http: HttpGet = async (url) => {
        let body: Buffer | null = null
        if (url === URL_LATEST) {
          const zipUrl = `https://example.invalid/Pult-${w.manifest.version}-arm64.zip`
          const m = {
            schema: 1, version: '0.3.9', released: '2026-10-22T10:00:00.000Z',
            notes: 'https://github.com/pawellazarew/pult/releases/tag/v0.3.9',
            package: { url: 'https://example.invalid/pult-0.3.9.tgz', sha256: 'c'.repeat(64), size: 10 },
            app: {
              version: w.manifest.version, minVersion: '0.1.13',
              ...(w.manifest.noApp ? {} : { 'darwin-arm64': { url: zipUrl, sha256: w.manifest.sha256 ?? createHash('sha256').update(w.zip).digest('hex'), size: w.manifest.size ?? w.zip.length } }),
            },
          }
          body = Buffer.from(signEnvelope(Buffer.from(JSON.stringify(m)), privateKey))
        } else if (url.endsWith('-arm64.zip')) body = w.zip
        if (!body) return { status: 404, header: () => null, body: null }
        const b = body
        return { status: 200, header: () => null, body: (async function* () { yield b })() }
      }
      return {
        platform: 'darwin',
        arch: 'arm64',
        appDirs: () => [appsDir],
        http,
        unzip: testUnzip,
        copyTree: async (s, d) => { cpSync(s, d, { recursive: true, verbatimSymlinks: true }) },
        codesignVerify: async (p) => { if (w.codesignFail || w.codesignFailFor(p)) throw new Error('codesign: code object is not signed at all') },
        findPids: async (exe) => (w.findPidsDelayMs ? await new Promise((r) => setTimeout(r, w.findPidsDelayMs)) : null, [...w.procs]).filter(([, p]) => p.alive && p.exe === exe && (p.uid ?? process.getuid?.()) === process.getuid?.()).map(([pid]) => pid),
        procInfo: async (pid) => {
          if (w.procInfoDelayMs) await new Promise((r) => setTimeout(r, w.procInfoDelayMs))
          const p = w.procs.get(pid)
          return p ? { uid: p.uid ?? (process.getuid?.() ?? -1), exe: p.exe, startedAt: p.startedAt } : null
        },
        rename: (src, dst) => {
          const e = w.renameFail(src, dst)
          if (e) throw e
          renameSync(src, dst)
        },
        signal: (pid, sig) => {
          w.signals.push([pid, sig])
          const p = w.procs.get(pid)
          if (!p) return
          if (sig === 'SIGKILL' || (sig === 'SIGTERM' && w.quitOnTerm)) p.alive = false
        },
        alive: (pid) => w.procs.get(pid)?.alive === true,
        open: async (a) => {
          w.opens.push(a)
          const pid = nextPid++
          const exe = join(a, 'Contents', 'MacOS', 'Pult')
          w.procs.set(pid, { exe, alive: true, startedAt: Date.now() - w.newProcAgeMs, ...(w.newProcUid !== null ? { uid: w.newProcUid } : {}) })
          const version = plistString(readFileSync(join(a, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString')
          if (w.helloOnOpen) setTimeout(() => w.updater?.onShellReady({ version, execPath: exe, pid }), w.readyDelayMs)
        },
        lsregister: async (args) => { w.lsreg.push(args) },
      }
    },
    options(over = {}) {
      return {
        paths: home.paths,
        config: { ...home.config, updates: { check: false, url: URL_LATEST } },
        logger: home.logger,
        env: {},
        keys: KEYS,
        tools: w.tools(),
        latestApp: () => w.manifest.version,
        packageBusy: () => null,
        shells: () => w.shells,
        quitWaitMs: 300,
        helloWaitMs: 400,
        killWaitMs: 200,
        pollMs: 10,
        recoverWaitMs: 300,
        firstRunWaitMs: 300,
        firstRunPollMs: 50,
        ...over,
      }
    },
    remove() {
      try { chmodSync(appsDir, 0o755) } catch { /* уже */ }
      rmSync(root, { recursive: true, force: true })
      home.remove()
    },
  }
  if (o.running !== false) w.procs.set(nextPid++, { exe: join(app, 'Contents', 'MacOS', 'Pult'), alive: true, startedAt: Date.now() - 3_600_000 })
  return w
}

function updaterOf(w: World, over: Partial<AppUpdaterOptions> = {}): AppUpdater {
  const u = createAppUpdater(w.options(over))
  w.updater = u
  return u
}

const versionAt = (app: string): string | null => {
  try { return plistString(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString') } catch { return null }
}

/** Окно на месте и ничего не тронуто: версия прежняя, previous нет, open не звался, сигналов не было. */
function untouched(w: World, from = '0.1.15'): void {
  assert.equal(versionAt(w.app), from, 'поставленное окно должно остаться прежним')
  assert.deepEqual(w.opens, [], 'open не должен зваться')
  const apps = existsSync(w.home.paths.apps) ? readdirSync(w.home.paths.apps) : []
  assert.deepEqual(apps.filter((n) => n.startsWith('previous-') || n.startsWith('staging-')), [], `в apps/ лишнее: ${apps.join(', ')}`)
  assert.deepEqual(existsSync(w.home.paths.downloads) ? readdirSync(w.home.paths.downloads) : [], [], 'zip должен быть убран')
  assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'], 'рядом с окном ничего лишнего (.Pult.app.incoming/old)')
  assert.equal(existsSync(join(w.home.paths.apps, 'swap.json')), false, 'журнал замены убран')
}

async function runFailed(w: World, re: RegExp): Promise<void> {
  const u = updaterOf(w)
  const r = await u.apply()
  assert.equal(r.to, w.manifest.version)
  await u.idle()
  const last = readAppState(w.home.paths).last
  assert.equal(last?.result, 'failed', JSON.stringify(last))
  assert.match(last?.message ?? '', re)
  assert.equal(u.status().applying, null)
}

// --- тесты ----------------------------------------------------------------------------------------

describe('обновление окна: чистые проверки', () => {
  it('Mach-O: тонкий arm64, «толстый» x86_64+arm64, не Mach-O', () => {
    assert.deepEqual(machOArchs(machO('arm64')), ['arm64'])
    assert.deepEqual(machOArchs(machO('x86_64')), ['x86_64'])
    const fat = Buffer.alloc(64)
    fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4); fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28)
    assert.deepEqual(machOArchs(fat), ['x86_64', 'arm64'])
    assert.equal(machOArchs(Buffer.from('#!/bin/sh\necho hi\n')), null)
  })

  it('каталог zip: годный проходит; вне Pult.app, «..», абсолютный путь, запись внутри ссылки, setuid — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-z-'))
    try {
      const file = join(dir, 'a.zip')
      const ok = makeBundle(join(dir, 'ok'), { version: '0.1.16' })
      writeFileSync(file, zipOf(entriesOf(ok)))
      assert.ok(scanZip(file).entries > 5)
      const f = (name: string, mode = 0o100644): ZEntry => ({ name, data: Buffer.from('x'), mode })
      const cases: Array<[ZEntry[], RegExp]> = [
        [[f('Pult.app/a'), f('evil.sh')], /вне Pult\.app/],
        [[f('Pult.app/../evil')], /недопустимый путь/],
        [[f('/etc/evil')], /недопустимое имя/],
        [[{ name: 'Pult.app/link', data: Buffer.from('/tmp'), mode: 0o120777 }, f('Pult.app/link/evil')], /внутри символической ссылки/],
        [[f('Pult.app/suid', 0o104755)], /setuid/],
        [[f('Pult.app/fifo', 0o010644)], /не файл/],
      ]
      for (const [entries, re] of cases) {
        writeFileSync(file, zipOf(entries))
        assert.throws(() => scanZip(file), re)
      }
      writeFileSync(file, Buffer.from('not a zip at all, definitely not, no end record here'))
      assert.throws(() => scanZip(file), /не zip/)
      writeFileSync(file, zipOf([f('Pult.app/a'), f('Pult.app/b'), f('Pult.app/c')]))
      assert.throws(() => scanZip(file, { maxEntries: 2 }), /потолка/)
      assert.throws(() => scanZip(file, { maxUnpacked: 2 }), /потолка/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('дерево бандла: ссылка наружу или абсолютная — отказ; внутренняя — можно', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-t-'))
    try {
      const app = makeBundle(dir, { version: '0.1.16' })
      assert.ok(checkTree(app) > 3)
      symlinkSync('../../..', join(app, 'Contents', 'up'))
      assert.throws(() => checkTree(app), /выходит из бандла/)
      rmSync(join(app, 'Contents', 'up'))
      symlinkSync('/etc', join(app, 'Contents', 'abs'))
      assert.throws(() => checkTree(app), /абсолютный путь/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hello оболочки: версия Pult.app из Info.plist рядом с execPath; не Electron — ничего', () => {
    const plistText = plist(APP_BUNDLE_ID, '0.1.16')
    assert.deepEqual(shellAppInfo('/Applications/Pult.app/Contents/MacOS/Pult', { electron: '44.4.5' }, () => plistText),
      { execPath: '/Applications/Pult.app/Contents/MacOS/Pult', version: '0.1.16' })
    assert.deepEqual(shellAppInfo('/w/node_modules/electron/dist/electron', { electron: '44.4.5' }, () => plistText), { execPath: '/w/node_modules/electron/dist/electron' })
    assert.equal(shellAppInfo('/usr/bin/node', {}, () => plistText), null)
    assert.deepEqual(shellHelloOf({ version: '0.1.16', execPath: '/x', pid: 42 }), { version: '0.1.16', execPath: '/x', pid: 42 })
    assert.deepEqual(shellHelloOf({ version: 'x'.repeat(41), execPath: 5, pid: -1 }), { version: null, execPath: null, pid: null })
    // Ключ дважды (вложенный словарь) — «не знаю», а не первое значение.
    assert.equal(plistString(`${plistText}<key>CFBundleIdentifier</key><string>evil</string>`, 'CFBundleIdentifier'), null)
  })
})

describe('обновление окна: демон-обновлятель на швах', () => {
  it('удачный путь: zip → проверки → окно закрыто SIGTERM → замена → lsregister → open → hello новой версии', async () => {
    const w = world()
    mkdirSync(join(w.home.paths.apps, 'previous-0.1.14'), { recursive: true })
    try {
      const u = updaterOf(w)
      const before = u.status()
      assert.equal(before.installed, '0.1.15')
      assert.equal(before.latest, '0.1.16')
      assert.equal(before.available, true)
      assert.equal(before.unsupported, null)
      const r = await u.apply()
      assert.deepEqual(r, { applying: true, to: '0.1.16', target: 'app' })
      assert.ok(u.status().applying, 'идёт — видно в статусе')
      await u.idle()
      const st = u.status()
      assert.equal(st.applying, null)
      assert.equal(st.last?.result, 'done', st.last?.message)
      assert.equal(st.installed, '0.1.16')
      assert.equal(st.available, false)
      assert.equal(versionAt(w.app), '0.1.16')
      // Прежнее окно — один цикл; более старые убраны; staging и zip — нет.
      assert.equal(versionAt(join(w.home.paths.apps, 'previous-0.1.15', 'Pult.app')), '0.1.15')
      assert.deepEqual(readdirSync(w.home.paths.apps).sort(), ['previous-0.1.15'])
      assert.deepEqual(readdirSync(w.home.paths.downloads), [])
      // Ссылка внутри бандла пережила распаковку и переезд.
      assert.equal(readlinkSync(join(w.app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current')), 'A')
      assert.deepEqual(w.signals.map(([, s]) => s), ['SIGTERM'], 'окну — только SIGTERM')
      assert.deepEqual(w.opens, [w.app])
      assert.ok(w.lsreg.some((a) => a[0] === '-f' && a[1] === w.app), JSON.stringify(w.lsreg))
      assert.ok(w.lsreg.some((a) => a[0] === '-u' && a[1]?.endsWith(join('previous-0.1.15', 'Pult.app'))), JSON.stringify(w.lsreg))
      assert.deepEqual(readAppState(w.home.paths).bad, [])
    } finally { w.remove() }
  })

  it('sha256 не сходится с подписанным манифестом — ничего не тронуто', async () => {
    const w = world()
    w.manifest.sha256 = 'e'.repeat(64)
    try { await runFailed(w, /sha256/); untouched(w) } finally { w.remove() }
  })

  it('размер не сходится — ничего не тронуто', async () => {
    const w = world()
    w.manifest.size = w.zip.length + 1
    try { await runFailed(w, /байт/); untouched(w) } finally { w.remove() }
  })

  it('в архиве чужой bundle id — отказ, окно не тронуто', async () => {
    const w = world({ release: { version: '0.1.16', id: 'com.example.evil' } })
    try { await runFailed(w, /чужое приложение.*com\.example\.evil/); untouched(w); assert.equal(w.signals.length, 0) } finally { w.remove() }
  })

  it('версия в архиве не та, что в манифесте — отказ', async () => {
    const w = world({ release: { version: '0.1.17' } })
    w.manifest.version = '0.1.16'
    try { await runFailed(w, /версия в архиве 0\.1\.17.*0\.1\.16/); untouched(w) } finally { w.remove() }
  })

  it('не arm64 — отказ', async () => {
    const w = world({ release: { version: '0.1.16', arch: 'x86_64' } })
    try { await runFailed(w, /без arm64/); untouched(w) } finally { w.remove() }
  })

  it('ссылка в бандле наружу — отказ', async () => {
    const w = world({ release: { version: '0.1.16', extra: (a) => symlinkSync('../../../..', join(a, 'Contents', 'Resources')) } })
    try { await runFailed(w, /выходит из бандла/); untouched(w) } finally { w.remove() }
  })

  it('codesign --verify не прошёл — отказ', async () => {
    const w = world()
    w.codesignFail = true
    try { await runFailed(w, /подпись бандла не сходится.*not signed/); untouched(w) } finally { w.remove() }
  })

  it('окно не закрылось по SIGTERM за срок — отказ, SIGKILL окну человека не шлётся, ничего не тронуто', async () => {
    const w = world()
    w.quitOnTerm = false
    try {
      await runFailed(w, /окно не закрылось.*закрой его сам/)
      untouched(w)
      assert.deepEqual(w.signals.map(([, s]) => s), ['SIGTERM'])
    } finally { w.remove() }
  })

  it('папка окна без права записи — отказ ДО загрузки с инструкцией', { skip: process.getuid?.() === 0 ? 'root пишет всюду' : false }, async () => {
    const w = world()
    chmodSync(w.appsDir, 0o555)
    try {
      const u = updaterOf(w)
      await assert.rejects(u.apply(), (e: Error) => e instanceof AppUpdateError && /нет прав на запись/.test(e.message) && /вручную.*Pult-0\.1\.16-arm64\.zip/.test(e.message))
      assert.equal(u.busy(), false)
      chmodSync(w.appsDir, 0o755)
      untouched(w)
      assert.equal(w.signals.length, 0)
    } finally { w.remove() }
  })

  it('новое окно не подключилось — откат: новое погашено, прежнее на месте и запущено, версия bad', async () => {
    const w = world()
    w.helloOnOpen = false
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      const st = u.status()
      assert.equal(st.last?.result, 'rolled_back', st.last?.message)
      assert.match(st.last?.message ?? '', /не подключилось.*вернул 0\.1\.15/)
      assert.equal(versionAt(w.app), '0.1.15')
      assert.equal(st.bad, true)
      assert.equal(st.available, false)
      assert.deepEqual(readAppState(w.home.paths).bad, ['0.1.16'])
      // open: новое, затем прежнее; новое — SIGTERM, а потом SIGKILL (оно наше), если не вышло.
      assert.deepEqual(w.opens, [w.app, w.app])
      const newPid = [...w.procs.keys()][1] as number
      assert.ok(w.signals.some(([p, s]) => p === newPid && s === 'SIGTERM'))
      assert.deepEqual(readdirSync(w.home.paths.apps), [], 'previous возвращён, failed убран')
      // Сама не предлагается; `allowBad` (pult update --app --force) — можно.
      await assert.rejects(u.apply(), /уже не встало.*--force/)
      w.helloOnOpen = true
      const r = await u.apply({ allowBad: true })
      assert.equal(r.to, '0.1.16')
      await u.idle()
      assert.equal(u.status().last?.result, 'done')
    } finally { w.remove() }
  })

  it('пакет обновляется — отказ; один запуск за раз; не вместе с чужим update.lock', async () => {
    const w = world()
    try {
      const busy = updaterOf(w, { packageBusy: () => 'идёт обновление пакета до 0.3.9' })
      await assert.rejects(busy.apply(), /идёт обновление пакета/)
      untouched(w)
      const u = updaterOf(w)
      const [a, b] = await Promise.all([u.apply(), u.apply()])
      assert.equal(a.to, b.to)
      assert.equal(u.busy(), true)
      await u.idle()
      assert.equal(w.opens.length, 1, 'второй вызов не запустил вторую замену')
      // run/update.lock держит другой процесс (`pult update` в терминале) — отказ.
      const w2 = world()
      try {
        const held = acquireLock(w2.home.paths.updateLock, { pid: process.ppid })
        assert.ok(held.ok)
        const u2 = updaterOf(w2)
        await assert.rejects(u2.apply(), /идёт обновление пакета \(pid/)
      } finally { w2.remove() }
    } finally { w.remove() }
  })

  it('без понижения: та же или старше версия в канале — отказ; expect не совпал — отказ', async () => {
    for (const [ver, re] of [['0.1.15', /последнее/], ['0.1.14', /новее канала/]] as const) {
      const w = world({ release: { version: ver } })
      try {
        const u = updaterOf(w)
        assert.equal(u.status().available, false)
        await assert.rejects(u.apply(), re)
        untouched(w)
      } finally { w.remove() }
    }
    const w = world()
    try { await assert.rejects(updaterOf(w).apply({ expect: '0.1.20' }), /просили 0\.1\.20/) } finally { w.remove() }
  })

  it('в релизе нет окна для macOS — отказ', async () => {
    const w = world()
    w.manifest.noApp = true
    try { await assert.rejects(updaterOf(w).apply(), /нет окна для macOS arm64/) } finally { w.remove() }
  })

  it('Linux: не поддерживается, статус говорит почему; CLI --app — ничего не делает и говорит это', async () => {
    const w = world()
    try {
      const u = updaterOf(w, { tools: { ...w.tools(), platform: 'linux' } })
      const st: AppUpdateStatus = u.status()
      assert.match(st.unsupported ?? '', /только на macOS/)
      assert.equal(st.available, false)
      await assert.rejects(u.apply(), /только на macOS/)
      untouched(w)
      const out: string[] = []
      let connected = false
      const code = await updateAppCli({ out: (s) => out.push(s), err: (s) => out.push(s) }, { platform: 'linux', connect: async () => { connected = true; throw new Error('не должен') } })
      assert.equal(code, 0)
      assert.equal(connected, false)
      assert.ok(out.join('\n').includes(APP_UPDATE_MAC_ONLY))
    } finally { w.remove() }
  })

  it('окно не найдено или чужое — не поддерживается', () => {
    const w = world()
    try {
      rmSync(w.app, { recursive: true })
      assert.match(updaterOf(w).status().unsupported ?? '', /не найден/)
      makeBundle(w.appsDir, { version: '0.1.15', id: 'com.example.other' })
      assert.match(updaterOf(w).status().unsupported ?? '', /не окно Пульта/)
    } finally { w.remove() }
  })
})

describe('обновление окна: демон целиком (сокет, hello оболочки, CLI --app)', () => {
  /** Демон с канал-швом и швами окна; `open` поднимает «оболочку», которая здоровается по сокету с app.version. */
  /** Сырое соединение оболочки с hello `app`. */
  async function shellConn(w: World, app: { version: string | null; execPath: string; pid: number }) {
    const c = await rawConnect(w.home.paths)
    c.send({ type: 'hello', token: readFileSync(w.home.paths.token, 'utf8').trim(), client: 'shell', protocol: 1, app })
    await c.next()
    return c
  }

  async function daemonWorld(w: World, opts: { hello?: boolean; helloWaitMs?: number } = {}) {
    const tools = w.tools()
    const d = await startTestDaemon(w.home, {
      updates: { http: tools.http as HttpGet, keys: KEYS, schedule: false },
      appUpdate: {
        tools: {
          ...tools,
          open: async (a) => {
            w.opens.push(a)
            if (opts.hello === false) return
            const pid = nextPid++
            const exe = join(a, 'Contents', 'MacOS', 'Pult')
            w.procs.set(pid, { exe, alive: true, startedAt: Date.now() })
            // Настоящее рукопожатие оболочки (client 'shell', app {version, execPath, pid}) и первый вызов интерфейса.
            const c = await shellConn(w, { version: versionAt(a), execPath: exe, pid })
            c.send({ id: 1, method: 'settings.get' })
            await c.next()
            setTimeout(() => c.end(), 50)
          },
        },
        quitWaitMs: 300, helloWaitMs: opts.helloWaitMs ?? 2000, killWaitMs: 200, pollMs: 10,
      },
    })
    return d
  }

  it('update.apply {target: app} по сокету; hello оболочки новой версии и первый вызов интерфейса — готово; статус в daemon.status', async () => {
    const w = world()
    w.home.config.updates = { check: false, url: URL_LATEST }
    const d = await daemonWorld(w)
    const c = await connectClient(w.home.paths)
    try {
      const checked = (await c.request('update.check')) as UpdateStatus
      assert.equal(checked.app?.latest, '0.1.16')
      assert.equal(checked.app?.available, true)
      await assert.rejects(c.request('update.apply', { target: 'window' }), /target/)
      const r = await c.request('update.apply', { target: 'app', expect: '0.1.16' }) as { to: string }
      assert.equal(r.to, '0.1.16')
      assert.ok(await waitFor(async () => ((await c.request('update.status')) as UpdateStatus).app?.applying === null, 10_000))
      const st = (await c.request('daemon.status')) as { update?: UpdateStatus }
      assert.equal(st.update?.app?.last?.result, 'done', st.update?.app?.last?.message)
      assert.equal(st.update?.app?.installed, '0.1.16')
      assert.equal(versionAt(w.app), '0.1.16')
    } finally {
      c.close()
      await d.stop('тест')
      w.remove()
    }
  })

  it('остановка демона посреди пробы: отказы ожидающим разрешениям и адаптеры — сразу, всё — быстрее 5 с; старт доводит по журналу', async () => {
    const w = world()
    w.home.config.updates = { check: false, url: URL_LATEST }
    const d = await daemonWorld(w, { hello: false, helloWaitMs: 30_000 })
    const c = await connectClient(w.home.paths)
    try {
      await c.request('update.check')
      await c.request('update.apply', { target: 'app' })
      assert.ok(await waitFor(async () => ((await c.request('update.status')) as UpdateStatus).app?.applying?.step === 'health', 10_000))
      const perm = d.broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'ls' } })
      const t0 = Date.now()
      c.close()
      await d.stop('тест')
      const took = Date.now() - t0
      const decision = await perm
      assert.equal(decision.behavior, 'deny', 'ожидающий запрос получил отказ')
      assert.ok(took < 5000, `остановка шла ${took} мс`)
      assert.ok(existsSync(join(w.home.paths.apps, 'swap.json')), 'оборванная проба — журнал на месте')
    } finally {
      w.remove()
    }
  })

  it('пока окно обновляется, «Обновить» пакета отказывает', async () => {
    const w = world()
    w.quitOnTerm = false
    w.home.config.updates = { check: false, url: URL_LATEST }
    const d = await daemonWorld(w)
    const c = await connectClient(w.home.paths)
    try {
      await c.request('update.check')
      await c.request('update.apply', { target: 'app' })
      await assert.rejects(c.request('update.apply', {}), (e: Error) => e instanceof ClientError && /идёт обновление окна/.test(e.message))
      assert.ok(await waitFor(async () => ((await c.request('update.status')) as UpdateStatus).app?.applying === null, 10_000))
    } finally {
      c.close()
      await d.stop('тест')
      w.remove()
    }
  })

  it('CLI: pult update --app ведёт демона до конца и печатает итог', { skip: process.platform !== 'darwin' ? 'CLI --app на Linux — no-op (тест выше)' : false }, async () => {
    const w = world({ running: false })
    w.home.config.updates = { check: false, url: URL_LATEST }
    const d = await daemonWorld(w)
    try {
      const c = await connectClient(w.home.paths)
      await c.request('update.check')
      c.close()
      const env: NodeJS.ProcessEnv = { ...process.env, PULT_HOME: w.home.paths.home, PULT_TEST: '1' }
      delete env['PULT_UPDATE_URL']
      const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI_ENTRY, 'update', '--app'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', (b: Buffer) => { out += b.toString() })
        child.stderr.on('data', (b: Buffer) => { out += b.toString() })
        child.on('exit', (code) => resolve({ code, out }))
      })
      assert.equal(res.code, 0, res.out)
      assert.match(res.out, /обновляю окно до 0\.1\.16/)
      assert.match(res.out, /окно обновлено: 0\.1\.15 → 0\.1\.16/)
      assert.equal(versionAt(w.app), '0.1.16')
    } finally {
      await d.stop('тест')
      w.remove()
    }
  })

  it('CLI: --force с --list и --app вместе с --check — отказ', async () => {
    const run = (args: string[]): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
      const home = mkdtempSync(join(tmpdir(), 'pau-c-'))
      const child = spawn(process.execPath, [CLI_ENTRY, 'update', ...args], { env: { ...process.env, PULT_HOME: home, PULT_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stderr.on('data', (b: Buffer) => { out += b.toString() })
      child.on('exit', (code) => { rmSync(home, { recursive: true, force: true }); resolve({ code, out }) })
    })
    // `--force` без `--app` теперь значит «не ждать идущих ходов» (канал, --from, --to); с --list и --check его нет.
    const a = await run(['--force', '--list'])
    assert.notEqual(a.code, 0)
    assert.match(a.out, /--force — не с --list и --check/)
    const b = await run(['--app', '--check'])
    assert.notEqual(b.code, 0)
    assert.match(b.out, /pult update --check/)
  })
})

// --- ревью безопасности: обрывы, замена на одном томе, другие окна, строгая проба ----------------------------

const NEW = '0.1.16'
const OLD = '0.1.15'
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: тест`), { code })

describe('обновление окна: ошибки не роняют демона', () => {
  it('сбой подготовки (downloads — файл) и уборки — итог failed, ни одного необработанного отказа', async () => {
    const w = world()
    const unhandled: unknown[] = []
    const on = (e: unknown): void => { unhandled.push(e) }
    process.on('unhandledRejection', on)
    try {
      rmSync(w.home.paths.downloads, { recursive: true, force: true })
      writeFileSync(w.home.paths.downloads, 'не папка')
      await runFailed(w, /EEXIST|ENOTDIR|not a directory|file already exists/i)
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(unhandled, [])
      assert.equal(versionAt(w.app), OLD)
    } finally { process.off('unhandledRejection', on); w.remove() }
  })
})

describe('обновление окна: замена двумя rename на одном томе (сбои каждого шага)', () => {
  it('новое окно на другом томе — проверенная копия рядом со старым до закрытия окна; дальше rename', async () => {
    const w = world()
    let copies = 0
    w.renameFail = (src, dst) => (src.includes('staging-') && dst.includes(`.Pult.app.incoming-${NEW}-`) ? errno('EXDEV') : null)
    try {
      const u = updaterOf(w, { tools: { ...w.tools(), copyTree: async (a, b) => { copies++; cpSync(a, b, { recursive: true, verbatimSymlinks: true }) } } })
      await u.apply()
      await u.idle()
      assert.equal(u.status().last?.result, 'done', u.status().last?.message)
      assert.equal(copies, 1)
      assert.equal(versionAt(w.app), NEW)
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
    } finally { w.remove() }
  })

  it('копия на другой том не совпала с исходной — отказ до закрытия окна, ничего не тронуто', async () => {
    const w = world()
    w.renameFail = (src, dst) => (src.includes('staging-') && dst.includes('.Pult.app.incoming-') ? errno('EXDEV') : null)
    try {
      const u = updaterOf(w, { tools: { ...w.tools(), copyTree: async (a, b) => { cpSync(a, b, { recursive: true, verbatimSymlinks: true }); rmSync(join(b, 'Contents', 'MacOS', 'Pult')) } } })
      await u.apply()
      await u.idle()
      assert.match(u.status().last?.message ?? '', /не совпала/)
      untouched(w)
      assert.equal(w.signals.length, 0, 'окно не закрывали')
    } finally { w.remove() }
  })

  it('копия на другой том с неверной подписью — отказ до закрытия окна', async () => {
    const w = world()
    w.renameFail = (src, dst) => (src.includes('staging-') && dst.includes('.Pult.app.incoming-') ? errno('EXDEV') : null)
    w.codesignFailFor = (p) => p.includes('.Pult.app.incoming-')
    try {
      await runFailed(w, /подпись копии .*не сходится/)
      untouched(w)
      assert.equal(w.signals.length, 0)
    } finally { w.remove() }
  })

  it('первый rename (окно → .old) не прошёл — «ничего не тронуто», прежнее окно открыто снова', async () => {
    const w = world()
    w.renameFail = (src) => (src === w.app ? errno('EACCES') : null)
    try {
      await runFailed(w, /прежнее окно не сдвинуть.*ничего не тронуто/)
      assert.equal(versionAt(w.app), OLD)
      assert.deepEqual(w.opens, [w.app])
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
      assert.equal(existsSync(join(w.home.paths.apps, 'swap.json')), false)
    } finally { w.remove() }
  })

  it('второй rename (.incoming → место) не прошёл — прежнее вернул и открыл', async () => {
    const w = world()
    w.renameFail = (src, dst) => (src.includes(`.Pult.app.incoming-${NEW}-`) && dst === w.app ? errno('EIO') : null)
    try {
      await runFailed(w, /новое окно не встало на место.*прежнее вернул/)
      assert.equal(versionAt(w.app), OLD)
      assert.deepEqual(w.opens, [w.app])
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
    } finally { w.remove() }
  })

  it('второй rename и возврат не прошли — итог с путём к прежнему, журнал остаётся; следующий старт возвращает окно', async () => {
    const w = world()
    let restoreFails = true
    w.renameFail = (src, dst) => {
      if (src.includes(`.Pult.app.incoming-${NEW}-`) && dst === w.app) return errno('EIO')
      if (src.includes(`.Pult.app.old-${OLD}-`) && dst === w.app && restoreFails) return errno('EIO')
      return null
    }
    try {
      await runFailed(w, /прежнее не вернулось.*\.Pult\.app\.old-0\.1\.15-/)
      assert.equal(existsSync(w.app), false)
      assert.ok(existsSync(join(w.home.paths.apps, 'swap.json')), 'журнал оставлен для восстановления')
      restoreFails = false
      const u2 = updaterOf(w)
      await u2.ready
      assert.equal(versionAt(w.app), OLD)
      assert.equal(existsSync(join(w.home.paths.apps, 'swap.json')), false)
      assert.match(u2.status().last?.message ?? '', /посреди замены.*вернул на место/)
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
    } finally { w.remove() }
  })

  it('прежнее окно → PULT_HOME через другой том: копия (живое окно уже на месте); не вышло — только предупреждение', async () => {
    for (const code of ['EXDEV', 'EACCES']) {
      const w = world()
      w.renameFail = (src, dst) => (src.includes(`.Pult.app.old-${OLD}-`) && dst.includes('previous-') ? errno(code) : null)
      try {
        const u = updaterOf(w)
        await u.apply()
        await u.idle()
        assert.equal(u.status().last?.result, 'done', `${code}: ${u.status().last?.message}`)
        assert.equal(versionAt(w.app), NEW)
        assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'], `${code}: .old рядом с окном убран`)
        if (code === 'EXDEV') assert.equal(versionAt(join(w.home.paths.apps, `previous-${OLD}`, 'Pult.app')), OLD)
      } finally { w.remove() }
    }
  })
})

describe('обновление окна: обрыв на каждом шаге и восстановление при старте', () => {
  const journal = (w: World, phase: string, over: Record<string, unknown> = {}): void => {
    mkdirSync(w.home.paths.apps, { recursive: true })
    const old = join(w.appsDir, `.Pult.app.old-${OLD}-${homeTag(w.home.paths.home)}`)
    writeFileSync(join(w.home.paths.apps, 'swap.json'), JSON.stringify({
      schema: 1, app: w.app, dir: w.appsDir, old, incoming: join(w.appsDir, `.Pult.app.incoming-${NEW}-${homeTag(w.home.paths.home)}`), prev: old,
      from: OLD, to: NEW, phase, wasRunning: true, at: new Date().toISOString(), ...over,
    }))
  }
  /** Поставить новое окно на место, прежнее — в `prevAt`. */
  const swapTo = (w: World, prevAt: string): void => {
    mkdirSync(dirname(prevAt), { recursive: true })
    renameSync(w.app, prevAt)
    const tmp = mkdtempSync(join(w.root, 'n-'))
    renameSync(makeBundle(tmp, { version: NEW }), w.app)
  }
  const recovered = async (w: World): Promise<AppUpdater> => {
    const u = updaterOf(w)
    await u.ready
    assert.equal(existsSync(join(w.home.paths.apps, 'swap.json')), false, 'журнал убран')
    assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'], 'рядом с окном чисто')
    return u
  }

  it('между двумя rename (места пусто) — прежнее на место, не bad', async () => {
    const w = world({ running: false })
    try {
      journal(w, 'swap')
      renameSync(w.app, join(w.appsDir, `.Pult.app.old-${OLD}-${homeTag(w.home.paths.home)}`))
      mkdirSync(join(w.appsDir, `.Pult.app.incoming-${NEW}-${homeTag(w.home.paths.home)}`))
      const u = await recovered(w)
      assert.equal(versionAt(w.app), OLD)
      assert.equal(u.status().last?.result, 'failed')
      assert.deepEqual(readAppState(w.home.paths).bad, [])
      assert.deepEqual(w.opens, [w.app], 'окно было открыто до замены — открыто снова')
    } finally { w.remove() }
  })

  for (const [phase, where, bad] of [['swap', 'old', false], ['swapped', 'old', false], ['swapped', 'previous', false], ['health', 'previous', true]] as const) {
    it(`фаза ${phase}, прежнее в ${where}: новое стоит без «готово» — откат${bad ? ', bad (проба не прошла и после перезапуска)' : ' без bad (обрыв наш)'}, новое окно погашено`, async () => {
      const w = world({ running: false })
      try {
        const prevAt = where === 'old' ? join(w.appsDir, `.Pult.app.old-${OLD}-${homeTag(w.home.paths.home)}`) : join(w.home.paths.apps, `previous-${OLD}`, 'Pult.app')
        journal(w, phase, { prev: prevAt, swapAt: Date.now() })
        swapTo(w, prevAt)
        const pid = nextPid++
        w.procs.set(pid, { exe: join(w.app, 'Contents', 'MacOS', 'Pult'), alive: true, startedAt: Date.now() })
        const u = await recovered(w)
        assert.equal(versionAt(w.app), OLD)
        assert.equal(u.status().last?.result, 'rolled_back', u.status().last?.message)
        assert.deepEqual(readAppState(w.home.paths).bad, bad ? [NEW] : [])
        assert.ok(w.signals.some(([p, sig]) => p === pid && sig === 'SIGTERM'), 'новое окно погашено')
        assert.deepEqual(w.opens, [w.app])
      } finally { w.remove() }
    })
  }

  it('фаза health, демон перезапущен посреди пробы: новое окно переподключилось и готово — оставить, не bad', async () => {
    const w = world({ running: false })
    try {
      const prevAt = join(w.home.paths.apps, `previous-${OLD}`, 'Pult.app')
      const swapAt = Date.now() - 5000
      journal(w, 'health', { prev: prevAt, swapAt })
      swapTo(w, prevAt)
      const pid = nextPid++
      const exe = join(w.app, 'Contents', 'MacOS', 'Pult')
      w.procs.set(pid, { exe, alive: true, startedAt: Date.now() - 4000 })
      const u = updaterOf(w, { recoverWaitMs: 3000 })
      setTimeout(() => u.onShellReady({ version: NEW, execPath: exe, pid }), 50)
      await u.ready
      assert.equal(versionAt(w.app), NEW)
      assert.equal(u.status().last?.result, 'done', u.status().last?.message)
      assert.match(u.status().last?.message ?? '', /после перезапуска демона/)
      assert.deepEqual(readAppState(w.home.paths).bad, [])
      assert.equal(w.signals.length, 0)
      assert.equal(existsSync(join(w.home.paths.apps, 'swap.json')), false)
    } finally { w.remove() }
  })

  it('кандидат в прежнее окно проверяется (подпись): испорченный .old пропускается, берётся previous', async () => {
    const w = world({ running: false })
    try {
      const tagd = homeTag(w.home.paths.home)
      const oldAt = join(w.appsDir, `.Pult.app.old-${OLD}-${tagd}`)
      const prevAt = join(w.home.paths.apps, `previous-${OLD}`, 'Pult.app')
      journal(w, 'swapped', { prev: oldAt })
      swapTo(w, prevAt)
      cpSync(prevAt, oldAt, { recursive: true, verbatimSymlinks: true })
      w.codesignFailFor = (p) => p === oldAt
      await recovered(w)
      assert.equal(versionAt(w.app), OLD)
      assert.equal(existsSync(prevAt), false, 'взят previous')
    } finally { w.remove() }
  })

  it('восстановление не прошло (прежнего нет) — журнал остаётся, «Обновить окно» отказывает до перезапуска демона', async () => {
    const w = world({ running: false })
    try {
      journal(w, 'swapped')
      rmSync(w.app, { recursive: true })
      renameSync(makeBundle(mkdtempSync(join(w.root, 'n-')), { version: NEW }), w.app)
      const u = updaterOf(w)
      await u.ready
      assert.ok(existsSync(join(w.home.paths.apps, 'swap.json')))
      assert.match(u.status().last?.message ?? '', /восстановление после обрыва не прошло/)
      w.manifest.version = '0.1.17'
      await assert.rejects(u.apply(), /прошлое обновление окна не доведено/)
    } finally { w.remove() }
  })

  it('оборванный откат: места пусто, прежнее в .incoming-<from>, новое в .failed-<to> — прежнее на место', async () => {
    const w = world({ running: false })
    try {
      journal(w, 'rollback')
      renameSync(w.app, join(w.appsDir, `.Pult.app.incoming-${OLD}-${homeTag(w.home.paths.home)}`))
      renameSync(makeBundle(mkdtempSync(join(w.root, 'n-')), { version: NEW }), join(w.appsDir, `.Pult.app.failed-${NEW}-${homeTag(w.home.paths.home)}`))
      const u = await recovered(w)
      assert.equal(versionAt(w.app), OLD)
      assert.equal(u.status().last?.result, 'rolled_back')
    } finally { w.remove() }
  })

  it('откат дошёл до конца, итог не записан — rolled_back и bad', async () => {
    const w = world({ running: false })
    try {
      journal(w, 'rollback')
      const u = await recovered(w)
      assert.equal(u.status().last?.result, 'rolled_back')
      assert.deepEqual(readAppState(w.home.paths).bad, [NEW])
    } finally { w.remove() }
  })

  it('без журнала — уборка staging-*, failed-*, своих .Pult.app.{incoming,failed,old}-*-<метка>; чужие и previous — нет', async () => {
    const w = world({ running: false })
    try {
      const tg = homeTag(w.home.paths.home)
      for (const d of [`staging-${NEW}`, `failed-${NEW}`, `previous-${OLD}`]) mkdirSync(join(w.home.paths.apps, d), { recursive: true })
      for (const d of [`.Pult.app.incoming-${NEW}-${tg}`, `.Pult.app.failed-${NEW}-${tg}`, `.Pult.app.old-${OLD}-${tg}`, `.Pult.app.incoming-${NEW}-deadbeef`]) mkdirSync(join(w.appsDir, d))
      const u = updaterOf(w)
      await u.ready
      assert.deepEqual(readdirSync(w.home.paths.apps), [`previous-${OLD}`])
      assert.deepEqual(readdirSync(w.appsDir).sort(), [`.Pult.app.incoming-${NEW}-deadbeef`, 'Pult.app'], 'чужой PULT_HOME не тронут')
      assert.equal(versionAt(w.app), OLD)
    } finally { w.remove() }
  })

  it('остановка демона: до закрытия окна — работа бросается, окно не тронуто; после — ждёт её конца', async () => {
    const w = world()
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.stop()
      await u.idle()
      assert.match(u.status().last?.message ?? '', /демон останавливается/)
      untouched(w)
    } finally { w.remove() }
    const w2 = world()
    w2.helloOnOpen = false
    try {
      const u = updaterOf(w2, { helloWaitMs: 5000 })
      await u.apply()
      assert.ok(await waitFor(() => u.status().applying?.step === 'health', 5000))
      await u.stop()
      assert.equal(u.status().applying, null, 'stop разбудил пробу и дождался выхода работы')
      assert.ok(existsSync(join(w2.home.paths.apps, 'swap.json')), 'окно не гасили в спешке — журнал для старта')
      assert.equal(versionAt(w2.app), NEW)
      // Следующий старт: новое окно не поднялось и после перезапуска — откат и bad.
      const u2 = updaterOf(w2)
      await u2.ready
      assert.equal(versionAt(w2.app), OLD)
      assert.equal(u2.status().last?.result, 'rolled_back')
      assert.deepEqual(readAppState(w2.home.paths).bad, [NEW])
    } finally { w2.remove() }
  })
})

describe('обновление окна: другие окна и строгая проба', () => {
  it('открыто окно не из поставленного бандла — отказ «закрой окно из …» до закрытия окна', async () => {
    const w = world()
    w.shells = [{ version: OLD, execPath: '/Users/you/Applications/Pult.app/Contents/MacOS/Pult', pid: 7 }]
    try {
      await runFailed(w, /закрой окно из \/Users\/you\/Applications\/Pult\.app/)
      untouched(w)
      assert.equal(w.signals.length, 0)
    } finally { w.remove() }
  })

  it('стоят два Pult.app — выбирается тот, чьё окно открыто', () => {
    const w = world()
    try {
      const second = join(w.root, 'HomeApplications')
      mkdirSync(second)
      const app2 = makeBundle(second, { version: '0.1.14' })
      w.shells = [{ version: '0.1.14', execPath: join(app2, 'Contents', 'MacOS', 'Pult'), pid: 9 }]
      const u = updaterOf(w, { tools: { ...w.tools(), appDirs: () => [w.appsDir, second] } })
      assert.equal(u.status().path, app2)
      w.shells = []
      assert.equal(u.status().path, w.app)
    } finally { w.remove() }
  })

  for (const [name, set] of [
    ['процесс запущен до замены', (w: World) => { w.newProcAgeMs = 60_000 }],
    ['процесс чужого пользователя', (w: World) => { w.newProcUid = (process.getuid?.() ?? 0) + 1 }],
  ] as const) {
    it(`готовность не засчитывается: ${name} — откат`, async () => {
      const w = world()
      set(w)
      try {
        const u = updaterOf(w)
        await u.apply()
        await u.idle()
        assert.equal(u.status().last?.result, 'rolled_back', u.status().last?.message)
      } finally { w.remove() }
    })
  }

  it('готовность, проверка которой шла во время ожидания, засчитывается перед тем, как гасить', async () => {
    const w = world()
    w.readyDelayMs = 10
    w.procInfoDelayMs = 200
    try {
      const u = updaterOf(w, { helloWaitMs: 100 })
      w.findPidsDelayMs = 0
      await u.apply()
      assert.ok(await waitFor(() => u.status().applying?.step === 'health', 5000))
      w.findPidsDelayMs = 300 // поиск новых процессов при откате дольше проверки готовности
      await u.idle()
      assert.equal(u.status().last?.result, 'done', u.status().last?.message)
      assert.equal(versionAt(w.app), NEW)
    } finally { w.remove() }
  })

  it('окно было закрыто — не открывается; previous держится до первого запуска; первый запуск готов — отпускается', async () => {
    const w = world({ running: false })
    mkdirSync(join(w.root, 'x'))
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      assert.equal(u.status().last?.result, 'done')
      assert.match(u.status().last?.message ?? '', /ещё не запускалось.*pult ui/)
      assert.deepEqual(w.opens, [])
      assert.deepEqual(u.status().firstRun, { to: NEW, from: OLD, state: 'waiting' })
      assert.ok(existsSync(join(w.home.paths.apps, `previous-${OLD}`, 'Pult.app')))
      // Человек открыл окно: hello и готовность интерфейса из нового бандла.
      const pid = nextPid++
      const exe = join(w.app, 'Contents', 'MacOS', 'Pult')
      w.procs.set(pid, { exe, alive: true, startedAt: Date.now() })
      u.onShellHello({ version: NEW, execPath: exe, pid })
      u.onShellReady({ version: NEW, execPath: exe, pid })
      assert.ok(await waitFor(() => u.status().firstRun === null, 2000), 'первый запуск засчитан')
      assert.ok(existsSync(join(w.home.paths.apps, `previous-${OLD}`)), 'previous — ещё один цикл')
    } finally { w.remove() }
  })

  it('первый запуск окна, заменённого закрытым, не заработал за срок — «Вернуть 0.1.15» (rollback) возвращает прежнее', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      const pid = nextPid++
      const exe = join(w.app, 'Contents', 'MacOS', 'Pult')
      w.procs.set(pid, { exe, alive: true, startedAt: Date.now() })
      u.onShellHello({ version: NEW, execPath: exe, pid })
      assert.ok(await waitFor(() => u.status().firstRun?.state === 'failed', 3000))
      assert.match(u.status().last?.message ?? '', /не заработало при первом запуске.*Вернуть 0\.1\.15/)
      const r = await u.apply({ rollback: true })
      assert.equal(r.to, NEW)
      await u.idle()
      assert.equal(versionAt(w.app), OLD)
      assert.equal(u.status().last?.result, 'rolled_back', u.status().last?.message)
      assert.deepEqual(readAppState(w.home.paths).bad, [NEW])
      assert.equal(u.status().firstRun, null)
      assert.ok(w.signals.some(([p, sig]) => p === pid && sig === 'SIGTERM'), 'неработающее новое окно погашено')
      await assert.rejects(u.apply({ rollback: true }), /возвращать нечего/)
    } finally { w.remove() }
  })

  it('пока новое окно не запускалось, «Обновить окно» отказывает: открой его или верни прежнее', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      w.manifest.version = '0.1.17'
      assert.equal(u.status().available, false)
      await assert.rejects(u.apply(), /новое окно 0\.1\.16 ещё не запускалось: открой его \(pult ui\) или верни 0\.1\.15/)
    } finally { w.remove() }
  })

  it('окно упало, не подключившись: процесс из нового бандла замечен ps — тот же отсчёт, «не заработало»', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      // hello нет: процесс есть, но упал раньше, чем подключился к демону.
      w.procs.set(nextPid++, { exe: join(w.app, 'Contents', 'MacOS', 'Pult'), alive: true, startedAt: Date.now() })
      assert.ok(await waitFor(() => u.status().firstRun?.state === 'failed', 3000), 'отсчёт пошёл от ps')
    } finally { w.remove() }
  })

  it('«Вернуть»: rename(прежнее → место) не прошёл — копия рядом переживает старт, и старт её возвращает', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      let fail = true
      w.renameFail = (src, dst) => (fail && src.includes(`.Pult.app.incoming-${OLD}-`) && dst === w.app ? errno('EIO') : null)
      await u.apply({ rollback: true })
      await u.idle()
      assert.match(u.status().last?.message ?? '', /вернуть окно 0\.1\.15 не вышло.*\.Pult\.app\.incoming-0\.1\.15-.*перезапуск демона доведёт/)
      assert.equal(versionAt(w.app), NEW, 'новое вернулось на место')
      const back = join(w.appsDir, `.Pult.app.incoming-${OLD}-${homeTag(w.home.paths.home)}`)
      assert.equal(versionAt(back), OLD)
      assert.ok(existsSync(join(w.home.paths.apps, 'swap.json')), 'журнал возврата')
      assert.equal(readAppState(w.home.paths).pending?.prev, back, 'pending знает, где прежнее')
      await u.stop()
      fail = false
      const u2 = updaterOf(w)
      await u2.ready
      assert.equal(versionAt(w.app), OLD, 'старт довёл возврат')
      assert.equal(u2.status().firstRun, null)
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
    } finally { w.remove() }
  })

  it('«Вернуть»: обрыв между двумя rename (места пусто) — старт ставит прежнее, не удаляя его как мусор', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      await u.stop()
      const tg = homeTag(w.home.paths.home)
      const pd = readAppState(w.home.paths).pending
      assert.ok(pd)
      // Состояние после «прежнее → .incoming-<from>» и «новое → .failed-<to>», до «.incoming → место».
      const back = join(w.appsDir, `.Pult.app.incoming-${OLD}-${tg}`)
      renameSync(pd.prev, back)
      renameSync(w.app, join(w.appsDir, `.Pult.app.failed-${NEW}-${tg}`))
      writeFileSync(join(w.home.paths.apps, 'swap.json'), JSON.stringify({
        schema: 1, app: w.app, dir: w.appsDir, old: join(w.appsDir, `.Pult.app.old-${OLD}-${tg}`), incoming: join(w.appsDir, `.Pult.app.incoming-${NEW}-${tg}`),
        prev: back, from: OLD, to: NEW, phase: 'rollback', wasRunning: true, at: new Date().toISOString(), swapAt: pd.swapAt,
      }))
      const u2 = updaterOf(w)
      await u2.ready
      assert.equal(versionAt(w.app), OLD)
      assert.equal(u2.status().firstRun, null)
      assert.deepEqual(readAppState(w.home.paths).bad, [NEW])
      assert.deepEqual(readdirSync(w.appsDir), ['Pult.app'])
    } finally { w.remove() }
  })

  it('без журнала уборка не трогает прежнее окно, ждущее первого запуска (и его место рядом с окном)', async () => {
    const w = world({ running: false })
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      await u.stop()
      const tg = homeTag(w.home.paths.home)
      const pd = readAppState(w.home.paths).pending
      assert.ok(pd)
      const back = join(w.appsDir, `.Pult.app.incoming-${OLD}-${tg}`)
      renameSync(pd.prev, back)
      const u2 = updaterOf(w)
      await u2.ready
      assert.equal(versionAt(back), OLD, 'копия рядом с окном сохранена')
    } finally { w.remove() }
  })

  it('откат не прошёл — итог называет, где прежнее окно сейчас', async () => {
    const w = world()
    w.helloOnOpen = false
    w.renameFail = (src, dst) => (src.includes(`.Pult.app.incoming-${OLD}-`) && dst === w.app ? errno('EIO') : null)
    try {
      const u = updaterOf(w)
      await u.apply()
      await u.idle()
      assert.match(u.status().last?.message ?? '', new RegExp(`откат не прошёл.*прежнее окно в .*\\.Pult\\.app\\.incoming-0\\.1\\.15-${homeTag(w.home.paths.home)}`))
    } finally { w.remove() }
  })

  it('ps etime → секунды', () => {
    assert.equal(etimeSeconds('00:07'), 7)
    assert.equal(etimeSeconds('01:02:03'), 3723)
    assert.equal(etimeSeconds('2-00:00:01'), 172801)
    assert.equal(etimeSeconds('nope'), null)
  })
})

describe('обновление окна: zip и дерево (ревью)', () => {
  it('локальный заголовок с другим именем, чем в каталоге, — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-l-'))
    try {
      const file = join(dir, 'a.zip')
      const z = zipOf([{ name: 'Pult.app/aaa', data: Buffer.from('x'), mode: 0o100644 }])
      const at = z.indexOf(Buffer.from('Pult.app/aaa'))
      z.write('Pult.app/../', at, 'utf8') // только локальное имя; каталог прежний
      writeFileSync(file, z)
      assert.throws(() => scanZip(file), /имя в локальном заголовке другое/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('локальная запись, которой нет в каталоге, и записи внахлёст — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-h-'))
    try {
      const file = join(dir, 'a.zip')
      const e = (n: string): ZEntry => ({ name: n, data: Buffer.from(n), mode: 0o100644 })
      writeFileSync(file, zipOf([e('Pult.app/a'), e('Pult.app/evil'), e('Pult.app/b')], { hide: [1] }))
      assert.throws(() => scanZip(file), /лишние байты/)
      writeFileSync(file, zipOf([e('Pult.app/a'), e('Pult.app/evil')], { hide: [1] }))
      assert.throws(() => scanZip(file), /лишние байты/)
      writeFileSync(file, zipOf([e('Pult.app/a'), e('Pult.app/b')], { dupFirst: true }))
      assert.throws(() => scanZip(file), /наложена/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('zip от настоящего ditto (дескрипторы данных, AppleDouble) проходит', { skip: process.platform !== 'darwin' ? 'ditto — только macOS' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-d-'))
    try {
      const app = makeBundle(dir, { version: NEW })
      writeFileSync(join(app, 'Contents', 'Resources.bin'), Buffer.alloc(200_000, 7))
      const file = join(dir, 'd.zip')
      spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, file])
      assert.ok(scanZip(file).entries > 5)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ссылка в никуда — отказ (по буквам её не проверить)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-n-'))
    try {
      const app = makeBundle(dir, { version: NEW })
      symlinkSync('..', join(app, 'Contents', 'D'))
      symlinkSync('Contents/D/../nonexist', join(app, 'F'))
      assert.throws(() => checkTree(app), /ведёт в никуда/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('цепочка ссылок: по буквам внутри, на деле наружу — отказ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pau-c-'))
    try {
      const app = makeBundle(dir, { version: NEW })
      symlinkSync('..', join(app, 'Contents', 'D'))
      symlinkSync('Contents/D/..', join(app, 'C'))
      assert.throws(() => checkTree(app), /через цепочку ссылок/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('совет «вручную» для /Applications: удалить старое, если ставить в ~/Applications', () => {
    assert.match(manualSteps('https://example.invalid/Pult-0.1.16-arm64.zip', '/Applications'), /удали \/Applications\/Pult\.app.*~\/Applications/)
    assert.doesNotMatch(manualSteps(null, '/Users/you/Applications'), /удали/)
  })
})

describe('обновление окна: другое окно по сокету (here)', () => {
  it('окно не из поставленного бандла видит here: false, а «Обновить окно» отказывает «закрой окно из …»', async () => {
    const w = world({ running: false })
    w.home.config.updates = { check: false, url: URL_LATEST }
    const tools = w.tools()
    const d = await startTestDaemon(w.home, { updates: { http: tools.http as HttpGet, keys: KEYS, schedule: false }, appUpdate: { tools, quitWaitMs: 300, helloWaitMs: 500, killWaitMs: 200, pollMs: 10 } })
    const sh = await rawConnect(w.home.paths)
    try {
      sh.send({ type: 'hello', token: readFileSync(w.home.paths.token, 'utf8').trim(), client: 'shell', protocol: 1, app: { execPath: '/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', version: '44.4.5', pid: 5 } })
      await sh.next()
      sh.send({ id: 1, method: 'update.check' })
      const r = await sh.next() as { result: UpdateStatus }
      assert.equal(r.result.app?.here, false)
      assert.equal(r.result.app?.available, true)
      const c = await connectClient(w.home.paths)
      assert.equal(((await c.request('update.status')) as UpdateStatus).app?.here, null, 'не окно — null')
      await c.request('update.apply', { target: 'app' })
      assert.ok(await waitFor(async () => ((await c.request('update.status')) as UpdateStatus).app?.applying === null, 10_000))
      assert.match(((await c.request('update.status')) as UpdateStatus).app?.last?.message ?? '', /закрой окно из \/w\/node_modules\/electron\/dist\/Electron\.app/)
      assert.equal(versionAt(w.app), OLD)
      c.close()
    } finally {
      sh.end()
      await d.stop('тест')
      w.remove()
    }
  })
})

export type { ShellHello }
