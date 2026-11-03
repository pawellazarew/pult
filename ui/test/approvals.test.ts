// M8d в окне: кнопки «В этой сессии» / «Всегда …» в карточке разрешения (только предложенные провайдером,
// ⌘↵ — один раз), ширина решения в истории, «Как подтверждать действия» в «+ Сессия» и в подвале,
// «Убрать из списка» для любого проекта.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { DraftView } from '../src/components/Draft.js'
import { PermCard } from '../src/components/PermCard.js'
import type { AgentView } from '../src/model/agents.js'
import { buildAgents } from '../src/model/agents.js'
import { applyConversation, EMPTY_CONVERSATION, netBlockedText } from '../src/model/conversation.js'
import type { PermItem } from '../src/model/conversation.js'
import { composerCmdEnter, hotkeyAction } from '../src/model/hotkeys.js'
import { applyInbox, composerApproves, EMPTY_INBOX, focusedRequest, reconcileInbox } from '../src/model/inbox.js'
import { approvalBlocksBrowser, approvalHint, cwdCoversHome } from '../src/model/newAgent.js'
import { draftStartParams, pickApproval, pickModel, toggleBrowser } from '../src/model/draft.js'
import { draft, draftProps, env } from './draftFixture.js'
import { byHuman, parseOffers, scopeButtons, scopeText } from '../src/model/permissions.js'
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
  it('Inbox: номер события приносит события, сверка с perm.list — нет («в ленту» без прыжка)', () => {
    const s = applyInbox(EMPTY_INBOX, ev(7, 'permission.requested', { id: 'p1', toolName: 'Bash', input: {} }))
    assert.equal(s['p1']?.eventId, 7)
    const r = reconcileInbox(EMPTY_INBOX, [{ id: 'p2', sessionId: 'c', toolName: 'fileChange', input: {}, createdAt: '2026-10-19T09:59:00Z', waitingMs: 1 }])
    assert.equal(r['p2']?.eventId, undefined)
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
  it('меню доступа черновика: подсказка своя у каждого провайдера; «Полный доступ» — красный и «спрошу один раз»', () => {
    const access = (d = draft(), inheritMode = 'default'): string => html(DraftView, draftProps({ draft: d, env: env({ inheritMode }), initialMenu: 'access' }))
    const ask = access(pickApproval(draft(), 'ask', null))
    assert.match(ask, /data-testid="draft-access-item"[^>]*aria-checked="true"[^>]*data-value="ask"|aria-checked="true"[^>]*data-testid="draft-access-item" data-value="ask"/)
    // Шаг A: тексты сверены с кодом (ревью Codex № 6, 7): «Спрашивать» у Claude — явный manual, правила владельца в силе.
    assert.match(text(ask), /правки и команды — вопрос в Inbox; что разрешено твоими правилами Claude — без вопроса/)
    assert.match(text(ask), /правки запрещены; любая команда — вопрос в Inbox/)
    const codex = pickModel(draft(), 'codex', null, env(), null)
    const cw = text(access(codex))
    assert.match(cw, /шаг за песочницу — отказ без вопроса/)
    assert.doesNotMatch(cw, /MCP-серверы тоже без вопросов/, '«MCP тоже без вопросов» — неправда (ревью Codex № 6)')
    // «Как в настройках Claude» — только у Claude, с действующим режимом словами; при bypass — красный пункт.
    assert.match(ask, /data-value="inherit"/)
    assert.doesNotMatch(access(codex), /data-value="inherit"/)
    assert.match(text(access(draft(), 'auto')), /действует твой defaultMode: сейчас auto/)
    assert.match(access(draft(), 'bypassPermissions'), /class="dmi danger"[^>]*data-testid="draft-access-item" data-value="inherit"/)
    assert.match(ask, /class="dmi danger"[^>]*data-testid="draft-access-item" data-value="full"/)
    assert.match(text(ask), /спрошу один раз/, 'без согласия — один вопрос при первом выборе')
    assert.match(text(access(codex)), /danger-full-access/)
    assert.notEqual(approvalHint('claude', 'workspace'), approvalHint('codex', 'workspace'))
  })
  it('черновик: доступ шлётся явно; full — с confirm; браузер в «без вопросов» гаснет, а не уходит в демон', () => {
    const f = draft('/x')
    assert.equal(f.approval, 'workspace', 'новая папка — «Правки в папке» (решение Павла)')
    assert.equal(draftStartParams(pickApproval(f, 'ask', null), { prompt: '', inheritMode: null })['approval'], 'ask')
    assert.equal('confirm' in draftStartParams(f, { prompt: '', inheritMode: null }), false)
    assert.equal(draftStartParams(pickApproval(f, 'full', 1), { prompt: '', consentRev: 1, inheritMode: null })['confirm'], true)
    const w = pickApproval(f, 'workspace', null)
    assert.equal(pickModel(w, 'codex', null, env(), null).approval, 'workspace', 'смена провайдера явный режим не сбрасывает')
    const b = toggleBrowser(pickApproval(f, 'ask', null), true)
    assert.equal(pickApproval(b, 'full', 1).browser, false)
    assert.deepEqual(pickApproval(b, 'full', 1).notes, ['browser-off'])
    assert.equal(toggleBrowser(pickModel(w, 'codex', null, env(), null), true).browser, false, 'Codex «Правки в папке» — браузер не включается')
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
    const [auto] = buildAgents([rec({ approval: 'inherit', claudeMode: 'auto' }) as never], {})
    assert.match(html(Conversation, props(auto!)), />как в настройках claude: auto</)
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

  it('папка — дом или выше: в черновике отказ до отправки; с worktree — можно', () => {
    for (const p of ['/', '/Users', '/Users/you', '/Users/you/', '/home', '/home/user']) assert.equal(cwdCoversHome(p), true, p)
    for (const p of ['/Users/you/proj', '/home/user/w/x', '/tmp', '/opt/pult']) assert.equal(cwdCoversHome(p), false, p)
    // Шаг B: в черновике вместо предупреждения — настоящий отказ демона до отправки (`agent.preflight`, §4).
    const home = html(DraftView, draftProps({ draft: draft('/Users/you'), env: env({ folder: { cwd: '/Users/you', ok: false, refusal: 'covers_pult_home', home: '/Users/you/.pult' } }) }))
    assert.match(home, /data-testid="draft-folder-home"/)
    assert.match(text(home), /Здесь нельзя: внутри лежит ~\/\.pult — возьми папку проекта/)
    assert.match(home, /data-testid="draft-send"[^>]*disabled=""/)
    const wt = html(DraftView, draftProps({ draft: draft('/Users/you', { worktree: true }), env: env({ folder: { cwd: '/Users/you', ok: false, refusal: 'covers_pult_home' } }) }))
    assert.doesNotMatch(wt, /draft-folder-home/, 'с worktree разрешено, как в коде')
  })

  it('сеть: `no_proxy` — своими словами и что делать', () => {
    const t = netBlockedText({ reason: 'no_proxy' })
    assert.match(t.title, /режим required, а прокси не задан/)
    assert.match(t.text, /укажи network\.<провайдер>\.proxy или mode "off" в config\.json/)
  })
})

describe('кто ответил (0.3.7)', () => {
  it('byHuman: human и <клиент>#<соединение> (в том числе unknown#N) — без подписи; служебные — с подписью', () => {
    for (const by of ['human', 'shell#3', 'cli#17', 'unknown#5', 'mcp-ask#2']) assert.equal(byHuman(by), true, by)
    for (const by of ['timeout', 'rm', 'stop', 'shutdown', 'provider_gone', 'Shell#3', 'shell#', '#3', 'shell#3 x']) assert.equal(byHuman(by), false, by)
  })
})
