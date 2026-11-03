import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { it } from 'node:test'
import { shutdownDeadline } from '../dist/daemon/shutdown.js'
import { tempHome, startTestDaemon } from './helpers.js'

it('ошибка журнала завершает демон аварийно и освобождает сокет и lock', { timeout: 10_000 }, async () => {
  const home = tempHome()
  const daemon = await startTestDaemon(home)
  try {
    const stopped = new Promise<number>((resolve) => daemon.onStopped(resolve))
    daemon.store.append = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) }
    assert.throws(() => daemon.emit({ sessionId: 'w', provider: 'pult', kind: 'status.changed', data: {} }), /ENOSPC/)
    assert.equal(await stopped, 1, 'launchd должен перезапустить демон')
    assert.equal(existsSync(home.paths.sock), false)
    assert.equal(existsSync(home.paths.lock), false)
  } finally { await daemon.stop('уборка'); home.remove() }
})

it('сбой этапа уборки не мешает закрыть сокет и снять lock; stop идемпотентен', async () => {
  const home = tempHome()
  const daemon = await startTestDaemon(home)
  try {
    let code = -1
    daemon.onStopped((result) => { code = result })
    daemon.broker.shutdown = () => { throw new Error('сломанный брокер') }
    const first = daemon.stop('тест')
    assert.equal(daemon.stop('повтор'), first)
    await first
    assert.equal(code, 1)
    assert.equal(existsSync(home.paths.sock), false)
    assert.equal(existsSync(home.paths.lock), false)
  } finally { home.remove() }
})

it('общий предел завершает процесс даже при бесконечном ожидании уборки', { timeout: 5_000 }, async () => {
  const module = new URL('../dist/daemon/shutdown.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { shutdownDeadline } from ${JSON.stringify(module)}; shutdownDeadline(() => process.exit(1), 30); await new Promise(() => {});`], { stdio: 'ignore' })
  const result = await new Promise<{code:number|null; signal:string|null}>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({code, signal}))
  })
  assert.deepEqual(result, { code: 1, signal: null })
})

it('завершённая уборка отменяет предельный таймер', async () => {
  let fired = false
  const cancel = shutdownDeadline(() => { fired = true }, 10)
  cancel()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fired, false)
})

it('общий предел даёт штатной лестнице Codex и обновлению завершиться за 9 секунд', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let timedOut = false
  const cancel = shutdownDeadline(() => { timedOut = true })
  t.mock.timers.tick(9_000)
  assert.equal(timedOut, false, '3+3 секунды Codex и 3 секунды обновления не являются зависанием')
  t.mock.timers.tick(11_000)
  assert.equal(timedOut, true)
  cancel()
})
