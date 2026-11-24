import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  ClockIcon,
  FlagIcon,
  PaintBrushIcon
} from '@phosphor-icons/react'
import type { ExamSession, Question } from '@shared/contracts'
import { formatDate, invoke } from '../../api'
import { HighlightableMaterial } from '../../components/HighlightableMaterial'
import { MarkdownContent } from '../../components/MarkdownContent'
import { QuestionOptionList } from '../../components/QuestionOptionList'
import {
  ReadingTypographyBar,
  useReadingTypography
} from '../../components/ReadingTypographyControl'
import { ScratchpadDrawer } from '../../components/ScratchpadDrawer'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section
} from '../../components/ui'
import {
  readLocalStorageJson,
  removeLocalStorage,
  writeLocalStorageJson
} from '../../hooks/useLocalStorageState'
import { EssaySaveController, ExamAnswerSaveController } from '../../services/exam-essay-save'
import { hasOpenModal } from '../../services/shortcuts'
import { useAppStore } from '../../store'
import { EXAM_UNCERTAIN_PREFIX, pruneStaleExamUncertainKeys, remainingSeconds } from './shared'

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
        const savedUncertain = readLocalStorageJson<unknown>(
          `${EXAM_UNCERTAIN_PREFIX}${active.id}`,
          null
        )
        if (Array.isArray(savedUncertain)) setUncertainIds(savedUncertain.map(String))
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
      if (
        !current ||
        confirmOpen ||
        hasOpenModal() ||
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
      removeLocalStorage(`${EXAM_UNCERTAIN_PREFIX}${exam.id}`)
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
          <span className="muted">
            第 {index + 1} / {questions.length} 题 · 已答 {answered} 题
          </span>
        </div>
        <div className="exam-sticky-right">
          <Button
            size="small"
            appearance={zenMode ? 'secondary' : 'outline'}
            icon={zenMode ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
            title="切换沉浸专注视野（折叠侧栏与页头 · Alt+Z）"
            onClick={toggleZenMode}
          >
            {zenMode ? '退出专注' : '专注'}
          </Button>
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
              <div className="answer-panel" style={{ padding: 0 }}>
                <HighlightableMaterial
                  promptId={(() => {
                    const currentMat = current.material.replace(/\r\n?/g, '\n').trim()
                    const firstSame = questions.find(
                      (q) =>
                        q.category === current.category &&
                        (q.material?.replace(/\r\n?/g, '\n').trim() ?? '') === currentMat &&
                        (!current.groupId || !q.groupId || q.groupId === current.groupId)
                    )
                    return firstSame
                      ? `exam-${exam.id}-mat-${firstSame.id}`
                      : `exam-${exam.id}-q-${current.id}`
                  })()}
                  content={current.material}
                  sourceFilePath={current.filePath}
                  storagePrefix="tizhou:xingce-highlights:"
                  preset="xingce"
                  variant="embedded"
                  headerLeft={<strong>给定材料</strong>}
                />
              </div>
            )}
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
                <textarea
                  className="essay-editor"
                  data-testid="exam-essay-input"
                  aria-label="主观题作答输入"
                  value={essayText}
                  onChange={(event) => scheduleEssaySave(event.target.value)}
                />
                <div className="exam-essay-status">
                  <span className="muted">已写 {essayText.replace(/\s/g, '').length} 字</span>
                  {saveStatus === 'saving' && <span className="muted">正在保存…</span>}
                  {saveStatus === 'saved' && <span className="positive">✓ 已保存</span>}
                  {saveStatus === 'error' && !saveBlocked && (
                    <span className="negative">保存失败</span>
                  )}
                  {saveBlocked && (
                    <span className="negative">
                      保存失败{' '}
                      <Button size="small" appearance="secondary" onClick={() => void retrySave()}>
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
          className="exam-sheet-sticky"
          title="答题卡"
          description={`${answered}/${exam.questionIds.length} 已作答${uncertainIds.length ? ` · ${uncertainIds.length} 题待查` : ''}`}
        >
          <div className="question-grid">
            {questions.map((question, questionIndex) => {
              const hasAnswer = (exam.answers[question.id]?.answer ?? []).some(
                (value) => value.trim().length > 0
              )
              return (
                <Button
                  className={`question-number${uncertainIds.includes(question.id) ? ' is-uncertain' : ''}`}
                  size="small"
                  appearance={
                    questionIndex === index ? 'primary' : hasAnswer ? 'secondary' : 'subtle'
                  }
                  key={question.id}
                  onClick={() => setIndex(questionIndex)}
                >
                  {questionIndex + 1}
                </Button>
              )
            })}
          </div>
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
      <ScratchpadDrawer open={showScratchpad} onClose={() => setShowScratchpad(false)} />
    </div>
  )
}
