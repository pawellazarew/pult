import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeCoordinates, runtimeImage, runtimePoint, runtimeSetupLabel } from '../src/components/RuntimePanel.js'

describe('runtime preview device coordinates', () => {
  it('maps a scaled image click to original Android pixels', () => {
    const size = runtimeCoordinates('android', { width: 1440, height: 3200 })!
    assert.deepEqual(runtimePoint({ x: 200, y: 420 }, { left: 20, top: 20, width: 360, height: 800 }, size), { x: 720, y: 1600 })
  })
  it('uses logical points for iOS and never guesses its Retina scale', () => {
    assert.equal(runtimeCoordinates('ios', { width: 1170, height: 2532 }, { width: 585, height: 1266 }), null)
    assert.deepEqual(runtimeCoordinates('ios', { width: 1170, height: 2532, coordinateWidth: 390, coordinateHeight: 844 }), { width: 390, height: 844 })
  })
  it('rejects stale or out-of-screen input and bounds edge pixels', () => {
    const box = { left: 10, top: 20, width: 100, height: 200 }, size = { width: 400, height: 800 }
    assert.equal(runtimePoint({ x: 9, y: 30 }, box, size), null)
    assert.equal(runtimePoint({ x: 20, y: 30 }, { ...box, width: 0 }, size), null)
    assert.equal(runtimePoint({ x: Infinity, y: 30 }, box, size), null)
    assert.deepEqual(runtimePoint({ x: 110, y: 220 }, box, size), { x: 399, y: 799 })
  })
})

describe('runtime preview raster isolation', () => {
  it('accepts bounded JPEG/PNG data only', () => {
    assert.equal(runtimeImage({ image: { data: 'YWJj', mimeType: 'image/jpeg' } }), 'data:image/jpeg;base64,YWJj')
    assert.equal(runtimeImage({}), null)
    assert.equal(runtimeImage({ image: { data: '<svg onload=alert(1)>', mimeType: 'image/png' } }), null)
    assert.equal(runtimeImage({ image: { data: 'A'.repeat(600001), mimeType: 'image/png' } }), null)
    assert.equal(runtimeImage({ image: { data: 'YWJj', mimeType: 'text/html' as 'image/png' } }), null)
  })
})


describe('runtime setup status', () => {
  it('does not call manual approval an installation', () => {
    assert.equal(runtimeSetupLabel('approved', false), 'Выполни шаги настройки')
    assert.equal(runtimeSetupLabel('approved', true), 'Компонент установлен')
    assert.equal(runtimeSetupLabel('installing', true), 'Устанавливаю компонент…')
    assert.equal(runtimeSetupLabel('failed', true), 'Установка не завершена')
  })
})
