// Run after tsc with Node 24. Only temporary homes and no provider processes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout, ensureLayout } from '../dist/core/paths.js';
import { createStore } from '../dist/core/store.js';
import { createRegistry } from '../dist/sessions/registry.js';
import { createManager } from '../dist/sessions/manager.js';
import { defaultConfig } from '../dist/core/config.js';
import { createBroker } from '../dist/perm/broker.js';

const home = mkdtempSync(join(tmpdir(), 'pult-usage-oracle-'));
const paths = layout(home);
ensureLayout(paths);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const registry = createRegistry(paths);
const store = createStore(paths);
const adapter = { close: async () => {}, blocked: () => ({ blocked: false }), reset() {}, shutdown: async () => {} };
const make = () => createManager({ paths, config: defaultConfig(), logger, store, registry,
  publish: draft => store.append(draft), adapters: { claude: adapter, codex: adapter, zcode: adapter },
  broker: createBroker({ emit() {} }) });
let manager = make();
const actions = [];
const snapshot = action => actions.push({ ...action, expected: JSON.parse(JSON.stringify({ usage: manager.usage() })) });
const create = (name, provider, archived = false) => {
  registry.create({ name, provider, cwd: home, mode: 'turn', createdAt: '2026-11-16T00:00:00Z', lastStatus: 'cold', lastEventId: 0, ...(archived ? { archived: true } : {}) });
  snapshot({ op: 'create', name, provider, archived });
};
const emit = (name, data, parentId) => {
  manager.emit({ sessionId: name, provider: 'pult', kind: 'usage.updated', data, ...(parentId ? { parentId } : {}) });
  snapshot({ op: 'emit', name, data, ...(parentId ? { parentId } : {}) });
};
try {
  snapshot({ op: 'read' });
  create('z-last', 'zcode', true); create('a-first', 'codex'); create('claude', 'claude');
  emit('a-first', { source: 'result', totalCostUsd: 1.25, numTurns: 99, usage: { input_tokens: 1.5, output_tokens: 4, cache_read_input_tokens: null, cache_creation_input_tokens: 100 } }, 'child');
  emit('a-first', { source: 'result', totalCostUsd: 0, usage: { input_tokens: -0.5, output_tokens: null, cache_read_input_tokens: 2 } });
  emit('a-first', { source: 'result', totalCostUsd: null, usage: null });
  emit('a-first', { source: 'rate_limit_event', status: 'allowed', windows: { five_hour: { utilization: 0.125, future: ['\ud800', '🚀'] }, seven_day: null, opaque: { a: true } }, resetsAt: null, ignored: 'not retained' });
  emit('a-first', { source: 'result', totalCostUsd: -1.00005, usage: {} });
  emit('a-first', { source: 'rate_limit_event' });
  emit('ghost', { source: 'result', totalCostUsd: 3, usage: { input_tokens: 9007199254740993 } });
  create('ghost', 'zcode');
  emit('claude', { source: 'unknown' });
  store.append({ sessionId: 'claude', provider: 'claude', kind: 'usage.updated', data: { source: 'result', totalCostUsd: 999 } });
  snapshot({ op: 'direct', name: 'claude' });
  manager.archive('a-first', true); snapshot({ op: 'archive', name: 'a-first' });
  await manager.rm('ghost'); snapshot({ op: 'remove', name: 'ghost' });
  create('ghost', 'codex');
  emit('z-last', { source: 'result', usage: { input_tokens: 1e308 } });
  emit('z-last', { source: 'result', usage: { input_tokens: 1e308 } });
  emit('z-last', { source: 'result', usage: { input_tokens: -1e308 } });
  manager = make(); snapshot({ op: 'restart' });
  assert.ok(store.lastId > 0);
  process.stdout.write(JSON.stringify({ source: 'actual createManager', actions }, null, 2) + '\n');
} finally {
  store.close(); rmSync(home, { recursive: true, force: true });
}
