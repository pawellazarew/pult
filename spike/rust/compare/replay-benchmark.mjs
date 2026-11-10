#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, platform, arch, release, cpus } from 'node:os'
import { resolve, dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const options = { trials: 10, records: 10_000, 'payload-bytes': 256 }
let scratch, active, interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; process.exitCode = 130; active?.kill('SIGTERM') })
try {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2)
    if (!args[i]?.startsWith('--') || !['rust', 'out', 'trials', 'records', 'payload-bytes'].includes(key) || args[i + 1] === undefined) throw new Error('Usage: node replay-benchmark.mjs --rust /absolute/pult-r1 --out /absolute/new.json [--trials 10 --records 10000 --payload-bytes 256]')
    options[key] = ['rust', 'out'].includes(key) ? args[i + 1] : Number(args[i + 1])
  }
  for (const key of ['rust', 'out']) if (typeof options[key] !== 'string' || !isAbsolute(options[key])) throw new Error(`--${key} requires an absolute path`)
  if (!existsSync(options.rust) || existsSync(options.out)) throw new Error('Rust binary must exist and output must not already exist')
  for (const [key, max] of [['trials', 50], ['records', 100_000], ['payload-bytes', 32768]]) if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`invalid --${key}`)
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const maxRecordBytes = Buffer.byteLength(JSON.stringify({ sequence: options.records, kind: 'provider.message', data: { text: 'x'.repeat(options['payload-bytes']) } })) + 1
  if (maxRecordBytes * options.records > 32 * 1024 * 1024) throw new Error('fixture upper bound exceeds 32 MiB')
  const fixture = Buffer.from(Array.from({ length: options.records }, (_, i) => JSON.stringify({ sequence: i + 1, kind: 'provider.message', data: { text: 'x'.repeat(options['payload-bytes']) } }) + '\n').join(''))
  if (fixture.length > 32 * 1024 * 1024) throw new Error('fixture exceeds journal limit')
  scratch = mkdtempSync(join(tmpdir(), 'pult-replay-'))
  const run = (runtime, home, expectedSuccess = true) => new Promise((accept, reject) => {
    if (interrupted) { reject(new Error('interrupted')); return }
    const command = runtime === 'node' ? process.execPath : options.rust
    const argv = runtime === 'node' ? [join(here, 'node-replay.mjs'), '--home', home] : ['--home', home, 'replay']
    const started = performance.now()
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    active = child
    const digest = createHash('sha256')
    let outputBytes = 0, records = 0, maxRssBytes = null, samples = 0, stderr = '', expired = false
    const sample = () => {
      try {
        const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
        if (rss > 0) { maxRssBytes = Math.max(maxRssBytes ?? 0, rss * 1024); samples++ }
      } catch { /* short processes can exit between samples */ }
    }
    const interval = setInterval(sample, 20)
    const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 30_000)
    child.stdout.on('data', (bytes) => { digest.update(bytes); outputBytes += bytes.length; for (const b of bytes) if (b === 10) records++ })
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-4096) })
    child.once('error', (error) => { clearInterval(interval); clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => {
      clearInterval(interval); clearTimeout(deadline); active = null
      const result = { runtime, elapsedMs: performance.now() - started, maxSampledRssBytes: maxRssBytes, rssSamples: samples, outputBytes, records, sha256: digest.digest('hex') }
      if (expired || signal || (expectedSuccess ? code !== 0 : code === 0)) reject(new Error(`${runtime} unexpected exit ${code}/${signal}: ${stderr}`))
      else accept(result)
    })
  })
  const homeFor = (name, bytes) => {
    const home = join(scratch, name)
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(home, 'r1.ndjson'), bytes, { mode: 0o600 })
    return home
  }
  // Both must reject real corruption; a successful replay alone cannot prove validation parity.
  for (const [name, invalid] of [['gap', '{"sequence":2,"kind":"x","data":{}}\n'], ['corrupt', '{broken}\n']]) {
    for (const runtime of ['node', 'rust']) await run(runtime, homeFor(`${runtime}-${name}`, invalid), false)
  }
  const rows = []
  for (let trial = 0; trial < options.trials; trial++) {
    for (const runtime of trial % 2 ? ['rust', 'node'] : ['node', 'rust']) {
      const row = await run(runtime, homeFor(`${runtime}-${trial}`, fixture))
      if (row.sha256 !== hash(fixture) || row.outputBytes !== fixture.length || row.records !== options.records) throw new Error(`${runtime} replay output mismatch`)
      rows.push({ trial, ...row })
    }
  }
  const summary = Object.fromEntries(['node', 'rust'].map((runtime) => {
    const selected = rows.filter((r) => r.runtime === runtime)
    const times = selected.map((r) => r.elapsedMs).sort((a, b) => a - b)
    return [runtime, { p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], sampledRssBytes: selected.map((r) => r.maxSampledRssBytes) }]
  }))
  const result = { schemaVersion: 1, measuredAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(), host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version }, rustBinarySha256: hash(readFileSync(options.rust)), runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))), nodePeerSha256: hash(readFileSync(join(here, 'node-replay.mjs'))), options: { trials: options.trials, records: options.records, payloadBytes: options['payload-bytes'] }, fixtureBytes: fixture.length, fixtureSha256: hash(fixture), scope: 'Complete valid ASCII single-writer replay only; wall includes startup/validation/serialization/pipes and RSS sampling overhead. Not provider/ACK/storage-durability or full-Pult parity.', summary, rows }
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n')
  console.log(`Saved ${rows.length} replay trials to ${options.out}`)
} catch (error) {
  console.error(String(error))
  process.exitCode ||= 1
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
