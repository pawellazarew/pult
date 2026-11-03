// Память папок (быстрый старт, шаг B; design/2026-11-02-quick-start §3.9): история папок, в которых заводились чаты,
// и запомненный доступ каждой — `PULT_HOME/folders.json`, 0600. `projects.json` (закрепления) не трогается: у него
// свой смысл и свой лимит.
//
// КЛЮЧ — настоящая папка (`realpath`), а не путь, как его выбрали: `~/src/app` и симлинк на неё — одна папка. Рядом
// хранится `(dev, ino)`: папку заменили (удалили и создали заново, `git clone` поверх) или симлинк перенаправили на
// другую — ключ тот же, а inode другой, и память доступа НЕ применяется («папка изменилась — доступ сброшен»).
// Совпадение только точное: вложенные и родительские папки ничего не наследуют (полный доступ к `~/src` не даёт его
// `~/src/app`).
//
// WORKTREE. Папка git worktree пишет в ключ основного репозитория: чат в `pult/<имя>` и чат в самом репо — одна папка
// для человека. Основной репозиторий находится по файлу `.git` worktree (`gitdir: …/.git/worktrees/<имя>`, рядом
// `commondir`) — то же, что `git rev-parse --git-common-dir`, но без процесса git на каждый вопрос.
//
// ЗАПИСЬ ДОСТУПА — только реальный старт или смена доступа в живом чате (решает сервер, src/sessions/resolve.ts
// `shouldRemember`); брошенный черновик сюда не пишет никогда.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ApprovalMode } from '../adapters/types.js'
import { isApprovalMode } from '../adapters/types.js'
import { atomicWrite } from '../service/fsutil.js'

/** Записей держим не больше; вытесняются только записи БЕЗ памяти доступа, самые старые. */
export const FOLDERS_MAX = 500

export interface FolderEntry {
  /** Путь, как его выбрал человек в последний раз (для показа). */
  display: string
  /** `dev` и `ino` папки — строками: у APFS inode 64-битный. */
  dev: string
  ino: string
  lastUsedAt?: string
  access?: ApprovalMode
  accessSetAt?: string
}

export interface FolderIdentity {
  key: string
  display: string
  dev: string
  ino: string
}

/** Основной репозиторий для папки git worktree; не worktree — `null`. */
export function worktreeMainRepo(dir: string): string | null {
  let gitFile: string
  try {
    const st = statSync(join(dir, '.git'))
    if (!st.isFile()) return null
    gitFile = readFileSync(join(dir, '.git'), 'utf8')
  } catch { return null }
  const m = /^gitdir:\s*(.+)\s*$/m.exec(gitFile)
  if (!m) return null
  const gitdir = resolve(dir, (m[1] as string).trim())
  let common: string
  try { common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()) } catch { return null }
  // Обычная раскладка: `<repo>/.git` — основной репозиторий `<repo>`. Голый репозиторий — его папка и есть ключ.
  return common.endsWith('/.git') ? dirname(common) : common
}

/** Ключ папки: настоящая папка (у worktree — основной репозиторий), её `(dev, ino)`; нет папки — `null`. */
export function folderIdentity(path: string): FolderIdentity | null {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
  const real = (p: string): string | null => { try { return realpathSync.native(p) } catch { return null } }
  let key = real(path)
  if (!key) return null
  const main = worktreeMainRepo(key)
  if (main) key = real(main) ?? key
  try {
    const st = statSync(key, { bigint: true })
    if (!st.isDirectory()) return null
    return { key, display: resolve(path), dev: String(st.dev), ino: String(st.ino) }
  } catch { return null }
}

export interface FolderRecall {
  key: string
  display: string
  /** Запомненный доступ; нет — памяти нет (или папка изменилась). */
  access?: ApprovalMode
  accessSetAt?: string
  /** Память была, но `(dev, ino)` не совпали: папку заменили или симлинк перенаправили — доступ сброшен. */
  changed?: true
  lastUsedAt?: string
}

export interface RecentFolder { path: string; key: string; lastUsedAt: string; access?: ApprovalMode }

export interface FolderStore {
  /** Что Пульт помнит о папке. Папки нет — `null`. */
  recall(path: string): FolderRecall | null
  /** Чат заведён в папке: история (последняя папка, «Где работаем?»). */
  use(path: string, at?: Date): FolderRecall | null
  /** Запомнить доступ папки (реальный старт или смена в живом чате). */
  remember(path: string, access: ApprovalMode, at?: Date): FolderRecall | null
  /** «Забыть папку»: и историю, и доступ. */
  forget(path: string): boolean
  /** «Очистить историю»: записи без памяти доступа уходят, у остальных — без даты. */
  clearHistory(): number
  /** Папки по истории, новые первыми (только существующие и с тем же inode). */
  recent(limit: number): RecentFolder[]
  /** Все записи (для «Настройки → Папки»). */
  entries(): Array<FolderEntry & { key: string }>
}

interface FoldersFile { version: 1; rev: number; folders: Record<string, FolderEntry> }

function parseFolders(raw: unknown): FoldersFile {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const rev = typeof o['rev'] === 'number' && Number.isSafeInteger(o['rev']) && o['rev'] >= 0 ? o['rev'] : 0
  const src = o['folders'] && typeof o['folders'] === 'object' && !Array.isArray(o['folders']) ? o['folders'] as Record<string, unknown> : {}
  const folders: Record<string, FolderEntry> = Object.create(null) as Record<string, FolderEntry>
  for (const [key, v] of Object.entries(src)) {
    if (!isAbsolute(key) || key.includes('\0') || !v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (typeof e['dev'] !== 'string' || typeof e['ino'] !== 'string') continue
    const at = (k: string): string | undefined => (typeof e[k] === 'string' && Number.isFinite(Date.parse(e[k] as string)) ? e[k] as string : undefined)
    const lastUsedAt = at('lastUsedAt')
    const accessSetAt = at('accessSetAt')
    // Кривой уровень — памяти нет (тише, а не шире).
    const access = isApprovalMode(e['access']) ? e['access'] : undefined
    folders[key] = {
      display: typeof e['display'] === 'string' && isAbsolute(e['display']) ? e['display'] : key,
      dev: e['dev'], ino: e['ino'],
      ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(access ? { access, ...(accessSetAt ? { accessSetAt } : {}) } : {}),
    }
  }
  return { version: 1, rev, folders }
}

export function createFolderStore(file: string, now: () => Date = () => new Date()): FolderStore {
  let data: FoldersFile
  try { data = parseFolders(JSON.parse(readFileSync(file, 'utf8'))) } catch { data = { version: 1, rev: 0, folders: Object.create(null) as Record<string, FolderEntry> } }
  const save = (): void => {
    data.rev += 1
    atomicWrite(file, JSON.stringify(data, null, 2) + '\n', 0o600)
  }
  const evict = (): void => {
    const keys = Object.keys(data.folders)
    if (keys.length <= FOLDERS_MAX) return
    const plain = keys.filter((k) => !data.folders[k]?.access)
      .sort((a, b) => (data.folders[a]?.lastUsedAt ?? '').localeCompare(data.folders[b]?.lastUsedAt ?? ''))
    for (const k of plain.slice(0, keys.length - FOLDERS_MAX)) delete data.folders[k]
  }
  const view = (id: FolderIdentity, e: FolderEntry | undefined): FolderRecall => {
    const same = !!e && e.dev === id.dev && e.ino === id.ino
    return {
      key: id.key, display: id.display,
      ...(e && same && e.access ? { access: e.access, ...(e.accessSetAt ? { accessSetAt: e.accessSetAt } : {}) } : {}),
      ...(e && !same && e.access ? { changed: true as const } : {}),
      ...(e && same && e.lastUsedAt ? { lastUsedAt: e.lastUsedAt } : {}),
    }
  }
  /** Запись для папки: та же папка — как была; папку заменили — без памяти (inode другой). */
  const entryFor = (id: FolderIdentity): FolderEntry => {
    const e = data.folders[id.key]
    if (e && e.dev === id.dev && e.ino === id.ino) return { ...e, display: id.display }
    return { display: id.display, dev: id.dev, ino: id.ino }
  }
  return {
    recall(path) {
      const id = folderIdentity(path)
      return id ? view(id, data.folders[id.key]) : null
    },
    use(path, at = now()) {
      const id = folderIdentity(path)
      if (!id) return null
      data.folders[id.key] = { ...entryFor(id), lastUsedAt: at.toISOString() }
      evict()
      save()
      return view(id, data.folders[id.key])
    },
    remember(path, access, at = now()) {
      const id = folderIdentity(path)
      if (!id) return null
      data.folders[id.key] = { ...entryFor(id), access, accessSetAt: at.toISOString() }
      evict()
      save()
      return view(id, data.folders[id.key])
    },
    forget(path) {
      const id = folderIdentity(path)
      const key = id?.key ?? (isAbsolute(path) ? resolve(path) : null)
      if (!key || !data.folders[key]) return false
      delete data.folders[key]
      save()
      return true
    },
    clearHistory() {
      let n = 0
      for (const [k, e] of Object.entries(data.folders)) {
        if (!e.access) { delete data.folders[k]; n++ } else if (e.lastUsedAt) { delete e.lastUsedAt; n++ }
      }
      if (n) save()
      return n
    },
    recent(limit) {
      const out: RecentFolder[] = []
      const list = Object.entries(data.folders).filter(([, e]) => e.lastUsedAt)
        .sort(([, a], [, b]) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
      for (const [key, e] of list) {
        if (out.length >= limit) break
        // Папку удалили или заменили — в «последние» не годится (§4: последняя папка пропускается).
        let st
        try { st = statSync(key, { bigint: true }) } catch { continue }
        if (!st.isDirectory() || String(st.dev) !== e.dev || String(st.ino) !== e.ino) continue
        out.push({ path: e.display, key, lastUsedAt: e.lastUsedAt as string, ...(e.access ? { access: e.access } : {}) })
      }
      return out
    },
    entries() {
      return Object.entries(data.folders).map(([key, e]) => ({ key, ...e }))
    },
  }
}
