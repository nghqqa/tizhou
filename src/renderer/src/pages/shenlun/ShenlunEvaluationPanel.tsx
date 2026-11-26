import { Button } from '@fluentui/react-components'
import type { ConstructedEvaluation } from '@shared/contracts'
import { formatFullDate } from '../../api'
import { Section } from '../../components/ui'

export function ShenlunEvaluationPanel({
  evaluation,
  evaluating = false,
  onRetryEvaluate
}: {
  evaluation: ConstructedEvaluation
  evaluating?: boolean
  onRetryEvaluate?: () => void
}): React.JSX.Element {
  const isLocalFallback = evaluation.provider === 'local-rubric'
  const fallbackMatch = evaluation.summary.match(/^【AI 批改回退提示】([^\n]+)\n+([\s\S]*)$/)
  const fallbackNotice = fallbackMatch?.[1]?.trim() ?? ''
  const displaySummary = fallbackMatch ? (fallbackMatch[2] ?? '').trim() : evaluation.summary

  return (
    <Section
      title={`评估结果：${evaluation.score} 分`}
      description={`${isLocalFallback ? '本地规则评分' : evaluation.provider} · ${formatFullDate(evaluation.createdAt)}`}
    >
      {fallbackNotice && (
        <div className="eval-fallback-banner" role="alert">
          <div className="eval-fallback-body">
            <strong>AI 批改未能完成，已自动回退为本地规则评分</strong>
            <p>{fallbackNotice}</p>
          </div>
          {onRetryEvaluate && (
            <Button
              size="small"
              appearance="primary"
              disabled={evaluating}
              onClick={onRetryEvaluate}
            >
              {evaluating ? '批改中...' : '重新用 AI 批改'}
            </Button>
          )}
        </div>
      )}
      <div className="grid three">
        {evaluation.dimensions.map((dimension, index) => (
          <div className="stat eval-dim-card" key={`${dimension.name}-${index}`}>
            <span>{dimension.name}</span>
            <strong>{dimension.score}</strong>
            <small>{dimension.comment}</small>
          </div>
        ))}
      </div>
      <div className="answer-panel eval-answer-panel">
        <h3>综合反馈</h3>
        <p>{displaySummary}</p>
        <ol>
          {evaluation.suggestions.map((suggestion, index) => (
            <li key={`${index}-${suggestion.slice(0, 24)}`}>{suggestion}</li>
          ))}
        </ol>
      </div>
    </Section>
  )
}
