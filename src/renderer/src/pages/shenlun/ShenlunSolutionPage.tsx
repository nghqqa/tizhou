import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Spinner, Tab, TabList } from '@fluentui/react-components'
import { FloppyDiskIcon, SparkleIcon, StopIcon } from '@phosphor-icons/react'
import type {
  ConstructedAttemptRecord,
  ConstructedDraft,
  ConstructedEvaluation,
  Question,
  QuestionFacets,
  QuestionSummary
} from '@shared/contracts'
import {
  classifyShenlunType,
  formatShenlunMaterialParagraphs,
  inspectShenlunMaterialQuality,
  recommendShenlunMaterialIndices,
  splitShenlunMaterialBlocks,
  type ShenlunQuestionType
} from '@shared/shenlun'
import { invoke } from '../../api'
import { HighlightableMaterial } from '../../components/HighlightableMaterial'
import { MarkdownContent } from '../../components/MarkdownContent'
import { QuestionEditDialog } from '../../components/QuestionEditDialog'
import { useReadingTypography } from '../../components/ReadingTypographyControl'
import { ShenlunAnswerSheet } from '../../components/ShenlunAnswerSheet'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../../components/ui'
import {
  BOOLEAN_FLAG_CODEC,
  BOOLEAN_OPT_IN_CODEC,
  useLocalStorageState
} from '../../hooks/useLocalStorageState'
import {
  cancelAiStream,
  extractShenlunStreamPreview,
  subscribeAiStream
} from '../../services/ai-stream'
import { hasOpenModal, isEditableTarget } from '../../services/shortcuts'
import { useImeSearchInput } from '../../services/search-input'
import { extractWordLimit, readStoredRegion, writeStoredRegion } from '../../services/study-helpers'
import { useAppStore } from '../../store'
import { QUALITY_FILTER_CODEC, SHEET_MODE_CODEC, type ShenlunQualityFilter } from './constants'
import { ShenlunEvaluationPanel } from './ShenlunEvaluationPanel'
import { ShenlunFilterBar } from './ShenlunFilterBar'
import { ShenlunHistoryPanel } from './ShenlunHistoryPanel'
import { ShenlunNavBar } from './ShenlunNavBar'
import { ShenlunPointChecklist } from './ShenlunPointChecklist'
import { ShenlunSnippetDrawer } from './ShenlunSnippetDrawer'

export function ShenlunSolutionPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedPromptId = searchParams.get('promptId') ?? ''
  const defaultRegion = useAppStore((state) => state.data?.settings.defaultRegion ?? '')
  const zenMode = useAppStore((state) => state.zenMode)
  const toggleZenMode = useAppStore((state) => state.toggleZenMode)
  const vault = useAppStore((state) => state.data?.vault)
  const refreshVault = useAppStore((state) => state.refreshVault)
  const showToast = useAppStore((state) => state.showToast)
  const [prompts, setPrompts] = useState<QuestionSummary[]>()
  const [promptId, setPromptId] = useState(requestedPromptId)
  const [loadedPromptId, setLoadedPromptId] = useState('')
  const [currentDetail, setCurrentDetail] = useState<Question | undefined>()
  const [region, setRegion] = useState(() =>
    requestedPromptId ? '' : readStoredRegion('tizhou:shenlun-region', defaultRegion)
  )
  const [regions, setRegions] = useState<string[]>([])
  const [regionCounts, setRegionCounts] = useState<Array<{ region: string; count: number }>>([])
  const [shenlunType, setShenlunType] = useState<'' | ShenlunQuestionType>('')
  const search = useImeSearchInput({ delayMs: 250 })
  const activeQuery = search.debouncedValue.trim()
  const [loadingPrompts, setLoadingPrompts] = useState(true)
  const [appliedFilter, setAppliedFilter] = useState<{ region: string; query: string }>({
    region: '',
    query: ''
  })
  const [hasAnyPrompts, setHasAnyPrompts] = useState<boolean | null>(null)
  const [onlyUnattempted, setOnlyUnattempted] = useState(false)
  const [qualityFilter, setQualityFilter] = useLocalStorageState<ShenlunQualityFilter>(
    'tizhou:shenlun-quality-filter',
    'all',
    QUALITY_FILTER_CODEC
  )
  const [officialTypography, setOfficialTypography] = useLocalStorageState<boolean>(
    'tizhou:shenlun-official-typography',
    false,
    BOOLEAN_OPT_IN_CODEC
  )
  const reading = useReadingTypography()
  const [content, setContent] = useState('')
  const [evaluation, setEvaluation] = useState<ConstructedEvaluation>()
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>('')
  const [promptHistory, setPromptHistory] = useState<ConstructedAttemptRecord[]>([])
  const [allHistory, setAllHistory] = useState<ConstructedAttemptRecord[]>([])
  const [view, setView] = useState<'write' | 'reference' | 'history'>('write')
  const [saving, setSaving] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [streamEvalRaw, setStreamEvalRaw] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [snippetOpen, setSnippetOpen] = useState(false)
  const [error, setError] = useState('')
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Record<string, boolean>>({})
  const [materialTab, setMaterialTab] = useState<'all' | number>('all')
  const [sheetMode, setSheetMode] = useLocalStorageState<'sheet' | 'plain'>(
    'tizhou:shenlun-sheet-mode',
    'sheet',
    SHEET_MODE_CODEC
  )
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [showTimer, setShowTimer] = useLocalStorageState<boolean>(
    'tizhou:shenlun-show-timer',
    true,
    BOOLEAN_FLAG_CODEC
  )
  const saveTimer = useRef<number | undefined>(undefined)
  const activePromptIdRef = useRef(promptId)
  activePromptIdRef.current = promptId
  const pendingDraftRef = useRef<{ promptId: string; title: string; content: string } | null>(null)
  const questionCacheRef = useRef(new Map<string, Question>())
  const evalStreamCancelRef = useRef<(() => void) | null>(null)

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

  const qualityCounts = useMemo(() => {
    let all = 0
    let cleanable = 0
    let verified = 0
    let incomplete = 0
    for (const prompt of prompts ?? []) {
      all += 1
      if (prompt.materialQuality === 'incomplete') {
        incomplete += 1
      } else {
        cleanable += 1
        if (prompt.materialQuality === 'verified') verified += 1
      }
    }
    return { all, cleanable, verified, incomplete }
  }, [prompts])

  const qualityFilteredPrompts = useMemo(() => {
    if (!prompts) return undefined
    if (qualityFilter === 'all') return prompts
    return prompts.filter((prompt) => {
      if (qualityFilter === 'hide-incomplete') return prompt.materialQuality !== 'incomplete'
      return prompt.materialQuality === 'verified'
    })
  }, [prompts, qualityFilter])

  const typeCounts = useMemo(() => {
    const counts: Record<ShenlunQuestionType, number> = {
      单一题: 0,
      综合题: 0,
      公文题: 0,
      作文题: 0
    }
    for (const prompt of qualityFilteredPrompts ?? []) {
      const kind = classifyShenlunType(prompt.category, prompt.stemPreview)
      counts[kind] += 1
    }
    return counts
  }, [qualityFilteredPrompts])

  const visiblePrompts = useMemo(() => {
    if (!qualityFilteredPrompts) return undefined
    return qualityFilteredPrompts.filter((prompt) => {
      if (shenlunType && classifyShenlunType(prompt.category, prompt.stemPreview) !== shenlunType) {
        return false
      }
      if (onlyUnattempted && statusByPrompt.has(prompt.id)) {
        return false
      }
      return true
    })
  }, [qualityFilteredPrompts, shenlunType, onlyUnattempted, statusByPrompt])

  const currentIndex = useMemo(
    () => (visiblePrompts ? visiblePrompts.findIndex((prompt) => prompt.id === promptId) : -1),
    [visiblePrompts, promptId]
  )
  const totalVisible = visiblePrompts?.length ?? 0
  const currentSummary = useMemo(
    () => (visiblePrompts && currentIndex >= 0 ? visiblePrompts[currentIndex] : undefined),
    [visiblePrompts, currentIndex]
  )
  const current = totalVisible > 0 && currentDetail?.id === promptId ? currentDetail : undefined

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
    void invoke<QuestionFacets>({
      method: 'vault.facets',
      params: { subject: 'shenlun' }
    })
      .then((facets) => {
        setRegions(facets.regions)
        setRegionCounts(facets.regionCounts ?? [])
        if (region && !facets.regions.includes(region)) {
          setRegion('')
          writeStoredRegion('tizhou:shenlun-region', '')
        }
      })
      .catch(() => {
        setRegions([])
        setRegionCounts([])
      })
  }, [])

  const activeQuestionType = current
    ? classifyShenlunType(current.category, current.stem)
    : '单一题'
  const currentLimit = current ? extractWordLimit(current.stem) : null

  const hasActivePrompt = Boolean(promptId) && totalVisible > 0
  useEffect(() => {
    setElapsedSeconds(0)
    if (!hasActivePrompt) return
    const timer = window.setInterval(() => {
      setElapsedSeconds((sec) => sec + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [promptId, hasActivePrompt])

  function handleExtractToDraft(excerpts: string[]): void {
    let next = content
    let added = false
    for (const raw of excerpts) {
      const clean = raw.trim()
      if (!clean || next.includes(clean)) continue
      const sep = next.trim().length > 0 ? '\n' : ''
      next = `${next}${sep}· ${clean}`
      added = true
    }
    if (added) updateDraftContent(next)
    if (view !== 'write') setView('write')
  }

  // 响应 URL 参数跳转（例如从学习报告「申论作答记录」点进复盘），评估进行中忽略外部切题
  useEffect(() => {
    if (!requestedPromptId || evaluating) return
    void flushPendingDraft(false).then(() => {
      setRegion('')
      search.clear()
      setShenlunType('')
      setQualityFilter('all')
      setOnlyUnattempted(false)
      setPromptId(requestedPromptId)
    })
  }, [requestedPromptId, evaluating, search.clear])

  // 地区/关键词查询（输入防抖与中文 IME 合成态由 useImeSearchInput 统一处理，首次加载与切地区立即执行）
  useEffect(() => {
    let cancelled = false
    setLoadingPrompts(true)
    setError('')
    void invoke<QuestionSummary[]>({
      method: 'vault.listSummary',
      params: {
        subject: 'shenlun',
        type: 'essay',
        limit: 5000,
        region: region || undefined,
        query: activeQuery || undefined
      }
    })
      .then(async (items) => {
        if (cancelled) return
        const previous = activePromptIdRef.current
        const nextId =
          requestedPromptId && items.some((item) => item.id === requestedPromptId)
            ? requestedPromptId
            : previous && items.some((item) => item.id === previous)
              ? previous
              : (items[0]?.id ?? '')
        if (nextId !== previous) {
          await flushPendingDraft(false)
          if (cancelled) return
        }
        setPrompts(items)
        setAppliedFilter({ region, query: activeQuery })
        if (items.length > 0) {
          setHasAnyPrompts(true)
        } else if (!region && !activeQuery) {
          setHasAnyPrompts(false)
        }
        setPromptId(nextId)
        setLoadingPrompts(false)
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '申论题目读取失败')
          setLoadingPrompts(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeQuery, region, requestedPromptId])

  // 开启「只看未做」导致当前题不在可见列表中时，先落盘草稿再自动切到第一道未做题
  useEffect(() => {
    if (evaluating) return
    if (!visiblePrompts || !visiblePrompts.length) return
    if (!visiblePrompts.some((item) => item.id === promptId)) {
      const nextId = visiblePrompts[0]!.id
      const previousId = promptId
      void flushPendingDraft(false).then(() => {
        setPromptId((currentId) => (currentId === previousId ? nextId : currentId))
      })
    }
  }, [visiblePrompts, promptId, evaluating])

  // 切换题目时按需加载完整题目材料、草稿与本题历次评估记录
  useEffect(() => {
    if (!promptId) {
      setCurrentDetail(undefined)
      setContent('')
      setEvaluation(undefined)
      setSelectedHistoryId('')
      setPromptHistory([])
      setExpandedHistoryIds({})
      setLoadedPromptId('')
      return
    }
    let cancelled = false
    const cachedQuestion = questionCacheRef.current.get(promptId)
    if (cachedQuestion) setCurrentDetail(cachedQuestion)
    setContent('')
    setEvaluation(undefined)
    setSelectedHistoryId('')
    setPromptHistory([])
    setExpandedHistoryIds({})
    void Promise.all([
      cachedQuestion
        ? Promise.resolve(cachedQuestion)
        : invoke<Question | undefined>({
            method: 'vault.question',
            params: { id: promptId }
          }),
      invoke<ConstructedDraft | undefined>({
        method: 'draft.get',
        params: { id: `draft-${promptId}` }
      }),
      invoke<ConstructedAttemptRecord[]>({
        method: 'constructed.history',
        params: { promptId, limit: 50 }
      }).catch(() => [] as ConstructedAttemptRecord[])
    ])
      .then(([questionDetail, draft, history]) => {
        if (cancelled) return
        if (questionDetail) {
          questionCacheRef.current.set(promptId, questionDetail)
          setCurrentDetail(questionDetail)
        }
        setContent(draft?.content ?? '')
        setPromptHistory(history)
        if (history.length > 0) {
          setEvaluation(history[0]!.evaluation)
          setSelectedHistoryId(history[0]!.id)
        }
        if (questionDetail?.material) {
          const blocks = splitShenlunMaterialBlocks(questionDetail.material)
          const rec = recommendShenlunMaterialIndices(
            blocks,
            questionDetail.stem,
            questionDetail.explanation,
            classifyShenlunType(questionDetail.category, questionDetail.stem)
          )
          setMaterialTab(blocks.length >= 3 && rec.length > 0 ? rec[0]! : 'all')
        } else {
          setMaterialTab('all')
        }
        setLoadedPromptId(promptId)
      })
      .catch(() => {
        if (!cancelled) setLoadedPromptId(promptId)
      })
    return () => {
      cancelled = true
    }
  }, [promptId])

  // 卸载与关闭窗口前兜底冲刷未落盘草稿，避免刚输入即离开页面或关闭应用丢失
  useEffect(() => {
    const flushNow = (): void => {
      window.clearTimeout(saveTimer.current)
      if (pendingDraftRef.current) {
        void persistDraftSnapshot(pendingDraftRef.current, false)
      }
    }
    window.addEventListener('beforeunload', flushNow)
    return () => {
      window.removeEventListener('beforeunload', flushNow)
      flushNow()
      evalStreamCancelRef.current?.()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (hasOpenModal()) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (!current) return
        event.preventDefault()
        void saveDraft(true)
        return
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !evaluating &&
        !isEditableTarget(event.target)
      ) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          void goAdjacent(-1)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          void goAdjacent(1)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, evaluating, visiblePrompts, currentIndex, content])

  async function persistDraftSnapshot(
    snapshot: { promptId: string; title: string; content: string },
    showState = false
  ): Promise<boolean> {
    if (showState) setSaving(true)
    try {
      await invoke({
        method: 'draft.save',
        params: {
          id: `draft-${snapshot.promptId}`,
          promptId: snapshot.promptId,
          title: snapshot.title,
          content: snapshot.content
        }
      })
      if (pendingDraftRef.current === snapshot) {
        pendingDraftRef.current = null
      }
      return true
    } catch (cause) {
      if (activePromptIdRef.current === snapshot.promptId) {
        setError(cause instanceof Error ? cause.message : '草稿保存失败')
      }
      return false
    } finally {
      if (showState) setSaving(false)
    }
  }

  async function flushPendingDraft(showState = false): Promise<boolean> {
    window.clearTimeout(saveTimer.current)
    const pending = pendingDraftRef.current
    if (pending) {
      return persistDraftSnapshot(pending, showState)
    }
    if (showState && promptId && current) {
      return persistDraftSnapshot({ promptId, title: current.stem.slice(0, 40), content }, true)
    }
    return false
  }

  function updateDraftContent(nextContent: string): void {
    setContent(nextContent)
    if (!promptId || !current) return
    const snapshot = { promptId, title: current.stem.slice(0, 40), content: nextContent }
    pendingDraftRef.current = snapshot
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void persistDraftSnapshot(snapshot, false)
    }, 1200)
  }

  async function saveDraft(showState = true): Promise<void> {
    const ok = await flushPendingDraft(showState)
    if (ok && showState) {
      showToast('草稿已保存')
    }
  }

  async function switchPrompt(nextId: string): Promise<void> {
    if (!nextId || nextId === promptId || evaluating) return
    await flushPendingDraft(false)
    setPromptId(nextId)
    if (requestedPromptId) {
      setSearchParams({}, { replace: true })
    }
  }

  async function toggleOnlyUnattempted(): Promise<void> {
    if (evaluating) return
    await flushPendingDraft(false)
    setOnlyUnattempted((value) => !value)
  }

  async function selectQualityFilter(nextFilter: ShenlunQualityFilter): Promise<void> {
    if (evaluating || nextFilter === qualityFilter) return
    await flushPendingDraft(false)
    setQualityFilter(nextFilter)
  }

  async function goAdjacent(delta: -1 | 1): Promise<void> {
    if (!visiblePrompts || currentIndex < 0 || evaluating) return
    const target = visiblePrompts[currentIndex + delta]
    if (target) await switchPrompt(target.id)
  }

  async function evaluate(): Promise<void> {
    if (!current || evaluating) return
    const targetPromptId = current.id
    const targetTitle = current.stem.slice(0, 40)
    const targetContent = content
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setEvaluating(true)
    setStreamEvalRaw('')
    setError('')
    const unsubscribe = subscribeAiStream(requestId, (accumulated) => {
      if (activePromptIdRef.current === targetPromptId) {
        setStreamEvalRaw(accumulated)
      }
    })
    evalStreamCancelRef.current = () => {
      void cancelAiStream(requestId)
    }
    try {
      await flushPendingDraft(false)
      await persistDraftSnapshot(
        { promptId: targetPromptId, title: targetTitle, content: targetContent },
        false
      )
      const result = await invoke<ConstructedEvaluation>({
        method: 'constructed.evaluate',
        params: {
          promptId: targetPromptId,
          title: targetTitle,
          content: targetContent,
          requestId
        }
      })
      const [history] = await Promise.all([
        activePromptIdRef.current === targetPromptId
          ? invoke<ConstructedAttemptRecord[]>({
              method: 'constructed.history',
              params: { promptId: targetPromptId, limit: 50 }
            }).catch(() => [] as ConstructedAttemptRecord[])
          : Promise.resolve(null),
        refreshAllHistory()
      ])
      if (activePromptIdRef.current === targetPromptId) {
        setEvaluation(result)
        setSelectedHistoryId(result.id)
        if (history) setPromptHistory(history)
      }
    } catch (cause) {
      if (activePromptIdRef.current === targetPromptId) {
        const msg = cause instanceof Error ? cause.message : '评估失败'
        if (msg.includes('已停止')) {
          showToast('已停止本次 AI 批改')
        } else {
          setError(msg)
        }
      }
    } finally {
      unsubscribe()
      evalStreamCancelRef.current = null
      setStreamEvalRaw('')
      setEvaluating(false)
    }
  }

  function loadHistoryDraft(record: ConstructedAttemptRecord): void {
    if (evaluating || record.promptId !== promptId) return
    updateDraftContent(record.content)
    setEvaluation(record.evaluation)
    setSelectedHistoryId(record.id)
    setView('write')
  }

  function resetAllFilters(): void {
    setRegion('')
    writeStoredRegion('tizhou:shenlun-region', '')
    search.clear()
    setShenlunType('')
    setQualityFilter('all')
    setOnlyUnattempted(false)
  }

  const currentQuality = useMemo(() => {
    if (current) {
      return inspectShenlunMaterialQuality(current.material, { explanation: current.explanation })
    }
    if (currentSummary?.materialQuality) {
      return {
        level: currentSummary.materialQuality,
        issues: currentSummary.materialIssues ?? [],
        hasReferenceAnswer: Boolean(currentSummary.hasReferenceAnswer)
      }
    }
    return null
  }, [current, currentSummary])

  if (prompts === undefined)
    return (
      <div className="page">
        <PageHeader title="申论作答" />
        <LoadingState />
      </div>
    )
  if (
    hasAnyPrompts === false &&
    !loadingPrompts &&
    !region &&
    !activeQuery &&
    !appliedFilter.region &&
    !appliedFilter.query
  )
    return (
      <div className="page">
        <PageHeader title="申论作答" />
        <EmptyState
          title="知识库中没有申论主观题"
          description="导入 type: essay 且 subject: shenlun 的 Markdown 题目后即可开始。"
        />
      </div>
    )

  const hasPrev = currentIndex > 0
  const hasNext = currentIndex >= 0 && currentIndex < totalVisible - 1
  const currentStatus = current ? statusByPrompt.get(current.id) : undefined
  const appliedConditionParts = [
    appliedFilter.region ? `地区：${appliedFilter.region}` : '',
    appliedFilter.query ? `关键词：${appliedFilter.query}` : ''
  ].filter(Boolean)

  return (
    <div className="page page-solution">
      <PageHeader
        eyebrow="提升 · 申论作答"
        title="申论作答"
        description="草稿在本机自动保存。未配置 AI 时使用透明的本地规则评分，配置后自动尝试语义评估。"
        actions={
          <>
            <Button
              icon={<FloppyDiskIcon />}
              disabled={saving || !current}
              onClick={() => void saveDraft()}
            >
              {saving ? '保存中' : '保存草稿'}
            </Button>
            {evaluating ? (
              <Button
                appearance="secondary"
                icon={<StopIcon weight="fill" />}
                onClick={() => evalStreamCancelRef.current?.()}
              >
                停止批改
              </Button>
            ) : (
              <Button
                appearance="primary"
                icon={<SparkleIcon />}
                disabled={!current}
                onClick={() => void evaluate()}
              >
                提交评估
              </Button>
            )}
          </>
        }
      />
      {error && <ErrorState message={error} />}
      {evaluating &&
        (() => {
          const streamPreview = extractShenlunStreamPreview(streamEvalRaw)
          return (
            <Section className="shenlun-stream-card">
              <div className="shenlun-stream-head">
                <div className="button-row">
                  <Spinner size="tiny" label="正在评估答案（AI 实时批改）" />
                  {streamPreview.chars > 0 && (
                    <span className="pill">已接收 {streamPreview.chars} 字</span>
                  )}
                  {streamPreview.score !== undefined && (
                    <span className="pill">暂估得分 {streamPreview.score}</span>
                  )}
                </div>
                <Button
                  size="small"
                  appearance="secondary"
                  icon={<StopIcon weight="fill" />}
                  onClick={() => evalStreamCancelRef.current?.()}
                >
                  停止生成
                </Button>
              </div>
              {streamPreview.snippet && (
                <div className="shenlun-stream-preview">
                  <span>{streamPreview.snippet}</span>
                  <span className="ai-stream-cursor" aria-hidden="true" />
                </div>
              )}
            </Section>
          )
        })()}
      <Section>
        <ShenlunFilterBar
          regions={regions}
          regionCounts={regionCounts}
          region={region}
          promptId={promptId}
          promptsCount={prompts.length}
          qualityFilteredCount={qualityFilteredPrompts?.length}
          visiblePrompts={visiblePrompts ?? []}
          statusByPrompt={statusByPrompt}
          search={search}
          shenlunType={shenlunType}
          typeCounts={typeCounts}
          qualityFilter={qualityFilter}
          qualityCounts={qualityCounts}
          evaluating={evaluating}
          onRegionOrPromptChange={(nextRegion, nextPromptId) => {
            if (nextRegion !== region) {
              setRegion(nextRegion)
              writeStoredRegion('tizhou:shenlun-region', nextRegion)
            }
            if (nextPromptId) void switchPrompt(nextPromptId)
          }}
          onSelectPrompt={(id) => void switchPrompt(id)}
          onSelectType={setShenlunType}
          onSelectQualityFilter={(filter) => void selectQualityFilter(filter)}
        />
        {prompts.length === 0 ? (
          loadingPrompts ? (
            <LoadingState label="正在检索申论题目" />
          ) : (
            <EmptyState
              title="当前筛选下没有匹配的申论题目"
              description={
                appliedConditionParts.length > 0
                  ? `当前条件（${appliedConditionParts.join('，')}）暂无题目，可直接修改上方关键词或清除筛选查看全部申论真题。`
                  : '当前筛选下暂无题目，可清除筛选查看全部申论真题。'
              }
              actionLabel="查看全部题目"
              onAction={resetAllFilters}
            />
          )
        ) : totalVisible === 0 ? (
          (qualityFilteredPrompts?.length ?? 0) === 0 ? (
            <EmptyState
              title={
                qualityFilter === 'verified'
                  ? '当前条件下暂无「精校带解析」题目'
                  : '当前条件下暂无非残缺题目'
              }
              description="可切换回「全部材料」查看该考区或关键词下的全部申论真题。"
              actionLabel="显示全部材料"
              onAction={() => void selectQualityFilter('all')}
            />
          ) : shenlunType && typeCounts[shenlunType] === 0 ? (
            <EmptyState
              title={`当前筛选下暂无「${shenlunType}」`}
              description="可切换其他题型标签，或查看全部题型。"
              actionLabel="查看全部题型"
              onAction={() => setShenlunType('')}
            />
          ) : (
            <EmptyState
              title="当前筛选下已全部做完"
              description="所有匹配题目均已有评估记录，可切换「显示全部题目」继续二刷精进。"
              actionLabel="显示全部题目"
              onAction={() => void toggleOnlyUnattempted()}
            />
          )
        ) : loadedPromptId !== promptId ? (
          <LoadingState label="正在读取题目与草稿" />
        ) : (
          <>
            <ShenlunNavBar
              current={current}
              currentSummary={currentSummary}
              currentQuality={currentQuality}
              currentStatus={currentStatus}
              activeQuestionType={activeQuestionType}
              elapsedSeconds={elapsedSeconds}
              showTimer={showTimer}
              reading={reading}
              officialTypography={officialTypography}
              onlyUnattempted={onlyUnattempted}
              evaluating={evaluating}
              hasPrev={hasPrev}
              hasNext={hasNext}
              currentIndex={currentIndex}
              totalVisible={totalVisible}
              zenMode={zenMode}
              canEdit={Boolean(!vault?.isBuiltin && current?.filePath)}
              snippetOpen={snippetOpen}
              onToggleTimer={() => setShowTimer((prev) => !prev)}
              onToggleOfficialTypography={() => setOfficialTypography((value) => !value)}
              onToggleOnlyUnattempted={() => void toggleOnlyUnattempted()}
              onToggleZenMode={toggleZenMode}
              onToggleSnippets={() => setSnippetOpen((prev) => !prev)}
              onOpenEdit={() => setEditOpen(true)}
              onGoAdjacent={(delta) => void goAdjacent(delta)}
            />
            <div
              ref={reading.surfaceRef}
              className={`essay-columns question-reading-surface${officialTypography ? ' is-official-doc' : ''}`}
              data-reading-font={reading.typography.font}
              style={reading.surfaceStyle}
            >
              <div className="essay-col">
                {current && currentQuality?.level === 'incomplete' && (
                  <div className="shenlun-quality-banner" role="note">
                    该题材料来自上游 PDF 抽取，检测到可能存在残缺（
                    {currentQuality.issues.join('、')}
                    ），作答与 AI 批改时请注意核对原卷。
                  </div>
                )}
                {current?.material &&
                  (() => {
                    const blocks = splitShenlunMaterialBlocks(current.material)
                    const recSet =
                      blocks.length >= 2
                        ? new Set(
                            recommendShenlunMaterialIndices(
                              blocks,
                              current.stem,
                              current.explanation,
                              classifyShenlunType(current.category, current.stem)
                            )
                          )
                        : new Set<number>()
                    const activeBlock =
                      typeof materialTab === 'number' && blocks[materialTab]
                        ? blocks[materialTab]!
                        : null
                    const displayedMaterial = formatShenlunMaterialParagraphs(
                      activeBlock ? activeBlock.raw : current.material
                    )
                    return (
                      <HighlightableMaterial
                        promptId={
                          materialTab === 'all' ? current.id : `${current.id}#blk-${materialTab}`
                        }
                        content={displayedMaterial}
                        sourceFilePath={current.filePath}
                        onExtract={handleExtractToDraft}
                        headerLeft={
                          blocks.length >= 2 ? (
                            <div className="essay-material-head">
                              <h3>给定资料</h3>
                              <div
                                className="essay-material-tabs"
                                role="tablist"
                                aria-label="材料分段"
                              >
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={materialTab === 'all'}
                                  className={`essay-material-tab${materialTab === 'all' ? ' is-active' : ''}`}
                                  onClick={() => setMaterialTab('all')}
                                >
                                  全部 ({blocks.length})
                                </button>
                                {blocks.map((block, idx) => (
                                  <button
                                    key={`${block.title}-${idx}`}
                                    type="button"
                                    role="tab"
                                    aria-selected={materialTab === idx}
                                    className={`essay-material-tab${materialTab === idx ? ' is-active' : ''}`}
                                    onClick={() => setMaterialTab(idx)}
                                  >
                                    {block.title}
                                    {recSet.has(idx) && (
                                      <span className="essay-material-badge">相关</span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <h3>给定资料</h3>
                          )
                        }
                      />
                    )
                  })()}
                <div className="essay-stem-card">
                  <div className="essay-stem-label">作答要求</div>
                  <MarkdownContent
                    className="question-stem"
                    content={current?.stem ?? ''}
                    sourceFilePath={current?.filePath}
                  />
                </div>
              </div>
              <div className="essay-col">
                <div className="solution-tabs-bar">
                  <TabList
                    className="solution-tabs"
                    selectedValue={view}
                    onTabSelect={(_, data) =>
                      setView(data.value as 'write' | 'reference' | 'history')
                    }
                  >
                    <Tab value="write">我的作答</Tab>
                    <Tab value="reference">参考解析</Tab>
                    <Tab value="history">历史记录 ({promptHistory.length})</Tab>
                  </TabList>
                  {view === 'write' && (
                    <div className="sheet-mode-switch" role="group" aria-label="作答模式">
                      <button
                        type="button"
                        className={`sheet-mode-btn${sheetMode === 'sheet' ? ' is-active' : ''}`}
                        onClick={() => setSheetMode('sheet')}
                      >
                        答题卡
                      </button>
                      <button
                        type="button"
                        className={`sheet-mode-btn${sheetMode === 'plain' ? ' is-active' : ''}`}
                        onClick={() => setSheetMode('plain')}
                      >
                        自由框
                      </button>
                    </div>
                  )}
                </div>
                {view === 'write' ? (
                  sheetMode === 'sheet' ? (
                    <ShenlunAnswerSheet
                      value={content}
                      onChange={updateDraftContent}
                      limit={currentLimit}
                      headerTitle={
                        currentIndex >= 0
                          ? `第 ${currentIndex + 1} 题 · ${activeQuestionType}`
                          : activeQuestionType
                      }
                      officialTypography={officialTypography}
                    />
                  ) : (
                    <div className="essay-editor-wrap">
                      <textarea
                        className="essay-editor"
                        data-testid="shenlun-draft-input"
                        aria-label="申论作答草稿"
                        value={content}
                        onChange={(event) => updateDraftContent(event.target.value)}
                        placeholder="建议先列要点，再组织成完整答案。草稿会在停止输入后自动保存。"
                      />
                      {(() => {
                        const wordCount = content.replace(/\s/g, '').length
                        const limit = currentLimit
                        const overLimit = Boolean(limit?.max && wordCount > limit.max)
                        const underLimit = Boolean(
                          limit?.min && wordCount > 0 && wordCount < limit.min
                        )
                        return (
                          <span
                            className={`essay-word-counter${overLimit ? ' is-over-limit' : underLimit ? ' is-under-limit' : ''}`}
                            title={limit ? `已识别题干字数要求：${limit.label}` : undefined}
                          >
                            {limit ? `${wordCount} / ${limit.label}` : `${wordCount} 字`}
                          </span>
                        )
                      })()}
                    </div>
                  )
                ) : view === 'reference' ? (
                  <div className="answer-panel">
                    <h3>参考要点</h3>
                    <p>{current?.answer.join('；')}</p>
                    <MarkdownContent
                      content={current?.explanation ?? ''}
                      sourceFilePath={current?.filePath}
                    />
                    {current && (
                      <ShenlunPointChecklist
                        promptId={current.id}
                        title={current.stem.slice(0, 60)}
                        answer={current.answer}
                        explanation={current.explanation}
                        draftContent={content}
                        onSaved={(saved) => {
                          setPromptHistory((prev) => [
                            saved,
                            ...prev.filter((item) => item.id !== saved.id)
                          ])
                          setEvaluation(saved.evaluation)
                          setSelectedHistoryId(saved.id)
                          void refreshAllHistory()
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <ShenlunHistoryPanel
                    promptHistory={promptHistory}
                    selectedHistoryId={selectedHistoryId}
                    expandedHistoryIds={expandedHistoryIds}
                    evaluating={evaluating}
                    onSelectEvaluation={(record) => {
                      setEvaluation(record.evaluation)
                      setSelectedHistoryId(record.id)
                    }}
                    onLoadDraft={loadHistoryDraft}
                    onToggleExpand={(recordId) =>
                      setExpandedHistoryIds((prev) => ({
                        ...prev,
                        [recordId]: !prev[recordId]
                      }))
                    }
                  />
                )}
              </div>
            </div>
          </>
        )}
      </Section>
      {current && evaluation && (
        <ShenlunEvaluationPanel
          evaluation={evaluation}
          evaluating={evaluating}
          onRetryEvaluate={() => void evaluate()}
        />
      )}
      <QuestionEditDialog
        question={current ?? null}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={(updated) => {
          questionCacheRef.current.set(updated.id, updated)
          setCurrentDetail(updated)
          const quality = inspectShenlunMaterialQuality(updated.material, {
            explanation: updated.explanation
          })
          setPrompts((prev) =>
            prev?.map((item) =>
              item.id === updated.id
                ? {
                    ...item,
                    category: updated.category,
                    difficulty: updated.difficulty,
                    stemPreview: updated.stem.slice(0, 120),
                    hasReferenceAnswer: quality.hasReferenceAnswer,
                    materialQuality: quality.level,
                    materialIssues: quality.issues
                  }
                : item
            )
          )
          if (
            typeof materialTab === 'number' &&
            splitShenlunMaterialBlocks(updated.material ?? '').length <= materialTab
          ) {
            setMaterialTab('all')
          }
          void refreshVault()
          showToast('勘误已保存并重新索引')
        }}
      />
      <ShenlunSnippetDrawer
        open={snippetOpen}
        onClose={() => setSnippetOpen(false)}
        onInsert={(text) => {
          if (!current) return
          updateDraftContent(`${content}${content.trim() ? '\n' : ''}${text}`)
          setView('write')
        }}
      />
    </div>
  )
}
