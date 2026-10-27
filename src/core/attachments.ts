// Уборка `PULT_HOME/attachments` — картинок, вставленных из буфера в окне (окно 0.1.16, shell/src/clipboardImage.ts):
// `attachments/<сессия>/<день>/paste-*.png`. Демон удаляет файлы старше 30 дней на старте и раз в сутки, потом —
// опустевшие старые папки. Здесь же — папка сессии для `--add-dir` claude (`sessionAttachmentsDirs`).
//
// Границы, которые нельзя нарушать:
//   * ничего вне `attachments/`: обход только вниз от неё, имена из `readdir` (без `..` и абсолютных путей);
//   * симлинки не раскрываются никогда: `lstat`, по ссылке на папку не спускаемся; сама ссылка — файл, старая удаляется
//     `unlink` (он удаляет ссылку, а не то, куда она ведёт). `attachments` сама симлинк — не трогаем ничего;
//   * без `rm -r`: только `unlink` файлов и `rmdir` ПУСТЫХ папок — даже ошибка в счёте возраста не снесёт дерево разом.

import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_NAME_RE } from '../sessions/registry.js'

export const ATTACHMENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const ATTACHMENTS_SWEEP_MS = 24 * 60 * 60 * 1000
/** Глубина обхода: `attachments/<сессия>/<день>/<файл>` — 3; запас на случай вложенности, но не бесконечно. */
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
    let before
    try { before = lstatSync(d) } catch { r.errors++; return false }
    let names: string[]
    try { names = readdirSync(d) } catch { r.errors++; return false }
    // Папку подменили между lstat и readdir (симлинком на чужую) — не трогаем ничего из прочитанного.
    try {
      const after = lstatSync(d)
      if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) { r.errors++; return false }
    } catch { r.errors++; return false }
    let left = names.length
    for (const name of names) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) { r.errors++; continue }
      const p = join(d, name)
      let st
      try { st = lstatSync(p) } catch { left--; continue }
      // Другая файловая система (точка монтирования внутри attachments) — не наша, не заходим и не удаляем.
      if (st.dev !== top.dev) continue
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

/** Папка 0700 без раскрытия симлинков: создать, если нет; на её месте симлинк или файл — false. */
function privateDir(dir: string): boolean {
  try { mkdirSync(dir, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false }
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    chmodSync(dir, 0o700)
    return true
  } catch { return false }
}

/**
 * Папка картинок сессии для `--add-dir` (ревью #17): `PULT_HOME/attachments/<сессия>` — своя у каждой сессии, иначе
 * сессия читала (а в `workspace` и правила) картинки всех остальных. Пусто, если имя не по правилу, если `attachments` или
 * папка сессии — симлинк или не папка, или если realpath папки не равен `realpath(PULT_HOME)/attachments/<сессия>`
 * (подмена симлинком на ~ выше по пути). Иначе — путь как есть и по realpath (на macOS `/var/…` — это `/private/var/…`).
 */
export function sessionAttachmentsDirs(home: string, session: string): string[] {
  if (!SESSION_NAME_RE.test(session)) return []
  const root = join(home, 'attachments')
  const dir = join(root, session)
  if (!privateDir(root) || !privateDir(dir)) return []
  try {
    const want = join(realpathSync(home), 'attachments', session)
    const real = realpathSync(dir)
    if (real !== want) return []
    return [...new Set([dir, real])]
  } catch { return [] }
}
