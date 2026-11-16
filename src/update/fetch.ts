// Сеть канала обновлений: один GET за latest.json и один за тарбол — больше Пульт никуда не ходит.
//
// ПОЧЕМУ fetch Node, а не curl (как у своего node в runtime.ts):
//   * редиректы — руками (`redirect: 'manual'`): каждый адрес цепочки проверяется на https ДО запроса
//     к нему. GitHub отдаёт релиз через 302 на objects.githubusercontent.com — это https и проходит;
//     у curl то же обещает `--proto-redir`, но проверить его в тесте можно только фальшивым curl;
//   * потолок размера — по ПРОЧИТАННЫМ байтам, а не по Content-Length (его может не быть или он врёт);
//   * демон не спавнит процесс раз в сутки, а тест подставляет функцию запроса (`HttpGet`) и ни одного
//     правила не ослабляет — https проверяется и для неё.
// Цена: fetch Node 22–24 не читает HTTPS_PROXY. Демон под launchd прокси-переменных и не видит (они у
// владельца в функции zsh, config.ts), а GitHub доступен напрямую; понадобится прокси — это `updates.proxy`
// следующей вехи, не повод сейчас терять контроль над редиректами.

import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fsyncSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { VERSION } from '../core/version.js'

export class FetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

/** Ответ одного запроса (без следования редиректам). */
export interface HttpResponse {
  status: number
  header(name: string): string | null
  body: AsyncIterable<Uint8Array> | null
  /** Бросить тело, которое не будем читать (редирект, ошибка): иначе соединение висит до таймаута. */
  cancel?(): void
}

/** Один GET без следования редиректам. Тест подставляет свою; в бою — `nodeHttpGet`. */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<HttpResponse>

export const MAX_REDIRECTS = 5
export const MANIFEST_TIMEOUT_MS = 30_000
/** Тарбол ~2 МБ, но канал бывает любым: общий потолок большой, а «ни байта за минуту» обрывает раньше. */
export const PACKAGE_TIMEOUT_MS = 15 * 60_000
export const IDLE_TIMEOUT_MS = 60_000

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export const nodeHttpGet: HttpGet = async (url, signal) => {
  const r = await fetch(url, {
    redirect: 'manual',
    signal,
    headers: { 'user-agent': `pult/${VERSION}`, accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.1' },
  })
  return {
    status: r.status,
    header: (n) => r.headers.get(n),
    body: r.body as unknown as AsyncIterable<Uint8Array> | null,
    cancel: () => { void r.body?.cancel().catch(() => { /* уже закрыто */ }) },
  }
}

/**
 * Тестовый «сервер»: адрес https://<любой>/…/<имя> отдаётся файлом `<dir>/<имя>`, нет файла — 404.
 * Только под PULT_TEST=1 (`httpFor`): сквозные тесты CLI и окна поднимают Пульт отдельным процессом,
 * и инъекцию туда не передать иначе, чем окружением, — как PULT_TEST_NODE_TARBALL у своего node.
 */
export function dirHttpGet(dir: string): HttpGet {
  return async (url) => {
    const name = basename(new URL(url).pathname)
    const file = join(dir, name)
    if (!name || !existsSync(file) || !statSync(file).isFile()) return { status: 404, header: () => null, body: null }
    const size = statSync(file).size
    return {
      status: 200,
      header: (n) => (n.toLowerCase() === 'content-length' ? String(size) : null),
      body: createReadStream(file),
    }
  }
}

/** Чем ходить в сеть. В тестах (PULT_TEST=1) — никогда в настоящую: только PULT_TEST_UPDATE_DIR. */
export function httpFor(env: NodeJS.ProcessEnv): HttpGet {
  if (env['PULT_TEST'] === '1' || process.env['PULT_TEST'] === '1') {
    const dir = env['PULT_TEST_UPDATE_DIR'] ?? process.env['PULT_TEST_UPDATE_DIR']
    if (!dir) return async () => { throw new FetchError('PULT_TEST=1: сеть в тестах не трогается — нужен PULT_TEST_UPDATE_DIR') }
    return dirHttpGet(dir)
  }
  return nodeHttpGet
}

function requireHttps(url: string, what: string): string {
  let u: URL
  try { u = new URL(url) } catch { throw new FetchError(`${what}: «${url.slice(0, 200)}» — не адрес`) }
  if (u.protocol !== 'https:') throw new FetchError(`${what}: только https, а здесь ${u.protocol.replace(/:$/, '')} (${u.host})`)
  if (u.username || u.password) throw new FetchError(`${what}: логин в адресе не принимается`)
  return u.href
}

/** Таймер общего потолка и таймер тишины на одном AbortController. */
function deadline(totalMs: number, idleMs: number | null): { signal: AbortSignal; touch(): void; done(): void; why(): string } {
  const ac = new AbortController()
  let reason = ''
  const total = setTimeout(() => { reason = `таймаут ${Math.ceil(totalMs / 1000)} с`; ac.abort() }, totalMs)
  total.unref?.()
  let idle: NodeJS.Timeout | null = null
  const touch = (): void => {
    if (idleMs === null) return
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => { reason = `ни байта за ${Math.ceil(idleMs / 1000)} с`; ac.abort() }, idleMs)
    idle.unref?.()
  }
  touch()
  return {
    signal: ac.signal,
    touch,
    done: () => { clearTimeout(total); if (idle) clearTimeout(idle) },
    why: () => reason,
  }
}

/** Запрос с редиректами: каждый адрес цепочки — только https, не больше MAX_REDIRECTS переходов. */
async function openFollowing(url: string, http: HttpGet, signal: AbortSignal, what: string): Promise<{ res: HttpResponse; url: string }> {
  let cur = requireHttps(url, what)
  for (let hop = 0; ; hop++) {
    const res = await http(cur, signal)
    if (REDIRECTS.has(res.status)) {
      res.cancel?.()
      if (hop >= MAX_REDIRECTS) throw new FetchError(`${what}: больше ${MAX_REDIRECTS} редиректов`)
      const loc = res.header('location')
      if (!loc) throw new FetchError(`${what}: редирект ${res.status} без адреса`)
      let next: string
      try { next = new URL(loc, cur).href } catch { throw new FetchError(`${what}: редирект на «${loc.slice(0, 200)}» — не адрес`) }
      cur = requireHttps(next, `${what}: редирект`)
      continue
    }
    if (res.status !== 200) {
      res.cancel?.()
      throw new FetchError(`${what}: ${cur} ответил HTTP ${res.status}`)
    }
    return { res, url: cur }
  }
}

const declaredLength = (res: HttpResponse): number | null => {
  const v = res.header('content-length')
  if (v === null || !/^\d+$/.test(v.trim())) return null
  return Number(v.trim())
}

function wrapAbort(e: unknown, d: { why(): string }, what: string): Error {
  if (e instanceof FetchError) return e
  const why = d.why()
  if (why) return new FetchError(`${what}: ${why}`)
  const err = e as Error & { cause?: { code?: string; message?: string } }
  // fetch прячет настоящую причину (DNS, TLS, отказ соединения) в cause — её и показываем.
  const cause = err.cause?.code ?? err.cause?.message
  return new FetchError(`${what}: ${err.message}${cause ? ` (${cause})` : ''}`)
}

export interface FetchBytesOptions {
  http: HttpGet
  maxBytes: number
  timeoutMs?: number
  what: string
}

/** Небольшой файл целиком в память (latest.json): потолок по прочитанным байтам, общий таймаут. */
export async function fetchBytes(url: string, opts: FetchBytesOptions): Promise<Buffer> {
  const d = deadline(opts.timeoutMs ?? MANIFEST_TIMEOUT_MS, null)
  try {
    const { res } = await openFollowing(url, opts.http, d.signal, opts.what)
    const declared = declaredLength(res)
    if (declared !== null && declared > opts.maxBytes) {
      res.cancel?.()
      throw new FetchError(`${opts.what}: ${declared} байт — больше потолка ${opts.maxBytes}`)
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res.body ?? []) {
      total += chunk.length
      if (total > opts.maxBytes) {
        res.cancel?.()
        throw new FetchError(`${opts.what}: больше потолка ${opts.maxBytes} байт — дочитывать не стал`)
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch (e) {
    throw wrapAbort(e, d, opts.what)
  } finally {
    d.done()
  }
}

/** writeSync пишет не обязательно всё: дописать остаток, пока кусок не ляжет целиком. */
export function writeAll(fd: number, chunk: Uint8Array, write: (fd: number, b: Uint8Array) => number = (f, b) => writeSync(f, b)): void {
  let off = 0
  while (off < chunk.length) {
    const n = write(fd, chunk.subarray(off))
    if (!(n > 0)) throw new FetchError(`запись на диск вернула ${n} байт`)
    off += n
  }
}

async function sha256File(file: string): Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256')
  let size = 0
  for await (const b of createReadStream(file)) { size += (b as Buffer).length; h.update(b as Buffer) }
  return { size, sha256: h.digest('hex') }
}

export interface DownloadProgress { received: number; total: number; percent: number }

export interface DownloadOptions {
  http: HttpGet
  /** Размер из манифеста: больше — обрыв посреди загрузки, меньше — отказ в конце. */
  size: number
  sha256: string
  timeoutMs?: number
  idleMs?: number
  what: string
  onProgress?: (progress: DownloadProgress) => void
}

/**
 * Скачать в `file` (создаётся заново, 0600) и сверить размер и sha256 с манифестом. Любой провал —
 * файла нет: недокачанный или чужой тарбол не должен дожить до `npm install`.
 */
export async function downloadTo(url: string, file: string, opts: DownloadOptions): Promise<void> {
  const d = deadline(opts.timeoutMs ?? PACKAGE_TIMEOUT_MS, opts.idleMs ?? IDLE_TIMEOUT_MS)
  const hash = createHash('sha256')
  let fd: number | null = null
  let created = false
  let total = 0
  let lastPercent = -1
  const report = (verified = false): void => {
    const percent = verified ? 100 : Math.min(99, Math.floor(total * 100 / opts.size))
    if (percent === lastPercent) return
    lastPercent = percent
    // A closed UI/IPC channel must not invalidate a signed download.
    try { opts.onProgress?.({ received: total, total: opts.size, percent }) } catch { /* progress is advisory */ }
  }
  try {
    const { res } = await openFollowing(url, opts.http, d.signal, opts.what)
    const declared = declaredLength(res)
    if (declared !== null && declared !== opts.size) {
      res.cancel?.()
      throw new FetchError(`${opts.what}: сервер обещает ${declared} байт, манифест — ${opts.size}`)
    }
    fd = openSync(file, 'wx', 0o600)
    created = true
    report()
    for await (const chunk of res.body ?? []) {
      d.touch()
      total += chunk.length
      if (total > opts.size) {
        res.cancel?.()
        throw new FetchError(`${opts.what}: больше ${opts.size} байт из манифеста — дочитывать не стал`)
      }
      hash.update(chunk)
      writeAll(fd, chunk)
      report()
    }
    if (total !== opts.size) throw new FetchError(`${opts.what}: пришло ${total} байт, манифест обещал ${opts.size}`)
    const got = hash.digest('hex')
    if (got !== opts.sha256) throw new FetchError(`${opts.what}: sha256 ${got.slice(0, 12)}… не совпадает с манифестом ${opts.sha256.slice(0, 12)}… — файл подменён или испорчен`)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    // Сумма по сети — про байты, которые ПРИШЛИ; ставить будем байты, которые ЛЕЖАТ. Перечитать файл
    // дешевле (тарбол ~2 МБ), чем спорить, что диск записал ровно то же.
    const onDisk = await sha256File(file)
    if (onDisk.size !== opts.size || onDisk.sha256 !== opts.sha256) throw new FetchError(`${opts.what}: на диске не те байты, что пришли (${onDisk.size} байт, sha256 ${onDisk.sha256.slice(0, 12)}…)`)
    report(true)
  } catch (e) {
    if (fd !== null) { try { closeSync(fd) } catch { /* уже закрыт */ } fd = null }
    if (created) { try { unlinkSync(file) } catch { /* уже нет */ } }
    throw wrapAbort(e, d, opts.what)
  } finally {
    if (fd !== null) closeSync(fd)
    d.done()
  }
}
