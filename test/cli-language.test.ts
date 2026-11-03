import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import { setLanguage } from '../dist/i18n/core.js'
import { formatDoctor } from '../dist/env/doctor.js'
import { updateAppCli } from '../dist/update/appUpdateCli.js'

const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))
function help(config: unknown, env: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'pult-language-'))
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config))
    const r = spawnSync(process.execPath, [cli, '--help'], {
      encoding: 'utf8', env: { ...process.env, PULT_HOME: home, PULT_TEST: '1', PULT_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '', ...env },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(home, 'run')), false, 'help must not start a daemon or write state')
    return r.stdout
  } finally { rmSync(home, { recursive: true, force: true }) }
}
it('CLI English setting translates help, including placeholders and exit codes', () => {
  const text = help({ language: 'en' }, { LANG: 'ru_RU.UTF-8' })
  assert.match(text, /control center/)
  assert.match(text, /Exit codes: 0 success/)
  assert.match(text, /Playwright MCP \d/)
  assert.doesNotMatch(text, /[А-Яа-яЁё]|\{\d+\}/)
})
it('CLI explicit PULT_LANG overrides config, auto follows LC_ALL before LANG', () => {
  assert.match(help({ language: 'ru' }, { PULT_LANG: 'en' }), /control center/)
  assert.match(help({ language: 'en' }, { PULT_LANG: 'ru' }), /диспетчерская/)
  assert.match(help({ language: 'en' }, { PULT_LANG: 'auto', LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' }), /диспетчерская/)
  assert.match(help({}, { LC_ALL: 'C', LANG: 'ru_RU.UTF-8' }), /control center/)
})
it('CLI helper text is translated lazily after imports', async () => {
  setLanguage('en')
  try {
    const report = formatDoctor({ ok: true, generatedAt: '', home: '', items: [], counts: { ok: 1, warn: 0, fail: 0 } })
    assert.match(report, /total: ok 1/)
    const out: string[] = []
    assert.equal(await updateAppCli({ out: (s) => out.push(s), err: () => {} }, { platform: 'linux', connect: async () => { throw new Error('unexpected connection') } }), 0)
    assert.match(out[0]!, /Automatic window updates are available only on macOS/)
    assert.doesNotMatch(out[0]!, /[А-Яа-яЁё]/)
  } finally { setLanguage('ru') }
})
