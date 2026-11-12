import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const script = fileURLToPath(new URL('../scripts/generate-rpc-catalog.mjs', import.meta.url))
const catalogSource = fileURLToPath(new URL('../protocol/methods.json', import.meta.url))
const routerSource = fileURLToPath(new URL('../src/daemon/server.ts', import.meta.url))
const protocolSource = fileURLToPath(new URL('../src/core/rpc.ts', import.meta.url))

interface CatalogMethod {
  name: string
  node: string
  rust: string
  access: string
  paramsSchema: unknown
  resultSchema: unknown
}
interface Catalog { methods: CatalogMethod[]; [key: string]: unknown }

function fixture(run: (paths: { catalog: string; source: string; protocol: string; out: string }) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'pult-rpc-catalog-'))
  const paths = { catalog: join(home, 'methods.json'), source: join(home, 'server.ts'), protocol: join(home, 'rpc.ts'), out: join(home, 'catalog.ts') }
  try {
    copyFileSync(catalogSource, paths.catalog)
    copyFileSync(routerSource, paths.source)
    copyFileSync(protocolSource, paths.protocol)
    run(paths)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function generate(paths: { catalog: string; source: string; protocol: string; out: string }, check = false) {
  return spawnSync(process.execPath, [script, '--catalog', paths.catalog, '--source', paths.source, '--protocol-source', paths.protocol, '--out', paths.out, ...(check ? ['--check'] : [])], { encoding: 'utf8', timeout: 15_000 })
}

function changeCatalog(path: string, change: (catalog: Catalog) => void): void {
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as Catalog
  change(catalog)
  writeFileSync(path, JSON.stringify(catalog))
}

describe('RPC catalog generation and source drift', () => {
  it('checks the committed catalog and rejects a stale generated file without changing it', () => {
    const current = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(current.status, 0, current.stderr)
    fixture((paths) => {
      const generated = generate(paths)
      assert.equal(generated.status, 0, generated.stderr)
      writeFileSync(paths.out, 'stale generated output\n')
      const checked = generate(paths, true)
      assert.equal(checked.status, 1)
      assert.match(checked.stderr, /stale/)
      assert.equal(readFileSync(paths.out, 'utf8'), 'stale generated output\n')
    })
  })

  it('keeps partial schemas separate from the 28 fully implemented methods', () => {
    const catalog = JSON.parse(readFileSync(catalogSource, 'utf8')) as Catalog
    const implemented = catalog.methods.filter((method) => method.rust === 'implemented').map((method) => method.name)
    const partial = catalog.methods.filter((method) => method.rust === 'partial')
    assert.equal(implemented.length, 28)
    assert.equal(catalog.methods.length, 99)
    assert.equal(catalog.methods.filter((method) => method.node === 'implemented').length, 85)
    assert.deepEqual(partial.map((method) => method.name), ['agent.list', 'agent.prompt', 'agent.start', 'agent.stop', 'perm.list', 'perm.resolve'])
    assert.ok(partial.every((method) => method.paramsSchema && method.resultSchema))
    fixture((paths) => {
      const generated = generate(paths)
      assert.equal(generated.status, 0, generated.stderr)
      const output = readFileSync(paths.out, 'utf8')
      const foundation = output.match(/^export type RustFoundationMethod = (.+)$/m)?.[1]
      assert.ok(foundation)
      assert.deepEqual(foundation.split(' | ').map((name) => JSON.parse(name) as string), implemented)
      const partialUnion = output.match(/^export type RustPartialMethod = (.+)$/m)?.[1]
      assert.ok(partialUnion)
      assert.deepEqual(partialUnion.split(' | ').map((name) => JSON.parse(name) as string), partial.map((method) => method.name))
      assert.match(output, /export interface RustPartialParams/)
      assert.match(output, /export interface RustPartialResults/)
    })
  })

  it('validates turn-memory access metadata and includes it in the catalog response enum', () => {
    const catalog = JSON.parse(readFileSync(catalogSource, 'utf8')) as Catalog
    const mutations = catalog.methods.filter((method) => method.access === 'owner-or-turn-memory')
    assert.deepEqual(mutations.map((method) => method.name), ['memory.add', 'memory.forget', 'memory.update'])
    const reads = catalog.methods.filter((method) => method.access === 'owner-or-memory')
    assert.deepEqual(reads.map((method) => method.name), ['memory.catalog', 'memory.get', 'memory.list', 'memory.search'])
    const response = catalog.methods.find((method) => method.name === 'protocol.catalog')?.resultSchema as {
      properties: { methods: { items: { properties: { access: { enum: string[] } } } } }
    }
    assert.ok(response.properties.methods.items.properties.access.enum.includes('owner-or-turn-memory'))
    assert.ok(catalog.methods.every((method) => response.properties.methods.items.properties.access.enum.includes(method.access)))
    fixture((paths) => {
      changeCatalog(paths.catalog, (value) => { value.methods[0]!.access = 'owner-or-invented' })
      const rejected = generate(paths)
      assert.equal(rejected.status, 1)
      assert.match(rejected.stderr, /Invalid metadata/)
    })
    fixture((paths) => {
      changeCatalog(paths.catalog, (value) => { value.methods[0]!.access = 'owner-or-turn-memory' })
      const accepted = generate(paths)
      assert.equal(accepted.status, 0, accepted.stderr)
    })
  })

  it('describes strict owner configuration, optional session policy, and server-derived provenance', () => {
    const catalog = JSON.parse(readFileSync(catalogSource, 'utf8'))
    const method = (name: string) => catalog.methods.find((entry: { name: string }) => entry.name === name)
    const configure = method('memory.configure')
    assert.equal(configure.node, 'extension')
    assert.equal(configure.rust, 'implemented')
    assert.equal(configure.access, 'owner')
    assert.deepEqual(configure.paramsSchema.required, ['session'])
    assert.equal(configure.paramsSchema.additionalProperties, false)
    const inputPolicy = configure.paramsSchema.properties.memory
    assert.equal(inputPolicy.additionalProperties, false)
    assert.deepEqual(inputPolicy.required, [])
    assert.deepEqual(inputPolicy.properties.write.enum, ['off', 'ask'])
    assert.deepEqual(configure.resultSchema.properties.memory.required, ['read', 'write'])
    assert.deepEqual(method('agent.start').paramsSchema.properties.memory, inputPolicy)
    assert.deepEqual(method('agent.start').resultSchema.properties.memory, configure.resultSchema.properties.memory)
    const listedRecord = method('agent.list').resultSchema.properties.sessions.items
    assert.equal(listedRecord.additionalProperties, true)
    assert.equal(listedRecord.properties.memory, undefined, 'recovered future policy stays opaque instead of claiming normalized authority')
    assert.ok(!method('agent.start').paramsSchema.required.includes('memory'))
    for (const name of ['memory.add', 'memory.update', 'memory.forget', 'memory.get']) {
      const entry = method(name)
      const record = entry.resultSchema
      assert.deepEqual(record.properties.author.enum, ['owner', 'claude', 'codex', 'zcode'])
      assert.equal(record.properties.sourceEventId.minimum, 1)
      assert.equal(record.properties.sourceEventId.maximum, Number.MAX_SAFE_INTEGER)
      assert.equal(record.properties.sourceTurnId.maxLength, 256)
      assert.equal(record.properties.sourceCreatedAt.type, 'string')
      for (const field of ['sourceEventId', 'sourceTurnId', 'sourceCreatedAt']) {
        assert.ok(!record.required.includes(field))
        assert.equal(entry.paramsSchema.properties[field], undefined)
      }
    }
  })

  it('requires both schemas and supported schema types for partial methods', () => {
    for (const mutation of ['params', 'results', 'unsupported-schema'] as const) {
      fixture((paths) => {
        changeCatalog(paths.catalog, (catalog) => {
          const partial = catalog.methods.find((method) => method.rust === 'partial')
          assert.ok(partial)
          if (mutation === 'params') partial.paramsSchema = null
          else if (mutation === 'results') partial.resultSchema = null
          else partial.paramsSchema = { type: 'invented' }
        })
        const result = generate(paths)
        assert.equal(result.status, 1)
        assert.match(result.stderr, mutation === 'unsupported-schema' ? /Unsupported schema type/ : /requires both schemas/)
      })
    }
  })

  it('rejects unknown Rust states and permits an empty partial union', () => {
    fixture((paths) => {
      changeCatalog(paths.catalog, (catalog) => { (catalog.methods[0] as CatalogMethod).rust = 'complete-ish' })
      const invalid = generate(paths)
      assert.equal(invalid.status, 1)
      assert.match(invalid.stderr, /Invalid implementation state/)
    })
    fixture((paths) => {
      changeCatalog(paths.catalog, (catalog) => {
        for (const method of catalog.methods) if (method.rust === 'partial') {
          method.rust = 'unported'
          method.paramsSchema = null
          method.resultSchema = null
        }
      })
      const generated = generate(paths)
      assert.equal(generated.status, 0, generated.stderr)
      assert.match(readFileSync(paths.out, 'utf8'), /export type RustPartialMethod = never/)
    })
  })

  it('detects a newly added Node route until the canonical catalog records it', () => {
    fixture((paths) => {
      writeFileSync(paths.source, readFileSync(paths.source, 'utf8') + "\nswitch (method) { case 'future.action': break }\n")
      const missing = generate(paths)
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /Source RPC route missing from catalog: future.action/)
      changeCatalog(paths.catalog, (catalog) => {
        catalog.methods.push({ ...catalog.methods[0], name: 'future.action', node: 'implemented', rust: 'unported', paramsSchema: null, resultSchema: null } as CatalogMethod)
        catalog.methods.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      })
      const recorded = generate(paths)
      assert.equal(recorded.status, 0, recorded.stderr)
    })
  })

  it('tracks reserved methods separately from implemented Node routes', () => {
    fixture((paths) => {
      const source = readFileSync(paths.source, 'utf8')
      const updated = source.replace('const LATER_METHODS = new Set<string>([])', "const LATER_METHODS = new Set<string>(['future.reserved'])")
      assert.notEqual(updated, source)
      writeFileSync(paths.source, updated)
      const missing = generate(paths)
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /Reserved RPC route missing from catalog: future.reserved/)
      changeCatalog(paths.catalog, (catalog) => {
        catalog.methods.push({ ...catalog.methods[0], name: 'future.reserved', node: 'reserved', rust: 'unported', paramsSchema: null, resultSchema: null } as CatalogMethod)
        catalog.methods.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      })
      const recorded = generate(paths)
      assert.equal(recorded.status, 0, recorded.stderr)
    })
  })

  it('catches a removed route and a changed Node protocol version', () => {
    fixture((paths) => {
      const source = readFileSync(paths.source, 'utf8')
      writeFileSync(paths.source, source.replaceAll("case 'daemon.status':", "case 'daemon.changed':"))
      const removed = generate(paths)
      assert.equal(removed.status, 1)
      assert.match(removed.stderr, /Node route missing from source: daemon.status/)
      writeFileSync(paths.source, source)
      const protocol = readFileSync(paths.protocol, 'utf8')
      const changed = protocol.replace('PROTOCOL_VERSION = 1', 'PROTOCOL_VERSION = 2')
      assert.notEqual(changed, protocol)
      writeFileSync(paths.protocol, changed)
      const mismatched = generate(paths)
      assert.equal(mismatched.status, 1)
      assert.match(mismatched.stderr, /version disagrees/)
    })
  })

  it('rejects duplicate names and invented schemas for unported methods', () => {
    for (const mutation of ['duplicate', 'unported-schema'] as const) {
      fixture((paths) => {
        changeCatalog(paths.catalog, (catalog) => {
          if (mutation === 'duplicate') catalog.methods.push(catalog.methods[0] as CatalogMethod)
          else {
            const unported = catalog.methods.find((method) => method.rust === 'unported')
            assert.ok(unported)
            unported.resultSchema = { type: 'object', additionalProperties: true }
          }
        })
        const result = generate(paths)
        assert.equal(result.status, 1)
        assert.match(result.stderr, mutation === 'duplicate' ? /duplicate method/ : /Unported method must leave schemas null/)
      })
    }
  })
})
