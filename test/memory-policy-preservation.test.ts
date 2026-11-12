import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { layout } from '../dist/core/paths.js'
import { createRegistry, parseSessions } from '../dist/sessions/registry.js'

const record = (memory?: unknown) => ({ name: 'chat', provider: 'codex', cwd: '/fixture/project',
  mode: 'turn', createdAt: '2026-11-12T00:00:00Z', lastStatus: 'working', lastEventId: 0,
  ...(memory === undefined ? {} : { memory }),
})

describe('Rust memory policy survives Node rollback', () => {
  it('preserves configured, disabled, malformed and future values without interpreting them', () => {
    for (const memory of [{ read: true, write: 'ask' }, { read: false, write: 'off' },
      { version: 2, read: true, write: 'future', extra: ['opaque'] }, null, 'invalid', 17]) {
      const parsed = parseSessions({ version: 2, sessions: [record(memory)] })
      assert.deepEqual((parsed[0] as unknown as { memory?: unknown })?.memory, memory)
      assert.equal(Object.hasOwn(parsed[0]!, 'memory'), true)
    }
    assert.equal(Object.hasOwn(parseSessions({ sessions: [record()] })[0]!, 'memory'), false)
    for (const privacy of [{ private: true }, { temporary: true }, { private: { future: 'opaque' }, temporary: false }]) {
      const raw = { ...record({ read: true, write: 'ask' }), ...privacy }
      const parsed = parseSessions({ sessions: [raw] })[0]!
      for (const [key, value] of Object.entries(privacy)) assert.deepEqual((parsed as unknown as Record<string, unknown>)[key], value)
    }
  })

  it('keeps the exact opaque field through actual cooldown/rename/reopen without changing consent', () => {
    const home = mkdtempSync(join(tmpdir(), 'pult-memory-policy-'))
    chmodSync(home, 0o700)
    try {
      const paths = layout(home)
      const memory = { read: true, write: 'ask', future: { enabled: false } }
      const config = JSON.stringify({ migrations: { accessLevels: { at: '2026-11-01T00:00:00Z' } }, preserve: 'owner settings' })
      writeFileSync(paths.config, config, { mode: 0o600 })
      writeFileSync(paths.sessions, JSON.stringify({ version: 2, sessions: [{ ...record(memory), private: true }] }), { mode: 0o600 })
      const consent = join(home, 'consent.json')
      writeFileSync(consent, '{"rev":7,"approved":true}', { mode: 0o600 })
      const registry = createRegistry(paths)
      registry.coolDown()
      registry.update('chat', { title: 'Renamed' })
      assert.deepEqual(JSON.parse(readFileSync(paths.sessions, 'utf8')).sessions[0].memory, memory)
      assert.equal(JSON.parse(readFileSync(paths.sessions, 'utf8')).sessions[0].private, true)
      assert.deepEqual((createRegistry(paths).get('chat') as unknown as { memory?: unknown })?.memory, memory)
      assert.equal(readFileSync(paths.config, 'utf8'), config)
      assert.equal(readFileSync(consent, 'utf8'), '{"rev":7,"approved":true}')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
