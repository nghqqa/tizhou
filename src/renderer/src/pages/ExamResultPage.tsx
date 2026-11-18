import { useEffect, useMemo, useState } from 'react'
import { Button, Select } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  CalendarCheckIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  ExamIcon
} from '@phosphor-icons/react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ExamSession, Question } from '@shared/contracts'
import { formatFullDate, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { OptionContent } from '../components/OptionContent'
import { EmptyState, ErrorState, LoadingState, Section } from '../components/ui'

/** 与交卷判分同口径：去空格、大写、去重、排序后比较 */
function isAnswerCorrect(question: Question, answer: string[]): boolean {
  const normalize = (values: string[]) =>
    [...new Set(values.map((value) => value.trim().toUpperCase()))].sort()
  return (
    JSON.stringify(normalize(answer)) === JSON.stringify(normalize(question.answer)) &&
    answer.length > 0
  )
}

type ReviewFilter = 'all' | 'wrong-unanswered'

export function ExamResultPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [exam, setExam] = useState<ExamSession>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ReviewFilter>('all')

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

  /** 逐题复盘条目：快照 + 作答 + 判分（与交卷口径一致，未作答按错误计） */
  const reviewItems = useMemo(() => {
    if (!exam) return []
    return exam.questionIds.flatMap((questionId, index) => {
      const snapshot = exam.questionSnapshots[questionId]
      if (!snapshot) return []
      const userAnswer = exam.answers[questionId]?.answer ?? []
      return [
        {
          index: index + 1,
          question: snapshot,
          userAnswer,
          answered: userAnswer.length > 0,
          correct: isAnswerCorrect(snapshot, userAnswer)
        }
      ]
    })
  }, [exam])

  /** 各模块（category）正确率分布 */
  const categoryStats = useMemo(() => {
    const byCategory = new Map<string, { attempts: number; correct: number }>()
    for (const item of reviewItems) {
      const entry = byCategory.get(item.question.category) ?? { attempts: 0, correct: 0 }
      entry.attempts += 1
      if (item.correct) entry.correct += 1
      byCategory.set(item.question.category, entry)
    }
    return [...byCategory.entries()]
      .map(([category, stat]) => ({
        category,
        ...stat,
        accuracy: stat.attempts ? Math.round((stat.correct / stat.attempts) * 100) : 0
      }))
      .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
  }, [reviewItems])

  const filteredItems =
    filter === 'wrong-unanswered' ? reviewItems.filter((item) => !item.correct) : reviewItems

  if (loading)
    return (
      <div className="page">
        <LoadingState label="正在读取模考结果" />
      </div>
    )
  if (error)
    return (
      <div className="page">
        <ErrorState message={error} />
      </div>
    )
  if (!exam)
    return (
      <div className="page">
        <EmptyState title="未找到模考" description="该模考可能已被清除。" />
      </div>
    )

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

      <div className="grid two">
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
        <Section title="模块正确率分布" description="按快照分类统计，弱项模块排前。">
          {categoryStats.length ? (
            <div className="mastery-list">
              {categoryStats.map((item) => (
                <div className="mastery-row" key={item.category}>
                  <div className="mastery-info">
                    <strong>{item.category}</strong>
                    <span className="mastery-detail">
                      {item.correct}/{item.attempts} 正确
                    </span>
                  </div>
                  <div className="mastery-bar-wrap">
                    <div className="mastery-bar">
                      <div className="mastery-bar-fill" style={{ width: `${item.accuracy}%` }} />
                    </div>
                    <span className="mastery-percent">{item.accuracy}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">本场模考没有可用的题目快照。</p>
          )}
        </Section>
      </div>

      <div style={{ marginTop: 16 }}>
        <Section
          title="逐题复盘"
          description="基于交卷时的题目快照展示每题作答、参考答案与解析。"
          actions={
            <Select
              value={filter}
              onChange={(_, data) => setFilter(data.value as ReviewFilter)}
              aria-label="复盘筛选"
            >
              <option value="all">全部题目</option>
              <option value="wrong-unanswered">仅看错题与未答</option>
            </Select>
          }
        >
          {filteredItems.length ? (
            filteredItems.map((item) => (
              <div className="answer-panel" key={item.question.id}>
                <h3 className={item.correct ? 'positive' : 'negative'}>
                  第 {item.index} 题：{item.answered ? (item.correct ? '正确' : '错误') : '未作答'}
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                    {item.question.category}
                  </span>
                </h3>
                {item.question.material && (
                  <>
                    <strong>给定材料</strong>
                    <MarkdownContent
                      content={item.question.material}
                      sourceFilePath={item.question.filePath}
                    />
                  </>
                )}
                <MarkdownContent
                  className="question-stem"
                  content={item.question.stem}
                  sourceFilePath={item.question.filePath}
                />
                {item.question.options.length > 0 && (
                  <div className="review-options">
                    {item.question.options.map((option) => {
                      const isAnswer = item.question.answer.includes(option.key)
                      const isChosen = item.userAnswer.includes(option.key)
                      return (
                        <div
                          key={option.key}
                          className={`review-option ${
                            isAnswer ? 'correct' : isChosen ? 'wrong' : ''
                          }`.trim()}
                        >
                          <span className="option-key">{option.key}</span>
                          <OptionContent option={option} sourceFilePath={item.question.filePath} />
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
                  你的作答：{item.userAnswer.length ? item.userAnswer.join('、') : '未作答'} ·
                  参考答案：{item.question.answer.join('、') || '无'}
                </p>
                <MarkdownContent
                  content={item.question.explanation}
                  sourceFilePath={item.question.filePath}
                />
              </div>
            ))
          ) : (
            <EmptyState
              title={filter === 'wrong-unanswered' ? '没有错题' : '没有可复盘的题目'}
              description={
                filter === 'wrong-unanswered'
                  ? '本场模考全部答对，切换筛选可查看全部题目。'
                  : '该场模考没有保存题目快照。'
              }
            />
          )}
        </Section>
      </div>

      <div style={{ marginTop: 16 }}>
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
