// Уборка `PULT_HOME/attachments` — картинок, вставленных из буфера в окне (окно 0.1.16, shell/src/clipboardImage.ts).
// Демон удаляет файлы старше 30 дней на старте и раз в сутки, потом — опустевшие папки дней.
//
// Границы, которые нельзя нарушать:
//   * ничего вне `attachments/`: обход только вниз от неё, имена из `readdir` (без `..` и абсолютных путей);
//   * симлинки не раскрываются никогда: `lstat`, по ссылке на папку не спускаемся; сама ссылка — файл, старая удаляется
//     `unlink` (он удаляет ссылку, а не то, куда она ведёт). `attachments` сама симлинк — не трогаем ничего;
//   * без `rm -r`: только `unlink` файлов и `rmdir` ПУСТЫХ папок — даже ошибка в счёте возраста не снесёт дерево разом.

import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const ATTACHMENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const ATTACHMENTS_SWEEP_MS = 24 * 60 * 60 * 1000
/** Глубина обхода: `attachments/<день>/<файл>` — 2; запас на случай вложенности, но не бесконечно. */
const MAX_DEPTH = 4

export interface SweepResult { files: number; dirs: number; errors: number }

/** Удалить файлы старше `maxAgeMs` (по mtime) и опустевшие папки под `dir`. Сама `dir` остаётся. */
export function sweepAttachments(dir: string, now: number = Date.now(), maxAgeMs: number = ATTACHMENTS_MAX_AGE_MS): SweepResult {
  const r: SweepResult = { files: 0, dirs: 0, errors: 0 }
  let top
  try { top = lstatSync(dir) } catch { return r }
  if (top.isSymbolicLink() || !top.isDirectory()) return r
  const cutoff = now - maxAgeMs
  const walk = (d: string, depth: number): boolean => {
    let names: string[]
    try { names = readdirSync(d) } catch { r.errors++; return false }
    let left = names.length
    for (const name of names) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) { r.errors++; continue }
      const p = join(d, name)
      let st
      try { st = lstatSync(p) } catch { left--; continue }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if (depth >= MAX_DEPTH) continue
        // Папка пуста после уборки и сама старая — убрать. Свежую пустую (день, который окно только что завело) не трогаем.
        if (walk(p, depth + 1) && st.mtimeMs < cutoff) {
          try { rmdirSync(p); r.dirs++; left-- } catch { r.errors++ }
        }
        continue
      }
      if (st.mtimeMs >= cutoff) continue
      try { unlinkSync(p); r.files++; left-- } catch { r.errors++ }
    }
    return left === 0
  }
  walk(dir, 1)
  return r
}
