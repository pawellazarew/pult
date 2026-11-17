import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIRST_LAUNCH_MS, waitForAppPort } from '../../scripts/app-startup.mjs'

// check-app.mjs — скрипт проверки собранного Pult.app, запускать его в юнит-тестах нельзя (нужен
// настоящий подписанный бандл). Само ожидание проверяется на виртуальных часах;
// проверки схемы ниже читают только конфигурацию/текст и ничего не запускают.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-app.mjs')

describe('check-app: ожидание медленного первого запуска', () => {
  it('без порта даёт ровно 90 секунд, опрашивая каждые 100 мс', async () => {
    assert.equal(FIRST_LAUNCH_MS, 90_000)
    let clock = 0
    const pauses: number[] = []
    const ready = await waitForAppPort({
      now: () => clock,
      sleep: async (ms) => { pauses.push(ms); clock += ms },
      discover: () => { assert.ok(clock < 90_000) },
      hasPort: () => false,
      launcherExited: () => false,
    })
    assert.equal(ready, false)
    assert.equal(clock, 90_000)
    assert.ok(pauses.length > 0)
    assert.ok(pauses.every((ms) => ms === 100))
  })
  it('проверяет владение перед портом и принимает медленный старт позже 15 секунд', async () => {
    let clock = 0
    let discoveredAt: number | null = null
    const ready = await waitForAppPort({
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      discover: () => { discoveredAt = clock },
      hasPort: () => { assert.equal(discoveredAt, clock); return clock >= 60_000 },
      launcherExited: () => false,
    })
    assert.equal(ready, true)
    assert.equal(clock, 60_000)
  })
  it('готовый порт принимается только после проверки владения, без ожидания', async () => {
    let discovered = false
    const ready = await waitForAppPort({
      now: () => 0,
      sleep: async () => { assert.fail('готовый порт не требует ожидания') },
      discover: () => { discovered = true },
      hasPort: () => { assert.equal(discovered, true); return true },
      launcherExited: () => false,
    })
    assert.equal(ready, true)
  })
  it('выход launcher без порта завершает ожидание сразу после проверки владения', async () => {
    let discovered = false
    const ready = await waitForAppPort({
      now: () => 0,
      sleep: async () => { assert.fail('выход launcher не расходует остаток таймаута') },
      discover: () => { discovered = true },
      hasPort: () => false,
      launcherExited: () => { assert.equal(discovered, true); return true },
    })
    assert.equal(ready, false)
  })
  it('ошибка владения распространяется даже при готовом порте', async () => {
    const error = new Error('PID/start/path не принадлежит прогону')
    let portChecked = false
    await assert.rejects(waitForAppPort({
      now: () => 0,
      sleep: async () => { assert.fail('ошибка владения не должна повторяться') },
      discover: () => { throw error },
      hasPort: () => { portChecked = true; return true },
      launcherExited: () => false,
    }), (caught) => { assert.equal(caught, error); return true })
    assert.equal(portChecked, false)
  })
})

describe('схема pult:// в сборке (docs/14 О3)', () => {
  it('electron-builder объявляет схему pult: из build.protocols он пишет CFBundleURLTypes в Info.plist', () => {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(SCRIPT), '..', 'package.json'), 'utf8')) as {
      build?: { protocols?: Array<{ name?: string; schemes?: string[] }> }
    }
    const protocols = pkg.build?.protocols ?? []
    assert.ok(protocols.some((p) => p.name === 'Pult' && p.schemes?.includes('pult')), JSON.stringify(protocols))
  })
  it('check-app сверяет CFBundleURLTypes собранного приложения', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    assert.match(src, /plist\.CFBundleURLTypes/)
    assert.match(src, /CFBundleURLSchemes\.includes\('pult'\)/)
  })
})
