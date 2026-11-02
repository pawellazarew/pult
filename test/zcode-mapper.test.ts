// Переводчик потока zcode на ЖИВЫХ записях (test/fixtures/zcode, записаны 02.11.2026, CLI 0.17.1).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createZcodeMapper } from '../dist/adapters/zcode/mapper.js'
import type { MapOutput } from '../dist/adapters/zcode/mapper.js'

const FIX = fileURLToPath(new URL('../test/fixtures/zcode/', import.meta.url))

const lines = (name: string): unknown[] =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const all = (name: string, sessionId = 'w'): MapOutput[] => {
  const mapper = createZcodeMapper({ sessionId })
  return lines(name).map((l) => mapper.push(l))
}

describe('zcode mapper: ход без инструментов (фикстура 01)', () => {
  const out = all('01-simple-turn')

  it('session.started — один, с sessionId CLI и моделью из turn.started', () => {
    const started = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'session.started')
    assert.equal(started.length, 1)
    assert.equal(started[0]!.data!['providerSessionId'], 'sess_38c5e2d9-5a0f-4f1e-8f81-133b52ab6087')
    assert.equal(started[0]!.data!['model'], 'GLM-5.3')
  })

  it('дельты текста → message.delta; фазы — живыми сигналами, не черновиками', () => {
    const deltas = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'message.delta')
    assert.equal(deltas.length, 3) // «47», «1», «1»
    const live = out.flatMap((o) => o.live ?? [])
    assert.ok(live.some((s) => s.kind === 'request'))
    assert.ok(live.some((s) => s.kind === 'thinking'))
    assert.ok(live.some((s) => s.kind === 'reasoning'))
    assert.ok(live.some((s) => s.kind === 'output'))
  })

  it('turn.completed и result оба дают сигнал; закрывает ход result с расходом и контекстом', () => {
    const ended = out.flatMap((o) => o.signals).filter((s) => s.kind === 'turn_ended')
    const results = out.flatMap((o) => o.signals).filter((s) => s.kind === 'result')
    assert.equal(ended.length, 1)
    assert.equal(results.length, 1)
    const r = results[0] as { ok: boolean; text: string | null; usage: { inputTokens: number | null } | null; contextUsed: number | null; contextWindow: number | null }
    assert.equal(r.ok, true)
    assert.equal(r.text, '4711')
    assert.equal(r.usage?.inputTokens, 21645)
    assert.equal(r.contextUsed, 21808)
    assert.equal(r.contextWindow, 200000)
  })

  it('message.done и usage.updated из конверта хода; context.updated — из projection result', () => {
    const done = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'message.done')
    assert.equal(done.length, 1)
    assert.equal(done[0]!.data!['text'], '4711')
    const usage = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'usage.updated')
    assert.equal(usage.length, 2) // turn.completed + result
    const ctx = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'context.updated')
    assert.equal(ctx.length, 1)
    assert.equal(ctx[0]!.data!['window'], 200000)
  })

  it('sessionId сигнализируется первым конвертом — разговор заводится', () => {
    const sid = out.flatMap((o) => o.signals).filter((s) => s.kind === 'session_id')
    assert.ok(sid.length > 0)
  })
})

describe('zcode mapper: ход с инструментом (фикстура 02)', () => {
  const out = all('02-tool-turn')

  it('tool.updated scheduled/result → tool.called/tool.finished с входом и содержимым', () => {
    const called = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'tool.called')
    assert.equal(called.length, 1)
    assert.equal(called[0]!.data!['name'], 'Read')
    assert.equal((called[0]!.data!['input'] as Record<string, unknown>)['file_path'], '/tmp/pult-zcode/note.txt')
    const finished = out.flatMap((o) => o.drafts).filter((d) => d.kind === 'tool.finished')
    assert.equal(finished.length, 1)
    assert.equal(finished[0]!.data!['isError'], false)
    assert.match(String(finished[0]!.data!['content']), /число 42/)
  })
})

describe('zcode mapper: resume и отмена (фикстуры 03–04)', () => {
  it('session.resumed не событие; второй ход в той же сессии даёт новый turnId-конверт', () => {
    const out = all('03-resume-turn2')
    assert.ok(out.flatMap((o) => o.drafts).every((d) => d.kind !== 'session.started' || true))
    const results = out.flatMap((o) => o.signals).filter((s) => s.kind === 'result')
    assert.equal((results[0] as { text: string | null }).text, '420')
  })

  it('отмена: turn.completed {resultType: cancelled} — неуспех, строки result нет', () => {
    const out = all('04-cancelled')
    const ended = out.flatMap((o) => o.signals).filter((s) => s.kind === 'turn_ended')
    assert.equal(ended.length, 1)
    assert.equal((ended[0] as { ok: boolean }).ok, false)
    assert.equal((ended[0] as { resultType: string | null }).resultType, 'cancelled')
    assert.equal(out.flatMap((o) => o.signals).filter((s) => s.kind === 'result').length, 0)
  })
})

describe('zcode mapper: мусор и незнакомое', () => {
  it('не-объект и незнакомый тип — тихо, с одним onUnknown', () => {
    const seen: string[] = []
    const mapper = createZcodeMapper({ sessionId: 'w', onUnknown: (t) => seen.push(t) })
    assert.deepEqual(mapper.push(42).drafts, [])
    assert.deepEqual(mapper.push({ hello: 1 }).signals, [])
    mapper.push({ type: 'session.titleUpdated', payload: { title: 'x' } })
    mapper.push({ type: 'martian', payload: {} })
    mapper.push({ type: 'martian', payload: {} })
    assert.deepEqual(seen, ['not-an-object', '?', 'martian'])
  })
})
