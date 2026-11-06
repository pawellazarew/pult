// Эталонные тесты переводчика: КАЖДАЯ фикстура прогоняется через него, и проверяется,
// во что превратился поток. Если завтра `claude` поменяет форму события, падать будет здесь,
// а не в проде.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ACCOUNT_BLOCK_RE, createClaudeMapper } from '../dist/adapters/claude/mapper.js'
import type { TurnSignal } from '../dist/adapters/claude/mapper.js'
import type { EventDraft } from '../dist/core/events.js'

const FIXTURES = fileURLToPath(new URL('../test/fixtures/claude/', import.meta.url))

function run(name: string): { drafts: EventDraft[]; signals: TurnSignal[]; unknown: string[]; skipped: string[] } {
  const unknown: string[] = []
  const mapper = createClaudeMapper({ sessionId: 'w', onUnknown: (t) => unknown.push(t) })
  const drafts: EventDraft[] = []
  const signals: TurnSignal[] = []
  // Неразбираемые строки ВЫБРАСЫВАЮТСЯ, как их выбрасывает адаптер: настоящий CLI печатает
  // в тот же stdout и не-JSON (фикстура 10 начинается ровно с такой строки). Сколько их
  // было — возвращаем: молча глотать мусор в эталонном тесте нельзя.
  const skipped: string[] = []
  for (const line of readFileSync(`${FIXTURES}${name}.jsonl`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let native: unknown
    try { native = JSON.parse(line) } catch { skipped.push(line); continue }
    const r = mapper.push(native)
    drafts.push(...r.drafts)
    signals.push(...r.signals)
  }
  return { drafts, signals, unknown, skipped }
}

const kinds = (drafts: EventDraft[]): string[] => drafts.map((d) => d.kind)
const results = (signals: TurnSignal[]): Array<Extract<TurnSignal, { kind: 'result' }>> =>
  signals.filter((s): s is Extract<TurnSignal, { kind: 'result' }> => s.kind === 'result')

describe('переводчик claude: эталоны по фикстурам', () => {
  it('01 простой ход: init → дельты → message.done → usage → успешный result', () => {
    const { drafts, signals, unknown } = run('01-simple-turn')
    assert.deepEqual(unknown, [], 'незнакомых типов быть не должно')
    assert.equal(drafts[0]?.kind, 'session.started')
    assert.ok(kinds(drafts).includes('message.delta'))
    const done = drafts.filter((d) => d.kind === 'message.done')
    assert.ok(done.some((d) => (d.data as { text: string }).text === 'PULT'))
    // rate_limit_event и result дают по usage.updated; limit.hit не даёт ни один — status allowed.
    assert.equal(drafts.filter((d) => d.kind === 'usage.updated').length, 2)
    assert.equal(drafts.filter((d) => d.kind === 'limit.hit').length, 0)
    const rs = results(signals)
    assert.equal(rs.length, 1)
    assert.equal(rs[0]?.ok, true)
    assert.equal(rs[0]?.terminalReason, 'completed')
    assert.equal(rs[0]?.startedInBackground, 0)
  })

  it('01: оба окна лимита приезжают одним rate_limit_event', () => {
    const { drafts } = run('01-simple-turn')
    const rl = drafts.find((d) => d.kind === 'usage.updated' && (d.data as { source?: string }).source === 'rate_limit_event')
    assert.ok(rl)
    const w = (rl.data as { windows: { five_hour: { utilization: number }; seven_day: { utilization: number } } }).windows
    assert.equal(typeof w.five_hour.utilization, 'number')
    assert.equal(typeof w.seven_day.utilization, 'number')
  })

  it('02 тёплая сессия: два хода, два result, второй помнит контекст', () => {
    const { signals, drafts } = run('02-warm-two-turns')
    assert.equal(results(signals).length, 2)
    // ИЗМЕРЕНО: у КАЖДОГО хода свой `system/init`, даже внутри одного тёплого процесса.
    // Поэтому сигналов turn_started два, а событие session.started — ровно одно.
    assert.equal(signals.filter((s) => s.kind === 'turn_started').length, 2)
    assert.equal(drafts.filter((d) => d.kind === 'session.started').length, 1)
    const texts = drafts.filter((d) => d.kind === 'message.done').map((d) => (d.data as { text: string }).text)
    assert.ok(texts.includes('41'), `ожидали ответ 41, получили ${JSON.stringify(texts)}`)
  })

  it('03 resume: оба процесса дают один и тот же providerSessionId', () => {
    const a = run('03-resume-turn1')
    const b = run('03-resume-turn2')
    const idOf = (s: TurnSignal[]): string | undefined =>
      s.find((x): x is Extract<TurnSignal, { kind: 'session_id' }> => x.kind === 'session_id')?.id
    assert.ok(idOf(a.signals))
    assert.equal(idOf(a.signals), idOf(b.signals))
    const texts = b.drafts.filter((d) => d.kind === 'message.done').map((d) => (d.data as { text: string }).text)
    assert.ok(texts.includes('MAYAK'))
  })

  it('04 разрешения: вызов Edit стал tool.called и tool.finished с тем же toolUseId', () => {
    const { drafts, signals } = run('04-permission-deny-allow')
    const called = drafts.filter((d) => d.kind === 'tool.called')
    const names = called.map((d) => (d.data as { name: string }).name)
    // Модель сначала прочитала файл, потом дважды позвала Edit — оба хода записаны.
    assert.deepEqual(names, ['Read', 'Edit', 'Edit'])
    const ids = new Set(
      called.filter((d) => (d.data as { name: string }).name === 'Edit')
        .map((d) => (d.data as { toolUseId: string }).toolUseId),
    )
    const finished = drafts.filter((d) => d.kind === 'tool.finished')
    assert.ok(finished.some((d) => ids.has((d.data as { toolUseId: string }).toolUseId)))
    // ОТКАЗ — не ошибка хода (инвариант из DELTA v0.5 §2).
    assert.ok(results(signals).every((r) => r.ok))
  })

  it('05 пишущий Bash спрашивает: tool.called Bash с полем command', () => {
    const { drafts } = run('05-permission-bash-deny')
    const bash = drafts.find((d) => d.kind === 'tool.called' && (d.data as { name: string }).name === 'Bash')
    assert.ok(bash)
    assert.equal((bash.data as { input: { command: string } }).input.command, 'touch probe.txt')
  })

  it('background agent stays working until notification and finishes once', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    mapper.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { run_in_background: true } }] } })
    const launch = mapper.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: 'Async agent launched successfully.' }] } })
    assert.equal(launch.drafts.filter(d => d.kind === 'agent.finished').length, 0)
    const notification = { type: 'system', subtype: 'task_notification', tool_use_id: 'bg', status: 'completed', summary: 'Done' }
    const done = mapper.push(notification)
    assert.equal(done.drafts.filter(d => d.kind === 'agent.finished').length, 1)
    assert.equal(mapper.push(notification).drafts.filter(d => d.kind === 'agent.finished').length, 0)
  })

  it('real background fixture finishes the agent only after task notification', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    let notified = false
    let completions = 0
    for (const line of readFileSync(`${FIXTURES}/12-background-live.jsonl`, 'utf8').trim().split('\n')) {
      const event = JSON.parse(line)
      if (event.subtype === 'task_notification') notified = true
      for (const draft of mapper.push(event).drafts) {
        if (draft.kind === 'agent.finished') {
          assert.ok(notified)
          completions++
        }
      }
    }
    assert.equal(completions, 1)
  })

  it('background launch failure finishes immediately as error', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    mapper.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { run_in_background: true } }] } })
    const failed = mapper.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg', is_error: true, content: 'Launch failed' }] } })
    assert.equal(failed.drafts[0]?.kind, 'agent.finished')
    assert.equal((failed.drafts[0]?.data as { isError: boolean }).isError, true)
  })

  it('06 субагент: agent.spawned с parentId у детей и ВТОРОЙ result после фонового старта', () => {
    const { drafts, signals } = run('06-subagent')
    const spawned = drafts.filter((d) => d.kind === 'agent.spawned')
    assert.equal(spawned.length, 1)
    assert.equal((spawned[0]?.data as { subagentType: string }).subagentType, 'Explore')
    const agentId = (spawned[0]?.data as { toolUseId: string }).toolUseId
    assert.ok(drafts.some((d) => d.kind === 'agent.finished' && (d.data as { toolUseId: string }).toolUseId === agentId))
    // Измеренный факт: ходов два, и у первого started_in_background = 1.
    const rs = results(signals)
    assert.equal(rs.length, 2)
    assert.equal(rs[0]?.startedInBackground, 1)
    assert.equal(rs[1]?.text, 'DONE')
    assert.equal(signals.filter((s) => s.kind === 'turn_started').length, 2)
  })

  it('07 шторм: третий подряд api_retry даёт сигнал retry_storm и ни одного события в словарь', () => {
    const { drafts, signals } = run('07-api-retry-storm')
    const storm = signals.find((s): s is Extract<TurnSignal, { kind: 'retry_storm' }> => s.kind === 'retry_storm')
    assert.ok(storm)
    assert.equal(storm.retries, 3)
    assert.equal(drafts.filter((d) => d.kind !== 'session.started').length, 0)
  })

  it('08 не залогинен: result с is_error, хотя subtype остался success', () => {
    const { signals } = run('08-not-logged-in')
    const r = results(signals)[0]
    assert.ok(r)
    assert.equal(r.ok, false, 'судить по is_error и terminal_reason, не по subtype')
    assert.equal(r.terminalReason, 'api_error')
    assert.match(String(r.text), /Failed to authenticate/)
  })

  it('09 блок аккаунта: сигнал provider_blocked по дословной строке', () => {
    const { signals } = run('09-account-region-block')
    const blocked = signals.filter((s) => s.kind === 'provider_blocked')
    assert.ok(blocked.length > 0)
    assert.ok(ACCOUNT_BLOCK_RE.test(String((blocked[0] as { text: string }).text)))
  })

  it('10 разговора нет: не-JSON строка выброшена, ни одного session.started, текст из errors[]', () => {
    const { drafts, signals, unknown, skipped } = run('10-resume-no-conversation')
    // Первая строка записи — `No conversation found with session ID: <uuid>` без всякого
    // JSON. Адаптер такие выбрасывает, и здесь ровно то же самое.
    assert.equal(skipped.length, 1)
    assert.match(skipped[0] as string, /^No conversation found with session ID: /)
    assert.deepEqual(unknown, [])
    // `system/init` не приходил вовсе — значит и разговора на диске не завелось.
    assert.deepEqual(drafts.filter((d) => d.kind === 'session.started'), [])
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]?.kind, 'usage.updated')
    const r = results(signals)[0]
    assert.ok(r)
    // `subtype` здесь `error_during_execution`, но судим мы по `is_error` (инвариант 4).
    assert.equal(r.ok, false)
    assert.equal(r.terminalReason, null, 'terminal_reason в этом ответе нет вовсе')
    assert.match(String(r.text), /No conversation found with session ID/)
  })

  // --- калитка на конверт ошибки -------------------------------------------------
  // Решающая строка «disabled Claude subscription access» — обычный текст. Агент, который
  // работает над самим Пультом, цитирует её в ответе дословно, и без калитки такой ответ
  // останавливал ВЕСЬ провайдер со всеми чужими сессиями до ручного `provider.reset`.

  it('строка блока в ОБЫЧНОМ ответе провайдер не останавливает — только message.done', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const text = 'В mapper.ts строка «disabled Claude subscription access» решает про блок аккаунта.'
    const r = mapper.push({
      type: 'assistant',
      message: { model: 'haiku', content: [{ type: 'text', text }] },
    })
    assert.deepEqual(r.signals, [], 'у конверта нет ни error, ни is_api_error_message')
    assert.deepEqual(kinds(r.drafts), ['message.done'])
    assert.equal((r.drafts[0]?.data as { text: string }).text, text)
  })

  it('строка блока в УСПЕШНОМ result провайдер не останавливает', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const r = mapper.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'Готово: строку «disabled Claude subscription access» больше не ищем в любом тексте.',
    })
    assert.deepEqual(r.signals.filter((s) => s.kind === 'provider_blocked'), [])
    assert.equal(results(r.signals)[0]?.ok, true)
  })

  it('конверт ошибки со строкой блока провайдер останавливает: и assistant, и result', () => {
    // Оба признака конверта проверяются порознь: `is_api_error_message` без `error` у
    // assistant и `terminal_reason: api_error` без `is_error` у result.
    const text = 'API Error: 403 … has disabled Claude subscription access for Claude Code'
    const byFlag = createClaudeMapper({ sessionId: 'w' }).push({
      type: 'assistant', is_api_error_message: true,
      message: { content: [{ type: 'text', text }] },
    })
    assert.equal(byFlag.signals.filter((s) => s.kind === 'provider_blocked').length, 1)

    const byReason = createClaudeMapper({ sessionId: 'w' }).push({
      type: 'result', subtype: 'success', terminal_reason: 'api_error', result: text,
    })
    assert.equal(byReason.signals.filter((s) => s.kind === 'provider_blocked').length, 1)
  })

  it('13 чужой result: разгрузка без метки реплики, ответ — с меткой; command_lifecycle — сигналы', () => {
    const { signals, unknown } = run('13-resume-phantom-result')
    assert.deepEqual(unknown, [], 'command_lifecycle и task_notification — знакомые типы')
    const rs = results(signals)
    assert.equal(rs.length, 2)
    assert.equal(rs[0]?.numTurns, 0)
    assert.equal(rs[0]?.userMessageUuids, null, 'разгрузка не отвечает ни на одну реплику')
    assert.equal(rs[1]?.numTurns, 1)
    assert.equal(rs[1]?.text, 'PONG')
    const cmds = signals.filter((s): s is Extract<TurnSignal, { kind: 'command' }> => s.kind === 'command')
    assert.deepEqual(cmds.map((c) => c.state), ['queued', 'started', 'completed'])
    const tie = cmds[0]?.uuid
    assert.ok(tie)
    assert.ok(cmds.every((c) => c.uuid === tie))
    assert.deepEqual(rs[1]?.userMessageUuids, [tie])
    // Порядок, на котором держится адаптер: чужой result — между queued и started нашей реплики.
    const order = signals.filter((s) => s.kind === 'command' || s.kind === 'result').map((s) => (s.kind === 'command' ? s.state : `result:${(s as { numTurns: number | null }).numTurns}`))
    assert.deepEqual(order, ['queued', 'result:0', 'started', 'result:1', 'completed'])
  })

  it('14 локальная команда: result с num_turns 0 помечен меткой реплики', () => {
    const { signals, unknown } = run('14-local-command')
    assert.deepEqual(unknown, [])
    const rs = results(signals)
    assert.equal(rs.length, 1)
    assert.equal(rs[0]?.ok, true)
    assert.equal(rs[0]?.numTurns, 0)
    const tie = signals.find((s): s is Extract<TurnSignal, { kind: 'command' }> => s.kind === 'command')?.uuid
    assert.ok(tie)
    assert.deepEqual(rs[0]?.userMessageUuids, [tie])
  })

  it('незнакомый тип события логируется ОДИН раз и не роняет переводчик', () => {
    const seen: string[] = []
    const mapper = createClaudeMapper({ sessionId: 'w', onUnknown: (t) => seen.push(t) })
    for (let i = 0; i < 5; i++) mapper.push({ type: 'совершенно_новое', payload: i })
    mapper.push(null)
    mapper.push({ type: 'system', subtype: 'ещё_одно' })
    assert.deepEqual(seen, ['совершенно_новое', 'not-an-object', 'system/ещё_одно'])
  })

  it('permission_denials из result попадают в журнал — сверка со следом брокера (F4)', () => {
    // Собственный учёт CLI: что он спросил и на что получил отказ. Без него след брокера
    // (`permission.requested` / `permission.resolved`) не с чем сверить.
    const { drafts } = run('05-permission-bash-deny')
    const fromResult = drafts.filter(
      (d) => d.kind === 'usage.updated' && (d.data as { source?: string }).source === 'result',
    )
    const denials = fromResult
      .flatMap((d) => (d.data as { permissionDenials: Array<{ toolName: string | null; input: unknown }> }).permissionDenials)
    assert.ok(denials.length >= 1, 'отказ по Bash обязан быть виден в журнале')
    assert.ok(denials.some((x) => x.toolName === 'Bash'), JSON.stringify(denials))
    const bash = denials.find((x) => x.toolName === 'Bash')
    assert.deepEqual((bash?.input as { command?: string }).command, 'touch probe.txt')
  })

  it('permission_denials пустые у чистого хода и не падают на мусоре (F4)', () => {
    const { drafts } = run('01-simple-turn')
    const res = drafts.find((d) => d.kind === 'usage.updated' && (d.data as { source?: string }).source === 'result')
    assert.deepEqual((res?.data as { permissionDenials: unknown[] }).permissionDenials, [])
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const r = mapper.push({ type: 'result', is_error: false, terminal_reason: 'completed', permission_denials: [null, 42] })
    const d = (r.drafts[0]?.data as { permissionDenials: unknown[] }).permissionDenials
    assert.deepEqual(d, [{ toolName: null, toolUseId: null, input: null }, { toolName: null, toolUseId: null, input: null }])
  })

  it('РЕДАКЦИЯ: адрес почты из потока не попадает ни в одно событие', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const r = mapper.push({
      type: 'assistant',
      message: { role: 'assistant', model: 'haiku', content: [{ type: 'text', text: 'пиши на vasya.pupkin@example.com сегодня' }] },
    })
    const text = (r.drafts[0]?.data as { text: string }).text
    assert.ok(!text.includes('@example.com'), text)
    assert.match(text, /<email>/)
  })
})

// --- контекстное окно -------------------------------------------------------------
// Подсказка обращения = input + cache_creation + cache_read из `message.usage` ответа верхнего
// уровня; окно — `modelUsage[модель].contextWindow` из `result`. Числа ниже сняты с фикстур.

describe('переводчик claude: контекстное окно (context.updated)', () => {
  type Ctx = { used: number; window: number | null; model: string | null }
  const ctxOf = (drafts: EventDraft[]): Ctx[] => drafts.filter((d) => d.kind === 'context.updated').map((d) => d.data as Ctx)
  const HAIKU = 'claude-haiku-4-5-20251001'

  it('01: реплика даёт подсказку без окна, result — окно; повторный конверт того же message.id — тишина', () => {
    const { drafts } = run('01-simple-turn')
    // 10 + 9693 + 13689. Конвертов assistant в записи два (CLI режет ответ по блокам), а событий
    // два не поэтому: второй конверт несёт тот же usage и молчит, второе событие — окно из result.
    assert.deepEqual(ctxOf(drafts), [
      { used: 23392, window: null, model: HAIKU },
      { used: 23392, window: 200000, model: HAIKU },
    ])
    // Окно пишется ДО сигнала result: адаптер сначала пишет события, потом закрывает ход.
    assert.equal(drafts[drafts.length - 1]?.kind, 'context.updated')
  })

  it('02 тёплый процесс: второй ход знает окно с первой же реплики, одинаковое не повторяется', () => {
    assert.deepEqual(ctxOf(run('02-warm-two-turns').drafts), [
      { used: 23392, window: null, model: HAIKU },
      { used: 23392, window: 200000, model: HAIKU },
      { used: 24917, window: 200000, model: HAIKU }, // 10 + 1525 + 23382
    ])
  })

  it('04: каждое обращение хода — своя подсказка, растёт вместе с разговором', () => {
    const ctx = ctxOf(run('04-permission-deny-allow').drafts)
    assert.deepEqual(ctx.map((c) => c.used), [24171, 24424, 24664, 24664, 24839, 25136])
    assert.deepEqual(ctx.map((c) => c.window), [null, null, null, 200000, 200000, 200000])
  })

  it('06 субагент: его реплики (parent_tool_use_id) в контекст сессии не идут', () => {
    const { drafts } = run('06-subagent')
    // Реплика субагента в записи — 10 + 8940 + 0 = 8950: такой подсказки среди событий нет.
    assert.deepEqual(ctxOf(drafts).map((c) => c.used), [23424, 25113, 25113, 25672])
    assert.ok(drafts.filter((d) => d.kind === 'context.updated').every((d) => d.parentId === undefined))
  })

  it('08/09/10: синтетический конверт отказа без usage и пустой modelUsage — ни одного события', () => {
    for (const name of ['08-not-logged-in', '09-account-region-block', '10-resume-no-conversation']) {
      assert.deepEqual(ctxOf(run(name).drafts), [], name)
    }
  })

  it('окно берётся у СВОЕЙ модели: точное имя, иначе ключ с суффиксом ([1m]); чужая модель не подходит', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    mapper.push({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-x', content: [], usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 94_000 } } })
    const r = mapper.push({
      type: 'result', is_error: false, terminal_reason: 'completed',
      modelUsage: {
        'claude-haiku-4-5': { contextWindow: 200000 },
        'claude-opus-x[1m]': { contextWindow: 1000000 },
      },
    })
    assert.deepEqual(ctxOf(r.drafts), [{ used: 95005, window: 1000000, model: 'claude-opus-x' }])
  })

  it('сменилась модель — окно прежней не переносится до её result', () => {
    const mapper = createClaudeMapper({ sessionId: 'w' })
    const say = (model: string, used: number): EventDraft[] =>
      mapper.push({ type: 'assistant', message: { model, content: [], usage: { input_tokens: used } } }).drafts
    say('a', 100)
    mapper.push({ type: 'result', modelUsage: { a: { contextWindow: 1000 } } })
    assert.deepEqual(ctxOf(say('a', 150)), [{ used: 150, window: 1000, model: 'a' }])
    assert.deepEqual(ctxOf(say('b', 200)), [{ used: 200, window: null, model: 'b' }])
  })
})

describe('переводчик claude: предупреждение о лимите — не лимит', () => {
  // Форма — дословно из журнала владельца 07.10.2026: недельное окно перешло 75%.
  const rl = (status: string) => ({
    type: 'rate_limit_event',
    rate_limit_info: {
      status, resetsAt: 1791687600, rateLimitType: 'seven_day', isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1791418200 }, seven_day: { utilization: 0.75, resetsAt: 1791687600 } },
    },
  })
  it('allowed_warning — только usage.updated: ни limit.hit, ни сигнала лимита', () => {
    const m = createClaudeMapper({ sessionId: 'w', onUnknown: () => {} })
    const out = m.push(rl('allowed_warning'))
    assert.deepEqual(out.drafts.map((d) => d.kind), ['usage.updated'])
    assert.equal((out.drafts[0]!.data as { status: string }).status, 'allowed_warning')
    assert.deepEqual(out.signals, [])
  })
  it('rejected — лимит: limit.hit и сигнал', () => {
    const m = createClaudeMapper({ sessionId: 'w', onUnknown: () => {} })
    const out = m.push(rl('rejected'))
    assert.deepEqual(out.drafts.map((d) => d.kind), ['usage.updated', 'limit.hit'])
    assert.deepEqual(out.signals, [{ kind: 'limit', status: 'rejected' }])
  })
})
