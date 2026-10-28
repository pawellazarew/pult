import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentView } from '../src/model/agents.js'
import { statusView } from '../src/model/agents.js'
import { chatSections, chatStatus, projectChats, projectPreview } from '../src/model/navigation.js'
import { groupByProject } from '../src/model/projects.js'

const a = (name: string, patch: Partial<AgentView> = {}): AgentView => ({
  name, provider: 'claude', status: 'cold', cwd: '/srv/pult', pending: 0,
  lastActivity: '2026-10-27T10:00:00Z', ...patch,
})

describe('единый список бесед', () => {
  it('вопрос важнее working, затем работают и недавние; архив не дублируется', () => {
    const groups = groupByProject(['/srv/pult'], [a('recent'), a('running', { status: 'working' }),
      a('pending', { status: 'working', pending: 1 }), a('question', { status: 'blocked_question' }), a('archived', { archived: true })])
    const sections = chatSections(groups)
    assert.deepEqual(sections.map((s) => [s.key, s.rows.map((r) => r.agent.name)]), [
      ['waiting', ['pending', 'question']], ['working', ['running']], ['recent', ['recent']],
    ])
    assert.equal(sections.flatMap((s) => s.rows).length, 4)
  })

  it('поиск не зависит от регистра, ищет все слова по названию, проекту, провайдеру и ветке', () => {
    const groups = groupByProject(['/srv/pult'], [a('fix', { title: 'Исправить настройки', provider: 'codex', branch: 'feat/settings' }),
      a('other', { title: 'Настройки сети' })])
    assert.deepEqual(chatSections(groups, 'НАСТРОЙКИ codex PULT').flatMap((s) => s.rows.map((r) => r.agent.name)), ['fix'])
    assert.deepEqual(chatSections(groups, 'feat/settings').flatMap((s) => s.rows.map((r) => r.agent.name)), ['fix'])
    assert.equal(chatSections(groups, 'нет такого').flatMap((s) => s.rows).length, 0)
  })

  it('сортирует свежие беседы внутри каждой группы; проект совпадает с выбранным корнем', () => {
    const groups = groupByProject(['/srv'], [a('old'), a('new', { lastActivity: '2026-10-27T11:00:00Z' })])
    const recent = chatSections(groups)[2]!.rows
    assert.deepEqual(recent.map((r) => r.agent.name), ['new', 'old'])
    assert.equal(recent[0]?.project, 'srv')
    assert.equal(recent[0]?.projectPath, '/srv')
  })

  it('работающие идут по созданию, новые сверху; активность и переименование не меняют порядок', () => {
    const older = a('older', { status: 'working', createdAt: '2026-10-27T08:00:00Z', lastActivity: '2026-10-27T12:00:00Z' })
    const newer = a('newer', { status: 'working', createdAt: '2026-10-27T09:00:00Z', lastActivity: '2026-10-27T10:00:00Z' })
    const order = (xs: AgentView[]): string[] => chatSections(groupByProject(['/srv'], xs))[1]!.rows.map((r) => r.agent.name)
    assert.deepEqual(order([older, newer]), ['newer', 'older'])
    assert.deepEqual(order([{ ...older, lastActivity: '2026-10-28T12:00:00Z', title: 'А новое название' }, newer]), ['newer', 'older'])
    const same = { ...newer, createdAt: older.createdAt }
    assert.deepEqual(order([older, same]), order([{ ...older, title: 'Я последнее название' }, same]))
  })

  it('фон после ответа (субагенты, команды): среди «Работают» с «В фоне», поле ввода не заперто; кончился — назад в недавние', () => {
    const bg = { count: 2, tasks: ['субагент /root/checker', 'npm test'] }
    const withBg = a('bg', { provider: 'codex', status: 'idle', background: bg })
    const sections = (x: AgentView): string[] => chatSections(groupByProject(['/srv/pult'], [x, a('quiet')]))
      .flatMap((s) => s.rows.filter((r) => r.agent.name === x.name).map(() => s.key))
    assert.deepEqual(sections(withBg), ['working'])
    assert.deepEqual(chatStatus(withBg), { label: 'В фоне', tone: 'run', detail: 'Фоновые задачи: 2' })
    assert.equal(statusView(withBg.status).busy, false, 'статус idle — ввод открыт')
    const [chats] = projectChats(groupByProject(['/srv/pult'], [withBg, a('quiet')]), '', 'working')
    assert.deepEqual(chats?.rows.map((r) => r.name), ['bg'])
    assert.equal(chats?.working, 1)
    const { background: _gone, ...after } = withBg
    assert.deepEqual(sections(after), ['recent'])
    // Ошибка хода важнее фона: подпись «ошибка» остаётся, фон — значком.
    assert.equal(chatStatus(a('f', { status: 'failed', background: bg })).label, 'ошибка')
    assert.deepEqual(sections(a('f', { status: 'failed', background: bg })), ['working'])
  })

  it('состояние не маскирует ожидание зелёным готово; cold — история, без технического жаргона', () => {
    assert.equal(chatStatus(a('x', { status: 'idle', pending: 1 })).label, 'Ждёт ответа')
    assert.equal(chatStatus(a('x', { status: 'idle', pending: 1 })).tone, 'wait')
    assert.equal(chatStatus(a('x')).label, 'История')
    assert.equal(chatStatus(a('x', { status: 'idle' })).label, 'Готово')
    assert.equal(chatStatus(a('x', { status: 'failed' })).tone, 'fail')
    assert.equal(chatStatus(a('x', { status: 'working' })).label, 'Работает')
  })
})

describe('чаты внутри проектов', () => {
  it('сохраняет порядок проектов и сортирует чаты по созданию, независимо от статуса и активности', () => {
    const older = a('older', { createdAt: '2026-10-27T08:00:00Z' })
    const newer = a('newer', { createdAt: '2026-10-27T09:00:00Z' })
    const groups = groupByProject(['/srv/empty', '/srv/pult'], [older, newer])
    const view = projectChats(groups)
    assert.deepEqual(view.map((p) => p.group.name), ['empty', 'pult'])
    assert.deepEqual(view[1]!.rows.map((r) => r.name), ['newer', 'older'])
    const changed = groupByProject(['/srv/empty', '/srv/pult'], [{ ...older, status: 'working' as const, lastActivity: '2027-01-01' }, newer])
    assert.deepEqual(projectChats(changed)[1]!.rows.map((r) => r.name), ['newer', 'older'])
    assert.equal(projectChats(changed, '', 'working')[0]!.rows[0]?.name, 'older')
  })
  it('ищет по названию проекта и чата, фильтрует ожидание, не возвращает архив', () => {
    const groups = groupByProject(['/srv/pult'], [a('fix', { title: 'Исправить PDF', pending: 1 }), a('gone', { archived: true })])
    assert.equal(projectChats(groups, 'PDF pult')[0]!.rows[0]?.name, 'fix')
    assert.equal(projectChats(groups, '', 'waiting')[0]!.waiting, 1)
    assert.equal(projectChats(groups, '', 'working').length, 0)
    assert.equal(projectChats(groups, 'ничего').length, 0)
  })
  it('краткий список не прячет выбранный, работающий чат и запрос разрешения; порядок остаётся исходным', () => {
    const rows = Array.from({ length: 9 }, (_, i) => a(`s${i}`))
    rows[5]!.status = 'working'; rows[7]!.pending = 1
    assert.deepEqual(projectPreview(rows, 's8', false).map((r) => r.name), ['s0', 's1', 's2', 's3', 's5', 's7', 's8'])
    assert.equal(projectPreview(rows, null, true).length, 9)
  })
})
