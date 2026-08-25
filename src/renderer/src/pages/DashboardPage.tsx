import { Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowRightIcon,
  BookOpenTextIcon,
  BrainIcon,
  CalendarCheckIcon,
  ChartLineUpIcon,
  ExamIcon,
  PlayIcon,
  TargetIcon
} from '@phosphor-icons/react'
import { useNavigate } from 'react-router-dom'
import { formatDate } from '../api'
import { Section } from '../components/ui'
import { useAppStore } from '../store'
import type { DashboardData } from '@shared/contracts'

const DAILY_QUOTES = [
  '不积跬步，无以至千里',
  '学然后知不足，教然后知困',
  '博学之，审问之，慎思之，明辨之，笃行之',
  '业精于勤，荒于嬉',
  '锲而不舍，金石可镂',
  '千里之行，始于足下',
  '温故而知新，可以为师矣'
]

const SUBJECT_LABELS: Record<string, string> = {
  xingce: '行测',
  shenlun: '申论',
  common: '公基'
}

function getQuote(): string {
  const day = new Date().getDate()
  return DAILY_QUOTES[day % DAILY_QUOTES.length]!
}

function formatToday(): string {
  const now = new Date()
  const weeks = ['日', '一', '二', '三', '四', '五', '六']
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${weeks[now.getDay()]}`
}

/** 从科目掌握数据中找到最值得补强的科目 */
function findWeakest(dashboard: DashboardData): { subject: string; accuracy: number; attempts: number } | undefined {
  const mastered = dashboard.subjectMastery.filter((item) => item.attempts > 0)
  if (!mastered.length) return undefined
  return mastered.reduce((weakest, item) =>
    item.accuracy < weakest.accuracy ? item : weakest
  )
}

/** 生成最近 14 天的日历格子数据 */
function buildCalendar(dashboard: DashboardData): Array<{ date: string; attempts: number; accuracy: number; isToday: boolean }> {
  const activityMap = new Map(dashboard.activity.map((item) => [item.date, item]))
  const cells: Array<{ date: string; attempts: number; accuracy: number; isToday: boolean }> = []
  const today = new Date()
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const dateStr = date.toISOString().slice(0, 10)
    const activity = activityMap.get(dateStr)
    cells.push({
      date: dateStr,
      attempts: activity?.attempts ?? 0,
      accuracy: activity?.accuracy ?? 0,
      isToday: offset === 0
    })
  }
  return cells
}

function StatStrip({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const targetProgress = dashboard.dailyTarget ? dashboard.todayAttempts / dashboard.dailyTarget : 0
  const reviewProgress = dashboard.dueReviews > 0 ? 1 : 0
  const items = [
    {
      label: '今日完成',
      value: dashboard.todayAttempts,
      unit: `/${dashboard.dailyTarget} 题`,
      progress: Math.min(1, targetProgress),
      progressLabel: `${Math.round(targetProgress * 100)}%`
    },
    {
      label: '累计正确率',
      value: dashboard.accuracy,
      unit: '%',
      progress: dashboard.accuracy / 100,
      progressLabel: dashboard.todayAttempts > 0 ? '基于全部有效作答' : '完成首组训练后生成'
    },
    {
      label: '到期复习',
      value: dashboard.dueReviews,
      unit: dashboard.dueReviews ? ' 题' : '',
      progress: reviewProgress,
      progressLabel: dashboard.dueReviews ? '待处理' : '暂无到期'
    },
    {
      label: '今日投入',
      value: dashboard.todayMinutes,
      unit: ' 分钟',
      progress: dashboard.todayMinutes > 0 ? Math.min(1, dashboard.todayMinutes / 60) : 0,
      progressLabel: `连续 ${dashboard.studyStreak} 天`
    }
  ]
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div className="stat-strip-item" key={item.label}>
          <span className="stat-strip-label">{item.label}</span>
          <strong className="stat-strip-value">
            {item.value}
            <small>{item.unit}</small>
          </strong>
          <div className="stat-strip-bar">
            <div className="stat-strip-bar-fill" style={{ width: `${item.progress * 100}%` }} />
          </div>
          {item.progressLabel && (
            <span className="stat-strip-detail">{item.progressLabel}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function TrainingRhythm({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const cells = buildCalendar(dashboard)
  const hasData = cells.some((cell) => cell.attempts > 0)
  const maxAttempts = Math.max(...cells.map((cell) => cell.attempts), 1)
  return (
    <Section
      title="近两周训练节奏"
      description={hasData ? '格色深浅表示当日题量，悬停查看详情。' : '完成第一组训练后开始记录。'}
    >
      <div className="calendar-strip" role="img" aria-label="近14天训练节奏">
        {cells.map((cell) => {
          const intensity = cell.attempts > 0 ? Math.max(0.25, cell.attempts / maxAttempts) : 0
          const className = [
            'calendar-cell',
            cell.isToday ? ' calendar-cell-today' : '',
            cell.attempts > 0 && !cell.isToday ? ' calendar-cell-active' : '',
            cell.attempts === 0 && !cell.isToday ? ' calendar-cell-empty' : ''
          ].join('')
          return (
            <div
              key={cell.date}
              className={className}
              style={cell.attempts > 0 && !cell.isToday ? { opacity: intensity } : undefined}
              title={`${cell.date.slice(5)} · ${cell.attempts} 题${cell.accuracy ? ` · 正确率 ${cell.accuracy}%` : ''}`}
            >
              <span className="calendar-cell-num">{cell.attempts || ''}</span>
            </div>
          )
        })}
      </div>
      <div className="calendar-legend">
        <span className="calendar-legend-item"><i className="calendar-cell calendar-cell-today" style={{width:10,height:10}} />今天</span>
        <span className="calendar-legend-item"><i className="calendar-cell calendar-cell-active" style={{width:10,height:10,opacity:0.7}} />已训练</span>
        <span className="calendar-legend-item"><i className="calendar-cell calendar-cell-empty" style={{width:10,height:10}} />未训练</span>
      </div>
    </Section>
  )
}

function SubjectMastery({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const navigate = useNavigate()
  const weakest = findWeakest(dashboard)
  return (
    <Section
      title="科目掌握"
      description={weakest ? `掌握度最低：${SUBJECT_LABELS[weakest.subject] ?? weakest.subject}，建议优先补强。` : '完成训练后按真实作答计算。'}
    >
      {dashboard.subjectMastery.length ? (
        <div className="mastery-list">
          {dashboard.subjectMastery.map((item) => {
            const label = SUBJECT_LABELS[item.subject] ?? item.subject
            const isWeak = weakest?.subject === item.subject
            return (
              <div className={`mastery-row ${isWeak ? 'mastery-row-weak' : ''}`} key={item.subject}>
                <div className="mastery-info">
                  <strong>{label}</strong>
                  {isWeak && <span className="mastery-tag">优先补强</span>}
                  <span className="mastery-detail">
                    {item.attempts > 0 ? `${item.attempts} 次作答` : '尚未训练'}
                  </span>
                </div>
                <div className="mastery-bar-wrap">
                  <div className="mastery-bar">
                    <div className="mastery-bar-fill" style={{ width: `${item.accuracy}%` }} />
                  </div>
                  <span className="mastery-percent">{item.attempts > 0 ? `${item.accuracy}%` : '—'}</span>
                </div>
                <Button
                  size="small"
                  appearance={isWeak ? 'primary' : 'subtle'}
                  onClick={() => navigate('/practice')}
                >
                  {isWeak ? '补强' : '训练'}
                </Button>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="empty-state" style={{ minHeight: 100 }}>
          <TargetIcon size={24} className="muted" />
          <h3>尚无掌握数据</h3>
          <Button appearance="primary" size="small" onClick={() => navigate('/practice')}>
            开始第一组训练
          </Button>
        </div>
      )}
      <div className="mastery-actions">
        <Button
          appearance="subtle"
          icon={<BookOpenTextIcon />}
          onClick={() => navigate('/review')}
        >
          {dashboard.dueReviews ? `${dashboard.dueReviews} 题待复习` : '错题复习'}
        </Button>
        <Button
          appearance="subtle"
          icon={<ChartLineUpIcon />}
          onClick={() => navigate('/diagnosis')}
        >
          能力诊断
        </Button>
        <Button
          appearance="subtle"
          icon={<BrainIcon />}
          onClick={() => navigate('/ai')}
        >
          AI 助教
        </Button>
      </div>
    </Section>
  )
}

export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)!
  const refresh = useAppStore((state) => state.refreshDashboard)
  const dashboard = data.dashboard
  const weakest = findWeakest(dashboard)
  const estimatedMinutes = Math.max(5, Math.round((dashboard.dailyTarget - dashboard.todayAttempts) * 0.8))
  const remaining = Math.max(0, dashboard.dailyTarget - dashboard.todayAttempts)

  return (
    <div className="page">
      {/* 页头：日期 + 寄语 + 主操作 */}
      <div className="dash-header">
        <div className="dash-header-info">
          <span className="dash-date">{formatToday()}</span>
          <h1 className="dash-quote">{getQuote()}</h1>
          <p className="dash-subtitle">
            {dashboard.totalQuestions > 0
              ? `知识库 ${dashboard.totalQuestions} 道题 · 连续学习 ${dashboard.studyStreak} 天`
              : '先导入题库，再开始训练'}
          </p>
        </div>
        <div className="dash-header-action">
          <Button
            appearance="primary"
            size="large"
            icon={<PlayIcon weight="fill" />}
            onClick={() => navigate('/practice')}
          >
            开始训练
          </Button>
          <span className="dash-target">
            今日 {dashboard.dailyTarget} 题 · 预计 {estimatedMinutes} 分钟
          </span>
        </div>
      </div>

      {/* 今日任务主区 */}
      <div className="today-task">
        <div className="today-task-info">
          <span className="today-task-label">今日先补</span>
          <strong className="today-task-subject">
            {weakest
              ? `${SUBJECT_LABELS[weakest.subject] ?? weakest.subject}`
              : '行测 · 任意模块'}
          </strong>
          <span className="today-task-detail">
            {weakest
              ? `正确率 ${weakest.accuracy}% · 建议 ${Math.min(12, remaining || 10)} 题`
              : remaining > 0
                ? `还差 ${remaining} 题达成今日目标`
                : '今日目标已达成，可安排模考或复习'}
          </span>
        </div>
        <div className="today-task-actions">
          <Button
            appearance="primary"
            icon={<TargetIcon weight="fill" />}
            onClick={() => navigate('/practice')}
          >
            {weakest ? `补 ${SUBJECT_LABELS[weakest.subject] ?? '薄弱科目'}` : '开始训练'}
          </Button>
          {dashboard.dueReviews > 0 && (
            <Button
              icon={<CalendarCheckIcon />}
              onClick={() => navigate('/review')}
            >
              复习 {dashboard.dueReviews} 题
            </Button>
          )}
        </div>
      </div>

      {/* 统计带 */}
      <StatStrip dashboard={dashboard} />

      {/* 训练节奏 + 科目掌握 */}
      <div className="dashboard-grid" style={{ marginTop: 14 }}>
        <TrainingRhythm dashboard={dashboard} />
        <SubjectMastery dashboard={dashboard} />
      </div>

      {/* 继续进行 + 最近作答 */}
      <div className="grid two" style={{ marginTop: 14 }}>
        <Section title="继续进行">
          {dashboard.activeExam ? (
            <div>
              <div className="data-row">
                <div>
                  <strong>{dashboard.activeExam.title}</strong>
                  <span>
                    已答 {Object.keys(dashboard.activeExam.answers).length}/
                    {dashboard.activeExam.questionIds.length} 题
                  </span>
                </div>
                <ExamIcon size={20} className="accent" />
              </div>
              <Button
                appearance="primary"
                style={{ marginTop: 12 }}
                onClick={() => navigate('/exam/run')}
              >
                继续模考
              </Button>
            </div>
          ) : dashboard.activePlan ? (
            <div>
              <div className="data-row">
                <div>
                  <strong>{dashboard.activePlan.title}</strong>
                  <span>{dashboard.activePlan.focus.join(' · ')}</span>
                </div>
                <BrainIcon size={20} className="accent" />
              </div>
              <ProgressBar
                value={
                  dashboard.activePlan.items.filter((item) => item.done).length /
                  dashboard.activePlan.items.length
                }
                style={{ marginTop: 12 }}
              />
              <Button style={{ marginTop: 12 }} onClick={() => navigate('/diagnosis')}>
                查看计划
              </Button>
            </div>
          ) : (
            <div className="empty-state" style={{ minHeight: 100 }}>
              <h3>今天已无待办</h3>
              <p>可以安排一场模考检验水平。</p>
              <Button size="small" onClick={() => navigate('/exam')}>
                安排模考
              </Button>
            </div>
          )}
        </Section>
        <Section
          title="最近作答"
          actions={
            <Button appearance="subtle" size="small" onClick={() => void refresh()}>
              刷新
            </Button>
          }
        >
          {dashboard.recentAttempts.length ? (
            <ul className="data-list data-list-scroll">
              {dashboard.recentAttempts.slice(0, 8).map((attempt) => (
                <li className="data-row" key={attempt.id}>
                  <div>
                    <strong>{attempt.questionTitle}</strong>
                    <span>{formatDate(attempt.createdAt)}</span>
                  </div>
                  <span className={attempt.correct ? 'positive' : 'negative'}>
                    {attempt.correct ? '✓ 正确' : '✗ 错误'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state" style={{ minHeight: 100 }}>
              <h3>暂无作答记录</h3>
              <p>完成一道题后，这里会保留你的错题和笔记。</p>
              <Button size="small" appearance="primary" onClick={() => navigate('/practice')}>
                开始第一组训练
              </Button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
