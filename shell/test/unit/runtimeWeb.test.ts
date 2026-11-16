import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeBounds, runtimeFit, runtimeInputPoint, runtimeNumber, runtimeSessionId, runtimeWebPartition, runtimeWebUrl } from '../../src/runtimeWebPolicy.js'

describe('isolated runtime browser policy', () => {
  it('allows local and remote http(s), denies privileged schemes and credential URLs', () => {
    assert.equal(runtimeWebUrl('http://localhost:4173/test'), 'http://localhost:4173/test')
    assert.equal(runtimeWebUrl('https://example.com'), 'https://example.com/')
    for (const input of ['file:///etc/passwd', 'app://pult/index.html', 'javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.com', 'https://example.com@localhost', '', null]) {
      assert.throws(() => runtimeWebUrl(input), String(input))
    }
  })
  it('clips native bounds to the app content and hides degenerate or invalid surfaces', () => {
    assert.deepEqual(runtimeBounds({ x: 700, y: 600, width: 500, height: 500 }, { width: 900, height: 800 }), { x: 700, y: 600, width: 200, height: 200 })
    assert.equal(runtimeBounds({ x: 900, y: 800, width: 500, height: 500 }, { width: 900, height: 800 }), null)
    assert.equal(runtimeBounds(null, { width: 900, height: 800 }), null)
    assert.throws(() => runtimeBounds({ x: NaN, y: 0, width: 400, height: 300 }, { width: 900, height: 800 }))
    assert.throws(() => runtimeBounds({ x: 1, y: 0, width: Infinity, height: 300 }, { width: 900, height: 800 }))
  })
  it('isolates browser partitions and never treats session names as filesystem paths', () => {
    const first = runtimeWebPartition('alpha')
    assert.equal(first, runtimeWebPartition('alpha'))
    assert.notEqual(first, runtimeWebPartition('beta'))
    assert.notEqual(runtimeWebPartition('alpha', 'created-first'), runtimeWebPartition('alpha', 'created-second'))
    assert.equal(runtimeWebPartition('alpha', 'created-first'), runtimeWebPartition('alpha', 'created-first'))
    assert.notEqual(runtimeWebPartition('alpha', 'beta:gamma'), runtimeWebPartition('alpha.beta', 'gamma'))
    assert.match(first, /^persist:pult-runtime-web-[0-9a-f]{32}$/)
    for (const input of ['../alpha', '/alpha', '', 'a/b', 'a\u0000', null]) assert.throws(() => runtimeSessionId(input))
  })
  it('bounds numeric input before generating browser commands', () => {
    assert.equal(runtimeNumber(undefined, 100, 0, 1000), 100)
    assert.throws(() => runtimeNumber('100', 0, 0, 1000))
    assert.throws(() => runtimeNumber(1001, 0, 0, 1000))
  })
})

describe('fixed logical browser presentation', () => {
  it('letterboxes the native surface without changing the page size', () => {
    assert.deepEqual(runtimeFit({ x: 10, y: 20, width: 640, height: 600 }, { width: 1280, height: 800 }), { x: 10, y: 120, width: 640, height: 400, scale: .5 })
    assert.equal(runtimeFit({ x: 0, y: 0, width: 2560, height: 1600 }, { width: 1280, height: 800 }).scale, 2)
    assert.equal(runtimeFit({ x: 0, y: 0, width: 2560, height: 1600 }, { width: 1280, height: 800 }, true).scale, 1)
    assert.equal(runtimeFit({ x: 0, y: 0, width: 640, height: 400 }, { width: 1280, height: 800 }, true).scale, .5)
  })
  it('transforms both event positions exactly once, never applies Retina DPR or document scroll', () => {
    assert.deepEqual(runtimeInputPoint({ x: 1260, y: 780 }, { width: 1280, height: 800 }, .5), { x: 630, y: 390 })
    for (const point of [{ x: -1, y: 0 }, { x: 1280, y: 1 }, { x: 1, y: 800 }, { x: NaN, y: 1 }]) assert.throws(() => runtimeInputPoint(point, { width: 1280, height: 800 }, .5))
  })
})
