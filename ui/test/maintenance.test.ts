import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MaintenancePanel, ProviderAuthState } from '../src/components/Maintenance.js'
import type { ProviderTool, PultBridge } from '../../shell/src/contract.js'
import type { DoctorReport } from '../src/model/types.js'

const tool: ProviderTool = { provider: 'codex', path: '/bin/codex', realpath: '/apps/codex-v2', version: 'codex-cli 2.0', source: 'native' }
const report: DoctorReport = { ok: true, generatedAt: '2026-11-19T10:00:00Z', home: '/fixture', counts: { ok: 2, warn: 0, fail: 0 }, items: [
  { id: 'cli.codex', title: 'CLI Codex', status: 'ok', detail: 'Found', data: { path: tool.path, realpath: tool.realpath, version: tool.version } },
  { id: 'login.codex', title: 'Codex login', status: 'ok', detail: 'fixture-account' },
] }
const auth = (over: Partial<ProviderTool> = {}, checked: DoctorReport | null = report): string => renderToStaticMarkup(createElement(ProviderAuthState, { tool: { ...tool, ...over }, report: checked }))

describe('CLI auth report belongs to the observed installation', () => {
  it('shows matching authentication, including a different launcher for the same canonical file', () => {
    assert.match(auth(), /Вход подтверждён · fixture-account/)
    assert.match(auth({ path: '/other/codex' }), /Вход подтверждён · fixture-account/)
  })

  it('does not present an old login result after an update at the same path or an unstable probe', () => {
    for (const over of [{ version: 'codex-cli 3.0' }, { version: null }, { changedDuringCheck: true }, { path: null }, { realpath: '/apps/codex-v3' }]) {
      assert.match(auth(over), /Вход ещё не проверен/)
      assert.doesNotMatch(auth(over), /fixture-account|Вход подтверждён/)
    }
    assert.match(auth({ path: '/other/codex', realpath: '/apps/foreign-codex' }), /Вход ещё не проверен/)
    assert.match(auth({}, null), /Вход ещё не проверен/)
  })
})

describe('CLI reconnect control stays in Pult', () => {
  const noop = (): void => {}
  const render = (over: Partial<Parameters<typeof MaintenancePanel>[0]> = {}): string => renderToStaticMarkup(createElement(MaintenancePanel, {
    bridge: {} as PultBridge, conn: { state: 'up', daemon: { version: 'fixture', pid: 12, startedAt: '2026-11-19T10:00:00Z' } }, status: null,
    doctor: { report: null, loading: false, error: null }, starting: false, onStart: noop, onDoctor: noop, onRunDoctor: async () => {},
    onCopy: noop, onUpdates: noop, onClose: noop, onReconnectProviders: noop, ...over,
  }))

  it('offers reconnect as a separate action with the pending count and confirmation explanation', () => {
    const out = render({ providerUpdateCount: 2 })
    assert.match(out, /data-testid="maintenance-reconnect-providers"/)
    assert.match(out, /Переподключить CLI<span class="count">2<\/span>/)
    assert.doesNotMatch(out, /disabled="" data-testid="maintenance-reconnect-providers"/)
    assert.match(out, /активные ходы, они прервутся только после твоего подтверждения/)
  })

  it('disables reconnect offline, without a handler, or while busy and shows its error inside the panel', () => {
    const variants: Partial<Parameters<typeof MaintenancePanel>[0]>[] = [
      { conn: { state: 'down', reason: 'fixture', attempt: 0, retryInMs: null } }, { onReconnectProviders: undefined }, { reconnectingProviders: true },
    ]
    for (const props of variants) assert.match(render(props), /disabled="" data-testid="maintenance-reconnect-providers"/)
    assert.match(render({ reconnectingProviders: true }), /Переподключаю CLI…/)
    assert.match(render({ providerConnectionError: '<lost reply>' }), /role="alert" data-testid="maintenance-provider-connection-error">&lt;lost reply&gt;/)
  })
})
