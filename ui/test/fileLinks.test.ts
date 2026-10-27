import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { followFile, Markdown } from '../src/components/Markdown.js'
import { parseInline } from '../src/model/markdown.js'
import { fileCitation } from '../src/model/fileReferences.js'

it('выходной codex-file-citation становится ссылкой на PDF с кириллицей и пробелами', () => {
  const out = renderToStaticMarkup(createElement(Markdown, {
    text: ':codex-file-citation{path="/Users/tester/Downloads/Резюме — LLM Engineer.pdf" purpose="output"}',
  }))
  assert.match(out, /data-testid="file-link"/)
  assert.match(out, /Резюме — LLM Engineer.pdf/)
  assert.doesNotMatch(out, /codex-file-citation|purpose=/)
})

it('порядок атрибутов, несколько файлов и кавычка в имени сохраняются', () => {
  const citation = ':codex-file-citation{purpose="output" path="/tmp/a\\\"b.pdf"}'
  assert.deepEqual(fileCitation(citation), { path: '/tmp/a"b.pdf', length: citation.length })
  const out = parseInline('Готово: :codex-file-citation{path="/tmp/a.pdf" purpose="output"} и :codex-file-citation{path="/tmp/b.txt" purpose="output"}.')
  assert.equal(out.filter((p) => p.t === 'file').length, 2)
})

it('старое окно без openFile показывает файл в Finder, минимальный мост копирует путь', async () => {
  const calls: string[] = []
  const bridge = { copyText: async (p: string) => { calls.push(`copy ${p}`) }, revealPath: async (p: string) => { calls.push(`reveal ${p}`) } }
  assert.equal(await followFile(bridge, '/tmp/a.pdf'), 'revealed')
  assert.deepEqual(calls, ['reveal /tmp/a.pdf'])
  assert.equal(await followFile({ copyText: bridge.copyText }, '/tmp/a.pdf'), 'copied')
  assert.deepEqual(calls, ['reveal /tmp/a.pdf', 'copy /tmp/a.pdf'])
})

it('код, недописанная ссылка, URI и управляющие символы не становятся файловыми действиями', () => {
  const code = parseInline('`:codex-file-citation{path="/tmp/a.pdf" purpose="output"}`')
  assert.equal(code[0]?.t, 'code')
  for (const text of [':codex-file-citation{path="/tmp/a.pdf"', ':codex-file-citation{path="https://example.com/a.pdf"}',
    ':codex-file-citation{path="//server/share/a.pdf"}', ':codex-file-citation{path="/tmp/a\\u0000.pdf"}',
    ':codex-file-citation{path="/tmp/a.pdf" path="/tmp/b.pdf"}']) {
    assert.equal(parseInline(text).some((p) => p.t === 'file'), false, text)
  }
})

it('обычная абсолютная Markdown-ссылка на документ тоже становится файловой', () => {
  const out = renderToStaticMarkup(createElement(Markdown, { text: '[Отчёт](/tmp/report.pdf)' }))
  assert.match(out, /data-testid="file-link"/)
  assert.match(out, /Отчёт/)
})
