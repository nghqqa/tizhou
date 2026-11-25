import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowCounterClockwiseIcon,
  DotsSixVerticalIcon,
  EraserIcon,
  NotePencilIcon,
  PaintBrushIcon,
  TrashIcon,
  XIcon
} from '@phosphor-icons/react'
import { evaluateQuickCalc, extractLastCalcExpression } from '../services/quick-calc'
import {
  clampScratchpadPosition,
  computeDefaultScratchpadPosition,
  computeDockPosition,
  loadSavedScratchpadPosition,
  saveScratchpadPosition,
  type ScratchpadDockPreset,
  type ScratchpadPosition
} from '../services/scratchpad-position'
import { hasOpenModal } from '../services/shortcuts'

interface ScratchpadDrawerProps {
  open: boolean
  onClose: () => void
  allowCalculator?: boolean
}

interface Stroke {
  tool: 'pen' | 'eraser'
  color: 'ink' | 'red'
  points: Array<{ x: number; y: number }>
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  panelWidth: number
  panelHeight: number
  moved: boolean
  lastLeft: number
  lastTop: number
}

const DOCK_PRESETS: Array<{ id: ScratchpadDockPreset; label: string; announcement: string }> = [
  { id: 'top-left', label: '停靠左上', announcement: '草稿纸已停靠左上角' },
  { id: 'top-right', label: '停靠右上', announcement: '草稿纸已停靠右上角' },
  { id: 'bottom-left', label: '停靠左下', announcement: '草稿纸已停靠左下角' },
  { id: 'bottom-right', label: '停靠右下', announcement: '草稿纸已停靠右下角' }
]

export function ScratchpadDrawer({
  open,
  onClose,
  allowCalculator = false
}: ScratchpadDrawerProps): React.JSX.Element | null {
  const [tab, setTab] = useState<'draw' | 'text'>('draw')
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [penColor, setPenColor] = useState<'ink' | 'red'>('ink')
  const [noteText, setNoteText] = useState('')
  const [calcExpr, setCalcExpr] = useState('')
  const [strokeCount, setStrokeCount] = useState(0)
  const [clearedBackupCount, setClearedBackupCount] = useState(0)
  const [position, setPosition] = useState<ScratchpadPosition | null>(() =>
    loadSavedScratchpadPosition()
  )
  const [isDragging, setIsDragging] = useState(false)
  const [dockMenuOpen, setDockMenuOpen] = useState(false)
  const [liveAnnouncement, setLiveAnnouncement] = useState('')

  const asideRef = useRef<HTMLElement>(null)
  const dragHandleRef = useRef<HTMLButtonElement>(null)
  const dockMenuRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const suppressNextHandleClickRef = useRef(false)
  const announceTimerRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const currentStrokeRef = useRef<Stroke | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const clearedBackupRef = useRef<Stroke[]>([])

  const announce = useCallback((message: string): void => {
    setLiveAnnouncement(message)
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current)
    }
    announceTimerRef.current = window.setTimeout(() => {
      setLiveAnnouncement('')
      announceTimerRef.current = null
    }, 1200)
  }, [])

  useEffect(
    () => () => {
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current)
      }
    },
    []
  )

  const calcResult = useMemo(
    () =>
      allowCalculator && calcExpr.trim() ? evaluateQuickCalc(calcExpr) : { ok: false as const },
    [allowCalculator, calcExpr]
  )
  const noteLastCalc = useMemo(
    () => (allowCalculator && tab === 'text' ? extractLastCalcExpression(noteText) : null),
    [allowCalculator, tab, noteText]
  )

  const resolveStrokeColor = useCallback((color: 'ink' | 'red'): string => {
    if (color === 'red') return '#c93b31'
    const isDark = document.documentElement.dataset.theme === 'dark'
    return isDark ? '#ebe6dc' : '#262320'
  }, [])

  const paintStroke = useCallback(
    (ctx: CanvasRenderingContext2D, stroke: Stroke): void => {
      if (stroke.points.length === 0) return
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (stroke.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.strokeStyle = 'rgba(0,0,0,1)'
        ctx.lineWidth = 16
      } else {
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = resolveStrokeColor(stroke.color)
        ctx.lineWidth = 2
      }
      const first = stroke.points[0]!
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      if (stroke.points.length === 1) {
        ctx.lineTo(first.x + 0.01, first.y + 0.01)
      } else {
        for (let i = 1; i < stroke.points.length; i += 1) {
          const pt = stroke.points[i]!
          ctx.lineTo(pt.x, pt.y)
        }
      }
      ctx.stroke()
      ctx.restore()
    },
    [resolveStrokeColor]
  )

  const redrawCanvas = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const targetW = Math.max(1, Math.round(rect.width * dpr))
    const targetH = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const stroke of strokesRef.current) {
      paintStroke(ctx, stroke)
    }
    if (drawingRef.current && currentStrokeRef.current) {
      paintStroke(ctx, currentStrokeRef.current)
    }
  }, [paintStroke])

  const undoStroke = useCallback((): void => {
    if (tab !== 'draw') return
    if (strokesRef.current.length > 0) {
      strokesRef.current = strokesRef.current.slice(0, -1)
      setStrokeCount(strokesRef.current.length)
      redrawCanvas()
      return
    }
    if (clearedBackupRef.current.length > 0) {
      strokesRef.current = clearedBackupRef.current
      clearedBackupRef.current = []
      setStrokeCount(strokesRef.current.length)
      setClearedBackupCount(0)
      redrawCanvas()
    }
  }, [tab, redrawCanvas])

  const measurePanelSize = useCallback((): { width: number; height: number } => {
    const rect = asideRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height }
    }
    return {
      width: Math.min(440, Math.max(240, window.innerWidth - 32)),
      height: 340
    }
  }, [])

  const applyClampedPosition = useCallback(
    (next: ScratchpadPosition, message?: string): void => {
      const { width, height } = measurePanelSize()
      const clamped = clampScratchpadPosition(
        next,
        width,
        height,
        window.innerWidth,
        window.innerHeight
      )
      setPosition(clamped)
      saveScratchpadPosition(clamped)
      if (message) announce(message)
    },
    [measurePanelSize, announce]
  )

  const resetToDefaultPosition = useCallback((): void => {
    const { width, height } = measurePanelSize()
    const next = computeDefaultScratchpadPosition(
      width,
      height,
      window.innerWidth,
      window.innerHeight
    )
    setPosition(next)
    saveScratchpadPosition(next)
    setDockMenuOpen(false)
    announce('草稿纸已复位至右下角')
  }, [measurePanelSize, announce])

  useLayoutEffect(() => {
    if (!open || !position) return
    const { width, height } = measurePanelSize()
    const clamped = clampScratchpadPosition(
      position,
      width,
      height,
      window.innerWidth,
      window.innerHeight
    )
    if (clamped.left !== position.left || clamped.top !== position.top) {
      setPosition(clamped)
      saveScratchpadPosition(clamped)
    }
  }, [open, position, measurePanelSize])

  useEffect(() => {
    if (!open) {
      setDockMenuOpen(false)
      setIsDragging(false)
      dragStateRef.current = null
      if (asideRef.current) {
        asideRef.current.style.transform = ''
      }
      return
    }
    const handleResize = (): void => {
      setPosition((prev) => {
        if (!prev) return prev
        const { width, height } = measurePanelSize()
        const clamped = clampScratchpadPosition(
          prev,
          width,
          height,
          window.innerWidth,
          window.innerHeight
        )
        if (clamped.left === prev.left && clamped.top === prev.top) return prev
        saveScratchpadPosition(clamped)
        return clamped
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [open, measurePanelSize])

  useEffect(() => {
    if (!dockMenuOpen) return
    const handlePointerDownOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (
        target &&
        (dockMenuRef.current?.contains(target) || dragHandleRef.current?.contains(target))
      ) {
        return
      }
      setDockMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDownOutside)
    return () => document.removeEventListener('pointerdown', handlePointerDownOutside)
  }, [dockMenuOpen])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (hasOpenModal()) return
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Escape') {
        if (dockMenuOpen) {
          event.preventDefault()
          setDockMenuOpen(false)
          dragHandleRef.current?.focus()
          return
        }
        onClose()
        return
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey &&
        tab === 'draw' &&
        !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault()
        undoStroke()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, tab, dockMenuOpen, onClose, undoStroke])

  useEffect(() => {
    if (!open || tab !== 'draw') return
    redrawCanvas()
    const canvas = canvasRef.current
    const observer =
      canvas && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => redrawCanvas())
        : null
    if (canvas && observer) observer.observe(canvas)
    const themeObserver = new MutationObserver(() => redrawCanvas())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => {
      observer?.disconnect()
      themeObserver.disconnect()
    }
  }, [open, tab, redrawCanvas])

  if (!open) return null

  function getPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    }
  }

  function clearCurrent(): void {
    if (tab === 'text') {
      setNoteText('')
      setCalcExpr('')
      return
    }
    if (strokesRef.current.length > 0) {
      clearedBackupRef.current = strokesRef.current
      setClearedBackupCount(clearedBackupRef.current.length)
    }
    strokesRef.current = []
    setStrokeCount(0)
    redrawCanvas()
  }

  function appendCalcResultToNote(): void {
    if (!calcResult.ok) return
    const snippet = `${calcExpr.trim()} = ${calcResult.formatted}`
    setNoteText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${snippet}` : snippet))
  }

  function finishHeadDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragStateRef.current = null
    if (asideRef.current) {
      asideRef.current.style.transform = ''
    }
    setIsDragging(false)
    if (drag.moved) {
      suppressNextHandleClickRef.current = true
      window.setTimeout(() => {
        suppressNextHandleClickRef.current = false
      }, 0)
      const finalPos: ScratchpadPosition = {
        left: drag.lastLeft,
        top: drag.lastTop
      }
      setPosition(finalPos)
      saveScratchpadPosition(finalPos)
      announce('草稿纸位置已更新')
    }
  }

  function handleHeadPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target as HTMLElement | null
    const fromHandle = Boolean(target?.closest('.scratchpad-drag-handle'))
    const control = target?.closest('button, input, select, textarea, a')
    if (control && !fromHandle) return
    const aside = asideRef.current
    if (!aside) return
    const rect = aside.getBoundingClientRect()
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      panelWidth: rect.width,
      panelHeight: rect.height,
      moved: false,
      lastLeft: rect.left,
      lastTop: rect.top
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleHeadPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) {
      drag.moved = true
      setIsDragging(true)
      setDockMenuOpen(false)
    }
    const clamped = clampScratchpadPosition(
      { left: drag.originLeft + dx, top: drag.originTop + dy },
      drag.panelWidth,
      drag.panelHeight,
      window.innerWidth,
      window.innerHeight
    )
    drag.lastLeft = clamped.left
    drag.lastTop = clamped.top
    if (asideRef.current) {
      asideRef.current.style.transform = `translate3d(${clamped.left - drag.originLeft}px, ${clamped.top - drag.originTop}px, 0)`
    }
  }

  function handleHeadDoubleClick(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement | null
    const fromHandle = Boolean(target?.closest('.scratchpad-drag-handle'))
    const control = target?.closest('button, input, select, textarea, a')
    if (control && !fromHandle) return
    resetToDefaultPosition()
  }

  function handleHandleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const step = event.shiftKey ? 48 : 20
    let dx = 0
    let dy = 0
    let dirLabel = ''
    if (event.key === 'ArrowLeft') {
      dx = -step
      dirLabel = '草稿纸已向左移动'
    } else if (event.key === 'ArrowRight') {
      dx = step
      dirLabel = '草稿纸已向右移动'
    } else if (event.key === 'ArrowUp') {
      dy = -step
      dirLabel = '草稿纸已向上移动'
    } else if (event.key === 'ArrowDown') {
      dy = step
      dirLabel = '草稿纸已向下移动'
    } else if (event.key === 'Home') {
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent.stopPropagation()
      resetToDefaultPosition()
      return
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopPropagation()
    const rect = asideRef.current?.getBoundingClientRect()
    const base =
      position ??
      (rect
        ? { left: rect.left, top: rect.top }
        : computeDefaultScratchpadPosition(440, 340, window.innerWidth, window.innerHeight))
    applyClampedPosition({ left: base.left + dx, top: base.top + dy }, dirLabel)
  }

  function applyDock(preset: ScratchpadDockPreset, announcement: string): void {
    const { width, height } = measurePanelSize()
    const next = computeDockPosition(preset, width, height, window.innerWidth, window.innerHeight)
    setPosition(next)
    saveScratchpadPosition(next)
    setDockMenuOpen(false)
    announce(announcement)
  }

  const canUndo = strokeCount > 0 || clearedBackupCount > 0
  const drawerStyle: React.CSSProperties | undefined = position
    ? {
        left: `${position.left}px`,
        top: `${position.top}px`,
        right: 'auto',
        bottom: 'auto'
      }
    : undefined

  return (
    <aside
      ref={asideRef}
      className={`scratchpad-drawer${isDragging ? ' is-dragging' : ''}`}
      style={drawerStyle}
      aria-label="随手草稿纸"
    >
      <div className="scratchpad-sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>
      <div
        className="scratchpad-head"
        onPointerDown={handleHeadPointerDown}
        onPointerMove={handleHeadPointerMove}
        onPointerUp={finishHeadDrag}
        onPointerCancel={finishHeadDrag}
        onLostPointerCapture={finishHeadDrag}
        onDoubleClick={handleHeadDoubleClick}
      >
        <div className="scratchpad-head-left">
          <button
            ref={dragHandleRef}
            type="button"
            className="scratchpad-drag-handle"
            aria-label="拖动草稿纸。点击打开停靠菜单，聚焦后可用方向键移动位置，双击复位右下角"
            aria-haspopup="menu"
            aria-expanded={dockMenuOpen}
            title="按住顶栏或此处自由拖动 · 点击选停靠位置 · 双击复位"
            onClick={() => {
              if (suppressNextHandleClickRef.current) {
                suppressNextHandleClickRef.current = false
                return
              }
              setDockMenuOpen((prev) => !prev)
            }}
            onKeyDown={handleHandleKeyDown}
          >
            <DotsSixVerticalIcon size={14} weight="bold" />
          </button>
          <div className="scratchpad-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'draw'}
              className={`scratchpad-tab${tab === 'draw' ? ' is-active' : ''}`}
              onClick={() => setTab('draw')}
            >
              <PaintBrushIcon size={13} />
              <span>手写草稿</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'text'}
              className={`scratchpad-tab${tab === 'text' ? ' is-active' : ''}`}
              onClick={() => setTab('text')}
            >
              <NotePencilIcon size={13} />
              <span>速算便签</span>
            </button>
          </div>
        </div>
        <div className="scratchpad-actions">
          {tab === 'draw' && (
            <>
              <button
                type="button"
                className={`scratchpad-pen is-ink${tool === 'pen' && penColor === 'ink' ? ' is-active' : ''}`}
                title="黑笔"
                aria-label="黑笔"
                onClick={() => {
                  setTool('pen')
                  setPenColor('ink')
                }}
              />
              <button
                type="button"
                className={`scratchpad-pen is-red${tool === 'pen' && penColor === 'red' ? ' is-active' : ''}`}
                title="红笔"
                aria-label="红笔"
                onClick={() => {
                  setTool('pen')
                  setPenColor('red')
                }}
              />
              <button
                type="button"
                className={`scratchpad-icon-btn${tool === 'eraser' ? ' is-active' : ''}`}
                title="局部橡皮擦"
                aria-label="局部橡皮擦"
                aria-pressed={tool === 'eraser'}
                onClick={() => setTool((prev) => (prev === 'eraser' ? 'pen' : 'eraser'))}
              >
                <EraserIcon size={14} />
              </button>
              <button
                type="button"
                className="scratchpad-icon-btn"
                title="撤销上一笔 (Ctrl+Z)"
                aria-label="撤销上一笔"
                disabled={!canUndo}
                onClick={undoStroke}
              >
                <ArrowCounterClockwiseIcon size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            className="scratchpad-icon-btn"
            title={tab === 'draw' ? '清空画布' : '清空便签'}
            aria-label={tab === 'draw' ? '清空画布' : '清空便签'}
            onClick={clearCurrent}
          >
            <TrashIcon size={14} />
          </button>
          <button
            type="button"
            className="scratchpad-icon-btn"
            title="收起 (S / Alt+D / Esc)"
            aria-label="关闭草稿纸"
            onClick={onClose}
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      {dockMenuOpen && (
        <div
          ref={dockMenuRef}
          className="scratchpad-dock-menu"
          role="menu"
          aria-label="草稿纸快速停靠位置"
        >
          <div className="scratchpad-dock-grid">
            {DOCK_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="menuitem"
                className="scratchpad-dock-item"
                onClick={() => applyDock(preset.id, preset.announcement)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="scratchpad-dock-hint">
            按住顶栏可任意拖动；聚焦手柄时可用方向键微调（Shift 加速），Home 复位右下角。
          </p>
        </div>
      )}

      {tab === 'draw' ? (
        <canvas
          ref={canvasRef}
          className={`scratchpad-canvas${tool === 'eraser' ? ' is-eraser' : ''}`}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            const pt = getPoint(event)
            drawingRef.current = true
            currentStrokeRef.current = { tool, color: penColor, points: [pt] }
            const canvas = canvasRef.current
            const ctx = canvas?.getContext('2d')
            if (ctx) {
              const dpr = window.devicePixelRatio || 1
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
              paintStroke(ctx, currentStrokeRef.current)
            }
          }}
          onPointerMove={(event) => {
            if (!drawingRef.current || !currentStrokeRef.current) return
            const canvas = canvasRef.current
            const ctx = canvas?.getContext('2d')
            if (!ctx) return
            const prev =
              currentStrokeRef.current.points[currentStrokeRef.current.points.length - 1]!
            const next = getPoint(event)
            currentStrokeRef.current.points.push(next)
            const dpr = window.devicePixelRatio || 1
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            paintStroke(ctx, {
              tool: currentStrokeRef.current.tool,
              color: currentStrokeRef.current.color,
              points: [prev, next]
            })
          }}
          onPointerUp={() => {
            if (drawingRef.current && currentStrokeRef.current) {
              strokesRef.current = [...strokesRef.current, currentStrokeRef.current]
              clearedBackupRef.current = []
              setStrokeCount(strokesRef.current.length)
              setClearedBackupCount(0)
            }
            drawingRef.current = false
            currentStrokeRef.current = null
          }}
          onPointerCancel={() => {
            if (drawingRef.current && currentStrokeRef.current) {
              strokesRef.current = [...strokesRef.current, currentStrokeRef.current]
              clearedBackupRef.current = []
              setStrokeCount(strokesRef.current.length)
              setClearedBackupCount(0)
            }
            drawingRef.current = false
            currentStrokeRef.current = null
          }}
        />
      ) : (
        <div className="scratchpad-text-pane">
          {allowCalculator && (
            <div className="scratchpad-calc-bar">
              <input
                type="text"
                className="scratchpad-calc-input"
                value={calcExpr}
                onChange={(event) => setCalcExpr(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    appendCalcResultToNote()
                  }
                }}
                placeholder="速算求值：如 4280/(1+14.3%)"
                aria-label="速算公式输入"
              />
              {calcResult.ok ? (
                <button
                  type="button"
                  className="scratchpad-calc-result"
                  title="点击或按 Enter 将计算结果记入下方便签"
                  onClick={appendCalcResultToNote}
                >
                  = {calcResult.formatted}
                  {calcResult.percentHint ? ` (${calcResult.percentHint})` : ''}
                </button>
              ) : (
                calcExpr.trim() && <span className="scratchpad-calc-invalid">式子未完整</span>
              )}
            </div>
          )}
          <textarea
            className="scratchpad-textarea"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder={
              allowCalculator
                ? '记录截位直除式子（末尾写算式如 4280/(1+14.3%) 也会实时出参考值）、排除标记或推理草图…'
                : '记录截位直除式子、选项排除标记或逻辑推理草图…'
            }
          />
          {allowCalculator && noteLastCalc && (
            <div className="scratchpad-note-eval">
              <span>{noteLastCalc.expression}</span>
              <strong>
                = {noteLastCalc.result.formatted}
                {noteLastCalc.result.percentHint ? ` (${noteLastCalc.result.percentHint})` : ''}
              </strong>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
