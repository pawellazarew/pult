// Одна точка состояния (StatusDot) на весь интерфейс: цвет — только состояние, никогда не провайдер.
// Регрессия: вкладка сессии красила точку в цвет провайдера (зелёный у Codex), и «работает» не отличалось
// от «простаивает» — а строка чата в боковой панели показывала синюю мигающую точку.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusDot, toneState } from '../src/components/StatusDot.js'
import type { DotState } from '../src/components/StatusDot.js'
import { SessionTabs } from '../src/components/SessionTabs.js'
import { ProjectTree } from '../src/components/ProjectTree.js'
import { PhaseLine } from '../src/components/Conversation.js'
import { Chip } from '../src/components/common.js'
import { groupByProject } from '../src/model/projects.js'
import type { AgentView } from '../src/model/agents.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const noop = (): void => {}
const NOW = Date.parse('2026-11-06T10:00:00Z')
const agent = (over: Partial<AgentView> = {}): AgentView => ({
  name: 'fix-dot', provider: 'codex', status: 'idle', cwd: '/w/pult', pending: 0, lastActivity: '2026-11-06T09:59:50Z', ...over,
})
const tree = (agents: AgentView[]) => ({
  groups: groupByProject([], agents), selected: null, now: NOW, collapsed: new Set<string>(),
  onSelect: noop, onNew: noop, onToggle: noop, onAddProject: noop, onPin: noop,
})
const tabs = (a: AgentView): string => html(SessionTabs, { tabs: [a], active: a.name, onSelect: noop, onClose: noop })
/** Точка состояния из разметки: `data-state` или null, если точки нет. */
const dotIn = (out: string): string | null => /class="status-dot[^"]*" data-state="([a-z]+)"/.exec(out)?.[1] ?? null
const css = (path: string): string => readFileSync(new URL(`../ui/src/${path}`, import.meta.url), 'utf8')

describe('StatusDot', () => {
  const states: DotState[] = ['working', 'waiting', 'failed', 'done', 'idle', 'queued']
  const labels: Record<DotState, string> = {
    working: 'Работает', waiting: 'Ждёт ответа', failed: 'Ошибка', done: 'Готово', idle: 'Простаивает', queued: 'В очереди',
  }

  it('каждое состояние — свой data-state и подпись для читалки', () => {
    for (const state of states) {
      const out = html(StatusDot, { state })
      assert.match(out, new RegExp(`data-state="${state}"`), state)
      assert.match(out, /data-size="sm"/)
      assert.match(out, /role="img"/)
      assert.match(out, new RegExp(`aria-label="${labels[state]}"`), state)
    }
  })

  it('live → role="status"; label=null → декоративная, без роли и подписи', () => {
    assert.match(html(StatusDot, { state: 'working', live: true }), /role="status"/)
    const deco = html(StatusDot, { state: 'working', label: null, size: 'md' })
    assert.match(deco, /aria-hidden="true"/)
    assert.doesNotMatch(deco, /role=|aria-label/)
    assert.match(deco, /data-size="md"/)
  })

  it('тон модели → состояние', () => {
    assert.deepEqual(['run', 'wait', 'fail', 'ok', 'queued', 'mut'].map(toneState), ['working', 'waiting', 'failed', 'done', 'queued', 'queued'])
  })

  it('CSS: цвета только на токенах состояния, работа мигает, без движения — кольцо', () => {
    const dot = css('components/status-dot.css')
    for (const [state, token] of [['working', '--run'], ['waiting', '--wait'], ['failed', '--fail'], ['done', '--ok'], ['queued', '--queued']]) {
      assert.match(dot, new RegExp(`\\.status-dot\\[data-state="${state}"\\] \\{[^}]*background: var\\(${token}\\)`), state)
    }
    assert.match(dot, /\[data-state="working"\] \{[^}]*animation: pulse 1\.4s/)
    assert.match(dot, /prefers-reduced-motion: reduce\)\s*\{\s*\.status-dot\[data-state="working"\] \{ animation: none; outline: 1px solid var\(--run\)/)
    assert.doesNotMatch(dot, /--prov|--teal|--claude|--glm/, 'точка не знает про провайдеров')
  })

  it('старых самодельных точек в стилях больше нет', () => {
    const all = css('styles.css') + css('workspace.css') + css('components/temporary-chat.css')
    for (const dead of ['.tab-dot', '.phase-dot', '.chip .dot', '.pstat', '.cell-state .dot', '.subagent-state', 'data-working']) {
      assert.ok(!all.includes(dead), dead)
    }
  })
})

describe('вкладка сессии говорит то же, что строка чата', () => {
  it('работает: синяя мигающая StatusDot поверх значка провайдера, не цвет провайдера', () => {
    const out = tabs(agent({ status: 'working' }))
    assert.match(out, /<span class="tab-provider"><span class="provider-icon [^"]*" role="img" aria-label="Codex"/)
    assert.match(out, /class="status-dot tab-live-dot" data-state="working" data-size="sm" data-cutout="1" data-testid="tab-status" role="img" aria-label="Работает"/)
    assert.doesNotMatch(out, /tab-dot|data-busy/)
    // Та же точка, что у строки в боковой панели.
    assert.equal(dotIn(html(ProjectTree, tree([agent({ status: 'working' })]))), 'working')
  })

  it('ждёт и ошибка — точка своего цвета; готово и история — без точки, как в строке', () => {
    const cases: Array<[Partial<AgentView>, string | null]> = [
      [{ status: 'blocked_permission', pending: 1 }, 'waiting'],
      [{ status: 'failed' }, 'failed'],
      [{ status: 'limited' }, 'failed'],
      [{ status: 'idle', background: { count: 1, tasks: ['build'] } }, 'working'],
      [{ status: 'idle' }, null],
      [{ status: 'cold' }, null],
      [{ status: 'done' }, null],
    ]
    for (const [over, want] of cases) {
      const a = agent(over)
      assert.equal(dotIn(tabs(a)), want, `вкладка ${JSON.stringify(over)}`)
      assert.equal(dotIn(html(ProjectTree, tree([a]))), want, `строка ${JSON.stringify(over)}`)
    }
    assert.match(tabs(agent({ status: 'blocked_question' })), /data-needs="1"/)
  })

  it('провайдер не меняет вид точки', () => {
    const strip = (s: string): string => /<span class="status-dot[^>]*>/.exec(s)?.[0] ?? ''
    const claude = strip(tabs(agent({ provider: 'claude', status: 'working' })))
    assert.ok(claude)
    assert.equal(strip(tabs(agent({ provider: 'codex', status: 'working' }))), claude)
    assert.equal(strip(tabs(agent({ provider: 'zcode', status: 'working' }))), claude)
  })
})

describe('остальные места — та же StatusDot', () => {
  it('строка фазы: работа, ожидание, запуск; декоративная — диктору говорит role="status" рядом', () => {
    const phase = (p: string): string => html(PhaseLine, { phase: { phase: p, since: NOW, turnSince: NOW }, now: NOW })
    assert.equal(dotIn(phase('thinking')), 'working')
    assert.equal(dotIn(phase('tool')), 'working')
    assert.equal(dotIn(phase('waiting')), 'waiting')
    assert.equal(dotIn(phase('starting')), 'queued')
    assert.match(phase('thinking'), /class="status-dot" data-state="working" data-size="md" data-testid="turn-phase-dot" aria-hidden="true"/)
  })

  it('плашка статуса в шапке', () => {
    assert.equal(dotIn(html(Chip, { tone: 'run', label: 'идёт' })), 'working')
    assert.equal(dotIn(html(Chip, { tone: 'fail', label: 'ошибка' })), 'failed')
  })
})
