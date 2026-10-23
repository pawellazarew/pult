// e2e 0.3.5: строка фазы хода под репликой. Фальшивый claude (`demo-working`) молчит 2,5 с после `system/init`
// («думает…», секунды идут), потом зовёт инструменты, каждый «работает» 1,5 с («выполняет: Read …»), потом отвечает —
// строка уходит. Окно — 0.1.15-совместимое: живой канал идёт той же подпиской `events.subscribe` с курсором от базы.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>

describe('окно: фаза хода', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'phase' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  it('отправил — «думает…» и секунды идут; инструмент — «выполняет: Read …»; ответ — строки нет; в дереве — фаза', async () => {
    await c.request('agent.start', { name: 'ph', kind: 'claude', cwd: h.workDir('ph', { scenario: 'demo-working', hangAfterInit: 2500, hangAfterTool: 1500 }) })
    await h.win.locator('[data-testid="agent-row"][data-agent="ph"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="ph"]').waitFor({ timeout: 10_000 })
    const box = h.win.getByTestId('composer')
    await box.fill('посмотри, как шапка считает проценты')
    const line = h.win.getByTestId('turn-phase')
    // Короткий таймаут: строки может уже не быть, а текст в сообщении assert считается всегда.
    const text = async (): Promise<string> => (await h.win.getByTestId('turn-phase-text').textContent({ timeout: 200 }).catch(() => null)) ?? ''
    const t0 = Date.now()
    await box.press('Enter')

    // Реакция сразу: строка есть меньше чем через секунду после отправки, и это «думает…» (провайдер отозвался).
    assert.ok(await waitFor(async () => (await text()) === 'думает…', 1000, 25), `через ${Date.now() - t0} мс строка: «${await text()}»`)
    const first = (await h.win.getByTestId('turn-phase-time').textContent()) ?? ''
    assert.match(first, /^\d+ с$/)
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('turn-phase-time').textContent()) ?? '') !== first, 2500), 'секунды стоят')
    assert.equal(await h.win.getByTestId('turn-phase-live').textContent(), 'думает', 'диктору — фаза без секунд')
    assert.equal(await h.win.locator('[data-agent="ph"] [data-testid="row-status"]').textContent(), 'думает')
    await h.shot('thinking')

    assert.ok(await waitFor(async () => (await line.getAttribute('data-phase')) === 'tool', 6000), `не дошло до инструмента: «${await text()}»`)
    assert.equal(await text(), 'выполняет: Read ui/src/components/Header.tsx…')
    assert.equal(await h.win.locator('[data-agent="ph"] [data-testid="row-status"]').textContent(), 'Read')
    await h.shot('tool')

    assert.ok(await waitFor(async () => ((await h.win.getByTestId('feed').textContent()) ?? '').includes('правка нужна только в'), 20_000), 'ответа нет')
    assert.ok(await waitFor(async () => (await line.count()) === 0, 3000), `строка фазы не ушла: «${await text()}»`)
    assert.equal(await h.win.locator('[data-agent="ph"] [data-testid="row-status"]').textContent(), 'готов')
  })
})
