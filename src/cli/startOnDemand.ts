// Подъём демона по требованию: любая команда, которой нужен демон, запускает `pultd`
// ОТСОЕДИНЁННЫМ (detached + unref), чтобы он пережил закрытие терминала, и ждёт сокет.
// stdout/stderr ребёнка уходят в файл журнала: без этого закрытие терминала уронило бы
// демона на первой же записи в закрытый pipe (EPIPE).
//
// СЛУЖБА (В4): если для этого PULT_HOME установлена служба, демона поднимает МЕНЕДЖЕР СЛУЖБ
// (`launchctl kickstart` без -k, а незагруженную службу — `bootstrap` / `systemctl --user start`),
// а не мы. Иначе появляются два демона: наш занимает lock, служебный выходит с кодом 3, и launchd
// перезапускает его каждые 10 с (docs/08 §2). Отсоединённый спавн при установленной службе —
// только если менеджер служб ответил ошибкой, и с предупреждением: что служба осталась в стороне
// и какой командой её вернуть.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureLayout } from '../core/paths.js'
import type { PultPaths } from '../core/paths.js'
import { buildChildEnv } from '../env/allowlist.js'
import { daemonNode } from '../env/nodeBin.js'
import type { Step } from '../service/manager.js'
import { start as startService } from '../service/manager.js'
import { bypassNotice, ownServiceContext } from '../service/status.js'
import { connectClient } from './client.js'
import type { Client } from './client.js'
import type { ClientKind, DaemonStatus } from '../core/rpc.js'

export const DAEMON_WAIT_MS = 10_000

export function daemonEntry(): string {
  return fileURLToPath(new URL('../daemon/main.js', import.meta.url))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface EnsureResult {
  client: Client
  spawned: boolean
  pid?: number
  /** Кто поднял демона: менеджер служб или наш отсоединённый спавн. */
  via?: 'service' | 'spawn'
}

async function waitSocket(
  paths: PultPaths,
  waitMs: number,
  client?: ClientKind,
): Promise<{ client: Client | null; lastError: unknown }> {
  const deadline = Date.now() + waitMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    await sleep(60)
    try {
      return { client: await connectClient(paths, client ? { client } : {}), lastError: null }
    } catch (e) {
      lastError = e
    }
  }
  return { client: null, lastError }
}

/**
 * Режим ответившего демона или `null`, если он не сказал за 2 с. Без `timeoutMs` у запроса: тот
 * по таймауту рвёт соединение, а клиент ещё нужен вызывающему — опоздавший ответ просто пропадёт.
 */
async function answeringMode(client: Client): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), 2000) })
  try {
    const st = await Promise.race([client.request('daemon.status') as Promise<DaemonStatus>, late])
    return st === null ? null : (st.mode ?? 'on-demand')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Окружение демона, которого поднимает CLI: белый список + переменные САМОГО Пульта.
 * Вынесено из ensureDaemon для `pult update`: демона НОВОЙ версии он поднимает с тем же
 * окружением, что и подъём по требованию, — иначе тестовые швы (фальшивые CLI, PULT_TEST_NET)
 * терялись бы ровно на обновлении, и демон новой версии искал бы настоящий `claude`.
 */
export function daemonSpawnEnv(paths: PultPaths, parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  return buildChildEnv(parentEnv, {
    extra: {
      PULT_HOME: paths.home,
      ...(parentEnv['PULT_TEST'] ? { PULT_TEST: parentEnv['PULT_TEST'] } : {}),
      // Переменные САМОГО Пульта пробрасываем осознанно: PULT_CLAUDE_BIN перебивает поиск
      // CLI (им же тест подставляет фальшивый `claude`). Это не дыра в белом списке —
      // белый список защищает ДОЧЕРНИЙ процесс провайдера, а не нашего же демона.
      ...(parentEnv['PULT_CLAUDE_BIN'] ? { PULT_CLAUDE_BIN: parentEnv['PULT_CLAUDE_BIN'] } : {}),
      // PULT_CODEX_BIN — то же самое для второго провайдера. Без этой строки тест
      // подставлял фальшивый app-server только в СВОЁМ процессе, а поднятый по требованию
      // демон находил настоящий `codex` и шёл с ним к модели. Поймано в В3.
      ...(parentEnv['PULT_CODEX_BIN'] ? { PULT_CODEX_BIN: parentEnv['PULT_CODEX_BIN'] } : {}),
      // PULT_TEST_NET работает ТОЛЬКО вместе с PULT_TEST=1 (см. daemon/server.ts) и делает
      // сквозные тесты герметичными: без неё демон звал настоящий `curl` к api.anthropic.com.
      ...(parentEnv['PULT_TEST_NET'] ? { PULT_TEST_NET: parentEnv['PULT_TEST_NET'] } : {}),
      ...(parentEnv['PULT_LOG_ECHO'] ? { PULT_LOG_ECHO: parentEnv['PULT_LOG_ECHO'] } : {}),
      // M8c: свой адрес latest.json — настройка человека (только https, channel.ts), демон обязан её видеть.
      ...(parentEnv['PULT_UPDATE_URL'] ? { PULT_UPDATE_URL: parentEnv['PULT_UPDATE_URL'] } : {}),
      // Тестовые швы канала обновлений и задержка стража (M8e) — только вместе с PULT_TEST=1: вне тестов демон их и не читает.
      ...(parentEnv['PULT_TEST'] === '1' ? pick(parentEnv, ['PULT_TEST_UPDATE_DIR', 'PULT_TEST_RELEASE_KEY', 'PULT_TEST_UPDATE_FIRST_MS', 'PULT_TEST_NET_DELAY_MS', 'PULT_TEST_PROVIDERS', 'PULT_TEST_APP_DIRS', 'PULT_TEST_APP_HELLO_MS', 'PULT_TEST_APP_CODESIGN']) : {}),
    },
  })
}

function pick(env: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) if (env[k]) out[k] = env[k] as string
  return out
}

/**
 * Поднять демона из точки входа `entry` ОТСОЕДИНЁННЫМ (detached + unref): он переживает
 * закрытие терминала. stdout/stderr — в журнал демона, а не в трубу: закрытый терминал уронил
 * бы демона на первой же записи (EPIPE). Точка входа — параметр: `pult update` поднимает
 * демона НОВОЙ версии из `current`, а не из своего `../daemon/main.js` (docs/08 §4).
 */
export function spawnDaemonDetached(
  paths: PultPaths,
  entry: string,
  parentEnv: NodeJS.ProcessEnv,
  nodePath?: string,
): ChildProcess {
  // Свой node Пульта, если он поставлен, — даже когда вызывающий передал свой путь; иначе
  // переданный, иначе node этого CLI (src/update/runtime.ts, env/nodeBin.ts daemonNode).
  const node = daemonNode(paths.runtimeActive, nodePath ?? process.execPath)
  ensureLayout(paths)
  const logFd = openSync(paths.logFile, 'a', 0o600)
  try {
    const child = spawn(node, [entry], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: daemonSpawnEnv(paths, parentEnv),
    })
    // Ошибка спавна (ENOENT node и т.п.) не должна ронять CLI необработанным 'error':
    // вызывающий всё равно ждёт сокет и объяснит провал сам.
    child.on('error', () => { /* см. выше */ })
    child.unref()
    return child
  } finally {
    // Дескриптор унаследован ребёнком; у нас он больше не нужен.
    closeSync(logFd)
  }
}

/**
 * Пытается подключиться; если демона нет — поднимает и ждёт.
 *
 * `nodePath` — чем запускать демона при отсоединённом спавне, если своего node Пульта нет (он
 * главнее). По умолчанию `process.execPath` (CLI и так идёт под node). Окно Пульта (Ф2, `shell/`) живёт в Electron: его `execPath` — бинарь
 * Electron, а fuse `RunAsNode` выключен, поэтому оболочка передаёт сюда настоящий node.
 * `client` — вид клиента в рукопожатии: у окна это `shell`.
 */
export async function ensureDaemon(
  paths: PultPaths,
  opts: {
    waitMs?: number
    env?: NodeJS.ProcessEnv
    warn?: (s: string) => void
    nodePath?: string
    client?: ClientKind
  } = {},
): Promise<EnsureResult> {
  const connect = (): Promise<Client> => connectClient(paths, opts.client ? { client: opts.client } : {})
  try {
    return { client: await connect(), spawned: false }
  } catch { /* демона нет — поднимаем */ }

  const parentEnv = opts.env ?? process.env
  const waitMs = opts.waitMs ?? DAEMON_WAIT_MS
  const warn = opts.warn ?? ((s: string): void => { process.stderr.write(s.endsWith('\n') ? s : s + '\n') })

  const svc = ownServiceContext(paths, parentEnv)
  if (svc) {
    let st: Step
    try {
      st = startService(svc)
    } catch (e) {
      st = { cmd: svc.platform === 'darwin' ? 'launchctl kickstart' : 'systemctl --user start', ok: false, detail: (e as Error).message }
    }
    if (st.ok) {
      const { client, lastError } = await waitSocket(paths, waitMs, opts.client)
      if (client) return { client, spawned: true, via: 'service' }
      // Менеджер службу принял, а демон не ответил: второй демон в обход службы здесь только
      // навредит (он займёт lock, служебный уйдёт в петлю кода 3). Объясняем и выходим.
      throw new Error(
        `служба ${svc.name} запущена (${st.cmd}), но демон не ответил за ${waitMs} мс: `
        + `${(lastError as Error)?.message ?? 'причина неизвестна'}. Смотри ${paths.serviceLog} и pult doctor`,
      )
    }
    warn(`pult: служба ${svc.name} не запустилась (${st.cmd}: ${st.detail}) — поднимаю демона напрямую, в обход службы`)
  }

  const child = spawnDaemonDetached(paths, daemonEntry(), parentEnv, opts.nodePath)

  const { client, lastError } = await waitSocket(paths, waitMs, opts.client)
  if (client) {
    // Предупреждение — только если отвечает действительно демон «по требованию». Пока мы поднимали
    // своего, мог успеть подняться служебный: lock у него, а наш вышел с кодом 3 — тогда всё в порядке.
    if (svc && (await answeringMode(client)) === 'on-demand') { for (const l of bypassNotice(svc)) warn(l) }
    return { client, spawned: true, via: 'spawn', ...(child.pid !== undefined ? { pid: child.pid } : {}) }
  }
  throw new Error(
    `демон не поднялся за ${waitMs} мс: ${(lastError as Error)?.message ?? 'причина неизвестна'}. `
    + `Смотри журнал ${paths.logFile}`,
  )
}
