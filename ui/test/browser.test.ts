// О3 в окне: галочка «Браузер» в «+ Сессия», пункт меню сессии, «браузер · скачивания» в подвале,
// заметка «Ход без браузера» и диалог «MCP-серверы». Отрисовка в строку, без DOM.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { DoctorPanel, McpServersDialog } from '../src/components/Panels.js'
import { DraftView } from '../src/components/Draft.js'
import { browserItems } from '../src/components/ProjectTree.js'
import type { AgentView } from '../src/model/agents.js'
import { buildAgents } from '../src/model/agents.js'
import { applyConversation, EMPTY_CONVERSATION } from '../src/model/conversation.js'
import { mcpRows, toggleServer } from '../src/model/mcp.js'
import type { McpListing } from '../src/model/mcp.js'
import { draftStartParams, pickApproval, toggleBrowser } from '../src/model/draft.js'
import { draft, draftProps } from './draftFixture.js'
import type { AgentRecord, PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const noop = (): void => {}

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  name: 'w', provider: 'claude', status: 'idle', cwd: '/w/pult', pending: 0, lastActivity: '2026-10-14T09:59:50Z', ...over,
})

describe('черновик: браузер для агента', () => {
  it('по умолчанию выключен; пункт в «⋯»; «показывать окно» — только при включённом', () => {
    const out = html(DraftView, draftProps({ draft: pickApproval(draft(), 'ask', null), initialMenu: 'more' }))
    assert.match(out, /data-testid="draft-more-browser"[^>]*/)
    assert.match(out, /aria-checked="false"[^>]*data-testid="draft-more-browser"/)
    assert.doesNotMatch(out, /draft-more-headed/, 'окно — только когда браузер включён')
    assert.match(text(out), /Встроенный браузер Пульта/)
    assert.match(text(out), /через Inbox/)
    const on = html(DraftView, draftProps({ draft: toggleBrowser(pickApproval(draft(), 'ask', null), true), initialMenu: 'more' }))
    assert.match(on, /draft-more-headed/)
    assert.match(on, /data-testid="draft-chip-browser"/, 'включённое — пунктирным чипом')
  })

  it('agent.start: браузер — true или {headed: true}; выключен — поля нет', () => {
    const f = pickApproval(draft('/x'), 'ask', null)
    const p = (d: typeof f): unknown => draftStartParams(d, { prompt: '', inheritMode: null })['browser']
    assert.equal(p(f), undefined)
    assert.equal(p(toggleBrowser(f, true)), true)
    assert.deepEqual(p(toggleBrowser(f, true, true)), { headed: true })
    assert.equal(p({ ...f, browser: false, browserHeaded: true }), undefined)
  })
})

describe('сессия с браузером', () => {
  it('agent.list → вид: браузер и папка скачиваний', () => {
    const rec = { name: 'w', provider: 'claude', cwd: '/x', mode: 'turn', createdAt: '2026-10-14T10:00:00Z', lastStatus: 'idle', lastEventId: 0,
      pendingPermissions: 0, browser: { headed: true }, browserDownloads: '/h/browser/w/downloads' } as AgentRecord
    const [v] = buildAgents([rec], {})
    assert.deepEqual(v?.browser, { headed: true })
    assert.equal(v?.browserDownloads, '/h/browser/w/downloads')
    const [n] = buildAgents([{ ...rec, browser: undefined } as AgentRecord], {})
    assert.equal(n?.browser, undefined)
    assert.equal(n?.browserDownloads, undefined, 'без браузера папку не показываем')
  })

  it('подвал: «браузер · скачивания» только у сессии с браузером', () => {
    const props = (a: AgentView): Record<string, unknown> => ({
      agent: a, items: [], now: Date.now(), usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    })
    const on = html(Conversation, props(agent({ browser: { headed: true }, browserDownloads: '/h/browser/w/downloads' })))
    assert.match(on, /data-testid="conv-browser"/)
    assert.match(text(on), /браузер \(окно\) · скачивания/)
    assert.match(on, /Скачивания: \/h\/browser\/w\/downloads/)
    assert.doesNotMatch(html(Conversation, props(agent())), /conv-browser/)
  })

  it('меню сессии: включить; включён — выключить и «показывать окно»', () => {
    const calls: Array<[string, boolean, boolean]> = []
    const cb = (n: string, on: boolean, headed: boolean): void => { calls.push([n, on, headed]) }
    const off = browserItems(agent(), cb)
    assert.deepEqual(off.map((i) => (i === 'sep' ? i : (i as { label: string }).label)), ['Браузер для агента'])
    ;(off[0] as { onSelect(): void }).onSelect()
    const on = browserItems(agent({ browser: {} }), cb)
    assert.deepEqual(on.map((i) => (i === 'sep' ? i : (i as { label: string }).label)), ['✓ Браузер для агента', 'Показывать окно браузера'])
    ;(on[0] as { onSelect(): void }).onSelect()
    ;(on[1] as { onSelect(): void }).onSelect()
    const headed = browserItems(agent({ browser: { headed: true } }), cb)
    ;(headed[1] as { onSelect(): void }).onSelect()
    assert.deepEqual(calls, [['w', true, false], ['w', false, false], ['w', true, true], ['w', true, false]])
  })

  it('лента: «Ход без браузера» и «после перезапуска демона» с причиной; установка у демона — без заметки', () => {
    const ev = (id: number, data: Record<string, unknown>): PultEvent =>
      ({ id, ts: '2026-10-14T10:00:00Z', sessionId: 'w', provider: 'claude', kind: 'browser.install', data })
    const c = applyConversation(EMPTY_CONVERSATION, ev(1, { state: 'skipped', reason: 'Playwright MCP не поставился: ETIMEDOUT — повтор на следующем ходу, починка: pult browser install' }))
    const n = c.items[0] as { type: string; title: string; text: string }
    assert.equal(n.type, 'notice')
    assert.equal(n.title, 'Ход без браузера')
    assert.match(n.text, /pult browser install/)
    const p = applyConversation(EMPTY_CONVERSATION, ev(2, { state: 'pending', reason: 'Codex подхватит смену браузера…' })).items[0] as { title: string }
    assert.equal(p.title, 'Браузер — после перезапуска демона')
    assert.equal(applyConversation(EMPTY_CONVERSATION, ev(3, { state: 'done' })).items.length, 0)
  })
})

describe('«MCP-серверы»', () => {
  const listing: McpListing = {
    servers: [
      { name: 'linear', transport: 'http', detail: 'https://mcp.linear.app' },
      { name: 'github', transport: 'stdio', detail: 'gh-mcp' },
    ],
    selected: ['github', 'gone'],
    missing: ['gone'],
    warnings: ['/h/.claude.json: не разбирается как JSON — серверы оттуда не видны'],
  }

  it('строки: по имени, отмечены выбранные; переключение', () => {
    assert.deepEqual(mcpRows(listing, listing.selected).map((r) => `${r.name}:${r.checked ? 'x' : '-'}`), ['github:x', 'linear:-'])
    assert.deepEqual(toggleServer(['a'], 'b'), ['a', 'b'])
    assert.deepEqual(toggleServer(['a', 'b'], 'a'), ['b'])
    assert.deepEqual(mcpRows(null, []), [])
  })

  it('диалог: только ~/.claude.json, предупреждение файла, выбранный-но-не-найденный, сохранение выключено до правки', () => {
    const out = html(McpServersDialog, { listing, loading: false, error: null, saving: false, onSave: noop, onClose: noop })
    assert.equal((out.match(/data-testid="mcp-row"/g) ?? []).length, 2)
    assert.match(out, /data-testid="mcp-check-github"[^>]*checked/)
    assert.match(out, /data-testid="mcp-warning"/)
    assert.match(out, /data-testid="mcp-missing"[^>]*data-name="gone"/)
    assert.match(out, /data-testid="mcp-save"[^>]*disabled|disabled=""[^>]*data-testid="mcp-save"/)
    assert.match(text(out), /\.mcp\.json\) — позже/)
    assert.match(text(out), /~\/\.codex\/config\.toml/)
    const empty = html(McpServersDialog, { listing: { servers: [], selected: [], missing: [], warnings: [] }, loading: false, error: null, saving: false, onSave: noop, onClose: noop })
    assert.match(empty, /data-testid="mcp-empty"/)
  })

  it('doctor: кнопка «MCP-серверы…» — только когда окно умеет mcp.*', () => {
    const base = { report: null, groups: [], loading: false, error: null, copied: null, onRerun: noop, onCopy: noop, onClose: noop }
    assert.match(html(DoctorPanel, { ...base, onMcp: noop }), /data-testid="open-mcp-settings"/)
    assert.doesNotMatch(html(DoctorPanel, base), /open-mcp-settings/)
  })
})
