import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createClaudeMapper } from '../../src/adapters/claude/mapper.js'
import type { PultEvent } from '../src/model/types.js'
import type { AgentItem, ConvItem, ModelItem, NoticeItem, PermItem, ToolItem } from '../src/model/conversation.js'
import { reconcileAsyncAnswers, applyConversation, countItems, EMPTY_CONVERSATION, foldConversation, resultText, toolSummary } from '../src/model/conversation.js'

let seq = 0
const ev = (kind: string, data: Record<string, unknown> = {}, over: Partial<PultEvent> = {}): PultEvent => ({
  id: ++seq, ts: `2026-09-28T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, sessionId: 'w', provider: 'claude',
  kind: kind as PultEvent['kind'], data, ...over,
})

describe('лента разговора: свёртка событий', () => {
  it('реплика человека, дельты и окончательный текст — одна реплика модели', () => {
    const c = foldConversation([
      ev('message.user', { text: 'привет' }),
      ev('status.changed', { status: 'working', turnId: 't1' }),
      ev('message.delta', { text: 'При', index: 0 }),
      ev('message.delta', { text: 'вет!', index: 0 }),
    ])
    assert.equal(c.items.length, 2)
    const m = c.items[1] as ModelItem
    assert.equal(m.type, 'model')
    assert.equal(m.text, 'Привет!')
    assert.equal(m.streaming, true)
    const done = applyConversation(c, ev('message.done', { text: 'Привет! Чем помочь?' }))
    assert.equal(done.items.length, 2, 'done не заводит вторую реплику')
    assert.deepEqual([(done.items[1] as ModelItem).text, (done.items[1] as ModelItem).streaming], ['Привет! Чем помочь?', false])
  })

  it('повтор и старое событие не меняют ленту (тот же объект)', () => {
    const e = ev('message.user', { text: 'x' })
    const c = applyConversation(EMPTY_CONVERSATION, e)
    assert.equal(applyConversation(c, e), c)
  })

  it('codex: дельты разных itemId не склеиваются, done находит свою реплику', () => {
    const c = foldConversation([
      ev('message.delta', { text: 'план: ', itemId: 'a' }, { provider: 'codex' }),
      ev('message.done', { text: 'план: готов', itemId: 'a' }, { provider: 'codex' }),
      ev('message.delta', { text: 'ответ', itemId: 'b' }, { provider: 'codex' }),
      ev('message.done', { text: 'ответ полностью', itemId: 'b' }, { provider: 'codex' }),
    ])
    assert.deepEqual(c.items.map((i) => (i as ModelItem).text), ['план: готов', 'ответ полностью'])
  })

  it('инструмент: called → finished раскрывается результатом, ошибка отмечается', () => {
    const c = foldConversation([
      ev('tool.called', { toolUseId: 'u1', name: 'Read', input: { file_path: '/p/a.ts' } }),
      ev('tool.called', { toolUseId: 'u2', name: 'Bash', input: { command: 'npm test' } }),
      ev('tool.finished', { toolUseId: 'u1', isError: false, content: [{ type: 'text', text: '1\tconst a = 1' }] }),
      ev('tool.finished', { toolUseId: 'u2', isError: true, content: 'exit 1' }),
    ])
    const [a, b] = c.items as ToolItem[]
    assert.deepEqual([a?.state, a?.result, b?.state, b?.result], ['ok', '1\tconst a = 1', 'error', 'exit 1'])
    assert.equal(toolSummary('Read', a!.input), '/p/a.ts')
    assert.equal(toolSummary('Grep', { pattern: 'formatPct', path: 'ui/src' }), 'formatPct  в ui/src')
    assert.equal(toolSummary('commandExecution', { command: ['/bin/zsh', '-lc', 'ls'] }), '/bin/zsh -lc ls')
  })

  it('субагент: события с parentId ложатся внутрь блока, вложенность любой глубины', () => {
    const c = foldConversation([
      ev('agent.spawned', { toolUseId: 'A', name: 'Agent', subagentType: 'Explore', description: 'найти вызовы' }),
      ev('tool.called', { toolUseId: 'g1', name: 'Grep', input: { pattern: 'fetchLimits' } }, { parentId: 'A' }),
      ev('agent.spawned', { toolUseId: 'B', subagentType: 'general' }, { parentId: 'A' }),
      ev('message.done', { text: 'глубоко' }, { parentId: 'B' }),
      ev('tool.finished', { toolUseId: 'g1', isError: false }, { parentId: 'A' }),
      ev('agent.finished', { toolUseId: 'B', isError: false }, { parentId: 'A' }),
      ev('message.done', { text: 'нашёл 3 вызова' }, { parentId: 'A' }),
      ev('message.done', { text: 'Итог наверху' }),
    ])
    assert.equal(c.items.length, 2, 'наверху: блок субагента и итог')
    const a = c.items[0] as AgentItem
    assert.equal(a.type, 'agent')
    assert.equal(a.state, 'running', 'agent.finished для A не приходил')
    assert.deepEqual(a.items.map((i) => i.type), ['tool', 'agent', 'model'])
    assert.equal((a.items[0] as ToolItem).state, 'ok')
    const b = a.items[1] as AgentItem
    assert.equal(b.state, 'ok')
    assert.equal((b.items[0] as ModelItem).text, 'глубоко')
    assert.equal(countItems(c.items), 6)
  })

  it('сирота (parentId без блока) не теряется — ложится в корень', () => {
    const c = foldConversation([ev('message.done', { text: 'я сирота' }, { parentId: 'нет-такого' })])
    assert.equal((c.items[0] as ModelItem).text, 'я сирота')
  })

  it('разрешение: карточка в ленте, решение меняет её состояние', () => {
    const c = foldConversation([
      ev('permission.requested', { id: 'p1', toolName: 'Edit', toolUseId: 'u9', input: { file_path: '/a' } }, { provider: 'pult' }),
      ev('permission.resolved', { id: 'p1', decision: 'deny', by: 'human', message: 'не трогай' }, { provider: 'pult' }),
    ])
    const p = c.items[0] as PermItem
    assert.deepEqual([p.type, p.state, p.by, p.message], ['perm', 'deny', 'human', 'не трогай'])
  })

  it('провалы: страж, остановка провайдера, лимит, текст причины; без дублей', () => {
    const c = foldConversation([
      ev('net.blocked', { reason: 'blocked_country', loc: 'RU', guard: ['RU', 'BY'] }),
      ev('status.changed', { status: 'failed', reason: 'net_blocked' }),
      ev('provider.blocked', { provider: 'claude', text: 'disabled Claude subscription access' }),
      ev('status.changed', { status: 'failed', turnId: 't', errorCode: 'provider_unavailable', message: 'disabled Claude subscription access' }),
      ev('limit.hit', { resetsAt: 1790011200, rateLimitType: 'five_hour' }),
      ev('message.user', { text: 'ещё раз' }),
      ev('status.changed', { status: 'failed', turnId: 't2', errorCode: 'internal', message: 'claude вышел без result' }),
      ev('status.changed', { status: 'interrupted' }),
    ])
    const notices = c.items.filter((i): i is NoticeItem => i.type === 'notice')
    assert.deepEqual(notices.map((n) => [n.tone, n.title]), [
      ['fail', 'Сеть заблокирована стражем — страна выхода в списке-страже'],
      ['fail', 'Провайдер claude остановлен целиком'],
      ['wait', 'Лимит claude исчерпан (five_hour)'],
      ['fail', 'Ход не удался'],
      ['info', 'Ход остановлен'],
    ])
    assert.match(notices[0]!.text!, /выход: RU · страж: RU, BY — подними VPN/)
    assert.equal(notices[2]!.resetsAt, 1790011200)
    assert.equal(notices[3]!.text, 'claude вышел без result')
  })

  it('конец хода (готов, стоп, провал) гасит «печатает» у незакрытой реплики, и во вложенном блоке тоже', () => {
    for (const status of ['idle', 'interrupted', 'failed']) {
      const c = foldConversation([
        ev('agent.spawned', { toolUseId: 'A' }),
        ev('message.delta', { text: 'обрыв' }, { parentId: 'A' }),
        ev('status.changed', { status, turnId: 't' }),
      ])
      assert.equal(((c.items[0] as AgentItem).items[0] as ModelItem).streaming, false, status)
    }
  })

  it('стоп и провал хода гасят спиннеры незакрытых инструментов и субагентов; обычный конец — нет', () => {
    for (const status of ['interrupted', 'failed']) {
      const c = foldConversation([
        ev('agent.spawned', { toolUseId: 'A', subagentType: 'Explore' }),
        ev('tool.called', { toolUseId: 'u1', name: 'Read', input: {} }, { parentId: 'A' }),
        ev('tool.called', { toolUseId: 'u2', name: 'Bash', input: {} }),
        ev('tool.called', { toolUseId: 'u3', name: 'Grep', input: {} }),
        ev('tool.finished', { toolUseId: 'u3', isError: false, content: 'ok' }),
        ev('status.changed', { status, turnId: 't' }),
      ])
      const a = c.items[0] as AgentItem
      assert.deepEqual([a.state, (a.items[0] as ToolItem).state, (c.items[1] as ToolItem).state, (c.items[2] as ToolItem).state],
        ['stopped', 'stopped', 'stopped', 'ok'], status)
      assert.ok(a.endTs, 'время конца проставлено')
    }
    const idle = foldConversation([ev('tool.called', { toolUseId: 'u', name: 'Read', input: {} }), ev('status.changed', { status: 'idle', turnId: 't' })])
    assert.equal((idle.items[0] as ToolItem).state, 'running', 'idle инструменты не трогает — их закрывает свой конец')
  })

  it('resultText: строки и блоки, обрезка', () => {
    assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(resultText('x'.repeat(10), 4), 'xxxx…')
    assert.equal(resultText(null), undefined)
  })
})

describe('лента разговора на настоящем потоке Claude (фикстура 06, субагент)', () => {
  it('Agent → блок субагента с его ответом внутри, итог хода — снаружи', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const file = new URL('../test/fixtures/claude/06-subagent.jsonl', import.meta.url)
    const events: PultEvent[] = []
    let id = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      for (const d of mapper.push(JSON.parse(line)).drafts) {
        events.push({ id: ++id, ts: '2026-09-21T10:00:00.000Z', ...d, data: d.data ?? {} } as PultEvent)
      }
    }
    const c = foldConversation(events)
    const agent = c.items.find((i): i is AgentItem => i.type === 'agent')
    assert.ok(agent, 'блок субагента есть')
    assert.equal(agent.subagentType, 'Explore')
    assert.equal(agent.state, 'ok')
    assert.ok(agent.items.some((i: ConvItem) => i.type === 'model' && i.text === 'OK'), 'ответ субагента внутри блока')
    const top = c.items.filter((i): i is ModelItem => i.type === 'model').map((m) => m.text)
    assert.deepEqual(top.slice(-1), ['DONE'])
    assert.ok(!top.includes('OK'), 'ответ субагента не вылез наверх')
  })
})

describe('длительность инструмента', () => {
  it('десятичная запятая, как во всём русском интерфейсе', async () => {
    const { formatSeconds } = await import('../src/model/conversation.js')
    assert.equal(formatSeconds(300), '0,3 с')
    assert.equal(formatSeconds(15_300), '15,3 с')
  })
})

describe('лента: предупреждение о лимите — не «исчерпан»', () => {
  it('старый limit.hit c allowed_warning — «израсходован на 75% — работать можно»; настоящий — «исчерпан»', () => {
    const warn = applyConversation(EMPTY_CONVERSATION, ev('limit.hit', {
      status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: 1791687600,
      windows: { five_hour: { utilization: 0.12 }, seven_day: { utilization: 0.75 } },
    }))
    const n = warn.items[0] as NoticeItem
    assert.equal(n.title, 'Лимит claude на неделю израсходован на 75% — работать можно')
    const hard = applyConversation(EMPTY_CONVERSATION, ev('limit.hit', { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1791687600 }))
    assert.match((hard.items[0] as NoticeItem).title, /исчерпан/)
  })
})


describe('Codex async questions in conversation replay', () => {
  it('metadata survives delta replacement and answered state survives full replay', () => {
    const delta = ev('message.delta', { text: 'Choose', itemId: 'q-async' })
    const done = ev('message.done', { text: 'Choose?', itemId: 'q-async', questions: [{ title: 'Choose?', options: ['A', 'B'] }] })
    const c = foldConversation([delta, done])
    const question = c.items[0] as ModelItem
    assert.equal(question.id, delta.id)
    assert.equal(question.questionEventId, done.id)
    assert.deepEqual(question.questions, [{ title: 'Choose?', options: ['A', 'B'] }])
    const answered = foldConversation([delta, done, ev('message.user', { text: 'Choose?\nA', questionId: done.id })])
    assert.equal((answered.items[0] as ModelItem).questionAnswered, true)
  })
  it('subagent async questions remain text until thread routing exists', () => {
    const c = foldConversation([ev('message.done', { text: 'Subagent question', questions: [{ title: 'Choose?', options: null }] }, { parentId: 'child' })])
    assert.ok(!c.items.some(it => it.type === 'model' && it.questions?.length))
  })
})


it('reconciles async question replies from a separate history page', () => {
  const question = ev('message.done', { text: 'Choose?', questions: [{ title: 'Choose?', options: ['A'] }] })
  const before = foldConversation([question])
  const after = foldConversation([ev('message.user', { text: 'A', questionId: question.id })])
  const combined = reconcileAsyncAnswers([...before.items, ...after.items])
  assert.equal((combined[0] as ModelItem).questionAnswered, true)
})
