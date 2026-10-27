// Плотный реальный сценарий: 60 бесед, длинные названия, поиск и один путь навигации.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('спокойный чат: навигация', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'navigation' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client()
    const dir = h.workDir('pult', { scenario: 'simple' })
    for (let i = 0; i < 60; i++) {
      const name = `chat-${String(i).padStart(2, '0')}`
      await c.request('agent.start', { name, kind: i % 2 ? 'codex' : 'claude', cwd: dir })
      await c.request('agent.rename', { name, title: i === 59 ? 'Проверить сохранение темы после перезапуска приложения' : `Обсудить изменения экрана настроек — проход ${i + 1}` })
    }
    await c.request('agent.prompt', { name: 'chat-59', text: 'Проверь экран настроек' })
    await c.request('agent.wait', { name: 'chat-59', until: ['idle'], timeoutMs: 20_000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="chat-59"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="chat-59"]').waitFor({ timeout: 10_000 })
    await c.request('events.emit', { kind: 'status.changed', sessionId: 'chat-59', provider: 'codex', data: { status: 'working', turnId: 'preview-turn' } })
    await h.win.getByTestId('stop-turn').waitFor({ timeout: 5000 })
  })
  after(async () => { await h?.close() })

  it('60 бесед видны один раз, вкладок нет, техническая сводка скрыта; окно 1280×800 без переполнения', async () => {
    assert.equal(await h.win.getByTestId('agent-row').count(), 60)
    assert.equal(await h.win.getByTestId('session-tab').count(), 0)
    assert.equal(await h.win.getByTestId('health-menu').getAttribute('open'), null)
    assert.equal(await h.win.getByTestId('inbox').count(), 0)
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    await h.win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const geometry = await h.win.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
      feedHeight: document.querySelector('[data-testid="feed"]')!.getBoundingClientRect().height }))
    assert.ok(geometry.overflow <= 1, `горизонтальное переполнение ${geometry.overflow}px`)
    assert.ok(geometry.feedHeight >= 300, `разговор сжат до ${geometry.feedHeight}px`)
    await h.shot('navigation-60-chats-1280')
  })

  it('поиск сужает список, ⌘1 выбирает первую видимую беседу, очистка возвращает все 60', async () => {
    const search = h.win.getByTestId('chat-filter')
    await search.fill('СОХРАНЕНИЕ темы')
    assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 1))
    assert.equal(await h.win.getByTestId('agent-row').getAttribute('data-agent'), 'chat-59')
    await h.win.keyboard.press('Meta+1')
    assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'), 'chat-59')
    await h.shot('navigation-filtered')
    await search.fill('')
    assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 60))
  })

  it('Enter и Space на кнопке меню открывают меню, не выбирают беседу; Enter на строке выбирает её', async () => {
    const row = h.win.locator('.chat-section [data-testid="agent-row"][data-agent="chat-58"]')
    const button = row.getByTestId('row-menu')
    const menu = h.win.getByTestId('session-menu-list')
    for (const key of ['Enter', 'Space']) {
      await button.focus()
      await button.press(key)
      await menu.waitFor({ timeout: 3000 })
      assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'), 'chat-59', `${key} на вложенной кнопке не выбирает строку`)
      await h.win.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached', timeout: 3000 })
    }
    await row.focus()
    await row.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="chat-58"]').waitFor({ timeout: 3000 })
  })

})
