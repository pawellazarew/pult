import { connectClient } from '../../src/cli/client.ts'
import { paths } from '../../src/core/paths.ts'

// Use the existing handshake, protocol version, limits and timeout behavior.
// This adapter exposes two reads only; the owner credential never leaves Node/Bun.
export async function readDaemon(route: string, name: string) {
  const client = await connectClient(paths(), { client: 'cli', timeoutMs: 5000 })
  try {
    if (route === 'sessions') {
      const result = await client.request('agent.list', {}, { timeoutMs: 5000 }) as { sessions: Array<Record<string, unknown>> }
      return { sessions: result.sessions.filter(s => !s.archived).map(s => ({
        name: String(s.name), title: String(s.title || s.name),
        provider: String(s.provider), status: String(s.lastStatus || 'idle'), cwd: String(s.cwd),
      })) }
    }
    if (route === 'conversation') {
      if (!name) return { text: 'Выберите разговор слева.' }
      const result = await client.request('agent.read', { name, format: 'text', since: 0 }, { timeoutMs: 5000 }) as { text?: string; truncated?: boolean }
      return { text: (result.text || 'В этом разговоре пока нет сообщений.') + (result.truncated ? '\n\n[Показана первая страница истории]' : '') }
    }
    throw new Error('unsupported read')
  } finally { client.close() }
}

export function startBridge(read = readDaemon) {
  const capability = crypto.randomUUID() + crypto.randomUUID()
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      // No browser origins, CORS, generic RPC passthrough or write endpoint.
      if (request.headers.has('origin')) return new Response('Forbidden', { status: 403 })
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      const route = url.pathname.slice(1)
      if (!['sessions', 'conversation'].includes(route) || request.headers.get('authorization') !== `Bearer ${capability}`) {
        return new Response('Not found', { status: 404 })
      }
      try { return Response.json(await read(route, url.searchParams.get('name') || ''), { headers: { 'Cache-Control': 'no-store' } }) }
      catch { return Response.json({ error: 'Не удалось прочитать демон Пульта. Проверьте, что он запущен.' }, { status: 503 }) }
    },
  })
  return { server, capability, origin: `http://127.0.0.1:${server.port}` }
}
