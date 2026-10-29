import { getLanguage } from '../i18n/core.js'
import type { Language } from '../i18n/core.js'
import { t as tr } from './i18n.js'
// Клиент сокета демона: рукопожатие, сопоставление запросов и ответов, поток подписки.

import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { PultEvent } from '../core/events.js'
import { createLineSplitter, encodeLine, MAX_LINE_BYTES, NdjsonError } from '../core/ndjson.js'
import type { PultPaths } from '../core/paths.js'
import type { ClientKind, RpcError } from '../core/rpc.js'
import { PROTOCOL_VERSION } from '../core/rpc.js'
import { readToken } from '../core/token.js'
import { isBinaryPlist, plistString } from '../update/plist.js'
import { VERSION } from '../core/version.js'

export class ClientError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ClientError'
  }
}

export interface DaemonInfo {
  version: string
  pid: number
  startedAt: string
}

export interface Client {
  readonly daemon: DaemonInfo
  /**
   * `timeoutMs` — потолок ожидания ответа: не пришёл — отказ `timeout` и соединение закрывается
   * (демон, ответивший hello_ok и замолчавший, иначе держал бы вызывающего вечно). Без него —
   * ждать сколько угодно: так живут `agent wait` и `prompt --wait`.
   */
  request(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>
  subscribe(
    params: { since?: number; sessionId?: string },
    onEvent: (ev: PultEvent) => void,
    onEnd?: (end: { code: string; message: string }) => void,
  ): Promise<{ sub: number; cursor: number }>
  close(): void
  onClose(fn: () => void): void
}

export interface ConnectOptions {
  /** Display language of this caller, sampled for each request; never a daemon-wide override. */
  locale?: () => Language
  client?: ClientKind
  timeoutMs?: number
}

/**
 * Чем запущено окно (0.3.4) — для hello оболочки: путь к исполняемому файлу Electron и версия Pult.app из его
 * Info.plist. По ним демон после замены окна видит, что поднялась НОВАЯ версия (src/update/appUpdate.ts). Код этот
 * исполняется в main оболочки (она грузит cli/client.js из пакета), поэтому работает и в окне 0.1.15 — новая
 * оболочка не нужна. Не Electron — null; не из бандла (рабочая копия) — только путь.
 */
export function shellAppInfo(
  execPath: string = process.execPath,
  versions: Record<string, string | undefined> = process.versions,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): { execPath: string; version?: string } | null {
  if (!versions['electron']) return null
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  if (!m) return { execPath }
  try {
    const text = read(path.join(m[1] as string, 'Contents', 'Info.plist'))
    const v = isBinaryPlist(text) ? null : plistString(text, 'CFBundleShortVersionString')
    return v ? { execPath, version: v } : { execPath }
  } catch {
    return { execPath }
  }
}

/**
 * Окно запоминается при загрузке модуля (в main оболочки — при её старте): переподключения после рестарта демона
 * шлют то же самое, а Info.plist, который обновление окна уже заменило под работающим процессом, не перечитывается.
 * `pid` — свой: по нему демон сверяет, что поднялся процесс из нового бандла. `pkg` (0.3.16) — версия пакета, из
 * которого этот модуль загружен: оболочка грузит его и интерфейс из одного пакета при старте, так что это версия
 * интерфейса в окне. Демон сменил версию, а `pkg` прежний — окно надо перезапустить.
 */
const SHELL_APP: ({ execPath: string; version?: string; pid: number; pkg: string }) | null = (() => {
  const info = shellAppInfo()
  return info ? { ...info, pid: process.pid, pkg: VERSION } : null
})()
const shellApp = (): typeof SHELL_APP => SHELL_APP

export async function connectClient(paths: PultPaths, opts: ConnectOptions = {}): Promise<Client> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const token = readToken(paths.token)
  if (!token) throw new ClientError('no_daemon', tr`нет файла токена ${paths.token} — демон не запущен`)

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(paths.sock)
    const onError = (e: NodeJS.ErrnoException): void => {
      s.destroy()
      reject(new ClientError('no_daemon', tr`сокет ${paths.sock} не отвечает (${e.code ?? e.message})`))
    }
    s.once('error', onError)
    s.once('connect', () => { s.removeListener('error', onError); resolve(s) })
  })

  type SubHandler = { onEvent: (ev: PultEvent) => void; onEnd?: (e: { code: string; message: string }) => void }
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const subs = new Map<number, SubHandler>()
  // Обработчик подписки, который ждёт своего номера. Регистрируется ДО отправки запроса:
  // демон присылает ответ и первые кадры одним куском, а `await` отдал бы управление только
  // микрозадачей позже — кадры успели бы прийти «ничьими».
  const pendingSubs = new Map<number, SubHandler>()
  const closeHandlers: Array<() => void> = []
  let seq = 0
  let helloResolve: ((info: DaemonInfo) => void) | null = null
  let helloReject: ((e: Error) => void) | null = null
  let closed = false

  const splitter = createLineSplitter()
  socket.on('data', (chunk: Buffer) => {
    let lines: string[]
    try {
      lines = splitter.push(chunk)
    } catch (e) {
      if (e instanceof NdjsonError) { socket.destroy(); return }
      throw e
    }
    for (const line of lines) {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }

      if (msg['type'] === 'hello_ok') {
        helloResolve?.(msg['daemon'] as DaemonInfo)
        helloResolve = null
        helloReject = null
        continue
      }
      if (msg['type'] === 'error') {
        const err = new ClientError(String(msg['code']), String(msg['message'] ?? msg['code']))
        if (helloReject) { helloReject(err); helloReject = null; helloResolve = null; continue }
        for (const p of pending.values()) p.reject(err)
        pending.clear()
        continue
      }
      if (typeof msg['sub'] === 'number') {
        const entry = subs.get(msg['sub'] as number)
        if (!entry) continue
        if (msg['end']) {
          entry.onEnd?.(msg['end'] as { code: string; message: string })
          subs.delete(msg['sub'] as number)
        } else if (msg['event']) {
          entry.onEvent(msg['event'] as PultEvent)
        }
        continue
      }
      const id = msg['id']
      if (typeof id === 'number') {
        const p = pending.get(id)
        if (!p) continue
        pending.delete(id)
        if (msg['error']) {
          pendingSubs.delete(id)
          const e = msg['error'] as RpcError
          p.reject(new ClientError(e.code, e.message))
        } else {
          const waiter = pendingSubs.get(id)
          if (waiter) {
            pendingSubs.delete(id)
            const subNo = (msg['result'] as { sub?: unknown } | null)?.sub
            if (typeof subNo === 'number') subs.set(subNo, waiter)
          }
          p.resolve(msg['result'])
        }
      }
    }
  })

  socket.on('close', () => {
    closed = true
    for (const p of pending.values()) p.reject(new ClientError('connection_closed', tr('соединение с демоном закрыто')))
    pending.clear()
    for (const fn of closeHandlers) { try { fn() } catch { /* неважно */ } }
  })
  socket.on('error', () => { /* разбираемся по close */ })

  const daemon = await new Promise<DaemonInfo>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ClientError('timeout', tr('демон не ответил на hello'))),
      timeoutMs,
    )
    // Оба исхода снимают таймер: висящий таймер держал бы процесс CLI живым после ответа.
    helloResolve = (info) => { clearTimeout(timer); resolve(info) }
    helloReject = (e) => { clearTimeout(timer); reject(e) }
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new ClientError('connection_closed', tr('демон закрыл соединение на рукопожатии')))
    })
    const client = opts.client ?? 'cli'
    const app = client === 'shell' ? shellApp() : null
    socket.write(encodeLine({ type: 'hello', token, client, protocol: PROTOCOL_VERSION, ...(app ? { app } : {}) }))
  })

  const send = (
    method: string,
    params?: Record<string, unknown>,
    subWaiter?: SubHandler,
  ): Promise<unknown> => {
    if (closed) return Promise.reject(new ClientError('connection_closed', tr('соединение закрыто')))
    const id = ++seq
    const line = encodeLine({ id, method, locale: opts.locale?.() ?? getLanguage(), ...(params ? { params } : {}) })
    // Строку длиннее предела демон не читает, а РВЁТ соединение целиком — и с ним все прочие
    // вызовы и подписки на нём (у окна оно одно на всё). Отказываем здесь, ничего не отправляя.
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_LINE_BYTES) {
      return Promise.reject(new ClientError('payload_too_large', tr`запрос ${method} — ${bytes} байт, больше предела строки ${MAX_LINE_BYTES}: не отправлен`))
    }
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (subWaiter) pendingSubs.set(id, subWaiter)
      socket.write(line)
    })
  }

  const request = (method: string, params?: Record<string, unknown>, ropts: { timeoutMs?: number } = {}): Promise<unknown> => {
    const p = send(method, params)
    const ms = ropts.timeoutMs
    if (ms === undefined) return p
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ClientError('timeout', tr`демон не ответил на ${method} за ${ms} мс`))
        // Соединение закрывается: ответ, пришедший позже, уже никому не нужен, а висящий сокет
        // держал бы процесс CLI. Промис `p` отвергнется по close — его отказ поглощён ниже.
        socket.destroy()
      }, ms)
      p.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e: unknown) => { clearTimeout(timer); reject(e) },
      )
    })
  }

  return {
    daemon,
    request,
    async subscribe(params, onEvent, onEnd) {
      const result = (await send(
        'events.subscribe',
        params as Record<string, unknown>,
        { onEvent, ...(onEnd ? { onEnd } : {}) },
      )) as { sub: number; cursor?: number }
      return { sub: result.sub, cursor: result.cursor ?? 0 }
    },
    close() {
      closed = true
      socket.destroy()
    },
    onClose(fn) { closeHandlers.push(fn) },
  }
}
