import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { approvalContext } from '../dist/adapters/approvalContext.js'
import { userTurnLine } from '../dist/adapters/claude/argv.js'

describe('контекст режима для модели', () => {
  it('Codex workspace объясняет never, наследование песочницы и ложный вывод об авторизации', () => {
    const text = approvalContext('codex', 'workspace', true)
    assert.match(text, /Правки в папке без вопросов/)
    assert.match(text, /approval_policy=never/)
    assert.match(text, /наследуют песочницу/)
    assert.match(text, /Not logged in/)
    assert.match(text, /Спрашивать/)
    assert.doesNotMatch(text, /выбери.*Полный доступ/)
  })

  it('Claude workspace допускает вопросы в Inbox, а full не обещает доступ к сети', () => {
    assert.match(approvalContext('claude', 'workspace', true), /acceptEdits/)
    assert.match(approvalContext('claude', 'workspace', true), /Inbox/)
    assert.doesNotMatch(approvalContext('claude', 'workspace', true), /approval_policy=never/)
    assert.match(approvalContext('codex', 'full', true), /danger-full-access/)
    assert.match(approvalContext('claude', 'full', true), /bypassPermissions/)
    assert.match(approvalContext('codex', 'full', true), /не гарантирует/)
  })

  it('все режимы, умолчание и отсутствие брокера различаются', () => {
    for (const provider of ['claude', 'codex'] as const) {
      assert.match(approvalContext(provider, 'read-only', true), /Только чтение/)
      assert.match(approvalContext(provider, undefined, true), /Спрашивать/)
      assert.equal(approvalContext(provider, undefined, true), approvalContext(provider, 'ask', true))
      assert.match(approvalContext(provider, 'ask', false), /брокер разрешений недоступен/)
    }
  })

  it('Claude получает пояснение отдельным блоком, сохраняя исходную реплику и uuid', () => {
    const context = approvalContext('claude', 'workspace', true)
    const msg = JSON.parse(userTurnLine('исходный запрос', 'uuid', context))
    assert.equal(msg.uuid, 'uuid')
    assert.deepEqual(msg.message.content, [{ type: 'text', text: 'исходный запрос' }, { type: 'text', text: context }])
    assert.equal(JSON.parse(userTurnLine('старый вызов')).message.content.length, 1)
  })
})
