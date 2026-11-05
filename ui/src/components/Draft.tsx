// Черновик нового чата (быстрый старт, шаг B; design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.2–§3.5, кадры 01, 02,
// 03, 08, 09, 10, 12). Вместо модала «Новая сессия»: заголовок «Что делаем в <папка>?», поле на закреплённой позиции
// (верх колонки на 26% высоты — ввод и меню его не двигают) и чипы под ним: папка · провайдер+модель · усилие · доступ
// · ⋯ (ветка, браузер). Меню встают у своего чипа (прототип ставил меню доступа в правый верхний угол — известный
// недочёт). Логика полей — model/draft.ts; здесь отрисовка, меню, клавиши и вложения.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, RefObject } from 'react'
import { t } from '../lib/i18n.js'
import { ProviderIcon } from './ProviderIcon.js'
import type { ApprovalMode } from '../../../src/adapters/types.js'
import type { SavedAttachment } from '../../../shell/src/contract.js'
import { plural } from '../lib/ru.js'
import { consentGrants } from '../model/access.js'
import { ago, shortPath } from '../model/agents.js'
import {
  accessChipLabel, branchError, draftEmpty, draftFull, escDecision, folderName, linkPromptStats, remembersAccess, modelUnlisted, pickEffort, pickModel, readinessBlocks, readinessOf,
  submitDecision, toggleBrowser, toggleWorktree,
} from '../model/draft.js'
import type { DraftChat, DraftEnv, Readiness } from '../model/draft.js'
import { APPROVAL_LABEL, approvalBlocksBrowser, approvalHint, approvalLevels, providerPreset } from '../model/newAgent.js'
import { folderFromDrop, hasFiles } from '../model/filePathsInput.js'
import type { FilePathSource } from '../model/paths.js'
import type { AgentProvider, ProviderCatalog } from '../model/types.js'
import { Dictation } from './Dictation.js'
import { appendDictation } from '../model/speech.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { useAttachments } from './useAttachments.js'
import { Icon, IS_MAC } from './common.js'

/** Недавняя папка (`folders.recent`): откуда Пульт её знает и когда в ней работали. */
export interface RecentFolder { path: string; at: string; source: 'pult' | 'claude' | 'codex' }

/** Строка под полем о сбое или расхождении: «Повторить», «Вернуть мой текст», «Оставить копию». */
export interface DraftNotice { text: string; retry: boolean; restoreText?: string; fork?: boolean; openChat?: string }

/** Ключ вложений черновика в хранилище окна и папка `attachments/<ключ>` — переживают уход из черновика и перезагрузку. */
export const draftAttachmentSession = (id: string): string => `draft-${id.replace(/-/g, '').slice(0, 20)}`

/** Вложения черновика для старта: сколько их и как переложить в папку вложений сессии, когда демон выдаст имя. */
export interface DraftFiles { count: number; finalize(name: string): Promise<SavedAttachment[]> }

/** Сколько отправка заперта в черновике из ссылки (все пути: кнопка, ↵, ⌘↵) — §3.1, B3. */
export const LINK_SUBMIT_DELAY_MS = 1000

export type MenuKind = 'folder' | 'model' | 'effort' | 'access' | 'speed' | 'more'

export interface DraftViewProps {
  draft: DraftChat
  env: DraftEnv
  catalog: ProviderCatalog | null
  checking: boolean
  now: number
  recent: readonly RecentFolder[] | null
  /** Папки проектов дерева (закреплённые и папки сессий) — первые в меню папки. */
  projects: readonly string[]
  sending: boolean
  error: DraftNotice | null
  /** Демон на связи: иначе черновик пишется, а отправка ждёт. */
  online: boolean
  /** Черновик держит другое окно (пульс свежий): «Забрать». */
  foreign: boolean
  /** Поверх открыт модал: горячие клавиши черновика молчат. */
  obstructed: boolean
  filePaths: FilePathSource | null
  /** Не ставить фокус в поле (черновик открыт ссылкой: окно всплыло без спроса). */
  noAutoFocus?: boolean
  /** Меню, открытое сразу (тесты отрисовки и кадры README). */
  initialMenu?: MenuKind | null
  /** Window actions supplied by Console, independent of draft state. */
  headerActions?: ReactNode
  /** Счётчик ⌘N на этом же черновике: сменился — открытое меню закрывается (§3.5). */
  menuReset?: number
  /** Вложения поменялись — их метаданные идут в снимок черновика (пустота, восстановление). */
  onAttachments?(items: SavedAttachment[]): void
  onRestoreText?(text: string): void
  onFork?(): void
  onOpenChat?(name: string): void
  onChange(d: DraftChat): void
  /** Текст поля — отдельно: вставка вложений приходит позже, и снимок черновика к тому времени мог смениться. */
  onText(text: string): void
  onFolder(cwd: string | null): void
  onPickSystemFolder(): void
  /** Уровень доступа из меню: полный без согласия — диалог согласия у вызывающего. */
  onApproval(a: ApprovalMode): void
  onSend(files: DraftFiles | null): void
  onDiscard(): void
  onCheckProviders(): void
  onClaim(): void
}

const PROVIDER_NAME: Readonly<Record<AgentProvider, string>> = { claude: 'Claude', codex: 'Codex', zcode: 'ZCode' }

function claudeModelNote(id: string): string {
  if (id === 'haiku') return t('быстрая, для мелочей')
  if (id === 'sonnet') return t('на каждый день')
  if (id === 'opus') return t('сложные задачи')
  if (id === 'fable') return t('самая сильная и дорогая')
  return ''
}

function readinessWords(r: Readiness): string {
  switch (r) {
    case 'ready': return t('вход выполнен')
    case 'checking': return t('проверяю…')
    case 'stale': return t('проверено давно')
    case 'login-required': return t('нужен вход')
    case 'catalog-error': return t('список моделей не загрузился')
    case 'unavailable': return t('CLI не запускается')
  }
}

/**
 * Меню у чипа: под ним, а если снизу не помещается — над ним; по ширине — в пределах окна. Клавиши: ↑/↓ — пункты,
 * ↵ — выбрать (и поглощается: до поля не доходит), Esc — закрыть. Клик мимо закрывает.
 */
function ChipMenu({ anchor, onClose, label, testId, children, footer }: {
  anchor: RefObject<HTMLElement | null>; onClose(): void; label: string; testId: string; children: ReactNode; footer?: ReactNode
}): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const place = useCallback((): void => {
    const a = anchor.current?.getBoundingClientRect()
    const m = box.current
    if (!a || !m) return
    const h = m.offsetHeight
    const w = m.offsetWidth
    const gap = 6
    const below = window.innerHeight - a.bottom - gap - 8
    const above = a.top - gap - 8
    const down = h <= below || below >= above
    const maxHeight = Math.max(160, down ? below : above)
    const top = down ? a.bottom + gap : Math.max(8, a.top - gap - Math.min(h, maxHeight))
    const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8))
    setPos({ top, left, maxHeight })
  }, [anchor])
  useLayoutEffect(() => { place() }, [place, children])
  useEffect(() => {
    window.addEventListener('resize', place)
    const down = (e: MouseEvent): void => {
      const n = e.target as Node
      if (box.current?.contains(n) || anchor.current?.contains(n)) return
      onClose()
    }
    document.addEventListener('mousedown', down, true)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('mousedown', down, true) }
  }, [place, onClose, anchor])
  // Фокус — на отмеченный пункт (или первый), когда меню уже стоит на месте (скрытое фокус не берёт): ↑/↓ сразу ходят.
  const focused = useRef(false)
  useEffect(() => {
    if (!pos || focused.current) return
    focused.current = true
    const items = box.current?.querySelectorAll<HTMLElement>('[data-mi]:not([aria-disabled="true"])')
    const checked = box.current?.querySelector<HTMLElement>('[data-mi][aria-checked="true"]')
    ;(checked ?? items?.[0])?.focus()
  }, [pos])
  // Esc закрывает меню, где бы ни был фокус, — раньше горячих клавиш окна (там Esc убрал бы пустой черновик).
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onClose])
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]:not([aria-disabled="true"])') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
      next?.focus()
      return
    }
    // ↵ выбирает пункт (кнопка сама) и дальше не идёт: ни в поле, ни в горячие клавиши окна.
    if (e.key === 'Enter') e.stopPropagation()
  }
  return (
    <div ref={box} className="dmenu" role="menu" aria-label={label} data-testid={testId} onKeyDown={onKey}
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}>
      {children}
      {footer && <div className="dmenu-foot">{footer}</div>}
    </div>
  )
}

function MenuItem({ label, note, checked, danger, disabled, onSelect, testId, right, value }: {
  label: ReactNode; note?: ReactNode; checked?: boolean; danger?: boolean; disabled?: boolean; onSelect(): void; testId: string; right?: ReactNode; value?: string
}): ReactElement {
  return (
    <button type="button" role="menuitemradio" data-mi="1" aria-checked={!!checked} aria-disabled={disabled ? 'true' : undefined}
      className={`dmi${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`} data-testid={testId} data-value={value}
      onClick={() => { if (!disabled) onSelect() }}>
      <span className="ck" aria-hidden="true">{checked ? <Icon name="check" /> : null}</span>
      <span className="l">{label}</span>
      <span className="r">{right}</span>
      {note ? <span className="d">{note}</span> : null}
    </button>
  )
}

function Toggle({ on }: { on: boolean }): ReactElement {
  return <span className={`dtoggle${on ? ' on' : ''}`} aria-hidden="true" />
}

export function DraftView(p: DraftViewProps): ReactElement {
  const d = p.draft
  const general = d.scope === 'general'
  const textRef = useRef(d.text); textRef.current = d.text
  const [dictating, setDictating] = useState(false)
  const [menu, setMenu] = useState<MenuKind | null>(p.initialMenu ?? null)
  const firstReset = useRef(p.menuReset)
  const box = useRef<HTMLTextAreaElement>(null)
  const refs = {
    folder: useRef<HTMLButtonElement>(null), model: useRef<HTMLButtonElement>(null), effort: useRef<HTMLButtonElement>(null),
    access: useRef<HTMLButtonElement>(null), speed: useRef<HTMLButtonElement>(null), more: useRef<HTMLButtonElement>(null),
  }
  const inheritMode = p.env.inheritMode
  const consent = p.env.consent
  const folderInfo = d.cwd && p.env.folder?.cwd === d.cwd ? p.env.folder : null
  const readiness = readinessOf(p.catalog, d.provider, p.checking, p.now)
  const full = draftFull(d, inheritMode)
  const [attachSession] = useState(() => draftAttachmentSession(d.id))
  // Вложения живут в хранилище окна под ключом черновика (ревью Codex 11): уйти в чат и вернуться — карточки на месте.
  const files = useAttachments({ source: p.filePaths, box, text: d.text, setText: (v) => p.onText(v), session: attachSession, persist: true })
  const restoredFiles = useRef(false)
  useEffect(() => {
    if (restoredFiles.current) return
    restoredFiles.current = true
    if (!files.items.length && d.attachments?.length) files.restore(d.attachments)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const filesKey = files.items.map((x) => x.path).join('\n')
  const reportedKey = useRef((d.attachments ?? []).map((x) => x.path).join('\n'))
  useEffect(() => {
    if (filesKey === reportedKey.current) return
    reportedKey.current = filesKey
    p.onAttachments?.(files.items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey])
  useEffect(() => { if (p.menuReset !== firstReset.current) { firstReset.current = p.menuReset; setMenu(null) } }, [p.menuReset])
  // Черновик из ссылки: первую секунду отправка заперта — Enter, нажатый в другом приложении за миг до того, как окно
  // всплыло, не заведёт чат (§3.1, B3).
  const [armedAt] = useState(() => Date.now() + (d.origin.kind === 'link' ? LINK_SUBMIT_DELAY_MS : 0))
  const [, tick] = useState(0)
  const linkLocked = Date.now() < armedAt
  useEffect(() => {
    if (!linkLocked) return
    const timer = window.setTimeout(() => tick((n) => n + 1), Math.max(0, armedAt - Date.now()) + 10)
    return () => window.clearTimeout(timer)
  }, [linkLocked, armedAt])

  // Фокус в поле сразу (⌘N → печатай → ↵); черновик из ссылки фокус не берёт.
  useEffect(() => { if (!p.noAutoFocus) box.current?.focus() }, [d.id, p.noAutoFocus])
  // Поле растёт по тексту до предела, дальше — прокрутка (позиция поля при этом не сдвигается: растёт вниз).
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(240, Math.max(78, el.scrollHeight + 2))}px`
  }, [d.text])

  // Меню закрылось — фокус в поле, если пункт не открыл диалог (согласие держит фокус на «Оставить как было»).
  const closeMenu = useCallback((): void => {
    setMenu(null)
    requestAnimationFrame(() => { if (!document.querySelector('[aria-modal="true"]')) box.current?.focus() })
  }, [])
  const toggle = (m: MenuKind): void => setMenu((cur) => (cur === m ? null : m))

  const refusal = folderInfo?.refusal && !(folderInfo.refusal === 'covers_pult_home' && d.worktree) ? folderInfo.refusal : null
  const branchErr = d.worktree ? branchError(d.branch) : null
  const blocked = !p.online || p.foreign || !!refusal || !!branchErr || readinessBlocks(readiness) || files.pending > 0
  const hasText = !!d.text.trim() || files.items.length > 0
  const empty = draftEmpty(d, files.items.length)
  const send = (): void => {
    if (dictating) return
    const decision = submitDecision({ composing: false, repeat: false, busy: p.sending, linkLocked: Date.now() < armedAt, hasFolder: !!d.cwd, scope: d.scope, hasText, blocked })
    if (decision === 'folder') { setMenu('folder'); return }
    if (decision !== 'send') return
    if (readiness === 'stale') p.onCheckProviders()
    p.onSend(files.items.length ? { count: files.items.length, finalize: (name) => files.finalize(name) } : null)
  }
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      const what = escDecision({ menuOpen: menu !== null, dialogOpen: false, empty })
      if (what === 'menu') { e.preventDefault(); e.stopPropagation(); closeMenu() }
      // Пустой черновик — Esc убирает его (дальше обработает окно); с текстом Esc ничего не делает и в окно не идёт.
      else if (what !== 'discard') { e.preventDefault(); e.stopPropagation() }
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return
    // Набор IME сам пользуется Enter: клавиша не наша (защита как в Conversation).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    e.stopPropagation()
    const decision = submitDecision({ composing: false, repeat: e.repeat, busy: p.sending, linkLocked: Date.now() < armedAt, hasFolder: !!d.cwd, scope: d.scope, hasText, blocked })
    if (decision === 'folder') setMenu('folder')
    else if (decision === 'send') send()
  }

  // ⌘⇧I/⌘⇧E/⌘⇧M — меню модели, усилия, доступа; ⌘⇧O — меню папки; ⌘O — системный выбор папки (§3.5).
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keysRef.current = (e) => {
    if (p.obstructed || p.sending) return
    const cmd = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (!cmd || e.altKey) return
    const code = e.code ?? ''
    if (!e.shiftKey && code === 'KeyO') { e.preventDefault(); setMenu(null); p.onPickSystemFolder(); return }
    if (!e.shiftKey) return
    const m: MenuKind | null = code === 'KeyI' ? 'model' : code === 'KeyE' ? (d.provider === 'zcode' ? null : 'effort') : code === 'KeyM' ? 'access' : code === 'KeyO' ? 'folder' : null
    if (!m) return
    e.preventDefault()
    setMenu((cur) => (cur === m ? null : m))
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keysRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Папку можно перетащить в окно (кроме поля: туда файлы встают вложениями).
  const [folderOver, setFolderOver] = useState(false)
  const [dropHint, setDropHint] = useState<string | null>(null)
  const inBox = (e: DragEvent<HTMLElement>): boolean => !!box.current?.contains(e.target as Node)
  const over = (e: DragEvent<HTMLDivElement>): void => {
    if (inBox(e) || !p.filePaths || !hasFiles(e.dataTransfer.types)) { if (folderOver) setFolderOver(false); return }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!folderOver) setFolderOver(true)
  }
  const drag = {
    onDragEnter: over, onDragOver: over,
    onDragLeave: (e: DragEvent<HTMLDivElement>): void => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFolderOver(false) },
    onDrop: (e: DragEvent<HTMLDivElement>): void => {
      setFolderOver(false)
      if (inBox(e) || !p.filePaths || !e.dataTransfer.files.length) return
      e.preventDefault()
      void folderFromDrop(e.dataTransfer, p.filePaths).then((r) => {
        if (r.kind === 'folder') { setDropHint(null); p.onFolder(r.path) }
        else if (r.kind === 'files') setDropHint(t('Сюда — одну папку. Файлы перетащи в поле: они встанут вложениями.'))
      })
    },
  }

  // --- меню ----------------------------------------------------------------------------------------------------
  const pickFolderRow = (cwd: string): void => { closeMenu(); p.onFolder(cwd) }
  const folderRows = (): Array<{ path: string; note: string }> => {
    const seen = new Set<string>()
    const out: Array<{ path: string; note: string }> = []
    for (const path of p.projects) { if (!seen.has(path)) { seen.add(path); out.push({ path, note: shortPath(path, 60) }) } }
    for (const f of p.recent ?? []) {
      if (seen.has(f.path)) continue
      seen.add(f.path)
      out.push({ path: f.path, note: shortPath(f.path, 60) })
    }
    return out.slice(0, 12)
  }
  const folderMenu = (
    <ChipMenu anchor={refs.folder} onClose={closeMenu} label={t('Папка')} testId="draft-menu-folder"
      footer={<span>{t('Можно перетащить папку в окно')}</span>}>
      <MenuItem testId="draft-folder-general" label={t('Без проекта')} checked={general} onSelect={() => { closeMenu(); p.onFolder(null) }} />
      <div className="dmsep" />
      {folderRows().length > 0 && <div className="dmh" role="presentation">{t('Проекты и недавние')}</div>}
      {folderRows().map((f) => (
        <MenuItem key={f.path} testId="draft-folder-item" value={f.path} label={<b>{folderName(f.path)}</b>} note={f.note}
          checked={d.cwd === f.path} onSelect={() => pickFolderRow(f.path)} />
      ))}
      <div className="dmsep" />
      <MenuItem testId="draft-folder-other" label={t('Другая папка…')} onSelect={() => { setMenu(null); p.onPickSystemFolder() }} />
    </ChipMenu>
  )

  const modelRows = (prov: AgentProvider): ReactElement[] => {
    if (prov === 'claude') {
      return providerPreset('claude', null, null).models.map((m) => (
        <MenuItem key={m} testId="draft-model-item" value={`claude:${m}`} label={<b>{m}</b>} note={claudeModelNote(m)}
          checked={d.provider === 'claude' && d.model === m} onSelect={() => { closeMenu(); p.onChange(pickModel(d, 'claude', m, p.env, p.catalog)) }} />
      ))
    }
    if (prov === 'codex') {
      const list = p.catalog?.codex.models ?? []
      const rows = [
        <MenuItem key="default" testId="draft-model-item" value="codex:" label={<b>{t('по умолчанию Codex')}</b>} note={t('модель из твоего config.toml')}
          checked={d.provider === 'codex' && !d.model} onSelect={() => { closeMenu(); p.onChange(pickModel(d, 'codex', null, p.env, p.catalog)) }} />,
        ...list.map((m) => (
          <MenuItem key={m.id} testId="draft-model-item" value={`codex:${m.id}`} label={<b>{m.label}</b>} note={m.isDefault ? t('по умолчанию в Codex') : m.id}
            checked={d.provider === 'codex' && d.model === m.id} onSelect={() => { closeMenu(); p.onChange(pickModel(d, 'codex', m.id, p.env, p.catalog)) }} />
        )),
      ]
      if (d.provider === 'codex' && d.model && !list.some((m) => m.id === d.model)) {
        rows.push(<MenuItem key="unlisted" testId="draft-model-item" value={`codex:${d.model}`} label={<b>{d.model}</b>} note={t('нет в списке — ID сохранён как есть')} checked onSelect={closeMenu} />)
      }
      return rows
    }
    return [<MenuItem key="glm" testId="draft-model-item" value="zcode:" label={<b>GLM</b>} note={t('модель и усилие задаёт аккаунт Z.AI')}
      checked={d.provider === 'zcode'} onSelect={() => { closeMenu(); p.onChange(pickModel(d, 'zcode', null, p.env, p.catalog)) }} />]
  }
  const modelMenu = (
    <ChipMenu anchor={refs.model} onClose={closeMenu} label={t('Модель')} testId="draft-menu-model"
      footer={<span>{t('Список Codex — из твоего Codex CLI')}</span>}>
      {(['claude', 'codex', 'zcode'] as const).map((prov, i) => {
        const r = readinessOf(p.catalog, prov, p.checking, p.now)
        return (
          <div key={prov} className="dmgroup">
            {i > 0 && <div className="dmsep" />}
            <div className="dmh" role="presentation">{PROVIDER_NAME[prov]}<span className={`rd rd-${r}`} data-testid={`draft-readiness-${prov}`}>● {r === 'catalog-error' && prov !== 'codex' ? t('вход не проверен') : readinessWords(r)}</span></div>
            {modelRows(prov)}
          </div>
        )
      })}
    </ChipMenu>
  )

  const preset = providerPreset(d.provider, d.model, p.catalog)
  const effortMenu = (
    <ChipMenu anchor={refs.effort} onClose={closeMenu} label={t('Усилие')} testId="draft-menu-effort"
      footer={<span>{t('Выше усилие — дольше и дороже ход')}</span>}>
      <div className="dmh" role="presentation">{t('Усилие')}{d.model ? ` · ${d.model}` : ''}</div>
      {preset.efforts.map((e) => (
        <MenuItem key={e} testId="draft-effort-item" value={e} label={e} checked={d.effort === e}
          onSelect={() => { closeMenu(); p.onChange(pickEffort(d, e)) }} />
      ))}
    </ChipMenu>
  )

  const folderLabel = d.cwd ? folderName(d.cwd) : t('папки')
  // Текст «запомню» — по тому, что на самом деле уйдёт в память (ревью Codex 14): явный выбор, не «Только этот чат»,
  // не полный из ссылки. Сейчас уровень из памяти или умолчаний — так и сказано.
  const remembers = remembersAccess(d, inheritMode)
  const linkFull = d.origin.kind === 'link' && full
  const rememberLine = d.chatOnly ? t('Только этот чат — память папки не трогаю')
    : linkFull ? t('Полный из ссылки — только этому чату, в память не пишу')
    : remembers ? t`Запишу для ${folderLabel} при отправке`
    : d.approvalOrigin === 'folder' ? t`Сейчас — из памяти ${folderLabel}; выбор здесь запомню`
    : t`Сейчас — по умолчанию; выбор здесь запомню для ${folderLabel}`
  const accessMenu = (
    <ChipMenu anchor={refs.access} onClose={closeMenu} label={t('Доступ агента')} testId="draft-menu-access"
      footer={<span data-testid="draft-access-footer">{rememberLine}</span>}>
      <div className="dmh" role="presentation">{t('Доступ агента')} · {PROVIDER_NAME[d.provider]}</div>
      {approvalLevels(d.provider).map((a) => {
        const isFull = a === 'full' || (a === 'inherit' && inheritMode === 'bypassPermissions')
        const ask = isFull && !consentGrants(consent, d.provider) ? t(' · спрошу один раз') : ''
        return (
          <div key={a}>
            {a === 'inherit' && <div className="dmsep" />}
            <MenuItem testId="draft-access-item" value={a} label={isFull ? <b>{APPROVAL_LABEL[a]}</b> : APPROVAL_LABEL[a]}
              note={`${approvalHint(d.provider, a, inheritMode)}${ask}`} checked={d.approval === a} danger={isFull}
              onSelect={() => { closeMenu(); p.onApproval(a) }} />
          </div>
        )
      })}
      <div className="dmsep" />
      <button type="button" role="menuitemcheckbox" data-mi="1" aria-checked={d.chatOnly} className="dmi" data-testid="draft-access-chat-only"
        onClick={() => p.onChange({ ...d, chatOnly: !d.chatOnly })}>
        <span className="ck" aria-hidden="true"><Icon name="pin" /></span>
        <span className="l">{t('Только этот чат')}</span>
        <span className="r"><Toggle on={d.chatOnly} /></span>
        <span className="d">{d.chatOnly ? t`память ${folderLabel} не трогаю` : d.origin.kind === 'link' ? t`иначе запомню для ${folderLabel} — кроме полного доступа` : t`иначе запомню для ${folderLabel} — и чтение тоже`}</span>
      </button>
    </ChipMenu>
  )

  const speedMenu = (
    <ChipMenu anchor={refs.speed} onClose={closeMenu} label={t('Скорость')} testId="draft-menu-speed"
      footer={<span>{t('Доступность и расход зависят от модели и тарифа.')}</span>}>
      <MenuItem testId="draft-speed-normal" label="Normal" checked={d.serviceTier !== 'fast'} onSelect={() => { closeMenu(); p.onChange({ ...d, serviceTier: 'default' }) }} />
      <MenuItem testId="draft-speed-fast" label="Fast" checked={d.serviceTier === 'fast'} onSelect={() => { closeMenu(); p.onChange({ ...d, serviceTier: 'fast' }) }} />
    </ChipMenu>
  )

  const browserOff = approvalBlocksBrowser(d.provider, d.approval)
  const browserReason = d.provider === 'zcode' ? t('у ZCode браузера для агента нет')
    : full ? t('в полном доступе выключен') : d.provider === 'codex' && d.approval === 'workspace' ? t('у Codex в «Правки в папке» выключен') : null
  const moreMenu = (
    <ChipMenu anchor={refs.more} onClose={closeMenu} label={t('Ещё: ветка, браузер')} testId="draft-menu-more"
      footer={<span>{t('Включённое появится чипом под полем')}</span>}>
      <div className="dmh" role="presentation">{t('Редкое')}</div>
      <button type="button" role="menuitemcheckbox" data-mi="1" aria-checked={d.worktree} aria-disabled={general ? 'true' : undefined} className={`dmi${general ? ' disabled' : ''}`} data-testid="draft-more-worktree"
        onClick={() => { if (!general) p.onChange(toggleWorktree(d, !d.worktree)) }}>
        <span className="ck" aria-hidden="true"><Icon name="branch" /></span>
        <span className="l">{t('Отдельная ветка (worktree)')}</span>
        <span className="r"><Toggle on={d.worktree} /></span>
        <span className="d">{general ? t('Для отдельной ветки выбери проект.') : t('своя копия репозитория, основная папка не тронута')}</span>
      </button>
      {d.worktree && (
        <div className="dmi-input">
          <input className="mono" value={d.branch} placeholder={t('pult/<имя чата>')} aria-label={t('Имя ветки')} data-testid="draft-branch"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); closeMenu() } }}
            onChange={(e) => p.onChange({ ...d, branch: e.target.value })} />
          {branchErr && <span className="bad">{branchErr}</span>}
        </div>
      )}
      <button type="button" role="menuitemcheckbox" data-mi="1" aria-checked={d.browser} aria-disabled={browserOff ? 'true' : undefined}
        className={`dmi${browserOff ? ' disabled' : ''}`} data-testid="draft-more-browser"
        onClick={() => { if (!browserOff) p.onChange(toggleBrowser(d, !d.browser)) }}>
        <span className="ck" aria-hidden="true"><Icon name="globe" /></span>
        <span className="l">{t('Встроенный браузер Пульта')}</span>
        <span className="r"><Toggle on={d.browser} /></span>
        <span className="d">{browserReason ?? t('свой профиль, каждый вызов — через Inbox')}</span>
      </button>
      {d.browser && (
        <button type="button" role="menuitemcheckbox" data-mi="1" aria-checked={d.browserHeaded} className="dmi" data-testid="draft-more-headed"
          onClick={() => p.onChange(toggleBrowser(d, true, !d.browserHeaded))}>
          <span className="ck" />
          <span className="l">{t('Показывать окно браузера')}</span>
          <span className="r"><Toggle on={d.browserHeaded} /></span>
        </button>
      )}
    </ChipMenu>
  )

  // --- строки под полем ----------------------------------------------------------------------------------------
  const notes: Array<{ tone: 'ok' | 'warn' | 'fail' | 'plain'; text: ReactNode; testId: string }> = []
  const fname = d.cwd ? folderName(d.cwd) : ''
  if (d.origin.kind === 'link' && d.origin.pathRejected && !d.cwd) notes.push({ tone: 'warn', testId: 'draft-link-path-rejected', text: t('Папка из ссылки не из твоих проектов — выбери сам.') })
  if (refusal === 'missing') notes.push({ tone: 'fail', testId: 'draft-folder-missing', text: t('Папки больше нет — выбери другую. Текст останется.') })
  if (refusal === 'covers_pult_home') notes.push({ tone: 'fail', testId: 'draft-folder-home', text: t`Здесь нельзя: внутри лежит ${folderInfo?.home ? shortPath(folderInfo.home) : '~/.pult'} — возьми папку проекта (или отдельную ветку в ⋯).` })
  if (folderInfo?.folder?.changed) notes.push({ tone: 'warn', testId: 'draft-folder-changed', text: t`Папка ${fname} изменилась — запомненный доступ сброшен.` })
  if (d.notes.includes('link-full-blocked')) {
    notes.push({ tone: 'warn', testId: 'draft-link-full', text: <>{t`Для ${fname} запомнен полный доступ, но черновик из ссылки его не включает. `}<button type="button" className="link-btn" data-testid="draft-link-full-enable" onClick={() => p.onApproval(d.blockedApproval ?? 'full')}>{t('Включить для этого чата')}</button></> })
  }
  if (d.notes.includes('full-revoked')) {
    notes.push({ tone: 'warn', testId: 'draft-full-revoked', text: <>{t`Для ${fname || t('этой папки')} был полный доступ, но разрешение отозвано — стоит «Спрашивать». `}<button type="button" className="link-btn" data-testid="draft-full-enable" onClick={() => p.onApproval(d.blockedApproval ?? 'full')}>{t('Включить снова')}</button></> })
  }
  if (d.notes.includes('browser-off')) notes.push({ tone: 'warn', testId: 'draft-browser-off', text: t('Встроенный браузер Пульта выключен: в этом доступе он не работает.') })
  if (readiness === 'login-required' || readiness === 'unavailable') {
    const fix = p.catalog?.[d.provider].fixCmd
    notes.push({ tone: 'fail', testId: 'draft-readiness', text: <>{readiness === 'login-required' ? t`${PROVIDER_NAME[d.provider]}: не выполнен вход` : t`${PROVIDER_NAME[d.provider]}: CLI не запускается`}{fix ? <> — <code>{fix}</code></> : null} · <button type="button" className="link-btn" onClick={p.onCheckProviders} data-testid="draft-readiness-check">{t('Проверить')}</button></> })
  }
  // Список моделей грузится только у Codex; у Claude и ZCode «ошибка проверки» — не повод пугать строкой под полем.
  if (readiness === 'catalog-error' && d.provider === 'codex') notes.push({ tone: 'warn', testId: 'draft-readiness', text: t`${PROVIDER_NAME[d.provider]}: список моделей не загрузился — отправлю с выбранной моделью как есть.` })
  if (modelUnlisted(d, p.catalog)) notes.push({ tone: 'warn', testId: 'draft-model-unlisted', text: t`Модели ${d.model ?? ''} нет в списке Codex — ID сохранён без замены; если Codex откажет, выбери другую.` })
  if (p.foreign) notes.push({ tone: 'warn', testId: 'draft-foreign', text: <>{t('Черновик открыт в другом окне. ')}<button type="button" className="link-btn" onClick={p.onClaim} data-testid="draft-claim">{t('Забрать')}</button></> })
  if (!p.online) notes.push({ tone: 'warn', testId: 'draft-offline', text: t('Демон не на связи — черновик сохранится, отправить можно будет, когда он вернётся.') })
  if (dropHint) notes.push({ tone: 'plain', testId: 'draft-drop-hint', text: dropHint })
  if (files.notice) notes.push({ tone: 'warn', testId: 'draft-paste-notice', text: files.notice })
  if (p.error) {
    const er = p.error
    notes.push({ tone: er.retry ? 'fail' : 'warn', testId: 'draft-error', text: <>{er.text}
      {er.retry ? <> · <button type="button" className="link-btn" onClick={send} data-testid="draft-retry">{t('Повторить')}</button></> : null}
      {er.restoreText !== undefined ? <> · <button type="button" className="link-btn" onClick={() => p.onRestoreText?.(er.restoreText as string)} data-testid="draft-restore-text">{t('Вернуть мой текст')}</button></> : null}
      {er.openChat ? <> · <button type="button" className="link-btn" onClick={() => p.onOpenChat?.(er.openChat as string)} data-testid="draft-open-chat">{t('Открыть чат')}</button></> : null}
      {er.fork ? <> · <button type="button" className="link-btn" onClick={() => p.onFork?.()} data-testid="draft-fork">{er.openChat ? t('Завести новый') : t('Оставить копию')}</button></> : null}</> })
  }
  const stats = linkPromptStats(d)
  if (stats) notes.push({ tone: 'plain', testId: 'draft-prompt-stats', text: t`Текст из ссылки: ${stats.lines} ${plural(stats.lines, t('строка'), t('строки'), t('строк'))} · ${stats.chars} ${plural(stats.chars, t('знак'), t('знака'), t('знаков'))} — прокрути поле, прежде чем отправлять.` })

  const unlisted = modelUnlisted(d, p.catalog)
  const modelLabel = d.provider === 'zcode' ? 'GLM' : d.model ?? t('по умолчанию')
  const access = accessChipLabel(d, inheritMode)
  const noFolder = !d.cwd

  return (
    <section className="conv draft-view" aria-label={t('Новый чат')} data-testid="draft" data-draft={d.id} {...drag} data-drop={folderOver ? '1' : undefined}>
      <header className="conv-head">
        <div className="conv-title"><div className="top">
          <h2 className="draft-title" data-testid="draft-title">{t('Новый чат')}</h2>
          <button ref={refs.folder} type="button" className={`dchip fold draft-scope${refusal ? ' danger' : noFolder && !general ? ' warn' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'folder'}
            disabled={p.sending} data-testid="draft-chip-folder" data-path={d.cwd ?? ''} title={d.cwd ?? t('Без проекта')} aria-label={t('Проект разговора')} onClick={() => toggle('folder')}>
            <Icon name={general ? 'model' : 'folder'} /><span className="txt">{general ? t('Без проекта') : noFolder ? t('Выбери папку') : fname}</span><Icon name="chevd" className="ic chev" />
          </button>
          {d.origin.kind === 'link' && <span className="draft-pill link" data-testid="draft-from-link"><Icon name="info" />{t('из ссылки')}</span>}
        </div>
        {d.origin.kind === 'link' && d.cwd && <div className="conv-location draft-link-location" data-testid="draft-location"><Icon name="folder" />{d.cwd}</div>}
        </div>
        {p.headerActions && <div className="draft-header-actions">{p.headerActions}</div>}
      </header>
      <div className="draft-wrap">
        <div className="draft-col">
          <div className="draft-intro">
            <h1 className="draft-h" data-testid="draft-heading">{general ? t('О чём поговорим?') : noFolder ? t('Выбери проект') : <>{t('Что делаем в ')}<span className="fold">{fname}</span>?</>}</h1>
            <p className="draft-sub">{general ? t('Вопрос, идея или черновик — можно начать без проекта.') : noFolder ? t('Папку можно выбрать в заголовке.') : t('Напиши задачу ниже.')}</p>
          </div>
          <div className="draft-compose">
            <div className={`draft-box${full ? ' full' : ''}${files.over ? ' attachment-over' : ''}`} data-access-full={full ? '1' : undefined}>
              <AttachmentStrip items={files.items} previews={files.previews} pending={files.pending} onRemove={files.remove} />
              <textarea ref={box} rows={3} value={d.text} data-testid="draft-input" aria-label={t('Первая реплика нового чата')}
                placeholder={general ? t('Напиши сообщение…') : t('Опиши задачу')}
                readOnly={p.sending}
                onChange={(e) => p.onText(e.target.value)} onKeyDown={onKey}
                onPaste={files.onPaste} onDragEnter={files.onDragEnter} onDragOver={files.onDragOver} onDragLeave={files.onDragLeave} onDrop={files.onDrop} />
              <div className="draft-tb">
                {files.enabled && <AttachButton disabled={p.sending || files.pending > 0} onFiles={files.addFiles} />}
                <div className="dchips" data-testid="draft-chips" inert={p.sending}>
                  <button ref={refs.model} type="button" className={`dchip${unlisted ? ' warn' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'model'}
                    data-testid="draft-chip-model" data-provider={d.provider} data-model={d.model ?? ''} title={t('Модель')} onClick={() => toggle('model')}>
                    <ProviderIcon provider={d.provider} /><span className="txt">{modelLabel}</span>{unlisted ? <span className="dim">{t(' · нет в списке')}</span> : null}<Icon name="chevd" className="ic chev" />
                  </button>
                  {d.provider !== 'zcode' && (
                    <button ref={refs.effort} type="button" className="dchip" aria-haspopup="menu" aria-expanded={menu === 'effort'}
                      data-testid="draft-chip-effort" data-effort={d.effort} title={t('Усилие')} aria-label={t`Усилие: ${d.effort || t('по умолчанию')}`} onClick={() => toggle('effort')}>
                      <Icon name="gauge" /><span className="draft-control-label">{d.effort || t('по умолчанию')}</span><Icon name="chevd" className="ic chev" />
                    </button>
                  )}
                  <button ref={refs.access} type="button" className={`dchip${full ? ' danger' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'access'}
                    data-testid="draft-chip-access" data-approval={d.approval} title={t('Доступ агента')} aria-label={t`Доступ: ${access}`} onClick={() => toggle('access')}>
                    <Icon name="shield" /><span className="txt draft-control-label">{access}</span>{d.chatOnly ? <span className="dim">{t(' · этот чат')}</span> : null}<Icon name="chevd" className="ic chev" />
                  </button>
                  {d.provider === 'codex' && <button ref={refs.speed} type="button" className={`dchip icon-only draft-speed${d.serviceTier === 'fast' ? ' fast' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'speed'} data-testid="draft-chip-speed" title={t`Скорость: ${d.serviceTier === 'fast' ? 'Fast' : 'Normal'}`} aria-label={t`Скорость: ${d.serviceTier === 'fast' ? 'Fast' : 'Normal'}`} onClick={() => toggle('speed')}><Icon name="bolt" /></button>}
                  {d.worktree && <button type="button" className="dchip extra" data-testid="draft-chip-worktree" onClick={() => toggle('more')}><Icon name="branch" />{t('ветка ')}{d.branch.trim() || 'pult/…'}</button>}
                  {d.browser && <button type="button" className="dchip extra" data-testid="draft-chip-browser" onClick={() => toggle('more')}><Icon name="globe" />{t('браузер')}</button>}
                  <button ref={refs.more} type="button" className="dchip icon-only" aria-haspopup="menu" aria-expanded={menu === 'more'}
                    data-testid="draft-chip-more" title={t('Ещё: ветка, браузер')} aria-label={t('Ещё: ветка, браузер')} onClick={() => toggle('more')}><Icon name="more" /></button>
                </div>
                <Dictation key={d.id} disabled={p.sending || p.obstructed} onBusy={setDictating} onText={(spoken) => { p.onText(appendDictation(textRef.current, spoken)); requestAnimationFrame(() => box.current?.focus()) }} />
                <button type="button" className="btn btn-primary draft-send" data-testid="draft-send" onClick={send}
                  disabled={p.sending || dictating || linkLocked || !hasText || blocked} aria-busy={p.sending || undefined} aria-label={p.sending ? t('Завожу…') : t('Отправить')} title={p.sending ? t('Завожу…') : t('Отправить')}>
                  {p.sending ? <Icon name="clock" /> : <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>}
                </button>
              </div>
            </div>
            {notes.map((n) => <div key={n.testId} className={`inline-note ${n.tone}`} role={n.tone === 'fail' ? 'alert' : 'status'} data-testid={n.testId}><Icon name={n.tone === 'ok' ? 'check' : 'info'} /><span>{n.text}</span></div>)}

          </div>
        </div>
      </div>
      {menu === 'folder' && folderMenu}
      {menu === 'model' && modelMenu}
      {menu === 'effort' && effortMenu}
      {menu === 'access' && accessMenu}
      {menu === 'speed' && d.provider === 'codex' && speedMenu}
      {menu === 'more' && moreMenu}
    </section>
  )
}

function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles(f: File[]): void }): ReactElement {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} className="attach-picker-input" type="file" multiple data-testid="draft-attachment-picker" onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    <button type="button" className="btn attach-picker" title={t('Прикрепить файлы')} aria-label={t('Прикрепить файлы')} onClick={() => input.current?.click()} disabled={disabled}>＋</button>
  </>
}

