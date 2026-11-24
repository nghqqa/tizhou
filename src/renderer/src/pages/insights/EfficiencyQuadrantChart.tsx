import { useMemo } from 'react'
import {
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  ZAxis
} from 'recharts'
import { useNavigate } from 'react-router-dom'
import type { ReportData } from '@shared/contracts'
import { Section } from '../../components/ui'

interface QuadrantPoint {
  category: string
  avgSeconds: number
  accuracy: number
  attempts: number
  quadrantLabel: string
  color: string
}

function classifyQuadrant(
  accuracy: number,
  avgSeconds: number,
  targetAccuracy: number,
  targetSeconds: number
): { label: string; color: string } {
  if (accuracy >= targetAccuracy && avgSeconds <= targetSeconds) {
    return { label: '稳健优势（保持手感）', color: 'var(--tz-pine)' }
  }
  if (accuracy >= targetAccuracy && avgSeconds > targetSeconds) {
    return { label: '准但偏慢（重点提速/练速算）', color: 'var(--tz-amber, #c97a16)' }
  }
  if (accuracy < targetAccuracy && avgSeconds <= targetSeconds) {
    return { label: '快而不准（防粗心与审题陷阱）', color: 'var(--tz-vermillion)' }
  }
  return { label: '慢且不准（专项补基 / 考场取舍）', color: '#8f3b5b' }
}

function QuadrantTooltip({
  active,
  payload
}: {
  active?: boolean
  payload?: Array<{ payload?: QuadrantPoint }>
}): React.JSX.Element | null {
  const item = active ? payload?.[0]?.payload : undefined
  if (!item) return null
  return (
    <div className="quadrant-tooltip">
      <strong>{item.category}</strong>
      <span>正确率：{item.accuracy}%</span>
      <span>均题耗时：{item.avgSeconds} 秒</span>
      <span>累计作答：{item.attempts} 题</span>
      <span className="quadrant-tooltip-advice">{item.quadrantLabel}</span>
    </div>
  )
}

/** 正确率 × 均题耗时四象限效率矩阵（点击模块气泡可直达对应专项训练） */
export function EfficiencyQuadrantChart({
  categoryStats
}: {
  categoryStats: ReportData['categoryStats']
}): React.JSX.Element | null {
  const navigate = useNavigate()
  const activeStats = useMemo(
    () => categoryStats.filter((item) => item.attempts > 0),
    [categoryStats]
  )

  const { points, targetAccuracy, targetSeconds, maxSeconds } = useMemo(() => {
    const accBase = 70
    const durations = activeStats.map((item) => Math.max(5, item.averageDurationSeconds))
    const avgDur = durations.length
      ? Math.round(durations.reduce((sum, sec) => sum + sec, 0) / durations.length)
      : 60
    const secBase = Math.max(45, Math.min(90, avgDur))
    const maxSec = Math.max(110, ...durations.map((sec) => Math.ceil((sec + 15) / 10) * 10))
    const built: QuadrantPoint[] = activeStats.map((item) => {
      const dur = Math.max(1, item.averageDurationSeconds)
      const q = classifyQuadrant(item.accuracy, dur, accBase, secBase)
      return {
        category: item.category,
        avgSeconds: dur,
        accuracy: item.accuracy,
        attempts: item.attempts,
        quadrantLabel: q.label,
        color: q.color
      }
    })
    return { points: built, targetAccuracy: accBase, targetSeconds: secBase, maxSeconds: maxSec }
  }, [activeStats])

  if (points.length === 0) return null

  return (
    <Section
      title="效率四象限矩阵（正确率 × 均题耗时）"
      description={`横轴为均题耗时（参照线 ${targetSeconds} 秒），纵轴为正确率（参照线 ${targetAccuracy}%）；气泡越大作答越多，点击可直达该模块专项训练。`}
    >
      <div className="quadrant-legend">
        <span className="pill positive">左上 · 准且快（优势保分）</span>
        <span className="pill warning">右上 · 准但慢（练速算提速）</span>
        <span className="pill">左下 · 快而不准（慢审防错）</span>
        <span className="pill negative">右下 · 慢且不准（补基或战略取舍）</span>
      </div>
      <div className="quadrant-chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 18, right: 24, bottom: 16, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--tz-border)" />
            <ReferenceArea
              x1={0}
              x2={targetSeconds}
              y1={targetAccuracy}
              y2={100}
              fill="rgba(45, 117, 79, 0.06)"
            />
            <ReferenceArea
              x1={targetSeconds}
              x2={maxSeconds}
              y1={0}
              y2={targetAccuracy}
              fill="rgba(191, 63, 47, 0.05)"
            />
            <XAxis
              type="number"
              dataKey="avgSeconds"
              name="均题耗时"
              domain={[0, maxSeconds]}
              tickFormatter={(value: number) => `${value}s`}
              tick={{ fill: 'var(--tz-ink-3)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="number"
              dataKey="accuracy"
              name="正确率"
              domain={[0, 100]}
              tickFormatter={(value: number) => `${value}%`}
              tick={{ fill: 'var(--tz-ink-3)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <ZAxis type="number" dataKey="attempts" range={[140, 640]} name="题量" />
            <ReferenceLine
              x={targetSeconds}
              stroke="var(--tz-border-strong)"
              strokeDasharray="4 4"
            />
            <ReferenceLine
              y={targetAccuracy}
              stroke="var(--tz-border-strong)"
              strokeDasharray="4 4"
            />
            <ChartTooltip cursor={{ strokeDasharray: '3 3' }} content={<QuadrantTooltip />} />
            <Scatter
              data={points}
              cursor="pointer"
              onClick={(entry) => {
                const candidate =
                  entry && typeof entry === 'object' && 'category' in entry
                    ? String((entry as { category?: unknown }).category ?? '')
                    : ''
                if (candidate) {
                  navigate(
                    `/practice?mode=adaptive&category=${encodeURIComponent(candidate)}&recommended=${encodeURIComponent(candidate)}`
                  )
                }
              }}
            >
              {points.map((point) => (
                <Cell key={point.category} fill={point.color} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="quadrant-chip-list">
        {points.map((point) => (
          <button
            key={point.category}
            type="button"
            className="quadrant-chip"
            onClick={() =>
              navigate(
                `/practice?mode=adaptive&category=${encodeURIComponent(point.category)}&recommended=${encodeURIComponent(point.category)}`
              )
            }
          >
            <span className="quadrant-dot" style={{ background: point.color }} />
            <strong>{point.category}</strong>
            <span className="muted">
              {point.accuracy}% · {point.avgSeconds}s · {point.attempts} 题
            </span>
          </button>
        ))}
      </div>
    </Section>
  )
}
