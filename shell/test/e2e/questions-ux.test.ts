import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { launch, REPO } from './harness.js'
import type { Harness } from './harness.js'
import type { Page } from 'playwright-core'

describe('question form: preserve a reply while navigating, submit from keyboard', () => {
  let h: Harness
  let page: Page
  before(async () => {
    h = await launch({ name: 'questions-ux' })
    const window = h.app.waitForEvent('window')
    await h.app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ width: 850, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await win.loadURL('about:blank')
    })
    page = await window
    const bundle = await build({ stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PermCard } from './ui/src/components/PermCard.tsx';
      import { questionDraft } from './ui/src/model/questions.ts';
      const input = { questions: [
        { id: 'choice', header: 'Scope', question: 'Which part?', options: [{ label: 'UI', description: 'The visible interface' }, { label: 'Backend' }], isOther: true },
        { id: 'detail', header: 'Details', question: 'What should change?', options: null },
        { id: 'secret', header: 'Secret', question: 'Test secret?', options: null, isSecret: true }
      ] };
      window.replies = []; window.readQuestionDraft = () => questionDraft('question-navigation');
      function App() {
        const [visible, show] = useState(true); const [state, setState] = useState('pending');
        return <><button data-testid="navigate" onClick={() => show(v => !v)}>Navigate</button>{visible && <PermCard permId="question-navigation" toolName="requestUserInput" input={input} state={state} now={Date.now()} createdAt={new Date().toISOString()} onAnswer={answers => { window.replies.push(answers); setState('allow') }}/>}</>;
      }
      document.body.innerHTML = '<div id="root"></div>'; createRoot(document.getElementById('root')).render(<App/>);
    `, resolveDir: REPO, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByTestId('question-send').waitFor()
  })
  after(async () => { await h?.close() })
  it('chat → another view → chat preserves selected options and custom text without sending', async () => {
    await page.getByLabel('UI', { exact: false }).check()
    await page.getByRole('textbox', { name: 'Details' }).fill('Make the editor wider')
    await page.getByLabel('Secret', { exact: true }).fill('test-only-secret')
    await page.getByTestId('navigate').click()
    await page.getByTestId('navigate').click()
    assert.equal(await page.getByLabel('UI', { exact: false }).isChecked(), true)
    assert.equal(await page.getByRole('textbox', { name: 'Details' }).inputValue(), 'Make the editor wider')
    assert.equal(await page.getByLabel('Secret', { exact: true }).inputValue(), 'test-only-secret')
    assert.equal(await page.getByLabel('Secret', { exact: true }).getAttribute('type'), 'password')
    assert.equal(await page.evaluate(() => (window as any).replies.length), 0)
  })
  it('Cmd/Ctrl+Enter sends the complete structured reply once, without a new conversation message', async () => {
    await page.getByLabel('UI', { exact: false }).check()
    await page.getByRole('textbox', { name: 'Details' }).fill('Make the editor wider')
    await page.getByRole('textbox', { name: 'Details' }).press('Control+Enter')
    await page.getByText('Ответ отправлен', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).replies), [{ choice: { answers: ['UI'] }, detail: { answers: ['Make the editor wider'] }, secret: { answers: ['test-only-secret'] } }])
    assert.deepEqual(await page.evaluate(() => (window as any).readQuestionDraft()), { chosen: {}, other: {} }, 'resolved reply, including the secret, is removed from the draft cache')
  })
})
