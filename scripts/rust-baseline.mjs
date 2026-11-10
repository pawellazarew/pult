#!/usr/bin/env node
// R0 fixture baseline: real daemon/socket/storage, fake providers, no installed Pult or model traffic.
import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { cpus, platform, release, arch } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const self = fileURLToPath(import.meta.url)
const root = resolve(dirname(self), '..')
const args = process.argv.slice(2)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

if (args.includes('--worker')) {
  const { tempHome, startTestDaemon } = await import('../dist-test/helpers.js')
  const home = tempHome()
  home.config.autoTitle = false
  let daemon
  let ending = false
  const stop = async () => {
    if (ending) return
    ending = true
    try { await daemon?.stop('baseline finished') } finally { home.remove() }
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  process.on('disconnect', () => void stop())
  process.on('message', (m) => {
    if (m === 'stop') void stop()
    if (m === 'sample') process.send?.({ kind: 'sample', rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage() })
  })
  try {
    daemon = await startTestDaemon(home)
    process.send?.({ kind: 'ready', paths: home.paths })
  } catch (error) {
    process.send?.({ kind: 'failure', message: String(error) })
    await stop()
  }
} else {
  if (!args.includes('--out') || args.length !== 2 || args[0] !== '--out') {
    console.error('Usage: npm run build && node scripts/rust-baseline.mjs --out /absolute/evidence.json')
    process.exit(2)
  }
  const output = resolve(args[1])
  const { connectClient } = await import('../dist/cli/client.js')
  const rows = []
  let active = null
  const abort = () => { if (active?.connected) active.send('stop'); process.exitCode = 130 }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]
  const timing = async (run, n = 30) => {
    const samples = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      await run()
      samples.push(performance.now() - t)
    }
    return { n, p50Ms: quantile(samples, .5), p95Ms: quantile(samples, .95) }
  }
  const tree = (pid) => {
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
    const ids = new Set([pid])
    for (let changed = true; changed;) {
      changed = false
      for (const [id, parent] of processes) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true }
    }
    return { processCount: ids.size, rssBytes: processes.filter(([id]) => ids.has(id)).reduce((sum, [, , rss]) => sum + rss * 1024, 0) }
  }
  const inbox = (child) => {
    const messages = []
    let waiting = null
    let exited = false
    child.on('message', (m) => {
      if (waiting) { const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve(m) }
      else messages.push(m)
    })
    child.on('exit', (code) => {
      exited = true
      if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error(`baseline child exited: ${code}`)); waiting = null }
    })
    return () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
      if (exited) { reject(new Error('baseline child already exited')); return }
      waiting = { resolve, reject, timer: setTimeout(() => { waiting = null; reject(new Error('baseline IPC timeout')) }, 30_000) }
    })
  }
  try {
    for (const sessions of [0, 1, 10]) {
      if (process.exitCode) throw new Error('interrupted')
      const t0 = performance.now()
      const child = fork(self, ['--worker'], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, PULT_LANG: 'en' } })
      active = child
      let stderr = ''
      child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-8192) })
      const next = inbox(child)
      let client
      try {
        const ready = await next()
        if (ready.kind !== 'ready') throw new Error(ready.message ?? 'worker not ready')
        client = await connectClient(ready.paths)
        const startupMs = performance.now() - t0
        const request = (method, params = {}) => client.request(method, params, { timeoutMs: 15_000 })
        for (let i = 0; i < sessions; i++) {
          const cwd = resolve(ready.paths.home, `work-${i}`)
          mkdirSync(cwd)
          await request('agent.start', { name: `fixture-${i}`, kind: 'codex', cwd })
          await request('agent.prompt', { name: `fixture-${i}`, text: '[[hang]]' })
        }
        // Wait for all threads to enter their deterministic active turn.
        const deadline = Date.now() + 15_000
        while (sessions) {
          const list = await request('agent.list')
          const agents = Array.isArray(list) ? list : list.agents ?? list.sessions ?? []
          if (agents.length === sessions && agents.every((a) => a.lastStatus === 'working')) break
          if (Date.now() > deadline) throw new Error('fixture threads did not become working')
          await pause(20)
        }
        const status = await timing(() => request('daemon.status'))
        child.send('sample')
        const before = await next()
        const processTree = tree(child.pid)
        const sampleStart = performance.now()
        await pause(1000)
        child.send('sample')
        const after = await next()
        const idleCpuPercentOneCore = ((after.cpu.user - before.cpu.user) + (after.cpu.system - before.cpu.system)) / ((performance.now() - sampleStart) * 1000) * 100
        const histories = []
        for (const events of [100, 10_000]) {
          const sessionId = `history-${events}`
          for (let i = 0; i < events; i++) await request('events.emit', { sessionId, provider: 'codex', kind: 'message.done', data: { text: `fixture ${i} ${'x'.repeat(256)}` } })
          const coldStart = performance.now()
          const page = await request('events.history', { sessionId })
          const coldMs = performance.now() - coldStart
          const warm = await timing(() => request('events.history', { sessionId }), 10)
          histories.push({ events, firstPageMs: coldMs, repeatedFirstPage: warm, responseBytes: Buffer.byteLength(JSON.stringify(page)) })
        }
        rows.push({ sessions, provider: 'fake-codex-app-server', startupMs, status, idleCpuPercentOneCore, daemonRssBytes: before.rssBytes, processTree, histories })
      } finally {
        client?.close()
        if (child.exitCode === null && child.signalCode === null) {
          const ended = new Promise((r) => child.once('exit', r))
          child.send('stop')
          const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }, 10_000)
          await ended
          clearTimeout(timer)
        }
        active = null
        if (child.signalCode || child.exitCode !== 0) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* process group is already gone */ }
          throw new Error(`worker cleanup failed (${child.signalCode ?? child.exitCode}); scratch data may remain; no successful evidence saved: ${stderr}`)
        }
      }
    }
    const result = {
      schemaVersion: 1, measuredAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      trackedDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()),
      scriptSha256: createHash('sha256').update(readFileSync(self)).digest('hex'),
      host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version },
      scope: 'Fixture baseline: real isolated daemon and RPC; fake Codex threads sharing one app-server; daemon RSS includes imported test helpers. No Electron, real model traffic, or claims about production throughput.',
      rows,
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    console.log(`Saved ${rows.length} fixture scenarios to ${output}`)
  } catch (error) {
    console.error(String(error))
    process.exitCode = process.exitCode || 1
  }
}
