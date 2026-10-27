// О2 «внимание» в окне: непрочитанное в строках и вкладках, очередь ⌘⌥L / ⌃⌘L, ⌥⌘U, ошибки и фильтры Inbox.
// Модель — чистыми функциями, разметка — renderToStaticMarkup, как в render.test.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HOTKEYS, HotkeysHelp, Inbox } from '../src/components/Panels.js'
import { ProjectTree } from '../src/components/ProjectTree.js'
import { SessionTabs } from '../src/components/SessionTabs.js'
import { buildAgents } from '../src/model/agents.js'
import type { AgentView } from '../src/model/agents.js'
import { attentionKeys, hotkeyAction } from '../src/model/hotkeys.js'
import { inboxCounts, inboxView, isInboxFilter } from '../src/model/inbox.js'
import type { InboxItem } from '../src/model/inbox.js'
import { groupByProject } from '../src/model/projects.js'
import { isSnoozed, nextWaiting, pruneSnoozed, snooze, unsnooze, waitingQueue } from '../src/model/queue.js'
import { refreshesAgents } from '../src/model/state.js'
import type { AgentRecord, Attention, PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-10-14T10:00:00Z')

const att = (id: number, kind: Attention['kind'], text?: string, turnId?: string): Attention =>
  ({ id, kind, at: '2026-10-14T09:58:00Z', ...(text ? { text } : {}), ...(turnId ? { turnId } : {}) })
const ag = (name: string, over: Partial<AgentView> = {}): AgentView =>
  ({ name, provider: 'claude', status: 'idle', cwd: '/srv/w', pending: 0, lastActivity: '2026-10-14T09:00:00Z', ...over })
const rec = (name: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
  name, provider: 'claude', cwd: '/srv/w', mode: 'turn', createdAt: '2026-10-14T08:00:00Z', lastStatus: 'idle', lastEventId: 0, pendingPermissions: 0, ...over,
})
const perm = (id: string, sessionId: string): InboxItem => ({ id, sessionId, toolName: 'Bash', input: { command: 'ls' }, createdAt: '2026-10-14T09:59:00Z' })

describe('окно: непрочитанное из agent.list', () => {
  it('buildAgents: unread и attention по отметке «видел»; старый демон без полей — ничего не непрочитано', () => {
    const [a, b, c, d] = buildAgents([
      rec('a', { attention: att(10, 'done'), lastSeenEventId: 5 }),
      rec('b', { attention: att(10, 'failed', 'упал'), lastSeenEventId: 10 }),
      rec('c', { lastSeenEventId: 99, markedUnread: true }),
      rec('d'),
    ], {}).sort((x, y) => x.name.localeCompare(y.name))
    assert.deepEqual([a?.unread, a?.attention?.kind], [true, 'done'])
    assert.deepEqual([b?.unread, b?.attention?.text], [undefined, 'упал'])
    assert.equal(c?.unread, true)
    assert.deepEqual([d?.unread, d?.attention], [undefined, undefined])
  })

  it('проект считает непрочитанные сессии', () => {
    const g = groupByProject(['/srv/w'], [ag('a', { unread: true }), ag('b'), ag('c', { unread: true })])
    assert.deepEqual(g.map((x) => [x.name, x.unread]), [['w', 2]])
  })

  it('лимит, страж и вопрос обновляют список — по нему живут точка и ошибки Inbox', () => {
    const e = (kind: string): PultEvent => ({ id: 1, ts: '', sessionId: 'w', provider: 'claude', kind: kind as PultEvent['kind'], data: {} })
    for (const k of ['limit.hit', 'net.blocked', 'provider.blocked', 'question.asked', 'status.changed']) assert.equal(refreshesAgents(e(k)), true, k)
    assert.equal(refreshesAgents(e('message.delta')), false)
  })
})

describe('клавиатурная разборка очереди', () => {
  const k = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }>, key = '') =>
    ({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt })

  it('мак: ⌘⌥L, ⌃⌘L, ⌥⌘U — по коду клавиши (⌥ меняет символ), точным набором модификаторов', () => {
    assert.deepEqual(hotkeyAction(k('KeyL', { meta: true, alt: true }, '¬'), true), { type: 'nextWaiting' })
    assert.deepEqual(hotkeyAction(k('KeyL', { meta: true, ctrl: true }, 'l'), true), { type: 'snooze' })
    assert.deepEqual(hotkeyAction(k('KeyU', { meta: true, alt: true }, '¨'), true), { type: 'markUnread' })
    assert.deepEqual(hotkeyAction(k('KeyL', { meta: true, alt: true }, 'д'), true), { type: 'nextWaiting' }, 'русская раскладка')
    assert.equal(hotkeyAction(k('KeyL', { meta: true, alt: true, ctrl: true }), true), null)
    assert.equal(hotkeyAction(k('KeyL', { meta: true }), true), null)
    assert.equal(hotkeyAction(k('KeyU', { meta: true, ctrl: true }), true), null)
    assert.equal(hotkeyAction(k('KeyL', { ctrl: true, alt: true }), true), null, 'вне мака-набора на маке — ничего')
  })

  it('не мак: Ctrl+Alt+L, Ctrl+Shift+L, Ctrl+Alt+U', () => {
    assert.deepEqual(hotkeyAction(k('KeyL', { ctrl: true, alt: true }), false), { type: 'nextWaiting' })
    assert.deepEqual(hotkeyAction(k('KeyL', { ctrl: true, shift: true }), false), { type: 'snooze' })
    assert.deepEqual(hotkeyAction(k('KeyU', { ctrl: true, alt: true }), false), { type: 'markUnread' })
    assert.equal(hotkeyAction(k('KeyL', { meta: true, alt: true }), false), null)
    assert.deepEqual(attentionKeys(false), { next: 'Ctrl+Alt+L', snooze: 'Ctrl+Shift+L', unread: 'Ctrl+Alt+U' })
  })

  it('прежние клавиши не задеты: ⌘N, ⌘1, ⌘/', () => {
    assert.deepEqual(hotkeyAction(k('KeyN', { meta: true }, 'n'), true), { type: 'newAgent' })
    assert.deepEqual(hotkeyAction(k('Digit1', { meta: true }, '1'), true), { type: 'selectAgent', index: 0 })
    assert.deepEqual(hotkeyAction(k('Slash', { meta: true }, '/'), true), { type: 'help' })
  })

  const agents = [
    ag('done-old', { unread: true, attention: att(3, 'done') }),
    ag('ask', { pending: 1, attention: att(7, 'ask') }),
    ag('err-new', { unread: true, attention: att(9, 'failed', 'x') }),
    ag('quiet', { attention: att(2, 'done') }),
    ag('err-old', { unread: true, attention: att(4, 'limit') }),
    ag('seen-err', { attention: att(5, 'failed') }),
    ag('done-new', { unread: true, attention: att(8, 'done') }),
  ]

  it('порядок: ошибки → запросы → непрочитанные готовые; внутри — кто ждёт дольше; прочитанные — не в очереди', () => {
    assert.deepEqual(waitingQueue(agents).map((a) => a.name), ['err-old', 'err-new', 'ask', 'done-old', 'done-new'])
    // Архивные: ошибка — нет; ждущий запрос — да (сессия стоит, пока ты не ответишь).
    const withArchived = [...agents, ag('arch-err', { unread: true, attention: att(1, 'failed'), archived: true }), ag('arch-ask', { pending: 2, archived: true })]
    assert.deepEqual(waitingQueue(withArchived).map((a) => a.name), ['err-old', 'err-new', 'arch-ask', 'ask', 'done-old', 'done-new'])
    assert.equal(nextWaiting([ag('arch', { unread: true, attention: att(1, 'failed'), archived: true })], null), null)
    assert.equal(nextWaiting(agents, null), 'err-old')
    assert.equal(nextWaiting(agents, 'err-old'), 'err-new', 'текущую пропускаем')
    assert.equal(nextWaiting([ag('quiet')], null), null)
    assert.equal(nextWaiting([ag('only', { unread: true, attention: att(1, 'done') })], 'only'), null)
  })

  it('отложенная — в конец своего класса, пока не случится новое событие внимания', () => {
    let s = snooze({}, agents[4]!)
    assert.equal(isSnoozed(agents[4]!, s), true)
    assert.deepEqual(waitingQueue(agents, s).map((a) => a.name), ['err-new', 'err-old', 'ask', 'done-old', 'done-new'])
    assert.equal(nextWaiting(agents, 'err-new', s), 'err-old', 'класс важнее отложенности')
    const fresh = agents.map((a) => (a.name === 'err-old' ? { ...a, attention: att(12, 'limit') } : a))
    assert.equal(isSnoozed(fresh[4]!, s), false, 'новое событие — снова в очереди')
    assert.deepEqual(pruneSnoozed(s, fresh), {})
    assert.deepEqual(unsnooze(s, 'err-old'), {}, 'пришёл сам — снова не отложена')
    assert.equal(unsnooze(s, 'nope'), s, 'нечего снимать — тот же объект')
    s = snooze(s, agents[0]!)
    assert.equal(pruneSnoozed(s, agents), s, 'без перемен — тот же объект')
    assert.deepEqual(Object.keys(pruneSnoozed(s, agents.filter((a) => a.name !== 'done-old'))), ['err-old'], 'удалённая сессия забывается')
  })

  it('все три — в справке ⌘/', () => {
    const keys = HOTKEYS.map(([k]) => k)
    const mac = attentionKeys(true)
    const other = attentionKeys(false)
    for (const [m, o] of [[mac.next, other.next], [mac.snooze, other.snooze], [mac.unread, other.unread]] as const) {
      assert.ok(keys.includes(m) || keys.includes(o), `${m} нет в справке`)
    }
    const out = text(html(HotkeysHelp, { onClose: noop }))
    assert.match(out, /следующая сессия, которая ждёт тебя/)
    assert.match(out, /отложить текущую/)
    assert.match(out, /пометить текущую непрочитанной/)
  })
})

describe('Inbox: ошибки и фильтры', () => {
  const agents = [
    ag('err', { unread: true, attention: att(9, 'failed', 'процесс упал', 't9') }),
    ag('lim', { unread: true, attention: att(4, 'limit', 'five_hour') }),
    ag('done', { unread: true, attention: att(6, 'done') }),
    ag('seen', { attention: att(8, 'blocked', 'blocked_country') }),
    ag('marked', { unread: true }),
    ag('arch', { unread: true, archived: true, attention: att(2, 'failed', 'давно', 't2') }),
  ]
  const perms = [perm('p1', 'ask')]

  it('«Все» — запросы и непрочитанные ошибки; «Непрочитанные» — все непрочитанные сессии; «Ошибки» — только ошибки', () => {
    const all = inboxView('all', perms, agents)
    assert.deepEqual(all.perms.map((p) => p.id), ['p1'])
    assert.deepEqual(all.sessions.map((c) => [c.name, c.kind, c.text ?? null]), [['lim', 'limit', 'five_hour'], ['err', 'failed', 'процесс упал']])
    const unread = inboxView('unread', perms, agents)
    assert.deepEqual(unread.perms, [])
    assert.deepEqual(unread.sessions.map((c) => [c.name, c.error]), [['marked', false], ['lim', true], ['done', false], ['err', true]])
    const errors = inboxView('errors', perms, agents)
    assert.deepEqual([errors.perms.length, errors.sessions.map((c) => c.name)], [0, ['lim', 'err']])
    assert.deepEqual(inboxCounts(perms, agents), { all: 3, unread: 4, errors: 2 }, 'архивные не считаются')
    assert.ok(!unread.sessions.some((c) => c.name === 'arch'), 'и не показываются')
    // «Повторить» — только у ошибки хода (turnId) и только пока сессия не занята.
    assert.deepEqual(all.sessions.map((c) => [c.name, c.retryable]), [['lim', false], ['err', true]])
    assert.equal(inboxView('errors', [], [ag('busy', { status: 'working', unread: true, attention: att(9, 'failed', 'x', 't9') })]).sessions[0]?.retryable, false)
    assert.equal(isInboxFilter('errors'), true)
    assert.equal(isInboxFilter('мусор'), false)
  })

  const props = (filter: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
    const v = inboxView(filter as 'all', perms, agents)
    return {
      items: v.perms, cards: v.sessions, filter, counts: inboxCounts(perms, agents), agents, focused: null, busy: new Set(), now: NOW,
      onFocus: noop, onApprove: noop, onDeny: noop, onClose: noop, onFilter: noop, onOpen: noop, onRetry: noop, ...over,
    }
  }

  it('шапка: три фильтра с числами, выбранный нажат', () => {
    const out = html(Inbox, props('errors'))
    assert.match(out, /data-filter="errors"/)
    assert.match(out, /aria-pressed="false"[^>]*data-testid="inbox-filter-all">Все<span class="n">3<\/span>/)
    assert.match(out, /aria-pressed="false"[^>]*data-testid="inbox-filter-unread">Непрочитанные<span class="n">4<\/span>/)
    assert.match(out, /aria-pressed="true"[^>]*data-testid="inbox-filter-errors">Ошибки<span class="n">2<\/span>/)
  })

  it('карточка ошибки: вид, сессия, причина, «Повторить» и «Открыть»; запросы — следом', () => {
    const out = html(Inbox, props('all'))
    const errs = out.match(/data-testid="inbox-error"/g) ?? []
    assert.equal(errs.length, 2)
    assert.match(out, /data-testid="inbox-error" data-agent="err" data-kind="failed" data-error="1"/)
    assert.match(text(out), /Ход упал err claude .* процесс упал Повторить Открыть/)
    assert.match(text(out), /Лимит исчерпан lim .* five_hour Открыть Ход упал/, 'у лимита аккаунта (без хода) — только «Открыть»')
    assert.ok(out.indexOf('data-agent="lim"') < out.indexOf('data-perm-id="p1"'), 'ошибки — над запросами')
    assert.doesNotMatch(out, /data-testid="inbox-unread"/, '«готово» в «Все» не показывается')
    assert.match(html(Inbox, props('all', { retrying: new Set(['err']) })), /disabled=""[^>]*data-testid="inbox-retry"[^>]*>.*Повторяю…/)
  })

  it('«Непрочитанные»: у «готово» — только «Открыть»; пустые фильтры говорят своё', () => {
    const out = html(Inbox, props('unread'))
    assert.match(out, /data-testid="inbox-unread" data-agent="done" data-kind="done" data-error="0"/)
    assert.equal((out.match(/data-testid="inbox-retry"/g) ?? []).length, 1, '«Повторить» только у ошибки хода (у лимита аккаунта — нет)')
    const empty = (filter: string): string => text(html(Inbox, { ...props(filter), items: [], cards: [] }))
    assert.match(empty('all'), /Никто ничего не ждёт/)
    assert.match(empty('unread'), /Непрочитанного нет/)
    assert.match(empty('errors'), /Ошибок нет/)
  })

  it('стили карточек и точек — на токенах темы', () => {
    const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
    for (const sel of ['.unread-dot', '.unread-dot[data-error="1"]', '.proj-unread', '.inbox-filter', '.inbox-session[data-error="1"]']) {
      assert.ok(css.includes(sel), sel)
    }
    assert.match(css, /\.unread-dot\[data-error="1"\] \{ background: var\(--fail\); \}/)
  })
})

describe('точка «непрочитано» в дереве и на вкладке', () => {
  const tree = (agents: AgentView[]) => ({
    groups: groupByProject(['/srv/w'], agents), selected: null, now: NOW, collapsed: new Set<string>(),
    onSelect: noop, onNew: noop, onToggle: noop, onAddProject: noop, onPin: noop,
  })

  it('строка: точка перед названием, красная у ошибки; у проекта — счётчик непрочитанных', () => {
    const out = html(ProjectTree, tree([ag('a', { unread: true, attention: att(1, 'done') }), ag('b', { unread: true, attention: att(2, 'failed') }), ag('c')]))
    assert.match(out, /data-unread="1" data-testid="agent-row" data-agent="a"/)
    assert.match(out, /data-agent="a"[^]*?<span class="ag-name"><span class="unread-dot" data-error="0" data-testid="row-unread"[^>]*><\/span>a</)
    assert.match(out, /data-agent="b"[^]*?class="unread-dot" data-error="1"/)
    assert.match(out, /data-unread="0" data-testid="agent-row" data-agent="c"/)
    assert.equal((out.match(/data-testid="row-unread"/g) ?? []).length, 2)
    assert.match(out, /data-testid="project-unread" title="2 непрочитанные беседы">2</)
    assert.doesNotMatch(html(ProjectTree, tree([ag('c')])), /project-unread|row-unread/)
  })

  it('вкладка: точка после названия', () => {
    const out = html(SessionTabs, { tabs: [ag('a', { unread: true }), ag('b')], active: 'b', onSelect: noop, onClose: noop })
    assert.match(out, /data-unread="1" data-testid="session-tab" data-agent="a"/)
    assert.match(out, /class="tab-name">a<\/span><span class="unread-dot"[^>]*data-testid="tab-unread"/)
    assert.equal((out.match(/data-testid="tab-unread"/g) ?? []).length, 1)
  })
})
