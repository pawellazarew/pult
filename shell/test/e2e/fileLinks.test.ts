import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import { pdfFixture } from './pdfFixture.js'

let h: Harness
before(async () => { h = await launch({ name: 'file-links' }); assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000)) })
after(async () => { await h?.close() })

it('цитата PDF вне проекта открывает документ только по клику; отсутствующий файл объясняет ошибку', async () => {
  const downloads = path.join(h.home, 'Downloads')
  mkdirSync(downloads)
  const pdf = path.join(downloads, 'Резюме — Engineer.pdf')
  writeFileSync(pdf, pdfFixture())
  const c = await h.client()
  await c.request('agent.start', { name: 'files', kind: 'codex', cwd: h.workDir('project') })
  await c.request('events.emit', { sessionId: 'files', provider: 'codex', kind: 'message.done', data: { text: `Готовый документ:\n\n:codex-file-citation{path=${JSON.stringify(pdf)} purpose="output"}` } })
  await h.win.locator('[data-testid="agent-row"][data-agent="files"]').click()
  const link = h.win.getByTestId('file-link')
  await link.waitFor()
  assert.match(await link.textContent() ?? '', /Резюме — Engineer.pdf/)
  const opened = () => h.app.evaluate(() => (globalThis as { __pultTestFiles?: Array<{ path: string; action: string }> }).__pultTestFiles ?? [])
  assert.deepEqual(await opened(), [])
  await link.click()
  await h.win.getByTestId('file-open-external').waitFor()
  assert.deepEqual(await opened(), [])
  await h.win.getByTestId('file-open-external').click()
  assert.deepEqual(await opened(), [{ path: realpathSync(pdf), action: 'open' }])
  for (const raw of ['https://example.com/test.pdf', path.join(downloads, 'missing.pdf')]) {
    const error = await h.win.evaluate(async (p) => { try { await window.pult!.openFile!(p); return null } catch (e) { return (e as { code?: string }).code } }, raw)
    assert.equal(error, 'file_unavailable')
  }
  await h.scheme('light'); await h.screen('file-link-light')
  await h.scheme('dark'); await h.screen('file-link-dark')
  await h.win.getByTestId('files-close').click()
  const missing = path.join(downloads, 'missing.pdf')
  await c.request('events.emit', { sessionId: 'files', provider: 'codex', kind: 'message.done', data: { text: `:codex-file-citation{path=${JSON.stringify(missing)} purpose="output"}` } })
  await h.win.getByTestId('file-link').nth(1).click()
  await h.win.getByRole('alert').filter({ hasText: 'Не удалось открыть файл' }).waitFor()
})
