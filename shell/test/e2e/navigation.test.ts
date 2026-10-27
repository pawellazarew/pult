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

  it('недавние остаются под проектами при длинных активных списках; новые события не переставляют работающие чаты', async () => {
    const c = await h.client()
    for (let i = 0; i < 35; i++) await c.request('events.emit', { kind: 'status.changed', sessionId: `chat-${String(i).padStart(2, '0')}`, provider: i % 2 ? 'codex' : 'claude', data: { status: 'working' } })
    const working = h.win.getByTestId('chats-working').getByTestId('agent-row')
    assert.ok(await waitFor(async () => await working.count() === 36))
    const order = () => working.evaluateAll((rows) => rows.map((el) => (el as HTMLElement).dataset.agent))
    const before = await order()
    assert.equal(before[0], 'chat-59', 'последняя созданная беседа должна быть первой среди работающих')
    const result = await c.request('events.emit', { kind: 'status.changed', sessionId: 'chat-00', provider: 'claude', data: { status: 'working' } }) as { ids: number[] }
    await h.win.getByTestId('event-count').filter({ hasText: `#${result.ids.at(-1)}` }).waitFor({ state: 'attached' })
    assert.deepEqual(await order(), before, 'событие переставило работающие беседы')
    for (let i = 0; i < 12; i++) await c.request('project.add', { path: h.workDir(`project-${i}`) })
    const projects = h.win.getByTestId('project-manager')
    await projects.locator('summary').click()
    await projects.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))) })
    const recent = h.win.getByTestId('chats-recent')
    for (const [width, height] of [[1280, 800], [1024, 642], [900, 560]]) {
      await h.app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!) }, [width, height])
      await h.win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await h.win.getByTestId('active-chats').evaluate((el) => { el.scrollTop = el.scrollHeight })
      await h.win.getByTestId('sidebar-projects').evaluate((el) => { el.scrollTop = el.scrollHeight })
      const bounds = await recent.boundingBox()
      const first = await recent.getByTestId('agent-row').first().boundingBox()
      const viewport = await h.win.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth }))
      assert.ok(bounds && first)
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'недавние вышли за край окна')
      assert.ok(first.y >= bounds.y && first.y + first.height <= bounds.y + bounds.height, 'в недавних не видна даже первая беседа')
      assert.ok(viewport.overflow <= 1, 'sidebar раздвигает окно')
      assert.ok(await h.win.getByTestId('sidebar-projects').evaluate((el) => el.getBoundingClientRect().bottom) <= bounds.y + 1, 'проекты должны находиться над недавними')
      const projectBox = await h.win.getByTestId('sidebar-projects').boundingBox()
      const projectHeading = await projects.locator('summary').boundingBox()
      assert.ok(projectBox && projectHeading && projectHeading.y >= projectBox.y - 1 && projectHeading.y + projectHeading.height <= projectBox.y + projectBox.height + 1, 'заголовок проектов исчез при прокрутке')
      await h.shot(`pinned-recent-${width}`)
    }
    // Возвращаем место для проверки меню следующего сценария.
    await projects.locator('summary').click()
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
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
