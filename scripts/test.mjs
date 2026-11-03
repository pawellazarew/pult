#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = ['dist-test', 'dist-ui-test'].flatMap((dir) =>
  {
    const names = readdirSync(join(root, dir)).filter((name) => name.endsWith('.test.js')).sort()
    if (!names.length) throw new Error(`No compiled tests in ${dir}`)
    return names.map((name) => join(root, dir, name))
  },
)
// CLI/installer tests start several children each. More files competing for CPU and disk
// make latency assertions measure host contention rather than daemon responsiveness.
const concurrency = Math.max(1, Math.min(2, availableParallelism() - 1))
console.log(`test runner: ${files.length} files, concurrency ${concurrency}`)
const child = spawnSync(process.execPath, [
  '--import', join(root, 'scripts/test-language.mjs'), '--test', `--test-concurrency=${concurrency}`,
  ...process.argv.slice(2), ...files,
], { cwd: root, stdio: 'inherit' })
if (child.error) throw child.error
process.exit(child.status ?? 1)
