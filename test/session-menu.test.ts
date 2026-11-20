// Архив и локальное автоназвание через настоящий демон с тестовым провайдером.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { localSessionTitle } from '../dist/sessions/autotitle.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'

describe('автоназвание: модуль', () => {
  it('название из первых слов: первая содержательная строка, до 6 слов, без хвостовой пунктуации', () => {
    assert.equal(localSessionTitle('# Почини падающий тест в шапке лимитов, пожалуйста срочно\nподробности'), 'Почини падающий тест в шапке лимитов')
    assert.equal(localSessionTitle('\n\n  > Сделай ревью.  \n'), 'Сделай ревью')
    assert.equal(localSessionTitle('   '), null)
    assert.equal(localSessionTitle('\u200B'), null)
  })
})

describe('реестр: архив и флаг автоназвания', () => {
  it('поля читаются только как true; мусор — нет поля', () => {
    const [a, b] = parseSessions({ sessions: [
      { name: 'a', provider: 'claude', cwd: '/srv/a', archived: true, autoTitled: true },
      { name: 'b', provider: 'claude', cwd: '/srv/b', archived: 'yes', autoTitled: 1 },
    ] })
    assert.equal(a?.archived, true)
    assert.equal(a?.autoTitled, true)
    assert.equal(b?.archived, undefined)
    assert.equal(b?.autoTitled, undefined)
  })
})

describe('демон: архив и автоназвание', () => {
  it('первая реплика даёт название один раз; ручное не перетирается; архив — пометка, реплика возвращает', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-menu-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    writeFileSync(join(home.paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const rec = async (name: string): Promise<Record<string, unknown>> =>
      ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === name)!
    try {
      await c.request('agent.start', { name: 'w', kind: 'codex', cwd })
      await c.request('agent.prompt', { name: 'w', text: 'Почини падающий тест' })
      assert.ok(await waitFor(async () => (await rec('w'))['title'] === 'Почини падающий тест', 10_000), 'название не появилось')
      assert.equal((await rec('w'))['autoTitled'], true)
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      await c.request('agent.rename', { name: 'w', title: '' })
      await c.request('agent.prompt', { name: 'w', text: 'Ещё реплика' })
      await c.request('agent.wait', { name: 'w', until: ['idle'], timeoutMs: 20_000 })
      assert.equal((await rec('w'))['title'], undefined, 'стёртое руками название не возвращается')

      // Ручное название до первой реплики — автоназвание его не трогает.
      await c.request('agent.start', { name: 'm', kind: 'claude', cwd, title: 'Моё' })
      await c.request('agent.prompt', { name: 'm', text: 'Сделай что-нибудь' })
      await c.request('agent.wait', { name: 'm', until: ['idle'], timeoutMs: 20_000 })
      assert.equal((await rec('m'))['title'], 'Моё')

      // Архив: пометка туда и обратно; реплика в архивную сессию возвращает её.
      assert.equal(((await c.request('agent.archive', { name: 'm', archived: true })) as Record<string, unknown>)['archived'], true)
      assert.equal((await rec('m'))['archived'], true)
      await assert.rejects(c.request('agent.archive', { name: 'm' }), (e: { code?: string }) => e.code === 'invalid_params')
      await c.request('agent.prompt', { name: 'm', text: 'Вернись' })
      assert.equal((await rec('m'))['archived'], undefined, 'реплика возвращает из архива')
      await c.request('agent.wait', { name: 'm', until: ['idle'], timeoutMs: 20_000 })
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})
