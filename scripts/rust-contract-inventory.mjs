#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out') {
  console.error('Usage: node scripts/rust-contract-inventory.mjs --out /absolute/contracts.json')
  process.exit(2)
}
const source = readFileSync(resolve(root, 'src/daemon/server.ts'), 'utf8')
const cases = [...new Set([...source.matchAll(/case '([a-zA-Z][a-zA-Z0-9_.]+\.[a-zA-Z0-9_.]+)'\s*:/g)].map((m) => m[1]))].sort()
if (!cases.length) throw new Error('No RPC cases found: review the extractor after router changes')
const result = {
  schemaVersion: 1,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'Literal dotted switch cases in src/daemon/server.ts; not a generated API schema or proof of coverage.',
  rpcCases: cases,
  testFiles: readdirSync(resolve(root, 'test')).filter((n) => n.endsWith('.test.ts')).sort(),
  uiTestFiles: readdirSync(resolve(root, 'ui/test')).filter((n) => n.endsWith('.test.ts')).sort(),
  shellE2eFiles: readdirSync(resolve(root, 'shell/test/e2e')).filter((n) => n.endsWith('.test.ts')).sort(),
  contractSources: ['src/core/rpc.ts', 'src/core/events.ts', 'src/adapters/types.ts'],
}
const output = resolve(args[1])
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(`Saved ${cases.length} literal RPC cases to ${output}`)
