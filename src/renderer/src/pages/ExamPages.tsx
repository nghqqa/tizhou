import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  ProgressBar,
  Select
} from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  ExamIcon,
  FlagIcon
} from '@phosphor-icons/react'
import type { ExamSession, Question, QuestionFacets } from '@shared/contracts'
import { useNavigate } from 'react-router-dom'
import { formatDate, formatFullDate, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { OptionContent } from '../components/OptionContent'
import { ReadingTypographyBar, useReadingTypography } from '../components/ReadingTypographyControl'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { EssaySaveController, ExamAnswerSaveController } from '../services/exam-essay-save'
import { useAppStore } from '../store'

const EXAM_UNCERTAIN_PREFIX = 'tizhou:exam-uncertain:'

/** 清理已结束或弃考模考遗留的本地待查标记，仅保留当前进行中的场次 */
function pruneStaleExamUncertainKeys(activeExamId?: string): void {
  try {
    const keepKey = activeExamId ? `${EXAM_UNCERTAIN_PREFIX}${activeExamId}` : ''
    const staleKeys: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(EXAM_UNCERTAIN_PREFIX) && key !== keepKey) {
        staleKeys.push(key)
      }
    }
    for (const key of staleKeys) {
      window.localStorage.removeItem(key)
    }
  } catch {
    /* 忽略受限存储环境失败 */
  }
}

export function ExamHomePage(): React.JSX.Element {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)!
  const [title, setTitle] = useState('行测自定义模考')
  const subject = 'xingce' as const
  const [durationMinutes, setDurationMinutes] = useState(data.settings.defaultExamMinutes)
  const [questionCount, setQuestionCount] = useState(20)
  const [facets, setFacets] = useState<QuestionFacets>({ years: [], regions: [], papers: [] })
  const [year, setYear] = useState('')
  const [region, setRegion] = useState('')
  const [paper, setPaper] = useState('')
  const [history, setHistory] = useState<ExamSession[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [papers, setPapers] = useState<Array<{ paper: string; count: number; year?: number }>>([])
  const [paperChoice, setPaperChoice] = useState('')
  useEffect(() => {
    void invoke<ExamSession[]>({ method: 'exam.history' })
      .then((items) => {
        setHistory(items)
        pruneStaleExamUncertainKeys(items.find((item) => item.status === 'active')?.id)
      })
      .catch(() => setHistory([]))
    void invoke<QuestionFacets>({ method: 'vault.facets', params: { subject: 'xingce' } })
      .then(setFacets)
      .catch(() => setFacets({ years: [], regions: [], papers: [] }))
    void invoke<Array<{ paper: string; count: number; year?: number }>>({ method: 'exam.papers' })
      .then(setPapers)
      .catch(() => setPapers([]))
  }, [])

  async function createPaperExam(): Promise<void> {
    if (!paperChoice) return
    setBusy(true)
    setError('')
    try {
      await invoke<ExamSession>({ method: 'exam.createPaper', params: { paper: paperChoice } })
      navigate('/exam/run')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '原卷组卷失败')
    } finally {
      setBusy(false)
    }
  }

  async function createExam(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke<ExamSession>({
        method: 'exam.create',
        params: {
          title,
          subject,
          durationMinutes,
          questionCount,
          filter: {
            year: year ? Number(year) : undefined,
            region: region || undefined,
            paper: paper || undefined
          }
        }
      })
      navigate('/exam/run')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建模考失败')
    } finally {
      setBusy(false)
    }
  }
  const active = history?.find((exam) => exam.status === 'active')
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 模拟考试"
        title="模拟考试"
        description="答案会逐题落盘，关闭应用后仍可继续；交卷时基于题目快照形成完整记录。"
        actions={
          active && (
            <Button appearance="primary" onClick={() => navigate('/exam/run')}>
              继续未完成模考
            </Button>
          )
        }
      />
      <div className="grid two">
        <Section title="新建模考" description="只从当前活动知识库选题。">
          {error && <ErrorState message={error} />}
          <div className="form-grid">
            <Field className="full" label="考试名称">
              <Input value={title} onChange={(_, dataValue) => setTitle(dataValue.value)} />
            </Field>
            <Field label="科目">
              <Input value="行政职业能力测验" readOnly />
            </Field>
            <Field label="题目数量">
              <Input
                type="number"
                min={1}
                max={100}
                value={String(questionCount)}
                onChange={(_, dataValue) =>
                  setQuestionCount(Math.max(1, Math.min(100, Number(dataValue.value) || 1)))
                }
              />
            </Field>
            <Field label="限时分钟">
              <Input
                type="number"
                min={10}
                max={300}
                value={String(durationMinutes)}
                onChange={(_, dataValue) =>
                  setDurationMinutes(Math.max(10, Math.min(300, Number(dataValue.value) || 10)))
                }
              />
            </Field>
            {facets.years.length > 0 && (
              <Field label="年份">
                <Select value={year} onChange={(_, dataValue) => setYear(dataValue.value)}>
                  <option value="">全部年份</option>
                  {facets.years.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {facets.regions.length > 0 && (
              <Field label="地区">
                <Select value={region} onChange={(_, dataValue) => setRegion(dataValue.value)}>
                  <option value="">全部地区</option>
                  {facets.regions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {facets.papers.length > 0 && (
              <Field className="full" label="指定试卷">
                <Select value={paper} onChange={(_, dataValue) => setPaper(dataValue.value)}>
                  <option value="">全部试卷</option>
                  {facets.papers.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Button
            appearance="primary"
            icon={<ExamIcon />}
            style={{ marginTop: 18 }}
            disabled={busy || Boolean(active)}
            onClick={() => void createExam()}
          >
            {active ? '请先完成当前模考' : '创建并开始'}
          </Button>
        </Section>
        <Section title="考试规则">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>断点续答</strong>
                <span>每次选择答案后立即保存</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
            <li className="data-row">
              <div>
                <strong>统一交卷</strong>
                <span>交卷后才进入训练统计和错题系统</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
            <li className="data-row">
              <div>
                <strong>题目快照</strong>
                <span>知识库更新不会篡改历史作答</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
          </ul>
        </Section>
      </div>
      <div style={{ marginTop: 16 }}>
        <Section
          title="真题原卷模考"
          description="按试卷原题号顺序整卷组卷、限时 120 分钟；题目来自当前知识库，联考共用题已去重，题量不足 30 的卷不出现在列表。"
        >
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <Field label="选择真题卷" className="grow">
              <Select
                value={paperChoice}
                onChange={(_, dataValue) => setPaperChoice(dataValue.value)}
              >
                <option value="">选择试卷…</option>
                {papers.map((item) => (
                  <option key={item.paper} value={item.paper}>
                    {item.paper}（{item.count} 题）
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              appearance="primary"
              icon={<ExamIcon />}
              disabled={busy || !paperChoice || Boolean(active)}
              onClick={() => void createPaperExam()}
            >
              {active ? '请先完成当前模考' : '开始整卷模考'}
            </Button>
          </div>
          {!papers.length && (
            <p className="muted" style={{ margin: '10px 0 0' }}>
              当前知识库没有带试卷归属信息的题目（真题库导入后自动出现）。
            </p>
          )}
        </Section>
      </div>
      <div style={{ marginTop: 16 }}>
        <Section title="历史模考">
          {!history ? (
            <LoadingState />
          ) : history.length ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>科目</th>
                  <th>进度</th>
                  <th>分数</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.map((exam) => (
                  <tr key={exam.id}>
                    <td>{exam.title}</td>
                    <td>{exam.subject === 'xingce' ? '行测' : '申论'}</td>
                    <td>
                      {exam.status === 'active'
                        ? `已答 ${Object.keys(exam.answers).length}/${exam.questionIds.length}`
                        : '已交卷'}
                    </td>
                    <td>{exam.score === undefined ? '暂未评分' : `${exam.score} 分`}</td>
                    <td>{formatFullDate(exam.updatedAt)}</td>
                    <td>
                      <Button
                        size="small"
                        appearance="secondary"
                        onClick={() =>
                          navigate(
                            exam.status === 'finished' ? `/exam/result/${exam.id}` : '/exam/run'
                          )
                        }
                      >
                        {exam.status === 'finished' ? '查看复盘' : '继续作答'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="暂无模考记录"
              description="创建第一场自定义模考后，成绩和作答进度会显示在这里。"
            />
          )}
        </Section>
      </div>
    </div>
  )
}

function remainingSeconds(exam: ExamSession): number {
  const deadline = new Date(exam.startedAt).getTime() + exam.durationMinutes * 60_000
  return Math.max(0, Math.floor((deadline - Date.now()) / 1000))
}

export function ExamRunPage(): React.JSX.Element {
  const navigate = useNavigate()
  const refresh = useAppStore((state) => state.refreshDashboard)
  const [exam, setExam] = useState<ExamSession>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [index, setIndex] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'idle'
  )
  const [essayText, setEssayText] = useState('')
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [uncertainIds, setUncertainIds] = useState<string[]>([])
  const [eliminatedByQuestion, setEliminatedByQuestion] = useState<Record<string, string[]>>({})
  const reading = useReadingTypography()
  const essayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(true)
  // 每题累计耗时（秒）与当前题目进入时间戳：切题、保存答案及交卷前实时累计，支撑复盘页模块耗时分析
  const questionDurationsRef = useRef<Record<string, number>>({})
  const timingAnchorRef = useRef<{ questionId: string; enteredAt: number } | null>(null)
  const examRef = useRef<ExamSession | undefined>(undefined)
  examRef.current = exam

  function flushActiveQuestionDuration(questionId?: string): number {
    const anchor = timingAnchorRef.current
    const nowMs = Date.now()
    if (anchor) {
      const delta = Math.max(0, Math.round((nowMs - anchor.enteredAt) / 1000))
      if (delta > 0) {
        questionDurationsRef.current[anchor.questionId] =
          (questionDurationsRef.current[anchor.questionId] ?? 0) + delta
      }
      timingAnchorRef.current = { questionId: anchor.questionId, enteredAt: nowMs }
    }
    return questionId ? (questionDurationsRef.current[questionId] ?? 0) : 0
  }

  // 客观题答案保存控制器：串行化 + 同题去重 + 失败保留 + 交卷前 drain
  const answerSaveRef = useRef<ExamAnswerSaveController | null>(null)
  if (!answerSaveRef.current) {
    answerSaveRef.current = new ExamAnswerSaveController(async (request) => {
      await invoke({
        method: 'exam.save',
        params: {
          examId: request.examId,
          answer: {
            questionId: request.questionId,
            answer: request.answer,
            durationSeconds: questionDurationsRef.current[request.questionId] ?? 0
          }
        }
      })
    })
  }
  // 生产保存控制器：串行化队列 + 失败保留 + 重试 + drain 检查
  const saveControllerRef = useRef<EssaySaveController | null>(null)
  if (!saveControllerRef.current && exam) {
    saveControllerRef.current = new EssaySaveController(
      async (save) => {
        const saved = await invoke<ExamSession>({
          method: 'exam.save',
          params: {
            examId: save.examId,
            answer: {
              questionId: save.questionId,
              answer: save.answer,
              durationSeconds: questionDurationsRef.current[save.questionId] ?? 0
            }
          }
        })
        if (mountedRef.current) setExam(saved)
      },
      (status) => {
        if (mountedRef.current) setSaveStatus(status)
      }
    )
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (essayTimerRef.current) clearTimeout(essayTimerRef.current)
      // 组件卸载时把挂起答案保存完成后再停止（异步，不阻塞卸载本身）
      void answerSaveRef.current?.destroy()
      void saveControllerRef.current?.destroy()
    }
  }, [])

  useEffect(() => {
    void invoke<ExamSession | undefined>({ method: 'exam.active' })
      .then((active) => {
        pruneStaleExamUncertainKeys(active?.id)
        if (!active) return
        // 从持久化答案恢复已累计耗时，断点续答不丢耗时
        const restoredDurations: Record<string, number> = {}
        for (const [qId, ans] of Object.entries(active.answers)) {
          restoredDurations[qId] = Math.max(0, Math.round(ans.durationSeconds ?? 0))
        }
        questionDurationsRef.current = restoredDurations
        setExam(active)
        setSeconds(remainingSeconds(active))
        try {
          const savedUncertain = window.localStorage.getItem(`${EXAM_UNCERTAIN_PREFIX}${active.id}`)
          if (savedUncertain) {
            const parsed = JSON.parse(savedUncertain)
            if (Array.isArray(parsed)) setUncertainIds(parsed.map(String))
          }
        } catch {
          /* 忽略受限存储读取失败 */
        }
        setQuestions(
          active.questionIds
            .map((id) => active.questionSnapshots[id])
            .filter((item): item is Question => Boolean(item))
        )
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '模考读取失败'))
  }, [])
  useEffect(() => {
    if (!exam) return
    const timer = window.setInterval(() => setSeconds(remainingSeconds(exam)), 1000)
    return () => window.clearInterval(timer)
  }, [exam])
  useEffect(() => {
    if (exam && seconds === 0 && !finishing) void finish()
  }, [seconds, exam?.id])
  const answered = exam
    ? Object.values(exam.answers).filter((item) => item.answer.some((value) => value.trim())).length
    : 0
  const current = questions[index]

  // 切题时结算上一题停留耗时并切换计时锚点；若上一题已作答且有新增耗时则顺手持久化
  useEffect(() => {
    const nextId = current?.id
    const prevAnchor = timingAnchorRef.current
    const nowMs = Date.now()
    if (prevAnchor && prevAnchor.questionId !== nextId) {
      const delta = Math.max(0, Math.round((nowMs - prevAnchor.enteredAt) / 1000))
      if (delta > 0) {
        questionDurationsRef.current[prevAnchor.questionId] =
          (questionDurationsRef.current[prevAnchor.questionId] ?? 0) + delta
        const activeExam = examRef.current
        const prevAnswer = activeExam?.answers[prevAnchor.questionId]
        if (activeExam && prevAnswer?.answer.some((v) => v.trim())) {
          answerSaveRef.current?.save({
            examId: activeExam.id,
            questionId: prevAnchor.questionId,
            answer: prevAnswer.answer
          })
        }
      }
    }
    timingAnchorRef.current = nextId ? { questionId: nextId, enteredAt: nowMs } : null
  }, [current?.id])
  const currentAnswer =
    current && exam?.answers[current.id]?.answer ? exam.answers[current.id]!.answer : []
  const currentUncertain = current ? uncertainIds.includes(current.id) : false
  const currentEliminated = current ? (eliminatedByQuestion[current.id] ?? []) : []
  const timeText = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const title = useMemo(() => exam?.title ?? '模拟考试', [exam?.title])

  function toggleUncertain(): void {
    if (!exam || !current) return
    setUncertainIds((prev) => {
      const nextIds = prev.includes(current.id)
        ? prev.filter((id) => id !== current.id)
        : [...prev, current.id]
      try {
        window.localStorage.setItem(`tizhou:exam-uncertain:${exam.id}`, JSON.stringify(nextIds))
      } catch {
        /* 忽略受限存储写入失败 */
      }
      return nextIds
    })
  }

  function toggleEliminate(key: string, event: React.MouseEvent): void {
    event.preventDefault()
    // 已选中的选项不进入划除态，避免出现“内部已划除但界面仍显示选中”的无反馈状态
    if (!current || currentAnswer.includes(key)) return
    setEliminatedByQuestion((prev) => {
      const list = prev[current.id] ?? []
      const nextList = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
      return { ...prev, [current.id]: nextList }
    })
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !current ||
        confirmOpen ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLButtonElement
      )
        return
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        setIndex((value) => Math.max(0, value - 1))
        return
      }
      if (event.key === 'ArrowRight' && index + 1 < questions.length) {
        event.preventDefault()
        setIndex((value) => Math.min(questions.length - 1, value + 1))
        return
      }
      if (event.key.toLowerCase() === 'u') {
        event.preventDefault()
        toggleUncertain()
        return
      }
      if (current.type !== 'essay') {
        const optionIndex = /^[1-8]$/.test(event.key)
          ? Number(event.key) - 1
          : /^[a-h]$/i.test(event.key)
            ? event.key.toUpperCase().charCodeAt(0) - 65
            : -1
        const option = current.options[optionIndex]
        if (option) void choose(option.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, confirmOpen, index, questions.length, currentAnswer, exam, uncertainIds])

  async function choose(key: string): Promise<void> {
    if (!exam || !current) return
    if (currentEliminated.includes(key)) {
      setEliminatedByQuestion((prev) => ({
        ...prev,
        [current.id]: (prev[current.id] ?? []).filter((item) => item !== key)
      }))
    }
    const answer =
      current.type === 'multiple'
        ? currentAnswer.includes(key)
          ? currentAnswer.filter((item) => item !== key)
          : [...currentAnswer, key]
        : [key]
    const durationSeconds = flushActiveQuestionDuration(current.id)
    // 乐观更新：用户意图立即生效（保存失败不再回滚——回滚会用旧快照覆盖更新的作答）
    setExam({
      ...exam,
      answers: {
        ...exam.answers,
        [current.id]: { questionId: current.id, answer, durationSeconds }
      }
    })
    // 串行化保存队列：同题连续选择自动去重为最新一次，旧响应不会覆盖新状态
    answerSaveRef.current?.save({
      examId: exam.id,
      questionId: current.id,
      answer
    })
  }
  async function finish(): Promise<void> {
    if (!exam) return
    // 交卷前结算当前题耗时并同步写入已作答记录
    if (current) {
      const finalDuration = flushActiveQuestionDuration(current.id)
      const existingAns = exam.answers[current.id]
      if (
        existingAns?.answer.some((v) => v.trim()) &&
        finalDuration !== existingAns.durationSeconds
      ) {
        answerSaveRef.current?.save({
          examId: exam.id,
          questionId: current.id,
          answer: existingAns.answer
        })
      }
    }
    // 交卷前 flush pending 并检查保存失败
    if (essayTimerRef.current) {
      clearTimeout(essayTimerRef.current)
      essayTimerRef.current = undefined
    }
    // 客观题答案：等待全部挂起保存完成；存在失败则阻止交卷并自动重试
    const answerController = answerSaveRef.current
    if (answerController) {
      const failedIds = await answerController.drain()
      if (failedIds.length > 0) {
        answerController.retryAll()
        setSaveBlocked(true)
        setError(`有 ${failedIds.length} 题答案尚未保存成功，已自动重试；请稍后再次交卷。`)
        setFinishing(false)
        setConfirmOpen(false)
        return
      }
    }
    const controller = saveControllerRef.current
    if (controller) {
      await controller.flushPending()
      const result = await controller.drain()
      if (result.hasFailure) {
        setSaveBlocked(true)
        setError('答案保存失败，暂不能交卷。请点击「重试保存」后再次交卷。')
        setFinishing(false)
        setConfirmOpen(false)
        return
      }
    }
    setSaveBlocked(false)
    setFinishing(true)
    setConfirmOpen(false)
    setError('')
    try {
      await invoke({ method: 'exam.finish', params: { examId: exam.id } })
      try {
        window.localStorage.removeItem(`tizhou:exam-uncertain:${exam.id}`)
      } catch {
        /* 忽略 */
      }
      await refresh()
      navigate(`/exam/result/${exam.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交卷失败')
    } finally {
      setFinishing(false)
    }
  }

  /** 重试失败的保存 */
  async function retrySave(): Promise<void> {
    const controller = saveControllerRef.current
    if (!controller) return
    setError('')
    const result = await controller.retryAll()
    if (!result.hasFailure) {
      setSaveBlocked(false)
      setSaveStatus('saved')
    } else {
      setError(`仍有 ${result.failedQuestionIds.length} 题保存失败，请再次重试。`)
    }
  }

  /** 主观题 debounce：输入时捕获当前 questionId，600ms 后保存 */
  function scheduleEssaySave(text: string): void {
    setEssayText(text)
    if (essayTimerRef.current) clearTimeout(essayTimerRef.current)
    const controller = saveControllerRef.current
    if (controller && exam && current) {
      controller.markDirty(exam.id, current.id, text)
    }
    essayTimerRef.current = setTimeout(() => {
      void saveControllerRef.current?.flushPending()
    }, 600)
  }

  // 切题时 flush 上一题的未保存内容（controller 已捕获旧题 ID）
  useEffect(() => {
    return () => {
      if (essayTimerRef.current) {
        clearTimeout(essayTimerRef.current)
        essayTimerRef.current = undefined
      }
      void saveControllerRef.current?.flushPending()
    }
  }, [index])

  // 加载当前题的已有主观题答案
  useEffect(() => {
    if (current?.type === 'essay') {
      setEssayText(currentAnswer[0] ?? '')
    } else {
      setEssayText('')
    }
  }, [current?.id])
  if (error && !exam)
    return (
      <div className="page">
        <PageHeader title="模拟考试" />
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      </div>
    )
  if (!exam)
    return (
      <div className="page">
        <PageHeader title="模拟考试" />
        <EmptyState
          title="没有进行中的模考"
          description="返回模考首页创建一场考试。"
          actionLabel="返回模考首页"
          onAction={() => navigate('/exam')}
        />
      </div>
    )
  if (!current)
    return (
      <div className="page">
        <LoadingState label="正在读取试卷" />
      </div>
    )
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 模考进行中"
        title={title}
        description={`开始于 ${formatDate(exam.startedAt)}，答案会自动保存。`}
        actions={
          <>
            <span className={`pill ${seconds < 300 ? 'negative' : ''}`}>
              <ClockIcon /> {timeText}
            </span>
            <Button
              appearance="primary"
              data-testid="exam-submit"
              onClick={() => setConfirmOpen(true)}
            >
              交卷
            </Button>
          </>
        }
      />
      {error && <ErrorState message={error} />}
      <div className="question-shell">
        <Section className="question-card">
          <div className="progress-text">
            <span>
              第 {index + 1} 题 / 共 {questions.length} 题
            </span>
            <span>已答 {answered} 题</span>
          </div>
          <ProgressBar value={answered / exam.questionIds.length} />
          <div className="question-top-bar">
            <div className="question-meta">
              <span className="pill">{current.category}</span>
              <span className="pill">难度 {current.difficulty}</span>
              {current.year && <span className="pill">{current.year}</span>}
              {current.region && <span className="pill">{current.region}</span>}
            </div>
            <ReadingTypographyBar
              typography={reading.typography}
              onUpdate={reading.update}
              onStepScale={reading.stepScale}
              onResetScale={reading.resetScale}
            />
          </div>
          <div
            ref={reading.surfaceRef}
            className="question-reading-surface"
            data-reading-font={reading.typography.font}
            style={reading.surfaceStyle}
          >
            {current.material && (
              <div className="answer-panel">
                <strong>给定材料</strong>
                <MarkdownContent content={current.material} sourceFilePath={current.filePath} />
              </div>
            )}
            <MarkdownContent
              className="question-stem"
              content={current.stem}
              sourceFilePath={current.filePath}
            />
            {current.type === 'essay' ? (
              <div>
                <textarea
                  className="essay-editor"
                  data-testid="exam-essay-input"
                  aria-label="主观题作答输入"
                  value={essayText}
                  onChange={(event) => scheduleEssaySave(event.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                  {saveStatus === 'saving' && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      正在保存…
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="positive" style={{ fontSize: 11 }}>
                      ✓ 已保存
                    </span>
                  )}
                  {saveStatus === 'error' && !saveBlocked && (
                    <span className="negative" style={{ fontSize: 11 }}>
                      保存失败
                    </span>
                  )}
                  {saveBlocked && (
                    <span className="negative" style={{ fontSize: 11 }}>
                      保存失败{' '}
                      <Button size="small" appearance="secondary" onClick={() => void retrySave()}>
                        重试保存
                      </Button>
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="options">
                {current.options.map((option) => {
                  const isSelected = currentAnswer.includes(option.key)
                  const isEliminated = !isSelected && currentEliminated.includes(option.key)
                  return (
                    <button
                      type="button"
                      key={option.key}
                      title="左键选择 · 右键排除干扰项"
                      className={`option-button ${isSelected ? 'selected' : isEliminated ? 'is-eliminated' : ''}`}
                      data-testid={`exam-option-${option.key}`}
                      onClick={() => void choose(option.key)}
                      onContextMenu={(event) => toggleEliminate(option.key, event)}
                    >
                      <span className="option-key">{option.key}</span>
                      <OptionContent option={option} sourceFilePath={current.filePath} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="question-footer">
            <div className="button-row">
              <Button
                icon={<ArrowLeftIcon />}
                disabled={index === 0}
                onClick={() => setIndex((value) => value - 1)}
              >
                上一题
              </Button>
              <Button
                appearance={currentUncertain ? 'secondary' : 'subtle'}
                icon={<FlagIcon />}
                onClick={toggleUncertain}
              >
                {currentUncertain ? '取消待查' : '标记不确定'}
              </Button>
            </div>
            <Button
              appearance="primary"
              disabled={index === questions.length - 1}
              onClick={() => setIndex((value) => value + 1)}
            >
              下一题
            </Button>
          </div>
        </Section>
        <Section
          title="答题卡"
          description={`${answered}/${exam.questionIds.length} 已作答${uncertainIds.length ? ` · ${uncertainIds.length} 题待查` : ''}`}
        >
          <div className="question-grid">
            {questions.map((question, questionIndex) => (
              <Button
                className={`question-number${uncertainIds.includes(question.id) ? ' is-uncertain' : ''}`}
                size="small"
                appearance={
                  questionIndex === index
                    ? 'primary'
                    : exam.answers[question.id]
                      ? 'secondary'
                      : 'subtle'
                }
                key={question.id}
                onClick={() => setIndex(questionIndex)}
              >
                {questionIndex + 1}
              </Button>
            ))}
          </div>
        </Section>
      </div>
      <Dialog open={confirmOpen} onOpenChange={(_, data) => setConfirmOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>确认交卷</DialogTitle>
            <DialogContent>
              还有 {exam.questionIds.length - answered} 道题未作答
              {uncertainIds.length > 0 ? `，另有 ${uncertainIds.length} 道题标记不确定` : ''}
              。交卷后不能继续修改，所有题目会一次性计入训练记录。
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmOpen(false)}>继续检查</Button>
              <Button appearance="primary" disabled={finishing} onClick={() => void finish()}>
                确认交卷
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
