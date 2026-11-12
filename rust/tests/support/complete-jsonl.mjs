import { existsSync, readFileSync } from 'node:fs'

// A live append stream commits a record with its newline. Defer only the
// unfinished tail; JSON.parse must still reject every complete corrupt record.
export function readCompleteJsonl(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const end = text.lastIndexOf('\n')
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line))
}
