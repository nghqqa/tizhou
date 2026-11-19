import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Field, Input, Select, Spinner, Tab, TabList } from '@fluentui/react-components'
import { ArrowLeftIcon, ArrowRightIcon, FloppyDiskIcon, SparkleIcon } from '@phosphor-icons/react'
import { useSearchParams } from 'react-router-dom'
import type {
  ConstructedAttemptRecord,
  ConstructedDraft,
  ConstructedEvaluation,
  Question
} from '@shared/contracts'
import { formatFullDate, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'

// 下拉预览的优雅截断：压缩空白后在限长内回退到最近的句读，
// 没有句读可退时才硬切，始终以省略号提示有下文
function stemPreview(stem: string, max = 60): string {
  const compact = stem.replace(/\s+/g, '')
  if (compact.length <= max) return compact
  const head = compact.slice(0, max)
  const boundary = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('、')
  )
  return (boundary > 20 ? head.slice(0, boundary + 1) : head) + '…'
}

export function ShenlunSolutionPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedPromptId = searchParams.get('promptId') ?? ''
  const [prompts, setPrompts] = useState<Question[]>()
  const [promptId, setPromptId] = useState(requestedPromptId)
  const [keyword, setKeyword] = useState('')
  const [onlyUnattempted, setOnlyUnattempted] = useState(false)
  const [content, setContent] = useState('')
  const [evaluation, setEvaluation] = useState<ConstructedEvaluation>()
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>('')
  const [promptHistory, setPromptHistory] = useState<ConstructedAttemptRecord[]>([])
  const [allHistory, setAllHistory] = useState<ConstructedAttemptRecord[]>([])
  const [view, setView] = useState<'write' | 'reference' | 'history'>('write')
  const [saving, setSaving] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [error, setError] = useState('')
  const saveTimer = useRef<number | undefined>(undefined)

  // 按题汇总已评估状态（最新得分与提交次数）
  const statusByPrompt = useMemo(() => {
    const map = new Map<string, { count: number; latestScore: number; latestAt: string }>()
    for (const item of allHistory) {
      const existing = map.get(item.promptId)
      if (!existing) {
        map.set(item.promptId, {
          count: 1,
          latestScore: item.evaluation.score,
          latestAt: item.createdAt
        })
      } else {
        existing.count += 1
      }
    }
    return map
  }, [allHistory])

  const visiblePrompts = useMemo(() => {
    if (!prompts) return undefined
    if (!onlyUnattempted) return prompts
    return prompts.filter((prompt) => !statusByPrompt.has(prompt.id))
  }, [prompts, onlyUnattempted, statusByPrompt])

  const currentIndex = useMemo(
    () => (visiblePrompts ? visiblePrompts.findIndex((prompt) => prompt.id === promptId) : -1),
    [visiblePrompts, promptId]
  )
  const current = useMemo(
    () =>
      (visiblePrompts && currentIndex >= 0 ? visiblePrompts[currentIndex] : undefined) ??
      prompts?.find((prompt) => prompt.id === promptId),
    [visiblePrompts, currentIndex, prompts, promptId]
  )

  // 加载全局申论评估记录（用于标注每题状态与「只看未做」筛选）
  async function refreshAllHistory(): Promise<void> {
    try {
      const items = await invoke<ConstructedAttemptRecord[]>({
        method: 'constructed.history',
        params: { limit: 500 }
      })
      setAllHistory(items)
    } catch {
      /* 历史记录加载失败不阻塞作答主流程 */
    }
  }

  useEffect(() => {
    void refreshAllHistory()
  }, [])

  // 响应 URL 参数跳转（例如从学习报告「申论作答记录」点进复盘）
  useEffect(() => {
    if (requestedPromptId) {
      setOnlyUnattempted(false)
      setPromptId(requestedPromptId)
    }
  }, [requestedPromptId])

  // 关键词搜索（防抖）：题目多时不再静默截断在前 200 题，可按关键词定位目标题
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void invoke<Question[]>({
        method: 'vault.search',
        params: {
          subject: 'shenlun',
          type: 'essay',
          limit: 500,
          query: keyword.trim() || undefined
        }
      })
        .then((items) => {
          setPrompts(items)
          setPromptId((previous) => {
            if (requestedPromptId && items.some((item) => item.id === requestedPromptId)) {
              return requestedPromptId
            }
            return previous && items.some((item) => item.id === previous)
              ? previous
              : (items[0]?.id ?? '')
          })
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : '申论题目读取失败'))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword, requestedPromptId])

  // 开启「只看未做」导致当前题不在可见列表中时，自动切到第一道未做题
  useEffect(() => {
    if (!visiblePrompts || !visiblePrompts.length) return
    if (!visiblePrompts.some((item) => item.id === promptId)) {
      setPromptId(visiblePrompts[0]!.id)
    }
  }, [visiblePrompts, promptId])

  // 切换题目时加载草稿与本题历次评估记录（自动回显最近一次评估）
  useEffect(() => {
    if (!promptId) return
    let cancelled = false
    setContent('')
    setEvaluation(undefined)
    setSelectedHistoryId('')
    setPromptHistory([])
    void Promise.all([
      invoke<ConstructedDraft | undefined>({
        method: 'draft.get',
        params: { id: `draft-${promptId}` }
      }),
      invoke<ConstructedAttemptRecord[]>({
        method: 'constructed.history',
        params: { promptId, limit: 50 }
      }).catch(() => [] as ConstructedAttemptRecord[])
    ]).then(([draft, history]) => {
      if (cancelled) return
      setContent(draft?.content ?? '')
      setPromptHistory(history)
      if (history.length > 0) {
        setEvaluation(history[0]!.evaluation)
        setSelectedHistoryId(history[0]!.id)
      }
    })
    return () => {
      cancelled = true
    }
  }, [promptId])

  useEffect(() => {
    if (!promptId) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveDraft(false)
    }, 1200)
    return () => window.clearTimeout(saveTimer.current)
  }, [content, promptId])

  async function saveDraft(showState = true): Promise<void> {
    if (!promptId || !current) return
    if (showState) setSaving(true)
    try {
      await invoke({
        method: 'draft.save',
        params: { id: `draft-${promptId}`, promptId, title: current.stem.slice(0, 40), content }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '草稿保存失败')
    } finally {
      if (showState) setSaving(false)
    }
  }

  async function switchPrompt(nextId: string): Promise<void> {
    if (!nextId || nextId === promptId) return
    window.clearTimeout(saveTimer.current)
    await saveDraft(false)
    setPromptId(nextId)
    if (requestedPromptId) {
      setSearchParams({}, { replace: true })
    }
  }

  async function goAdjacent(delta: -1 | 1): Promise<void> {
    if (!visiblePrompts || currentIndex < 0) return
    const target = visiblePrompts[currentIndex + delta]
    if (target) await switchPrompt(target.id)
  }

  async function evaluate(): Promise<void> {
    if (!current) return
    setEvaluating(true)
    setError('')
    try {
      await saveDraft(false)
      const result = await invoke<ConstructedEvaluation>({
        method: 'constructed.evaluate',
        params: { promptId: current.id, title: current.stem.slice(0, 40), content }
      })
      setEvaluation(result)
      setSelectedHistoryId(result.id)
      const [history] = await Promise.all([
        invoke<ConstructedAttemptRecord[]>({
          method: 'constructed.history',
          params: { promptId: current.id, limit: 50 }
        }).catch(() => [] as ConstructedAttemptRecord[]),
        refreshAllHistory()
      ])
      setPromptHistory(history)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评估失败')
    } finally {
      setEvaluating(false)
    }
  }

  function loadHistoryDraft(record: ConstructedAttemptRecord): void {
    setContent(record.content)
    setEvaluation(record.evaluation)
    setSelectedHistoryId(record.id)
    setView('write')
  }

  if (!prompts)
    return (
      <div className="page">
        <PageHeader title="申论作答" />
        <LoadingState />
      </div>
    )
  if (!prompts.length)
    return (
      <div className="page">
        <PageHeader title="申论作答" />
        <EmptyState
          title="知识库中没有申论主观题"
          description="导入 type: essay 且 subject: shenlun 的 Markdown 题目后即可开始。"
        />
      </div>
    )

  const totalVisible = visiblePrompts?.length ?? 0
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex >= 0 && currentIndex < totalVisible - 1
  const currentStatus = current ? statusByPrompt.get(current.id) : undefined

  return (
    <div className="page page-solution">
      <PageHeader
        eyebrow="提升 · 申论作答"
        title="申论作答"
        description="草稿在本机自动保存。未配置 AI 时使用透明的本地规则评分，配置后自动尝试语义评估。"
        actions={
          <>
            <Button icon={<FloppyDiskIcon />} disabled={saving} onClick={() => void saveDraft()}>
              {saving ? '保存中' : '保存草稿'}
            </Button>
            <Button
              appearance="primary"
              icon={<SparkleIcon />}
              disabled={evaluating || !current}
              onClick={() => void evaluate()}
            >
              {evaluating ? '评估中' : '提交评估'}
            </Button>
          </>
        }
      />
      {error && <ErrorState message={error} />}
      <Section>
        <div className="form-grid">
          <Field className="grow" label="搜索题目">
            <Input
              value={keyword}
              onChange={(_, data) => setKeyword(data.value)}
              placeholder="按题干关键词过滤"
            />
          </Field>
          <Field className="grow" label="选择题目">
            <Select
              value={promptId}
              disabled={!totalVisible}
              onChange={(_, data) => void switchPrompt(data.value)}
            >
              {(visiblePrompts ?? []).map((prompt) => {
                const status = statusByPrompt.get(prompt.id)
                const badge = status ? ` [已评 ${status.latestScore} 分]` : ''
                return (
                  <option value={prompt.id} key={prompt.id}>
                    {prompt.category}：{stemPreview(prompt.stem)}
                    {badge}
                  </option>
                )
              })}
            </Select>
          </Field>
        </div>
        <div className="solution-nav-bar">
          <div className="question-meta">
            {current && <span className="pill">{current.category}</span>}
            {current && <span className="pill">难度 {current.difficulty}</span>}
            <span className="pill">{content.replace(/\s/g, '').length} 字</span>
            {currentStatus && (
              <span className="pill">
                已评 {currentStatus.count} 次 · 最新 {currentStatus.latestScore} 分
              </span>
            )}
            {totalVisible > 0 && currentIndex >= 0 && (
              <span className="pill">
                第 {currentIndex + 1} / {totalVisible} 题
              </span>
            )}
          </div>
          <div className="solution-nav-actions">
            <Button
              size="small"
              appearance={onlyUnattempted ? 'primary' : 'subtle'}
              onClick={() => setOnlyUnattempted((value) => !value)}
            >
              {onlyUnattempted ? '显示全部题目' : '只看未做'}
            </Button>
            <Button
              size="small"
              icon={<ArrowLeftIcon />}
              disabled={!hasPrev}
              onClick={() => void goAdjacent(-1)}
            >
              上一题
            </Button>
            <Button
              size="small"
              icon={<ArrowRightIcon />}
              iconPosition="after"
              disabled={!hasNext}
              onClick={() => void goAdjacent(1)}
            >
              下一题
            </Button>
          </div>
        </div>
        {onlyUnattempted && totalVisible === 0 ? (
          <EmptyState
            title="当前筛选下已全部做完"
            description="所有匹配题目均已有评估记录，可切换「显示全部题目」继续二刷精进。"
          />
        ) : (
          <div className="essay-columns">
            <div className="essay-col">
              {current?.material && (
                <div className="essay-material">
                  <h3>给定资料</h3>
                  <MarkdownContent content={current.material} sourceFilePath={current.filePath} />
                </div>
              )}
              <MarkdownContent
                className="question-stem"
                content={current?.stem ?? ''}
                sourceFilePath={current?.filePath}
              />
            </div>
            <div className="essay-col">
              <TabList
                selectedValue={view}
                onTabSelect={(_, data) => setView(data.value as 'write' | 'reference' | 'history')}
              >
                <Tab value="write">我的作答</Tab>
                <Tab value="reference">参考解析</Tab>
                <Tab value="history">历史记录 ({promptHistory.length})</Tab>
              </TabList>
              {view === 'write' ? (
                <textarea
                  className="essay-editor"
                  data-testid="shenlun-draft-input"
                  aria-label="申论作答草稿"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="建议先列要点，再组织成完整答案。草稿会在停止输入后自动保存。"
                />
              ) : view === 'reference' ? (
                <div className="answer-panel">
                  <h3>参考要点</h3>
                  <p>{current?.answer.join('；')}</p>
                  <MarkdownContent
                    content={current?.explanation ?? ''}
                    sourceFilePath={current?.filePath}
                  />
                </div>
              ) : (
                <div className="answer-panel">
                  {promptHistory.length === 0 ? (
                    <p className="muted">本题尚无评估记录，提交评估后会在此保留每次作答与点评。</p>
                  ) : (
                    <div className="solution-history-list">
                      {promptHistory.map((record, index) => {
                        const active = record.id === selectedHistoryId
                        const wordCount = record.content.replace(/\s/g, '').length
                        return (
                          <div
                            key={record.id}
                            className={`solution-history-item${active ? ' is-active' : ''}`}
                          >
                            <div className="solution-history-head">
                              <div>
                                <strong>
                                  第 {promptHistory.length - index} 次 · {record.evaluation.score}{' '}
                                  分
                                </strong>
                                <span className="solution-history-meta">
                                  {formatFullDate(record.createdAt)} · {wordCount} 字 ·{' '}
                                  {record.evaluation.provider}
                                </span>
                              </div>
                              <div className="solution-history-actions">
                                <Button
                                  size="small"
                                  appearance={active ? 'primary' : 'subtle'}
                                  onClick={() => {
                                    setEvaluation(record.evaluation)
                                    setSelectedHistoryId(record.id)
                                  }}
                                >
                                  {active ? '查看中' : '查看点评'}
                                </Button>
                                <Button size="small" onClick={() => loadHistoryDraft(record)}>
                                  载入修改
                                </Button>
                              </div>
                            </div>
                            <p className="solution-history-preview">
                              {record.content.trim() || '（空作答）'}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Section>
      {evaluating && (
        <Section>
          <Spinner label="正在评估答案" />
        </Section>
      )}
      {evaluation && (
        <Section
          title={`评估结果：${evaluation.score} 分`}
          description={`${evaluation.provider} · ${formatFullDate(evaluation.createdAt)}`}
        >
          <div className="grid three">
            {evaluation.dimensions.map((dimension) => (
              <div className="stat" key={dimension.name}>
                <span>{dimension.name}</span>
                <strong>{dimension.score}</strong>
                <small>{dimension.comment}</small>
              </div>
            ))}
          </div>
          <div className="answer-panel">
            <h3>综合反馈</h3>
            <p>{evaluation.summary}</p>
            <ol>
              {evaluation.suggestions.map((suggestion) => (
                <li key={suggestion}>{suggestion}</li>
              ))}
            </ol>
          </div>
        </Section>
      )}
    </div>
  )
}
