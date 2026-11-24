import type { ConstructedEvaluation } from '@shared/contracts'
import { formatFullDate } from '../../api'
import { Section } from '../../components/ui'

export function ShenlunEvaluationPanel({
  evaluation
}: {
  evaluation: ConstructedEvaluation
}): React.JSX.Element {
  return (
    <Section
      title={`评估结果：${evaluation.score} 分`}
      description={`${evaluation.provider} · ${formatFullDate(evaluation.createdAt)}`}
    >
      <div className="grid three">
        {evaluation.dimensions.map((dimension) => (
          <div className="stat eval-dim-card" key={dimension.name}>
            <span>{dimension.name}</span>
            <strong>{dimension.score}</strong>
            <small>{dimension.comment}</small>
          </div>
        ))}
      </div>
      <div className="answer-panel">
        <h3>综合反馈</h3>
        <p>{evaluation.summary}</p>
        <ol>
          {evaluation.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ol>
      </div>
    </Section>
  )
}
