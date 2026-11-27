import { useEffect, useMemo, useState } from 'react'
import { Button, Select } from '@fluentui/react-components'
import { GitDiffIcon } from '@phosphor-icons/react'
import type { ConstructedAttemptRecord } from '@shared/contracts'
import { formatFullDate } from '../../api'
import { diffTexts } from '../../services/text-diff'

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
  const [compareOpen, setCompareOpen] = useState(false)
  const [baseId, setBaseId] = useState('')
  const [targetId, setTargetId] = useState('')

  useEffect(() => {
    if (promptHistory.length < 2) {
      setCompareOpen(false)
      setBaseId('')
      setTargetId('')
      return
    }
    const resolvedTarget = promptHistory.some((item) => item.id === targetId)
      ? targetId
      : promptHistory[0]!.id
    const resolvedBase =
      promptHistory.some((item) => item.id === baseId) && baseId !== resolvedTarget
        ? baseId
        : (promptHistory.find((item) => item.id !== resolvedTarget)?.id ?? promptHistory[1]!.id)
    if (resolvedTarget !== targetId) setTargetId(resolvedTarget)
    if (resolvedBase !== baseId) setBaseId(resolvedBase)
  }, [promptHistory])

  const recordNumberById = useMemo(() => {
    const map = new Map<string, number>()
    promptHistory.forEach((record, index) => {
      map.set(record.id, promptHistory.length - index)
    })
    return map
  }, [promptHistory])

  const baseRecord = promptHistory.find((item) => item.id === baseId) ?? promptHistory[1]
  const targetRecord = promptHistory.find((item) => item.id === targetId) ?? promptHistory[0]

  const diffResult = useMemo(() => {
    if (!compareOpen || !baseRecord || !targetRecord) return null
    return diffTexts(baseRecord.content, targetRecord.content)
  }, [compareOpen, baseRecord, targetRecord])

  const scoreDelta =
    baseRecord && targetRecord ? targetRecord.evaluation.score - baseRecord.evaluation.score : 0
  const baseWords = baseRecord ? baseRecord.content.replace(/\s/g, '').length : 0
  const targetWords = targetRecord ? targetRecord.content.replace(/\s/g, '').length : 0
  const netWordDelta = targetWords - baseWords

  return (
    <div className="answer-panel">
      {promptHistory.length === 0 ? (
        <p className="muted">本题尚无评估记录，提交评估后会在此保留每次作答与点评。</p>
      ) : (
        <>
          {promptHistory.length >= 2 && (
            <div className="diff-toolbar">
              <Button
                size="small"
                appearance={compareOpen ? 'primary' : 'outline'}
                icon={<GitDiffIcon />}
                onClick={() => setCompareOpen((prev) => !prev)}
              >
                {compareOpen ? '收起文本对比' : '一稿 vs 二稿文本 Diff 对比'}
              </Button>
            </div>
          )}

          {compareOpen && baseRecord && targetRecord && diffResult && (
            <div className="diff-panel">
              <div className="diff-controls">
                <label className="diff-select-field">
                  <span className="muted">基准稿</span>
                  <Select
                    value={baseRecord.id}
                    onChange={(_, data) => {
                      const nextBase = data.value
                      if (nextBase === targetRecord.id) {
                        setTargetId(baseRecord.id)
                      }
                      setBaseId(nextBase)
                    }}
                    aria-label="选择基准稿"
                  >
                    {promptHistory.map((item) => (
                      <option key={item.id} value={item.id} disabled={item.id === targetRecord.id}>
                        第 {recordNumberById.get(item.id)} 次 · {item.evaluation.score} 分 ·{' '}
                        {item.content.replace(/\s/g, '').length} 字
                      </option>
                    ))}
                  </Select>
                </label>
                <span className="muted">对比</span>
                <label className="diff-select-field">
                  <span className="muted">修订稿</span>
                  <Select
                    value={targetRecord.id}
                    onChange={(_, data) => {
                      const nextTarget = data.value
                      if (nextTarget === baseRecord.id) {
                        setBaseId(targetRecord.id)
                      }
                      setTargetId(nextTarget)
                    }}
                    aria-label="选择修订稿"
                  >
                    {promptHistory.map((item) => (
                      <option key={item.id} value={item.id} disabled={item.id === baseRecord.id}>
                        第 {recordNumberById.get(item.id)} 次 · {item.evaluation.score} 分 ·{' '}
                        {item.content.replace(/\s/g, '').length} 字
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="diff-summary">
                <span
                  className={`pill${scoreDelta > 0 ? ' positive' : scoreDelta < 0 ? ' negative' : ''}`}
                >
                  分数 {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta === 0 ? '持平' : scoreDelta}
                  {scoreDelta !== 0 ? ' 分' : ''}
                </span>
                <span className="pill positive">新增 +{diffResult.addedChars} 字</span>
                <span className="pill negative">删减 -{diffResult.removedChars} 字</span>
                <span className="pill">
                  净变化 {netWordDelta >= 0 ? `+${netWordDelta}` : netWordDelta} 字
                </span>
              </div>
              <div className="diff-body" role="region" aria-label="申论作答修订差异视图">
                {diffResult.segments.length === 0 ? (
                  <span className="muted">两版作答内容为空</span>
                ) : (
                  diffResult.segments.map((segment, idx) => {
                    if (segment.type === 'remove') {
                      return (
                        <del key={idx} className="diff-del">
                          {segment.text}
                        </del>
                      )
                    }
                    if (segment.type === 'add') {
                      return (
                        <ins key={idx} className="diff-add">
                          {segment.text}
                        </ins>
                      )
                    }
                    return <span key={idx}>{segment.text}</span>
                  })
                )}
              </div>
            </div>
          )}

          <div className="solution-history-list">
            {promptHistory.map((record, index) => {
              const active = record.id === selectedHistoryId
              const trimmed = record.content.trim()
              const wordCount = record.content.replace(/\s/g, '').length
              const canExpand = trimmed.length > 140 || trimmed.split('\n').length > 4
              const expanded = Boolean(expandedHistoryIds[record.id])
              return (
                <div
                  key={record.id}
                  className={`solution-history-item${active ? ' is-active' : ''}`}
                >
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
                      <Button
                        size="small"
                        disabled={evaluating}
                        onClick={() => onLoadDraft(record)}
                      >
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
        </>
      )}
    </div>
  )
}
