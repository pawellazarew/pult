import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execAsync } from '../dist/env/exec.js'

test('device text travels as UTF-8 stdin, preserving Unicode and shell metacharacters', async () => {
  const input = "Привет 👋 '; $HOME $(not-a-command)\nline two"
  const r = await execAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 3000, input })
  assert.equal(r.status, 0); assert.equal(r.stdout, input)
})

test('early stdin exit does not crash the caller with EPIPE', async () => {
  const r = await execAsync(process.execPath, ['-e', 'process.exit(4)'], { timeoutMs: 3000, input: 'a'.repeat(300_000) })
  assert.equal(r.status, 4)
})
