// Быстрый старт, шаг A, окно: согласие на полный доступ один раз, метки по действующему режиму (чип, плашка, щит,
// рамка, строка под полем), меню доступа с «Как в настройках Claude», «Настройки → Доступ».

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccessSection, ConsentDialog } from '../src/components/Access.js'
import { Conversation } from '../src/components/Conversation.js'
import { accessChip, consentGrants, consentLine, headerPill, needsConsent, pendingStrip, sidebarFull } from '../src/model/access.js'
import type { AccessView, ConsentView } from '../src/model/access.js'
import type { AgentView } from '../src/model/agents.js'
import { buildAgents } from '../src/model/agents.js'
import { draftStartParams, pickApproval, pickModel } from '../src/model/draft.js'
import { draft, env } from './draftFixture.js'
import { configureParams, confirmNeeded, settingsMenu } from '../src/model/sessionSettings.js'
import type { MenuRow } from '../src/model/sessionSettings.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const noop = (): void => {}

const GRANTED: ConsentView = { rev: 3, version: 1, current: 1, granted: true, providers: ['claude', 'codex', 'zcode'], grantedAt: '2026-11-02T11:00:00Z' }
const NONE: ConsentView = { rev: 0, version: 0, current: 1, granted: false, providers: [] }
const REVOKED: ConsentView = { rev: 4, version: 1, current: 1, granted: false, providers: [], revokedAt: '2026-11-03T09:00:00Z' }
const view = (over: Partial<AccessView> = {}): AccessView => ({ desired: 'ask', desiredFull: false, blocked: false, live: false, pending: false, red: false, ...over })
const agent = (over: Partial<AgentView> = {}): AgentView =>
  ({ name: 'w', provider: 'claude', status: 'idle', cwd: '/w', pending: 0, lastActivity: '2026-11-02T09:00:00Z', model: 'opus', effort: 'high', ...over })
const BYPASS = { approval: 'full' as const, reported: 'bypassPermissions', confirmed: true, full: true, at: 'x' }

describe('шаг A: согласие в окне', () => {
  it('согласие на провайдера; полный уровень без согласия — диалог, с согласием — без вопроса (ui/test/settings:61 разделён)', () => {
    assert.equal(consentGrants(GRANTED, 'codex'), true)
    assert.equal(consentGrants(REVOKED, 'claude'), false)
    assert.equal(consentGrants(null, 'claude'), false)
    assert.equal(needsConsent('claude', 'full', null, NONE), true)
    assert.equal(needsConsent('claude', 'full', null, GRANTED), false)
    assert.equal(needsConsent('claude', 'inherit', 'bypassPermissions', NONE), true)
    assert.equal(needsConsent('claude', 'inherit', 'auto', NONE), false)
    assert.equal(confirmNeeded({ kind: 'approval', approval: 'full' }, NONE), 'full', 'без согласия — диалог согласия')
    assert.equal(confirmNeeded({ kind: 'approval', approval: 'full' }, GRANTED), null, 'с согласием — без модала')
    assert.equal(confirmNeeded({ kind: 'approval', approval: 'inherit' }, NONE, 'claude', 'bypassPermissions'), 'full')
    // confirm: true демон требует по-прежнему; consentRev — номер, который видело окно.
    assert.deepEqual(configureParams('w', { kind: 'approval', approval: 'full' }, true, 3), { name: 'w', approval: 'full', confirm: true, consentRev: 3 })
    assert.deepEqual(configureParams('w', { kind: 'model', model: 'opus' }, true, 3), { name: 'w', model: 'opus', confirm: true })
    // Шаг B: черновик шлёт тот же confirm и номер согласия, который видело окно.
    const f = draft('/w')
    const full = draftStartParams(pickApproval(f, 'full', 3), { prompt: 'x', consentRev: 3, inheritMode: null })
    assert.deepEqual([full['confirm'], full['consentRev']], [true, 3])
    assert.equal('consentRev' in draftStartParams(pickApproval(f, 'workspace', 3), { prompt: 'x', consentRev: 3, inheritMode: null }), false)
    assert.equal(pickModel(pickApproval(f, 'inherit', 3), 'codex', null, env(), null).approval, 'ask', '«как в настройках Claude» у Codex — явный «Спрашивать»')
  })
  it('диалог: оба провайдера, честные границы (MCP, браузер Пульта), «Оставить как было» и «Разрешить»', () => {
    const out = html(ConsentDialog, { onGrant: noop, onKeep: noop })
    const t = text(out)
    assert.match(t, /Полный доступ: Claude, Codex и ZCode/)
    assert.match(t, /bypassPermissions .* ask\/deny/)
    assert.match(t, /danger-full-access \+ never/)
    assert.match(t, /Пульт его сам не даст — оно придёт в Inbox/)
    assert.match(t, /Встроенный браузер Пульта в этом режиме выключен\. Твои MCP-серверы и shell — нет\./)
    assert.match(t, /Отозвать разрешение — Настройки → Доступ/)
    assert.doesNotMatch(t, /MCP[- ]серверы тоже без вопросов/)
    assert.match(out, /role="alertdialog"/)
    assert.match(out, /data-testid="consent-keep"[^>]*>Оставить как было/)
    assert.match(out, /data-testid="consent-grant"[^>]*>Разрешить полный доступ/)
    assert.match(text(html(ConsentDialog, { onGrant: noop, onKeep: noop, error: 'окно старое' })), /окно старое/)
  })
  it('«Настройки → Доступ»: дата согласия и «Отозвать»; отозвано / не дано — без кнопки', () => {
    const g = html(AccessSection, { consent: GRANTED, onRevoke: async () => null })
    assert.match(text(g), /Полный доступ разрешён 02\.11\.2026/)
    assert.match(g, /data-testid="access-revoke"/)
    assert.doesNotMatch(html(AccessSection, { consent: REVOKED, onRevoke: async () => null }), /access-revoke/)
    assert.match(consentLine(REVOKED), /отозван 03\.11\.2026/)
    assert.match(consentLine(NONE), /спрашивается один раз/)
  })
})

describe('шаг A: метки по действующему режиму', () => {
  it('полный выбран: красный чип, плашка, щит; ходов не было — «ожидается»', () => {
    const a = { provider: 'claude' as const, approval: 'full' as const, access: view({ desired: 'full', desiredFull: true, red: true }) }
    const chip = accessChip(a)
    assert.deepEqual([chip.label, chip.red, chip.state, chip.suffix], ['Полный доступ', true, 'expected', 'ожидается'])
    assert.deepEqual(headerPill(a), { label: 'полный доступ', state: 'full' })
    assert.equal(sidebarFull(a), true)
    const after = accessChip({ ...a, access: view({ desired: 'full', desiredFull: true, red: true, applied: BYPASS }) })
    assert.deepEqual([after.state, after.suffix], ['full', null])
  })
  it('понижение во время хода: «Спрашивать · после хода», «полный доступ · до конца хода», строка «Стоп»; процесс вышел — метки нет', () => {
    const a = { provider: 'claude' as const, access: view({ desired: 'ask', applied: BYPASS, live: true, pending: true, red: true }) }
    const chip = accessChip(a)
    assert.deepEqual([chip.label, chip.suffix, chip.red], ['Спрашивать', 'после хода', true])
    assert.deepEqual(headerPill(a), { label: 'полный доступ · до конца хода', state: 'until-turn-end' })
    assert.match(pendingStrip(a) ?? '', /Нужно сейчас — «Стоп»/)
    const done = { provider: 'claude' as const, access: view({ desired: 'ask', applied: BYPASS }) }
    assert.equal(headerPill(done), null)
    assert.equal(sidebarFull(done), false)
    assert.equal(pendingStrip(done), null)
  })
  it('полный выбран без разрешения — «не разрешён», не красный; Codex без подтверждения — «не подтверждено»', () => {
    const b = accessChip({ provider: 'claude', approval: 'full', access: view({ desired: 'full', desiredFull: true, blocked: true, applied: { ...BYPASS, approval: 'ask', reported: 'default', full: false } }) })
    assert.deepEqual([b.state, b.suffix, b.red], ['blocked', 'не разрешён', false])
    const cx = accessChip({ provider: 'codex', access: view({ desired: 'workspace', applied: { approval: 'workspace', reported: null, confirmed: false, full: false, at: 'x' } }) })
    assert.deepEqual([cx.state, cx.suffix], ['unconfirmed', 'не подтверждено'])
    const inh = accessChip({ provider: 'claude', approval: 'inherit', access: view({ desired: 'inherit', inheritMode: 'auto', applied: { approval: 'inherit', reported: 'auto', confirmed: true, full: false, at: 'x' } }) })
    assert.equal(inh.label, 'Как в настройках Claude: auto')
  })
  it('чат: плашка в шапке, красный чип со щитом, красная рамка поля, строка под полем при понижении', () => {
    const [a] = buildAgents([{ name: 'w', provider: 'claude', cwd: '/w', mode: 'turn', createdAt: 'x', lastStatus: 'working', lastEventId: 0, pendingPermissions: 0,
      access: view({ desired: 'ask', applied: BYPASS, live: true, pending: true, red: true }) } as never], {})
    const props = {
      agent: a, items: [], now: Date.parse('2026-11-02T10:00:00Z'), usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    }
    const out = html(Conversation, props)
    assert.match(out, /data-testid="conv-access-pill" data-state="until-turn-end"|data-state="until-turn-end"[^>]*data-testid="conv-access-pill"/)
    assert.match(out, /class="approval t-fail" data-testid="conv-approval" data-approval="ask" data-access-state="pending"/)
    assert.match(out, /class="box access-full" data-access-full="1"/)
    assert.match(out, /data-testid="access-pending-strip"/)
    assert.match(out, /data-testid="stop-turn"/, '«Стоп» виден, пока идёт ход')
  })
})

describe('шаг A: меню доступа в подвале', () => {
  const items = (rows: MenuRow[]): MenuRow[] => rows.filter((r) => r.type === 'item' && r.pick.kind === 'approval')
  const label = (r: MenuRow): string => (r.type === 'sep' ? '—' : r.label)
  it('Claude: пять уровней, «Как в настройках Claude · сейчас auto»; без согласия — «спрошу один раз»; bypass — красный', () => {
    const rows = items(settingsMenu(agent({ approval: 'inherit', claudeMode: 'auto' }), null, new Map(), NONE))
    assert.deepEqual(rows.map(label), ['Только чтение', 'Спрашивать', 'Правки в папке без вопросов', 'Полный доступ · спрошу один раз', 'Как в настройках Claude · сейчас auto'])
    assert.deepEqual(items(settingsMenu(agent(), null, new Map(), GRANTED)).map(label)[3], 'Полный доступ')
    const byp = items(settingsMenu(agent({ approval: 'inherit', access: view({ desired: 'inherit', inheritMode: 'bypassPermissions' }) }), null, new Map(), NONE))
    const inh = byp.find((r) => r.type === 'item' && r.pick.kind === 'approval' && r.pick.approval === 'inherit')
    assert.equal(inh?.type === 'item' && inh.danger, true)
  })
  it('Codex: четыре уровня, «Как в настройках Claude» нет', () => {
    const rows = items(settingsMenu(agent({ provider: 'codex', model: 'gpt-x' }), null, new Map(), NONE))
    assert.equal(rows.length, 4)
    assert.equal(rows.some((r) => r.type === 'item' && r.pick.kind === 'approval' && r.pick.approval === 'inherit'), false)
  })
  it('ZCode (PR #40): четыре уровня, полный — под тем же согласием; согласие на двоих его не покрывает; чип «не подтверждено»', () => {
    const z = agent({ provider: 'zcode' })
    delete (z as { model?: string }).model
    delete (z as { effort?: string }).effort
    const rows = items(settingsMenu(z, null, new Map(), NONE))
    assert.deepEqual(rows.map(label), ['Только чтение', 'Спрашивать', 'Правки в папке без вопросов', 'Полный доступ · спрошу один раз'])
    assert.equal(items(settingsMenu(z, null, new Map(), GRANTED)).map(label)[3], 'Полный доступ')
    const OLD: ConsentView = { ...GRANTED, providers: ['claude', 'codex'] }
    assert.equal(needsConsent('zcode', 'full', null, OLD), true, 'согласие до ZCode — диалог ещё раз')
    assert.equal(needsConsent('zcode', 'full', null, GRANTED), false)
    assert.equal(confirmNeeded({ kind: 'approval', approval: 'full' }, OLD, 'zcode'), 'full')
    const c = accessChip({ provider: 'zcode', approval: 'full', access: view({ desired: 'full', desiredFull: true, red: true, applied: { approval: 'full', reported: null, confirmed: false, full: true, at: 'x' } }) })
    assert.deepEqual([c.state, c.suffix, c.red], ['unconfirmed', 'не подтверждено', true])
    assert.match(c.title, /последний процесс запущен с «Полный доступ» \(не подтверждено\)/)
    const d = text(html(ConsentDialog, { onGrant: noop, onKeep: noop }))
    assert.match(d, /ZCode --mode yolo/)
  })
})
