// Only empty, neutral provider working directories live here. Conversation data never does.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { resolveHome } from '../core/paths.js'
import { TemporaryChatError } from './types.js'

const LEAF = /^work-[A-Za-z0-9]{6}$/
const safeError = (): TemporaryChatError => new TemporaryChatError('internal')

export function defaultTemporaryWorkspaceRoot(): string { return join(resolveHome(), 'temporary-workspaces') }

function rootFor(root: string): string {
  try {
    if (!isAbsolute(root) || basename(root) === '.' || basename(root) === '..') throw safeError()
    try { mkdirSync(root, { mode: 0o700 }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const st = lstatSync(root)
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())
      || realpathSync(root) !== join(realpathSync(dirname(root)), basename(root))) throw safeError()
    chmodSync(root, 0o700)
    return realpathSync(root)
  } catch { throw safeError() }
}

export function createTemporaryWorkspace(root: string): string {
  try {
    const cwd = mkdtempSync(join(rootFor(root), 'work-'))
    chmodSync(cwd, 0o700)
    validateTemporaryWorkspace(root, cwd)
    return cwd
  } catch { throw safeError() }
}

export function validateTemporaryWorkspace(root: string, cwd: string): void {
  try {
    const canonical = rootFor(root), st = lstatSync(cwd)
    if (!LEAF.test(basename(cwd)) || !st.isDirectory() || st.isSymbolicLink()
      || (process.getuid && st.uid !== process.getuid()) || realpathSync(dirname(cwd)) !== canonical
      || realpathSync(cwd) !== join(canonical, basename(cwd))) throw safeError()
  } catch { throw safeError() }
}

/** A substituted child symlink is unlinked, never traversed. A substituted root is refused. */
export function removeTemporaryWorkspace(root: string, cwd: string): void {
  try {
    const canonical = rootFor(root)
    if (!LEAF.test(basename(cwd)) || realpathSync(dirname(cwd)) !== canonical) throw safeError()
    rmSync(join(canonical, basename(cwd)), { recursive: true, force: true })
  } catch { throw safeError() }
}

/** Startup cleanup recognizes only our random leaf names; it reads no conversation state. */
export function cleanupTemporaryWorkspaces(root: string): void {
  try {
    const canonical = rootFor(root)
    for (const name of readdirSync(canonical)) if (LEAF.test(name)) removeTemporaryWorkspace(canonical, join(canonical, name))
  } catch { throw safeError() }
}
