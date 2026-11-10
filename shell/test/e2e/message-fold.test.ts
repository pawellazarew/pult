import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('long messages in the conversation', () => {
  let h: Harness
  let userId: number
  let modelId: number
  const userText = 'Начало реплики. ' + 'Подробности задачи. '.repeat(40) + '\n\nХВОСТ_РЕПЛИКИ'
  const modelText = 'Начало ответа. ' + 'Подробности решения. '.repeat(40) + '\n\nХВОСТ_ОТВЕТА'
  before(async () => {
    h = await launch({ name: 'message-fold' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const client = await h.client()
    await client.request('agent.start', { name: 'fold-chat', kind: 'claude', cwd: h.workDir('fold-chat') })
    const user = await client.request('events.emit', { kind: 'message.user', sessionId: 'fold-chat', provider: 'claude', data: { text: userText } }) as { ids: number[] }
    userId = user.ids[0]!
    const model = await client.request('events.emit', { kind: 'message.done', sessionId: 'fold-chat', provider: 'claude', data: { text: modelText } }) as { ids: number[] }
    modelId = model.ids[0]!
    await h.win.locator('[data-testid="agent-row"][data-agent="fold-chat"]').click()
    await h.win.getByTestId('conversation').waitFor()
  })
  after(async () => { await h?.close() })

  it('expands and collapses both authors while copying the original complete text', async () => {
    for (const [id, text, tail] of [[userId, userText, 'ХВОСТ_РЕПЛИКИ'], [modelId, modelText, 'ХВОСТ_ОТВЕТА']] as const) {
      const message = h.win.locator(`.it[data-event-id="${id}"]`)
      const toggle = message.getByTestId('message-fold')
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.doesNotMatch(await message.innerText(), new RegExp(tail))
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      assert.match(await message.innerText(), new RegExp(tail))
      await message.getByTestId('msg-copy').click()
      const copied = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard)
      assert.equal(copied, text)
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.doesNotMatch(await message.innerText(), new RegExp(tail))
    }
    await h.shot('collapsed-messages')
  })

  it('preserves a streaming answer expansion and reveals a hidden search result', async () => {
    const client = await h.client()
    await client.request('events.emit', { kind: 'message.user', sessionId: 'fold-chat', provider: 'claude', data: { text: 'Продолжи ответ' } })
    const next = await client.request('events.emit', { kind: 'message.delta', sessionId: 'fold-chat', provider: 'claude', data: { text: modelText } }) as { ids: number[] }
    const message = h.win.locator(`.it[data-event-id="${next.ids[0]}"]`)
    await message.getByTestId('message-fold').click()
    await client.request('events.emit', { kind: 'message.delta', sessionId: 'fold-chat', provider: 'claude', data: { text: '\nНОВАЯ_ДЕЛЬТА' } })
    assert.ok(await waitFor(async () => (await message.innerText()).includes('НОВАЯ_ДЕЛЬТА')))
    assert.equal(await message.getByTestId('message-fold').getAttribute('aria-expanded'), 'true')
    await client.request('events.emit', { kind: 'message.done', sessionId: 'fold-chat', provider: 'claude', data: { text: modelText + '\nНОВАЯ_ДЕЛЬТА' } })
    await message.getByTestId('message-fold').click()
    await h.win.keyboard.press('Meta+Shift+KeyF')
    const search = h.win.getByTestId('search-dialog')
    await search.getByTestId('search-input').fill('ХВОСТ_РЕПЛИКИ')
    await search.getByTestId('search-hit').first().waitFor()
    await h.win.keyboard.press('Enter')
    await search.waitFor({ state: 'detached' })
    const user = h.win.locator(`.it[data-event-id="${userId}"]`)
    assert.ok(await waitFor(async () => await user.getByTestId('message-fold').getAttribute('aria-expanded') === 'true'))
    assert.match(await user.innerText(), /ХВОСТ_РЕПЛИКИ/)
  })

  it('only enables fenced-code copying after expansion and copies the full code', async () => {
    const code = Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join('\n')
    const client = await h.client()
    await client.request('events.emit', { kind: 'message.user', sessionId: 'fold-chat', provider: 'claude', data: { text: 'Покажи код' } })
    const result = await client.request('events.emit', { kind: 'message.done', sessionId: 'fold-chat', provider: 'claude', data: { text: '```ts\n' + code + '\n```' } }) as { ids: number[] }
    const message = h.win.locator(`.it[data-event-id="${result.ids[0]}"]`)
    const toggle = message.getByTestId('message-fold')
    await toggle.waitFor()
    assert.equal(await message.getByTestId('md-copy').count(), 0)
    await toggle.click()
    await message.getByTestId('md-copy').click()
    const copied = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard)
    assert.equal(copied, code)
    await toggle.click()
    assert.equal(await message.getByTestId('md-copy').count(), 0)
  })
})
