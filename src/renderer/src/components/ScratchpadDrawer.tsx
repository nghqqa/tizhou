import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowCounterClockwiseIcon,
  EraserIcon,
  NotePencilIcon,
  PaintBrushIcon,
  TrashIcon,
  XIcon
} from '@phosphor-icons/react'
import { evaluateQuickCalc, extractLastCalcExpression } from '../services/quick-calc'
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

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const currentStrokeRef = useRef<Stroke | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const clearedBackupRef = useRef<Stroke[]>([])

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
  }, [open, tab, onClose, undoStroke])

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

  const canUndo = strokeCount > 0 || clearedBackupCount > 0

  return (
    <aside className="scratchpad-drawer" aria-label="随手草稿纸">
      <div className="scratchpad-head">
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
