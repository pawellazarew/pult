import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, ONE_PX_PNG, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('мост вложений: File и системный буфер вместо произвольного пути страницы', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'attachment-bridge' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
  })
  after(async () => { await h?.close() })

  it('native File копируется в хранилище, публичная path-строка и поддельный File отвергаются', async () => {
    const folder = path.join(h.home, 'input')
    mkdirSync(folder)
    const original = path.join(folder, 'temporary.txt')
    writeFileSync(original, 'temporary contents')
    const forbidden = await h.win.evaluate(async (source) => await window.pult!.attachments!.import('chat', { path: source }), original)
    assert.ok('error' in forbidden, JSON.stringify(forbidden))
    const fake = await h.win.evaluate(async (source) => await window.pult!.attachments!.files('chat', [{ name: 'fake.txt', path: source } as unknown as File]), original)
    assert.ok('error' in fake[0]!, JSON.stringify(fake))
    await h.win.evaluate(() => { const el = document.createElement('input'); el.type = 'file'; el.id = 'attachment-test-file'; document.body.append(el) })
    await h.win.locator('#attachment-test-file').setInputFiles(original)
    const results = await h.win.evaluate(async () => {
      const input = document.getElementById('attachment-test-file') as HTMLInputElement
      return await window.pult!.attachments!.files('chat', Array.from(input.files ?? []))
    })
    const r = results[0]!
    assert.ok(!('error' in r), JSON.stringify(results))
    assert.equal(r.name, 'temporary.txt')
    assert.ok(r.path.startsWith(path.join(h.home, 'attachments', 'chat') + path.sep))
    unlinkSync(original)
    assert.equal(readFileSync(r.path, 'utf8'), 'temporary contents')
    const rehome = await h.win.evaluate(async (saved) => await window.pult!.attachments!.import('final', { path: saved.path, name: saved.name }), r)
    assert.ok(!('error' in rehome), JSON.stringify(rehome))
    assert.ok(rehome.path.startsWith(path.join(h.home, 'attachments', 'final') + path.sep))
  })

  it('File без дискового пути сохраняется, raster-превью своё; clipboard источники читает main', async () => {
    const result = await h.win.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      return await window.pult!.attachments!.files('chat', [new File([bytes], 'virtual screenshot.png', { type: 'image/png' })])
    }, ONE_PX_PNG)
    const r = result[0]!
    assert.ok(!('error' in r), JSON.stringify(result))
    assert.equal(r.name, 'virtual screenshot.png')
    assert.deepEqual(readFileSync(r.path), Buffer.from(ONE_PX_PNG, 'base64'))
    const preview = await h.win.evaluate(async (source) => await window.pult!.attachments!.preview('chat', source), r.path)
    assert.ok('dataUrl' in preview, JSON.stringify(preview))
    assert.match(preview.dataUrl, /^data:image\/png;base64,/)
    const forbidden = await h.win.evaluate(async (source) => await window.pult!.attachments!.preview('other', source), r.path)
    assert.ok('error' in forbidden)
    const source = path.join(h.home, 'clipboard-file.md')
    writeFileSync(source, '# clipboard')
    await h.app.evaluate((_electron, source) => { (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths = [source] }, source)
    const copied = await h.win.evaluate(async () => await window.pult!.attachments!.clipboard('chat'))
    const c = copied[0]!
    assert.ok(!('error' in c), JSON.stringify(copied))
    unlinkSync(source)
    assert.equal(readFileSync(c.path, 'utf8'), '# clipboard')
    await h.app.evaluate(() => { (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths = [] })
  })
})
