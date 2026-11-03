import { t as tr } from './i18n.js'
// `pult ui` — открыть окно Пульта (docs/12 §4, О3).
//
// Порядок: поставленное приложение `Pult.app` (/Applications, затем ~/Applications) → оболочка
// из рабочей копии (`PULT_UI_ROOT` или корень этого пакета, если рядом собран shell/) → подсказка,
// как окно получить. `--dev` пропускает Pult.app и берёт рабочую копию сразу.
//
// Выбор — чистая функция `planUi` (файловую систему ей передают), поэтому юнит-тесты гоняют её
// без диска; запуск — отдельно, в `launchUi`. `--print` печатает план и ничего не запускает.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

export interface UiProbe {
  isDir(p: string): boolean
  isFile(p: string): boolean
  read(p: string): string | null
}

export type UiPlan =
  | { kind: 'app'; app: string; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'dev'; root: string; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'none'; hint: string }

export interface PlanInput {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Корень пакета, из которого запущен CLI (для рабочей копии: рядом лежит shell/). */
  selfRoot: string
  /** node, которым демона поднимать, если окно придётся его спавнить. */
  nodePath: string
  dev: boolean
  fs: UiProbe
}

export const APP_NAME = 'Pult.app'

/**
 * Где искать Pult.app. Под PULT_TEST — только `PULT_TEST_APP_DIRS` (по умолчанию нигде): тест не
 * должен зависеть от того, стоит ли окно на машине разработчика.
 */
export function appDirs(env: NodeJS.ProcessEnv): string[] {
  if (env['PULT_TEST'] === '1') return (env['PULT_TEST_APP_DIRS'] ?? '').split(':').filter(Boolean)
  return ['/Applications', path.join(homedir(), 'Applications')]
}

/** Бинарь Electron оболочки рабочей копии: `shell/node_modules/electron/path.txt` — как делает сам пакет electron. */
export function devElectron(root: string, fs: UiProbe): string | null {
  const pkg = path.join(root, 'shell', 'node_modules', 'electron')
  const rel = (fs.read(path.join(pkg, 'path.txt')) ?? '').trim()
  if (!rel) return null
  const bin = path.join(pkg, 'dist', rel)
  return fs.isFile(bin) ? bin : null
}

/** Годится ли корень как рабочая копия с собранным окном: пакет, dist/ui и shell/dist. */
function devReady(root: string, fs: UiProbe): boolean {
  return fs.isFile(path.join(root, 'dist', 'ui', 'index.html'))
    && fs.isFile(path.join(root, 'dist', 'cli', 'startOnDemand.js'))
    && fs.isFile(path.join(root, 'shell', 'dist', 'main.js'))
}

const howTo = (): string => [
  tr('окно не найдено. Как получить:'),
  tr('  поставить Pult.app: cd shell && npm ci && npm run dist:mac → shell/out/mac-arm64/Pult.app в /Applications'),
  tr('  или из рабочей копии: npm run build && (cd shell && npm ci && npm run build), затем PULT_UI_ROOT=<копия> pult ui --dev'),
].join('\n')

export function planUi(input: PlanInput): UiPlan {
  const { env, fs } = input
  // Окну пробрасываем только то, что задаёт «чей это Пульт»: дом, node и (в разработке) корень пакета.
  const passEnv: Record<string, string> = { PULT_NODE: env['PULT_NODE']?.trim() || input.nodePath }
  if (env['PULT_HOME']?.trim()) passEnv['PULT_HOME'] = path.resolve(env['PULT_HOME'].trim())
  if (env['PULT_TEST'] === '1') passEnv['PULT_TEST'] = '1'
  if (env['PULT_LANG']) passEnv['PULT_LANG'] = env['PULT_LANG']

  if (!input.dev && input.platform === 'darwin') {
    for (const dir of appDirs(env)) {
      const app = path.join(dir, APP_NAME)
      if (!fs.isDir(app)) continue
      // `open -a` уже работающее окно поднимает, а не плодит второе; --env доходит только до нового процесса.
      const args = ['-a', app]
      for (const [k, v] of Object.entries(passEnv)) args.push('--env', `${k}=${v}`)
      return { kind: 'app', app, command: 'open', args, env: {} }
    }
  }

  const explicit = env['PULT_UI_ROOT']?.trim()
  const candidates = explicit ? [path.resolve(explicit)] : [path.resolve(input.selfRoot)]
  for (const root of candidates) {
    if (!devReady(root, fs)) continue
    const electron = devElectron(root, fs)
    if (!electron) continue
    return {
      kind: 'dev',
      root,
      command: electron,
      args: [path.join(root, 'shell')],
      env: { ...passEnv, PULT_UI_ROOT: root },
    }
  }

  const why = explicit
    ? tr`PULT_UI_ROOT=${path.resolve(explicit)}: нет собранного окна (dist/ui, dist/cli, shell/dist, shell/node_modules/electron)`
    : input.dev ? tr('рабочая копия без собранного окна (shell/dist, shell/node_modules/electron)') : ''
  return { kind: 'none', hint: why ? `${why}\n${howTo()}` : howTo() }
}

export function describePlan(plan: UiPlan): string {
  switch (plan.kind) {
    case 'app': return tr`окно: ${plan.app}\n  ${[plan.command, ...plan.args].join(' ')}`
    case 'dev': return tr`окно из рабочей копии: ${plan.root}\n  ${[plan.command, ...plan.args].join(' ')}`
    case 'none': return plan.hint
  }
}

/**
 * Запустить окно. Pult.app — через `open`: ждём его код (0 — LaunchServices приложение принял).
 * Рабочая копия — Electron отсоединённым: CLI сразу выходит, окно живёт само; ошибка спавна
 * (нет бинаря, нет прав) приходит событием `error` — ждём её или `spawn`, чтобы код выхода был честным.
 */
export function launchUi(plan: Extract<UiPlan, { kind: 'app' | 'dev' }>, baseEnv: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...baseEnv, ...plan.env }
    if (plan.kind === 'app') {
      const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'], env })
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (d: string) => { stderr += d })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(tr`open ${plan.app}: код ${String(code)}${stderr.trim() ? ` — ${stderr.trim()}` : ''}`))
      })
      return
    }
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', env })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
