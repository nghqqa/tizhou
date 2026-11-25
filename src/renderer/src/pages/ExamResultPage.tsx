import { useEffect, useMemo, useState } from 'react'
import { Button, Field, Select, Textarea } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  BookmarkSimpleIcon,
  CalendarCheckIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  ClockCountdownIcon,
  ExamIcon,
  NotePencilIcon,
  RobotIcon,
  TargetIcon
} from '@phosphor-icons/react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ExamSession, PracticeSession, Question, QuestionUserMeta } from '@shared/contracts'
import { WRONG_CAUSE_OPTIONS, formatDurationBrief, isAnswerCorrect } from '@shared/study-constants'
import { formatFullDate, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { OptionContent } from '../components/OptionContent'
import { ReadingTypographyBar, useReadingTypography } from '../components/ReadingTypographyControl'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { analyzeExamSunkCost } from '../services/exam-sunk-cost'
import { useAppStore } from '../store'
import { ShenlunPointChecklist } from './shenlun/ShenlunPointChecklist'

type ReviewFilter = 'all' | 'wrong-unanswered'

export function ExamResultPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const reading = useReadingTypography()
  const [exam, setExam] = useState<ExamSession>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [userMeta, setUserMeta] = useState<Record<string, QuestionUserMeta>>({})
  const [userMetaLoaded, setUserMetaLoaded] = useState(false)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [openNoteIds, setOpenNoteIds] = useState<Record<string, boolean>>({})
  const [savingNoteId, setSavingNoteId] = useState('')
  const [redoBusy, setRedoBusy] = useState(false)
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [enqueuedDone, setEnqueuedDone] = useState(false)
  const [reviewPage, setReviewPage] = useState(1)
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null)
  const [showAllSlow, setShowAllSlow] = useState(false)
  const [enqueueSunkBusy, setEnqueueSunkBusy] = useState(false)
  const [enqueuedSunkDone, setEnqueuedSunkDone] = useState(false)
  const REVIEW_PAGE_SIZE = 20

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setUserMetaLoaded(false)
    void invoke<ExamSession | null>({ method: 'exam.get', params: { examId: id } })
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setError('未找到该场模考记录')
          return
        }
        setExam(result)
        void invoke<Record<string, QuestionUserMeta>>({
          method: 'questions.userMeta',
          params: { questionIds: result.questionIds }
        })
          .then((meta) => {
            if (cancelled) return
            setUserMeta(meta)
            const drafts: Record<string, string> = {}
            for (const [qId, item] of Object.entries(meta)) {
              drafts[qId] = item.note
            }
            setNoteDrafts(drafts)
            setUserMetaLoaded(true)
          })
          .catch(() => {
            /* 元数据拉取失败时不置 loaded，避免空草稿误覆盖库中已有笔记 */
          })
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读取模考结果失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  /** 逐题复盘条目：快照 + 作答 + 判分 + 单题耗时（与交卷口径一致，未作答按错误计） */
  const reviewItems = useMemo(() => {
    if (!exam) return []
    return exam.questionIds.flatMap((questionId, index) => {
      const snapshot = exam.questionSnapshots[questionId]
      if (!snapshot) return []
      const answerRec = exam.answers[questionId]
      const userAnswer = answerRec?.answer ?? []
      const answered = userAnswer.some((v) => v.trim())
      return [
        {
          index: index + 1,
          question: snapshot,
          userAnswer,
          answered,
          correct: isAnswerCorrect(snapshot.answer, userAnswer, { requireNonEmpty: true }),
          durationSeconds: Math.max(0, Math.round(answerRec?.durationSeconds ?? 0))
        }
      ]
    })
  }, [exam])

  /** 各模块（category）正确率与耗时分布 */
  const categoryStats = useMemo(() => {
    const byCategory = new Map<
      string,
      { attempts: number; correct: number; totalDuration: number; timedCount: number }
    >()
    for (const item of reviewItems) {
      const entry = byCategory.get(item.question.category) ?? {
        attempts: 0,
        correct: 0,
        totalDuration: 0,
        timedCount: 0
      }
      entry.attempts += 1
      if (item.correct) entry.correct += 1
      if (item.durationSeconds > 0) {
        entry.totalDuration += item.durationSeconds
        entry.timedCount += 1
      }
      byCategory.set(item.question.category, entry)
    }
    return [...byCategory.entries()]
      .map(([category, stat]) => ({
        category,
        attempts: stat.attempts,
        correct: stat.correct,
        accuracy: stat.attempts ? Math.round((stat.correct / stat.attempts) * 100) : 0,
        totalDuration: stat.totalDuration,
        avgDuration: stat.timedCount ? Math.round(stat.totalDuration / stat.timedCount) : 0
      }))
      .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
  }, [reviewItems])

  const wrongIds = useMemo(
    () =>
      exam?.subject === 'shenlun'
        ? []
        : reviewItems.filter((item) => !item.correct).map((item) => item.question.id),
    [reviewItems, exam?.subject]
  )
  const uncertainCorrectIds = useMemo(() => {
    const uIds = exam?.uncertainIds ?? []
    if (!uIds.length || exam?.subject === 'shenlun') return []
    return reviewItems
      .filter((item) => item.correct && uIds.includes(item.question.id))
      .map((item) => item.question.id)
  }, [reviewItems, exam?.uncertainIds, exam?.subject])

  const sunkCostReport = useMemo(() => {
    if (exam?.subject === 'shenlun') return null
    return analyzeExamSunkCost(
      reviewItems.map((item) => ({
        index: item.index,
        questionId: item.question.id,
        category: item.question.category,
        stem: item.question.stem,
        correct: item.correct,
        answered: item.answered,
        durationSeconds: item.durationSeconds
      }))
    )
  }, [exam?.subject, reviewItems])

  const filteredItems =
    filter === 'wrong-unanswered' ? reviewItems.filter((item) => !item.correct) : reviewItems

  async function toggleFavorite(questionId: string): Promise<void> {
    const currentFav = userMeta[questionId]?.favorite ?? false
    const nextFav = !currentFav
    try {
      await invoke({ method: 'favorite.set', params: { questionId, favorite: nextFav } })
      setUserMeta((prev) => ({
        ...prev,
        [questionId]: {
          favorite: nextFav,
          note: prev[questionId]?.note ?? '',
          wrongCause: prev[questionId]?.wrongCause
        }
      }))
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '收藏更新失败')
    }
  }

  async function updateWrongCause(questionId: string, cause: string): Promise<void> {
    try {
      await invoke({ method: 'wrongQuestion.setCause', params: { questionId, wrongCause: cause } })
      setUserMeta((prev) => ({
        ...prev,
        [questionId]: {
          favorite: prev[questionId]?.favorite ?? false,
          note: prev[questionId]?.note ?? '',
          wrongCause: cause || undefined
        }
      }))
      showToast(cause ? `已标注错因：${cause}` : '已清除错因标注')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '错因保存失败')
    }
  }

  async function saveNote(questionId: string): Promise<void> {
    const content = noteDrafts[questionId] ?? ''
    setSavingNoteId(questionId)
    try {
      await invoke({ method: 'note.save', params: { questionId, content } })
      setUserMeta((prev) => ({
        ...prev,
        [questionId]: {
          favorite: prev[questionId]?.favorite ?? false,
          note: content,
          wrongCause: prev[questionId]?.wrongCause
        }
      }))
      showToast('笔记已保存')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '笔记保存失败')
    } finally {
      setSavingNoteId('')
    }
  }

  async function redoWrongQuestions(): Promise<void> {
    if (!wrongIds.length || redoBusy) return
    setRedoBusy(true)
    try {
      await invoke<PracticeSession>({
        method: 'practice.session.start',
        params: {
          mode: 'sequence',
          count: wrongIds.length,
          feedbackMode: 'immediate',
          questionIds: wrongIds
        }
      })
      navigate('/practice?resumeActive=1')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '启动错题重刷失败')
    } finally {
      setRedoBusy(false)
    }
  }

  async function enqueueUncertainCorrect(): Promise<void> {
    if (!uncertainCorrectIds.length || enqueueBusy || enqueuedDone) return
    setEnqueueBusy(true)
    try {
      const res = await invoke<{ added: number; skipped: number }>({
        method: 'review.enqueue',
        params: { questionIds: uncertainCorrectIds, reason: '蒙对/不确定' }
      })
      setEnqueuedDone(true)
      showToast(
        res.added > 0
          ? `已将 ${res.added} 道蒙对/不确定题加入明日间隔复习`
          : '这些题目已在待复习队列中'
      )
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '加入复习队列失败')
    } finally {
      setEnqueueBusy(false)
    }
  }

  async function enqueueSunkCostQuestions(): Promise<void> {
    const ids = sunkCostReport?.sunkCostItems.map((item) => item.questionId) ?? []
    if (!ids.length || enqueueSunkBusy || enqueuedSunkDone) return
    setEnqueueSunkBusy(true)
    try {
      const res = await invoke<{ added: number; skipped: number }>({
        method: 'review.enqueue',
        params: { questionIds: ids, reason: '考场超时答错' }
      })
      setEnqueuedSunkDone(true)
      showToast(
        res.added > 0
          ? `已将 ${res.added} 道超时沉没成本题加入间隔复习`
          : '这些题目已在待复习队列中'
      )
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '加入复习队列失败')
    } finally {
      setEnqueueSunkBusy(false)
    }
  }

  const totalReviewPages = Math.max(1, Math.ceil(filteredItems.length / REVIEW_PAGE_SIZE))
  const safeReviewPage = Math.min(reviewPage, totalReviewPages)
  const pagedItems = filteredItems.slice(
    (safeReviewPage - 1) * REVIEW_PAGE_SIZE,
    safeReviewPage * REVIEW_PAGE_SIZE
  )

  useEffect(() => {
    if (!pendingScrollId) return
    const target = document.getElementById(`exam-review-q-${pendingScrollId}`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setPendingScrollId(null)
    }
  }, [pendingScrollId, filter, safeReviewPage, pagedItems.length])

  function jumpToQuestion(questionId: string, isCorrect: boolean): void {
    const needSwitchFilter = filter === 'wrong-unanswered' && isCorrect
    const targetList = needSwitchFilter ? reviewItems : filteredItems
    const idx = targetList.findIndex((item) => item.question.id === questionId)
    const targetPage = idx >= 0 ? Math.floor(idx / REVIEW_PAGE_SIZE) + 1 : 1
    if (needSwitchFilter) {
      setFilter('all')
    }
    if (targetPage !== safeReviewPage || needSwitchFilter) {
      setReviewPage(targetPage)
      setPendingScrollId(questionId)
      return
    }
    const target = document.getElementById(`exam-review-q-${questionId}`)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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
  const answeredCount = reviewItems.filter((item) => item.answered).length
  const unanswered = totalQuestions - answeredCount
  const isShenlunExam = exam.subject === 'shenlun'
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

  const stats = isShenlunExam
    ? [
        { label: '模式', value: '申论整卷', suffix: '' },
        { label: '完成大题', value: answeredCount, suffix: ` / ${totalQuestions}` },
        { label: '未答大题', value: unanswered, suffix: ' 题' },
        { label: '实际用时', value: actualMin, suffix: ` 分 ${actualSec} 秒` }
      ]
    : [
        { label: '得分', value: score, suffix: '分' },
        { label: '正确率', value: accuracy, suffix: '%' },
        { label: '正确题数', value: correct, suffix: ` / ${totalQuestions}` },
        { label: '已答', value: answeredCount, suffix: ` / ${totalQuestions}` },
        { label: '未答', value: unanswered, suffix: ' 题' },
        { label: '实际用时', value: actualMin, suffix: ` 分 ${actualSec} 秒` }
      ]

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow={`训练 · 模考复盘 · ${formatFullDate(exam.startedAt)}`}
        title={exam.title}
        description={`${exam.status === 'finished' ? '考试已完成' : '考试未完成'} · 限时 ${durationMin} 分钟`}
        actions={
          <>
            {wrongIds.length > 0 && (
              <Button
                appearance="primary"
                icon={<TargetIcon />}
                disabled={redoBusy}
                onClick={() => void redoWrongQuestions()}
              >
                {redoBusy ? '正在组卷…' : `重刷本场错题 (${wrongIds.length})`}
              </Button>
            )}
            {uncertainCorrectIds.length > 0 && (
              <Button
                appearance="secondary"
                disabled={enqueueBusy || enqueuedDone}
                onClick={() => void enqueueUncertainCorrect()}
              >
                {enqueuedDone
                  ? `已加入 ${uncertainCorrectIds.length} 道蒙对题`
                  : `将 ${uncertainCorrectIds.length} 道蒙对/不确定题加入复习`}
              </Button>
            )}
            <Button icon={<ArrowLeftIcon />} onClick={() => navigate('/exam')}>
              返回模考
            </Button>
          </>
        }
      />

      <div className={`stat-strip ${isShenlunExam ? '' : 'three'}`}>
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
            {isShenlunExam ? (
              <li className="data-row">
                <div>
                  <strong>已完成 {answeredCount} 道大题作答</strong>
                  <span>各题作答文本已保存至草稿箱，可在下方逐题自查采分点或进入单题 AI 批改</span>
                </div>
                <CheckCircleIcon className="positive" />
              </li>
            ) : (
              <>
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
                    <span>可在下方就地标注错因、记笔记，或一键重刷本场错题</span>
                  </div>
                  <CalendarCheckIcon className="positive" />
                </li>
                {uncertainCorrectIds.length > 0 && (
                  <li className="data-row">
                    <div>
                      <strong>标旗「不确定」但答对 {uncertainCorrectIds.length} 题</strong>
                      <span>建议一并收入错题复习队列，避免蒙对掩盖薄弱点</span>
                    </div>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={enqueueBusy || enqueuedDone}
                      onClick={() => void enqueueUncertainCorrect()}
                    >
                      {enqueuedDone ? '已加入' : '一键加入复习'}
                    </Button>
                  </li>
                )}
              </>
            )}
          </ul>
        </Section>
        <Section
          title="模块正确率与耗时分布"
          description="按快照分类统计，弱项模块排前；显示各模块累计与均题耗时。"
        >
          {categoryStats.length ? (
            <div className="mastery-list">
              {categoryStats.map((item) => (
                <div
                  className={`mastery-row${item.accuracy < 60 ? ' mastery-row-weak' : ''}`}
                  key={item.category}
                >
                  <div className="mastery-info">
                    <strong>{item.category}</strong>
                    <span className="mastery-detail">
                      {item.correct}/{item.attempts} 正确
                      {item.totalDuration > 0 && (
                        <>
                          {' · '}总耗时 {formatDurationBrief(item.totalDuration)} · 均题{' '}
                          <span
                            className={
                              exam.subject !== 'shenlun' && item.avgDuration > 75
                                ? 'warning'
                                : undefined
                            }
                          >
                            {item.avgDuration}秒
                          </span>
                        </>
                      )}
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

      {sunkCostReport && sunkCostReport.topSlowItems.length > 0 && (
        <Section
          title="超时黑洞榜（沉没成本分析）"
          description="识别考场单题耗时最长与超时仍答错的题目，帮助看清“死磕丢时间”的题型分布，点击可定位逐题复盘。"
          actions={
            sunkCostReport.sunkCostItems.length > 0 ? (
              <Button
                size="small"
                appearance="secondary"
                icon={<ClockCountdownIcon />}
                disabled={enqueueSunkBusy || enqueuedSunkDone}
                onClick={() => void enqueueSunkCostQuestions()}
              >
                {enqueuedSunkDone
                  ? `已将 ${sunkCostReport.sunkCostItems.length} 题加入复习`
                  : `将 ${sunkCostReport.sunkCostItems.length} 道沉没成本题加入复习`}
              </Button>
            ) : undefined
          }
        >
          <div className="sunk-cost-summary">
            <div className="sunk-cost-stat">
              <span className="muted">超时且答错（沉没成本）</span>
              <strong className={sunkCostReport.sunkCostItems.length > 0 ? 'negative' : 'positive'}>
                {sunkCostReport.sunkCostItems.length} 题
              </strong>
            </div>
            <div className="sunk-cost-stat">
              <span className="muted">沉没累计耗时</span>
              <strong>
                {sunkCostReport.sunkCostTotalSeconds > 0
                  ? formatDurationBrief(sunkCostReport.sunkCostTotalSeconds)
                  : '0秒'}
              </strong>
            </div>
            <div className="sunk-cost-stat">
              <span className="muted">占记录答题时长</span>
              <strong>{sunkCostReport.sunkCostSharePercent}%</strong>
            </div>
          </div>
          <div className="sunk-cost-list">
            {(showAllSlow
              ? sunkCostReport.topSlowItems
              : sunkCostReport.topSlowItems.slice(0, 6)
            ).map((entry) => (
              <button
                key={entry.questionId}
                type="button"
                className={`sunk-cost-row${entry.isSunkCost ? ' is-sunk' : ''}`}
                onClick={() => jumpToQuestion(entry.questionId, entry.correct)}
              >
                <span className="sunk-cost-no">第 {entry.index} 题</span>
                <span className="pill">{entry.moduleName}</span>
                <span className="sunk-cost-stem">{entry.stemPreview}</span>
                <span className="sunk-cost-time">
                  {formatDurationBrief(entry.durationSeconds)} · {entry.overtimeRatio}×
                </span>
                <span
                  className={`sunk-cost-badge${entry.isSunkCost ? ' is-sunk' : entry.isOvertime ? ' is-warn' : ''}`}
                >
                  {entry.isSunkCost ? '沉没成本' : entry.isOvertime ? '超时答对' : '偏慢'}
                </span>
              </button>
            ))}
          </div>
          {sunkCostReport.topSlowItems.length > 6 && (
            <div className="sunk-cost-more">
              <Button
                size="small"
                appearance="subtle"
                onClick={() => setShowAllSlow((prev) => !prev)}
              >
                {showAllSlow
                  ? '收起部分条目'
                  : `展开全部 ${sunkCostReport.topSlowItems.length} 道高耗时题`}
              </Button>
            </div>
          )}
        </Section>
      )}

      {reviewItems.length > 0 && (
        <Section
          title="题号快速定位"
          description="绿底为答对、红底为答错、灰底为未作答；点击题号直接定位到对应解析。"
        >
          <div className="exam-review-jumpbar">
            {reviewItems.map((item) => (
              <button
                key={item.question.id}
                type="button"
                className={`exam-jump-btn ${item.correct ? 'is-correct' : item.answered ? 'is-wrong' : 'is-unanswered'}`}
                title={`第 ${item.index} 题 · ${item.question.category}${item.durationSeconds > 0 ? ` · 用时 ${item.durationSeconds} 秒` : ''}`}
                onClick={() => jumpToQuestion(item.question.id, item.correct)}
              >
                {item.index}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="逐题复盘"
        description="基于交卷时的题目快照展示每题作答、参考答案、耗时与解析，支持就地收藏、标注错因、记笔记与 AI 追问。"
        actions={
          <div className="button-row">
            <ReadingTypographyBar
              typography={reading.typography}
              onUpdate={reading.update}
              onStepScale={reading.stepScale}
              onResetScale={reading.resetScale}
            />
            <Select
              value={filter}
              onChange={(_, data) => {
                setFilter(data.value as ReviewFilter)
                setReviewPage(1)
              }}
              aria-label="复盘筛选"
            >
              <option value="all">全部题目（{reviewItems.length}）</option>
              <option value="wrong-unanswered">仅看错题与未答（{wrongIds.length}）</option>
            </Select>
          </div>
        }
      >
        {pagedItems.length ? (
          <>
            <div
              ref={reading.surfaceRef}
              className="question-reading-surface"
              data-reading-font={reading.typography.font}
              style={reading.surfaceStyle}
            >
              {pagedItems.map((item) => {
                const meta = userMeta[item.question.id] ?? { favorite: false, note: '' }
                const noteOpen = Boolean(openNoteIds[item.question.id] || meta.note)
                return (
                  <div
                    className="answer-panel exam-review-card"
                    id={`exam-review-q-${item.question.id}`}
                    key={item.question.id}
                  >
                    <div className="exam-review-card-head">
                      <h3 className={`exam-review-title ${item.correct ? 'positive' : 'negative'}`}>
                        第 {item.index} 题：
                        {item.answered ? (item.correct ? '正确' : '错误') : '未作答'}
                        <span className="muted exam-review-meta">
                          {item.question.category}
                          {item.durationSeconds > 0
                            ? ` · 用时 ${formatDurationBrief(item.durationSeconds)}`
                            : ''}
                        </span>
                      </h3>
                      <div className="button-row">
                        {!item.correct && (
                          <Select
                            size="small"
                            aria-label={`第 ${item.index} 题错因标注`}
                            value={meta.wrongCause ?? ''}
                            onChange={(_, data) =>
                              void updateWrongCause(item.question.id, data.value)
                            }
                          >
                            <option value="">标注错因…</option>
                            {WRONG_CAUSE_OPTIONS.map((cause) => (
                              <option key={cause} value={cause}>
                                {cause}
                              </option>
                            ))}
                          </Select>
                        )}
                        <Button
                          size="small"
                          appearance={meta.favorite ? 'secondary' : 'subtle'}
                          icon={<BookmarkSimpleIcon weight={meta.favorite ? 'fill' : undefined} />}
                          onClick={() => void toggleFavorite(item.question.id)}
                        >
                          {meta.favorite ? '已收藏' : '收藏'}
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<NotePencilIcon />}
                          onClick={() =>
                            setOpenNoteIds((prev) => ({
                              ...prev,
                              [item.question.id]: !noteOpen
                            }))
                          }
                        >
                          {noteOpen ? '收起笔记' : '记笔记'}
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<RobotIcon />}
                          onClick={() =>
                            navigate(`/ai?questionId=${encodeURIComponent(item.question.id)}`)
                          }
                        >
                          AI 追问
                        </Button>
                      </div>
                    </div>
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
                              <OptionContent
                                option={option}
                                sourceFilePath={item.question.filePath}
                              />
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
                    {isShenlunExam && (
                      <>
                        <div className="button-row" style={{ marginTop: 10 }}>
                          <Button
                            size="small"
                            appearance="primary"
                            onClick={() =>
                              navigate(
                                `/shenlun-solution?promptId=${encodeURIComponent(item.question.id)}`
                              )
                            }
                          >
                            去单题二稿精修 / AI 批改
                          </Button>
                        </div>
                        <ShenlunPointChecklist
                          promptId={item.question.id}
                          title={item.question.stem.slice(0, 60)}
                          answer={item.question.answer}
                          explanation={item.question.explanation}
                          draftContent={item.userAnswer[0] ?? ''}
                        />
                      </>
                    )}
                    {noteOpen && (
                      <div className="library-note-box">
                        <Field label="本题复盘笔记">
                          <Textarea
                            rows={2}
                            value={noteDrafts[item.question.id] ?? ''}
                            onChange={(_, data) =>
                              setNoteDrafts((prev) => ({
                                ...prev,
                                [item.question.id]: data.value
                              }))
                            }
                            placeholder="记录本题陷阱、速算技巧或错因复盘"
                          />
                        </Field>
                        <Button
                          size="small"
                          appearance="secondary"
                          icon={<NotePencilIcon />}
                          disabled={!userMetaLoaded || savingNoteId === item.question.id}
                          className="field-gap-top-sm"
                          onClick={() => void saveNote(item.question.id)}
                        >
                          {savingNoteId === item.question.id
                            ? '保存中…'
                            : userMetaLoaded
                              ? '保存笔记'
                              : '加载中…'}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {totalReviewPages > 1 && (
              <div className="list-pagination">
                <Button
                  size="small"
                  appearance="subtle"
                  disabled={safeReviewPage <= 1}
                  onClick={() => setReviewPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </Button>
                <span className="muted">
                  第 {safeReviewPage} / {totalReviewPages} 页（共 {filteredItems.length} 题）
                </span>
                <Button
                  size="small"
                  appearance="subtle"
                  disabled={safeReviewPage >= totalReviewPages}
                  onClick={() => setReviewPage((p) => Math.min(totalReviewPages, p + 1))}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
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

      <Section title="下一步">
        <div className="button-row">
          {wrongIds.length > 0 && (
            <Button
              appearance="primary"
              icon={<TargetIcon />}
              disabled={redoBusy}
              onClick={() => void redoWrongQuestions()}
            >
              重刷本场错题（{wrongIds.length} 题）
            </Button>
          )}
          <Button icon={<CalendarCheckIcon />} onClick={() => navigate('/review')}>
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
  )
}
