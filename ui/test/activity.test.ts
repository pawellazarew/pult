import assert from 'node:assert/strict'
import { it } from 'node:test'
import { groupActivity } from '../src/model/activity.js'
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
