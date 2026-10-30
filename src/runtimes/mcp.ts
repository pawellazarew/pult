import { createInterface } from 'node:readline'
import { connectClient } from '../cli/client.js'
import type { PultPaths } from '../core/paths.js'
import type { RuntimeResult } from './types.js'

const field = { type: 'string' }
export const RUNTIME_TOOLS = [
  { name: 'discover', description: 'Find the shared Pult browser, installed iOS simulators and Android emulators, capabilities, setup requirements and current controller. Nothing is installed. Use these tools when a task needs UI verification.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'perform', description: 'Operate the SAME screen shown to the user in Pult. First attach targetId from discover. Actions: attach, inspect (UI tree), screenshot (image), tap, swipe, type, button, launch, install (app), logs, navigate/open_url, reload, back, forward, detach. Inputs: web tap {ref} from inspect or {x,y}; iOS tap {label} or {x,y} in points; Android tap {x,y} in original pixels. swipe {x,y,endX,endY,duration} (web uses deltaY); button {button:"home"} on mobile, {name:"ENTER"} on web; type {text}; navigate/open_url {url}; launch {appId}; install {path}. Screenshot coordinateWidth/coordinateHeight define input dimensions. Read capabilities. Refresh inspect after screen changes; never invent element IDs. If human controls the target, wait for release. Text-only models can inspect UI trees but cannot judge screenshots or Canvas appearance. Screenshot images are sent to your model provider.', inputSchema: { type: 'object', properties: { targetId: field, action: field, input: { type: 'object', additionalProperties: true } }, required: ['targetId', 'action'], additionalProperties: false } },
  { name: 'request_setup', description: 'Propose missing components for this task using setupId from discover. The user sees the precise setup proposal and chooses whether to install. This tool NEVER approves its own request. Read setup_status and retry discover after setup; manual system steps may be required.', inputSchema: { type: 'object', properties: { setupId: field }, required: ['setupId'], additionalProperties: false } },
  { name: 'setup_status', description: 'Read the user decision and installation state of this session setup requests. Approved manual instructions do not mean the component is installed; verify with discover.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] as const

export function runtimeToolResult(result: unknown): { content: unknown[] } {
  const r = result && typeof result === 'object' ? result as RuntimeResult : {}
  const { image, ...rest } = r
  const content: unknown[] = [{ type: 'text', text: JSON.stringify(rest) }]
  if (image && typeof image.data === 'string' && image.data.length < 700_000 && ['image/png', 'image/jpeg'].includes(image.mimeType)) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return { content }
}

export async function runRuntimeMcp(paths: PultPaths): Promise<number> {
  const key = process.env['PULT_RUNTIME_KEY']
  if (!key) { process.stderr.write('pult: нет ключа среды\n'); return 1 }
  const sessionId = process.env['PULT_RUNTIME_SESSION'] ?? ''
  const client = await connectClient(paths, { runtimeKey: key, client: 'mcp-runtime' })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (id: unknown, result: unknown): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') }
  const tasks = new Set<Promise<void>>()
  const handle = async (raw: string): Promise<void> => {
    let m: Record<string, unknown>
    try { if (Buffer.byteLength(raw) > 100_000) return; m = JSON.parse(raw) as Record<string, unknown>; if (!m || typeof m !== 'object') return } catch { return }
    if (!Object.hasOwn(m, 'id')) return
    if (m['method'] === 'initialize') { send(m['id'], { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pult-runtime', version: '1.0.0' } }); return }
    if (m['method'] === 'ping') { send(m['id'], {}); return }
    if (m['method'] === 'tools/list') { send(m['id'], { tools: RUNTIME_TOOLS }); return }
    if (m['method'] !== 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m['id'], error: { code: -32601, message: 'Method not found' } }) + '\n'); return }
    try {
      const p = m['params'] as { name?: string; arguments?: Record<string, unknown> } | undefined
      const args = p?.arguments ?? {}
      let method: string; let params: Record<string, unknown> = { sessionId }
      switch (p?.name) {
        case 'discover': method = 'runtime.discover'; break
        case 'perform': method = 'runtime.perform'; params = { ...args, sessionId }; break
        case 'request_setup': method = 'runtime.setup.request'; params['setupId'] = args['setupId']; break
        case 'setup_status': method = 'runtime.setup.list'; break
        default: throw new Error('Unknown runtime tool')
      }
      send(m['id'], runtimeToolResult(await client.request(method, params, { timeoutMs: 660_000 })))
    } catch (e) { send(m['id'], { isError: true, content: [{ type: 'text', text: (e as Error).message }] }) }
  }
  try { for await (const line of lines) { const task = handle(line); tasks.add(task); void task.finally(() => tasks.delete(task)); if (tasks.size > 16) await Promise.race(tasks) }; await Promise.allSettled(tasks) }
  finally { client.close() }
  return 0
}
