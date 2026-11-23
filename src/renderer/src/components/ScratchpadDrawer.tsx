import { useEffect, useRef, useState } from 'react'
import { EraserIcon, NotePencilIcon, PaintBrushIcon, XIcon } from '@phosphor-icons/react'

interface ScratchpadDrawerProps {
  open: boolean
  onClose: () => void
}

export function ScratchpadDrawer({
  open,
  onClose
}: ScratchpadDrawerProps): React.JSX.Element | null {
  const [tab, setTab] = useState<'draw' | 'text'>('draw')
  const [penColor, setPenColor] = useState<'ink' | 'red'>('ink')
  const [noteText, setNoteText] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open || tab !== 'draw') return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const targetW = Math.max(1, Math.round(rect.width * dpr))
    const targetH = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      // 保留已有笔迹
      const snapshot = canvas.width > 0 && canvas.height > 0 ? canvas.toDataURL() : ''
      canvas.width = targetW
      canvas.height = targetH
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
        if (snapshot) {
          const img = new Image()
          img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height)
          img.src = snapshot
        }
      }
    }
  }, [open, tab])

  if (!open) return null

  function getPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    }
  }

  function strokeColor(): string {
    if (penColor === 'red') return '#c93b31'
    const isDark = document.documentElement.dataset.theme === 'dark'
    return isDark ? '#ebe6dc' : '#262320'
  }

  function clearCurrent(): void {
    if (tab === 'text') {
      setNoteText('')
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

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
                className={`scratchpad-pen is-ink${penColor === 'ink' ? ' is-active' : ''}`}
                title="黑笔"
                aria-label="黑笔"
                onClick={() => setPenColor('ink')}
              />
              <button
                type="button"
                className={`scratchpad-pen is-red${penColor === 'red' ? ' is-active' : ''}`}
                title="红笔"
                aria-label="红笔"
                onClick={() => setPenColor('red')}
              />
            </>
          )}
          <button
            type="button"
            className="scratchpad-icon-btn"
            title="清空"
            aria-label="清空草稿纸"
            onClick={clearCurrent}
          >
            <EraserIcon size={14} />
          </button>
          <button
            type="button"
            className="scratchpad-icon-btn"
            title="关闭 (Esc)"
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
          className="scratchpad-canvas"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            drawingRef.current = true
            lastPointRef.current = getPoint(event)
          }}
          onPointerMove={(event) => {
            if (!drawingRef.current || !lastPointRef.current) return
            const canvas = canvasRef.current
            const ctx = canvas?.getContext('2d')
            if (!ctx) return
            const next = getPoint(event)
            ctx.beginPath()
            ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y)
            ctx.lineTo(next.x, next.y)
            ctx.strokeStyle = strokeColor()
            ctx.lineWidth = 2
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.stroke()
            lastPointRef.current = next
          }}
          onPointerUp={() => {
            drawingRef.current = false
            lastPointRef.current = null
          }}
          onPointerCancel={() => {
            drawingRef.current = false
            lastPointRef.current = null
          }}
        />
      ) : (
        <textarea
          className="scratchpad-textarea"
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="记录截位直除式子、选项排除标记或逻辑推理草图…"
        />
      )}
    </aside>
  )
}
