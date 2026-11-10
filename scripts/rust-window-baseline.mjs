#!/usr/bin/env node
// Isolated whole-window fixture measurement; never attaches to installed Pult.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { cpus, platform, release, arch } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out') {
  console.error('Usage after root/shell test builds: node scripts/rust-window-baseline.mjs --out /tmp/window.json')
  process.exit(2)
}
const { launch, waitFor } = await import('../shell/dist-test/e2e/harness.js')
const start = performance.now()
const h = await launch({ name: 'rust-r0-window-baseline' })
let client, cleanupPromise
let interrupted = false
const cleanup = () => cleanupPromise ??= h.close()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; process.exitCode = 130; void cleanup().catch(() => {}) })
try {
  if (!await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000)) throw new Error('window did not connect')
  const startupMs = performance.now() - start
  client = await h.client()
  h.codexConfig({ scenario: 'hang' })
  const rows = []
  let created = 0
  for (const sessions of [0, 1, 10]) {
    for (; created < sessions; created++) {
      const name = `fixture-${created}`
      await client.request('agent.start', { name, kind: 'codex', cwd: h.workDir(name) }, { timeoutMs: 15_000 })
      await client.request('agent.prompt', { name, text: '[[hang]]' }, { timeoutMs: 15_000 })
    }
    if (!await waitFor(async () => {
      const list = await client.request('agent.list', {}, { timeoutMs: 5000 })
      return list.sessions.length === sessions && list.sessions.every((a) => a.lastStatus === 'working')
    }, 15_000)) throw new Error('fixture threads did not become active')
    await h.app.evaluate(({ app }) => app.getAppMetrics())
    await new Promise((r) => setTimeout(r, 2000))
    const metrics = await h.app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({
      type: p.type, cpuPercent: p.cpu.percentCPUUsage, workingSetKiB: p.memory.workingSetSize,
    })))
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((s) => s.trim().split(/\s+/).map(Number))
    const ids = new Set([h.app.process().pid, h.daemonPid()].filter(Boolean))
    for (let changed = true; changed;) {
      changed = false
      for (const [id, parent] of processes) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true }
    }
    rows.push({ sessions, electron: metrics, tree: {
      processCount: ids.size, rssBytes: processes.filter(([id]) => ids.has(id)).reduce((sum, [, , rss]) => sum + rss * 1024, 0),
    } })
  }
  const result = {
    schemaVersion: 1, measuredAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
    scope: 'Electron source harness + real daemon + fake Codex; no real model, installed app or GPU timing. Electron working set and ps RSS are distinct metrics. CPU is Electron interval estimate, not full-tree CPU.',
    startupMs, rows,
  }
  if (interrupted) throw new Error('window measurement interrupted; no success evidence saved')
  const output = resolve(args[1])
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`Saved fixture window metrics to ${output}`)
} finally {
  client?.close()
  await cleanup()
}
