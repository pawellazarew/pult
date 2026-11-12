#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) { throw new Error(message) }

function sourceInventory(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const routes = new Set()
  let reserved = null
  const visit = (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text.includes('.')) routes.add(node.expression.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'LATER_METHODS') {
      const declaration = node.initializer
      if (!declaration || !ts.isNewExpression(declaration) || !ts.isIdentifier(declaration.expression) || declaration.expression.text !== 'Set' || !declaration.arguments || declaration.arguments.length !== 1 || !ts.isArrayLiteralExpression(declaration.arguments[0])) fail('LATER_METHODS must be a literal Set array; update inventory extraction for a new router')
      reserved = declaration.arguments[0].elements.map((element) => {
        if (!ts.isStringLiteral(element)) fail('LATER_METHODS must contain literal method names')
        return element.text
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!routes.size || reserved === null) fail('RPC router declarations were not found')
  return { routes, reserved: new Set(reserved) }
}

function schemaType(schema) {
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return schema.oneOf.map(schemaType).join(' | ')
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.type)) return schema.type.map((type) => schemaType({ ...schema, type })).join(' | ')
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties ?? {}).map(([name, value]) => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${schemaType(value)}`)
    if (schema.additionalProperties === true) fields.push('[key: string]: unknown')
    return fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, never>'
  }
  if (schema.type === 'array') return `Array<${schemaType(schema.items)}>`
  if (schema.type === 'integer' || schema.type === 'number') return 'number'
  if (['string', 'boolean', 'null'].includes(schema.type)) return schema.type
  fail(`Unsupported schema type ${JSON.stringify(schema.type)}`)
}

function validateCatalog(catalog, inventory, protocolSource) {
  const source = ts.createSourceFile(protocolSource, readFileSync(protocolSource, 'utf8'), ts.ScriptTarget.Latest, true)
  let protocolVersion
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PROTOCOL_VERSION' && node.initializer && ts.isNumericLiteral(node.initializer)) protocolVersion = Number(node.initializer.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (protocolVersion === undefined) fail('Literal PROTOCOL_VERSION was not found')
  if (catalog.catalogVersion !== 1 || catalog.protocolVersion !== protocolVersion || !Array.isArray(catalog.methods)) fail('Catalog version disagrees with the Node protocol source')
  const names = new Set()
  for (const method of catalog.methods) {
    if (typeof method.name !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(method.name) || names.has(method.name)) fail(`Invalid or duplicate method ${method.name}`)
    names.add(method.name)
    if (!['implemented', 'reserved', 'extension'].includes(method.node) || !['implemented', 'partial', 'unported'].includes(method.rust)) fail(`Invalid implementation state for ${method.name}`)
    if (!['owner', 'ask', 'owner-or-runtime', 'owner-or-memory', 'owner-shell'].includes(method.access) || typeof method.testOnly !== 'boolean' || typeof method.description !== 'string' || !method.description.trim()) fail(`Invalid metadata for ${method.name}`)
    if (method.node === 'implemented' && !inventory.routes.has(method.name)) fail(`Catalog Node route missing from source: ${method.name}`)
    if (method.node === 'reserved' && (!inventory.reserved.has(method.name) || inventory.routes.has(method.name))) fail(`Catalog reserved route missing from LATER_METHODS: ${method.name}`)
    if (method.node === 'extension' && (inventory.routes.has(method.name) || inventory.reserved.has(method.name))) fail(`Extension now exists in Node source: ${method.name}; update its state`)
    if (method.rust === 'unported') {
      if (method.paramsSchema !== null || method.resultSchema !== null) fail(`Unported method must leave schemas null: ${method.name}`)
    } else {
      if (!method.paramsSchema || !method.resultSchema) fail(`Implemented or partial method requires both schemas: ${method.name}`)
      schemaType(method.paramsSchema)
      schemaType(method.resultSchema)
    }
  }
  for (const name of inventory.routes) if (!catalog.methods.some((method) => method.name === name && method.node === 'implemented')) fail(`Source RPC route missing from catalog: ${name}`)
  for (const name of inventory.reserved) if (!inventory.routes.has(name) && !catalog.methods.some((method) => method.name === name && method.node === 'reserved')) fail(`Reserved RPC route missing from catalog: ${name}`)
  const sorted = [...names].sort()
  if (catalog.methods.some((method, index) => method.name !== sorted[index])) fail('Catalog methods must be sorted by name')
}

function render(catalog) {
  const implemented = catalog.methods.filter((method) => method.rust === 'implemented')
  const partial = catalog.methods.filter((method) => method.rust === 'partial')
  const table = (methods, name, key) => `export interface ${name} {\n${methods.map((method) => `  ${JSON.stringify(method.name)}: ${schemaType(method[key])}`).join('\n')}\n}\n`
  return '// Generated by scripts/generate-rpc-catalog.mjs from protocol/methods.json.\n// Change the catalog and regenerate; --check also verifies the Node router inventory.\n\n'
    + `export const RPC_CATALOG = ${JSON.stringify(catalog, null, 2)} as const\n\n`
    + 'export type RpcMethodName = typeof RPC_CATALOG.methods[number][\'name\']\n'
    + `export type RustFoundationMethod = ${implemented.map((method) => JSON.stringify(method.name)).join(' | ')}\n\n`
    + table(implemented, 'RustFoundationParams', 'paramsSchema') + '\n' + table(implemented, 'RustFoundationResults', 'resultSchema')
    + `\nexport type RustPartialMethod = ${partial.length ? partial.map((method) => JSON.stringify(method.name)).join(' | ') : 'never'}\n\n`
    + table(partial, 'RustPartialParams', 'paramsSchema') + '\n' + table(partial, 'RustPartialResults', 'resultSchema')
}

try {
  const options = { catalog: resolve(root, 'protocol/methods.json'), source: resolve(root, 'src/daemon/server.ts'), out: resolve(root, 'src/core/methodCatalog.ts'), 'protocol-source': resolve(root, 'src/core/rpc.ts'), check: false }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--check') options.check = true
    else if (['--catalog', '--source', '--out', '--protocol-source'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = resolve(args[++i])
    else fail('Usage: node scripts/generate-rpc-catalog.mjs [--check] [--catalog path] [--source path] [--protocol-source path] [--out path]')
  }
  const catalog = JSON.parse(readFileSync(options.catalog, 'utf8'))
  validateCatalog(catalog, sourceInventory(options.source), options['protocol-source'])
  const generated = render(catalog)
  if (options.check) {
    let current
    try { current = readFileSync(options.out, 'utf8') } catch { fail('Generated RPC catalog is missing; regenerate it') }
    if (current !== generated) fail('Generated RPC catalog is stale; run node scripts/generate-rpc-catalog.mjs')
  } else {
    mkdirSync(dirname(options.out), { recursive: true })
    writeFileSync(options.out, generated)
  }
  console.log(`RPC catalog ${options.check ? 'checked' : 'generated'}: ${catalog.methods.length} methods, ${catalog.methods.filter((method) => method.rust === 'implemented').length} Rust foundation methods, ${catalog.methods.filter((method) => method.rust === 'partial').length} Rust partial methods`)
} catch (error) {
  console.error(`rpc-catalog: ${error.message}`)
  process.exitCode = 1
}
