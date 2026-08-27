import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  ProgressBar,
  Select,
  Spinner,
  Textarea
} from '@fluentui/react-components'
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FileMdIcon,
  FolderOpenIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
  WrenchIcon,
  LightningIcon
} from '@phosphor-icons/react'
import { PIP_MIRROR_OPTIONS, pipMirrorLabel } from '@shared/pip-mirrors'
import type {
  BatchReviewResult,
  KnowledgeArtifactDetail,
  KnowledgeArtifactStatus,
  KnowledgeBuildJob,
  KnowledgeBuildMode,
  KnowledgeBuildQuality,
  KnowledgeEngineStatus,
  KnowledgeSourceScan,
  OcrQualityReport,
  Subject,
  VaultIndexResult
} from '@shared/contracts'
import { formatBytes, invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { useAppStore } from '../store'

const RUNNING_STATES = new Set(['queued', 'running', 'cancelling'])

function jobStatusLabel(status: KnowledgeBuildJob['status']): string {
  return {
    queued: '等待启动',
    running: '处理中',
    review: '等待审核',
    completed: '已完成',
    cancelling: '正在停止',
    cancelled: '已取消',
    failed: '任务异常'
  }[status]
}

/** 综合状态+审核数量计算展示状态：全部处理完不再显示"等待审核" */
function getDisplayJobStatus(job: KnowledgeBuildJob): string {
  if (job.status === 'review' && job.pendingArtifacts === 0 && job.artifacts.length > 0) {
    return '本批已处理'
  }
  return jobStatusLabel(job.status)
}

/** OCR 质量摘要：区分文字层页/OCR页/置信度，不与 AI 模型置信度混淆 */
function OcrQualitySummary({ report }: { report: OcrQualityReport }): React.JSX.Element {
  const parts: string[] = []
  if (report.textLayerPages > 0) parts.push(`文字层 ${report.textLayerPages} 页`)
  if (report.ocrPages > 0) parts.push(`OCR ${report.ocrPages} 页`)
  if (report.averageConfidence != null) {
    parts.push(`OCR 置信度 ${(report.averageConfidence * 100).toFixed(0)}%`)
  }
  if (report.emptyPages > 0) parts.push(`${report.emptyPages} 页空白`)
  const lowConfRatio = report.ocrLineCount > 0 ? report.lowConfidenceLines / report.ocrLineCount : 0
  const hasWarning =
    report.warnings.length > 0 ||
    report.emptyPages > 0 ||
    (report.averageConfidence != null && report.averageConfidence < 0.72) ||
    lowConfRatio > 0.2
  const warningTexts = [...new Set(report.warnings)].slice(0, 3).map((w) => w.slice(0, 80))
  const title = report.warnings.length > 3 ? report.warnings.join('\n') : undefined
  return (
    <span className={hasWarning ? 'ocr-quality ocr-quality-warning' : 'ocr-quality'} title={title}>
      {parts.join(' · ')}
      {hasWarning && warningTexts.length === 0 && ' · 识别质量较低，请人工抽查'}
      {warningTexts.length > 0 && (
        <span className="ocr-quality-detail"> · {warningTexts.join('；')}</span>
      )}
    </span>
  )
}

function artifactStatusLabel(status: KnowledgeArtifactStatus): string {
  return {
    pending: '待审核',
    approved: '已批准',
    rejected: '已拒绝',
    published: '已发布'
  }[status]
}

function statusAppearance(
  status: KnowledgeArtifactStatus
): 'filled' | 'outline' | 'tint' | 'ghost' {
  return status === 'approved' || status === 'published'
    ? 'filled'
    : status === 'rejected'
      ? 'outline'
      : 'tint'
}

export function KnowledgeBuilderPage(): React.JSX.Element {
  const initialize = useAppStore((state) => state.initialize)
  const [engine, setEngine] = useState<KnowledgeEngineStatus>()
  const [scan, setScan] = useState<KnowledgeSourceScan>()
  const [sourcePath, setSourcePath] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<KnowledgeBuildMode>('direct')
  const [quality, setQuality] = useState<KnowledgeBuildQuality>('high')
  const [subject, setSubject] = useState<Subject | 'common' | 'auto'>('auto')
  const [tags, setTags] = useState('')
  const [instruction, setInstruction] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [job, setJob] = useState<KnowledgeBuildJob>()
  const [artifact, setArtifact] = useState<KnowledgeArtifactDetail>()
  const [busy, setBusy] = useState('')
  const [filterStatus, setFilterStatus] = useState<
    'all' | 'pending' | 'approved' | 'rejected' | 'warnings'
  >('all')
  const [reviewPage, setReviewPage] = useState(0)
  const PAGE_SIZE = 50
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const visibleFiles = useMemo(() => {
    if (!scan) return []
    const keyword = query.trim().toLowerCase()
    return scan.files.filter(
      (file) => !keyword || file.relativePath.toLowerCase().includes(keyword)
    )
  }, [query, scan])

  const visibleEligible = visibleFiles.filter((file) => file.eligible)
  const selectedSize = scan?.files
    .filter((file) => selected.has(file.id))
    .reduce((total, file) => total + file.size, 0)

  useEffect(() => {
    void Promise.all([
      invoke<KnowledgeEngineStatus>({ method: 'knowledgeBuilder.engine.status' }),
      invoke<KnowledgeBuildJob | undefined>({ method: 'knowledgeBuilder.job.latest' })
    ])
      .then(([engineStatus, latest]) => {
        setEngine(engineStatus)
        setJob(latest)
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
            rightsConfirmed
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

  async function openArtifact(id: string): Promise<void> {
    if (!job) return
    setBusy('artifact')
    setError('')
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

  async function reviewArtifact(status: 'pending' | 'approved' | 'rejected'): Promise<void> {
    if (!job || !artifact) return
    setBusy('review')
    setError('')
    try {
      const updated = await invoke<KnowledgeBuildJob>({
        method: 'knowledgeBuilder.artifact.review',
        params: { jobId: job.id, artifactId: artifact.id, status }
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

  async function revertImport(): Promise<void> {
    if (!job) return
    if (
      !window.confirm(
        '确认撤销本次导入？将从当前题库删除该任务发布的全部题目文件并重新索引（不影响其他题目）。'
      )
    )
      return
    setBusy('publish')
    setError('')
    try {
      await invoke({ method: 'knowledgeBuilder.job.revert', params: { id: job.id } })
      await initialize()
      setJob(await invoke({ method: 'knowledgeBuilder.job.get', params: { id: job.id } }))
      setArtifact(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销导入失败')
    } finally {
      setBusy('')
    }
  }

  async function reviewAll(status: 'approved' | 'rejected'): Promise<void> {
    if (!job) return
    const pendingIds = job.artifacts
      .filter((item) => item.status === 'pending')
      .map((item) => item.id)
    if (!pendingIds.length) return
    const action = status === 'approved' ? '批准' : '拒绝'
    if (!window.confirm(`确认${action}全部 ${pendingIds.length} 个待审核产物？`)) return
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

  if (!engine) return <LoadingState label="正在检查知识转换环境" />

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
        eyebrow="知识库工坊"
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

      <Section
        title="转换环境"
        description="使用独立 Python 环境，不改动系统 Python，也不会把 API Key 交给转换进程。"
        actions={
          <>
            {engine.available && engine.ocrAvailable && busy !== 'engine' && (
              <Button
                appearance={engine.ocrAccelerator === 'dml' ? 'subtle' : 'primary'}
                icon={<LightningIcon />}
                disabled={busy === 'gpu'}
                onClick={() => void toggleGpuAccelerator()}
              >
                {busy === 'gpu'
                  ? engine.ocrAccelerator === 'dml'
                    ? '正在移除'
                    : '正在启用'
                  : engine.ocrAccelerator === 'dml'
                    ? '移除 GPU 加速'
                    : '启用 GPU 加速'}
              </Button>
            )}
            {(!engine.available || !engine.ocrAvailable) && (
              <Button
                appearance="primary"
                icon={<WrenchIcon />}
                disabled={busy === 'engine'}
                onClick={() => void installEngine()}
              >
                {busy === 'engine'
                  ? '正在安装'
                  : engine.available
                    ? '补装 OCR 组件'
                    : '安装转换引擎'}
              </Button>
            )}
          </>
        }
      >
        <div className="builder-engine-row">
          <div className={`engine-state ${engine.available ? 'ready' : 'missing'}`}>
            {engine.available ? <CheckCircleIcon size={22} /> : <WrenchIcon size={22} />}
            <div>
              <strong>{engine.message}</strong>
              <small>
                {engine.pythonPath ??
                  '需要本机已有 Python 3.10 或更高版本，安装内容位于应用数据目录'}
              </small>
              <small>
                OCR 组件（扫描件识别）：
                {engine.ocrAvailable ? '已就绪' : '未安装，补装后可自动识别扫描式 PDF'}
              </small>
              {engine.available && engine.ocrAvailable && (
                <small>
                  GPU 加速（扫描识别提速，可选）：
                  {engine.ocrAccelerator === 'dml'
                    ? `已启用 DirectML${engine.gpuAdapterName ? ` · ${engine.gpuAdapterName}` : ''}`
                    : engine.gpuAdapterName
                      ? `未启用 · 检测到 ${engine.gpuAdapterName}，启用后扫描识别约提速 2-3 倍`
                      : '未启用 · 未检测到独立显卡，当前使用 CPU 推理'}
                </small>
              )}
            </div>
          </div>
          {(busy === 'engine' || busy === 'gpu') && (
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              <ProgressBar
                value={engine.installProgress ? engine.installProgress.percent / 100 : undefined}
              />
              <small className="muted-copy">
                {engine.installProgress
                  ? `${engine.installProgress.phase}… ${engine.installProgress.percent}%`
                  : '正在准备安装…'}
              </small>
            </div>
          )}
          <div className="builder-mirror-row" style={{ marginTop: 14 }}>
            <Field label="组件安装源" style={{ maxWidth: 320 }}>
              <Select
                value={engine.pipMirrorId ?? 'auto'}
                disabled={busy !== ''}
                onChange={(_, data) => void setMirror(data.value)}
              >
                {PIP_MIRROR_OPTIONS.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <small className="muted-copy">
              作用于转换组件的安装、补装与修复，不会改动系统 pip 配置。
              {engine.pipMirrorId === 'auto'
                ? '自动模式在每次安装开始时对官方源与国内镜像测速，选最快的国内源。'
                : `当前钉死：${pipMirrorLabel(engine.pipMirrorId)}。`}
            </small>
          </div>
        </div>
      </Section>

      <Section
        title="原料批次"
        description="建议先选 1-3 个代表性文件验证质量和费用，再逐步扩大批次。图表密集型内容（如资料分析统计表）OCR 可能还原失真，发布前请重点核对材料数字。"
      >
        <div className="builder-source-row">
          <Field label="原料目录">
            <Input
              value={sourcePath}
              onChange={(_, data) => setSourcePath(data.value)}
              placeholder="选择或输入本地资料目录"
            />
          </Field>
          <Button
            appearance="subtle"
            icon={busy === 'scan' ? <Spinner size="tiny" /> : <ArrowClockwiseIcon />}
            disabled={!sourcePath.trim() || busy === 'scan'}
            onClick={() => void scanSource()}
          >
            扫描
          </Button>
        </div>

        {scan ? (
          <>
            <div className="builder-scan-summary" aria-label="扫描摘要">
              <div>
                <strong>{scan.eligibleCount}</strong>
                <span>可转换文件</span>
              </div>
              <div>
                <strong>{formatBytes(scan.eligibleSize)}</strong>
                <span>可转换体积</span>
              </div>
              <div>
                <strong>{scan.skippedCount}</strong>
                <span>跳过或待处理</span>
              </div>
              <div>
                <strong>{selected.size}</strong>
                <span>本批已选，{formatBytes(selectedSize ?? 0)}</span>
              </div>
            </div>

            <div className="builder-file-toolbar">
              <Input
                value={query}
                onChange={(_, data) => setQuery(data.value)}
                placeholder="按路径筛选文件"
              />
              <Button
                appearance="subtle"
                onClick={() =>
                  setSelected(new Set(visibleEligible.slice(0, 500).map((file) => file.id)))
                }
              >
                全选
              </Button>
              <Button appearance="subtle" onClick={() => setSelected(new Set())}>
                清空
              </Button>
            </div>

            <div className="builder-file-list" role="list" aria-label="原料文件">
              {visibleFiles.map((file) => (
                <label className={`builder-file ${file.eligible ? '' : 'disabled'}`} key={file.id}>
                  <Checkbox
                    checked={selected.has(file.id)}
                    disabled={!file.eligible}
                    onChange={(_, data) => toggleFile(file.id, data.checked === true)}
                    aria-label={`选择 ${file.relativePath}`}
                  />
                  <FileMdIcon size={18} aria-hidden />
                  <span className="builder-file-name" title={file.relativePath}>
                    {file.relativePath}
                  </span>
                  <span>{formatBytes(file.size)}</span>
                  <Badge appearance="outline">{file.extension}</Badge>
                  {!file.eligible && <small>{file.reason}</small>}
                </label>
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            title="尚未扫描原料"
            description="选择“本地知识库”或你的其他资料目录。扫描只读取文件元数据，不会修改内容。"
            actionLabel="选择目录"
            onAction={() => void chooseSource()}
          />
        )}
      </Section>

      {scan && (
        <Section
          title="整理策略"
          description="直导题库：题本与解析/答案册放同一批次，自动配对、与当前题库去重后写入（零 API）；AI 模式：由模型提取知识后逐项审核。"
        >
          <div className="builder-options">
            <Field className="builder-option-field" label="产物类型">
              <Select
                value={mode}
                onChange={(_, data) => setMode(data.value as KnowledgeBuildMode)}
              >
                <option value="auto">自动识别题目与知识</option>
                <option value="questions">只生成题目</option>
                <option value="documents">只生成知识文档</option>
                <option value="convert-only">仅转换 Markdown，不调用模型</option>
                <option value="direct">直导题库（题本+解析/答案，零 API）</option>
              </Select>
            </Field>
            {mode !== 'direct' && (
              <Field className="builder-option-field" label="质量流程">
                <Select
                  value={quality}
                  disabled={mode === 'convert-only'}
                  onChange={(_, data) => setQuality(data.value as KnowledgeBuildQuality)}
                >
                  <option value="high">高质量，两阶段审校</option>
                  <option value="standard">标准，单阶段提取</option>
                </Select>
              </Field>
            )}
            <Field className="builder-option-field" label="默认科目">
              <Select
                value={subject}
                onChange={(_, data) => setSubject(data.value as Subject | 'common' | 'auto')}
              >
                <option value="auto">由内容判断</option>
                <option value="xingce">行测</option>
                <option value="shenlun">申论</option>
                <option value="common">公共知识</option>
              </Select>
            </Field>
            <Field
              className="builder-option-field"
              label="批次标签"
              hint="用逗号分隔，将附加到所有产物"
            >
              <Input
                value={tags}
                onChange={(_, data) => setTags(data.value)}
                placeholder="例如：国考，2025"
              />
            </Field>
          </div>
          {mode !== 'direct' && (
            <Field
              label="自定义整理要求"
              hint="例如：优先提取数量关系公式与典型陷阱。要求只影响内容侧重点，不能绕过证据和审核规则。"
            >
              <Textarea
                value={instruction}
                resize="vertical"
                onChange={(_, data) => setInstruction(data.value)}
                placeholder="可留空，使用默认公考知识编辑规则"
              />
            </Field>
          )}
          <Checkbox
            checked={rightsConfirmed}
            onChange={(_, data) => setRightsConfirmed(data.checked === true)}
            label="我确认有权处理所选资料，并会在发布前逐项核对答案、事实与来源"
          />
          <div className="builder-start-row">
            <div className="builder-start-main">
              <Button
                className="builder-start-button"
                appearance="primary"
                icon={<PlayIcon />}
                disabled={
                  !engine.available ||
                  !selected.size ||
                  !rightsConfirmed ||
                  busy === 'start' ||
                  Boolean(job && RUNNING_STATES.has(job.status))
                }
                onClick={() => void startJob()}
              >
                {busy === 'start' ? '正在创建…' : mode === 'direct' ? '开始导入' : '开始处理'}
              </Button>
              <div className="builder-start-meta">
                <strong>{selected.size > 0 ? `${selected.size} 个文件` : '尚未选择文件'}</strong>
                <span>
                  {selected.size > 0
                    ? mode === 'direct'
                      ? '完成后需抽查并发布入库'
                      : '由模型提取后逐项审核'
                    : '请先在上方列表选择需要处理的文件'}
                </span>
              </div>
            </div>
            <p className="builder-start-note">原文件保持不变 · 任务可取消 · 单个失败不中断整批</p>
          </div>
        </Section>
      )}

      {job && (
        <Section
          title="任务与审核"
          description={job.message}
          actions={
            <div className="button-row">
              <Button
                appearance="subtle"
                icon={<FolderOpenIcon />}
                onClick={() => void openOutput()}
              >
                任务目录
              </Button>
              {RUNNING_STATES.has(job.status) && (
                <Button
                  appearance="subtle"
                  icon={<StopIcon />}
                  onClick={() => {
                    if (window.confirm('确认停止当前任务？已完成的文件会保留。')) void cancelJob()
                  }}
                >
                  停止
                </Button>
              )}
              {job.failedFiles > 0 && !RUNNING_STATES.has(job.status) && (
                <Button
                  appearance="subtle"
                  icon={<ArrowClockwiseIcon />}
                  disabled={busy === 'retry'}
                  onClick={() => void retryJob()}
                >
                  重试失败
                </Button>
              )}
              {!RUNNING_STATES.has(job.status) && job.pendingArtifacts > 0 && (
                <>
                  <Button
                    appearance="secondary"
                    icon={<CheckCircleIcon />}
                    disabled={busy === 'review'}
                    onClick={() => void reviewAll('approved')}
                  >
                    {busy === 'review' ? '处理中…' : `全部批准 ${job.pendingArtifacts}`}
                  </Button>
                  <Button
                    appearance="secondary"
                    icon={<ArrowClockwiseIcon />}
                    disabled={busy === 'review'}
                    onClick={() => void reviewAll('rejected')}
                  >
                    {busy === 'review' ? '处理中…' : '全部拒绝'}
                  </Button>
                </>
              )}
              {!RUNNING_STATES.has(job.status) &&
                job.pendingArtifacts === 0 &&
                job.artifacts.length > 0 && (
                  <span className="pill">
                    ✓ 已处理 · 批准 {job.approvedArtifacts} · 拒绝{' '}
                    {job.artifacts.filter((a) => a.status === 'rejected').length}
                  </span>
                )}
              {job.approvedArtifacts > 0 && !RUNNING_STATES.has(job.status) && (
                <Button
                  appearance="primary"
                  icon={<CheckCircleIcon />}
                  disabled={busy === 'publish'}
                  onClick={() => void publish()}
                >
                  {busy === 'publish' ? '发布中…' : `发布 ${job.approvedArtifacts} 项`}
                </Button>
              )}
              {job.options.mode === 'direct' &&
                !RUNNING_STATES.has(job.status) &&
                job.artifacts.some((item) => item.status === 'published') && (
                  <Button
                    appearance="subtle"
                    icon={<ArrowClockwiseIcon />}
                    disabled={busy === 'publish'}
                    onClick={() => void revertImport()}
                  >
                    撤销本次导入
                  </Button>
                )}
            </div>
          }
        >
          <div className="builder-job-head">
            <div>
              <Badge appearance="filled">{getDisplayJobStatus(job)}</Badge>
              <strong>
                {job.processedFiles}/{job.totalFiles} 文件
              </strong>
              <span>{job.currentFile ?? '当前没有正在处理的文件'}</span>
            </div>
            <div>
              <span>{job.pendingArtifacts} 待审核</span>
              <span>{job.approvedArtifacts} 已批准</span>
              <span>{job.artifacts.filter((a) => a.status === 'rejected').length} 已拒绝</span>
              {job.failedFiles > 0 && <span>{job.failedFiles} 失败</span>}
            </div>
          </div>
          <ProgressBar value={job.totalFiles ? job.processedFiles / job.totalFiles : 0} />

          <div className="builder-job-files">
            {job.files.map((file) => (
              <div key={file.sourceId}>
                <span title={file.relativePath}>{file.relativePath}</span>
                <Badge appearance="outline">{file.state}</Badge>
                <small>
                  {file.message ?? '等待处理'}
                  {file.fromCache && ' · 缓存命中'}
                </small>
                {file.ocrQuality && <OcrQualitySummary report={file.ocrQuality} />}
              </div>
            ))}
          </div>

          {job.artifacts.length > 0 && (
            <div className="builder-review-layout">
              <div className="builder-artifact-list" aria-label="待审核知识产物">
                <div className="builder-filter-bar">
                  {(['all', 'pending', 'approved', 'rejected', 'warnings'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="builder-filter-pill"
                      data-active={filterStatus === f}
                      onClick={() => {
                        setFilterStatus(f)
                        setReviewPage(0)
                      }}
                    >
                      {f === 'all'
                        ? `全部 ${job.artifacts.length}`
                        : f === 'pending'
                          ? `待审 ${job.pendingArtifacts}`
                          : f === 'approved'
                            ? `已批 ${job.approvedArtifacts}`
                            : f === 'rejected'
                              ? `已拒 ${job.artifacts.filter((a) => a.status === 'rejected').length}`
                              : `有警告 ${job.artifacts.filter((a) => a.warnings.length > 0).length}`}
                    </button>
                  ))}
                </div>
                {filteredArtifacts.length === 0 && (
                  <div className="empty-compact" style={{ padding: '16px 12px' }}>
                    <span>
                      {filterStatus === 'pending'
                        ? '没有待审核产物，当前批次已全部处理'
                        : filterStatus === 'approved'
                          ? '没有已批准产物'
                          : filterStatus === 'rejected'
                            ? '没有已拒绝产物'
                            : filterStatus === 'warnings'
                              ? '没有带警告的产物'
                              : '当前筛选下没有产物'}
                    </span>
                  </div>
                )}
                {paginatedArtifacts.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`builder-artifact ${artifact?.id === item.id ? 'active' : ''}`}
                    onClick={() => void openArtifact(item.id)}
                  >
                    <span>
                      <Badge appearance={statusAppearance(item.status)}>
                        {artifactStatusLabel(item.status)}
                      </Badge>
                      <small>{item.kind === 'question' ? '题目' : '知识'}</small>
                      <small>
                        {item.generatedBy === 'direct-import'
                          ? '规则切题'
                          : `置信度 ${Math.round(item.confidence * 100)}%`}
                      </small>
                      {item.warnings.length > 0 && (
                        <small className="warning">⚠ {item.warnings.length}</small>
                      )}
                    </span>
                    <strong>{item.title}</strong>
                    <p>{item.preview}</p>
                  </button>
                ))}
                {totalPages > 1 && (
                  <div className="builder-pagination">
                    <Button
                      size="small"
                      appearance="subtle"
                      disabled={safePage === 0}
                      onClick={() => setReviewPage(safePage - 1)}
                    >
                      上一页
                    </Button>
                    <span>
                      {safePage + 1} / {totalPages} · {filteredArtifacts.length} 条
                    </span>
                    <Button
                      size="small"
                      appearance="subtle"
                      disabled={safePage >= totalPages - 1}
                      onClick={() => setReviewPage(safePage + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </div>
              <div className="builder-artifact-preview">
                {busy === 'artifact' ? (
                  <LoadingState label="正在读取产物" />
                ) : artifact ? (
                  <>
                    <div className="builder-preview-head">
                      <div>
                        <strong>{artifact.title}</strong>
                        <span>
                          {artifact.generatedBy === 'direct-import'
                            ? '规则切题（确定性导入）'
                            : `内容置信度 ${Math.round(artifact.confidence * 100)}%`}
                          {artifact.warnings.length > 0 && ` · ${artifact.warnings.length} 条警告`}
                          {' · '}来源：{artifact.evidenceExcerpt?.slice(0, 60) || '待核验'}
                        </span>
                      </div>
                      {artifact.status === 'pending' && (
                        <div className="button-row">
                          <Button
                            disabled={busy === 'review'}
                            onClick={() => void reviewArtifact('rejected')}
                          >
                            拒绝
                          </Button>
                          <Button
                            appearance="primary"
                            disabled={busy === 'review'}
                            onClick={() => void reviewArtifact('approved')}
                          >
                            批准
                          </Button>
                        </div>
                      )}
                      {artifact.status === 'rejected' && (
                        <div className="builder-status-row">
                          <span className="pill">已拒绝</span>
                          <Button
                            appearance="subtle"
                            size="small"
                            disabled={busy === 'review'}
                            onClick={() => void reviewArtifact('pending')}
                          >
                            恢复待审核
                          </Button>
                        </div>
                      )}
                      {artifact.status === 'approved' && (
                        <div className="builder-status-row">
                          <span className="pill">已批准</span>
                          <Button
                            appearance="subtle"
                            size="small"
                            disabled={busy === 'review'}
                            onClick={() => void reviewArtifact('pending')}
                          >
                            撤回批准
                          </Button>
                        </div>
                      )}
                      {artifact.status === 'published' && <span className="pill">已发布</span>}
                    </div>
                    {artifact.warnings.length > 0 && (
                      <div className="builder-warning-list">
                        {artifact.warnings.map((warning) => (
                          <span key={warning}>{warning}</span>
                        ))}
                      </div>
                    )}
                    <MarkdownContent
                      content={artifact.markdown.replace(/^---\s*[\s\S]*?\s*---\s*/m, '')}
                    />
                  </>
                ) : job && job.pendingArtifacts === 0 && job.artifacts.length > 0 ? (
                  <div className="empty-guide">
                    <strong>本批产物已全部处理</strong>
                    <span>
                      已批准 {job.approvedArtifacts} 项 · 已拒绝{' '}
                      {job.artifacts.filter((a) => a.status === 'rejected').length} 项
                      {job.approvedArtifacts > 0 && '，可点击上方「发布」入库'}
                    </span>
                    <span>在左侧筛选中切换「已批准」或「已拒绝」可查看具体项目</span>
                  </div>
                ) : (
                  <div className="empty-compact" style={{ padding: '20px 0' }}>
                    <span>从左侧选择一项产物开始审核，或点击「全部批准」批量处理</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
