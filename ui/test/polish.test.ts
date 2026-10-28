import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { Markdown } from '../src/components/Markdown.js'
import { hotkeyAction } from '../src/model/hotkeys.js'
import type { ConvItem } from '../src/model/conversation.js'

const noop = (): void => {}

it('галерея не оставляет пустые ячейки от пробелов; текст с изображением остаётся абзацем', () => {
  const gallery = renderToStaticMarkup(createElement(Markdown, { text: '![A](a.png) ![B](b.png) ![C](c.png)' }))
  assert.match(gallery, /<p class="image-gallery">/)
  assert.doesNotMatch(gallery, /<span>\s*<\/span>/)
  const mixed = renderToStaticMarkup(createElement(Markdown, { text: 'Результат: ![A](a.png)' }))
  assert.doesNotMatch(mixed, /class="image-gallery"/)
  assert.match(mixed, /Результат:/)
})
const render = (items: ConvItem[] = []): string => renderToStaticMarkup(createElement(Conversation, {
  agent: { name: 'w', provider: 'codex', status: 'working', cwd: '/w/project', model: 'test-model', approval: 'full', pending: 0, lastActivity: '2026-10-27T10:00:00Z' },
  items, now: 0, usage: undefined, focusedPerm: null, permBusy: new Set<string>(), sendError: null, sending: false,
  onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop, onConfigure: noop,
}))

it('⌘K/⌘B работают по коду клавиши в русской раскладке и не забирают другие сочетания', () => {
  const key = { key: 'л', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
  assert.deepEqual(hotkeyAction(key, true), { type: 'quickSwitch' })
  assert.deepEqual(hotkeyAction({ ...key, key: 'и', code: 'KeyB' }, true), { type: 'toggleSidebar' })
  assert.equal(hotkeyAction({ ...key, shiftKey: true }, true), null)
  assert.equal(hotkeyAction({ ...key, altKey: true }, true), null)
  assert.equal(hotkeyAction({ ...key, metaKey: false, ctrlKey: true }, true), null)
  assert.deepEqual(hotkeyAction({ ...key, metaKey: false, ctrlKey: true }, false), { type: 'quickSwitch' })
})

it('ошибка видна кратко, а большой JSON остаётся за отдельным закрытым раскрытием', () => {
  const input = 'LONG_INPUT_'.repeat(4000)
  const out = render([{ type: 'tool', id: 1, key: 't', ts: '', toolUseId: 't', name: 'Bash', input: { command: input }, state: 'error', exitCode: 2,
    result: Array.from({ length: 20 }, (_, i) => `строка ${i}`).join('\n') + '\nНужен пакет' }])
  const preview = /data-testid="tool-error-preview">(.*?)<\/div>/s.exec(out)?.[1] ?? ''
  assert.match(preview, /Код 2.*зависит от конкретной команды/)
  assert.match(preview, /Нужен пакет/)
  assert.doesNotMatch(preview, /LONG_INPUT_|строка 0/)
  assert.match(out, /<details class="tool-raw"><summary>Полный ввод и вывод<\/summary>/)
  assert.ok(out.includes(input), 'полный ввод по-прежнему доступен по раскрытию')
})

it('модель и полный доступ находятся рядом с отправкой и не спрятаны в сведениях', () => {
  const out = render()
  const toolbar = out.slice(out.indexOf('class="composer-toolbar"'))
  assert.match(toolbar, /data-testid="conv-settings"/)
  assert.match(toolbar, /class="approval t-fail".*?data-approval="full"/s)
  assert.ok(toolbar.indexOf('data-testid="conv-approval"') < toolbar.indexOf('class="chat-info"'))
  assert.match(toolbar, /data-testid="stop-turn"/)
  assert.match(toolbar, /data-testid="send"/)
})
