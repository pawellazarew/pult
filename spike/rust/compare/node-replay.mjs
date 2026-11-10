#!/usr/bin/env node
// Read-only peer for the complete, single-writer replay benchmark; not a Pult daemon.
import { readFileSync, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { once } from 'node:events'

try {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--home' || !isAbsolute(args[1])) throw new Error('Usage: node node-replay.mjs --home /absolute/private-home')
  const home = args[1]
  const dir = lstatSync(home)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw new Error('home must be a private regular directory')
  const file = join(home, 'r1.ndjson')
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 32 * 1024 * 1024) throw new Error('journal must be private, regular and at most 32 MiB')
  const bytes = readFileSync(file)
  const end = bytes.lastIndexOf(10) + 1
  // Rust repairs an incomplete tail; this peer ignores it without mutating the fixture.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
  let sequence = 1
  const rows = []
  for (const line of text ? text.slice(0, -1).split('\n') : []) {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('oversized journal record')
    const row = JSON.parse(line)
    if (!row || row.sequence !== sequence || !Number.isSafeInteger(row.sequence) || typeof row.kind !== 'string' || !Object.hasOwn(row, 'data')) throw new Error('invalid record or non-contiguous sequence')
    rows.push({ sequence: sequence++, kind: row.kind, data: row.data })
  }
  for (const row of rows) if (!process.stdout.write(JSON.stringify(row) + '\n')) await once(process.stdout, 'drain')
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
}
