#!/usr/bin/env node
// public-tree.mjs — exports Pult's PUBLIC source tree (M9): `git ls-files` minus scripts/public-exclude.txt,
// into a fresh git repository with ONE commit «Pult 0.3.0», then checks the export and fails on any finding.
//
//   node scripts/public-tree.mjs <outDir>
//
// <outDir> must not exist (or be an empty directory) and must lie outside this repository. Nothing is pushed,
// nothing is published: the result is a local repository to look at and to run `./scripts/ci-check.sh` in.
//
// Checks (any finding → exit 1, the export stays on disk for inspection):
//   a. REFERENCES — no kept file points to an excluded path: markdown links, paths in backticks, import/require,
//      fixture paths, scripts reading files. A path is resolved from the repo root and from the referencing file's
//      folder; `<placeholder>` segments and `*` count as wildcards, `{a,b}` is expanded. A reference hits when it
//      names an excluded file, a folder whose every file is excluded, or a glob that matches only excluded files.
//      One exception, printed as info: a spike leg (`spike/<leg>/…`) may name its OWN run outputs — paths inside
//      the same leg that the exported .gitignore ignores (the scripts write `logs/` and `results.json` there).
//   b. LEAKGUARD — scripts/ci-leakguard.mjs over every exported file.
//   c. PATTERNS — personal and history markers the leakguard does not know (list below); every hit is printed,
//      only the ones on ALLOW pass.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AUTHOR = { name: 'Pavel Lazarev', email: 'pawellazarew@gmail.com' }
const MESSAGE = 'Pult 0.3.0'

// ---------------------------------------------------------------- pattern scan (c)
// Every rule FAILS unless the hit is on ALLOW. ALLOW entries are exact: file + rule, with the reason.
const PATTERNS = [
  // Absolute home folders of real users; `you` and `user` are the placeholders docs and tests use.
  { name: 'home-path', re: /\/Users\/([a-z][A-Za-z0-9._-]*)/g, ok: (m) => ['you', 'user'].includes(m[1]) },
  { name: 'gmail', re: /@gmail\.com/gi },
  // The owner's local proxy port from the spike era; allowed only where docs explain the proxy example / history.
  { name: 'proxy-10808', re: /127\.0\.0\.1:10808/g },
  // Cloudflare trace fields with a VALUE (`loc=` plus a two- or three-letter code) — an egress country/datacenter as captured output.
  // The parser (`/^loc=(…)/`), interpolations (`loc=${…}`) and the placeholder `loc=XX` are code and docs, not data.
  { name: 'cf-trace', re: /\b(?:loc|colo)=([A-Z]{2,3})\b/g, ok: (m) => m[1] === 'XX' },
  // Work and other personal project/domain names of the owner. A `[x]` class keeps each pattern from matching
  // its own source line, so this file is scanned like any other.
  { name: 'work-org', re: /itgr[i]/gi },
  { name: 'work-domain', re: /01\.tec[h]/gi },
  { name: 'other-project', re: /lazyfo[x]|quicklykiw[i]/gi },
  { name: 'artifact-link', re: /claude\.ai\/artifact/gi },
]

// [file, rule, reason, line?]. A file may also be a RegExp over the path; `line`, when given, must match the line too.
const ALLOW = [
  ['scripts/public-tree.mjs', 'gmail', 'author of the single public commit (public in its metadata anyway)', /^const AUTHOR = \{/],
  [/^docs\/.*\.md$/, 'proxy-10808', 'design docs and DELTA history explain the spike-era proxy example'],
  [/^README(\.ru)?\.md$/, 'proxy-10808', 'README explains the proxy setting with this example address'],
  [/^spike\//, 'proxy-10808', 'spike harness documents/probes the proxy it was measured with (history)'],
  ['scripts/ci-leakguard.mjs', 'artifact-link', 'the leakguard rule claude-artifact documents the address shape it catches (placeholder <id>, no real link)', /artifact\/<id>/],
]

// ---------------------------------------------------------------------- helpers
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts })

function die(msg) {
  process.stderr.write(`public-tree: ${msg}\n`)
  process.exit(2)
}

/** gitignore-style glob → RegExp over a repo path. */
function globToRe(pat) {
  let p = pat
  let anchored = false
  if (p.startsWith('/')) { anchored = true; p = p.slice(1) }
  let dirOnly = false
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1) }
  if (p.includes('/')) anchored = true
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      i++
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const head = anchored ? '^' : '^(?:.*/)?'
  // A pattern names a file or a folder: a folder pattern matches everything under it.
  return new RegExp(head + re + (dirOnly ? '/.*$' : '(?:/.*)?$'))
}

function loadExcludes(file) {
  const rules = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const neg = line.startsWith('!')
    const pat = neg ? line.slice(1) : line
    rules.push({ pat, neg, re: globToRe(pat), used: 0 })
  }
  return rules
}

function isExcluded(rules, path) {
  let out = false
  let hit = null
  for (const r of rules) if (r.re.test(path)) { out = !r.neg; hit = r }
  if (hit) hit.used++
  return out
}

/**
 * Which of `paths` the export's .gitignore ignores. `git check-ignore` exits 1 when NOTHING is ignored (not an
 * error) and dies on an empty line («empty string is not a valid pathspec»), so an export with no excluded files
 * — the public repo itself — asks it nothing.
 */
function checkIgnored(paths) {
  if (!paths.length) return []
  const r = spawnSync('git', ['-C', OUT, 'check-ignore', '--no-index', '--stdin'], { input: paths.join('\n') + '\n', encoding: 'utf8', env: gitEnv, maxBuffer: 256 << 20 })
  if (r.error || (r.status !== 0 && r.status !== 1)) die(`git check-ignore: ${r.error?.message ?? r.stderr.trim()}`)
  return r.stdout.split('\n').filter(Boolean)
}

function isText(buf) {
  return !buf.subarray(0, 8192).includes(0)
}

const human = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`

// ---------------------------------------------------------------------- main
const outArg = process.argv[2]
if (!outArg || outArg.startsWith('-')) die('usage: node scripts/public-tree.mjs <outDir>')
const OUT = resolve(outArg)
if (OUT === ROOT || OUT.startsWith(ROOT + '/')) die(`outDir must lie outside the repository: ${OUT}`)
if (existsSync(OUT) && readdirSync(OUT).length) die(`outDir is not empty: ${OUT}`)

const excludeRules = loadExcludes(join(ROOT, 'scripts', 'public-exclude.txt'))

// `git ls-files -s`: mode, object, stage, path — the mode keeps exec bits and symlinks.
const entries = sh('git', ['-C', ROOT, 'ls-files', '-s', '-z']).split('\0').filter(Boolean).map((l) => {
  const tab = l.indexOf('\t')
  return { mode: l.slice(0, 6), path: l.slice(tab + 1) }
})
const kept = []
const excluded = []
for (const e of entries) (isExcluded(excludeRules, e.path) ? excluded : kept).push(e)
for (const r of excludeRules) if (!r.used && !r.neg) process.stdout.write(`   note: exclude pattern matched nothing: ${r.pat}\n`)

// Copy from the WORKING TREE (what ci-check sees), not from HEAD: the export of a dirty tree is the dirty tree.
mkdirSync(OUT, { recursive: true })
let keptBytes = 0
let exclBytes = 0
for (const e of kept) {
  const src = join(ROOT, e.path)
  const dst = join(OUT, e.path)
  mkdirSync(dirname(dst), { recursive: true })
  if (e.mode === '120000') { symlinkSync(readlinkSync(src), dst); continue }
  copyFileSync(src, dst)
  chmodSync(dst, e.mode === '100755' ? 0o755 : 0o644)
  keptBytes += statSync(dst).size
}
for (const e of excluded) { try { exclBytes += statSync(join(ROOT, e.path)).size } catch { /* deleted in tree */ } }

// One commit, fixed author and committer, no hooks, no signing, nothing inherited from the source repo.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
}
const git = (...args) => sh('git', ['-C', OUT, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv })
git('init', '-q', '-b', 'main')
const listFile = join(OUT, '.git', 'public-tree-files')
writeFileSync(listFile, kept.map((e) => e.path).join('\n') + '\n')
// `-f`: some tracked files match the tree's own .gitignore (negated schema globs) — add exactly the list.
git('add', '-f', `--pathspec-from-file=${listFile}`)
git('commit', '-q', '--no-verify', '-m', MESSAGE)
const sha = git('rev-parse', 'HEAD').trim()
const committed = git('ls-files').split('\n').filter(Boolean)
if (committed.length !== kept.length) die(`commit holds ${committed.length} files, expected ${kept.length}`)

process.stdout.write(`public-tree: ${OUT}\n`)
process.stdout.write(`   commit ${sha} «${MESSAGE}» by ${AUTHOR.name} <${AUTHOR.email}>\n`)
process.stdout.write(`   kept ${kept.length} files (${human(keptBytes)}), excluded ${excluded.length} files (${human(exclBytes)})\n`)

const failures = []

// --------------------------------------------------------------- a. REFERENCES
{
  const keptSet = new Set(kept.map((e) => e.path))
  const exclList = excluded.map((e) => e.path)
  const allList = entries.map((e) => e.path)
  // Paths the exported .gitignore ignores — spike run outputs (see the exception in the header).
  const ignored = new Set(checkIgnored(exclList))
  // Pattern files are lists of globs, not references.
  const SKIP_REF = new Set(['.gitignore', 'scripts/public-exclude.txt', 'scripts/public-tree.mjs'])
  const legOf = (p) => { const m = /^spike\/([^/]+)\//.exec(p); return m ? m[1] : null }

  const expandBraces = (s) => {
    const m = /\{([^{}]*)\}/.exec(s)
    if (!m) return [s]
    return m[1].split(',').flatMap((alt) => expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)))
  }
  const resolveTok = (tok, from) => {
    const out = []
    const bases = tok.startsWith('../') || tok.startsWith('./') ? [posix.dirname(from)] : ['', posix.dirname(from)]
    for (const b of bases) {
      const n = posix.normalize(b ? posix.join(b, tok) : tok)
      if (n.startsWith('../') || n === '..' || n.startsWith('/')) continue
      out.push(n.replace(/^\.\//, ''))
    }
    return out
  }
  /** Which excluded paths a resolved reference names; [] if it names a kept path or nothing. */
  const targets = (ref) => {
    const isDir = ref.endsWith('/')
    const body = isDir ? ref.slice(0, -1) : ref
    if (!body || body === '.') return []
    if (/[*]/.test(body)) {
      const re = globToRe('/' + body + (isDir ? '/' : ''))
      const ex = exclList.filter((p) => re.test(p))
      if (!ex.length) return []
      return allList.some((p) => keptSet.has(p) && re.test(p)) ? [] : ex
    }
    if (!isDir && keptSet.has(body)) return []
    if (!isDir && exclList.includes(body)) return [body]
    const under = allList.filter((p) => p.startsWith(body + '/'))
    if (under.length && under.every((p) => !keptSet.has(p))) return under
    return []
  }

  const hits = []
  const info = []
  for (const e of kept) {
    if (SKIP_REF.has(e.path) || e.mode === '120000') continue
    const buf = readFileSync(join(OUT, e.path))
    if (!isText(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.length > 4000) return   // minified/generated one-liners (schemas, lock files) carry no references
      // `<leg>` placeholders right next to a slash become a wildcard segment: `spike/<нога>/logs/` → `spike/*/logs/`.
      const prepped = line.replace(/<[^<>/\s]+>(?=\/)/g, '*').replace(/(?<=\/)<[^<>/\s]+>/g, '*')
      for (const m of prepped.matchAll(/[\p{L}\p{N}_.\-/*{},]+/gu)) {
        let tok = m[0].replace(/^[,.]+(?=[^./])/, '').replace(/[.,:;]+$/, '')
        if (!tok.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(tok)) continue
        if (tok.startsWith('/') || tok.startsWith('~')) continue
        for (const variant of expandBraces(tok).flatMap((t) => t.includes('{') ? [t] : t.split(','))) {
          if (!variant) continue
          for (const ref of resolveTok(variant, e.path)) {
            const t = targets(ref)
            if (!t.length) continue
            const leg = legOf(e.path)
            const own = leg && t.every((p) => legOf(p) === leg && ignored.has(p))
            const rec = `${e.path}:${i + 1}: ${variant} → ${t.length === 1 ? t[0] : `${t.length} excluded files`}`
            ;(own ? info : hits).push(rec)
            break
          }
        }
      }
    })
  }
  const uniq = (a) => [...new Set(a)]
  process.stdout.write(`\n== a. REFERENCES to excluded paths ==\n`)
  for (const h of uniq(hits)) process.stdout.write(`   HIT ${h}\n`)
  process.stdout.write(`   ${uniq(hits).length} hit(s); ${uniq(info).length} spike leg reference(s) to its own gitignored run output (allowed)\n`)
  if (process.env.PUBLIC_TREE_VERBOSE) for (const h of uniq(info)) process.stdout.write(`   own-output ${h}\n`)
  if (hits.length) failures.push(`references: ${uniq(hits).length}`)
}

// ---------------------------------------------------------------- b. LEAKGUARD
{
  process.stdout.write(`\n== b. LEAKGUARD (scripts/ci-leakguard.mjs over the export) ==\n`)
  try {
    const out = sh(process.execPath, ['scripts/ci-leakguard.mjs'], { cwd: OUT, input: committed.join('\n') + '\n' })
    process.stdout.write(out.split('\n').filter(Boolean).map((l) => `   ${l}`).join('\n') + '\n')
  } catch (err) {
    process.stdout.write(String(err.stdout || '') + String(err.stderr || ''))
    failures.push('leakguard')
  }
}

// ----------------------------------------------------------------- c. PATTERNS
{
  process.stdout.write(`\n== c. PATTERNS ==\n`)
  let bad = 0
  let allowed = 0
  for (const path of committed) {
    const full = join(OUT, path)
    let buf
    try { buf = readFileSync(full) } catch { continue }
    if (!isText(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((line, i) => {
      for (const rule of PATTERNS) {
        for (const m of line.matchAll(rule.re)) {
          if (rule.ok && rule.ok(m)) continue
          const allow = ALLOW.find(([f, r, , l]) => r === rule.name && (f instanceof RegExp ? f.test(path) : f === path) && (!l || l.test(line)))
          const at = Math.max(0, m.index - 40)
          const frag = line.slice(at, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim()
          if (allow) allowed++
          else bad++
          process.stdout.write(`   ${allow ? 'allowed' : 'HIT    '} ${path}:${i + 1}: ${rule.name} — ${frag}\n`)
        }
      }
    })
  }
  process.stdout.write(`   ${bad} hit(s), ${allowed} allowed\n`)
  if (bad) failures.push(`patterns: ${bad}`)
}

process.stdout.write('\n')
if (failures.length) {
  process.stderr.write(`public-tree: FAILED — ${failures.join('; ')} (export kept at ${OUT} for inspection)\n`)
  process.exit(1)
}
process.stdout.write(`public-tree: OK — ${kept.length} kept, ${excluded.length} excluded, commit ${sha}\n`)
