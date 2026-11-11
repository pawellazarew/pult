// Pure cross-language oracle: validate the supplied JSON using the actual Node
// implementation and emit only configToFile results. No settings writes/probes.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const moduleUrl = new URL('../../dist/core/config.js', import.meta.url)
if (!existsSync(fileURLToPath(moduleUrl))) {
  process.stderr.write('Run npm ci && npm run build before runtime config interoperability tests\n')
  process.exitCode = 1
} else {
  const { validateConfig, configToFile } = await import(moduleUrl)
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) throw new Error('config corpus exceeds input budget')
    chunks.push(chunk)
  }
  const corpus = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(corpus) || corpus.length > 64) throw new Error('invalid config corpus')
  process.stdout.write(JSON.stringify(corpus.map(raw => configToFile(validateConfig(raw).config))))
}
