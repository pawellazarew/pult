// «/» в поле ввода (docs/19): где набирается команда, отбор и порядок строк, подстановка и разметка списка.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlashMenu, slashErrorText } from '../src/components/SlashMenu.js'
import { applySlash, findSlashToken, matchTier, rankSlash } from '../src/model/slash.js'
import type { SlashItem } from '../src/model/slash.js'

const item = (name: string, over: Partial<SlashItem> = {}): SlashItem => ({
  name, description: '', source: 'skill', provider: 'claude', insert: `/${name} `, ...over,
})
const CATALOG: SlashItem[] = [
  item('brainstorming', { description: 'Structured brainstorming and design exploration' }),
  item('compact', { source: 'builtin', description: 'Free up context by summarizing the conversation' }),
  item('engineering:debug', { source: 'plugin', description: 'Structured debugging session', argumentHint: '<error message>' }),
  item('code-review', { source: 'builtin', description: 'Review the current diff' }),
  item('pult-cmd', { source: 'command', description: 'Test command' }),
  item('debug', { source: 'builtin', description: 'Enable debug logging' }),
]
const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const noop = (): void => {}

describe('«/»: где набирается команда', () => {
  it('в начале поля и после пробела; каретка — конец запроса', () => {
    assert.deepEqual(findSlashToken('/', 1), { start: 0, end: 1, query: '', position: 'start' })
    assert.deepEqual(findSlashToken('/bra', 4), { start: 0, end: 4, query: 'bra', position: 'start' })
    assert.deepEqual(findSlashToken('  /co', 5), { start: 2, end: 5, query: 'co', position: 'start' }, 'пробелы перед / — всё ещё начало')
    assert.deepEqual(findSlashToken('fix this /deb', 13), { start: 9, end: 13, query: 'deb', position: 'inline' })
    assert.deepEqual(findSlashToken('line\n/x', 7), { start: 5, end: 7, query: 'x', position: 'inline' })
  })
  it('не команда: путь, a/b, пробел после имени, выделение, кавычки', () => {
    assert.equal(findSlashToken('/opt/demo', 9), null)
    assert.equal(findSlashToken('a/b', 3), null)
    assert.equal(findSlashToken('/compact ', 9), null)
    assert.equal(findSlashToken('/compact', 1, 4), null)
    assert.equal(findSlashToken('/"x', 3), null)
    assert.equal(findSlashToken('plain text', 10), null)
    assert.equal(findSlashToken('', 0), null)
  })
  it('каретка посреди слова — заменится слово целиком', () => {
    assert.deepEqual(findSlashToken('/brXYZ tail', 3), { start: 0, end: 6, query: 'br', position: 'start' })
  })
})

describe('«/»: отбор и порядок', () => {
  it('пустой запрос — всё в порядке провайдера', () => {
    assert.deepEqual(rankSlash(CATALOG, '').map((x) => x.name), CATALOG.map((x) => x.name))
  })
  it('точное > начало имени > начало части имени > подстрока > описание', () => {
    assert.deepEqual(rankSlash(CATALOG, 'debug').map((x) => x.name), ['debug', 'engineering:debug'])
    assert.deepEqual(rankSlash(CATALOG, 'co').map((x) => x.name), ['compact', 'code-review', 'pult-cmd'], 'pult-cmd — по слову «command» описания, последней')
    assert.deepEqual(rankSlash(CATALOG, 'review').map((x) => x.name), ['code-review'])
    assert.deepEqual(rankSlash(CATALOG, 'summar').map((x) => x.name), ['compact'], 'по слову описания')
    assert.deepEqual(rankSlash(CATALOG, 'BRAIN').map((x) => x.name), ['brainstorming'], 'регистр не важен')
    assert.equal(matchTier(item('engineering:debug'), 'edb'), 4, 'подпоследовательность')
    assert.deepEqual(rankSlash(CATALOG, 'zzzz'), [])
  })
  it('посреди текста — только скиллы (встроенные и команды работают лишь в начале реплики)', () => {
    assert.deepEqual(rankSlash(CATALOG, '', 'inline').map((x) => x.name), ['brainstorming', 'engineering:debug'])
  })
})

describe('«/»: подстановка', () => {
  it('Claude — /name и пробел, каретка за ним', () => {
    const tok = findSlashToken('/bra', 4)!
    assert.deepEqual(applySlash('/bra', tok, '/brainstorming '), { text: '/brainstorming ', caret: 15 })
  })
  it('Codex — $name вместо набранного /', () => {
    const tok = findSlashToken('please /cod', 11)!
    assert.deepEqual(applySlash('please /cod', tok, '$codex-hello '), { text: 'please $codex-hello ', caret: 20 })
  })
  it('за командой уже пробел — второго нет, каретка после пробела', () => {
    const tok = findSlashToken('/co rest', 3)!
    assert.deepEqual(applySlash('/co rest', tok, '/compact '), { text: '/compact rest', caret: 9 })
  })
})

describe('«/»: список', () => {
  it('строки: имя, подсказка аргументов, описание, источник; выделенная — aria-selected', () => {
    const out = html(SlashMenu, { id: 's', items: CATALOG.slice(0, 3), active: 1, loading: false, error: null, query: '', onPick: noop, onHover: noop })
    assert.match(out, /role="listbox"/)
    assert.equal((out.match(/role="option"/g) ?? []).length, 3)
    assert.match(out, /id="s-1" role="option" aria-selected="true"/)
    assert.match(out, /<span class="slash-name">\/engineering:debug<\/span><span class="slash-hint">&lt;error message&gt;<\/span>/)
    assert.match(out, /slash-badge is-builtin">встроенная/)
    assert.match(out, /slash-badge is-skill">скилл/)
    assert.match(out, /slash-badge is-plugin">плагин/)
  })
  it('Codex — имя в списке с $', () => {
    const out = html(SlashMenu, { id: 's', items: [item('codex-hello', { provider: 'codex', insert: '$codex-hello ' })], active: 0, loading: false, error: null, query: 'co', onPick: noop, onHover: noop })
    assert.match(out, /slash-name">\$codex-hello</)
  })
  it('пусто: загрузка, ничего по запросу, ничего в папке, ошибка', () => {
    const base = { id: 's', items: [], active: 0, onPick: noop, onHover: noop }
    assert.match(html(SlashMenu, { ...base, loading: true, error: null, query: '' }), /Загружаю скиллы и команды…/)
    assert.match(html(SlashMenu, { ...base, loading: false, error: null, query: 'zz' }), /Нет команд по «zz»/)
    assert.match(html(SlashMenu, { ...base, loading: false, error: null, query: '' }), /Для этой папки скиллов и команд нет/)
    assert.match(html(SlashMenu, { ...base, loading: false, error: 'страж', query: '' }), /страж/)
    assert.doesNotMatch(html(SlashMenu, { ...base, loading: false, error: null, query: '' }), /listbox/)
  })
  it('старая оболочка или демон — подсказка обновить', () => {
    assert.equal(slashErrorText({ code: 'method_not_allowed', message: 'x' }), 'Список команд появится после обновления Pult')
    assert.equal(slashErrorText({ code: 'not_found', message: 'неизвестный метод agent.commands' }), 'Список команд появится после обновления Pult')
    assert.equal(slashErrorText(new Error('boom')), 'Список команд не загрузился: boom')
  })
})
