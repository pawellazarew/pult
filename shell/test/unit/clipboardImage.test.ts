// Картинка из буфера → PNG в PULT_HOME/attachments (shell/src/clipboardImage.ts): права, раскладка, потолки, симлинки,
// чтение из буфера Electron 44 (`ClipboardItem`). Метод моста без аргументов — проверка контракта здесь же.

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  attachmentName, attachmentsDir, MAX_IMAGE_BYTES, readClipboardImageBytes, saveClipboardImage,
} from '../../src/clipboardImage.js'
import type { ImageLike } from '../../src/clipboardImage.js'
import { IPC } from '../../src/contract.js'
import type { PultBridge } from '../../src/contract.js'

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const home = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'pci-')); roots.push(d); return path.join(d, 'h') }

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5a3b1f50000000049454e44ae426082', 'hex')
const image = (png: Buffer = PNG, size = { width: 1, height: 1 }): ImageLike & { encoded: number } => {
  const i = { encoded: 0, isEmpty: () => png.length === 0, getSize: () => size, toPNG: () => { i.encoded++; return png } }
  return i
}
const NOW = new Date(2026, 9, 27, 9, 5, 7) // местное время: 2026-10-27 09:05:07
const rand = (): Buffer => Buffer.from([0xa1, 0xb2, 0xc3])
const mode = (p: string): number => lstatSync(p).mode & 0o777

describe('картинка из буфера → файл', () => {
  it('имя: attachments/<ГГГГ-ММ-ДД>/paste-<ЧЧММСС>-<6 hex>.png по местному времени', () => {
    assert.deepEqual(attachmentName(NOW, 'a1b2c3'), { day: '2026-10-27', file: 'paste-090507-a1b2c3.png' })
  })

  it('пишет PNG под attachments/<дата>/: папки 0700, файл 0600, ответ — путь, размеры, байты', () => {
    const h = home()
    const r = saveClipboardImage({ home: h, image: image(PNG, { width: 1, height: 1 }), now: NOW, rand })
    assert.ok(!('error' in r), JSON.stringify(r))
    const want = path.join(h, 'attachments', '2026-10-27', 'paste-090507-a1b2c3.png')
    assert.deepEqual(r, { path: want, width: 1, height: 1, bytes: PNG.length })
    assert.deepEqual(readFileSync(want), PNG)
    assert.equal(mode(want), 0o600)
    assert.equal(mode(path.join(h, 'attachments')), 0o700)
    assert.equal(mode(path.join(h, 'attachments', '2026-10-27')), 0o700)
    assert.equal(attachmentsDir(h), path.join(h, 'attachments'))
    // НЕ внутри run/: та закрыта агентам правилами deny (0.3.7).
    assert.ok(!path.relative(path.join(h, 'run'), want).match(/^[^.]/))
  })

  it('папка с правами шире 0700 (создана руками) — подтягивается к 0700', () => {
    const h = home()
    mkdirSync(path.join(h, 'attachments'), { recursive: true, mode: 0o755 })
    assert.ok(!('error' in saveClipboardImage({ home: h, image: image(), now: NOW, rand })))
    assert.equal(mode(path.join(h, 'attachments')), 0o700)
  })

  it('тот же файл второй раз — отказ, а не перезапись (wx)', () => {
    const h = home()
    saveClipboardImage({ home: h, image: image(), now: NOW, rand })
    const r = saveClipboardImage({ home: h, image: image(Buffer.from('другое')), now: NOW, rand })
    assert.ok('error' in r)
    assert.deepEqual(readFileSync(path.join(h, 'attachments', '2026-10-27', 'paste-090507-a1b2c3.png')), PNG)
  })

  it('больше потолка — отказ словами, файла нет', () => {
    const h = home()
    const r = saveClipboardImage({ home: h, image: image(Buffer.alloc(2048, 1)), now: NOW, rand, maxBytes: 1024 })
    assert.ok('error' in r && /больше/.test(r.error), JSON.stringify(r))
    assert.equal(MAX_IMAGE_BYTES, 25 * 1024 * 1024)
    let files: string[] = []
    try { files = readdirSync(path.join(h, 'attachments', '2026-10-27')) } catch { /* папки нет — тоже нет файла */ }
    assert.deepEqual(files, [])
  })

  it('слишком много пикселей — отказ ДО кодирования', () => {
    const img = image(PNG, { width: 20_000, height: 20_000 })
    const r = saveClipboardImage({ home: home(), image: img, now: NOW, rand })
    assert.ok('error' in r && /слишком большая/.test(r.error))
    assert.equal(img.encoded, 0)
  })

  it('пустой буфер — отказ «нет картинки»', () => {
    for (const img of [null, image(Buffer.alloc(0)), image(PNG, { width: 0, height: 0 })]) {
      const r = saveClipboardImage({ home: home(), image: img, now: NOW, rand })
      assert.deepEqual(r, { error: 'в буфере нет картинки' })
    }
  })

  it('attachments или папка дня — симлинк: отказ, туда, куда он ведёт, не пишем', () => {
    const h = home()
    const elsewhere = path.join(path.dirname(h), 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(h, { recursive: true })
    symlinkSync(elsewhere, path.join(h, 'attachments'))
    assert.ok('error' in saveClipboardImage({ home: h, image: image(), now: NOW, rand }))
    assert.deepEqual(readdirSync(elsewhere), [])

    const h2 = home()
    mkdirSync(path.join(h2, 'attachments'), { recursive: true })
    symlinkSync(elsewhere, path.join(h2, 'attachments', '2026-10-27'))
    assert.ok('error' in saveClipboardImage({ home: h2, image: image(), now: NOW, rand }))
    assert.deepEqual(readdirSync(elsewhere), [])
  })

  it('симлинк на месте имени файла — отказ (wx не идёт по ссылке)', () => {
    const h = home()
    const day = path.join(h, 'attachments', '2026-10-27')
    mkdirSync(day, { recursive: true })
    const target = path.join(path.dirname(h), 'target.txt')
    writeFileSync(target, 'не трогать')
    symlinkSync(target, path.join(day, 'paste-090507-a1b2c3.png'))
    assert.ok('error' in saveClipboardImage({ home: h, image: image(), now: NOW, rand }))
    assert.equal(readFileSync(target, 'utf8'), 'не трогать')
  })

  it('PULT_HOME не абсолютный — отказ', () => {
    assert.ok('error' in saveClipboardImage({ home: 'rel/h', image: image(), now: NOW, rand }))
  })
})

describe('чтение картинки из буфера Electron 44 (ClipboardItem)', () => {
  const item = (types: string[], blob: unknown) => ({ types, getType: async () => blob })
  it('image/png предпочтительнее, иначе любой image/*; текст — не картинка', async () => {
    const png = new Blob([PNG], { type: 'image/png' })
    const tiff = new Blob([Buffer.from('tiff')], { type: 'image/tiff' })
    assert.deepEqual(await readClipboardImageBytes({ read: async () => [item(['image/tiff'], tiff), item(['image/png'], png)] }), PNG)
    assert.deepEqual(await readClipboardImageBytes({ read: async () => [item(['text/plain', 'image/tiff'], tiff)] }), Buffer.from('tiff'))
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['text/plain'], new Blob(['x']))] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [] }), null)
  })
  it('слишком большой сырой формат, пустой, не Blob или буфер бросил — null', async () => {
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], new Blob([Buffer.alloc(10)]))] }, 5), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], new Blob([]))] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => [item(['image/png'], 'строка')] }), null)
    assert.equal(await readClipboardImageBytes({ read: async () => { throw new Error('нет доступа') } }), null)
  })
})

describe('контракт моста: путь и байты окно не передаёт', () => {
  it('clipboardImage.save() без параметров, свой канал IPC', () => {
    const b = { clipboardImage: { save: async () => ({ error: 'x' }) } } satisfies Pick<PultBridge, 'clipboardImage'>
    // Сигнатура без параметров: функция с аргументом сюда не подошла бы по типу `save(): Promise<…>` только при
    // проверке длины — проверяем её и в рантайме у настоящего preload (e2e bridge.test).
    assert.equal(b.clipboardImage.save.length, 0)
    assert.equal(IPC.clipboardImage, 'pult:clipboard-image')
    assert.equal(new Set(Object.values(IPC)).size, Object.values(IPC).length, 'каналы IPC не повторяются')
  })
})
