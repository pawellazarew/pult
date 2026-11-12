// Журнал демона: JSONL в PULT_HOME/logs/pultd.log.
// Инвариант 7: в журнал не попадают токены, ключи и пароли. Почта остаётся читаемой.
// Фильтр стоит НА ЗАПИСИ, а не
// на вызывающем коде — иначе один забытый `log.info(err)` в адаптере сливает ключ.

import { closeSync, fstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Имена полей, чьи значения вырезаются целиком, чем бы они ни были. */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i

const VALUE_RULES: Array<{ re: RegExp; to: string }> = [
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, to: '<token>' },
  { re: /\bsk-[A-Za-z0-9]{16,}/g, to: '<token>' },
  // Ключи OpenAI нового вида: `sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`. Правило выше их НЕ ловит —
  // после `sk-` идут 4–7 букв и дефис. Первым такой ключ мог бы напечатать `codex login status`
  // (он маскирует, но проверять чужую маску Пульт не обязан) — В5, строка «Подписка codex».
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g, to: '<token>' },
  { re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{16,}/g, to: '<token>' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, to: '<token>' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: '<token>' },
  { re: /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{16,}=*/g, to: '<token>' },
  // Логин и пароль внутри URL: так выглядит прокси вида http://user:pass@host:port, который
  // владелец мог написать в config.json и который иначе уехал бы в отчёт доктора как есть.
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, to: '$1<redacted>@' },
  // Длинная шестнадцатеричная строка — это наш собственный токен сокета (64 символа)
  // и любой похожий на него секрет.
  { re: /\b[0-9a-f]{32,}\b/gi, to: '<token>' },
]

export function redactString(s: string): string {
  let out = s
  for (const rule of VALUE_RULES) out = out.replace(rule.re, rule.to)
  return out
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_NAME_RE.test(k) ? '<redacted>' : redact(v, depth + 1)
  }
  return out
}

export interface Logger {
  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  close(): void
}

export interface LoggerOptions {
  /** Дублировать строки в stdout — для запуска демона на переднем плане. */
  echo?: boolean
  pid?: number
  /** Предел одного файла; сохраняются ещё backups предыдущих файлов. */
  maxBytes?: number
  backups?: number
}

export function createLogger(file: string, opts: LoggerOptions = {}): Logger {
  const maxBytes = Math.max(256, opts.maxBytes ?? 8 * 1024 * 1024)
  const backups = Math.max(1, Math.min(10, Math.floor(opts.backups ?? 3)))
  let fd: number | null = null
  let size = 0
  let closed = false
  const open = (): void => {
    fd = openSync(file, 'a', 0o600)
    size = fstatSync(fd).size
  }
  try { open() } catch { fd = null }
  const pid = opts.pid ?? process.pid

  const rotate = (): void => {
    if (fd !== null) { closeSync(fd); fd = null }
    try { unlinkSync(`${file}.${backups}`) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    for (let n = backups - 1; n >= 1; n--) {
      try { renameSync(`${file}.${n}`, `${file}.${n + 1}`) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    try { renameSync(file, `${file}.1`) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    open()
  }
  const write = (line: string): void => {
    if (closed) return
    try {
      if (fd === null) open()
      const bytes = Buffer.from(line)
      if (size > 0 && size + bytes.length > maxBytes) rotate()
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd!, bytes, offset, bytes.length - offset)
      size += bytes.length
    } catch { /* Ошибка диагностического журнала не должна ронять демон. */ }
    if (opts.echo) { try { process.stdout.write(line) } catch { /* stdout закрыт */ } }
  }

  const log = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    const rec = {
      ts: new Date().toISOString(),
      level,
      pid,
      msg: redactString(msg),
      ...(data ? (redact(data) as Record<string, unknown>) : {}),
    }
    let line = JSON.stringify(rec) + '\n'
    // Один stderr от CLI тоже не должен обходить предел файла.
    if (Buffer.byteLength(line) > maxBytes) {
      line = JSON.stringify({ ts: rec.ts, level, pid, msg: 'log entry truncated', truncated: true }) + '\n'
    }
    write(line)
  }

  return {
    log,
    debug: (m, d) => log('debug', m, d),
    info: (m, d) => log('info', m, d),
    warn: (m, d) => log('warn', m, d),
    error: (m, d) => log('error', m, d),
    close: () => {
      closed = true
      if (fd !== null) { try { closeSync(fd) } catch { /* уже закрыт */ } fd = null }
    },
  }
}
