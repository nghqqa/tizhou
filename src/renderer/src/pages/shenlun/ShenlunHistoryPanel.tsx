import { Button } from '@fluentui/react-components'
import type { ConstructedAttemptRecord } from '@shared/contracts'
import { formatFullDate } from '../../api'

interface ShenlunHistoryPanelProps {
  promptHistory: ConstructedAttemptRecord[]
  selectedHistoryId: string
  expandedHistoryIds: Record<string, boolean>
  evaluating: boolean
  onSelectEvaluation: (record: ConstructedAttemptRecord) => void
  onLoadDraft: (record: ConstructedAttemptRecord) => void
  onToggleExpand: (recordId: string) => void
}

export function ShenlunHistoryPanel({
  promptHistory,
  selectedHistoryId,
  expandedHistoryIds,
  evaluating,
  onSelectEvaluation,
  onLoadDraft,
  onToggleExpand
}: ShenlunHistoryPanelProps): React.JSX.Element {
  return (
    <div className="answer-panel">
      {promptHistory.length === 0 ? (
        <p className="muted">本题尚无评估记录，提交评估后会在此保留每次作答与点评。</p>
      ) : (
        <div className="solution-history-list">
          {promptHistory.map((record, index) => {
            const active = record.id === selectedHistoryId
            const trimmed = record.content.trim()
            const wordCount = record.content.replace(/\s/g, '').length
            const canExpand = trimmed.length > 140 || trimmed.split('\n').length > 4
            const expanded = Boolean(expandedHistoryIds[record.id])
            return (
              <div key={record.id} className={`solution-history-item${active ? ' is-active' : ''}`}>
                <div className="solution-history-head">
                  <div>
                    <strong>
                      第 {promptHistory.length - index} 次 · {record.evaluation.score} 分
                    </strong>
                    <span className="solution-history-meta">
                      {formatFullDate(record.createdAt)} · {wordCount} 字 ·{' '}
                      {record.evaluation.provider}
                    </span>
                  </div>
                  <div className="solution-history-actions">
                    <Button
                      size="small"
                      appearance={active ? 'primary' : 'subtle'}
                      onClick={() => onSelectEvaluation(record)}
                    >
                      {active ? '查看中' : '查看点评'}
                    </Button>
                    <Button size="small" disabled={evaluating} onClick={() => onLoadDraft(record)}>
                      载入修改
                    </Button>
                  </div>
                </div>
                <p className={`solution-history-preview${expanded ? ' is-expanded' : ''}`}>
                  {trimmed || '（空作答）'}
                </p>
                {canExpand && (
                  <button
                    type="button"
                    className="solution-history-expand"
                    onClick={() => onToggleExpand(record.id)}
                  >
                    {expanded ? '收起全文' : '展开全文'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
