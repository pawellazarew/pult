// Страж страны выхода. Ни один тест не ходит в сеть: проба инъецируется.
// Проверяется ровно то, чему научил 21.09 (DELTA v0.5 §1): решает СТРАНА, а не порт;
// откат с прокси на прямой путь тоже проходит через стража; «не знаю, где мы» = блок.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { DEFAULT_GUARD_COUNTRIES } from '../dist/core/config.js'
import { checkNetwork, clearNetCache, curlArgs, noProxyValue, parseLoc } from '../dist/env/net.js'
import { claudeNetworkEnv } from '../dist/adapters/claude/adapter.js'
import { codexNetworkEnv } from '../dist/adapters/codex/adapter.js'
import type { ProbeFn } from '../dist/env/net.js'

const trace = (loc: string): string => `fl=1f2\nh=api.anthropic.com\nloc=${loc}\ntls=TLSv1.3\n`

interface FakeProbe {
  fn: ProbeFn
  calls: Array<{ url: string; proxy: string | null }>
}

/** Проба, которая отвечает по маршруту: `proxy` — что вернуть через прокси, `direct` — напрямую. */
function fakeProbe(map: { proxy?: string | null; direct?: string | null }): FakeProbe {
  const calls: Array<{ url: string; proxy: string | null }> = []
  const fn: ProbeFn = async (url, proxy) => {
    calls.push({ url, proxy })
    const loc = proxy ? map.proxy : map.direct
    if (!loc) return { status: 7, stdout: '', stderr: 'curl: (7) Failed to connect' }
    return { status: 0, stdout: trace(loc), stderr: '' }
  }
  return { fn, calls }
}

beforeEach(() => clearNetCache())

describe('разбор ответа', () => {
  it('loc вытаскивается и приводится к верхнему регистру', () => {
    assert.equal(parseLoc(trace('fi')), 'FI')
    assert.equal(parseLoc('нет такой строки'), null)
  })
})

describe('страж', () => {
  it('разрешённая страна через прокси — ход можно делать', async () => {
    const probe = fakeProbe({ proxy: 'FI' })
    const c = await checkNetwork('claude', { mode: 'auto', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.ok, true)
    assert.equal(c.path, 'proxy')
    assert.equal(c.loc, 'FI')
    assert.equal(c.reason, 'ok')
    assert.equal(probe.calls[0]?.proxy, 'http://127.0.0.1:3128', 'проба обязана идти ЧЕРЕЗ прокси')
  })

  it('страна из списка-стража — ход запрещён', async () => {
    const probe = fakeProbe({ proxy: 'RU' })
    const c = await checkNetwork('claude', { mode: 'auto', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.ok, false)
    assert.equal(c.reason, 'blocked_country')
    assert.equal(c.path, 'none')
  })

  it('неизвестная страна считается блоком', async () => {
    const probe = fakeProbe({ proxy: null, direct: null })
    const c = await checkNetwork('claude', { mode: 'off', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.ok, false)
    assert.equal(c.reason, 'unknown_location')
    assert.equal(c.loc, null)
    assert.equal(probe.calls.length, 2, 'оба адреса-запаски должны быть опробованы')
  })

  it('required + мёртвый прокси = блок, прямого пути не пробуем', async () => {
    const probe = fakeProbe({ proxy: null, direct: 'FI' })
    const c = await checkNetwork('claude', { mode: 'required', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.ok, false)
    assert.equal(c.reason, 'proxy_dead')
    assert.ok(probe.calls.every((x) => x.proxy !== null), 'в режиме required прямой путь недопустим')
  })

  it('auto + мёртвый прокси откатывается на прямой путь, НО страж всё равно работает', async () => {
    const good = fakeProbe({ proxy: null, direct: 'DE' })
    const c1 = await checkNetwork('claude', { mode: 'auto', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: good.fn })
    assert.equal(c1.ok, true)
    assert.equal(c1.path, 'direct')
    assert.equal(c1.fellBack, true)
    assert.equal(c1.loc, 'DE')

    clearNetCache()
    const bad = fakeProbe({ proxy: null, direct: 'RU' })
    const c2 = await checkNetwork('claude', { mode: 'auto', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: bad.fn })
    assert.equal(c2.ok, false, 'откат на прямой путь не имеет права обходить стража')
    assert.equal(c2.reason, 'blocked_country')
    assert.equal(c2.fellBack, true)
  })

  it('режим off ходит только напрямую', async () => {
    const probe = fakeProbe({ proxy: 'FI', direct: 'FI' })
    const c = await checkNetwork('codex', { mode: 'off', proxy: 'http://127.0.0.1:3128' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.path, 'direct')
    assert.ok(probe.calls.every((x) => x.proxy === null))
  })

  it('профиль без адреса прокси: auto — прямой путь без curl -x, required — блок без проб (M8b)', async () => {
    clearNetCache()
    const probe = fakeProbe({ proxy: 'FI', direct: 'DE' })
    const a = await checkNetwork('claude', { mode: 'auto', proxy: '' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(a.path, 'direct')
    assert.equal(a.fellBack, false)
    assert.equal(a.loc, 'DE')
    assert.ok(probe.calls.every((x) => x.proxy === null))
    const before = probe.calls.length
    const r = await checkNetwork('codex', { mode: 'required', proxy: '' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'proxy_dead')
    assert.equal(probe.calls.length, before, 'required без прокси не пробует ни прокси, ни прямой путь')
  })

  it('второй запрос в пределах 60 с берётся из кэша', async () => {
    const probe = fakeProbe({ proxy: 'FI' })
    let now = 1_000_000
    const opts = { probe: probe.fn, now: () => now }
    const first = await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, opts)
    assert.equal(first.cached, false)
    const second = await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, opts)
    assert.equal(second.cached, true)
    assert.equal(probe.calls.length, 1)

    now += 61_000
    const third = await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, opts)
    assert.equal(third.cached, false)
    assert.equal(probe.calls.length, 2)
  })

  it('fresh обходит кэш', async () => {
    const probe = fakeProbe({ proxy: 'FI' })
    await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn, fresh: true })
    assert.equal(probe.calls.length, 2)
  })

  it('оборванная проба не даёт страну, даже если loc успел приехать', async () => {
    // curl -m отдаёт код 28 и ПОЛОВИНУ тела. Раньше `loc=` из этой половины засчитывался,
    // и страж разрешал ход по маршруту, который на самом деле не работает.
    const probe: ProbeFn = async () => ({ status: 28, stdout: 'fl=1f2\nloc=FI\n', stderr: 'curl: (28) timeout' })
    const c = await checkNetwork('claude', { mode: 'off', proxy: 'p' }, DEFAULT_GUARD_COUNTRIES, { probe })
    assert.equal(c.ok, false)
    assert.equal(c.reason, 'unknown_location')
    assert.equal(c.loc, null)
    assert.equal(c.attempts[0]?.exit, 28)
    assert.equal(c.attempts[0]?.loc, null)
  })

  it('curl зовётся с -q и явным прокси', () => {
    // -q ПЕРВЫМ: иначе curl читает ~/.curlrc, и строка `proxy = …` в нём уводит пробу
    // прямого пути через чужой прокси — страж тогда одобряет не ту страну.
    const direct = curlArgs('https://example/trace', null, 8000)
    assert.equal(direct[0], '-q')
    assert.deepEqual(direct, ['-q', '-s', '-m', '8', '-x', '', 'https://example/trace'])
    const viaProxy = curlArgs('https://example/trace', 'http://127.0.0.1:3128', 8000)
    assert.deepEqual(viaProxy.slice(-3), ['-x', 'http://127.0.0.1:3128', 'https://example/trace'])
  })

  it('свой список-страж перекрывает умолчание', async () => {
    const probe = fakeProbe({ proxy: 'FI' })
    const c = await checkNetwork('claude', { mode: 'auto', proxy: 'p' }, ['fi'], { probe: probe.fn })
    assert.equal(c.ok, false)
    assert.equal(c.reason, 'blocked_country')
  })
})

// noProxy (21.10.2026): агент за прокси ходит в корпоративные сервисы мимо него — их пускают
// только с выхода корпоративного VPN. Без поля ребёнок получает прежний NO_PROXY.
describe('noProxy профиля', () => {
  const profile = { mode: 'auto' as const, proxy: 'http://127.0.0.1:28781', noProxy: ['.corp.example', '.git.corp.example'] }

  it('без добавки — только localhost, как раньше', () => {
    assert.equal(noProxyValue(), 'localhost,127.0.0.1,::1')
    assert.equal(noProxyValue(['localhost', '.corp.example']), 'localhost,127.0.0.1,::1,.corp.example')
  })

  it('доходит до NO_PROXY ребёнка claude и codex', async () => {
    const c = await checkNetwork('claude', profile, DEFAULT_GUARD_COUNTRIES, { probe: fakeProbe({ proxy: 'FI' }).fn })
    assert.deepEqual(c.noProxy, ['.corp.example', '.git.corp.example'])
    assert.equal(claudeNetworkEnv(c).NO_PROXY, 'localhost,127.0.0.1,::1,.corp.example,.git.corp.example')
    assert.equal(codexNetworkEnv({ ...c, provider: 'codex' }).NO_PROXY, 'localhost,127.0.0.1,::1,.corp.example,.git.corp.example')
  })

  it('прямой путь не ставит переменных, даже с noProxy', async () => {
    const c = await checkNetwork('claude', profile, DEFAULT_GUARD_COUNTRIES, { probe: fakeProbe({ proxy: null, direct: 'DE' }).fn })
    assert.equal(c.path, 'direct')
    assert.deepEqual(claudeNetworkEnv(c), {})
  })

  it('правка noProxy не ждёт кэша', async () => {
    const probe = fakeProbe({ proxy: 'FI' })
    await checkNetwork('claude', { ...profile, noProxy: [] }, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    const c = await checkNetwork('claude', profile, DEFAULT_GUARD_COUNTRIES, { probe: probe.fn })
    assert.equal(c.cached, false)
    assert.deepEqual(c.noProxy, ['.corp.example', '.git.corp.example'])
  })
})
