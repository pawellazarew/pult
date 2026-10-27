import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, it } from 'node:test'
import { localFile } from '../../src/localFile.js'

const root = mkdtempSync(path.join(tmpdir(), 'pult-file-'))
after(() => rmSync(root, { recursive: true, force: true }))

it('локальный PDF с пробелами и кириллицей открывается; код и программы только показываются в Finder', () => {
  for (const [name, action] of [['Резюме — Engineer.PDF', 'open'], ['notes.md', 'open'], ['run.command', 'reveal'], ['tool.sh', 'reveal'], ['index.html', 'reveal'], ['script.ts', 'reveal']] as const) {
    const file = path.join(root, name)
    writeFileSync(file, '')
    assert.deepEqual(localFile(file), { path: realpathSync(file), action })
  }
  const shortcut = path.join(root, 'looks-like.pdf')
  symlinkSync(path.join(root, 'run.command'), shortcut)
  assert.equal(localFile(shortcut).action, 'reveal')
})

it('отсутствующие файлы, папки, приложения, URI и управляющие символы отвергаются', () => {
  const app = path.join(root, 'Tool.app')
  mkdirSync(app)
  for (const value of [path.join(root, 'missing.pdf'), root, app, 'file:///tmp/a.pdf', 'https://example.com/a.pdf', '//host/a.pdf', 'a.pdf', '/tmp/a\0.pdf', '/tmp/a\n.pdf', null, 42]) assert.throws(() => localFile(value))
})
