// e2e ноги 1 (docs/12 §2, §5): окно открывается, мост пускает только белый список, daemon.status
// работает, подписка получает события; демон убит — плашка «демон недоступен»; демон поднят
// заново — окно переподключается и доигрывает журнал с курсора: ни одно событие не потеряно,
// ни одно не пришло дважды.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { DaemonStatus } from '../../src/contract.js'
import { launch, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Debug = { ids: number[]; conn: Array<{ state: string; at: number }>; boot: number | null }

describe('окно: мост, подписка, переподключение', () => {
  let h: Harness

  // Пауза повтора растянута до 2,5 с: демон, поднятый тестом, успевает принять события ДО того,
  // как окно переподключится, — значит, они приходят доигрыванием с курсора, а не живым потоком.
  before(async () => { h = await launch({ name: 'bridge', backoff: '2500,5000' }) })
  after(async () => { await h?.close() })

  const debug = async (): Promise<Debug> => h.win.evaluate(() => {
    const d = window.__pultDebug
    return { ids: d ? d.eventIds() : [], conn: d ? d.connLog() : [], boot: d ? d.bootCursor() : null }
  })
  const connState = async (): Promise<string | null> => h.win.getAttribute('.app', 'data-conn')

  it('окно открывается на app://pult и подключается к демону', async () => {
    assert.equal(h.win.url(), 'app://pult/index.html')
    assert.ok(await waitFor(async () => (await connState()) === 'up', 20_000), 'окно не подключилось к демону')
    await h.win.getByTestId('daemon-meta').waitFor({ state: 'attached', timeout: 10_000 })
    assert.equal(await h.win.title(), 'Пульт')
    await h.shot('up')
  })

  it('в окне нет Node и Electron: только window.pult', async () => {
    const probe = await h.win.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      bridgeKeys: Object.keys(window.pult ?? {}).sort(),
      version: window.pult?.version,
    }))
    assert.equal(probe.require, 'undefined')
    assert.equal(probe.process, 'undefined')
    assert.equal(probe.version, 1)
    assert.deepEqual(probe.bridgeKeys, [
      'call', 'clipboardFilePaths', 'copyText', 'notify', 'onConnection', 'onNavigate', 'openExternal', 'openImage', 'pathsForFiles', 'pickFolder', 'readImage', 'revealPath', 'saveImage',
      'startDaemon', 'stopDaemon', 'subscribe', 'testMode', 'version',
    ])
  })

  it('мост отвергает методы вне белого списка, не доходя до демона', async () => {
    for (const method of ['perm.request', 'events.emit', 'daemon.stop', 'hello']) {
      const r = await h.win.evaluate(async (m) => {
        try {
          await window.pult!.call(m as never, {})
          return { ok: true }
        } catch (e) {
          return e as { code: string; message: string }
        }
      }, method)
      assert.deepEqual(Object.keys(r).sort(), ['code', 'message'], method)
      assert.equal((r as { code: string }).code, 'method_not_allowed', method)
    }
    // Демон жив и события emit в журнал не попало.
    const c = await h.client()
    const tail = (await c.request('events.tail', { since: 0 })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }
    assert.equal(tail.events.filter((e) => e.kind === 'status.changed' && 'n' in e.data).length, 0)
  })

  it('daemon.status через мост — тот же демон, что держит lock', async () => {
    const st = (await h.win.evaluate(() => window.pult!.call('daemon.status'))) as DaemonStatus
    assert.equal(st.pid, h.daemonPid())
    assert.equal(st.protocol, 1)
    assert.equal(st.home, h.home)
  })

  it('подписка получает события, которые пишет в журнал другой клиент', async () => {
    const c = await h.client()
    const r = (await c.request('events.emit', { kind: 'status.changed', count: 3, data: { from: 'e2e' } })) as { ids: number[] }
    assert.ok(await waitFor(async () => (await debug()).ids.includes(r.ids.at(-1)!)), 'события не дошли до окна')
    const d = await debug()
    for (const id of r.ids) assert.ok(d.ids.includes(id), `событие ${id} не дошло`)
    await h.win.getByTestId('event-count').filter({ hasText: `#${r.ids.at(-1)}` }).waitFor({ state: 'attached', timeout: 5000 })
  })

  it('демон убит — плашка «демон недоступен»; поднят — окно доигрывает с курсора без потерь и повторов', async () => {
    const pid = h.daemonPid()
    assert.ok(pid, 'нет pid демона')
    process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(async () => (await connState()) === 'down', 10_000), 'окно не заметило смерть демона')
    const banner = h.win.getByTestId('conn-banner')
    await banner.waitFor({ timeout: 5000 })
    assert.match((await banner.textContent()) ?? '', /[Дд]емон недоступен/)
    await h.shot('down')

    // Демон возвращается «сам» (как его подняла бы служба) и сразу пишет события.
    await h.startDaemonExternally()
    let c: Awaited<ReturnType<Harness['client']>> | null = null
    assert.ok(await waitFor(async () => { c = await h.client(); return true }, 15_000, 30), 'внешний демон не поднялся')
    const emitted = (await c!.request('events.emit', { kind: 'status.changed', count: 5, data: { from: 'после рестарта' } })) as { ids: number[] }
    const emittedAt = Date.now()

    assert.ok(await waitFor(async () => (await connState()) === 'up', 20_000), 'окно не переподключилось')
    assert.ok(await waitFor(async () => (await debug()).ids.includes(emitted.ids.at(-1)!), 10_000), 'доигрывание не дошло')
    // Ещё немного живого потока после переподключения.
    const live = (await c!.request('events.emit', { kind: 'status.changed', count: 2 })) as { ids: number[] }
    assert.ok(await waitFor(async () => (await debug()).ids.includes(live.ids.at(-1)!), 10_000), 'живой поток после переподключения не дошёл')
    await sleep(300)

    const d = await debug()
    // С 0.2.19 окно стартует по снимку (`events.snapshot`) и подписывается с его курсора: всё до
    // курсора — в снимке, поток обязан нести ровно журнал ПОСЛЕ него.
    assert.notEqual(d.boot, null, 'окно не стартовало по снимку')
    const journal = (await c!.request('events.tail', { since: d.boot })) as { events: Array<{ id: number }> }
    assert.deepEqual(d.ids, journal.events.map((e) => e.id), 'окно получило ровно журнал после снимка: без потерь, без повторов, по порядку')
    assert.equal(new Set(d.ids).size, d.ids.length)

    // Переподключение случилось ПОСЛЕ того, как события легли в журнал — они пришли доигрыванием.
    const reconnect = d.conn.filter((x) => x.state === 'up').at(-1)
    assert.ok(reconnect && reconnect.at >= emittedAt - 50, `окно подключилось раньше emit (${reconnect?.at} < ${emittedAt})`)
    await h.win.getByTestId('conn-banner').waitFor({ state: 'detached', timeout: 5000 })
    await h.shot('reconnected')
  })
})
