// Картинка из буфера → PNG в PULT_HOME/attachments/<сессия> (shell/src/clipboardImage.ts): права, раскладка, имя сессии,
// размер по заголовку ДО декодирования (бомба), потолки, симлинки, потолок за день, частота, чтение `ClipboardItem`.

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  attachmentName, attachmentsDir, dayBytes, imageHeaderSize, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_RAW_BYTES,
  readClipboardImageBytes, saveClipboardImage, SaveRate, SESSION_NAME_RE,
} from '../../src/clipboardImage.js'
import type { ImageLike, SaveImageOptions } from '../../src/clipboardImage.js'
import { IPC } from '../../src/contract.js'

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const home = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'pci-')); roots.push(d); return path.join(d, 'h') }

/** PNG с IHDR заданного размера (тело не важно: декодер в тестах — заглушка). */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20)
  return b
}
/** JPEG: SOI, APP0, SOF0 с размером. */
function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sofSeg = Buffer.from([0xff, sof, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, Buffer.from([0xff, 0xd9])])
}
const OUT = Buffer.from('encoded-png')
function decoder(size?: { width: number; height: number }, out: Buffer = OUT) {
  const calls: Buffer[] = []
  const decode = (b: Buffer): ImageLike => {
    calls.push(b)
    const h = imageHeaderSize(b)
    const s = size ?? { width: h?.width ?? 0, height: h?.height ?? 0 }
    return { isEmpty: () => false, getSize: () => s, toPNG: () => out }
  }
  return { decode, calls }
}
const NOW = new Date(2026, 9, 27, 9, 5, 7) // местное время: 2026-10-27 09:05:07
const rand = (): Buffer => Buffer.from([0xa1, 0xb2, 0xc3])
const mode = (p: string): number => lstatSync(p).mode & 0o777
const save = (o: Partial<SaveImageOptions> & { home: string }) => {
  const d = decoder()
  return saveClipboardImage({ session: 'w', bytes: png(2, 3), decode: d.decode, now: NOW, rand, ...o })
}

describe('картинка из буфера → файл', () => {
  it('имя: <ГГГГ-ММ-ДД>/paste-<ЧЧММСС>-<6 hex>.png по местному времени', () => {
    assert.deepEqual(attachmentName(NOW, 'a1b2c3'), { day: '2026-10-27', file: 'paste-090507-a1b2c3.png' })
  })

  it('пишет PNG под attachments/<сессия>/<дата>/: папки 0700, файл 0600, ответ — путь, размеры, байты', () => {
    const h = home()
    const r = save({ home: h })
    assert.ok(!('error' in r), JSON.stringify(r))
    const want = path.join(h, 'attachments', 'w', '2026-10-27', 'paste-090507-a1b2c3.png')
    assert.deepEqual(r, { path: want, width: 2, height: 3, bytes: OUT.length })
    assert.deepEqual(readFileSync(want), OUT)
    assert.equal(mode(want), 0o600)
    for (const d of ['attachments', 'attachments/w', 'attachments/w/2026-10-27']) assert.equal(mode(path.join(h, d)), 0o700, d)
    assert.equal(attachmentsDir(h), path.join(h, 'attachments'))
  })

  it('имя сессии — по правилу демона; чужое или пустое — отказ, файла нет', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'sessions', 'registry.ts'), 'utf8')
    assert.ok(src.includes(`SESSION_NAME_RE = ${SESSION_NAME_RE.toString()}`), 'правило имён разошлось с демоном')
    for (const session of ['', '../x', 'a/b', '.', 'W', '-x', 'a'.repeat(33), null, 7]) {
      const h = home()
      const r = save({ home: h, session })
      assert.ok('error' in r && /сессия/.test(r.error), `${String(session)}: ${JSON.stringify(r)}`)
      assert.throws(() => readdirSync(path.join(h, 'attachments')))
    }
  })

  it('папка с правами шире 0700 (создана руками) — подтягивается к 0700', () => {
    const h = home()
    mkdirSync(path.join(h, 'attachments', 'w'), { recursive: true, mode: 0o755 })
    assert.ok(!('error' in save({ home: h })))
    assert.equal(mode(path.join(h, 'attachments')), 0o700)
    assert.equal(mode(path.join(h, 'attachments', 'w')), 0o700)
  })

  it('тот же файл второй раз — отказ, а не перезапись (wx)', () => {
    const h = home()
    save({ home: h })
    const r = saveClipboardImage({ home: h, session: 'w', bytes: png(1, 1), decode: decoder(undefined, Buffer.from('другое')).decode, now: NOW, rand })
    assert.ok('error' in r)
    assert.deepEqual(readFileSync(path.join(h, 'attachments', 'w', '2026-10-27', 'paste-090507-a1b2c3.png')), OUT)
  })

  it('PNG больше потолка — отказ словами, файла нет', () => {
    const h = home()
    const r = saveClipboardImage({ home: h, session: 'w', bytes: png(2, 2), decode: decoder(undefined, Buffer.alloc(2048, 1)).decode, now: NOW, rand, maxBytes: 1024 })
    assert.ok('error' in r && /больше/.test(r.error), JSON.stringify(r))
    assert.equal(MAX_IMAGE_BYTES, 25 * 1024 * 1024)
    assert.throws(() => readdirSync(path.join(h, 'attachments', 'w', '2026-10-27')))
  })

  it('бомба: крошечный PNG, объявивший 50000×50000, — отказ ДО декодирования', () => {
    const d = decoder()
    const bomb = png(50_000, 50_000)
    assert.ok(bomb.length < 64)
    const r = saveClipboardImage({ home: home(), session: 'w', bytes: bomb, decode: d.decode, now: NOW, rand })
    assert.ok('error' in r && /слишком большая: 50000×50000/.test(r.error), JSON.stringify(r))
    assert.equal(d.calls.length, 0, 'декодер не звали')
    assert.equal(MAX_IMAGE_PIXELS, 100_000_000)
    // То же для JPEG.
    const j = decoder()
    assert.ok('error' in saveClipboardImage({ home: home(), session: 'w', bytes: jpeg(60_000, 60_000), decode: j.decode, now: NOW, rand }))
    assert.equal(j.calls.length, 0)
  })

  it('декодер не согласен с заголовком (врёт размер) — отказ', () => {
    const d = decoder({ width: 50_000, height: 50_000 })
    assert.ok('error' in saveClipboardImage({ home: home(), session: 'w', bytes: png(1, 1), decode: d.decode, now: NOW, rand }))
  })

  it('незнакомый формат (TIFF, GIF, мусор) — отказ без декодирования; пусто — «нет картинки»', () => {
    for (const bytes of [Buffer.from('II*\0abcdefgh'), Buffer.from('GIF89a......'), Buffer.from('просто текст')]) {
      const d = decoder()
      const r = saveClipboardImage({ home: home(), session: 'w', bytes, decode: d.decode, now: NOW, rand })
      assert.ok('error' in r && /незнакомом формате/.test(r.error))
      assert.equal(d.calls.length, 0)
    }
    for (const bytes of [null, Buffer.alloc(0)]) assert.deepEqual(save({ home: home(), bytes }), { error: 'в буфере нет картинки' })
    assert.deepEqual(save({ home: home(), bytes: png(0, 0) }), { error: 'в буфере нет картинки' })
  })

  it('размер по заголовку: PNG IHDR, JPEG SOF0/SOF2 (через APP-сегменты), обрезанное — null', () => {
    assert.deepEqual(imageHeaderSize(png(1920, 1080)), { type: 'png', width: 1920, height: 1080 })
    assert.deepEqual(imageHeaderSize(jpeg(640, 480)), { type: 'jpeg', width: 640, height: 480 })
    assert.deepEqual(imageHeaderSize(jpeg(800, 600, 0xc2)), { type: 'jpeg', width: 800, height: 600 })
    assert.equal(imageHeaderSize(png(1, 1).subarray(0, 20)), null)
    assert.equal(imageHeaderSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null)
    assert.equal(imageHeaderSize(Buffer.from([0xff, 0xd8, 0x00, 0x00])), null)
  })

  it('потолок за день по всем сессиям — отказ словами', () => {
    const h = home()
    const other = path.join(h, 'attachments', 'other', '2026-10-27')
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, 'big.png'), Buffer.alloc(900))
    assert.equal(dayBytes(path.join(h, 'attachments'), '2026-10-27'), 900)
    const r = saveClipboardImage({ home: h, session: 'w', bytes: png(1, 1), decode: decoder(undefined, Buffer.alloc(200)).decode, now: NOW, rand, maxDayBytes: 1000 })
    assert.ok('error' in r && /за сегодня/.test(r.error), JSON.stringify(r))
    assert.ok(!('error' in saveClipboardImage({ home: h, session: 'w', bytes: png(1, 1), decode: decoder(undefined, Buffer.alloc(50)).decode, now: NOW, rand, maxDayBytes: 1000 })))
  })

  it('attachments, папка сессии или папка дня — симлинк (в том числе на ~): отказ, туда, куда он ведёт, не пишем', () => {
    const elsewhere = path.join(path.dirname(home()), 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const cases: Array<(h: string) => void> = [
      (h) => { mkdirSync(h, { recursive: true }); symlinkSync(elsewhere, path.join(h, 'attachments')) },
      (h) => { mkdirSync(path.join(h, 'attachments'), { recursive: true }); symlinkSync(elsewhere, path.join(h, 'attachments', 'w')) },
      (h) => { mkdirSync(path.join(h, 'attachments', 'w'), { recursive: true }); symlinkSync(elsewhere, path.join(h, 'attachments', 'w', '2026-10-27')) },
    ]
    for (const make of cases) {
      const h = home()
      make(h)
      assert.ok('error' in save({ home: h }))
      assert.deepEqual(readdirSync(elsewhere), [])
    }
    // attachments → ~: отказ ДО любой записи в домашнюю папку.
    const h = home()
    mkdirSync(h, { recursive: true })
    symlinkSync(homedir(), path.join(h, 'attachments'))
    assert.ok('error' in save({ home: h }))
  })

  it('симлинк на месте имени файла — отказ (wx не идёт по ссылке)', () => {
    const h = home()
    const day = path.join(h, 'attachments', 'w', '2026-10-27')
    mkdirSync(day, { recursive: true })
    const target = path.join(path.dirname(h), 'target.txt')
    writeFileSync(target, 'не трогать')
    symlinkSync(target, path.join(day, 'paste-090507-a1b2c3.png'))
    assert.ok('error' in save({ home: h }))
    assert.equal(readFileSync(target, 'utf8'), 'не трогать')
  })

  it('PULT_HOME не абсолютный — отказ', () => {
    assert.ok('error' in save({ home: 'rel/h' }))
  })

  it('не чаще раза в секунду', () => {
    const r = new SaveRate(1000)
    assert.deepEqual([r.take(10_000), r.take(10_500), r.take(11_000), r.take(11_999)], [true, false, true, false])
  })
})

describe('чтение картинки из буфера Electron 44 (ClipboardItem)', () => {
  const item = (types: string[], blob: unknown) => ({ types, getType: async () => blob })
  const P = png(1, 1)
  it('image/png предпочтительнее, иначе любой image/*; текст — не картинка', async () => {
    const pngBlob = new Blob([new Uint8Array(P)], { type: 'image/png' })
    const tiff = new Blob([Buffer.from('tiff')], { type: 'image/tiff' })
    assert.deepEqual(await readClipboardImageBytes({ read: async () => [item(['image/tiff'], tiff), item(['image/png'], pngBlob)] }), P)
    assert.deepEqual(await readClipboardImageBytes({ read: async () => [item(['text/plain', 'image/tiff'], tiff)] }), Buffer.from('tiff'))
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['text/plain'], new Blob(['x']))] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [] }), null)
  })
  it('Blob утиной типизацией (из другого мира instanceof не проходит)', async () => {
    const duck = { size: P.length, arrayBuffer: async () => new Uint8Array(P).buffer }
    assert.deepEqual(await readClipboardImageBytes({ read: async () => [item(['image/png'], duck)] }), P)
  })
  it('больше 50 МБ сырого, пустой, не Blob или буфер бросил — null', async () => {
    assert.equal(MAX_RAW_BYTES, 50 * 1024 * 1024)
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], { size: MAX_RAW_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) })] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], new Blob([]))] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], 'строка')] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => { throw new Error('нет доступа') } }), null)
  })
})

describe('контракт моста: путь и байты окно не передаёт', () => {
  it('свой канал IPC, каналы не повторяются', () => {
    assert.equal(IPC.clipboardImage, 'pult:clipboard-image')
    assert.equal(new Set(Object.values(IPC)).size, Object.values(IPC).length)
  })
})
