// «/» в поле ввода (docs/19): разбор списков команд Claude и Codex, кэш каталога, снятие списка у `claude`
// управляющим `initialize` и метод демона `agent.commands`.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_HIDDEN, claudeCommandsFromInitialize, cleanDescription, codexCommandsFromSkills, commandNamesFromFiles,
  createCommandCatalog, reconcileClaudeInit,
} from '../dist/commands/catalog.js'
import type { SlashCommand } from '../dist/commands/catalog.js'
import { claudeProbeArgv, initializeLine, initializeResponseOf, probeClaudeCommands } from '../dist/commands/claudeProbe.js'
import { connectClient } from '../dist/cli/client.js'
import { isSlashCommandTurn, userTurnLine } from '../dist/adapters/claude/argv.js'
import { createClaudeMapper } from '../dist/adapters/claude/mapper.js'
import { startTestDaemon, tempHome, workIn } from './helpers.js'

const FIXTURE = fileURLToPath(new URL('../test/fixtures/claude/initialize-commands.jsonl', import.meta.url))
const recorded = (): unknown => (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { response: { response: unknown } }).response.response
const names = (l: readonly SlashCommand[]): string[] => l.map((c) => c.name)

describe('каталог «/»: Claude initialize', () => {
  it('записанный ответ CLI 2.1.318: скрыто неработающее без терминала, источники, вставка /name', () => {
    const list = claudeCommandsFromInitialize(recorded(), { commandFiles: new Set(['pult-cmd']) })
    const n = names(list)
    for (const hidden of ['clear', 'focus', 'color', 'doctor', 'model', 'effort', 'rename', 'heapdump', '__remote-workflow']) {
      assert.ok(!n.includes(hidden), `${hidden} скрыта`)
    }
    // «(removed)» и «Renamed to» — убранные CLI команды.
    assert.ok(!n.includes('agents') && !n.includes('extra-usage'))
    for (const shown of ['hello-pult', 'pult-cmd', 'compact', 'context', 'usage', 'engineering:debug', 'pdf']) assert.ok(n.includes(shown), shown)
    const by = new Map(list.map((c) => [c.name, c]))
    assert.equal(by.get('hello-pult')?.source, 'skill')
    assert.equal(by.get('hello-pult')?.description, 'Test skill for the Pult slash picker (Claude). Echo check.', 'хвост (project) снят')
    assert.equal(by.get('pult-cmd')?.source, 'command', 'файл .claude/commands/pult-cmd.md')
    assert.equal(by.get('compact')?.source, 'builtin')
    assert.equal(by.get('engineering:debug')?.source, 'plugin')
    assert.match(by.get('engineering:debug')?.description ?? '', /^Structured debugging/, 'голова (engineering) снята')
    assert.equal(by.get('engineering:debug')?.argumentHint, '<error message or problem description>')
    assert.equal(by.get('compact')?.insert, '/compact ')
    assert.ok(list.every((c) => c.provider === 'claude' && c.insert === `/${c.name} `))
  })
  it('мусор на входе — пустой список, повторы — первый', () => {
    assert.deepEqual(claudeCommandsFromInitialize(null), [])
    assert.deepEqual(claudeCommandsFromInitialize({ commands: 'x' }), [])
    const l = claudeCommandsFromInitialize({ commands: [{ name: 'a', description: 'one' }, { name: 'a', description: 'two' }, { name: 'bad name' }, { name: '' }, 7] })
    assert.deepEqual(l.map((c) => [c.name, c.description]), [['a', 'one']])
  })
  it('terminal_slash_commands из init прячутся тоже', () => {
    const l = claudeCommandsFromInitialize({ commands: [{ name: 'x-term', description: '' }, { name: 'ok', description: '' }] }, { terminalOnly: new Set(['x-term']) })
    assert.deepEqual(names(l), ['ok'])
  })
  it('clear/reset/new — скрыты: меняют session_id, Пульт возобновлял бы старый разговор', () => {
    for (const n of ['clear', 'reset', 'new']) assert.ok(CLAUDE_HIDDEN.has(n))
  })
  it('описания: хвосты CLI и пробелы', () => {
    assert.equal(cleanDescription('Do X\n  well (claude.ai sync)'), 'Do X well')
    assert.equal(cleanDescription('(typesafe) Build things (dynamic workflow)'), 'Build things')
  })
  it('файлы команд → имена CLI', () => {
    assert.deepEqual([...commandNamesFromFiles(['a.md', 'sub/b.md', 'notes.txt'])], ['a', 'sub:b'])
  })
})

describe('каталог «/»: сверка с system/init', () => {
  const base: SlashCommand[] = [
    { name: 'keep', description: 'd', source: 'skill', provider: 'claude', insert: '/keep ' },
    { name: 'gone', description: 'd', source: 'skill', provider: 'claude', insert: '/gone ' },
    { name: 'pdf', description: 'p', source: 'skill', provider: 'claude', insert: '/pdf ' },
  ]
  it('пропавшее уходит, новое приходит без описания, anthropic-skills:x — то же, что x, скрытое не всплывает', () => {
    const next = reconcileClaudeInit(base, {
      slashCommands: ['keep', 'anthropic-skills:pdf', 'fresh', 'tool:cmd', 'clear', 'color'], skills: ['fresh'], terminalOnly: ['color'],
    })
    assert.deepEqual(next.map((c) => [c.name, c.source, c.description]), [
      ['keep', 'skill', 'd'], ['pdf', 'skill', 'p'], ['fresh', 'skill', ''], ['tool:cmd', 'plugin', ''],
    ])
  })
  it('маппер Claude несёт имена команд из init корня в сигнале turn_started', () => {
    const m = createClaudeMapper({ sessionId: 's' })
    const out = m.push({ type: 'system', subtype: 'init', session_id: 'x', slash_commands: ['a', 'b'], skills: ['a'], terminal_slash_commands: ['b'] })
    const sig = out.signals.find((s) => s.kind === 'turn_started') as { commands?: unknown } | undefined
    assert.deepEqual(sig?.commands, { slashCommands: ['a', 'b'], skills: ['a'], terminalOnly: ['b'] })
  })
})

describe('каталог «/»: Codex skills/list', () => {
  it('скиллы → $name, выключенные скрыты, короткое описание предпочтительнее, плагин — plugin', () => {
    const l = codexCommandsFromSkills({ data: [{ cwd: '/w', errors: [], skills: [
      { name: 'codex-hello', description: 'Long text', path: '/w/.agents/skills/codex-hello/SKILL.md', scope: 'repo', enabled: true, pluginId: null },
      { name: 'engineering:debug', description: 'Debug', interface: { shortDescription: 'Short' }, path: '/p', scope: 'user', enabled: true, pluginId: 'engineering@x' },
      { name: 'off', description: 'x', path: '/o', scope: 'user', enabled: false, pluginId: null },
    ] }] }, '/w')
    assert.deepEqual(l.map((c) => [c.name, c.insert, c.source, c.description]), [
      ['codex-hello', '$codex-hello ', 'skill', 'Long text'],
      ['engineering:debug', '$engineering:debug ', 'plugin', 'Short'],
    ])
    assert.deepEqual(codexCommandsFromSkills({}), [])
  })
})

describe('каталог «/»: кэш', () => {
  const one = (name: string): SlashCommand[] => [{ name, description: '', source: 'skill', provider: 'claude', insert: `/${name} ` }]
  it('свежий — из памяти, force и истёкший — заново, ошибка — прежний список и текст, одновременные — один спавн', async () => {
    let clock = 1000
    let calls = 0
    let fail = false
    const cat = createCommandCatalog({
      now: () => clock, ttlMs: 100,
      probe: async (k, force) => { calls++; if (fail) throw new Error('страж'); await new Promise((r) => setTimeout(r, 5)); return one(`${k.cwd}-${calls}${force ? '-f' : ''}`) },
    })
    const key = { provider: 'claude' as const, cwd: '/a' }
    const [a, b] = await Promise.all([cat.list(key), cat.list(key)])
    assert.equal(calls, 1, 'два запроса — один снимок')
    assert.deepEqual(names(a.commands), ['/a-1'])
    assert.equal(b.commands, a.commands)
    assert.deepEqual(names((await cat.list(key)).commands), ['/a-1'], 'из памяти')
    assert.deepEqual(names((await cat.list(key, { force: true })).commands), ['/a-2-f'])
    clock += 200
    fail = true
    const failed = await cat.list(key)
    assert.equal(failed.error, 'страж')
    assert.deepEqual(names(failed.commands), ['/a-2-f'], 'прежний список остаётся')
    fail = false
    assert.deepEqual(names((await cat.list({ provider: 'claude', cwd: '/b' })).commands), ['/b-4'], 'другая папка — свой список')
    cat.invalidate('claude')
    assert.deepEqual(names((await cat.list(key)).commands), ['/a-5'])
  })
  it('init сверяет кэш и запоминает терминальные команды для следующего снимка', async () => {
    const cat = createCommandCatalog({ probe: async () => [...one('a'), ...one('t')] })
    const key = { provider: 'claude' as const, cwd: '/a' }
    await cat.list(key)
    cat.seenClaudeInit(key, { slashCommands: ['a', 'b', 't'], skills: ['b'], terminalOnly: ['t'] })
    assert.deepEqual(names((await cat.list(key)).commands), ['a', 'b'])
    assert.deepEqual(names((await cat.list(key, { force: true })).commands), ['a'], 'терминальная скрыта и в новом снимке')
  })
})

describe('каталог «/»: снятие у claude', () => {
  it('argv и управляющая строка', () => {
    assert.deepEqual(claudeProbeArgv('user,project').slice(-2), ['--setting-sources', 'user,project'])
    assert.ok(claudeProbeArgv().includes('--strict-mcp-config'))
    assert.ok(!claudeProbeArgv().includes('--mcp-config'), 'серверы владельца не поднимаются')
    assert.deepEqual(JSON.parse(initializeLine()), { type: 'control_request', request_id: 'pult-commands', request: { subtype: 'initialize' } })
    assert.equal(initializeResponseOf('{"type":"system"}'), null)
    assert.equal(initializeResponseOf('{"type":"control_response","response":{"request_id":"other","response":{}}}'), null)
    assert.throws(() => initializeResponseOf('{"type":"control_response","response":{"request_id":"pult-commands","subtype":"error","error":"nope"}}'), /nope/)
  })
  it('фальшивый claude: ответ на initialize с файлами команд папки', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-cmd-'))
    const home = join(dir, 'home')
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(dir, '.claude', 'commands', 'pult-cmd.md'), '# x')
    const list = await probeClaudeCommands({ bin: fileURLToPath(new URL('../test/fakes/fake-claude.mjs', import.meta.url)), cwd: dir, env: process.env, home })
    assert.equal(list.find((c) => c.name === 'pult-cmd')?.source, 'command')
    assert.ok(list.some((c) => c.name === 'hello-pult'))
  })
  it('CLI, который молчит или падает, — ошибка словами, а не вечное ожидание', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-cmd-'))
    const mute = join(dir, 'mute.mjs')
    writeFileSync(mute, '#!/usr/bin/env node\nsetTimeout(() => {}, 10000)\n')
    chmodSync(mute, 0o755)
    await assert.rejects(probeClaudeCommands({ bin: mute, cwd: dir, env: process.env, timeoutMs: 300, home: dir }), /вовремя/)
    const dead = join(dir, 'dead.mjs')
    writeFileSync(dead, '#!/usr/bin/env node\nprocess.stderr.write("Not logged in\\n"); process.exit(1)\n')
    chmodSync(dead, 0o755)
    await assert.rejects(probeClaudeCommands({ bin: dead, cwd: dir, env: process.env, home: dir }), /Not logged in/)
  })
})

describe('ход Claude с «/командой»', () => {
  it('один текстовый блок: контекст режима не добавляется, иначе CLI не развернёт команду', () => {
    assert.equal(isSlashCommandTurn('/compact'), true)
    assert.equal(isSlashCommandTurn('/hello-pult abc'), true)
    assert.equal(isSlashCommandTurn('/engineering:debug x\ny'), true)
    assert.equal(isSlashCommandTurn('/opt/demo/file.txt посмотри'), false)
    assert.equal(isSlashCommandTurn('please /compact'), false)
    assert.equal(isSlashCommandTurn('/compact', 1), false, 'с вложениями — как раньше')
    const line = JSON.parse(userTurnLine('/context', 'u', undefined)) as { message: { content: unknown[] } }
    assert.equal(line.message.content.length, 1)
  })
  it('фальшивый claude в демоне получает /команду одним блоком', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const cwd = workIn(home)
      const stdinOut = join(cwd, 'stdin.jsonl')
      writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, stdinOut }))
      await c.request('agent.start', { name: 'sc', kind: 'claude', cwd })
      await c.request('agent.prompt', { name: 'sc', text: '/context' })
      await c.request('agent.wait', { name: 'sc', timeoutMs: 15000 })
      await c.request('agent.prompt', { name: 'sc', text: 'plain' })
      await c.request('agent.wait', { name: 'sc', timeoutMs: 15000 })
      const sent = readFileSync(stdinOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { message?: { content?: Array<{ text?: string }> } })
        .filter((m) => m.message)
      assert.equal(sent[0]?.message?.content?.length, 1, '/context — один блок')
      assert.equal(sent[0]?.message?.content?.[0]?.text, '/context')
      assert.ok((sent[1]?.message?.content?.length ?? 0) >= 2, 'обычная реплика — с контекстом режима')
    } finally {
      c.close()
      await d.stop('конец теста')
      home.remove()
    }
  })
})

describe('демон: agent.commands', () => {
  it('по чату Claude и Codex, по черновику (provider+cwd), отказы на плохие параметры', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const cwd = workIn(home)
      await c.request('agent.start', { name: 'cl', kind: 'claude', cwd })
      const cl = (await c.request('agent.commands', { name: 'cl' })) as { provider: string; commands: SlashCommand[]; error?: string }
      assert.equal(cl.provider, 'claude')
      assert.equal(cl.error, undefined)
      assert.ok(cl.commands.some((x) => x.name === 'hello-pult' && x.insert === '/hello-pult '))
      assert.ok(!cl.commands.some((x) => x.name === 'clear'))

      await c.request('agent.start', { name: 'cx', kind: 'codex', cwd })
      const cx = (await c.request('agent.commands', { name: 'cx' })) as { provider: string; commands: SlashCommand[] }
      assert.deepEqual(cx.commands.map((x) => x.insert), ['$codex-hello ', '$imagegen '])
      assert.equal(cx.commands[1]?.description, 'Generate images')

      const before = await c.request('agent.list', {})
      const general = (await c.request('agent.commands', { provider: 'claude', scope: 'general' })) as { commands: SlashCommand[] }
      assert.ok(general.commands.some((x) => x.name === 'hello-pult'))
      assert.deepEqual(await c.request('agent.list', {}), before, 'discovery does not create a session')
      const draft = (await c.request('agent.commands', { provider: 'codex', cwd })) as { commands: SlashCommand[] }
      assert.equal(draft.commands.length, 2)
      const z = (await c.request('agent.commands', { provider: 'zcode', cwd })) as { commands: SlashCommand[] }
      assert.deepEqual(z.commands, [])

      const code = (want: string) => (e: { code?: string }): boolean => e.code === want
      await assert.rejects(c.request('agent.commands', { name: 'nope' }), code('not_found'))
      await assert.rejects(c.request('agent.commands', { provider: 'claude', cwd: 'rel' }), code('invalid_params'))
      await assert.rejects(c.request('agent.commands', { provider: 'claude', cwd: join(cwd, 'missing') }), code('invalid_params'))
      await assert.rejects(c.request('agent.commands', { provider: 'gpt', cwd }), code('invalid_params'))
      await assert.rejects(c.request('agent.commands', { provider: 'claude', scope: 'general', cwd }), code('invalid_params'))
      await assert.rejects(c.request('agent.commands', { provider: 'claude', scope: 'bad', cwd }), code('invalid_params'))
    } finally {
      c.close()
      await d.stop('конец теста')
      home.remove()
    }
  })
})
