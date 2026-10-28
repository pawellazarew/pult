import { useEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactElement } from 'react'
import { clampSize } from '../model/panelSizes.js'
import { ResizeHandle } from './ResizeHandle.js'
import { usePanelBox, usePanelSize } from './WorkspaceLayout.js'

/** Diagnostics contains long paths and logs, so it benefits from more reading room. */
export function ResizableDialog({ children, className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const actual = usePanelBox(root, { width: 780, height: 500 })
  const [width, setWidth] = usePanelSize('pult.panel.doctorWidth.v1')
  const [height, setHeight] = usePanelSize('pult.panel.doctorHeight.v1')
  const [viewport, setViewport] = useState(() => typeof window === 'undefined' ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const update = (): void => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const maxWidth = viewport.width - 32, maxHeight = Math.floor(viewport.height * .86)
  const minWidth = Math.min(480, maxWidth), minHeight = Math.min(260, maxHeight)
  return <div {...props} ref={root} className={`${className ?? ''} resizable-dialog`} style={{
    width: width === null ? undefined : clampSize(width, minWidth, maxWidth),
    height: height === null ? undefined : clampSize(height, minHeight, maxHeight),
  }}>
    {children}
    <ResizeHandle label="Ширина диагностики" value={actual.width} min={minWidth} max={maxWidth} onChange={setWidth}
      onReset={() => setWidth(null)} className="dialog-width-boundary" testId="doctor-width-resize" />
    <ResizeHandle label="Высота диагностики" axis="y" value={actual.height} min={minHeight} max={maxHeight} onChange={setHeight}
      onReset={() => setHeight(null)} className="dialog-height-boundary" testId="doctor-height-resize" />
  </div>
}
