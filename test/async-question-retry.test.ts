import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { PultEvent } from '../dist/core/events.js'
import { startTestDaemon, tempHome } from './helpers.js'

for (const failure of ['startFails', 'turnStartFails']) it(`idle async question: ${failure} keeps the answer retryable after daemon restart`, async () => {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'pt-async-retry-'))
  const fakeConfig = join(home.paths.home, '.pult-fake-codex.json')
  writeFileSync(fakeConfig, JSON.stringify({ [failure]: true, speed: 0 }))
  let daemon = await startTestDaemon(home)
  let client = await connectClient(home.paths)
  try {
    await client.request('agent.start', { name: 'retry-question', kind: 'codex', cwd })
    const question = daemon.emit({ sessionId: 'retry-question', provider: 'codex', kind: 'message.done', data: {
      itemId: 'idle-question', text: 'Which color?', questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }],
    } })
    const answer = { name: 'retry-question', questionId: question.id, answers: ['Blue'] }
    await assert.rejects(client.request('agent.question.answer', answer), /thread\/start|запрещён|turn\/start rejected/)
    const history = await client.request('agent.read', { name: 'retry-question', format: 'json' }) as { events: PultEvent[] }
    assert.ok(!history.events.some(event => event.kind === 'message.user' && event.data['questionId'] === question.id),
      'a rejected start must not persist an accepted answer or disable the question form')

    client.close()
    await daemon.stop('restart with a repaired provider')
    writeFileSync(fakeConfig, JSON.stringify({ startFails: false, speed: 0 }))
    daemon = await startTestDaemon(home)
    client = await connectClient(home.paths)
    const accepted = await client.request('agent.question.answer', answer) as { turnId: string }
    assert.ok(accepted.turnId)
    const replay = await client.request('agent.read', { name: 'retry-question', format: 'json' }) as { events: PultEvent[] }
    assert.equal(replay.events.filter(event => event.kind === 'message.user' && event.data['questionId'] === question.id).length, 1)
  } finally {
    client.close()
    await daemon.stop('test complete')
    home.remove()
    rmSync(cwd, { recursive: true, force: true })
  }
})
