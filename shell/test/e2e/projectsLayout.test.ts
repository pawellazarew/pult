import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('раскрытие проектов', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'projects-layout' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const c = await h.client()
    const dirs = ['alpha', 'beta', 'gamma'].map((n) => h.workDir(n))
    for (const dir of dirs) await c.request('project.add', { path: dir })
    for (let i = 0; i < 10; i++) await c.request('agent.start', { name: `chat-${i}`, kind: 'claude', cwd: dirs[i % 3] })
    for (let i = 0; i < 2; i++) await c.request('events.emit', { kind: 'status.changed', sessionId: `chat-${i}`, provider: 'claude', data: { status: 'working' } })
    assert.ok(await waitFor(async () => await h.win.getByTestId('project').count() === 3))
  })
  after(async () => { await h?.close() })

  it('счётчик 3 соответствует трём полностью видимым строкам после раскрытия', async () => {
    const manager = h.win.getByTestId('project-manager')
    for (const [width, height] of [[1280, 800], [1024, 642], [900, 560]]) {
      await h.app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!), [width, height])
      await manager.locator('summary').click()
      await h.win.waitForTimeout(300)
      const geometry = await h.win.getByTestId('sidebar-projects').evaluate((el) => {
        const bounds = el.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, count: el.querySelector('.count')?.textContent,
          rows: [...el.querySelectorAll('.proj-h')].map((row) => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }) }
      })
      assert.equal(geometry.count, '3')
      assert.equal(geometry.rows.length, 3)
      for (const row of geometry.rows) assert.ok(row.top >= geometry.top && row.bottom <= geometry.bottom + 1, `${width}: строка проекта обрезана: ${JSON.stringify(geometry)}`)
      const active = await h.win.getByTestId('active-chats').boundingBox()
      assert.ok(active && active.height >= 70, `${width}: работающие чаты сжаты до ${active?.height}px`)
      const recent = await h.win.getByTestId('chats-recent').boundingBox()
      const firstRecent = await h.win.getByTestId('chats-recent').getByTestId('agent-row').first().boundingBox()
      assert.ok(recent && firstRecent && firstRecent.y + firstRecent.height <= recent.y + recent.height + 1, 'первая недавняя беседа должна оставаться видимой')
      await h.shot(`projects-three-${width}`)
      await manager.locator('summary').click()
      await h.win.waitForTimeout(300)
    }
  })

  it('раскрытие и закрытие проходят через промежуточную высоту; reduced motion отключает движение', async () => {
    await h.win.emulateMedia({ reducedMotion: 'no-preference' })
    const measure = () => h.win.getByTestId('sidebar-projects').evaluate((el) => el.getBoundingClientRect().height)
    const closed = await measure()
    await h.win.getByTestId('project-manager').locator('summary').click()
    await h.win.waitForTimeout(60)
    const middle = await measure()
    await h.win.waitForTimeout(260)
    const opened = await measure()
    assert.ok(middle > closed + 1 && middle < opened - 1, `раскрытие скачком: ${closed} → ${middle} → ${opened}`)
    await h.win.getByTestId('project-manager').locator('summary').click()
    await h.win.waitForTimeout(60)
    const closing = await measure()
    assert.ok(closing > closed + 1 && closing < opened - 1, `закрытие скачком: ${opened} → ${closing} → ${closed}`)
    await h.win.waitForTimeout(260)
    await h.win.emulateMedia({ reducedMotion: 'reduce' })
    await h.win.getByTestId('project-manager').locator('summary').click()
    await h.win.waitForTimeout(40)
    assert.ok(Math.abs(await measure() - opened) <= 1, 'reduced motion должен раскрывать без анимации')
  })
})
