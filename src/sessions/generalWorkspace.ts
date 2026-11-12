// У обычного разговора без проекта есть своя нейтральная папка для CLI. Она не становится
// проектом и не наследует файлы предыдущего чата, даже если имя сессии переиспользовали.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tr } from '../i18n/shared.js'
import { SESSION_NAME_RE } from './registry.js'

export function generalWorkspaceRoot(home: string): string {
  const root = join(home, 'conversations')
  try { mkdirSync(root, { mode: 0o700 }) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== join(realpathSync(home), 'conversations')) {
    throw new Error(tr('папка разговоров без проекта подменена — запуск отменён'))
  }
  chmodSync(root, 0o700)
  return root
}

export function createGeneralWorkspace(home: string, name: string): string {
  if (!SESSION_NAME_RE.test(name)) throw new Error(tr('неверное имя разговора'))
  const path = mkdtempSync(join(generalWorkspaceRoot(home), `${name}-`))
  chmodSync(path, 0o700)
  validateGeneralWorkspace(home, name, path)
  return path
}

/** Проверяется перед запуском и после рестарта до записи новой реплики. Ссылки не принимаются. */
export function validateGeneralWorkspace(home: string, name: string, cwd: string): void {
  if (!SESSION_NAME_RE.test(name)) throw new Error(tr('неверное имя разговора'))
  const root = join(home, 'conversations')
  const stat = lstatSync(root), dir = lstatSync(cwd)
  const leaf = basename(cwd)
  const expected = join(realpathSync(home), 'conversations', leaf)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink()
    || realpathSync(dirname(cwd)) !== realpathSync(root) || !leaf.startsWith(`${name}-`)
    || !/^[A-Za-z0-9]{6}$/.test(leaf.slice(name.length + 1))
    || realpathSync(root) !== join(realpathSync(home), 'conversations') || realpathSync(cwd) !== expected) {
    throw new Error(tr('папка разговора без проекта изменилась — запуск отменён'))
  }
}
