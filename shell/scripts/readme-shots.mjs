#!/usr/bin/env node
// readme-shots.mjs — кадры окна для README: сцена на фальшивых CLI → test-results/readme/ → сжатые PNG в docs/images/.
//
//   cd shell && npm run shots:readme
//
// Шаги: сборка пакета pult (демон и интерфейс окна берутся из ../dist), сборка тестов оболочки, прогон
// test/readme/shots.test.ts (снимает ТОЛЬКО окно Electron, не экран), затем pngquant через npx (без зависимости
// в package.json). Нет сети для npx — PNG копируются несжатыми, скрипт об этом пишет.
// В гейт (scripts/ci-check.sh) не входит: кадры меняются при любой правке вида, а сравнивать их не с чем.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELL = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(SHELL, '..')
const RAW = join(SHELL, 'test-results', 'readme')
const OUT = join(REPO, 'docs', 'images')
const PNGQUANT = 'pngquant-bin@9.0.0'

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) { process.stderr.write(`readme-shots: ${cmd} ${args.join(' ')} — код ${r.status}\n`); process.exit(1) }
}

run('npm', ['run', 'build'], REPO)
run('node', ['scripts/build.mjs', '--tests'], SHELL)
run('node', ['--test', '--test-concurrency=1', 'dist-test/readme/shots.test.js'], SHELL)

mkdirSync(OUT, { recursive: true })
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`
for (const name of readdirSync(RAW).filter((f) => f.endsWith('.png')).sort()) {
  const src = join(RAW, name)
  const dst = join(OUT, name)
  // 256 цветов на кадр интерфейса хватает: ровные заливки, текст остаётся чётким (--quality 80–98, без дизеринга —
  // он шумит на плоском фоне и раздувает файл).
  const q = spawnSync('npx', ['--yes', PNGQUANT, '--quality=80-98', '--speed=1', '--nofs', '--strip', '--force', '--output', dst, src], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (q.status !== 0) {
    copyFileSync(src, dst)
    process.stdout.write(`  ${name}: pngquant не сработал (${String(q.stderr).trim().split('\n').pop() || `код ${q.status}`}) — скопирован как есть, ${kb(dst)}\n`)
    continue
  }
  process.stdout.write(`  ${name}: ${kb(src)} → ${kb(dst)}\n`)
}
process.stdout.write(`readme-shots: ${OUT}\n`)
