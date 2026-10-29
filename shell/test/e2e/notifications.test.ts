import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { NotifyTarget } from '../../src/contract.js'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Globals = {
  __pultTestNotifications?: Array<{ id: string; target: NotifyTarget }>
  __pultTestNotificationClick?: (id: string) => boolean
}

describe('переход из системного уведомления', () => {
  let h: Harness
  let c: Awaited<ReturnType<Harness['client']>>
  before(async () => {
    h = await launch({ name: 'notifications' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    c = await h.client()
    for (const name of ['alpha', 'beta']) {
      await c.request('agent.start', { name, kind: 'claude', cwd: h.workDir(name, { scenario: name === 'beta' ? 'demo-edit' : 'simple' }) })
    }
    await h.win.locator('[data-testid="agent-row"][data-agent="alpha"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor()
  })
  after(async () => { await h?.close() })

  const notify = async (target: NotifyTarget): Promise<string> => {
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
    await h.win.evaluate(async (t) => { await window.pult!.notify('Тестовое уведомление', 'Чат ждёт тебя', t) }, target)
    const id = await h.app.evaluate(() => (globalThis as Globals).__pultTestNotifications?.at(-1)?.id)
    assert.ok(id, 'уведомление не создано')
    return id
  }
  const click = async (id: string): Promise<void> => {
    assert.equal(await h.app.evaluate((_e, key) => (globalThis as Globals).__pultTestNotificationClick?.(key) ?? false, id), true)
  }

  it('при открытой alpha клик по уведомлению beta выбирает beta', async () => {
    const id = await notify({ sessionId: 'beta' })
    await click(id)
    await h.win.locator('[data-testid="conversation"][data-agent="beta"]').waitFor({ timeout: 5000 })
    assert.deepEqual(await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())), [true])
  })

  it('уведомление о разрешении открывает чат и выделяет нужный запрос', async () => {
    await h.win.locator('[data-testid="agent-row"][data-agent="alpha"]').click()
    await c.request('agent.prompt', { name: 'beta', text: 'Поправь округление' })
    let permission: { id: string; sessionId: string } | undefined
    assert.ok(await waitFor(async () => {
      permission = ((await c.request('perm.list', {})) as { pending: Array<{ id: string; sessionId: string }> }).pending.find((p) => p.sessionId === 'beta')
      return !!permission
    }, 15_000))
    await click(await notify({ sessionId: 'beta', permId: permission!.id }))
    await h.win.locator('[data-testid="conversation"][data-agent="beta"]').waitFor({ timeout: 5000 })
    await h.win.getByTestId('inbox').locator(`[data-testid="perm-card"][data-perm-id="${permission!.id}"][data-focused="true"]`).waitFor({ timeout: 5000 })
    await c.request('perm.resolve', { id: permission!.id, decision: 'deny' })
    await c.request('agent.wait', { name: 'beta', until: ['idle', 'done'], timeoutMs: 10_000 })
  })

  it('сводное уведомление о нескольких чатах открывает Inbox', async () => {
    if (await h.win.getByTestId('inbox').count()) await h.win.keyboard.press('Meta+i')
    await click(await notify({ inbox: true }))
    await h.win.getByTestId('inbox').waitFor({ timeout: 5000 })
  })

  it('закрытое окно открывается на чате уведомления, а не на прежней alpha', async () => {
    await h.win.locator('[data-testid="agent-row"][data-agent="alpha"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor()
    const id = await notify({ sessionId: 'beta' })
    await h.win.close()
    const next = h.app.waitForEvent('window', { timeout: 15_000 })
    await click(id)
    const win = await next
    await win.locator('[data-testid="conversation"][data-agent="beta"]').waitFor({ timeout: 15_000 })
  })
})
