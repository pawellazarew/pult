// Окно обновляется само (0.3.4): демон качает zip окна из подписанного манифеста, проверяет его, закрывает окно,
// меняет Pult.app, открывает новое и ждёт его hello; не поднялось — откат. Всё — на фальшивых бандлах во временных
// папках и на швах (распаковка, подпись, процессы, сигналы, open, lsregister, hello): настоящий Pult.app, ~/.pult
// и настоящий демон не трогаются никогда.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { ClientError, shellAppInfo } from '../dist/cli/client.js'
import type { AppUpdateStatus, UpdateStatus } from '../dist/core/rpc.js'
import { acquireLock } from '../dist/core/lock.js'
import { readAppState } from '../dist/update/appState.js'
import {
  APP_BUNDLE_ID, AppUpdateError, checkTree, createAppUpdater, machOArchs, scanZip, shellHelloOf,
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
function zipOf(entries: ZEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const e of entries) {
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
    centrals.push(ch, name)
    off += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
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

interface Proc { exe: string; alive: boolean }

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
        codesignVerify: async () => { if (w.codesignFail) throw new Error('codesign: code object is not signed at all') },
        plistXml: async () => null,
        findPids: async (exe) => [...w.procs].filter(([, p]) => p.alive && p.exe === exe).map(([pid]) => pid),
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
          w.procs.set(pid, { exe, alive: true })
          const version = plistString(readFileSync(join(a, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleShortVersionString')
          if (w.helloOnOpen) setTimeout(() => w.updater?.onShellHello({ version, execPath: exe }), 20)
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
        quitWaitMs: 300,
        helloWaitMs: 400,
        killWaitMs: 200,
        pollMs: 10,
        ...over,
      }
    },
    remove() {
      try { chmodSync(appsDir, 0o755) } catch { /* уже */ }
      rmSync(root, { recursive: true, force: true })
      home.remove()
    },
  }
  if (o.running !== false) w.procs.set(nextPid++, { exe: join(app, 'Contents', 'MacOS', 'Pult'), alive: true })
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
    assert.deepEqual(shellHelloOf({ version: '0.1.16', execPath: '/x' }), { version: '0.1.16', execPath: '/x' })
    assert.deepEqual(shellHelloOf({ version: 'x'.repeat(41), execPath: 5 }), { version: null, execPath: null })
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
  async function daemonWorld(w: World, opts: { hello?: boolean } = {}) {
    const tools = w.tools()
    const d = await startTestDaemon(w.home, {
      updates: { http: tools.http as HttpGet, keys: KEYS, schedule: false },
      appUpdate: {
        tools: {
          ...tools,
          open: async (a) => {
            w.opens.push(a)
            if (opts.hello === false) return
            const exe = join(a, 'Contents', 'MacOS', 'Pult')
            const version = versionAt(a)
            // Настоящее рукопожатие оболочки: client 'shell' и app {version, execPath}.
            const c = await rawConnect(w.home.paths)
            c.send({ type: 'hello', token: readFileSync(w.home.paths.token, 'utf8').trim(), client: 'shell', protocol: 1, app: { version, execPath: exe } })
            await c.next()
            setTimeout(() => c.end(), 50)
          },
        },
        quitWaitMs: 300, helloWaitMs: 2000, killWaitMs: 200, pollMs: 10,
      },
    })
    return d
  }

  it('update.apply {target: app} по сокету; hello оболочки новой версии — готово; статус в daemon.status', async () => {
    const w = world({ running: false })
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

  it('CLI: --force без --app и --app вместе с --check — отказ', async () => {
    const run = (args: string[]): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
      const home = mkdtempSync(join(tmpdir(), 'pau-c-'))
      const child = spawn(process.execPath, [CLI_ENTRY, 'update', ...args], { env: { ...process.env, PULT_HOME: home, PULT_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stderr.on('data', (b: Buffer) => { out += b.toString() })
      child.on('exit', (code) => { rmSync(home, { recursive: true, force: true }); resolve({ code, out }) })
    })
    const a = await run(['--force'])
    assert.notEqual(a.code, 0)
    assert.match(a.out, /--force — только вместе с --app/)
    const b = await run(['--app', '--check'])
    assert.notEqual(b.code, 0)
    assert.match(b.out, /pult update --check/)
  })
})

export type { ShellHello }
