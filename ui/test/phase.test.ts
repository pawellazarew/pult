// Строка фазы хода (0.3.5): кадры живого канала → карта фаз, подписи и секунды, «Размышления», диктор, дерево.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation, PhaseLine } from '../src/components/Conversation.js'
import { ProjectTree } from '../src/components/ProjectTree.js'
import type { AgentView } from '../src/model/agents.js'
import { buildAgents } from '../src/model/agents.js'
import { toolSummary } from '../src/model/conversation.js'
import {
  applyPhaseFrame, EMPTY_PHASES, formatElapsed, LIVE_CURSOR_BASE, parsePhase, phaseAnnouncement, phaseElapsed, phaseText, shortToolName, treePhaseLabel,
} from '../src/model/phase.js'
import type { PhaseMap, TurnPhase } from '../src/model/phase.js'
import { groupByProject } from '../src/model/projects.js'
import type { PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-10-23T10:00:00Z')

const frame = (sessionId: string, data: Record<string, unknown>, id = LIVE_CURSOR_BASE + 1): PultEvent =>
  ({ id, ts: '', sessionId, provider: 'pult', kind: 'turn.phase' as PultEvent['kind'], data })
const ph = (over: Partial<TurnPhase> = {}): TurnPhase => ({ phase: 'thinking', since: NOW - 12_000, turnSince: NOW - 20_000, ...over })

describe('фаза хода: кадры живого канала', () => {
  it('reset забывает всё; фаза сессии ставится и снимается; чужие кадры и мусор карту не трогают', () => {
    let m: PhaseMap = EMPTY_PHASES
    m = applyPhaseFrame(m, frame('a', { phase: ph() }))
    m = applyPhaseFrame(m, frame('b', { phase: ph({ phase: 'writing' }) }))
    assert.deepEqual(Object.keys(m), ['a', 'b'])
    assert.equal(m['b']?.phase, 'writing')
    m = applyPhaseFrame(m, frame('a', { phase: null }))
    assert.deepEqual(Object.keys(m), ['b'])
    const same = applyPhaseFrame(m, { ...frame('b', {}), kind: 'message.delta' } as PultEvent)
    assert.equal(same, m, 'обычное событие — та же карта')
    assert.equal(applyPhaseFrame(m, frame('zz', { phase: null })), m, 'снять незнакомую — та же карта')
    m = applyPhaseFrame(m, frame('b', { phase: { phase: 'летает', since: 1 } }))
    assert.deepEqual(Object.keys(m), [], 'непонятная фаза — как «нет фазы»')
    m = applyPhaseFrame(applyPhaseFrame(m, frame('a', { phase: ph() })), frame('daemon', { reset: true }))
    assert.equal(m, EMPTY_PHASES)
    assert.equal(parsePhase({ phase: 'tool', since: 'вчера' }), null)
    assert.deepEqual(parsePhase({ phase: 'tool', since: 5, tool: { name: 'Bash' }, background: 0, reasoning: '' }), { phase: 'tool', since: 5, turnSince: 5, tool: { name: 'Bash', detail: '' } })
  })
})

describe('фаза хода: подписи и секунды', () => {
  it('секунды — от начала фазы по часам демона', () => {
    assert.equal(formatElapsed(0), '0 с')
    assert.equal(formatElapsed(-500), '0 с')
    assert.equal(formatElapsed(12_900), '12 с')
    assert.equal(formatElapsed(65_000), '1 мин 05 с')
    assert.equal(formatElapsed(3_725_000), '1 ч 02 мин')
    assert.equal(phaseElapsed(ph(), NOW), '12 с')
  })

  it('каждая фаза — своими словами; инструмент с подписью; фоновые задачи — хвостом', () => {
    assert.equal(phaseText(ph({ phase: 'starting' })), 'запускается…')
    assert.equal(phaseText(ph()), 'думает…')
    assert.equal(phaseText(ph({ phase: 'writing' })), 'пишет…')
    assert.equal(phaseText(ph({ phase: 'tool', tool: { name: 'Bash', detail: 'npm test' } })), 'выполняет: Bash npm test…')
    assert.equal(phaseText(ph({ phase: 'waiting', waiting: { kind: 'permission', permId: 'p1', toolName: 'Bash' } })), 'ждёт тебя')
    assert.equal(phaseText(ph({ phase: 'waiting', waiting: { kind: 'question', permId: 'p1', toolName: 'AskUserQuestion' } })), 'ждёт ответа на вопрос')
    assert.equal(phaseText(ph({ background: 2 })), 'думает… · фоновые задачи: 2')
    assert.equal(phaseText(ph({ phase: 'background', background: 3 })), 'фоновые задачи: 3')
    // Подпись инструмента — та же, что у свёрнутой строки инструмента в ленте.
    assert.equal(toolSummary('Grep', { pattern: 'formatPct', path: 'ui/src' }), 'formatPct  в ui/src')
  })

  it('диктор: только смена фазы — без секунд, подписи инструмента и текста размышлений', () => {
    assert.equal(phaseAnnouncement(ph({ reasoning: 'много текста' })), 'думает')
    assert.equal(phaseAnnouncement(ph({ phase: 'tool', tool: { name: 'mcp__browser__browser_navigate', detail: 'https://x.test' } })), 'выполняет browser_navigate')
    assert.equal(phaseAnnouncement(null), '')
    assert.equal(shortToolName('mcp__my_srv__do_it'), 'do_it')
    assert.equal(shortToolName('Bash'), 'Bash')
  })
})

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  name: 'w', provider: 'claude', status: 'working', cwd: '/w/app', pending: 0, lastActivity: '2026-10-23T09:59:50Z', ...over,
})

describe('строка фазы в ленте', () => {
  it('«думает… 12 с»: диктору — «думает» в aria-live, секунды ему не читаются', () => {
    const out = html(PhaseLine, { phase: ph(), now: NOW })
    assert.match(out, /data-testid="turn-phase" data-phase="thinking"/)
    assert.match(out, /data-testid="turn-phase-text">думает…</)
    assert.match(out, /data-testid="turn-phase-time" aria-hidden="true">12 с</)
    assert.match(out, /role="status" aria-live="polite" data-testid="turn-phase-live">думает</)
    assert.doesNotMatch(out, /Размышления/, 'текста нет — и раскрывашки нет')
  })

  it('размышления — свёрнутым «Размышления» с текстом', () => {
    const out = html(PhaseLine, { phase: ph({ reasoning: 'сначала проверю тесты' }), now: NOW })
    assert.match(out, /<details class="phase-reasoning" data-testid="turn-phase-reasoning"><summary>Размышления<\/summary><pre class="mono">сначала проверю тесты<\/pre><\/details>/)
    assert.doesNotMatch(out, /<details[^>]* open/, 'свёрнуто')
  })

  it('«ждёт тебя» — со ссылкой в Inbox; без обработчика ссылки нет', () => {
    const waiting = ph({ phase: 'waiting', waiting: { kind: 'permission', permId: 'p1-x', toolName: 'Bash' } })
    assert.match(html(PhaseLine, { phase: waiting, now: NOW, onOpenInbox: noop }), /data-testid="turn-phase-inbox"[^>]*>открыть в Inbox</)
    assert.doesNotMatch(html(PhaseLine, { phase: waiting, now: NOW }), /turn-phase-inbox/)
  })

  it('в ленте — после реплик; пока реплика «отправляется…» — строки нет; без фазы — нет', () => {
    const items = [{ type: 'user', key: 'u', id: 1, ts: '2026-10-23T09:59:40Z', text: 'почини' }]
    const base = {
      items, now: NOW, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    }
    const out = html(Conversation, { ...base, agent: agent({ phase: ph({ phase: 'tool', tool: { name: 'Bash', detail: 'npm test' } }) }) })
    assert.ok(out.indexOf('data-testid="msg-user"') < out.indexOf('data-testid="turn-phase"'), 'строка — под репликой')
    assert.match(text(out), /выполняет: Bash npm test…/)
    assert.doesNotMatch(html(Conversation, { ...base, agent: agent({ phase: ph() }), pending: { text: 'ещё', ts: '2026-10-23T09:59:59Z' } }), /turn-phase/)
    assert.doesNotMatch(html(Conversation, { ...base, agent: agent({ status: 'idle' }) }), /turn-phase/)
  })
})

describe('список: устойчивый статус и фаза в подробностях', () => {
  const tree = (agents: AgentView[]): Record<string, unknown> => ({
    groups: groupByProject([], agents), selected: null, now: NOW, collapsed: new Set<string>(),
    onSelect: noop, onNew: noop, onToggle: noop, onAddProject: noop, onPin: noop,
  })
  const chip = (a: AgentView): string => /data-testid="row-status"[^>]*>([^<]*)</.exec(html(ProjectTree, tree([a])))?.[1] ?? ''

  it('статус «Работает» стабилен, фаза видна отдельно; ожидание не маскируется фазой', () => {
    assert.equal(treePhaseLabel(ph({ phase: 'starting' })), 'запуск')
    assert.equal(treePhaseLabel(ph({ phase: 'tool', tool: { name: 'mcp__browser__browser_take_screenshot', detail: '' } })), 'browser_take_sc…')
    assert.equal(treePhaseLabel(ph({ phase: 'background', background: 1 })), null)
    assert.equal(chip(agent({ phase: ph() })), 'Работает')
    assert.match(html(ProjectTree, tree([agent({ phase: ph() })])), /class="chat-action" title="думает">думает</)
    assert.equal(chip(agent({ phase: ph({ phase: 'writing' }) })), 'Работает')
    assert.equal(chip(agent({ phase: ph({ phase: 'tool', tool: { name: 'Bash', detail: 'npm test' } }) })), 'Работает')
    assert.equal(chip(agent()), 'Работает')
    assert.equal(chip(agent({ status: 'blocked_permission', pending: 1, phase: ph({ phase: 'waiting' }) })), 'Ждёт ответа · 1')
    assert.equal(chip(agent({ status: 'idle', phase: ph({ phase: 'background', background: 2 }) })), 'Готово')
  })

  it('Codex: команда — «shell» с самой командой (без обёртки оболочки) и секундами; фон — значком «фон · N»', () => {
    const cmd = ph({ phase: 'tool', tool: { name: 'commandExecution', detail: toolSummary('commandExecution', { command: "/bin/zsh -lc 'npm test'" }) } })
    assert.equal(phaseText(cmd), 'выполняет: shell npm test…')
    assert.equal(treePhaseLabel(cmd), 'shell')
    assert.equal(shortToolName('commandExecution'), 'shell')
    assert.equal(toolSummary('commandExecution', { command: '/bin/bash -c "make check"' }), 'make check')
    assert.equal(toolSummary('commandExecution', { command: 'ls -la' }), 'ls -la', 'без обёртки — как есть')
    assert.equal(toolSummary('commandExecution', { command: "/opt/homebrew/bin/zsh -cl 'npm run e2e'" }), 'npm run e2e')
    assert.equal(toolSummary('Bash', { command: `bash -c "echo 'a b' && rm -rf build"` }), "echo 'a b' && rm -rf build", 'внутренние кавычки не раскрываются, ничего не прячется')
    assert.equal(toolSummary('Bash', { command: "shellcheck -c 'x'" }), "shellcheck -c 'x'", 'не оболочка — как есть')
    const bgRow = html(ProjectTree, tree([agent({ provider: 'codex', status: 'idle', background: { count: 2, tasks: ['npm test', 'субагент'] } })]))
    assert.match(bgRow, /data-testid="row-background"[^>]*>фон · 2</)
    assert.equal(chip(agent({ provider: 'codex', status: 'idle', background: { count: 2, tasks: [] } })), 'В фоне')
    assert.doesNotMatch(bgRow, /chat-row-status[^"]*is-quiet/, 'идущая работа — не «тихая» строка')
  })

  it('фаза из живого канала доезжает до строки (buildAgents)', () => {
    const rec = { name: 'w', provider: 'claude', cwd: '/w', createdAt: '2026-10-23T09:00:00Z', lastStatus: 'working', pendingPermissions: 0 }
    const [v] = buildAgents([rec as never], { w: { phase: ph({ phase: 'writing' }) } })
    assert.equal(v?.phase?.phase, 'writing')
    const [none] = buildAgents([rec as never], {})
    assert.equal(none?.phase, undefined)
  })
})
