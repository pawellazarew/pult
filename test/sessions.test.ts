// Реестр сессий, свёртка статуса, дерево агентов и индекс журнала.
// Всё здесь либо чистое, либо трогает только временный PULT_HOME.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import type { PultEvent } from '../dist/core/events.js'
import { layout, ensureLayout } from '../dist/core/paths.js'
import { createStore } from '../dist/core/store.js'
import type { EventStore } from '../dist/core/store.js'
import { defaultConfig } from '../dist/core/config.js'
import type { NetCheck } from '../dist/env/net.js'
import { createBroker } from '../dist/perm/broker.js'
import { coversPultHome, createManager } from '../dist/sessions/manager.js'
import type { SessionManager } from '../dist/sessions/manager.js'
import { createRegistry, isSessionName, normalizeTitle, parseSessions, SESSION_TITLE_MAX, writeSessionsAtomic } from '../dist/sessions/registry.js'
import type { SessionRecord, SessionRegistry, SessionStatus } from '../dist/sessions/registry.js'
import { reduceStatus, reduceStatusEvent } from '../dist/sessions/status.js'
import { buildTree, formatTree } from '../dist/sessions/tree.js'
import { CLI_ENTRY, FAKE_CLAUDE, sleep, tempHome, waitFor, workIn } from './helpers.js'
import type { TempHome } from './helpers.js'

const ev = (kind: string, over: Partial<PultEvent> = {}): PultEvent => ({
  id: 1, ts: '2026-09-21T10:00:00.000Z', sessionId: 'w', provider: 'claude',
  kind: kind as PultEvent['kind'], data: {}, ...over,
})

describe('имена агентов', () => {
  it('принимает и отвергает по [a-z][a-z0-9_-]{0,31}', () => {
    for (const good of ['w', 'worker', 'w1', 'a_b-c', 'a'.repeat(32)]) assert.ok(isSessionName(good), good)
    for (const bad of ['', 'W', '1w', '-w', 'a'.repeat(33), 'с-кириллицей', 'with space', 'dot.name']) {
      assert.ok(!isSessionName(bad), bad)
    }
  })
})

describe('свёртка статуса (таблица)', () => {
  const table: Array<[SessionStatus, string, SessionStatus]> = [
    ['cold', 'session.started', 'idle'],
    ['idle', 'session.started', 'idle'],
    // init приходит посреди хода: «готов» до первой дельты — ложь.
    ['working', 'session.started', 'working'],
    // Активность вне хода статус не двигает: ход начинает только явный `status.changed working` (28.10.2026).
    ['idle', 'message.delta', 'idle'],
    ['idle', 'tool.called', 'idle'],
    ['failed', 'agent.finished', 'failed'],
    ['interrupted', 'tool.finished', 'interrupted'],
    ['done', 'message.done', 'done'],
    ['cold', 'tool.called', 'cold'],
    ['working', 'tool.finished', 'working'],
    ['working', 'permission.requested', 'blocked_permission'],
    ['blocked_permission', 'permission.resolved', 'working'],
    ['idle', 'permission.resolved', 'idle'],
    ['working', 'question.asked', 'blocked_question'],
    ['working', 'limit.hit', 'limited'],
    ['limited', 'message.delta', 'limited'],
    ['blocked_permission', 'message.delta', 'blocked_permission'],
    ['working', 'net.blocked', 'failed'],
    ['idle', 'provider.blocked', 'failed'],
    ['working', 'session.ended', 'done'],
    ['working', 'usage.updated', 'working'],
    // Замер контекста — справка, а не работа: простаивающую сессию «идущей» не делает.
    ['idle', 'context.updated', 'idle'],
    ['limited', 'context.updated', 'limited'],
  ]
  for (const [from, kind, to] of table) {
    it(`${from} + ${kind} → ${to}`, () => {
      assert.equal(reduceStatusEvent(from, ev(kind)), to)
    })
  }

  it('старые события предупреждения о лимите (allowed_warning) статус не меняют — ввод не запирается', () => {
    const warnHit = ev('limit.hit', { data: { status: 'allowed_warning', rateLimitType: 'seven_day' } })
    const warnStatus = ev('status.changed', { data: { status: 'limited', rateLimitStatus: 'allowed_warning' } })
    assert.equal(reduceStatusEvent('working', warnHit), 'working')
    assert.equal(reduceStatusEvent('idle', warnStatus), 'idle')
    assert.equal(reduceStatusEvent('working', ev('limit.hit', { data: { status: 'rejected' } })), 'limited', 'настоящий лимит — по-прежнему limited')
  })

  it('поток субагента (parentId) статус не двигает: после ответа фоновый субагент не делает сессию «идёт»', () => {
    for (const kind of ['message.delta', 'message.done', 'tool.called', 'tool.finished', 'agent.spawned', 'agent.finished']) {
      assert.equal(reduceStatusEvent('idle', ev(kind, { parentId: 'toolu_1' })), 'idle', kind)
      assert.equal(reduceStatusEvent('working', ev(kind, { parentId: 'toolu_1' })), 'working', kind)
    }
    assert.equal(reduceStatusEvent('idle', ev('message.done')), 'idle', 'и свой поток вне хода тоже не двигает')
  })

  // Четыре разобранных случая ложного «Похоже, завис» (28.10.2026): Codex отпускает ход, а субагенты и фоновые
  // команды доделывают работу — их конец приходит верхним событием без `parentId` уже ПОСЛЕ хода. События
  // синтетические, форма — как в журнале.
  describe('ход кончился, а субагенты и команды Codex — нет: статус не воскресает', () => {
    const codex = (kind: string, data: Record<string, unknown> = {}): PultEvent => ev(kind, { provider: 'codex', data })
    const turn = (end: Record<string, unknown>): PultEvent[] => [
      codex('status.changed', { status: 'working', turnId: 't1' }),
      codex('status.changed', { status: 'working', turnId: 't1', reason: 'turn_started' }),
      codex('agent.spawned', { toolUseId: 'call_a', name: 'Agent', agentThreadId: 'thr-a' }),
      codex('tool.called', { toolUseId: 'exec-1', name: 'commandExecution', input: { command: 'npm test' } }),
      codex('status.changed', end),
    ]
    it('конец хода idle → поздний agent.finished: idle', () => {
      const evs = [...turn({ status: 'idle', turnId: 't1' }), codex('agent.finished', { toolUseId: 'call_a', agentThreadId: 'thr-a' })]
      assert.equal(reduceStatus(evs), 'idle')
    })
    it('ход упал (internal) → agent.finished через 10 с: failed', () => {
      const evs = [...turn({ status: 'failed', turnId: 't1', errorCode: 'internal' }), codex('agent.finished', { toolUseId: 'call_a', agentThreadId: 'thr-a' })]
      assert.equal(reduceStatus(evs), 'failed')
    })
    it('ход оборван → субагенты и фоновая команда кончаются через минуты: статус конца хода', () => {
      const evs = [
        ...turn({ status: 'failed', turnId: 't1' }),
        codex('message.done', { text: 'итог субагента', itemId: 'm1' }),
        codex('agent.finished', { toolUseId: 'call_a', agentThreadId: 'thr-a' }),
        codex('tool.finished', { toolUseId: 'exec-1', name: 'commandExecution', status: 'completed', exitCode: 0 }),
      ]
      assert.equal(reduceStatus(evs), 'failed')
    })
    it('стоп (interrupted) → команда хода кончается через 3 с: interrupted', () => {
      const evs = [...turn({ status: 'interrupted' }), codex('tool.finished', { toolUseId: 'exec-1', name: 'commandExecution', status: 'completed', exitCode: 0 })]
      assert.equal(reduceStatus(evs), 'interrupted')
    })
  })

  it('status.changed с явным статусом бьёт любую догадку', () => {
    assert.equal(reduceStatusEvent('working', ev('status.changed', { data: { status: 'interrupted' } })), 'interrupted')
    assert.equal(reduceStatusEvent('failed', ev('status.changed', { data: { status: 'idle' } })), 'idle')
    // Мусор в поле игнорируется, статус не меняется.
    assert.equal(reduceStatusEvent('working', ev('status.changed', { data: { status: 'мусор' } })), 'working')
  })

  it('свёртка всей истории: холодная сессия → рабочая → ждёт человека → готова', () => {
    const history = [
      ev('session.started'), ev('message.delta'), ev('tool.called'),
      ev('permission.requested'), ev('permission.resolved'),
      ev('status.changed', { data: { status: 'idle' } }),
    ]
    assert.equal(reduceStatus(history), 'idle')
    assert.equal(reduceStatus(history.slice(0, 4)), 'blocked_permission')
  })
})

describe('дерево агентов', () => {
  const t = (ms: number): string => new Date(Date.UTC(2026, 8, 21, 10, 0, 0, 0) + ms).toISOString()

  it('субагент с детьми: инструменты ребёнка висят под ним, длительность считается', () => {
    const events: PultEvent[] = [
      ev('agent.spawned', { ts: t(0), data: { toolUseId: 'A1', name: 'Agent', subagentType: 'Explore', model: 'haiku' } }),
      ev('tool.called', { ts: t(100), parentId: 'A1', data: { toolUseId: 'T1', name: 'Read' } }),
      ev('tool.finished', { ts: t(400), parentId: 'A1', data: { toolUseId: 'T1' } }),
      ev('tool.called', { ts: t(500), data: { toolUseId: 'T2', name: 'Bash' } }),
      ev('tool.finished', { ts: t(700), data: { toolUseId: 'T2', isError: true } }),
      ev('agent.finished', { ts: t(900), data: { toolUseId: 'A1' } }),
    ]
    const tree = buildTree(events)
    assert.equal(tree.roots.length, 2)
    assert.equal(tree.orphans, 0)
    const agent = tree.roots[0]
    assert.ok(agent)
    assert.equal(agent.kind, 'agent')
    assert.equal(agent.subagentType, 'Explore')
    assert.equal(agent.model, 'haiku')
    assert.equal(agent.status, 'done')
    assert.equal(agent.durationMs, 900)
    assert.equal(agent.children.length, 1)
    assert.equal(agent.children[0]?.name, 'Read')
    assert.equal(agent.children[0]?.durationMs, 300)
    assert.equal(tree.roots[1]?.status, 'failed')
    assert.match(formatTree(tree), /Agent\(Explore\)/)
  })

  it('незакрытый узел остаётся running, сирота попадает в корни и считается', () => {
    const tree = buildTree([
      ev('tool.called', { data: { toolUseId: 'T1', name: 'Read' } }),
      ev('tool.called', { parentId: 'НЕТ-ТАКОГО', data: { toolUseId: 'T9', name: 'Grep' } }),
    ])
    assert.equal(tree.byId.get('T1')?.status, 'running')
    assert.equal(tree.orphans, 1)
    assert.equal(tree.roots.length, 2)
  })

  it('дерево из настоящего потока субагента строится в один корень с ребёнком', () => {
    // Цепочка как в фикстуре 06: сам Agent — корень, его tool_result его же закрывает.
    const tree = buildTree([
      ev('agent.spawned', { data: { toolUseId: 'toolu_x', name: 'Agent', subagentType: 'Explore' } }),
      ev('tool.called', { parentId: 'toolu_x', data: { toolUseId: 'toolu_y', name: 'Read' } }),
      ev('agent.finished', { data: { toolUseId: 'toolu_x' } }),
    ])
    assert.equal(tree.roots.length, 1)
    assert.equal(tree.roots[0]?.children.length, 1)
  })
})

describe('реестр сессий', () => {
  const rec = (name: string): SessionRecord => ({
    name, provider: 'claude', cwd: '/tmp/x', mode: 'turn',
    createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
  })

  it('заводит, обновляет, удаляет; повторное имя отвергается', () => {
    const home = tempHome()
    try {
      const reg = createRegistry(home.paths)
      assert.ok(reg.create(rec('w')))
      assert.ok(!reg.create(rec('w')))
      assert.equal(reg.list().length, 1)
      assert.equal(reg.update('w', { lastStatus: 'working' })?.lastStatus, 'working')
      assert.equal(reg.get('w')?.lastStatus, 'working')
      assert.ok(reg.remove('w'))
      assert.ok(!reg.remove('w'))
      assert.equal(reg.list().length, 0)
    } finally { home.remove() }
  })

  it('название: чистится в одну строку, снимается через undefined, переживает перечитывание', () => {
    assert.equal(normalizeTitle('  Починить\n VPN\t у\u2028Димы  '), 'Починить VPN у Димы')
    // Название печатает `agent list`: ESC, DEL и C1 (CSI одним байтом) не должны доехать до терминала.
    assert.equal(normalizeTitle('a\u001b[31mb\u007fc\u0085d\u009be'), 'a [31mb c d e')
    // Невидимые знаки формата выбрасываются, в том числе разворот письма; ZWJ составного эмодзи остаётся.
    assert.equal(normalizeTitle('VPN\u200b у\u202e Димы\u2060\u00ad\ufeff'), 'VPN у Димы')
    assert.equal(normalizeTitle('семья 👨\u200d👩\u200d👧'), 'семья 👨\u200d👩\u200d👧')
    // Ни одного видимого знака — названия нет: пустая строка в списке никому не нужна.
    for (const empty of ['', '   ', '\n\t', '\u200b', '\u200e\u2060', '\u200d', '\u3164', undefined, null, 42]) assert.equal(normalizeTitle(empty), null, JSON.stringify(empty))
    const home = tempHome()
    try {
      const reg = createRegistry(home.paths)
      reg.create(rec('w'))
      assert.equal(reg.update('w', { title: 'Починить VPN' })?.title, 'Починить VPN')
      assert.equal(createRegistry(home.paths).get('w')?.title, 'Починить VPN', 'название лежит на диске')
      // Снятое название — поля НЕТ, а не `title: undefined`: иначе запись «с названием» и «без»
      // различались бы только на диске.
      const cleared = reg.update('w', { title: undefined })
      assert.ok(cleared && !('title' in cleared))
      assert.ok(!('title' in (createRegistry(home.paths).get('w') as SessionRecord)))
    } finally { home.remove() }
  })

  it('название в sessions.json, правленном руками: мусор выбрасывается, длинное режется по знакам', () => {
    const base = { provider: 'claude', cwd: '/x' }
    const got = parseSessions({ sessions: [
      { ...base, name: 'a', title: 42 },
      { ...base, name: 'b', title: '  ' },
      { ...base, name: 'c', title: 'я'.repeat(SESSION_TITLE_MAX + 10) },
      { ...base, name: 'd', title: 'в две\nстроки' },
    ] })
    assert.deepEqual(got.map((s) => s.title), [undefined, undefined, 'я'.repeat(SESSION_TITLE_MAX), 'в две строки'])
  })

  it('после рестарта всё незавершённое становится cold, завершённое не трогается', () => {
    const home = tempHome()
    try {
      const reg = createRegistry(home.paths)
      reg.create({ ...rec('a'), lastStatus: 'working' })
      reg.create({ ...rec('b'), lastStatus: 'blocked_permission' })
      reg.create({ ...rec('c'), lastStatus: 'done' })
      reg.create({ ...rec('d'), lastStatus: 'failed' })
      const reopened = createRegistry(home.paths)
      assert.equal(reopened.coolDown(), 2)
      assert.equal(reopened.get('a')?.lastStatus, 'cold')
      assert.equal(reopened.get('b')?.lastStatus, 'cold')
      assert.equal(reopened.get('c')?.lastStatus, 'done')
      assert.equal(reopened.get('d')?.lastStatus, 'failed')
    } finally { home.remove() }
  })

  it('битый sessions.json не роняет демона: кривые записи выбрасываются', () => {
    const home = tempHome()
    try {
      writeFileSync(home.paths.sessions, JSON.stringify({
        version: 1,
        sessions: [
          null, 42, { name: 'ЗАГЛАВНЫМИ' }, { name: 'ok', provider: 'нет', cwd: '/x' },
          { name: 'good', provider: 'claude', cwd: '/x', mode: 'мусор', lastStatus: 'мусор' },
        ],
      }))
      const reg = createRegistry(home.paths)
      assert.deepEqual(reg.list().map((s) => s.name), ['good'])
      assert.equal(reg.get('good')?.mode, 'turn')
      assert.equal(reg.get('good')?.lastStatus, 'cold')
    } finally { home.remove() }
  })

  it('АТОМАРНОСТЬ: kill -9 посреди записи оставляет СТАРЫЙ файл целым', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-atom-'))
    try {
      const file = join(dir, 'sessions.json')
      writeSessionsAtomic(file, [rec('старый')])
      const before = readFileSync(file, 'utf8')

      // Ребёнок пишет большой список в цикле, мы убиваем его SIGKILL посреди работы.
      const script = `
        import { writeSessionsAtomic } from ${JSON.stringify(new URL('../dist/sessions/registry.js', import.meta.url).href)}
        const big = Array.from({length: 4000}, (_, i) => ({
          name: 'n' + i, provider: 'claude', cwd: '/tmp/x', mode: 'turn',
          createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'idle', lastEventId: i,
        }))
        process.send?.('ready')
        for (;;) writeSessionsAtomic(${JSON.stringify(file)}, big)
      `
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      await new Promise<void>((r) => child.once('message', () => r()))
      await new Promise<void>((r) => { setTimeout(r, 120) })
      child.kill('SIGKILL')
      await new Promise<void>((r) => child.once('close', () => r()))

      // Файл разбирается ВСЕГДА: это либо старый список, либо полностью записанный новый.
      const after = readFileSync(file, 'utf8')
      const parsed = parseSessions(JSON.parse(after))
      assert.ok(parsed.length === 1 || parsed.length === 4000, `получили ${parsed.length} записей`)
      if (parsed.length === 1) assert.equal(after, before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('менеджер сессий: правки после ревью В2', () => {
  const rec = (name: string): SessionRecord => ({
    name, provider: 'claude', cwd: '/tmp/x', mode: 'turn',
    createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
  })

  it('поток дельт НЕ пишет sessions.json на каждое событие (F2)', () => {
    // `registry.update` — это временный файл + fsyncSync + rename. Раньше он звался на КАЖДОЕ
    // событие сессии, а `--include-partial-messages` даёт сотни `message.delta` на реплику:
    // одна словоохотливая реплика превращалась в сотни fsync-ов.
    const home = tempHome()
    try {
      const real = createRegistry(home.paths)
      real.create(rec('w'))
      let writes = 0
      const counting: SessionRegistry = { ...real, update: (n, p) => { writes++; return real.update(n, p) } }
      const store = createStore(home.paths)
      const manager = createManager({
        paths: home.paths, config: defaultConfig(), logger: home.logger, store,
        publish: (d) => store.append(d),
        adapters: {},
        broker: createBroker({ emit: () => {} }),
        registry: counting,
      })
      writes = 0
      const N = 300
      for (let i = 0; i < N; i++) {
        manager.emit({ sessionId: 'w', provider: 'claude', kind: 'message.delta', data: { text: `кусок ${i}` } })
      }
      // Статус меняется ровно один раз (начало хода → working); 300 дельт — ничего.
      manager.emit({ sessionId: 'w', provider: 'claude', kind: 'status.changed', data: { status: 'working', turnId: 't1' } })
      writes = 0
      for (let i = 0; i < N; i++) {
        manager.emit({ sessionId: 'w', provider: 'claude', kind: 'message.delta', data: { text: `кусок ${i}` } })
      }
      assert.equal(writes, 0, `${writes} записей реестра на ${N} дельт — это усиление записи`)
      assert.equal(store.lastId, 2 * N + 1, 'в журнал при этом уходит КАЖДОЕ событие')
      assert.equal(real.get('w')?.lastStatus, 'working')
      store.close()
    } finally { home.remove() }
  })

  it('контекстное окно sessions.json само не пишет — уезжает в реестр попутно со сменой статуса', () => {
    // `context.updated` идёт на КАЖДОЕ обращение к модели; отдельная запись реестра на каждое
    // вернула бы усиление записи, от которого уже лечили дельты (тест выше).
    const home = tempHome()
    try {
      const real = createRegistry(home.paths)
      real.create(rec('w'))
      let writes = 0
      const counting: SessionRegistry = { ...real, update: (n, p) => { writes++; return real.update(n, p) } }
      const store = createStore(home.paths)
      const manager = createManager({
        paths: home.paths, config: defaultConfig(), logger: home.logger, store,
        publish: (d) => store.append(d),
        adapters: {},
        broker: createBroker({ emit: () => {} }),
        registry: counting,
      })
      writes = 0
      for (let i = 1; i <= 50; i++) {
        manager.emit({ sessionId: 'w', provider: 'claude', kind: 'context.updated', data: { used: 1000 * i, window: i === 1 ? 200000 : null, model: 'm' } })
      }
      assert.equal(writes, 0, 'замеры контекста реестр не трогают')
      // Окно, которого переводчик не знал, менеджер подставил ДО записи в журнал.
      const logged = store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'context.updated')
      assert.equal(logged.length, 50)
      assert.ok(logged.every((e) => e.data['window'] === 200000), JSON.stringify(logged.map((e) => e.data['window'])))
      const listed = manager.list()[0]?.context
      assert.deepEqual([listed?.used, listed?.window, listed?.model], [50000, 200000, 'm'])
      assert.equal(real.get('w')?.context, undefined, 'до смены статуса на диске контекста нет')

      manager.emit({ sessionId: 'w', provider: 'claude', kind: 'status.changed', data: { status: 'working' } })
      assert.equal(writes, 1, 'одна запись — та же, что и без контекста')
      assert.equal(createRegistry(home.paths).get('w')?.context?.used, 50000, 'перечитанный файл помнит контекст')
      // Другая модель — прошлое окно не подставляется.
      manager.emit({ sessionId: 'w', provider: 'claude', kind: 'context.updated', data: { used: 10, window: null, model: 'другая' } })
      assert.equal(store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'context.updated').pop()?.data['window'], null)
      // Чужая сессия памяти не заводит.
      manager.emit({ sessionId: 'ghost', provider: 'claude', kind: 'context.updated', data: { used: 1, window: 2, model: null } })
      assert.deepEqual(manager.list().map((r) => r.name), ['w'])
      store.close()
    } finally { home.remove() }
  })

  it('контекст в sessions.json, правленном руками: кривой выбрасывается, целый остаётся', () => {
    const base = rec('w')
    const parsed = parseSessions({ sessions: [
      { ...base, context: { used: 48000, window: 200000, model: 'm', at: '2026-10-07T10:00:00.000Z' } },
      { ...base, name: 'bad', context: { used: 'много', window: 200000, at: '2026-10-07T10:00:00.000Z' } },
      { ...base, name: 'noat', context: { used: 1, window: 2 } },
    ] })
    assert.deepEqual(parsed.map((r) => [r.name, r.context?.used ?? null]), [['w', 48000], ['bad', null], ['noat', null]])
    assert.equal(parsed[0]?.context?.model, 'm')
  })

  it('--cwd на несуществующую папку отвергается до спавна (F1)', async () => {
    // Иначе опечатка доезжала до child_process.spawn, а ENOENT оттуда прилетал событием
    // 'error' у процесса, которого никто не слушал.
    const home = tempHome()
    try {
      const store = createStore(home.paths)
      const manager = createManager({
        paths: home.paths, config: defaultConfig(), logger: home.logger, store,
        publish: (d) => store.append(d),
        adapters: {},
        broker: createBroker({ emit: () => {} }),
      })
      await assert.rejects(
        () => manager.start({ name: 'w', kind: 'claude', cwd: join(tmpdir(), 'нет-такой-папки-pult') }),
        (e: Error & { code?: string }) => {
          assert.equal(e.code, 'invalid_params')
          assert.match(e.message, /такой папки нет/)
          return true
        },
      )
      // Файл — не папка: тоже отказ.
      const file = join(home.paths.home, 'не-папка.txt')
      writeFileSync(file, 'x')
      await assert.rejects(() => manager.start({ name: 'w', kind: 'claude', cwd: file }))
      assert.deepEqual(manager.list(), [])
      store.close()
    } finally { home.remove() }
  })
})

describe('сторож тишины: только настоящий ход (28.10.2026)', () => {
  const rec = (name: string, provider: 'claude' | 'codex' = 'codex'): SessionRecord => ({
    name, provider, cwd: '/tmp/x', mode: 'turn',
    createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
  })
  // Порог 300 мс, проход сторожа — каждые 75 мс.
  const world = (): { manager: SessionManager; store: EventStore; stalls(): PultEvent[]; status(): SessionStatus | undefined; done(): Promise<void> } => {
    const home = tempHome()
    const config = defaultConfig()
    config.watchdog.silenceMinutes = 0.005
    const registry = createRegistry(home.paths)
    registry.create(rec('w'))
    const store = createStore(home.paths)
    const manager = createManager({
      paths: home.paths, config, logger: home.logger, store,
      publish: (d) => store.append(d), adapters: {}, broker: createBroker({ emit: () => {} }), registry,
    })
    return {
      manager, store,
      stalls: () => store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'turn.stalled'),
      status: () => manager.list().find((r) => r.name === 'w')?.lastStatus,
      done: async () => { await manager.shutdown(); store.close(); home.remove() },
    }
  }
  const say = (m: SessionManager, kind: string, data: Record<string, unknown> = {}, parentId?: string): void => {
    m.emit({ sessionId: 'w', provider: 'codex', kind: kind as PultEvent['kind'], data, ...(parentId ? { parentId } : {}) })
  }

  it('настоящая тишина в ходе — одно «завис» на ход', async () => {
    const w = world()
    try {
      say(w.manager, 'status.changed', { status: 'working', turnId: 't1' })
      assert.ok(await waitFor(() => w.stalls().length > 0, 3000), 'turn.stalled не пришёл')
      await sleep(400)
      assert.equal(w.stalls().length, 1)
      assert.equal(w.status(), 'working', 'сторож ход не обрывает')
    } finally { await w.done() }
  })

  it('ход кончился, поздний agent.finished / tool.finished без parentId — ни working, ни «завис»', async () => {
    const w = world()
    try {
      say(w.manager, 'status.changed', { status: 'working', turnId: 't1' })
      say(w.manager, 'agent.spawned', { toolUseId: 'call_a', name: 'Agent', agentThreadId: 'thr-a' })
      say(w.manager, 'tool.called', { toolUseId: 'exec-1', name: 'commandExecution', input: { command: 'npm test' } })
      say(w.manager, 'status.changed', { status: 'idle', turnId: 't1' })
      say(w.manager, 'message.done', { text: 'итог', itemId: 'm1' }, 'call_a')
      say(w.manager, 'agent.finished', { toolUseId: 'call_a', agentThreadId: 'thr-a' })
      say(w.manager, 'tool.finished', { toolUseId: 'exec-1', name: 'commandExecution', status: 'completed' })
      assert.equal(w.status(), 'idle')
      await sleep(800)
      assert.equal(w.stalls().length, 0, 'без хода «завис» — ложь')
      for (const end of ['failed', 'interrupted']) {
        say(w.manager, 'status.changed', { status: 'working', turnId: `t-${end}` })
        say(w.manager, 'status.changed', { status: end, turnId: `t-${end}` })
        say(w.manager, 'tool.finished', { toolUseId: 'exec-2', name: 'commandExecution', status: 'completed' })
        assert.equal(w.status(), end)
      }
      await sleep(800)
      assert.equal(w.stalls().length, 0)
    } finally { await w.done() }
  })

  it('открытый инструмент хода (долгий тест, sleep) — не «завис»; после его конца тишина считается заново', async () => {
    const w = world()
    try {
      say(w.manager, 'status.changed', { status: 'working', turnId: 't1' })
      say(w.manager, 'tool.called', { toolUseId: 'exec-1', name: 'commandExecution', input: { command: 'sleep 600' } })
      await sleep(900)
      assert.equal(w.stalls().length, 0, 'инструмент работает — сторож молчит')
      assert.equal(w.manager.phase('w')?.phase, 'tool', 'строка фазы показывает инструмент')
      say(w.manager, 'tool.finished', { toolUseId: 'exec-1', name: 'commandExecution', status: 'completed' })
      assert.ok(await waitFor(() => w.stalls().length > 0, 3000), 'после инструмента настоящая тишина — «завис»')
    } finally { await w.done() }
  })

  it('живые сигналы (размышления) — признак жизни хода', async () => {
    const w = world()
    try {
      say(w.manager, 'status.changed', { status: 'working', turnId: 't1' })
      const until = Date.now() + 900
      while (Date.now() < until) {
        w.manager.live('w', { kind: 'reasoning', text: 'думаю ' })
        await sleep(60)
      }
      assert.equal(w.stalls().length, 0, 'модель думает — не «завис»')
      assert.ok(await waitFor(() => w.stalls().length > 0, 3000), 'сигналы кончились — «завис»')
    } finally { await w.done() }
  })

  it('вопрос вне хода (субагент пережил ход): ответ возвращает сессию в idle, а не в working', () => {
    const home = tempHome()
    const registry = createRegistry(home.paths)
    registry.create(rec('w'))
    const store = createStore(home.paths)
    const manager = createManager({
      paths: home.paths, config: defaultConfig(), logger: home.logger, store,
      publish: (d) => store.append(d), adapters: {}, broker: createBroker({ emit: () => {} }), registry,
    })
    try {
      say(manager, 'permission.requested', { id: 'p1', toolName: 'commandExecution' })
      assert.equal(manager.list()[0]?.lastStatus, 'blocked_permission')
      say(manager, 'permission.resolved', { id: 'p1', decision: 'allow' })
      assert.equal(manager.list()[0]?.lastStatus, 'idle')
      const last = store.readFrom(0, { sessionId: 'w' }).at(-1)
      assert.deepEqual(last?.data, { status: 'idle', reason: 'permission_outside_turn' }, 'окно видит то же событием')
      // Внутри хода — по-прежнему «ход продолжается».
      say(manager, 'status.changed', { status: 'working', turnId: 't1' })
      say(manager, 'permission.requested', { id: 'p2', toolName: 'commandExecution' })
      say(manager, 'permission.resolved', { id: 'p2', decision: 'allow' })
      assert.equal(manager.list()[0]?.lastStatus, 'working')
    } finally { void manager.shutdown(); store.close(); home.remove() }
  })
})

describe('менеджер: название агента', () => {
  it('задаётся на старте и меняется когда угодно; имя и журнал не трогаются', async () => {
    const home = tempHome()
    try {
      const stand = boot(home)
      const started = await stand.manager.start({ name: 'w', title: '  Починить  VPN ', kind: 'claude', cwd: workIn(home) })
      assert.equal(started.title, 'Починить VPN')
      const before = stand.store.lastId

      assert.equal(stand.manager.rename('w', 'Релиз Эха Океана 🚀').title, 'Релиз Эха Океана 🚀')
      assert.deepEqual(stand.manager.list().map((s) => [s.name, s.title]), [['w', 'Релиз Эха Океана 🚀']])
      assert.equal(stand.store.lastId, before, 'переименование — не событие хода: журнал не растёт')

      // Пустое название снимает его: в списках снова имя.
      assert.ok(!('title' in stand.manager.rename('w', '   ')))
      assert.ok(!('title' in (stand.manager.list()[0] as object)))
      await stand.close()

      // Рестарт демона: название читается с диска.
      const again = boot(home)
      again.manager.rename('w', 'после рестарта')
      await again.close()
      const third = boot(home)
      assert.equal(third.manager.list()[0]?.title, 'после рестарта')
      await third.close()
    } finally { home.remove() }
  })

  it('отказы: нет такого агента, слишком длинное, не строка — и запись не меняется', async () => {
    const home = tempHome()
    try {
      const stand = boot(home)
      await stand.manager.start({ name: 'w', kind: 'claude', cwd: workIn(home) })
      stand.manager.rename('w', 'как было')
      const code = (fn: () => unknown): string | undefined => {
        try { fn() } catch (e) { return (e as { code?: string }).code }
        return 'не бросил'
      }
      assert.equal(code(() => stand.manager.rename('нет', 'x')), 'not_found')
      // Предел — в знаках: 60 кириллических букв проходят, 61-я — отказ, а не тихая обрезка.
      assert.equal(stand.manager.rename('w', 'я'.repeat(SESSION_TITLE_MAX)).title, 'я'.repeat(SESSION_TITLE_MAX))
      stand.manager.rename('w', 'как было')
      assert.equal(code(() => stand.manager.rename('w', 'я'.repeat(SESSION_TITLE_MAX + 1))), 'invalid_params')
      assert.equal(code(() => stand.manager.rename('w', 42 as unknown as string)), 'invalid_params')
      assert.equal(stand.manager.list()[0]?.title, 'как было')
      await assert.rejects(
        () => stand.manager.start({ name: 'x', title: 'я'.repeat(SESSION_TITLE_MAX + 1), kind: 'claude', cwd: workIn(home) }),
        (e: { code?: string }) => e.code === 'invalid_params',
      )
      assert.deepEqual(stand.manager.list().map((s) => s.name), ['w'], 'агент с негодным названием не заведён')
      await stand.close()
    } finally { home.remove() }
  })
})

describe('менеджер: папка сессии', () => {
  it('не PULT_HOME и не его предок: агент с правкой файлов без вопроса переписал бы config.json Пульта', async () => {
    const home = tempHome()
    try {
      const stand = boot(home)
      for (const cwd of [home.paths.home, dirname(home.paths.home), `${home.paths.home}/`]) {
        await assert.rejects(
          () => stand.manager.start({ name: 'x', kind: 'claude', cwd }),
          (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /возьми папку проекта/.test(e.message ?? ''),
          cwd,
        )
      }
      assert.deepEqual(stand.manager.list(), [], 'отказ на входе: в реестре пусто')
      // Папка внутри PULT_HOME до config.json не дотягивается — её пускаем.
      await stand.manager.start({ name: 'w', kind: 'claude', cwd: workIn(home) })
      // `PULT_HOME/..x` — не сосед, а потомок (relative → `..`): его пускаем.
      assert.equal(coversPultHome(join(home.paths.home, '..x'), home.paths.home), false)
      assert.equal(coversPultHome(workIn(home), home.paths.home), false)
      await stand.close()
    } finally { home.remove() }
  })

  it('«..x» по-настоящему: PULT_HOME под папкой `..x` — она и её родитель накрывают его, сосед `..x` — нет', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-dots-'))
    try {
      // relative(root, root/..x/home) = `..x/home` — начинается с «..», но это спуск, а не подъём.
      const parent = join(root, '..x')
      const ph = join(parent, 'home')
      mkdirSync(ph, { recursive: true })
      assert.equal(coversPultHome(parent, ph), true, 'папка `..x` над PULT_HOME')
      assert.equal(coversPultHome(root, ph), true, 'дед: relative = `..x/home`')
      // Настоящий сосед с именем `..x`: relative(root/b/..x, root/b/home) = `../home` — не накрывает.
      const sib = join(root, 'b')
      mkdirSync(join(sib, '..x'), { recursive: true })
      mkdirSync(join(sib, 'home'), { recursive: true })
      assert.equal(coversPultHome(join(sib, '..x'), join(sib, 'home')), false)
      assert.equal(coversPultHome(join(ph, 'w'), ph), false, 'папка внутри PULT_HOME')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('сессия из sessions.json с папкой над PULT_HOME: ход и смена режима шире «Только чтение» — отказ; в нём ход идёт', async () => {
    const home = tempHome()
    try {
      // Заведена до проверки на старте (или папка стала ссылкой): запись лежит в sessions.json как есть.
      const legacy = (name: string, approval?: SessionRecord['approval']): SessionRecord => ({
        name, provider: 'claude', cwd: home.paths.home, mode: 'turn', ...(approval ? { approval } : {}),
        createdAt: '2026-10-01T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
      })
      writeSessionsAtomic(home.paths.sessions, [legacy('old'), legacy('ws', 'workspace'), legacy('ro', 'read-only')])
      // Адаптер-заглушка без процессов: проверяется решение менеджера, а не claude.
      const resumed: string[] = []
      const adapter = {
        async startSession(spec: { name: string }) { return { name: spec.name, providerSessionId: `p-${spec.name}` } },
        async resume(name: string) { resumed.push(name) },
        async send(name: string) { return { turnId: `t-${name}`, done: Promise.resolve({ turnId: `t-${name}`, ok: true }) } },
        configure: () => 'next_turn',
        async respondPermission() {}, async interrupt() {}, async close() {}, async shutdown() {},
        blocked: () => ({ blocked: false }), reset() {},
      } as unknown as ProviderAdapter
      const store = createStore(home.paths)
      const manager = createManager({
        paths: home.paths, config: defaultConfig(), logger: home.logger, store,
        publish: (d) => store.append(d), adapters: { claude: adapter },
        broker: createBroker({ emit: () => {} }),
      })
      try {
        const refused = (e: { code?: string; message?: string }): boolean => e.code === 'invalid_params' && /Только чтение/.test(e.message ?? '')
        // resume: ход в `ask` и `workspace` не заводится — ни реплики в журнале, ни resume.
        await assert.rejects(() => manager.prompt('old', 'привет'), refused)
        await assert.rejects(() => manager.prompt('ws', 'привет'), refused)
        assert.equal(store.readFrom(0).filter((e) => e.kind === 'message.user').length, 0, 'реплика не ушла в журнал')
        assert.deepEqual(resumed, [])
        // configure: шире «Только чтение» — отказ, запись не тронута; в «Только чтение» — можно.
        await assert.rejects(() => manager.configure({ name: 'old', approval: 'workspace' }), refused)
        await assert.rejects(() => manager.configure({ name: 'old', approval: 'full', confirm: true }), refused)
        assert.equal(manager.list().find((r) => r.name === 'old')?.approval, undefined)
        const r = await manager.configure({ name: 'ws', approval: 'read-only' })
        assert.equal(r.record.approval, 'read-only')
        // «Только чтение» — ход заводится.
        assert.equal((await manager.prompt('ro', 'привет')).turnId, 't-ro')
        assert.deepEqual(resumed, ['ro'])
      } finally { await manager.shutdown().catch(() => {}); store.close() }
    } finally { home.remove() }
  })
})

/** Страж сети инъецируется: ни один тест не ходит наружу. */
const okNet = async (): Promise<NetCheck> => ({
  provider: 'claude', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-09-21T10:00:00.000Z', cached: false,
})

interface Stand {
  manager: SessionManager
  store: EventStore
  close(): Promise<void>
}

/**
 * Менеджер с настоящим адаптером Claude на фальшивом CLI поверх данного PULT_HOME.
 *
 * ПОЗВАТЬ ДВАЖДЫ ПО ОДНОМУ ДОМУ — это и есть рестарт демона: реестр и журнал на диске те же,
 * а менеджер и адаптер новые и пустые, ровно как после `daemon stop` + `daemon start`.
 * Ковыряться в `live` адаптера не нужно и нечестно — его незнание сессии здесь настоящее.
 */
function boot(home: TempHome): Stand {
  const store = createStore(home.paths)
  const claude = createClaudeAdapter({
    paths: home.paths, config: defaultConfig(), logger: home.logger,
    bin: FAKE_CLAUDE, cliEntry: CLI_ENTRY,
    emit: (d) => { manager.emit(d) },
    askPermission: async () => ({ behavior: 'deny', message: 'тест' }),
    netCheck: okNet,
  })
  const manager = createManager({
    paths: home.paths, config: defaultConfig(), logger: home.logger, store,
    publish: (d) => store.append(d),
    adapters: { claude },
    broker: createBroker({ emit: (d) => { manager.emit(d) } }),
  })
  return {
    manager,
    store,
    async close() { await manager.shutdown(); store.close() },
  }
}

/**
 * Папка сессии с настройкой фальшивого CLI: через окружение она не пройдёт (белый список).
 * Туда же, рядом, фальшивый CLI дописывает argv каждого запуска — по нему и видно, с
 * `--session-id` ушёл ход или с `--resume`.
 */
function workDir(cfg: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-work-'))
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({
    scenario: 'simple', speed: 0, argvOut: join(cwd, 'argv.jsonl'), ...cfg,
  }))
  return cwd
}

/** Запуски фальшивого CLI в этой папке — по одному argv на ход. */
function runs(cwd: string): Array<{ argv: string[] }> {
  const file = join(cwd, 'argv.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
}

describe('менеджер сессий: стоп посреди хода', () => {
  it('журнал не врёт: ни одного failed и ровно один interrupted на стоп', async () => {
    // НАБЛЮДЕНО на настоящем CLI: `agent prompt`, через секунду `agent stop` — и в журнале
    // `status.changed failed errorCode=internal` (снятый ход рапортовал «claude вышел без
    // result»), а следом ДВА `interrupted`: писали и адаптер, и менеджер. Хозяин статуса
    // теперь один — менеджер; адаптер по стопу молчит и отдаёт ходу код `interrupted`.
    const home = tempHome()
    // `hang` держит ход открытым: стоп заведомо приходит ПОСРЕДИ работы, а не после конца.
    const cwd = workDir({ hang: 3000 })
    const { manager, store, close } = boot(home)
    try {
      await manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await manager.prompt('w', 'привет')
      await manager.stop('w')
      // Ждём СВОИМ ref-нутым ожиданием, а не `manager.wait`: его таймер опроса намеренно
      // `unref`-нут (в демоне цикл держит сокет), и здесь набор уехал бы в `cancelled`.
      // Ждём не первого `interrupted`, а тишины: ложный `failed` от снятого хода приходил
      // ПОСЛЕ него, и проверка «статус стал interrupted» его бы не увидела.
      assert.ok(await waitFor(() => manager.list()[0]?.lastStatus === 'interrupted', 10_000))
      await sleep(300)

      const statuses = store.readFrom(0, { sessionId: 'w' })
        .filter((e) => e.kind === 'status.changed')
        .map((e) => String((e.data as { status?: unknown }).status))
      assert.deepEqual(statuses.filter((s) => s === 'failed'), [], `ложный failed: ${statuses.join(' → ')}`)
      assert.deepEqual(statuses.filter((s) => s === 'interrupted'), ['interrupted'], statuses.join(' → '))
      assert.equal(manager.list()[0]?.lastStatus, 'interrupted')
      // И ГЛАВНОЕ ДЛЯ РЕСТАРТА: разговора не завелось, значит реестру нечего запоминать.
      // Попади сюда выдуманный на `agent start` uuid — `adapter.resume` после рестарта
      // демона поднял бы сессию с `started: true`, и кирпич воспроизвёлся бы заново.
      assert.equal(manager.list()[0]?.providerSessionId, undefined)
    } finally {
      await close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('РЕСТАРТ: реестр помнит providerSessionId только после system/init', async () => {
    // `adapter.resume` берёт `started: Boolean(rec.providerSessionId)`, поэтому цена ошибки
    // здесь — кирпич, переживающий перезапуск демона. Проверяем обе половины: до init поле
    // пустое, после init — тот uuid, который назвал САМ CLI, а не наш выдуманный.
    const home = tempHome()
    const cwd = workDir({})
    const { manager, store, close } = boot(home)
    try {
      const rec = await manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      assert.equal(rec.providerSessionId, undefined, 'на agent start разговора ещё нет')

      await manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => manager.list()[0]?.lastStatus === 'idle', 20_000), 'ход должен был закончиться')
      const reported = store.readFrom(0, { sessionId: 'w' })
        .find((e) => e.kind === 'session.started')
      const id = (reported?.data as { providerSessionId?: string } | undefined)?.providerSessionId
      assert.ok(id, 'system/init обязан был назвать session_id')
      assert.equal(manager.list()[0]?.providerSessionId, id)
    } finally {
      await close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})

describe('менеджер сессий: рестарт демона', () => {
  it('импортированный Claude fork-флаг уходит в CLI один раз и снимается по system/init', async () => {
    const home = tempHome()
    const cwd = workDir({})
    const stand = boot(home)
    try {
      await stand.manager.importSession({ name: 'imported', kind: 'claude', cwd, mode: 'turn' }, '94357d2d-8c5c-46b3-9a4c-2176726d3521', [], true)
      await stand.manager.prompt('imported', 'первый импортированный ход')
      assert.ok(await waitFor(() => stand.manager.list()[0]?.lastStatus === 'idle', 20_000))
      assert.ok(runs(cwd)[0]!.argv.includes('--fork-session'))
      assert.ok(runs(cwd)[0]!.argv.includes('--resume'))
      assert.equal(stand.manager.list()[0]?.forkOnResume, undefined)
      assert.ok(stand.store.readFrom(0, { sessionId: 'imported' }).some((e) => e.kind === 'session.started'))
      await stand.manager.prompt('imported', 'второй импортированный ход')
      assert.ok(await waitFor(() => stand.manager.list()[0]?.lastStatus === 'idle', 20_000))
      assert.ok(!runs(cwd)[1]!.argv.includes('--fork-session'))
    } finally { await stand.close(); rmSync(cwd, { recursive: true, force: true }); home.remove() }
  })
  it('импорт сохраняет provider id, историю и fork до подтверждённого init', async () => {
    const home = tempHome()
    let stand = boot(home)
    const originalId = '94357d2d-8c5c-46b3-9a4c-2176726d3521'
    try {
      const imported = await stand.manager.importSession({ name: 'imported', kind: 'claude', cwd: workIn(home) }, originalId,
        [{ role: 'user', text: 'Вопрос из CLI' }, { role: 'assistant', text: 'Ответ из CLI' }], true)
      assert.equal(imported.providerSessionId, originalId)
      assert.equal(imported.forkOnResume, true)
      assert.equal(stand.manager.list()[0]?.lastStatus, 'cold')
      assert.deepEqual(stand.store.readFrom(0, { sessionId: 'imported' }).filter((e) => e.kind === 'message.user' || e.kind === 'message.done').map((e) => [e.kind, e.data['text']]),
        [['message.user', 'Вопрос из CLI'], ['message.done', 'Ответ из CLI']])
      await stand.close()
      stand = boot(home)
      assert.equal(stand.manager.list()[0]?.providerSessionId, originalId)
      assert.equal(stand.manager.list()[0]?.forkOnResume, true)
      stand.manager.emit({ sessionId: 'imported', provider: 'claude', kind: 'message.delta', data: { text: 'пока ещё без init' } })
      assert.equal(stand.manager.list()[0]?.forkOnResume, true)
      stand.manager.emit({ sessionId: 'imported', provider: 'claude', kind: 'session.started', data: { providerSessionId: originalId } })
      assert.equal(stand.manager.list()[0]?.forkOnResume, undefined)
      assert.equal(createRegistry(home.paths).get('imported')?.forkOnResume, undefined)
    } finally { await stand.close(); home.remove() }
  })

  it('init нового fork меняет provider id и очищает флаг в реестре', async () => {
    const home = tempHome()
    const stand = boot(home)
    try {
      await stand.manager.importSession({ name: 'imported', kind: 'claude', cwd: workIn(home) }, 'original', [], true)
      stand.manager.emit({ sessionId: 'imported', provider: 'claude', kind: 'session.started', data: { providerSessionId: 'forked' } })
      assert.equal(stand.manager.list()[0]?.providerSessionId, 'forked')
      assert.equal(stand.manager.list()[0]?.forkOnResume, undefined)
      assert.equal(createRegistry(home.paths).get('imported')?.providerSessionId, 'forked')
    } finally { await stand.close(); home.remove() }
  })
  // НАБЛЮДЕНО на настоящем CLI 21.09.2026: `daemon stop` → `daemon start` → `agent prompt`
  // ⇒ `pult agent: internal — сессия x не заведена в адаптере`, и так НАВСЕГДА. Реестр
  // сессию пережил, адаптер — нет, а `ProviderAdapter.resume` во всём `src/` не звал никто.
  // Здесь второй стенд поверх того же PULT_HOME и есть перезапущенный демон.

  it('разговор переживает рестарт: ход 2 идёт с --resume и теми же model/effort', async () => {
    const home = tempHome()
    const cwd = workDir({})
    const first = boot(home)
    try {
      await first.manager.start({
        name: 'w', kind: 'claude', cwd, mode: 'turn', model: 'haiku', effort: 'low',
        settingSources: 'user',
      })
      await first.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const id = first.manager.list()[0]?.providerSessionId
      assert.ok(id, 'разговор обязан был завестись')
    } finally { await first.close() }

    const second = boot(home)
    try {
      // Адаптер второго стенда сессии не знает — и это настоящее незнание, а не подделка.
      await second.manager.prompt('w', 'ещё раз')
      assert.ok(await waitFor(() => second.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const rec = second.manager.list()[0]
      assert.equal(rec?.lastStatus, 'idle')
      // argv второго хода: возобновление того же разговора и те же параметры запуска.
      const all = runs(cwd)
      assert.equal(all.length, 2, 'ходов должно быть ровно два')
      const argv = all[1]!.argv
      assert.equal(argv[argv.indexOf('--resume') + 1], rec?.providerSessionId)
      assert.equal(argv[argv.indexOf('--model') + 1], 'haiku')
      assert.equal(argv[argv.indexOf('--effort') + 1], 'low')
      // Граница доступа переживает рестарт вместе с сессией.
      assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user')
    } finally {
      await second.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('контекстное окно: в agent.list после хода и после рестарта; окно подставляется в первую реплику хода', async () => {
    // В режиме `turn` каждый ход — новый процесс claude и новый переводчик: окна модели он не
    // знает до своего result. Без подстановки менеджера первая реплика хода писала бы `window: null`.
    const home = tempHome()
    const cwd = workDir({})
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await first.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const c = first.manager.list()[0]?.context
      // Фикстура 01: 10 + 9693 + 13689 токенов подсказки, окно haiku — 200 000.
      assert.deepEqual([c?.used, c?.window, c?.model], [23392, 200000, 'claude-haiku-4-5-20251001'])
      assert.match(String(c?.at), /^\d{4}-\d\d-\d\dT/)
    } finally { await first.close() }

    const second = boot(home)
    try {
      assert.equal(second.manager.list()[0]?.context?.window, 200000, 'реестр помнит контекст после рестарта')
      const since = second.store.lastId
      await second.manager.prompt('w', 'ещё раз')
      assert.ok(await waitFor(() => second.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const ctx = second.store.readFrom(since, { sessionId: 'w' }).filter((e) => e.kind === 'context.updated')
      assert.ok(ctx.length >= 1)
      assert.ok(ctx.every((e) => e.data['window'] === 200000), JSON.stringify(ctx.map((e) => e.data)))
    } finally {
      await second.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('рестарт после стопа ДО init: ход 2 идёт с --session-id, а не в никуда', async () => {
    // Две беды складывались: адаптер сессию забыл, а реестр помнил бы выдуманный uuid.
    const home = tempHome()
    const cwd = workDir({ hang: 3000 })
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await first.manager.prompt('w', 'привет')
      // `prompt` возвращается по спавну, а не по тому, что ребёнок успел что-то сделать:
      // ждём его argv, иначе стоп прилетит раньше запуска и ход 1 не состоится вовсе.
      assert.ok(await waitFor(() => runs(cwd).length === 1, 20_000), 'процесс должен был запуститься')
      await first.manager.stop('w')
      assert.equal(first.manager.list()[0]?.providerSessionId, undefined)
    } finally { await first.close() }

    // Ход 2 играет фикстуру целиком: разговор надо завести с нуля.
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({
      scenario: 'simple', speed: 0, argvOut: join(cwd, 'argv.jsonl'),
    }))
    const second = boot(home)
    try {
      await second.manager.prompt('w', 'ещё раз')
      assert.ok(await waitFor(() => second.manager.list()[0]?.lastStatus === 'idle', 20_000))
      const argv = runs(cwd)[runs(cwd).length - 1]!.argv
      assert.ok(!argv.includes('--resume'), `возобновлять было нечего: ${argv.join(' ')}`)
      assert.ok(argv.includes('--session-id'), argv.join(' '))
    } finally {
      await second.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('после рестарта rm работает по сессии, которую адаптер ни разу не видел', async () => {
    // `rm` и `stop` адаптеру не нужны: незнакомую сессию он обязан принять молча. Запись из
    // реестра уходит, `session.ended` пишется — иначе сессию нельзя было бы даже удалить.
    const home = tempHome()
    const cwd = workDir({})
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
    } finally { await first.close() }

    const second = boot(home)
    try {
      await second.manager.stop('w')
      await second.manager.rm('w')
      assert.deepEqual(second.manager.list(), [])
      const ended = second.store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'session.ended')
      assert.equal(ended.length, 1)
    } finally {
      await second.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('работавшая на момент падения сессия встаёт после рестарта как cold, а не working', async () => {
    // Процесса провайдера после рестарта нет ни одного, поэтому `working` на диске — ложь.
    // Резкий стенд без `stop` — это и есть падение демона посреди хода.
    const home = tempHome()
    const cwd = workDir({ hang: 5000 })
    const first = boot(home)
    try {
      await first.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await first.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => first.manager.list()[0]?.lastStatus === 'working', 20_000))
    } finally { await first.close() }
    // На диске осталось `working`: закрытие стенда статус не меняет.
    assert.equal(createRegistry(home.paths).get('w')?.lastStatus, 'working')

    const second = boot(home)
    try {
      assert.equal(second.manager.list()[0]?.lastStatus, 'cold')
    } finally {
      await second.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})

describe('индекс журнала (долг В1)', () => {
  it('50 000 событий: подписка со свежего курсора не читает весь файл', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-idx-'))
    try {
      const paths = layout(dir)
      ensureLayout(paths)
      const store = createStore(paths)
      for (let i = 0; i < 50_000; i++) {
        store.append({ sessionId: 'w', provider: 'claude', kind: 'message.delta', data: { text: `строка номер ${i}` } })
      }
      const total = readFileSync(paths.journal).length
      assert.ok(total > 5_000_000, `журнал должен быть большим, получили ${total} байт`)
      assert.equal(store.stats().bytesRead, 0, 'запись читать журнал не обязана')

      const tail = store.readFrom(49_997)
      assert.equal(tail.length, 3)
      assert.equal(tail[0]?.id, 49_998)
      const read = store.stats().bytesRead
      // Щедрый предел: три последние строки — это сотни байт, а весь файл — мегабайты.
      assert.ok(read < 4096, `прочитано ${read} байт вместо всего файла (${total})`)
      assert.ok(read / total < 0.001, `доля прочитанного ${read / total}`)

      // С нуля — читаем всё, и это тоже должно работать.
      const all = store.readFrom(0, { limit: 10 })
      assert.equal(all.length, 10)
      store.close()

      // Индекс восстанавливается при открытии: новый store видит тот же хвост.
      const reopened = createStore(paths)
      assert.equal(reopened.lastId, 50_000)
      assert.equal(reopened.stats().indexed, 50_000)
      assert.equal(reopened.readFrom(49_999).length, 1)
      assert.ok(reopened.stats().bytesRead < 4096)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('журнал для окна (Ф2, О1)', () => {
  it('реплика человека пишется message.user ДО хода, отредактированной и без влияния на статус', async () => {
    const home = tempHome()
    const cwd = workDir({})
    const { manager, store, close } = boot(home)
    try {
      await manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await manager.prompt('w', 'проверь почту ivan@example.com и ответь')
      assert.ok(await waitFor(() => manager.list()[0]?.lastStatus === 'idle', 10_000))
      const evs = store.readFrom(0, { sessionId: 'w' })
      const user = evs.filter((e) => e.kind === 'message.user')
      assert.equal(user.length, 1)
      const text = String((user[0]?.data as { text?: unknown }).text)
      assert.ok(!text.includes('ivan@example.com'), `адрес почты уехал в журнал: ${text}`)
      assert.ok(text.startsWith('проверь почту'), text)
      const working = evs.find((e) => e.kind === 'status.changed' && (e.data as { status?: unknown }).status === 'working')
      assert.ok(working && (user[0]?.id ?? 0) < working.id, 'реплика обязана идти раньше хода')
      // Ответ модели (`agent read`) реплику человека не содержит.
      assert.ok(!String(manager.read('w', 0, 'text').text).includes('проверь почту'))
      // Сама по себе реплика статус не двигает.
      assert.equal(reduceStatusEvent('idle', ev('message.user')), 'idle')
      assert.equal(reduceStatusEvent('failed', ev('message.user')), 'failed')
    } finally {
      await close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('проваленный ход пишет причину текстом в status.changed failed', async () => {
    const home = tempHome()
    const cwd = workDir({ scenario: 'not-logged-in' })
    const { manager, store, close } = boot(home)
    try {
      await manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => manager.list()[0]?.lastStatus === 'failed', 10_000))
      const failed = store.readFrom(0, { sessionId: 'w' })
        .filter((e) => e.kind === 'status.changed' && (e.data as { status?: unknown }).status === 'failed')
      assert.equal(failed.length, 1)
      const msg = String((failed[0]?.data as { message?: unknown }).message ?? '')
      assert.match(msg, /Failed to authenticate/)
    } finally {
      await close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})
