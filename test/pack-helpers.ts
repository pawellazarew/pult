// Настоящие тарболы пакета для тестов обновления и install.sh (docs/08 §9): `npm pack` из
// ВРЕМЕННОЙ копии пакета (package.json с подменённой версией + dist + service). Только
// `--offline`, HOME и кэш npm — во временной папке: настоящий ~/.npm не трогается.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { platformKey, runtimeName } from '../dist/update/runtime.js'
import type { PlatformKey } from '../dist/update/runtime.js'

export const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
export const CLI = join(ROOT, 'dist', 'cli', 'main.js')
export const NODE_DIR = dirname(process.execPath)

export function npmBin(): string {
  const sibling = join(NODE_DIR, 'npm')
  return existsSync(sibling) ? sibling : 'npm'
}

export interface PackSpec {
  version: string
  /** Имя пакета; по умолчанию pult. */
  name?: string
  /** Полная замена dist/daemon/main.js (сломанная версия C). */
  daemonMain?: string
  /** Код, дописываемый в конец dist/daemon/main.js (версия D, падающая после ответа). */
  appendToDaemon?: string
  /** `scripts` в package.json тарбола (install-скрипты, которые npm исполнять не должен). */
  scripts?: Record<string, string>
  /** Пин своего node (`runtime.env` в корне пакета); без него — пакет, как до 0.2.18. */
  runtimeEnv?: string
  /** Без лаунчера команды `service/pult` — пакет, как 0.2.18–0.2.21. */
  noCliLauncher?: boolean
}

/** Сломанная версия: демон выходит с кодом 1 сразу, ничего не открыв. */
export const BROKEN_DAEMON = "process.stderr.write('C: сломанная сборка, выхожу\\n')\nprocess.exit(1)\n"

/**
 * Версия, которая успевает ответить hello_ok и падает примерно через секунду: ждёт появления
 * сокета (значит, listen состоялся) и выходит с кодом 1. Ловится только проверкой «жив через 2 с».
 */
export const CRASH_AFTER_HELLO = [
  "import { existsSync as __pultTestExists } from 'node:fs'",
  'const __pultTestTimer = setInterval(() => {',
  "  if (__pultTestExists(process.env.PULT_HOME + '/run/pultd.sock')) {",
  '    clearInterval(__pultTestTimer)',
  "    setTimeout(() => { process.stderr.write('D: ответила и падаю через секунду\\n'); process.exit(1) }, 1200)",
  '  }',
  '}, 50)',
  '',
].join('\n')

export function packPult(workDir: string, spec: PackSpec): string {
  const name = spec.name ?? 'pult'
  const stage = join(workDir, `stage-${name}-${spec.version}`)
  const out = join(workDir, 'tarballs')
  mkdirSync(out, { recursive: true })
  cpSync(join(ROOT, 'dist'), join(stage, 'dist'), { recursive: true })
  cpSync(join(ROOT, 'service'), join(stage, 'service'), { recursive: true })
  chmodSync(join(stage, 'service', 'pultd-launch'), 0o755)
  chmodSync(join(stage, 'service', 'pult'), 0o755)
  if (spec.noCliLauncher) rmSync(join(stage, 'service', 'pult'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
  pkg['name'] = name
  pkg['version'] = spec.version
  delete pkg['scripts']
  delete pkg['devDependencies']
  if (spec.scripts) pkg['scripts'] = spec.scripts
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2))
  if (spec.runtimeEnv !== undefined) writeFileSync(join(stage, 'runtime.env'), spec.runtimeEnv)
  const daemonMain = join(stage, 'dist', 'daemon', 'main.js')
  if (spec.daemonMain !== undefined) writeFileSync(daemonMain, spec.daemonMain)
  if (spec.appendToDaemon !== undefined) writeFileSync(daemonMain, readFileSync(daemonMain, 'utf8') + '\n' + spec.appendToDaemon)
  const npmHome = join(workDir, 'npm-home')
  const r = spawnSync(npmBin(), ['pack', '--offline', '--ignore-scripts', '--pack-destination', out, stage], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${NODE_DIR}:${process.env['PATH'] ?? ''}`,
      HOME: npmHome,
      npm_config_cache: join(npmHome, 'cache'),
      npm_config_update_notifier: 'false',
    },
  })
  if (r.status !== 0) throw new Error(`npm pack ${name}@${spec.version}: ${r.stderr}`)
  const file = join(out, `${name}-${spec.version}.tgz`)
  if (!existsSync(file)) throw new Error(`npm pack не положил ${file}: ${r.stdout}`)
  return file
}

export interface Run { code: number | null; stdout: string; stderr: string }

/** Запуск процесса с захватом вывода; ChildProcess — наружу, чтобы тест мог его ждать или убить. */
export function runProc(cmd: string, args: string[], env: Record<string, string>, cwd?: string): { child: ChildProcess; done: Promise<Run> } {
  // Packed CLI fixtures assert Russian output; explicit per-test locale still takes precedence.
  const child = spawn(cmd, args, { env: { PULT_LANG: 'ru', ...env }, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => { stdout += d })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => { stderr += d })
  const done = new Promise<Run>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
  return { child, done }
}

/**
 * Тарбол «node» версии `version` для своего node Пульта (src/update/runtime.ts) — без сети:
 * sh-скрипт, на `-v` отвечает версией (или `answers`), остальное — exec настоящего node теста.
 * Перед exec оставляет след `<каталог node>/used`: по нему тест видит, что демона подняли им.
 */
export function fakeNodeTarball(dir: string, version: string, opts: { answers?: string; npm?: boolean } = {}): { tgz: string; sha: string } {
  const key = platformKey() as PlatformKey
  const name = runtimeName(version, key)
  const tag = Math.random().toString(36).slice(2)
  const stage = join(dir, `stage-node-${version}-${tag}`)
  mkdirSync(join(stage, name, 'bin'), { recursive: true })
  // Как в настоящем тарболе: заголовки C, которые установка вырезает.
  mkdirSync(join(stage, name, 'include', 'node'), { recursive: true })
  writeFileSync(join(stage, name, 'include', 'node', 'node.h'), '')
  const node = join(stage, name, 'bin', 'node')
  writeFileSync(node, [
    '#!/bin/sh',
    `[ "$1" = "-v" ] && echo ${opts.answers ?? `v${version}`} && exit 0`,
    'printf x > "$(dirname "$0")/../used"',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'))
  chmodSync(node, 0o755)
  if (opts.npm) {
    // npm рядом с node, как в настоящем тарболе: `pult update` берёт его первым (findNpm), и установка
    // на машине без системного node не идёт за npm в чужие места.
    const realNpm = realpathSync(join(NODE_DIR, 'npm'))
    writeFileSync(join(stage, name, 'bin', 'npm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(realNpm)} "$@"\n`)
    chmodSync(join(stage, name, 'bin', 'npm'), 0o755)
  }
  const tgz = join(dir, `${name}-${tag}.tar.gz`)
  const r = spawnSync('tar', ['-czf', tgz, '-C', stage, name], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  if (r.status !== 0) throw new Error(`tar ${tgz}: ${r.stderr}`)
  rmSync(stage, { recursive: true, force: true })
  return { tgz, sha: createHash('sha256').update(readFileSync(tgz)).digest('hex') }
}

/** `runtime.env` под тарбол из fakeNodeTarball — сумма только для платформы этой машины. */
export function fakePin(version: string, sha: string): string {
  const key = (platformKey() as PlatformKey).replace('-', '_').toUpperCase()
  return `PULT_NODE_VERSION=${version}\nPULT_NODE_SHA256_${key}=${sha}\n`
}
