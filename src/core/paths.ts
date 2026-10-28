// Раскладка PULT_HOME. Единственное место, где склеиваются пути состояния: всё остальное
// берёт готовую структуру, чтобы «никаких записей вне PULT_HOME» (инвариант 8) можно было
// проверить чтением одного файла.

import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export interface PultPaths {
  readonly home: string
  readonly run: string
  readonly sock: string
  readonly token: string
  readonly lock: string
  readonly events: string
  readonly journal: string
  readonly logs: string
  readonly logFile: string
  readonly config: string
  readonly sessions: string
  readonly envCache: string
  /** Каталог служебных исполняемых файлов: сюда кладётся лаунчер службы (В4). */
  readonly bin: string
  /** `bin/pultd-launch` — точка входа службы launchd/systemd, копия из активной версии. */
  readonly launcher: string
  /** `bin/pult` — лаунчер команды `pult` на своём node Пульта (service/pult), копия из активной версии. */
  readonly cliLauncher: string
  /** Файл состояния лаунчера: путь к node >= 22 (лаунчер сам его чинит). */
  readonly nodePath: string
  /** `versions/<v>` — установленные версии пакета. */
  readonly versions: string
  /** `current -> versions/<v>` — симлинк активной версии. */
  readonly current: string
  /** stdout+stderr процесса под службой. НЕ pultd.log: там JSONL демона (docs/08 §1). */
  readonly serviceLog: string
  /** `run/update.lock` — один `pult update` за раз (docs/08 §1). */
  readonly updateLock: string
  /** `update.json` — current, previous, bad[] и последняя попытка обновления. */
  readonly updateState: string
  /** Кэш npm установки версий: внутри PULT_HOME, а не в ~/.npm (инвариант 8). */
  readonly npmCache: string
  /** `runtime/node-v<версия>-<платформа>` — свой node Пульта (src/update/runtime.ts). */
  readonly runtime: string
  /** `runtime/active` — путь к bin/node своего node; по нему лаунчер и спавн поднимают демона. */
  readonly runtimeActive: string
  /** `mcp/` — MCP-серверы, которые Пульт ставит сам (О3: Playwright MCP — браузер агента). */
  readonly mcp: string
  /** `run/mcp-install.lock` — одна установка MCP-сервера за раз (CLI и демон). */
  readonly mcpInstallLock: string
  /** `browser/<сессия>/{profile,downloads}` — профиль и скачивания браузера агента (О3). */
  readonly browser: string
  /** `downloads/` — тарбол из канала обновлений на время `pult update` (M8c); после установки удаляется. */
  readonly downloads: string
  /** `update-check.json` — итог последней проверки канала обновлений демоном (M8c). */
  readonly updateCheck: string
  /** `logs/update.log` — вывод `pult update`, который запустил демон по «Обновить» в окне. */
  readonly updateLog: string
  /** `new-session-last.json` — последний выбор «+ Сессия» окна (M8f): провайдер, модель, усилие, режим, папка. */
  readonly newSessionLast: string
  /**
   * `apps/` — окно на время своего обновления (0.3.4): `staging-<v>`, `previous-<v>` (прежнее окно, один цикл); с 0.3.16
   * ещё `ready-<v>` — окно, скачанное и проверенное заранее (фоновая подготовка), и `stage-<v>` — оно же, пока готовится.
   */
  readonly apps: string
  /**
   * `update-apply.json` — журнал «Перезапустить и обновить» (0.3.16): пишется перед рестартом демона, новый демон по
   * нему доводит обновление окна.
   */
  readonly updateApply: string
  /** `app-update.json` — версии окна, не вставшие на этой машине (bad), и последняя попытка обновить окно. */
  readonly appUpdateState: string
  /**
   * `attachments/<ГГГГ-ММ-ДД>/paste-*.png` — картинки, вставленные из буфера в окне (окно 0.1.16, shell/src/clipboardImage.ts).
   * Пишет окно, читают агенты (Claude — через `--add-dir`), старше 30 дней удаляет демон (src/core/attachments.ts).
   * НЕ внутри `run/`: та закрыта агентам правилами deny (0.3.7).
   */
  readonly attachments: string
}

/**
 * Предел длины пути unix-сокета — 104 байта на macOS (`sun_path`) и 108 на Linux.
 * Берём меньший: демон, который стартует с домом в глубокой временной папке, обязан
 * падать с внятной ошибкой, а не с `ENAMETOOLONG` из глубины net.listen.
 */
export const SOCK_PATH_LIMIT = 104

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['PULT_HOME']
  if (raw && raw.trim()) return resolve(raw.trim())
  return join(homedir(), '.pult')
}

export function layout(home: string): PultPaths {
  const run = join(home, 'run')
  const events = join(home, 'events')
  const logs = join(home, 'logs')
  return {
    home,
    run,
    sock: join(run, 'pultd.sock'),
    token: join(run, 'token'),
    lock: join(run, 'pultd.lock'),
    events,
    journal: join(events, 'journal.jsonl'),
    logs,
    logFile: join(logs, 'pultd.log'),
    config: join(home, 'config.json'),
    sessions: join(home, 'sessions.json'),
    envCache: join(home, 'env.json'),
    bin: join(home, 'bin'),
    launcher: join(home, 'bin', 'pultd-launch'),
    cliLauncher: join(home, 'bin', 'pult'),
    nodePath: join(home, 'node-path'),
    versions: join(home, 'versions'),
    current: join(home, 'current'),
    serviceLog: join(logs, 'service.log'),
    updateLock: join(run, 'update.lock'),
    updateState: join(home, 'update.json'),
    npmCache: join(home, 'npm-cache'),
    runtime: join(home, 'runtime'),
    runtimeActive: join(home, 'runtime', 'active'),
    mcp: join(home, 'mcp'),
    mcpInstallLock: join(run, 'mcp-install.lock'),
    browser: join(home, 'browser'),
    downloads: join(home, 'downloads'),
    updateCheck: join(home, 'update-check.json'),
    updateLog: join(logs, 'update.log'),
    newSessionLast: join(home, 'new-session-last.json'),
    apps: join(home, 'apps'),
    updateApply: join(home, 'update-apply.json'),
    appUpdateState: join(home, 'app-update.json'),
    attachments: join(home, 'attachments'),
  }
}

export function paths(env: NodeJS.ProcessEnv = process.env): PultPaths {
  return layout(resolveHome(env))
}

/** Каталоги создаём и ТУТ ЖЕ chmod'им: режим у mkdir маскируется umask (DELTA v0.4 §4). */
export function ensureLayout(p: PultPaths): void {
  for (const dir of [p.home, p.run, p.events, p.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
}

export function checkSockPath(sock: string): void {
  const len = Buffer.byteLength(sock, 'utf8')
  if (len > SOCK_PATH_LIMIT) {
    throw new Error(
      `путь сокета длиннее ${SOCK_PATH_LIMIT} байт (${len}): ${sock}. ` +
      'Задай PULT_HOME покороче — ядро обрежет путь и демон станет недостижим.',
    )
  }
}

/**
 * `dir` — сама папка `target` или её предок (оба через realpath; нет такой папки — путь как есть). Сравнение по
 * частям пути, а не по строкам: `/a/..x` — потомок `/a`, а не «выше» (relative даёт `..x`, а не `..`).
 */
export function coversDir(dir: string, target: string): boolean {
  const real = (p: string): string => { try { return realpathSync.native(p) } catch { return resolve(p) } }
  const rel = relative(real(dir), real(target))
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}
