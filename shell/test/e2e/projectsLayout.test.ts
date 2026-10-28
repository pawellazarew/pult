import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('раскрытие проектов и размер недавних', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'projects-layout' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const c = await h.client(), dirs = ['alpha', 'beta', 'gamma'].map((n) => h.workDir(n))
    for (const dir of dirs) await c.request('project.add', { path: dir })
    for (let i = 0; i < 10; i++) await c.request('agent.start', { name: `chat-${i}`, kind: 'claude', cwd: dirs[i % 3] })
    for (let i = 0; i < 2; i++) await c.request('events.emit', { kind: 'status.changed', sessionId: `chat-${i}`, provider: 'claude', data: { status: 'working' } })
    assert.ok(await waitFor(async () => await h.win.getByTestId('project').count() === 3))
  })
  after(async () => { await h?.close() })

  it('все три свёрнутых проекта и первая недавняя беседа видны на трёх размерах окна', async () => {
    for (const project of await h.win.getByTestId('project').all()) if (await project.getAttribute('open') !== null) await project.getByTestId('project-toggle').click()
    for (const [width, height] of [[1280, 800], [1024, 642], [900, 560]]) {
      await h.app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!), [width, height])
      assert.ok(await waitFor(async () => h.win.getByTestId('sidebar-projects').evaluate((el) => {
        const box = el.getBoundingClientRect()
        return Array.from(el.querySelectorAll('.project-group > summary')).every((row) => { const r = row.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom + 1 })
      })))
      assert.equal(await h.win.locator('.projects-heading .count').textContent(), '3')
      await h.shot(`projects-three-${width}`)
    }
  })

  it('проекты открываются плавно, сохраняют свёрнутость; reduced motion отключает движение', async () => {
    const project = h.win.getByTestId('project').first(), toggle = project.getByTestId('project-toggle')
    const heights = await project.evaluate(async (el) => {
      const samples: number[] = []
      ;(el.querySelector('summary') as HTMLElement).click()
      const end = performance.now() + 260
      while (performance.now() < end) { samples.push(el.getBoundingClientRect().height); await new Promise<void>((done) => requestAnimationFrame(() => done())) }
      return samples
    })
    assert.ok(heights.some((height) => height > heights[0]! + 2 && height < heights.at(-1)! - 2), 'нет промежуточных размеров при раскрытии')
    await toggle.click()
    assert.ok(await waitFor(async () => await project.getAttribute('open') === null))
    // `open` у details снимается сразу по клику, а в localStorage свёрнутость попадает позже: `toggle` → React → эффект.
    // Перезагрузка раньше записи теряла её (раннер macOS под нагрузкой: проект после reload открыт).
    const path = await project.getAttribute('data-project')
    assert.ok(await waitFor(async () => h.win.evaluate((p) => (JSON.parse(localStorage.getItem('pult.collapsed') ?? '[]') as string[]).includes(p!), path)))
    await h.win.reload()
    assert.ok(await waitFor(async () => await h.win.getByTestId('project').count() === 3))
    assert.equal(await h.win.getByTestId('project').first().getAttribute('open'), null)
    await h.win.emulateMedia({ reducedMotion: 'reduce' })
    await h.win.getByTestId('project-toggle').first().click()
    const duration = await h.win.getByTestId('project').first().evaluate((el) => getComputedStyle(el, '::details-content').transitionDuration)
    assert.equal(duration, '0s')
  })

  it('граница недавних работает мышью и клавиатурой; размер сохраняется после reload', async () => {
    const splitter = h.win.getByTestId('recent-resize')
    const height = () => h.win.getByTestId('chats-recent').evaluate((el) => el.getBoundingClientRect().height)
    const before = await height(), box = await splitter.boundingBox()
    assert.ok(box)
    await h.win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await h.win.mouse.down(); await h.win.mouse.move(box.x + box.width / 2, box.y - 70, { steps: 8 }); await h.win.mouse.up()
    assert.ok(await height() > before + 30)
    const dragged = await height()
    await splitter.focus(); await splitter.press('ArrowDown')
    assert.ok(await height() < dragged - 5)
    await splitter.press('End')
    const saved = await splitter.getAttribute('aria-valuenow')
    await h.win.reload()
    assert.ok(await waitFor(async () => await h.win.getByTestId('recent-resize').getAttribute('aria-valuenow') === saved))
    assert.ok(await h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await h.win.getByTestId('recent-resize').dblclick()
    assert.ok(Number(await h.win.getByTestId('recent-resize').getAttribute('aria-valuenow')) < 55)
  })

  it('«+» в проекте открывает создание в его папке и не сворачивает проект', async () => {
    const project = h.win.getByTestId('project').first(), open = await project.getAttribute('open')
    await project.getByTestId('project-new-session').click()
    await h.win.getByTestId('new-agent-dialog').waitFor()
    assert.equal(await h.win.getByTestId('new-agent-cwd').getAttribute('data-path'), await project.getAttribute('data-project'))
    await h.win.keyboard.press('Escape')
    assert.equal(await project.getAttribute('open'), open)
  })
})
