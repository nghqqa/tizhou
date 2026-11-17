import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Button,
  Checkbox,
  Field,
  Input,
  ProgressBar,
  Select,
  Textarea
} from '@fluentui/react-components'
import {
  BookmarkSimpleIcon,
  CheckIcon,
  FlagIcon,
  NotePencilIcon,
  SkipForwardIcon
} from '@phosphor-icons/react'
import type {
  AiAskResult,
  AttemptResult,
  PracticeSelection,
  PracticeSession,
  Question,
  QuestionFacets,
  ReviewItem,
  Subject
} from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { OptionContent } from '../components/OptionContent'
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
}

function Trainer({
  review = false,
  initial
}: {
  review?: boolean
  initial?: TrainerInitial
}): React.JSX.Element {
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
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
  const [onlyWrong, setOnlyWrong] = useState(false)
  const [onlyFavorite, setOnlyFavorite] = useState(false)
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
  const [wrongCause, setWrongCause] = useState('')
  const [reviewFeedback, setReviewFeedback] = useState<'forgot' | 'hard' | 'normal' | 'easy'>(
    'normal'
  )
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(review)
  const [error, setError] = useState('')
  const startedAt = useRef(Date.now())

  useEffect(() => {
    // 科目筛选跟随 URL 参数（xingce / shenlun），空值与 common 视为不限科目
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
    void invoke<PracticeSession | undefined>({
      method: 'practice.session.active',
      params: { mode: review ? 'review' : 'practice' }
    })
      .then((active) => {
        if (active) {
          if (review) restoreSession(active)
          else setPendingSession(active)
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
  }, [review, subject])

  const current = questions[index]

  useEffect(() => {
    if (!current) return
    void invoke<string>({ method: 'note.get', params: { questionId: current.id } })
      .then(setNote)
      .catch(() => setNote(''))
    void invoke<boolean>({ method: 'favorite.get', params: { questionId: current.id } })
      .then(setFavorite)
      .catch(() => setFavorite(false))
  }, [current?.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 焦点在表单控件上时不抢键盘：Select/Button 上的 Enter 属于控件本身（避免误提交）
      if (
        !current ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLButtonElement
      )
        return
      const optionIndex = /^[1-8]$/.test(event.key)
        ? Number(event.key) - 1
        : /^[a-h]$/i.test(event.key)
          ? event.key.toUpperCase().charCodeAt(0) - 65
          : -1
      const option = current.options[optionIndex]
      if (option && !result) choose(option.key)
      if (event.key === 'Enter' && !result && (selected.length || essayAnswer.trim())) void submit()
      if (event.key.toLowerCase() === 'n' && result) void next()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, result, selected, essayAnswer])

  function restoreSession(active: PracticeSession): void {
    const restored = active.questionIds
      .map((id) => active.questionSnapshots[id])
      .filter((question): question is Question => Boolean(question))
    setSession(active)
    setFeedbackMode(active.feedbackMode)
    setQuestions(restored)
    setIndex(Math.min(active.currentIndex, Math.max(0, restored.length - 1)))
    setPendingSession(undefined)
    setLoading(false)
    startedAt.current = Date.now()
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
          onlyFavorite: onlyFavorite || undefined
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
      setError(cause instanceof Error ? cause.message : '选题失败')
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
    if (!current || result) return
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
    if (!current) return
    const answer = current.type === 'essay' ? [essayAnswer.trim()] : selected
    if (!answer[0]) {
      setError('请先填写或选择答案')
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await invoke<AttemptResult>({
        method: 'attempt.submit',
        params: {
          questionId: current.id,
          answer,
          durationSeconds: Math.round((Date.now() - startedAt.current) / 1000),
          mode: review ? 'review' : 'practice',
          sessionId: session?.id,
          wrongCause,
          reviewFeedback: review ? reviewFeedback : undefined
        }
      })
      const updatedResults = [
        ...sessionResults,
        { questionId: current.id, result: response, answer }
      ]
      setSessionResults(updatedResults)
      void refreshDashboard()
      if (feedbackMode === 'summary') {
        if (index + 1 >= questions.length) {
          if (session)
            await invoke({ method: 'practice.session.complete', params: { id: session.id } })
          setSummaryComplete(true)
        } else {
          await advance()
        }
      } else {
        setResult(response)
        setSimilar(
          await invoke<Question[]>({
            method: 'questions.similar',
            params: { id: current.id, limit: 3 }
          })
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交失败')
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
  }

  async function advance(): Promise<void> {
    const nextIndex = index + 1
    if (session) {
      const updated = await invoke<PracticeSession>({
        method: 'practice.session.update',
        params: { id: session.id, currentIndex: nextIndex }
      })
      setSession(updated)
    }
    setIndex(nextIndex)
    resetQuestionState()
  }

  async function next(): Promise<void> {
    if (index + 1 >= questions.length) {
      if (session) await invoke({ method: 'practice.session.complete', params: { id: session.id } })
      setQuestions([])
      setSession(undefined)
      setSessionResults([])
      setIndex(0)
      return
    }
    await advance()
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

  if (loading && !current) return <LoadingState label="正在准备题目" />

  if (summaryComplete) {
    const correctCount = sessionResults.filter((item) => item.result.correct).length
    return (
      <Section
        title={`本组完成：${correctCount}/${sessionResults.length} 正确`}
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
                第 {questionIndex + 1} 题：{item?.result.correct ? '正确' : '错误'}
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
            <Button appearance="primary" onClick={() => restoreSession(pendingSession)}>
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
            <Select value={subject} onChange={(_, data) => setSubject(data.value as '' | Subject)}>
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
              label="只练错题"
              checked={onlyWrong}
              onChange={(_, data) => setOnlyWrong(Boolean(data.checked))}
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
  return (
    <div className="question-shell">
      <Section className="question-card">
        {error && <ErrorState message={error} />}
        <div className="progress-text">
          <span>
            第 {index + 1} 题 / 共 {questions.length} 题
          </span>
          <span>
            {current.category} · 难度 {current.difficulty}
          </span>
        </div>
        <ProgressBar value={(index + 1) / questions.length} />
        <div className="question-meta" style={{ marginTop: 18 }}>
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
          <Textarea
            resize="vertical"
            rows={8}
            value={essayAnswer}
            onChange={(_, data) => setEssayAnswer(data.value)}
            placeholder="写下你的作答要点"
            disabled={Boolean(result)}
          />
        ) : (
          <div className="options">
            {current.options.map((option) => (
              <button
                type="button"
                key={option.key}
                className={`option-button ${
                  result
                    ? current.answer.includes(option.key)
                      ? 'correct'
                      : selected.includes(option.key)
                        ? 'wrong'
                        : 'dimmed'
                    : selected.includes(option.key)
                      ? 'selected'
                      : ''
                }`}
                onClick={() => choose(option.key)}
                disabled={Boolean(result)}
              >
                <span className="option-key">{option.key}</span>
                <OptionContent option={option} sourceFilePath={current.filePath} />
              </button>
            ))}
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
        <div className="question-footer">
          <div className="button-row">
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
          {result ? (
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
              <MarkdownContent content={aiExplanation} />
            ) : (
              <Button disabled={aiBusy} onClick={() => void askAiAboutCurrent()}>
                {aiBusy ? '正在分析' : '解释本题易错点'}
              </Button>
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
  const subjectParam = searchParams.get('subject')
  const subject =
    subjectParam === 'xingce' || subjectParam === 'shenlun' || subjectParam === 'common'
      ? subjectParam === 'common'
        ? ''
        : subjectParam
      : undefined
  const initial: TrainerInitial | undefined =
    mode || count || category || subject !== undefined
      ? {
          mode: mode ?? undefined,
          count,
          category,
          feedbackMode: 'immediate',
          subject: subject ?? 'xingce'
        }
      : undefined
  return (
    <div className="page">
      <PageHeader
        eyebrow="PRACTICE"
        title="专项练习"
        description="支持会话恢复、内容快照、即时或汇总解析、键盘选项和自适应选题。"
      />
      {recommended && (
        <div className="answer-panel" style={{ marginBottom: 14 }}>
          <p className="positive" style={{ margin: 0 }}>
            ✓ 已根据你的薄弱模块生成训练建议：{recommended}
            {count ? ` · ${count} 题` : ''}。你可以直接开始，也可以调整下方配置。
          </p>
        </div>
      )}
      <Trainer initial={initial} />
    </div>
  )
}

export function ReviewPage(): React.JSX.Element {
  const [due, setDue] = useState<ReviewItem[]>()
  useEffect(() => {
    void invoke<ReviewItem[]>({ method: 'review.due', params: { limit: 500 } }).then(setDue)
  }, [])
  return (
    <div className="page">
      <PageHeader
        eyebrow="REVIEW"
        title="错题复习"
        description={
          due
            ? `${due.length} 道题已到期。忘记、困难、一般和熟练反馈会调整下一次复习间隔。`
            : '正在读取复习队列。'
        }
      />
      <Trainer review />
    </div>
  )
}
