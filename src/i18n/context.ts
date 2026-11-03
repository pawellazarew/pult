import { AsyncLocalStorage } from 'node:async_hooks'
import { setLanguageResolver } from './core.js'
import type { Language } from './core.js'
const context = new AsyncLocalStorage<Language | (() => Language)>()
setLanguageResolver(() => { const value = context.getStore(); return typeof value === 'function' ? value() : value })
/** A daemon can serve overlapping requests in different languages without changing global state. */
export function withLanguage<T>(language: Language | (() => Language), run: () => T): T { return context.run(language, run) }
