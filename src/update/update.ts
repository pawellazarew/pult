// `pult update --from <tgz> [--reinstall] | --to <версия> | --list` — docs/08-PLAN-F1-M4.md §4.
// Голый `pult update` и `--check` — канал обновлений (channel.ts, M8c): скачивает тарбол и идёт сюда же.
//
// Порядок `--from` (каждый шаг — ответ на измеренную или предсказуемую поломку):
//   1. `run/update.lock` — два обновления разом переставили бы `current` друг у друга из-под ног;
//   2. имя и версия из тарбола; не `pult` — отказ;
//   3. версия уже активна — «уже стоит»; есть на диске — переключение без переустановки;
//   4. npm в `versions/<v>.partial` → проверка → rename в `versions/<v>`: полупоставленная версия
//      версией не считается никогда, а убитая посреди npm установка оставляет только `.partial`;
//   5. лаунчер из новой версии, previous запоминается, `current` переключается атомарно;
//   6. свой node из пина версии (runtime.ts) — ДО остановки старого демона: скачивание идёт, пока он
//      ещё работает; не вышло — предупреждение, демон пойдёт на системном node;
//   7. перезапуск и проба (probe.ts); провал — откат: `current` назад, лаунчер из previous, указатель
//      своего node как был, старый демон снова, версия помечена bad и оставлена на диске для разбора.
// Источник — подписанный latest.json в релизах GitHub (channel.ts), а не VPS из черновика Ф7.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireLock } from '../core/lock.js'
import { ensureLayout } from '../core/paths.js'
import type { PultPaths } from '../core/paths.js'
import { stopRunningDaemon } from '../service/install.js'
import type { Io } from '../service/install.js'
import { atomicSymlink, atomicWrite } from '../service/fsutil.js'
import type { ServiceContext } from '../service/context.js'
import { bypassNotice, ownServiceContext, readServiceFile, REINSTALL_CMD } from '../service/status.js'
import { npmInstall, readTarballManifest, UpdateError, verifyInstalled } from './install.js'
import { compareVersions } from '../core/semver.js'
import type { RestartContext } from './probe.js'
import { daemonStatusOnce, fileSize, outputFile, restartAndProbe, tailSince } from './probe.js'
import type { ProbeOptions } from './probe.js'
import { ensureRuntime, pinnedRuntimes, pruneRuntimes, readActivePointer, readPin, writeActivePointer } from './runtime.js'
import type { UpdateAttempt, UpdateState } from './versions.js'
import {
  cleanLeftovers, currentName, isVersionName, OLD_MARK, packageIn, PARTIAL_SUFFIX, PROBE_PENDING, probeInterrupted,
  pruneVersions, readState, removeVersionDir, scanVersions, writeState,
} from './versions.js'

export interface UpdateOptions {
  env?: NodeJS.ProcessEnv
  reinstall?: boolean
  json?: boolean
  /** Для тестов: сузить пробу (число попыток, ожидания). В бою — значения из docs/08 §4. */
  probe?: ProbeOptions
  /**
   * Канал обновлений (M8c): тарбол обязан назвать ту же версию, что подписанный манифест. Сумма уже
   * сошлась, но несовпадение версии значит, что релиз собран криво, — ставить его нельзя.
   */
  expectVersion?: string
  /** Чем назвать попытку в update.json: `from` — руками, `channel` — из latest.json. */
  action?: 'from' | 'channel'
  /**
   * Канал: sha256 тарбола из подписанного манифеста. Версия, уже лежащая на диске, переиспользуется,
   * только если её ставили из канала с ТЕМ ЖЕ тарболом (метка `.channel-sha256` в каталоге версии):
   * иначе неподписанный `--from` с тем же номером версии прошёл бы за подписанный релиз.
   */
  channelSha?: string
  /** Куда идёт вывод этого `pult update` (запуск из окна — logs/update.log); нет — терминал. Пишется в попытку. */
  log?: string
}

/** Метка каталога версии: sha256 тарбола, из которого её поставил канал обновлений. */
export const CHANNEL_MARK = '.channel-sha256'

const channelMark = (dir: string): string | null => {
  try { return readFileSync(join(dir, CHANNEL_MARK), 'utf8').trim() } catch { return null }
}

const now = (): string => new Date().toISOString()

function prepareDirs(paths: PultPaths): void {
  ensureLayout(paths)
  // versions/ и bin/ — 0700, как в `daemon install`: код версий и лаунчер меняют поведение службы.
  for (const dir of [paths.versions, paths.bin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
}

/** Сколько `pult update` ждёт фоновую подготовку (`pult update --stage`), прежде чем отказать. */
export const STAGE_WAIT_MS = 10 * 60_000

/** Метка «lock держит фоновая подготовка»: pid держателя. Рядом с lock, живёт ровно столько, сколько он. */
const stageMark = (paths: PultPaths): string => `${paths.updateLock}.stage`
const stageHolder = (paths: PultPaths): number | null => {
  try { const n = Number(readFileSync(stageMark(paths), 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null } catch { return null }
}

/**
 * Один `pult update` за раз: `open(O_CREAT|O_EXCL)` + живость pid со временем старта — тот же
 * lock, что у демона (core/lock.ts), со всеми его уроками про переиспользованный pid.
 * 0.3.16: lock держит фоновая подготовка (`pult update --stage`, её запускает демон) — не отказ, а ожидание её конца
 * (не дольше STAGE_WAIT_MS): человек, набравший `pult update`, не должен гадать, что за «другое обновление».
 */
export async function withUpdateLock(paths: PultPaths, io: Io, fn: () => Promise<number>, opts: { stage?: boolean; stageWaitMs?: number } = {}): Promise<number> {
  prepareDirs(paths)
  const deadline = Date.now() + (opts.stageWaitMs ?? STAGE_WAIT_MS)
  let said = false
  let got = acquireLock(paths.updateLock)
  while (!got.ok && !opts.stage && got.holderPid !== null && stageHolder(paths) === got.holderPid && Date.now() < deadline) {
    if (!said) { io.err(`pult update: демон готовит обновление в фоне (pid ${got.holderPid}) — жду конца подготовки, потом продолжу`); said = true }
    await new Promise((r) => { setTimeout(r, 500) })
    got = acquireLock(paths.updateLock)
  }
  if (!got.ok) {
    const bg = got.holderPid !== null && stageHolder(paths) === got.holderPid
    io.err(bg
      ? `pult update: фоновая подготовка обновления (pid ${got.holderPid}) идёт дольше ${Math.round((opts.stageWaitMs ?? STAGE_WAIT_MS) / 60_000)} мин — повтори позже; журнал: ${paths.updateLog}`
      : `pult update: уже идёт другое обновление (pid ${got.holderPid ?? '?'}${got.holderCmd ? `, ${got.holderCmd}` : ''}) — дождись его конца`)
    return 1
  }
  if (opts.stage) { try { atomicWrite(stageMark(paths), `${process.pid}\n`, 0o600) } catch { /* без метки — просто отказ другим */ } }
  try {
    return await fn()
  } finally {
    if (opts.stage) { try { unlinkSync(stageMark(paths)) } catch { /* уже нет */ } }
    got.lock.release()
  }
}

function recordLast(paths: PultPaths, st: UpdateState, last: UpdateAttempt, opts: UpdateOptions = {}): void {
  st.last = opts.log ? { ...last, log: opts.log } : last
  writeState(paths, st)
}

/**
 * Лаунчеры — копии из пакета версии (0755, tmp+rename): службы (`service/pultd-launch`; нет — версия
 * старше В4) и команды `pult` (`service/pult`, с 0.2.22: CLI на своём node Пульта, без системного).
 * Лаунчера команды нет в пакете (откат на версию старше) — прежний остаётся: он не привязан к
 * версии и запускает CLI того, на что смотрит `current`.
 */
const readService = (pkgRoot: string, name: string): Buffer | null => {
  try { return readFileSync(join(pkgRoot, 'service', name)) } catch { return null }
}

function refreshLauncher(paths: PultPaths, pkgRoot: string, io: Io): void {
  const daemon = readService(pkgRoot, 'pultd-launch')
  if (daemon) atomicWrite(paths.launcher, daemon, 0o755)
  else io.err(`внимание: в пакете ${pkgRoot} нет service/pultd-launch — лаунчер службы оставлен прежним`)
  const cli = readService(pkgRoot, 'pult')
  if (cli) atomicWrite(paths.cliLauncher, cli, 0o755)
}

/**
 * «Уже стоит» ничего не переключает, но лаунчера команды может не быть: версию ставил CLI старше
 * 0.2.22, а install.sh повторно кладёт симлинк именно на bin/pult. Нет файла — копия из активной версии.
 */
function ensureCliLauncher(paths: PultPaths, pkgRoot: string): void {
  if (existsSync(paths.cliLauncher)) return
  const cli = readService(pkgRoot, 'pult')
  if (cli) atomicWrite(paths.cliLauncher, cli, 0o755)
}

const versionLink = (v: string): string => join('versions', v)

/**
 * Свой node из пина версии (src/update/runtime.ts). Провал обновление НЕ валит: демон поднимется
 * на системном node, как до 0.2.18, — об этом и о команде повтора говорим прямо.
 */
function prepareRuntime(paths: PultPaths, pkgRoot: string, io: Io, env: NodeJS.ProcessEnv): void {
  try {
    const pin = readPin(pkgRoot)
    if (!pin) return // версия старше 0.2.18: пина нет, указатель не трогаем
    const r = ensureRuntime(paths, pin, { env, progress: (s) => io.err(s) })
    if (r.fetched) io.out(`свой node ${r.version} поставлен: ${r.node}`)
  } catch (e) {
    io.err(`внимание: свой node не поставлен — ${(e as Error).message}`)
    io.err('  демон пойдёт на системном node, и brew upgrade node снова уронит его доступ к ~/Desktop; повторить: pult runtime install')
  }
}

/**
 * Что сказать про службу после того, как демон ответил. Обновление версию переключило, но службу
 * оно обязано оставить в том виде, в каком взяло, — или ясно сказать, что не вышло и как вернуть:
 *   * демон отвечает НЕ из-под службы (менеджер служб отказал, проба прошла на спавне в обход);
 *   * файл службы записан прежней версией и отстал от шаблона (его `pult update` не переписывает).
 */
function serviceNotes(svc: ServiceContext | null, mode: string | undefined, io: Io): void {
  if (!svc) return
  if (mode !== 'service') { for (const l of bypassNotice(svc)) io.err(l); return }
  const stale = readServiceFile(svc).stale
  if (stale) io.err(`внимание: файл службы ${svc.file} записан прежней версией — ${stale}. Обнови: ${REINSTALL_CMD}`)
}

/**
 * Переключение на версию, которая УЖЕ лежит в `versions/<v>`, с пробой и откатом. Общая часть
 * `--from` и `--to`. Вызывается под update.lock.
 */
async function switchAndProbe(paths: PultPaths, io: Io, v: string, action: UpdateAttempt['action'], opts: UpdateOptions): Promise<number> {
  const env = opts.env ?? process.env
  const target = packageIn(join(paths.versions, v))
  if (!target) {
    io.err(`pult update: в ${join(paths.versions, v)} нет пакета pult`)
    return 1
  }
  const st = readState(paths)
  const was = currentName(paths)
  // previous — только живая версия: `current`, указывающий в пустоту, откатом не станет.
  const wasPkg = was !== null && existsSync(paths.current) ? packageIn(paths.current) : null
  // ПЕРЕПРОВЕРКА прерванной пробы: `current` уже на v, и откатываться надо не «на саму себя», а
  // на previous, который прерванный запуск успел записать в update.json. Что было до него —
  // потеряно вместе с убитым процессом, поэтому после такого отката previous пуст.
  const reprobe = was === v
  const recorded = st.previous !== null && st.previous !== v && packageIn(join(paths.versions, st.previous)) ? st.previous : null
  const previous = reprobe ? recorded : wasPkg ? was : null
  const previousBefore = reprobe ? null : st.previous

  // Перепроверка прерванной пробы: указатель на диске уже новой версии — прежний лежит в update.json.
  const pointerBefore = reprobe && st.runtimeBefore !== undefined ? st.runtimeBefore : readActivePointer(paths)
  prepareRuntime(paths, target.root, io, env)

  const hadDaemon = (await daemonStatusOnce(paths)) !== null
  const svc = ownServiceContext(paths, env)
  const ctx: RestartContext = { paths, svc, env, warn: (s) => io.err(s), progress: (s) => io.err(s) }
  // Старый демон гасится ДО отметки в журнале: иначе в «хвост вывода новой версии» при откате
  // попадали его строки об остановке. Проба всё равно остановила бы его сама (probe.ts).
  if (hadDaemon) {
    const t0 = Date.now()
    const s = await stopRunningDaemon(paths)
    if (s.stopped) io.err(`остановлен прежний демон (pid ${s.pid ?? '?'}) — ${((Date.now() - t0) / 1000).toFixed(1)} с`)
  }
  const logFile = outputFile(ctx)
  const logFrom = fileSize(logFile)

  // --- переключение -----------------------------------------------------------------
  refreshLauncher(paths, target.root, io)
  if (previous !== null) st.previous = previous
  st.current = v
  st.last = { at: now(), action, version: v, was, result: 'failed', message: PROBE_PENDING }
  st.runtimeBefore = pointerBefore
  writeState(paths, st)
  atomicSymlink(versionLink(v), paths.current)

  // --- проба ------------------------------------------------------------------------
  const probe = await restartAndProbe(ctx, target.version, opts.probe)
  if (probe.ok) {
    // Демона до обновления не было и службы нет — состояние как было: проверенный демон гасим.
    if (!hadDaemon && !svc) {
      try { await stopRunningDaemon(paths) } catch (e) { io.err(`внимание: ${(e as Error).message}`) }
    }
    st.bad = st.bad.filter((b) => b !== v)
    const removed = pruneVersions(paths, st)
    // Свои node — после версий: держим только те, что нужны пакетам, оставшимся на диске.
    const removedRuntimes = pruneRuntimes(paths, pinnedRuntimes(paths))
    delete st.runtimeBefore
    recordLast(paths, st, { at: now(), action, version: v, was, result: 'ok' }, opts)
    io.out(previous !== null ? `pult обновлён: ${previous} → ${v}` : `pult ${v} установлен`)
    io.out(`демон ${target.version} прошёл пробу: pid ${probe.status?.pid ?? '?'}, режим ${probe.status?.mode ?? '?'}`
      + `${!hadDaemon && !svc ? ' — и остановлен: до обновления демона не было' : ''}`)
    if (removed.length) io.out(`убраны старые версии: ${removed.join(', ')}`)
    if (removedRuntimes.length) io.out(`убраны старые node: ${removedRuntimes.join(', ')}`)
    serviceNotes(svc, probe.status?.mode, io)
    return 0
  }

  // --- откат ------------------------------------------------------------------------
  const tail = tailSince(logFile, logFrom)
  if (!st.bad.includes(v)) st.bad.push(v)
  // Указатель своего node — как до обновления: откатная версия поднимется на том node, на котором жила.
  writeActivePointer(paths, pointerBefore)
  delete st.runtimeBefore
  if (previous === null) {
    // Первой установке откатываться некуда: снимаем current, чтобы служба и `daemon install`
    // не поднимали заведомо сломанную версию. Её каталог остаётся на диске для разбора.
    try { unlinkSync(paths.current) } catch { /* уже нет */ }
    try { await stopRunningDaemon(paths) } catch { /* ниже всё равно код 1 */ }
    st.current = null
    st.previous = previousBefore
    const msg = `${v} не прошла пробу: ${probe.reason}`
    recordLast(paths, st, { at: now(), action, version: v, was, result: 'failed', message: msg }, opts)
    io.err(`pult update: ${msg}`)
    io.err(`откатываться некуда (первая установка): current снят, ${join(paths.versions, v)} оставлена для разбора`)
    if (tail) io.err(`--- хвост ${logFile} (вывод ${v}) ---\n${tail}`)
    return 1
  }

  const prevPkg = packageIn(join(paths.versions, previous))
  atomicSymlink(versionLink(previous), paths.current)
  if (prevPkg) refreshLauncher(paths, prevPkg.root, io)
  st.current = previous
  st.previous = previousBefore
  const msg = `${v} не прошла пробу: ${probe.reason}; откат на ${previous}`
  recordLast(paths, st, { at: now(), action, version: v, was, result: 'rolled_back', message: msg }, opts)
  io.err(`pult update: ${msg}`)
  io.err(`${v} помечена bad и оставлена на диске: ${join(paths.versions, v)}`)
  if (tail) io.err(`--- хвост ${logFile} (вывод ${v}) ---\n${tail}`)

  // Старый демон — снова, если он был или его держит служба. Одна попытка без проверки «жив
  // через 2 с»: эта версия уже работала, и её падение здесь — отдельная беда, о которой скажем.
  if (hadDaemon || svc) {
    const back = await restartAndProbe(ctx, prevPkg?.version ?? previous, { ...opts.probe, attempts: 1, aliveAfterMs: 0, label: 'откат' })
    if (back.ok) {
      io.err(`демон ${prevPkg?.version ?? previous} снова отвечает: pid ${back.status?.pid ?? '?'}, режим ${back.status?.mode ?? '?'}`)
      serviceNotes(svc, back.status?.mode, io)
    } else {
      io.err(`ВНИМАНИЕ: демон ${previous} после отката не поднялся: ${back.reason}. Смотри pult doctor`)
    }
  } else {
    try { await stopRunningDaemon(paths) } catch { /* и так код 1 */ }
  }
  return 1
}

/**
 * `pult update` из CLI (канал, `--from`, `--to`) перезапускает демона, а с ним обрываются идущие ходы. Окно в этом
 * случае ждёт конца ходов (src/update/checker.ts); CLI ждать в фоне некому — он отказывает с тем же счётом
 * (`daemon.status.turns`), `--force` — не ждать. Демона нет или он старый (поля нет) — ходов он не знает, отказа нет.
 * `--expect` (так «Обновить» зовёт сам демон) сюда не ходит: демон уже дождался ходов или человек нажал «Сейчас».
 * true — отказано, строка уже в stderr.
 */
export async function refuseRunningTurns(paths: PultPaths, io: Io, opts: { force: boolean; status?: () => Promise<{ turns?: number } | null> }): Promise<boolean> {
  if (opts.force) return false
  const st = await (opts.status ?? (() => daemonStatusOnce(paths)))()
  const turns = typeof st?.turns === 'number' ? st.turns : 0
  if (turns <= 0) return false
  io.err(`pult update: идут ходы: ${turns} — обновление перезапустит демона и оборвёт их; дождись или --force`)
  return true
}

export async function updateFrom(paths: PultPaths, io: Io, tgzArg: string, opts: UpdateOptions = {}): Promise<number> {
  return withUpdateLock(paths, io, () => installTarball(paths, io, tgzArg, opts))
}

/** `--from` без lock: его берёт вызывающий (`updateFrom` или канал обновлений — на всю загрузку и установку). */
export async function installTarball(paths: PultPaths, io: Io, tgzArg: string, opts: UpdateOptions = {}): Promise<number> {
  const env = opts.env ?? process.env
  const tgz = resolve(tgzArg)
  const action = opts.action ?? 'from'
  const cleaned = cleanLeftovers(paths)
  if (cleaned.length) io.out(`убраны следы прерванных установок: ${cleaned.join(', ')}`)

  let v: string
  try {
    v = readTarballManifest(tgz, env).version
  } catch (e) {
    if (e instanceof UpdateError) { io.err(`pult update: ${e.message}`); return 1 }
    throw e
  }
  if (opts.expectVersion !== undefined && v !== opts.expectVersion) {
    io.err(`pult update: в тарболе версия ${v}, а подписанный манифест обещал ${opts.expectVersion} — релиз собран криво, не ставлю`)
    return 1
  }
  const st = readState(paths)
  const dir = join(paths.versions, v)
  const onDisk = packageIn(dir)
  const valid = onDisk !== null && onDisk.layout === 'installed' && onDisk.version === v
  // Прерванная проба — не «уже стоит»: раньше повтор той же команды после убитого посреди
  // пробы `pult update` отвечал кодом 0, хотя версия ни разу не ответила hello_ok.
  const interrupted = probeInterrupted(st, currentName(paths))
  if (valid && currentName(paths) === v && existsSync(paths.current) && interrupted) {
    io.out(`${v} активна, но её проба была прервана — проверяю заново`)
    return switchAndProbe(paths, io, v, action, opts)
  }
  if (valid && currentName(paths) === v && existsSync(paths.current)) {
    if (opts.reinstall) {
      // Переставить папку, из которой прямо сейчас работает демон и служба, — значит подменить
      // код под живым процессом. Путь честный: переключиться на другую версию и повторить.
      io.err(`pult update: ${v} активна — её не переставляю. Переключись на другую (pult update --to <версия>) и повтори --reinstall`)
      return 1
    }
    recordLast(paths, st, { at: now(), action, version: v, was: v, result: 'already' }, opts)
    ensureCliLauncher(paths, onDisk.root)
    io.out(`уже стоит: ${v} активна`)
    return 0
  }
  const trusted = opts.channelSha === undefined || channelMark(dir) === opts.channelSha
  if (valid && !opts.reinstall && trusted) {
    io.out(`${v} уже лежит в ${dir} — переключаюсь без переустановки (--reinstall переставит)`)
    return switchAndProbe(paths, io, v, action, opts)
  }
  if (valid && !trusted) io.out(`${v} уже лежит в ${dir}, но не из этого подписанного тарбола — переставляю`)

  if (!installDir(paths, io, tgz, v, st, opts, true)) return 1
  return switchAndProbe(paths, io, v, action, opts)
}

/**
 * npm в `versions/<v>.partial` → проверка → rename в `versions/<v>` (+ метка канала). Общее у установки и фоновой
 * подготовки (0.3.16). false — не вышло, причина уже в stderr; `record` — записать провал в update.json (подготовка
 * молчит: её неудача — не «обновление не встало», а повод скачать ещё раз).
 */
function installDir(paths: PultPaths, io: Io, tgz: string, v: string, st: UpdateState, opts: UpdateOptions, record: boolean): boolean {
  const env = opts.env ?? process.env
  const action = opts.action ?? 'from'
  const dir = join(paths.versions, v)
  const partial = dir + PARTIAL_SUFFIX
  removeVersionDir(partial)
  try {
    npmInstall(paths, partial, tgz, env)
    verifyInstalled(partial, v, paths, env)
  } catch (e) {
    removeVersionDir(partial)
    const msg = (e as Error).message
    if (record) recordLast(paths, st, { at: now(), action, version: v, was: currentName(paths), result: 'failed', message: msg }, opts)
    io.err(`pult update: ${msg}`)
    io.err('ничего не переключено: current и работающий демон прежние')
    return false
  }
  if (existsSync(dir) || scanVersions(paths).versions.some((x) => x.name === v)) {
    // --reinstall или мусор без пакета на месте версии: rename не заменяет непустой каталог,
    // поэтому старый отодвигается в сторону и удаляется уже после подмены.
    const old = `${dir}${OLD_MARK}${process.pid}`
    renameSync(dir, old)
    renameSync(partial, dir)
    removeVersionDir(old)
  } else {
    renameSync(partial, dir)
  }
  if (opts.channelSha !== undefined) atomicWrite(join(dir, CHANNEL_MARK), `${opts.channelSha}\n`, 0o600)
  st.installed[v] = now()
  writeState(paths, st)
  io.out(`${v} поставлена в ${dir}`)
  return true
}

/**
 * 0.3.16: версия `v` уже подготовлена каналом — лежит в `versions/<v>`, пакет той же версии и с меткой канала
 * (`sha256` — той же, что в подписанном манифесте; не задан — любой меткой канала).
 */
export function stagedReady(paths: PultPaths, v: string, sha256?: string): boolean {
  const dir = join(paths.versions, v)
  const pkg = packageIn(dir)
  if (!pkg || pkg.layout !== 'installed' || pkg.version !== v) return false
  const mark = channelMark(dir)
  return mark !== null && (sha256 === undefined || mark === sha256)
}

/**
 * Не больше одной подготовленной версии: убрать прочие версии канала новее активной (не current, не previous, не
 * `keep`). Остальное на диске — дело `pruneVersions` после переключения.
 */
export function pruneStaged(paths: PultPaths, keep: string | null): string[] {
  const cur = currentName(paths)
  const st = readState(paths)
  const curPkg = cur !== null ? packageIn(join(paths.versions, cur)) : null
  const removed: string[] = []
  for (const e of scanVersions(paths).versions) {
    if (e.dev || e.name === cur || e.name === st.previous || e.name === keep || e.version === null) continue
    if (channelMark(e.dir) === null) continue
    if (curPkg && compareVersions(e.name, curPkg.version) <= 0) continue
    removeVersionDir(e.dir)
    delete st.installed[e.name]
    removed.push(e.name)
  }
  if (removed.length) writeState(paths, st)
  return removed
}

/**
 * 0.3.16, фоновая подготовка: поставить тарбол в `versions/<v>` и НЕ переключать. Вызывается под update.lock.
 * Активная версия или уже подготовленная тем же тарболом — ничего не делать. Провал в update.json не пишется.
 */
export function stageTarball(paths: PultPaths, io: Io, tgzArg: string, opts: UpdateOptions = {}): number {
  const env = opts.env ?? process.env
  const tgz = resolve(tgzArg)
  cleanLeftovers(paths)
  let v: string
  try {
    v = readTarballManifest(tgz, env).version
  } catch (e) {
    if (e instanceof UpdateError) { io.err(`pult update: ${e.message}`); return 1 }
    throw e
  }
  if (opts.expectVersion !== undefined && v !== opts.expectVersion) {
    io.err(`pult update: в тарболе версия ${v}, а подписанный манифест обещал ${opts.expectVersion} — релиз собран криво, не ставлю`)
    return 1
  }
  if (currentName(paths) === v) { io.out(`${v} активна — готовить нечего`); return 0 }
  if (stagedReady(paths, v, opts.channelSha)) { io.out(`${v} уже подготовлена: ${join(paths.versions, v)}`); return 0 }
  return installDir(paths, io, tgz, v, readState(paths), opts, false) ? 0 : 1
}

/** 0.3.16: переключиться на подготовленную заранее версию — тот же путь, что у установки (проба, автооткат). */
export async function switchStaged(paths: PultPaths, io: Io, v: string, opts: UpdateOptions = {}): Promise<number> {
  io.out(`${v} подготовлена заранее — переключаюсь`)
  return switchAndProbe(paths, io, v, opts.action ?? 'channel', opts)
}

export async function updateTo(paths: PultPaths, io: Io, v: string, opts: UpdateOptions = {}): Promise<number> {
  if (!isVersionName(v)) {
    io.err(`pult update --to: «${v}» — не имя версии (ожидается вида 1.2.3 или 1.2.3-dev)`)
    return 1
  }
  return withUpdateLock(paths, io, async () => {
    const pkg = packageIn(join(paths.versions, v))
    if (!pkg) {
      io.err(`pult update --to: версии ${v} на диске нет — что есть: pult update --list`)
      return 1
    }
    if (currentName(paths) === v && existsSync(paths.current)) {
      if (probeInterrupted(readState(paths), v)) {
        io.out(`${v} активна, но её проба была прервана — проверяю заново`)
        return switchAndProbe(paths, io, v, 'to', opts)
      }
      io.out(`уже активна: ${v}`)
      return 0
    }
    return switchAndProbe(paths, io, v, 'to', opts)
  })
}

export interface ListedVersion {
  name: string
  version: string | null
  current: boolean
  previous: boolean
  bad: boolean
  dev: boolean
  path: string
  target?: string
  installedAt?: string
}

export function listVersions(paths: PultPaths): { current: string | null; previous: string | null; bad: string[]; versions: ListedVersion[]; leftovers: string[]; last: UpdateAttempt | null } {
  const st = readState(paths)
  const cur = currentName(paths)
  const disk = scanVersions(paths)
  const versions = disk.versions.map((e) => ({
    name: e.name,
    version: e.version,
    current: e.name === cur,
    previous: e.name === st.previous,
    bad: st.bad.includes(e.name),
    dev: e.dev,
    path: e.dir,
    ...(e.target !== undefined ? { target: e.target } : {}),
    ...(st.installed[e.name] ? { installedAt: st.installed[e.name] } : {}),
  }))
  return { current: cur, previous: st.previous, bad: st.bad, versions, leftovers: disk.leftovers, last: st.last }
}

export function updateList(paths: PultPaths, io: Io, opts: UpdateOptions = {}): number {
  const l = listVersions(paths)
  if (opts.json) { io.out(JSON.stringify(l)); return 0 }
  if (!l.versions.length) {
    io.out(`версий нет (${paths.versions}); поставить: pult update --from <pult-x.y.z.tgz>`)
  } else {
    io.out(`версии в ${paths.versions}:`)
    for (const v of l.versions) {
      const marks = [
        v.current ? 'current' : '',
        v.previous ? 'previous' : '',
        v.bad ? 'bad' : '',
        v.dev ? `dev → ${v.target ?? '?'}` : '',
        v.version === null ? 'пакета нет' : '',
      ].filter(Boolean)
      io.out(`  ${v.current ? '*' : ' '} ${v.name.padEnd(16)} ${marks.join(' · ')}`)
    }
  }
  if (l.current !== null && !l.versions.some((v) => v.current)) io.out(`current → ${l.current}, но такой версии на диске нет — pult update --to <версия>`)
  if (l.leftovers.length) io.out(`следы прерванных установок (уберёт следующий pult update): ${l.leftovers.join(', ')}`)
  if (l.last) io.out(`последняя попытка: ${l.last.at} ${l.last.action} ${l.last.version} — ${l.last.result}${l.last.message ? ` (${l.last.message})` : ''}`)
  return 0
}
