import { useEffect, useMemo, useState } from 'react'
import { Button, Switch } from '@fluentui/react-components'
import { FolderOpenIcon, SparkleIcon } from '@phosphor-icons/react'
import { matchesSearchTerms } from '@shared/search'
import type {
  BatchReviewResult,
  KnowledgeArtifactDetail,
  KnowledgeArtifactSummary,
  KnowledgeBuildJob,
  KnowledgeBuildMode,
  KnowledgeBuildQuality,
  KnowledgeEngineStatus,
  KnowledgeSourceScan,
  Subject,
  VaultIndexResult,
  VlmConfigView,
  VlmProofreadSuggestion
} from '@shared/contracts'
import { invoke } from '../../api'
import { ConfirmDialog, ErrorState, LoadingState, PageHeader } from '../../components/ui'
import { useImeSearchInput } from '../../services/search-input'
import { useAppStore } from '../../store'
import { ArtifactReviewPanel, type ArtifactFilterStatus } from './ArtifactReviewPanel'
import { BuildStrategyCard } from './BuildStrategyCard'
import { EngineStatusCard } from './EngineStatusCard'
import { RUNNING_STATES, type SourcePreviewState } from './helpers'
import { JobProgressCard } from './JobProgressCard'
import { SourcePreviewDialog } from './SourcePreviewDialog'
import { SourceScanCard } from './SourceScanCard'

export function KnowledgeBuilderPage(): React.JSX.Element {
  const initialize = useAppStore((state) => state.initialize)
  const showToast = useAppStore((state) => state.showToast)
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'clearCacheAll' }
    | { kind: 'revertImport' }
    | { kind: 'reviewAll'; status: 'approved' | 'rejected'; count: number }
    | { kind: 'cancelJob' }
    | null
  >(null)
  const [engine, setEngine] = useState<KnowledgeEngineStatus>()
  const [scan, setScan] = useState<KnowledgeSourceScan>()
  const [sourcePath, setSourcePath] = useState('')
  const search = useImeSearchInput({ delayMs: 0 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<KnowledgeBuildMode>('direct')
  const [quality, setQuality] = useState<KnowledgeBuildQuality>('high')
  const [subject, setSubject] = useState<Subject | 'common' | 'auto'>('auto')
  const [tags, setTags] = useState('')
  const [instruction, setInstruction] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  // 缓存管理：忽略缓存重转的批次选项 + 缓存统计/清空
  const [ignoreCache, setIgnoreCache] = useState(false)
  // 任务级 VLM 批量预精校（需总开关已开启才可见）
  const [enableVlmProofread, setEnableVlmProofread] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<{
    entries: Array<{ sourceName: string }>
    totalBytes: number
  }>()
  const [job, setJob] = useState<KnowledgeBuildJob>()
  const [artifact, setArtifact] = useState<KnowledgeArtifactDetail>()
  const [busy, setBusy] = useState('')
  // 能力边界产物的人工确认：勾选「我已查看原始页面并确认内容正确」后解除发布限制
  const [humanConfirmed, setHumanConfirmed] = useState(false)
  // 来源页预览：证据图片经受控 IPC 获取（dataUrl），不接触本地路径
  const [preview, setPreview] = useState<SourcePreviewState | undefined>()
  const [previewImage, setPreviewImage] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewZoom, setPreviewZoom] = useState(1)
  const [filterStatus, setFilterStatus] = useState<ArtifactFilterStatus>('all')
  const [reviewPage, setReviewPage] = useState(0)
  const PAGE_SIZE = 50
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  // VLM 按页精校（可选，默认关闭）：开关状态 + 精校建议 + 正文编辑器
  const [vlmConfig, setVlmConfig] = useState<VlmConfigView>()
  const [vlmSuggestion, setVlmSuggestion] = useState<VlmProofreadSuggestion>()
  const [editorContent, setEditorContent] = useState('')
  const [editorMode, setEditorMode] = useState<'closed' | 'manual' | 'vlm'>('closed')

  const visibleFiles = useMemo(() => {
    if (!scan) return []
    const keyword = search.committedValue.trim()
    return scan.files.filter((file) => !keyword || matchesSearchTerms(file.relativePath, keyword))
  }, [search.committedValue, scan])

  const visibleEligible = visibleFiles.filter((file) => file.eligible)
  const selectedSize = scan?.files
    .filter((file) => selected.has(file.id))
    .reduce((total, file) => total + file.size, 0)

  useEffect(() => {
    void refreshCacheStats()
  }, [])

  useEffect(() => {
    void Promise.all([
      invoke<KnowledgeEngineStatus>({ method: 'knowledgeBuilder.engine.status' }),
      invoke<KnowledgeBuildJob | undefined>({ method: 'knowledgeBuilder.job.latest' }),
      invoke<VlmConfigView>({ method: 'ai.vlmConfig.get' })
    ])
      .then(([engineStatus, latest, vlm]) => {
        setEngine(engineStatus)
        setJob(latest)
        setVlmConfig(vlm)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '知识库工坊初始化失败'))
  }, [])

  // 任务进入审核状态时，自动选中第一条待审核产物
  useEffect(() => {
    if (!job || job.status !== 'review' || artifact) return
    const first = job.artifacts.find((item) => item.status === 'pending')
    if (first) void openArtifact(first.id)
  }, [job?.status])

  useEffect(() => {
    if (!job || !RUNNING_STATES.has(job.status)) return
    const timer = window.setInterval(() => {
      void invoke<KnowledgeBuildJob>({
        method: 'knowledgeBuilder.job.get',
        params: { id: job.id }
      })
        .then(setJob)
        .catch((cause) => setError(cause instanceof Error ? cause.message : '任务状态读取失败'))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.status])

  async function installEngine(): Promise<void> {
    setBusy('engine')
    setError('')
    const poll = window.setInterval(() => {
      void invoke<KnowledgeEngineStatus>({ method: 'knowledgeBuilder.engine.status' })
        .then(setEngine)
        .catch(() => undefined)
    }, 1200)
    try {
      setEngine(await invoke({ method: 'knowledgeBuilder.engine.install' }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '转换引擎安装失败')
    } finally {
      window.clearInterval(poll)
      setBusy('')
    }
  }

  async function toggleGpuAccelerator(): Promise<void> {
    if (!engine) return
    const removing = engine.ocrAccelerator === 'dml'
    setBusy('gpu')
    setError('')
    const poll = window.setInterval(() => {
      void invoke<KnowledgeEngineStatus>({ method: 'knowledgeBuilder.engine.status' })
        .then(setEngine)
        .catch(() => undefined)
    }, 1200)
    try {
      setEngine(
        await invoke<KnowledgeEngineStatus>({
          method: removing
            ? 'knowledgeBuilder.engine.gpu.remove'
            : 'knowledgeBuilder.engine.gpu.install'
        })
      )
      setMessage(
        removing
          ? '已恢复 CPU 推理后端，GPU 加速组件已移除。'
          : 'GPU 加速已启用，扫描式 PDF 的识别速度将显著提升。'
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'GPU 加速组件操作失败')
      void invoke<KnowledgeEngineStatus>({ method: 'knowledgeBuilder.engine.status' })
        .then(setEngine)
        .catch(() => undefined)
    } finally {
      window.clearInterval(poll)
      setBusy('')
    }
  }

  async function setMirror(mirrorId: string): Promise<void> {
    if (!engine) return
    setBusy('mirror')
    setError('')
    try {
      setEngine(
        await invoke<KnowledgeEngineStatus>({
          method: 'knowledgeBuilder.engine.mirror.set',
          params: { id: mirrorId }
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安装源设置失败')
    } finally {
      setBusy('')
    }
  }

  async function chooseSource(): Promise<void> {
    setError('')
    const path = await invoke<string | undefined>({ method: 'knowledgeBuilder.source.choose' })
    if (!path) return
    setSourcePath(path)
    await scanSource(path)
  }

  async function scanSource(path = sourcePath): Promise<void> {
    if (!path.trim()) return
    setBusy('scan')
    setError('')
    try {
      const result = await invoke<KnowledgeSourceScan>({
        method: 'knowledgeBuilder.source.scan',
        params: { path: path.trim() }
      })
      setSourcePath(result.sourcePath)
      setScan(result)
      setSelected(new Set())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '原料扫描失败')
    } finally {
      setBusy('')
    }
  }

  function toggleFile(id: string, checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function refreshCacheStats(): Promise<void> {
    try {
      setCacheInfo(
        await invoke<{ entries: Array<{ sourceName: string }>; totalBytes: number }>({
          method: 'knowledgeBuilder.cache.stats'
        })
      )
    } catch {
      // 缓存统计失败不影响页面使用
    }
  }

  function clearCacheAll(): void {
    setConfirmAction({ kind: 'clearCacheAll' })
  }

  async function performClearCacheAll(): Promise<void> {
    setConfirmAction(null)
    try {
      const removed = await invoke<{ removed: number }>({
        method: 'knowledgeBuilder.cache.clear',
        params: {}
      })
      showToast(`已清空 ${removed.removed} 条转换缓存。`)
      await refreshCacheStats()
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : '清空缓存失败'
      setError(msg)
      showToast(msg)
    }
  }

  async function clearCacheFor(sourceName: string): Promise<void> {
    try {
      const removed = await invoke<{ removed: number }>({
        method: 'knowledgeBuilder.cache.clear',
        params: { sourceName }
      })
      showToast(
        removed.removed > 0
          ? `已清除「${sourceName}」的 ${removed.removed} 条转换缓存，重新导入时将重新转换。`
          : `「${sourceName}」没有可清除的转换缓存。`
      )
      await refreshCacheStats()
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : '清除缓存失败'
      setError(msg)
      showToast(msg)
    }
  }

  async function startJob(): Promise<void> {
    if (!scan) return
    setBusy('start')
    setError('')
    setArtifact(undefined)
    try {
      const created = await invoke<KnowledgeBuildJob>({
        method: 'knowledgeBuilder.job.start',
        params: {
          sourcePath: scan.sourcePath,
          fileIds: [...selected],
          options: {
            mode,
            quality,
            subject,
            tags: tags
              .split(/[,，;；\n]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            instruction,
            rightsConfirmed,
            ignoreConversionCache: ignoreCache,
            enableVlmProofread: enableVlmProofread && vlmConfig?.enabled === true
          }
        }
      })
      setJob(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务启动失败')
    } finally {
      setBusy('')
    }
  }

  async function cancelJob(): Promise<void> {
    if (!job) return
    setError('')
    try {
      setJob(await invoke({ method: 'knowledgeBuilder.job.cancel', params: { id: job.id } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务停止失败')
    }
  }

  async function retryJob(): Promise<void> {
    if (!job) return
    setBusy('retry')
    setError('')
    try {
      setJob(await invoke({ method: 'knowledgeBuilder.job.retry', params: { id: job.id } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '失败文件重试失败')
    } finally {
      setBusy('')
    }
  }

  // 预览当前页：经 IPC 取 dataUrl；缺 assetId/IPC 失败显示明确错误（不空白）
  useEffect(() => {
    if (!preview) return
    const entry = preview.entries[preview.index]
    setPreviewImage('')
    setPreviewError('')
    setPreviewZoom(1)
    if (!entry) return
    if (!entry.evidenceAssetId) {
      setPreviewError('证据图片不可用（该页未渲染预览，可对照原 PDF 核对）')
      return
    }
    let cancelled = false
    void invoke<string>({
      method: 'knowledgeBuilder.evidence.get',
      params: { jobId: preview.jobId, assetId: entry.evidenceAssetId }
    })
      .then((dataUrl) => {
        if (!cancelled) {
          if (dataUrl && dataUrl.startsWith('data:image/')) setPreviewImage(dataUrl)
          else setPreviewError('证据图片数据为空，请重新导入生成证据')
        }
      })
      .catch((cause) => {
        if (!cancelled) setPreviewError(cause instanceof Error ? cause.message : '证据图片读取失败')
      })
    return () => {
      cancelled = true
    }
  }, [preview])

  function openSourcePreview(evidence: KnowledgeArtifactSummary['sourceEvidence']): void {
    if (!job || !evidence || evidence.status === 'unavailable') return
    const entries = evidence.references.flatMap((reference) =>
      reference.pages.map((page) => ({
        label:
          reference.role === 'material'
            ? '材料'
            : reference.role === 'solution'
              ? '解析'
              : reference.role === 'preserved-page'
                ? '保留页'
                : '题本',
        pageNumber: page.pageNumber,
        mapping: page.mapping,
        evidenceAssetId: page.evidenceAssetId
      }))
    )
    if (entries.length === 0) return
    // 资料分析优先展示材料页（材料 role 排前）
    entries.sort((a, b) => (a.label === '材料' ? -1 : b.label === '材料' ? 1 : 0))
    setPreview({ jobId: job.id, entries, index: 0 })
  }

  async function openArtifact(id: string): Promise<void> {
    if (!job) return
    setBusy('artifact')
    setError('')
    setHumanConfirmed(false)
    setVlmSuggestion(undefined)
    setEditorMode('closed')
    setEditorContent('')
    try {
      setArtifact(
        await invoke({
          method: 'knowledgeBuilder.artifact.get',
          params: { jobId: job.id, artifactId: id }
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '产物读取失败')
    } finally {
      setBusy('')
    }
  }

  /** 切换工坊 VLM 总开关：关闭即 100% 本地离线，不发送任何图片 */
  async function toggleVlmEnabled(checked: boolean): Promise<void> {
    if (!vlmConfig) return
    setError('')
    try {
      setVlmConfig(
        await invoke<VlmConfigView>({
          method: 'ai.vlmConfig.save',
          params: { enabled: checked, mode: vlmConfig.mode }
        })
      )
      setMessage(
        checked
          ? 'VLM 按页精校已开启：仅把触发精校的 PDF 页面图片发送到你配置的模型服务。'
          : 'VLM 按页精校已关闭：知识工坊保持 100% 本地离线。'
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '开关保存失败')
    }
  }

  /** 单产物按页精校：调主进程渲染关联来源页高清图并请求视觉模型，返回建议不落盘 */
  async function runVlmProofread(): Promise<void> {
    if (!job || !artifact) return
    setBusy('vlm')
    setError('')
    try {
      const suggestion = await invoke<VlmProofreadSuggestion>({
        method: 'knowledgeBuilder.artifact.vlmProofread',
        params: { jobId: job.id, artifactId: artifact.id }
      })
      setVlmSuggestion(suggestion)
      setEditorContent(suggestion.correctedMarkdown)
      setEditorMode('vlm')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'VLM 精校失败')
    } finally {
      setBusy('')
    }
  }

  /** 保存正文（人工编辑或采纳 VLM 建议）：服务端强校验 id/answer/options 不可篡改 */
  async function saveMarkdown(origin: 'vlm' | 'manual'): Promise<void> {
    if (!job || !artifact || !editorContent.trim()) return
    setBusy('save')
    setError('')
    try {
      const updated = await invoke<KnowledgeArtifactDetail>({
        method: 'knowledgeBuilder.artifact.updateMarkdown',
        params: { jobId: job.id, artifactId: artifact.id, markdown: editorContent, origin }
      })
      setArtifact(updated)
      const refreshed = await invoke<KnowledgeBuildJob>({
        method: 'knowledgeBuilder.job.get',
        params: { id: job.id }
      })
      setJob(refreshed)
      setEditorMode('closed')
      setVlmSuggestion(undefined)
      setMessage(
        origin === 'vlm' ? '已采纳精校结果并保存，仍需人工复核确认后方可发布。' : '正文已保存。'
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '正文保存失败')
    } finally {
      setBusy('')
    }
  }

  async function reviewArtifact(status: 'pending' | 'approved' | 'rejected'): Promise<void> {
    if (!job || !artifact) return
    setBusy('review')
    setError('')
    try {
      const updated = await invoke<KnowledgeBuildJob>({
        method: 'knowledgeBuilder.artifact.review',
        params: {
          jobId: job.id,
          artifactId: artifact.id,
          status,
          confirmHumanReview: status === 'approved' && humanConfirmed
        }
      })
      setJob(updated)
      setArtifact(
        await invoke({
          method: 'knowledgeBuilder.artifact.get',
          params: { jobId: job.id, artifactId: artifact.id }
        })
      )
      if (status === 'pending') setMessage('已恢复为待审核')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审核状态保存失败')
    } finally {
      setBusy('')
    }
  }

  function revertImport(): void {
    if (!job) return
    setConfirmAction({ kind: 'revertImport' })
  }

  async function performRevertImport(): Promise<void> {
    if (!job) return
    setConfirmAction(null)
    setBusy('publish')
    setError('')
    try {
      await invoke({ method: 'knowledgeBuilder.job.revert', params: { id: job.id } })
      await initialize()
      setJob(await invoke({ method: 'knowledgeBuilder.job.get', params: { id: job.id } }))
      setArtifact(undefined)
      showToast('已撤销本次导入并重建索引')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销导入失败')
    } finally {
      setBusy('')
    }
  }

  function reviewAll(status: 'approved' | 'rejected'): void {
    if (!job) return
    const pendingIds = job.artifacts
      .filter((item) => item.status === 'pending')
      .map((item) => item.id)
    if (!pendingIds.length) return
    setConfirmAction({ kind: 'reviewAll', status, count: pendingIds.length })
  }

  async function performReviewAll(status: 'approved' | 'rejected'): Promise<void> {
    if (!job) return
    const action = status === 'approved' ? '批准' : '拒绝'
    setConfirmAction(null)
    setBusy('review')
    setError('')
    setMessage('')
    try {
      const result = await invoke<BatchReviewResult>({
        method: 'knowledgeBuilder.artifacts.reviewMany',
        params: { jobId: job.id, status }
      })
      setJob(result.job)
      // 当前选中项可能被批量处理，重新读取
      if (artifact) {
        try {
          setArtifact(
            await invoke({
              method: 'knowledgeBuilder.artifact.get',
              params: { jobId: job.id, artifactId: artifact.id }
            })
          )
        } catch {
          setArtifact(undefined)
        }
      }
      if (result.failed > 0) {
        setError(
          `已${action} ${result.processed} 项，${result.failed} 项失败${result.errors.length ? `：${result.errors[0]}` : ''}`
        )
      } else {
        setMessage(`已${action} ${result.processed} 项`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `批量${action}失败`)
    } finally {
      setBusy('')
    }
  }

  async function publish(): Promise<void> {
    if (!job) return
    setBusy('publish')
    setError('')
    try {
      const result = await invoke<VaultIndexResult>({
        method: 'knowledgeBuilder.publish',
        params: { jobId: job.id }
      })
      await initialize()
      setJob(await invoke({ method: 'knowledgeBuilder.job.get', params: { id: job.id } }))
      setArtifact(undefined)
      if (result.warnings.length) setError(`发布完成，但有 ${result.warnings.length} 条索引提示`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库发布失败')
    } finally {
      setBusy('')
    }
  }

  async function openOutput(): Promise<void> {
    if (!job) return
    try {
      await invoke({ method: 'shell.openPath', params: { path: job.outputPath } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务目录无法打开')
    }
  }

  if (!engine)
    return (
      <div className="page">
        {error ? <ErrorState message={error} /> : <LoadingState label="正在检查知识转换环境" />}
      </div>
    )

  // 审核列表筛选 + 分页
  const filteredArtifacts = (job?.artifacts ?? []).filter((item) => {
    switch (filterStatus) {
      case 'pending':
        return item.status === 'pending'
      case 'approved':
        return item.status === 'approved'
      case 'rejected':
        return item.status === 'rejected'
      case 'warnings':
        return item.warnings.length > 0
      default:
        return true
    }
  })
  const totalPages = Math.max(1, Math.ceil(filteredArtifacts.length / PAGE_SIZE))
  const safePage = Math.min(reviewPage, totalPages - 1)
  const paginatedArtifacts = filteredArtifacts.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE
  )

  return (
    <div className="page knowledge-builder-page">
      <PageHeader
        eyebrow="知识 · 知识库工坊"
        title="把本地资料变成可审核的题库"
        description="原料只读，MarkItDown 负责转换，已配置模型负责提炼和复核。只有人工批准的产物才会进入应用管理知识库。"
        actions={
          <Button appearance="subtle" icon={<FolderOpenIcon />} onClick={() => void chooseSource()}>
            选择目录
          </Button>
        }
      />

      {error && <ErrorState message={error} onRetry={() => setError('')} />}
      {message && (
        <div className="answer-panel" style={{ marginBottom: 10 }}>
          <p className="positive" style={{ margin: 0 }}>
            {message}
          </p>
        </div>
      )}

      <div className="builder-vlm-row" data-testid="builder-vlm-row">
        <SparkleIcon size={18} aria-hidden />
        <Switch
          checked={vlmConfig?.enabled === true}
          onChange={(_, data) => void toggleVlmEnabled(data.checked)}
          label="VLM 按页精校"
          data-testid="workshop-vlm-switch"
        />
        <small className="muted-copy" style={{ flex: 1, minWidth: 220 }}>
          {vlmConfig?.enabled
            ? `已开启 · ${vlmConfig.mode === 'custom' ? `视觉模型 ${vlmConfig.model ?? '未配置'}` : `复用主模型 ${vlmConfig.mainModel ?? ''}`}。仅把触发精校的 PDF 页面图片发送到你配置的模型服务。`
            : '默认关闭，知识工坊保持 100% 本地离线。开启后可将表格/数字异常页发送给视觉模型辅助核对。'}
        </small>
        <Button
          size="small"
          appearance="subtle"
          onClick={() => (window.location.hash = '#/model-settings')}
        >
          模型设置
        </Button>
      </div>

      <EngineStatusCard
        engine={engine}
        busy={busy}
        onToggleGpu={() => void toggleGpuAccelerator()}
        onInstallEngine={() => void installEngine()}
        onMirrorChange={(mirrorId) => void setMirror(mirrorId)}
      />

      <SourceScanCard
        sourcePath={sourcePath}
        scan={scan}
        visibleFiles={visibleFiles}
        visibleEligible={visibleEligible}
        selected={selected}
        selectedSize={selectedSize}
        cacheInfo={cacheInfo}
        busy={busy}
        search={search}
        onSourcePathChange={setSourcePath}
        onChooseSource={() => void chooseSource()}
        onScanSource={() => void scanSource()}
        onClearCacheAll={clearCacheAll}
        onClearCacheFor={(sourceName) => void clearCacheFor(sourceName)}
        onSelectVisibleEligible={() =>
          setSelected(new Set(visibleEligible.slice(0, 500).map((file) => file.id)))
        }
        onClearSelected={() => setSelected(new Set())}
        onToggleFile={toggleFile}
      />

      {scan && (
        <BuildStrategyCard
          mode={mode}
          quality={quality}
          subject={subject}
          tags={tags}
          instruction={instruction}
          rightsConfirmed={rightsConfirmed}
          ignoreCache={ignoreCache}
          enableVlmProofread={enableVlmProofread}
          vlmConfig={vlmConfig}
          engine={engine}
          selectedCount={selected.size}
          busy={busy}
          job={job}
          onModeChange={setMode}
          onQualityChange={setQuality}
          onSubjectChange={setSubject}
          onTagsChange={setTags}
          onInstructionChange={setInstruction}
          onRightsConfirmedChange={setRightsConfirmed}
          onIgnoreCacheChange={setIgnoreCache}
          onEnableVlmProofreadChange={setEnableVlmProofread}
          onStartJob={() => void startJob()}
        />
      )}

      {job && (
        <JobProgressCard
          job={job}
          busy={busy}
          onOpenOutput={() => void openOutput()}
          onRequestCancelJob={() => setConfirmAction({ kind: 'cancelJob' })}
          onRetryJob={() => void retryJob()}
          onReviewAll={(status) => reviewAll(status)}
          onPublish={() => void publish()}
          onRequestRevertImport={() => revertImport()}
        >
          {job.artifacts.length > 0 && (
            <ArtifactReviewPanel
              job={job}
              artifact={artifact}
              filterStatus={filterStatus}
              safePage={safePage}
              totalPages={totalPages}
              filteredArtifacts={filteredArtifacts}
              paginatedArtifacts={paginatedArtifacts}
              busy={busy}
              humanConfirmed={humanConfirmed}
              vlmConfig={vlmConfig}
              vlmSuggestion={vlmSuggestion}
              editorMode={editorMode}
              editorContent={editorContent}
              onFilterStatusChange={(status) => {
                setFilterStatus(status)
                setReviewPage(0)
              }}
              onPageChange={setReviewPage}
              onOpenPreview={openSourcePreview}
              onOpenArtifact={(id) => void openArtifact(id)}
              onReviewArtifact={(status) => void reviewArtifact(status)}
              onHumanConfirmedChange={setHumanConfirmed}
              onRunVlmProofread={() => void runVlmProofread()}
              onStartManualEdit={(markdown) => {
                setEditorContent(markdown)
                setEditorMode('manual')
                setVlmSuggestion(undefined)
              }}
              onEditorContentChange={setEditorContent}
              onSaveMarkdown={(origin) => void saveMarkdown(origin)}
              onCloseEditor={() => {
                setEditorMode('closed')
                setVlmSuggestion(undefined)
              }}
            />
          )}
        </JobProgressCard>
      )}

      <SourcePreviewDialog
        preview={preview}
        previewImage={previewImage}
        previewError={previewError}
        previewZoom={previewZoom}
        onClose={() => setPreview(undefined)}
        onPageChange={(nextIndex) => preview && setPreview({ ...preview, index: nextIndex })}
        onZoomChange={setPreviewZoom}
      />
      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={
          confirmAction?.kind === 'clearCacheAll'
            ? '清空全部转换缓存？'
            : confirmAction?.kind === 'revertImport'
              ? '撤销本次导入？'
              : confirmAction?.kind === 'reviewAll'
                ? `确认${confirmAction.status === 'approved' ? '批准' : '拒绝'}全部待审核产物？`
                : '停止当前转换任务？'
        }
        description={
          confirmAction?.kind === 'clearCacheAll'
            ? '清空后下次导入会重新转换所有文件（OCR 与结构解析耗时与首次相同）。'
            : confirmAction?.kind === 'revertImport'
              ? '将从当前题库删除本次任务发布的全部题目文件并重新索引，不影响其他题目。'
              : confirmAction?.kind === 'reviewAll'
                ? `本次将批量${confirmAction.status === 'approved' ? '批准' : '拒绝'} ${confirmAction.count} 个待审核产物。`
                : '已完成转换的文件会保留在任务目录中。'
        }
        confirmLabel={
          confirmAction?.kind === 'clearCacheAll'
            ? '清空缓存'
            : confirmAction?.kind === 'revertImport'
              ? '撤销导入'
              : confirmAction?.kind === 'reviewAll'
                ? confirmAction.status === 'approved'
                  ? '全部批准'
                  : '全部拒绝'
                : '确认停止'
        }
        danger={
          confirmAction?.kind === 'clearCacheAll' ||
          confirmAction?.kind === 'revertImport' ||
          confirmAction?.kind === 'cancelJob' ||
          (confirmAction?.kind === 'reviewAll' && confirmAction.status === 'rejected')
        }
        busy={Boolean(busy)}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction?.kind === 'clearCacheAll') return performClearCacheAll()
          if (confirmAction?.kind === 'revertImport') return performRevertImport()
          if (confirmAction?.kind === 'reviewAll') return performReviewAll(confirmAction.status)
          if (confirmAction?.kind === 'cancelJob') {
            setConfirmAction(null)
            return cancelJob()
          }
        }}
      />
    </div>
  )
}
