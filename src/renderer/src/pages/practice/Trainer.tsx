import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ProgressBar, Textarea } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BookmarkSimpleIcon,
  CalculatorIcon,
  CheckIcon,
  ClockIcon,
  ColumnsIcon,
  FlagIcon,
  LightningIcon,
  PaintBrushIcon,
  PencilSimpleIcon,
  SkipForwardIcon
} from '@phosphor-icons/react'
import type {
  AttemptResult,
  PracticeSelection,
  PracticeSession,
  Question,
  QuestionFacets,
  Subject
} from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { expandCategoryAliases, isAnswerCorrect } from '@shared/study-constants'
import { invoke } from '../../api'
import { HighlightableMaterial } from '../../components/HighlightableMaterial'
import { MarkdownContent } from '../../components/MarkdownContent'
import { QuestionEditDialog } from '../../components/QuestionEditDialog'
import { QuestionOptionList } from '../../components/QuestionOptionList'
import {
  ReadingTypographyBar,
  useReadingTypography
} from '../../components/ReadingTypographyControl'
import { ScratchpadDrawer } from '../../components/ScratchpadDrawer'
import { EmptyState, ErrorState, LoadingState, Section } from '../../components/ui'
import {
  BOOLEAN_FLAG_CODEC,
  BOOLEAN_OPT_IN_CODEC,
  useLocalStorageState
} from '../../hooks/useLocalStorageState'
import { streamAiAsk } from '../../services/ai-stream'
import { hasOpenModal } from '../../services/shortcuts'
import {
  formatMaterialSource,
  readStoredRegion,
  writeStoredRegion
} from '../../services/study-helpers'
import { useAppStore } from '../../store'
import type { Category, SessionResult, TrainerInitial } from './constants'
import { FormulaCheatCard } from './FormulaCheatCard'
import { PracticeFilterPanel } from './PracticeFilterPanel'
import { SessionSummaryView } from './SessionSummaryView'
import { TrainerSidebar } from './TrainerSidebar'

function normalizeMaterialText(material?: string): string {
  return (material ?? '').replace(/\r\n?/g, '\n').trim()
}

function isDataAnalysisCategory(category: string): boolean {
  return category === '资料分析' || category.startsWith('资料分析')
}

function snapDataAnalysisCount(value: number): number {
  return Math.max(5, Math.min(100, Math.round(value / 5) * 5))
}

function isSameMaterialGroup(a: Question, b: Question): boolean {
  const matA = normalizeMaterialText(a.material)
  if (!matA || a.category !== b.category) return false
  if (normalizeMaterialText(b.material) !== matA) return false
  return !a.groupId || !b.groupId || a.groupId === b.groupId
}

export function Trainer({
  review = false,
  initial
}: {
  review?: boolean
  initial?: TrainerInitial
}): React.JSX.Element {
  const navigate = useNavigate()
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const refreshVault = useAppStore((state) => state.refreshVault)
  const showToast = useAppStore((state) => state.showToast)
  const zenMode = useAppStore((state) => state.zenMode)
  const toggleZenMode = useAppStore((state) => state.toggleZenMode)
  const vault = useAppStore((state) => state.data?.vault)
  const ai = useAppStore((state) => state.data!.ai)
  const defaultRegion = useAppStore((state) => state.data?.settings.defaultRegion ?? '')
  const [categories, setCategories] = useState<Category[]>([])
  const [facets, setFacets] = useState<QuestionFacets>({ years: [], regions: [], papers: [] })
  const [subject, setSubject] = useState<'' | Subject>(initial?.subject ?? 'xingce')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [year, setYear] = useState('')
  const [region, setRegion] = useState(() =>
    review ? '' : readStoredRegion('tizhou:practice-region', defaultRegion)
  )
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
  const [count, setCount] = useState(() => {
    const baseCount = initial?.count ?? 10
    return initial?.category &&
      isDataAnalysisCategory(initial.category) &&
      !initial.onlyWrong &&
      !initial.onlyFavorite
      ? snapDataAnalysisCount(baseCount)
      : baseCount
  })
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
  const [summaryOnlyWrong, setSummaryOnlyWrong] = useState(false)
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
  const [showTimer, setShowTimer] = useLocalStorageState<boolean>(
    'tizhou:practice-show-timer',
    true,
    BOOLEAN_FLAG_CODEC
  )
  const [materialSplit, setMaterialSplit] = useLocalStorageState<boolean>(
    'tizhou:practice-material-split',
    true,
    BOOLEAN_FLAG_CODEC
  )
  const [rapidMode, setRapidMode] = useLocalStorageState<boolean>(
    'tizhou:practice-rapid-mode',
    false,
    BOOLEAN_OPT_IN_CODEC
  )
  const [enqueuedIds, setEnqueuedIds] = useState<string[]>([])
  const [rapidAdvancePending, setRapidAdvancePending] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [showFormulaCard, setShowFormulaCard] = useState(false)
  const startedAt = useRef(Date.now())
  const currentQuestionIdRef = useRef('')
  const activeSessionIdRef = useRef('')
  const aiStreamCancelRef = useRef<(() => void) | null>(null)
  const rapidAdvanceTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      aiStreamCancelRef.current?.()
      window.clearTimeout(rapidAdvanceTimerRef.current)
    }
  }, [])

  useEffect(() => {
    // 科目/分类元数据跟随筛选变化（科目筛选来自 URL 参数或下拉选择，空值与 common 视为不限）
    const subjectFilter = subject === 'xingce' || subject === 'shenlun' ? subject : undefined
    void invoke<Category[]>({
      method: 'vault.categories',
      params: { subject: review ? undefined : subjectFilter }
    })
      .then((nextCats) => {
        setCategories(nextCats)
        setCategory((currentCat) => {
          if (!currentCat || nextCats.some((item) => item.name === currentCat)) return currentCat
          const aliases = expandCategoryAliases(currentCat)
          const matched = nextCats.find((item) => aliases.includes(item.name))
          return matched ? matched.name : currentCat
        })
      })
      .catch(() => setCategories([]))
    void invoke<QuestionFacets>({
      method: 'vault.facets',
      params: { subject: review ? undefined : subjectFilter, region: region || undefined }
    })
      .then((nextFacets) => {
        setFacets(nextFacets)
        setPaper((currentPaper) =>
          currentPaper && !nextFacets.papers.includes(currentPaper) ? '' : currentPaper
        )
      })
      .catch(() => setFacets({ years: [], regions: [], papers: [] }))
  }, [review, subject, region])

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
  const [showScratchpad, setShowScratchpad] = useState(false)
  const currentEliminated = current ? (eliminatedByQuestion[current.id] ?? []) : []

  useEffect(() => {
    if (!current || result || currentRecord) return
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [current?.id, result, currentRecord])

  function cancelRapidAdvance(): void {
    window.clearTimeout(rapidAdvanceTimerRef.current)
    setRapidAdvancePending(false)
  }

  function toggleTimerVisibility(): void {
    setShowTimer((value) => !value)
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
      const targetEl = event.target as HTMLElement | null
      const isOptionButton = Boolean(targetEl?.closest('.option-button'))
      // 弹窗打开或输入控件聚焦时不拦截键盘
      if (
        !current ||
        loading ||
        hasOpenModal() ||
        targetEl?.isContentEditable ||
        Boolean(targetEl?.closest('.scratchpad-drawer')) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLButtonElement && !isOptionButton)
      )
        return
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setShowScratchpad((value) => !value)
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const keyLower = event.key.toLowerCase()
      if (keyLower === 's') {
        event.preventDefault()
        setShowScratchpad((value) => !value)
        return
      }
      if (keyLower === 'u') {
        event.preventDefault()
        void toggleUncertain()
        return
      }
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
      if (review && result?.correct && /^[1-4]$/.test(event.key)) {
        const ratingMap = ['forgot', 'hard', 'normal', 'easy'] as const
        const chosenFeedback = ratingMap[Number(event.key) - 1]
        if (chosenFeedback) {
          event.preventDefault()
          void rateReview(chosenFeedback)
          return
        }
      }
      if (
        event.key === 'Enter' &&
        !result &&
        !currentRecord &&
        (selected.length || essayAnswer.trim())
      ) {
        event.preventDefault()
        void submit()
      }
      if (keyLower === 'n' && (result || currentRecord)) void next()
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
    sessionResults,
    session,
    rapidMode,
    review
  ])

  function restoreSession(active: PracticeSession): void {
    const restored = active.questionIds
      .map((id) => active.questionSnapshots[id])
      .filter((question): question is Question => Boolean(question))
    activeSessionIdRef.current = active.id
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
      const effectiveCount =
        !override &&
        isDataAnalysisCategory(category) &&
        !onlyWrong &&
        !onlyFavorite &&
        !onlyUnattempted &&
        !difficulty &&
        !keyword.trim()
          ? snapDataAnalysisCount(count)
          : count
      if (effectiveCount !== count) setCount(effectiveCount)
      const selection: PracticeSelection = override ?? {
        mode,
        count: effectiveCount,
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
    if (!current || result || currentRecord || loading) return
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
    } else {
      setSelected([key])
      if (rapidMode) {
        void submit([key])
      }
    }
  }

  async function toggleUncertain(): Promise<void> {
    if (!session || !current) return
    cancelRapidAdvance()
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
    cancelRapidAdvance()
    const next = !favorite
    try {
      await invoke({ method: 'favorite.set', params: { questionId: current.id, favorite: next } })
      setFavorite(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '收藏操作失败')
    }
  }

  async function submit(overrideAnswer?: string[]): Promise<void> {
    if (!current || loading) return
    const answer = current.type === 'essay' ? [essayAnswer.trim()] : (overrideAnswer ?? selected)
    if (!answer[0]) {
      setError('请先填写或选择答案')
      return
    }
    const submittedQuestionId = current.id
    const submittedSessionId = session?.id ?? ''
    setLoading(true)
    setError('')
    window.clearTimeout(rapidAdvanceTimerRef.current)
    setRapidAdvancePending(false)
    try {
      const response = await invoke<AttemptResult>({
        method: 'attempt.submit',
        params: {
          questionId: submittedQuestionId,
          answer,
          durationSeconds: Math.round((Date.now() - startedAt.current) / 1000),
          mode: review ? 'review' : 'practice',
          sessionId: session?.id,
          wrongCause
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
        if (rapidMode && response.correct && index + 1 < questions.length) {
          setRapidAdvancePending(true)
          const currentIdxSnapshot = index
          rapidAdvanceTimerRef.current = window.setTimeout(() => {
            setRapidAdvancePending(false)
            if (currentQuestionIdRef.current === submittedQuestionId) {
              void jumpTo(currentIdxSnapshot + 1, updatedResults)
            }
          }, 650)
        }
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
    aiStreamCancelRef.current?.()
    aiStreamCancelRef.current = null
    window.clearTimeout(rapidAdvanceTimerRef.current)
    setRapidAdvancePending(false)
    setAiBusy(false)
    setSelected([])
    setEssayAnswer('')
    setResult(undefined)
    setWrongCause('')
    setReviewFeedback('normal')
    setSimilar([])
    setAiExplanation('')
    setNote('')
    setFavorite(false)
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
      showToast('笔记已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记保存失败')
    }
  }

  async function rateReview(feedback: 'forgot' | 'hard' | 'normal' | 'easy'): Promise<void> {
    if (!current || !result) return
    const targetQuestionId = current.id
    const baseResult = result
    window.clearTimeout(rapidAdvanceTimerRef.current)
    setRapidAdvancePending(false)
    setReviewFeedback(feedback)
    try {
      const rated = await invoke<{
        nextReviewAt?: string
        mastered: boolean
        intervalDays?: number
        reviewStage: number
      }>({
        method: 'review.rate',
        params: {
          questionId: targetQuestionId,
          feedback,
          baselineStreak: baseResult.reviewBaseline?.streak,
          baselineStage: baseResult.reviewBaseline?.stage
        }
      })
      const updatedResult: AttemptResult = {
        ...baseResult,
        nextReviewAt: rated.nextReviewAt,
        mastered: rated.mastered,
        intervalDays: rated.intervalDays
      }
      if (currentQuestionIdRef.current === targetQuestionId) {
        setResult(updatedResult)
      }
      setSessionResults((prev) =>
        prev.map((item) =>
          item.questionId === targetQuestionId ? { ...item, result: updatedResult } : item
        )
      )
      void refreshDashboard()
      const labelMap = {
        forgot: '已标记重来，1 天后再次巩固',
        hard: `已标记困难，${rated.intervalDays ?? 1} 天后复习`,
        normal: rated.mastered
          ? '掌握达标，已移出待复习队列'
          : `已标记掌握，阶梯推进至 ${rated.intervalDays ?? 3} 天后复习`,
        easy: rated.mastered
          ? '秒杀达标，已移出待复习队列'
          : `已标记秒杀，跃迁至 ${rated.intervalDays ?? 7} 天后复习`
      }
      showToast(labelMap[feedback])
    } catch (cause) {
      if (currentQuestionIdRef.current === targetQuestionId) {
        setError(cause instanceof Error ? cause.message : '记忆评级更新失败')
      }
    }
  }

  async function enqueueSingleUncertain(questionId: string): Promise<void> {
    if (enqueuedIds.includes(questionId)) return
    try {
      const res = await invoke<{ added: number; skipped: number }>({
        method: 'review.enqueue',
        params: { questionIds: [questionId], reason: '蒙对/不确定' }
      })
      setEnqueuedIds((prev) => (prev.includes(questionId) ? prev : [...prev, questionId]))
      void refreshDashboard()
      showToast(res.added > 0 ? '已加入明日间隔复习队列' : '该题已在待复习队列中')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '加入复习队列失败')
    }
  }

  async function appendSimilarQuestions(items: Question[]): Promise<void> {
    const existingIds = new Set(questions.map((item) => item.id))
    const toAppend = items.filter((item) => !existingIds.has(item.id))
    if (!toAppend.length) return
    try {
      if (session) {
        const updated = await invoke<PracticeSession>({
          method: 'practice.session.update',
          params: { id: session.id, appendQuestionIds: toAppend.map((item) => item.id) }
        })
        setSession(updated)
      }
      setQuestions((prev) => [...prev, ...toAppend])
      showToast(`已将 ${toAppend.length} 道相似题追加到本组末尾`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '追加相似题失败')
    }
  }

  async function askAiAboutCurrent(): Promise<void> {
    if (!current || !result || aiBusy) return
    const targetQuestionId = current.id
    aiStreamCancelRef.current?.()
    setAiBusy(true)
    setAiExplanation('')
    setError('')
    try {
      const handle = streamAiAsk(
        {
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
        },
        (accumulated) => {
          if (currentQuestionIdRef.current === targetQuestionId) {
            setAiExplanation(accumulated)
          }
        }
      )
      aiStreamCancelRef.current = handle.cancel
      const response = await handle.promise
      if (currentQuestionIdRef.current === targetQuestionId) {
        setAiExplanation(
          response.aborted && response.content.trim()
            ? `${response.content}\n\n*(已停止生成)*`
            : response.content
        )
      }
    } catch (cause) {
      if (currentQuestionIdRef.current === targetQuestionId) {
        setError(cause instanceof Error ? cause.message : 'AI 讲解失败')
      }
    } finally {
      aiStreamCancelRef.current = null
      setAiBusy(false)
    }
  }

  if (loading && !current) return <LoadingState label="正在准备题目" />

  if (summaryComplete) {
    return (
      <SessionSummaryView
        questions={questions}
        sessionResults={sessionResults}
        uncertainIds={session?.uncertainIds ?? []}
        summaryOnlyWrong={summaryOnlyWrong}
        onToggleOnlyWrong={() => setSummaryOnlyWrong((v) => !v)}
        onRetryWrong={(wrongQuestions) => {
          setSummaryComplete(false)
          setSummaryOnlyWrong(false)
          void startSession({
            mode: 'sequence',
            count: wrongQuestions.length,
            feedbackMode,
            questionIds: wrongQuestions.map((q) => q.id)
          })
        }}
        onBackToConfig={() => {
          setSummaryComplete(false)
          setSummaryOnlyWrong(false)
          setQuestions([])
          setSession(undefined)
          setSessionResults([])
        }}
      />
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
      <PracticeFilterPanel
        error={error}
        mode={mode}
        onModeChange={setMode}
        subject={subject}
        onSubjectChange={(nextSubject) => {
          // 切科目时联动清空旧科目维度的残余筛选，避免「申论科目 + 行测模块」这类矛盾组合
          setSubject(nextSubject)
          setCategory('')
          setYear('')
          setRegion('')
          setPaper('')
        }}
        category={category}
        onCategoryChange={(nextCategory) => {
          setCategory(nextCategory)
          if (
            isDataAnalysisCategory(nextCategory) &&
            !onlyWrong &&
            !onlyFavorite &&
            !onlyUnattempted &&
            !difficulty &&
            !keyword.trim()
          ) {
            setCount((prev) => snapDataAnalysisCount(prev))
          }
        }}
        categories={categories}
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        feedbackMode={feedbackMode}
        onFeedbackModeChange={setFeedbackMode}
        keyword={keyword}
        onKeywordChange={setKeyword}
        year={year}
        onYearChange={setYear}
        facets={facets}
        region={region}
        paper={paper}
        onRegionOrPaperChange={(nextRegion, nextPaper) => {
          setRegion(nextRegion)
          if (!review) writeStoredRegion('tizhou:practice-region', nextRegion)
          if (nextPaper !== undefined) setPaper(nextPaper)
        }}
        onPaperChange={setPaper}
        count={count}
        onCountChange={setCount}
        onlyUnattempted={onlyUnattempted}
        onOnlyUnattemptedChange={(checked) => {
          setOnlyUnattempted(checked)
          if (checked) setOnlyWrong(false)
        }}
        onlyWrong={onlyWrong}
        onOnlyWrongChange={(checked) => {
          setOnlyWrong(checked)
          if (checked) setOnlyUnattempted(false)
        }}
        onlyFavorite={onlyFavorite}
        onOnlyFavoriteChange={setOnlyFavorite}
        onStart={() => void startSession()}
      />
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

  // 识别同材料连题组（同模块且归一化材料一致，避免历史 groupId 碰撞跨模块/跨材料混组），在左栏提供小题快切条
  const siblingIndices: number[] = []
  if (current.material) {
    questions.forEach((q, qIdx) => {
      if (isSameMaterialGroup(current, q)) siblingIndices.push(qIdx)
    })
  }
  const useSplit = Boolean(current.material && materialSplit)
  const sharedMaterialKey =
    siblingIndices.length > 1 ? `mat-group:${questions[siblingIndices[0]!]!.id}` : `q:${current.id}`
  const canEditQuestion = Boolean(!vault?.isBuiltin && current.filePath)

  return (
    <div className="question-shell">
      <Section className="question-card">
        {error && <ErrorState message={error} />}
        <div className="progress-text">
          <span>
            第 {index + 1} 题 / 共 {questions.length} 题
            {rapidAdvancePending && <span className="pill is-rapid-next">答对 · 即将下一题</span>}
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
            <span className="pill" title={current.source}>
              教材来源：{formatMaterialSource(current.source)}
            </span>
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
                onClick={() => setMaterialSplit((value) => !value)}
              >
                {materialSplit ? '分栏对照' : '上下排布'}
              </Button>
            )}
            <Button
              size="small"
              appearance={rapidMode ? 'primary' : 'subtle'}
              icon={<LightningIcon weight={rapidMode ? 'fill' : 'regular'} />}
              title="极速连刷：单选/判断点击选项即刻提交，答对后自动跳下一题，答错停留在解析"
              onClick={() => {
                cancelRapidAdvance()
                setRapidMode((value) => !value)
              }}
            >
              {rapidMode ? '极速中' : '极速'}
            </Button>
            <Button
              size="small"
              appearance={showFormulaCard ? 'secondary' : 'subtle'}
              icon={<CalculatorIcon />}
              title="展开/收起行测速算与百化分速查卡"
              onClick={() => setShowFormulaCard((value) => !value)}
            >
              速查卡
            </Button>
            <Button
              size="small"
              appearance={showScratchpad ? 'secondary' : 'subtle'}
              icon={<PaintBrushIcon />}
              title="打开/收起随手草稿纸 (S / Alt+D)"
              onClick={() => setShowScratchpad((value) => !value)}
            >
              草稿纸
            </Button>
            <span className="toolbar-sep" aria-hidden="true" />
            <Button
              size="small"
              appearance="subtle"
              icon={<PencilSimpleIcon />}
              disabled={!canEditQuestion}
              title={
                canEditQuestion
                  ? '就地修改题干/选项/答案/解析并写回源 Markdown'
                  : '内置示例题库为只读，连接本地 Markdown 知识库后可就地勘误'
              }
              onClick={() => {
                cancelRapidAdvance()
                setEditOpen(true)
              }}
            >
              勘误
            </Button>
            <Button
              size="small"
              appearance={zenMode ? 'secondary' : 'subtle'}
              icon={zenMode ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
              title="切换沉浸专注视野（折叠/展开左侧导航 · Alt+Z）"
              onClick={toggleZenMode}
            >
              {zenMode ? '退出专注' : '专注'}
            </Button>
            <ReadingTypographyBar
              typography={reading.typography}
              onUpdate={reading.update}
              onStepScale={reading.stepScale}
              onResetScale={reading.resetScale}
            />
          </div>
        </div>
        {showFormulaCard && <FormulaCheatCard />}
        <div
          ref={reading.surfaceRef}
          className={`question-reading-surface${useSplit ? ' material-split-layout' : ''}`}
          data-reading-font={reading.typography.font}
          style={reading.surfaceStyle}
        >
          {current.material && (
            <div className={useSplit ? 'material-split-left' : 'answer-panel'}>
              <HighlightableMaterial
                promptId={sharedMaterialKey}
                content={current.material}
                sourceFilePath={current.filePath}
                storagePrefix="tizhou:xingce-highlights:"
                preset="xingce"
                variant="embedded"
                headerLeft={
                  <div className="material-split-inline-head">
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
                }
              />
            </div>
          )}
          <div className="material-split-right">
            {!current.material && current.subject === 'xingce' ? (
              <HighlightableMaterial
                promptId={`stem:${current.id}`}
                content={current.stem}
                sourceFilePath={current.filePath}
                storagePrefix="tizhou:xingce-highlights:"
                preset="xingce"
                variant="inline"
              />
            ) : (
              <MarkdownContent
                className="question-stem"
                content={current.stem}
                sourceFilePath={current.filePath}
              />
            )}
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
              <QuestionOptionList
                options={current.options}
                selected={selected}
                sourceFilePath={current.filePath}
                correctKeys={result ? current.answer : undefined}
                eliminatedKeys={currentEliminated}
                disabled={locked}
                onSelect={choose}
                onToggleEliminate={toggleEliminate}
              />
            )}
            {result && (
              <div className="answer-panel">
                <h3 className={result.correct ? 'positive' : 'negative'}>
                  {result.correct ? '回答正确' : '回答错误'}
                </h3>
                <p>参考答案：{result.expected.join('、')}</p>
                <MarkdownContent content={result.explanation} sourceFilePath={current.filePath} />
                {result.nextReviewAt && (
                  <p className="muted">
                    已按艾宾浩斯阶梯安排复习：
                    {result.intervalDays ? `${result.intervalDays} 天后再次巩固` : '已入待复习队列'}
                    。
                  </p>
                )}
                {result.mastered && <p className="positive">稳定答对，已标记为掌握。</p>}
                {review && result.correct && (
                  <div className="review-rate-bar">
                    <span className="muted">对照解析评估记忆掌握度（快捷键 1–4）：</span>
                    <div className="button-row">
                      {(
                        [
                          { key: 'forgot', label: '1 重来 · 1天' },
                          { key: 'hard', label: '2 困难 · 短期' },
                          { key: 'normal', label: '3 掌握 · 推进' },
                          { key: 'easy', label: '4 秒杀 · 跃阶' }
                        ] as const
                      ).map((btn) => (
                        <Button
                          key={btn.key}
                          size="small"
                          appearance={reviewFeedback === btn.key ? 'primary' : 'secondary'}
                          onClick={() => void rateReview(btn.key)}
                        >
                          {btn.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {!review && uncertain && result.correct && (
                  <div className="button-row" style={{ marginTop: 8 }}>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={enqueuedIds.includes(current.id)}
                      onClick={() => void enqueueSingleUncertain(current.id)}
                    >
                      {enqueuedIds.includes(current.id)
                        ? '已加入明日复习队列'
                        : '标有不确定且已答对 · 加入明日间隔复习'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
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
        <div className="shortcut-hint">
          快捷键：A–D / 1–4 选答案 · Enter 提交 · N 下一题 · U 标待查 · S 草稿纸 · Alt+Z 专注 · ?
          全部快捷键
        </div>
      </Section>
      <TrainerSidebar
        questions={questions}
        index={index}
        current={current}
        session={session}
        sessionResults={sessionResults}
        answeredMap={answeredMap}
        feedbackMode={feedbackMode}
        loading={loading}
        result={result}
        currentRecord={currentRecord}
        review={review}
        wrongCause={wrongCause}
        onWrongCauseChange={(nextCause, isWrongSubmitted) => {
          cancelRapidAdvance()
          setWrongCause(nextCause)
          if (current && isWrongSubmitted) {
            void invoke({
              method: 'wrongQuestion.setCause',
              params: { questionId: current.id, wrongCause: nextCause }
            })
              .then(() => showToast('错因标注已更新'))
              .catch((cause) => setError(cause instanceof Error ? cause.message : '错因更新失败'))
          }
        }}
        note={note}
        onNoteChange={(nextNote) => {
          cancelRapidAdvance()
          setNote(nextNote)
        }}
        onSaveNote={() => {
          cancelRapidAdvance()
          void saveNote()
        }}
        similar={similar}
        onAppendSimilar={(items) => void appendSimilarQuestions(items)}
        aiCanAsk={ai.hasApiKey || ai.provider === 'ollama' || ai.provider === 'lmstudio'}
        aiExplanation={aiExplanation}
        aiBusy={aiBusy}
        onAskAi={() => {
          cancelRapidAdvance()
          void askAiAboutCurrent()
        }}
        onCancelAi={() => aiStreamCancelRef.current?.()}
        onNavigateToAi={(questionId) =>
          navigate(`/ai?questionId=${encodeURIComponent(questionId)}`)
        }
        onJumpTo={(questionIndex) => void jumpTo(questionIndex)}
      />
      <ScratchpadDrawer
        open={showScratchpad}
        allowCalculator
        contextKey={sharedMaterialKey}
        onClose={() => setShowScratchpad(false)}
      />
      <QuestionEditDialog
        question={current}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={(updated) => {
          setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)))
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  questionSnapshots: { ...prev.questionSnapshots, [updated.id]: updated }
                }
              : prev
          )
          setSessionResults((prev) =>
            prev.map((item) =>
              item.questionId === updated.id
                ? {
                    ...item,
                    result: {
                      ...item.result,
                      expected: updated.answer,
                      explanation: updated.explanation,
                      correct:
                        updated.type === 'essay'
                          ? item.result.correct
                          : isAnswerCorrect(updated.answer, item.answer, { requireNonEmpty: true })
                    }
                  }
                : item
            )
          )
          if (result) {
            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    expected: updated.answer,
                    explanation: updated.explanation,
                    correct:
                      updated.type === 'essay'
                        ? prev.correct
                        : isAnswerCorrect(updated.answer, selected, { requireNonEmpty: true })
                  }
                : prev
            )
          }
          void refreshVault()
          showToast('勘误已保存并重新索引')
        }}
      />
    </div>
  )
}
