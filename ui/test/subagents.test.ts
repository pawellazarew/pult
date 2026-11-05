import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveFinished, parseSubagentKeys, subagentViews, visibleSubagents } from '../src/model/subagents.js'
import type { AgentItem } from '../src/model/conversation.js'
const child = (id: number, toolUseId: string, items: AgentItem[] = [], state: AgentItem['state'] = 'ok'): AgentItem => ({ type: 'agent', key: String(id), id, ts: '2026-11-05T00:00:00Z', toolUseId, items, state })
test('subagent identity includes ancestor scope and always uses the existing projection', () => {
 const left = child(1, 'a', [child(2, 'same')]), right = child(3, 'b', [child(4, 'same')])
 const views = subagentViews([left,right])
 assert.equal(views.length,4); assert.notEqual(views[1]?.key,views[3]?.key)
 assert.equal(views[1]?.parentKey,views[0]?.key); assert.equal(views[0]?.item,left)
})
test('archive hides completed only; a resumed running child is visible again', () => {
 const done=child(1,'done'), working=child(2,'working',[],'running')
 const views=subagentViews([done,working]), hidden=archiveFinished(views,new Set())
 assert.deepEqual(visibleSubagents(views,hidden).map(v=>v.item.toolUseId),['working'])
 done.state='running'; assert.equal(visibleSubagents(views,hidden).length,2)
})
test('malformed persisted view state never invents children or crashes', () => {
 assert.deepEqual(parseSubagentKeys('broken'),[]); assert.deepEqual(parseSubagentKeys('{"key":1}'),[])
 assert.deepEqual(parseSubagentKeys('["a",2,"a",null,"b"]'),['a','b'])
})
