import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('проекты как основная навигация', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'navigation' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client(), dir = h.workDir('pult', { scenario: 'simple' })
    for (let i = 0; i < 60; i++) {
      const name = `chat-${String(i).padStart(2, '0')}`
      await c.request('agent.start', { name, kind: i % 2 ? 'codex' : 'claude', cwd: dir })
      await c.request('agent.rename', { name, title: i === 59 ? 'Проверить сохранение темы после перезапуска приложения' : `Обсудить изменения экрана настроек — проход ${i + 1}` })
    }
    await c.request('agent.prompt', { name: 'chat-59', text: 'Проверь экран настроек' })
    await c.request('agent.wait', { name: 'chat-59', until: ['idle'], timeoutMs: 20_000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="chat-59"]').click()
    await c.request('events.emit', { kind: 'status.changed', sessionId: 'chat-59', provider: 'codex', data: { status: 'working', turnId: 'preview-turn' } })
    await h.win.getByTestId('stop-turn').waitFor()
  })
  after(async () => { await h?.close() })

  it('проект содержит чаты, длинный список раскрывается; недавние остаются отдельными ярлыками', async () => {
    assert.equal(await h.win.getByTestId('project').count(), 1)
    assert.equal(await h.win.getByTestId('agent-row').count(), 4)
    assert.equal(await h.win.getByTestId('recent-row').count(), 59)
    await h.win.getByTestId('project-more').click()
    assert.equal(await h.win.getByTestId('agent-row').count(), 60)
    await h.win.getByRole('button', { name: 'Свернуть список', exact: true }).click()
    assert.equal(await h.win.getByTestId('agent-row').count(), 4)
    assert.equal(await h.win.getByTestId('session-tab').count(), 0)
    const sizes = await h.win.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, feed: document.querySelector('[data-testid="feed"]')!.getBoundingClientRect().height }))
    assert.ok(sizes.overflow <= 1 && sizes.feed >= 250)
    await h.shot('project-chats-1280')
  })

  it('поиск раскрывает совпадения, ⌘1 выбирает первый чат проекта', async () => {
    const search = h.win.getByTestId('chat-filter')
    await search.fill('СОХРАНЕНИЕ темы')
    assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 1))
    await h.win.keyboard.press('Meta+1')
    assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'), 'chat-59')
    await search.fill('')
    assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 4))
    await h.win.keyboard.press('Meta+B'); await h.win.keyboard.press('Meta+2')
    await h.win.locator('[data-testid="conversation"][data-agent="chat-58"]').waitFor()
    await h.win.keyboard.press('Meta+1'); await h.win.keyboard.press('Meta+B')
    await h.win.locator('[data-testid="conversation"][data-agent="chat-59"]').waitFor()
  })

  it('выбор старого чата из недавних раскрывает проект и показывает выбранный чат за пределами краткого списка', async () => {
    const project = h.win.getByTestId('project')
    await project.getByTestId('project-toggle').click()
    assert.ok(await waitFor(async () => await project.getAttribute('open') === null))
    await h.win.locator('[data-testid="recent-row"][data-agent="chat-00"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="chat-00"]').waitFor()
    assert.ok(await waitFor(async () => await project.getAttribute('open') !== null))
    const selected = project.locator('[data-testid="agent-row"][data-agent="chat-00"]')
    assert.equal(await selected.getAttribute('aria-selected'), 'true')
    assert.ok(await waitFor(async () => {
      const row = await selected.boundingBox(), area = await h.win.getByTestId('sidebar-projects').boundingBox()
      return !!row && !!area && row.y >= area.y && row.y + row.height <= area.y + area.height + 1
    }))
    await project.getByTestId('project-toggle').click()
    await h.win.locator('[data-testid="recent-row"][data-agent="chat-00"]').click()
    assert.ok(await waitFor(async () => await project.getAttribute('open') !== null), 'повторный выбор текущего чата тоже раскрывает проект')
    await h.win.locator('[data-testid="agent-row"][data-agent="chat-59"]').click()
  })

  it('фильтр работающих: чат с ходом сверху, остальные по созданию; события не двигают строки; свёрнутый проект показывает состояние', async () => {
    const c = await h.client()
    const project = h.win.getByTestId('project')
    const summary = h.win.getByTestId('project-toggle')
    try {
      for (let i = 0; i < 35; i++) await c.request('events.emit', { kind: 'status.changed', sessionId: `chat-${String(i).padStart(2, '0')}`, provider: i % 2 ? 'codex' : 'claude', data: { status: 'working' } })
      await h.win.getByTestId('filter-working').click()
      assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 36))
      const order = () => h.win.getByTestId('agent-row').evaluateAll((rows) => rows.map((el) => (el as HTMLElement).dataset.agent))
      const before = await order()
      assert.equal(before[0], 'chat-59')
      const result = await c.request('events.emit', { kind: 'status.changed', sessionId: 'chat-00', provider: 'claude', data: { status: 'working' } }) as { ids: number[] }
      await h.win.getByTestId('event-count').filter({ hasText: `#${result.ids.at(-1)}` }).waitFor({ state: 'attached' })
      assert.deepEqual(await order(), before)
      await summary.click()
      // Ждём саму пометку свёрнутого проекта. Раньше ждали «36» в тексте строки проекта, а его там с самого
      // начала показывает счётчик чатов: ожидание проходило сразу, и счёт пометки шёл раньше, чем `toggle`
      // у details доходил до React (на раннере CI — 0 вместо 1, и следующие тесты падали следом).
      await summary.getByLabel('36 в работе').waitFor()
    } finally {
      // Провал здесь не должен уносить следующие тесты: проект раскрыт, фильтр «Все».
      if (await project.getAttribute('open') === null) await summary.click()
      assert.ok(await waitFor(async () => await project.getAttribute('open') !== null))
      await h.win.getByTestId('filter-all').click()
      assert.ok(await waitFor(async () => await h.win.getByTestId('filter-all').getAttribute('aria-pressed') === 'true'))
    }
  })

  it('новая реплика поднимает чат из середины наверх один раз; события хода и фон его не двигают', async () => {
    const c = await h.client()
    const seen = new Set<string>()
    let sampling = true
    let sampler: Promise<void> = Promise.resolve()
    try {
      await h.win.getByTestId('project-more').click()
      assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 60))
      const order = () => h.win.getByTestId('agent-row').evaluateAll((rows) => rows.map((el) => (el as HTMLElement).dataset.agent))
      const before = await order()
      assert.ok(before.indexOf('chat-45') > 5, before.join(' '))
      const expected = ['chat-45', ...before.filter((n) => n !== 'chat-45')]
      // Пока идёт ход, строки снимаются непрерывно: видны только два порядка — до реплики и после.
      sampler = (async () => { while (sampling) { seen.add((await order()).join(' ')); await new Promise((r) => setTimeout(r, 15)) } })()
      await c.request('agent.prompt', { name: 'chat-45', text: 'Проверь порядок' })
      await c.request('agent.wait', { name: 'chat-45', until: ['idle'], timeoutMs: 20_000 })
      assert.ok(await waitFor(async () => (await order()).join(' ') === expected.join(' ')), 'чат с новой репликой — наверху проекта')
      // Ход кончился, а дальше — поток, инструменты, субагент, фон и сторож у него и у соседа.
      let last = 0
      for (const name of ['chat-45', 'chat-10']) {
        for (const [kind, data] of [['message.delta', { text: 'ещё' }], ['tool.called', { toolUseId: `t-${name}`, name: 'Bash', input: {} }],
          ['agent.spawned', { toolUseId: `a-${name}`, description: 'фон' }], ['background.changed', { count: 1, tasks: [{ id: 'b', description: 'фон' }] }],
          ['turn.stalled', { silentForMs: 1 }], ['status.changed', { status: 'idle' }], ['background.changed', { count: 0, tasks: [] }]] as const) {
          const r = await c.request('events.emit', { kind, sessionId: name, provider: name === 'chat-45' ? 'codex' : 'claude', data }) as { ids: number[] }
          last = r.ids.at(-1) ?? last
        }
      }
      await h.win.getByTestId('event-count').filter({ hasText: `#${last}` }).waitFor({ state: 'attached' })
      await h.win.evaluate(() => window.dispatchEvent(new Event('focus')))
      await new Promise((r) => setTimeout(r, 300))
      sampling = false
      await sampler
      assert.deepEqual(await order(), expected, 'события после хода строку не двигают')
      assert.deepEqual([...seen].filter((o) => o !== before.join(' ') && o !== expected.join(' ')), [], 'промежуточных порядков нет')
      assert.equal(await h.win.locator('[data-testid="recent-row"]').first().getAttribute('data-agent'), 'chat-45', 'и в «Недавних» он первый')
      assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'), 'chat-59', 'выбор не украден')
    } finally {
      sampling = false
      await sampler
      // Провал здесь не должен уносить следующие тесты: длинный список снова свёрнут.
      const fold = h.win.getByRole('button', { name: 'Свернуть список', exact: true })
      if (await fold.count()) await fold.click()
    }
  })

  it('много проектов прокручиваются в основной области; недавние видны на трёх размерах окна', async () => {
    const c = await h.client()
    for (let i = 0; i < 12; i++) await c.request('project.add', { path: h.workDir(`project-${i}`) })
    await h.win.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.ok(await waitFor(async () => await h.win.getByTestId('project').count() === 13))
    for (const [width, height] of [[1280, 800], [1024, 642], [900, 560]]) {
      await h.app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!), [width, height])
      await h.win.getByTestId('sidebar-projects').evaluate((el) => { el.scrollTop = el.scrollHeight })
      await h.win.locator('[data-testid="chats-recent"] .ag-list').evaluate((el) => { el.scrollTop = 0 })
      assert.ok(await waitFor(async () => h.win.evaluate(() => {
        const projects = document.querySelector('[data-testid="sidebar-projects"]')!.getBoundingClientRect()
        const recent = document.querySelector('[data-testid="chats-recent"]')!.getBoundingClientRect()
        const first = document.querySelector('[data-testid="recent-row"]')!.getBoundingClientRect()
        const heading = document.querySelector('.projects-heading')!.getBoundingClientRect()
        return projects.bottom <= recent.top && first.top >= recent.top && first.bottom <= recent.bottom + 1 && recent.bottom <= innerHeight && heading.top >= projects.top - 1 && document.documentElement.scrollWidth <= innerWidth + 1
      })))
      await h.shot(`project-sidebar-${width}`)
    }
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  })

  it('Enter и Space на меню не выбирают чат; Enter на строке выбирает его', async () => {
    const row = h.win.locator('[data-testid="agent-row"][data-agent="chat-58"]')
    const menu = h.win.getByTestId('session-menu-list')
    for (const key of ['Enter', 'Space']) {
      await row.getByTestId('row-menu').focus()
      await row.getByTestId('row-menu').press(key)
      await menu.waitFor()
      assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'), 'chat-59')
      await h.win.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    }
    await row.focus(); await row.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="chat-58"]').waitFor()
  })
})
