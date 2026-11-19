import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { launch, REPO, RESULTS, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { DaemonStatus } from '../../src/contract.js'

describe('updated CLI discovery and Inbox reconnection through the native bridge', () => {
  let h: Harness
  let home: string
  let codex: string
  let oldPid: number
  const wrapper = (file: string, fake: string, version: string): void => {
    const replacement = `${file}.next`
    writeFileSync(replacement, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); } else { await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'test/fakes', fake)).href)}); }\n`, { mode: 0o700 })
    chmodSync(replacement, 0o700)
    renameSync(replacement, file)
  }
  before(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'pult-provider-update-'))
    codex = path.join(home, 'codex.mjs')
    const claude = path.join(home, 'claude.mjs')
    wrapper(codex, 'fake-codex-app-server.mjs', 'codex-cli 1.2.3')
    wrapper(claude, 'fake-claude.mjs', '1.2.3 (Claude Code)')
    h = await launch({ name: 'provider-updates', home, env: { PULT_CODEX_BIN: codex, PULT_CLAUDE_BIN: claude } })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    oldPid = h.daemonPid()!
    assert.ok(oldPid)
    await h.win.getByTestId('open-maintenance').click()
    const panel = h.win.getByTestId('maintenance-panel')
    await panel.waitFor()
    assert.ok(await waitFor(async () => (await panel.textContent())?.includes('codex-cli 1.2.3') ?? false))
    await panel.getByRole('button', { name: 'Готово', exact: true }).click()
  })
  after(async () => { await h?.close() })

  it('detects same-path replacement without stopping an active turn or opening Terminal', async () => {
    const c = await h.client()
    await c.request('agent.start', { name: 'refresh-live', kind: 'codex', cwd: h.workDir('refresh-live') })
    await c.request('agent.prompt', { name: 'refresh-live', text: '[[hang]] keep the current turn' })
    await c.request('agent.wait', { name: 'refresh-live', until: ['working'], timeoutMs: 10_000 })
    // Even a same-version replacement must be detected by file identity, not by semver.
    wrapper(codex, 'fake-codex-app-server.mjs', 'codex-cli 1.2.3')
    await h.win.getByTestId('open-maintenance').click()
    const panel = h.win.getByTestId('maintenance-panel')
    await panel.waitFor()
    await panel.getByRole('button', { name: 'Перепроверить', exact: true }).click()
    assert.ok(await waitFor(async () => Number(await h.win.getByTestId('inbox-count').textContent()) > 0))
    await panel.getByRole('button', { name: 'Готово', exact: true }).click()
    if (!await h.win.getByTestId('inbox').count()) await h.win.getByTestId('toggle-inbox').click()
    const card = h.win.locator('[data-testid="inbox-provider-update"][data-provider="codex"]')
    await card.waitFor()
    assert.match(await card.textContent() ?? '', /codex-cli 1\.2\.3/)
    assert.equal(h.daemonPid(), oldPid)
    await c.request('agent.wait', { name: 'refresh-live', until: ['working'], timeoutMs: 2_000 })
    assert.deepEqual(await h.app.evaluate(() => (globalThis as { __pultTestMaintenanceScripts?: string[] }).__pultTestMaintenanceScripts ?? []), [])
    await h.scheme('dark')
    await h.win.screenshot({ path: path.join(RESULTS, 'provider-update-inbox-dark.png'), animations: 'disabled' })
    await h.scheme('light')
    await h.win.screenshot({ path: path.join(RESULTS, 'provider-update-inbox-light.png'), animations: 'disabled' })
    await h.scheme('dark')
  })

  it('cancellation retains the old daemon and update card; confirmation adopts the detected file', async () => {
    const card = h.win.locator('[data-testid="inbox-provider-update"][data-provider="codex"]')
    await h.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    })
    await card.getByRole('button', { name: 'Подключить обновление', exact: true }).click()
    assert.ok(await waitFor(async () => await card.getByRole('button', { name: 'Подключить обновление', exact: true }).isEnabled()))
    assert.equal(h.daemonPid(), oldPid)
    const c = await h.client()
    await c.request('agent.wait', { name: 'refresh-live', until: ['working'], timeoutMs: 2_000 })
    await c.request('agent.stop', { name: 'refresh-live' })
    await h.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    })
    await card.getByRole('button', { name: 'Подключить обновление', exact: true }).click()
    assert.ok(await waitFor(async () => !!h.daemonPid() && h.daemonPid() !== oldPid && await h.win.getAttribute('.app', 'data-conn') === 'up', 25_000))
    assert.ok(await waitFor(async () => await card.count() === 0))
    const fresh = await h.client()
    const status = await fresh.request('daemon.status') as DaemonStatus
    const tools = await h.win.evaluate(async () => await window.pult!.providerTools!())
    assert.deepEqual(status.providerInstallations?.codex.installation, tools.find(tool => tool.provider === 'codex')?.installation)
    const history = await fresh.request('agent.read', { name: 'refresh-live', format: 'json' }) as { events: Array<{ kind: string; data: { text?: string } }> }
    assert.equal(history.events.filter(event => event.kind === 'message.user').length, 1)
    assert.equal(history.events.find(event => event.kind === 'message.user')?.data.text, '[[hang]] keep the current turn')
    assert.deepEqual(await h.app.evaluate(() => (globalThis as { __pultTestMaintenanceScripts?: string[] }).__pultTestMaintenanceScripts ?? []), [])
  })
})
