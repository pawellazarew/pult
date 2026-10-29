import { t } from '../cli/i18n.js'
// `pult runtime [--json]` и `pult runtime install [--from <node-x.y.z.tar.gz>]` — свой node Пульта
// (src/update/runtime.ts) без смены версии: показать, на чём работает демон, и поставить node,
// если при обновлении он не скачался.
//
// install НЕ убирает старые node и НЕ перезапускает демона: работающий демон живёт на прежнем
// бинаре, и удалить его из-под живого процесса — ровно поломка 14.10.2026. Перезапуск — команда
// человеку: ход, идущий прямо сейчас, перезапуск оборвал бы.

import type { PultPaths } from '../core/paths.js'
import type { DaemonStatus } from '../core/rpc.js'
import type { Io } from '../service/install.js'
import { daemonStatusOnce } from './probe.js'
import { ensureRuntime, PIN_FILE, readPin, runtimeReport, RuntimeError } from './runtime.js'
import type { RuntimePin } from './runtime.js'
import { withUpdateLock } from './update.js'

export const RESTART_CMD = 'pult daemon stop && pult daemon start'

function loadPin(pkgRoot: string, io: Io, what: string): RuntimePin | null | 'error' {
  try {
    return readPin(pkgRoot)
  } catch (e) {
    io.err(`${what}: ${(e as Error).message}`)
    return 'error'
  }
}

function daemonLine(st: DaemonStatus | null): string {
  if (!st) return t('демон не отвечает')
  if (!st.node) return t`демон ${st.version} не сообщает свой node (версия старше 0.2.18)`
  const n = st.node
  if (!n.alive) return t`node демона ${n.path} (${n.version}) удалён или заменён — перезапусти: ${RESTART_CMD}`
  return n.own ? t`демон на своём node ${n.version}: ${n.path}` : t`демон на системном node ${n.path} (${n.version})`
}

export async function runtimeShow(paths: PultPaths, io: Io, opts: { pkgRoot: string; json?: boolean; env?: NodeJS.ProcessEnv }): Promise<number> {
  const pin = loadPin(opts.pkgRoot, io, 'pult runtime')
  if (pin === 'error') return 1
  const report = runtimeReport(paths, pin, opts.env)
  const st = await daemonStatusOnce(paths)
  if (opts.json) {
    io.out(JSON.stringify({ ...report, daemon: st?.node ?? null }))
    return 0
  }
  if (!report.key) {
    io.out(t`своего node под ${report.platform} нет — демон работает на системном node`)
  } else if (!report.pinned) {
    io.out(t`в пакете нет ${PIN_FILE} — эта версия Пульта своего node не знает`)
  } else if (!report.active) {
    io.out(t`свой node ${report.pinned} не поставлен — поставить: pult runtime install`)
  } else if (!report.activeVersion) {
    io.out(t`свой node не отвечает: ${report.active} — поставить заново: pult runtime install`)
  } else {
    io.out(t`свой node ${report.activeVersion}: ${report.active}${report.activeVersion === `v${report.pinned}` ? '' : t` (пин пакета — ${report.pinned}: pult runtime install)`}`)
  }
  io.out(daemonLine(st))
  if (report.installed.length) io.out(t`на диске: ${report.installed.join(', ')}`)
  return 0
}

export async function runtimeInstall(paths: PultPaths, io: Io, opts: { pkgRoot: string; from?: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  const env = opts.env ?? process.env
  return withUpdateLock(paths, io, async () => {
    const pin = loadPin(opts.pkgRoot, io, 'pult runtime install')
    if (pin === 'error') return 1
    if (!pin) {
      io.err(t`pult runtime install: в пакете ${opts.pkgRoot} нет ${PIN_FILE} — эта версия Пульта своего node не знает`)
      return 1
    }
    let r
    try {
      r = ensureRuntime(paths, pin, { env, ...(opts.from ? { from: opts.from } : {}), progress: (s) => io.err(s) })
    } catch (e) {
      if (!(e instanceof RuntimeError)) throw e
      io.err(`pult runtime install: ${e.message}`)
      return 1
    }
    io.out(r.fetched ? t`свой node ${r.version} поставлен: ${r.node}` : t`свой node ${r.version} уже стоит: ${r.node}`)
    const st = await daemonStatusOnce(paths)
    const onIt = st?.node?.own === true && st.node.alive && st.node.version === `v${r.version}`
    if (st && !onIt) io.out(t`${daemonLine(st)} — свой node подхватит после перезапуска: ${RESTART_CMD}`)
    return 0
  })
}
