import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SESSION_NAME_RE, SESSION_TITLE_MAX } from '../../src/sessions/registry.js'
import { AGENT_TITLE_MAX, agentLabel, ago, buildAgents, shortPath, sortAgents, statusView, waitingCount } from '../src/model/agents.js'
import type { AgentView } from '../src/model/agents.js'
import { blockedProviders, doctorGroups, doctorTone, guardFromDoctor, guardView, providerStatusView } from '../src/model/health.js'
import { hotkeyAction } from '../src/model/hotkeys.js'
import { applyInbox, EMPTY_INBOX, focusedRequest, inboxList, pendingBySession, reconcileInbox } from '../src/model/inbox.js'
import { parseInline, parseMarkdown, safeHref, splitRow } from '../src/model/markdown.js'
import type { Block, Inline } from '../src/model/markdown.js'
import { insertPaths, quotePath } from '../src/model/paths.js'
import { answersReady, buildAnswers, isQuestionTool, questionsOf } from '../src/model/questions.js'
import { closeTab, groupByProject, openTab, projectName, pruneTabs } from '../src/model/projects.js'
import { AGENT_NAME_RE, defaultForm, linkForm, linkPrefill, LINK_PROMPT_MAX_LINES, promptStats, PRESETS, providerPreset, startParams, suggestName, switchProvider, validateForm } from '../src/model/newAgent.js'
import { armLinkGuard, keysGuarded, LINK_KEY_GUARD_MS, resetLinkGuard, swallowsKey, takeAutoFocus } from '../src/lib/linkGuard.js'
import { describePermission, gutterNo, lineDiff, parseUnifiedDiff } from '../src/model/permissions.js'
import { applyEvents, EMPTY_STATE, notificationFor, syncStatuses } from '../src/model/state.js'
import { applyContext, contextRowView, contextTone, contextView, formatExact, formatTokens } from '../src/model/context.js'
import type { AgentRecord, DoctorReport, PultEvent } from '../src/model/types.js'
import { applyUsage, EMPTY_USAGE, formatClock, formatPct, formatResetIn, limitHolds, limitWindowsView, usageTone, usageForDisplay } from '../src/model/usage.js'

let seq = 100
const ev = (kind: string, data: Record<string, unknown> = {}, over: Partial<PultEvent> = {}): PultEvent => ({
  id: ++seq, ts: '2026-09-28T10:00:00.000Z', sessionId: 'w', provider: 'claude',
  kind: kind as PultEvent['kind'], data, ...over,
})

const view = (name: string, status: AgentView['status'], lastTurnAt: string, pending = 0): AgentView =>
  ({ name, provider: 'claude', status, cwd: '/x', pending, lastActivity: '2026-09-28T10:00:00Z', lastTurnAt })

describe('агенты: статусы и порядок', () => {
  it('ждущие тебя первыми, потом работающие, потом остальные по началу последнего хода', () => {
    const sorted = sortAgents([
      view('old-idle', 'idle', '2026-09-28T08:00:00Z'),
      view('work', 'working', '2026-09-28T09:00:00Z'),
      view('fresh-idle', 'idle', '2026-09-28T09:59:00Z'),
      view('asks', 'blocked_permission', '2026-09-28T07:00:00Z'),
      view('failed', 'failed', '2026-09-28T09:30:00Z'),
      view('pending-but-working', 'working', '2026-09-28T06:00:00Z', 1),
    ])
    assert.deepEqual(sorted.map((a) => a.name), ['asks', 'pending-but-working', 'work', 'fresh-idle', 'failed', 'old-idle'])
    assert.equal(waitingCount(sorted), 2)
  })

  it('порядок по началу хода: реплика поднимает беседу один раз; поток, инструменты и фон — нет; без хода — createdAt', () => {
    const rec = (name: string, createdAt: string, lastTurnAt?: string): AgentRecord =>
      ({ name, provider: 'claude', cwd: '/x', mode: 'turn', createdAt, ...(lastTurnAt ? { lastTurnAt } : {}), lastStatus: 'idle', lastEventId: 0, pendingPermissions: 0 })
    const records = [
      rec('old', '2026-09-28T08:00:00.000Z'),
      rec('mid', '2026-09-28T09:00:00.000Z', '2026-09-28T09:30:00.000Z'),
      rec('new', '2026-09-28T09:10:00.000Z'),
    ]
    const order = (live: Parameters<typeof buildAgents>[1]): string[] => buildAgents(records, live).map((a) => a.name)
    // Старые записи без lastTurnAt — по createdAt; ход (mid) выше созданной позже без хода.
    assert.deepEqual(order({}), ['mid', 'new', 'old'])
    // Живой поток: реплика человека в «old» — наверх сразу, до agent.list.
    let st = applyEvents(EMPTY_STATE, [ev('message.user', { text: 'привет' }, { sessionId: 'old', ts: '2026-09-28T10:00:00.000Z' })])
    const live = (): Parameters<typeof buildAgents>[1] => Object.fromEntries(Object.entries(st.sessions).map(([n, l]) => [n, { status: 'idle' as const, lastTs: l.lastTs, ...(l.lastTurnTs ? { lastTurnTs: l.lastTurnTs } : {}) }]))
    assert.deepEqual(order(live()), ['old', 'mid', 'new'])
    // Дальше ход «mid»: поток, инструменты, субагент, фон, конец хода и сторож — порядок тот же.
    st = applyEvents(st, ['message.delta', 'tool.called', 'tool.finished', 'agent.spawned', 'background.changed', 'turn.stalled'].map((k, i) =>
      ev(k, k === 'background.changed' ? { count: 1, tasks: [] } : {}, { sessionId: 'mid', ts: `2026-09-28T11:0${i}:00.000Z` })))
    st = applyEvents(st, [ev('status.changed', { status: 'idle' }, { sessionId: 'old', ts: '2026-09-28T12:00:00.000Z' })])
    assert.deepEqual(order(live()), ['old', 'mid', 'new'])
    assert.equal(st.sessions['mid']?.lastTurnTs, undefined, 'события без реплики время хода не заводят')
    // agent.list догнал: то же время из реестра — второго прыжка нет.
    records[0] = { ...records[0]!, lastTurnAt: '2026-09-28T10:00:00.000Z' }
    assert.deepEqual(order(live()), ['old', 'mid', 'new'])
    assert.equal(buildAgents(records, live()).find((a) => a.name === 'old')?.lastTurnAt, '2026-09-28T10:00:00.000Z')
    // Реестр новее живого (ход из CLI, пока окно спало) — побеждает реестр.
    records[2] = { ...records[2]!, lastTurnAt: '2026-09-28T13:00:00.000Z' }
    assert.deepEqual(order(live()), ['new', 'old', 'mid'])
  })

  it('подписи и тона статусов по палитре docs/12 §3', () => {
    assert.deepEqual([statusView('idle').tone, statusView('working').tone, statusView('blocked_permission').tone, statusView('cold').tone, statusView('failed').tone],
      ['ok', 'run', 'wait', 'queued', 'fail'])
    assert.equal(statusView('blocked_permission').label, 'ждёт тебя')
    assert.equal(statusView('working').busy, true)
    assert.equal(statusView('непонятный').label, 'непонятный')
  })

  it('buildAgents: живой статус важнее записанного, активность — свежее создания, ветка worktree', () => {
    const rec: AgentRecord = {
      name: 'w', provider: 'codex', cwd: '/Users/user/p/wt', mode: 'turn', createdAt: '2026-09-28T09:00:00Z',
      lastStatus: 'idle', lastEventId: 3, pendingPermissions: 0,
      worktree: { path: '/Users/user/.pult/worktrees/x', branch: 'feat/ui', repo: '/Users/user/p' },
    }
    const [a] = buildAgents([rec], { w: { status: 'working', lastTs: '2026-09-28T09:05:00Z' } })
    assert.deepEqual([a?.status, a?.lastActivity, a?.branch], ['working', '2026-09-28T09:05:00Z', 'feat/ui'])
    assert.equal(a?.createdAt, rec.createdAt)
  })

  it('название: подпись агента — оно, а без него имя; предел тот же, что у демона', () => {
    const rec: AgentRecord = {
      name: 'me', title: 'Починить VPN', provider: 'claude', cwd: '/p', mode: 'turn', createdAt: '2026-09-28T09:00:00Z',
      lastStatus: 'idle', lastEventId: 0, pendingPermissions: 0,
    }
    const { title: _drop, ...bare } = rec
    const built = buildAgents([rec, { ...bare, name: 'me-2' }], {})
    const [a, b] = [built.find((x) => x.name === 'me'), built.find((x) => x.name === 'me-2')]
    assert.deepEqual([a?.name, a?.title, agentLabel(a!)], ['me', 'Починить VPN', 'Починить VPN'])
    assert.ok(b && !('title' in b))
    assert.equal(agentLabel(b), 'me-2')
    assert.equal(AGENT_TITLE_MAX, SESSION_TITLE_MAX)
  })

  it('shortPath и ago', () => {
    assert.equal(shortPath('/Users/user/Desktop/pult'), '~/Desktop/pult')
    assert.equal(shortPath('/Users/user/src/projects/tools/pult-wt-f2/very/deep/src', 30), '…/deep/src')
    const now = Date.parse('2026-09-28T10:00:00Z')
    assert.deepEqual(['2026-09-28T09:59:50Z', '2026-09-28T09:57:00Z', '2026-09-28T07:00:00Z', '2026-09-25T10:00:00Z', 'x'].map((t) => ago(t, now)),
      ['только что', '3 мин', '3 ч', '3 дн', '—'])
  })
})

describe('разрешения: что просит агент', () => {
  it('Edit → дифф с контекстом и номерами строк', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n')
    const neu = ['a', 'b', 'c', 'd', 'E!', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const v = describePermission('Edit', { file_path: '/p/x.ts', old_string: old, new_string: neu, replace_all: false })
    assert.equal(v.kind, 'edit')
    assert.equal(v.title, 'Правка файла')
    assert.equal(v.target, '/p/x.ts')
    const d = v.diffs[0]!
    assert.deepEqual([d.added, d.removed, d.path], [2, 1, '/p/x.ts'])
    const rows = d.rows.map((r) => (r.op === 'gap' ? `…${r.count}` : `${r.op}${r.text}`))
    assert.deepEqual(rows, ['…1', ' b', ' c', ' d', '-e', '+E!', ' f', ' g', ' h', ' i', '+j'])
    assert.deepEqual(v.fields, [], 'известные поля не дублируются строками')
  })

  it('Write — всё добавлено; Bash — команда и причина; прочее — поля как есть', () => {
    const w = describePermission('Write', { file_path: '/p/n.md', content: 'x\ny\n' })
    assert.deepEqual([w.kind, w.diffs[0]!.added, w.diffs[0]!.removed], ['write', 2, 0])
    const b = describePermission('Bash', { command: 'touch probe.txt', description: 'создать пробу' })
    assert.deepEqual([b.kind, b.target, b.reason], ['command', 'touch probe.txt', 'создать пробу'])
    const g = describePermission('mcp__x__y', { a: 1, b: 'два', c: null })
    assert.deepEqual([g.title, g.fields], ['Инструмент mcp__x__y', [['a', '1'], ['b', 'два']]])
  })

  it('codex commandExecution (фикстура 03): команда, причина, папка, строковые варианты', () => {
    const v = describePermission('commandExecution', {
      kind: 'command', reason: 'Allow writing x.txt?', command: "/bin/zsh -lc 'echo hi > x.txt'", cwd: '/p/sandbox',
      commandActions: [{ type: 'unknown' }], proposedExecpolicyAmendment: ['/bin/zsh'], availableDecisions: ['accept', 'cancel'],
      itemId: 'exec-1',
    })
    assert.deepEqual([v.kind, v.target, v.reason, v.cwd, v.options], ['command', "/bin/zsh -lc 'echo hi > x.txt'", 'Allow writing x.txt?', '/p/sandbox', ['accept', 'cancel']])
    assert.deepEqual(v.fields, [], 'служебные id протокола человеку не показываются')
  })

  it('codex fileChange: унифицированный дифф по файлам', () => {
    const v = describePermission('fileChange', { changes: [{ path: 'a.txt', kind: 'update', unified_diff: '--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n' }] })
    assert.equal(v.target, 'a.txt')
    assert.deepEqual([v.diffs[0]!.added, v.diffs[0]!.removed], [1, 1])
    assert.deepEqual(parseUnifiedDiff('@@ -3 +3 @@\n-a\n+b').rows, [{ op: '-', text: 'a', oldNo: 3 }, { op: '+', text: 'b', newNo: 3 }])
  })

  it('строка внутри hunk, похожая на заголовок (`---old`, `+++new`), — это правка, а не заголовок', () => {
    const d = parseUnifiedDiff('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+-- new comment\n select 1')
    assert.deepEqual(d.rows.map((r) => (r.op === 'gap' ? 'gap' : `${r.op}${r.text}`)), ['--- old comment', '+-- new comment', ' select 1'])
    assert.deepEqual([d.added, d.removed], [1, 1])
    const e = parseUnifiedDiff('@@ -1 +1 @@\n---old\n+++new')
    assert.deepEqual([e.added, e.removed], [1, 1])
    assert.deepEqual(e.rows, [{ op: '-', text: '--old', oldNo: 1 }, { op: '+', text: '++new', newNo: 1 }])
    // Второй файл в том же тексте: его заголовки после конца первого hunk снова заголовки.
    const two = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -5 +5 @@\n-c\n+d')
    assert.deepEqual([two.added, two.removed], [2, 2])
  })

  it('номер строки в желобке: у удалённой — старый, у остальных — новый (один сквозной столбец)', () => {
    const d = lineDiff('a\nb\nc\n}', 'a\nb\nC\nD\n}')
    const nos = d.rows.map((r) => (r.op === 'gap' ? null : `${gutterNo(r)}${r.op.trim()}`))
    assert.deepEqual(nos, ['1', '2', '3-', '3+', '4+', '5'])
  })

  it('большой вход не считается квадратично: всё удалено, всё добавлено', () => {
    const big = Array.from({ length: 700 }, (_, i) => `l${i}`).join('\n')
    const d = lineDiff(big, `${big}\nnew`)
    assert.deepEqual([d.removed, d.added], [700, 701])
  })
})

describe('лимиты', () => {
  it('после сброса скрывает старый процент, сохраняя второе действующее окно и исходный снимок', () => {
    const now = Date.parse('2026-09-28T10:00:00Z')
    const windows = { five_hour: { utilization: 1, resetsAt: now / 1000 - 1 }, seven_day: { utilization: 0.4, resetsAt: now / 1000 + 60 } }
    const original = applyUsage(EMPTY_USAGE, ev('limit.hit', { status: 'limited', windows, resetsAt: now / 1000 - 1 })).claude!
    const display = usageForDisplay(original, now)!
    assert.equal(display.fiveHour?.utilization, null)
    assert.equal(display.sevenDay?.utilization, 0.4)
    assert.equal(display.status, 'unknown')
    assert.equal(original.fiveHour?.utilization, 1)
    assert.equal(usageForDisplay(undefined, now), undefined)
    const stillLimited = { ...original, sevenDay: { utilization: 1, resetsAt: now / 1000 + 60 } }
    assert.equal(usageForDisplay(stillLimited, now)?.status, 'limited')
  })
  it('последний снимок окон по провайдеру; старое событие не перетирает новое', () => {
    const windows = { five_hour: { utilization: 0.35, resetsAt: 1790011200 }, seven_day: { utilization: 0.19, resetsAt: 1790546400 } }
    let u = applyUsage(EMPTY_USAGE, ev('usage.updated', { source: 'rate_limit_event', status: 'allowed', windows }))
    u = applyUsage(u, ev('usage.updated', { source: 'result', totalCostUsd: 0.01 }))
    assert.equal(u.claude?.fiveHour?.utilization, 0.35)
    const older = { ...ev('usage.updated', { status: 'limited', windows }), id: 1 }
    assert.equal(applyUsage(u, older), u)
    u = applyUsage(u, ev('limit.hit', { status: 'limited', windows, resetsAt: 1790011200 }, { provider: 'codex' }))
    assert.equal(u.codex?.status, 'limited')
  })

  it('формат: проценты, тон, «через», часы', () => {
    assert.deepEqual([formatPct(0.354), formatPct(null), formatPct(1.2)], ['35%', '—', '120%'])
    assert.deepEqual([usageTone(0.2), usageTone(0.75), usageTone(0.95), usageTone(0.1, 'limited'), usageTone(null)], ['ok', 'wait', 'fail', 'fail', 'queued'])
    const now = Date.parse('2026-09-28T10:00:00Z')
    const sec = (iso: string): number => Date.parse(iso) / 1000
    assert.deepEqual([
      formatResetIn(sec('2026-09-28T10:40:00Z'), now),
      formatResetIn(sec('2026-09-28T12:10:00Z'), now),
      formatResetIn(sec('2026-10-01T14:00:00Z'), now),
      formatResetIn(sec('2026-09-28T09:00:00Z'), now),
    ], ['через 40 мин', 'через 2 ч 10 мин', 'через 3 дн 4 ч', 'ожидаем свежие данные'])
    assert.equal(formatClock(Date.parse('2026-09-28T14:30:00Z'), now, 'UTC'), '14:30')
    assert.equal(formatClock(Date.parse('2026-10-02T09:05:00Z'), now, 'UTC'), '2 окт 09:05')
  })
})

describe('лимит держит реплику только до сброса', () => {
  it('limited и сброс впереди — держит; сброс прошёл или неизвестен — отпускает', () => {
    const now = Date.parse('2026-09-28T10:00:00Z')
    const future = now / 1000 + 600
    const past = now / 1000 - 1
    assert.equal(limitHolds('limited', future, now), true)
    assert.equal(limitHolds('limited', past, now), false, 'после сброса окно снова пускает реплику — демон сам скажет, если лимит ещё держит')
    assert.equal(limitHolds('limited', undefined, now), false)
    assert.equal(limitHolds('idle', future, now), false)
  })
})

describe('Inbox', () => {
  const req = (id: string, sessionId: string, ts: string): PultEvent =>
    ev('permission.requested', { id, toolName: 'Edit', input: { file_path: '/a' } }, { sessionId, provider: 'pult', ts })

  it('события: пришёл, решён, сессия ушла; старые сверху; счёт по агентам', () => {
    let s = EMPTY_INBOX
    for (const e of [req('p1', 'a', '2026-09-28T10:00:02Z'), req('p2', 'b', '2026-09-28T10:00:01Z'), req('p3', 'a', '2026-09-28T10:00:03Z')]) s = applyInbox(s, e)
    assert.deepEqual(inboxList(s).map((p) => p.id), ['p2', 'p1', 'p3'])
    assert.deepEqual(pendingBySession(s), { a: 2, b: 1 })
    s = applyInbox(s, ev('permission.resolved', { id: 'p1', decision: 'allow' }, { sessionId: 'a', provider: 'pult' }))
    s = applyInbox(s, ev('session.ended', { reason: 'rm' }, { sessionId: 'b' }))
    assert.deepEqual(inboxList(s).map((p) => p.id), ['p3'])
  })

  it('`concealed` из события и из perm.list доезжает до карточки; без флага — поля нет', () => {
    let s = applyInbox(EMPTY_INBOX, ev('permission.requested', { id: 'p1', toolName: 'Bash', input: { command: 'ssh <email>' }, concealed: true },
      { sessionId: 'a', provider: 'pult', ts: '2026-09-28T10:00:00Z' }))
    assert.equal(s['p1']?.concealed, true)
    s = applyInbox(s, req('p2', 'a', '2026-09-28T10:00:01Z'))
    assert.equal('concealed' in s['p2']!, false)
    s = reconcileInbox(EMPTY_INBOX, [{ id: 'p9', sessionId: 'c', toolName: 'Bash', input: { command: 'ssh <email>' }, concealed: true, createdAt: '2026-09-28T10:01:00Z', waitingMs: 5 }])
    assert.equal(s['p9']?.concealed, true)
  })

  it('сверка с perm.list: снятое без окна исчезает, неизвестное появляется', () => {
    let s = applyInbox(EMPTY_INBOX, req('p1', 'a', '2026-09-28T10:00:00Z'))
    s = reconcileInbox(s, [{ id: 'p9', sessionId: 'c', toolName: 'Bash', input: { command: 'ls' }, createdAt: '2026-09-28T10:01:00Z', waitingMs: 5 }])
    assert.deepEqual(Object.keys(s), ['p9'])
    assert.equal(reconcileInbox(s, [{ id: 'p9', sessionId: 'c', toolName: 'Bash', input: {}, createdAt: '', waitingMs: 9 }]), s, 'без изменений — тот же объект')
    // Запрос, пришедший событием после вопроса к perm.list, сверка не выкидывает.
    const late = applyInbox(s, req('p10', 'a', '2026-09-28T10:05:00Z'))
    assert.deepEqual(Object.keys(reconcileInbox(late, [], '2026-09-28T10:04:59Z')), ['p10'])
  })

  it('выделенный запрос: выбранный → свой у текущего агента → самый старый', () => {
    const list = [
      { id: 'p1', sessionId: 'a', toolName: 't', input: {}, createdAt: '1' },
      { id: 'p2', sessionId: 'b', toolName: 't', input: {}, createdAt: '2' },
    ]
    assert.equal(focusedRequest(list, 'p2', 'a')?.id, 'p2')
    assert.equal(focusedRequest(list, 'нет', 'b')?.id, 'p2')
    assert.equal(focusedRequest(list, null, null)?.id, 'p1')
    assert.equal(focusedRequest([], null, 'a'), null)
  })

  it('выделенный запрос — только видимый: закрытый Inbox не отдаёт ⌘↵ запрос чужой сессии', () => {
    const list = [
      { id: 'p1', sessionId: 'b', toolName: 'Bash', input: {}, createdAt: '1' },
      { id: 'p2', sessionId: 'a', toolName: 'Bash', input: {}, createdAt: '2' },
    ]
    // Inbox закрыт, у текущего агента запроса нет — выделять нечего.
    assert.equal(focusedRequest(list.slice(0, 1), null, 'a', []), null)
    assert.equal(focusedRequest(list.slice(0, 1), null, null, []), null)
    // Выбранный раньше запрос чужой сессии после закрытия Inbox не выделен.
    assert.equal(focusedRequest(list, 'p1', 'a', [])?.id, 'p2')
    assert.equal(focusedRequest(list.slice(0, 1), 'p1', 'a', []), null)
    // Свой запрос виден в разговоре и при закрытом Inbox.
    assert.equal(focusedRequest(list, null, 'a', [])?.id, 'p2')
    // Inbox открыт — чужой запрос виден, откат на самый старый прежний.
    assert.equal(focusedRequest(list.slice(0, 1), null, 'a', list.slice(0, 1))?.id, 'p1')
  })
})

describe('здоровье: страж, провайдеры, doctor', () => {
  const report: DoctorReport = {
    ok: false, generatedAt: '2026-09-28T09:00:00Z', home: '/h',
    counts: { ok: 3, warn: 1, fail: 1 },
    items: [
      { id: 'net.claude', title: 'Сеть claude', status: 'ok', detail: 'd', data: { loc: 'FI', reason: 'ok', checkedAt: '2026-09-28T09:00:01Z' } },
      { id: 'net.codex', title: 'Сеть codex', status: 'ok', detail: 'd', data: { loc: 'FI', reason: 'ok', checkedAt: '2026-09-28T09:00:02Z' } },
      { id: 'cli.claude', title: 'claude', status: 'ok', detail: 'd' },
      { id: 'service', title: 'Служба', status: 'warn', detail: 'не установлена', fix: 'pult daemon install' },
      { id: 'login.codex', title: 'Вход codex', status: 'fail', detail: 'нет', fix: 'codex login' },
    ],
  }

  it('страж: страна и время из доктора; свежий отказ из журнала важнее', () => {
    const ok = guardView(guardFromDoctor(report))
    assert.deepEqual([ok.tone, ok.label, ok.checkedAt], ['ok', 'выход FI', '2026-09-28T09:00:02Z'])
    const bad = guardView([...guardFromDoctor(report), { provider: 'claude', loc: 'RU', ok: false, reason: 'blocked_country', checkedAt: '2026-09-28T09:30:00Z' }])
    assert.deepEqual([bad.tone, bad.label], ['fail', 'выход RU — стоп'])
    assert.match(bad.detail, /подними VPN/)
    assert.equal(guardView([]).tone, 'queued')
  })

  it('doctor: провалы и предупреждения первыми, с командами; тон отчёта', () => {
    const g = doctorGroups(report)
    assert.equal(g[0]?.title, 'Требует внимания')
    assert.deepEqual(g[0]?.items.map((i) => [i.id, i.fix]), [['login.codex', 'codex login'], ['service', 'pult daemon install']])
    assert.deepEqual(g.slice(1).map((x) => x.title), ['Сеть', 'CLI, вход и подписки'])
    assert.equal(doctorTone(report), 'fail')
    assert.equal(doctorTone(null), 'queued')
  })

  it('остановленные провайдеры из daemon.status', () => {
    assert.deepEqual(blockedProviders({ claude: { blocked: true, reason: 'disabled' }, codex: { blocked: false } }), [{ provider: 'claude', reason: 'disabled' }])
    assert.deepEqual(blockedProviders(undefined), [])
  })
})

describe('горячие клавиши', () => {
  const k = (key: string, code: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) =>
    ({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt })

  it('⌘N ⌘1…9 ⌘I ⌘Enter Esc на маке, в том числе в русской раскладке', () => {
    assert.deepEqual(hotkeyAction(k('n', 'KeyN', { meta: true }), true), { type: 'newAgent' })
    assert.deepEqual(hotkeyAction(k('т', 'KeyN', { meta: true }), true), { type: 'newAgent' })
    assert.deepEqual(hotkeyAction(k('3', 'Digit3', { meta: true }), true), { type: 'selectAgent', index: 2 })
    assert.deepEqual(hotkeyAction(k('ш', 'KeyI', { meta: true }), true), { type: 'toggleInbox' })
    assert.deepEqual(hotkeyAction(k('Enter', 'Enter', { meta: true }), true), { type: 'approveFocused' })
    assert.deepEqual(hotkeyAction(k('Escape', 'Escape'), true), { type: 'escape' })
  })

  it('без ⌘ ничего; Ctrl на маке — не ⌘; на других системах ⌘ = Ctrl', () => {
    assert.equal(hotkeyAction(k('n', 'KeyN'), true), null)
    assert.equal(hotkeyAction(k('n', 'KeyN', { ctrl: true }), true), null)
    assert.equal(hotkeyAction(k('0', 'Digit0', { meta: true }), true), null)
    assert.equal(hotkeyAction(k('n', 'KeyN', { meta: true, shift: true }), true), null)
    assert.deepEqual(hotkeyAction(k('n', 'KeyN', { ctrl: true }), false), { type: 'newAgent' })
  })
})

describe('форма «+ Сессия» по ссылке pult://new (О3)', () => {
  it('заготовка: годные поля проходят, чужие и лишние — нет', () => {
    assert.deepEqual(linkPrefill({ path: '/p/Эхо', prompt: 'сделай', provider: 'codex', extra: 1 }), { path: '/p/Эхо', prompt: 'сделай', provider: 'codex' })
    assert.deepEqual(linkPrefill({}), {})
    assert.deepEqual(linkPrefill({ path: 'rel', prompt: 42, provider: 'bash' }), {})
    assert.deepEqual(linkPrefill({ path: '/a/../b', prompt: 'a\0b' }), {})
    for (const x of [null, undefined, 'pult://new', [], 5]) assert.equal(linkPrefill(x), null, String(x))
  })
  it('заготовка: невидимые символы и лишние строки не проходят; чужая папка — только пометка', () => {
    for (const ch of ['\u202e', '\u200b', '\ufeff', '\u0085', '\u2028']) {
      assert.deepEqual(linkPrefill({ path: `/p/a${ch}`, prompt: `x${ch}` }), {}, `U+${ch.codePointAt(0)?.toString(16)}`)
    }
    assert.deepEqual(linkPrefill({ prompt: 'a\n\tb' }), { prompt: 'a\n\tb' })
    assert.deepEqual(linkPrefill({ prompt: 'x\n'.repeat(LINK_PROMPT_MAX_LINES) }), {}, '201 строка')
    // Main выбросил чужую папку и поставил пометку — даже если путь вдруг пришёл, в форму он не попадёт.
    assert.deepEqual(linkPrefill({ path: '/p', pathRejected: true }), { pathRejected: true })
    assert.deepEqual(linkForm({ path: '/p', pathRejected: true, prompt: 'x' }, []), { ...defaultForm('claude'), prompt: 'x' })
  })
  it('счётчик реплики из ссылки: строки и знаки (кодовые точки)', () => {
    assert.deepEqual(promptStats(''), { lines: 0, chars: 0 })
    assert.deepEqual(promptStats('a\nб\n🙂'), { lines: 3, chars: 5 })
  })
  it('окно защиты после ссылки: клавиши глотаются полсекунды, фокус поля сессии из ссылки — пропущен один раз', () => {
    resetLinkGuard()
    assert.equal(keysGuarded(1000), false)
    armLinkGuard(1000, 'alpha')
    assert.equal(keysGuarded(1000 + LINK_KEY_GUARD_MS - 1), true)
    assert.equal(keysGuarded(1000 + LINK_KEY_GUARD_MS), false)
    for (const k of ['Enter', 'a', 'Backspace', ' ']) assert.equal(swallowsKey(k), true, k)
    for (const k of ['Meta', 'Shift', 'Escape']) assert.equal(swallowsKey(k), false, k)
    assert.equal(takeAutoFocus('beta', 1100), true, 'чужая сессия — фокус как обычно')
    assert.equal(takeAutoFocus('alpha', 1100), false)
    assert.equal(takeAutoFocus('alpha', 1200), true, 'пропуск — один раз')
    armLinkGuard(5000, 'alpha')
    assert.equal(takeAutoFocus('alpha', 5000 + 60_000), true, 'старый пропуск истёк')
    armLinkGuard(9000)
    assert.equal(takeAutoFocus('alpha', 9000), true, 'ссылка без сессии фокус не трогает')
    resetLinkGuard()
  })
  it('форма: провайдер, папка с именем из неё, реплика; остальное по умолчанию', () => {
    const f = linkForm({ path: '/Users/user/Эхо Океана', prompt: 'почини', provider: 'codex' }, ['eho-okeana'])
    assert.deepEqual(f, { ...defaultForm('codex'), cwd: '/Users/user/Эхо Океана', name: 'eho-okeana-2', prompt: 'почини' })
    assert.deepEqual(linkForm({}, []), defaultForm('claude'))
    // Ничего не запускается само: форма — это только поля; agent.start шлёт кнопка «Завести».
    assert.deepEqual(validateForm(linkForm({ prompt: 'x' }, []), []).cwd, 'выбери папку')
  })
})

describe('форма «+ Сессия»', () => {
  it('правило имени — то же, что у демона', () => {
    assert.equal(AGENT_NAME_RE.source, SESSION_NAME_RE.source)
  })

  it('имя из папки: транслит, чистка, свободное', () => {
    assert.equal(suggestName('/Users/user/Эхо Океана', []), 'eho-okeana')
    assert.equal(suggestName('/p/pult', ['pult', 'pult-2']), 'pult-3')
    assert.equal(suggestName('/p/2048_Game!', []), 'game')
    assert.equal(suggestName('/', []), 'agent')
    assert.ok(AGENT_NAME_RE.test(suggestName('/p/' + 'x'.repeat(80), [])))
  })

  it('пресеты: claude — модель и усилие, codex — только усилие', () => {
    const c = defaultForm('claude')
    assert.deepEqual([c.model, c.effort], ['sonnet', 'medium'])
    const x = switchProvider({ ...c, effort: 'high' }, 'codex')
    assert.deepEqual([x.provider, x.model, x.effort], ['codex', null, 'high'])
  })

  it('пресеты — всё, что принимает CLI: fable и xhigh/max у claude, ultra только у codex', () => {
    assert.deepEqual(PRESETS.claude.models, ['haiku', 'sonnet', 'opus', 'fable'])
    assert.deepEqual(PRESETS.claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(PRESETS.codex.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.deepEqual(providerPreset('codex', 'fast', {
      checkedAt: '', claude: { provider: 'claude', state: 'ready', detail: '', models: [] },
      codex: { provider: 'codex', state: 'ready', detail: '', models: [
        { id: 'fast', label: 'Fast', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true },
      ] },
    }).efforts, ['low', 'high'])
    // Уровень, которого у другого провайдера нет, при переключении не протекает в `agent.start`.
    const back = switchProvider({ ...defaultForm('codex'), effort: 'ultra' }, 'claude')
    assert.deepEqual([back.model, back.effort], ['sonnet', 'medium'])
    assert.equal(switchProvider({ ...defaultForm('claude'), effort: 'max' }, 'codex').effort, 'max')
  })

  it('проверка и параметры agent.start', () => {
    const f = { ...defaultForm('claude'), cwd: '/p', name: 'w', worktree: ' feat/ui ', prompt: 'x' }
    assert.deepEqual(validateForm(f, []), {})
    assert.deepEqual(Object.keys(validateForm({ ...f, cwd: '', name: 'W!', worktree: 'a b' }, [])).sort(), ['cwd', 'name', 'worktree'])
    assert.equal(validateForm(f, ['w']).name, 'такая сессия уже есть')
    assert.deepEqual(startParams(f), { name: 'w', kind: 'claude', cwd: '/p', model: 'sonnet', effort: 'medium', worktree: 'feat/ui' })
    assert.deepEqual(startParams({ ...defaultForm('codex'), cwd: '/p', name: 'c' }), { name: 'c', kind: 'codex', cwd: '/p', effort: 'medium' })
  })
})

describe('Markdown реплик', () => {
  it('блоки: код, заголовок, списки, цитата, абзацы', () => {
    const b = parseMarkdown('# Итог\nтекст с `кодом` и **важным**\n\n- раз\n- два\n1. один\n> цитата\n```ts\nconst a = 1\n```\nхвост')
    assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'list', 'list', 'quote', 'code', 'p'])
    assert.deepEqual(parseInline('a `b` **c** d'), [
      { t: 'text', v: 'a ' }, { t: 'code', v: 'b' }, { t: 'text', v: ' ' }, { t: 'bold', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' d' },
    ])
    const code = b.find((x) => x.t === 'code')
    assert.deepEqual(code, { t: 'code', lang: 'ts', v: 'const a = 1' })
  })

  it('незакрытый блок кода (идут дельты) не теряет текст', () => {
    assert.deepEqual(parseMarkdown('```\nпишу'), [{ t: 'code', lang: '', v: 'пишу' }])
  })
  // Ссылки из дерева строки — для проверок «что стало ссылкой и куда ведёт».
  const links = (xs: Inline[]): Array<{ href: string | null; url: string }> => xs.flatMap((x) =>
    x.t === 'link' ? [{ href: x.href, url: x.url }] : 'c' in x ? links(x.c) : [])
  const txt = (xs: Inline[]): string => xs.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.t === 'br' ? '\n' : x.t === 'image' ? x.alt : x.t === 'file' ? x.path : txt(x.c))).join('')
  const T = (v: string): Inline => ({ t: 'text', v })

  it('блок кода: язык — первое слово строки сведений; закрывает такая же серия не короче', () => {
    assert.deepEqual(parseMarkdown('```ts title="x.ts"\nconst a = 1\n```'), [{ t: 'code', lang: 'ts', v: 'const a = 1' }])
    assert.deepEqual(parseMarkdown('````md\n```\nвнутри\n```\n````\nпосле'),
      [{ t: 'code', lang: 'md', v: '```\nвнутри\n```' }, { t: 'p', v: [T('после')] }])
    assert.deepEqual(parseMarkdown('~~~\nx\n~~~'), [{ t: 'code', lang: '', v: 'x' }])
  })

  it('выделения вкладываются: жирный со ссылкой, курсив, зачёркнутый, ***жирный курсив***', () => {
    assert.deepEqual(parseInline('**см. [доку](https://a.io)**'), [
      { t: 'bold', c: [T('см. '), { t: 'link', href: 'https://a.io/', url: 'https://a.io', c: [T('доку')] }] },
    ])
    assert.deepEqual(parseInline('*к* _к_ ~~з~~'), [
      { t: 'em', c: [T('к')] }, T(' '), { t: 'em', c: [T('к')] }, T(' '), { t: 'del', c: [T('з')] },
    ])
    assert.deepEqual(parseInline('***x***'), [{ t: 'bold', c: [{ t: 'em', c: [T('x')] }] }])
    assert.deepEqual(parseInline('**a *b* c**'), [{ t: 'bold', c: [T('a '), { t: 'em', c: [T('b')] }, T(' c')] }])
  })

  it('snake_case, умножение и незакрытые звёзды остаются текстом', () => {
    assert.deepEqual(parseInline('snake_case_name и my_var_'), [T('snake_case_name и my_var_')])
    assert.deepEqual(parseInline('2 * 3 * 4'), [T('2 * 3 * 4')])
    assert.deepEqual(parseInline('**жирный в пути'), [T('**жирный в пути')])
    assert.deepEqual(parseInline('\\*не курсив\\*'), [T('*не курсив*')])
    assert.deepEqual(parseInline('`a **b** c`'), [{ t: 'code', v: 'a **b** c' }])
  })

  it('ссылки: [текст](адрес "заголовок"), <автоссылка>, голый адрес без хвостовой пунктуации', () => {
    assert.deepEqual(parseInline('[`код` и текст](https://x.io/a "Заголовок")'), [
      { t: 'link', href: 'https://x.io/a', url: 'https://x.io/a', title: 'Заголовок', c: [{ t: 'code', v: 'код' }, T(' и текст')] },
    ])
    assert.deepEqual(links(parseInline('<https://a.io/x> и <me@example.com>')), [
      { href: 'https://a.io/x', url: 'https://a.io/x' }, { href: 'mailto:me@example.com', url: 'mailto:me@example.com' },
    ])
    const bare = parseInline('Смотри https://a.io/x. И (https://b.io/wiki/A_(B)), и https://c.io/q?x=1!')
    assert.deepEqual(links(bare).map((l) => l.url), ['https://a.io/x', 'https://b.io/wiki/A_(B)', 'https://c.io/q?x=1'])
    assert.equal(txt(bare), 'Смотри https://a.io/x. И (https://b.io/wiki/A_(B)), и https://c.io/q?x=1!')
    // Внутри текста ссылки — не вторая ссылка.
    assert.equal(links(parseInline('[https://a.io](https://b.io)')).length, 1)
  })

  it('опасная или относительная ссылка — текст без href', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'src/main.ts', 'https://bank.example.com@evil.example.org/']) {
      const l = links(parseInline(`[жми](${u})`))
      assert.deepEqual(l, [{ href: null, url: u }], u)
    }
    assert.equal(safeHref('mailto:a@example.org'), 'mailto:a@example.org')
    assert.equal(safeHref('ftp://x.io'), null)
    // Недописанная ссылка (идут дельты) — просто текст.
    assert.deepEqual(parseInline('[док](https://a.i'), [T('[док]('), { t: 'link', href: 'https://a.i/', url: 'https://a.i', c: [T('https://a.i')] }])
  })

  it('таблица: выравнивание, `\\|`, `|` в коде, рваные строки, формат в ячейках', () => {
    const b = parseMarkdown('| Имя | `a|b` | Число |\n|:--|:-:|--:|\n| **x** | y \\| z |\n| 1 | 2 | 3 | 4 |\nпосле')
    const t = b[0] as Block & { t: 'table' }
    assert.equal(t.t, 'table')
    assert.deepEqual(t.align, ['left', 'center', 'right'])
    assert.deepEqual(t.head, [[T('Имя')], [{ t: 'code', v: 'a|b' }], [T('Число')]])
    assert.deepEqual(t.rows, [
      [[{ t: 'bold', c: [T('x')] }], [T('y | z')], []],
      [[T('1')], [T('2')], [T('3')]],
    ])
    assert.deepEqual(b[1], { t: 'p', v: [T('после')] })
    // Без крайних черт и без выравнивания.
    const bare = parseMarkdown('a | b\n--- | ---\n1 | 2')[0] as Block & { t: 'table' }
    assert.deepEqual([bare.align, bare.head, bare.rows], [[null, null], [[T('a')], [T('b')]], [[[T('1')], [T('2')]]]])
    assert.deepEqual(splitRow('| `x \\| y` | z |'), ['`x | y`', 'z'])
  })

  it('таблица в пути (разделитель недописан) — абзац, не исключение', () => {
    for (const s of ['| a | b |', '| a | b |\n|', '| a | b |\n|--', '| a | b |\n|---|']) {
      assert.deepEqual(parseMarkdown(s).map((x) => x.t), ['p'], s)
    }
  })

  it('черта: ---, ***, ___; под абзацем --- — заголовок (setext), разделитель таблицы — не черта', () => {
    assert.deepEqual(parseMarkdown('a\n\n---\n\n***\n___\n- - -').map((x) => x.t), ['p', 'hr', 'hr', 'hr', 'hr'])
    assert.deepEqual(parseMarkdown('Итог\n---'), [{ t: 'h', level: 2, v: [T('Итог')] }])
    assert.deepEqual(parseMarkdown('Итог\n==='), [{ t: 'h', level: 1, v: [T('Итог')] }])
    assert.deepEqual(parseMarkdown('| a |\n|---|').map((x) => x.t), ['table'])
  })

  it('заголовки h1–h6, закрывающие решётки сняты, #тег — не заголовок', () => {
    assert.deepEqual(parseMarkdown('#### Четыре\n###### Шесть ##\n#тег').map((x) => (x.t === 'h' ? [x.level, txt(x.v)] : x.t)),
      [[4, 'Четыре'], [6, 'Шесть'], 'p'])
  })

  it('вложенные списки по отступу, номер начала, задачи, ленивое продолжение', () => {
    const b = parseMarkdown('3. три\n4. четыре\n   - вложенный\n     - ещё глубже\n\n- [ ] сделать\n- [x] готово\nленивая строка\n\nабзац')
    assert.deepEqual(b.map((x) => x.t), ['list', 'list', 'p'])
    const ol = b[0] as Block & { t: 'list' }
    assert.deepEqual([ol.ordered, ol.start, ol.items.length], [true, 3, 2])
    const inner = ol.items[1]!.c[1] as Block & { t: 'list' }
    assert.equal(inner.t, 'list')
    assert.equal(txt((inner.items[0]!.c[0] as Block & { t: 'p' }).v), 'вложенный')
    assert.equal((inner.items[0]!.c[1] as Block).t, 'list')
    const tasks = b[1] as Block & { t: 'list' }
    assert.deepEqual(tasks.items.map((it) => it.task), [{ checked: false }, { checked: true }])
    assert.equal(txt((tasks.items[1]!.c[0] as Block & { t: 'p' }).v), 'готово\nленивая строка')
  })

  it('список: пустые строки между пунктами его не рвут, код внутри пункта — блок пункта', () => {
    const b = parseMarkdown('1. раз\n   ```sh\n   ls -la\n   ```\n\n2. два')
    assert.deepEqual(b.map((x) => x.t), ['list'])
    const ol = b[0] as Block & { t: 'list' }
    assert.equal(ol.items.length, 2)
    assert.deepEqual(ol.items[0]!.c[1], { t: 'code', lang: 'sh', v: 'ls -la' })
  })

  it('нумерованный не с 1 абзац не прерывает; цитата — блоки внутри', () => {
    assert.deepEqual(parseMarkdown('Это было\n2024. год').map((x) => x.t), ['p'])
    const q = parseMarkdown('> **важно**\n> - пункт') [0] as Block & { t: 'quote' }
    assert.deepEqual(q.c.map((x) => x.t), ['p', 'list'])
  })

  it('чужой текст не роняет разбор: глубокая вложенность и тысячи звёзд', () => {
    assert.ok(parseMarkdown('> '.repeat(500) + 'x').length > 0)
    assert.ok(parseMarkdown(' - '.repeat(300) + 'x').length > 0)
    const t0 = Date.now()
    parseInline('_a '.repeat(20_000))
    parseInline('*a '.repeat(20_000))
    assert.ok(Date.now() - t0 < 2000, 'разбор квадратичный')
  })
})

describe('состояние окна', () => {
  it('статус считает та же свёртка, что у демона; реестр накладывается поверх', () => {
    const s = applyEvents(EMPTY_STATE, [
      ev('message.user', { text: 'x' }),
      ev('status.changed', { status: 'working', turnId: 't' }),
      ev('permission.requested', { id: 'p1', toolName: 'Edit', input: {} }, { provider: 'pult' }),
    ])
    assert.equal(s.sessions['w']?.status, 'blocked_permission')
    assert.equal(Object.keys(s.inbox).length, 1)
    const statusId = s.sessions['w']!.statusId
    const rec: AgentRecord = { name: 'w', provider: 'claude', cwd: '/x', mode: 'turn', createdAt: '2026-09-28T09:00:00Z', lastStatus: 'cold', lastEventId: statusId, pendingPermissions: 0 }
    // Реестр остудил сессию после рестарта (lastEventId тот же) — правда за реестром.
    assert.equal(syncStatuses(s, [rec]).sessions['w']?.status, 'cold')
    // Опоздавший ответ списка (реестр ещё не видел последней смены) свежую свёртку не перетирает.
    assert.equal(syncStatuses(s, [{ ...rec, lastStatus: 'working', lastEventId: statusId - 1 }]).sessions['w']?.status, 'blocked_permission')
  })

  it('дельты не двигают активность; rm стирает ленту; события демона — не разговор', () => {
    let s = applyEvents(EMPTY_STATE, [ev('message.user', { text: 'x' }, { ts: '2026-09-28T10:00:00Z' })])
    s = applyEvents(s, [ev('message.delta', { text: 'y' }, { ts: '2026-09-28T10:05:00Z' })])
    assert.equal(s.sessions['w']?.lastTs, '2026-09-28T10:00:00Z')
    s = applyEvents(s, [ev('daemon.started', {}, { sessionId: 'daemon', provider: 'pult' })])
    assert.equal(s.sessions['daemon'], undefined)
    s = applyEvents(s, [ev('session.ended', { reason: 'rm' })])
    assert.equal(s.sessions['w'], undefined)
  })

  it('рестарт демона: карточки разрешений прошлого запуска в ленте гаснут (их id новый брокер выдаст заново)', () => {
    let s = applyEvents(EMPTY_STATE, [
      ev('permission.requested', { id: 'p1', toolName: 'Edit', input: {} }, { provider: 'pult' }),
      ev('agent.spawned', { toolUseId: 'A' }),
      ev('permission.requested', { id: 'p2', toolName: 'Bash', input: {} }, { provider: 'pult', parentId: 'A' }),
    ])
    s = applyEvents(s, [ev('daemon.started', {}, { sessionId: 'daemon', provider: 'pult' })])
    const items = s.sessions['w']!.conv.items
    assert.equal((items[0] as { state: string }).state, 'expired')
    assert.equal((items[2] as { state: string }).state, 'expired')
    // Новый запрос с тем же id после рестарта — живая карточка, решение попадает в неё, а не в старую.
    s = applyEvents(s, [
      ev('permission.requested', { id: 'p1', toolName: 'Write', input: {} }, { provider: 'pult' }),
      ev('permission.resolved', { id: 'p1', decision: 'allow' }, { provider: 'pult' }),
    ])
    const after = s.sessions['w']!.conv.items
    assert.deepEqual([(after[0] as { state: string }).state, (after[3] as { state: string }).state], ['expired', 'allow'])
  })

  it('уведомления только о свежем: запрос разрешения и конец хода', () => {
    const now = Date.parse('2026-09-28T10:00:10Z')
    const n = notificationFor(ev('permission.requested', { id: 'p1', toolName: 'Edit', input: { file_path: '/a.ts' } }, { provider: 'pult' }), now)
    assert.deepEqual(n, { title: 'w ждёт тебя', body: 'Правка файла: /a.ts', target: { sessionId: 'w', permId: 'p1' }, kind: 'ask' })
    assert.equal(notificationFor(ev('status.changed', { status: 'idle', turnId: 't' }), now)?.title, 'w: ход закончен')
    // Названный агент зовёт названием, а ведёт клик всё равно по имени сессии.
    assert.deepEqual(
      [notificationFor(ev('status.changed', { status: 'idle', turnId: 't' }), now, 'Починить VPN')?.title,
        notificationFor(ev('status.changed', { status: 'failed', turnId: 't' }), now, 'Починить VPN')?.target.sessionId],
      ['Починить VPN: ход закончен', 'w'],
    )
    assert.equal(notificationFor(ev('status.changed', { status: 'idle', turnId: 't' }), now + 60_000), null, 'доигрывание истории молчит')
    assert.equal(notificationFor(ev('status.changed', { status: 'working', turnId: 't' }), now), null)
  })
})

describe('пути файлов в реплике', () => {
  it('путь без пробелов — как есть; с пробелом или кавычкой — в одинарных кавычках', () => {
    assert.equal(quotePath('/srv/p/a.txt'), '/srv/p/a.txt')
    assert.equal(quotePath('/srv/p/Отчёт 1.txt'), "'/srv/p/Отчёт 1.txt'")
    assert.equal(quotePath("/tmp/it's"), `'/tmp/it'\\''s'`)
  })
  it('пустое поле — только пути через пробел, каретка в конце', () => {
    assert.deepEqual(insertPaths('', 0, 0, ['/a', '/b c']), { text: "/a '/b c'", caret: 9 })
  })
  it('посреди текста — пробелы только там, где вплотную стоит слово; выделение заменяется', () => {
    assert.deepEqual(insertPaths('глянь файлы', 5, 5, ['/x']), { text: 'глянь /x файлы', caret: 8 })
    assert.deepEqual(insertPaths('глянь ', 6, 6, ['/x']), { text: 'глянь /x', caret: 8 })
    assert.deepEqual(insertPaths('см ЭТО тут', 3, 6, ['/x']), { text: 'см /x тут', caret: 5 })
  })
})

describe('статус провайдера в шапке', () => {
  it('одно короткое слово, полный текст и починка — в подсказке', () => {
    const v = providerStatusView({ provider: 'codex', state: 'login_required', detail: 'Нужен вход', fixCmd: 'codex login', models: [] }, false)
    assert.deepEqual([v.label, v.tone], ['нужен вход', 'wait'])
    assert.match(v.title, /Нужен вход — починить: codex login/)
    assert.equal(providerStatusView({ provider: 'claude', state: 'ready', detail: 'Вход выполнен · готов', models: [] }, false).label, 'готов')
  })
  it('идёт проверка или ещё не проверяли — серым', () => {
    assert.deepEqual([providerStatusView(undefined, true).label, providerStatusView(undefined, true).tone], ['проверяю', 'mut'])
    assert.equal(providerStatusView(undefined, false).label, 'проверить')
  })
})

describe('проекты: дерево сессий', () => {
  const ses = (name: string, cwd: string, extra: Partial<AgentView> = {}): AgentView =>
    ({ name, provider: 'claude', status: 'idle', cwd, pending: 0, lastActivity: '2026-10-07T10:00:00Z', ...extra })
  it('сессия — в самый глубокий проект, где лежит её папка; worktree — по исходному репозиторию', () => {
    const g = groupByProject(['/srv/Me', '/srv/Me/tools/pult'], [
      ses('a', '/srv/Me/tools/pult/src'), ses('b', '/srv/Me/games'), ses('c', '/srv/.pult/worktrees/x', { repo: '/srv/Me/tools/pult' }),
      ses('d', '/srv/Medium'),
    ])
    assert.deepEqual(g.map((x) => [x.name, x.pinned, x.sessions.map((s) => s.name)]),
      [['Me', true, ['b']], ['pult', true, ['a', 'c']], ['Medium', false, ['d']]])
  })
  it('архивные сессии — не в проектах (у них своя секция)', () => {
    const g = groupByProject(['/srv/w'], [ses('a', '/srv/w'), ses('b', '/srv/w', { archived: true }), ses('c', '/srv/loose', { archived: true })])
    assert.deepEqual(g.map((x) => [x.name, x.sessions.map((s) => s.name)]), [['w', ['a']]])
  })
  it('пустой закреплённый проект виден; ждущие считаются у группы', () => {
    const g = groupByProject(['/srv/empty', '/srv/w'], [ses('x', '/srv/w', { status: 'blocked_permission' }), ses('y', '/srv/w', { pending: 2 })])
    assert.deepEqual(g.map((x) => [x.name, x.sessions.length, x.waiting]), [['empty', 0, 0], ['w', 2, 2]])
  })
  it('неявные проекты — после закреплённых, по имени; одна папка — одна группа', () => {
    const g = groupByProject([], [ses('z', '/srv/zeta'), ses('a', '/srv/alpha'), ses('a2', '/srv/alpha')])
    assert.deepEqual(g.map((x) => [x.name, x.sessions.length]), [['alpha', 2], ['zeta', 1]])
    assert.equal(projectName('/srv/a/b/'), 'b')
  })
  it('вкладки: открыть без дублей, закрыть активную — соседка справа, иначе слева; удалённые выкидываются', () => {
    assert.deepEqual(openTab(['a', 'b'], 'b'), ['a', 'b'])
    assert.deepEqual(openTab(['a'], 'c'), ['a', 'c'])
    assert.deepEqual(closeTab(['a', 'b', 'c'], 'b', 'b'), { tabs: ['a', 'c'], active: 'c' })
    assert.deepEqual(closeTab(['a', 'b'], 'b', 'b'), { tabs: ['a'], active: 'a' })
    assert.deepEqual(closeTab(['a', 'b'], 'a', 'b'), { tabs: ['b'], active: 'b' })
    assert.deepEqual(closeTab(['a'], 'a', 'a'), { tabs: [], active: null })
    assert.deepEqual(pruneTabs(['a', 'b', 'c'], new Set(['a', 'c'])), ['a', 'c'])
  })
})

describe('фоновые задачи сессии', () => {
  const ev = (id: number, kind: string, data: Record<string, unknown>, sessionId = 'w'): PultEvent =>
    ({ id, ts: `2026-10-07T10:00:0${id}Z`, sessionId, provider: 'claude', kind, data } as PultEvent)
  it('background.changed — счёт и описания; пустой список и рестарт демона гасят пометку', () => {
    let s = applyEvents(EMPTY_STATE, [ev(1, 'background.changed', { count: 1, tasks: [{ id: 'a', type: 'local_agent', description: 'Проверить тесты' }] })])
    assert.deepEqual(s.sessions['w']?.background, { count: 1, tasks: ['Проверить тесты'] })
    const rows = buildAgents([{ name: 'w', provider: 'claude', cwd: '/srv/w', lastStatus: 'idle', createdAt: '2026-10-07T09:00:00Z', lastEventId: 0, pendingPermissions: 0, mode: 'turn' } as unknown as AgentRecord],
      { w: { status: 'idle', background: s.sessions['w']!.background! } })
    assert.equal(rows[0]?.background?.count, 1)
    s = applyEvents(s, [ev(2, 'daemon.started', {}, 'daemon')])
    assert.equal(s.sessions['w']?.background?.count, 0)
    s = applyEvents(s, [ev(3, 'background.changed', { count: 2, tasks: [] }), ev(4, 'background.changed', { count: 0, tasks: [] })])
    assert.equal(s.sessions['w']?.background?.count, 0)
    assert.equal(buildAgents([{ name: 'w', provider: 'claude', cwd: '/srv/w', lastStatus: 'idle', createdAt: '2026-10-07T09:00:00Z', lastEventId: 0, pendingPermissions: 0, mode: 'turn' } as unknown as AgentRecord],
      { w: { status: 'idle', background: s.sessions['w']!.background! } })[0]?.background, undefined, 'ноль задач — пометки нет')
  })
})

describe('контекстное окно сессии', () => {
  const ctx = (used: number, window: number | null, model: string | null = 'claude-haiku-4-5'): { used: number; window: number | null; model: string | null; at: string } =>
    ({ used, window, model, at: '2026-09-28T10:00:00.000Z' })

  it('токены коротко: до тысячи как есть, тысячи — k (до 10k с запятой), миллионы — M', () => {
    assert.deepEqual([950, 4200, 9960, 48213, 200000, 258400, 999_400, 1_000_000, 1_250_000].map(formatTokens),
      ['950', '4,2k', '10k', '48k', '200k', '258k', '999k', '1M', '1,3M'])
    assert.equal(formatExact(1_048_213), '1 048 213')
  })

  it('тон доли окна: до 70% — ok, 70–90% — wait, от 90% — fail; без окна — queued', () => {
    assert.deepEqual([0.1, 0.69, 0.7, 0.89, 0.9, 1.2, null].map(contextTone), ['ok', 'ok', 'wait', 'wait', 'fail', 'fail', 'queued'])
  })

  it('подпись, полоска и подсказка с точными числами и моделью', () => {
    const v = contextView(ctx(48_213, 200_000))
    assert.equal(v?.label, 'контекст 48k / 200k · 24%')
    assert.equal(v?.short, '24%')
    assert.equal(v?.tone, 'ok')
    assert.equal(v?.barPct, 24)
    assert.equal(v?.title, 'Контекстное окно: 48 213 из 200 000 токенов (24%) · claude-haiku-4-5')
    // Окно ещё не известно (у Claude — до конца первого хода): без доли, но с числом.
    const unknown = contextView(ctx(48_213, null, null))
    assert.equal(unknown?.label, 'контекст 48k')
    assert.equal(unknown?.short, '48k')
    assert.equal(unknown?.tone, 'queued')
    assert.match(unknown?.title ?? '', /размер окна станет известен в конце хода/)
    // Через край (окно меньше подсказки) — полоска упирается в 100, доля честная.
    const over = contextView(ctx(210_000, 200_000))
    assert.deepEqual([over?.barPct, over?.short, over?.tone], [100, '105%', 'fail'])
    assert.equal(contextView(undefined), null)
  })

  it('в строке дерева — только от половины окна', () => {
    assert.equal(contextRowView(ctx(99_000, 200_000)), null)
    assert.equal(contextRowView(ctx(48_000, null)), null)
    assert.equal(contextRowView(ctx(150_000, 200_000))?.short, '75%')
    assert.equal(contextRowView(ctx(150_000, 200_000))?.tone, 'wait')
  })

  it('свёртка: неизвестное окно наследуется у той же модели, у другой — нет; кривое событие не ломает', () => {
    let c = applyContext(undefined, ev('context.updated', { used: 100, window: 200_000, model: 'a' }))
    c = applyContext(c, ev('context.updated', { used: 150, window: null, model: 'a' }))
    assert.deepEqual([c?.used, c?.window, c?.model], [150, 200_000, 'a'])
    assert.equal(applyContext(c, ev('context.updated', { used: 10, window: null, model: 'b' }))?.window, null)
    assert.equal(applyContext(c, ev('context.updated', { used: 'много' })), c)
    assert.equal(applyContext(c, ev('message.done', { text: 'x' })), c)
  })

  it('журнал с нуля → состояние окна → строка сессии: контекст доходит до AgentView', () => {
    // Ровно то, что пишет демон за ход Claude: окно приходит с result, потом следующий замер.
    const s = applyEvents(EMPTY_STATE, [
      ev('message.user', { text: 'привет' }, { ts: '2026-09-28T10:00:00Z' }),
      ev('context.updated', { used: 23_392, window: null, model: 'claude-haiku-4-5-20251001' }, { ts: '2026-09-28T10:00:02Z' }),
      ev('context.updated', { used: 23_392, window: 200_000, model: 'claude-haiku-4-5-20251001' }, { ts: '2026-09-28T10:00:03Z' }),
      ev('status.changed', { status: 'idle', turnId: 't1' }, { ts: '2026-09-28T10:00:03Z' }),
      ev('context.updated', { used: 150_100, window: null, model: 'claude-haiku-4-5-20251001' }, { ts: '2026-09-28T10:05:00Z' }),
    ])
    const live = s.sessions['w']
    assert.deepEqual([live?.context?.used, live?.context?.window], [150_100, 200_000])
    // Замер контекста — не новая работа: «последняя активность» строки остаётся на конце хода.
    assert.equal(live?.lastTs, '2026-09-28T10:00:03Z')
    const rec: AgentRecord = { name: 'w', provider: 'claude', cwd: '/x', mode: 'turn', createdAt: '2026-09-28T09:00:00Z', lastStatus: 'idle', lastEventId: 0, pendingPermissions: 0 }
    const [a] = buildAgents([rec], { w: { status: live!.status, lastTs: live!.lastTs, ...(live?.context ? { context: live.context } : {}) } })
    assert.equal(contextView(a?.context)?.label, 'контекст 150k / 200k · 75%')
    // Наложение реестра контекст не теряет.
    assert.equal(syncStatuses(s, [{ ...rec, lastStatus: 'cold', lastEventId: 999 }]).sessions['w']?.context?.used, 150_100)
    // Потока по сессии ещё нет — контекст из agent.list.
    const [fromList] = buildAgents([{ ...rec, context: { used: 1000, window: 200_000, model: null, at: '2026-09-28T09:30:00Z' } }], {})
    assert.equal(fromList?.context?.used, 1000)
  })
})

describe('вопросы модели: Claude и Codex в одной карточке', () => {
  it('AskUserQuestion: ключ — текст вопроса, одиночный выбор, «свой ответ» всегда', () => {
    const qs = questionsOf('AskUserQuestion', { questions: [
      { question: 'Где нужен статус-бар?', header: 'Где', multiSelect: false, options: [{ label: 'Claude Code', description: 'statusLine' }, { label: 'Pult' }] },
      { question: 'Что ещё?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ] })
    assert.deepEqual(qs.map((q) => [q.key, q.multi, q.other, q.options.length]), [['Где нужен статус-бар?', false, true, 2], ['Что ещё?', true, true, 2]])
    assert.ok(isQuestionTool('AskUserQuestion') && isQuestionTool('requestUserInput') && !isQuestionTool('Edit'))
  })
  it('requestUserInput: ключ — id; «свой ответ» — без вариантов или isOther', () => {
    const qs = questionsOf('requestUserInput', { questions: [{ id: 'a', header: 'H', question: 'Q', options: [{ label: 'x' }] }, { id: 'b', question: 'T', options: null }] })
    assert.deepEqual(qs.map((q) => [q.key, q.other]), [['a', false], ['b', true]])
  })
  it('ответы: одиночный — свой текст важнее выбора; множественный — выбор плюс свой', () => {
    const qs = questionsOf('AskUserQuestion', { questions: [{ question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Q2', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] })
    const a = buildAnswers(qs, { Q1: ['A'], Q2: ['A', 'B'] }, { Q1: '  своё ', Q2: 'ещё' })
    assert.deepEqual(a, { Q1: { answers: ['своё'] }, Q2: { answers: ['A', 'B', 'ещё'] } })
    assert.equal(answersReady(buildAnswers(qs, { Q1: ['B'] }, {}), qs), false, 'на Q2 нет ответа')
    assert.equal(answersReady(buildAnswers(qs, { Q1: ['B'], Q2: ['A'] }, {}), qs), true)
  })
})

describe('лимиты в полосе под чатом', () => {
  const now = Date.parse('2026-10-07T19:30:00Z')
  it('5ч — время сброса сегодня, 7дн — «через N дн»; тон по доле; прошедшее окно — без процентов', () => {
    const usage = { status: 'allowed_warning', resetsAt: null, fiveHour: { utilization: 0.12, resetsAt: now / 1000 + 2 * 3600 }, sevenDay: { utilization: 0.75, resetsAt: now / 1000 + 3 * 86_400 } }
    const w = limitWindowsView(usage as never, now)
    assert.deepEqual(w.map((x) => [x.key, x.pct, x.tone]), [['5ч', '12%', 'ok'], ['7дн', '75%', usageTone(0.75)]])
    // Сброс в пределах суток — время (с датой, если по местному времени уже завтра).
    assert.match(w[0]!.reset, /\d\d:\d\d$/)
    assert.equal(w[1]!.reset, 'через 3 дн')
    const stale = limitWindowsView({ ...usage, fiveHour: { utilization: 0.9, resetsAt: now / 1000 - 60 } } as never, now)
    assert.deepEqual(stale.map((x) => x.key), ['7дн'], 'прошедшее окно без свежих данных не показывается (с прошлой датой сброса)')
    assert.deepEqual(limitWindowsView(undefined, now), [])
  })
})

describe('горячие клавиши: справка', () => {
  const k = (over: Record<string, unknown>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })
  it('⌘/ — справка (и в русской раскладке: по коду клавиши)', () => {
    assert.deepEqual(hotkeyAction(k({ key: '/', code: 'Slash', metaKey: true }), true), { type: 'help' })
    assert.deepEqual(hotkeyAction(k({ key: '.', code: 'Slash', metaKey: true }), true), { type: 'help' })
    assert.equal(hotkeyAction(k({ key: '/', code: 'Slash' }), true), null, 'без ⌘ — просто символ')
  })
})
