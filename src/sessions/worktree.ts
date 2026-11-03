// `pult agent start … --worktree <ветка>` — рабочая папка агента в отдельном `git worktree`
// (docs/08-PLAN-F1-M4.md §6). Делает это ДЕМОН в `agent.start`, не CLI: папку и ветку должен
// заводить тот же процесс, который потом запускает в ней агента и помнит её в реестре.
//
// ЗАЧЕМ worktree, а не просто `--cwd`: два агента в одной рабочей копии правят одни и те же
// файлы и один индекс — `git add` одного подхватывает полуправку другого. Worktree — вторая
// рабочая копия того же репозитория на своей ветке: история общая, файлы и индекс свои.
//
// ГДЕ ЛЕЖИТ: `PULT_HOME/worktrees/<basename(toplevel)>-<8 hex sha256(realpath(toplevel))>/<папка>`.
//   * вне репозитория — папка внутри репо (как `.claude/worktrees/`) появляется в его
//     `git status` как неотслеживаемая и пачкает дерево человека;
//   * внутри PULT_HOME — инвариант 8: писать можно в PULT_HOME, в папку сессии и её worktree
//     и в `.git` исходного репозитория (служебные файлы самого `git worktree`), больше никуда;
//   * хэш пути в имени — два репозитория `app` в разных местах не должны делить одну папку.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: `--force` (ни в `add`, ни в `remove`) и удаления веток. `--force`
// у `add` выписывает ветку второй раз поверх чужой рабочей копии, у `remove` — выбрасывает
// неотправленную правку. Ветка может держать единственную копию работы агента.
//
// GIT — с окружением по белому списку (инвариант 1) и `GIT_TERMINAL_PROMPT=0`. Белый список
// здесь не формальность: демон, поднятый из git-хука, унаследовал бы `GIT_DIR`/`GIT_INDEX_FILE`,
// и `worktree add` ушёл бы в ЧУЖОЙ репозиторий. `GIT_TERMINAL_PROMPT=0` — у демона нет
// терминала: git, решивший спросить пароль, висел бы до таймаута вместо внятной ошибки.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ERROR_CODES } from '../core/rpc.js'
import { buildChildEnv } from '../env/allowlist.js'

/** Что хранит реестр: где папка, какая ветка и из какого репозитория (docs/08 §6). */
export interface WorktreeInfo {
  path: string
  branch: string
  repo: string
}

export interface PreparedWorktree {
  worktree: WorktreeInfo
  /** cwd сессии: папка worktree + тот же подкаталог, что был у `--cwd` внутри репозитория. */
  cwd: string
  /** Что сделано: новая ветка, выписана существующая, переиспользована готовая папка. */
  action: 'created' | 'checked-out' | 'reused'
  /** `--base` задан, но ветка уже была — база ни на что не повлияла, и человеку надо это знать. */
  baseIgnored: boolean
}

export class WorktreeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'WorktreeError'
  }
}

/** Код ошибки протокола на отказ самого git: CLI выходит с кодом 1 и печатает текст git. */
export const GIT_FAILED = ERROR_CODES.gitFailed

/**
 * Потолок на одну команду git. `worktree add` выписывает файлы целиком — на большом репо
 * это секунды, не минуты; дольше — git чего-то ждёт (замок индекса, хук), и честнее отказать.
 */
export const GIT_TIMEOUT_MS = 120_000

export interface WorktreeOptions {
  /** PULT_HOME. */
  home: string
  /** `--cwd` агента: обязан лежать внутри git-репозитория. */
  cwd: string
  branch: string
  /** `--base <ref>`: от чего завести НОВУЮ ветку. Пусто — HEAD `cwd`. */
  base?: string
  /** Родительское окружение для белого списка; тест подставляет своё. */
  env?: NodeJS.ProcessEnv
  /**
   * Кто из заведённых агентов уже сидит в этой папке. Два агента в одном worktree — ровно та
   * поломка, от которой worktree и спасает (общие файлы и индекс), поэтому переиспользовать
   * можно только папку, у которой хозяина нет.
   */
  inUseBy?: (path: string) => string | null
}

interface GitResult { code: number; stdout: string; stderr: string }

function gitEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  return buildChildEnv(parent, { extra: { GIT_TERMINAL_PROMPT: '0' } })
}

function git(args: string[], env: Record<string, string>): Promise<GitResult> {
  return new Promise((res, rej) => {
    execFile('git', args, { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (e, stdout, stderr) => {
      if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        rej(new WorktreeError(GIT_FAILED, `git не найден в PATH демона (${env['PATH'] ?? ''})`))
        return
      }
      if (e && (e as { killed?: boolean }).killed) {
        rej(new WorktreeError(GIT_FAILED, `git ${args.slice(2, 4).join(' ')} не уложился в ${GIT_TIMEOUT_MS / 1000} с`))
        return
      }
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0
      res({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Первая осмысленная строка ответа git — её человек и увидит. */
function gitText(r: GitResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `git вышел с кодом ${r.code}`).split('\n').slice(0, 4).join('\n')
}

const sha8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/**
 * Имя папки из имени ветки: `/` → `-`, всё вне `[A-Za-z0-9._-]` → `_` (docs/08 §6).
 * Точки в начале не бывает: такие имена веток отвергает сам `check-ref-format`.
 */
export function worktreeSlug(branch: string): string {
  const s = branch.replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '_')
  return s || '_'
}

/** `PULT_HOME/worktrees/<basename>-<8 hex>` для репозитория с этим (уже реальным) корнем. */
export function repoWorktreesDir(home: string, repo: string): string {
  return join(home, 'worktrees', `${basename(repo)}-${sha8(repo)}`)
}

/** Сравнение путей через realpath: на macOS /var → /private/var, а git печатает реальный путь. */
function real(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

interface ListedWorktree { path: string; branch: string | null }

/** `git worktree list --porcelain -z`: записи разделены пустым полем, поля — NUL. */
function parseWorktreeList(raw: string): ListedWorktree[] {
  const out: ListedWorktree[] = []
  let cur: ListedWorktree | null = null
  for (const field of raw.split('\0')) {
    if (field === '') { if (cur) out.push(cur); cur = null; continue }
    if (field.startsWith('worktree ')) { if (cur) out.push(cur); cur = { path: field.slice(9), branch: null }; continue }
    if (cur && field.startsWith('branch refs/heads/')) cur.branch = field.slice('branch refs/heads/'.length)
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Готовит worktree под агента и отдаёт cwd сессии. Порядок проверок — docs/08 §6:
 * репозиторий → имя ветки → папка (переиспользовать / выписать ветку / завести ветку).
 */
export async function prepareWorktree(opts: WorktreeOptions): Promise<PreparedWorktree> {
  const env = gitEnv(opts.env ?? process.env)
  const branch = opts.branch

  // 1. cwd внутри репозитория. `--show-prefix` — тот относительный подкаталог, в который
  //    агент попадёт и в worktree: запущенный из `repo/web` должен работать в `wt/web`.
  const top = await git(['-C', opts.cwd, 'rev-parse', '--show-toplevel', '--show-prefix'], env)
  if (top.code !== 0) {
    throw new WorktreeError('invalid_params', `--cwd ${opts.cwd} не внутри git-репозитория: ${gitText(top)}`)
  }
  const [toplevel = '', prefix = ''] = top.stdout.split('\n')
  if (!toplevel) throw new WorktreeError('invalid_params', `--cwd ${opts.cwd}: git не назвал корень репозитория`)
  const repo = real(toplevel)

  // 2. Имя ветки — судит сам git. Вывод обязан совпасть с вводом: `--branch` РАСКРЫВАЕТ
  //    сокращения вроде `@{-1}` в имя другой ветки, и агент уехал бы не туда, куда просили.
  const ref = await git(['-C', repo, 'check-ref-format', '--branch', branch], env)
  if (ref.code !== 0 || ref.stdout.trim() !== branch) {
    throw new WorktreeError('invalid_params', `--worktree ${JSON.stringify(branch)}: недопустимое имя ветки${ref.code !== 0 ? ` (${gitText(ref)})` : ''}`)
  }

  const listed = await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z'], env)
  if (listed.code !== 0) throw new WorktreeError(GIT_FAILED, gitText(listed))
  const worktrees = parseWorktreeList(listed.stdout)

  // 3. Папка. Корень PULT_HOME берём РЕАЛЬНЫМ: git записывает в свои служебные файлы реальный
  //    путь, и сверка «это та же папка» иначе промахивается на /var → /private/var.
  const root = repoWorktreesDir(real(opts.home), repo)
  const slug = worktreeSlug(branch)
  // Второй кандидат — на случай, когда имя папки уже занято ДРУГОЙ веткой: `a/b` и `a-b`
  // дают одно и то же `a-b`. Хэш имени ветки детерминирован, поэтому повторный `agent start`
  // той же ветки найдёт ту же папку.
  const candidates = [join(root, slug), join(root, `${slug}-${sha8(branch)}`)]

  let chosen: string | null = null
  let reuse = false
  const busy: string[] = []
  for (const p of candidates) {
    const entry = worktrees.find((w) => real(w.path) === real(p))
    if (entry && entry.branch === branch) {
      if (!existsSync(p)) {
        throw new WorktreeError(GIT_FAILED,
          `worktree ${p} записан в git, но папки нет — сначала: git -C ${JSON.stringify(repo)} worktree prune`)
      }
      chosen = p
      reuse = true
      break
    }
    if (entry || existsSync(p)) { busy.push(p); continue }
    chosen = p
    break
  }
  if (!chosen) {
    throw new WorktreeError('invalid_params', `папки под ветку ${branch} заняты другим: ${busy.join(', ')}`)
  }

  let action: PreparedWorktree['action']
  let baseIgnored = false
  if (reuse) {
    const holder = opts.inUseBy?.(chosen) ?? null
    if (holder) {
      throw new WorktreeError('invalid_params', `worktree ${chosen} уже занят агентом ${holder}: два агента в одной папке делят файлы и индекс`)
    }
    action = 'reused'
    baseIgnored = Boolean(opts.base)
  } else {
    // Ветка выписана где-то ещё (в самом репо или в чужом worktree) — git откажет и сам, но
    // его текст про «use --force» звучит как совет. Мы называем путь и не советуем --force.
    const elsewhere = worktrees.find((w) => w.branch === branch)
    if (elsewhere) {
      throw new WorktreeError('invalid_params', `ветка ${branch} уже выписана в ${elsewhere.path}`)
    }
    const known = await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], env)
    // Режим каталога — как у остального PULT_HOME: mkdir маскируется umask, поэтому chmod явно.
    const all = join(root, '..')
    mkdirSync(all, { recursive: true, mode: 0o700 })
    chmodSync(all, 0o700)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (known.code === 0) {
      const add = await git(['-C', repo, 'worktree', 'add', chosen, branch], env)
      if (add.code !== 0) throw new WorktreeError(GIT_FAILED, gitText(add))
      action = 'checked-out'
      baseIgnored = Boolean(opts.base)
    } else {
      // База разрешается в sha ЗАРАНЕЕ и через `--end-of-options`: строка из argv человека
      // вида `--orphan` иначе ушла бы в `worktree add` опцией, а не ревизией.
      const baseRef = opts.base ?? 'HEAD'
      const rev = await git(['-C', opts.cwd, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`], env)
      const sha = rev.stdout.trim()
      if (rev.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
        throw new WorktreeError('invalid_params', `база ${JSON.stringify(baseRef)} не найдена в репозитории ${repo}`)
      }
      const add = await git(['-C', repo, 'worktree', 'add', '-b', branch, chosen, sha], env)
      if (add.code !== 0) throw new WorktreeError(GIT_FAILED, gitText(add))
      action = 'created'
    }
  }

  const worktree: WorktreeInfo = { path: chosen, branch, repo }
  const sub = prefix.replace(/\/+$/, '')
  const cwd = sub ? join(chosen, sub) : chosen
  let isDir = false
  try { isDir = statSync(cwd).isDirectory() } catch { isDir = false }
  if (!isDir) {
    // Подкаталога нет в этой ветке (она старше него). Папку не создаём: пустой каталог, которого
    // нет в ветке, — это агент, работающий «не там», а не удобство. Worktree остаётся и будет
    // переиспользован.
    throw new WorktreeError('invalid_params', `в ветке ${branch} нет подкаталога ${sub} (worktree оставлен: ${chosen})`)
  }
  return { worktree, cwd, action, baseIgnored }
}

/**
 * `git worktree remove <папка>` БЕЗ `--force`: грязное дерево (правка или неотслеживаемый
 * файл) — отказ с текстом git. Ветка не удаляется никогда.
 *
 * Из какого каталога звать git: из исходного репозитория, а если его уже нет — из самого
 * worktree (ИЗМЕРЕНО: `git -C <wt> worktree remove <абсолютный путь wt>` работает). Папки
 * worktree нет — git всё равно отвечает 0 и подчищает свои служебные записи (измерено).
 */
export async function removeWorktree(wt: WorktreeInfo, parentEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = gitEnv(parentEnv)
  const from = existsSync(wt.repo) ? wt.repo : existsSync(wt.path) ? wt.path : null
  if (!from) return
  const r = await git(['-C', from, 'worktree', 'remove', wt.path], env)
  if (r.code !== 0) throw new WorktreeError(GIT_FAILED, gitText(r))
}

/**
 * Шаг B (ревью m10): ветку, которую завёл несостоявшийся старт, убрать вслед за его worktree. `branch -d` — без силы:
 * ветку с коммитами, которых нет в текущей, git не удалит. Зовётся только для ветки, которую этот старт и создал.
 */
export async function deleteBranch(wt: WorktreeInfo, parentEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!existsSync(wt.repo)) return
  const r = await git(['-C', wt.repo, 'branch', '-d', '--', wt.branch], gitEnv(parentEnv))
  if (r.code !== 0) throw new WorktreeError(GIT_FAILED, gitText(r))
}
