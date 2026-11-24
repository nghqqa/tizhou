import { Button, Field, Select, Textarea } from '@fluentui/react-components'
import { NotePencilIcon, RobotIcon, StopIcon } from '@phosphor-icons/react'
import { Spinner } from '@fluentui/react-components'
import type { AttemptResult, PracticeSession, Question } from '@shared/contracts'
import { WRONG_CAUSE_OPTIONS } from '@shared/study-constants'
import { MarkdownContent } from '../../components/MarkdownContent'
import { Section } from '../../components/ui'
import type { SessionResult } from './constants'
import { SimilarQuestionsCard } from './SimilarQuestionsCard'

interface TrainerSidebarProps {
  questions: Question[]
  index: number
  current: Question
  session?: PracticeSession
  sessionResults: SessionResult[]
  answeredMap: Map<string, SessionResult>
  feedbackMode: 'immediate' | 'summary'
  loading: boolean
  result?: AttemptResult
  currentRecord?: SessionResult
  review: boolean
  wrongCause: string
  onWrongCauseChange: (nextCause: string, isWrongSubmitted: boolean) => void
  reviewFeedback: 'forgot' | 'hard' | 'normal' | 'easy'
  onReviewFeedbackChange: (next: 'forgot' | 'hard' | 'normal' | 'easy') => void
  note: string
  onNoteChange: (next: string) => void
  onSaveNote: () => void
  similar: Question[]
  onAppendSimilar: (items: Question[]) => void
  aiCanAsk: boolean
  aiExplanation: string
  aiBusy: boolean
  onAskAi: () => void
  onCancelAi: () => void
  onNavigateToAi: (questionId: string) => void
  onJumpTo: (questionIndex: number) => void
}

export function TrainerSidebar({
  questions,
  index,
  current,
  session,
  sessionResults,
  answeredMap,
  feedbackMode,
  loading,
  result,
  currentRecord,
  review,
  wrongCause,
  onWrongCauseChange,
  reviewFeedback,
  onReviewFeedbackChange,
  note,
  onNoteChange,
  onSaveNote,
  similar,
  onAppendSimilar,
  aiCanAsk,
  aiExplanation,
  aiBusy,
  onAskAi,
  onCancelAi,
  onNavigateToAi,
  onJumpTo
}: TrainerSidebarProps): React.JSX.Element {
  const submitted = Boolean(result || currentRecord)
  const isWrongSubmitted = Boolean(
    (result && !result.correct) || (currentRecord && !currentRecord.result.correct)
  )

  return (
    <div className="side-stack">
      <Section
        title="本组答题卡"
        description={`已答 ${sessionResults.length} / ${questions.length} 题${session?.uncertainIds.length ? ` · ${session.uncertainIds.length} 题待查` : ''}`}
      >
        <div className="question-grid">
          {questions.map((question, questionIndex) => {
            const rec = answeredMap.get(question.id)
            const isUncertain = session?.uncertainIds.includes(question.id) ?? false
            const statusClass =
              rec && feedbackMode === 'immediate'
                ? rec.result.correct
                  ? ' is-correct'
                  : ' is-wrong'
                : ''
            return (
              <Button
                key={question.id}
                className={`question-number${statusClass}${isUncertain ? ' is-uncertain' : ''}`}
                size="small"
                appearance={questionIndex === index ? 'primary' : rec ? 'secondary' : 'subtle'}
                disabled={loading}
                onClick={() => onJumpTo(questionIndex)}
              >
                {questionIndex + 1}
              </Button>
            )
          })}
        </div>
      </Section>
      <Section
        title="错因标注"
        description="标注会进入报告，用于区分知识和操作问题；答错后仍可补标修改。"
      >
        <Field label="本题主要风险">
          <Select
            value={wrongCause}
            disabled={submitted && !isWrongSubmitted}
            onChange={(_, data) => onWrongCauseChange(data.value, isWrongSubmitted)}
          >
            <option value="">暂不标注</option>
            {WRONG_CAUSE_OPTIONS.map((cause) => (
              <option key={cause} value={cause}>
                {cause}
              </option>
            ))}
          </Select>
        </Field>
        {review && (
          <Field label="本次记忆反馈" className="field-gap-top">
            <Select
              value={reviewFeedback}
              onChange={(_, data) =>
                onReviewFeedbackChange(data.value as 'forgot' | 'hard' | 'normal' | 'easy')
              }
              disabled={Boolean(result)}
            >
              <option value="forgot">忘记</option>
              <option value="hard">困难</option>
              <option value="normal">一般</option>
              <option value="easy">熟练</option>
            </Select>
          </Field>
        )}
      </Section>
      <Section title="本题笔记">
        <Textarea
          rows={5}
          resize="vertical"
          value={note}
          onChange={(_, data) => onNoteChange(data.value)}
          placeholder="记录方法、陷阱或复盘结论"
        />
        <Button icon={<NotePencilIcon />} className="field-gap-top" onClick={onSaveNote}>
          保存笔记
        </Button>
      </Section>
      {result && similar.length > 0 && (
        <SimilarQuestionsCard
          similar={similar}
          appendedIds={new Set(questions.map((question) => question.id))}
          onAppendQuestions={onAppendSimilar}
        />
      )}
      {result && aiCanAsk && (
        <Section title="AI 深讲" description="白名单上下文：当前题、材料、你的答案与官方解析。">
          {aiBusy ? (
            <div className="ai-stream-panel">
              {aiExplanation ? (
                <div>
                  <MarkdownContent content={aiExplanation} />
                  <div className="ai-stream-status">
                    <span className="ai-stream-cursor" aria-hidden="true" />
                    <span>正在流式生成…</span>
                  </div>
                </div>
              ) : (
                <Spinner size="tiny" label="正在流式解析易错点…" />
              )}
              <div className="button-row" style={{ marginTop: 10 }}>
                <Button
                  size="small"
                  appearance="secondary"
                  icon={<StopIcon weight="fill" />}
                  onClick={onCancelAi}
                >
                  停止生成
                </Button>
              </div>
            </div>
          ) : aiExplanation ? (
            <>
              <MarkdownContent content={aiExplanation} />
              <div className="button-row" style={{ marginTop: 10 }}>
                <Button size="small" appearance="subtle" onClick={onAskAi}>
                  重新深讲
                </Button>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<RobotIcon />}
                  onClick={() => onNavigateToAi(current.id)}
                >
                  带本题去 AI 助教继续追问
                </Button>
              </div>
            </>
          ) : (
            <div className="button-row">
              <Button onClick={onAskAi}>解释本题易错点</Button>
              <Button
                appearance="subtle"
                icon={<RobotIcon />}
                onClick={() => onNavigateToAi(current.id)}
              >
                去助教追问
              </Button>
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
