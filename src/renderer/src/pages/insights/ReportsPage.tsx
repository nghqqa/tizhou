import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Select } from '@fluentui/react-components'
import { ArrowRightIcon, ClipboardTextIcon } from '@phosphor-icons/react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { ConstructedAttemptRecord, ReportData } from '@shared/contracts'
import { formatFullDate, invoke } from '../../api'
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  Stat
} from '../../components/ui'
import { useAppStore } from '../../store'
import { EfficiencyQuadrantChart } from './EfficiencyQuadrantChart'
import { ScoreEstimatorSection } from './ScoreEstimatorSection'

export function ReportsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const [range, setRange] = useState<ReportData['range']>('30d')
  const [report, setReport] = useState<ReportData>()
  const [essayRecords, setEssayRecords] = useState<ConstructedAttemptRecord[]>([])
  const [essayRecordsFailed, setEssayRecordsFailed] = useState(false)
  const [error, setError] = useState('')

  async function exportMarkdown(): Promise<void> {
    try {
      const savedPath = await invoke<string | undefined>({
        method: 'reports.exportMarkdown',
        params: { range }
      })
      if (savedPath) showToast('学习报告已导出')
    } catch (cause) {
      const msg = `导出失败：${cause instanceof Error ? cause.message : '未知错误'}`
      setError(msg)
      showToast(msg)
    }
  }

  async function exportToObsidian(): Promise<void> {
    try {
      const target = await invoke<string>({ method: 'reports.exportObsidian', params: { range } })
      showToast(`已导出到 Obsidian（学习报告）：${target}`)
    } catch (cause) {
      const msg = `导出到 Obsidian 失败：${cause instanceof Error ? cause.message : '未知错误'}`
      setError(msg)
      showToast(msg)
    }
  }

  useEffect(() => {
    setReport(undefined)
    setEssayRecordsFailed(false)
    setError('')
    void Promise.all([
      invoke<ReportData>({ method: 'reports.get', params: { range } }),
      invoke<ConstructedAttemptRecord[]>({
        method: 'constructed.history',
        params: { range, limit: 100 }
      })
        .then((rows) => ({ rows, failed: false }))
        .catch(() => ({ rows: [] as ConstructedAttemptRecord[], failed: true }))
    ])
      .then(([reportData, historyResult]) => {
        setReport(reportData)
        setEssayRecords(historyResult.rows)
        setEssayRecordsFailed(historyResult.failed)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '报告生成失败'))
  }, [range])

  const essaySummary = useMemo(() => {
    if (report?.essaySummary && report.essaySummary.count > 0) {
      return report.essaySummary
    }
    if (!essayRecords.length) return null
    const uniquePrompts = new Set(essayRecords.map((item) => item.promptId)).size
    const scores = essayRecords.map((item) => item.evaluation.score)
    const average = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    const best = Math.max(...scores)
    return { count: essayRecords.length, uniquePrompts, average, best }
  }, [report?.essaySummary, essayRecords])

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="提升 · 学习报告"
        title="学习报告"
        description="只统计已经提交的有效作答，未作答和草稿不会污染正确率。"
        actions={
          <>
            <Select
              value={range}
              onChange={(_, data) => setRange(data.value as ReportData['range'])}
            >
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="all">全部时间</option>
            </Select>
            <Button onClick={() => void exportMarkdown()}>导出 Markdown</Button>
            <Button
              appearance="primary"
              icon={<ClipboardTextIcon />}
              onClick={() => void exportToObsidian()}
            >
              导出到 Obsidian
            </Button>
          </>
        }
      />
      {error && <ErrorState message={error} />}
      {!report ? (
        <LoadingState label="正在聚合训练记录" />
      ) : report.totalAttempts === 0 && !essaySummary && essayRecords.length === 0 ? (
        <EmptyState
          title="还没有可分析的作答"
          description="完成一组练习或申论评估后，这里会显示模块正确率、用时趋势、错因分布与申论做题记录。"
          actionLabel="去专项练习"
          onAction={() => navigate('/practice')}
        />
      ) : (
        <>
          {report.totalAttempts > 0 && (
            <>
              <div className="stats-row">
                <Stat
                  label="有效作答"
                  value={`${report.totalAttempts} 题`}
                  detail={`${report.correctAttempts} 题正确`}
                />
                <Stat label="正确率" value={`${report.accuracy}%`} detail="按全部有效作答计算" />
                <Stat
                  label="累计投入"
                  value={`${report.studyMinutes} 分钟`}
                  detail="根据单题用时汇总"
                />
                <Stat
                  label="已标注错因"
                  value={`${report.wrongCauses.filter((item) => item.cause !== '未标注').reduce((sum, item) => sum + item.count, 0)} 次`}
                  detail="用于诊断训练障碍"
                />
              </div>
              <Section title="训练趋势" description="作答量与正确率使用不同坐标轴。">
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={report.dailyStats}
                      margin={{ top: 12, right: 16, bottom: 0, left: -12 }}
                    >
                      <CartesianGrid vertical={false} stroke="var(--tz-border)" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value: string) => value.slice(5)}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: 'var(--tz-ink-3)', fontSize: 11 }}
                      />
                      <YAxis
                        yAxisId="left"
                        allowDecimals={false}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: 'var(--tz-ink-3)', fontSize: 11 }}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[0, 100]}
                        tickFormatter={(value: number) => `${value}%`}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: 'var(--tz-ink-3)', fontSize: 11 }}
                      />
                      <ChartTooltip
                        contentStyle={{
                          background: 'var(--tz-surface)',
                          border: '1px solid var(--tz-border-strong)',
                          borderRadius: 6,
                          fontSize: 12
                        }}
                      />
                      <Legend verticalAlign="top" height={28} />
                      <Bar
                        yAxisId="left"
                        dataKey="attempts"
                        name="题数"
                        fill="var(--tz-vermillion)"
                        radius={[3, 3, 0, 0]}
                        maxBarSize={48}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="accuracy"
                        name="正确率"
                        stroke="var(--tz-pine)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Section>
              <EfficiencyQuadrantChart categoryStats={report.categoryStats} />
              <ScoreEstimatorSection categoryStats={report.categoryStats} />
              <div className="grid two">
                <Section title="模块表现">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>模块</th>
                        <th>作答</th>
                        <th>正确率</th>
                        <th>均时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.categoryStats.map((item) => (
                        <tr key={item.category}>
                          <td>{item.category}</td>
                          <td>{item.attempts}</td>
                          <td
                            className={
                              item.accuracy >= 75
                                ? 'positive'
                                : item.accuracy < 60
                                  ? 'negative'
                                  : ''
                            }
                          >
                            {item.accuracy}%
                          </td>
                          <td>{item.averageDurationSeconds} 秒</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
                <Section title="错误原因">
                  <ul className="data-list">
                    {report.wrongCauses.map((item) => (
                      <li className="data-row" key={item.cause}>
                        <div>
                          <strong>{item.cause}</strong>
                          <span>
                            {report.totalAttempts
                              ? Math.round((item.count / report.totalAttempts) * 100)
                              : 0}
                            % 的全部作答
                          </span>
                        </div>
                        <strong>{item.count}</strong>
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            </>
          )}
          {essaySummary && (
            <Section
              title="申论作答记录"
              description={
                `累计评估 ${essaySummary.count} 次 · 覆盖 ${essaySummary.uniquePrompts} 题 · 平均 ${essaySummary.average} 分 · 最高 ${essaySummary.best} 分` +
                (essayRecordsFailed
                  ? '（明细列表加载失败，上方汇总统计不受影响）'
                  : essaySummary.count > essayRecords.length
                    ? `（下表展示最近 ${essayRecords.length} 条明细）`
                    : '')
              }
            >
              <div className="table-scroll">
                <table className="report-table report-table-essay">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>题目</th>
                      <th>字数</th>
                      <th>评估方式</th>
                      <th>得分</th>
                      <th>复盘</th>
                    </tr>
                  </thead>
                  <tbody>
                    {essayRecords.map((record) => {
                      const score = record.evaluation.score
                      const wordCount = record.content.replace(/\s/g, '').length
                      return (
                        <tr key={record.id}>
                          <td className="muted">{formatFullDate(record.createdAt)}</td>
                          <td>
                            <span className="table-title-ellipsis" title={record.title}>
                              {record.title}
                            </span>
                          </td>
                          <td>{wordCount} 字</td>
                          <td className="muted">{record.evaluation.provider}</td>
                          <td className={score >= 80 ? 'positive' : score < 60 ? 'negative' : ''}>
                            {score} 分
                          </td>
                          <td>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<ArrowRightIcon />}
                              iconPosition="after"
                              onClick={() =>
                                navigate(
                                  `/shenlun-solution?promptId=${encodeURIComponent(record.promptId)}`
                                )
                              }
                            >
                              查看复盘
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
