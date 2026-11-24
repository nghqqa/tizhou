import { useState } from 'react'
import { Button } from '@fluentui/react-components'
import type { Question } from '@shared/contracts'
import { invoke } from '../../api'
import { MarkdownContent } from '../../components/MarkdownContent'
import { OptionContent } from '../../components/OptionContent'
import { Section } from '../../components/ui'
import { useAppStore } from '../../store'
import type { SessionResult } from './constants'

interface SessionSummaryViewProps {
  questions: Question[]
  sessionResults: SessionResult[]
  uncertainIds?: string[]
  summaryOnlyWrong: boolean
  onToggleOnlyWrong: () => void
  onRetryWrong: (wrongQuestions: Question[]) => void
  onBackToConfig: () => void
}

export function SessionSummaryView({
  questions,
  sessionResults,
  uncertainIds = [],
  summaryOnlyWrong,
  onToggleOnlyWrong,
  onRetryWrong,
  onBackToConfig
}: SessionSummaryViewProps): React.JSX.Element {
  const showToast = useAppStore((state) => state.showToast)
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const [enqueuing, setEnqueuing] = useState(false)
  const [enqueued, setEnqueued] = useState(false)

  // 分母基于完整题目列表（快照恢复后内存态 sessionResults 可能缺失历史作答）
  const correctCount = sessionResults.filter((item) => item.result.correct).length
  const wrongQuestions = questions.filter((question) => {
    const item = sessionResults.find((entry) => entry.questionId === question.id)
    return !item || !item.result.correct
  })
  const uncertainCorrectIds = questions
    .filter(
      (q) =>
        uncertainIds.includes(q.id) &&
        sessionResults.find((entry) => entry.questionId === q.id)?.result.correct
    )
    .map((q) => q.id)
  const summaryVisible = summaryOnlyWrong ? wrongQuestions : questions

  async function enqueueUncertainCorrect(): Promise<void> {
    if (!uncertainCorrectIds.length || enqueuing || enqueued) return
    setEnqueuing(true)
    try {
      const res = await invoke<{ added: number; skipped: number }>({
        method: 'review.enqueue',
        params: { questionIds: uncertainCorrectIds, reason: '蒙对/不确定' }
      })
      setEnqueued(true)
      void refreshDashboard()
      showToast(
        res.added > 0
          ? `已将 ${res.added} 道蒙对/不确定题加入明日间隔复习`
          : '这些题目已在待复习队列中'
      )
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '加入复习队列失败')
    } finally {
      setEnqueuing(false)
    }
  }

  return (
    <Section
      title={`本组完成：${correctCount}/${questions.length} 正确`}
      description="汇总模式在全部作答完成后统一展示答案与解析。"
      actions={
        <div className="button-row">
          {wrongQuestions.length > 0 && (
            <Button
              appearance={summaryOnlyWrong ? 'primary' : 'outline'}
              onClick={onToggleOnlyWrong}
            >
              仅看错题 ({wrongQuestions.length})
            </Button>
          )}
          {wrongQuestions.length > 0 && (
            <Button appearance="secondary" onClick={() => onRetryWrong(wrongQuestions)}>
              重刷本场错题 ({wrongQuestions.length})
            </Button>
          )}
          {uncertainCorrectIds.length > 0 && (
            <Button
              appearance="secondary"
              disabled={enqueuing || enqueued}
              onClick={() => void enqueueUncertainCorrect()}
            >
              {enqueued
                ? `已入队 ${uncertainCorrectIds.length} 题`
                : `将 ${uncertainCorrectIds.length} 道蒙对/不确定题加入复习`}
            </Button>
          )}
          <Button appearance="primary" onClick={onBackToConfig}>
            返回训练配置
          </Button>
        </div>
      }
    >
      {summaryVisible.map((question) => {
        const questionIndex = questions.findIndex((entry) => entry.id === question.id)
        const item = sessionResults.find((entry) => entry.questionId === question.id)
        return (
          <div className="answer-panel" key={question.id}>
            <h3 className={item?.result.correct ? 'positive' : 'negative'}>
              第 {questionIndex + 1} 题：
              {item ? (item.result.correct ? '正确' : '错误') : '未作答'}
            </h3>
            {question.material && (
              <>
                <strong>给定材料</strong>
                <MarkdownContent content={question.material} sourceFilePath={question.filePath} />
              </>
            )}
            <MarkdownContent content={question.stem} sourceFilePath={question.filePath} />
            {question.options.length > 0 && (
              <div className="review-options">
                {question.options.map((option) => {
                  const isAnswer = question.answer.includes(option.key)
                  const isChosen = (item?.answer ?? []).includes(option.key)
                  return (
                    <div
                      key={option.key}
                      className={`review-option ${
                        isAnswer ? 'correct' : isChosen ? 'wrong' : ''
                      }`.trim()}
                    >
                      <span className="option-key">{option.key}</span>
                      <OptionContent option={option} sourceFilePath={question.filePath} />
                      <span className="muted">
                        {isChosen ? '你的选择' : ''}
                        {isChosen && isAnswer ? ' · ' : ''}
                        {isAnswer ? '参考答案' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            <p>
              你的作答：{item?.answer?.length ? item.answer.join('、') : '未作答'} · 参考答案：
              {question.answer.join('、')}
            </p>
            <MarkdownContent content={question.explanation} sourceFilePath={question.filePath} />
          </div>
        )
      })}
    </Section>
  )
}
