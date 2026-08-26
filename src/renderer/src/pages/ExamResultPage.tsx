import { useEffect, useState } from 'react'
import { Button } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  CalendarCheckIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  ExamIcon
} from '@phosphor-icons/react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ExamSession } from '@shared/contracts'
import { formatFullDate, invoke } from '../api'
import { EmptyState, ErrorState, LoadingState, Section } from '../components/ui'

export function ExamResultPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [exam, setExam] = useState<ExamSession>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    void invoke<ExamSession | null>({ method: 'exam.get', params: { examId: id } })
      .then((result) => {
        if (!result) {
          setError('未找到该场模考记录')
          return
        }
        setExam(result)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '读取模考结果失败'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <LoadingState label="正在读取模考结果" />
  if (error) return <ErrorState message={error} />
  if (!exam) return <EmptyState title="未找到模考" description="该模考可能已被清除。" />

  const totalQuestions = exam.questionIds.length
  const answeredCount = Object.keys(exam.answers).length
  const unanswered = totalQuestions - answeredCount
  const correct = exam.correctCount ?? 0
  const accuracy = totalQuestions > 0 ? Math.round((correct / totalQuestions) * 100) : 0
  const score = exam.score ?? 0
  const durationMin = exam.durationMinutes
  const actualSeconds = exam.finishedAt
    ? Math.max(
        0,
        Math.round(
          (new Date(exam.finishedAt).getTime() - new Date(exam.startedAt).getTime()) / 1000
        )
      )
    : 0
  const actualMin = Math.floor(actualSeconds / 60)
  const actualSec = actualSeconds % 60

  const stats = [
    { label: '得分', value: score, suffix: '分' },
    { label: '正确率', value: accuracy, suffix: '%' },
    { label: '正确题数', value: correct, suffix: ` / ${totalQuestions}` },
    { label: '已答', value: answeredCount, suffix: ` / ${totalQuestions}` },
    { label: '未答', value: unanswered, suffix: ' 题' },
    { label: '实际用时', value: actualMin, suffix: ` 分 ${actualSec} 秒` }
  ]

  return (
    <div className="page">
      <div className="dash-header">
        <div className="dash-header-info">
          <span className="dash-date">{formatFullDate(exam.startedAt)}</span>
          <h1 className="dash-quote">{exam.title}</h1>
          <p className="dash-subtitle">
            {exam.status === 'finished' ? '考试已完成' : '考试未完成'} · 限时 {durationMin} 分钟
          </p>
        </div>
        <div className="dash-header-action">
          <Button icon={<ArrowLeftIcon />} onClick={() => navigate('/exam')}>
            返回模考
          </Button>
        </div>
      </div>

      <div className="stat-strip">
        {stats.map((stat) => (
          <div className="stat-strip-item" key={stat.label}>
            <span className="stat-strip-label">{stat.label}</span>
            <strong className="stat-strip-value">
              {stat.value}
              <small>{stat.suffix}</small>
            </strong>
          </div>
        ))}
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <Section title="本次作答摘要">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>正确 {correct} 题</strong>
                <span>已计入学习报告和错题系统</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
            {unanswered > 0 && (
              <li className="data-row">
                <div>
                  <strong>未答 {unanswered} 题</strong>
                  <span>未作答的题目按错误计入</span>
                </div>
                <CalendarCheckIcon className="warning" />
              </li>
            )}
            <li className="data-row">
              <div>
                <strong>错题已加入复习</strong>
                <span>可在错题复习中按间隔复习</span>
              </div>
              <CalendarCheckIcon className="positive" />
            </li>
          </ul>
        </Section>
        <Section title="下一步">
          <div style={{ display: 'grid', gap: 10 }}>
            <Button
              appearance="primary"
              icon={<CalendarCheckIcon />}
              onClick={() => navigate('/review')}
            >
              进入错题复习
            </Button>
            <Button icon={<ChartLineUpIcon />} onClick={() => navigate('/reports')}>
              查看学习报告
            </Button>
            <Button icon={<ExamIcon />} onClick={() => navigate('/exam')}>
              再来一场模考
            </Button>
          </div>
        </Section>
      </div>
    </div>
  )
}
