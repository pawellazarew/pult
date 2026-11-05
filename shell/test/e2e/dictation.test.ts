import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { launch, REPO, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { Page } from 'playwright-core'

describe('dictation: browser capture and draft lifecycle', () => {
  let h: Harness
  let page: Page
  before(async () => {
    h = await launch({ name: 'dictation' })
    const window = h.app.waitForEvent('window')
    await h.app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ width: 850, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await win.loadURL('about:blank')
    })
    page = await window
    const bundle = await build({ stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Dictation } from './ui/src/components/Dictation.tsx';
      import { appendDictation } from './ui/src/model/speech.ts';
      let delayed = false, resolveText;
      window.testSpeech = { stopped: 0, requests: 0, cancel: 0, ready: true, delay: () => delayed = true, finish: () => resolveText?.('голосом') };
      window.pult = { speech: {
        status: async () => ({ runtime: true, ready: window.testSpeech.ready, downloading: false, received: 0, total: 148000000 }),
        prepare: async () => {}, install: async () => { window.testSpeech.ready = true },
        cancel: async () => { window.testSpeech.cancel++ },
        transcribe: async () => { window.testSpeech.requests++; if (delayed) return new Promise(r => resolveText = r); return 'голосом' }
      }};
      const tracks = () => [{ label: 'MacBook Microphone', stop: () => { window.testSpeech.stopped++ }, onended: null }];
      Object.defineProperty(navigator, 'mediaDevices', { value: {
        getUserMedia: async () => { const t = tracks(); return { getTracks: () => t, getAudioTracks: () => t } },
        enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mac', label: 'MacBook Microphone' }],
        addEventListener() {}, removeEventListener() {}
      }});
      window.MediaRecorder = class {
        state = 'inactive'; onstop; ondataavailable; onerror;
        start() { this.state = 'recording' }
        stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['test']) }); setTimeout(() => this.onstop?.(), 0) }
      };
      window.OfflineAudioContext = class { async decodeAudioData() { return { length: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000).fill(.1) } } };
      function App() {
        const [draft, setDraft] = useState('Мой текст'); const [busy, setBusy] = useState(false); const [session, setSession] = useState(0);
        return <><textarea data-testid="draft" value={draft} onChange={e => setDraft(e.target.value)} /><button data-testid="send" disabled={busy}>Отправить</button><button data-testid="switch" onClick={() => setSession(s => s + 1)}>Смена</button><Dictation key={session} disabled={false} onBusy={setBusy} onText={t => setDraft(d => appendDictation(d, t))}/></>;
      }
      document.body.innerHTML = '<div id="root"></div>'; createRoot(document.getElementById('root')).render(<App/>);
    `, resolveDir: REPO, loader: 'tsx' }, bundle: true, write: false, outfile: '/tmp/pult-dictation-harness.js', platform: 'browser', format: 'iife', jsx: 'automatic' })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByTestId('dictation-toggle').waitFor()
  })
  after(async () => { await h?.close() })
  it('records, releases microphone, preserves edited draft and never submits', async () => {
    await page.getByTestId('dictation-toggle').click()
    await page.getByRole('button', { name: 'Завершить диктовку' }).waitFor()
    assert.equal(await page.getByTestId('send').isDisabled(), true)
    await page.getByTestId('draft').fill('Допечатал')
    await page.getByTestId('dictation-toggle').click()
    assert.ok(await waitFor(async () => await page.getByTestId('draft').inputValue() === 'Допечатал голосом'))
    assert.equal(await page.getByTestId('send').isEnabled(), true)
    assert.equal(await page.evaluate(() => (window as any).testSpeech.stopped), 2)
  })
  it('ordinary Space release does not end click recording; Escape discards it', async () => {
    await page.getByTestId('dictation-toggle').click()
    await page.getByRole('button', { name: 'Завершить диктовку' }).waitFor()
    await page.getByTestId('draft').focus()
    await page.keyboard.press('Space')
    assert.equal(await page.getByRole('button', { name: 'Завершить диктовку' }).count(), 1)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('send').isEnabled(), true)
    assert.equal(await page.evaluate(() => (window as any).testSpeech.requests), 1)
    await page.getByTestId('draft').fill('Допечатал голосом')
  })
  it('push-to-talk ends on release and session switch discards a late transcript', async () => {
    await page.evaluate(() => (window as any).testSpeech.delay())
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.down('Space')
    await page.getByRole('button', { name: 'Завершить диктовку' }).waitFor()
    await page.keyboard.up('Space'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
    assert.ok(await waitFor(async () => await page.evaluate(() => (window as any).testSpeech.requests) === 2))
    await page.getByTestId('switch').click()
    await page.evaluate(() => (window as any).testSpeech.finish())
    assert.equal(await page.getByTestId('draft').inputValue(), 'Допечатал голосом')
    assert.equal(await page.getByTestId('send').isEnabled(), true)
  })
  it('missing model opens a concrete download proposal without recording', async () => {
    await page.evaluate(() => { (window as any).testSpeech.ready = false })
    await page.getByTestId('dictation-toggle').click()
    await page.getByRole('button', { name: 'Скачать модель · 148 МБ' }).waitFor()
    assert.equal(await page.getByTestId('send').isEnabled(), true)
    const client = await h.client()
    await client.request('agent.start', { name: 'voice', kind: 'claude', cwd: h.workDir('voice', { scenario: 'simple' }) })
    await h.win.bringToFront()
    await h.win.locator('[data-testid="agent-row"][data-agent="voice"]').click()
    await h.win.getByRole('button', { name: 'Настройки диктовки' }).click()
    await h.win.getByTestId('settings-nav-voice').waitFor()
    if (await h.win.evaluate(async () => (await window.pult!.speech!.status()).runtime)) await h.win.getByRole('button', { name: 'Скачать модель · 148 МБ' }).waitFor()
    else await h.win.getByText('Обнови приложение Пульта: в этой сборке нет распознавания.').waitFor()
    await h.win.screenshot({ path: `${REPO}/shell/test-results/dictation-settings.png` })
  })
})
