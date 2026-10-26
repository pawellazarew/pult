// M8d в окне: кнопки «В этой сессии» / «Всегда …» в карточке разрешения (только предложенные провайдером,
// ⌘↵ — один раз), ширина решения в истории, «Как подтверждать действия» в «+ Сессия» и в подвале,
// «Убрать из списка» для любого проекта.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { ApprovalField } from '../src/components/Panels.js'
import { PermCard } from '../src/components/PermCard.js'
import type { AgentView } from '../src/model/agents.js'
import { buildAgents } from '../src/model/agents.js'
import { applyConversation, EMPTY_CONVERSATION, netBlockedText } from '../src/model/conversation.js'
import type { PermItem } from '../src/model/conversation.js'
import { composerCmdEnter, hotkeyAction } from '../src/model/hotkeys.js'
import { applyInbox, composerApproves, EMPTY_INBOX, focusedRequest, reconcileInbox } from '../src/model/inbox.js'
import { approvalBlocksBrowser, approvalHint, cwdCoversHome, defaultForm, homeWarning, startParams, switchProvider, validateForm } from '../src/model/newAgent.js'
import { parseOffers, scopeButtons, scopeText } from '../src/model/permissions.js'
import { busySessions, groupByProject, projectRemoval } from '../src/model/projects.js'
import type { PultEvent } from '../src/model/types.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-10-19T10:00:00Z')

const RULE = { kind: 'execpolicy' as const, label: "/bin/zsh -lc 'echo hi > x.txt'", note: '(с любыми аргументами дальше) — без песочницы и без вопроса во всех сессиях Codex; правило в ~/.codex/rules/default.rules' }

const card = (over: Record<string, unknown> = {}): string => html(PermCard, {
  permId: 'p1', toolName: 'commandExecution', input: { command: 'echo hi > x.txt', availableDecisions: ['accept', 'acceptForSession', 'cancel'] },
  state: 'pending', createdAt: '2026-10-19T09:59:50Z', now: NOW, focused: true, onFocus: noop, onApprove: noop, onDeny: noop, ...over,
})

describe('M8d: карточка разрешения', () => {
  it('без предложений — как раньше: «Разрешить» (⌘↵) и «Отказать…», никаких «в сессии»/«всегда»', () => {
    const out = card({ input: { command: 'ls' } })
    assert.match(out, /data-testid="perm-approve"/)
    assert.doesNotMatch(out, /perm-approve-session|perm-approve-rule/)
  })
  it('предложены оба: три кнопки «да»; ⌘↵ — только на «Разрешить» (один раз); префикс команды и где живёт правило — видны', () => {
    const out = card({ offers: { session: true, rule: RULE } })
    const t = text(out)
    assert.match(out, /data-testid="perm-approve-session"/)
    assert.match(out, /data-testid="perm-approve-rule"/)
    assert.match(t, /В этой сессии/)
    assert.match(t, /Всегда: команды, начинающиеся с \/bin\/zsh -lc 'echo hi > x\.txt'/)
    // Правда о правиле — строкой под кнопками: префикс, любые аргументы, без песочницы, файл правил Codex.
    assert.match(t, /Всегда: команды, начинающиеся с «\/bin\/zsh -lc 'echo hi > x\.txt'» \(с любыми аргументами дальше\) — без песочницы и без вопроса во всех сессиях Codex; правило в ~\/\.codex\/rules\/default\.rules/)
    // Клавиша ⌘↵ нарисована ровно один раз — внутри кнопки «Разрешить».
    assert.equal((out.match(/class="kbd/g) ?? []).length, 1)
    const approveBtn = /<button[^>]*data-testid="perm-approve"[^>]*>.*?<\/button>/.exec(out)?.[0] ?? ''
    assert.match(approveBtn, /kbd/)
    assert.doesNotMatch(/<button[^>]*data-testid="perm-approve-session"[^>]*>.*?<\/button>/.exec(out)?.[0] ?? '', /kbd/)
    assert.doesNotMatch(/<button[^>]*data-testid="perm-approve-rule"[^>]*>.*?<\/button>/.exec(out)?.[0] ?? '', /kbd/)
    // acceptForSession покрыт кнопкой — строки «варианты провайдера» с ним нет.
    assert.doesNotMatch(t, /варианты провайдера/)
  })
  it('сеть: «Всегда пускать в сеть к <хост>»', () => {
    const t = text(card({ offers: { rule: { kind: 'network', label: 'example.com', note: 'правило сети ляжет в настройки самого Codex' } } }))
    assert.match(t, /Всегда пускать в сеть к example\.com/)
    assert.doesNotMatch(t, /В этой сессии/)
  })
  it('решённая карточка говорит ширину: «в этой сессии», «всегда для …»; один раз — без хвоста', () => {
    assert.match(text(card({ state: 'allow', scope: 'session' })), /Разрешено · в этой сессии/)
    assert.match(text(card({ state: 'allow', scope: 'rule', rule: { kind: 'execpolicy', label: 'git push' } })), /Разрешено · всегда: команды, начинающиеся с «git push»/)
    assert.doesNotMatch(text(card({ state: 'allow' })), /·/)
  })
  it('⌘↵ остаётся «разрешить выделенный» — без ширины: горячая клавиша не несёт scope', () => {
    const ev = { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    assert.deepEqual(hotkeyAction(ev, true), { type: 'approveFocused' })
  })
})

describe('M8d: модель Inbox и ленты', () => {
  const ev = (id: number, kind: string, data: Record<string, unknown>): PultEvent =>
    ({ id, ts: '2026-10-19T09:59:50Z', sessionId: 'c', provider: 'pult', kind, data }) as PultEvent
  it('parseOffers не верит форме: кривое поле — нет и кнопки', () => {
    assert.deepEqual(parseOffers({ session: true, rule: RULE }), { session: true, rule: RULE })
    assert.equal(parseOffers({ session: 'yes', rule: { kind: 'shell', label: 'x' } }), undefined)
    assert.equal(parseOffers({ rule: { kind: 'execpolicy', label: '' } }), undefined)
    assert.equal(parseOffers(null), undefined)
    assert.deepEqual(scopeButtons(undefined), [])
    assert.deepEqual(scopeButtons({ session: true }).map((b) => b.scope), ['session'])
    assert.equal(scopeText('once', undefined), null)
    assert.equal(scopeText('rule', { kind: 'network', label: 'example.com' }), 'всегда — сеть к example.com')
  })
  it('Inbox: предложения из события и из perm.list', () => {
    const s = applyInbox(EMPTY_INBOX, ev(1, 'permission.requested', { id: 'p1', toolName: 'commandExecution', input: {}, offers: { session: true } }))
    assert.deepEqual(s['p1']?.offers, { session: true })
    const r = reconcileInbox(EMPTY_INBOX, [{ id: 'p2', sessionId: 'c', toolName: 'fileChange', input: {}, offers: { session: true }, createdAt: '2026-10-19T09:59:00Z', waitingMs: 1 }])
    assert.deepEqual(r['p2']?.offers, { session: true })
  })
  it('лента: решение помнит ширину и правило', () => {
    let conv = applyConversation(EMPTY_CONVERSATION, ev(1, 'permission.requested', { id: 'p1', toolName: 'commandExecution', input: {}, offers: { rule: RULE } }))
    conv = applyConversation(conv, ev(2, 'permission.resolved', { id: 'p1', decision: 'allow', scope: 'rule', rule: { kind: 'execpolicy', label: RULE.label }, by: 'human' }))
    const it = conv.items.find((x) => x.type === 'perm') as PermItem
    assert.deepEqual([it.state, it.scope, it.rule], ['allow', 'rule', { kind: 'execpolicy', label: RULE.label }])
    // Отказ ширины не несёт, даже если демон старше и прислал её.
    let c2 = applyConversation(EMPTY_CONVERSATION, ev(1, 'permission.requested', { id: 'p1', toolName: 'x', input: {} }))
    c2 = applyConversation(c2, ev(2, 'permission.resolved', { id: 'p1', decision: 'deny', scope: 'session' }))
    assert.equal((c2.items[0] as PermItem).scope, undefined)
  })
})

describe('M8d: «Как подтверждать действия»', () => {
  it('поле: подсказка своя у каждого провайдера; «Полный доступ» — красное предупреждение', () => {
    const ask = html(ApprovalField, { provider: 'claude', approval: 'ask', onChange: noop })
    assert.match(ask, /<option value="ask" selected="">Спрашивать<\/option>/)
    assert.match(text(ask), /по твоим настройкам Claude/)
    assert.match(text(html(ApprovalField, { provider: 'claude', approval: 'read-only', onChange: noop })), /правки запрещены, каждую команду спросит/)
    assert.match(text(html(ApprovalField, { provider: 'codex', approval: 'workspace', onChange: noop })), /твои MCP-серверы тоже без вопросов/)
    assert.doesNotMatch(ask, /new-agent-approval-warning/)
    const full = html(ApprovalField, { provider: 'codex', approval: 'full', onChange: noop })
    assert.match(full, /data-testid="new-agent-approval-warning"/)
    assert.match(text(full), /агент делает что угодно без вопросов, песочницы нет/)
    assert.match(text(full), /danger-full-access/)
    assert.notEqual(approvalHint('claude', 'workspace'), approvalHint('codex', 'workspace'))
  })
  it('форма: по умолчанию ask и поля в agent.start нет; смена провайдера режим не сбрасывает; браузер в «без вопросов» — ошибка формы', () => {
    const f = { ...defaultForm('claude'), name: 'w', cwd: '/x' }
    assert.equal(f.approval, 'ask')
    assert.equal('approval' in startParams(f), false)
    assert.equal(startParams({ ...f, approval: 'read-only' })['approval'], 'read-only')
    assert.equal('confirm' in startParams({ ...f, approval: 'workspace' }), false)
    assert.equal(startParams({ ...f, approval: 'full' })['confirm'], true, 'full — с подтверждением: человек видел предупреждение')
    assert.equal(switchProvider({ ...f, approval: 'workspace' }, 'codex').approval, 'workspace')
    assert.equal(validateForm({ ...f, browser: true, approval: 'full' }, []).approval !== undefined, true)
    assert.equal(validateForm({ ...f, browser: true, approval: 'workspace' }, []).approval, undefined, 'Claude acceptEdits — браузер можно')
    assert.equal(validateForm({ ...f, provider: 'codex', browser: true, approval: 'workspace' }, []).approval !== undefined, true)
    assert.equal(approvalBlocksBrowser('codex', 'read-only'), false)
  })
  it('подвал сессии показывает режим; full — тоном ошибки; запись без поля — «спрашивать»', () => {
    const rec = (over: Record<string, unknown>) => ({ name: 'w', provider: 'claude', cwd: '/w', mode: 'turn', createdAt: '2026-10-19T09:00:00Z', lastStatus: 'idle', lastEventId: 0, pendingPermissions: 0, ...over })
    const [plain] = buildAgents([rec({}) as never], {})
    const [full] = buildAgents([rec({ approval: 'full' }) as never], {})
    assert.equal(plain?.approval, undefined)
    assert.equal(full?.approval, 'full')
    const props = (a: AgentView) => ({
      agent: a, items: [], now: NOW, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    })
    assert.match(html(Conversation, props(plain!)), /data-testid="conv-approval" data-approval="ask"[^>]*>спрашивать</)
    const [auto] = buildAgents([rec({ claudeMode: 'auto' }) as never], {})
    assert.match(html(Conversation, props(auto!)), />спрашивать — у Claude по твоим настройкам: auto</)
    assert.match(html(Conversation, props(full!)), /class="approval t-fail" data-testid="conv-approval" data-approval="full"/)
  })
})

describe('M8d: «Убрать из списка» для любого проекта', () => {
  const ag = (name: string, cwd: string, over: Partial<AgentView> = {}): AgentView =>
    ({ name, provider: 'claude', status: 'idle', cwd, pending: 0, lastActivity: '2026-10-19T09:00:00Z', ...over })
  it('закреплённый без сессий — снять закрепление; с сессиями (и папка сессии) — в архив ровно сессии группы', () => {
    const groups = groupByProject(['/p/empty', '/p/app'], [ag('a', '/p/app'), ag('b', '/p/app/pkg'), ag('c', '/loose'), ag('z', '/p/app', { archived: true })])
    const by = (path: string) => groups.find((g) => g.path === path)!
    assert.deepEqual(projectRemoval(by('/p/empty')), { kind: 'unpin' })
    assert.deepEqual(projectRemoval(by('/p/app')), { kind: 'archive', sessions: ['a', 'b'], busy: [] }, 'архивная z уже не в группе')
    assert.deepEqual(projectRemoval(by('/loose')), { kind: 'archive', sessions: ['c'], busy: [] })
    // Занятые: ход, вопрос, ожидающий запрос, очередь — окно скажет «сначала останови».
    assert.deepEqual(busySessions([ag('w', '/x', { status: 'working' }), ag('q', '/x', { status: 'blocked_question' }), ag('p', '/x', { pending: 1 }),
      ag('u', '/x', { queue: [{ id: '1', text: 't', at: 'x' }] }), ag('i', '/x')]), ['w', 'q', 'p', 'u'])
    assert.equal(projectRemoval({ pinned: false, sessions: [] }), null)
    // После архива группа папки-сессии пропадает, новая сессия в папке возвращает её.
    const after = groupByProject([], [ag('c', '/loose', { archived: true })])
    assert.equal(after.length, 0)
    assert.equal(groupByProject([], [ag('c', '/loose', { archived: true }), ag('n', '/loose')]).length, 1)
  })
})

describe('после #13: «показано не всё» словами карточки, ⌘↵ из поля — только своя сессия, дом как папка', () => {
  const concealed = (over: Record<string, unknown>): string => text(card({ concealed: true, offers: undefined, ...over }))

  it('команда — «исходная команда»; правка — «исходный ввод»; решённая карточка — без строки', () => {
    const cmd = concealed({ toolName: 'Bash', input: { command: 'ssh <email> uptime' } })
    assert.match(cmd, /Показано не всё: фильтр секретов скрыл часть ввода .*Исполнится исходная команда — не уверен, отказывай\./)
    const edit = concealed({ toolName: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: '<token>' } })
    assert.match(edit, /Исполнится исходный ввод/)
    assert.doesNotMatch(edit, /команда/)
    assert.doesNotMatch(card({ concealed: true, state: 'allow', toolName: 'Bash', input: { command: 'ls' } }), /perm-concealed/)
  })

  it('вопрос (AskUserQuestion и requestUserInput) — про вопрос, без слова «команда»', () => {
    const claudeQ = html(PermCard, {
      permId: 'q1', toolName: 'AskUserQuestion', state: 'pending', createdAt: '2026-10-19T09:59:50Z', now: NOW, concealed: true,
      input: { questions: [{ question: 'Писать <email>?', header: 'Адрес', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] }] },
      onFocus: noop, onApprove: noop, onDeny: noop, onAnswer: noop,
    })
    const codexQ = html(PermCard, {
      permId: 'q2', toolName: 'requestUserInput', state: 'pending', createdAt: '2026-10-19T09:59:50Z', now: NOW, concealed: true,
      input: { questions: [{ id: 'k', header: 'Ключ', question: 'Какой <token>?', isOther: true, options: [] }] },
      onFocus: noop, onApprove: noop, onDeny: noop, onAnswer: noop,
    })
    for (const out of [claudeQ, codexQ]) {
      assert.match(out, /data-testid="perm-concealed"/)
      assert.match(text(out), /Показано не всё: фильтр секретов скрыл часть вопроса или вариантов .*Модель видит вопрос целиком — не уверен, о чём он, пропусти\./)
      assert.doesNotMatch(text(out), /команд/)
    }
    // Без флага — строки нет и у вопроса.
    assert.doesNotMatch(html(PermCard, {
      permId: 'q3', toolName: 'AskUserQuestion', state: 'pending', createdAt: '2026-10-19T09:59:50Z', now: NOW,
      input: { questions: [{ question: 'Да?', header: 'Q', multiSelect: false, options: [{ label: 'Да' }] }] }, onFocus: noop, onAnswer: noop, onDeny: noop,
    }), /perm-concealed/)
  })

  it('⌘↵: свой запрос виден только после загрузки ленты; из поля — только запрос текущей сессии', () => {
    const own = { id: 'pa', sessionId: 'a', toolName: 'Bash', input: {}, createdAt: '2' }
    const other = { id: 'pb', sessionId: 'b', toolName: 'Bash', input: {}, createdAt: '1' }
    // Лента сессии a ещё грузится, Inbox закрыт — своей карточки на экране нет: выделять нечего.
    assert.equal(focusedRequest([own], null, 'a', [], false), null)
    assert.equal(focusedRequest([own], null, 'a', [], true)?.id, 'pa')
    // Лента грузится, но тот же запрос показан в открытом Inbox — виден.
    assert.equal(focusedRequest([own], null, 'a', [own], false)?.id, 'pa')
    // Inbox открыт, у a своего нет: вне поля ⌘↵ берёт карточку b, из поля a — нет.
    const f = focusedRequest([other], null, 'a', [other], true)
    assert.equal(f?.id, 'pb')
    assert.equal(composerApproves(f, 'a'), null)
    assert.equal(composerApproves(f, 'b')?.id, 'pb')
    assert.equal(composerApproves(null, 'a'), null)
    assert.equal(composerApproves(f, null), null)
    // Поле a при выделенной карточке b: «прервать и сказать» не подавлено (permFocused — только своё).
    assert.equal(composerCmdEnter({ busy: true, needsYou: false, permFocused: composerApproves(f, 'a') !== null, queueable: true, hasText: true, blocked: false }), 'interrupt')
  })

  it('папка — дом или выше: предупреждение в форме (не отказ); «Только чтение» и worktree — без него', () => {
    for (const p of ['/', '/Users', '/Users/you', '/Users/you/', '/home', '/home/user']) assert.equal(cwdCoversHome(p), true, p)
    for (const p of ['/Users/you/proj', '/home/user/w/x', '/tmp', '/opt/pult']) assert.equal(cwdCoversHome(p), false, p)
    const f = { ...defaultForm('claude'), cwd: '/Users/you', name: 'w' }
    assert.match(homeWarning(f) ?? '', /агент сможет менять ~\/\.claude, ~\/\.codex, ~\/\.zshrc и др\. без вопросов в режимах «Правки в папке без вопросов» и «Полный доступ»/)
    assert.equal(homeWarning({ ...f, approval: 'read-only' }), null)
    assert.equal(homeWarning({ ...f, worktree: 'feat/x' }), null)
    assert.equal(homeWarning({ ...f, cwd: '/Users/you/proj' }), null)
    assert.equal(homeWarning({ ...f, cwd: '' }), null)
    assert.deepEqual(validateForm(f, []), {}, 'предупреждение не мешает завести')
  })

  it('сеть: `no_proxy` — своими словами и что делать', () => {
    const t = netBlockedText({ reason: 'no_proxy' })
    assert.match(t.title, /режим required, а прокси не задан/)
    assert.match(t.text, /укажи network\.<провайдер>\.proxy или mode "off" в config\.json/)
  })
})
