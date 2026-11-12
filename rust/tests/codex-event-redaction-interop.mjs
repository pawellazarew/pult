// Actual Node mapper oracle; no provider, image capture, probes or file writes.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const moduleUrl = new URL('../../dist/adapters/codex/mapper.js', import.meta.url)
if (!existsSync(fileURLToPath(moduleUrl))) {
  process.stderr.write('Run npm ci && npm run build before Codex mapper interop\n')
  process.exitCode = 1
} else {
  const { createCodexMapper } = await import(moduleUrl)
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) throw new Error('mapper corpus exceeds input budget')
    chunks.push(chunk)
  }
  const corpus = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(corpus) || corpus.length > 32) throw new Error('invalid mapper corpus')
  const drafts = corpus.map(events => {
    const mapper = createCodexMapper({ sessionId: 'trusted-session', model: 'model-trusted' })
    return events.flatMap(event => mapper.push(event.method, event.params).drafts)
  })
  process.stdout.write(JSON.stringify(drafts))
}
