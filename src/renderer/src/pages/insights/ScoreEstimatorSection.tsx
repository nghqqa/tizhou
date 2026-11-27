import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Select } from '@fluentui/react-components'
import { ArrowRightIcon, FireIcon, TrendUpIcon } from '@phosphor-icons/react'
import { Section } from '../../components/ui'
import {
  SCORE_TEMPLATES,
  estimateXingceScore,
  loadScoreEstimatorPrefs,
  saveScoreEstimatorPrefs,
  type CategoryStatInput,
  type ScoreTemplateId
} from '../../services/score-estimator'

export function ScoreEstimatorSection({
  categoryStats
}: {
  categoryStats: CategoryStatInput[]
}): React.JSX.Element {
  const navigate = useNavigate()
  const [prefs, setPrefs] = useState(() => loadScoreEstimatorPrefs())
  const [targetInput, setTargetInput] = useState(() =>
    String(loadScoreEstimatorPrefs().targetScore)
  )

  const estimate = useMemo(
    () => estimateXingceScore(categoryStats, prefs.templateId, prefs.targetScore),
    [categoryStats, prefs.templateId, prefs.targetScore]
  )
  const hasAnySample = useMemo(() => estimate.modules.some((m) => m.hasData), [estimate.modules])

  function updatePrefs(patch: Partial<typeof prefs>): void {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      saveScoreEstimatorPrefs(next)
      return next
    })
  }

  function commitTargetInput(raw: string): void {
    const parsed = Number(raw.trim())
    const nextScore = Number.isFinite(parsed)
      ? Math.min(95, Math.max(50, Math.round(parsed)))
      : prefs.targetScore
    setTargetInput(String(nextScore))
    if (nextScore !== prefs.targetScore) {
      updatePrefs({ targetScore: nextScore })
    }
  }

  return (
    <Section
      title="行测目标分拆解与加权估分"
      description="按国省考各模块真实分值权重测算当前预估总分，自动拆解还需多对的题数与高性价比突破口。"
      actions={
        <div className="score-estimator-controls">
          <Select
            aria-label="选择分值权重方案"
            value={prefs.templateId}
            onChange={(_, data) => updatePrefs({ templateId: data.value as ScoreTemplateId })}
          >
            {Object.values(SCORE_TEMPLATES).map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.label}
              </option>
            ))}
          </Select>
          <label className="score-target-field">
            <span>目标分</span>
            <Input
              type="number"
              aria-label="目标分数"
              min={50}
              max={95}
              step={1}
              value={targetInput}
              onChange={(_, data) => {
                setTargetInput(data.value)
                const parsed = Number(data.value.trim())
                if (data.value.trim() && Number.isFinite(parsed) && parsed >= 50 && parsed <= 95) {
                  updatePrefs({ targetScore: Math.round(parsed) })
                }
              }}
              onBlur={() => commitTargetInput(targetInput)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitTargetInput(targetInput)
                }
              }}
            />
          </label>
        </div>
      }
    >
      {!hasAnySample && (
        <div className="answer-panel" style={{ marginBottom: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            当前时间周期内暂无行测刷题样本，以下预估分按各模块 50%
            基准正确率模拟展示；完成首批专项或模考后将自动更新为真实估分。
          </p>
        </div>
      )}
      <div className="score-estimator-summary">
        <div className="score-summary-metrics">
          <div className="score-metric-box">
            <span className="muted">加权预估分</span>
            <strong className={estimate.reachedTarget ? 'positive' : 'score-num-main'}>
              {estimate.estimatedTotalScore.toFixed(1)} <small>/ 100</small>
            </strong>
          </div>
          <div className="score-metric-box">
            <span className="muted">目标分数</span>
            <strong>
              {estimate.targetTotalScore} <small>分</small>
            </strong>
          </div>
          <div className="score-metric-box">
            <span className="muted">差距测算</span>
            <strong className={estimate.reachedTarget ? 'positive' : 'negative'}>
              {estimate.reachedTarget
                ? '已达标'
                : `差 ${estimate.totalGap.toFixed(1)} 分（约 ${estimate.totalQuestionsNeeded} 题）`}
            </strong>
          </div>
        </div>
        <p className="score-recommendation">
          <TrendUpIcon size={15} />
          <span>{estimate.topRecommendation}</span>
        </p>
      </div>

      <div className="table-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>模块</th>
              <th>题量 × 分值</th>
              <th>当前正确率</th>
              <th>预估 / 满分</th>
              <th>目标与差额</th>
              <th>专项突破</th>
            </tr>
          </thead>
          <tbody>
            {estimate.modules.map((mod) => (
              <tr key={mod.moduleName}>
                <td>
                  <span className="score-mod-cell">
                    <strong>{mod.moduleName}</strong>
                    {mod.recommended && (
                      <span className="score-roi-badge" title="单题分值高且提分空间大">
                        <FireIcon size={11} weight="fill" /> 优先提分
                      </span>
                    )}
                  </span>
                </td>
                <td className="muted">
                  {mod.questionCount} 题 × {mod.pointsPerQuestion} 分
                </td>
                <td>
                  <span
                    className={
                      !mod.hasData
                        ? 'muted'
                        : mod.currentAccuracy >= mod.targetAccuracy
                          ? 'positive'
                          : mod.currentAccuracy < 60
                            ? 'negative'
                            : ''
                    }
                  >
                    {mod.currentAccuracy}%
                  </span>{' '}
                  <small className="muted">
                    {!mod.hasData
                      ? '（暂无样本，按50%计）'
                      : mod.lowSample
                        ? `（仅${mod.attempts}题）`
                        : `（${mod.attempts}题）`}
                  </small>
                </td>
                <td>
                  <strong>{mod.estimatedScore.toFixed(1)}</strong>{' '}
                  <span className="muted">/ {mod.maxScore.toFixed(1)}</span>
                </td>
                <td>
                  <span className="muted">目标 {mod.targetAccuracy}%</span>
                  {mod.questionsNeeded > 0 ? (
                    <span className="score-gap-tag"> · 需多对 {mod.questionsNeeded} 题</span>
                  ) : (
                    <span className="positive"> · 已达标</span>
                  )}
                </td>
                <td>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<ArrowRightIcon />}
                    iconPosition="after"
                    onClick={() =>
                      navigate(`/practice?category=${encodeURIComponent(mod.moduleName)}`)
                    }
                  >
                    去练习
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
