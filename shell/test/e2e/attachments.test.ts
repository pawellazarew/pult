import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, ONE_PX_PNG, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('вложения: карточки, временные файлы и отправка', () => {
  let h: Harness
  let client: Awaited<ReturnType<Harness['client']>>
  before(async () => {
    h = await launch({ name: 'attachments' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    client = await h.client()
    h.codexConfig({ scenario: 'simple' })
    await client.request('agent.start', { name: 'attached', kind: 'codex', cwd: h.workDir('project') })
    await h.win.locator('[data-testid="agent-row"][data-agent="attached"]').click()
    await h.win.getByTestId('composer').waitFor()
    await h.win.getByTestId('toggle-inbox').click()
  })
  after(async () => { await h?.close() })
  const dropMemory = async (id: string, name: string, content: string, type: string): Promise<void> => {
    await h.win.getByTestId(id).evaluate((el, arg) => {
      const bytes = Uint8Array.from(atob(arg.content), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], arg.name, { type: arg.type }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, { name, content, type })
  }
  const cards = () => h.win.getByTestId('attachment-card')
  const cardPaths = () => cards().evaluateAll((els) => els.map((el) => el.getAttribute('data-path')!))
  const users = async (session: string) => ((await client.request('events.tail', { since: 0, sessionId: session })) as { events: Array<{ kind: string; data: { text?: string } }> }).events.filter((e) => e.kind === 'message.user').map((e) => e.data.text ?? '')

  it('drop картинки из памяти и обычного файла показывает карточки; reload сохраняет их без исходника', async () => {
    const box = h.win.getByTestId('composer')
    await box.fill('Сравни эти файлы')
    await dropMemory('composer', 'Снимок.png', ONE_PX_PNG, 'image/png')
    const original = path.join(h.workDir('temporary'), 'notes.txt')
    writeFileSync(original, 'temporary source')
    await h.win.getByTestId('attachment-picker').setInputFiles(original)
    assert.ok(await waitFor(async () => await cards().count() === 2))
    assert.equal(await box.inputValue(), 'Сравни эти файлы')
    assert.ok(await waitFor(async () => await cards().locator('img').count() === 1))
    const paths = await cardPaths()
    assert.ok(paths.every((p) => p.startsWith(path.join(h.home, 'attachments', 'attached') + '/')))
    assert.equal(readFileSync(paths.find((p) => p.endsWith('notes.txt'))!, 'utf8'), 'temporary source')
    unlinkSync(original)
    await h.win.reload()
    assert.ok(await waitFor(async () => await cards().count() === 2))
    assert.ok(await waitFor(async () => await cards().locator('img').count() === 1))
    assert.ok(paths.every(existsSync))
    for (const theme of ['light', 'dark'] as const) { await h.scheme(theme); await h.screen(`attachments-${theme}`) }
    await cards().filter({ hasText: 'notes.txt' }).getByTestId('attachment-remove').click()
    await h.win.reload()
    assert.ok(await waitFor(async () => await cards().count() === 1))
    assert.ok(paths.every(existsSync), 'крестик не удаляет файл, который может быть в истории')
  })

  it('вложение отправляется без текста; агент получает сохранённый путь, карточки очищаются', async () => {
    const saved = (await cardPaths())[0]!
    await h.win.getByTestId('composer').fill('')
    await h.win.getByTestId('send').click()
    assert.ok(await waitFor(async () => (await users('attached')).some((text) => text.includes(saved))))
    assert.equal(await cards().count(), 0)
    assert.ok(existsSync(saved))
    const messages = await users('attached')
    assert.match(messages[0]!, /^Прикреплённые файлы:/)
    await h.win.reload()
    await h.win.getByTestId('composer').waitFor()
    assert.equal(await cards().count(), 0)
  })

  it('новый диалог: вложить до имени, переименовать, создать — путь в папке итоговой сессии', async () => {
    const dir = h.workDir('new-project', { scenario: 'simple' })
    await h.stubPickFolder(dir)
    await h.win.keyboard.press('Meta+N')
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor()
    await dlg.getByTestId('new-agent-name').fill('')
    await dropMemory('new-agent-prompt', 'draft.txt', Buffer.from('draft contents').toString('base64'), 'text/plain')
    assert.ok(await waitFor(async () => await dlg.getByTestId('attachment-card').count() === 1))
    const stage = await dlg.getByTestId('attachment-card').getAttribute('data-path')
    assert.match(stage!, /attachments\/draft-/)
    await dlg.getByTestId('pick-folder').click()
    await dlg.getByTestId('new-agent-name').fill('final-chat')
    await dlg.getByTestId('new-agent-submit').click()
    await dlg.waitFor({ state: 'detached', timeout: 15_000 })
    assert.ok(await waitFor(async () => (await users('final-chat')).length > 0, 15_000))
    const text = (await users('final-chat'))[0]!
    assert.ok(text.includes(path.join(h.home, 'attachments', 'final-chat')))
    assert.ok(!text.includes(stage!))
    const final = text.slice(text.indexOf('- ') + 2).trim().replace(/^'|'$/g, '')
    assert.equal(readFileSync(final, 'utf8'), 'draft contents')
  })

  it('слишком большой файл объясняется словами, текст и уже добавленное вложение остаются', async () => {
    await h.win.locator('[data-testid="agent-row"][data-agent="attached"]').click()
    await h.win.getByTestId('composer').fill('не теряй этот текст')
    await dropMemory('composer', 'small.txt', Buffer.from('small').toString('base64'), 'text/plain')
    assert.ok(await waitFor(async () => await cards().count() === 1))
    await h.win.getByTestId('composer').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(26 * 1024 * 1024)], 'too-big.bin'))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('paste-notice').textContent().catch(() => '')) ?? '').includes('25 МБ')))
    assert.equal(await cards().count(), 1)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'не теряй этот текст')
    await h.win.getByTestId('attachment-remove').click()
    // Текст из Office с приложенной картинкой вставляет текст, а не ещё одну карточку.
    await h.win.getByTestId('composer').evaluate((el) => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'таблица')
      dt.setData('image/png', 'ignored')
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      if (!el.dispatchEvent(event)) throw new Error('обычный текст перехвачен')
    })
    assert.equal(await cards().count(), 0)
  })

  it('исчезнувшая сохранённая копия блокирует отправку и оставляет черновик', async () => {
    await dropMemory('composer', 'missing.txt', Buffer.from('missing').toString('base64'), 'text/plain')
    assert.ok(await waitFor(async () => await cards().count() === 1))
    const saved = (await cardPaths())[0]!
    const before = (await users('attached')).length
    unlinkSync(saved)
    await h.win.getByTestId('send').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('paste-notice').isVisible()))
    assert.equal((await users('attached')).length, before)
    assert.equal(await cards().count(), 1)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'не теряй этот текст')
  })


  it('медленная проверка и её отказ возвращают снимок, сохраняя новый текст и новое вложение', async () => {
    await h.win.getByTestId('attachment-remove').click()
    await h.win.getByTestId('composer').fill('первый запрос')
    await dropMemory('composer', 'first.txt', Buffer.from('first').toString('base64'), 'text/plain')
    assert.ok(await waitFor(async () => await cards().count() === 1))
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('pult:attachment-import')
      ipcMain.handle('pult:attachment-import', async () => {
        await new Promise((resolve) => setTimeout(resolve, 800))
        return { error: 'Проверка временно недоступна. Повтори отправку.' }
      })
    })
    const before = (await users('attached')).length
    await h.win.getByTestId('send').click()
    assert.equal(await h.win.getByTestId('composer').inputValue(), '')
    await h.win.getByTestId('composer').fill('новый запрос')
    await dropMemory('composer', 'second.txt', Buffer.from('second').toString('base64'), 'text/plain')
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('paste-notice').textContent().catch(() => '')) ?? '').includes('временно недоступна')))
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'первый запрос\n\nновый запрос')
    assert.equal(await cards().count(), 2)
    assert.equal((await users('attached')).length, before)
  })

})
