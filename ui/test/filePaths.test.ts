// Пути файлов в поле текста (⌘V из Finder, перетаскивание) и папка перетаскиванием на форму «+ Сессия»:
// model/filePathsInput.ts без DOM — события в их минимальной форме. Одни и те же обработчики стоят в поле реплики
// разговора и в «первой реплике» диалога; живые броски и вставки гоняет e2e shell/test/e2e/flows.test.ts.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewAgentDialog } from '../src/components/Panels.js'
import { FOLDER_DROP_HINT, folderFromDrop, hasFiles, pathsInputHandlers } from '../src/model/filePathsInput.js'
import type { Caret, DragLike, PasteLike, PathsField } from '../src/model/filePathsInput.js'
import { insertPaths } from '../src/model/paths.js'
import type { FilePathSource } from '../src/model/paths.js'
import { defaultForm, withFolder } from '../src/model/newAgent.js'

/** Поле из стейта, как у компонента: `put` вставляет `insertPaths` от текущего текста. */
function field(value: string, caret = value.length, src: FilePathSource | null = source([])): { el: Caret; t: PathsField; puts: Array<[string[], number, number]> } {
  const el: Caret = { value, selectionStart: caret, selectionEnd: caret }
  const puts: Array<[string[], number, number]> = []
  const t: PathsField = {
    source: src,
    field: () => el,
    put: (paths, start, end) => {
      puts.push([paths, start, end])
      const r = insertPaths(el.value, start, end, paths)
      el.value = r.text
      el.selectionStart = el.selectionEnd = r.caret
    },
  }
  return { el, t, puts }
}

/** Мост окна: пути из буфера main и пути `File` (у настоящего — `webUtils.getPathForFile`). */
function source(clip: string[] | Error, byName: Record<string, string> = {}): FilePathSource {
  return {
    clipboard: async () => { if (clip instanceof Error) throw clip; return clip },
    files: (fs) => fs.flatMap((f) => (byName[f.name] ? [byName[f.name]!] : [])),
  }
}

const file = (name: string): File => new File(['x'], name, { type: 'text/plain' })

function paste(el: Caret, types: string[], files: File[] = []): PasteLike & { prevented: boolean } {
  const e = { clipboardData: { types, files }, currentTarget: el, prevented: false, preventDefault() { e.prevented = true } }
  return e
}
function drag(el: Caret, types: string[], files: File[] = []): DragLike & { prevented: boolean } {
  const e = { dataTransfer: { types, files, dropEffect: 'none' }, currentTarget: el, prevented: false, preventDefault() { e.prevented = true } }
  return e
}

describe('пути файлов в поле: общий помощник поля реплики и «первой реплики»', () => {
  it('hasFiles: только тип Files', () => {
    assert.equal(hasFiles(['text/plain', 'Files']), true)
    assert.equal(hasFiles(['text/plain']), false)
    assert.equal(hasFiles(null), false)
  })

  it('перетаскивание файлов: пути на место каретки, с кавычками и пробелами как в оболочке', () => {
    const f = field('глянь ', 6, source([], { 'a.txt': '/srv/p/Отчёт 1.txt', 'b.txt': '/tmp/b.txt' }))
    const h = pathsInputHandlers(f.t)
    const over = drag(f.el, ['Files'])
    h.onDragOver(over)
    assert.equal(over.prevented, true)
    assert.equal(over.dataTransfer.dropEffect, 'copy')
    const drop = drag(f.el, ['Files'], [file('a.txt'), file('b.txt')])
    h.onDrop(drop)
    assert.equal(drop.prevented, true)
    assert.equal(f.el.value, "глянь '/srv/p/Отчёт 1.txt' /tmp/b.txt")
    assert.equal(f.el.selectionStart, f.el.value.length)
  })

  it('перетаскивание в середину текста: пробел до и после, только если вплотную текст', () => {
    const f = field('глянькод', 5, source([], { 'x': '/x' }))
    pathsInputHandlers(f.t).onDrop(drag(f.el, ['Files'], [file('x')]))
    assert.equal(f.el.value, 'глянь /x код')
  })

  it('перетаскивание не файлов (текст) не трогается: событие не отменено, поле прежнее', () => {
    const f = field('abc')
    const h = pathsInputHandlers(f.t)
    const over = drag(f.el, ['text/plain'])
    h.onDragOver(over)
    const drop = drag(f.el, ['text/plain'])
    h.onDrop(drop)
    assert.deepEqual([over.prevented, drop.prevented, f.puts.length, f.el.value], [false, false, 0, 'abc'])
  })

  it('⌘V на файлах из Finder: все пути из буфера main, а не имя первого файла', async () => {
    const f = field('глянь ', 6, source(['/srv/p/Отчёт 1.txt', '/tmp/b.txt']))
    const e = paste(f.el, ['Files'], [file('Отчёт 1.txt')])
    await pathsInputHandlers(f.t).onPaste(e)
    assert.equal(e.prevented, true)
    assert.equal(f.el.value, "глянь '/srv/p/Отчёт 1.txt' /tmp/b.txt")
  })

  it('⌘V: буфер main пуст или старая оболочка без него — пути из самих File', async () => {
    for (const clip of [[], new Error('нет канала')]) {
      const f = field('', 0, source(clip, { 'a.txt': '/w/a.txt' }))
      await pathsInputHandlers(f.t).onPaste(paste(f.el, ['Files'], [file('a.txt')]))
      assert.equal(f.el.value, '/w/a.txt')
    }
  })

  it('⌘V обычного текста не трогается: событие не отменено, вставляет сам браузер', async () => {
    const f = field('abc')
    const e = paste(f.el, ['text/plain'])
    assert.equal(pathsInputHandlers(f.t).onPaste(e), undefined)
    assert.deepEqual([e.prevented, f.puts.length, f.el.value], [false, 0, 'abc'])
  })

  it('⌘V: пока main читал буфер, в поле допечатали — пути встают туда, где каретка сейчас', async () => {
    let release!: (v: string[]) => void
    const src: FilePathSource = { clipboard: () => new Promise((r) => { release = r }), files: () => [] }
    const f = field('a', 1, src)
    const done = pathsInputHandlers(f.t).onPaste(paste(f.el, ['Files'], [file('x')]))
    f.el.value = 'abc'
    f.el.selectionStart = f.el.selectionEnd = 3
    release(['/x'])
    await done
    assert.deepEqual(f.puts, [[['/x'], 3, 3]])
    assert.equal(f.el.value, 'abc /x')
  })

  it('нет моста (старая оболочка) — ни перетаскивание, ни ⌘V файлов поле не трогают', async () => {
    const f = field('abc', 3, null)
    const h = pathsInputHandlers(f.t)
    const over = drag(f.el, ['Files'])
    h.onDragOver(over)
    const drop = drag(f.el, ['Files'], [file('a')])
    h.onDrop(drop)
    const e = paste(f.el, ['Files'], [file('a')])
    await h.onPaste(e)
    assert.deepEqual([over.prevented, drop.prevented, e.prevented, f.puts.length], [false, false, false, 0])
  })
})

describe('«+ Сессия»: папка перетаскиванием', () => {
  const entry = (isDirectory: boolean) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory }) })
  const src = source([], { proj: '/w/my-proj', 'a.txt': '/w/a.txt', 'b.txt': '/w/b.txt' })

  it('одна папка → её путь', async () => {
    assert.deepEqual(await folderFromDrop({ files: [file('proj')], items: [entry(true)] }, src), { kind: 'folder', path: '/w/my-proj' })
  })

  it('строковые элементы рядом с файлом (uri-list) не мешают найти запись', async () => {
    const items = [{ kind: 'string' }, entry(true)]
    assert.deepEqual(await folderFromDrop({ files: [file('proj')], items }, src), { kind: 'folder', path: '/w/my-proj' })
  })

  it('файл или несколько файлов → «files»: папку не меняют', async () => {
    assert.deepEqual(await folderFromDrop({ files: [file('a.txt')], items: [entry(false)] }, src), { kind: 'files', count: 1 })
    assert.deepEqual(await folderFromDrop({ files: [file('a.txt'), file('b.txt')], items: [entry(false), entry(false)] }, src), { kind: 'files', count: 2 })
  })

  it('нет записи файловой системы: читаемый файл — файл, нечитаемый — папка', async () => {
    assert.deepEqual(await folderFromDrop({ files: [file('a.txt')] }, src), { kind: 'files', count: 1 })
    const dir = Object.assign(file('proj'), { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) })
    assert.deepEqual(await folderFromDrop({ files: [dir as File] }, src), { kind: 'folder', path: '/w/my-proj' })
  })

  it('без моста, без файлов или без пути — ничего', async () => {
    assert.deepEqual(await folderFromDrop({ files: [file('proj')], items: [entry(true)] }, null), { kind: 'none' })
    assert.deepEqual(await folderFromDrop({ files: [] }, src), { kind: 'none' })
    assert.deepEqual(await folderFromDrop({ files: [file('нет-пути')], items: [entry(true)] }, src), { kind: 'none' })
  })

  it('папка из броска ставится как из системного выбора: cwd и имя из папки, пока имя не трогали', () => {
    const f = defaultForm('claude')
    assert.deepEqual([withFolder(f, '/w/my-proj', false, []).cwd, withFolder(f, '/w/my-proj', false, []).name], ['/w/my-proj', 'my-proj'])
    assert.equal(withFolder(f, '/w/my-proj', false, ['my-proj']).name, 'my-proj-2')
    assert.equal(withFolder({ ...f, name: 'mine' }, '/w/my-proj', true, []).name, 'mine')
  })

  it('подсказка про файлы говорит, куда их тащить', () => {
    assert.match(FOLDER_DROP_HINT, /одну папку/)
    assert.match(FOLDER_DROP_HINT, /первая реплика/)
  })

  it('диалог с мостом путей рисуется как раньше: поле реплики и папка на месте, подсветки нет', () => {
    const out = renderToStaticMarkup(createElement(NewAgentDialog as ComponentType<Record<string, unknown>>, {
      taken: [], pickFolder: async () => null, onCreate: async () => null, onClose: () => {}, filePaths: src,
    }))
    assert.match(out, /data-testid="new-agent-prompt"/)
    assert.match(out, /data-testid="new-agent-cwd"/)
    assert.doesNotMatch(out, /data-drop=/)
    assert.doesNotMatch(out, /data-testid="new-agent-drop-hint"/)
  })
})
