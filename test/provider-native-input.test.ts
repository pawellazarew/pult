import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createCodexAdapter } from '../dist/adapters/codex/adapter.js'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import { defaultConfig } from '../dist/core/config.js'
import { createLogger } from '../dist/core/log.js'
import type { EventDraft } from '../dist/core/events.js'
import type { PromptAttachment } from '../dist/core/promptAttachments.js'
import { FAKE_CODEX, FAKE_CLAUDE } from './helpers.js'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64')
const check = (provider: 'codex' | 'claude') => async () => ({ provider, mode: 'auto' as const, path: 'direct' as const, proxy: null, loc: 'FI', ok: true, reason: 'ok' as const, fellBack: false, guard: ['RU'], attempts: [], ms: 1, checkedAt: '2026-11-05T10:00:00.000Z', cached: false })
const lines = (file: string): Array<Record<string, any>> => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []

it('Codex sends native images and resets Fast to Normal on the actual wire, preserving turn snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-cx-native-')), paths = layout(join(dir, 'h')), cwd = join(dir, 'work')
  ensureLayout(paths); mkdirSync(cwd); const logOut = join(dir, 'wire.jsonl')
  writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'simple', speed: 0, logOut }))
  const day = join(paths.attachments, 'w', '2026-11-05'); mkdirSync(day, { recursive: true }); const file = join(day, 'shot.png'); writeFileSync(file, PNG)
  const attachment: PromptAttachment = { path: file, name: 'shot.png', bytes: PNG.length, mime: 'image/png', kind: 'file' }
  const adapter = createCodexAdapter({ paths, config: defaultConfig(), logger: createLogger(paths.logFile), bin: FAKE_CODEX, emit() {}, askPermission: async () => ({ behavior: 'deny' }), netCheck: check('codex'), schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'test' }) })
  try {
    await adapter.startSession({ name: 'w', cwd, mode: 'turn', broker: false, serviceTier: 'fast' })
    assert.equal((await (await adapter.send('w', 'Посмотри', { serviceTier: 'fast', attachments: [attachment] })).done).ok, true)
    adapter.configure?.('w', { serviceTier: 'default' })
    assert.equal((await (await adapter.send('w', 'Normal')).done).ok, true)
    assert.equal((await (await adapter.send('w', 'snapshot', { serviceTier: 'fast' })).done).ok, true)
    const requests = lines(logOut).filter((r) => r.ev === 'client').map((r) => r.msg)
    assert.equal(requests.find((r) => r.method === 'thread/start').params.serviceTier, 'fast')
    const turns = requests.filter((r) => r.method === 'turn/start')
    assert.deepEqual(turns.map((r) => r.params.serviceTier), ['fast', 'default', 'fast'])
    assert.deepEqual(turns[0].params.input.slice(0, 2), [{ type: 'text', text: 'Посмотри' }, { type: 'localImage', path: file }])
    assert.ok(!JSON.stringify(turns[0].params.input[0]).includes(file))
  } finally { await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }) }
})

it('Claude sends native base64 through stdin, without persisting it in journal events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-cl-native-')), paths = layout(join(dir, 'h')), cwd = join(dir, 'work')
  ensureLayout(paths); mkdirSync(cwd); const stdinOut = join(dir, 'stdin.jsonl')
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, stdinOut }))
  const day = join(paths.attachments, 'w', '2026-11-05'); mkdirSync(day, { recursive: true }); const file = join(day, 'shot.png'); writeFileSync(file, PNG)
  const attachment: PromptAttachment = { path: file, name: 'shot.png', bytes: PNG.length, mime: 'image/png', kind: 'file' }
  const events: EventDraft[] = []
  const adapter = createClaudeAdapter({ paths, config: defaultConfig(), logger: createLogger(paths.logFile), bin: FAKE_CLAUDE, emit: (e) => events.push(e), askPermission: async () => ({ behavior: 'deny' }), netCheck: check('claude') })
  try {
    await adapter.startSession({ name: 'w', cwd, mode: 'turn', broker: false })
    assert.equal((await (await adapter.send('w', 'Посмотри', { attachments: [attachment] })).done).ok, true)
    const user = lines(stdinOut).find((r) => r.type === 'user')!
    assert.deepEqual(user.message.content.slice(0, 2), [{ type: 'text', text: 'Посмотри' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }])
    assert.ok(!JSON.stringify(events).includes(PNG.toString('base64')))
  } finally { await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }) }
})
