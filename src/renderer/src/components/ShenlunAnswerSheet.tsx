import { useMemo, useRef, useState } from 'react'
import { SHENLUN_SHEET_COLS, buildShenlunSheetGrid } from '@shared/shenlun'
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
  placeholder = '点击下方任意方格开始作答 · 25 格/行 · 回车换行 · 自动保存'
}: ShenlunAnswerSheetProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [caretIndex, setCaretIndex] = useState(value.length)

  // 中文输入法组合态：在选字上屏前不把拼音字母拆进方格，而是显示在光标处悬浮预览条中
  const [composing, setComposing] = useState(false)
  const [imeRawValue, setImeRawValue] = useState('')
  const [imePreviewText, setImePreviewText] = useState('')
  const preComposeValueRef = useRef(value)
  const preComposeCaretRef = useRef(value.length)

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
    setCaretIndex(el.selectionStart ?? value.length)
  }

  function focusAt(index: number): void {
    const el = textareaRef.current
    if (!el) return
    const clamped = Math.max(0, Math.min(index, value.length))
    el.focus()
    window.requestAnimationFrame(() => {
      el.setSelectionRange(clamped, clamped)
      setCaretIndex(clamped)
    })
  }

  const caretLeftPct = Math.min(92, (grid.caretCol / SHENLUN_SHEET_COLS) * 100)
  const caretTopPx = grid.caretRow * 29 + 12

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
        <span
          className={`shenlun-sheet-counter${overLimit ? ' is-over-limit' : underLimit ? ' is-under-limit' : ''}`}
          title={limit ? `已识别题干字数要求：${limit.label}` : undefined}
        >
          {limit ? `${wordCount} / ${limit.label}` : `${wordCount} 字`}
        </span>
      </div>

      {!value && <div className="shenlun-sheet-subbar">{placeholder}</div>}

      <div
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
          }}
          onChange={(event) => {
            const nextVal = event.target.value
            // 某些平台下 nativeEvent.isComposing 为 true 时仅更新本地 IME 缓冲
            if (composing || (event.nativeEvent as InputEvent).isComposing) {
              setImeRawValue(nextVal)
              return
            }
            onChange(nextVal)
            setCaretIndex(event.target.selectionStart ?? nextVal.length)
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
                    focused && grid.caretRow === cell.row && grid.caretCol === cell.col
                  return (
                    <div
                      key={cell.col}
                      role="gridcell"
                      className={[
                        'shenlun-sheet-cell',
                        cell.isLimitBoundary ? 'is-limit-boundary' : '',
                        cell.isOverLimit ? 'is-over-limit' : '',
                        isCaretHere ? 'is-caret' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        if (cell.charIndex !== null) {
                          const rect = event.currentTarget.getBoundingClientRect()
                          const clickRightHalf = event.clientX - rect.left > rect.width / 2
                          focusAt(clickRightHalf ? cell.charIndex + 1 : cell.charIndex)
                        } else {
                          focusAt(row.lineEndCharIndex)
                        }
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
