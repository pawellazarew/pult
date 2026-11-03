// Общие заготовки для тестов черновика нового чата (шаг B): окружение резолвера и пропсы DraftView.

import { createDraft } from '../src/model/draft.js'
import type { DraftChat, DraftEnv } from '../src/model/draft.js'
import type { DraftViewProps } from '../src/components/Draft.js'
import type { ConsentView } from '../src/model/access.js'

export const NO_CONSENT: ConsentView = { rev: 0, version: 0, current: 1, granted: false, providers: [] }
export const CONSENT: ConsentView = { rev: 4, version: 1, current: 1, granted: true, providers: ['claude', 'codex', 'zcode'], grantedAt: '2026-11-02T10:00:00Z' }

export function env(over: Partial<DraftEnv> = {}): DraftEnv {
  return { settings: null, consent: NO_CONSENT, folder: null, inheritMode: 'default', ...over }
}

export function draft(cwd: string | null = '/w/acme-api', over: Partial<DraftChat> = {}, e: DraftEnv = env()): DraftChat {
  return { ...createDraft({ id: '11111111-2222-4333-8444-555555555555', cwd, now: new Date('2026-11-03T10:00:00Z') }, e), ...over }
}

const noop = (): void => {}

export function draftProps(over: Partial<DraftViewProps> = {}): DraftViewProps & Record<string, unknown> {
  return {
    draft: draft(), env: env(), catalog: null, checking: false, now: Date.parse('2026-11-03T10:00:00Z'), recent: [], projects: [],
    sending: false, error: null, online: true, foreign: false, obstructed: false, filePaths: null,
    onChange: noop, onText: noop, onFolder: noop, onPickSystemFolder: noop, onApproval: noop, onSend: noop, onDiscard: noop,
    onCheckProviders: noop, onClaim: noop, ...over,
  }
}
