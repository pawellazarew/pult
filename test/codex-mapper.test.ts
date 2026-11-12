// Переводчик Codex на ЗАПИСАННЫХ потоках. Чистый тест: ни процессов, ни сети, ни файлов
// кроме самих фикстур. Здесь проверяется то, во что превращается сырой протокол, — и
// фикстуры тут настоящие, снятые спайком 20.09.2026 и пробой В3 21.09.2026.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { EventDraft } from '../dist/core/events.js'
import { createCodexMapper, errorInfoName, LIMIT_ERROR_INFO, NO_ROLLOUT_RE, USAGE_LIMIT_RE } from '../dist/adapters/codex/mapper.js'
import type { CodexSignal } from '../dist/adapters/codex/mapper.js'

const FIXTURES = fileURLToPath(new URL('../test/fixtures/codex/', import.meta.url))

interface Raw { method: string; params: Record<string, unknown>; id?: number }

function load(name: string): Raw[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw)
}

interface Played {
  drafts: EventDraft[]
  signals: CodexSignal[]
  unknown: string[]
  /** Запросы сервера к клиенту, встреченные в записи (переводчик их не разбирает). */
  serverRequests: Raw[]
  /** Строки, выброшенные из-за незнакомого треда — ровно то, что делает демультиплексор. */
  dropped: Raw[]
}

/**
 * Проигрывает запись через переводчик ровно так, как это делает демультиплексор адаптера:
 * события СВОЕГО треда идут без родителя, события треда субагента — с `parentId` того узла,
 * который завела `subAgentActivity/started`.
 */
function play(name: string, ownThreadId?: string): Played {
  const raws = load(name)
  const own = ownThreadId ?? String((raws[0]?.params ?? {})['threadId'] ?? '')
  const unknown: string[] = []
  const mapper = createCodexMapper({ sessionId: 'w', onUnknown: (what) => unknown.push(what) })
  const out: Played = { drafts: [], signals: [], unknown, serverRequests: [], dropped: [] }
  const children = new Map<string, string>()
  for (const raw of raws) {
    if (raw.id !== undefined) { out.serverRequests.push(raw); continue }
    const threadId = String(raw.params['threadId'] ?? '')
    const parentId = children.get(threadId)
    if (threadId !== '' && threadId !== own && parentId === undefined) { out.dropped.push(raw); continue }
    const res = mapper.push(raw.method, raw.params, parentId !== undefined ? { parentId } : {})
    out.drafts.push(...res.drafts)
    out.signals.push(...res.signals)
    for (const sig of res.signals) {
      if (sig.kind === 'subagent_started') children.set(sig.agentThreadId, sig.nodeId)
    }
  }
  return out
}

const kinds = (p: Played): string[] => p.drafts.map((d) => d.kind)
const sigKinds = (p: Played): string[] => p.signals.map((s) => s.kind)
const texts = (p: Played): string[] => p.drafts.filter((d) => d.kind === 'message.done').map((d) => String((d.data as { text: string }).text))

describe('переводчик codex: обычный ход (фикстура 01, запись спайка B1)', () => {
  const p = play('01-simple-turn')

  it('дельта и готовый текст — из item/*, а НЕ из turn/completed', () => {
    assert.deepEqual(texts(p), ['OK'])
    const delta = p.drafts.find((d) => d.kind === 'message.delta')
    assert.equal((delta?.data as { text: string }).text, 'OK')
    // В turn/completed этой записи itemsView = "summary", но читать его мы всё равно не будем.
    assert.ok(!kinds(p).includes('tool.called'))
  })

  it('сигналы хода: начался и завершился успешно', () => {
    const started = p.signals.find((s) => s.kind === 'turn_started')
    assert.ok(started && started.kind === 'turn_started' && started.providerTurnId.length > 0)
    const done = p.signals.find((s) => s.kind === 'turn_completed')
    assert.ok(done && done.kind === 'turn_completed')
    assert.equal(done.status, 'completed')
    assert.equal(done.errorMessage, null)
  })

  it('расход токенов снимается с thread/tokenUsage/updated', () => {
    const tokens = p.signals.find((s) => s.kind === 'tokens')
    assert.ok(tokens && tokens.kind === 'tokens')
    assert.equal(tokens.input, 18632)
    assert.equal(tokens.output, 5)
  })

  it('шум записи (mcpServer/*, hook/*, account/updated, thread/status/changed) не переводится и не считается незнакомым', () => {
    assert.deepEqual(p.unknown, [])
    assert.ok(!kinds(p).some((k) => k === 'tool.called' || k === 'agent.spawned'))
  })
})

describe('переводчик codex: разрешения (фикстуры 02 и 03, записи спайка B2)', () => {
  it('ОТКАЗ: команда помечена ошибкой, ход всё равно завершён', () => {
    const p = play('02-permission-decline')
    assert.equal(p.serverRequests.length, 1)
    assert.equal(p.serverRequests[0]?.method, 'item/commandExecution/requestApproval')
    const called = p.drafts.find((d) => d.kind === 'tool.called')
    assert.equal((called?.data as { name: string }).name, 'commandExecution')
    assert.match(String((called?.data as { input: { command: string } }).input.command), /echo hi > x\.txt/)
    const finished = p.drafts.find((d) => d.kind === 'tool.finished')
    assert.equal((finished?.data as { isError: boolean }).isError, true)
    assert.equal((finished?.data as { status: string }).status, 'declined')
    const done = p.signals.find((s) => s.kind === 'turn_completed')
    assert.ok(done && done.kind === 'turn_completed' && done.status === 'completed', 'отказ НЕ проваливает ход')
  })

  it('РАЗРЕШЕНИЕ: команда выполнена, exitCode 0', () => {
    const p = play('03-permission-accept')
    const finished = p.drafts.find((d) => d.kind === 'tool.finished')
    assert.equal((finished?.data as { isError: boolean }).isError, false)
    assert.equal((finished?.data as { exitCode: number }).exitCode, 0)
  })

  it('availableDecisions записи — смешанный список: строки И объект', () => {
    const p = play('03-permission-accept')
    const offered = (p.serverRequests[0]?.params as { availableDecisions: unknown[] }).availableDecisions
    assert.deepEqual(offered.filter((d) => typeof d === 'string'), ['accept', 'cancel'])
    assert.ok(offered.some((d) => typeof d === 'object' && d !== null && 'acceptWithExecpolicyAmendment' in (d as object)))
  })
})

describe('переводчик codex: субагент (фикстура 04, запись спайка B4)', () => {
  const p = play('04-subagent')

  it('субагент заводит узел дерева, а закрывается по agentThreadId — у completed СВОЙ id', () => {
    const spawned = p.drafts.filter((d) => d.kind === 'agent.spawned')
    assert.equal(spawned.length, 1)
    const node = (spawned[0]?.data as { toolUseId: string; subagentType: string }).toolUseId
    assert.equal((spawned[0]?.data as { subagentType: string }).subagentType, '/root/ping')
    assert.match(node, /^call_/)
    const finished = p.drafts.filter((d) => d.kind === 'agent.finished')
    assert.equal(finished.length, 1)
    // Вот ради чего карта по треду: id у `completed` — `subagent-completed-<turnId>`.
    assert.equal((finished[0]?.data as { toolUseId: string }).toolUseId, node)
  })

  it('события ребёнка висят под узлом родителя (parentId), а не в корне', () => {
    const child = p.drafts.filter((d) => d.parentId !== undefined)
    assert.ok(child.length > 0, 'ребёнок обязан был приехать с parentId')
    assert.ok(child.some((d) => d.kind === 'message.done' && (d.data as { text: string }).text === 'PING'))
  })

  it('текст ответа хода — только СВОЙ тред: «PING» ребёнка в него не попадает', () => {
    const said = p.signals.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text)
    assert.ok(said.some((t) => t.includes('Subagent reply: PING')))
    assert.ok(!said.includes('PING'), `текст ребёнка просочился в ответ хода: ${JSON.stringify(said)}`)
  })

  it('collabAgentToolCall переводится в инструмент с именем из tool (`wait`)', () => {
    const wait = p.drafts.find((d) => d.kind === 'tool.called' && (d.data as { name: string }).name === 'wait')
    assert.ok(wait, 'вызов collabAgentToolCall не переведён')
    assert.ok(p.drafts.some((d) => d.kind === 'tool.finished' && (d.data as { name: string }).name === 'wait'))
  })

  it('тред ребёнка объявляет себя РАНЬШЕ subAgentActivity — первое его уведомление выбрасывается', () => {
    // ИЗМЕРЕНО (запись B4, строки 23–24): `thread/status/changed` ребёнка приходит ДО
    // `subAgentActivity/started`, то есть до того, как мы вообще узнаём о его существовании.
    // Демультиплексор его выбрасывает, и это правильно; в бою такого даже не случится —
    // `thread/status/changed` погашен через `optOutNotificationMethods`.
    assert.deepEqual(p.dropped.map((r) => r.method), ['thread/status/changed'])
  })

  it('ходы ребёнка НЕ считаются ходами родителя', () => {
    // В записи два turn/started и два turn/completed — родителя и ребёнка. Переводчик
    // отдаёт сигналы по обоим, а фильтрует их демультиплексор по `own`; здесь важно, что
    // сигналы не потерялись и не склеились.
    assert.equal(sigKinds(p).filter((k) => k === 'turn_started').length, 2)
    assert.equal(sigKinds(p).filter((k) => k === 'turn_completed').length, 2)
  })
})

describe('переводчик codex: сеть и лимиты', () => {
  it('шторм error/willRetry (фикстура 05, запись спайка S5) даёт сигналы retry и ни одного turn_completed', () => {
    const p = play('05-error-retry-storm')
    const retries = p.signals.filter((s) => s.kind === 'retry')
    assert.ok(retries.length >= 3, `ожидались хотя бы три повтора, получено ${retries.length}`)
    assert.match((retries[0] as { message: string }).message, /Reconnecting\.\.\. 2\/5/)
    assert.equal(sigKinds(p).filter((k) => k === 'turn_completed').length, 0)
  })

  it('лимит (фикстура 08) виден МАШИННО по codexErrorInfo, а не по английскому тексту', () => {
    const p = play('08-usage-limit-error')
    const limit = p.signals.find((s) => s.kind === 'limit')
    assert.ok(limit && limit.kind === 'limit')
    assert.equal(limit.info, 'usageLimitExceeded')
    assert.match(limit.message, /hit your usage limit/)
    // `willRetry: false` не превращается в retry: повторять нечего.
    assert.equal(sigKinds(p).filter((k) => k === 'retry').length, 0)
  })

  it('запасной признак лимита — текст, и он совпадает с измеренным', () => {
    assert.ok(USAGE_LIMIT_RE.test("You've hit your usage limit. Try again at Sep 22nd, 2026 12:23 AM."))
    assert.ok(LIMIT_ERROR_INFO.has('usageLimitExceeded') && LIMIT_ERROR_INFO.has('rateLimitExceeded'))
  })

  it('имя варианта codexErrorInfo вынимается и из строки, и из объекта', () => {
    assert.equal(errorInfoName('usageLimitExceeded'), 'usageLimitExceeded')
    assert.equal(errorInfoName({ responseStreamDisconnected: { httpStatusCode: null } }), 'responseStreamDisconnected')
    assert.equal(errorInfoName(null), null)
  })

  it('строка «no rollout found» узнаётся дословно — по ней работает самолечение', () => {
    assert.ok(NO_ROLLOUT_RE.test('no rollout found for thread id 01a0c585-4cc6-7a50-ac1c-a1ceeb0d4ed3'))
  })
})

describe('переводчик codex: возобновлённый ход (фикстура 06, запись спайка B3)', () => {
  it('после thread/resume ход идёт как обычно и помнит контекст', () => {
    const p = play('06-resume-turn')
    assert.deepEqual(texts(p), ['OK'])
    assert.equal(p.signals.filter((s) => s.kind === 'turn_completed').length, 1)
  })
})

describe('переводчик codex: незнакомое не роняет ничего', () => {
  it('незнакомый метод логируется ОДИН раз и пропускается', () => {
    const unknown: string[] = []
    const mapper = createCodexMapper({ sessionId: 'w', onUnknown: (w) => unknown.push(w) })
    for (let i = 0; i < 5; i++) {
      const res = mapper.push('совершенно/новый/метод', { threadId: 't' })
      assert.deepEqual(res.drafts, [])
      assert.deepEqual(res.signals, [])
    }
    assert.deepEqual(unknown, ['совершенно/новый/метод'])
  })

  it('незнакомый ТИП элемента всё равно попадает в дерево как инструмент', () => {
    const unknown: string[] = []
    const mapper = createCodexMapper({ sessionId: 'w', onUnknown: (w) => unknown.push(w) })
    const res = mapper.push('item/started', { threadId: 't', turnId: 'u', item: { type: 'quantumThing', id: 'q1' } })
    assert.equal(res.drafts.length, 1)
    assert.equal(res.drafts[0]?.kind, 'tool.called')
    assert.equal((res.drafts[0]?.data as { name: string }).name, 'quantumThing')
    assert.deepEqual(unknown, ['item/quantumThing'])
  })

  it('почта из текста модели остаётся читаемой в событии', () => {
    const mapper = createCodexMapper({ sessionId: 'w' })
    const res = mapper.push('item/completed', {
      threadId: 't', turnId: 'u',
      item: { type: 'agentMessage', id: 'm1', text: 'пиши на ' + 'vasya' + '@example.org', phase: 'final_answer' },
    })
    assert.equal((res.drafts[0]?.data as { text: string }).text, 'пиши на vasya@example.org')
  })
})

describe('переводчик codex: контекстное окно (context.updated)', () => {
  type Ctx = { used: number; window: number | null; model: string | null }
  const ctxOf = (drafts: EventDraft[]): Ctx[] => drafts.filter((d) => d.kind === 'context.updated').map((d) => d.data as Ctx)
  /** Уведомление в измеренной форме (запись B1): `last` — последнее обращение, `total` — накопленное. */
  const usage = (last: Record<string, number>, window: number | null = 258400): Record<string, unknown> => ({
    threadId: 't', turnId: 'u',
    tokenUsage: {
      total: { totalTokens: 999_999, inputTokens: 999_999, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, ...last },
      modelContextWindow: window,
    },
  })

  it('01: занятость — last.totalTokens (не накопленный total), окно — modelContextWindow', () => {
    assert.deepEqual(ctxOf(play('01-simple-turn').drafts), [{ used: 18637, window: 258400, model: null }])
  })

  it('04 субагент: только СВОЙ тред; уведомление треда ребёнка (19107) события не даёт', () => {
    const p = play('04-subagent')
    assert.deepEqual(ctxOf(p.drafts).map((c) => c.used), [18722, 18764, 18834])
    assert.ok(p.drafts.filter((d) => d.kind === 'context.updated').every((d) => d.parentId === undefined))
    // Само уведомление ребёнка до переводчика дошло (с parentId) — его отсеял именно он.
    assert.equal(p.signals.filter((s) => s.kind === 'tokens' && s.input === 19102).length, 1)
  })

  it('06 resume: второй ход того же треда — подсказка из last, а не накопленные 37297', () => {
    assert.deepEqual(ctxOf(play('06-resume-turn').drafts), [{ used: 18660, window: 258400, model: null }])
  })

  it('рассуждения последнего обращения вычитаются — как в tokens_in_context_window() Codex CLI', () => {
    const mapper = createCodexMapper({ sessionId: 'w', model: 'gpt-6-astra' })
    const r = mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 30_000, inputTokens: 27_000, outputTokens: 3000, reasoningOutputTokens: 1200 }))
    assert.deepEqual(ctxOf(r.drafts), [{ used: 28_800, window: 258400, model: 'gpt-6-astra' }])
  })

  it('то же значение второй раз не пишется; окно без modelContextWindow наследуется', () => {
    const mapper = createCodexMapper({ sessionId: 'w' })
    assert.equal(ctxOf(mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 100 })).drafts).length, 1)
    assert.equal(ctxOf(mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 100 })).drafts).length, 0)
    assert.deepEqual(ctxOf(mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 150 }, null)).drafts), [{ used: 150, window: 258400, model: null }])
  })

  it('уведомление с parentId (тред ребёнка) контекст сессии не трогает', () => {
    const mapper = createCodexMapper({ sessionId: 'w' })
    const r = mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 500 }), { parentId: 'call_1' })
    assert.deepEqual(ctxOf(r.drafts), [])
    assert.equal(r.signals.filter((s) => s.kind === 'tokens').length, 1, 'расход ребёнка в ход по-прежнему считается')
  })

  it('модель: из ответа thread/start (setModel); model/rerouted своего треда — новая модель и сброс окна', () => {
    const unknown: string[] = []
    const mapper = createCodexMapper({ sessionId: 'w', model: 'gpt-x', onUnknown: (w) => unknown.push(w) })
    mapper.setModel('gpt-6-astra')
    assert.deepEqual(ctxOf(mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 100 })).drafts), [{ used: 100, window: 258400, model: 'gpt-6-astra' }])
    const r = mapper.push('model/rerouted', { threadId: 't', turnId: 'u', fromModel: 'gpt-6-astra', toModel: 'gpt-6-mini', reason: 'highRiskCyberActivity' })
    assert.deepEqual(r.drafts, [])
    assert.deepEqual(unknown, [])
    assert.deepEqual(ctxOf(mapper.push('thread/tokenUsage/updated', usage({ totalTokens: 120 }, null)).drafts), [{ used: 120, window: null, model: 'gpt-6-mini' }])
  })
})

describe('Codex async input questions on completed agent messages', () => {
  const done = (questions?: unknown) => createCodexMapper({ sessionId: 'q' }).push('item/completed', {
    threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'message', text: 'Please choose', ...(questions === undefined ? {} : { questions }) },
  }).drafts.find((event) => event.kind === 'message.done')?.data as Record<string, unknown>

  it('preserves the structured async question titles and options from the actual schema', () => {
    const questions = [{ title: 'Which part?', options: ['UI', 'Backend'] }, { title: 'What should change?', options: null }]
    assert.deepEqual(done(questions), { text: 'Please choose', itemId: 'message', questions })
    assert.deepEqual(done([{ title: 'A free-form question' }])['questions'], [{ title: 'A free-form question', options: null }])
  })

  it('keeps email addresses in question titles and option labels', () => {
    const serialized = JSON.stringify(done([{ title: 'Contact person@example.com?', options: ['person@example.com', 'No'] }]))
    assert.ok(serialized.includes('person@example.com'))
    assert.ok(!serialized.includes('<email>'))
  })

  it('keeps ordinary messages unchanged and rejects malformed or excessive question forms as a whole', () => {
    const ordinary = { text: 'Please choose', itemId: 'message' }
    for (const questions of [undefined, null, [], 'Which?', [{ title: 1 }], [{ title: '' }], [{ title: 'Q', options: 'A' }], [{ title: 'Q', options: [1] }],
      [{ title: 'Good', options: ['A'] }, { title: 'Bad', options: [{}] }],
      Array.from({ length: 9 }, () => ({ title: 'Q' })),
      [{ title: 'Q'.repeat(2001) }], [{ title: 'Q', options: ['A'.repeat(501)] }], [{ title: 'Q', options: Array(13).fill('A') }],
    ]) assert.deepEqual(done(questions), ordinary)
  })
})
