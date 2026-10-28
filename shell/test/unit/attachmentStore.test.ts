import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { attachmentBaseName, importAttachment, importStoredAttachment, ownedAttachment, previewAttachment } from '../../src/attachmentStore.js'
import type { ImportAttachmentOptions, ThumbnailImage } from '../../src/attachmentStore.js'
import type { AttachmentResult, SavedAttachment } from '../../src/contract.js'
import { IPC } from '../../src/contract.js'

const roots: string[] = []
after(() => { for (const p of roots) rmSync(p, { recursive: true, force: true }) })
function setup(): { root: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pat-'))
  roots.push(root)
  return { root, home: path.join(root, 'h') }
}
const NOW = new Date(2026, 9, 28, 10, 20, 30)
const rand = (): Buffer => Buffer.from('a1b2c3d4e5f6', 'hex')
const save = (o: Partial<ImportAttachmentOptions> & { home: string }): AttachmentResult => importAttachment({ session: 'chat', item: { name: 'note.txt', bytes: Buffer.from('hello') }, now: NOW, rand, ...o })
function ok(r: AttachmentResult): SavedAttachment { assert.ok(!('error' in r), JSON.stringify(r)); return r }
function png(w = 2, h = 3): Buffer {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.write('IHDR', 12)
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
function image(dataUrl = 'data:image/png;base64,cG5n'): { decode: (b: Buffer) => ThumbnailImage; calls: Buffer[]; sizes: Array<{ width: number; height: number; quality: 'good' }> } {
  const calls: Buffer[] = []
  const sizes: Array<{ width: number; height: number; quality: 'good' }> = []
  const img: ThumbnailImage = { isEmpty: () => false, getSize: () => ({ width: 2000, height: 1000 }), resize: (s) => { sizes.push(s); return img }, toDataURL: () => dataUrl }
  return { calls, sizes, decode: (b) => { calls.push(b); return img } }
}

describe('снимки вложений в хранилище сессии', () => {
  it('байты без исходного пути сохраняются приватно; имя не может выйти из папки', () => {
    const { home } = setup()
    const r = ok(save({ home, item: { name: '../../screen shot.png', bytes: png() } }))
    assert.equal(r.name, 'screen shot.png')
    assert.equal(r.mime, 'image/png')
    assert.equal(r.kind, 'file')
    assert.equal(r.bytes, 33)
    assert.equal(path.dirname(r.path), path.join(home, 'attachments', 'chat', '2026-10-28'))
    assert.deepEqual(readFileSync(r.path), png())
    assert.equal(lstatSync(r.path).mode & 0o777, 0o600)
    for (const d of [path.dirname(r.path), path.dirname(path.dirname(r.path)), path.join(home, 'attachments')]) assert.equal(lstatSync(d).mode & 0o777, 0o700)
    assert.ok(ownedAttachment(home, 'chat', r.path))
    assert.ok(!ownedAttachment(home, 'other', r.path))
    assert.equal(attachmentBaseName('C:\\Screens\\../image.png'), 'image.png')
    assert.equal(attachmentBaseName('..\u0000'), '_')
    const longName = attachmentBaseName('Изображение'.repeat(80) + '.png')
    assert.ok(Buffer.byteLength(longName) <= 180)
    assert.ok(longName.endsWith('.png'))
  })

  it('копия файла живёт после удаления исходного временного файла; содержимое не меняется', () => {
    const { root, home } = setup()
    const source = path.join(root, 'temporary.pdf')
    const bytes = Buffer.from('%PDF-1.7\nabc\0binary')
    writeFileSync(source, bytes)
    const r = ok(save({ home, item: { path: source } }))
    unlinkSync(source)
    assert.notEqual(r.path, source)
    assert.equal(r.name, 'temporary.pdf')
    assert.equal(r.mime, 'application/pdf')
    assert.deepEqual(readFileSync(r.path), bytes)
  })

  it('draft можно перенести в finalsession, повторная передача уже своего файла не плодит копии', () => {
    const { home } = setup()
    const draft = ok(save({ home, session: 'draft-1' }))
    const final = ok(save({ home, session: 'final', item: { path: draft.path, name: draft.name } }))
    assert.notEqual(final.path, draft.path)
    assert.equal(final.name, draft.name)
    assert.equal(readFileSync(final.path, 'utf8'), 'hello')
    assert.deepEqual(ok(save({ home, session: 'final', item: { path: final.path, name: final.name } })), final)
    assert.equal(readdirSync(path.dirname(final.path)).length, 1)
  })

  it('public import отклоняет произвольный исходный путь, native import копирует его, а rehome принимает сохранённый', () => {
    const { root, home } = setup()
    const source = path.join(root, 'secret.txt')
    writeFileSync(source, 'private source')
    const opts = { home, session: 'draft', item: { path: source }, now: NOW, rand }
    assert.ok('error' in importStoredAttachment(opts))
    const saved = ok(importAttachment(opts))
    const copied = ok(importStoredAttachment({ ...opts, session: 'final', item: { path: saved.path, name: saved.name } }))
    assert.equal(readFileSync(copied.path, 'utf8'), 'private source')
    assert.notEqual(copied.path, saved.path)
  })

  it('папка остаётся ссылкой без рекурсивной копии; симлинк не принимается', () => {
    const { root, home } = setup()
    const folder = path.join(root, 'project')
    mkdirSync(folder)
    writeFileSync(path.join(folder, 'readme.md'), '# hi')
    const r = ok(save({ home, item: { path: folder } }))
    assert.deepEqual(r, { path: realpathSync(folder), name: 'project', bytes: 0, mime: 'inode/directory', kind: 'directory' })
    const link = path.join(root, 'link')
    symlinkSync(path.join(folder, 'readme.md'), link)
    assert.match(JSON.stringify(save({ home, item: { path: link } })), /символические ссылки/)
  })

  it('не принимает слишком большой файл/байты, исчезнувший путь, чужой тип и некорректное имя сессии', () => {
    const { root, home } = setup()
    writeFileSync(path.join(root, 'big'), Buffer.alloc(20))
    for (const item of [{ path: path.join(root, 'big') }, { bytes: new Uint8Array(20) }]) assert.match(JSON.stringify(save({ home, item, maxBytes: 10 })), /больше 25 МБ/)
    assert.match(JSON.stringify(save({ home, item: { path: path.join(root, 'gone') } })), /исчез/)
    assert.match(JSON.stringify(save({ home, item: { path: 'relative.txt' } })), /абсолютный путь/)
    for (const session of ['../foreign', '', 'A', null]) assert.ok('error' in save({ home, session }))
    for (const item of [null, {}, { bytes: 'x' }, { path: '/file', bytes: Buffer.from('x') }, { name: 3, bytes: Buffer.from('x') }]) assert.ok('error' in save({ home, item }))
    assert.ok('error' in save({ home: '' }))
  })

  it('не следует destination-симлинкам, не перезаписывает существующее имя, соблюдает дневную квоту', () => {
    const { root, home } = setup()
    mkdirSync(home)
    const outside = path.join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, path.join(home, 'attachments'))
    assert.ok('error' in save({ home }))
    assert.deepEqual(readdirSync(outside), [])
    const other = setup()
    const first = ok(save({ home: other.home }))
    assert.ok('error' in save({ home: other.home }))
    assert.equal(readFileSync(first.path, 'utf8'), 'hello')
    assert.ok('error' in save({ home: other.home, rand: () => Buffer.from('000000', 'hex'), maxDayBytes: 9 }))
    assert.equal(readdirSync(path.dirname(first.path)).length, 1)
  })
})

describe('превью сохранённого вложения', () => {
  it('декодирует только raster из своей сессии и уменьшает до320×240', () => {
    const { home } = setup()
    const r = ok(save({ home, item: { name: 's.png', bytes: png() } }))
    const d = image()
    assert.deepEqual(previewAttachment({ home, session: 'chat', source: r.path, decode: d.decode }), { dataUrl: 'data:image/png;base64,cG5n' })
    assert.equal(d.calls.length, 1)
    assert.deepEqual(d.sizes, [{ width: 320, height: 160, quality: 'good' }])
    assert.ok('error' in previewAttachment({ home, session: 'other', source: r.path, decode: d.decode }))
    assert.equal(d.calls.length, 1)
  })

  it('SVG/HTML, pixel bomb, сырая внешняя картинка и подменённый симлинком файл не доходят до декодера', () => {
    const d = image()
    for (const [name, bytes] of [['x.svg', Buffer.from('<svg/>')], ['x.html', Buffer.from('<html/>')], ['x.png', png(50000, 50000)]] as const) {
      const { home } = setup()
      const r = ok(save({ home, item: { name, bytes } }))
      assert.ok('error' in previewAttachment({ home, session: 'chat', source: r.path, decode: d.decode }))
    }
    const { root, home } = setup()
    const outside = path.join(root, 'outside.png')
    writeFileSync(outside, png())
    assert.ok('error' in previewAttachment({ home, session: 'chat', source: outside, decode: d.decode }))
    const r = ok(save({ home, item: { name: 's.png', bytes: png() } }))
    unlinkSync(r.path)
    symlinkSync(outside, r.path)
    assert.ok('error' in previewAttachment({ home, session: 'chat', source: r.path, decode: d.decode }))
    assert.equal(d.calls.length, 0)
  })

  it('не отдаёт HTML/data URI и слишком большое превью', () => {
    const { home } = setup()
    const r = ok(save({ home, item: { name: 's.png', bytes: png() } }))
    for (const dataUrl of ['data:text/html;base64,eA==', 'data:image/png;base64,' + 'x'.repeat(300_000)]) {
      assert.ok('error' in previewAttachment({ home, session: 'chat', source: r.path, decode: image(dataUrl).decode }))
    }
    assert.notEqual(IPC.attachmentImport, IPC.attachmentPreview)
  })
})
