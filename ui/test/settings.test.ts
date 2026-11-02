// M8f в окне: подвал «opus · high · спрашивать» — кнопка меню (модель, усилие, режим — со следующего хода),
// строка ленты о смене, «+ Сессия» по слоям (умолчания, последний выбор, явный контекст), «Настройки» (⌘,).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { SettingsDialog } from '../src/components/Settings.js'
import type { AgentView } from '../src/model/agents.js'
import { applyConversation, EMPTY_CONVERSATION } from '../src/model/conversation.js'
import { hotkeyAction } from '../src/model/hotkeys.js'
import { prefillForm, startParams, switchProviderPrefill } from '../src/model/newAgent.js'
import type { SettingsReply } from '../src/model/newAgent.js'
import {
  configureParams, confirmNeeded, draftError, footerParts, isNoop, modelWindows, setDefault, setDefaultProvider, settingsDraft, settingsErrorText,
  settingsMenu, shellHasSettings,
} from '../src/model/sessionSettings.js'
import type { MenuRow } from '../src/model/sessionSettings.js'
import type { ProviderCatalog, PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-10-20T10:00:00Z')

const agent = (over: Partial<AgentView> = {}): AgentView =>
  ({ name: 'w', provider: 'claude', status: 'idle', cwd: '/w', pending: 0, lastActivity: '2026-10-20T09:00:00Z', model: 'opus', effort: 'high', ...over })
const items = (rows: MenuRow[]): MenuRow[] => rows.filter((r) => r.type === 'item')
const label = (r: MenuRow): string => (r.type === 'sep' ? '—' : r.label)

const CATALOG: ProviderCatalog = {
  checkedAt: 'x',
  claude: { provider: 'claude', state: 'ready', detail: '', models: [] },
  codex: { provider: 'codex', state: 'ready', detail: '', models: [
    { id: 'gpt-fast', label: 'GPT Fast', efforts: ['low', 'medium'], defaultEffort: 'low', isDefault: true },
    { id: 'gpt-deep', label: 'GPT Deep', efforts: ['high', 'xhigh'], defaultEffort: 'high', isDefault: false },
  ] },
  zcode: { provider: 'zcode', state: 'ready', detail: '', models: [] },
}

describe('M8f: меню подвала', () => {
  it('Claude: пресеты моделей (текущая отмечена), усилия, режимы; «полный доступ» красный; подсказки «со следующего хода» и про кэш', () => {
    const rows = settingsMenu(agent(), null, new Map())
    const its = items(rows)
    assert.deepEqual(its.filter((r) => r.type === 'item' && r.pick.kind === 'model').map(label), ['haiku', 'sonnet', 'opus', 'fable'])
    assert.deepEqual(its.filter((r) => r.type === 'item' && r.checked).map(label), ['opus', 'high', 'Спрашивать'])
    const full = its.find((r) => r.type === 'item' && r.pick.kind === 'approval' && r.pick.approval === 'full')
    assert.equal(full?.type === 'item' && full.danger, true)
    const notes = rows.filter((r) => r.type === 'note').map(label)
    assert.ok(notes.some((n) => /со следующего хода/i.test(n)))
    assert.ok(notes.some((n) => /кэш промпта у каждой модели свой/.test(n)))
  })
  it('окно модели меньше занятого контекста — «не влезет: 300k > 200k» у пункта и вопрос перед сменой', () => {
    const windows = modelWindows([{ model: 'sonnet', context: { model: 'claude-sonnet-5-5', window: 200_000, at: 'x' } }])
    const a = agent({ context: { used: 300_000, window: 1_000_000, model: 'claude-opus-5-5[1m]', at: 'y' } })
    const sonnet = items(settingsMenu(a, null, windows)).find((r) => r.type === 'item' && r.pick.kind === 'model' && r.pick.model === 'sonnet')!
    assert.equal(label(sonnet), 'sonnet — не влезет: 300k > 200k')
    assert.equal(sonnet.type === 'item' && confirmNeeded(sonnet.pick), 'misfit')
    assert.equal(confirmNeeded({ kind: 'approval', approval: 'full' }), 'full')
    assert.equal(confirmNeeded({ kind: 'effort', effort: 'low' }), null)
  })
  it('Codex: модели из живого списка, усилия ТЕКУЩЕЙ модели; списка нет — строка-подсказка; модель вне списка — тоже в меню', () => {
    const rows = settingsMenu(agent({ provider: 'codex', model: 'gpt-deep', effort: 'high' }), CATALOG, new Map())
    assert.deepEqual(items(rows).filter((r) => r.type === 'item' && r.pick.kind === 'effort').map(label), ['high', 'xhigh'])
    assert.deepEqual(items(rows).filter((r) => r.type === 'item' && r.pick.kind === 'model').map(label), ['GPT Fast', 'GPT Deep'])
    const bare = settingsMenu(agent({ provider: 'codex', model: 'custom-1', effort: 'low' }), null, new Map())
    assert.ok(bare.some((r) => r.type === 'note' && /не загружен/.test(r.label)))
    assert.deepEqual(items(bare).filter((r) => r.type === 'item' && r.pick.kind === 'model').map(label), ['custom-1'])
  })
  it('параметры agent.configure; выбор текущего — ничего не шлём; подпись кнопки', () => {
    assert.deepEqual(configureParams('w', { kind: 'model', model: 'sonnet' }, false), { name: 'w', model: 'sonnet' })
    assert.deepEqual(configureParams('w', { kind: 'approval', approval: 'full' }, true), { name: 'w', approval: 'full', confirm: true })
    assert.equal(isNoop({ kind: 'approval', approval: 'ask' }, agent()), true)
    assert.equal(isNoop({ kind: 'effort', effort: 'low' }, agent()), false)
    assert.deepEqual(footerParts(agent({ approval: 'read-only' })), ['opus', 'high', 'только чтение'])
  })
  it('подвал: кнопка меню только с onConfigure (старая оболочка — просто текст)', () => {
    const props = (on: boolean) => ({
      agent: agent(), items: [], now: NOW, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
      ...(on ? { onConfigure: noop } : {}),
    })
    const withMenu = html(Conversation, props(true))
    assert.match(withMenu, /<button[^>]*class="settings"[^>]*data-testid="conv-settings"[^>]*aria-haspopup="menu"/)
    assert.match(withMenu, /data-testid="conv-model"[^>]*>opus · high</)
    assert.doesNotMatch(html(Conversation, props(false)), /conv-settings/)
  })
  it('старая оболочка и старый демон: меню прячется, отказ — словами', () => {
    assert.equal(shellHasSettings('0.1.14'), false)
    assert.equal(shellHasSettings('0.1.15'), true)
    assert.equal(shellHasSettings(null), true)
    assert.match(settingsErrorText('method_not_allowed', 'x'), /оболочка старше 0\.1\.15/)
  })
})

describe('M8f: строка ленты о смене', () => {
  const ev = (data: Record<string, unknown>): PultEvent => ({ id: 7, ts: '2026-10-20T10:00:00Z', sessionId: 'w', provider: 'claude', kind: 'session.configured', data })
  it('«модель: opus → sonnet · усилие: high → medium · режим: спрашивать → только чтение — со следующего хода»', () => {
    const conv = applyConversation(EMPTY_CONVERSATION, ev({ changes: { model: { from: 'opus', to: 'sonnet' }, effort: { from: 'high', to: 'medium' }, approval: { from: 'ask', to: 'read-only' } }, when: 'next_turn' }))
    const it0 = conv.items[0]
    assert.equal(it0?.type, 'notice')
    assert.equal(it0?.type === 'notice' && it0.title, 'модель: opus → sonnet · усилие: high → medium · режим: спрашивать → только чтение — со следующего хода')
    assert.equal(it0?.type === 'notice' && it0.tone, 'info')
  })
  it('заметка адаптера: ход на прежних настройках / ждёт конца фоновых задач — строкой ленты', () => {
    const conv = applyConversation(EMPTY_CONVERSATION, ev({ changes: {}, notice: 'жду окончания фоновых задач, чтобы включить режим «только чтение»' }))
    const n = conv.items[0]
    assert.ok(n?.type === 'notice' && n.tone === 'wait' && /жду окончания фоновых задач/.test(n.title))
  })
  it('браузер выключен режимом — заметка; ход-итог фона — «когда доделаются фоновые задачи»', () => {
    const conv = applyConversation(EMPTY_CONVERSATION, ev({ changes: { approval: { from: 'ask', to: 'full' }, browser: 'off' }, when: 'after_background' }))
    const n = conv.items[0]
    assert.ok(n?.type === 'notice' && /когда доделаются фоновые задачи/.test(n.title))
    assert.ok(n?.type === 'notice' && /браузер для агента выключен/.test(n.text ?? ''))
  })
})

describe('M8f: «+ Сессия» по слоям', () => {
  const settings = (over: Partial<SettingsReply['newSession']> = {}, last: SettingsReply['lastUsed'] = {}): SettingsReply => ({
    newSession: { rememberLast: true, defaults: { claude: { model: 'opus', effort: 'high', approval: 'read-only' }, codex: { effort: 'xhigh' }, zcode: {} }, ...over },
    lastUsed: last,
  })
  it('нет настроек — как раньше: claude, встроенные модель и усилие, «спрашивать»', () => {
    const f = prefillForm({ cwd: null }, null, [])
    assert.deepEqual([f.provider, f.model, f.effort, f.approval, f.cwd, f.mode], ['claude', 'sonnet', 'medium', 'ask', '', 'turn'])
  })
  it('умолчания поверх встроенных; последний выбор поверх умолчаний; явная папка — главнее', () => {
    const last = { provider: 'claude' as const, claude: { model: 'haiku', approval: 'workspace' as const, mode: 'warm' as const }, cwd: '/p/last' }
    const d = prefillForm({ cwd: null }, settings({ rememberLast: false }, last), ['last'])
    assert.deepEqual([d.model, d.effort, d.approval, d.cwd], ['opus', 'high', 'read-only', ''], 'rememberLast выключен — только умолчания, папки нет')
    const l = prefillForm({ cwd: null }, settings({}, last), ['last'])
    assert.deepEqual([l.model, l.effort, l.approval, l.mode, l.cwd, l.name], ['haiku', 'high', 'workspace', 'warm', '/p/last', 'last-2'])
    assert.equal(startParams(l)['mode'], 'warm')
    const proj = prefillForm({ cwd: '/p/proj' }, settings({}, last), [])
    assert.deepEqual([proj.cwd, proj.name, proj.model], ['/p/proj', 'proj', 'haiku'], 'папка проекта главнее прошлой папки')
  })
  it('full из последнего выбора не подставляется НИКОГДА: умолчание провайдера или «спрашивать»', () => {
    const tampered = { provider: 'claude' as const, claude: { approval: 'full' as never } }
    assert.equal(prefillForm({ cwd: null }, settings({}, tampered), []).approval, 'read-only')
    const noDefault = settings({ defaults: { claude: {}, codex: {}, zcode: {} } }, tampered)
    assert.equal(prefillForm({ cwd: null }, noDefault, []).approval, 'ask')
  })
  it('провайдер: ссылка > последний > умолчание; смена провайдера в форме берёт его слои; браузер в «без вопросов» не ставится', () => {
    const s = settings({ defaults: { provider: 'codex', claude: {}, codex: { approval: 'workspace', browser: true }, zcode: {} } })
    assert.equal(prefillForm({ cwd: null }, s, []).provider, 'codex')
    assert.equal(prefillForm({ cwd: null }, s, []).browser, false, 'Codex workspace — браузер не включается')
    assert.equal(prefillForm({ cwd: null, prefill: { provider: 'claude', path: '/p/x' } }, s, []).provider, 'claude')
    const sw = switchProviderPrefill(prefillForm({ cwd: null }, settings(), []), 'codex', settings())
    assert.deepEqual([sw.provider, sw.effort], ['codex', 'xhigh'])
  })
  it('предлагать ветку worktree — pult/<имя>', () => {
    const f = prefillForm({ cwd: '/p/app' }, settings({ defaults: { claude: { worktree: true }, codex: {}, zcode: {} } }), [])
    assert.equal(f.worktree, 'pult/app')
  })
})

describe('M8f: «Настройки» (⌘,)', () => {
  it('⌘, (и Ctrl+, вне macOS; в русской раскладке — по коду клавиши)', () => {
    const k = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    assert.deepEqual(hotkeyAction({ ...k, key: 'б', code: 'Comma' }, true), { type: 'settings' })
    assert.deepEqual(hotkeyAction({ ...k, metaKey: false, ctrlKey: true, key: ',', code: 'Comma' }, false), { type: 'settings' })
  })
  it('черновик: снять поле, провайдер по умолчанию, ошибка как у демона', () => {
    let d = settingsDraft(null)
    assert.equal(draftError(d), null)
    d = setDefault(d, 'codex', 'approval', 'workspace')
    d = setDefault(d, 'codex', 'browser', true)
    assert.match(draftError(d) ?? '', /браузер/)
    d = setDefault(d, 'codex', 'browser', undefined)
    d = setDefaultProvider(d, 'codex')
    d = setDefault(d, 'claude', 'model', 'opus')
    d = setDefault(d, 'claude', 'model', '')
    assert.equal(draftError(d), null)
    assert.deepEqual(d, { rememberLast: true, defaults: { provider: 'codex', claude: {}, codex: { approval: 'workspace' }, zcode: {} } })
  })
  it('экран: раздел «Новая сессия» с обоими провайдерами и переключателем, «Внешний вид» — пустой, с одной строкой', () => {
    const out = html(SettingsDialog, { settings: { rememberLast: false, defaults: { claude: { model: 'opus' }, codex: {} } }, catalog: CATALOG, onSave: async () => null, onClose: noop })
    const t = text(out)
    assert.match(out, /data-testid="settings-new-session"/)
    assert.match(out, /data-testid="settings-claude"/)
    assert.match(out, /data-testid="settings-codex"/)
    assert.match(out, /data-testid="settings-remember-last"/)
    assert.doesNotMatch(out, /data-testid="settings-remember-last" checked/)
    assert.match(t, /Подставлять последний выбор/)
    assert.match(t, /Внешний вид Темы и цвета — после редизайна\./)
    assert.doesNotMatch(out, /<option value="full"/, '«Полный доступ» умолчанием не ставится')
    assert.match(out, /<option value="gpt-deep">GPT Deep<\/option>/)
  })
})
