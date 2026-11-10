import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('accepted workspace: modes, general conversations and subagent history', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'paseo-ui' })
    await h.scheme('dark')
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app','data-conn') === 'up',20_000))
    const c = await h.client()
    await c.request('agent.start', { name: 'parent', kind: 'codex', cwd: h.workDir('parent') })
    await c.request('agent.start', { name: 'general', kind: 'claude', scope: 'general' })
    const emit = (kind: string, data: Record<string,unknown>, parentId?: string) => c.request('events.emit', { sessionId: 'parent', provider: 'codex', kind, data, ...(parentId ? { parentId } : {}) })
    await emit('agent.spawned', { toolUseId: 'audit', subagentType: 'pult_ui_audit', description: 'Проверить существующий интерфейс' })
    await emit('message.done', { text: 'Прочитал исходники. Вот результат независимого аудита.', itemId: 'child-result' }, 'audit')
    await emit('tool.called', { toolUseId: 'read-one', name: 'Read', input: { file_path: '/example/ui.tsx' } }, 'audit')
    await emit('tool.finished', { toolUseId: 'read-one', name: 'Read', result: 'existing source' }, 'audit')
    await emit('agent.finished', { toolUseId: 'audit' })
    await emit('agent.spawned', { toolUseId: 'running-child', subagentType: 'designer', description: 'Продолжает проверку' })
    await h.win.locator('[data-testid="agent-row"][data-agent="parent"]').click()
    await h.win.getByTestId('subagents-open').waitFor()
  })
  after(async () => { await h?.close() })

  it('opens read-only existing subagent history and keeps the parent draft', async () => {
    await h.win.getByTestId('composer').fill('Черновик родителя')
    await h.win.getByTestId('subagents-open').click()
    await h.win.getByTestId('subagent-open').filter({ hasText: 'pult_ui_audit' }).click()
    await h.win.getByTestId('subagent-view').waitFor()
    assert.equal(await h.win.getByTestId('composer').isVisible(),false)
    assert.match(await h.win.getByTestId('subagent-view').innerText(),/результат независимого аудита/)
    assert.equal(await h.win.getByTestId('subagent-tab').count(),1)
    await h.screen('paseo-subagent-dark')
    await h.win.getByTestId('subagent-return').click()
    assert.equal(await h.win.getByTestId('composer').inputValue(),'Черновик родителя')
    await h.win.getByTestId('subagents-open').click()
    await h.win.getByTestId('archive-finished-subagents').click()
    await h.win.getByTestId('subagents-open').click()
    assert.equal(await h.win.getByTestId('subagent-open').count(),1)
    assert.match(await h.win.getByTestId('subagent-open').innerText(),/designer/)
    await h.win.getByTestId('subagents-archive-toggle').click()
    await h.win.getByTestId('subagents-open').click()
    assert.equal(await h.win.getByTestId('subagent-open').count(),2)
    await h.win.keyboard.press('Escape')
  })

  it('changes layout without losing chat or draft and persists appearance', async () => {
    for (const mode of ['expanded','focus','normal']) {
      await h.win.getByTestId('conv-menu').click(); await h.win.getByTestId(`mode-${mode}`).click()
      assert.equal(await h.win.getAttribute('.app','data-interface-mode'),mode)
      assert.equal(await h.win.getByTestId('composer').inputValue(),'Черновик родителя')
      assert.equal(await h.win.getByTestId('conversation').getAttribute('data-agent'),'parent')
      if(mode==='expanded')assert.ok(await h.win.getByTestId('conversation-summary').isVisible())
      if(mode==='focus')assert.ok(await h.win.getByTestId('rail-project').count()>0)
      await h.screen(`paseo-${mode}-dark`)
    }
    assert.equal(await h.win.locator('.app .kbd:visible').count(),0)
    await h.win.getByTestId('open-help').click(); await h.win.getByTestId('help-shortcuts').click()
    assert.ok(await h.win.locator('[data-testid="hotkeys-help"] .hotkeys .kbd:visible').count()>0)
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('open-settings').click()
    await h.win.locator('#appearance-theme').selectOption('dark')
    await h.win.getByTestId('appearance-mode-focus').check()
    await h.win.getByTestId('settings-nav-storage').click()
    await h.win.getByTestId('settings-retention').selectOption('90')
    const c=await h.client()
    assert.ok(await waitFor(async()=>((await c.request('settings.get')) as {attachments:{retentionDays:number}}).attachments.retentionDays===90))
    await h.win.getByTestId('settings-nav-usage').click()
    assert.ok(await h.win.getByTestId('settings-usage').isVisible())
    await h.win.keyboard.press('Escape')
    await h.reopen()
    assert.ok(await waitFor(async()=>await h.win.getAttribute('.app','data-interface-mode')==='focus'))
    await h.win.getByTestId('conv-menu').click(); await h.win.getByTestId('mode-normal').click()
  })

  it('identifies providers by icons and blinks only the small working dot', async () => {
    const row = h.win.locator('[data-testid="agent-row"][data-agent="parent"]')
    assert.equal(await row.getByRole('img', { name: 'Codex', exact: true }).count(), 1)
    h.codexConfig({ scenario: 'hang' })
    const c = await h.client()
    await c.request('agent.prompt', { name: 'parent', text: 'Проверь индикатор работы' })
    const dot = row.locator('.row-live-dot[data-state="working"]')
    await dot.waitFor({ state: 'visible' })
    const style = await dot.evaluate((el) => {
      const s = getComputedStyle(el)
      return { width: parseFloat(s.width), height: parseFloat(s.height), animation: s.animationName, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }
    })
    assert.ok(style.width <= 7 && style.height <= 7, 'work indicator must remain a small dot')
    assert.equal(style.animation, style.reduced ? 'none' : 'pulse')
    await h.screen('paseo-provider-working-dot')
    await c.request('agent.stop', { name: 'parent' })
  })

  // Регрессия: вкладка субагента рисовала «●» глифом своего цвета и размера — теперь та же StatusDot, что у строки
  // чата в боковой панели: тот же синий, то же мигание, тот же размер. Провайдер — только значком.
  it('subagent tab and sidebar row share one status dot: working, failed, idle', async () => {
    const c = await h.client()
    const emit = (kind: string, data: Record<string, unknown>) => c.request('events.emit', { sessionId: 'parent', provider: 'codex', kind, data })
    const row = h.win.locator('[data-testid="agent-row"][data-agent="parent"]')
    // Свежий субагент: прошлый тест остановил родителя, и его субагенты уже «прерваны».
    await emit('agent.spawned', { toolUseId: 'dot-child', subagentType: 'dot_check', description: 'Проверяет точку' })
    await h.win.getByTestId('subagents-open').click()
    await h.win.getByTestId('subagent-open').filter({ hasText: 'dot_check' }).click()
    const tab = h.win.locator('[data-testid="subagent-tab"]').filter({ hasText: 'dot_check' })
    await tab.waitFor()
    h.codexConfig({ scenario: 'hang' })
    await c.request('agent.prompt', { name: 'parent', text: 'Проверь точку вкладки' })
    const dotState = async (where: typeof row): Promise<string | null> =>
      await where.locator('.status-dot').count() ? await where.locator('.status-dot').getAttribute('data-state') : null
    const look = (where: typeof row): Promise<string> => where.locator('.status-dot').evaluate((el) => {
      const s = getComputedStyle(el)
      return [s.backgroundColor, s.animationName, s.animationDuration, s.width, s.height].join(' ')
    })
    assert.ok(await waitFor(async () => await dotState(row) === 'working' && await dotState(tab) === 'working'), `working on row and tab: ${await dotState(row)} / ${await dotState(tab)}`)
    assert.equal(await look(tab), await look(row), 'tab dot looks exactly like the row dot')
    assert.equal(await tab.getByRole('img', { name: 'Codex', exact: true }).count(), 1, 'provider stays with the icon')
    await h.screen('status-dot-working')
    await emit('agent.finished', { toolUseId: 'dot-child', isError: true })
    await c.request('agent.stop', { name: 'parent' })
    assert.ok(await waitFor(async () => await dotState(tab) === 'failed' && await dotState(row) === null), 'failed tab, quiet row')
    await h.screen('status-dot-tab-failed-row-idle')
    await emit('status.changed', { status: 'failed', message: 'codex: код 1', errorCode: 'internal' })
    assert.ok(await waitFor(async () => await dotState(row) === 'failed'), 'failed row')
    assert.equal(await look(tab), await look(row))
    await h.screen('status-dot-failed')
    await h.win.getByTestId('subagent-return').click()
  })

  it('global new chat starts without folder and survives as a separate saved conversation', async () => {
    await h.win.getByTestId('new-agent').click()
    await h.win.getByTestId('draft-input').fill('Разговор без проекта')
    assert.match(await h.win.getByTestId('draft-chip-folder').innerText(),/Без проекта/)
    await h.win.getByTestId('draft-send').click()
    await h.win.getByTestId('conversation').waitFor()
    const name=await h.win.getByTestId('conversation').getAttribute('data-agent')
    assert.ok(name)
    const c=await h.client(), listing=await c.request('agent.list') as {sessions:Array<{name:string;scope?:string}>}
    assert.equal(listing.sessions.find((r)=>r.name===name)?.scope,'general')
    assert.ok(await h.win.getByTestId('general-conversations').isVisible())
    assert.doesNotMatch(await h.win.getByTestId('conv-location').innerText(),/conversations\//)
    await h.screen('paseo-general-dark')
    await h.reopen()
    assert.ok(await waitFor(async()=>await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).count()===1))
  })
})
