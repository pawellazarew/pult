import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setLanguage } from '../dist/i18n/core.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../dist/core/fileBrowser.js'
import { formatTree } from '../dist/sessions/tree.js'

test('file previews translate application reasons and preserve filenames and contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pult-i18n-files-'))
  const scope = { cwd: path.join(root, 'project'), userHome: path.join(root, 'user') }
  await mkdir(scope.cwd); await mkdir(scope.userHome)
  setLanguage('en')
  try {
    await writeFile(path.join(scope.cwd, 'ошибка.txt'), 'Файл недоступен в этом проекте')
    await writeFile(path.join(scope.cwd, 'данные.bin'), 'user text')
    assert.equal((await readWorkspaceFile(scope, 'ошибка.txt')).text, 'Файл недоступен в этом проекте')
    const bad = await readWorkspaceFile(scope, 'данные.bin')
    assert.equal(bad.name, 'данные.bin')
    assert.equal(bad.reason, 'Preview is not available for this file format')
    await assert.rejects(() => listWorkspaceFiles(scope, '../'), /File is not accessible in this project/)
    setLanguage('ru')
    assert.equal((await readWorkspaceFile(scope, 'данные.bin')).reason, 'Предпросмотр этого формата пока недоступен')
  } finally { setLanguage('ru'); await rm(root, { recursive: true, force: true }) }
})

test('agent tree localizes duration only; names remain intact', () => {
  setLanguage('en')
  try {
    const tree = { roots: [{ id: '1', kind: 'tool' as const, name: 'Команда', status: 'done' as const, startedAt: '', durationMs: 50, children: [] }], byId: new Map(), orphans: 0 }
    assert.equal(formatTree(tree), '✓ Команда · 50 ms')
    setLanguage('ru')
    assert.equal(formatTree(tree), '✓ Команда · 50 мс')
  } finally { setLanguage('ru') }
})
