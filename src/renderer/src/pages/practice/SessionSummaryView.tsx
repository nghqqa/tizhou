import { Button } from '@fluentui/react-components'
import type { Question } from '@shared/contracts'
import { MarkdownContent } from '../../components/MarkdownContent'
import { OptionContent } from '../../components/OptionContent'
import { Section } from '../../components/ui'
import type { SessionResult } from './constants'

interface SessionSummaryViewProps {
  questions: Question[]
  sessionResults: SessionResult[]
  summaryOnlyWrong: boolean
  onToggleOnlyWrong: () => void
  onRetryWrong: (wrongQuestions: Question[]) => void
  onBackToConfig: () => void
}

export function SessionSummaryView({
  questions,
  sessionResults,
  summaryOnlyWrong,
  onToggleOnlyWrong,
  onRetryWrong,
  onBackToConfig
}: SessionSummaryViewProps): React.JSX.Element {
  // 分母基于完整题目列表（快照恢复后内存态 sessionResults 可能缺失历史作答）
  const correctCount = sessionResults.filter((item) => item.result.correct).length
  const wrongQuestions = questions.filter((question) => {
    const item = sessionResults.find((entry) => entry.questionId === question.id)
    return !item || !item.result.correct
  })
  const summaryVisible = summaryOnlyWrong ? wrongQuestions : questions

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
