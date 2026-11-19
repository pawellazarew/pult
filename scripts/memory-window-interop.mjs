#!/usr/bin/env node
// Real Electron -> owner bridge -> isolated Rust memory. No provider turns.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.equal(process.platform, 'darwin', 'This Electron qualification runs on macOS')
assert.equal(process.argv.length, 3, 'Usage after root/shell test builds: node scripts/memory-window-interop.mjs /path/to/pultd-rust')
const binary = resolve(process.argv[2])
assert.ok(existsSync(binary), 'Build the Rust daemon first')
const { build } = await import('esbuild')
await build({ entryPoints: [join(root, 'shell/test/e2e/harness.ts')], outfile: join(root, 'shell/dist-test/e2e/harness.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { launch, waitFor, RESULTS } = await import('../shell/dist-test/e2e/harness.js')
const { connectClient } = await import('../dist/cli/client.js')
const { layout } = await import('../dist/core/paths.js')
const scratch = mkdtempSync(join(tmpdir(), 'pmw-'))
chmodSync(scratch, 0o700)
const home = join(scratch, 'h')
mkdirSync(home, { mode: 0o700 })
const paths = layout(home)
const project = join(scratch, 'project-a')
mkdirSync(project)
const daemons = []
let owner, h, complete = false
const note = (commandId, extra = {}) => ({ commandId, reason: 'Owner fixture decision', name: 'Project convention', summary: 'Shared project convention', details: 'Original project details', ...extra })
const phase = text => console.log(`memory-window: ${text}`)

async function startDaemon() {
  const child = spawn(binary, ['--home', home, 'daemon', 'serve'], { env: { ...process.env, PULT_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-8192) })
  const exited = new Promise(resolveExit => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', () => resolveExit({ code: null, signal: null }))
  })
  const handle = { child, exited, get stderr() { return stderr } }
  daemons.push(handle)
  let client
  assert.ok(await waitFor(async () => {
    if (!existsSync(paths.sock) || !existsSync(paths.token)) return false
    let candidate
    try {
      candidate = await connectClient(paths, { timeoutMs: 500, locale: () => 'ru' })
      const status = await candidate.request('daemon.status', {}, { timeoutMs: 500 })
      if (status.pid === child.pid) { client = candidate; return true }
    } catch { /* the startup endpoint is not ready yet */ }
    candidate?.close()
    return false
  }, 10_000), 'Rust daemon did not publish an owned endpoint')
  return { ...handle, client }
}

try {
  // Use the normal daemon admission path before seeding scratch registry data.
  const initial = await startDaemon()
  await initial.client.request('daemon.stop')
  initial.client.close()
  assert.equal((await initial.exited).code, 0)
  writeFileSync(paths.sessions, JSON.stringify({ version: 2, sessions: [{
    name: 'memory-project', provider: 'codex', cwd: project, mode: 'turn', createdAt: '2026-01-01T00:00:00.000Z',
    lastStatus: 'cold', lastEventId: 0, seenEventId: 0,
  }] }), { mode: 0o600 })
  writeFileSync(paths.config, JSON.stringify({ language: 'ru', migrations: { accessLevels: { at: '2026-01-01T00:00:00.000Z' } } }), { mode: 0o600 })
  const live = await startDaemon()
  owner = live.client
  const original = await owner.request('memory.add', note('window-project', { session: 'memory-project' }))
  await owner.request('memory.add', note('window-global', { scope: 'global', name: 'Global convention' }))
  h = await launch({ name: 'memory-rust', home, keepHome: true })
  assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
  assert.equal((await h.win.evaluate(() => window.pult.call('daemon.status'))).pid, live.child.pid, 'The window must stay on the actual Rust daemon')
  await h.win.locator('[data-testid="agent-row"][data-agent="memory-project"]').click()
  await h.win.keyboard.press('Meta+,')
  const settings = h.win.getByTestId('settings-dialog')
  await settings.waitFor()
  await h.win.getByTestId('settings-nav-sessions').click()
  await h.win.getByTestId('settings-provider').selectOption('codex')
  await h.win.getByTestId('settings-nav-memory').click()
  await h.win.getByTestId('settings-memory-open').click()
  const dialog = h.win.getByTestId('memory-dialog')
  await dialog.waitFor()
  const row = id => dialog.locator(`[data-testid="memory-row"][data-memory-id="${id}"]`)
  await row(original.id).click()
  await dialog.getByText('Original project details', { exact: true }).waitFor()
  assert.match(await dialog.getByTestId('memory-detail').innerText(), /Original project details/)
  phase('real Rust owner memory, project scope and record provenance visible')

  await dialog.getByTestId('memory-edit').click()
  await dialog.getByTestId('memory-details').fill('Changed from the actual window')
  await dialog.getByTestId('memory-reason').fill('Confirmed in the owner UI')
  await dialog.getByTestId('memory-pinned').check()
  await dialog.getByTestId('memory-save').click()
  await dialog.getByTestId('memory-edit').waitFor()
  let current = await owner.request('memory.get', { session: 'memory-project', id: original.id })
  assert.equal(current.version, 2)
  assert.equal(current.details, 'Changed from the actual window')
  assert.equal(current.pinned, true)
  await dialog.getByTestId('memory-history').locator('summary').first().click()
  assert.ok(await waitFor(async () => await dialog.getByTestId('memory-history-version').count() === 2))
  assert.equal(await dialog.getByTestId('memory-edit').isEnabled(), true)
  await h.scheme('dark')
  await h.win.screenshot({ path: join(RESULTS, 'memory-rust-history-dark.png'), animations: 'disabled' })
  phase('version-safe UI edit, pin and history match durable Rust records')

  await dialog.getByTestId('memory-edit').click()
  await dialog.getByTestId('memory-details').fill('Unsaved owner draft')
  await dialog.getByTestId('memory-reason').fill('Compare concurrent changes')
  current = await owner.request('memory.update', { session: 'memory-project', id: original.id, expectedVersion: current.version,
    commandId: 'window-concurrent', reason: 'Second owner update', details: 'Concurrent committed details' })
  await dialog.getByTestId('memory-save').click()
  await dialog.getByTestId('memory-conflict').waitFor()
  assert.equal(await dialog.getByTestId('memory-details').inputValue(), 'Unsaved owner draft')
  assert.equal((await owner.request('memory.get', { session: 'memory-project', id: original.id })).details, 'Concurrent committed details')
  await h.win.keyboard.press('Escape')
  await dialog.getByTestId('memory-discard').waitFor()
  await dialog.getByTestId('memory-discard-confirm').click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await h.win.getByTestId('settings-provider').inputValue(), 'codex', 'Opening memory must preserve unsaved preferences')
  await h.win.getByTestId('settings-memory-open').click()
  await dialog.waitFor()
  assert.equal(await dialog.getByTestId('memory-details').inputValue(), 'Unsaved owner draft')
  await dialog.getByTestId('memory-conflict-continue').click()
  await dialog.getByTestId('memory-save').click()
  await dialog.getByTestId('memory-edit').waitFor()
  current = await owner.request('memory.get', { session: 'memory-project', id: original.id })
  assert.equal(current.version, 4)
  assert.equal(current.details, 'Unsaved owner draft')
  phase('concurrent version conflict preserves draft and requires explicit owner resolution')

  await dialog.getByTestId('memory-scope').selectOption('global')
  await dialog.getByTestId('memory-new').click()
  await dialog.getByTestId('memory-name').fill('Window-created knowledge')
  await dialog.getByTestId('memory-summary').fill('A note saved through the actual owner bridge')
  await dialog.getByTestId('memory-details').fill('Safe plain text **with literal markers**')
  await dialog.getByTestId('memory-reason').fill('Owner confirmed creation')
  await dialog.getByTestId('memory-save').click()
  await dialog.getByTestId('memory-edit').waitFor()
  await dialog.getByTestId('memory-search').fill('Window-created')
  assert.ok(await waitFor(async () => await dialog.getByTestId('memory-row').count() === 1))
  const added = (await owner.request('memory.search', { scope: 'global', query: 'Window-created' })).memories[0]
  assert.ok(added)
  await row(added.id).click()
  await dialog.getByText('Safe plain text **with literal markers**', { exact: true }).waitFor()
  assert.match(await dialog.getByTestId('memory-detail').innerText(), /\*\*with literal markers\*\*/)
  await dialog.getByTestId('memory-forget').click()
  await dialog.getByTestId('memory-reason').fill('Owner confirmed forgetting')
  await dialog.getByTestId('memory-save').click()
  assert.ok(await waitFor(async () => await row(added.id).count() === 0))
  assert.equal((await owner.request('memory.search', { scope: 'global', query: 'Window-created' })).memories.length, 0)
  assert.equal((await owner.request('memory.history', { scope: 'global', id: added.id })).versions[0].deleted, true)
  phase('global creation, search and soft deletion agree with durable owner API')

  await dialog.getByTestId('memory-search').fill('')
  await dialog.getByTestId('memory-scope').selectOption(`project:${original.projectId}`)
  await row(original.id).click()
  await dialog.getByText('Unsaved owner draft', { exact: true }).waitFor()
  assert.equal(await dialog.getByTestId('memory-new').isEnabled(), true)
  assert.match(await dialog.getByTestId('memory-detail').innerText(), /Unsaved owner draft/)
  await h.scheme('light')
  await h.win.screenshot({ path: join(RESULTS, 'memory-rust-detail-light.png'), animations: 'disabled' })
  complete = true
  phase('persisted project selector works through the bridge; PASS')
} finally {
  owner?.close()
  let cleanupError = null
  try { await h?.close() } catch (error) { cleanupError = error }
  for (const handle of daemons) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM')
    if (!await Promise.race([handle.exited.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 5000))])) handle.child.kill('SIGKILL')
    await handle.exited
  }
  if (complete && !cleanupError) rmSync(scratch, { recursive: true, force: true })
  else {
    writeFileSync(join(scratch, 'rust.stderr'), daemons.map(handle => handle.stderr).join('\n'), { mode: 0o600 })
    console.error(`memory-window: retained failed fixture at ${scratch}`)
  }
  if (cleanupError) throw cleanupError
}
