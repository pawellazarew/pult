import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { RuntimeResult } from '../../../src/runtimes/types.js'

describe('runtime web: user and agent share one isolated browser page', () => {
  let h: Harness
  let server: Server
  let url: string
  const perform = async (action: string, input: Record<string, unknown> = {}): Promise<RuntimeResult> => {
    const c = await h.client()
    return await c.request('runtime.perform', { sessionId: 'web-test', targetId: 'web:web-test', action, input }) as RuntimeResult
  }
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>Shared preview</title><h1>Preview test</h1><input aria-label="Message"><button onclick="document.querySelector(\'output\').textContent=\'Clicked by agent\'">Change</button><output>Ready</output><script>window.probe={pult:typeof window.pult,node:typeof require,process:typeof process};console.log("runtime-console-proof")</script>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    h = await launch({ name: 'runtime-web' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client()
    await c.request('agent.start', { name: 'web-test', kind: 'claude', cwd: h.workDir('web-test') })
    assert.ok(await waitFor(async () => {
      const found = await c.request('runtime.discover', { sessionId: 'web-test' }) as { targets?: Array<{ kind: string; state: string }> }
      return found.targets?.some((target) => target.kind === 'web' && target.state === 'ready') === true
    }))
  })
  after(async () => { await h?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())) })

  it('agent reads the user input from the same WebContents, clicks, captures hidden page', async () => {
    await perform('attach', { url })
    await h.win.getByTestId('runtime-panel').waitFor()
    assert.equal(await h.win.getByTestId('action-error').count(), 0, 'runtime attachment should refresh newly created sessions before navigating')
    // Read the exact app-owned WebContentsView, not a second page with the same URL.
    await h.app.evaluate(async ({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL() === base)
      if (!wc) throw new Error('Shared contents not found')
      await wc.executeJavaScript('document.querySelector("input").value = "manual-same-target-proof";document.querySelector("input").dispatchEvent(new Event("input",{bubbles:true}))')
    }, url)
    const snapshot = await perform('inspect')
    assert.match(snapshot.text ?? '', /manual-same-target-proof/)
    const button = (snapshot['nodes'] as Array<{ ref: string; role: string; name: string }>).find((node) => node.role === 'button' && node.name === 'Change')
    assert.ok(button)
    await perform('tap', { ref: button.ref })
    assert.ok(await waitFor(async () => /Clicked by agent/.test((await perform('inspect')).text ?? '')))
    await h.win.evaluate(async () => { await window.pult!.runtimeView!('web-test', null) })
    const image = await perform('screenshot')
    assert.equal(image.image?.mimeType, 'image/jpeg')
    assert.ok(Number(image['coordinateWidth']) > 0 && Number(image['coordinateHeight']) > 0)
    assert.ok(Number(image['width']) > 0 && Number(image['height']) > 0)
    assert.ok(image.image && Buffer.from(image.image.data, 'base64').length > 500)
    assert.ok((image.image?.data.length ?? 0) < 530_001)
    const logs = await perform('logs')
    assert.match(logs.text ?? '', /runtime-console-proof/)
    // Capture the user's agent-observation mode: its DOM image is the SAME native contents.
    await h.win.getByTestId('runtime-control').click()
    await h.win.getByTestId('runtime-screen').locator('img').waitFor()
    assert.ok(await waitFor(async () => await h.win.getByTestId('runtime-screen').locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)))
    await h.screen('runtime-web-shared-preview')
    await h.win.getByTestId('runtime-control').click()
    await h.win.evaluate(async () => { await window.pult!.runtimeView!('web-test', null) })
  })

  it('untrusted page has no Pult bridge or Node, cannot navigate to files or open popups', async () => {
    const proof = await h.app.evaluate(async ({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL() === base)!
      return await wc.executeJavaScript('window.probe') as { pult: string; node: string; process: string }
    }, url)
    assert.deepEqual(proof, { pult: 'undefined', node: 'undefined', process: 'undefined' })
    for (const destination of ['app://pult/index.html', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello']) {
      await assert.rejects(perform('navigate', { url: destination }))
    }
    await h.app.evaluate(async ({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find((item) => item.getURL() === base)!
      await wc.executeJavaScript('window.open("https://example.com");location.href="file:///etc/passwd"')
    }, url)
    assert.equal((await perform('inspect'))['url'], url)
    assert.equal(await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    const c = await h.client()
    const events = await c.request('events.tail', { limit: 1000 })
    assert.ok(!JSON.stringify(events).includes('image/jpeg'), 'screenshots must not enter the durable journal')
    await perform('detach')
  })
  it('opens a blank web target before the user chooses a URL', async () => {
    await perform('attach')
    assert.equal((await perform('inspect'))['url'], 'about:blank')
    await perform('navigate', { url })
    assert.equal((await perform('inspect'))['url'], url)
    await perform('detach')
  })

})
