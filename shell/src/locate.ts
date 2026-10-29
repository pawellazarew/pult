import { t as tr } from './i18n.js'
// Где лежит пакет pult и чем запускать демона — для оболочки (docs/12 §2).
// Функции чистые: файловую систему им передают, поэтому юнит-тесты гоняют их без диска.

import { homedir } from 'node:os'
import path from 'node:path'

export interface FsProbe {
  /** Есть ли файл (для package.json и dist/…). */
  isFile(p: string): boolean
  /** Исполняемый ли файл (для node). */
  isExecutable(p: string): boolean
  /** Прочитать текст или null. */
  read(p: string): string | null
}

/** PULT_HOME как у пакета (src/core/paths.ts resolveHome): нужен ДО того, как пакет найден. */
export function pultHome(env: NodeJS.ProcessEnv): string {
  const raw = env['PULT_HOME']
  return raw && raw.trim() ? path.resolve(raw.trim()) : path.join(homedir(), '.pult')
}

export interface LocatedPackage {
  root: string
  via: 'PULT_UI_ROOT' | 'installed' | 'dev'
}

/**
 * Корень пакета pult: `PULT_UI_ROOT` (разработка: корень рабочей копии) → установленная раскладка
 * `PULT_HOME/current/lib/node_modules/pult` → рабочая копия под `current` (`install --dev`).
 * Порядок раскладок — как у `packageIn` в src/update/versions.ts.
 * Пакет годится, только если в нём собран и демон-клиент, и интерфейс.
 */
export function locatePackage(env: NodeJS.ProcessEnv, fs: FsProbe, opts: { packaged?: boolean } = {}): LocatedPackage | { error: string } {
  const ok = (root: string): boolean =>
    fs.isFile(path.join(root, 'package.json'))
    && fs.isFile(path.join(root, 'dist', 'cli', 'startOnDemand.js'))
    && fs.isFile(path.join(root, 'dist', 'ui', 'index.html'))
  // PULT_UI_ROOT выбирает, чей JS main импортирует и исполняет (cli/client.js и соседи). В собранном
  // Pult.app (`packaged`, решает main по `app.isPackaged`) переменную не слушаем ВООБЩЕ: разрешение
  // через PULT_TEST=1 пришло бы из того же окружения, что и сама PULT_UI_ROOT, — замок без смысла.
  // PULT_HOME по-прежнему выбирает код (PULT_HOME/current): это принятая граница — код пакета
  // доверен на уровне записи пользователя (shell/build/after-pack.cjs), а не защита от env.
  const dev = opts.packaged === true ? undefined : env['PULT_UI_ROOT']
  if (dev && dev.trim()) {
    const root = path.resolve(dev.trim())
    return ok(root)
      ? { root, via: 'PULT_UI_ROOT' }
      : { error: tr`PULT_UI_ROOT=${root}: нет собранного пакета (нужны dist/cli и dist/ui — npm run build)` }
  }
  const current = path.join(pultHome(env), 'current')
  const installed = path.join(current, 'lib', 'node_modules', 'pult')
  if (ok(installed)) return { root: installed, via: 'installed' }
  if (ok(current)) return { root: current, via: 'dev' }
  return { error: tr`пакет pult не найден в ${current} — поставь Пульт (install.sh) или задай PULT_UI_ROOT` }
}

/** Где искать node, если ни PULT_NODE, ни node-path не сработали: PATH окна из Finder почти пуст. */
export const NODE_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/**
 * Чем запускать демона. `process.execPath` оболочки — бинарь Electron, а fuse `RunAsNode` выключен,
 * поэтому нужен настоящий node >= 22: `PULT_NODE` → `PULT_HOME/node-path` (его пишет установка службы,
 * src/service/install.ts) → `node` по PATH → стандартные каталоги Homebrew.
 */
export function resolveNode(env: NodeJS.ProcessEnv, nodePathFile: string, fs: FsProbe): string | null {
  const explicit = env['PULT_NODE']
  if (explicit && explicit.trim() && fs.isExecutable(explicit.trim())) return explicit.trim()
  const saved = (fs.read(nodePathFile) ?? '').split('\n')[0]?.trim()
  if (saved && fs.isExecutable(saved)) return saved
  const dirs = [...(env['PATH'] ?? '').split(':').filter(Boolean), ...NODE_FALLBACK_DIRS]
  for (const d of dirs) {
    const p = path.join(d, 'node')
    if (fs.isExecutable(p)) return p
  }
  return null
}
