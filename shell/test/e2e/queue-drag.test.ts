import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { Locator } from 'playwright-core'

describe('queue: drag handles and sending a selected message now', () => {
  let h: Harness
  let first: string
  let second: string
  let rejected: string
  let originalTurn: string
  before(async () => {
    h = await launch({ name: 'queue-drag' })
    h.codexConfig({ scenario: 'hang' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000), 'daemon must be connected before making RPC requests')
    const c = await h.client()
    await c.request('agent.start', { name: 'queue-ui', kind: 'codex', cwd: h.workDir('queue-ui') })
    originalTurn = (await c.request('agent.prompt', { name: 'queue-ui', text: 'original task' }) as { turnId: string }).turnId
    const add = async (text: string): Promise<string> => (await c.request('agent.prompt', { name: 'queue-ui', text, queue: true }) as { id: string }).id
    first = await add('first later')
    second = await add('second now')
    rejected = await add('reject this steering')
    await h.win.locator('[data-testid="agent-row"][data-agent="queue-ui"]').click()
    await h.win.getByTestId('queue-item').nth(2).waitFor()
  })
  after(async () => { await h?.close() })
  const record = async () => ((await (await h.client()).request('agent.list')) as {
    sessions: Array<{ name: string; lastStatus: string; queuePaused?: boolean; queue?: Array<{ id: string; text: string }> }>
  }).sessions.find(s => s.name === 'queue-ui')!
  const ids = async () => (await record()).queue?.map(it => it.id) ?? []
  const waitOrder = async (expected: string[]): Promise<boolean> => await waitFor(async () => {
    const shown = await h.win.getByTestId('queue-item').evaluateAll(items => items.map(item => (item as HTMLElement).dataset['id']))
    return JSON.stringify(await ids()) === JSON.stringify(expected) && JSON.stringify(shown) === JSON.stringify(expected)
  })
  const row = (id: string): Locator => h.win.locator(`[data-testid="queue-item"][data-id="${id}"]`)
  const journal = async () => ((await (await h.client()).request('events.tail', { since: 0, sessionId: 'queue-ui' })) as {
    events: Array<{ kind: string; data: Record<string, unknown> }>
  }).events
  const dragTo = async (source: string, target: string): Promise<void> => {
    const handle = await row(source).getByTestId('queue-drag').boundingBox()
    const destination = await row(target).boundingBox()
    assert.ok(handle && destination)
    await h.win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await h.win.mouse.down()
    await h.win.mouse.move(destination.x + destination.width / 2, destination.y + 2, { steps: 12 })
  }

  it('three-line handle drags middle to first; focused handle moves it down with the keyboard', async () => {
    await dragTo(second, first)
    await h.win.locator(`[data-id="${first}"][data-drop="before"]`).waitFor()
    await h.win.mouse.up()
    assert.ok(await waitOrder([second, first, rejected]))
    await row(second).getByTestId('queue-drag').press('ArrowDown')
    assert.ok(await waitOrder([first, second, rejected]))
    await row(second).getByTestId('queue-drag').press('ArrowDown')
    assert.ok(await waitOrder([first, rejected, second]))
    assert.equal(await row(first).getAttribute('draggable'), null, 'message text itself must remain selectable')
    await h.screen('queue-drag')
  })

  it('sends a chosen last item into the active turn once and preserves the rest in order', async () => {
    await row(second).getByTestId('queue-send').click()
    assert.ok(await waitOrder([first, rejected]))
    assert.equal((await record()).lastStatus, 'working')
    const messages = (await journal()).filter(e => e.kind === 'message.user' && e.data['text'] === 'second now')
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.data['steering'], true)
    assert.equal(messages[0]!.data['turnId'], originalTurn)
    assert.equal((await journal()).some(e => e.kind === 'status.changed' && e.data['status'] === 'interrupted'), false)
  })

  it('rejected immediate send leaves the selected item in place and shows the error', async () => {
    await row(rejected).getByTestId('queue-send').click()
    await h.win.getByTestId('queue-send-error').waitFor()
    assert.ok(await waitFor(async () => (await record()).queuePaused === true))
    await h.win.getByTestId('queue-paused').waitFor()
    assert.deepEqual(await ids(), [first, rejected])
    assert.equal((await record()).lastStatus, 'working')
    assert.equal((await journal()).some(e => e.kind === 'message.user' && e.data['text'] === 'reject this steering'), false)
  })

  it('a target removed by another window cancels dragging; Escape cancels without stopping the turn', async () => {
    const c = await h.client()
    const extra = (await c.request('agent.prompt', { name: 'queue-ui', text: 'another later', queue: true }) as { id: string }).id
    await row(extra).waitFor()
    await dragTo(extra, rejected)
    await c.request('agent.queue.remove', { name: 'queue-ui', id: rejected })
    await row(rejected).waitFor({ state: 'detached' })
    await h.win.mouse.up()
    assert.deepEqual(await ids(), [first, extra])
    await dragTo(extra, first)
    await h.win.keyboard.press('Escape')
    await h.win.mouse.up()
    assert.deepEqual(await ids(), [first, extra])
    assert.equal((await record()).lastStatus, 'working')
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0)
  })
})
