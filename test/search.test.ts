// О2 «Поиск, метки, экспорт» (docs/14): поиск по разговорам (`events.search`, src/core/search.ts) и
// экспорт сессии в Markdown (`agent.export`, src/core/exportMd.ts, `pult agent export`).
// Всё — во временном PULT_HOME, без настоящих CLI: события пишет хранилище или `events.emit` тестового демона.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { connectClient } from '../dist/cli/client.js'
import type { Client } from '../dist/cli/client.js'
import type { PultEvent } from '../dist/core/events.js'
import { EXPORT_KINDS, exportFileName, exportSession, sessionMarkdown, slimEvent } from '../dist/core/exportMd.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { HEAD_BYTES, matchSnippet, queryRegExp, readSessionAsync, scanLines, searchableText, searchEvents, SNIPPET_CHARS, wantKinds } from '../dist/core/search.js'
import type { SearchResult } from '../dist/core/search.js'
import { createStore } from '../dist/core/store.js'
import { FAKE_CLAUDE, startTestDaemon, tempHome } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

const snip = (text: string, q: string): { snippet: string; match: [number, number] } | null => matchSnippet(text, queryRegExp(q))

describe('поиск: совпадение и отрывок', () => {
  it('без регистра, кириллица тоже; пробелы запроса — любые пробелы текста', () => {
    const r = snip('Почини ТЕСТЫ\n\nв  модуле оплаты', 'тесты в модуле')
    assert.ok(r)
    assert.equal(r.snippet, 'Почини ТЕСТЫ в модуле оплаты')
    assert.equal(r.snippet.slice(...r.match), 'ТЕСТЫ в модуле')
    assert.ok(snip('Ёлка и ЁЖ', 'ёж'))
    assert.ok(snip('ABC', 'abc'))
    assert.equal(snip('Почини тесты', 'тесты оплаты'), null)
  })

  it('спецсимволы запроса — буквально, не регулярка', () => {
    assert.ok(snip('вызов foo(a.b)*2', 'foo(a.b)*'))
    assert.equal(snip('fooXaYb', 'a.b'), null)
  })

  it('отрывок не длиннее 200 знаков, многоточие на обрезанном краю, совпадение внутри', () => {
    const text = `${'начало '.repeat(100)}ИГОЛКА${' хвост'.repeat(100)}`
    const r = snip(text, 'иголка')
    assert.ok(r)
    assert.ok(r.snippet.length <= SNIPPET_CHARS, String(r.snippet.length))
    assert.ok(r.snippet.startsWith('…') && r.snippet.endsWith('…'), r.snippet)
    assert.equal(r.snippet.slice(...r.match), 'ИГОЛКА')
    // Совпадение в самом начале — слева многоточия нет.
    const head = snip(`иголка${' хвост'.repeat(100)}`, 'ИГОЛКА')
    assert.ok(head && !head.snippet.startsWith('…') && head.match[0] === 0)
    // Короткий текст — целиком.
    assert.deepEqual(snip('найди меня', 'меня'), { snippet: 'найди меня', match: [6, 10] })
  })

  it('суррогатная пара на краю отрывка не режется', () => {
    const text = `${'😀'.repeat(150)}игла${'😀'.repeat(150)}`
    const r = snip(text, 'игла')
    assert.ok(r)
    assert.ok(r.snippet.length <= SNIPPET_CHARS)
    assert.doesNotMatch(r.snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('что ищется: реплики, итоги модели, вызов инструмента (имя + команда, путь, шаблон); вывод — нет', () => {
    assert.equal(searchableText({ kind: 'message.user', data: { text: 'привет' } }), 'привет')
    assert.equal(searchableText({ kind: 'message.done', data: { text: '' } }), null)
    assert.equal(searchableText({ kind: 'tool.called', data: { name: 'Bash', input: { command: 'npm test', description: 'тесты' } } }), 'Bash: npm test · тесты')
    assert.equal(searchableText({ kind: 'tool.called', data: { name: 'commandExecution', input: { command: ['git', 'status'] } } }), 'commandExecution: git status')
    assert.equal(searchableText({ kind: 'tool.called', data: { name: 'Grep', input: { pattern: 'TODO', path: 'src' } } }), 'Grep: src · TODO')
    assert.equal(searchableText({ kind: 'tool.finished', data: { content: 'всё' } }), null)
    assert.equal(searchableText({ kind: 'message.delta', data: { text: 'всё' } }), null)
  })
})

/** Хранилище во временном доме: события пишутся так же, как пишет демон. */
function storeHome(): { paths: PultPaths; append(sessionId: string, kind: PultEvent['kind'], data?: Record<string, unknown>): PultEvent; done(): void; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ps-'))
  const paths = layout(dir)
  ensureLayout(paths)
  const store = createStore(paths)
  return {
    paths,
    append: (sessionId, kind, data = {}) => store.append({ sessionId, provider: 'claude', kind, data }),
    done: () => store.close(),
    remove: () => { try { store.close() } catch { /* уже */ } rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('поиск по файлам сессий', () => {
  it('новые первыми по всем сессиям; limit и truncated; одна сессия; вывод инструмента не находится', async () => {
    const h = storeHome()
    try {
      const a1 = h.append('a', 'message.user', { text: 'Почини оплату' })
      h.append('a', 'tool.finished', { toolUseId: 't0', content: 'оплата оплата оплата' })
      const b1 = h.append('b', 'message.done', { text: 'Оплату починил' })
      const a2 = h.append('a', 'tool.called', { toolUseId: 't1', name: 'Bash', input: { command: 'grep -r оплат src' } })
      h.append('a', 'message.delta', { text: 'оплата' })
      h.done()
      const all = await searchEvents({ eventsDir: h.paths.events, query: 'ОПЛАТ', sessionIds: ['a', 'b'] })
      assert.deepEqual(all.results.map((r) => r.eventId), [a2.id, b1.id, a1.id])
      assert.deepEqual(all.results.map((r) => r.kind), ['tool.called', 'message.done', 'message.user'])
      assert.equal(all.results[0]?.snippet, 'Bash: grep -r оплат src')
      assert.equal(all.results[0]?.sessionId, 'a')
      assert.equal(all.truncated, false)
      const one = await searchEvents({ eventsDir: h.paths.events, query: 'оплат', sessionIds: ['b'] })
      assert.deepEqual(one.results.map((r) => r.eventId), [b1.id])
      const lim = await searchEvents({ eventsDir: h.paths.events, query: 'оплат', sessionIds: ['a', 'b'], limit: 2 })
      assert.deepEqual(lim.results.map((r) => r.eventId), [a2.id, b1.id])
      assert.equal(lim.truncated, true)
      assert.equal((await searchEvents({ eventsDir: h.paths.events, query: 'оплат', sessionIds: ['нет-такой'] })).results.length, 0)
    } finally {
      h.remove()
    }
  })

  it('граница удаления: имя заняли заново — прежней сессии в поиске нет', async () => {
    const h = storeHome()
    try {
      h.append('w', 'message.user', { text: 'старая иголка' })
      h.append('w', 'session.ended', { reason: 'rm' })
      const fresh = h.append('w', 'message.user', { text: 'новая иголка' })
      h.append('w', 'session.ended', { reason: 'cold' })
      h.done()
      const r = await searchEvents({ eventsDir: h.paths.events, query: 'иголка', sessionIds: ['w'] })
      assert.deepEqual(r.results.map((x) => x.eventId), [fresh.id])
    } finally {
      h.remove()
    }
  })

  it('совпадений тысячи — в памяти и в ответе только limit самых новых', async () => {
    const h = storeHome()
    try {
      let last = 0
      for (let i = 0; i < 1500; i++) last = h.append('a', 'message.done', { text: `иголка ${i}` }).id
      h.done()
      const r = await searchEvents({ eventsDir: h.paths.events, query: 'иголка', sessionIds: ['a'], limit: 500 })
      assert.equal(r.results.length, 200, 'limit не больше 200')
      assert.equal(r.results[0]?.eventId, last)
      assert.equal(r.results[0]?.snippet, 'иголка 1499')
      assert.equal(r.truncated, true)
    } finally {
      h.remove()
    }
  })
})

describe('строки длиннее куска чтения', () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
  const ts = '2026-10-14T10:00:00.000Z'

  it('ненужная строка в мегабайты пропускается по голове, не копится; нужные вокруг неё находятся', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const huge = 'вывод '.repeat(600_000) // ≈ 6,6 МБ одной строкой
      writeFileSync(join(dir, 'w.jsonl'),
        line({ id: 1, ts, sessionId: 'w', provider: 'claude', kind: 'message.user', data: { text: 'до иголки' } })
        + line({ id: 2, ts, sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 't', content: `${huge} иголка` } })
        + line({ id: 3, ts, sessionId: 'w', provider: 'claude', kind: 'message.done', data: { text: 'после иголки' } }))
      let delivered = 0
      let longest = 0
      await scanLines(join(dir, 'w.jsonl'), (_b, start, end) => { delivered++; longest = Math.max(longest, end - start) }, { head: wantKinds(new Set(['message.user', 'message.done'])) })
      assert.equal(delivered, 2, 'строка вывода до колбэка не дошла')
      assert.ok(longest < 1000)
      // Без решения по голове строка доходит целой: склейка кусков не теряет байты.
      let whole = 0
      await scanLines(join(dir, 'w.jsonl'), (_b, start, end) => { whole = Math.max(whole, end - start) })
      assert.equal(whole, Buffer.byteLength(line({ id: 2, ts, sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 't', content: `${huge} иголка` } })) - 1)
      const r = await searchEvents({ eventsDir: dir, query: 'иголк', sessionIds: ['w'] })
      assert.deepEqual(r.results.map((x) => x.eventId), [3, 1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('вид дальше головы (длинный parentId): до 4 КБ — по голове, дальше — разбором строки; ответ несёт parentId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const mid = 'p'.repeat(1000)
      const far = 'q'.repeat(HEAD_BYTES + 100)
      writeFileSync(join(dir, 'w.jsonl'),
        line({ id: 1, ts, sessionId: 'w', parentId: mid, provider: 'claude', kind: 'message.done', data: { text: 'иголка раз' } })
        + line({ id: 2, ts, sessionId: 'w', parentId: far, provider: 'claude', kind: 'message.done', data: { text: 'иголка два' } })
        + line({ id: 3, ts, sessionId: 'w', parentId: far, provider: 'claude', kind: 'tool.finished', data: { content: 'иголка в выводе' } }))
      const r = await searchEvents({ eventsDir: dir, query: 'иголка', sessionIds: ['w'] })
      assert.deepEqual(r.results.map((x) => [x.eventId, x.parentId?.length]), [[2, far.length], [1, mid.length]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Синтетический файл сессии ≈ `mb` МБ: выводы инструментов по 8 КБ, ответы модели с иголкой — каждое 20-е событие. */
function writeBigSession(paths: PultPaths, sessionId: string, mb: number): { needles: number; bytes: number } {
  const lines: string[] = []
  let bytes = 0
  let id = 1
  let needles = 0
  const blob = 'вывод инструмента '.repeat(250)
  const ts = '2026-10-14T10:00:00.000Z'
  while (bytes < mb * 1024 * 1024) {
    const ev = id % 20 === 0
      ? { id, ts, sessionId, provider: 'claude', kind: 'message.done', data: { text: `длинный ответ модели ${'слово '.repeat(200)} ИГОЛКА номер ${id}` } }
      : id % 3 === 0
        ? { id, ts, sessionId, provider: 'claude', kind: 'tool.called', data: { toolUseId: `t${id}`, name: 'Bash', input: { command: `ls ${id}` } } }
        : { id, ts, sessionId, provider: 'claude', kind: 'tool.finished', data: { toolUseId: `t${id}`, content: `${blob} иголка в выводе — не ищется` } }
    if (id % 20 === 0) needles++
    const line = JSON.stringify(ev) + '\n'
    lines.push(line)
    bytes += Buffer.byteLength(line)
    id++
  }
  writeFileSync(join(paths.events, `${sessionId}.jsonl`), lines.join(''))
  return { needles, bytes }
}

describe('events.search на демоне', () => {
  it('20 МБ: демон отвечает новым клиентам и daemon.status посреди поиска; ответ мал; второй поиск отменяет первый', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-srch-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const probe = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'big', kind: 'claude', cwd })
      await c.request('agent.start', { name: 'empty', kind: 'claude', cwd })
      const big = writeBigSession(home.paths, 'big', 20)
      assert.ok(big.bytes >= 20 * 1024 * 1024)

      // Демон тестов живёт в ЭТОМ процессе: задержка таймера на 1 мс — задержка его событийного цикла.
      let gap = 0
      let tick = Date.now()
      const timer = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - tick); tick = n }, 1)
      let finished = false
      const t0 = Date.now()
      const search = (c.request('events.search', { query: 'иголка', limit: 50 }) as Promise<SearchResult>).finally(() => { finished = true })
      const lags: number[] = []
      while (!finished) {
        let t = Date.now()
        const fresh = await connectClient(home.paths)
        fresh.close()
        await probe.request('daemon.status')
        lags.push(Date.now() - t)
        t = Date.now()
        await new Promise((r) => setTimeout(r, 5))
      }
      const r = await search
      const took = Date.now() - t0
      clearInterval(timer)
      assert.equal(r.results.length, 50)
      assert.equal(r.truncated, true)
      assert.ok(r.results.every((x) => x.kind === 'message.done' && x.sessionId === 'big'), 'выводы инструментов не ищутся')
      assert.deepEqual(r.results.map((x) => x.eventId), [...r.results.map((x) => x.eventId)].sort((a, b) => b - a), 'новые первыми')
      assert.ok(r.scanned.bytes >= big.bytes)
      const max = Math.max(...lags)
      assert.ok(gap < 100, `цикл стоял ${gap} мс подряд (поиск по ${big.bytes} байт — ${took} мс)`)
      assert.ok(max < 250, `hello + daemon.status посреди поиска ждали до ${max} мс (поиск ${took} мс, проб ${lags.length})`)
      assert.ok(Buffer.byteLength(JSON.stringify(r)) < 64 * 1024)

      // Окно ищет на каждый ввод: новый запрос того же клиента отменяет прежний.
      const first = c.request('events.search', { query: 'иголка' }) as Promise<SearchResult>
      const second = c.request('events.search', { query: 'ИГОЛКА номер' }) as Promise<SearchResult>
      const [r1, r2] = await Promise.all([first, second])
      assert.equal(r1.superseded, true)
      assert.equal(r2.superseded, undefined)
      assert.equal(r2.results.length, 100, 'limit по умолчанию — 100')
    } finally {
      probe.close()
      c.close()
      await d.stop('тест')
      home.remove()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('отказы и границы: пустой и длинный запрос, чужой sessionId, удалённая сессия не ищется', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-srch-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const code = (want: string) => (e: { code?: string }): boolean => e.code === want
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      await c.request('agent.start', { name: 'gone', kind: 'claude', cwd })
      await c.request('events.emit', { kind: 'message.user', sessionId: 'w', provider: 'claude', data: { text: 'Найди Кота' } })
      await c.request('events.emit', { kind: 'message.user', sessionId: 'gone', provider: 'claude', data: { text: 'кот удалённой' } })
      await c.request('agent.rm', { name: 'gone' })
      await assert.rejects(c.request('events.search', { query: '   ' }), code('invalid_params'))
      await assert.rejects(c.request('events.search', {}), code('invalid_params'))
      await assert.rejects(c.request('events.search', { query: 'x'.repeat(201) }), code('invalid_params'))
      await assert.rejects(c.request('events.search', { query: 'кот', sessionId: 5 }), code('invalid_params'))
      const r = (await c.request('events.search', { query: 'КОТ' })) as SearchResult
      assert.deepEqual(r.results.map((x) => [x.sessionId, x.snippet]), [['w', 'Найди Кота']])
      assert.deepEqual(r.results[0]?.match, [6, 9])
      assert.equal(((await c.request('events.search', { query: 'кот', sessionId: 'gone' })) as SearchResult).results.length, 0)
      assert.equal(((await c.request('events.search', { query: 'кот', sessionId: 'w', limit: 0 })) as SearchResult).results.length, 1, 'limit < 1 — один')
    } finally {
      c.close()
      await d.stop('тест')
      home.remove()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

const ev = (id: number, kind: PultEvent['kind'], data: Record<string, unknown>, parentId?: string): PultEvent =>
  ({ id, ts: `2026-10-14T10:00:${String(id).padStart(2, '0')}.000Z`, sessionId: 'w', provider: 'claude', kind, data, ...(parentId ? { parentId } : {}) })

describe('экспорт в Markdown', () => {
  it('шапка, ходы, реплики цитатой, инструменты строкой с исходом, субагент блоком, ошибки и лимиты', () => {
    const md = sessionMarkdown(
      { name: 'w', title: 'Починка оплаты', provider: 'claude', cwd: '/w/pay', model: 'opus', effort: 'high', createdAt: '2026-10-14T09:00:00.000Z',
        worktree: { path: '/h/worktrees/w', branch: 'fix/pay' } },
      [
        ev(1, 'message.user', { text: 'Почини оплату\nи тесты' }),
        ev(2, 'message.delta', { text: 'Смотрю' }),
        ev(3, 'message.done', { text: 'Смотрю **код**.' }),
        ev(4, 'tool.called', { toolUseId: 't1', name: 'Bash', input: { command: 'npm test', description: 'тесты' } }),
        ev(5, 'tool.finished', { toolUseId: 't1', isError: true, exitCode: 1, content: 'FAIL длинный вывод' }),
        ev(6, 'tool.called', { toolUseId: 't2', name: 'Read', input: { file_path: '/w/pay/a`b.ts' } }),
        ev(7, 'agent.spawned', { toolUseId: 'a1', subagentType: 'Explore', description: 'найти тесты' }),
        ev(8, 'tool.called', { toolUseId: 't3', name: 'Grep', input: { pattern: 'pay' } }, 'a1'),
        ev(9, 'message.done', { text: 'Нашёл два файла' }, 'a1'),
        ev(10, 'agent.finished', { toolUseId: 'a1', isError: false }),
        ev(11, 'permission.resolved', { toolName: 'Edit', decision: 'deny' }),
        ev(12, 'status.changed', { status: 'failed', message: 'API Error 500', turnId: 't-1' }),
        ev(13, 'message.user', { text: 'Ещё раз' }),
        ev(14, 'limit.hit', { status: 'rejected', message: 'лимит 5 часов' }),
        ev(15, 'status.changed', { status: 'idle', turnId: 't-2' }),
      ],
      new Date('2026-10-14T12:00:00.000Z'),
    )
    const lines = md.split('\n')
    assert.equal(lines[0], '# Починка оплаты')
    assert.match(md, /^- Сессия: `w`$/m)
    assert.match(md, /^- Провайдер: claude · opus · high$/m)
    assert.match(md, /^- Папка: `\/w\/pay`$/m)
    assert.match(md, /^- Worktree: `\/h\/worktrees\/w`, ветка `fix\/pay`$/m)
    assert.match(md, /^## Ход 1 · /m)
    assert.match(md, /^## Ход 2 · /m)
    assert.match(md, /\*\*Ты:\*\*\n\n> Почини оплату\n> и тесты/)
    assert.match(md, /\*\*claude:\*\*\n\nСмотрю \*\*код\*\*\./)
    assert.match(md, /^- `Bash: npm test · тесты` — код 1, ошибка$/m)
    assert.match(md, /^- `` Read: \/w\/pay\/a`b\.ts ``$/m, 'обратная кавычка — двойной оградой')
    assert.match(md, /^\*\*Субагент `Explore` — найти тесты\*\*$/m)
    assert.match(md, /^> - `Grep: pay`$/m, 'строки субагента — цитатой')
    assert.match(md, /^> Нашёл два файла$/m)
    assert.match(md, /^- разрешение `Edit`: отказано$/m)
    assert.match(md, /^\*\*Ошибка:\*\* API Error 500$/m)
    assert.match(md, /^\*\*Лимит:\*\* лимит 5 часов$/m)
    assert.doesNotMatch(md, /длинный вывод/, 'выводов инструментов нет')
    assert.doesNotMatch(md, /\n{3,}/)
    assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'))
  })

  it('пустая сессия и имя файла', () => {
    const md = sessionMarkdown({ name: 'w', provider: 'codex', cwd: '/w' }, [], new Date())
    assert.match(md, /^# w$/m)
    assert.match(md, /_Разговор пуст\._/)
    assert.match(exportFileName('fix-limits', new Date(2026, 9, 14, 9, 5, 3)), /^fix-limits-20261014-090503\.md$/)
  })
})

describe('экспорт не держит выводы инструментов', () => {
  it('сессия с выводами по мегабайтам: в памяти — только исход и строка вызова; Markdown мал', async () => {
    const home = tempHome()
    try {
      const big = 'x'.repeat(3 * 1024 * 1024)
      const ts = '2026-10-14T10:00:00.000Z'
      const lines: string[] = [JSON.stringify({ id: 1, ts, sessionId: 'w', provider: 'claude', kind: 'message.user', data: { text: 'Собери' } })]
      for (let i = 0; i < 4; i++) {
        lines.push(JSON.stringify({ id: 2 + i * 2, ts, sessionId: 'w', provider: 'claude', kind: 'tool.called', data: { toolUseId: `t${i}`, name: 'Write', input: { file_path: `/w/f${i}`, content: big } } }))
        lines.push(JSON.stringify({ id: 3 + i * 2, ts, sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: `t${i}`, isError: i === 1, exitCode: i, content: big } }))
      }
      writeFileSync(join(home.paths.events, 'w.jsonl'), lines.join('\n') + '\n')
      const { events } = await readSessionAsync(home.paths.events, 'w', { kinds: EXPORT_KINDS, map: slimEvent })
      assert.equal(events.length, 9)
      const kept = Math.max(...events.map((e) => JSON.stringify(e).length))
      assert.ok(kept < 2000, `в памяти осталось событие в ${kept} знаков`)
      assert.deepEqual(events.find((e) => e.id === 5)?.data, { toolUseId: 't1', exitCode: 1, isError: true })
      const r = await exportSession(home.paths, { name: 'w', provider: 'claude', cwd: '/w' })
      assert.ok(r.bytes < 4000, `Markdown ${r.bytes} байт`)
      const md = readFileSync(r.path, 'utf8')
      assert.match(md, /^- `Write: \/w\/f1` — код 1, ошибка$/m)
      assert.match(md, /^- `Write: \/w\/f3` — код 3$/m)
    } finally {
      home.remove()
    }
  })
})

describe('agent.export на демоне и pult agent export', () => {
  it('файл 0600 в exports/ (0700) из полного файла сессии после удаления-перезаведения; ответ — путь, не текст', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-exp-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const emit = (kind: string, data: Record<string, unknown>): Promise<unknown> => c.request('events.emit', { kind, sessionId: 'w', provider: 'claude', data })
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      await emit('message.user', { text: 'прежняя сессия' })
      await c.request('agent.rm', { name: 'w' })
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, title: 'Новая' })
      await emit('message.user', { text: 'Сделай отчёт' })
      await emit('message.done', { text: 'x'.repeat(300_000) })
      await emit('tool.called', { toolUseId: 't1', name: 'Bash', input: { command: 'ls' } })
      await emit('tool.finished', { toolUseId: 't1', exitCode: 0, content: 'a b c' })
      const r = (await c.request('agent.export', { name: 'w' })) as { path: string; bytes: number }
      assert.deepEqual(Object.keys(r).sort(), ['bytes', 'path'])
      assert.equal(join(r.path, '..'), join(home.paths.home, 'exports'))
      assert.match(r.path, /\/w-\d{8}-\d{6}\.md$/)
      assert.equal(statSync(r.path).mode & 0o777, 0o600)
      assert.equal(statSync(join(home.paths.home, 'exports')).mode & 0o777, 0o700)
      const md = readFileSync(r.path, 'utf8')
      assert.equal(Buffer.byteLength(md), r.bytes)
      assert.match(md, /^# Новая$/m)
      assert.match(md, /> Сделай отчёт/)
      assert.ok(md.includes('x'.repeat(300_000)), 'итог модели целиком, не из лёгкой истории')
      assert.match(md, /^- `Bash: ls` — код 0$/m)
      assert.doesNotMatch(md, /прежняя сессия/)
      // Второй экспорт в ту же секунду не затирает первый.
      const again = (await c.request('agent.export', { name: 'w' })) as { path: string }
      assert.notEqual(again.path, r.path)
      await assert.rejects(c.request('agent.export', { name: 'нет' }), (e: { code?: string }) => e.code === 'not_found')
    } finally {
      c.close()
      await d.stop('тест')
      home.remove()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('CLI: по умолчанию путь, --stdout — сам Markdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-expc-'))
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: 'ok', PULT_CLAUDE_BIN: FAKE_CLAUDE },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} завис`)) }, 25_000)
      child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }) })
    })
    let c: Client | null = null
    try {
      // Папка сессии — рядом с PULT_HOME, не над ним (`coversPultHome`, src/sessions/manager.ts).
      const work = join(dir, 'work')
      mkdirSync(work)
      assert.equal((await run(['agent', 'start', 'w', '--kind', 'claude', '--cwd', work])).code, 0)
      c = await connectClient(paths)
      await c.request('events.emit', { kind: 'message.user', sessionId: 'w', provider: 'claude', data: { text: 'Привет из CLI' } })
      const p = await run(['agent', 'export', 'w'])
      assert.equal(p.code, 0, p.stderr)
      const path = p.stdout.trim()
      assert.match(path, /exports\/w-\d{8}-\d{6}\.md$/)
      assert.match(readFileSync(path, 'utf8'), /> Привет из CLI/)
      const s = await run(['agent', 'export', 'w', '--stdout'])
      assert.equal(s.code, 0, s.stderr)
      assert.match(s.stdout, /^# w\n/)
      assert.match(s.stdout, /> Привет из CLI/)
      assert.deepEqual(readdirSync(join(paths.home, 'exports')), [basename(path)], '--stdout файла не оставляет')
      const both = await run(['agent', 'export', 'w', '--stdout', '--json'])
      assert.equal(both.code, 1)
      assert.match(both.stderr, /выбери одно/)
      const none = await run(['agent', 'export'])
      assert.equal(none.code, 1)
      assert.match(none.stderr, /нужно имя сессии/)
    } finally {
      c?.close()
      await run(['daemon', 'stop'])
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
