import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, waitFor } from './harness.js'

it('RU → EN → RU: saved language, chrome, drafts and session names survive reload and reopen', async () => {
  const h = await launch({ name: 'language', env: { PULT_LANG: '' } })
  try {
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client()
    await c.request('settings.set', { language: 'ru' })
    // Go through shell IPC too: refreshes native language before the reload.
    await h.win.evaluate(async () => { await window.pult!.call('settings.set', { language: 'ru' }) })
    await h.win.reload()
    await h.win.getByTestId('open-settings').waitFor()
    assert.equal(await h.win.locator('html').getAttribute('lang'), 'ru')
    await c.request('agent.start', { name: 'russian-name', title: 'Мой проект', kind: 'claude', cwd: h.workDir('russian-name', { scenario: 'simple' }) })
    await h.win.locator('[data-testid="agent-row"][data-agent="russian-name"]').click()
    const input = h.win.locator('textarea').first()
    await input.fill('Мой несохранённый текст {0}')
    await h.win.getByTestId('open-settings').click()
    await h.win.getByTestId('settings-language').selectOption('en')
    assert.equal(await h.win.locator('html').getAttribute('lang'), 'ru')
    await h.win.getByTestId('settings-remember-last').uncheck()
    await h.win.getByTestId('settings-save').click()
    assert.ok(await waitFor(async () => await h.win.locator('html').getAttribute('lang') === 'en', 10_000))
    await h.win.getByTestId('open-settings').waitFor()
    assert.match(await h.win.getByTestId('open-settings').innerText(), /Settings/)
    assert.equal(JSON.parse(readFileSync(path.join(h.home, 'config.json'), 'utf8')).language, 'en')
    assert.equal(JSON.parse(readFileSync(path.join(h.home, 'config.json'), 'utf8')).newSession.rememberLast, false)
    assert.ok(await waitFor(async () => await h.win.locator('[data-testid="agent-row"][data-agent="russian-name"]').count() === 1))
    assert.match(await h.win.locator('[data-testid="agent-row"][data-agent="russian-name"]').innerText(), /Мой проект/)
    assert.equal(await h.win.locator('textarea').first().inputValue(), 'Мой несохранённый текст {0}')
    await h.win.getByTestId('open-settings').click()
    await h.win.getByTestId('settings-dialog').waitFor()
    assert.match(await h.win.getByTestId('settings-dialog').innerText(), /Language/i)
    await h.screen('language-english-settings')
    await h.reopen()
    assert.ok(await waitFor(async () => await h.win.locator('html').getAttribute('lang') === 'en'))
    await h.win.getByTestId('open-settings').click()
    await h.win.getByTestId('settings-language').selectOption('ru')
    await h.win.getByTestId('settings-save').click()
    assert.ok(await waitFor(async () => await h.win.locator('html').getAttribute('lang') === 'ru', 10_000))
    assert.match(await h.win.getByTestId('open-settings').innerText(), /Настройки/)
  } finally { await h.close() }
})
