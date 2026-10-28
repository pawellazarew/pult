// e2e О2 «внимание»: значок на доке считает непрочитанные ошибки, Inbox показывает карточку ошибки с
// причиной, «Повторить» шлёт последнюю реплику заново и гасит значок. Значок дока тест читает из
// модели меню (`__pultTestTray.badge`) — её же main кладёт в `app.dock.setBadge`.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { TrayModel } from '../../src/tray.js'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>

describe('внимание: значок на доке и ошибки в Inbox', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'attention' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  const badge = async (): Promise<string | null> =>
    h.app.evaluate(() => ((globalThis as { __pultTestTray?: TrayModel }).__pultTestTray?.badge ?? null))
  const users = async (name: string): Promise<unknown[]> =>
    ((await c.request('agent.read', { name, format: 'json' })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
      .filter((e) => e.kind === 'message.user').map((e) => e.data['text'])

  it('готовый ход значок не зажигает; упавший — зажигает и встаёт карточкой в Inbox; «Повторить» гасит', async () => {
    await c.request('agent.start', { name: 'omega', kind: 'claude', cwd: h.workDir('omega', { scenario: 'simple' }) })
    await c.request('agent.prompt', { name: 'omega', text: 'Сделай раз' })
    await c.request('agent.wait', { name: 'omega', until: ['idle'], timeoutMs: 20_000 })
    // Непрочитанное «готово» — точка у строки, но не значок на доке.
    await h.win.locator('[data-testid="agent-row"][data-agent="omega"] [data-testid="row-unread"]').waitFor({ timeout: 10_000 })
    assert.equal(await badge(), '')

    // Ошибка именно этого хода (номер — из журнала): «Повторить» отправит его реплику.
    const turnId = ((await c.request('agent.read', { name: 'omega', format: 'json' })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
      .filter((e) => e.kind === 'status.changed' && e.data['status'] === 'working').at(-1)?.data['turnId']
    await c.request('events.emit', { kind: 'status.changed', sessionId: 'omega', provider: 'claude', data: { status: 'failed', turnId, message: 'процесс упал: код 1' } })
    assert.ok(await waitFor(async () => (await badge()) === '1', 10_000), `значок: ${JSON.stringify(await badge())}`)
    if (!(await h.win.getByTestId('inbox').count())) await h.win.getByTestId('toggle-inbox').click()
    const card = h.win.getByTestId('inbox').locator('[data-testid="inbox-error"][data-agent="omega"]')
    await card.waitFor({ timeout: 10_000 })
    assert.match((await card.getByTestId('inbox-error-text').textContent()) ?? '', /процесс упал/)
    assert.match((await card.getByTestId('inbox-error-text').textContent()) ?? '', /Код 1 — общий сигнал/)
    assert.equal(await card.locator('.error-details pre').isVisible(), false)
    await card.locator('.error-details summary').click()
    assert.equal(await card.locator('.error-details pre').innerText(), 'процесс упал: код 1')
    await card.locator('.error-details summary').click()
    assert.equal((await h.win.getByTestId('inbox-count').textContent()) ?? '', '1', 'в шапке — ошибка')

    // Фильтр «Непрочитанные» показывает ту же сессию; «Ошибки» — только её.
    await h.win.getByTestId('inbox-filter-errors').click()
    assert.equal(await h.win.getByTestId('inbox').locator('[data-testid="inbox-error"]').count(), 1)
    await h.win.getByTestId('inbox-filter-all').click()

    await card.getByTestId('inbox-retry').click()
    assert.ok(await waitFor(async () => (await badge()) === '', 10_000), 'значок не погас после «Повторить»')
    await card.waitFor({ state: 'detached', timeout: 10_000 })
    await c.request('agent.wait', { name: 'omega', until: ['idle'], timeoutMs: 20_000 })
    assert.deepEqual(await users('omega'), ['Сделай раз', 'Сделай раз'])
  })
})
