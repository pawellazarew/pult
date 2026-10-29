import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'
import { createNotificationRouter, notificationTarget } from '../../src/notifications.js'

class Notice extends EventEmitter {
  shown = 0
  constructor(readonly id: string) { super() }
  show(): void { this.shown++ }
}

describe('уведомление ведёт к своей беседе', () => {
  it('click остаётся жив после GC, когда у вызывающего остался только WeakRef', async () => {
    setFlagsFromString('--expose_gc')
    const gc = runInNewContext('gc') as () => void
    let ref: WeakRef<Notice> | undefined
    let selected = ''
    const router = createNotificationRouter({
      create: (o) => { const n = new Notice(o.id); ref = new WeakRef(n); return n },
      open: (t) => { selected = t.sessionId ?? '' },
    })
    router.show({ title: '', body: '' }, { sessionId: 'after-gc' })
    await new Promise<void>((r) => setImmediate(r))
    gc()
    await new Promise<void>((r) => setImmediate(r))
    gc()
    const notice = ref?.deref()
    assert.ok(notice, 'GC забрал объект уведомления вместе с обработчиком click')
    notice.emit('click')
    assert.equal(selected, 'after-gc')
  })

  it('держит объект до клика, открывает его чат и освобождает ссылку', () => {
    let native: Notice | undefined
    const opened: unknown[] = []
    const router = createNotificationRouter({ create: (o) => (native = new Notice(o.id)), open: (t) => { opened.push(t) } })
    const id = router.show({ title: 'Готово', body: 'Текст' }, { sessionId: 'alpha', permId: 'p1' })
    assert.equal(router.size(), 1, 'объект уведомления должен пережить возврат IPC-обработчика')
    assert.equal(native?.shown, 1)
    assert.deepEqual(notificationTarget(id), { sessionId: 'alpha', permId: 'p1' })
    native!.emit('click')
    assert.deepEqual(opened, [{ sessionId: 'alpha', permId: 'p1' }])
    assert.equal(router.size(), 0)
  })

  it('восстанавливает цели уведомлений после перезапуска, не показывая их повторно', async () => {
    const first = createNotificationRouter({ create: (o) => new Notice(o.id), open() {} })
    const id = first.show({ title: 'Готово', body: '' }, { sessionId: 'beta' })
    const restored = new Notice(id)
    const foreign = new Notice('чужое уведомление')
    const opened: unknown[] = []
    const router = createNotificationRouter({ create: (o) => new Notice(o.id), history: async () => [restored, foreign], open: (t) => { opened.push(t) } })
    await router.restore()
    assert.equal(router.size(), 1)
    assert.equal(restored.shown, 0)
    restored.emit('click')
    assert.deepEqual(opened, [{ sessionId: 'beta' }])
  })

  it('закрытое или не показанное уведомление освобождается; битые id отвергаются', () => {
    const natives: Notice[] = []
    const router = createNotificationRouter({ create: (o) => { const n = new Notice(o.id); natives.push(n); return n }, open() {} })
    for (const event of ['close', 'failed']) {
      router.show({ title: '', body: '' }, { sessionId: 'a' })
      natives.at(-1)!.emit(event)
      assert.equal(router.size(), 0)
    }
    for (const id of ['', 'pult-notify-v1.bad', 'other', 'pult-notify-v1.' + 'x'.repeat(2000)]) assert.equal(notificationTarget(id), null)
  })
})
