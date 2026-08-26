import { Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowRightIcon,
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
  return DAILY_QUOTES[new Date().getDate() % DAILY_QUOTES.length]!
}

function formatToday(): string {
  const now = new Date()
  const weeks = ['日', '一', '二', '三', '四', '五', '六']
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${weeks[now.getDay()]}`
}

function findWeakest(dashboard: DashboardData): { subject: string; accuracy: number; attempts: number } | undefined {
  const mastered = dashboard.subjectMastery.filter((item) => item.attempts > 0)
  if (!mastered.length) return undefined
  return mastered.reduce((weakest, item) => (item.accuracy < weakest.accuracy ? item : weakest))
}

function buildCalendar(dashboard: DashboardData): Array<{ date: string; attempts: number; accuracy: number; isToday: boolean }> {
  const activityMap = new Map(dashboard.activity.map((item) => [item.date, item]))
  const cells: Array<{ date: string; attempts: number; accuracy: number; isToday: boolean }> = []
  const today = new Date()
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const dateStr = date.toISOString().slice(0, 10)
    const activity = activityMap.get(dateStr)
    cells.push({ date: dateStr, attempts: activity?.attempts ?? 0, accuracy: activity?.accuracy ?? 0, isToday: offset === 0 })
  }
  return cells
}

/* ── 统计带 ────────────────────────────────────────────── */
function StatStrip({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const targetProgress = dashboard.dailyTarget ? dashboard.todayAttempts / dashboard.dailyTarget : 0
  const items = [
    { label: '今日完成', value: dashboard.todayAttempts, suffix: ` / ${dashboard.dailyTarget} 题`, progress: Math.min(1, targetProgress), detail: dashboard.todayAttempts >= dashboard.dailyTarget ? '已达成' : `还差 ${Math.max(0, dashboard.dailyTarget - dashboard.todayAttempts)} 题` },
    { label: '累计正确率', value: dashboard.accuracy, suffix: '%', progress: dashboard.accuracy / 100, detail: dashboard.todayAttempts > 0 ? '全部有效作答' : '暂无数据' },
    { label: '到期复习', value: dashboard.dueReviews, suffix: ' 题', progress: dashboard.dueReviews > 0 ? 1 : 0, detail: dashboard.dueReviews > 0 ? '待处理' : '暂无到期' },
    { label: '今日投入', value: dashboard.todayMinutes, suffix: ' 分钟', progress: Math.min(1, dashboard.todayMinutes / 60), detail: `连续 ${dashboard.studyStreak} 天` }
  ]
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div className="stat-strip-item" key={item.label}>
          <span className="stat-strip-label">{item.label}</span>
          <strong className="stat-strip-value">
            {item.value}
            <small>{item.suffix}</small>
          </strong>
          <div className="stat-strip-bar">
            <div className="stat-strip-bar-fill" style={{ width: `${item.progress * 100}%` }} />
          </div>
          <span className="stat-strip-detail">{item.detail}</span>
        </div>
      ))}
    </div>
  )
}

/* ── 训练节奏 ──────────────────────────────────────────── */
function TrainingRhythm({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const navigate = useNavigate()
  const cells = buildCalendar(dashboard)
  const hasData = cells.some((c) => c.attempts > 0)
  const maxAttempts = Math.max(...cells.map((c) => c.attempts), 1)
  const lastTrained = cells.filter((c) => c.attempts > 0).pop()
  return (
    <Section
      title="训练节奏"
      description={`连续 ${dashboard.studyStreak} 天${lastTrained ? ` · 最近 ${lastTrained.attempts} 题` : ' · 尚未开始'}`}
    >
      <div className="calendar-strip" role="img" aria-label="近14天训练节奏">
        {cells.map((cell) => {
          const intensity = cell.attempts > 0 ? Math.max(0.3, cell.attempts / maxAttempts) : 0
          const cls = [
            'calendar-cell',
            cell.isToday ? 'calendar-cell-today' : cell.attempts > 0 ? 'calendar-cell-active' : 'calendar-cell-empty'
          ].join(' ')
          return (
            <div
              key={cell.date}
              className={cls}
              style={cell.attempts > 0 && !cell.isToday ? { opacity: intensity } : undefined}
              title={`${cell.date} · ${cell.attempts} 题${cell.accuracy ? ` · 正确率 ${cell.accuracy}%` : ' · 未训练'}`}
            >
              <span className="calendar-cell-num">{cell.attempts || ''}</span>
              <span className="calendar-cell-day">{Number(cell.date.slice(8))}</span>
            </div>
          )
        })}
      </div>
      <div className="calendar-axis">
        <span>14 天前</span>
        <span>7 天前</span>
        <span>今天</span>
      </div>
      {!hasData && (
        <div className="empty-compact" style={{ marginTop: 8 }}>
          <span>完成第一组训练后开始记录</span>
          <button type="button" className="mastery-action" onClick={() => navigate('/practice')}>
            开始 <ArrowRightIcon size={12} />
          </button>
        </div>
      )}
    </Section>
  )
}

/* ── 科目掌握 ──────────────────────────────────────────── */
function SubjectMastery({ dashboard }: { dashboard: DashboardData }): React.JSX.Element {
  const navigate = useNavigate()
  const weakest = findWeakest(dashboard)
  const hasData = dashboard.subjectMastery.some((item) => item.attempts > 0)
  const sorted = [...dashboard.subjectMastery].sort((a, b) => {
    if (a.attempts === 0 && b.attempts === 0) return 0
    if (a.attempts === 0) return 1
    if (b.attempts === 0) return -1
    return a.accuracy - b.accuracy
  })
  if (!hasData) {
    return (
      <Section title="科目掌握" description="能力画像来自真实作答">
        <div className="empty-compact">
          <TargetIcon size={22} className="muted" />
          <div>
            <strong>完成第一组训练，开始建立能力画像</strong>
            <p>系统根据正确率和错题自动生成各科目掌握度。</p>
          </div>
          <button type="button" className="mastery-action" onClick={() => navigate('/practice')}>
            开始第一组训练 <ArrowRightIcon size={12} />
          </button>
        </div>
      </Section>
    )
  }
  return (
    <Section title="科目掌握" description={weakest ? `「${SUBJECT_LABELS[weakest.subject] ?? weakest.subject}」掌握度最低，建议优先补强。` : undefined}>
      <div className="mastery-list">
        {sorted.map((item) => {
          const label = SUBJECT_LABELS[item.subject] ?? item.subject
          const isWeak = weakest?.subject === item.subject
          return (
            <div className={`mastery-row ${isWeak ? 'mastery-row-weak' : ''}`} key={item.subject}>
              <div className="mastery-info">
                <strong>
                  {label}
                  {isWeak && <span className="mastery-tag">优先补强</span>}
                </strong>
                <span className="mastery-detail">{item.attempts} 次作答</span>
              </div>
              <div className="mastery-bar-wrap">
                <div className="mastery-bar">
                  <div className="mastery-bar-fill" style={{ width: `${item.accuracy}%` }} />
                </div>
                <span className="mastery-percent">{item.accuracy}%</span>
              </div>
              <button
                type="button"
                className="mastery-action"
                onClick={() =>
                  navigate(
                    `/practice?mode=adaptive&count=${Math.min(12, item.attempts > 0 ? 10 : 10)}&subject=${item.subject}&recommended=${SUBJECT_LABELS[item.subject] ?? item.subject}`
                  )
                }
              >
                {isWeak ? '补强' : '训练'} <ArrowRightIcon size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="mastery-actions">
        <button type="button" className="mastery-action" onClick={() => navigate('/review')}>
          {dashboard.dueReviews ? `${dashboard.dueReviews} 题待复习` : '错题复习'} <ArrowRightIcon size={12} />
        </button>
        <button type="button" className="mastery-action" onClick={() => navigate('/diagnosis')}>
          能力诊断 <ArrowRightIcon size={12} />
        </button>
      </div>
    </Section>
  )
}

/* ── 首页 ──────────────────────────────────────────────── */
export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)!
  const refresh = useAppStore((state) => state.refreshDashboard)
  const dashboard = data.dashboard
  const weakest = findWeakest(dashboard)
  const hasTraining = dashboard.todayAttempts > 0 || dashboard.subjectMastery.some((s) => s.attempts > 0)
  const remaining = Math.max(0, dashboard.dailyTarget - dashboard.todayAttempts)
  const suggestCount = weakest ? Math.min(12, remaining || 10) : 10
  const estimatedMin = Math.max(5, Math.round(suggestCount * 0.8))

  return (
    <div className="page">
      {/* 页头 */}
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
            onClick={() =>
              navigate(
                `/practice?mode=adaptive&count=${remaining || 10}${
                  weakest ? `&subject=${weakest.subject}&recommended=${SUBJECT_LABELS[weakest.subject] ?? weakest.subject}` : ''
                }`
              )
            }
          >
            开始训练
          </Button>
          <span className="dash-target">
            今日目标 {dashboard.dailyTarget} 题 · 预计 {estimatedMin} 分钟
          </span>
        </div>
      </div>

      {/* 今日任务主区 */}
      <div className="today-task">
        <div className="today-task-info">
          {hasTraining && weakest ? (
            <>
              <span className="today-task-label">今日补强</span>
              <strong className="today-task-subject">
                {SUBJECT_LABELS[weakest.subject] ?? weakest.subject}
              </strong>
              <span className="today-task-detail">
                正确率 {weakest.accuracy}% · 建议 {suggestCount} 题 · 约 {estimatedMin} 分钟
              </span>
            </>
          ) : (
            <>
              <span className="today-task-label">今日任务</span>
              <strong className="today-task-subject">完成第一组训练</strong>
              <span className="today-task-detail">
                完成 10 题后，系统会根据正确率生成你的补强建议
              </span>
            </>
          )}
        </div>
        <div className="today-task-actions">
          <Button
            appearance={hasTraining ? 'secondary' : 'primary'}
            icon={<TargetIcon weight="fill" />}
            onClick={() =>
              navigate(
                `/practice?mode=adaptive&count=${suggestCount}${
                  weakest ? `&subject=${weakest.subject}&recommended=${SUBJECT_LABELS[weakest.subject] ?? weakest.subject}` : '&recommended=首组训练'
                }`
              )
            }
          >
            {hasTraining ? `补 ${SUBJECT_LABELS[weakest?.subject ?? 'xingce'] ?? '薄弱科目'}` : '开始第一组训练'}
          </Button>
          {dashboard.dueReviews > 0 && (
            <Button
              appearance="subtle"
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

      {/* 节奏 + 掌握 */}
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
                    已答 {Object.keys(dashboard.activeExam.answers).length} of{' '}
                    {dashboard.activeExam.questionIds.length} 题
                  </span>
                </div>
                <ExamIcon size={20} className="accent" />
              </div>
              <ProgressBar
                value={Object.keys(dashboard.activeExam.answers).length / dashboard.activeExam.questionIds.length}
                style={{ marginTop: 10 }}
              />
              <button type="button" className="mastery-action" style={{ marginTop: 10 }} onClick={() => navigate('/exam/run')}>
                继续模考 <ArrowRightIcon size={12} />
              </button>
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
                value={dashboard.activePlan.items.filter((i) => i.done).length / dashboard.activePlan.items.length}
                style={{ marginTop: 10 }}
              />
              <button type="button" className="mastery-action" style={{ marginTop: 10 }} onClick={() => navigate('/diagnosis')}>
                查看计划 <ArrowRightIcon size={12} />
              </button>
            </div>
          ) : (
            <div className="empty-compact">
              <span>今天还没有训练记录</span>
              <button type="button" className="mastery-action" onClick={() => navigate('/practice')}>
                开始训练 <ArrowRightIcon size={12} />
              </button>
            </div>
          )}
        </Section>
        <Section
          title="最近作答"
          actions={
            <button type="button" className="mastery-action" onClick={() => void refresh()}>
              刷新
            </button>
          }
        >
          {dashboard.recentAttempts.length ? (
            <ul className="data-list data-list-scroll">
              {dashboard.recentAttempts.slice(0, 6).map((attempt) => (
                <li className="data-row" key={attempt.id}>
                  <div>
                    <strong>{attempt.questionTitle}</strong>
                    <span>{formatDate(attempt.createdAt)}</span>
                  </div>
                  <span className={attempt.correct ? 'positive' : 'negative'}>
                    {attempt.correct ? '✓' : '✗'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-compact">
              <span>完成一道题后，这里会保留你的错题和笔记</span>
              <button type="button" className="mastery-action" onClick={() => navigate('/practice')}>
                开始 <ArrowRightIcon size={12} />
              </button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
