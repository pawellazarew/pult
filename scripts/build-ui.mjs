#!/usr/bin/env node
// build-ui.mjs — сборка интерфейса окна Пульта (docs/12 §1) в статику dist/ui/:
//   index.html (CSP мета-тегом), app.js (React вшит в бандл), app.css (@font-face + стили), fonts/,
//   тексты лицензий вшитого (react-LICENSE.txt, react-dom-LICENSE.txt, scheduler-LICENSE.txt).
//
//   node scripts/build-ui.mjs            одна сборка (её зовёт `npm run build`)
//   node scripts/build-ui.mjs --watch    пересборка на каждое изменение (разработка: `npm run ui:watch`)
//   node scripts/build-ui.mjs --tests    ещё и юнит-тесты интерфейса ui/test/*.test.ts -> dist-ui-test/
//
// ПОЧЕМУ esbuild, а не tsc: интерфейсу нужен ОДИН файл с React внутри (у пакета pult нет рантайм-
// зависимостей, и `dist/ui` обязан открываться без node_modules). Типы проверяет tsc отдельно
// (`npm run typecheck` -> ui/tsconfig.json): esbuild их только стирает.
//
// ШРИФТЫ: woff2 берутся из devDependencies @fontsource-variable/* (OFL-1.1) и копируются в
// dist/ui/fonts/ вместе с текстом лицензии. Источник и лицензии — ui/fonts/LICENSES.md. Берём
// только подмножества cyrillic(-ext) и latin(-ext): интерфейс русский, идентификаторы латиницей.

import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI = join(ROOT, 'ui')
const OUT = join(ROOT, 'dist', 'ui')
const TEST_OUT = join(ROOT, 'dist-ui-test')
const require = createRequire(import.meta.url)

const args = new Set(process.argv.slice(2))
const WATCH = args.has('--watch')
const TESTS = args.has('--tests')

const FONTS = [
  { family: 'Geologica', pkg: '@fontsource-variable/geologica', prefix: 'geologica' },
  { family: 'Onest', pkg: '@fontsource-variable/onest', prefix: 'onest' },
  { family: 'JetBrains Mono', pkg: '@fontsource-variable/jetbrains-mono', prefix: 'jetbrains-mono' },
]
const SUBSETS = new Set(['cyrillic-ext', 'cyrillic', 'latin-ext', 'latin'])

/** Копирует шрифты в dist/ui/fonts и возвращает @font-face на них (пути относительно app.css). */
function buildFonts() {
  const outFonts = join(OUT, 'fonts')
  mkdirSync(outFonts, { recursive: true })
  const faces = []
  for (const f of FONTS) {
    const pkgDir = dirname(require.resolve(`${f.pkg}/package.json`))
    const css = readFileSync(join(pkgDir, 'wght.css'), 'utf8')
    // Блоки вида `/* onest-cyrillic-wght-normal */ @font-face { … }` — формат файлов fontsource.
    const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g
    let m
    let n = 0
    while ((m = re.exec(css)) !== null) {
      const name = m[1]
      const subset = name.slice(f.prefix.length + 1).replace(/-wght-normal$/, '')
      if (!SUBSETS.has(subset)) continue
      const range = /unicode-range:\s*([^;]+);/.exec(m[2])
      const weight = /font-weight:\s*([^;]+);/.exec(m[2])
      if (!range || !weight) throw new Error(`build-ui: в ${f.pkg}/wght.css у блока ${name} нет unicode-range или font-weight`)
      const file = `${name}.woff2`
      copyFileSync(join(pkgDir, 'files', file), join(outFonts, file))
      faces.push(
        `@font-face{font-family:"${f.family}";font-style:normal;font-display:swap;font-weight:${weight[1].trim()};`
        + `src:url(fonts/${file}) format("woff2");unicode-range:${range[1].trim()}}`,
      )
      n++
    }
    if (n !== SUBSETS.size) throw new Error(`build-ui: у ${f.pkg} найдено ${n} подмножеств из ${SUBSETS.size} — формат пакета поменялся`)
    // OFL требует класть текст лицензии рядом со шрифтом при распространении.
    copyFileSync(join(pkgDir, 'LICENSE'), join(outFonts, `${f.prefix}-OFL.txt`))
  }
  copyFileSync(join(UI, 'fonts', 'LICENSES.md'), join(outFonts, 'LICENSES.md'))
  return faces.join('\n') + '\n'
}

/** esbuild кладёт стили бандла в app.css; @font-face дописываем в его начало после каждой сборки. */
function fontsPlugin(faces) {
  return {
    name: 'pult-fonts',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return
        const cssPath = join(OUT, 'app.css')
        const body = readFileSync(cssPath, 'utf8')
        if (!body.startsWith('@font-face')) writeFileSync(cssPath, faces + body)
        copyFileSync(join(UI, 'index.html'), join(OUT, 'index.html'))
        if (WATCH) process.stdout.write(`build-ui: ${new Date().toLocaleTimeString()} собрано\n`)
      })
    },
  }
}

const appOptions = (faces) => ({
  entryPoints: { app: join(UI, 'src', 'main.tsx') },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome140'],
  jsx: 'automatic',
  minify: !WATCH,
  sourcemap: WATCH ? 'inline' : false,
  // Заголовки `@license` (React, react-dom, scheduler — MIT) остаются в конце app.js: лицензия MIT
  // требует нести уведомление об авторских правах вместе с кодом, а React вшит в бандл.
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': WATCH ? '"development"' : '"production"' },
  logLevel: 'warning',
  plugins: [fontsPlugin(faces)],
})

/**
 * Тексты лицензий того, что esbuild вшивает в app.js (React, react-dom и их scheduler — MIT): MIT требует
 * нести уведомление вместе с кодом. Заголовки `@license` остаются в конце app.js (legalComments), а полный
 * текст кладётся рядом — `dist/ui/<пакет>-LICENSE.txt`, как OFL у шрифтов.
 */
function copyBundledLicenses() {
  const fromReactDom = createRequire(require.resolve('react-dom/package.json'))
  const pkgs = [
    ['react', require.resolve('react/package.json')],
    ['react-dom', require.resolve('react-dom/package.json')],
    ['scheduler', fromReactDom.resolve('scheduler/package.json')],
  ]
  for (const [name, pkgJson] of pkgs) copyFileSync(join(dirname(pkgJson), 'LICENSE'), join(OUT, `${name}-LICENSE.txt`))
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const faces = buildFonts()
copyBundledLicenses()
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
mkdirSync(join(OUT, 'pdf'), { recursive: true })
copyFileSync(join(pdfRoot, 'build/pdf.worker.mjs'), join(OUT, 'pdf/pdf.worker.mjs'))
for (const dir of ['standard_fonts', 'cmaps']) cpSync(join(pdfRoot, dir), join(OUT, 'pdf', dir), { recursive: true })
copyFileSync(join(pdfRoot, 'LICENSE'), join(OUT, 'pdfjs-LICENSE.txt'))

if (WATCH) {
  const ctx = await esbuild.context(appOptions(faces))
  await ctx.watch()
  process.stdout.write(`build-ui: слежу за ${UI}\n`)
} else {
  await esbuild.build(appOptions(faces))
  if (TESTS) {
    rmSync(TEST_OUT, { recursive: true, force: true })
    const entries = readdirSync(join(UI, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => join(UI, 'test', f))
    await esbuild.build({
      entryPoints: entries,
      outdir: TEST_OUT,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node22'],
      packages: 'external',
      logLevel: 'warning',
    })
  }
}
