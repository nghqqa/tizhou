import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Button,
  Checkbox,
  Field,
  Input,
  ProgressBar,
  Select,
  Tab,
  TabList,
  Textarea
} from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  BookmarkSimpleIcon,
  CalculatorIcon,
  CheckIcon,
  ClockIcon,
  ColumnsIcon,
  ExportIcon,
  FlagIcon,
  NotePencilIcon,
  PrinterIcon,
  RobotIcon,
  SkipForwardIcon
} from '@phosphor-icons/react'
import type {
  AiAskResult,
  AttemptResult,
  PracticeSelection,
  PracticeSession,
  Question,
  QuestionFacets,
  QuestionLibraryItem,
  ReviewItem,
  Subject
} from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { formatDate, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { OptionContent } from '../components/OptionContent'
import { ReadingTypographyBar, useReadingTypography } from '../components/ReadingTypographyControl'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { useAppStore } from '../store'

interface Category {
  name: string
  count: number
}

interface SessionResult {
  questionId: string
  result: AttemptResult
  /** 用户当时的作答（汇总模式结束后复盘对照用） */
  answer: string[]
}

interface TrainerInitial {
  mode?: PracticeSelection['mode']
  count?: number
  category?: string
  feedbackMode?: 'immediate' | 'summary'
  subject?: '' | Subject
  onlyWrong?: boolean
  onlyFavorite?: boolean
  onlyUnattempted?: boolean
  questionId?: string
  resumeActive?: boolean
}

const BAIGUAFEN_TABLE: Array<[string, string]> = [
  ['1/2', '50%'],
  ['1/3', '33.3%'],
  ['1/4', '25%'],
  ['1/5', '20%'],
  ['1/6', '16.7%'],
  ['1/7', '14.3%'],
  ['1/8', '12.5%'],
  ['1/9', '11.1%'],
  ['1/10', '10%'],
  ['1/11', '9.1%'],
  ['1/12', '8.3%'],
  ['1/13', '7.7%'],
  ['1/14', '7.1%'],
  ['1/15', '6.7%'],
  ['1/16', '6.25%'],
  ['1/17', '5.9%'],
  ['1/18', '5.6%'],
  ['1/19', '5.3%'],
  ['1/20', '5%']
]

const FORMULA_HINTS: Array<{ name: string; expr: string }> = [
  { name: '基期量', expr: 'A / (1 + r)' },
  { name: '增长量（r = 1/n）', expr: 'A / (n + 1)（减少：A / (n - 1)）' },
  { name: '间隔增长率', expr: 'r₁ + r₂ + r₁·r₂' },
  { name: '两期比重差', expr: '(A / B) · (a - b) / (1 + a)' },
  { name: '平均数增长率', expr: '(a - b) / (1 + b)' },
  { name: '混合增长率', expr: '居中且偏向基数（现期近似）较大者' }
]

function Trainer({
  review = false,
  initial
}: {
  review?: boolean
  initial?: TrainerInitial
}): React.JSX.Element {
  const navigate = useNavigate()
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const showToast = useAppStore((state) => state.showToast)
  const ai = useAppStore((state) => state.data!.ai)
  const [categories, setCategories] = useState<Category[]>([])
  const [facets, setFacets] = useState<QuestionFacets>({ years: [], regions: [], papers: [] })
  const [subject, setSubject] = useState<'' | Subject>(initial?.subject ?? 'xingce')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [year, setYear] = useState('')
  const [region, setRegion] = useState('')
  const [paper, setPaper] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [keyword, setKeyword] = useState('')
  const [onlyWrong, setOnlyWrong] = useState(Boolean(initial?.onlyWrong))
  const [onlyFavorite, setOnlyFavorite] = useState(Boolean(initial?.onlyFavorite))
  const [onlyUnattempted, setOnlyUnattempted] = useState(Boolean(initial?.onlyUnattempted))
  const [favorite, setFavorite] = useState(false)
  const [mode, setMode] = useState<PracticeSelection['mode']>(
    initial?.mode ?? (review ? 'review' : 'adaptive')
  )
  const [feedbackMode, setFeedbackMode] = useState<'immediate' | 'summary'>(
    initial?.feedbackMode ?? 'immediate'
  )
  const [count, setCount] = useState(initial?.count ?? 10)
  const [session, setSession] = useState<PracticeSession>()
  const [pendingSession, setPendingSession] = useState<PracticeSession>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [essayAnswer, setEssayAnswer] = useState('')
  const [result, setResult] = useState<AttemptResult>()
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([])
  const [summaryComplete, setSummaryComplete] = useState(false)
  const [similar, setSimilar] = useState<Question[]>([])
  const [aiExplanation, setAiExplanation] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const reading = useReadingTypography()
  const [wrongCause, setWrongCause] = useState('')
  const [reviewFeedback, setReviewFeedback] = useState<'forgot' | 'hard' | 'normal' | 'easy'>(
    'normal'
  )
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(review)
  const [error, setError] = useState('')
  const [eliminatedByQuestion, setEliminatedByQuestion] = useState<Record<string, string[]>>({})
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [showTimer, setShowTimer] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('tizhou:practice-show-timer') !== '0'
    } catch {
      return true
    }
  })
  const [materialSplit, setMaterialSplit] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('tizhou:practice-material-split') !== '0'
    } catch {
      return true
    }
  })
  const [showFormulaCard, setShowFormulaCard] = useState(false)
  const startedAt = useRef(Date.now())
  const currentQuestionIdRef = useRef('')
  const activeSessionIdRef = useRef('')

  useEffect(() => {
    // 科目/分类元数据跟随筛选变化（科目筛选来自 URL 参数或下拉选择，空值与 common 视为不限）
    const subjectFilter = subject === 'xingce' || subject === 'shenlun' ? subject : undefined
    void invoke<Category[]>({
      method: 'vault.categories',
      params: { subject: review ? undefined : subjectFilter }
    })
      .then(setCategories)
      .catch(() => setCategories([]))
    void invoke<QuestionFacets>({
      method: 'vault.facets',
      params: { subject: review ? undefined : subjectFilter }
    })
      .then(setFacets)
      .catch(() => setFacets({ years: [], regions: [], papers: [] }))
  }, [review, subject])

  // 会话恢复只在挂载时查一次；若带 questionId 或 resumeActive 则按需直达训练
  useEffect(() => {
    if (!review && initial?.questionId) {
      void startSession({
        mode: 'sequence',
        count: 1,
        feedbackMode: 'immediate',
        questionIds: [initial.questionId]
      })
      return
    }
    void invoke<PracticeSession | undefined>({
      method: 'practice.session.active',
      params: { mode: review ? 'review' : 'practice' }
    })
      .then((active) => {
        if (active) {
          if (review || initial?.resumeActive) {
            restoreSession(active)
            void reloadSessionResults(active)
          } else setPendingSession(active)
        } else if (review) {
          void startSession({ mode: 'review', count: 50, feedbackMode: 'immediate' })
        } else {
          setLoading(false)
        }
      })
      .catch(() => {
        if (review) void startSession({ mode: 'review', count: 50, feedbackMode: 'immediate' })
        else setLoading(false)
      })
  }, [review, initial?.questionId, initial?.resumeActive])

  const current = questions[index]
  currentQuestionIdRef.current = current?.id ?? ''
  activeSessionIdRef.current = session?.id ?? ''
  const currentRecord = current
    ? sessionResults.find((item) => item.questionId === current.id)
    : undefined
  const currentEliminated = current ? (eliminatedByQuestion[current.id] ?? []) : []

  useEffect(() => {
    if (!current || result || currentRecord) return
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [current?.id, result, currentRecord])

  function toggleTimerVisibility(): void {
    setShowTimer((value) => {
      const nextValue = !value
      try {
        window.localStorage.setItem('tizhou:practice-show-timer', nextValue ? '1' : '0')
      } catch {
        /* 忽略受限环境写入失败 */
      }
      return nextValue
    })
  }

  function toggleEliminate(key: string, event: React.MouseEvent): void {
    event.preventDefault()
    if (!current || result || currentRecord) return
    const alreadyEliminated = (eliminatedByQuestion[current.id] ?? []).includes(key)
    setEliminatedByQuestion((prev) => {
      const list = prev[current.id] ?? []
      const nextList = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
      return { ...prev, [current.id]: nextList }
    })
    // 右键划除当前已选中的选项时同步取消选中，确保划除态即时可见
    if (!alreadyEliminated && selected.includes(key)) {
      setSelected((prev) => prev.filter((item) => item !== key))
    }
  }

  useEffect(() => {
    if (!current) return
    let cancelled = false
    void invoke<string>({ method: 'note.get', params: { questionId: current.id } })
      .then((value) => {
        if (!cancelled) setNote(value)
      })
      .catch(() => {
        if (!cancelled) setNote('')
      })
    void invoke<boolean>({ method: 'favorite.get', params: { questionId: current.id } })
      .then((value) => {
        if (!cancelled) setFavorite(value)
      })
      .catch(() => {
        if (!cancelled) setFavorite(false)
      })
    return () => {
      cancelled = true
    }
  }, [current?.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 焦点在表单控件上或提交在途时不抢键盘：避免误提交或提交中跳题串状态
      if (
        !current ||
        loading ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLButtonElement
      )
        return
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        void jumpTo(index - 1)
        return
      }
      if (event.key === 'ArrowRight' && index + 1 < questions.length) {
        event.preventDefault()
        void jumpTo(index + 1)
        return
      }
      const optionIndex = /^[1-8]$/.test(event.key)
        ? Number(event.key) - 1
        : /^[a-h]$/i.test(event.key)
          ? event.key.toUpperCase().charCodeAt(0) - 65
          : -1
      const option = current.options[optionIndex]
      if (option && !result && !currentRecord) choose(option.key)
      if (
        event.key === 'Enter' &&
        !result &&
        !currentRecord &&
        (selected.length || essayAnswer.trim())
      )
        void submit()
      if (event.key.toLowerCase() === 'n' && (result || currentRecord)) void next()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    current,
    loading,
    result,
    currentRecord,
    selected,
    essayAnswer,
    index,
    questions.length,
    sessionResults
  ])

  function restoreSession(active: PracticeSession): void {
    const restored = active.questionIds
      .map((id) => active.questionSnapshots[id])
      .filter((question): question is Question => Boolean(question))
    setSession(active)
    setFeedbackMode(active.feedbackMode)
    setQuestions(restored)
    setIndex(Math.min(active.currentIndex, Math.max(0, restored.length - 1)))
    setPendingSession(undefined)
    setEliminatedByQuestion({})
    setLoading(false)
    startedAt.current = Date.now()
    setElapsedSeconds(0)
  }

  /** 会话恢复：从 attempts 重建本组已答记录，既支撑「整组汇总解析」恢复，
   *  也让右侧「本组答题卡」在重启恢复后保留对错状态并支持回看 */
  async function reloadSessionResults(active: PracticeSession): Promise<void> {
    try {
      const records = await invoke<
        Array<{ questionId: string; answer: string[]; correct: boolean }>
      >({ method: 'practice.session.results', params: { id: active.id } })
      const rebuilt: SessionResult[] = records.map((record) => {
        const snapshot = active.questionSnapshots[record.questionId]
        return {
          questionId: record.questionId,
          answer: record.answer,
          result: {
            attemptId: '',
            correct: record.correct,
            expected: snapshot?.answer ?? [],
            explanation: snapshot?.explanation ?? '',
            nextReviewAt: undefined,
            mastered: false
          }
        }
      })
      if (activeSessionIdRef.current !== active.id) return
      setSessionResults((prev) => {
        const merged = new Map<string, SessionResult>()
        for (const item of rebuilt) merged.set(item.questionId, item)
        // 保留恢复期间用户已经提交的新记录，避免被旧查询结果覆盖
        for (const item of prev) merged.set(item.questionId, item)
        return [...merged.values()]
      })
      const currentId = active.questionIds[active.currentIndex]
      if (currentId && currentQuestionIdRef.current === currentId) {
        const currentHit = rebuilt.find((item) => item.questionId === currentId)
        if (currentHit) {
          const snapshot = active.questionSnapshots[currentId]
          if (snapshot?.type === 'essay') setEssayAnswer(currentHit.answer[0] ?? '')
          else setSelected(currentHit.answer)
          if (active.feedbackMode === 'immediate') setResult(currentHit.result)
        }
      }
    } catch {
      // 拉取失败退化为内存态：不阻塞恢复本身
    }
  }

  async function startSession(override?: PracticeSelection): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const selection: PracticeSelection = override ?? {
        mode,
        count,
        feedbackMode,
        filter: {
          subject: subject === 'xingce' || subject === 'shenlun' ? subject : undefined,
          category: category || undefined,
          year: year ? Number(year) : undefined,
          region: region || undefined,
          paper: paper || undefined,
          difficulty: difficulty ? (Number(difficulty) as 1 | 2 | 3 | 4 | 5) : undefined,
          query: keyword.trim() || undefined,
          onlyWrong: onlyWrong || undefined,
          onlyFavorite: onlyFavorite || undefined,
          onlyUnattempted: onlyUnattempted || undefined
        }
      }
      const created = await invoke<PracticeSession>({
        method: 'practice.session.start',
        params: selection
      })
      restoreSession(created)
      setSelected([])
      setEssayAnswer('')
      setResult(undefined)
      setSessionResults([])
      setSummaryComplete(false)
      setSimilar([])
      setAiExplanation('')
      setWrongCause('')
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : '选题失败'
      // 错题复习页 0 到期时展示干净空态，不再叠加多余的红条报错
      if (!(review && msg.includes('没有可用题目'))) {
        setError(msg)
      }
      setQuestions([])
    } finally {
      setLoading(false)
    }
  }

  async function abandonPending(): Promise<void> {
    if (!pendingSession) return
    await invoke({
      method: 'practice.session.complete',
      params: { id: pendingSession.id, abandoned: true }
    })
    setPendingSession(undefined)
  }

  function choose(key: string): void {
    if (!current || result || currentRecord) return
    // 左键选中被划除的选项时自动取消划除态
    if (currentEliminated.includes(key)) {
      setEliminatedByQuestion((prev) => ({
        ...prev,
        [current.id]: (prev[current.id] ?? []).filter((item) => item !== key)
      }))
    }
    if (current.type === 'multiple') {
      setSelected((values) =>
        values.includes(key) ? values.filter((value) => value !== key) : [...values, key]
      )
    } else setSelected([key])
  }

  async function toggleUncertain(): Promise<void> {
    if (!session || !current) return
    const uncertainIds = session.uncertainIds.includes(current.id)
      ? session.uncertainIds.filter((id) => id !== current.id)
      : [...session.uncertainIds, current.id]
    const updated = await invoke<PracticeSession>({
      method: 'practice.session.update',
      params: { id: session.id, uncertainIds }
    })
    setSession(updated)
  }

  async function toggleFavorite(): Promise<void> {
    if (!current) return
    const next = !favorite
    try {
      await invoke({ method: 'favorite.set', params: { questionId: current.id, favorite: next } })
      setFavorite(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '收藏操作失败')
    }
  }

  async function submit(): Promise<void> {
    if (!current || loading) return
    const answer = current.type === 'essay' ? [essayAnswer.trim()] : selected
    if (!answer[0]) {
      setError('请先填写或选择答案')
      return
    }
    const submittedQuestionId = current.id
    const submittedSessionId = session?.id ?? ''
    setLoading(true)
    setError('')
    try {
      const response = await invoke<AttemptResult>({
        method: 'attempt.submit',
        params: {
          questionId: submittedQuestionId,
          answer,
          durationSeconds: Math.round((Date.now() - startedAt.current) / 1000),
          mode: review ? 'review' : 'practice',
          sessionId: session?.id,
          wrongCause,
          reviewFeedback: review ? reviewFeedback : undefined
        }
      })
      void refreshDashboard()
      if (activeSessionIdRef.current !== submittedSessionId) return
      const updatedResults = [
        ...sessionResults.filter((item) => item.questionId !== submittedQuestionId),
        { questionId: submittedQuestionId, result: response, answer }
      ]
      setSessionResults((prev) => [
        ...prev.filter((item) => item.questionId !== submittedQuestionId),
        { questionId: submittedQuestionId, result: response, answer }
      ])
      if (feedbackMode === 'summary') {
        const answeredIds = new Set(updatedResults.map((item) => item.questionId))
        let nextUnanswered = -1
        for (let offset = 1; offset <= questions.length; offset += 1) {
          const candidate = (index + offset) % questions.length
          const candidateQuestion = questions[candidate]
          if (candidateQuestion && !answeredIds.has(candidateQuestion.id)) {
            nextUnanswered = candidate
            break
          }
        }
        if (nextUnanswered === -1) {
          if (session)
            await invoke({ method: 'practice.session.complete', params: { id: session.id } })
          setSummaryComplete(true)
        } else if (currentQuestionIdRef.current === submittedQuestionId) {
          await jumpTo(nextUnanswered, updatedResults)
        }
      } else if (currentQuestionIdRef.current === submittedQuestionId) {
        setResult(response)
        const similarList = await invoke<Question[]>({
          method: 'questions.similar',
          params: { id: submittedQuestionId, limit: 3 }
        })
        if (currentQuestionIdRef.current === submittedQuestionId) {
          setSimilar(similarList)
        }
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : '提交失败'
      if (currentQuestionIdRef.current === submittedQuestionId) {
        setError(msg)
      } else {
        showToast(`上一题提交失败：${msg}`)
      }
    } finally {
      setLoading(false)
    }
  }

  function resetQuestionState(): void {
    setSelected([])
    setEssayAnswer('')
    setResult(undefined)
    setWrongCause('')
    setReviewFeedback('normal')
    setSimilar([])
    setAiExplanation('')
    setError('')
    startedAt.current = Date.now()
    setElapsedSeconds(0)
  }

  async function jumpTo(
    targetIndex: number,
    resultsPool: SessionResult[] = sessionResults
  ): Promise<void> {
    if (targetIndex < 0 || targetIndex >= questions.length) return
    if (session) {
      const updated = await invoke<PracticeSession>({
        method: 'practice.session.update',
        params: { id: session.id, currentIndex: targetIndex }
      })
      setSession(updated)
    }
    const target = questions[targetIndex]
    const existing = target ? resultsPool.find((item) => item.questionId === target.id) : undefined
    setIndex(targetIndex)
    resetQuestionState()
    if (existing && target) {
      if (target.type === 'essay') setEssayAnswer(existing.answer[0] ?? '')
      else setSelected(existing.answer)
      if (feedbackMode === 'immediate') {
        setResult(existing.result)
        void invoke<Question[]>({
          method: 'questions.similar',
          params: { id: target.id, limit: 3 }
        })
          .then((list) => {
            if (currentQuestionIdRef.current === target.id) setSimilar(list)
          })
          .catch(() => {
            if (currentQuestionIdRef.current === target.id) setSimilar([])
          })
      }
    }
  }

  async function next(): Promise<void> {
    if (index + 1 >= questions.length) {
      if (session) await invoke({ method: 'practice.session.complete', params: { id: session.id } })
      setQuestions([])
      setSession(undefined)
      setSessionResults([])
      setEliminatedByQuestion({})
      setIndex(0)
      return
    }
    await jumpTo(index + 1)
  }

  async function saveNote(): Promise<void> {
    if (!current) return
    try {
      await invoke({ method: 'note.save', params: { questionId: current.id, content: note } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记保存失败')
    }
  }

  async function askAiAboutCurrent(): Promise<void> {
    if (!current || !result) return
    setAiBusy(true)
    setError('')
    try {
      const response = await invoke<AiAskResult>({
        method: 'ai.ask',
        params: {
          purpose: 'explain',
          messages: [
            {
              role: 'system',
              content: FEATURE_PROMPTS.wrongQuestion
            },
            {
              role: 'user',
              content: taskDataEnvelope('错题讲解输入', {
                question: {
                  subject: current.subject,
                  category: current.category,
                  type: current.type,
                  material: current.material ?? '',
                  stem: current.stem,
                  options: current.options
                },
                studentAnswer: selected.length ? selected : essayAnswer,
                referenceAnswer: result.expected,
                referenceExplanation: result.explanation
              })
            }
          ]
        }
      })
      setAiExplanation(response.content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 讲解失败')
    } finally {
      setAiBusy(false)
    }
  }

  if (loading && !current)
    return (
      <div className="page">
        <LoadingState label="正在准备题目" />
      </div>
    )

  if (summaryComplete) {
    // 分母基于完整题目列表（快照恢复后内存态 sessionResults 可能缺失历史作答）
    const correctCount = sessionResults.filter((item) => item.result.correct).length
    return (
      <Section
        title={`本组完成：${correctCount}/${questions.length} 正确`}
        description="汇总模式在全部作答完成后统一展示答案与解析。"
        actions={
          <Button
            appearance="primary"
            onClick={() => {
              setSummaryComplete(false)
              setQuestions([])
              setSession(undefined)
              setSessionResults([])
            }}
          >
            返回训练配置
          </Button>
        }
      >
        {questions.map((question, questionIndex) => {
          const item = sessionResults.find((entry) => entry.questionId === question.id)
          return (
            <div className="answer-panel" key={question.id}>
              <h3 className={item?.result.correct ? 'positive' : 'negative'}>
                第 {questionIndex + 1} 题：
                {item ? (item.result.correct ? '正确' : '错误') : '未作答'}
              </h3>
              {question.material && (
                <>
                  <strong>给定材料</strong>
                  <MarkdownContent content={question.material} sourceFilePath={question.filePath} />
                </>
              )}
              <MarkdownContent content={question.stem} sourceFilePath={question.filePath} />
              {question.options.length > 0 && (
                <div className="review-options">
                  {question.options.map((option) => {
                    const isAnswer = question.answer.includes(option.key)
                    const isChosen = (item?.answer ?? []).includes(option.key)
                    return (
                      <div
                        key={option.key}
                        className={`review-option ${
                          isAnswer ? 'correct' : isChosen ? 'wrong' : ''
                        }`.trim()}
                      >
                        <span className="option-key">{option.key}</span>
                        <OptionContent option={option} sourceFilePath={question.filePath} />
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
                你的作答：{item?.answer?.length ? item.answer.join('、') : '未作答'} · 参考答案：
                {question.answer.join('、')}
              </p>
              <MarkdownContent content={question.explanation} sourceFilePath={question.filePath} />
            </div>
          )
        })}
      </Section>
    )
  }

  if (!questions.length) {
    if (pendingSession) {
      return (
        <Section
          title="发现未完成训练"
          description={`上次停在第 ${pendingSession.currentIndex + 1}/${pendingSession.questionIds.length} 题，题目快照已保留。`}
        >
          <div className="button-row">
            <Button
              appearance="primary"
              onClick={() => {
                restoreSession(pendingSession)
                void reloadSessionResults(pendingSession)
              }}
            >
              继续上次训练
            </Button>
            <Button onClick={() => void abandonPending()}>放弃并新建</Button>
          </div>
        </Section>
      )
    }
    if (review)
      return (
        <>
          {error && <ErrorState message={error} />}
          <EmptyState
            title="今天没有到期错题"
            description="答错后次日进入复习，反馈等级会调整下次间隔，稳定答对后标记为掌握。"
            actionLabel="刷新复习队列"
            onAction={() =>
              void startSession({ mode: 'review', count: 50, feedbackMode: 'immediate' })
            }
          />
        </>
      )
    return (
      <Section
        title="训练配置"
        description="题目来自当前活动知识库，训练会话定期落盘并保留内容快照。"
      >
        {error && <ErrorState message={error} />}
        <div className="form-grid">
          <Field label="选题策略">
            <Select
              value={mode}
              onChange={(_, data) => setMode(data.value as PracticeSelection['mode'])}
            >
              <option value="adaptive">自适应优先</option>
              <option value="random">随机抽题</option>
              <option value="sequence">顺序训练</option>
            </Select>
          </Field>
          <Field label="科目">
            <Select
              value={subject}
              onChange={(_, data) => {
                // 切科目时联动清空旧科目维度的残余筛选，避免「申论科目 + 行测模块」这类矛盾组合
                setSubject(data.value as '' | Subject)
                setCategory('')
                setYear('')
                setRegion('')
                setPaper('')
              }}
            >
              <option value="xingce">行测</option>
              <option value="shenlun">申论</option>
              <option value="">全部科目</option>
            </Select>
          </Field>
          <Field label="专项模块">
            <Select value={category} onChange={(_, data) => setCategory(data.value)}>
              <option value="">全部模块</option>
              {categories.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}（{item.count}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="难度">
            <Select value={difficulty} onChange={(_, data) => setDifficulty(data.value)}>
              <option value="">全部难度</option>
              <option value="1">1 · 很容易</option>
              <option value="2">2 · 较容易</option>
              <option value="3">3 · 中等</option>
              <option value="4">4 · 较难</option>
              <option value="5">5 · 很难</option>
            </Select>
          </Field>
          <Field label="解析方式">
            <Select
              value={feedbackMode}
              onChange={(_, data) => setFeedbackMode(data.value as 'immediate' | 'summary')}
            >
              <option value="immediate">每题立即解析</option>
              <option value="summary">整组汇总解析</option>
            </Select>
          </Field>
          <Field label="关键词" className="grow">
            <Input
              value={keyword}
              onChange={(_, data) => setKeyword(data.value)}
              placeholder="按题干、解析或标签搜索"
            />
          </Field>
          {facets.years.length > 0 && (
            <Field label="年份">
              <Select value={year} onChange={(_, data) => setYear(data.value)}>
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
              <Select value={region} onChange={(_, data) => setRegion(data.value)}>
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
            <Field className="full" label="试卷">
              <Select value={paper} onChange={(_, data) => setPaper(data.value)}>
                <option value="">全部试卷</option>
                {facets.papers.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="本组题数">
            <Input
              type="number"
              min={1}
              max={100}
              value={String(count)}
              onChange={(_, data) => setCount(Math.max(1, Math.min(100, Number(data.value) || 1)))}
            />
          </Field>
          <div className="filter-toggles">
            <Checkbox
              label="只练未做"
              checked={onlyUnattempted}
              onChange={(_, data) => {
                const checked = Boolean(data.checked)
                setOnlyUnattempted(checked)
                if (checked) setOnlyWrong(false)
              }}
            />
            <Checkbox
              label="只练错题"
              checked={onlyWrong}
              onChange={(_, data) => {
                const checked = Boolean(data.checked)
                setOnlyWrong(checked)
                if (checked) setOnlyUnattempted(false)
              }}
            />
            <Checkbox
              label="只练收藏"
              checked={onlyFavorite}
              onChange={(_, data) => setOnlyFavorite(Boolean(data.checked))}
            />
          </div>
          <div className="button-row full">
            <Button appearance="primary" onClick={() => void startSession()}>
              生成训练
            </Button>
          </div>
        </div>
      </Section>
    )
  }

  if (!current)
    return (
      <EmptyState
        title="题目快照不可用"
        description="该会话可能损坏，请放弃后重新生成。"
        actionLabel="返回配置"
        onAction={() => setQuestions([])}
      />
    )

  const uncertain = session?.uncertainIds.includes(current.id) ?? false
  const timerText = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`
  const answeredMap = new Map(sessionResults.map((item) => [item.questionId, item]))
  const locked = Boolean(result || currentRecord)
  return (
    <div className="question-shell">
      <Section className="question-card">
        {error && <ErrorState message={error} />}
        <div className="progress-text">
          <span>
            第 {index + 1} 题 / 共 {questions.length} 题
          </span>
          <span className="progress-right">
            <span>
              {current.category} · 难度 {current.difficulty}
            </span>
            <button
              type="button"
              className={`practice-timer${showTimer && elapsedSeconds >= 60 && !locked ? ' is-overtime' : ''}`}
              title={showTimer ? '点击隐藏单题计时' : '点击显示单题计时'}
              onClick={toggleTimerVisibility}
            >
              <ClockIcon size={12} />
              {showTimer ? timerText : '计时已隐藏'}
            </button>
          </span>
        </div>
        <ProgressBar value={(index + 1) / questions.length} />
        <div className="question-top-bar">
          <div className="question-meta">
            <span className="pill">
              {current.type === 'single'
                ? '单选题'
                : current.type === 'multiple'
                  ? '多选题'
                  : current.type === 'judge'
                    ? '判断题'
                    : '主观题'}
            </span>
            <span className="pill">{current.source}</span>
            {current.year && <span className="pill">{current.year}</span>}
            {current.region && <span className="pill">{current.region}</span>}
            {current.paper && <span className="pill">{current.paper}</span>}
            {uncertain && <span className="pill warning">待复查</span>}
          </div>
          <div className="question-top-tools">
            {current.material && (
              <Button
                size="small"
                appearance={materialSplit ? 'secondary' : 'subtle'}
                icon={<ColumnsIcon />}
                title="切换材料左右分栏 / 上下排布"
                onClick={() => {
                  setMaterialSplit((value) => {
                    const nextValue = !value
                    try {
                      window.localStorage.setItem(
                        'tizhou:practice-material-split',
                        nextValue ? '1' : '0'
                      )
                    } catch {
                      /* 忽略 */
                    }
                    return nextValue
                  })
                }}
              >
                {materialSplit ? '分栏对照' : '上下排布'}
              </Button>
            )}
            <Button
              size="small"
              appearance={showFormulaCard ? 'secondary' : 'subtle'}
              icon={<CalculatorIcon />}
              title="展开/收起行测速算与百化分速查卡"
              onClick={() => setShowFormulaCard((value) => !value)}
            >
              速查卡
            </Button>
            <ReadingTypographyBar
              typography={reading.typography}
              onUpdate={reading.update}
              onStepScale={reading.stepScale}
              onResetScale={reading.resetScale}
            />
          </div>
        </div>
        {showFormulaCard && (
          <div className="formula-cheat-card">
            <div className="formula-cheat-col">
              <strong>常用百化分速查</strong>
              <div className="baiguafen-grid">
                {BAIGUAFEN_TABLE.map(([frac, pct]) => (
                  <span key={frac} className="baiguafen-chip">
                    <b>{frac}</b> = {pct}
                  </span>
                ))}
              </div>
            </div>
            <div className="formula-cheat-col">
              <strong>资料分析高频公式</strong>
              <ul className="formula-list">
                {FORMULA_HINTS.map((item) => (
                  <li key={item.name}>
                    <b>{item.name}：</b>
                    <span>{item.expr}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {(() => {
          // 识别同材料连题组（同 groupId 或同材料文本），在左栏提供小题快切条
          const siblingIndices: number[] = []
          if (current.material) {
            questions.forEach((q, qIdx) => {
              const sameGroup =
                (current.groupId && q.groupId && q.groupId === current.groupId) ||
                (q.material && q.material === current.material)
              if (sameGroup) siblingIndices.push(qIdx)
            })
          }
          const useSplit = Boolean(current.material && materialSplit)
          const questionBody = (
            <div className="material-split-right">
              <MarkdownContent
                className="question-stem"
                content={current.stem}
                sourceFilePath={current.filePath}
              />
              {current.type === 'essay' ? (
                <Textarea
                  resize="vertical"
                  rows={8}
                  value={essayAnswer}
                  onChange={(_, data) => setEssayAnswer(data.value)}
                  placeholder="写下你的作答要点"
                  disabled={locked}
                />
              ) : (
                <div className="options">
                  {current.options.map((option) => {
                    const eliminated = !locked && currentEliminated.includes(option.key)
                    return (
                      <button
                        type="button"
                        key={option.key}
                        title={locked ? undefined : '左键选择 · 右键排除干扰项'}
                        className={`option-button ${
                          result
                            ? current.answer.includes(option.key)
                              ? 'correct'
                              : selected.includes(option.key)
                                ? 'wrong'
                                : 'dimmed'
                            : selected.includes(option.key)
                              ? 'selected'
                              : eliminated
                                ? 'is-eliminated'
                                : ''
                        }`}
                        onClick={() => choose(option.key)}
                        onContextMenu={(event) => toggleEliminate(option.key, event)}
                        disabled={locked}
                      >
                        <span className="option-key">{option.key}</span>
                        <OptionContent option={option} sourceFilePath={current.filePath} />
                      </button>
                    )
                  })}
                </div>
              )}
              {result && (
                <div className="answer-panel">
                  <h3 className={result.correct ? 'positive' : 'negative'}>
                    {result.correct ? '回答正确' : '回答错误'}
                  </h3>
                  <p>参考答案：{result.expected.join('、')}</p>
                  <MarkdownContent content={result.explanation} sourceFilePath={current.filePath} />
                  {result.nextReviewAt && <p className="muted">已安排下一次间隔复习。</p>}
                  {result.mastered && <p className="positive">稳定答对，已标记为掌握。</p>}
                </div>
              )}
            </div>
          )
          return (
            <div
              ref={reading.surfaceRef}
              className={`question-reading-surface${useSplit ? ' material-split-layout' : ''}`}
              data-reading-font={reading.typography.font}
              style={reading.surfaceStyle}
            >
              {current.material && (
                <div className={useSplit ? 'material-split-left' : 'answer-panel'}>
                  <div className="material-split-head">
                    <strong>给定材料</strong>
                    {siblingIndices.length > 1 && (
                      <div className="material-sibling-tabs">
                        {siblingIndices.map((qIdx, order) => {
                          const sib = questions[qIdx]!
                          const sibRec = answeredMap.get(sib.id)
                          return (
                            <button
                              key={sib.id}
                              type="button"
                              disabled={loading}
                              className={`material-sibling-tab${qIdx === index ? ' is-active' : ''}${sibRec ? (sibRec.result.correct ? ' is-correct' : ' is-wrong') : ''}`}
                              onClick={() => void jumpTo(qIdx)}
                            >
                              第 {order + 1} 问
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <MarkdownContent content={current.material} sourceFilePath={current.filePath} />
                </div>
              )}
              {questionBody}
            </div>
          )
        })()}
        <div className="question-footer">
          <div className="button-row">
            {index > 0 && (
              <Button
                appearance="subtle"
                icon={<ArrowLeftIcon />}
                disabled={loading}
                onClick={() => void jumpTo(index - 1)}
              >
                上一题
              </Button>
            )}
            <Button
              appearance={favorite ? 'secondary' : 'subtle'}
              icon={<BookmarkSimpleIcon weight={favorite ? 'fill' : undefined} />}
              onClick={() => void toggleFavorite()}
            >
              {favorite ? '已收藏，点击取消' : '收藏'}
            </Button>
            <Button
              appearance={uncertain ? 'secondary' : 'subtle'}
              icon={<FlagIcon />}
              onClick={() => void toggleUncertain()}
            >
              {uncertain ? '取消待查' : '不确定'}
            </Button>
          </div>
          {locked ? (
            <Button appearance="primary" icon={<SkipForwardIcon />} onClick={() => void next()}>
              {index + 1 >= questions.length ? '完成本组' : '下一题'}
            </Button>
          ) : (
            <Button
              appearance="primary"
              icon={<CheckIcon />}
              onClick={() => void submit()}
              disabled={loading}
            >
              提交答案
            </Button>
          )}
        </div>
      </Section>
      <div className="side-stack">
        <Section
          title="本组答题卡"
          description={`已答 ${sessionResults.length} / ${questions.length} 题${session?.uncertainIds.length ? ` · ${session.uncertainIds.length} 题待查` : ''}`}
        >
          <div className="question-grid">
            {questions.map((question, questionIndex) => {
              const rec = answeredMap.get(question.id)
              const isUncertain = session?.uncertainIds.includes(question.id) ?? false
              const statusClass =
                rec && feedbackMode === 'immediate'
                  ? rec.result.correct
                    ? ' is-correct'
                    : ' is-wrong'
                  : ''
              return (
                <Button
                  key={question.id}
                  className={`question-number${statusClass}${isUncertain ? ' is-uncertain' : ''}`}
                  size="small"
                  appearance={questionIndex === index ? 'primary' : rec ? 'secondary' : 'subtle'}
                  disabled={loading}
                  onClick={() => void jumpTo(questionIndex)}
                >
                  {questionIndex + 1}
                </Button>
              )
            })}
          </div>
        </Section>
        <Section title="错因标注" description="标注会进入报告，用于区分知识和操作问题。">
          <Field label="本题主要风险">
            <Select
              value={wrongCause}
              onChange={(_, data) => setWrongCause(data.value)}
              disabled={Boolean(result)}
            >
              <option value="">暂不标注</option>
              <option value="知识缺口">知识缺口</option>
              <option value="概念混淆">概念混淆</option>
              <option value="审题失误">审题失误</option>
              <option value="计算失误">计算失误</option>
              <option value="时间压力">时间压力</option>
              <option value="猜测">猜测</option>
              <option value="未知">未知</option>
            </Select>
          </Field>
          {review && (
            <Field label="本次记忆反馈" style={{ marginTop: 12 }}>
              <Select
                value={reviewFeedback}
                onChange={(_, data) =>
                  setReviewFeedback(data.value as 'forgot' | 'hard' | 'normal' | 'easy')
                }
                disabled={Boolean(result)}
              >
                <option value="forgot">忘记</option>
                <option value="hard">困难</option>
                <option value="normal">一般</option>
                <option value="easy">熟练</option>
              </Select>
            </Field>
          )}
        </Section>
        <Section title="本题笔记">
          <Textarea
            rows={5}
            resize="vertical"
            value={note}
            onChange={(_, data) => setNote(data.value)}
            placeholder="记录方法、陷阱或复盘结论"
          />
          <Button
            icon={<NotePencilIcon />}
            style={{ marginTop: 10 }}
            onClick={() => void saveNote()}
          >
            保存笔记
          </Button>
        </Section>
        {result && similar.length > 0 && (
          <Section title="相似题" description="按模块、标签与难度在本地匹配。">
            <ul className="data-list">
              {similar.map((question) => (
                <li className="data-row" key={question.id}>
                  <div>
                    <strong>{question.stem}</strong>
                    <span>
                      {question.category} · 难度 {question.difficulty}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {result && (ai.hasApiKey || ai.provider === 'ollama' || ai.provider === 'lmstudio') && (
          <Section title="AI 深讲" description="白名单上下文：当前题、材料、你的答案与官方解析。">
            {aiExplanation ? (
              <>
                <MarkdownContent content={aiExplanation} />
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<RobotIcon />}
                  style={{ marginTop: 10 }}
                  onClick={() => navigate(`/ai?questionId=${encodeURIComponent(current.id)}`)}
                >
                  带本题去 AI 助教继续追问
                </Button>
              </>
            ) : (
              <div className="button-row">
                <Button disabled={aiBusy} onClick={() => void askAiAboutCurrent()}>
                  {aiBusy ? '正在分析' : '解释本题易错点'}
                </Button>
                <Button
                  appearance="subtle"
                  icon={<RobotIcon />}
                  onClick={() => navigate(`/ai?questionId=${encodeURIComponent(current.id)}`)}
                >
                  去助教追问
                </Button>
              </div>
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

export function PracticePage(): React.JSX.Element {
  const [searchParams] = useSearchParams()
  const recommended = searchParams.get('recommended')
  const mode = searchParams.get('mode') as PracticeSelection['mode'] | null
  const count = Number(searchParams.get('count')) || undefined
  const category = searchParams.get('category') ?? undefined
  const onlyWrong = searchParams.get('onlyWrong') === '1'
  const onlyFavorite = searchParams.get('onlyFavorite') === '1'
  const onlyUnattempted = searchParams.get('onlyUnattempted') === '1'
  const questionId = searchParams.get('questionId') ?? undefined
  const resumeActive = searchParams.get('resumeActive') === '1'
  const subjectParam = searchParams.get('subject')
  const subject =
    subjectParam === 'xingce' || subjectParam === 'shenlun' || subjectParam === 'common'
      ? subjectParam === 'common'
        ? ''
        : subjectParam
      : undefined
  const initial: TrainerInitial | undefined =
    mode ||
    count ||
    category ||
    onlyWrong ||
    onlyFavorite ||
    onlyUnattempted ||
    questionId ||
    resumeActive ||
    subject !== undefined
      ? {
          mode: mode ?? undefined,
          count,
          category,
          onlyWrong,
          onlyFavorite,
          onlyUnattempted,
          questionId,
          resumeActive,
          feedbackMode: 'immediate',
          subject: subject ?? (onlyWrong || onlyFavorite ? '' : 'xingce')
        }
      : undefined
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 专项练习"
        title="专项练习"
        description="支持会话恢复、内容快照、分栏材料对照、速查卡、键盘选项和自适应选题。"
      />
      {recommended && (
        <div className="answer-panel" style={{ marginBottom: 14 }}>
          <p className="positive" style={{ margin: 0 }}>
            ✓ 已根据你的薄弱模块生成训练建议：{recommended}
            {count ? ` · ${count} 题` : ''}。你可以直接开始，也可以调整下方配置。
          </p>
        </div>
      )}
      <Trainer key={questionId ?? (resumeActive ? 'resume' : 'default')} initial={initial} />
    </div>
  )
}

function QuestionLibraryView({ tab }: { tab: 'wrong' | 'favorite' | 'notes' }): React.JSX.Element {
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const [items, setItems] = useState<QuestionLibraryItem[]>()
  const [categories, setCategories] = useState<Category[]>([])
  const [category, setCategory] = useState('')
  const [wrongCause, setWrongCause] = useState('')
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [savingNoteId, setSavingNoteId] = useState('')
  const [exportIncludeAnswers, setExportIncludeAnswers] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void invoke<Category[]>({ method: 'vault.categories', params: {} })
      .then(setCategories)
      .catch(() => setCategories([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setError('')
      void invoke<QuestionLibraryItem[]>({
        method: 'questions.library',
        params: {
          tab,
          category: category || undefined,
          wrongCause: tab === 'wrong' && wrongCause ? wrongCause : undefined,
          query: query.trim() || undefined,
          limit: 200
        }
      })
        .then((rows) => {
          if (cancelled) return
          setItems(rows)
          setNoteDrafts((prev) => {
            const next = { ...prev }
            for (const row of rows) {
              if (!(row.question.id in next)) next[row.question.id] = row.note
            }
            return next
          })
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : '题单读取失败')
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [tab, category, wrongCause, query])

  async function toggleFavoriteItem(item: QuestionLibraryItem): Promise<void> {
    const nextFav = !item.favorite
    try {
      await invoke({
        method: 'favorite.set',
        params: { questionId: item.question.id, favorite: nextFav }
      })
      setItems((prev) => {
        if (!prev) return prev
        if (tab === 'favorite' && !nextFav) {
          return prev.filter((row) => row.question.id !== item.question.id)
        }
        return prev.map((row) =>
          row.question.id === item.question.id ? { ...row, favorite: nextFav } : row
        )
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '收藏更新失败')
    }
  }

  async function saveLibraryNote(questionId: string): Promise<void> {
    const content = noteDrafts[questionId] ?? ''
    setSavingNoteId(questionId)
    setError('')
    try {
      await invoke({ method: 'note.save', params: { questionId, content } })
      setItems((prev) => {
        if (!prev) return prev
        if (tab === 'notes' && !content.trim()) {
          return prev.filter((row) => row.question.id !== questionId)
        }
        return prev.map((row) => (row.question.id === questionId ? { ...row, note: content } : row))
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记保存失败')
    } finally {
      setSavingNoteId('')
    }
  }

  const emptyTitle =
    tab === 'wrong'
      ? '当前筛选下没有未掌握错题'
      : tab === 'favorite'
        ? '当前筛选下没有收藏题目'
        : '还没有保存过题目笔记'
  const emptyDescription =
    tab === 'wrong'
      ? '在专项练习或模考中答错的题目会自动收入错题本，连续稳定答对后移出。'
      : tab === 'favorite'
        ? '练习时点击「收藏」即可把好题、高频易错题收进收藏夹。'
        : '在专项练习右侧「本题笔记」记录做题心得后，会集中汇总在这里方便考前速览。'

  async function exportLibrary(format: 'markdown' | 'html'): Promise<void> {
    if (!items?.length || exporting) return
    setExporting(true)
    setError('')
    try {
      const target = await invoke<string | undefined>({
        method: 'questions.library.export',
        params: {
          tab,
          category: category || undefined,
          wrongCause: tab === 'wrong' && wrongCause ? wrongCause : undefined,
          query: query.trim() || undefined,
          includeAnswers: exportIncludeAnswers,
          includeNotes: true,
          format
        }
      })
      if (target) showToast(`已导出：${target}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Section
      title={tab === 'wrong' ? '错题本' : tab === 'favorite' ? '我的收藏' : '我的笔记'}
      description={
        items
          ? `共找到 ${items.length} 道题目${items.length >= 200 ? '（仅展示前 200 条，可叠加筛选缩小范围）' : ''}`
          : '正在读取…'
      }
      actions={
        items && items.length > 0 ? (
          <div className="button-row library-export-bar">
            <Checkbox
              label="导出含答案"
              checked={exportIncludeAnswers}
              onChange={(_, data) => setExportIncludeAnswers(Boolean(data.checked))}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<ExportIcon />}
              disabled={exporting}
              onClick={() => void exportLibrary('markdown')}
            >
              导出 MD
            </Button>
            <Button
              size="small"
              appearance="subtle"
              icon={<PrinterIcon />}
              disabled={exporting}
              onClick={() => void exportLibrary('html')}
            >
              打印版 HTML
            </Button>
            {tab !== 'notes' && (
              <Button
                appearance="primary"
                size="small"
                onClick={() => {
                  const params = new URLSearchParams()
                  params.set(tab === 'wrong' ? 'onlyWrong' : 'onlyFavorite', '1')
                  if (category) params.set('category', category)
                  navigate(`/practice?${params.toString()}`)
                }}
              >
                {tab === 'wrong' ? '针对当前筛选练错题' : '针对当前筛选练收藏'}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="toolbar">
        <Field label="关键词" className="grow">
          <Input
            value={query}
            onChange={(_, data) => setQuery(data.value)}
            placeholder="搜索题干、解析、标签或笔记内容"
          />
        </Field>
        <Field label="专项模块">
          <Select value={category} onChange={(_, data) => setCategory(data.value)}>
            <option value="">全部模块</option>
            {categories.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}（{item.count}）
              </option>
            ))}
          </Select>
        </Field>
        {tab === 'wrong' && (
          <Field label="错因筛选">
            <Select value={wrongCause} onChange={(_, data) => setWrongCause(data.value)}>
              <option value="">全部错因</option>
              <option value="知识缺口">知识缺口</option>
              <option value="概念混淆">概念混淆</option>
              <option value="审题失误">审题失误</option>
              <option value="计算失误">计算失误</option>
              <option value="时间压力">时间压力</option>
              <option value="猜测">猜测</option>
              <option value="未知">未知</option>
              <option value="未标注">未标注</option>
            </Select>
          </Field>
        )}
      </div>
      {error && <ErrorState message={error} />}
      {!items ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="library-list">
          {items.map((item) => {
            const q = item.question
            const expanded = expandedId === q.id
            const noteValue = noteDrafts[q.id] ?? item.note
            return (
              <div key={q.id} className="library-card">
                <div className="library-card-head">
                  <div className="question-meta" style={{ marginBottom: 0 }}>
                    <span className="pill">{q.category}</span>
                    <span className="pill">难度 {q.difficulty}</span>
                    {item.wrongCount > 0 && (
                      <span className="pill warning">错 {item.wrongCount} 次</span>
                    )}
                    {item.lastWrongCause && <span className="pill">{item.lastWrongCause}</span>}
                    {item.dueAt && <span className="pill">复习 {formatDate(item.dueAt)}</span>}
                    {q.year && <span className="pill">{q.year}</span>}
                  </div>
                  <div className="button-row">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<RobotIcon />}
                      onClick={() => navigate(`/ai?questionId=${encodeURIComponent(q.id)}`)}
                    >
                      AI 追问
                    </Button>
                    <Button
                      size="small"
                      appearance={item.favorite ? 'secondary' : 'subtle'}
                      icon={<BookmarkSimpleIcon weight={item.favorite ? 'fill' : undefined} />}
                      onClick={() => void toggleFavoriteItem(item)}
                    >
                      {item.favorite ? '已收藏' : '收藏'}
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => setExpandedId(expanded ? '' : q.id)}
                    >
                      {expanded ? '收起解析' : '展开解析与笔记'}
                    </Button>
                  </div>
                </div>
                <div className="library-stem">
                  <MarkdownContent content={q.stem} sourceFilePath={q.filePath} />
                </div>
                {item.note && !expanded && (
                  <p className="library-note-preview">笔记：{item.note}</p>
                )}
                {expanded && (
                  <div className="answer-panel">
                    {q.material && (
                      <div style={{ marginBottom: 10 }}>
                        <strong>给定材料</strong>
                        <MarkdownContent content={q.material} sourceFilePath={q.filePath} />
                      </div>
                    )}
                    {q.options.length > 0 && (
                      <div className="review-options">
                        {q.options.map((option) => {
                          const isAnswer = q.answer.includes(option.key)
                          return (
                            <div
                              key={option.key}
                              className={`review-option ${isAnswer ? 'correct' : ''}`.trim()}
                            >
                              <span className="option-key">{option.key}</span>
                              <OptionContent option={option} sourceFilePath={q.filePath} />
                              <span className="muted">{isAnswer ? '参考答案' : ''}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <p>
                      <strong>参考答案：</strong>
                      {q.answer.length ? q.answer.join('、') : '见下方参考解析'}
                    </p>
                    <MarkdownContent content={q.explanation} sourceFilePath={q.filePath} />
                    <div className="library-note-box">
                      <Field label="本题笔记">
                        <Textarea
                          rows={3}
                          value={noteValue}
                          onChange={(_, data) =>
                            setNoteDrafts((prev) => ({ ...prev, [q.id]: data.value }))
                          }
                          placeholder="记录解题套路、陷阱或复盘结论"
                        />
                      </Field>
                      <Button
                        size="small"
                        appearance="secondary"
                        icon={<NotePencilIcon />}
                        disabled={savingNoteId === q.id}
                        style={{ marginTop: 8 }}
                        onClick={() => void saveLibraryNote(q.id)}
                      >
                        {savingNoteId === q.id ? '保存中…' : '保存笔记'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

export function ReviewPage(): React.JSX.Element {
  const [due, setDue] = useState<ReviewItem[]>()
  const [tab, setTab] = useState<'due' | 'wrong' | 'favorite' | 'notes'>('due')
  useEffect(() => {
    void invoke<ReviewItem[]>({ method: 'review.due', params: { limit: 500 } }).then(setDue)
  }, [])
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 错题复习"
        title="错题复习"
        description={
          due
            ? `${due.length} 道题已到期。支持今日间隔复习，以及按错题本、收藏夹与笔记库全景检索复盘。`
            : '正在读取复习队列。'
        }
      />
      <TabList
        className="review-tabs"
        selectedValue={tab}
        onTabSelect={(_, data) => setTab(data.value as 'due' | 'wrong' | 'favorite' | 'notes')}
      >
        <Tab value="due">今日到期复习{due ? ` (${due.length})` : ''}</Tab>
        <Tab value="wrong">错题本</Tab>
        <Tab value="favorite">我的收藏</Tab>
        <Tab value="notes">我的笔记</Tab>
      </TabList>
      {tab === 'due' ? <Trainer review /> : <QuestionLibraryView key={tab} tab={tab} />}
    </div>
  )
}
