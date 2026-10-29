// О2 «внимание», часть 2 в окне: правила уведомлений (порог хода, вид для звука, предел пачки), очередь
// реплик под полем ввода, «Очередь стоит», карточка «Похоже, завис» в Inbox, заметка о молчании в ленте.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation, QueueList } from '../src/components/Conversation.js'
import { HOTKEYS, Inbox } from '../src/components/Panels.js'
import { buildAgents } from '../src/model/agents.js'
import type { AgentView } from '../src/model/agents.js'
import { applyConversation, EMPTY_CONVERSATION } from '../src/model/conversation.js'
import { inboxView } from '../src/model/inbox.js'
import {
  BURST_WINDOW_MS, DEFAULT_NOTIFY_RULES, EMPTY_THROTTLE, flushThrottle, notificationFor, notifyRules, offerNotice,
} from '../src/model/notify.js'
import type { Notice, Throttle } from '../src/model/notify.js'
import { refreshesAgents } from '../src/model/state.js'
import type { AgentRecord, PultEvent } from '../src/model/types.js'
import { composerCmdEnter } from '../src/model/hotkeys.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-10-14T10:00:10Z')

const ev = (kind: string, data: Record<string, unknown> = {}, over: Partial<PultEvent> = {}): PultEvent =>
  ({ id: 10, ts: '2026-10-14T10:00:05Z', sessionId: 'w', provider: 'claude', kind: kind as PultEvent['kind'], data, ...over })
const ag = (over: Partial<AgentView> = {}): AgentView =>
  ({ name: 'w', provider: 'claude', status: 'idle', cwd: '/srv/w', pending: 0, lastActivity: '2026-10-14T09:00:00Z', ...over })

describe('правила уведомлений', () => {
  it('конец хода — только длиннее порога; длительность неизвестна — как раньше', () => {
    const done = (turnMs?: number): Notice | null =>
      notificationFor(ev('status.changed', { status: 'idle', turnId: 't1', ...(turnMs !== undefined ? { turnMs } : {}) }), NOW, 'Починить VPN', { minTurnMs: 20_000 })
    assert.equal(done(5_000), null, 'короткий ход не зовёт')
    assert.deepEqual(done(25_000), { title: 'Починить VPN: ход закончен', body: 'сессия ждёт следующей реплики', target: { sessionId: 'w' }, kind: 'done' })
    assert.equal(done(undefined)?.kind, 'done', 'старый демон без turnMs')
    // Порог по умолчанию — 20 с.
    assert.equal(notificationFor(ev('status.changed', { status: 'idle', turnId: 't', turnMs: 19_000 }), NOW), null)
    assert.equal(DEFAULT_NOTIFY_RULES.minTurnSeconds, 20)
    // Итог фонового хода — тоже «готово».
    assert.equal(notificationFor(ev('status.changed', { status: 'idle', reason: 'background_turn_done', turnMs: 60_000 }), NOW)?.kind, 'done')
  })

  it('вопросы и ошибки — всегда, со своим видом; служебное и эхо лимита — нет', () => {
    const n = (e: PultEvent): Notice | null => notificationFor(e, NOW, undefined, { minTurnMs: 1_000_000 })
    assert.equal(n(ev('permission.requested', { id: 'p', toolName: 'Bash', input: { command: 'ls' } }))?.kind, 'ask')
    assert.equal(n(ev('status.changed', { status: 'failed', turnId: 't', turnMs: 10, message: 'упал' }))?.body, 'упал')
    assert.equal(n(ev('status.changed', { status: 'failed', turnId: 't' }))?.kind, 'error')
    assert.equal(n(ev('limit.hit', { status: 'rejected', rateLimitType: 'five_hour' }))?.title, 'w: лимит исчерпан')
    assert.equal(n(ev('limit.hit', { status: 'allowed_warning' })), null, 'предупреждение — не лимит')
    assert.equal(n(ev('status.changed', { status: 'limited', turnId: 't' })), null, 'эхо limit.hit не дублирует уведомление')
    assert.equal(n(ev('net.blocked', { reason: 'blocked_country', loc: 'RU' }))?.kind, 'error')
    const stall = n(ev('turn.stalled', { turnId: 't', silentForMs: 600_000 }))
    assert.deepEqual([stall?.title, stall?.kind, stall?.body], ['w: похоже, завис', 'error', 'ход молчит 10 мин — прервать или ждать?'])
    assert.equal(n(ev('status.changed', { status: 'idle', reason: 'warm_ttl' })), null)
    assert.equal(n(ev('status.changed', { status: 'idle', turnId: 't' }, { sessionId: 'daemon' })), null)
    assert.equal(n(ev('turn.stalled', {}, { ts: '2026-10-14T09:00:00Z' })), null, 'доигрывание истории молчит')
  })

  it('правила из daemon.status: кривое — по умолчанию', () => {
    assert.deepEqual(notifyRules({ minTurnSeconds: 5, sound: false }), { minTurnSeconds: 5, sound: false })
    assert.deepEqual(notifyRules(undefined), DEFAULT_NOTIFY_RULES)
    assert.deepEqual(notifyRules({ minTurnSeconds: -3, sound: 'no' }), DEFAULT_NOTIFY_RULES)
  })

  it('не больше двух за 10 с; остальное — одной сводкой, когда окно закроется', () => {
    const notice = (sessionId: string, kind: Notice['kind'] = 'done'): Pick<Notice, 'target' | 'kind'> => ({ target: { sessionId }, kind })
    let t: Throttle = EMPTY_THROTTLE
    const shown: boolean[] = []
    let flushAt: number | null = null
    for (const [i, n] of [notice('a'), notice('b'), notice('c', 'ask'), notice('d', 'error'), notice('c')].entries()) {
      const r = offerNotice(t, n, 1000 + i * 100)
      t = r.t
      shown.push(r.show)
      if (r.flushAt !== null) flushAt = r.flushAt
    }
    assert.deepEqual(shown, [true, true, false, false, false])
    assert.equal(flushAt, 1000 + BURST_WINDOW_MS, 'сводка — когда закроется окно первого уведомления')
    const f = flushThrottle(t, flushAt as number)
    assert.deepEqual(f.summary, { title: 'Пульт', body: 'ещё 2 сессии ждут тебя', target: { inbox: true }, kind: 'error' })
    assert.equal(f.t.held.length, 0)
    // Сводка заняла место в окне: пока второе уведомление (1100) не вышло из окна, новое ждёт.
    assert.equal(offerNotice(f.t, notice('e'), (flushAt as number) + 1).show, false)
    const later = 1100 + BURST_WINDOW_MS + 1
    const after = offerNotice(f.t, notice('e'), later)
    assert.equal(after.show, true)
    assert.equal(offerNotice(after.t, notice('f'), later + 1).show, false, 'сводка и это — уже два')
    // Одна придержанная сессия — сводка ведёт к ней.
    const one = flushThrottle({ sent: [], held: [{ sessionId: 'x', kind: 'ask' }] }, 0).summary
    assert.deepEqual([one?.body, one?.target, one?.kind], ['ещё 1 сессия ждёт тебя', { sessionId: 'x' }, 'ask'])
    assert.equal(flushThrottle(EMPTY_THROTTLE, 0).summary, null)
  })

  it('turn.stalled обновляет список агентов', () => {
    assert.equal(refreshesAgents(ev('turn.stalled')), true)
  })
})

describe('очередь реплик под полем ввода', () => {
  const convProps = (a: AgentView, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    agent: a, items: [], now: NOW, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
    onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    onQueueRemove: noop, onQueueMove: noop, onQueueResume: noop, ...over,
  })

  it('agent.list → очередь в строке агента', () => {
    const rec: AgentRecord = {
      name: 'w', provider: 'claude', cwd: '/srv/w', mode: 'turn', createdAt: '2026-10-14T08:00:00Z', lastStatus: 'working', lastEventId: 0,
      pendingPermissions: 0, queue: [{ id: 'a1', text: 'потом', at: '' }], queuePaused: true,
    }
    const [a] = buildAgents([rec], {})
    assert.deepEqual([a?.queue?.map((x) => x.id), a?.queuePaused], [['a1'], true])
    assert.equal(buildAgents([{ ...rec, queue: [], queuePaused: false }], {})[0]?.queue, undefined)
  })

  it('идёт ход: поле открыто, «В очередь», подсказка про ⌘Enter; очередь — текст, ↑↓ и ×', () => {
    const a = ag({ status: 'working', queue: [{ id: 'a1', text: 'первая', at: '' }, { id: 'b2', text: 'вторая', at: '' }] })
    const h = html(Conversation, convProps(a))
    assert.match(h, /data-testid="send"[^>]*>.*В очередь/)
    assert.doesNotMatch(h, /data-testid="send"[^>]*disabled/, 'кнопка не заперта ходом (заперта только пустым полем)')
    assert.match(h, /Enter поставит реплику в очередь/)
    assert.equal((h.match(/data-testid="queue-item"/g) ?? []).length, 2)
    assert.match(text(h), /1 первая .* 2 вторая/)
    // Первую выше не поднять, последнюю ниже не опустить.
    const items = h.split('data-testid="queue-item"').slice(1)
    assert.match(items[0] ?? '', /disabled=""[^>]*data-testid="queue-up"/)
    assert.doesNotMatch(items[1] ?? '', /disabled=""[^>]*data-testid="queue-up"/)
    assert.match(items[1] ?? '', /disabled=""[^>]*data-testid="queue-down"/)
    assert.doesNotMatch(h, /queue-paused/)
  })

  it('старый демон (без очереди): поле заперто ходом, как раньше', () => {
    const h = html(Conversation, convProps(ag({ status: 'working' }), { onQueueRemove: undefined }))
    assert.match(h, /data-testid="send"[^>]*>.*Отправить/)
    assert.match(h, /дождись конца или нажми «Стоп»/)
    assert.doesNotMatch(h, /data-testid="queue"/)
  })

  it('очередь стоит: плашка и «Продолжить»', () => {
    const h = html(QueueList, { queue: [{ id: 'a1', text: 'после падения', at: '' }], paused: true, onRemove: noop, onMove: noop, onResume: noop })
    assert.match(h, /data-testid="queue-paused"/)
    assert.match(text(h), /Очередь стоит: ход не удался/)
    assert.match(h, /data-testid="queue-resume"[^>]*>Продолжить/)
    // Значок плашки — со своим размером: без него SVG растягивался на всю беседу и сжимал текст в столбик.
    assert.match(h, /data-testid="queue-paused"><svg class="ic" width="16" height="16" viewBox="0 0 16 16"/)
    const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /^\.ic \{ width: 16px; height: 16px; flex: none; \}/m, 'нет размера значка по умолчанию')
    assert.match(css, /^\.queue-paused \.ic \{ width: 15px; height: 15px; flex: none;/m, 'нет размера значка плашки «Очередь стоит»')
    // Свободная сессия без очереди — ничего под полем.
    assert.doesNotMatch(html(Conversation, convProps(ag())), /data-testid="queue"/)
  })

  it('справка клавиш знает очередь и «прервать и сказать»', () => {
    const keys = HOTKEYS.map(([k, v]) => `${k} ${v}`).join('\n')
    assert.match(keys, /Enter отправить реплику · идёт ход — поставить её в очередь/)
    assert.match(keys, /в поле идёт ход — прервать его и сразу сказать реплику/)
  })
})

describe('«Похоже, завис»: карточка Inbox и заметка в ленте', () => {
  const stalled = ag({
    status: 'working', unread: true,
    attention: { id: 40, kind: 'stalled', at: '2026-10-14T09:58:00Z', text: 'ход молчит 12 мин', turnId: 't7' },
  })

  it('карточка-ошибка с «Прервать» и «Ждать», без «Повторить»', () => {
    const view = inboxView('errors', [], [stalled])
    assert.deepEqual(view.sessions.map((c) => [c.kind, c.error, c.retryable]), [['stalled', true, false]])
    const h = html(Inbox, { items: [], cards: view.sessions, filter: 'errors', agents: [stalled], focused: null, busy: new Set(), now: NOW,
      onFocus: noop, onApprove: noop, onDeny: noop, onClose: noop, onFilter: noop, onOpen: noop, onRetry: noop, onStop: noop, onWait: noop })
    assert.match(h, /data-kind="stalled"/)
    assert.match(text(h), /Похоже, завис/)
    assert.match(text(h), /ход молчит 12 мин/)
    assert.match(h, /data-testid="inbox-stall-stop"[^>]*>.*Прервать/)
    assert.match(h, /data-testid="inbox-stall-wait"[^>]*>Ждать/)
    assert.doesNotMatch(h, /inbox-retry/)
  })

  it('лента: заметка «Похоже, завис» с минутами', () => {
    const conv = applyConversation(EMPTY_CONVERSATION, ev('turn.stalled', { turnId: 't7', silentForMs: 720_000 }))
    const it0 = conv.items[0] as { type: string; title: string; text?: string; tone: string }
    assert.deepEqual([it0.type, it0.tone, it0.title], ['notice', 'wait', 'Похоже, завис'])
    assert.match(it0.text ?? '', /ход молчит 12 мин/)
  })
})

describe('⌘Enter в поле ввода', () => {
  it('прерывает только идущий ход с текстом; сессия ждёт тебя или выделен запрос — остаётся «разрешить»', () => {
    const base = { busy: true, needsYou: false, permFocused: false, queueable: true, hasText: true, blocked: false }
    assert.equal(composerCmdEnter(base), 'interrupt')
    assert.equal(composerCmdEnter({ ...base, needsYou: true }), 'window', 'ждёт разрешения — не прерывать')
    assert.equal(composerCmdEnter({ ...base, permFocused: true }), 'window')
    assert.equal(composerCmdEnter({ ...base, busy: false }), 'window')
    assert.equal(composerCmdEnter({ ...base, hasText: false }), 'window')
    assert.equal(composerCmdEnter({ ...base, queueable: false }), 'window', 'старый демон')
    assert.equal(composerCmdEnter({ ...base, blocked: true }), 'window')
  })
})
