import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { importAttachment, importStoredAttachment, previewAttachment } from '../../src/attachmentStore.js'
import { attachmentInputFromFile } from '../../src/attachmentInput.js'

const LARGE = 27_282_841
it('native large paths are stat-only external references, without cache/quota/copy/preview', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pult-linked-shell-'))
  try {
    const home = path.join(root, 'home')
    const source = path.join(root, 'original.png')
    const fd = openSync(source, 'wx'); try { ftruncateSync(fd, LARGE) } finally { closeSync(fd) }
    const saved = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync, createHash: crypto.createHash }
    const attempts = { open: 0, read: 0, hash: 0 }
    let result
    try {
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]) === source || String(args[0]) === realpathSync(source)) { attempts.open++; throw new Error('must not open original content') }
        return saved.openSync(...args)
      }) as typeof fs.openSync
      fs.readSync = (() => { attempts.read++; throw new Error('must not read original content') }) as typeof fs.readSync
      fs.readFileSync = (() => { attempts.read++; throw new Error('must not read original content') }) as typeof fs.readFileSync
      crypto.createHash = (() => { attempts.hash++; throw new Error('must not hash original content') }) as typeof crypto.createHash
      syncBuiltinESMExports()
      result = importAttachment({ home, session: 'draft', item: { path: source }, maxDayBytes: 0, rand: () => { throw new Error('reference must not allocate a cache name') } })
    } finally {
      Object.assign(fs, { openSync: saved.openSync, readSync: saved.readSync, readFileSync: saved.readFileSync })
      crypto.createHash = saved.createHash
      syncBuiltinESMExports()
    }
    assert.deepEqual(attempts, { open: 0, read: 0, hash: 0 })
    assert.deepEqual(result, { path: realpathSync(source), name: 'original.png', bytes: LARGE, mime: 'image/png', kind: 'file-reference' })
    assert.equal(existsSync(home), false)
    assert.ok('error' in importStoredAttachment({ home, session: 'final', item: { path: source } }), 'renderer import still cannot copy arbitrary external paths')
    assert.ok('error' in previewAttachment({ home, session: 'draft', source, decode: () => { throw new Error('reference must not be decoded') } }))
    const symlink = path.join(root, 'alias.png'); symlinkSync(source, symlink)
    assert.ok('error' in importAttachment({ home, session: 'draft', item: { path: symlink } }))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('preload prefers native paths and rejects oversized pathless blobs before arrayBuffer', async () => {
  let reads = 0
  const file = { name: 'video.mp4', size: LARGE, arrayBuffer: async () => { reads++; throw new Error('do not materialize large File') } }
  assert.deepEqual(await attachmentInputFromFile(file, '/chosen/video.mp4'), { name: 'video.mp4', path: '/chosen/video.mp4' })
  const missing = await attachmentInputFromFile(file, '')
  assert.ok('error' in missing)
  assert.match(missing.error, /больше 25 МБ/)
  assert.match(missing.error, /Сохрани.*на диск/)
  assert.equal(reads, 0)
  const small = await attachmentInputFromFile({ name: 'tiny.txt', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, '')
  assert.deepEqual(small, { name: 'tiny.txt', bytes: new Uint8Array([1, 2, 3]) })
})

it('a large original under managed cache cannot become a GC-exempt reference through an alias', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pult-linked-cache-'))
  try {
    const home = path.join(root, 'home'); const cache = path.join(home, 'attachments', 'other', 'day'); mkdirSync(cache, { recursive: true })
    const source = path.join(cache, 'large.mp4'); const fd = openSync(source, 'wx'); try { ftruncateSync(fd, LARGE) } finally { closeSync(fd) }
    const alias = path.join(root, 'alias'); symlinkSync(cache, alias)
    for (const original of [source, path.join(alias, 'large.mp4')]) assert.ok('error' in importAttachment({ home, session: 'draft', item: { path: original } }))
    assert.equal(existsSync(source), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
