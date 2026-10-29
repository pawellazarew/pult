import { t } from '../cli/i18n.js'
// `pult daemon install [--dev] [--print]` и `pult daemon uninstall` — docs/08-PLAN-F1-M4.md §2.
//
// Порядок install (каждый шаг — ответ на измеренную или предсказуемую поломку):
//   1. нужна активная версия (`current`); `--dev` делает ею рабочую копию пакета;
//   2. лаунчер из активной версии → PULT_HOME/bin/pultd-launch, node-path ← node этого CLI;
//   3. работающий демон «по требованию» останавливается мягко — иначе служебный экземпляр упрётся
//      в lock, выйдет с кодом 3, и launchd будет перезапускать его каждые 10 с;
//   4. файл службы — атомарно, строки экранированы;
//   5. загрузка через менеджер служб (+ linger на Linux);
//   6. проверка: сокет отвечает hello_ok с версией АКТИВНОЙ версии за ≤ 15 с.
// Запись в ~/Library/LaunchAgents или ~/.config/systemd/user — ТОЛЬКО здесь, по явной команде
// (инвариант 8 в редакции В4).

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '../cli/client.js'
import { connectClient } from '../cli/client.js'
import { ensureLayout } from '../core/paths.js'
import type { PultPaths } from '../core/paths.js'
import type { DaemonStatus } from '../core/rpc.js'
import { VERSION } from '../core/version.js'
import { stableNodePath } from '../env/nodeBin.js'
import type { ServiceContext } from './context.js'
import { serviceContext, ServiceError } from './context.js'
import { atomicSymlink, atomicWrite } from './fsutil.js'
import type { Step } from './manager.js'
import { daemonReload, formatLastExit, load, loadCommands, queryState, unload } from './manager.js'
import { renderService } from './render.js'
import { formatServiceLine, readServiceFile, serviceReport } from './status.js'

export const INSTALL_WAIT_MS = 15_000

export interface Io {
  out(s: string): void
  err(s: string): void
}

/** Корень пакета, из которого запущен этот CLI: dist/service/install.js → ../../ */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
}

export interface ActiveVersion {
  /** Корень пакета активной версии (там package.json, dist/, service/). */
  root: string
  version: string
  layout: 'installed' | 'dev'
}

/**
 * Активная версия по `current`. Две раскладки, как у лаунчера: установленная npm
 * (`current/lib/node_modules/pult`) и рабочая копия (`current` = корень пакета, `--dev`).
 */
export function activeVersion(paths: PultPaths): ActiveVersion | null {
  if (!existsSync(paths.current)) return null
  const candidates: Array<[string, ActiveVersion['layout']]> = [
    [join(paths.current, 'lib', 'node_modules', 'pult'), 'installed'],
    [paths.current, 'dev'],
  ]
  for (const [root, layout] of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'pult' && typeof pkg.version === 'string') return { root, version: pkg.version, layout }
    } catch { /* следующая раскладка */ }
  }
  return null
}

/**
 * macOS спрашивает доступ к ~/Desktop, ~/Documents и ~/Downloads у ПРОЦЕССА (TCC): под службой
 * это `node`, и первый же его заход туда (точка входа или cwd сессии) вызывает системный диалог.
 * Измерено спайком S9g — см. spike/env/HUMAN-STEPS.md.
 */
export function tccWarning(platform: string, home: string, pathsToCheck: string[]): string | null {
  if (platform !== 'darwin') return null
  const guarded = ['Desktop', 'Documents', 'Downloads'].map((d) => join(home, d))
  const hits: string[] = []
  for (const p of pathsToCheck) {
    let real = p
    try { real = realpathSync(p) } catch { /* пути ещё нет — берём как есть */ }
    for (const g of guarded) {
      let realG = g
      try { realG = realpathSync(g) } catch { /* нет такой папки */ }
      if (real === realG || real.startsWith(realG + sep) || p === g || p.startsWith(g + sep)) { hits.push(p); break }
    }
  }
  if (!hits.length) return null
  return t`внимание: ${hits.join(', ')} внутри ~/Desktop, ~/Documents или ~/Downloads. Служба запускает node, и macOS `
    + t('покажет системный диалог «“node” would like to access files in your … folder» — нажми «Разрешить», ')
    + t('иначе демон под службой не прочитает свою точку входа. Без диалога — ставь из тарбола: pult update --from <tgz>')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function tryConnect(paths: PultPaths, timeoutMs = 2000): Promise<Client | null> {
  try { return await connectClient(paths, { timeoutMs }) } catch { return null }
}

/**
 * Мягкая остановка работающего демона: `daemon.stop` и ожидание, пока lock-файл исчезнет (lock
 * снимается ПОСЛЕДНИМ — его пропажа и есть «уборка дошла до конца», урок В3).
 */
export async function stopRunningDaemon(paths: PultPaths, waitMs = 10_000): Promise<{ stopped: boolean; pid?: number }> {
  const client = await tryConnect(paths)
  if (!client) return { stopped: false }
  const pid = client.daemon.pid
  const closed = new Promise<void>((r) => client.onClose(() => r()))
  try {
    // С потолком: зависший демон, не отвечающий на daemon.stop, иначе вешал install и update
    // навсегда. Не ответил — соединение закрыто, дальше решает lock (и отказ ниже).
    await client.request('daemon.stop', undefined, { timeoutMs: Math.min(5000, waitMs) })
  } catch { /* соединение могло закрыться раньше ответа — дальше решает lock */ }
  await Promise.race([closed, sleep(5000)])
  client.close()
  const deadline = Date.now() + waitMs
  while (existsSync(paths.lock) && Date.now() < deadline) await sleep(50)
  if (existsSync(paths.lock)) {
    throw new ServiceError(t`работающий демон (pid ${pid}) не остановился за ${waitMs} мс: lock ${paths.lock} на месте. Останови его: pult daemon stop`)
  }
  return { stopped: true, pid }
}

function tailFile(file: string, lines: number): string {
  try {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n')
  } catch {
    return t`(${file} не читается)`
  }
}

function printSteps(io: Io, steps: Step[]): void {
  for (const s of steps) io.err(`  ${s.ok ? 'ok ' : t('ОШИБКА')} ${s.cmd}${s.detail ? ` — ${s.detail}` : ''}`)
}

export interface InstallOptions {
  dev?: boolean
  print?: boolean
  json?: boolean
  env?: NodeJS.ProcessEnv
  waitMs?: number
  /** process.execPath — node, которым лаунчер будет запускать демона. */
  nodeExec?: string
  /** Корень рабочей копии для --dev. По умолчанию — пакет этого CLI. */
  devRoot?: string
}

function renderFor(ctx: ServiceContext, nodeExec: string): string {
  return renderService({
    platform: ctx.platform,
    name: ctx.name,
    launcher: ctx.paths.launcher,
    pultHome: ctx.paths.home,
    serviceLog: ctx.paths.serviceLog,
    home: ctx.home,
    nodeExec,
  })
}

const fileLabel = (ctx: ServiceContext): string =>
  ctx.file ?? t`<каталог служб>/${ctx.platform === 'darwin' ? `${ctx.name}.plist` : ctx.name}`

export async function installService(paths: PultPaths, io: Io, opts: InstallOptions = {}): Promise<number> {
  const env = opts.env ?? process.env
  // Путь, переживающий `brew upgrade node`: Cellar/<версия> он удаляет (src/env/nodeBin.ts).
  const nodeExec = stableNodePath(opts.nodeExec ?? process.execPath)
  const ctx = serviceContext(paths, env)

  // --print: файл службы и команды загрузки, НИЧЕГО не записывая. Им же CI проверяет генерацию.
  if (opts.print) {
    const content = renderFor(ctx, nodeExec)
    const commands = loadCommands(ctx, fileLabel(ctx))
    if (opts.json) {
      io.out(JSON.stringify({ platform: ctx.platform, name: ctx.name, file: ctx.file, content, commands }))
    } else {
      io.out(t`# ${fileLabel(ctx)}\n${content}\n# команды загрузки:\n${commands.map((c) => `#   ${c}`).join('\n')}`)
    }
    return 0
  }

  if (!ctx.file) {
    throw new ServiceError(t('PULT_TEST=1 без PULT_SERVICE_DIR: файл службы некуда класть (настоящий каталог служб в тестах не трогается)'))
  }
  const existing = readServiceFile(ctx)
  if (existing.installed && !existing.ours) {
    io.err(t`pult daemon install: ${ctx.file} уже обслуживает другой PULT_HOME (${existing.fileHome ?? t('не указан')}).`)
    io.err(t`  снять ту службу: PULT_HOME=${existing.fileHome ?? t('<её дом>')} pult daemon uninstall`)
    io.err(t('  или поставить вторую рядом под другим именем: PULT_SERVICE_NAME=<имя> pult daemon install'))
    return 1
  }

  ensureLayout(paths)
  // bin/ и versions/ — как остальной PULT_HOME, 0700: лаунчер и код версий меняют поведение
  // службы, и писать туда кроме владельца не должен никто. chmod явный — mkdir маскируется umask.
  for (const dir of [paths.bin, paths.versions]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const warnings: string[] = []

  // --- 1. активная версия ---------------------------------------------------------
  if (opts.dev) {
    const root = realpathSync(opts.devRoot ?? packageRoot())
    const name = `${VERSION}-dev`
    const versionDir = join(paths.versions, name)
    atomicSymlink(root, versionDir)
    // Относительная ссылка: PULT_HOME можно перенести целиком, и current не порвётся.
    atomicSymlink(relative(paths.home, versionDir), paths.current)
    io.out(`--dev: ${versionDir} → ${root}; current → ${name}`)
  }
  const active = activeVersion(paths)
  if (!active) {
    io.err(t`pult daemon install: активной версии нет (${paths.current} не существует или не указывает на пакет pult).`)
    io.err(t('  поставь версию из тарбола:        pult update --from <pult-x.y.z.tgz>'))
    io.err(t('  или свяжи эту рабочую копию:      pult daemon install --dev'))
    return 1
  }
  // Для --dev проверяем путь рабочей копии КАК ЕГО ДАЛИ (и его realpath внутри tccWarning):
  // current — симлинк в PULT_HOME, и по нему одному папку ~/Desktop не увидеть.
  const tcc = tccWarning(ctx.platform, ctx.home, [opts.dev ? (opts.devRoot ?? packageRoot()) : active.root, paths.home])
  if (tcc) warnings.push(tcc)

  // --- 2. лаунчер и node-path -------------------------------------------------------
  const launcherSrc = join(active.root, 'service', 'pultd-launch')
  let launcherBody: Buffer
  try {
    launcherBody = readFileSync(launcherSrc)
  } catch {
    io.err(t`pult daemon install: в активной версии ${active.version} нет лаунчера ${launcherSrc} — версия старше В4? Поставь новую: pult update --from <tgz>`)
    return 1
  }
  atomicWrite(paths.launcher, launcherBody, 0o755)
  // Первая же попытка лаунчера должна быть удачной: node этого CLI заведомо >= 22 и жив. Но node-path —
  // кэш СИСТЕМНОГО node (service/pultd-launch): CLI, запущенный своим node Пульта (лаунчер bin/pult),
  // его не трогает — свой node лаунчер службы и так берёт первым, по runtime/active.
  // Сравнение по realpath: `/var/…` и `/private/var/…` на macOS, симлинк PULT_HOME на другой диск.
  const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
  const fromRuntime = relative(real(paths.runtime), real(nodeExec))
  if (!fromRuntime || fromRuntime.startsWith('..') || isAbsolute(fromRuntime)) {
    atomicWrite(paths.nodePath, `${nodeExec}\n`, 0o600)
  }

  // --- 3. демон «по требованию» -----------------------------------------------------
  const stopped = await stopRunningDaemon(paths)
  if (stopped.stopped) io.out(t`работающий демон (pid ${stopped.pid}) остановлен — дальше его держит служба`)

  // --- 4. файл службы ---------------------------------------------------------------
  // 0644: launchd отвергает plist, доступный на запись группе или всем.
  atomicWrite(ctx.file, renderFor(ctx, nodeExec), 0o644)

  // --- 5. загрузка ------------------------------------------------------------------
  const loaded = load(ctx, ctx.file)
  warnings.push(...loaded.warnings)
  if (!loaded.ok) {
    io.err(t`pult daemon install: менеджер служб не загрузил ${ctx.file}:`)
    printSteps(io, loaded.steps)
    io.err(t`  файл службы оставлен на месте; снять: pult daemon uninstall`)
    for (const w of warnings) io.err(w)
    return 1
  }

  // --- 6. проверка ------------------------------------------------------------------
  const waitMs = opts.waitMs ?? INSTALL_WAIT_MS
  const deadline = Date.now() + waitMs
  let seen: DaemonStatus | null = null
  while (Date.now() < deadline) {
    const client = await tryConnect(paths)
    if (client) {
      try {
        const st = (await client.request('daemon.status')) as DaemonStatus
        seen = st
        // Версия И режим: демон «по требованию», поднятый чужой командой между шагами 3 и 5,
        // отвечает той же версией, но держит lock — служебный экземпляр при этом выходит с кодом 3.
        // Такой ответ успехом установки не считается.
        if (st.version === active.version && st.mode === 'service') {
          client.close()
          for (const w of warnings) io.err(w)
          io.out(t`служба установлена: ${ctx.file}`)
          io.out(t`демон ${st.version} отвечает: pid ${st.pid}, режим ${st.mode ?? '?'}; журнал службы ${paths.serviceLog}`)
          return 0
        }
      } catch { /* демон ещё поднимается */ }
      client.close()
    }
    await sleep(200)
  }

  io.err(t`pult daemon install: демон не ответил hello_ok с версией ${active.version} за ${Math.round(waitMs / 1000)} с`
    + (seen ? t` (отвечал демон версии ${seen.version}, pid ${seen.pid}, режим ${seen.mode})` : ''))
  if (seen && seen.mode !== 'service') {
    io.err(t`  lock держит демон «по требованию» (pid ${seen.pid}) — служебный экземпляр выходит с кодом 3. `
      + t('Останови его (pult daemon stop) — служба подхватит сама, или повтори pult daemon install'))
  }
  io.err(t`--- хвост ${paths.serviceLog} ---`)
  io.err(tailFile(paths.serviceLog, 20))
  try {
    const st = queryState(ctx)
    io.err(t`--- менеджер служб --- загружена: ${st.loaded}, pid ${st.pid ?? '—'}, последний выход: ${formatLastExit(st)}${st.error ? `, ${st.error}` : ''}`)
  } catch (e) {
    io.err(t`--- менеджер служб --- ${(e as Error).message}`)
  }
  io.err(t`служба оставлена установленной; снять: pult daemon uninstall`)
  for (const w of warnings) io.err(w)
  return 1
}

export async function uninstallService(paths: PultPaths, io: Io, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const env = opts.env ?? process.env
  const ctx = serviceContext(paths, env)
  if (!ctx.file) {
    throw new ServiceError(t('PULT_TEST=1 без PULT_SERVICE_DIR: снимать нечего (настоящий каталог служб в тестах не трогается)'))
  }
  const f = readServiceFile(ctx)
  if (f.installed && !f.ours) {
    io.err(t`pult daemon uninstall: ${ctx.file} обслуживает другой PULT_HOME (${f.fileHome ?? t('не указан')}) — не трогаю.`)
    io.err(t`  снять её: PULT_HOME=${f.fileHome ?? t('<её дом>')} pult daemon uninstall`)
    return 1
  }
  if (!f.installed) {
    // Файла нет, но служба могла остаться загруженной (файл удалили руками) — снимаем и её.
    const u = unload(ctx)
    if (!u.ok) printSteps(io, u.steps)
    io.out(t('службы нет — снимать нечего'))
    return 0
  }
  const u = unload(ctx)
  if (!u.ok) {
    io.err(t`pult daemon uninstall: менеджер служб не снял ${ctx.name}:`)
    printSteps(io, u.steps)
    io.err(t('  файл службы оставлен на месте, чтобы повторить: pult daemon uninstall'))
    return 1
  }
  try { unlinkSync(ctx.file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (ctx.platform === 'linux') {
    const r = daemonReload(ctx)
    if (!r.ok) io.err(`  ${r.cmd} — ${r.detail}`)
    io.out(t`linger не трогаю (на нём могут жить другие службы); выключить, если не нужен: sudo loginctl disable-linger ${ctx.user}`)
  }
  io.out(t`служба снята: ${ctx.file} удалён; PULT_HOME (${paths.home}) не тронут`)
  return 0
}

/** Для `pult daemon status --json` и текстовой строки. */
export function serviceStatus(paths: PultPaths, env: NodeJS.ProcessEnv): { report: ReturnType<typeof serviceReport>; line: string } {
  const report = serviceReport(paths, env)
  return { report, line: formatServiceLine(report) }
}
