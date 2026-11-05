import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { PultEvent } from '../dist/core/events.js'
import type { PromptAttachment } from '../dist/core/promptAttachments.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { startTestDaemon, tempHome } from './helpers.js'

function picture(home: string, name: string): PromptAttachment {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=', 'base64')
  const dir = join(home, 'attachments', name, '2026-11-05')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'picture.png')
  writeFileSync(path, bytes)
  return { path, name: 'Снимок.png', bytes: bytes.length, mime: 'image/png', kind: 'file' }
}
type Rec = { name: string; cwd: string; serviceTier?: string; queue?: Array<{ id: string; text: string; attachments?: PromptAttachment[] }>; queuePaused?: boolean; phase?: string; promptSent?: boolean; promptDiffers?: boolean }

describe('structured attachment RPC', () => {
  it('image-only first prompt is delivered once; history stores text and metadata separately', async () => {
    const home = tempHome(), daemon = await startTestDaemon(home), c = await connectClient(home.paths, { client: 'shell' })
    try {
      const requestId = randomUUID(), base = { requestId, scope: 'general', kind: 'claude' }
      const reserved = await c.request('agent.start', { ...base, reserveOnly: true }) as Rec
      const attachment = picture(home.paths.home, reserved.name)
      const params = { ...base, prompt: '', attachments: [attachment] }
      const first = await c.request('agent.start', params) as Rec
      assert.equal(first.promptSent, true)
      await c.request('agent.wait', { name: first.name, timeoutMs: 10_000 })
      assert.equal((await c.request('agent.start', params) as Rec).name, first.name)
      const changed = await c.request('agent.start', { ...params, attachments: [{ ...attachment, name: 'переименован.png' }] }) as Rec
      assert.equal(changed.promptDiffers, true)
      const history = await c.request('agent.read', { name: first.name, format: 'json' }) as { events: PultEvent[] }
      const users = history.events.filter((e) => e.kind === 'message.user')
      assert.equal(users.length, 1)
      assert.equal(users[0]?.data['text'], '')
      assert.deepEqual(users[0]?.data['attachments'], [attachment])
      assert.equal(JSON.stringify(users[0]).includes('base64'), false)
      await assert.rejects(c.request('agent.prompt', { name: first.name, text: 'wrong owner', attachments: [{ ...attachment, path: join(home.paths.home, 'outside.png') }] }), (e: { code?: string }) => e.code === 'invalid_params')
      const after = await c.request('agent.read', { name: first.name, format: 'json' }) as { events: PultEvent[] }
      assert.equal(after.events.filter((e) => e.kind === 'message.user').length, 1, 'invalid metadata does not create a user message')
    } finally { c.close(); await daemon.stop('end'); home.remove() }
  })

  it('queue Send now preserves native images and normal/fast selection reaches Codex', async () => {
    const home = tempHome()
    const log = join(home.paths.home, 'fake-log.jsonl')
    writeFileSync(join(home.paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'hang', speed: 0, logOut: log }))
    const daemon = await startTestDaemon(home), c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'chat', scope: 'general', kind: 'codex', serviceTier: 'fast' })
      const initial = await c.request('agent.prompt', { name: 'chat', text: 'work' }) as { turnId: string }
      const attachment = picture(home.paths.home, 'chat')
      const queued = await c.request('agent.prompt', { name: 'chat', text: '', attachments: [attachment], queue: true }) as { id: string }
      const edit = await c.request('agent.queue.move', { name: 'chat', id: queued.id, hold: true }) as { edit: { text: string; attachments: PromptAttachment[] } }
      assert.deepEqual(edit.edit.attachments, [attachment])
      assert.equal(edit.edit.text, '')
      await c.request('agent.queue.move', { name: 'chat', id: queued.id, text: '' })
      const saved = parseSessions(JSON.parse(readFileSync(home.paths.sessions, 'utf8'))).find((r) => r.name === 'chat')!
      assert.deepEqual(saved.queue?.[0]?.attachments, [attachment])
      const sent = await c.request('agent.queue.send', { name: 'chat', id: queued.id }) as { turnId: string }
      assert.equal(sent.turnId, initial.turnId)
      const requests = readFileSync(log, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as { msg?: { method: string; params: Record<string, unknown> } }).map((x) => x.msg).filter(Boolean)
      const start = requests.find((x) => x?.method === 'turn/start')!
      assert.equal(start.params['serviceTier'], 'fast')
      const steer = requests.find((x) => x?.method === 'turn/steer')!
      assert.deepEqual(steer.params['input'], [{ type: 'localImage', path: attachment.path }])
      const configured = await c.request('agent.configure', { name: 'chat', serviceTier: 'default' }) as Rec
      assert.equal(configured.serviceTier, 'default')
      await c.request('agent.start', { name: 'claude', scope: 'general', kind: 'claude' })
      await assert.rejects(c.request('agent.configure', { name: 'claude', serviceTier: 'fast' }), (e: { code?: string }) => e.code === 'invalid_params')
    } finally { c.close(); await daemon.stop('end'); home.remove() }
  })
})
