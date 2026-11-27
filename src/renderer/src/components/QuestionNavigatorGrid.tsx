import { useMemo } from 'react'
import { Button } from '@fluentui/react-components'
import { ArrowDownIcon, ArrowsClockwiseIcon, ArrowUpIcon } from '@phosphor-icons/react'
import type { Question } from '@shared/contracts'
import {
  XINGCE_MODULE_ORDER,
  normalizeXingceModule,
  suggestedModuleSeconds
} from '@shared/study-constants'

export interface QuestionNavigatorItemStatus {
  answered?: boolean
  correct?: boolean
  uncertain?: boolean
  durationSeconds?: number
}

interface QuestionNavigatorGridProps {
  questions: Question[]
  currentIndex: number
  mode?: 'flat' | 'grouped'
  feedbackMode?: 'immediate' | 'summary'
  disabled?: boolean
  moduleOrder?: string[]
  onModuleOrderChange?: (nextOrder: string[]) => void
  onResetModuleOrder?: () => void
  getStatus: (question: Question, index: number) => QuestionNavigatorItemStatus
  onSelect: (index: number) => void
}

export function buildOrderedModuleIndices(
  questions: Question[],
  moduleOrder: string[]
): Array<{
  moduleName: string
  indices: number[]
}> {
  const buckets = new Map<string, number[]>()
  questions.forEach((question, index) => {
    const mod = normalizeXingceModule(question.category)
    const list = buckets.get(mod)
    if (list) list.push(index)
    else buckets.set(mod, [index])
  })
  const orderRank = (name: string): number => {
    const customIdx = moduleOrder.indexOf(name)
    if (customIdx >= 0) return customIdx
    const stdIdx = (XINGCE_MODULE_ORDER as readonly string[]).indexOf(name)
    return 100 + (stdIdx >= 0 ? stdIdx : 99)
  }
  return [...buckets.entries()]
    .sort((a, b) => orderRank(a[0]) - orderRank(b[0]) || a[1][0]! - b[1][0]!)
    .map(([moduleName, indices]) => ({ moduleName, indices }))
}

function formatMinutesLabel(seconds: number): string {
  if (seconds <= 0) return '0 分'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`
}

/** 公共答题卡网格组件：
 *  - `flat`：普通刷题/单模块模考/申论连作的连续题号网格
 *  - `grouped`：行测多模块模考按五大模块分组，支持个人做题顺序上下调序与模块实时配速对比 */
export function QuestionNavigatorGrid({
  questions,
  currentIndex,
  mode = 'flat',
  feedbackMode = 'summary',
  disabled = false,
  moduleOrder = [...XINGCE_MODULE_ORDER],
  onModuleOrderChange,
  onResetModuleOrder,
  getStatus,
  onSelect
}: QuestionNavigatorGridProps): React.JSX.Element {
  const groupedSections = useMemo(
    () => (mode === 'grouped' ? buildOrderedModuleIndices(questions, moduleOrder) : []),
    [mode, questions, moduleOrder]
  )

  const renderGridButton = (questionIndex: number, displayNumber: number): React.JSX.Element => {
    const question = questions[questionIndex]!
    const status = getStatus(question, questionIndex)
    const statusClass =
      feedbackMode === 'immediate' && status.correct !== undefined
        ? status.correct
          ? ' is-correct'
          : ' is-wrong'
        : ''
    return (
      <Button
        key={question.id}
        className={`question-number${statusClass}${status.uncertain ? ' is-uncertain' : ''}`}
        size="small"
        appearance={
          questionIndex === currentIndex ? 'primary' : status.answered ? 'secondary' : 'subtle'
        }
        disabled={disabled}
        onClick={() => onSelect(questionIndex)}
      >
        {displayNumber}
      </Button>
    )
  }

  if (mode !== 'grouped' || groupedSections.length <= 1) {
    return (
      <div className="question-grid">
        {questions.map((_, questionIndex) => renderGridButton(questionIndex, questionIndex + 1))}
      </div>
    )
  }

  const moveModule = (sectionIndex: number, delta: -1 | 1): void => {
    if (!onModuleOrderChange) return
    const targetIndex = sectionIndex + delta
    if (targetIndex < 0 || targetIndex >= groupedSections.length) return
    const visibleNames = groupedSections.map((section) => section.moduleName)
    const nameA = visibleNames[sectionIndex]!
    const nameB = visibleNames[targetIndex]!
    const baseOrder = [
      ...(moduleOrder && moduleOrder.length > 0 ? moduleOrder : XINGCE_MODULE_ORDER)
    ]
    for (const name of visibleNames) {
      if (!baseOrder.includes(name)) baseOrder.push(name)
    }
    const idxA = baseOrder.indexOf(nameA)
    const idxB = baseOrder.indexOf(nameB)
    if (idxA >= 0 && idxB >= 0) {
      baseOrder[idxA] = nameB
      baseOrder[idxB] = nameA
    }
    onModuleOrderChange(baseOrder)
  }

  return (
    <div className="module-nav-groups">
      {onModuleOrderChange && (
        <div className="module-nav-order-hint">
          <span>按个人习惯调整模块顺序</span>
          {onResetModuleOrder && (
            <button type="button" className="module-nav-reset-btn" onClick={onResetModuleOrder}>
              <ArrowsClockwiseIcon size={12} /> 默认序
            </button>
          )}
        </div>
      )}
      {groupedSections.map((section, sectionIdx) => {
        let answeredInSection = 0
        let spentSeconds = 0
        for (const qIdx of section.indices) {
          const st = getStatus(questions[qIdx]!, qIdx)
          if (st.answered) answeredInSection += 1
          spentSeconds += st.durationSeconds ?? 0
        }
        const suggestedSec = suggestedModuleSeconds(section.moduleName, section.indices.length)
        const suggestedMin = Math.max(1, Math.round(suggestedSec / 60))
        const isOvertime = spentSeconds > suggestedSec
        const hasCurrent = section.indices.includes(currentIndex)
        return (
          <div
            key={section.moduleName}
            className={`module-nav-group${hasCurrent ? ' is-current-module' : ''}`}
          >
            <div className="module-nav-head">
              <div className="module-nav-title-row">
                <strong>{section.moduleName}</strong>
                <span className="muted">
                  {answeredInSection}/{section.indices.length}
                </span>
              </div>
              <div className="module-nav-controls">
                <span
                  className={`module-pace-badge${isOvertime ? ' is-overtime' : ''}`}
                  title={`当前模块累计已用 ${formatMinutesLabel(spentSeconds)} / 考场建议约 ${suggestedMin} 分钟`}
                >
                  {formatMinutesLabel(spentSeconds)} / {suggestedMin}分
                </span>
                {onModuleOrderChange && (
                  <>
                    <button
                      type="button"
                      className="module-move-btn"
                      aria-label={`上移 ${section.moduleName}`}
                      disabled={sectionIdx === 0}
                      onClick={() => moveModule(sectionIdx, -1)}
                    >
                      <ArrowUpIcon size={11} />
                    </button>
                    <button
                      type="button"
                      className="module-move-btn"
                      aria-label={`下移 ${section.moduleName}`}
                      disabled={sectionIdx === groupedSections.length - 1}
                      onClick={() => moveModule(sectionIdx, 1)}
                    >
                      <ArrowDownIcon size={11} />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="question-grid">
              {section.indices.map((qIdx) => renderGridButton(qIdx, qIdx + 1))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
