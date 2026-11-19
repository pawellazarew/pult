import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge } from './bridge.ts'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(here, '.runtime')
await mkdir(runtime, { recursive: true, mode: 0o700 })
const upstream = await realpath(resolve(process.env.EXACT_CHECKOUT || '/tmp/pult-exact-upstream'))
const expected = (await readFile(resolve(here, 'upstream-revision'), 'utf8')).trim()
const actual = Bun.spawnSync(['git', '-C', upstream, 'rev-parse', 'HEAD']).stdout.toString().trim()
if (actual !== expected) throw new Error('Exact checkout differs from upstream-revision; see README.md')

await mkdir(resolve(runtime, 'data/src'), { recursive: true })
await writeFile(resolve(runtime, 'data/src/lib.rs'), await readFile(resolve(here, 'data/lib.rs')))
await writeFile(resolve(runtime, 'data/Cargo.toml'), `[package]
name = "pult-exact-data"
version = "0.1.0"
edition = "2021"
workspace = "../.exact/shells"
[dependencies]
exact-plan = { path = ${JSON.stringify(resolve(upstream, 'plan'))} }
exact-runner = { path = ${JSON.stringify(resolve(upstream, 'runner'))} }
`)
const bridge = startBridge()
try {
const app = resolve(here, '.runtime')
await mkdir(app, { recursive: true, mode: 0o700 })
const header = `source sessions() as shape Chats\n  url "${bridge.origin}/sessions"\n  header "Authorization" "Bearer ${bridge.capability}"\n\nsource conversation(name: string) as shape Transcript\n  url "${bridge.origin}/conversation?name={name}"\n  header "Authorization" "Bearer ${bridge.capability}"\n\n`
await writeFile(resolve(app, 'app.contract'), header + await readFile(resolve(here, 'app.contract'), 'utf8'), { mode: 0o600 })
await writeFile(resolve(app, 'app.json'), await readFile(resolve(here, 'app.json')), { mode: 0o600 })
console.log('Building Pult Exact Preview. Close the window or press Ctrl+C to stop the local read bridge.')
const child = Bun.spawn(['bun', 'host/apple/build.mjs', runtime, '--run'], { cwd: upstream, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } })
const stop = () => { child.kill(); bridge.server.stop(true) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.exitCode = await child.exited
} finally { bridge.server.stop(true) }
