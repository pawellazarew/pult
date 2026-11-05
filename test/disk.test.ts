import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFileSync } from 'node:fs'
import { createDiskMonitor, GB, parseDiskSettings } from '../dist/core/disk.js'
import { defaultConfig, validateConfig, writeDiskSettings } from '../dist/core/config.js'
import { createLogger } from '../dist/core/log.js'
import { connectClient } from '../dist/cli/client.js'
import { startTestDaemon, tempHome } from './helpers.js'

it('disk boundary, dynamic threshold, recovery and unknown measurements', () => {
  const home = tempHome()
  const log = createLogger(home.paths.logFile)
  let bytes = 6 * GB, threshold = 6 * GB
  const check = createDiskMonitor('/', log, { thresholdBytes: () => threshold, availableBytes: () => { if (bytes === -1) throw Error(); return bytes } })
  try {
    assert.equal(check().state, 'ok')
    bytes--; assert.equal(check().state, 'low')
    threshold = 5 * GB; assert.equal(check().state, 'ok')
    for (const invalid of [-1, NaN, Infinity]) { bytes = invalid; assert.equal(check().state, 'unknown'); assert.equal(check().freeBytes, null) }
    bytes = 0; assert.equal(check().state, 'low')
  } finally { log.close(); home.remove() }
})
it('disk config defaults, blank normalization, strict validation and unrelated fields', () => {
  assert.deepEqual(defaultConfig().disk, { thresholdGb: 6, prompt: null })
  assert.deepEqual(parseDiskSettings({ thresholdGb: 8, prompt: '   ' }), { thresholdGb: 8, prompt: null })
  for (const thresholdGb of [0, -1, 1.5, NaN, Infinity, '6', 1e16]) assert.throws(() => parseDiskSettings({ thresholdGb, prompt: null }))
  assert.throws(() => parseDiskSettings({ thresholdGb: 6, prompt: null, extra: 1 }))
  const h = tempHome()
  try {
    writeDiskSettings(h.paths.config, { thresholdGb: 8, prompt: 'custom' })
    assert.deepEqual(JSON.parse(readFileSync(h.paths.config, 'utf8')).disk, { thresholdGb: 8, prompt: 'custom' })
    assert.equal(validateConfig({ disk: { thresholdGb: 8, prompt: 'custom' } }).config.disk.prompt, 'custom')
  } finally { h.remove() }
})
it('disk RPC persists preferences, reflects threshold immediately, and rejects invalid writes', async () => {
  const home = tempHome()
  const d = await startTestDaemon(home)
  const c = await connectClient(home.paths)
  try {
    const initial = await c.request('settings.get') as { disk: { settings: { thresholdGb: number; prompt: string | null }; status: { path: string; thresholdBytes: number } } }
    assert.equal(initial.disk.settings.thresholdGb, 6)
    assert.equal(initial.disk.status.path, home.paths.home)
    const changed = await c.request('settings.set', { disk: { thresholdGb: 999999, prompt: 'my words' } }) as typeof initial
    assert.equal(changed.disk.settings.prompt, 'my words')
    assert.equal(changed.disk.status.thresholdBytes, 999999 * GB)
    await c.request('settings.set', { language: 'en' })
    assert.equal((await c.request('settings.get') as typeof initial).disk.settings.prompt, 'my words')
    await assert.rejects(c.request('settings.set', { disk: { thresholdGb: -1, prompt: null } }))
    assert.equal(JSON.parse(readFileSync(home.paths.config, 'utf8')).disk.thresholdGb, 999999)
    const reset = await c.request('settings.set', { disk: { thresholdGb: 6, prompt: ' ' } }) as typeof initial
    assert.equal(reset.disk.settings.prompt, null)
  } finally { c.close(); await d.stop('test complete'); home.remove() }
})
