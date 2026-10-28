import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('ошибки: понятная причина и технические подробности', () => {
  let h: Harness
  let emit: (kind: string, data: Record<string, unknown>) => Promise<unknown>
  before(async () => {
    h = await launch({ name: 'errors' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    h.codexConfig({ scenario: 'hang' })
    const client = await h.client()
    await client.request('agent.start', { name: 'errors', kind: 'codex', cwd: h.workDir('project') })
    emit = (kind, data) => client.request('events.emit', { sessionId: 'errors', provider: 'codex', kind, data })
    await h.win.locator('[data-testid="agent-row"][data-agent="errors"]').click()
    await h.win.getByTestId('composer').waitFor()
  })
  after(async () => { await h?.close() })

  it('код 1 объясняется словами, исходное сообщение можно раскрыть', async () => {
    await emit('message.user', { text: 'Проверь проект' })
    await emit('status.changed', { status: 'failed', message: 'codex: код 1', errorCode: 'internal' })
    const notice = h.win.getByTestId('failure-explanation')
    await notice.waitFor()
    assert.match((await notice.textContent()) ?? '', /Код 1 — общий сигнал/)
    assert.match((await notice.textContent()) ?? '', /Точную причину по этому числу определить нельзя/)
    assert.equal(await notice.locator('details').getAttribute('open'), null)
    assert.equal(await notice.locator('pre').isVisible(), false)
    await notice.locator('summary').click()
    assert.equal(await notice.locator('pre').innerText(), 'codex: код 1')
    await notice.locator('summary').click()
    for (const scheme of ['light', 'dark'] as const) { await h.scheme(scheme); await h.screen(`errors-${scheme}`) }
  })

  it('пустой поиск не объявляется падением агента, вход в аккаунт поясняется конкретно', async () => {
    await emit('tool.called', { toolUseId: 'search', name: 'Bash', input: { command: 'rg missing src' } })
    await emit('tool.finished', { toolUseId: 'search', exitCode: 1, isError: true, content: '' })
    const tool = h.win.getByTestId('tool-error-preview')
    await tool.waitFor()
    assert.match((await tool.textContent()) ?? '', /Поиск ничего не нашёл/)
    assert.match((await tool.textContent()) ?? '', /Это не означает, что агент сломался/)
    await emit('status.changed', { status: 'working' })
    // Дополнительное событие не даёт reducer принять новую ошибку за дубликат предыдущей.
    await emit('message.user', { text: 'Попробуй ещё раз' })
    for (let i = 0; i < 4; i++) await emit('message.delta', { text: '', index: i })
    await emit('status.changed', { status: 'failed', message: 'Not logged in. Please run /login' })
    assert.ok(await waitFor(async () => (await h.win.getByTestId('notice').allTextContents()).some((text) => text.includes('Нужно проверить вход в аккаунт'))))
  })
})
