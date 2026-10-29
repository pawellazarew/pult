import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { getLanguage, setLanguage } from '../../../src/i18n/core.js'
import { refreshLanguage } from '../../src/language.js'
import { trayModel } from '../../src/tray.js'

it('shell language follows config, explicit env and native system locale; tray changes without restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'pult-shell-language-'))
  const prev = process.env['PULT_LANG']
  try {
    delete process.env['PULT_LANG']
    writeFileSync(join(home, 'config.json'), JSON.stringify({ language: 'en' }))
    refreshLanguage(home, 'ru-RU')
    assert.equal(getLanguage(), 'en')
    const menu = trayModel({ conn: { state: 'connecting', attempt: 0 }, status: null, sessions: null, pending: null })
    assert.equal(menu.tooltip, 'Pult · connecting to daemon…')
    assert.ok(menu.items.some((i) => i.kind === 'item' && i.label === 'Open Pult'))
    process.env['PULT_LANG'] = 'ru'
    refreshLanguage(home, 'en-US')
    assert.equal(getLanguage(), 'ru')
    assert.match(trayModel({ conn: { state: 'connecting', attempt: 0 }, status: null, sessions: null, pending: null }).tooltip, /Пульт/)
    process.env['PULT_LANG'] = 'auto'
    refreshLanguage(home, 'en-US')
    assert.equal(getLanguage(), 'en')
  } finally {
    if (prev === undefined) delete process.env['PULT_LANG']; else process.env['PULT_LANG'] = prev
    setLanguage('ru')
    rmSync(home, { recursive: true, force: true })
  }
})
