// Компоненты окна, отрисованные в строку (react-dom/server): подписи и разметка, которые видит
// человек. Без DOM и без Electron — то, что можно проверить текстом, проверяется здесь; раскладку
// (переносы, ширины) меряет e2e по снимкам (shell/test/e2e/screens.test.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectTree } from '../src/components/ProjectTree.js'
import { SessionTabs } from '../src/components/SessionTabs.js'
import { groupByProject } from '../src/model/projects.js'
import { Conversation } from '../src/components/Conversation.js'
import { Header } from '../src/components/Header.js'
import { clickActs, followLink, Markdown } from '../src/components/Markdown.js'
import { DoctorPanel } from '../src/components/Panels.js'
import { PermCard } from '../src/components/PermCard.js'
import { connView } from '../src/lib/conn.js'
import { plural } from '../src/lib/ru.js'
import type { AgentView } from '../src/model/agents.js'
import { doctorGroups } from '../src/model/health.js'
import type { DoctorReport } from '../src/model/types.js'

// Пропсы собраны вручную и нарочно шире типов: тест проверяет разметку, а не сигнатуры.
const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NOW = Date.parse('2026-09-28T10:00:00Z')

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  name: 'fix-limits', provider: 'claude', status: 'idle', cwd: '/w/pult', pending: 0,
  lastActivity: '2026-09-28T09:59:50Z', ...over,
})

const convProps = (a: AgentView, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: a, items: [], now: NOW, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
  onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop, ...over,
})

const placeholder = (s: string): string => /placeholder="([^"]*)"/.exec(s)?.[1] ?? ''

describe('разговор: строка ввода говорит, что делать', () => {
  it('агент ждёт решения по запросу — не «делает ход, жми Стоп»', () => {
    for (const status of ['blocked_permission', 'blocked_question'] as const) {
      const out = html(Conversation, convProps(agent({ status, pending: 1 })))
      assert.match(placeholder(out), /ждёт твоего/, status)
      assert.doesNotMatch(placeholder(out), /делает ход/, status)
    }
    assert.match(placeholder(html(Conversation, convProps(agent({ status: 'working' })))), /делает ход/)
  })

  it('демон недоступен — ввод заблокирован и объясняет почему', () => {
    const out = html(Conversation, convProps(agent(), { link: 'down' }))
    assert.match(placeholder(out), /демон недоступен/)
    assert.match(out, /data-testid="send"[^>]*disabled=""|disabled=""[^>]*data-testid="send"/)
  })

  it('подключение к демону — ввод заблокирован, но не зовёт к кнопке, которой нет', () => {
    // В 'connecting' баннера с «Запустить демона» нет (connView → banner:null): подсказка
    // «запусти его кнопкой сверху» сразу после нажатия этой кнопки врала бы.
    assert.equal(connView({ state: 'connecting', attempt: 1 }).banner, null)
    const out = html(Conversation, convProps(agent(), { link: 'connecting' }))
    assert.match(placeholder(out), /подключаюсь к демону/)
    assert.doesNotMatch(placeholder(out), /кнопкой сверху/)
    assert.match(out, /data-testid="send"[^>]*disabled=""|disabled=""[^>]*data-testid="send"/)
  })
})

describe('название агента', () => {
  it('лента собирается из истории — «Загружаю историю…», а не «Разговор пуст»; строка из лёгкой истории рисуется как обычная', () => {
    const loading = html(Conversation, convProps(agent(), { historyLoading: true }))
    assert.match(loading, /Загружаю историю/)
    assert.doesNotMatch(loading, /Разговор пуст/)
    const tool = { key: 'e1', id: 1, ts: '2026-10-14T10:00:00.000Z', type: 'tool', toolUseId: 'u', name: 'Bash', input: { command: 'ls' }, state: 'ok', endId: 2, elided: true }
    const out = html(Conversation, convProps(agent(), { items: [tool], historyLoading: false }))
    assert.match(out, /data-testid="tool-row"/)
    assert.match(out, /ls/)
    const more = html(Conversation, convProps(agent(), { items: [tool], earlier: { more: true, loading: false } }))
    assert.match(more, /data-testid="load-earlier"[^>]*>Показать раньше/)
    assert.doesNotMatch(html(Conversation, convProps(agent(), { items: [tool], earlier: { more: false, loading: false } })), /load-earlier/)
  })

  it('без названия в шапке имя и кнопка «переименовать»; имя второй раз не пишется', () => {
    const out = html(Conversation, convProps(agent()))
    assert.match(out, /<h2[^>]*data-testid="conv-title"[^>]*>fix-limits<\/h2>/)
    assert.match(out, /data-testid="rename-agent"/)
    assert.doesNotMatch(out, /data-testid="conv-name"/)
    assert.equal(placeholder(out), 'реплика для fix-limits')
  })

  it('с названием: оно в шапке, в списке и в поле ввода; имя для CLI остаётся видно рядом', () => {
    const a = agent({ title: 'Починить лимиты' })
    const out = html(Conversation, convProps(a))
    assert.match(out, /<h2[^>]*>Починить лимиты<\/h2>/)
    assert.match(out, /data-testid="conv-name"[^>]*>fix-limits</)
    assert.equal(placeholder(out), 'реплика для Починить лимиты')
    const list = html(ProjectTree, tree([a]))
    assert.match(list, /class="ag-name"[^>]*>Починить лимиты</)
    // Выбор и горячие клавиши по-прежнему ходят по имени.
    assert.match(list, /data-agent="fix-limits"/)
  })

  it('названия не уникальны: в карточке Inbox имя сессии остаётся в подсказке', () => {
    const card = (agentProp: Record<string, string>): string => html(PermCard, {
      permId: 'p1', toolName: 'Bash', input: { command: 'ls' }, state: 'pending', agent: agentProp,
      createdAt: '2026-09-28T09:59:50Z', now: NOW, onFocus: noop, onApprove: noop, onDeny: noop,
    })
    assert.match(card({ name: 'Починить VPN', provider: 'claude', key: 'me-2' }), /class="who" title="Починить VPN · имя для CLI: me-2">Починить VPN</)
    assert.match(card({ name: 'me-2', provider: 'claude', key: 'me-2' }), /class="who" title="me-2">me-2</)
  })
})

/** Пропсы дерева: сессии раскладываются по проектам так же, как в окне. */
const tree = (agents: AgentView[], projects: string[] = []) => ({
  groups: groupByProject(projects, agents), selected: null, now: NOW, collapsed: new Set<string>(),
  onSelect: noop, onNew: noop, onToggle: noop, onAddProject: noop, onPin: noop,
})

describe('дерево проектов: сколько запросов ждёт — словами, в чипе', () => {
  it('проект доступен в управлении, беседы — в одном списке с подписью проекта', () => {
    const out = html(ProjectTree, tree([agent({ cwd: '/srv/w/app' }), agent({ name: 'sub', cwd: '/srv/w/app/pkg' })], ['/srv/w/app']))
    assert.match(out, /data-project="\/srv\/w\/app" data-pinned="1"/)
    assert.match(out, /class="proj-name">app</)
    assert.match(out, /data-testid="project-new-session"/)
    assert.match(out, /data-testid="project-menu"/)
    assert.doesNotMatch(out, /project-unpin|project-pin/, 'закрепить/убрать — в меню «⋯», а не значками на строке')
    assert.match(out, /data-testid="row-menu"/)
    assert.equal((out.match(/class="chat-project"/g) ?? []).length, 2, 'проект — подпись обеих бесед')
    assert.equal((out.match(/data-testid="agent-row"/g) ?? []).length, 2, 'управление проектами не дублирует беседы')
    assert.match(out, /data-testid="chats-recent"/)
    assert.match(out, /data-testid="project-manager"/)
    assert.match(out, /data-testid="chat-filter"/)
  })

  it('«Ждёт ответа · 2» вместо загадочного «2?»', () => {
    const out = text(html(ProjectTree, tree([agent({ pending: 2 })])))
    assert.match(out, /Ждёт ответа · 2/)
    assert.doesNotMatch(out, /2\?/)
  })
})

describe('подвал разговора: о сессии — под полем ввода', () => {
  it('папка, ветка, модель · усилие, имя для CLI и «?» — в подвале; в шапке их нет; строки подсказок клавиш нет', () => {
    const out = html(Conversation, convProps(agent({ title: 'Починить лимиты', branch: 'feat/x', model: 'opus', effort: 'high' }), { onHelp: noop }))
    const footer = /<div class="chat-status"[^>]*>.*$/s.exec(out)?.[0] ?? ''
    for (const id of ['conv-path', 'conv-branch', 'conv-model', 'conv-name', 'hotkeys-open']) assert.match(footer, new RegExp(`data-testid="${id}"`), id)
    assert.match(text(footer), /opus · high/)
    const head = /<header class="conv-head">.*?<\/header>/s.exec(out)?.[0] ?? ''
    assert.doesNotMatch(head, /conv-path|conv-branch|conv-model|conv-name/)
    assert.doesNotMatch(out, /Enter — отправить/, 'подсказки клавиш — в справке')
  })
})

describe('вопрос Claude в Inbox — карточка с выбором, а не разрешение', () => {
  it('AskUserQuestion: варианты переключателями, поле «свой ответ», «Отправить ответ» вместо «Разрешить»', () => {
    const out = html(PermCard, {
      permId: 'p1', toolName: 'AskUserQuestion', state: 'pending', createdAt: '2026-09-28T09:59:50Z', now: NOW,
      input: { questions: [{ question: 'Какой цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Красный', description: '' }, { label: 'Синий', description: 'спокойный' }] }] },
      agent: { name: 'w', provider: 'claude', key: 'w' }, onFocus: noop, onApprove: noop, onDeny: noop, onAnswer: noop,
    })
    assert.match(out, /data-question="1"/)
    assert.equal((out.match(/type="radio"/g) ?? []).length, 2)
    assert.match(out, /placeholder="Свой ответ"/)
    assert.match(out, /Отправить ответ/)
    assert.doesNotMatch(out, />Разрешить</)
    assert.match(out, /Вопрос Claude/)
  })
})

describe('шапка', () => {
  const base = {
    status: null, statusAt: 0, now: NOW,
    guard: { tone: 'ok', label: 'выход FI', checkedAt: '2026-09-28T09:58:00Z', detail: 'выход FI, страж RU' },
    usage: { claude: { fiveHour: { utilization: 0.42, resetsAt: NOW / 1000 + 3600 }, sevenDay: { utilization: 0.23, resetsAt: null }, status: 'allowed', resetsAt: null, updatedAt: '', eventId: 1 } },
    doctorTone: 'ok', inboxCount: 0, inboxOpen: false, onDoctor: noop, onInbox: noop,
  }

  it('демон недоступен — страж и лимиты помечены устаревшими, а не «живым зелёным»', () => {
    const down = html(Header, { ...base, conn: { state: 'down', reason: 'x', attempt: 1, retryInMs: 1000 } })
    assert.match(down, /class="hdr hdr-stale"/)
    assert.match(down, /data-testid="hdr-guard"[^>]*title="[^"]*не обновляется/)
    const up = html(Header, { ...base, conn: { state: 'up', daemon: { version: '0.1.0', pid: 1, startedAt: 'x' } } })
    assert.doesNotMatch(up, /hdr-stale/)
  })

  it('технические статусы доступны по требованию в компактной шапке', () => {
    const up = html(Header, { ...base, conn: { state: 'up', daemon: { version: '0.1.0', pid: 1, startedAt: 'x' } },
      providers: { checkedAt: 'x', claude: { provider: 'claude', state: 'ready', detail: 'Вход выполнен · готов', models: [] },
        codex: { provider: 'codex', state: 'login_required', detail: 'Нужен вход', fixCmd: 'codex login', models: [] } } })
    assert.match(up, /<details class="health-menu" data-testid="health-menu"><summary/)
    assert.doesNotMatch(up, /<details[^>]* open/)
    assert.match(up, /Подключено/)
    assert.match(up, /<div class="cell-top"><span class="lbl who-claude">claude<\/span><button[^>]*class="pstat t-ok"[^>]*>.*?готов<\/button><\/div>/)
    assert.match(up, /class="pstat t-wait"[^>]*title="Нужен вход — починить: codex login/)
    assert.doesNotMatch(up, /Вход выполнен · готов<\/button>/)
  })

  it('подсказка лимита говорит «использовано», а не голые проценты', () => {
    const up = html(Header, { ...base, conn: { state: 'up', daemon: { version: '0.1.0', pid: 1, startedAt: 'x' } } })
    const title = /data-testid="hdr-usage-claude"[^>]*title="([^"]*)"/.exec(up)?.[1] ?? ''
    assert.match(title, /использовано 42%/)
    assert.match(title, /сброс через 1 ч/)
  })
})

describe('doctor', () => {
  const report: DoctorReport = {
    ok: false, generatedAt: '2026-09-28T10:00:00Z', home: '/h', counts: { ok: 11, warn: 2, fail: 3 },
    items: [
      { id: 'cli.claude', title: 'CLI claude', status: 'fail', detail: 'не найден', fix: 'установи claude и убедись, что он лежит в PATH логин-шелла' },
      { id: 'login.codex', title: 'Вход codex', status: 'fail', detail: 'код выхода 1', fix: 'codex login', fixCmd: 'codex login' },
      { id: 'cli.codex', title: 'CLI codex', status: 'warn', detail: 'внутри ChatGPT.app', fix: 'симлинк повис — перенаправь: ln -sf /a /b', fixCmd: 'ln -sf /a /b' },
    ],
  }
  const panel = (): string => html(DoctorPanel, { report, groups: doctorGroups(report), loading: false, error: null, copied: null, onRerun: noop, onCopy: noop, onClose: noop })

  it('кнопка «копировать» — только у команды; совет словами — обычным текстом', () => {
    const out = panel()
    assert.equal((out.match(/data-testid="doctor-copy"/g) ?? []).length, 2)
    assert.doesNotMatch(out, /<code>установи claude/)
    assert.match(out, /<p class="doc-fix-text">установи claude/)
    assert.match(out, /<code>codex login<\/code>/)
    assert.match(out, /<code>ln -sf \/a \/b<\/code>/)
    assert.match(out, /<p class="doc-fix-text">симлинк повис/)
  })

  it('заголовок по-русски, числа в чипах согласованы', () => {
    const out = text(panel())
    assert.match(out, /^Проверка окружения/)
    assert.match(out, /11 ок/)
    assert.match(out, /2 предупреждения/)
    assert.match(out, /3 сбоя/)
  })

  it('plural: 1 сбой, 3 сбоя, 5 сбоев, 11 сбоев, 21 сбой, 104 сбоя', () => {
    const f = (n: number): string => `${n} ${plural(n, 'сбой', 'сбоя', 'сбоев')}`
    assert.deepEqual([1, 3, 5, 11, 12, 21, 104].map(f), ['1 сбой', '3 сбоя', '5 сбоев', '11 сбоев', '12 сбоев', '21 сбой', '104 сбоя'])
  })
})

describe('карточка разрешения: варианты провайдера', () => {
  const card = (options: string[]): string => text(html(PermCard, {
    permId: 'p1-x', toolName: 'commandExecution', input: { command: 'npm test', availableDecisions: options }, state: 'pending',
    createdAt: '2026-09-28T09:59:59Z', now: NOW,
  }))

  it('обычная пара «да/нет» строки не заводит — кнопки и так «Разрешить/Отказать»', () => {
    assert.doesNotMatch(card(['accept', 'cancel']), /варианты|accept|cancel/)
    assert.doesNotMatch(card(['accept', 'decline', 'cancel']), /варианты|accept/)
  })

  it('«на сессию» строкой не дублируется: с M8d его покрывает кнопка «В этой сессии» (если провайдер предложил)', () => {
    const out = card(['accept', 'acceptForSession', 'decline'])
    assert.doesNotMatch(out, /варианты провайдера/)
    assert.doesNotMatch(out, /acceptForSession/)
  })
})

describe('плашка «демон недоступен»', () => {
  it('одна ровная строка: техническая причина уходит в подсказку, текст не прыгает между попытками', () => {
    const a = connView({ state: 'down', reason: 'соединение с демоном закрыто', attempt: 1, retryInMs: 1000 })
    const b = connView({ state: 'down', reason: 'сокет не отвечает', attempt: 2, retryInMs: 1000 })
    assert.equal(a.banner, b.banner)
    assert.equal(a.banner, 'Переподключаюсь через 1 с.')
    assert.equal(b.reason, 'сокет не отвечает')
    assert.equal(a.reasonVisible, false)
    // Токен не подошёл — чинит человек, причину показываем прямо.
    assert.equal(connView({ state: 'down', reason: 'токен демона не подошёл', attempt: 1, retryInMs: 1000 }).reasonVisible, true)
  })
})

describe('контекстное окно сессии', () => {
  const ctx = (used: number, window: number | null) => ({ used, window, model: 'claude-haiku-4-5', at: '2026-09-28T09:59:00Z' })

  it('в полосе под полем ввода: подпись с долей, полоска по доле и подсказка с точными числами', () => {
    const out = html(Conversation, convProps(agent({ context: ctx(48_213, 200_000) })))
    const meter = /<div class="ctx-meter"[^>]*data-testid="conv-context"[^>]*>(.*?)<\/div><\/div>/.exec(out)
    assert.ok(meter, out)
    assert.equal(text(meter[1]!), 'контекст 48k / 200k · 24%')
    assert.match(meter[0], /data-tone="ok"/)
    assert.match(meter[0], /class="bar t-ok"><i style="width:24%"/)
    assert.match(meter[0], /title="Контекстное окно: 48 213 из 200 000 токенов \(24%\) · claude-haiku-4-5"/)
    // Тон: 70–90% — янтарь, дальше — красный.
    assert.match(html(Conversation, convProps(agent({ context: ctx(160_000, 200_000) }))), /data-tone="wait"/)
    assert.match(html(Conversation, convProps(agent({ context: ctx(190_000, 200_000) }))), /data-tone="fail"/)
  })

  it('полоса под чатом: контекст сессии и лимиты провайдера со сбросом; шапка без индикатора', () => {
    const usage = { status: 'allowed', resetsAt: null, fiveHour: { utilization: 0.12, resetsAt: NOW / 1000 + 3600 }, sevenDay: { utilization: 0.75, resetsAt: NOW / 1000 + 3 * 86_400 } }
    const out = html(Conversation, convProps(agent({ context: ctx(48_213, 200_000) }), { usage }))
    const strip = /<div class="chat-status"[^>]*>(.*)<\/div><\/section>/s.exec(out)?.[0] ?? ''
    assert.match(strip, /data-testid="conv-context"/, 'контекст — в полосе')
    assert.match(text(strip), /5ч 12% · \d\d:\d\d/)
    assert.match(text(strip), /7дн 75% · через 3 дн/)
    const head = /<header class="conv-head">.*?<\/header>/s.exec(out)?.[0] ?? ''
    assert.doesNotMatch(head, /conv-context/, 'в шапке индикатора больше нет')
  })

  it('замеров ещё не было — индикатора нет вовсе; окно не известно — без доли', () => {
    assert.doesNotMatch(html(Conversation, convProps(agent())), /conv-context/)
    const out = html(Conversation, convProps(agent({ context: ctx(23_392, null) })))
    assert.match(text(out), /контекст 23k(?! \/)/)
    assert.match(out, /data-tone="queued"/)
  })

  it('строка списка: контекст виден от 80%; старая модель вкладок сохраняет подсказку', () => {
    const calm = html(ProjectTree, tree([agent({ context: ctx(48_000, 200_000) })]))
    assert.doesNotMatch(calm, /row-context/, 'строка не шумит, пока окно свободно')
    const full = html(ProjectTree, tree([agent({ context: ctx(170_000, 200_000) })]))
    assert.match(full, /<span class="ctx t-wait"[^>]*data-testid="row-context"[^>]*>ctx 85%<\/span>/)
    const tabs = html(SessionTabs, { tabs: [agent({ context: ctx(48_000, 200_000) })], active: 'fix-limits', onSelect: noop, onClose: noop })
    assert.match(tabs, /title="fix-limits · [^"]*1 · контекст 24%"/)
    const bare = html(SessionTabs, { tabs: [agent()], active: 'fix-limits', onSelect: noop, onClose: noop })
    assert.doesNotMatch(bare, /контекст/)
  })
})

describe('контраст приглушённого текста (WCAG ≥ 4.5:1 для 10–12 px)', () => {
  const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
  const tokens = (block: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
    return out
  }
  const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')))
  const dark = tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing')))
  type RGB = [number, number, number]
  const hex = (h: string): RGB => { const v = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB }
  const rgba = (s: string): [RGB, number] => { const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(s)!; return [[+m[1]!, +m[2]!, +m[3]!], +m[4]!] }
  const over = (top: [RGB, number], under: RGB): RGB => top[0].map((c, i) => c * top[1] + under[i]! * (1 - top[1])) as RGB
  const lum = (c: RGB): number => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }) as RGB
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: RGB, b: RGB): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05) }

  for (const [name, t] of [['светлая', light], ['тёмная', dark]] as const) {
    it(`${name} тема: --faint на панели, фоне, утопленном блоке и янтарной строке «ждёт тебя»`, () => {
      const faint = hex(t['faint']!)
      const panel = hex(t['panel']!)
      const bgs: Array<[string, RGB]> = [
        ['panel', panel], ['ground', hex(t['ground']!)], ['sunk', hex(t['sunk']!)], ['sidebar', hex(t['sidebar']!)],
        ['selected', hex(t['selected']!)], ['wait-row', over(rgba(t['wait-soft']!), hex(t['sidebar']!))],
      ]
      for (const [bg, c] of bgs) {
        const r = ratio(faint, c)
        assert.ok(r >= 4.5, `${name}: --faint ${t['faint']} на ${bg} = ${r.toFixed(2)}:1`)
      }
    })
    it(`${name} тема: состояния и провайдеры читаются на строках sidebar`, () => {
      const bgs = [hex(t['sidebar']!), hex(t['selected']!), over(rgba(t['wait-soft']!), hex(t['sidebar']!))]
      for (const token of ['wait', 'amber', 'teal', 'accent', 'oc', 'fail']) for (const bg of bgs) {
        const r = ratio(hex(t[token]!), bg)
        assert.ok(r >= 4.5, `${name}: --${token} = ${r.toFixed(2)}:1`)
      }
    })
  }
})

describe('реплика модели: Markdown', () => {
  const md = (text: string, streaming = false): string => html(Markdown, { text, streaming })

  it('таблица — настоящая <table> в листаемой обёртке, выравнивание классом', () => {
    const out = md('| Имя | Число |\n|:--|--:|\n| **x** | 1 |')
    assert.match(out, /<div class="md-table"><table><thead><tr><th class="al-left"><span>Имя<\/span><\/th><th class="al-right"><span>Число<\/span><\/th><\/tr><\/thead>/)
    assert.match(out, /<tbody><tr><td class="al-left"><strong><span>x<\/span><\/strong><\/td><td class="al-right"><span>1<\/span><\/td><\/tr><\/tbody>/)
    // Ни одного style="…": CSP окна (style-src 'self') режет встроенные стили.
    assert.doesNotMatch(out, /style=/)
  })

  it('ссылка — <a> только для http(s) и mailto; адрес целиком в подсказке', () => {
    const out = md('[дока](https://a.io/x) и <mailto:me@example.com> и [зло](javascript:alert(1)) и [файл](src/main.ts)')
    assert.match(out, /<a href="https:\/\/a.io\/x" class="md-a" title="https:\/\/a.io\/x" rel="noreferrer"><span>дока<\/span><\/a>/)
    assert.match(out, /<a href="mailto:me@example.com"/)
    assert.equal((out.match(/<a /g) ?? []).length, 2)
    assert.doesNotMatch(out, /href="(javascript|src)/)
    assert.match(out, /<span class="md-link-off" title="javascript:alert\(1\)">/)
    assert.match(out, /<span class="md-link-off" title="src\/main.ts">/)
  })

  it('блок кода: шапка с языком и кнопкой «Копировать»', () => {
    const out = md('```ts\nconst a = 1\n```')
    assert.match(out, /<div class="md-code-head"><span class="lang">ts<\/span><button type="button" class="md-copy" data-testid="md-copy">Копировать<\/button><\/div>/)
    assert.match(out, /<pre><code>const a = 1<\/code><\/pre>/)
    assert.match(md('```\nx\n```'), /<span class="lang">код<\/span>/)
  })

  it('`код` в строке копируется кликом: подсказка и класс', () => {
    assert.match(md('запусти `npm test`'), /<code class="md-icode" title="Нажми — скопировать">npm test<\/code>/)
  })

  it('клик действует, только когда текст не выделяют', () => {
    assert.equal(clickActs('', 1), true)
    assert.equal(clickActs('npm', 1), false)
    assert.equal(clickActs('', 2), false)
  })

  it('ссылка: мост умеет openExternal — открывает; старая оболочка или отказ — копирует адрес', async () => {
    const log: string[] = []
    const copyText = async (t: string): Promise<void> => { log.push(`copy ${t}`) }
    assert.equal(await followLink({ copyText, openExternal: async (u) => { log.push(`open ${u}`) } }, 'https://a.io/', 'https://a.io'), 'opened')
    assert.equal(await followLink({ copyText }, 'https://a.io/', 'https://a.io'), 'copied')
    assert.equal(await followLink({ copyText, openExternal: async () => { throw new Error('нет браузера') } }, 'https://a.io/', 'https://a.io'), 'copied')
    assert.equal(await followLink({ copyText: async () => { throw new Error('x') } }, 'https://a.io/', 'https://a.io'), 'failed')
    assert.deepEqual(log, ['open https://a.io/', 'copy https://a.io', 'copy https://a.io'])
  })

  it('вложенные списки, задачи, черта, заголовки h4–h6, номер начала', () => {
    const out = md('3. три\n   - вложенный\n\n- [x] готово\n- [ ] нет\n\n---\n\n#### Четыре')
    assert.match(out, /<ol start="3"><li><span>три<\/span><ul><li><span>вложенный<\/span><\/li><\/ul><\/li><\/ol>/)
    assert.match(out, /<li class="md-task-li"><span class="md-task on" role="img" aria-label="сделано"><\/span><span>готово<\/span><\/li>/)
    assert.match(out, /aria-label="не сделано"/)
    assert.match(out, /<hr\/>/)
    assert.match(out, /<h4><span>Четыре<\/span><\/h4>/)
  })

  it('идут дельты: недописанная таблица и ссылка не роняют, курсор на месте', () => {
    for (const t of ['| a | b |\n|--', '| a | b |\n|---|---|\n| 1', 'см. [доку](https://a.', '```ts\nconst', '- [ ', '1. раз\n   - ']) {
      assert.match(md(t, true), /class="caret"/, t)
    }
    // Курсор — внутри последнего абзаца, а не строкой под ним.
    assert.match(md('пишу', true), /<p><span>пишу<\/span><span class="caret" aria-label="печатает"><\/span><\/p>/)
  })

  it('лента рисует реплику модели через Markdown', () => {
    const items = [{ type: 'model', key: 'm1', id: 1, ts: '2026-09-28T09:59:00Z', text: '| a |\n|---|\n| [x](https://a.io) |', streaming: false }]
    const out = html(Conversation, convProps(agent(), { items }))
    assert.match(out, /data-testid="msg-model"[\s\S]*<table>[\s\S]*<a href="https:\/\/a.io\/"/)
  })

  it('стили: таблица листается, текст реплики выделяется, ссылки и шапка кода оформлены', () => {
    const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
    assert.match(css, /\.md-table \{[^}]*overflow-x: auto/)
    for (const sel of ['.md a.md-a', '.md hr', '.md-code-head', '.md-task', '.md-flash']) assert.ok(css.includes(sel), sel)
    // Выделять мышью можно всё, кроме подписи и кнопки в шапке блока кода и значка задачи.
    const noSelect = [...css.matchAll(/([^{}]+)\{[^}]*user-select: none/g)].map((m) => m[1]!.trim())
    const bad = noSelect.filter((sel) => /\.md(?![-\w])|\.md-(?!code-head|task)|\.it-model|\.feed/.test(sel))
    assert.deepEqual(bad, [])
  })
})
