import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentView } from '../src/model/agents.js'
import { chatSections, chatStatus } from '../src/model/navigation.js'
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

  it('состояние не маскирует ожидание зелёным готово; cold — история, без технического жаргона', () => {
    assert.equal(chatStatus(a('x', { status: 'idle', pending: 1 })).label, 'Ждёт ответа')
    assert.equal(chatStatus(a('x', { status: 'idle', pending: 1 })).tone, 'wait')
    assert.equal(chatStatus(a('x')).label, 'История')
    assert.equal(chatStatus(a('x', { status: 'idle' })).label, 'Готово')
    assert.equal(chatStatus(a('x', { status: 'failed' })).tone, 'fail')
    assert.equal(chatStatus(a('x', { status: 'working' })).label, 'Работает')
  })
})
