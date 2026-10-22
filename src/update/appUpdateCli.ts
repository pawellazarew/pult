// `pult update --app [--force]` (0.3.4): то же, что «Обновить окно» в «Настройках», — просьба демону
// (`update.apply {target: 'app'}`), а не работа в CLI: проба нового окна — его hello демону, и только демон его
// видит. CLI ждёт итога по `update.status` и печатает шаги.

import type { Client } from '../cli/client.js'
import { ClientError } from '../cli/client.js'
import type { AppUpdateStatus, AppUpdateStep, UpdateStatus } from '../core/rpc.js'
import type { Io } from '../service/install.js'

const STEP_TEXT: Record<AppUpdateStep, string> = {
  download: 'качаю архив окна',
  verify: 'проверяю архив и подпись бандла',
  stage: 'кладу новое окно рядом со старым',
  quit: 'закрываю окно',
  swap: 'меняю Pult.app',
  launch: 'открываю новое окно',
  health: 'жду, пока новое окно подключится к демону',
  rollback: 'новое окно не поднялось — возвращаю прежнее',
}

/** Сообщение для Linux и прочих: окно там из рабочей копии, менять нечего. */
export const APP_UPDATE_MAC_ONLY = 'окно само обновляется только на macOS (Pult.app); на Linux окно из рабочей копии — pult ui --dev'

export interface AppUpdateCliOptions {
  /** Поставить и версию, помеченную bad. */
  force?: boolean
  platform?: NodeJS.Platform
  /** Соединение с демоном (поднимается по требованию). */
  connect: () => Promise<Client>
  pollMs?: number
  /** Сколько ждать итога целиком (загрузка ~120 МБ + проба). */
  timeoutMs?: number
}

export async function updateAppCli(io: Io, opts: AppUpdateCliOptions): Promise<number> {
  if ((opts.platform ?? process.platform) !== 'darwin') {
    io.out(`pult update --app: ${APP_UPDATE_MAC_ONLY} — ничего не сделано`)
    return 0
  }
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
  let client: Client
  try { client = await opts.connect() } catch (e) {
    io.err(`pult update --app: демон недоступен — ${(e as Error).message}`)
    return 1
  }
  try {
    let to: string
    // Итог — только попытки, начатой этим вызовом (`at` не раньше старта), а не прошлой с той же версией.
    const startedAt = new Date(Date.now() - 1000).toISOString()
    try {
      const r = await client.request('update.apply', { target: 'app', ...(opts.force ? { allowBad: true } : {}) }) as { to?: unknown }
      to = typeof r?.to === 'string' ? r.to : '?'
    } catch (e) {
      if (e instanceof ClientError && e.code === 'invalid_params') { io.err(`pult update --app: ${e.message}`); return 1 }
      throw e
    }
    io.out(`обновляю окно до ${to}: окно закроется и откроется само, сессии работают дальше`)
    let lastStep: AppUpdateStep | null = null
    let app: AppUpdateStatus | undefined
    for (;;) {
      const st = await client.request('update.status') as UpdateStatus
      app = st.app
      const a = app?.applying ?? null
      if (!a) break
      if (a.step !== lastStep) { io.out(`  ${STEP_TEXT[a.step]}…`); lastStep = a.step }
      if (Date.now() > deadline) { io.err('pult update --app: итога нет слишком долго — смотри «Настройки» → «Обновления» или pult update --check'); return 1 }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    const last = app?.last ?? null
    if (!last || last.to !== to || last.at < startedAt) { io.err('pult update --app: итог не записан — смотри logs/pultd.log'); return 1 }
    if (last.result === 'done') { io.out(`окно обновлено: ${last.message}`); return 0 }
    io.err(`pult update --app: ${last.message}`)
    return 1
  } catch (e) {
    io.err(`pult update --app: ${(e as Error).message}`)
    return 1
  } finally {
    client.close()
  }
}
