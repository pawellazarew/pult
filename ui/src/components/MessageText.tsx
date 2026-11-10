import { useId, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { t } from '../lib/i18n.js'
import { Markdown } from './Markdown.js'
import { Icon } from './common.js'

/** Stop after 501 code points so a streaming answer never needs a full scan. */
export function messagePreview(text: string): string | null {
  let end = 0
  let count = 0
  for (const character of text) {
    if (count === 500) return text.slice(0, end)
    end += character.length
    count++
  }
  return null
}

export function MessageText({ text, human, streaming, expanded, onExpandedChange, renderExpanded }: {
  text: string
  human?: boolean
  streaming?: boolean
  expanded?: boolean
  onExpandedChange?(expanded: boolean): void
  renderExpanded?(): ReactNode
}): ReactElement {
  const contentId = useId()
  const [localExpanded, setLocalExpanded] = useState(false)
  const preview = useMemo(() => messagePreview(text), [text])
  const open = preview === null || (expanded ?? localExpanded)
  const toggle = (): void => {
    if (expanded === undefined) setLocalExpanded(!open)
    onExpandedChange?.(!open)
  }
  return <div className="message-text" data-testid="message-text" data-collapsed={open ? '0' : '1'}>
    <div id={contentId}>{open
      ? renderExpanded ? renderExpanded() : <Markdown text={text} human={human} streaming={streaming} />
      : <div className="message-preview">{preview}…</div>}
    </div>
    {preview !== null && <button type="button" className="btn btn-ghost btn-sm message-fold" data-testid="message-fold"
      aria-controls={contentId} aria-expanded={open} onClick={toggle}>
      <Icon name="chevd" />{open ? t('Свернуть') : t('Развернуть')}
    </button>}
  </div>
}
