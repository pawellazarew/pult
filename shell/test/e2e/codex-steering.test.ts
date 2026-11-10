import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor, RESULTS } from './harness.js'
import type { Harness } from './harness.js'

describe('Codex: async question forms and steering', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'codex-steering' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000), 'окно ещё не подключилось к демону')
    h.codexConfig({ scenario: 'hang', asyncQuestions: [{ title: 'What makes questions difficult?', options: ['No form', 'Delivery'] }, { title: 'Any details?', options: null }] })
    const c = await h.client()
    await c.request('agent.start', { name: 'steer-ui', kind: 'codex', cwd: h.workDir('steer-ui') })
    await c.request('agent.prompt', { name: 'steer-ui', text: 'initial task' })
    await h.win.locator('[data-testid="agent-row"][data-agent="steer-ui"]').click()
    await h.win.getByTestId('composer').waitFor()
  })
  after(async () => { await h?.close() })
  const events = async () => ((await (await h.client()).request('events.tail', { since: 0, sessionId: 'steer-ui' })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
  const record = async () => ((await (await h.client()).request('agent.list')) as { sessions: Array<{ name: string; lastStatus: string; queue?: unknown[] }> }).sessions.find(s => s.name === 'steer-ui')!

  it('the screenshot question is a real form; replying steers without stopping and survives reload', async () => {
    const form = h.win.getByTestId('async-question')
    await form.getByRole('textbox', { name: 'What makes questions difficult?: свой ответ', exact: true }).fill('old custom text')
    await form.getByLabel('No form', { exact: false }).check()
    assert.equal(await form.getByRole('textbox', { name: 'What makes questions difficult?: свой ответ', exact: true }).inputValue(), '')
    await form.getByRole('textbox', { name: 'Any details?', exact: true }).fill('Keep my draft')
    await h.win.screenshot({ path: join(RESULTS, 'codex-questions-preview.png') })
    await form.getByTestId('question-send').click()
    await form.getByText('Ответ отправлен', { exact: true }).waitFor()
    assert.equal((await record()).lastStatus, 'working')
    assert.equal((await record()).queue?.length ?? 0, 0)
    const reply = (await events()).filter(e => e.kind === 'message.user').at(-1)!
    assert.equal(reply.data['steering'], true)
    assert.match(String(reply.data['text']), /No form/)
    assert.match(String(reply.data['text']), /Keep my draft/)
    assert.equal(typeof reply.data['questionId'], 'number')
    await h.win.reload()
    await h.win.getByTestId('async-question').getByText('Ответ отправлен', { exact: true }).waitFor()
    assert.equal(await h.win.getByTestId('async-question').getByTestId('question-send').count(), 0)
  })

  it('steer button and Alt+Enter leave the turn running; rejected text is restored', async () => {
    const box = h.win.getByTestId('composer')
    await box.fill('check tests first')
    await h.win.getByTestId('steer').click()
    assert.ok(await waitFor(async () => (await events()).some(e => e.kind === 'message.user' && e.data['text'] === 'check tests first')))
    await box.fill('then review docs')
    await box.press('Alt+Enter')
    assert.ok(await waitFor(async () => (await events()).some(e => e.kind === 'message.user' && e.data['text'] === 'then review docs')))
    assert.equal((await record()).lastStatus, 'working')
    assert.equal((await record()).queue?.length ?? 0, 0)
    await box.fill('reject this steering')
    await h.win.getByTestId('steer').click()
    await h.win.getByTestId('send-error').waitFor()
    assert.ok(await waitFor(async () => await box.inputValue() === 'reject this steering'))
    assert.equal((await events()).some(e => e.kind === 'message.user' && e.data['text'] === 'reject this steering'), false)
    assert.equal((await record()).lastStatus, 'working')
    await box.fill('later task')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await record()).queue?.length === 1))
  })
})
