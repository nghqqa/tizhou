import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, CheckIcon, NotePencilIcon } from '@phosphor-icons/react'
import type { QuestionSummary } from '@shared/contracts'
import { classifyShenlunType } from '@shared/shenlun'
import { formatMaterialSource } from '../services/study-helpers'

const PAGE_SIZE = 50

function compactStem(stem: string, max = 64): string {
  const clean = stem.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`
}

export interface ShenlunPromptPickerProps {
  prompts: QuestionSummary[]
  value: string
  statusByPrompt: Map<string, { count: number; latestScore: number; latestAt: string }>
  disabled?: boolean
  onSelect: (id: string) => void
}

export function ShenlunPromptPicker({
  prompts,
  value,
  statusByPrompt,
  disabled = false,
  onSelect
}: ShenlunPromptPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const currentIndex = useMemo(
    () => prompts.findIndex((item) => item.id === value),
    [prompts, value]
  )
  const current = currentIndex >= 0 ? prompts[currentIndex] : undefined
  const currentType = current ? classifyShenlunType(current.category, current.stemPreview) : ''

  return (
    <div className="prompt-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`prompt-picker-trigger${open ? ' is-open' : ''}`}
        disabled={disabled || prompts.length === 0}
        aria-expanded={open}
        onClick={() => {
          setVisibleCount(PAGE_SIZE)
          setOpen((prev) => !prev)
        }}
      >
        <NotePencilIcon size={15} className="prompt-picker-icon" />
        {current ? (
          <span className="prompt-picker-summary">
            <span className="prompt-picker-kind">{currentType}</span>
            <span className="prompt-picker-stem">{compactStem(current.stemPreview, 48)}</span>
          </span>
        ) : (
          <span className="prompt-picker-empty">暂无匹配的申论题目</span>
        )}
        {prompts.length > 0 && currentIndex >= 0 && (
          <span className="prompt-picker-counter">
            {currentIndex + 1} / {prompts.length}
          </span>
        )}
        <CaretDownIcon size={14} className="region-picker-caret" />
      </button>

      {open && (
        <div className="prompt-picker-popover" role="listbox" aria-label="申论题目列表">
          <div className="prompt-picker-list">
            {prompts.slice(0, visibleCount).map((prompt) => {
              const isSelected = prompt.id === value
              const kind = classifyShenlunType(prompt.category, prompt.stemPreview)
              const status = statusByPrompt.get(prompt.id)
              const sourceLabel = prompt.source ? formatMaterialSource(prompt.source) : ''
              return (
                <button
                  key={prompt.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`prompt-picker-item${isSelected ? ' is-active' : ''}`}
                  onClick={() => {
                    onSelect(prompt.id)
                    setOpen(false)
                  }}
                >
                  <div className="prompt-picker-item-top">
                    <div className="prompt-picker-badges">
                      <span className={`prompt-badge kind-${kind}`}>{kind}</span>
                      {prompt.region && <span className="prompt-badge">{prompt.region}</span>}
                      {prompt.year && <span className="prompt-badge">{prompt.year}</span>}
                      {status && (
                        <span className="prompt-badge is-score">已评 {status.latestScore} 分</span>
                      )}
                    </div>
                    {isSelected && <CheckIcon size={14} className="prompt-picker-check" />}
                  </div>
                  <div className="prompt-picker-item-stem">
                    {compactStem(prompt.stemPreview, 86)}
                  </div>
                  {sourceLabel && (
                    <div className="prompt-picker-item-meta">教材来源：{sourceLabel}</div>
                  )}
                </button>
              )
            })}
            {prompts.length > visibleCount && (
              <button
                type="button"
                className="region-cascade-option is-summary"
                onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
              >
                <span>加载更多题目（还有 {prompts.length - visibleCount} 题）</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
