// Код в чате идёт сверху вниз строками, а длинная строка переносится внутри колонки, а не уезжает под
// горизонтальную прокрутку: блоки ``` у модели и человека, вход инструмента в раскрытии, строки диффа.
// Разметка — react-dom/server, раскладка — правилами styles.css (переносы меряет глаз по снимку).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { Markdown } from '../src/components/Markdown.js'
import type { ConvItem } from '../src/model/conversation.js'
import { toolInputText } from '../src/model/conversation.js'
import { parseMarkdown } from '../src/model/markdown.js'

const noop = (): void => {}
const css = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8')
/** Тело правила ровно этого селектора (первое вхождение). */
const rule = (sel: string): string => {
  const at = css.indexOf(`\n${sel} {`)
  assert.ok(at >= 0, `нет правила ${sel}`)
  return css.slice(at, css.indexOf('}', at))
}
const md = (text: string, human = false): string => renderToStaticMarkup(createElement(Markdown, { text, ...(human ? { human } : {}) }))
const LONG = 'cd ~/w/pult && npm ci --no-audit --no-fund && npm run typecheck && npm test -- --test-reporter=spec --test-name-pattern="markdown"'
const FN = 'function f(a: number): number {\n  if (a > 0) {\n    return a\n  }\n\treturn -a\n}'

describe('код в чате — строками сверху вниз', () => {
  it('блок ``` у модели и у человека: каждая строка и отступ (пробелы и таб) на месте', () => {
    for (const human of [false, true]) {
      const out = md(`смотри:\n\n\`\`\`ts\n${FN}\n\`\`\``, human)
      assert.ok(out.includes(`<pre><code>${FN.replace(/>/g, '&gt;')}</code></pre>`), `human=${human}`)
    }
  })

  it('«Копировать» берёт текст блока дословно: строки, отступы и длинная строка без переносов', () => {
    const b = parseMarkdown(`\`\`\`bash\n${LONG}\n  второй\n\`\`\``)
    assert.deepEqual(b, [{ t: 'code', lang: 'bash', v: `${LONG}\n  второй` }])
  })

  it('стили: блок кода переносит длинные строки, а не листается вбок; пробелы и \\n сохраняются', () => {
    const pre = rule('.md pre')
    assert.match(pre, /white-space: pre-wrap/)
    assert.match(pre, /overflow-wrap: anywhere/)
    assert.doesNotMatch(css, /\.md[^{,]*\bpre[^{]*\{[^}]*white-space: (pre|nowrap);/)
  })

  it('стили: строка диффа переносится и в ленте, и в Inbox; номер и знак — в своих колонках', () => {
    assert.match(rule('.dl'), /grid-template-columns: 34px 14px minmax\(0, 1fr\)/)
    assert.match(rule('.dl .tx'), /white-space: pre-wrap; overflow-wrap: anywhere/)
  })
})

describe('вход инструмента в раскрытии — настоящими строками', () => {
  it('многострочная строка — блоком `ключ: |` с отступом, а не одной строкой с \\n', () => {
    const text = toolInputText({ command: "cat <<'EOF'\nline 1\n  line 2\nEOF", description: 'Пишет файл', timeout: 120000 })
    assert.equal(text, "command: |\n  cat <<'EOF'\n  line 1\n    line 2\n  EOF\ndescription: \"Пишет файл\"\ntimeout: 120000")
    assert.doesNotMatch(text, /\\n/)
  })

  it('однострочное — JSON в строке, вложенное — JSON с отступом; пустой вход — {}', () => {
    assert.equal(toolInputText({ command: 'ls -la', run: true }), 'command: "ls -la"\nrun: true')
    assert.equal(toolInputText({ edits: [{ a: 1 }] }), 'edits:\n  [\n    {\n      "a": 1\n    }\n  ]')
    assert.equal(toolInputText({}), '{}')
  })

  it('лента: раскрытый Bash показывает многострочную команду строками', () => {
    const command = 'set -e\nnpm ci\nnpm test'
    const items: ConvItem[] = [{ type: 'tool', id: 1, key: 't', ts: '', toolUseId: 't', name: 'Bash', input: { command }, state: 'error', exitCode: 1, result: 'упало' }]
    // Строка с провалом раскрыта сразу — раскрытие видно и в статической разметке.
    const out = renderToStaticMarkup(createElement(Conversation, {
      agent: { name: 'w', provider: 'claude', status: 'idle', cwd: '/w', pending: 0, lastActivity: '2026-11-02T10:00:00Z' },
      items, now: 0, usage: undefined, focusedPerm: null, permBusy: new Set<string>(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
    }))
    assert.ok(out.includes('<div class="k">вход</div><pre>command: |\n  set -e\n  npm ci\n  npm test</pre>'), out)
  })
})
