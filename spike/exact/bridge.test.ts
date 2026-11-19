import { test, expect } from 'bun:test'
import { startBridge } from './bridge.ts'

test('authenticated reads only; browser and arbitrary RPC requests are refused', async () => {
  const calls: string[] = []
  const b = startBridge(async (route, name) => { calls.push(route); return { route, name } })
  const headers = { authorization: `Bearer ${b.capability}` }
  try {
    expect((await fetch(`${b.origin}/sessions`)).status).toBe(404)
    expect((await fetch(`${b.origin}/agent.prompt`, { headers })).status).toBe(404)
    expect((await fetch(`${b.origin}/sessions`, { method: 'POST', headers })).status).toBe(405)
    expect((await fetch(`${b.origin}/sessions`, { headers: { ...headers, origin: 'https://example.org' } })).status).toBe(403)
    expect(calls).toEqual([])
    const response = await fetch(`${b.origin}/conversation?name=a%26b`, { headers })
    expect(await response.json()).toEqual({ route: 'conversation', name: 'a&b' })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(calls).toEqual(['conversation'])
  } finally { b.server.stop(true) }
})

test('unavailable daemon produces failure without disclosing its error', async () => {
  const b = startBridge(async () => { throw new Error('secret') })
  try {
    const response = await fetch(`${b.origin}/sessions`, { headers: { authorization: `Bearer ${b.capability}` } })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret')
  } finally { b.server.stop(true) }
})
