import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

let h: Harness
before(async () => {
  h = await launch({ name: 'html-preview' })
  assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
})
after(async () => { await h?.close() })

it('visualize HTML runs CSS and JavaScript in an isolated site beside the chat', async () => {
  const downloads = path.join(h.home, 'Downloads')
  mkdirSync(downloads)
  const html = path.join(downloads, 'План команды.html')
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>button { color: rgb(12, 34, 56); }</style>
    <button id="counter" onclick="this.textContent = 'Clicked'">Click me</button>
    <script>document.body.dataset.bridge = typeof window.pult;
    try { parent.document.body.dataset.compromised = 'yes' } catch { document.body.dataset.isolated = 'yes' }</script>`)
  const c = await h.client()
  await c.request('agent.start', { name: 'html', kind: 'codex', cwd: h.workDir('project') })
  await c.request('events.emit', { sessionId: 'html', provider: 'codex', kind: 'message.done', data: {
    text: '\ue200visualize\ue202' + JSON.stringify({ path: html }) + '\ue201',
  } })
  await h.win.locator('[data-testid="agent-row"][data-agent="html"]').click()
  await h.win.getByTestId('file-link').click()
  const frame = h.win.frameLocator('[data-testid="file-html"]')
  const button = frame.locator('#counter')
  await button.waitFor()
  assert.equal(await button.evaluate((el) => getComputedStyle(el).color), 'rgb(12, 34, 56)')
  await button.click()
  assert.ok(await waitFor(async () => await button.textContent() === 'Clicked'),
    'the isolated frame handles the click before its result is inspected')
  assert.equal(await frame.locator('body').getAttribute('data-bridge'), 'undefined')
  assert.equal(await frame.locator('body').getAttribute('data-isolated'), 'yes')
  assert.equal(await h.win.locator('body').getAttribute('data-compromised'), null)
  await h.win.getByTestId('file-source-toggle').click()
  assert.match(await h.win.getByTestId('file-source').textContent() ?? '', /<!doctype html>/)
  await h.win.getByTestId('file-source-toggle').click()
  await frame.locator('#counter').waitFor()
  await h.screen('html-preview')
})
