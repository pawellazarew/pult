import assert from 'node:assert/strict'
import { it } from 'node:test'
import { foldPath, groupActivity, subagentBodyKey, toolsGroupKey } from '../src/model/activity.js'
import { foldConversation } from '../src/model/conversation.js'
import type { ConvItem, ToolItem } from '../src/model/conversation.js'
import { parseMarkdown } from '../src/model/markdown.js'
import { isImagePath } from '../src/components/Images.js'

const tool = (id: number, over: Partial<ToolItem> = {}): ToolItem => ({ type: 'tool', id, key: `e${id}`, ts: '2026-10-27T10:00:00Z', toolUseId: `${id}`, name: 'Bash', input: {}, state: 'ok', ...over })
it('пачки не скрывают разрешения, ошибки и изображения', () => {
  const permission: ConvItem = { type: 'perm', key: 'p', id: 3, ts: '', permId: 'p', toolName: 'Bash', input: {}, state: 'pending' }
  const items = [tool(1), tool(2), permission, tool(4, { state: 'error' }), tool(5, { images: ['/w/a.png'] }), tool(6), tool(7)]
  const groups = groupActivity(items)
  assert.deepEqual(groups.map((g) => g.type), ['tools', 'item', 'item', 'item', 'tools'])
  assert.deepEqual(groups.flatMap((g) => g.type === 'tools' ? g.items : [g.item]), items)
})
it('Markdown сохраняет картинку отдельным узлом, не загружая HTML или сеть', () => {
  assert.deepEqual(parseMarkdown('![Макет](<design/a b.png>)'), [{ t: 'p', v: [{ t: 'image', url: 'design/a b.png', alt: 'Макет' }] }])
  assert.equal(isImagePath('design/a.png'), true)
  assert.equal(isImagePath('/w/a.JPG'), true)
  for (const src of ['https://example.com/a.png', 'file:///w/a.png', 'javascript:x.png', '/w/a.svg', '/w/a.png\n']) assert.equal(isImagePath(src), false, src)
})
it('tool.finished сохраняет изображения для живой ленты и повторного чтения истории', () => {
  const conv = foldConversation([{ id: 1, ts: '2026-10-27T10:00:00Z', sessionId: 'a', provider: 'codex', kind: 'tool.finished', data: { toolUseId: 'i', name: 'imageGeneration', images: ['/w/a.png'] } }])
  assert.deepEqual((conv.items[0] as ToolItem).images, ['/w/a.png'])
})

it('путь свёрнутых блоков к элементу: пачка, история субагента, пачка внутри неё', () => {
  const nested: ConvItem = { type: 'agent', key: 'a', id: 10, ts: '', toolUseId: 'a', state: 'ok', items: [tool(11), tool(12), tool(13), { type: 'model', key: 'm', id: 14, ts: '', text: 'итог', streaming: false }] }
  const items: ConvItem[] = [tool(1), tool(2), tool(3, { state: 'error' }), nested, tool(20)]
  assert.deepEqual(foldPath(items, 'e2'), [toolsGroupKey('e1')])
  // Строка с ошибкой и одиночная строка — на виду, раскрывать нечего.
  assert.deepEqual(foldPath(items, 'e3'), [])
  assert.deepEqual(foldPath(items, 'e20'), [])
  assert.deepEqual(foldPath(items, 'e12'), [subagentBodyKey('a'), toolsGroupKey('e11')])
  assert.deepEqual(foldPath(items, 'm'), [subagentBodyKey('a')])
  assert.equal(foldPath(items, 'нет такого'), null)
})
