import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { PultEvent } from '../dist/core/events.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'

async function rig(config: Record<string, unknown> = {}) {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'pt-queue-send-'))
  writeFileSync(join(home.paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'hang', speed: 0, logOut: join(home.paths.home, 'fake-log.jsonl'), ...config }))
  const daemon = await startTestDaemon(home)
  const c = await connectClient(home.paths)
  await c.request('agent.start', { name: 'q', kind: 'codex', cwd })
  const initial = await c.request('agent.prompt', { name: 'q', text: 'initial' }) as { turnId: string }
  const ids: string[] = []
  for (const text of ['one', 'two', 'three']) ids.push((await c.request('agent.prompt', { name: 'q', text, queue: true }) as { id: string }).id)
  const record = async () => ((await c.request('agent.list')) as { sessions: Array<{ name: string; lastStatus: string; queue?: Array<{ id: string; text: string }>; queuePaused?: boolean }> }).sessions.find(s => s.name === 'q')!
  const events = async () => ((await c.request('agent.read', { name: 'q', format: 'json' })) as { events: PultEvent[] }).events
  const close = async () => { c.close(); await daemon.stop('test complete'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  return { home, cwd, daemon, c, initial, ids, record, events, close }
}

describe('send a selected queued message immediately', () => {
  it('steers the active Codex turn and removes only the accepted item', async () => {
    const r = await rig()
    try {
      const result = await r.c.request('agent.queue.send', { name: 'q', id: r.ids[1] }) as { turnId: string }
      assert.equal(result.turnId, r.initial.turnId)
      assert.equal((await r.record()).lastStatus, 'working')
      assert.deepEqual((await r.record()).queue?.map(i => i.text), ['one', 'three'])
      const sent = (await r.events()).filter(e => e.kind === 'message.user' && e.data['text'] === 'two')
      assert.equal(sent.length, 1)
      assert.equal(sent[0]!.data['steering'], true)
      await assert.rejects(r.c.request('agent.queue.send', { name: 'q', id: r.ids[1] }), (e: { code?: string }) => e.code === 'queue_item_sent')
    } finally { await r.close() }
  })
  it('a rejected steering leaves the message and its position unchanged', async () => {
    const r = await rig({ rejectSteer: true })
    try {
      await assert.rejects(r.c.request('agent.queue.send', { name: 'q', id: r.ids[1] }), /steering rejected/)
      assert.deepEqual((await r.record()).queue?.map(i => i.text), ['one', 'two', 'three'])
      assert.equal((await r.record()).queuePaused, true, 'a rejected/uncertain delivery must wait for a human instead of being sent again automatically')
      assert.equal((await r.record()).lastStatus, 'working')
      assert.ok(!(await r.events()).some(e => e.kind === 'message.user' && e.data['text'] === 'two'))
    } finally { await r.close() }
  })
  it('reserves the sending item against concurrent edits and deletion; other reorders survive', async () => {
    const r = await rig({ steerDelayMs: 400 })
    try {
      const sending = r.c.request('agent.queue.send', { name: 'q', id: r.ids[1] })
      assert.ok(await waitFor(() => readFileSync(join(r.home.paths.home, 'fake-log.jsonl'), 'utf8').includes('\"method\":\"turn/steer\"')))
      for (const [method, extra] of [['agent.queue.remove', {}], ['agent.queue.move', { text: 'changed' }], ['agent.queue.move', { to: 0 }], ['agent.queue.move', { hold: true }]] as const) {
        await assert.rejects(r.c.request(method, { name: 'q', id: r.ids[1], ...extra }), /отправля/)
      }
      await r.c.request('agent.queue.move', { name: 'q', id: r.ids[2], to: 0 })
      await sending
      assert.deepEqual((await r.record()).queue?.map(i => i.text), ['three', 'one'])
    } finally { await r.close() }
  })
  it('sends the chosen item from a paused idle queue without resuming the remaining messages', async () => {
    const r = await rig()
    try {
      await r.c.request('agent.stop', { name: 'q' })
      const result = await r.c.request('agent.queue.send', { name: 'q', id: r.ids[1] }) as { turnId: string }
      assert.notEqual(result.turnId, r.initial.turnId)
      assert.equal((await r.record()).lastStatus, 'working')
      assert.equal((await r.record()).queuePaused, true)
      assert.deepEqual((await r.record()).queue?.map(i => i.text), ['one', 'three'])
    } finally { await r.close() }
  })
  it('recovers an accepted item after a crash before queue persistence, without confusing a reused short id', async () => {
    const r = await rig()
    let restarted: Awaited<ReturnType<typeof startTestDaemon>> | undefined
    let replay: Awaited<ReturnType<typeof connectClient>> | undefined
    try {
      const old = (await r.record()).queue!.find(item => item.id === r.ids[1])!
      await r.c.request('agent.queue.send', { name: 'q', id: old.id })
      r.c.close(); await r.daemon.stop('simulate restart after receipt')
      const disk = JSON.parse(readFileSync(r.home.paths.sessions, 'utf8')) as { sessions: Array<{ name: string; queue?: unknown[] }> }
      disk.sessions.find(s => s.name === 'q')!.queue!.push(old)
      writeFileSync(r.home.paths.sessions, JSON.stringify(disk))
      restarted = await startTestDaemon(r.home)
      replay = await connectClient(r.home.paths)
      const record = ((await replay.request('agent.list')) as { sessions: Array<{ name: string; queue: Array<{ text: string }> }> }).sessions.find(s => s.name === 'q')!
      assert.deepEqual(record.queue.map(item => item.text), ['one', 'three'])
      replay.close(); await restarted.stop('restart with a legitimately reused id')
      const nextDisk = JSON.parse(readFileSync(r.home.paths.sessions, 'utf8')) as typeof disk
      nextDisk.sessions.find(s => s.name === 'q')!.queue!.push({ ...old, at: '2099-01-01T00:00:00.000Z', text: 'a new item reusing the short id' })
      writeFileSync(r.home.paths.sessions, JSON.stringify(nextDisk))
      restarted = await startTestDaemon(r.home)
      replay = await connectClient(r.home.paths)
      const nextRecord = ((await replay.request('agent.list')) as { sessions: Array<{ name: string; queue: Array<{ text: string }> }> }).sessions.find(s => s.name === 'q')!
      assert.deepEqual(nextRecord.queue.map(item => item.text), ['one', 'three', 'a new item reusing the short id'])
    } finally { replay?.close(); await restarted?.stop('test complete'); await r.close() }
  })

})
