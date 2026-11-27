import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BellRingingIcon,
  BookBookmarkIcon,
  ClockIcon,
  ColumnsIcon,
  FlagIcon,
  PaintBrushIcon
} from '@phosphor-icons/react'
import type { ExamSession, Question } from '@shared/contracts'
import { formatShenlunMaterialParagraphs, splitShenlunMaterialBlocks } from '@shared/shenlun'
import {
  XINGCE_MODULE_ORDER,
  normalizeXingceModule,
  suggestedModuleSeconds
} from '@shared/study-constants'
import { formatDate, invoke } from '../../api'
import { HighlightableMaterial } from '../../components/HighlightableMaterial'
import { MarkdownContent } from '../../components/MarkdownContent'
import {
  QuestionNavigatorGrid,
  buildOrderedModuleIndices
} from '../../components/QuestionNavigatorGrid'
import { QuestionOptionList } from '../../components/QuestionOptionList'
import {
  ReadingTypographyBar,
  useReadingTypography
} from '../../components/ReadingTypographyControl'
import { ScratchpadDrawer } from '../../components/ScratchpadDrawer'
import { ShenlunAnswerSheet } from '../../components/ShenlunAnswerSheet'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section
} from '../../components/ui'
import {
  BOOLEAN_FLAG_CODEC,
  readLocalStorageJson,
  removeLocalStorage,
  useLocalStorageState,
  writeLocalStorageJson
} from '../../hooks/useLocalStorageState'
import { EssaySaveController, ExamAnswerSaveController } from '../../services/exam-essay-save'
import { hasOpenModal } from '../../services/shortcuts'
import { extractWordLimit } from '../../services/study-helpers'
import { useAppStore } from '../../store'
import { ShenlunSnippetDrawer } from '../shenlun/ShenlunSnippetDrawer'
import { EXAM_UNCERTAIN_PREFIX, pruneStaleExamUncertainKeys, remainingSeconds } from './shared'

const MODULE_ORDER_CODEC = {
  parse: (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String) : [...XINGCE_MODULE_ORDER]
    } catch {
      return [...XINGCE_MODULE_ORDER]
    }
  },
  serialize: (val: string[]): string => JSON.stringify(val)
}

function isSameExamMaterialGroup(a: Question, b: Question): boolean {
  const matA = (a.material ?? '').replace(/\r\n?/g, '\n').trim()
  if (!matA || a.category !== b.category) return false
  if ((b.material ?? '').replace(/\r\n?/g, '\n').trim() !== matA) return false
  return !a.groupId || !b.groupId || a.groupId === b.groupId
}

export function ExamRunPage(): React.JSX.Element {
  const navigate = useNavigate()
  const refresh = useAppStore((state) => state.refreshDashboard)
  const zenMode = useAppStore((state) => state.zenMode)
  const toggleZenMode = useAppStore((state) => state.toggleZenMode)
  const [exam, setExam] = useState<ExamSession>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [index, setIndex] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [showScratchpad, setShowScratchpad] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'idle'
  )
  const [essayText, setEssayText] = useState('')
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [uncertainIds, setUncertainIds] = useState<string[]>([])
  const [eliminatedByQuestion, setEliminatedByQuestion] = useState<Record<string, string[]>>({})
  const [materialSplit, setMaterialSplit] = useLocalStorageState<boolean>(
    'tizhou:exam-material-split',
    true,
    BOOLEAN_FLAG_CODEC
  )
  const [moduleOrder, setModuleOrder] = useLocalStorageState<string[]>(
    'tizhou:exam-module-order',
    [...XINGCE_MODULE_ORDER],
    MODULE_ORDER_CODEC
  )
  const [shenlunUseSheet, setShenlunUseSheet] = useState(false)
  const [shenlunMaterialTab, setShenlunMaterialTab] = useState<'all' | number>('all')
  const [snippetOpen, setSnippetOpen] = useState(false)
  const [cardAlertEnabled, setCardAlertEnabled] = useLocalStorageState<boolean>(
    'tizhou:exam-card-alert',
    true,
    BOOLEAN_FLAG_CODEC
  )
  const [cardAlertDismissed, setCardAlertDismissed] = useState(false)
  const reading = useReadingTypography()
  const essayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(true)
  const finishingRef = useRef(false)
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
      // 组件卸载时把挂起答案保存完成后再停止，并清空 ref 以便 StrictMode/重挂重建活跃控制器
      const answerCtrl = answerSaveRef.current
      const essayCtrl = saveControllerRef.current
      answerSaveRef.current = null
      saveControllerRef.current = null
      void answerCtrl?.destroy()
      void essayCtrl?.destroy()
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
        const savedUncertain = readLocalStorageJson<unknown>(
          `${EXAM_UNCERTAIN_PREFIX}${active.id}`,
          null
        )
        if (Array.isArray(savedUncertain)) setUncertainIds(savedUncertain.map(String))
        const loadedQuestions = active.questionIds
          .map((id) => active.questionSnapshots[id])
          .filter((item): item is Question => Boolean(item))
        setQuestions(loadedQuestions)
        if (active.subject === 'xingce') {
          const orderedGroups = buildOrderedModuleIndices(loadedQuestions, moduleOrder)
          if (orderedGroups.length > 1 && orderedGroups[0]?.indices[0] !== undefined) {
            setIndex(orderedGroups[0].indices[0])
          }
        }
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '模考读取失败'))
  }, [])

  useEffect(() => {
    if (!exam?.id) return
    const timer = window.setInterval(() => {
      const active = examRef.current
      if (active) setSeconds(remainingSeconds(active))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [exam?.id, exam?.startedAt, exam?.durationMinutes])

  useEffect(() => {
    if (exam && seconds === 0 && !finishing && !finishingRef.current) void finish()
  }, [seconds, exam?.id])

  const answered = exam
    ? Object.values(exam.answers).filter((item) => item.answer.some((value) => value.trim())).length
    : 0
  const current = questions[index]

  // 切题时结算上一题停留耗时并切换计时锚点；无论是否作答均落盘耗时，确保沉没成本分析覆盖高耗时未答题
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
        if (activeExam) {
          const prevQuestion = questions.find((q) => q.id === prevAnchor.questionId)
          const prevAnswer = activeExam.answers[prevAnchor.questionId]?.answer ?? []
          if (prevQuestion?.type === 'essay') {
            saveControllerRef.current?.enqueueIfIdle(
              activeExam.id,
              prevAnchor.questionId,
              prevAnswer
            )
          } else {
            answerSaveRef.current?.save({
              examId: activeExam.id,
              questionId: prevAnchor.questionId,
              answer: prevAnswer
            })
          }
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

  const moduleGroups = useMemo(
    () => (exam?.subject === 'xingce' ? buildOrderedModuleIndices(questions, moduleOrder) : []),
    [exam?.subject, questions, moduleOrder]
  )
  const hasMultipleModules = moduleGroups.length > 1
  const orderedIndices = useMemo(
    () =>
      hasMultipleModules
        ? moduleGroups.flatMap((group) => group.indices)
        : questions.map((_, idx) => idx),
    [hasMultipleModules, moduleGroups, questions]
  )
  const currentOrderPos = orderedIndices.indexOf(index)
  const prevQuestionIdx = currentOrderPos > 0 ? orderedIndices[currentOrderPos - 1]! : -1
  const nextQuestionIdx =
    currentOrderPos >= 0 && currentOrderPos + 1 < orderedIndices.length
      ? orderedIndices[currentOrderPos + 1]!
      : -1

  function toggleUncertain(): void {
    if (!exam || !current) return
    setUncertainIds((prev) => {
      const nextIds = prev.includes(current.id)
        ? prev.filter((id) => id !== current.id)
        : [...prev, current.id]
      writeLocalStorageJson(`${EXAM_UNCERTAIN_PREFIX}${exam.id}`, nextIds)
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
      const targetEl = event.target as HTMLElement | null
      if (
        !current ||
        confirmOpen ||
        hasOpenModal() ||
        targetEl?.isContentEditable ||
        Boolean(targetEl?.closest('.scratchpad-drawer')) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' '))
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
      if (event.key === 'ArrowLeft' && prevQuestionIdx >= 0) {
        event.preventDefault()
        setIndex(prevQuestionIdx)
        return
      }
      if (event.key === 'ArrowRight' && nextQuestionIdx >= 0) {
        event.preventDefault()
        setIndex(nextQuestionIdx)
        return
      }
      if (keyLower === 'u') {
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
  }, [current, confirmOpen, prevQuestionIdx, nextQuestionIdx, currentAnswer, exam, uncertainIds])

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
    if (!exam || finishingRef.current) return
    finishingRef.current = true
    setFinishing(true)
    try {
      // 交卷前结算当前题耗时并同步写入（含未答题耗时）
      if (current) {
        const finalDuration = flushActiveQuestionDuration(current.id)
        const existingAns = exam.answers[current.id]
        if (finalDuration > 0 && finalDuration !== (existingAns?.durationSeconds ?? 0)) {
          if (current.type === 'essay') {
            saveControllerRef.current?.enqueueIfIdle(exam.id, current.id, existingAns?.answer ?? [])
          } else {
            answerSaveRef.current?.save({
              examId: exam.id,
              questionId: current.id,
              answer: existingAns?.answer ?? []
            })
          }
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
          setConfirmOpen(false)
          return
        }
      }
      setSaveBlocked(false)
      setConfirmOpen(false)
      setError('')
      await invoke({ method: 'exam.finish', params: { examId: exam.id, uncertainIds } })
      removeLocalStorage(`${EXAM_UNCERTAIN_PREFIX}${exam.id}`)
      await refresh()
      navigate(`/exam/result/${exam.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交卷失败')
    } finally {
      finishingRef.current = false
      setFinishing(false)
    }
  }

  /** 重试失败的保存（同时覆盖客观题与主观题两个保存队列） */
  async function retrySave(): Promise<void> {
    setError('')
    let answerFailed = 0
    const answerController = answerSaveRef.current
    if (answerController && answerController.failedQuestionIds().length > 0) {
      answerController.retryAll()
      const remaining = await answerController.drain()
      answerFailed = remaining.length
    }
    let essayFailed = 0
    const controller = saveControllerRef.current
    if (controller && controller.hasFailedSave) {
      const result = await controller.retryAll()
      essayFailed = result.failedQuestionIds.length
    }
    const totalFailed = answerFailed + essayFailed
    if (totalFailed === 0) {
      setSaveBlocked(false)
      if (controller) setSaveStatus('saved')
    } else {
      setError(`仍有 ${totalFailed} 题保存失败，请再次重试。`)
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

  // 切题时先结算停留耗时，再 flush 上一题未保存主观题内容（controller 已捕获旧题 ID）
  useEffect(() => {
    return () => {
      flushActiveQuestionDuration()
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

  // 切到新题时重置申论分块材料 Tab（保留跨题连作同一材料的可用性）
  useEffect(() => {
    setShenlunMaterialTab('all')
  }, [current?.id])

  useEffect(() => {
    setCardAlertDismissed(false)
  }, [exam?.id])

  const firstUnansweredIdx = useMemo(() => {
    if (!exam) return -1
    return (
      orderedIndices.find((idx) => {
        const q = questions[idx]
        if (!q) return false
        return !(exam.answers[q.id]?.answer ?? []).some((v) => v.trim().length > 0)
      }) ?? -1
    )
  }, [exam, orderedIndices, questions])

  const firstUncertainIdx = useMemo(() => {
    if (!uncertainIds.length) return -1
    return (
      orderedIndices.find((idx) => {
        const q = questions[idx]
        return Boolean(q && uncertainIds.includes(q.id))
      }) ?? -1
    )
  }, [orderedIndices, questions, uncertainIds])

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

  const siblingIndices: number[] = []
  if (current.material) {
    questions.forEach((q, qIdx) => {
      if (isSameExamMaterialGroup(current, q)) siblingIndices.push(qIdx)
    })
  }
  const useSplit = Boolean(current.material && materialSplit)
  const examMaterialKey =
    siblingIndices.length > 1
      ? `exam-${exam.id}-mat-${questions[siblingIndices[0]!]!.id}`
      : `exam-${exam.id}-q-${current.id}`

  const activeModuleName = normalizeXingceModule(current.category)
  const activeModuleGroup = moduleGroups.find((g) => g.moduleName === activeModuleName)
  const activeModuleSavedSeconds = (activeModuleGroup?.indices ?? [index]).reduce(
    (sum, qIdx) => sum + (questionDurationsRef.current[questions[qIdx]!.id] ?? 0),
    0
  )
  const activeQuestionLiveDelta =
    timingAnchorRef.current?.questionId === current.id
      ? Math.max(0, Math.round((Date.now() - timingAnchorRef.current.enteredAt) / 1000))
      : 0
  const activeModuleSpentSeconds = activeModuleSavedSeconds + activeQuestionLiveDelta
  const activeModuleSuggestedSeconds = suggestedModuleSeconds(
    activeModuleName,
    activeModuleGroup?.indices.length ?? 1
  )
  const activeModuleOvertime = activeModuleSpentSeconds > activeModuleSuggestedSeconds

  const handleShenlunExtract = (excerpts: string[]): void => {
    if (current.type !== 'essay') return
    let next = essayText
    let added = false
    for (const raw of excerpts) {
      const clean = raw.trim()
      if (!clean || next.includes(clean)) continue
      next = `${next}${next.trim() ? '\n' : ''}· ${clean}`
      added = true
    }
    if (added) scheduleEssaySave(next)
  }

  return (
    <div className="page">
      <div className="exam-zen-hide">
        <PageHeader
          eyebrow="训练 · 模考进行中"
          title={title}
          description={`开始于 ${formatDate(exam.startedAt)}，答案会自动保存。`}
        />
      </div>
      <div className="exam-sticky-bar">
        <div className="exam-sticky-left">
          <span className={`pill ${seconds < 300 ? 'negative' : ''}`}>
            <ClockIcon /> {timeText}
          </span>
          {exam.subject === 'xingce' && (
            <span
              className={`pill ${activeModuleOvertime ? 'warning' : ''}`}
              title={`「${activeModuleName}」建议配速约 ${Math.round(activeModuleSuggestedSeconds / 60)} 分钟`}
            >
              {activeModuleName} {Math.floor(activeModuleSpentSeconds / 60)}/
              {Math.round(activeModuleSuggestedSeconds / 60)}分
            </span>
          )}
          <span className="muted">
            第 {index + 1} / {questions.length} 题 · 已答 {answered} 题
          </span>
        </div>
        <div className="exam-sticky-right">
          {exam.subject === 'shenlun' && (
            <Button
              size="small"
              appearance={snippetOpen ? 'secondary' : 'outline'}
              icon={<BookBookmarkIcon />}
              onClick={() => setSnippetOpen((v) => !v)}
            >
              规范词/金句
            </Button>
          )}
          <Button
            size="small"
            appearance={zenMode ? 'secondary' : 'outline'}
            icon={zenMode ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
            title="切换沉浸专注视野（折叠侧栏与页头 · Alt+Z）"
            onClick={toggleZenMode}
          >
            {zenMode ? '退出专注' : '专注'}
          </Button>
          {exam.subject === 'xingce' && exam.durationMinutes >= 15 && (
            <Button
              size="small"
              appearance={cardAlertEnabled ? 'secondary' : 'outline'}
              icon={<BellRingingIcon />}
              aria-pressed={cardAlertEnabled}
              title="剩余 ≤5 分钟时提醒停止死磕难题并核对空白题"
              onClick={() => setCardAlertEnabled((value) => !value)}
            >
              涂卡提醒
            </Button>
          )}
          <Button
            size="small"
            appearance={showScratchpad ? 'secondary' : 'outline'}
            icon={<PaintBrushIcon />}
            title="打开/收起考场草稿纸 (S / Alt+D)"
            onClick={() => setShowScratchpad((value) => !value)}
          >
            草稿纸
          </Button>
          <Button
            appearance="primary"
            data-testid="exam-submit"
            onClick={() => setConfirmOpen(true)}
          >
            交卷
          </Button>
        </div>
      </div>
      {exam.subject === 'xingce' &&
        exam.durationMinutes >= 15 &&
        cardAlertEnabled &&
        !cardAlertDismissed &&
        seconds > 0 &&
        seconds <= 300 && (
          <div className="exam-card-alert" role="status" aria-live="polite">
            <div className="exam-card-alert-copy">
              <BellRingingIcon size={16} />
              <span>
                <strong>考前最后 5 分钟虚拟涂卡检查：</strong>
                还剩 {Math.ceil(seconds / 60)} 分钟，当前仍有{' '}
                <strong>{exam.questionIds.length - answered}</strong> 道未答题
                {uncertainIds.length > 0 ? `、${uncertainIds.length} 道待查题` : ''}
                ，建议立即收手填补空白选项。
              </span>
            </div>
            <div className="exam-card-alert-actions">
              {firstUnansweredIdx >= 0 && (
                <Button
                  size="small"
                  appearance="primary"
                  onClick={() => setIndex(firstUnansweredIdx)}
                >
                  跳到首个未答
                </Button>
              )}
              {firstUncertainIdx >= 0 && (
                <Button
                  size="small"
                  appearance="secondary"
                  onClick={() => setIndex(firstUncertainIdx)}
                >
                  检查待查题
                </Button>
              )}
              <Button size="small" appearance="subtle" onClick={() => setCardAlertDismissed(true)}>
                知道了
              </Button>
            </div>
          </div>
        )}
      {error && <ErrorState message={error} />}
      {saveBlocked && current.type !== 'essay' && (
        <div className="button-row" style={{ marginBottom: 12 }}>
          <Button size="small" appearance="secondary" onClick={() => void retrySave()}>
            重试保存失败答案
          </Button>
        </div>
      )}
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
              {current.type === 'essay' && (
                <Button
                  size="small"
                  appearance={shenlunUseSheet ? 'secondary' : 'subtle'}
                  onClick={() => setShenlunUseSheet((v) => !v)}
                >
                  {shenlunUseSheet ? '自由文本框' : '方格纸'}
                </Button>
              )}
              <ReadingTypographyBar
                typography={reading.typography}
                onUpdate={reading.update}
                onStepScale={reading.stepScale}
                onResetScale={reading.resetScale}
              />
            </div>
          </div>
          <div
            ref={reading.surfaceRef}
            className={`question-reading-surface${useSplit ? ' material-split-layout' : ''}`}
            data-reading-font={reading.typography.font}
            style={reading.surfaceStyle}
          >
            {current.material && (
              <div className={useSplit ? 'material-split-left' : 'answer-panel'}>
                {exam.subject === 'shenlun' ? (
                  (() => {
                    const blocks = splitShenlunMaterialBlocks(current.material)
                    const activeBlock =
                      typeof shenlunMaterialTab === 'number' && blocks[shenlunMaterialTab]
                        ? blocks[shenlunMaterialTab]!
                        : null
                    const displayed = formatShenlunMaterialParagraphs(
                      activeBlock ? activeBlock.raw : current.material
                    )
                    return (
                      <HighlightableMaterial
                        promptId={
                          shenlunMaterialTab === 'all'
                            ? examMaterialKey
                            : `${examMaterialKey}#blk-${shenlunMaterialTab}`
                        }
                        content={displayed}
                        sourceFilePath={current.filePath}
                        storagePrefix="tizhou:shenlun-highlights:"
                        onExtract={handleShenlunExtract}
                        headerLeft={
                          <div className="material-split-inline-head">
                            <strong>给定资料</strong>
                            {blocks.length >= 2 && (
                              <div className="material-sibling-tabs">
                                <button
                                  type="button"
                                  className={`material-sibling-tab${shenlunMaterialTab === 'all' ? ' is-active' : ''}`}
                                  onClick={() => setShenlunMaterialTab('all')}
                                >
                                  全部({blocks.length})
                                </button>
                                {blocks.map((blk, bIdx) => (
                                  <button
                                    key={`${blk.title}-${bIdx}`}
                                    type="button"
                                    className={`material-sibling-tab${shenlunMaterialTab === bIdx ? ' is-active' : ''}`}
                                    onClick={() => setShenlunMaterialTab(bIdx)}
                                  >
                                    {blk.title}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        }
                      />
                    )
                  })()
                ) : (
                  <HighlightableMaterial
                    promptId={examMaterialKey}
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
                              const hasAns = (exam.answers[sib.id]?.answer ?? []).some((v) =>
                                v.trim()
                              )
                              return (
                                <button
                                  key={sib.id}
                                  type="button"
                                  className={`material-sibling-tab${qIdx === index ? ' is-active' : ''}${hasAns ? ' is-correct' : ''}`}
                                  onClick={() => setIndex(qIdx)}
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
                )}
              </div>
            )}
            <div className="material-split-right">
              {!current.material && current.subject === 'xingce' ? (
                <HighlightableMaterial
                  promptId={`exam-${exam.id}-stem-${current.id}`}
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
                <div>
                  {shenlunUseSheet ? (
                    <ShenlunAnswerSheet
                      key={current.id}
                      value={essayText}
                      onChange={scheduleEssaySave}
                      limit={extractWordLimit(current.stem)}
                      headerTitle={`第 ${index + 1} 题`}
                    />
                  ) : (
                    <textarea
                      className="essay-editor"
                      data-testid="exam-essay-input"
                      aria-label="主观题作答输入"
                      value={essayText}
                      onChange={(event) => scheduleEssaySave(event.target.value)}
                    />
                  )}
                  <div className="exam-essay-status">
                    <span className="muted">
                      已写 {essayText.replace(/\s/g, '').length} 字
                      {(() => {
                        const lim = extractWordLimit(current.stem)
                        return lim ? `（要求 ${lim.label}）` : ''
                      })()}
                    </span>
                    {saveStatus === 'saving' && <span className="muted">正在保存…</span>}
                    {saveStatus === 'saved' && <span className="positive">✓ 已保存</span>}
                    {saveStatus === 'error' && !saveBlocked && (
                      <span className="negative">保存失败</span>
                    )}
                    {saveBlocked && (
                      <span className="negative">
                        保存失败{' '}
                        <Button
                          size="small"
                          appearance="secondary"
                          onClick={() => void retrySave()}
                        >
                          重试保存
                        </Button>
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <QuestionOptionList
                  options={current.options}
                  selected={currentAnswer}
                  sourceFilePath={current.filePath}
                  eliminatedKeys={currentEliminated}
                  testIdPrefix="exam-option"
                  onSelect={(key) => void choose(key)}
                  onToggleEliminate={toggleEliminate}
                />
              )}
            </div>
          </div>
          <div className="question-footer">
            <div className="button-row">
              <Button
                icon={<ArrowLeftIcon />}
                disabled={prevQuestionIdx < 0}
                onClick={() => prevQuestionIdx >= 0 && setIndex(prevQuestionIdx)}
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
              disabled={nextQuestionIdx < 0}
              onClick={() => nextQuestionIdx >= 0 && setIndex(nextQuestionIdx)}
            >
              下一题
            </Button>
          </div>
        </Section>
        <Section
          className="exam-sheet-sticky"
          title="答题卡"
          description={`${answered}/${exam.questionIds.length} 已作答${uncertainIds.length ? ` · ${uncertainIds.length} 题待查` : ''}`}
        >
          <QuestionNavigatorGrid
            questions={questions}
            currentIndex={index}
            mode={hasMultipleModules ? 'grouped' : 'flat'}
            moduleOrder={moduleOrder}
            onModuleOrderChange={setModuleOrder}
            onResetModuleOrder={() => setModuleOrder([...XINGCE_MODULE_ORDER])}
            getStatus={(q) => ({
              answered: (exam.answers[q.id]?.answer ?? []).some((v) => v.trim().length > 0),
              uncertain: uncertainIds.includes(q.id),
              durationSeconds:
                (questionDurationsRef.current[q.id] ?? 0) +
                (timingAnchorRef.current?.questionId === q.id ? activeQuestionLiveDelta : 0)
            })}
            onSelect={(targetIdx) => setIndex(targetIdx)}
          />
        </Section>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="确认交卷"
        description={
          <>
            还有 {exam.questionIds.length - answered} 道题未作答
            {uncertainIds.length > 0 ? `，另有 ${uncertainIds.length} 道题标记不确定` : ''}
            。交卷后不能继续修改，所有题目会一次性计入训练记录。
          </>
        }
        cancelLabel="继续检查"
        confirmLabel="确认交卷"
        busy={finishing}
        onConfirm={finish}
        onCancel={() => setConfirmOpen(false)}
      />
      <ScratchpadDrawer
        open={showScratchpad}
        allowCalculator={exam.subject === 'xingce'}
        contextKey={examMaterialKey}
        onClose={() => setShowScratchpad(false)}
      />
      {exam.subject === 'shenlun' && (
        <ShenlunSnippetDrawer
          open={snippetOpen}
          onClose={() => setSnippetOpen(false)}
          onInsert={(text) => {
            if (current.type === 'essay') {
              scheduleEssaySave(`${essayText}${essayText.trim() ? '\n' : ''}${text}`)
            }
          }}
        />
      )}
    </div>
  )
}
