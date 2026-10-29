import { t as tr } from './i18n.js'
// Связь окна с демоном (docs/12 §2 «Переподключение»). Живёт в main-процессе; токен демона
// остаётся здесь и в рендерер не уходит никогда.
//
// Как устроено:
//   * одно соединение клиента `shell` на всё приложение;
//   * демон ушёл (стоп, обновление, падение) — состояние `down`, повтор ТОЛЬКО подключения с
//     растущей паузой. Сам демон повтор не поднимает: человек мог остановить его нарочно, а
//     поднять — кнопка «запустить» (`startDaemon`);
//   * у каждой подписки окна — свой курсор `lastId`: последний ДОСТАВЛЕННЫЙ окну id. После
//     переподключения main заново подписывается с `since: lastId`, демон доигрывает журнал, а
//     кадры с id <= lastId отсекаются — ничего не теряется и ничего не приходит дважды.
//
// Зависимости (подключение, таймеры) передаются снаружи: юнит-тесты гоняют этот класс на
// фальшивом клиенте и ручных таймерах, e2e — на настоящем демоне.

import type { Client } from '../../src/cli/client.js'
import type { PultEvent } from '../../src/core/events.js'
import type { Backoff } from './backoff.js'
import { backoffDelay } from './backoff.js'
import type { BridgeError, ConnState } from './contract.js'

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface LinkDeps {
  /** Только подключиться к живому демону (повторы). */
  connect(): Promise<Client>
  /** Подключиться, а если демона нет — поднять (старт окна и кнопка «запустить»). */
  ensure(): Promise<Client>
  backoff: Backoff
  timers?: Timers
  onState(s: ConnState): void
  log?(msg: string, extra?: Record<string, unknown>): void
}

interface Sub {
  lastId: number
  onEvent(ev: PultEvent): void
  /** Номер подписки у демона в ТЕКУЩЕМ соединении; null — ещё не подписаны. */
  daemonSub: number | null
  /** Соединение, в котором сделана подписка: кадры старого соединения не принимаются. */
  client: Client | null
}

export class LinkError extends Error implements BridgeError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LinkError'
  }
}

export class DaemonLink {
  private client: Client | null = null
  private state: ConnState = { state: 'connecting', attempt: 0 }
  private attempt = 0
  private timer: unknown = null
  private busy = false
  private checking: Promise<void> | null = null
  private closed = false
  /** Демона остановили кнопкой: повторов нет до «запустить». */
  private stoppedByUser = false
  private readonly subs = new Map<string, Sub>()
  private readonly timers: Timers

  constructor(private readonly deps: LinkDeps) {
    this.timers = deps.timers ?? realTimers
  }

  get current(): ConnState { return this.state }

  /** Первое подключение окна: демона нет — поднять (как CLI). */
  start(): Promise<void> { return this.attach(true) }

  /** После сна/возврата в окно проверяем живой сокет; остановленный вручную демон не поднимаем. */
  checkConnection(): Promise<void> {
    if (this.closed || this.stoppedByUser) return Promise.resolve()
    if (this.checking) return this.checking
    this.checking = this.checkLiveConnection().finally(() => { this.checking = null })
    return this.checking
  }

  private async checkLiveConnection(): Promise<void> {
    const c = this.client
    if (c) {
      try {
        await c.request('daemon.status', undefined, { timeoutMs: 5_000 })
        if (this.client === c) this.setState({ state: 'up', daemon: c.daemon })
        return
      } catch {
        if (this.client === c) {
          this.onLost(c)
          c.close()
        }
      }
    }
    if (!this.closed && !this.stoppedByUser) {
      this.cancelRetry()
      await this.attach(false)
    }
  }

  /** Кнопка «запустить»: сбрасывает паузу и поднимает демона. Ошибка уходит вызывающему. */
  async startDaemon(): Promise<void> {
    if (this.client) return
    await this.attach(true, true)
    if (!this.client) {
      const s = this.state
      throw new LinkError('no_daemon', s.state === 'down' ? s.reason : tr('демон не поднялся'))
    }
  }

  /** Вызов метода демона. Нет связи — отказ `no_daemon`, а не ожидание: окно покажет плашку. */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const c = this.client
    if (!c) throw new LinkError('no_daemon', tr('демон недоступен'))
    return c.request(method, params)
  }

  subscribe(key: string, since: number, onEvent: (ev: PultEvent) => void): void {
    this.unsubscribe(key)
    const sub: Sub = { lastId: Math.max(0, Math.floor(since) || 0), onEvent, daemonSub: null, client: null }
    this.subs.set(key, sub)
    if (this.client) void this.attachSub(this.client, key, sub)
  }

  unsubscribe(key: string): void {
    const sub = this.subs.get(key)
    if (!sub) return
    this.subs.delete(key)
    const c = this.client
    if (c && sub.client === c && sub.daemonSub !== null) {
      c.request('events.unsubscribe', { sub: sub.daemonSub }).catch(() => { /* соединение ушло — подписка умерла вместе с ним */ })
    }
  }

  /** Отписать всё, чей ключ начинается с `prefix` (окно закрыто). */
  unsubscribePrefix(prefix: string): void {
    for (const key of [...this.subs.keys()]) if (key.startsWith(prefix)) this.unsubscribe(key)
  }

  /** Выход приложения: закрыть соединение (демон продолжает жить). */
  close(): void {
    this.closed = true
    this.cancelRetry()
    const c = this.client
    this.client = null
    c?.close()
  }

  /** Остановка демона кнопкой: после неё окно не долбит сокет повторами. */
  async stopDaemon(): Promise<void> {
    const c = this.client
    if (!c) throw new LinkError('no_daemon', tr('демон недоступен'))
    this.stoppedByUser = true
    try {
      await c.request('daemon.stop')
    } catch (e) {
      this.stoppedByUser = false
      throw e
    }
  }

  private setState(s: ConnState): void {
    this.state = s
    this.deps.onState(s)
  }

  private cancelRetry(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
  }

  private scheduleRetry(reason: string): void {
    this.cancelRetry()
    if (this.closed) return
    if (this.stoppedByUser) {
      this.setState({ state: 'down', reason, attempt: 0, retryInMs: null })
      return
    }
    this.attempt += 1
    const delay = backoffDelay(this.attempt, this.deps.backoff)
    this.setState({ state: 'down', reason, attempt: this.attempt, retryInMs: delay })
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.attach(false)
    }, delay)
  }

  private async attach(spawn: boolean, manual = false): Promise<void> {
    if (this.closed || this.client || this.busy) return
    this.busy = true
    this.cancelRetry()
    if (manual) { this.stoppedByUser = false; this.attempt = 0 }
    if (this.state.state !== 'down' || manual) this.setState({ state: 'connecting', attempt: this.attempt })
    let client: Client
    try {
      client = spawn ? await this.deps.ensure() : await this.deps.connect()
    } catch (e) {
      this.busy = false
      const msg = (e as Error).message ?? String(e)
      this.deps.log?.(tr('демон не отвечает'), { error: msg, attempt: this.attempt })
      this.scheduleRetry(shortReason(e))
      return
    }
    this.busy = false
    if (this.closed) { client.close(); return }
    this.client = client
    this.attempt = 0
    this.stoppedByUser = false
    client.onClose(() => this.onLost(client))
    this.setState({ state: 'up', daemon: client.daemon })
    for (const [key, sub] of this.subs) void this.attachSub(client, key, sub)
  }

  private onLost(client: Client): void {
    if (this.client !== client) return
    this.client = null
    for (const sub of this.subs.values()) { sub.daemonSub = null; sub.client = null }
    if (this.closed) return
    this.scheduleRetry(this.stoppedByUser ? tr('остановлен кнопкой') : tr('соединение с демоном закрыто'))
  }

  private async attachSub(client: Client, key: string, sub: Sub): Promise<void> {
    sub.client = client
    sub.daemonSub = null
    const deliver = (ev: PultEvent): void => {
      // Кадр чужого (старого) соединения или отписанной подписки — мимо.
      if (this.subs.get(key) !== sub || sub.client !== client) return
      if (!Number.isInteger(ev.id) || ev.id <= sub.lastId) return
      sub.lastId = ev.id
      try { sub.onEvent(ev) } catch (e) { this.deps.log?.(tr('обработчик события упал'), { error: (e as Error).message }) }
    }
    try {
      const { sub: n } = await client.subscribe({ since: sub.lastId }, deliver)
      if (this.subs.get(key) === sub && sub.client === client) sub.daemonSub = n
      else client.request('events.unsubscribe', { sub: n }).catch(() => { /* неважно */ })
    } catch (e) {
      // Соединение упало посреди подписки: onLost переподключит и подпишет заново.
      this.deps.log?.(tr('подписка не удалась'), { error: (e as Error).message })
    }
  }
}

function shortReason(e: unknown): string {
  const code = (e as { code?: unknown })?.code
  if (code === 'no_daemon') return tr('сокет не отвечает')
  if (code === 'bad_token') return tr('токен демона не подошёл')
  const msg = (e as Error)?.message ?? String(e)
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg
}
