import type {
  KnowledgeArtifactStatus,
  KnowledgeArtifactSummary,
  KnowledgeBuildJob,
  OcrQualityReport
} from '@shared/contracts'

export const RUNNING_STATES = new Set(['queued', 'running', 'cancelling'])

export interface SourcePreviewEntry {
  label: string
  pageNumber: number
  mapping: 'exact' | 'estimated'
  evidenceAssetId?: string
}

export interface SourcePreviewState {
  jobId: string
  entries: SourcePreviewEntry[]
  index: number
}

export function jobStatusLabel(status: KnowledgeBuildJob['status']): string {
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
export function getDisplayJobStatus(job: KnowledgeBuildJob): string {
  if (job.status === 'review' && job.pendingArtifacts === 0 && job.artifacts.length > 0) {
    return '本批已处理'
  }
  return jobStatusLabel(job.status)
}

/** 任务状态徽章语义色调，避免待审核/正常态沿用朱砂红与报错撞色 */
export function jobStatusTone(job: KnowledgeBuildJob): string {
  if (job.status === 'failed') return 'is-failed'
  if (job.status === 'cancelled') return 'is-rejected'
  if (
    job.status === 'completed' ||
    (job.status === 'review' && job.pendingArtifacts === 0 && job.artifacts.length > 0)
  ) {
    return 'is-approved'
  }
  if (job.status === 'review') return 'is-pending'
  return 'is-neutral'
}

/** 来源证据标签：文件·页码；estimated 标「页码为推测」；unavailable 标「暂无法定位原页」 */
export function sourceEvidenceLabel(evidence?: KnowledgeArtifactSummary['sourceEvidence']): string {
  if (!evidence) return ''
  if (evidence.status === 'unavailable' || evidence.references.length === 0) return '暂无法定位原页'
  const parts: string[] = []
  for (const reference of evidence.references) {
    const pages = [...new Set(reference.pages.map((page) => page.pageNumber))].sort((a, b) => a - b)
    if (pages.length === 0) continue
    const pageText =
      pages.length === 1
        ? `第${pages[0]}页`
        : `第${pages[0]}～${pages[pages.length - 1]}页（共${pages.length}页）`
    const roleLabel =
      reference.role === 'material' ? '材料' : reference.role === 'solution' ? '解析' : ''
    parts.push(
      `${roleLabel}${pageText}${
        reference.pages.some((page) => page.mapping === 'estimated') ? '（页码为推测）' : ''
      }`
    )
  }
  if (parts.length === 0) return '暂无法定位原页'
  return `来源 ${parts.join(' · ')}`
}

/** OCR 质量摘要：区分文字层页/OCR页/置信度，不与 AI 模型置信度混淆 */
export function OcrQualitySummary({ report }: { report: OcrQualityReport }): React.JSX.Element {
  const parts: string[] = []
  if (report.structured) {
    parts.push(`结构解析 ${report.ocrPages} 页`)
    if (report.tableRegions) parts.push(`表格 ${report.tableRegions}`)
    if (report.figureRegions) parts.push(`图形 ${report.figureRegions}`)
    if (report.removedNoiseLines) parts.push(`剥离噪声 ${report.removedNoiseLines}`)
    parts.push('表格还原 · 图片保真')
  } else {
    if (report.textLayerPages > 0) parts.push(`文字层 ${report.textLayerPages} 页`)
    if (report.ocrPages > 0) parts.push(`OCR ${report.ocrPages} 页`)
    if (report.averageConfidence != null) {
      parts.push(`OCR 置信度 ${(report.averageConfidence * 100).toFixed(0)}%`)
    }
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

export function artifactStatusLabel(status: KnowledgeArtifactStatus): string {
  return {
    pending: '待审核',
    approved: '已批准',
    rejected: '已拒绝',
    published: '已发布'
  }[status]
}

/** 发布门禁判定：与主进程 partitionByPublishGate 完全同一口径——
 *  能力边界（非 text-supported）或警告含「配对待确认」且未人工确认 */
export function isPublishGated(artifact: {
  capability?: string
  humanConfirmed?: boolean
  warnings: string[]
}): boolean {
  return (
    (Boolean(artifact.capability) && artifact.capability !== 'text-supported') ||
    artifact.warnings.some((warning) => warning.includes('配对待确认'))
  )
}

export function statusAppearance(
  status: KnowledgeArtifactStatus
): 'filled' | 'outline' | 'tint' | 'ghost' {
  return status === 'approved' || status === 'published'
    ? 'filled'
    : status === 'rejected'
      ? 'outline'
      : 'tint'
}

/** 产物是否具备可精校的来源 PDF 页（材料/题本/保留页；解析册页不参与） */
export function hasProofreadPages(artifact: KnowledgeArtifactSummary): boolean {
  const evidence = artifact.sourceEvidence
  if (!evidence || evidence.status === 'unavailable') return false
  return evidence.references.some((ref) => ref.role !== 'solution' && ref.pages.length > 0)
}
