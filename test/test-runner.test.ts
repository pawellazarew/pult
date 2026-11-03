import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

function fixture(ui: boolean): { code: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'pult-runner-'))
  try {
    for (const dir of ['scripts', 'dist-test', 'dist-ui-test']) mkdirSync(join(root, dir))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    copyFileSync(fileURLToPath(new URL('../scripts/test.mjs', import.meta.url)), join(root, 'scripts/test.mjs'))
    writeFileSync(join(root, 'scripts/test-language.mjs'), 'process.env.PULT_RUNNER_FIXTURE = "ready"')
    const body = 'import {it} from "node:test"; import assert from "node:assert/strict"; it("fixture",()=>assert.equal(process.env.PULT_RUNNER_FIXTURE,"ready"));'
    writeFileSync(join(root, 'dist-test/package.test.js'), body)
    if (ui) writeFileSync(join(root, 'dist-ui-test/ui.test.js'), body)
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    delete env['NODE_OPTIONS']
    const r = spawnSync(process.execPath, [join(root, 'scripts/test.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
    if (r.error) throw r.error
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it('test runner выполняет оба набора с языковым bootstrap', () => {
  const r = fixture(true)
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /tests 2/)
  assert.match(r.stdout, /pass 2/)
})

it('test runner отказывает, если один скомпилированный набор пуст', () => {
  const r = fixture(false)
  assert.notEqual(r.code, 0, 'нельзя молча пропустить весь набор UI')
  assert.match(r.stderr, /No compiled tests in dist-ui-test/)
})
