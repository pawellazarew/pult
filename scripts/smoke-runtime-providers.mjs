// Called by the opt-in iOS smoke while its dedicated simulator is alive.
// Uses real CLI logins and subscription quota; normal network guard remains enabled.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectClient } from '../dist/cli/client.js'
import { defaultConfig, loadConfig } from '../dist/core/config.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import { startDaemon } from '../dist/daemon/server.js'

export async function smokeProviders(targetId, out, options = {}) {
  mkdirSync(out, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'prs-'))
  const work = mkdtempSync(join(tmpdir(), 'pult-provider-smoke-'))
  const paths = layout(home)
  ensureLayout(paths)
  const config = options.localNetwork ? loadConfig(join(homedir(), '.pult', 'config.json')).config : defaultConfig(); config.autoTitle = false
  const logger = createLogger(paths.logFile)
  const started = await startDaemon({ paths, config, logger })
  assert.ok(started.ok)
  const daemon = started.daemon
  const client = await connectClient(paths)
  const report = []
  let host; let polling; let active = true
  if (options.image) {
    const data = readFileSync(options.image).toString('base64')
    host = await connectClient(paths, { client: 'shell' })
    polling = (async () => {
      while (active) {
        const { jobs } = await host.request('runtime.host.poll', { available: true })
        for (const job of jobs) {
          try {
            await host.request('runtime.host.begin', { id: job.id })
            const result = job.action === 'screenshot' ? { image: { data, mimeType: 'image/jpeg' } } : { text: 'Read the provided screenshot', url: 'https://runtime-smoke.invalid/' }
            await host.request('runtime.host.complete', { id: job.id, result })
          } catch {}
        }
        await new Promise(r => setTimeout(r, 50))
      }
    })().catch(() => {})
  }
  try {
    for (const provider of ['claude', 'codex']) {
      const name = `smoke-${provider}`
      const currentTarget = options.image ? `web:${name}` : targetId
      console.log(`Provider smoke: ${provider}`)
      try {
        await client.request('agent.start', { name, kind: provider, cwd: work, approval: 'full', confirm: true, ...(provider === 'claude' ? { model: 'haiku' } : {}), effort: 'low' })
        await client.request('agent.prompt', { name, text: `Use only the pult_runtime MCP tools to inspect the test screen ${currentTarget}. Call discover, then perform attach for exactly this target, then perform screenshot. Read the status displayed below the button from the screenshot and report it. Do not install anything, change the app, click, use shell or read files.` })
        const wait = await client.request('agent.wait', { name, timeoutMs: 180_000 })
        writeFileSync(join(out, `${provider}-wait.json`), JSON.stringify(wait, null, 2))
        const events = daemon.store.readFrom(0, { sessionId: name, limit: 200 })
        writeFileSync(join(out, `${provider}-events.json`), JSON.stringify(events, null, 2))
        const blocked = events.find(e => ['net.blocked', 'provider.blocked', 'limit.hit', 'error'].includes(e.kind))
        if (blocked) throw new Error(`${blocked.kind}: ${JSON.stringify(blocked.data).slice(0, 800)}`)
        const called = events.filter(e => e.kind === 'tool.called').map(e => JSON.stringify(e.data))
        const done = events.filter(e => e.kind === 'message.done').map(e => JSON.stringify(e.data)).join('\n')
        assert.ok(called.some(s => s.includes('pult_runtime') && s.includes('screenshot')), 'Model did not request runtime screenshot')
        assert.match(done, /runtime-proof/i, 'Model did not read the expected screen status')
        report.push({ provider, passed: true, transportOnly: !!options.image, steps: ['runtime MCP connected', 'discover', 'attach', 'screenshot', 'screen text verified'] })
        console.log(`PASS ${provider}: MCP screenshot and visual status`)
      } catch (e) {
        report.push({ provider, passed: false, error: e.message })
        console.log(`FAIL ${provider}: ${e.message}`)
      } finally { await client.request('agent.stop', { name }).catch(() => {}) }
    }
    writeFileSync(join(out, 'providers.json'), JSON.stringify(report, null, 2))
    assert.ok(report.every(r => r.passed), 'One or more real provider smoke checks failed; see providers.json')
  } finally {
    active = false; await polling; host?.close()
    client.close(); await daemon.stop('runtime provider smoke'); logger.close()
    rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true })
  }
}

// Transport-only mode uses an already verified iOS screenshot, not a second live simulator.
if (process.argv.includes('--image')) {
  const i = process.argv.indexOf('--image')
  await smokeProviders(null, process.argv[i + 2] ?? '/tmp/pult-provider-report', { image: process.argv[i + 1], localNetwork: true })
}
