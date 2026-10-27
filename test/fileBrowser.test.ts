import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { listWorkspaceFiles, MAX_FILE_ENTRIES, MAX_TEXT_PREVIEW_BYTES, MAX_BINARY_PREVIEW_BYTES, readWorkspaceFile } from '../dist/core/fileBrowser.js'
import type { FileScope } from '../dist/core/fileBrowserTypes.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64')
async function fixture(run: (scope: FileScope & { userHome: string }, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'pult-files-'))
  const scope = { cwd: path.join(root, 'project'), userHome: path.join(root, 'user') }
  mkdirSync(scope.cwd); mkdirSync(scope.userHome)
  try { await run(scope, root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('просмотр файлов проекта', () => {
  it('папки первыми, имена в числовом порядке, пути относительны, скрытые файлы включаются явно', async () => fixture(async (scope) => {
    for (const name of ['100.txt', '9.txt', '99.txt', '.hidden']) writeFileSync(path.join(scope.cwd, name), name)
    for (const name of ['dir10', 'dir2']) mkdirSync(path.join(scope.cwd, name))
    writeFileSync(path.join(scope.cwd, 'dir2', 'file.txt'), 'текст')
    const listing = await listWorkspaceFiles(scope)
    assert.deepEqual(listing.entries.map((e) => e.name), ['dir2', 'dir10', '9.txt', '99.txt', '100.txt'])
    assert.equal(listing.root, realpathSync(scope.cwd))
    assert.equal(listing.path, '')
    assert.equal(listing.truncated, false)
    assert.deepEqual((await listWorkspaceFiles(scope, '')).entries, listing.entries)
    assert.ok(listing.entries.every((e) => !path.isAbsolute(e.path) && !Number.isNaN(Date.parse(e.modifiedAt))))
    assert.equal(listing.entries.find((e) => e.name === '9.txt')?.size, 5)
    const nested = await listWorkspaceFiles(scope, 'dir2')
    assert.equal(nested.path, 'dir2')
    assert.equal(nested.entries[0]?.path, path.join('dir2', 'file.txt'))
    assert.ok((await listWorkspaceFiles(scope, '.', true)).entries.some((e) => e.name === '.hidden'))
  }))

  it('текст и Markdown сохраняют UTF-8, пустой файл допустим, HTML остаётся текстом', async () => fixture(async (scope) => {
    for (const [name, text, kind] of [['README.md', '# Привет\nМир', 'markdown'], ['code.ts', 'const x = "ёж"\n', 'text'], ['page.html', '<script>evil()</script>', 'text'], ['empty.txt', '', 'text'], ['LICENSE', 'MIT', 'text']] as const) {
      writeFileSync(path.join(scope.cwd, name), text)
      const preview = await readWorkspaceFile(scope, name)
      assert.equal(preview.kind, kind)
      assert.equal(preview.text, text)
      assert.equal(preview.size, Buffer.byteLength(text))
      assert.equal(preview.path, realpathSync(path.join(scope.cwd, name)))
      assert.equal(preview.base64, undefined)
    }
  }))

  it('растровые изображения и PDF проверяются по содержимому, неверный формат не отдаёт байты', async () => fixture(async (scope) => {
    writeFileSync(path.join(scope.cwd, 'image.png'), png)
    writeFileSync(path.join(scope.cwd, 'report.pdf'), '%PDF-1.7\n%%EOF\n')
    const image = await readWorkspaceFile(scope, 'image.png')
    assert.equal(image.kind, 'image')
    assert.equal(image.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
    const pdf = await readWorkspaceFile(scope, 'report.pdf')
    assert.equal(pdf.kind, 'pdf')
    assert.equal(Buffer.from(pdf.base64!, 'base64').subarray(0, 5).toString(), '%PDF-')
    for (const name of ['fake.png', 'fake.pdf']) {
      writeFileSync(path.join(scope.cwd, name), '<script>evil()</script>')
      const bad = await readWorkspaceFile(scope, name)
      assert.equal(bad.kind, 'unsupported')
      assert.equal(bad.dataUrl, undefined)
      assert.equal(bad.base64, undefined)
      assert.ok(bad.reason)
    }
  }))

  it('неизвестный, исполняемый, бинарный и не-UTF8 файл не передают содержимое', async () => fixture(async (scope) => {
    const fixtures: Array<[string, Buffer]> = [['data.bin', Buffer.from('looks like text')], ['zero.txt', Buffer.from([65, 0, 66])], ['encoding.txt', Buffer.from([0xff, 0xfe])], ['control.txt', Buffer.from([65, 1, 66])], ['run.sh', Buffer.from('#!/bin/sh\n')]]
    for (const [name, bytes] of fixtures) {
      const file = path.join(scope.cwd, name)
      writeFileSync(file, bytes)
      if (name === 'run.sh') chmodSync(file, 0o755)
      const preview = await readWorkspaceFile(scope, name)
      assert.equal(preview.kind, 'unsupported', name)
      assert.equal(preview.text, undefined, name)
      assert.equal(preview.base64, undefined, name)
      assert.ok(preview.reason, name)
    }
  }))

  it('лимиты текста и PDF проверяются до чтения и сообщаются вместо полной нагрузки', async () => fixture(async (scope) => {
    writeFileSync(path.join(scope.cwd, 'large.txt'), Buffer.alloc(MAX_TEXT_PREVIEW_BYTES + 1, 65))
    writeFileSync(path.join(scope.cwd, 'large.pdf'), Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_BINARY_PREVIEW_BYTES)]))
    for (const name of ['large.txt', 'large.pdf']) {
      const preview = await readWorkspaceFile(scope, name)
      assert.equal(preview.kind, 'unsupported')
      assert.match(preview.reason!, /слишком большой/)
      assert.equal(preview.text, undefined)
      assert.equal(preview.base64, undefined)
    }
    writeFileSync(path.join(scope.cwd, 'exact.txt'), Buffer.alloc(MAX_TEXT_PREVIEW_BYTES, 65))
    assert.equal((await readWorkspaceFile(scope, 'exact.txt')).text?.length, MAX_TEXT_PREVIEW_BYTES)
  }))

  it('наружные пути и симлинки не перечисляются и не читаются; внутренний симлинк допустим', async () => fixture(async (scope, root) => {
    const outside = path.join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
    writeFileSync(path.join(scope.cwd, 'local.txt'), 'inside')
    symlinkSync(outside, path.join(scope.cwd, 'escape'))
    symlinkSync(path.join(outside, 'secret.txt'), path.join(scope.cwd, 'escape.txt'))
    symlinkSync(path.join(scope.cwd, 'local.txt'), path.join(scope.cwd, 'alias.txt'))
    assert.deepEqual((await listWorkspaceFiles(scope)).entries.map((e) => e.name), ['alias.txt', 'local.txt'])
    assert.equal((await readWorkspaceFile(scope, 'alias.txt')).text, 'inside')
    for (const name of ['../outside/secret.txt', 'escape.txt', 'escape/secret.txt', path.join(outside, 'secret.txt')]) await assert.rejects(readWorkspaceFile(scope, name))
    for (const name of ['..', 'escape', outside]) await assert.rejects(listWorkspaceFiles(scope, name))
  }))

  it('вне проекта читается только конкретный разрешённый файл, разрешение не открывает его папку', async () => fixture(async (scope, root) => {
    const output = path.join(root, 'Downloads')
    mkdirSync(output)
    const file = path.join(output, 'Отчёт — final.pdf')
    writeFileSync(file, '%PDF-1.4\n')
    writeFileSync(path.join(output, 'neighbor.txt'), 'not cited')
    const allowed = { ...scope, allowedFiles: [file] }
    assert.equal((await readWorkspaceFile(allowed, file)).kind, 'pdf')
    await assert.rejects(readWorkspaceFile(allowed, path.join(output, 'neighbor.txt')))
    await assert.rejects(listWorkspaceFiles(allowed, output))
    await assert.rejects(readWorkspaceFile(scope, file))
  }))

  it('каталоги учётных данных защищены даже от разрешённой ссылки и симлинка внутри проекта', async () => fixture(async (scope) => {
    for (const dir of ['.ssh', '.aws', '.gnupg', '.config', '.pult', '.codex', '.claude']) {
      const secret = path.join(scope.userHome, dir, 'secret.txt')
      mkdirSync(path.dirname(secret), { recursive: true }); writeFileSync(secret, 'secret')
      const alias = path.join(scope.cwd, `${dir.slice(1)}-alias.txt`)
      symlinkSync(secret, alias)
      const allowed = { ...scope, allowedFiles: [secret, alias] }
      await assert.rejects(readWorkspaceFile(allowed, secret))
      await assert.rejects(readWorkspaceFile(allowed, alias))
    }
    assert.equal((await listWorkspaceFiles(scope)).entries.length, 0)
  }))

  it('домашняя папка, её предки, корень и недопустимые адреса не становятся workspace', async () => fixture(async (scope, root) => {
    for (const cwd of [scope.userHome, root, path.parse(root).root]) await assert.rejects(listWorkspaceFiles({ ...scope, cwd }))
    for (const source of ['file:///etc/passwd', 'https://example.com/a', '//host/share', 'bad\0name', 'bad\nname']) {
      await assert.rejects(listWorkspaceFiles(scope, source))
      await assert.rejects(readWorkspaceFile(scope, source))
    }
    await assert.rejects(readWorkspaceFile(scope, 'missing.txt'))
    await assert.rejects(readWorkspaceFile(scope, '.'))
  }))

  it('длинный список ограничен и честно отмечен, без раскрытия всего каталога', async () => fixture(async (scope) => {
    for (let i = 0; i < MAX_FILE_ENTRIES + 3; i++) writeFileSync(path.join(scope.cwd, `${i}.txt`), '')
    const list = await listWorkspaceFiles(scope)
    assert.equal(list.entries.length, MAX_FILE_ENTRIES)
    assert.equal(list.truncated, true)
    assert.deepEqual(list.entries.map((e) => e.name), [...list.entries.map((e) => e.name)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
  }))
})
