import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createImageCapture, imageMime, MAX_IMAGE_BYTES, readScopedImage } from '../dist/core/images.js'
import { createClaudeMapper } from '../dist/adapters/claude/mapper.js'
import { createCodexMapper } from '../dist/adapters/codex/mapper.js'
import { compactHistory } from '../dist/core/history.js'
import type { PultEvent } from '../dist/core/events.js'
import { stripBlobs } from '../dist/core/blobs.js'

// Настоящий PNG 1×1, не заглушка с расширением.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64')
function fixture(run: (scope: { home: string; cwd: string; userHome: string; sessionId: string }, root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'pult-img-'))
  const scope = { home: path.join(root, 'pult'), cwd: path.join(root, 'project'), userHome: path.join(root, 'user'), sessionId: 'w' }
  mkdirSync(scope.cwd, { recursive: true }); mkdirSync(scope.userHome, { recursive: true })
  try { run(scope, root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('изображения отдельно от журнала', () => {
  it('MCP и Anthropic изображения сохранены один раз; переживают новый capture и читаются только своей сессией', () => fixture((scope) => {
    const capture = createImageCapture(scope)
    const refs = capture.capture([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'image', source: { type: 'base64', data: png.toString('base64') } }])
    assert.equal(refs.length, 1)
    assert.deepEqual(readFileSync(refs[0]!), png)
    assert.deepEqual(createImageCapture(scope).capture({ type: 'image', data: png.toString('base64') }), refs)
    assert.equal(readScopedImage(scope, refs[0]!).mimeType, 'image/png')
    assert.throws(() => readScopedImage({ ...scope, sessionId: 'other' }, refs[0]!))
    assert.throws(() => readScopedImage({ ...scope, cwd: path.dirname(scope.home), sessionId: 'other' }, refs[0]!))
    const alias = path.join(path.dirname(scope.home), 'alias'); symlinkSync(scope.home, alias)
    assert.throws(() => readScopedImage({ ...scope, home: alias, cwd: path.dirname(scope.home), sessionId: 'other' }, refs[0]!))
    mkdirSync(path.join(scope.home, 'run')); const protectedImage = path.join(scope.home, 'run', 'secret.png'); writeFileSync(protectedImage, png)
    assert.throws(() => readScopedImage({ ...scope, home: alias, cwd: path.dirname(scope.home) }, protectedImage))
  }))
  it('локальные и сгенерированные PNG доступны, чужие пути и симлинки наружу отклоняются', () => fixture((scope, root) => {
    const local = path.join(scope.cwd, 'image.png'); writeFileSync(local, png)
    assert.equal(readScopedImage(scope, 'image.png').name, 'image.png')
    const executable = path.join(scope.cwd, 'image.command'); writeFileSync(executable, png)
    assert.throws(() => readScopedImage(scope, executable))
    symlinkSync(executable, path.join(scope.cwd, 'disguised.png'))
    assert.throws(() => readScopedImage(scope, 'disguised.png'))
    const generated = path.join(scope.userHome, '.codex', 'generated_images'); mkdirSync(generated, { recursive: true })
    const generatedFile = path.join(generated, 'image.png'); writeFileSync(generatedFile, png)
    assert.ok(readScopedImage(scope, generatedFile))
    const outside = path.join(root, 'secret.png'); writeFileSync(outside, png)
    symlinkSync(outside, path.join(scope.cwd, 'linked.png'))
    for (const source of [outside, '../secret.png', 'linked.png', 'https://example.com/x.png', 'file:///etc/passwd', 'a\0b']) assert.throws(() => readScopedImage(scope, source))
    assert.throws(() => readScopedImage({ ...scope, sessionId: '../other' }, local))
  }))
  it('вложения читаются из своей сессии и остаются закрыты для чужой даже при широком cwd и alias home', () => fixture((scope, root) => {
    const dir = path.join(scope.home, 'attachments', 'w', '2026-10-28')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'screenshot.png'); writeFileSync(file, png)
    assert.deepEqual(readScopedImage(scope, file).bytes, png)
    assert.equal(readScopedImage(scope, file).path, realpathSync(file))
    const broad = { ...scope, cwd: root }
    assert.ok(readScopedImage(broad, file))
    assert.throws(() => readScopedImage({ ...broad, sessionId: 'foreign' }, file))
    const alias = path.join(root, 'pult-alias'); symlinkSync(scope.home, alias)
    const aliasFile = path.join(alias, 'attachments', 'w', '2026-10-28', 'screenshot.png')
    assert.deepEqual(readScopedImage({ ...scope, home: alias }, aliasFile).bytes, png)
    assert.throws(() => readScopedImage({ ...broad, home: alias, sessionId: 'foreign' }, aliasFile))
  }))
  it('симлинки attachments/root, owner и папки дня не дают читать внешнюю картинку как вложение', () => {
    for (const level of ['root', 'owner', 'day']) fixture((scope, root) => {
      // Внешний target лежит внутри cwd: даже разрешение читать project не должно легализовать
      // attachment-путь, который через симлинк покинул выделенную папку сессии.
      const target = path.join(scope.cwd, 'outside'); mkdirSync(target)
      const file = path.join(target, 'screenshot.png'); writeFileSync(file, png)
      const attachments = path.join(scope.home, 'attachments')
      let source: string
      if (level === 'root') {
        mkdirSync(scope.home, { recursive: true }); symlinkSync(scope.cwd, attachments)
        source = path.join(attachments, 'outside', 'screenshot.png')
      } else if (level === 'owner') {
        mkdirSync(attachments, { recursive: true }); symlinkSync(target, path.join(attachments, 'w'))
        source = path.join(attachments, 'w', 'screenshot.png')
      } else {
        mkdirSync(path.join(attachments, 'w'), { recursive: true }); symlinkSync(target, path.join(attachments, 'w', '2026-10-28'))
        source = path.join(attachments, 'w', '2026-10-28', 'screenshot.png')
      }
      assert.ok(readScopedImage(scope, file), 'сам project image остаётся доступен')
      assert.throws(() => readScopedImage(scope, source), `${level} symlink`)
    })
  })
  it('SVG, текст под расширением PNG, пустые и слишком большие файлы не попадают в renderer или storage', () => fixture((scope) => {
    for (const [name, bytes] of [['fake.png', Buffer.from('<svg onload="evil()"/>')], ['empty.png', Buffer.alloc(0)], ['large.png', Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)])]] as const) {
      writeFileSync(path.join(scope.cwd, name), bytes)
      assert.throws(() => readScopedImage(scope, name))
      assert.deepEqual(createImageCapture(scope).captureFile(name), [])
    }
    assert.equal(imageMime(Buffer.from('arbitrary')), null)
    assert.deepEqual(createImageCapture(scope).capture({ type: 'image', data: '<not base64>' }), [])
  }))
  it('Claude tool_result и Codex MCP сохраняют превью в лёгкой истории, а base64 не выходит в JSONL', () => fixture((scope) => {
    const images = createImageCapture(scope)
    const content = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
    const claude = createClaudeMapper({ sessionId: 'w', images }).push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } }).drafts
    const codex = createCodexMapper({ sessionId: 'w', images }).push('item/completed', { item: { id: 't', type: 'mcpToolCall', server: 'browser', tool: 'screenshot', status: 'completed', result: { content } } }).drafts
    for (const drafts of [claude, codex]) {
      const event = drafts.find((d) => d.kind === 'tool.finished')!
      assert.equal((event.data!['images'] as string[]).length, 1)
      assert.ok(!JSON.stringify(event).includes(png.toString('base64')))
      const lite = compactHistory([{ ...event, id: 1, ts: new Date().toISOString() } as PultEvent])
      assert.deepEqual(lite[0]!.data['images'], event.data!['images'])
    }
  }))
  it('Codex imageGeneration: savedPath и result-base64 -> долговечная картинка; result не записан в журнал', () => fixture((scope) => {
    const file = path.join(scope.cwd, 'image.png'); writeFileSync(file, png)
    const viewed = createCodexMapper({ sessionId: 'w', images: createImageCapture(scope) }).push('item/completed', { item: { type: 'imageView', id: 'view', path: file } })
    assert.equal((viewed.drafts[0]!.data!['images'] as string[]).length, 1)
    for (const data of [{ savedPath: file, result: '' }, { result: png.toString('base64') }]) {
      const result = createCodexMapper({ sessionId: 'w', images: createImageCapture(scope) }).push('item/completed', { item: { type: 'imageGeneration', id: 'img', status: 'completed', ...data } })
      assert.equal((result.drafts[0]!.data!['images'] as string[]).length, 1)
      assert.ok(!JSON.stringify(result).includes(png.toString('base64')))
    }
    assert.ok(!JSON.stringify(stripBlobs({ image_url: `data:image/png;base64,${png.toString('base64')}` })).includes(png.toString('base64')))
  }))
})
