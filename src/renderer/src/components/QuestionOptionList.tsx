import type { MouseEvent } from 'react'
import type { QuestionOption } from '@shared/contracts'
import { OptionContent } from './OptionContent'

export interface QuestionOptionListProps {
  options: QuestionOption[]
  selected: string[]
  sourceFilePath?: string
  /** 传入参考答案数组表示处于已判分复盘态；未传表示作答态 */
  correctKeys?: string[]
  eliminatedKeys?: string[]
  disabled?: boolean
  testIdPrefix?: string
  onSelect: (key: string) => void
  onToggleEliminate?: (key: string, event: MouseEvent<HTMLButtonElement>) => void
}

export function QuestionOptionList({
  options,
  selected,
  sourceFilePath,
  correctKeys,
  eliminatedKeys = [],
  disabled = false,
  testIdPrefix,
  onSelect,
  onToggleEliminate
}: QuestionOptionListProps): React.JSX.Element {
  const graded = correctKeys !== undefined
  return (
    <div className="options">
      {options.map((option) => {
        const isSelected = selected.includes(option.key)
        const isEliminated =
          !disabled && !graded && !isSelected && eliminatedKeys.includes(option.key)
        const stateClass = graded
          ? correctKeys.includes(option.key)
            ? 'correct'
            : isSelected
              ? 'wrong'
              : 'dimmed'
          : isSelected
            ? 'selected'
            : isEliminated
              ? 'is-eliminated'
              : ''
        return (
          <button
            type="button"
            key={option.key}
            title={!disabled && onToggleEliminate ? '左键选择 · 右键排除干扰项' : undefined}
            className={`option-button ${stateClass}`.trim()}
            data-testid={testIdPrefix ? `${testIdPrefix}-${option.key}` : undefined}
            onClick={() => onSelect(option.key)}
            onContextMenu={
              onToggleEliminate ? (event) => onToggleEliminate(option.key, event) : undefined
            }
            disabled={disabled}
          >
            <span className="option-key">{option.key}</span>
            <OptionContent option={option} sourceFilePath={sourceFilePath} />
          </button>
        )
      })}
    </div>
  )
}
