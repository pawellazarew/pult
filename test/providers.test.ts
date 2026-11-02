import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createProviderCatalog, parseCodexModels, zcodeLoginState, zcodeModelChoices } from '../dist/env/providers.js'

it('model catalog preserves per-model efforts and filters hidden or malformed models', () => {
  assert.deepEqual(parseCodexModels([
    { model: 'fast', displayName: 'Fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
    { model: 'hidden', hidden: true }, { model: 3 }, null,
  ]), [{ id: 'fast', label: 'Fast', efforts: ['low'], defaultEffort: 'low', isDefault: true }])
})

it('readiness distinguishes missing CLI, logged-out account and available app-server without returning auth output', async () => {
  const opts = { bins: { claude: 'claude', codex: 'codex', zcode: 'zcode' }, cwd: '/tmp', env: {}, models: async () => [] }
  const catalog = createProviderCatalog({ ...opts, run: async (bin) => bin === 'claude'
    ? { status: 1, stdout: '{"loggedIn":false,"email":"private@example.org"}', stderr: '' }
    : { status: 0, stdout: '', stderr: 'Logged in using ChatGPT' } })
  const checked = await catalog.check()
  assert.equal(checked.claude.state, 'login_required')
  assert.equal(checked.codex.state, 'ready')
  assert.equal(JSON.stringify(checked).includes('private@example.org'), false)
  const absent = await createProviderCatalog({ ...opts, run: async () => ({ status: null, stdout: '', stderr: '', error: 'spawn ENOENT' }) }).check()
  assert.equal(absent.codex.state, 'unavailable')
  assert.equal(absent.zcode.state, 'unavailable')
})

it('concurrent checks share one auth and model request and app-server failures are visible', async () => {
  let calls = 0
  const catalog = createProviderCatalog({ bins: { claude: 'claude', codex: 'codex', zcode: 'zcode' }, cwd: '/tmp', env: {},
    // Креды zcode — несуществующий файл: проверка входа детерминирована и не читает машину.
    zcodeCreds: () => '/nonexistent/zcode-credentials.json',
    run: async (bin) => { calls++; return { status: 0, stdout: bin === 'claude' ? '{"loggedIn":true}' : 'Logged in using ChatGPT', stderr: '' } },
    models: async () => { throw new Error('secret raw transport error') } })
  const first = catalog.check()
  assert.equal(first, catalog.check())
  assert.equal((await first).codex.state, 'error')
  // Третий вызов — `zcode --version` (вход zcode меряется файлом кред, не CLI).
  assert.equal(calls, 3)
})

it('zcode: вход по файлу кред, модели нет — один пункт «по умолчанию»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-prov-'))
  try {
    const creds = join(dir, 'credentials.json')
    const bins = { claude: 'claude', codex: 'codex', zcode: 'zcode' }
    const opts = { bins, cwd: '/tmp', env: {}, zcodeCreds: () => creds }
    const mk = (o: Record<string, unknown>) => createProviderCatalog({ ...opts, ...o })

    // Файла нет — вход нужен, но CLI жив (проверка --version прошла).
    const noCreds = await mk({ run: async () => ({ status: 0, stdout: 'zcode 0.17.1', stderr: '' }) }).check()
    assert.equal(noCreds.zcode.state, 'login_required')
    assert.equal(noCreds.zcode.fixCmd, 'zcode login')
    assert.deepEqual(noCreds.zcode.models, [])

    // Токен есть — готов, один модельный пункт, содержимое токена наружу не уходит.
    writeFileSync(creds, JSON.stringify({ 'oauth:zai:access_token': 'secret-token-value' }))
    const okCreds = await mk({ run: async () => ({ status: 0, stdout: 'zcode 0.17.1', stderr: '' }) }).check()
    assert.equal(okCreds.zcode.state, 'ready')
    assert.deepEqual(okCreds.zcode.models, zcodeModelChoices())
    assert.equal(okCreds.zcode.models[0]!.id, 'default')
    assert.equal(JSON.stringify(okCreds).includes('secret-token-value'), false)

    // Файл-мусор — честное «не удалось проверить», а не «нужен вход».
    writeFileSync(creds, '{не json')
    const junk = await mk({ run: async () => ({ status: 0, stdout: 'zcode 0.17.1', stderr: '' }) }).check()
    assert.equal(junk.zcode.state, 'error')
    assert.match(junk.zcode.detail, /не удалось проверить вход/i)

    // zcodeLoginState — прямая проверка трёх состояний.
    assert.equal(zcodeLoginState(join(dir, 'absent.json')), 'no')
    assert.equal(zcodeLoginState(creds), 'unknown')
    writeFileSync(creds, JSON.stringify({ other: 1 }))
    assert.equal(zcodeLoginState(creds), 'no')
    writeFileSync(creds, JSON.stringify({ zcodejwttoken: 'x' }))
    assert.equal(zcodeLoginState(creds), 'yes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
