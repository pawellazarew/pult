// Короткая команда БЕЗ остановки событийного цикла: `--version`, `auth status`, логин-шелл.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ (замер 30.09.2026, настоящий launchd). `spawnSync` держит событийный цикл
// на всё время жизни ребёнка, а у демона цикл один на все сессии, подписки и рукопожатия. Доктор
// звал так семь `--version`, `claude auth status` и `codex login status` подряд: под службой с
// фоновым приоритетом (`ProcessType Background`: тот же набор запусков шёл в 17 раз дольше) демон
// молчал 19 с на тестовой службе и 44–94 с на рабочей — `hello` новых клиентов падал по
// таймауту 10 с. Короткие команды доктора демон запускает только через эту функцию.
//
// Потолок по времени — с добиванием SIGKILL и ответом СРАЗУ: внук, унаследовавший трубу (rc-файл
// логин-шелла оставил фонового ребёнка), иначе держал бы `close` и вызывающего сколько угодно.
// По той же причине ответ не ждёт `close` дольше EXIT_GRACE_MS после выхода самого процесса: его код
// и вывод уже есть, а труба, которую держит внук, закроется, когда тот захочет.

import { spawn } from 'node:child_process'

export interface ExecResult {
  /** Код выхода; `null` — не запустился, убит сигналом или добит по таймауту (как у spawnSync). */
  status: number | null
  stdout: string
  stderr: string
  /** Почему `status` пуст: ошибка спавна (`ENOENT`…) или таймаут. */
  error?: string
}

export interface ExecOptions {
  timeoutMs: number
  /** Optional UTF-8 stdin. It never becomes a command argument or shell source. */
  input?: string
  env?: Record<string, string>
  /** Предел на каждый поток вывода; сверх него ребёнок добивается. По умолчанию 4 МБ. */
  maxBuffer?: number
  /** Рабочая папка ребёнка; нет — папка демона. */
  cwd?: string
}

/** Сколько после выхода процесса ждать закрытия его труб (остаток вывода приходит за миллисекунды). */
export const EXIT_GRACE_MS = 250

export function execAsync(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 4 * 1024 * 1024
  return new Promise<ExecResult>((resolve) => {
    let child
    try {
      child = spawn(file, args, { ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: (e as Error).message })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const done = (status: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      clearTimeout(grace)
      resolve({ status, stdout, stderr, ...(error !== undefined ? { error } : {}) })
    }
    const kill = (why: string): void => {
      try { child.kill('SIGKILL') } catch { /* уже ушёл */ }
      child.stdout?.destroy()
      child.stderr?.destroy()
      done(null, why)
    }
    const killer = setTimeout(() => kill(`добит по таймауту ${opts.timeoutMs} мс`), opts.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d; if (stdout.length > maxBuffer) kill('вывод больше предела') })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => { stderr += d; if (stderr.length > maxBuffer) kill('вывод больше предела') })
    child.on('error', (e) => { done(null, e.message) })
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => { /* Early child exit is reported by its exit status. */ })
      child.stdin?.end(opts.input, 'utf8')
    }
    child.on('close', (code) => { done(code) })
    child.on('exit', (code) => {
      grace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        done(code)
      }, EXIT_GRACE_MS)
    })
  })
}
