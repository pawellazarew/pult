import assert from 'node:assert/strict'
import { it } from 'node:test'
import { compactToolFailure, toolFailureTail } from '../src/model/toolFailure.js'

it('retained tool failure contains only bounded presentation, never raw output or command', () => {
  const failure = { title: 'a'.repeat(2000), explanation: 'b'.repeat(2000), action: 'c'.repeat(2000), expected: true as const }
  const preview = compactToolFailure(failure, 'OLD_PREFIX\n' + 'x'.repeat(5000) + '\nlast')
  assert.deepEqual(Object.keys(preview).sort(), ['failure', 'hasOutput', 'tail'])
  assert.equal(preview.failure.title.length, 512)
  assert.equal(preview.failure.explanation.length, 512)
  assert.equal(preview.failure.action.length, 512)
  assert.equal(preview.failure.expected, true)
  assert.equal(preview.tail.length, 1600)
  assert.ok(preview.tail.endsWith('last'))
  assert.ok(!preview.tail.includes('OLD_PREFIX'))
  assert.notEqual(preview.failure, failure)
})

it('compact tail preserves the existing six nonempty lines, UTF16 bound and empty output semantics', () => {
  assert.equal(toolFailureTail('0\n\n1\n \n2\n3\n4\n5\n6'), '1\n2\n3\n4\n5\n6')
  assert.equal(toolFailureTail('🙂'.repeat(1000)).length, 1600)
  assert.equal(toolFailureTail(undefined), '')
  assert.equal(toolFailureTail(' \n\t'), '')
})
