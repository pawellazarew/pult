// Чтение небольших файлов, которые может подложить кто угодно с правом записи в папку проекта (агент в «Правках в
// папке», скачанный архив): служебные файлы git и настройки Claude проекта. Демон читает их синхронно на `agent.start`,
// `agent.preflight` и `agent.list`, поэтому файл обязан быть ОБЫЧНЫМ и маленьким: FIFO, `/dev/zero`, сокет или
// многогигабайтный файл дают `null`, а не зависание или съеденную память (ревью шага B, Opus M1, Codex recheck 10).
//
//   * `follow: false` — сам путь не симлинк (служебные файлы git: их пишет только git);
//   * `follow: true` — симлинк можно (настройки Claude часто лежат ссылкой из репозитория dotfiles), но цель — обычный
//     файл; проверка — `fstat` по уже открытому дескриптору, так что подмена между проверкой и чтением не проходит.
// Открытие всегда с `O_NONBLOCK`: FIFO без писателя не повесит `open`.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'

export function readRegularFile(file: string, opts: { max: number; follow: boolean }): string | null {
  try {
    const st = opts.follow ? statSync(file) : lstatSync(file)
    if (!st.isFile() || st.size > opts.max) return null
  } catch { return null }
  let fd: number | null = null
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (opts.follow ? 0 : constants.O_NOFOLLOW))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > opts.max) return null
    const buf = Buffer.alloc(opts.max + 1)
    let n = 0
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null)
      if (got <= 0) break
      n += got
      if (n > opts.max) return null
    }
    return buf.subarray(0, n).toString('utf8')
  } catch { return null } finally { if (fd !== null) try { closeSync(fd) } catch { /* уже закрыт */ } }
}
