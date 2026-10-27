import assert from 'node:assert/strict'
import { it } from 'node:test'
import { referencesFile } from '../dist/core/fileReferences.js'

it('внешний файл доступен для просмотра только по точной ссылке из реплики беседы', () => {
  const path = '/tmp/Документ с пробелами.pdf'
  const event = { kind: 'message.done', data: { text: `Готово: :codex-file-citation{purpose="output" path=${JSON.stringify(path)}}` } }
  assert.equal(referencesFile([event], path), true)
  assert.equal(referencesFile([event], '/tmp/other.pdf'), false)
  assert.equal(referencesFile([{ ...event, kind: 'tool.finished' }], path), false)
  assert.equal(referencesFile([{ kind: 'message.user', data: { text: `[Файл](<${path}>)` } }], path), true)
  assert.equal(referencesFile([{ kind: 'message.done', data: { text: 'Произвольный путь /tmp/a.pdf без ссылки' } }], '/tmp/a.pdf'), false)
  assert.equal(referencesFile([], '/tmp/a.pdf'), false)
})
