// Старт окна по снимку и лента сессии по требованию (0.2.19, model/state.ts): лента из лёгкой
// истории (src/core/history.ts) выглядит как из полной, снимок не трогает Inbox и статусы,
// события «в пути» и в очереди окна не теряются и не двоятся, ранние страницы встают впереди.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compactHistory, pageHistory } from '../../src/core/history.js'
import type { ConvItem } from '../src/model/conversation.js'
import { applyInbox } from '../src/model/inbox.js'
import {
  applyEvent, applyEvents, beginEarlier, beginHydrate, bootState, EMPTY_STATE, failHydrate, finishEarlier, finishHydrate, foldSession,
  needsHydrate, syncStatuses,
} from '../src/model/state.js'
import type { HistoryPageReply, SessionLive, UiState } from '../src/model/state.js'
import type { AgentRecord, PultEvent } from '../src/model/types.js'

let seq = 0
const ev = (sessionId: string, kind: string, data: Record<string, unknown> = {}, extra: Partial<PultEvent> = {}): PultEvent =>
  ({ id: ++seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), sessionId, provider: 'claude', kind, data, ...extra }) as PultEvent

/** Лента без того, что лёгкая история урезает намеренно: вход и вывод инструмента. */
function norm(items: readonly ConvItem[]): unknown[] {
  return items.map((it) => {
    const o = { ...it } as Record<string, unknown>
    if (it.type === 'tool') { delete o['input']; delete o['result']; delete o['elided'] }
    if (it.type === 'agent') o['items'] = norm(it.items)
    return o
  })
}

const fold = (evs: readonly PultEvent[]): SessionLive | undefined => evs.reduce<SessionLive | undefined>((s, e) => foldSession(s, e), undefined)
const page = (events: readonly PultEvent[], cursor: number, more = false): HistoryPageReply => ({ events, cursor, more, oldest: events[0]?.id ?? null })

/** Ход: реплика, дельты, инструмент, субагент со своими дельтами вперемешку с корнем, разрешения, лимит. */
function turn(s: string): PultEvent[] {
  return [
    ev(s, 'message.user', { text: 'сделай' }),
    ev(s, 'status.changed', { status: 'working', turnId: 't1' }),
    ev(s, 'message.delta', { text: '' }),
    ev(s, 'message.delta', { text: 'Смотрю ' }),
    ev(s, 'message.delta', { text: 'код' }),
    ev(s, 'message.done', { text: 'Смотрю код.' }),
    ev(s, 'tool.called', { toolUseId: 'u1', name: 'Bash', input: { command: `cat ${'x'.repeat(500)}` } }),
    ev(s, 'message.delta', { text: 'жду ' }),
    ev(s, 'tool.finished', { toolUseId: 'u1', content: 'вывод'.repeat(100), exitCode: 0 }),
    ev(s, 'message.delta', { text: 'вывод' }),
    ev(s, 'agent.spawned', { toolUseId: 'A', subagentType: 'Explore', description: 'поиск' }),
    ev(s, 'message.delta', { text: 'суб ' }, { parentId: 'A' }),
    ev(s, 'message.delta', { text: 'корень ждёт ' }),
    ev(s, 'message.delta', { text: 'думает' }, { parentId: 'A' }),
    ev(s, 'permission.requested', { id: 'p-mid', toolName: 'Write', input: { file_path: '/a', content: 'y'.repeat(3000) } }, { parentId: 'A' }),
    ev(s, 'message.delta', { text: 'и дальше' }),
    ev(s, 'permission.resolved', { id: 'p-mid', decision: 'allow', by: 'человек' }),
    ev(s, 'tool.called', { toolUseId: 'u2', name: 'Grep', input: { pattern: 'x' } }, { parentId: 'A' }),
    ev(s, 'tool.finished', { toolUseId: 'u2', content: 'нашёл' }, { parentId: 'A' }),
    ev(s, 'message.done', { text: 'суб думает' }, { parentId: 'A' }),
    ev(s, 'agent.finished', { toolUseId: 'A' }),
    ev(s, 'status.changed', { status: 'idle', turnId: 't1' }),
    // Фоновый субагент пишет и после конца хода (07.10): смена статуса гасит идущие реплики.
    ev(s, 'message.delta', { text: 'после хода' }),
    ev(s, 'limit.hit', { provider: 'claude', resetsAt: 1_800_010_000 }),
    ev(s, 'message.delta', { text: 'ещё' }),
  ]
}

describe('лёгкая история', () => {
  it('лента та же, что из полной: позиции дельт, субагент, разрешение с parentId, смена статуса, лимит', () => {
    const evs = turn('w')
    const full = fold(evs)
    const lite = fold(compactHistory(evs))
    assert.deepEqual(norm(lite?.conv.items ?? []), norm(full?.conv.items ?? []))
    assert.equal(lite?.status, full?.status)
    assert.equal(lite?.lastTs, full?.lastTs)
    const tool = lite?.conv.items.find((i) => i.type === 'tool')
    assert.equal(tool?.type === 'tool' && tool.elided, true)
    assert.equal(tool?.type === 'tool' && tool.endId, evs[8]?.id)
  })

  it('закрытая итогом серия несёт один символ; карточка разрешения — целиком', () => {
    const out = compactHistory(turn('c'))
    const closed = out.find((e) => e.kind === 'message.delta' && String(e.data['text']).startsWith('С'))
    assert.equal(closed?.data['text'], 'С')
    const perm = out.find((e) => e.kind === 'permission.requested')
    assert.equal(((perm?.data['input'] as Record<string, string>)['content'] ?? '').length, 3000)
    assert.ok(!out.some((e) => e.kind === 'message.delta' && e.data['text'] === ''), 'пустая дельта уехала в историю')
  })

  it('страница: с конца по бюджету, с начала хода; before листает назад; хотя бы одно событие', () => {
    const evs = compactHistory([...turn('p'), ...turn('p'), ...turn('p')])
    const turns = evs.filter((e) => e.kind === 'message.user').map((e) => e.id)
    const size = (es: readonly PultEvent[]): number => es.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0)
    const lastTurn = evs.filter((e) => e.id >= (turns[2] as number))
    const p1 = pageHistory(evs, null, size(lastTurn) + 200)
    assert.equal(p1.events[0]?.kind, 'message.user')
    assert.equal(p1.events[0]?.id, turns[2])
    assert.equal(p1.more, true)
    const p2 = pageHistory(evs, p1.oldest, 10_000_000)
    assert.equal(p2.more, false)
    assert.deepEqual([...p2.events, ...p1.events].map((e) => e.id), evs.map((e) => e.id))
    const tiny = pageHistory(evs, null, 1)
    assert.equal(tiny.events.length, 1)
  })
})

describe('старт по снимку', () => {
  it('фон, контекст и лимиты — как после доигрывания; Inbox и статусы реестра не тронуты; статус не из limit.hit', () => {
    const bgOld = ev('b', 'background.changed', { count: 3, tasks: [] })
    const started = ev('daemon', 'daemon.started', {})
    const bgNew = ev('a', 'background.changed', { count: 2, tasks: [{ description: 'сборка' }] })
    const ctx = ev('a', 'context.updated', { used: 5000, window: 1_000_000, model: 'claude-opus-5-5' })
    const usage = ev('a', 'usage.updated', { provider: 'claude', status: 'allowed', windows: { fiveHour: { utilization: 0.4, resetsAt: 1_800_009_000 } } })
    const limit = ev('l', 'limit.hit', { provider: 'claude', resetsAt: 1_800_010_000 })
    // До снимка окно уже узнало Inbox (perm.list) и статусы (agent.list).
    let prev: UiState = { ...EMPTY_STATE, inbox: applyInbox(EMPTY_STATE.inbox, ev('a', 'permission.requested', { id: 'p1', toolName: 'Bash', input: {} })) }
    prev = syncStatuses(prev, [{ name: 'a', lastStatus: 'blocked_permission', lastEventId: 900, createdAt: '2026-10-14T00:00:00.000Z', provider: 'claude', cwd: '/tmp', mode: 'turn', pendingPermissions: 1 } as AgentRecord])
    const snapEvents = [bgOld, started, bgNew, ctx, usage, limit]
    const s = bootState({ events: snapEvents, activity: { a: '2026-10-14T10:00:00.000Z', c: '2026-10-14T09:00:00.000Z' }, cursor: limit.id + 100 }, prev)
    const replayed = applyEvents(EMPTY_STATE, snapEvents)
    assert.equal(s.lazy, true)
    assert.equal(s.lastId, limit.id + 100)
    assert.equal(s.bootId, started.id)
    assert.deepEqual(Object.keys(s.inbox), ['p1'])
    assert.equal(s.sessions['a']?.status, 'blocked_permission')
    assert.equal(s.sessions['l']?.status, 'cold', 'статус по старому limit.hit залипнет после рестарта демона')
    assert.deepEqual(s.sessions['a']?.background, { count: 2, tasks: ['сборка'] })
    assert.deepEqual(s.sessions['b']?.background, { count: 0, tasks: [] })
    assert.deepEqual(s.sessions['a']?.context, replayed.sessions['a']?.context)
    assert.deepEqual(s.usage, replayed.usage)
    assert.equal(s.sessions['a']?.lastTs, '2026-10-14T10:00:00.000Z')
    assert.equal(s.sessions['c']?.status, 'cold')
    assert.equal(s.sessions['l']?.conv.items.length, 0, 'уведомление снимка пролезло в ленту до её загрузки')
    assert.equal(needsHydrate(s, 'a'), true)
    assert.equal(needsHydrate(EMPTY_STATE, 'a'), false, 'полное доигрывание не грузит историю')
  })
})

describe('лента по требованию', () => {
  it('«в пути» — поверх истории ровно раз; очередь окна с номерами ≤ курсора не двоит текст; карточки старше запуска демона гаснут', () => {
    const before = ev('h', 'permission.requested', { id: 'p-old', toolName: 'Bash', input: { command: 'ls' } })
    const started = ev('daemon', 'daemon.started', {})
    const evs = turn('h')
    const cutAt = 14
    const history = [before, ...evs.slice(0, cutAt)]
    const cursor = (history[history.length - 1] as PultEvent).id
    let s = bootState({ events: [started], activity: {}, cursor: cursor - 3 })
    // Три последних события истории окно получит живьём, но отрисует (из очереди) только ПОСЛЕ истории.
    const queued = history.slice(-3)
    s = beginHydrate(s, 'h')
    s = finishHydrate(s, 'h', page(compactHistory(history), cursor))
    s = applyEvents(s, queued)
    s = applyEvents(s, evs.slice(cutAt))
    const full = fold([...history, ...evs.slice(cutAt)])
    const got = s.sessions['h']
    const strip = (items: readonly ConvItem[]): unknown[] => norm(items.filter((i) => i.type !== 'perm'))
    assert.deepEqual(strip(got?.conv.items ?? []), strip(full?.conv.items ?? []), 'текст идущей реплики задвоился')
    const perms = (got?.conv.items ?? []).filter((i) => i.type === 'perm').map((i) => (i.type === 'perm' ? [i.permId, i.state] : null))
    assert.deepEqual(perms, [['p-old', 'expired'], ['p-mid', 'allow']])
  })

  it('события, пришедшие, пока история в пути (номера > курсора), доигрываются; статус и фон — текущие', () => {
    let s = bootState({ events: [ev('q', 'background.changed', { count: 1, tasks: [] })], activity: {}, cursor: 1000 })
    s = beginHydrate(s, 'q')
    s = applyEvent(s, { ...ev('q', 'message.user', { text: 'ещё вопрос' }), id: 1001 })
    s = applyEvent(s, { ...ev('q', 'status.changed', { status: 'working', turnId: 't9' }), id: 1002 })
    assert.equal(s.inflight['q']?.length, 2)
    s = finishHydrate(s, 'q', page([ev('q', 'message.user', { text: 'первый' }), ev('q', 'status.changed', { status: 'idle', turnId: 't1' })], 1000))
    assert.deepEqual((s.sessions['q']?.conv.items ?? []).filter((i) => i.type === 'user').map((i) => (i.type === 'user' ? i.text : '')), ['первый', 'ещё вопрос'])
    assert.equal(s.sessions['q']?.status, 'working')
    assert.deepEqual(s.sessions['q']?.background, { count: 1, tasks: [] })
    assert.equal(s.floors['q'], 1000)

    let f = beginHydrate(bootState({ events: [], activity: {}, cursor: 5 }), 'z')
    f = failHydrate(f, 'z')
    assert.equal(needsHydrate(f, 'z'), true)
    assert.equal(f.inflight['z'], undefined)
  })

  it('начало хода для порядка бесед — только из живого потока: открыть беседу не значит поднять её', () => {
    let s = bootState({ events: [], activity: {}, cursor: 2000 })
    s = beginHydrate(s, 'o')
    s = finishHydrate(s, 'o', page([ev('o', 'message.user', { text: 'давний' }), ev('o', 'status.changed', { status: 'idle', turnId: 't1' })], 2000))
    assert.equal(s.sessions['o']?.lastTurnTs, undefined, 'реплика из истории строку не двигает')
    const live = { ...ev('o', 'message.user', { text: 'новая' }), id: 2001 }
    s = applyEvent(s, live)
    assert.equal(s.sessions['o']?.lastTurnTs, live.ts)
    s = beginHydrate(s, 'p')
    s = applyEvent(s, { ...ev('p', 'message.user', { text: 'пока грузится' }), id: 2002 })
    const during = s.sessions['p']?.lastTurnTs
    s = finishHydrate(s, 'p', page([ev('p', 'message.user', { text: 'старая' })], 2000))
    assert.ok(during && s.sessions['p']?.lastTurnTs === during, 'живая реплика во время загрузки истории не теряется')
    s = syncStatuses(s, [{ name: 'o', lastStatus: 'working', lastEventId: 0, createdAt: live.ts, provider: 'claude', cwd: '/tmp', mode: 'turn', pendingPermissions: 0 } as AgentRecord])
    assert.equal(s.sessions['o']?.lastTurnTs, live.ts, 'статусы реестра время хода не стирают')
  })

  it('смена статуса из очереди окна с номером ≤ курсора не теряется: ход «идёт», а не «готов» (e2e «Стоп», «⌘Enter посреди хода»)', () => {
    // Порядок из провала e2e 20.10: агент заведён (реестр — cold), ход начат до открытия ленты. Окно уже
    // свернуло `message.user`; `status.changed working` ждёт в очереди окна (пачка 24 мс), а ответ
    // `events.history` обгоняет её — курсор истории как раз на `working`. `session.started` — выше курсора.
    let s = bootState({ events: [], activity: {}, cursor: seq })
    const user = ev('g', 'message.user', { text: 'Долгая задача' })
    const working = ev('g', 'status.changed', { status: 'working', turnId: 't1' })
    const started = ev('g', 'session.started', { providerSessionId: 'x' })
    s = syncStatuses(s, [{ name: 'g', lastStatus: 'cold', lastEventId: 0, createdAt: user.ts, provider: 'claude', cwd: '/tmp', mode: 'turn', pendingPermissions: 0 } as AgentRecord])
    s = applyEvent(s, user)
    assert.equal(s.sessions['g']?.status, 'cold')
    s = beginHydrate(s, 'g')
    s = applyEvent(s, user)
    s = finishHydrate(s, 'g', page([user, working], working.id))
    s = applyEvents(s, [working, started])
    assert.equal(s.sessions['g']?.status, 'working', 'смена статуса из-под «пола» выброшена — окно залипло на «готов»')
    assert.equal(s.sessions['g']?.statusId, working.id)
    assert.equal(s.sessions['g']?.lastTs, started.ts)
    assert.deepEqual((s.sessions['g']?.conv.items ?? []).filter((i) => i.type === 'user').map((i) => (i.type === 'user' ? i.text : '')), ['Долгая задача'], 'реплика задвоилась')

    // Событие из-под «пола» не двигает время активности назад и не трогает ленту.
    const later = ev('g', 'message.done', { text: 'готово' })
    let t = beginHydrate(bootState({ events: [], activity: {}, cursor: user.id - 1 }), 'g')
    t = finishHydrate(t, 'g', page([user, working, started, later], later.id))
    // Статуса у окна не было: из истории берётся только то, что живой поток уже прошёл, — остальное ляжет из очереди.
    assert.equal(t.sessions['g']?.status, 'cold')
    const shown = t.sessions['g']
    t = applyEvents(t, [user, working, started, later])
    assert.equal(t.sessions['g']?.lastTs, later.ts)
    assert.equal(t.sessions['g']?.status, 'working')
    assert.equal(t.sessions['g']?.conv, shown?.conv, 'событие из-под «пола» легло в ленту второй раз')
  })

  it('ранняя страница встаёт перед лентой; кнопка гаснет, когда раньше ничего нет', () => {
    const first = turn('e')
    const second = turn('e')
    let s = bootState({ events: [], activity: {}, cursor: 0 })
    s = beginHydrate(s, 'e')
    s = finishHydrate(s, 'e', { events: compactHistory(second), more: true, oldest: second[0]?.id ?? null, cursor: (second[second.length - 1] as PultEvent).id })
    assert.equal(s.earlier['e']?.more, true)
    s = beginEarlier(s, 'e')
    assert.equal(s.earlier['e']?.loading, true)
    s = finishEarlier(s, 'e', { events: compactHistory(first), more: false, oldest: first[0]?.id ?? null, cursor: 0 })
    const items = [...(s.earlier['e']?.items ?? []), ...(s.sessions['e']?.conv.items ?? [])]
    const users = items.filter((i) => i.type === 'user').map((i) => i.id)
    assert.deepEqual(users, [first[0]?.id, second[0]?.id])
    assert.equal(s.earlier['e']?.more, false)
    assert.equal(s.earlier['e']?.loading, false)
  })
})
