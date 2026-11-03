import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectLanguage, resolveLanguage, setLanguage, translator } from '../dist/i18n/core.js'
import { defaultConfig, validateConfig, writeLanguage } from '../dist/core/config.js'
import { guardLine } from '../dist/core/guard.js'
import { withLanguage } from '../dist/i18n/context.js'
import { connectClient } from '../dist/cli/client.js'
import type { DoctorReport } from '../dist/env/doctor.js'
import { startTestDaemon, tempHome } from './helpers.js'
import { windowMisfit } from '../dist/sessions/settings.js'

afterEach(() => setLanguage('ru'))

describe('RU/EN language', () => {
  it('detects regional Russian and falls back to English for unsupported systems', () => {
    for (const locale of ['ru', 'ru-RU', 'ru_RU.UTF-8']) assert.equal(detectLanguage(locale), 'ru')
    for (const locale of ['en-GB', 'de-DE', 'C', undefined]) assert.equal(detectLanguage(locale), 'en')
    assert.equal(resolveLanguage('ru', 'en-US'), 'ru')
    assert.equal(resolveLanguage('en', 'ru-RU'), 'en')
    assert.equal(resolveLanguage('auto', 'ru-RU'), 'ru')
  })
  it('interpolates opaque values without translating or reinterpreting them', () => {
    const t = translator({ 'Привет, {0}!': 'Hello, {0}!', 'готово': 'done' })
    const user = 'готово ${secret} {1} ~/.русская-папка'
    assert.equal(t`Привет, ${user}!`, `Привет, ${user}!`)
    setLanguage('en')
    assert.equal(t`Привет, ${user}!`, `Hello, ${user}!`)
    assert.equal(t('готово'), 'done')
    assert.equal(t('unknown literal'), 'unknown literal')
  })
  it('localizes shared application validation and display helpers', () => {
    setLanguage('en')
    assert.equal(guardLine({ mode: 'allow', countries: ['DE'] }), 'allow only: DE')
    assert.equal(windowMisfit(300_000, 200_000), 'context too large: 300k > 200k')
    setLanguage('ru')
    assert.equal(guardLine({ mode: 'allow', countries: ['DE'] }), 'разрешать только: DE')
  })
  it('validates and persists only language, preserving unknown user configuration', () => {
    assert.equal(defaultConfig().language, 'auto')
    assert.equal(validateConfig({ language: 'en' }).config.language, 'en')
    assert.equal(validateConfig({ language: 'de' }).config.language, 'auto')
    assert.equal(validateConfig({ language: 'de' }).warnings.length, 1)
    const root = mkdtempSync(join(tmpdir(), 'pult-lang-'))
    const file = join(root, 'config.json')
    try {
      writeFileSync(file, JSON.stringify({ custom: 42, network: { claude: { proxy: 'keep' } } }))
      writeLanguage(file, 'en')
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { custom: 42, network: { claude: { proxy: 'keep' } }, language: 'en' })
      writeFileSync(file, '{broken')
      assert.throws(() => writeLanguage(file, 'ru'))
      assert.equal(readFileSync(file, 'utf8'), '{broken')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})


it('overlapping request locales stay isolated across awaits', async () => {
  const t = translator({ 'готово': 'done' })
  await Promise.all([
    withLanguage('en', async () => { await new Promise((r) => setTimeout(r, 5)); assert.equal(t('готово'), 'done') }),
    withLanguage('ru', async () => { await new Promise((r) => setTimeout(r, 10)); assert.equal(t('готово'), 'готово') }),
  ])
  assert.equal(t('готово'), 'готово')
})

it('daemon switches doctor language live and isolates concurrent RU/EN reports', async () => {
  const home = tempHome()
  const override = process.env['PULT_LANG']
  delete process.env['PULT_LANG']
  home.config.language = 'ru'
  const daemon = await startTestDaemon(home)
  const client = await connectClient(home.paths, { locale: () => home.config.language === 'en' ? 'en' : 'ru' })
  const englishClient = await connectClient(home.paths, { locale: () => 'en' })
  const russianClient = await connectClient(home.paths, { locale: () => 'ru' })
  const nodeTitle = (report: DoctorReport): string | undefined => report.items.find((item) => item.id === 'daemon.node')?.title
  try {
    assert.equal(nodeTitle(await client.request('doctor.run', { net: false }) as DoctorReport), 'Node демона')
    await client.request('settings.set', { language: 'en' })
    assert.equal(nodeTitle(await client.request('doctor.run', { net: false }) as DoctorReport), 'Daemon Node')
    const [en, ru] = await Promise.all([
      client.request('doctor.run', { net: false, locale: 'en' }),
      client.request('doctor.run', { net: false, locale: 'ru' }),
    ]) as [DoctorReport, DoctorReport]
    assert.equal(nodeTitle(en), 'Daemon Node')
    assert.equal(nodeTitle(ru), 'Node демона')
    const [clientEn, clientRu] = await Promise.all([englishClient.request('doctor.run', { net: false }), russianClient.request('doctor.run', { net: false })]) as [DoctorReport, DoctorReport]
    assert.equal(nodeTitle(clientEn), 'Daemon Node')
    assert.equal(nodeTitle(clientRu), 'Node демона')
    await client.request('settings.set', { language: 'ru' })
    assert.equal(nodeTitle(await client.request('doctor.run', { net: false }) as DoctorReport), 'Node демона')
  } finally {
    client.close()
    englishClient.close()
    russianClient.close()
    await daemon.stop('language test complete')
    home.remove()
    if (override === undefined) delete process.env['PULT_LANG']; else process.env['PULT_LANG'] = override
  }
})
