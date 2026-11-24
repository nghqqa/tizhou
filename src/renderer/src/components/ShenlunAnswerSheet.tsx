import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  SHENLUN_SHEET_COLS,
  buildShenlunSheetGrid,
  type ShenlunSheetCell,
  type ShenlunSheetRow
} from '@shared/shenlun'
import type { extractWordLimit } from '../services/study-helpers'

type WordLimit = NonNullable<ReturnType<typeof extractWordLimit>>

interface ShenlunAnswerSheetProps {
  value: string
  onChange: (next: string) => void
  limit: WordLimit | null
  headerTitle?: string
  officialTypography?: boolean
  placeholder?: string
}

export function ShenlunAnswerSheet({
  value,
  onChange,
  limit,
  headerTitle = '申论作答',
  officialTypography = false,
  placeholder = '点击下方任意方格开始作答 · 支持拖动框选、Ctrl+A 批量删除 · 回车换行'
}: ShenlunAnswerSheetProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [caretTopPx, setCaretTopPx] = useState(12)
  const [caretIndex, setCaretIndex] = useState(value.length)
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: value.length,
    end: value.length
  })
  const draggingRef = useRef(false)
  const dragAnchorRef = useRef(value.length)

  // 中文输入法组合态：在选字上屏前不把拼音字母拆进方格，而是显示在光标处悬浮预览条中
  const [composing, setComposing] = useState(false)
  const [imeRawValue, setImeRawValue] = useState('')
  const [imePreviewText, setImePreviewText] = useState('')
  const preComposeValueRef = useRef(value)
  const preComposeCaretRef = useRef(value.length)

  useEffect(() => {
    const stopDrag = (): void => {
      draggingRef.current = false
    }
    window.addEventListener('mouseup', stopDrag)
    return () => window.removeEventListener('mouseup', stopDrag)
  }, [])

  const displayValue = composing ? preComposeValueRef.current : value
  const displayCaret = composing ? preComposeCaretRef.current : caretIndex

  const wordCount = value.replace(/\s/g, '').length
  const maxChars = limit?.max ?? null
  const overLimit = Boolean(limit?.max && wordCount > limit.max)
  const underLimit = Boolean(limit?.min && wordCount > 0 && wordCount < limit.min)

  const grid = useMemo(
    () => buildShenlunSheetGrid(displayValue, maxChars, displayCaret),
    [displayValue, maxChars, displayCaret]
  )

  function syncCaretFromDom(): void {
    if (composing) return
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    setCaretIndex(end)
    setSelection({ start, end })
  }

  function applySelectionRange(anchor: number, focus: number): void {
    const el = textareaRef.current
    if (!el) return
    const a = Math.max(0, Math.min(anchor, value.length))
    const f = Math.max(0, Math.min(focus, value.length))
    const start = Math.min(a, f)
    const end = Math.max(a, f)
    el.focus()
    window.requestAnimationFrame(() => {
      el.setSelectionRange(start, end)
      setCaretIndex(f)
      setSelection({ start, end })
    })
  }

  function focusAt(index: number): void {
    applySelectionRange(index, index)
  }

  function insertIndent(): void {
    const el = textareaRef.current
    const start = el ? (el.selectionStart ?? value.length) : selection.start
    const end = el ? (el.selectionEnd ?? start) : selection.end
    const indent = '\u3000\u3000'
    const next = value.slice(0, start) + indent + value.slice(end)
    onChange(next)
    focusAt(start + indent.length)
  }

  function indexFromCellEvent(
    cell: ShenlunSheetCell,
    row: ShenlunSheetRow,
    event: React.MouseEvent<HTMLDivElement>
  ): number {
    if (cell.charIndex !== null) {
      const rect = event.currentTarget.getBoundingClientRect()
      const clickRightHalf = event.clientX - rect.left > rect.width / 2
      return clickRightHalf ? cell.charIndex + 1 : cell.charIndex
    }
    return row.lineEndCharIndex
  }

  const caretLeftPct = Math.min(92, (grid.caretCol / SHENLUN_SHEET_COLS) * 100)
  const hasRangeSelection = !composing && selection.end > selection.start

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const caretEl = body.querySelector<HTMLElement>('[data-caret="true"]')
    if (!caretEl) {
      setCaretTopPx(grid.caretRow * 29 + 12)
      return
    }
    const bodyRect = body.getBoundingClientRect()
    const cellRect = caretEl.getBoundingClientRect()
    setCaretTopPx(Math.max(4, Math.round(cellRect.top - bodyRect.top + body.scrollTop)))
  }, [grid.caretRow, grid.caretCol, composing, displayValue.length, officialTypography])

  return (
    <div
      className={`shenlun-sheet${officialTypography ? ' is-official-doc' : ''}${focused ? ' is-focused' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          focusAt(value.length)
        }
      }}
    >
      <div className="shenlun-sheet-header">
        <span className="shenlun-sheet-title">{headerTitle}</span>
        <div className="shenlun-sheet-tools">
          <button
            type="button"
            className="shenlun-sheet-indent"
            title="在光标处插入段首空两格（快捷键 Tab）"
            onMouseDown={(event) => {
              event.preventDefault()
              insertIndent()
            }}
          >
            空两格
          </button>
          <span
            className={`shenlun-sheet-counter${overLimit ? ' is-over-limit' : underLimit ? ' is-under-limit' : ''}`}
            title={limit ? `已识别题干字数要求：${limit.label}` : undefined}
          >
            {limit ? `${wordCount} / ${limit.label}` : `${wordCount} 字`}
          </span>
        </div>
      </div>

      {!value && <div className="shenlun-sheet-subbar">{placeholder}</div>}

      <div
        ref={bodyRef}
        className="shenlun-sheet-body"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault()
            focusAt(value.length)
          }
        }}
      >
        <textarea
          ref={textareaRef}
          className="shenlun-sheet-input"
          data-testid="shenlun-draft-input"
          aria-label="申论作答草稿"
          value={composing ? imeRawValue : value}
          style={{
            left: `${caretLeftPct}%`,
            top: `${caretTopPx}px`
          }}
          onFocus={() => {
            setFocused(true)
            syncCaretFromDom()
          }}
          onBlur={() => {
            setFocused(false)
            draggingRef.current = false
            if (composing) {
              setComposing(false)
              setImePreviewText('')
            }
          }}
          onCompositionStart={(event) => {
            preComposeValueRef.current = value
            preComposeCaretRef.current = event.currentTarget.selectionStart ?? value.length
            setImeRawValue(value)
            setImePreviewText('')
            setComposing(true)
          }}
          onCompositionUpdate={(event) => {
            setImePreviewText(event.data ?? '')
          }}
          onCompositionEnd={(event) => {
            const committed = event.currentTarget.value
            const nextCaret = event.currentTarget.selectionStart ?? committed.length
            setComposing(false)
            setImePreviewText('')
            onChange(committed)
            setCaretIndex(nextCaret)
            setSelection({ start: nextCaret, end: nextCaret })
          }}
          onChange={(event) => {
            const nextVal = event.target.value
            if (composing || (event.nativeEvent as InputEvent).isComposing) {
              setImeRawValue(nextVal)
              return
            }
            const nextPos = event.target.selectionStart ?? nextVal.length
            onChange(nextVal)
            setCaretIndex(nextPos)
            setSelection({ start: nextPos, end: nextPos })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault()
              insertIndent()
            }
          }}
          onKeyUp={syncCaretFromDom}
          onSelect={syncCaretFromDom}
        />

        {composing && imePreviewText && (
          <div
            className="shenlun-sheet-ime-pill"
            style={{
              left: `calc(${caretLeftPct}% + 14px)`,
              top: `${Math.max(4, caretTopPx - 4)}px`
            }}
          >
            {imePreviewText}
          </div>
        )}

        <div className="shenlun-sheet-rows" role="grid" aria-label="申论方格答题卡">
          {grid.rows.map((row) => (
            <div className="shenlun-sheet-row-wrap" key={row.rowIndex}>
              <div className="shenlun-sheet-row" role="row">
                {row.cells.map((cell) => {
                  const isCaretHere =
                    focused &&
                    !hasRangeSelection &&
                    grid.caretRow === cell.row &&
                    grid.caretCol === cell.col
                  const isSelected =
                    hasRangeSelection &&
                    cell.charIndex !== null &&
                    cell.charIndex >= selection.start &&
                    cell.charIndex < selection.end
                  return (
                    <div
                      key={cell.col}
                      role="gridcell"
                      data-caret={isCaretHere ? 'true' : undefined}
                      className={[
                        'shenlun-sheet-cell',
                        cell.isLimitBoundary ? 'is-limit-boundary' : '',
                        cell.isOverLimit ? 'is-over-limit' : '',
                        isSelected ? 'is-selected' : '',
                        isCaretHere ? 'is-caret' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        const idx = indexFromCellEvent(cell, row, event)
                        if (event.shiftKey) {
                          applySelectionRange(dragAnchorRef.current, idx)
                        } else {
                          draggingRef.current = true
                          dragAnchorRef.current = idx
                          applySelectionRange(idx, idx)
                        }
                      }}
                      onMouseEnter={(event) => {
                        if (!draggingRef.current) return
                        const idx = indexFromCellEvent(cell, row, event)
                        applySelectionRange(dragAnchorRef.current, idx)
                      }}
                    >
                      {cell.char && <span className="shenlun-sheet-char">{cell.char}</span>}
                    </div>
                  )
                })}
              </div>
              {row.hundredMark && <div className="shenlun-sheet-mark">{row.hundredMark}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
