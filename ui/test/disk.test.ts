import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiskSettings, defaultCleanupPrompt, freeDiskText } from '../src/components/DiskSettings.js'
import { setLanguage } from '../../src/i18n/core.js'
it('default prompt follows RU/EN; custom text is rendered unchanged; unknown has no fake free space', () => {
  try {
    setLanguage('ru'); assert.equal(defaultCleanupPrompt(), 'Помоги почистить диск')
    setLanguage('en'); assert.equal(defaultCleanupPrompt(), 'Help me free up disk space')
    const status = { state: 'unknown' as const, freeBytes: null, thresholdBytes: 6e9, path: '/data', checkedAt: 'now' }
    assert.equal(freeDiskText(status), 'Could not determine free disk space')
    const html = renderToStaticMarkup(createElement(DiskSettings, { disk: { settings: { thresholdGb: 6, prompt: 'мой текст' }, status }, onSave: async () => {} }))
    assert.match(html, /мой текст/)
    assert.match(html, /Help me free up disk space/)
    assert.match(html, /\/data/)
  } finally { setLanguage('ru') }
})
