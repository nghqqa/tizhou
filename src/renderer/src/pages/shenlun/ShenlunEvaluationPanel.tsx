import { Button } from '@fluentui/react-components'
import type { ConstructedEvaluation } from '@shared/contracts'
import { unescapeEvalText } from '@shared/shenlun-rubric'
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
  const normalizedSummary = unescapeEvalText(evaluation.summary)
  const fallbackMatch = normalizedSummary.match(/^【AI 批改回退提示】([^\n]+)\n+([\s\S]*)$/)
  const fallbackNotice = fallbackMatch?.[1]?.trim() ?? ''
  const displaySummary = fallbackMatch ? (fallbackMatch[2] ?? '').trim() : normalizedSummary

  return (
    <Section
      title={`评估结果：${evaluation.score} 分`}
      description={`${isLocalFallback ? '本地规则评分' : evaluation.provider} · ${formatFullDate(evaluation.createdAt)}`}
    >
      {evaluation.rubricMeta && (
        <div className="eval-rubric-strip">
          <span className="pill">
            {evaluation.rubricMeta.subType} · {evaluation.rubricMeta.tierLabel}
          </span>
          {evaluation.rubricMeta.fullScore !== undefined &&
            evaluation.rubricMeta.convertedScore !== undefined && (
              <span className="pill is-evaluated">
                折合题面 {evaluation.rubricMeta.convertedScore} / {evaluation.rubricMeta.fullScore}{' '}
                分
              </span>
            )}
          <span className="pill">
            实写 {evaluation.rubricMeta.wordCount} 字 · 占格 {evaluation.rubricMeta.sheetCellCount}
            {evaluation.rubricMeta.wordLimitLabel
              ? `（要求 ${evaluation.rubricMeta.wordLimitLabel}）`
              : ''}
          </span>
        </div>
      )}
      {evaluation.rubricMeta?.penalties && evaluation.rubricMeta.penalties.length > 0 && (
        <div className="eval-penalty-note" role="note">
          <strong>真考硬性扣分/风险核查：</strong>
          <span>{evaluation.rubricMeta.penalties.join('；')}</span>
        </div>
      )}
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
            <small>{unescapeEvalText(dimension.comment)}</small>
          </div>
        ))}
      </div>
      <div className="answer-panel eval-answer-panel">
        <h3>综合反馈</h3>
        <p>{displaySummary}</p>
        <ol>
          {evaluation.suggestions.map((suggestion, index) => (
            <li key={`${index}-${suggestion.slice(0, 24)}`}>{unescapeEvalText(suggestion)}</li>
          ))}
        </ol>
      </div>
    </Section>
  )
}
