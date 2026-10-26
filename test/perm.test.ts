// Разрешения: брокер-Inbox и НАСТОЯЩАЯ заглушка `pult mcp-ask`.
// Круг проверяется целиком: заглушка → сокет демона → брокер → решение человека → обратно.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { describe, it } from 'node:test'
import { ASKER_GONE_REASON, createBroker } from '../dist/perm/broker.js'
import type { AdapterDeps } from '../dist/adapters/types.js'
import { runMcpAsk } from '../dist/perm/mcpAsk.js'
import type { AskDecision, McpServerIo } from '../dist/perm/mcpAsk.js'
import type { EventDraft } from '../dist/core/events.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { readToken } from '../dist/core/token.js'
import type { DaemonHandle } from '../dist/daemon/server.js'
import { CLI_ENTRY, rawConnect, sleep, startTestDaemon, tempHome, waitFor, workIn } from './helpers.js'
import type { TempHome } from './helpers.js'

/**
 * Заводит сессию в реестре БЕЗ единого дочернего процесса (`startSession` только записывает).
 * С фикса f3 `perm.request` отвергает имя, которого в реестре нет, поэтому круг разрешений
 * начинается с настоящей сессии, а не с имени, взятого из воздуха.
 */
const register = async (daemon: DaemonHandle, home: TempHome, name: string): Promise<void> => {
  await daemon.manager.start({ name, kind: 'claude', cwd: workIn(home), mode: 'turn' })
}

// --- брокер -------------------------------------------------------------------
describe('брокер разрешений', () => {
  it('вопросы Codex требуют ответы по исходным id и допускают несколько вариантов и свой текст', async () => {
    const broker = createBroker({ emit: () => {} })
    const pending = broker.request({ sessionId: 'w', toolName: 'requestUserInput', input: { questions: [
      { id: 'choice', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'text', options: null },
    ] } })
    const id = broker.list()[0]!.id
    assert.throws(() => broker.resolve(id, { behavior: 'allow' }))
    assert.throws(() => broker.resolve(id, { behavior: 'allow', answers: { choice: { answers: ['C'] }, text: { answers: ['hello'] } } }))
    assert.equal(broker.pendingCount(), 1)
    const answers = { choice: { answers: ['A', 'B'] }, text: { answers: ['hello'] } }
    assert.ok(broker.resolve(id, { behavior: 'allow', answers }))
    assert.deepEqual(await pending, { behavior: 'allow', answers })
  })

  it('вопрос Claude (AskUserQuestion): ответы уходят в updatedInput.answers по тексту вопроса, множественный — через «, »', async () => {
    // Форма ответа — замер 07.10.2026 на CLI 2.1.291: модель получила «"Какой цвет?"="Синий"».
    const broker = createBroker({ emit: () => {} })
    const input = { questions: [
      { question: 'Какой цвет?', header: 'Цвет', options: [{ label: 'Красный' }, { label: 'Синий' }], multiSelect: false },
      { question: 'Что ещё?', header: 'Ещё', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
    ] }
    const pending = broker.request({ sessionId: 'w', toolName: 'AskUserQuestion', toolUseId: 'toolu_q', input })
    const id = broker.list()[0]!.id
    assert.throws(() => broker.resolve(id, { behavior: 'allow', answers: { 'Какой цвет?': { answers: ['Синий'] } } }), /нужен ответ: Что ещё/)
    assert.throws(() => broker.resolve(id, { behavior: 'allow', answers: { 'Какой цвет?': { answers: ['Синий', 'Красный'] }, 'Что ещё?': { answers: ['A'] } } }), /один ответ/)
    assert.throws(() => broker.resolve(id, { behavior: 'allow', answers: { 'Какой цвет?': { answers: ['Синий'] }, 'Что ещё?': { answers: ['A'] }, 'Лишний?': { answers: ['x'] } } }), /неизвестный вопрос/)
    assert.equal(broker.pendingCount(), 1)
    assert.ok(broker.resolve(id, { behavior: 'allow', answers: { 'Какой цвет?': { answers: ['Свой: бирюзовый'] }, 'Что ещё?': { answers: ['A', 'B'] } } }))
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { ...input, answers: { 'Какой цвет?': 'Свой: бирюзовый', 'Что ещё?': 'A, B' } } })
  })

  it('голое «разрешить» на AskUserQuestion — как раньше: исходный вход (ответов нет, но ход не ломается)', async () => {
    const broker = createBroker({ emit: () => {} })
    const input = { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
    const pending = broker.request({ sessionId: 'w', toolName: 'AskUserQuestion', input })
    broker.resolve(broker.list()[0]!.id, { behavior: 'allow' })
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: input })
  })

  it('пропуск вопроса Codex возвращает отказ без разрешения действия', async () => {
    const broker = createBroker({ emit: () => {} })
    const pending = broker.request({ sessionId: 'w', toolName: 'requestUserInput', input: { questions: [{ id: 'q' }] } })
    broker.resolve(broker.list()[0]!.id, { behavior: 'deny' })
    assert.equal((await pending).behavior, 'deny')
  })

  it('запрос публикует permission.requested, решение — permission.resolved', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => drafts.push(d) })
    const answer = broker.request({ sessionId: 'w', toolName: 'Edit', toolUseId: 'toolu_1', input: { file_path: '/tmp/x' } })
    assert.equal(broker.pendingCount(), 1)
    const req = drafts.find((d) => d.kind === 'permission.requested')
    assert.ok(req)
    assert.equal((req.data as { toolName: string }).toolName, 'Edit')
    const id = (req.data as { id: string }).id

    const pending = broker.list('w')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.id, id)
    assert.equal(broker.list('другая').length, 0)

    assert.ok(broker.resolve(id, { behavior: 'allow' }))
    const decision = await answer
    assert.equal(decision.behavior, 'allow')
    // allow ОБЯЗАН нести updatedInput — иначе Claude считает ответ неполным.
    assert.deepEqual(decision.updatedInput, { file_path: '/tmp/x' })
    assert.equal(broker.pendingCount(), 0)
    assert.ok(drafts.some((d) => d.kind === 'permission.resolved'))
    assert.ok(!broker.resolve(id, { behavior: 'allow' }), 'второй раз решить нельзя')
  })

  it('id запроса не повторяется между запусками брокера (рестарт демона)', async () => {
    const ids: string[] = []
    const grab = (d: EventDraft): void => { if (d.kind === 'permission.requested') ids.push((d.data as { id: string }).id) }
    const first = createBroker({ emit: grab })
    const second = createBroker({ emit: grab })
    const a = first.request({ sessionId: 'w', toolName: 'Edit', input: {} })
    const b = second.request({ sessionId: 'w', toolName: 'Bash', input: {} })
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1], 'первый запрос нового брокера получил тот же id, что у старого')
    assert.match(ids[0]!, /^p\d+-[0-9a-f]{6}$/)
    // Никаких неотвеченных вопросов после теста.
    first.shutdown('конец теста')
    second.shutdown('конец теста')
    for (const d of await Promise.all([a, b])) assert.equal(d.behavior, 'deny')
  })

  it('ТАЙМАУТ отвечает ОТКАЗОМ, а не разрешением', async () => {
    const broker = createBroker({ emit: () => {}, timeoutMs: 30 })
    const decision = await broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'rm -rf /' } })
    assert.equal(decision.behavior, 'deny')
    assert.match(String(decision.message), /таймаут/)
  })

  it('остановка демона отказывает ВСЕМ ожидающим', async () => {
    const broker = createBroker({ emit: () => {} })
    const a = broker.request({ sessionId: 'w', toolName: 'Edit', input: {} })
    const b = broker.request({ sessionId: 'w2', toolName: 'Bash', input: {} })
    assert.equal(broker.shutdown('демон останавливается'), 2)
    for (const d of await Promise.all([a, b])) {
      assert.equal(d.behavior, 'deny')
      assert.match(String(d.message), /останавливается/)
    }
  })

  it('РЕДАКЦИЯ: почта из входа инструмента не уезжает в событие, но решение отдаёт ОРИГИНАЛ', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => drafts.push(d) })
    const input = { file_path: '/tmp/x', new_string: 'напиши boss@example.org' }
    const answer = broker.request({ sessionId: 'w', toolName: 'Edit', input })
    const req = drafts.find((d) => d.kind === 'permission.requested')!
    const shown = JSON.stringify((req.data as { input: unknown }).input)
    assert.ok(!shown.includes('boss@example.org'), shown)
    assert.match(shown, /<email>/)
    broker.resolve(broker.list()[0]!.id, { behavior: 'allow' })
    const decision = await answer
    // Правка обязана примениться дословно: подставить `<email>` — значит сломать её.
    assert.deepEqual(decision.updatedInput, input)
  })

  it('РЕДАКЦИЯ ВИДНА: карточка знает, что показанное ≠ исполняемому (`concealed`), чистый вход — без флага', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => drafts.push(d) })
    const requested = (): Record<string, unknown> => drafts.filter((d) => d.kind === 'permission.requested').at(-1)!.data as Record<string, unknown>
    // Адресат команды выглядит как почта: человек видит `ssh <email>`, исполнится `ssh root@prod.example.com`.
    const hidden = broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'ssh root@prod.example.com uptime' } })
    assert.match(JSON.stringify(requested()['input']), /<email>/)
    assert.equal(requested()['concealed'], true)
    assert.equal(broker.list()[0]?.concealed, true)
    // Адаптер сам подрезал вход (Codex) — брокер верит его флагу.
    void broker.request({ sessionId: 'w', toolName: 'execCommand', input: { command: 'ls' }, concealed: true })
    assert.equal(requested()['concealed'], true)
    // Ничего не скрыто — флага нет ни в событии, ни в `perm.list`.
    void broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'npm test' } })
    assert.equal('concealed' in requested(), false)
    assert.equal('concealed' in broker.list().at(-1)!, false)
    broker.resolve(broker.list()[0]!.id, { behavior: 'allow' })
    assert.deepEqual((await hidden).updatedInput, { command: 'ssh root@prod.example.com uptime' })
    broker.shutdown()
  })

  it('ТИП: `askPermission` адаптера принимает `concealed` (литерал с лишним полем не скомпилировался бы)', async () => {
    const seen: unknown[] = []
    const ask: AdapterDeps['askPermission'] = async (req) => { seen.push(req.concealed); return { behavior: 'deny' } }
    await ask({ sessionId: 'w', toolName: 'execCommand', input: { command: ['a'] }, concealed: true })
    await ask({ sessionId: 'w', toolName: 'execCommand', input: { command: ['a'] } })
    assert.deepEqual(seen, [true, undefined])
  })

  it('СПРАШИВАЮЩИЙ УМЕР: `signal` снимает вопрос отказом (`provider_gone`), после решения он ни на что не влияет', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => drafts.push(d) })
    const resolved = (): Record<string, unknown>[] => drafts.filter((d) => d.kind === 'permission.resolved').map((d) => d.data as Record<string, unknown>)
    const gone = new AbortController()
    const asked = broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'ls' } }, { signal: gone.signal })
    const kept = new AbortController()
    const answered = broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'pwd' } }, { signal: kept.signal })
    assert.equal(broker.pendingCount(), 2)
    gone.abort()
    const d = await asked
    assert.equal(d.behavior, 'deny')
    assert.equal(d.message, `pult: ${ASKER_GONE_REASON}`)
    assert.deepEqual(broker.list().map((p) => p.input['command']), ['pwd'], 'снят только вопрос умершего')
    assert.deepEqual([resolved()[0]?.['by'], resolved()[0]?.['decision']], ['provider_gone', 'deny'])
    // Ответ пришёл раньше смерти — смерть после ответа ничего не пишет и не меняет.
    broker.resolve(broker.list()[0]!.id, { behavior: 'allow' })
    assert.equal((await answered).behavior, 'allow')
    kept.abort()
    assert.equal(resolved().length, 2)
    // Умер ещё до вопроса — вопрос сразу снят отказом, а в журнале отказ стоит за вопросом.
    const dead = new AbortController(); dead.abort()
    const late = await broker.request({ sessionId: 'w', toolName: 'Bash', input: {} }, { signal: dead.signal })
    assert.equal(late.behavior, 'deny')
    assert.deepEqual(drafts.slice(-2).map((x) => x.kind), ['permission.requested', 'permission.resolved'])
    assert.equal(broker.pendingCount(), 0)
  })
})

// --- заглушка mcp-ask в изоляции ------------------------------------------------
function fakeIo(): McpServerIo & { sent: unknown[]; feed(msg: unknown): void } {
  let onLine: ((line: string) => void) | null = null
  const sent: unknown[] = []
  return {
    sent,
    read(fn) { onLine = fn },
    write(line) { sent.push(JSON.parse(line)) },
    onEnd() { /* тест не закрывает поток */ },
    feed(msg) { onLine?.(typeof msg === 'string' ? msg : JSON.stringify(msg)) },
  }
}

describe('mcp-ask: протокол', () => {
  it('initialize → tools/list отдаёт ровно один инструмент ask с измеренной схемой', async () => {
    const io = fakeIo()
    runMcpAsk(io, async () => ({ behavior: 'deny' }))
    io.feed({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    io.feed({ jsonrpc: '2.0', method: 'notifications/initialized' })
    io.feed({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    await sleep(10)
    assert.equal(io.sent.length, 2, 'на уведомление отвечать нельзя')
    const init = io.sent[0] as { result: { serverInfo: { name: string }; protocolVersion: string } }
    assert.equal(init.result.serverInfo.name, 'pult')
    assert.equal(init.result.protocolVersion, '2025-11-25')
    const list = io.sent[1] as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }
    assert.equal(list.result.tools.length, 1)
    assert.equal(list.result.tools[0]?.name, 'ask')
    assert.deepEqual(Object.keys(list.result.tools[0]!.inputSchema.properties).sort(), ['input', 'tool_name', 'tool_use_id'])
  })

  it('tools/call возвращает решение ОДНИМ текстовым блоком JSON', async () => {
    const io = fakeIo()
    runMcpAsk(io, async () => ({ behavior: 'allow', updatedInput: { file_path: '/tmp/y' } }))
    io.feed({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Edit', input: {} } } })
    await sleep(10)
    const r = io.sent[0] as { result: { content: Array<{ type: string; text: string }> } }
    assert.equal(r.result.content.length, 1)
    assert.equal(r.result.content[0]?.type, 'text')
    assert.deepEqual(JSON.parse(r.result.content[0]!.text), { behavior: 'allow', updatedInput: { file_path: '/tmp/y' } })
  })

  it('ОТКАЗ ПО УМОЛЧАНИЮ: исключение в спрашивающем и мусорное решение дают deny', async () => {
    const io = fakeIo()
    let mode = 'throw'
    runMcpAsk(io, async () => {
      if (mode === 'throw') throw new Error('демон недоступен')
      return { behavior: 'что-то' } as unknown as AskDecision
    })
    io.feed({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: {} } })
    await sleep(10)
    mode = 'junk'
    io.feed({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: {} } })
    await sleep(10)
    for (const msg of io.sent) {
      const d = JSON.parse((msg as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as AskDecision
      assert.equal(d.behavior, 'deny')
    }
  })

  it('мусор вместо JSON даёт -32700 и не роняет процесс', async () => {
    const io = fakeIo()
    runMcpAsk(io, async () => ({ behavior: 'deny' }))
    io.feed('это не json')
    io.feed({ jsonrpc: '2.0', id: 9, method: 'ping' })
    await sleep(10)
    assert.equal((io.sent[0] as { error: { code: number } }).error.code, -32700)
    assert.ok((io.sent[1] as { result: unknown }).result)
  })
})

// --- настоящая заглушка как процесс, против настоящего демона ---------------------
interface Stub {
  child: ChildProcess
  call(method: string, params?: unknown): Promise<Record<string, unknown>>
  notify(method: string): void
  kill(): void
}

function startStub(home: string, session: string): Stub {
  const child = spawn(process.execPath, [CLI_ENTRY, 'mcp-ask'], {
    env: { ...process.env, PULT_HOME: home, PULT_ASK_SESSION: session },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  let buf = ''
  let id = 0
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line) as Record<string, unknown>
      const w = pending.get(msg['id'] as number)
      if (w) { pending.delete(msg['id'] as number); w(msg) }
    }
  })
  return {
    child,
    call(method, params) {
      const myId = ++id
      return new Promise<Record<string, unknown>>((res) => {
        pending.set(myId, res)
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
      })
    },
    notify(method) { child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') },
    kill() { try { child.stdin?.end() } catch { /* закрыт */ } try { child.kill('SIGKILL') } catch { /* мёртв */ } },
  }
}

const decisionOf = (msg: Record<string, unknown>): AskDecision =>
  JSON.parse((msg['result'] as { content: Array<{ text: string }> }).content[0]!.text) as AskDecision

describe('круг разрешений: настоящий `pult mcp-ask` против настоящего демона', () => {
  it('запрос доходит до брокера, approve возвращается разрешением', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    await register(daemon, home, 'w')
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', { protocolVersion: '2025-11-25' })
      stub.notify('notifications/initialized')
      const answer = stub.call('tools/call', {
        name: 'ask',
        arguments: { tool_name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }, tool_use_id: 'toolu_1' },
      })
      assert.ok(await waitFor(() => daemon.broker.pendingCount() === 1, 5000), 'запрос должен дойти до брокера')
      const pending = daemon.broker.list()
      assert.equal(pending[0]?.toolName, 'Edit')
      daemon.broker.resolve(pending[0]!.id, { behavior: 'allow' })
      const decision = decisionOf(await answer)
      assert.equal(decision.behavior, 'allow')
      assert.deepEqual(decision.updatedInput, { file_path: '/tmp/x', old_string: 'a', new_string: 'b' })
    } finally {
      stub.kill(); await daemon.stop('тест'); home.remove()
    }
  })

  it('deny доезжает с причиной', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    await register(daemon, home, 'w')
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', {})
      const answer = stub.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } })
      assert.ok(await waitFor(() => daemon.broker.pendingCount() === 1, 5000))
      daemon.broker.resolve(daemon.broker.list()[0]!.id, { behavior: 'deny', message: 'нельзя' })
      const decision = decisionOf(await answer)
      assert.equal(decision.behavior, 'deny')
      assert.equal(decision.message, 'нельзя')
    } finally {
      stub.kill(); await daemon.stop('тест'); home.remove()
    }
  })

  it('ОТКАЗ ПО УМОЛЧАНИЮ: демона нет — заглушка отвечает deny, а не ждёт вечно', async () => {
    const home = tempHome()
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', {})
      const decision = decisionOf(await stub.call('tools/call', { name: 'ask', arguments: { tool_name: 'Edit', input: {} } }))
      assert.equal(decision.behavior, 'deny')
      assert.match(String(decision.message), /демон не запущен|недоступен/)
    } finally { stub.kill(); home.remove() }
  })

  it('ОТКАЗ ПО УМОЛЧАНИЮ: демон умер ПОСРЕДИ вопроса', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    await register(daemon, home, 'w')
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', {})
      const answer = stub.call('tools/call', { name: 'ask', arguments: { tool_name: 'Edit', input: {} } })
      assert.ok(await waitFor(() => daemon.broker.pendingCount() === 1, 5000))
      // Остановка демона обязана отказать ожидающему, а не оставить его висеть.
      await daemon.stop('тест: демон падает посреди вопроса')
      const decision = decisionOf(await answer)
      assert.equal(decision.behavior, 'deny')
    } finally { stub.kill(); home.remove() }
  })

  it('ЗАГЛУШКА УМЕРЛА (умер её claude): вопрос уходит из Inbox отказом «процесс агента завершился», как у Codex', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    await register(daemon, home, 'w')
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', {})
      void stub.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'make deploy' } } })
      assert.ok(await waitFor(() => daemon.broker.pendingCount() === 1, 5000), 'запрос должен дойти до брокера')
      stub.kill()
      assert.ok(await waitFor(() => daemon.broker.pendingCount() === 0, 5000), 'вопрос мёртвой заглушки висит в Inbox')
      const resolved = daemon.store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'permission.resolved')
      assert.equal(resolved.length, 1)
      assert.deepEqual([resolved[0]!.data['decision'], resolved[0]!.data['by'], resolved[0]!.data['message']],
        ['deny', 'provider_gone', `pult: ${ASKER_GONE_REASON}`])
    } finally { stub.kill(); await daemon.stop('тест'); home.remove() }
  })

  it('perm.request доступен ТОЛЬКО клиенту mcp-ask: обычный cli получает отказ', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
      await conn.next()
      conn.send({ id: 1, method: 'perm.request', params: { sessionId: 'w', toolName: 'Bash', input: { command: 'rm -rf /' } } })
      const frame = await conn.next()
      const error = frame['error'] as Record<string, unknown>
      assert.equal(error['code'], 'invalid_params')
      assert.match(String(error['message']), /только клиенту mcp-ask/)
      assert.equal(daemon.broker.pendingCount(), 0, 'поддельный запрос не создаёт вопроса')
      conn.end()
    } finally { await daemon.stop('тест'); home.remove() }
  })

  it('ИМЯ-ПРИЗРАК: perm.request с незаведённой сессией отвергается (f3)', async () => {
    // Одного `client: mcp-ask` мало. Любой, кто прошёл рукопожатие с токеном, мог повесить
    // в Inbox запрос от имени сессии, которой нет, — неотличимый от настоящего.
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'mcp-ask', protocol: PROTOCOL_VERSION })
      await conn.next()
      conn.send({
        id: 1,
        method: 'perm.request',
        params: { sessionId: 'ghost-session-does-not-exist', toolName: 'Bash', input: { command: 'rm -rf /' } },
      })
      const frame = await conn.next()
      const error = frame['error'] as Record<string, unknown>
      assert.equal(error['code'], 'not_found')
      assert.match(String(error['message']), /perm\.request: сессии ghost-session-does-not-exist нет/)
      assert.equal(daemon.broker.pendingCount(), 0, 'запрос-призрак не должен попадать в очередь')
      assert.deepEqual(daemon.broker.list(), [])
      conn.end()
    } finally { await daemon.stop('тест'); home.remove() }
  })

  it('НЕВЕРНЫЙ ТОКЕН — отказ: подделать разрешение через сокет нельзя', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    const stub = startStub(home.paths.home, 'w')
    try {
      await stub.call('initialize', {})
      // Портим токен на диске: заглушка прочитает его и получит bad_token.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(home.paths.token, 'f'.repeat(64))
      const decision = decisionOf(await stub.call('tools/call', { name: 'ask', arguments: { tool_name: 'Edit', input: {} } }))
      assert.equal(decision.behavior, 'deny')
      assert.match(String(decision.message), /рукопожатие отвергнуто|bad_token/)
      assert.equal(daemon.broker.pendingCount(), 0, 'до брокера такой запрос не доходит')
    } finally { stub.kill(); await daemon.stop('тест'); home.remove() }
  })
})
