import { useState } from 'react'
import { Button } from '@fluentui/react-components'
import { ArrowClockwiseIcon, CheckIcon, EyeIcon, PlusIcon } from '@phosphor-icons/react'
import type { Question } from '@shared/contracts'
import { isAnswerCorrect } from '@shared/study-constants'
import { MarkdownContent } from '../../components/MarkdownContent'
import { QuestionOptionList } from '../../components/QuestionOptionList'
import { Section } from '../../components/ui'

interface SimilarQuestionsCardProps {
  similar: Question[]
  appendedIds: Set<string>
  onAppendQuestions: (items: Question[]) => void
}

export function SimilarQuestionsCard({
  similar,
  appendedIds,
  onAppendQuestions
}: SimilarQuestionsCardProps): React.JSX.Element {
  const [openId, setOpenId] = useState('')
  const [selectedById, setSelectedById] = useState<Record<string, string[]>>({})
  const [checkedById, setCheckedById] = useState<Record<string, boolean>>({})
  const [revealedById, setRevealedById] = useState<Record<string, boolean>>({})

  const unappended = similar.filter((q) => !appendedIds.has(q.id))

  function chooseOption(question: Question, key: string): void {
    if (checkedById[question.id] || revealedById[question.id]) return
    if (question.type === 'multiple') {
      setSelectedById((prev) => {
        const cur = prev[question.id] ?? []
        const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
        return { ...prev, [question.id]: next }
      })
      return
    }
    setSelectedById((prev) => ({ ...prev, [question.id]: [key] }))
    setCheckedById((prev) => ({ ...prev, [question.id]: true }))
  }

  function resetQuestion(questionId: string): void {
    setSelectedById((prev) => {
      const next = { ...prev }
      delete next[questionId]
      return next
    })
    setCheckedById((prev) => ({ ...prev, [questionId]: false }))
    setRevealedById((prev) => ({ ...prev, [questionId]: false }))
  }

  return (
    <Section
      title="相似题巩固"
      description="默认隐藏答案与解析，可直接自测或追加到本组末尾趁热巩固。"
      actions={
        similar.length > 0 ? (
          <Button
            size="small"
            appearance="subtle"
            icon={unappended.length === 0 ? <CheckIcon /> : <PlusIcon />}
            disabled={unappended.length === 0}
            onClick={() => onAppendQuestions(unappended)}
          >
            {unappended.length === 0 ? '已全部加入本组' : `全部追加 (${unappended.length})`}
          </Button>
        ) : undefined
      }
    >
      <ul className="data-list">
        {similar.map((question) => {
          const open = openId === question.id
          const chosen = selectedById[question.id] ?? []
          const checked = Boolean(checkedById[question.id])
          const revealed = Boolean(revealedById[question.id])
          const showAnswer = checked || revealed
          const hasOptions = question.type !== 'essay' && question.options.length > 0
          const correct = checked
            ? isAnswerCorrect(question.answer, chosen, { requireNonEmpty: true })
            : false
          const isAppended = appendedIds.has(question.id)

          return (
            <li className="similar-row-item" key={question.id}>
              <button
                type="button"
                className="similar-row-btn"
                onClick={() => setOpenId((prev) => (prev === question.id ? '' : question.id))}
              >
                <strong>{question.stem}</strong>
                <span>
                  {question.category} · 难度 {question.difficulty}
                  {checked ? (correct ? ' · 自测正确' : ' · 自测有误') : ''}
                  {isAppended ? ' · 已入本组' : ''} · {open ? '收起' : '自测'}
                </span>
              </button>
              {open && (
                <div className="similar-preview-box">
                  {question.material && (
                    <div className="similar-material-snippet">
                      <MarkdownContent
                        content={question.material}
                        sourceFilePath={question.filePath}
                      />
                    </div>
                  )}
                  <MarkdownContent content={question.stem} sourceFilePath={question.filePath} />
                  {hasOptions && (
                    <div className="similar-options-wrap">
                      <QuestionOptionList
                        options={question.options}
                        selected={chosen}
                        sourceFilePath={question.filePath}
                        correctKeys={showAnswer ? question.answer : undefined}
                        disabled={showAnswer}
                        onSelect={(key) => chooseOption(question, key)}
                      />
                    </div>
                  )}
                  <div className="similar-self-actions">
                    {hasOptions && question.type === 'multiple' && !showAnswer && (
                      <Button
                        size="small"
                        appearance="primary"
                        disabled={chosen.length === 0}
                        onClick={() => setCheckedById((prev) => ({ ...prev, [question.id]: true }))}
                      >
                        核对答案
                      </Button>
                    )}
                    {!showAnswer ? (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<EyeIcon />}
                        onClick={() =>
                          setRevealedById((prev) => ({ ...prev, [question.id]: true }))
                        }
                      >
                        直接看答案
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowClockwiseIcon />}
                        onClick={() => resetQuestion(question.id)}
                      >
                        重做自测
                      </Button>
                    )}
                    <Button
                      size="small"
                      appearance={isAppended ? 'secondary' : 'outline'}
                      icon={isAppended ? <CheckIcon /> : <PlusIcon />}
                      disabled={isAppended}
                      onClick={() => onAppendQuestions([question])}
                    >
                      {isAppended ? '已加入本组' : '追加到本组'}
                    </Button>
                  </div>
                  {showAnswer && (
                    <div className="similar-answer-reveal">
                      {checked && (
                        <p
                          className={correct ? 'positive' : 'negative'}
                          style={{ margin: '0 0 4px' }}
                        >
                          {correct ? '自测正确' : '自测有误'}
                        </p>
                      )}
                      {question.answer.length > 0 && (
                        <p style={{ margin: '0 0 6px' }}>
                          <strong>参考答案：</strong>
                          {question.answer.join('、')}
                        </p>
                      )}
                      <MarkdownContent
                        content={question.explanation}
                        sourceFilePath={question.filePath}
                      />
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
