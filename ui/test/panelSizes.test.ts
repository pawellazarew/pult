import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { savedSize, workspaceSizes } from '../src/model/panelSizes.js'
import type { WorkspaceFlags } from '../src/model/panelSizes.js'

const flags: WorkspaceFlags = { sidebarHidden: false, inboxOpen: false, filesOpen: false, filesExpanded: false }

describe('размеры панелей', () => {
  it('не принимает испорченные сохранённые значения', () => {
    for (const raw of [null, '', '  ', 'Infinity', 'NaN', '-40', '10001', 'oops']) assert.equal(savedSize(raw), null)
    assert.equal(savedSize('320'), 320)
  })
  it('ограничивает панели при сужении окна, сохраняя место разговору', () => {
    for (const width of [900, 1024, 1280, 1800]) {
      const s = workspaceSizes(width, { ...flags, inboxOpen: true }, { sidebar: 480, right: 700 })
      assert.ok(s.sidebar >= s.sidebarMin && s.sidebar <= s.sidebarMax)
      assert.ok(s.right >= s.rightMin && s.right <= s.rightMax)
      assert.ok(width - s.sidebar - s.right >= 320)
    }
    const wide = workspaceSizes(1800, { ...flags, inboxOpen: true }, { sidebar: 400, right: 600 })
    assert.equal(wide.sidebar, 400); assert.equal(wide.right, 600)
  })
  it('не резервирует ширину скрытым панелям и режиму чтения', () => {
    const hidden = workspaceSizes(900, { ...flags, sidebarHidden: true, inboxOpen: true }, { sidebar: 480, right: 900 })
    assert.equal(hidden.sidebar, 0); assert.equal(hidden.right, 580)
    const focused = workspaceSizes(900, { ...flags, filesOpen: true, filesExpanded: true }, { sidebar: null, right: 600 })
    assert.equal(focused.rightShown, false); assert.equal(focused.right, 0)
  })
})
