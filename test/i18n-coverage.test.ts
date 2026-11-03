// Guards for the RU/EN catalogs (PR #34). The translator falls back to the Russian source text when a key is
// missing, so a forgotten catalog entry or an unwrapped literal shows up as Russian in the English window without
// any error. These checks read the sources and catch both at test time:
//   1. ui/src has no Cyrillic literal outside t()/tr() keys, comments and regex literals (lines marked
//      `i18n-ignore` are deliberate: native language names, transliteration tables, text normalisation);
//   2. every literal key passed to t()/tr() in ui/src, shell/src and src has an English entry in its catalog.
// Keys built at runtime (t(variable)) are not checked here.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CYR = /[А-Яа-яЁё]/

interface Finding { line: number; text: string; kind: 'string' | 'template' | 'jsx' | 'regex' }

/** Lexer-lite for TS/TSX: Cyrillic outside comments and translator keys, plus the literal keys of t()/tr(). */
export function scanSource(src: string): { findings: Finding[]; keys: string[] } {
  const findings: Finding[] = []
  const keys: string[] = []
  let i = 0
  let line = 1
  const n = src.length
  const at = (k: number): string => src[k] ?? ''
  const identBefore = (end: number): { id: string; dot: boolean } => {
    let k = end
    while (k >= 0 && /[\w$]/.test(at(k))) k--
    return { id: src.slice(k + 1, end + 1), dot: at(k) === '.' }
  }
  /** `t(` / `tr(` right before the literal. */
  const translatorCall = (): boolean => {
    let j = i - 1
    while (j >= 0 && /\s/.test(at(j))) j--
    if (at(j) !== '(') return false
    j--
    while (j >= 0 && /\s/.test(at(j))) j--
    const { id, dot } = identBefore(j)
    return (id === 't' || id === 'tr') && !dot
  }
  /** t`…` / tr`…` */
  const taggedTemplate = (): boolean => {
    const { id, dot } = identBefore(i - 1)
    return (id === 't' || id === 'tr') && !dot
  }
  const unescape = (s: string): string => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, c: string) => {
    if (c[0] === 'u') return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16))
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16))
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[c] ?? c
  })
  const readString = (q: string): string => {
    let s = ''
    i++
    while (i < n && at(i) !== q) {
      if (at(i) === '\\') { s += at(i) + at(i + 1); i += 2; continue }
      if (at(i) === '\n') line++
      s += at(i); i++
    }
    i++
    return s
  }
  const readTemplate = (): string => {
    let key = ''
    let index = 0
    i++
    while (i < n && at(i) !== '`') {
      if (at(i) === '\\') { key += at(i) + at(i + 1); i += 2; continue }
      if (at(i) === '$' && at(i + 1) === '{') {
        i += 2
        code(true)
        key += `{${index++}}`
        continue
      }
      if (at(i) === '\n') line++
      key += at(i); i++
    }
    i++
    return key
  }
  function code(nested: boolean): void {
    let depth = nested ? 1 : 0
    while (i < n) {
      const c = at(i)
      if (c === '\n') { line++; i++; continue }
      if (c === '/' && at(i + 1) === '/') { while (i < n && at(i) !== '\n') i++; continue }
      if (c === '/' && at(i + 1) === '*') {
        const end = src.indexOf('*/', i + 2)
        const stop = end < 0 ? n : end + 2
        line += (src.slice(i, stop).match(/\n/g) ?? []).length
        i = stop
        continue
      }
      if (c === "'" || c === '"') {
        const start = line
        const keyed = translatorCall()
        const s = readString(c)
        if (keyed) keys.push(unescape(s))
        else if (CYR.test(s)) findings.push({ line: start, text: s, kind: 'string' })
        continue
      }
      if (c === '`') {
        const start = line
        const keyed = taggedTemplate() || translatorCall()
        const key = readTemplate()
        if (keyed) keys.push(unescape(key))
        else if (CYR.test(key)) findings.push({ line: start, text: key, kind: 'template' })
        continue
      }
      if (c === '/') {
        // Regex literal after an operator or keyword (JSX `</tag>` and `/>` follow `<`, `"` or `}` — not here).
        let j = i - 1
        while (j >= 0 && (at(j) === ' ' || at(j) === '\t')) j--
        if (j < 0 || /[(,=:[!&|?{;+\-*%~^\n]/.test(at(j)) || /\b(return|typeof|case)$/.test(src.slice(Math.max(0, j - 6), j + 1))) {
          let k = i + 1
          let cls = false
          while (k < n && at(k) !== '\n') {
            if (at(k) === '\\') { k += 2; continue }
            if (at(k) === '[') cls = true
            else if (at(k) === ']') cls = false
            else if (at(k) === '/' && !cls) break
            k++
          }
          if (at(k) === '/') {
            const body = src.slice(i + 1, k)
            if (CYR.test(body)) findings.push({ line, text: body, kind: 'regex' })
            i = k + 1
            while (/[a-z]/.test(at(i))) i++
            continue
          }
        }
      }
      if (c === '{') depth++
      if (c === '}') { depth--; if (nested && depth === 0) { i++; return } }
      if (CYR.test(c)) {
        // Cyrillic in code position: JSX text (or a Cyrillic identifier).
        let k = i
        while (k < n && at(k) !== '\n' && at(k) !== '<' && at(k) !== '{') k++
        findings.push({ line, text: src.slice(i, k).trim(), kind: 'jsx' })
        i = k
        continue
      }
      i++
    }
  }
  code(false)
  return { findings, keys }
}

/** Catalog files are machine-formatted: one `"key": "value"` JSON pair per line. */
function catalog(file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
    const l = raw.trim().replace(/,$/, '')
    if (!l.startsWith('"')) continue
    const pair = JSON.parse(`{${l}}`) as Record<string, string>
    for (const [k, v] of Object.entries(pair)) {
      assert.ok(!out.has(k), `${file}: duplicate key ${JSON.stringify(k)}`)
      out.set(k, v)
    }
  }
  assert.ok(out.size > 0, `${file}: no entries parsed`)
  return out
}

function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(join(ROOT, d))) {
      const rel = join(d, name)
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(rel)
    }
  }
  walk(dir)
  return out
}

const CATALOG_FILES = {
  ui: ['ui/src/locales/components.en.ts', 'ui/src/locales/models.en.ts'],
  shell: ['src/i18n/shell.en.ts'],
  cli: ['src/i18n/cli.en.ts'],
  shared: ['src/i18n/shared.ts'],
} as const
type CatalogName = keyof typeof CATALOG_FILES

/** Which catalog a file's translator uses — from its import, as wired in PR #34. */
function catalogOf(file: string, src: string): CatalogName | null {
  if (file.startsWith('ui/src/')) return /from '(?:\.\.?\/)+(?:lib\/)?i18n\.js'/.test(src) ? 'ui' : null
  if (file.startsWith('shell/src/')) return /from '\.\/i18n\.js'/.test(src) ? 'shell' : null
  if (/from '(?:\.\.\/cli|\.)\/i18n\.js'/.test(src)) return 'cli'
  if (/from '(?:\.\.\/)+i18n\/shared\.js'/.test(src)) return 'shared'
  return null
}

describe('i18n catalogs', () => {
  it('scanner separates translator keys from untranslated literals', () => {
    const { findings, keys } = scanSource([
      "const a = t('Привет') // комментарий",
      'const b = tr`Ещё ${n} ${plural(n, tr(\'строка\'), tr(\'строки\'), tr(\'строк\'))}`',
      "const c = 'голый текст'",
      'const d = <p title="подсказка">{t("Готово")} Текст</p>',
      "const e = /неизвестный метод/.test(x)",
      '/* блок\n   комментарий */ const f = obj.t(\'не ключ\')',
    ].join('\n'))
    assert.deepEqual(keys.sort(), ['Готово', 'Ещё {0} {1}', 'Привет', 'строк', 'строка', 'строки'].sort())
    assert.deepEqual(findings.map((f) => [f.line, f.kind, f.text]), [
      [3, 'string', 'голый текст'],
      [4, 'string', 'подсказка'],
      [4, 'jsx', 'Текст'],
      [5, 'regex', 'неизвестный метод'],
      [7, 'string', 'не ключ'],
    ])
  })

  it('ui/src has no Russian literal outside the translator (RU text lives only as catalog keys)', () => {
    const leftovers: string[] = []
    for (const file of sources('ui/src')) {
      if (file.startsWith(join('ui', 'src', 'locales'))) continue
      const src = readFileSync(join(ROOT, file), 'utf8')
      const lines = src.split('\n')
      for (const f of scanSource(src).findings) {
        if (f.kind === 'regex') continue // matching provider/daemon output, never shown
        if (/i18n-ignore/.test(lines[f.line - 1] ?? '')) continue
        leftovers.push(`${relative(ROOT, join(ROOT, file))}:${f.line}: ${f.text.slice(0, 120)}`)
      }
    }
    assert.deepEqual(leftovers, [], 'wrap these in t()/tr() and add an English entry (or mark the line i18n-ignore if deliberate)')
  })

  it('every literal translator key has an English entry in its catalog', () => {
    const catalogs = Object.fromEntries(Object.entries(CATALOG_FILES).map(([name, files]) => {
      const merged = new Map<string, string>()
      for (const f of files) for (const [k, v] of catalog(f)) merged.set(k, v)
      return [name, merged]
    })) as Record<CatalogName, Map<string, string>>
    const missing: string[] = []
    let checked = 0
    for (const file of [...sources('ui/src'), ...sources('shell/src'), ...sources('src')]) {
      if (file.startsWith(join('ui', 'src', 'locales')) || file.startsWith(join('src', 'i18n'))) continue
      const src = readFileSync(join(ROOT, file), 'utf8')
      const which = catalogOf(file, src)
      if (!which) continue
      for (const key of scanSource(src).keys) {
        if (!CYR.test(key)) continue
        checked++
        const en = catalogs[which].get(key)
        if (en === undefined) missing.push(`${which} ${file}: ${JSON.stringify(key).slice(0, 160)}`)
        else {
          // Placeholders must survive translation: a lost {N} silently drops a value from the English text.
          const want = new Set(key.match(/\{\d+\}/g) ?? [])
          for (const p of want) if (!en.includes(p)) missing.push(`${which} ${file}: ${JSON.stringify(key).slice(0, 80)} — English text lacks ${p}`)
        }
      }
    }
    assert.ok(checked > 500, `only ${checked} keys found — scanner or catalog wiring broke`)
    assert.deepEqual(missing, [])
  })
})
