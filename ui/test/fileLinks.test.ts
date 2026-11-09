import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { followFile, Markdown } from '../src/components/Markdown.js'
import { parseInline } from '../src/model/markdown.js'
import { fileCitation, visualizeReference } from '../src/model/fileReferences.js'
import { relativeDocument } from '../src/model/filePreviewContext.js'
import { referencesFile } from '../../src/core/fileReferences.js'
import { hotkeyAction } from '../src/model/hotkeys.js'

it('выходной codex-file-citation становится ссылкой на PDF с кириллицей и пробелами', () => {
  const out = renderToStaticMarkup(createElement(Markdown, {
    text: ':codex-file-citation{path="/Users/user/Downloads/Резюме — LLM Engineer.pdf" purpose="output"}',
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

it('локальные относительные ссылки получают папку файла; URI и якорь не становятся файловыми путями', () => {
  assert.equal(relativeDocument('/tmp/project/docs', '../README.md'), '/tmp/project/docs/../README.md')
  assert.equal(relativeDocument('/tmp/project', 'src/main.ts'), '/tmp/project/src/main.ts')
  for (const source of ['https://example.com', 'javascript:alert(1)', '//example.com/x', '#section', 'обычный текст']) assert.equal(relativeDocument('/tmp/project', source), null)
  assert.deepEqual(hotkeyAction({ key: 'з', code: 'KeyP', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true), { type: 'openFiles' })
})

it('Codex visualize renders the referenced HTML as an openable file', () => {
  const text = '\ue200visualize\ue202{"path":"/tmp/ios-roadmap.html"}\ue201';
  const out = renderToStaticMarkup(createElement(Markdown, { text }));
  assert.match(out, /data-testid="file-link"/);
  assert.doesNotMatch(out, /visualize|[\ue200-\ue202]/);
});


it('visualize validates paths and preserves incomplete markers and code', () => {
  for (const payload of [{ path: 'https://example.com/x' }, { path: '//server/x' },
    { path: '/tmp/a\u0000.html' }, { path: 42 }, null]) {
    const text = '\ue200visualize\ue202' + JSON.stringify(payload) + '\ue201'
    assert.equal(visualizeReference(text), null)
    assert.equal(parseInline(text).some((p) => p.t === 'file'), false)
  }
  const text = '\ue200visualize\ue202{"path":"/tmp/План команды.html"}\ue201'
  assert.equal(parseInline('`' + text + '`')[0]?.t, 'code')
  assert.equal(parseInline(text.slice(0, -1)).some((p) => p.t === 'file'), false)
  assert.equal(referencesFile([{ kind: 'message.done', data: { text } }], '/tmp/План команды.html'), true)
  assert.equal(referencesFile([{ kind: 'tool.finished', data: { text } }], '/tmp/План команды.html'), false)
  assert.equal(parseInline(text + ' и ' + text).filter((p) => p.t === 'file').length, 2)
})
