import assert from 'node:assert/strict'
import { it } from 'node:test'
import { HtmlPreviews } from '../../src/htmlPreview.js'
import type { FilePreview } from '../../../src/core/fileBrowserTypes.js'

const file: FilePreview = { path: '/tmp/plan.html', name: 'plan.html', kind: 'text', size: 20, modifiedAt: '', text: '<h1>Plan</h1>' }

it('HTML refresh preserves the running page until content changes', async () => {
  const previews = new HtmlPreviews()
  const first = previews.attach('chat', file)
  assert.ok(first.htmlUrl)
  assert.equal(previews.attach('chat', file).htmlUrl, first.htmlUrl)
  assert.equal(await previews.response(first.htmlUrl).text(), file.text)
  const updated = previews.attach('chat', { ...file, text: '<h1>Updated</h1>' })
  assert.notEqual(updated.htmlUrl, first.htmlUrl)
  assert.equal(previews.response(first.htmlUrl).status, 404)
  assert.equal(previews.response('pult-preview://page/missing').status, 404)
  assert.equal(previews.response(first.htmlUrl.replace('://page/', '://other/')).status, 404)
})

it('truncated HTML and non-HTML files have no website preview', () => {
  const previews = new HtmlPreviews()
  assert.equal(previews.attach('chat', { ...file, truncated: true }).htmlUrl, undefined)
  assert.equal(previews.attach('chat', { ...file, path: '/tmp/plan.txt' }).htmlUrl, undefined)
})
