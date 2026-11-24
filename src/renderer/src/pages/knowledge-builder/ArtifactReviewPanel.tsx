import { Badge, Button, Textarea } from '@fluentui/react-components'
import { EyeIcon, SparkleIcon } from '@phosphor-icons/react'
import type {
  KnowledgeArtifactDetail,
  KnowledgeArtifactSummary,
  KnowledgeBuildJob,
  VlmConfigView,
  VlmProofreadSuggestion
} from '@shared/contracts'
import { MarkdownContent } from '../../components/MarkdownContent'
import { LoadingState } from '../../components/ui'
import {
  artifactStatusLabel,
  hasProofreadPages,
  isPublishGated,
  sourceEvidenceLabel,
  statusAppearance
} from './helpers'

export type ArtifactFilterStatus = 'all' | 'pending' | 'approved' | 'rejected' | 'warnings'

interface ArtifactReviewPanelProps {
  job: KnowledgeBuildJob
  artifact?: KnowledgeArtifactDetail
  filterStatus: ArtifactFilterStatus
  safePage: number
  totalPages: number
  filteredArtifacts: KnowledgeArtifactSummary[]
  paginatedArtifacts: KnowledgeArtifactSummary[]
  busy: string
  humanConfirmed: boolean
  vlmConfig?: VlmConfigView
  vlmSuggestion?: VlmProofreadSuggestion
  editorMode: 'closed' | 'manual' | 'vlm'
  editorContent: string
  onFilterStatusChange: (status: ArtifactFilterStatus) => void
  onPageChange: (page: number) => void
  onOpenPreview: (evidence: KnowledgeArtifactSummary['sourceEvidence']) => void
  onOpenArtifact: (id: string) => void
  onReviewArtifact: (status: 'pending' | 'approved' | 'rejected') => void
  onHumanConfirmedChange: (checked: boolean) => void
  onRunVlmProofread: () => void
  onStartManualEdit: (markdown: string) => void
  onEditorContentChange: (content: string) => void
  onSaveMarkdown: (origin: 'vlm' | 'manual') => void
  onCloseEditor: () => void
}

export function ArtifactReviewPanel({
  job,
  artifact,
  filterStatus,
  safePage,
  totalPages,
  filteredArtifacts,
  paginatedArtifacts,
  busy,
  humanConfirmed,
  vlmConfig,
  vlmSuggestion,
  editorMode,
  editorContent,
  onFilterStatusChange,
  onPageChange,
  onOpenPreview,
  onOpenArtifact,
  onReviewArtifact,
  onHumanConfirmedChange,
  onRunVlmProofread,
  onStartManualEdit,
  onEditorContentChange,
  onSaveMarkdown,
  onCloseEditor
}: ArtifactReviewPanelProps): React.JSX.Element {
  return (
    <div className="builder-review-layout">
      <div className="builder-artifact-list" aria-label="待审核知识产物">
        <div className="builder-filter-bar">
          {(['all', 'pending', 'approved', 'rejected', 'warnings'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className="builder-filter-pill"
              data-active={filterStatus === f}
              onClick={() => onFilterStatusChange(f)}
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
          <div
            key={item.id}
            className={`builder-artifact ${artifact?.id === item.id ? 'active' : ''}`}
            data-testid="builder-artifact-item"
          >
            <span>
              <Badge
                appearance={statusAppearance(item.status)}
                className={`builder-status-badge is-${item.status}`}
              >
                {artifactStatusLabel(item.status)}
              </Badge>
              <small>{item.kind === 'question' ? '题目' : '知识'}</small>
              <small>
                {item.generatedBy === 'direct-import'
                  ? '规则切题'
                  : `置信度 ${Math.round(item.confidence * 100)}%`}
              </small>
              {item.importQualityTier && (
                <small
                  title={
                    item.importQualityTier === 'structured'
                      ? '结构化题目：已生成可作答结构，不代表 OCR 内容正确'
                      : item.importQualityTier === 'review-required'
                        ? '待人工审核：导入结果抽查，含图片/表格/图推等能力边界内容（不是要求标注 OCR 数据集）'
                        : '原始资料保留：仅保留原始资料，未生成可作答题目'
                  }
                >
                  {item.importQualityTier === 'structured'
                    ? '结构化题目'
                    : item.importQualityTier === 'review-required'
                      ? '待人工审核'
                      : '原始资料保留'}
                </small>
              )}
              {sourceEvidenceLabel(item.sourceEvidence) && (
                <small title="来源页证据：仅供对照原页核对（推测页码已标注），不是准确率验证">
                  {sourceEvidenceLabel(item.sourceEvidence)}
                </small>
              )}
              {item.sourceEvidence?.status !== 'unavailable' &&
                item.sourceEvidence?.references.some((r) =>
                  r.pages.some((p) => p.evidenceAssetId)
                ) && (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<EyeIcon />}
                    data-testid="source-preview-button"
                    title="查看原页预览（仅供对照核对）"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenPreview(item.sourceEvidence)
                    }}
                  />
                )}
              {item.warnings.length > 0 && (
                <small className="warning" title={item.warnings.join('\n')}>
                  ⚠ {item.warnings[0]}
                </small>
              )}
            </span>
            {/* 标题区域是独立的选择按钮：键盘 Enter/Space 只作用于这里，不冒泡到预览按钮 */}
            <button
              type="button"
              data-testid="builder-artifact-select"
              className="builder-artifact-select"
              onClick={() => onOpenArtifact(item.id)}
            >
              <strong>{item.title}</strong>
              <p>{item.preview}</p>
            </button>
          </div>
        ))}
        {totalPages > 1 && (
          <div className="builder-pagination">
            <Button
              size="small"
              appearance="subtle"
              disabled={safePage === 0}
              onClick={() => onPageChange(safePage - 1)}
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
              onClick={() => onPageChange(safePage + 1)}
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
                  <Button disabled={busy === 'review'} onClick={() => onReviewArtifact('rejected')}>
                    拒绝
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={busy === 'review'}
                    onClick={() => onReviewArtifact('approved')}
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
                    onClick={() => onReviewArtifact('pending')}
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
                    onClick={() => onReviewArtifact('pending')}
                  >
                    撤回批准
                  </Button>
                </div>
              )}
              {artifact.status === 'published' && <span className="pill">已发布</span>}
            </div>
            {artifact.status === 'pending' && isPublishGated(artifact) && (
              <div className="builder-warning-list">
                <span>
                  系统能力边界：此资料包含图片型内容。题舟不会自动猜测图形规律、图表数字或图片选项。请以原始页面为准，人工核对后再批准。
                </span>
                <label className="builder-confirm-check">
                  <input
                    type="checkbox"
                    checked={humanConfirmed}
                    onChange={(event) => onHumanConfirmedChange(event.target.checked)}
                  />
                  我已查看原始页面并确认内容正确
                </label>
              </div>
            )}
            {artifact.status === 'approved' && isPublishGated(artifact) && (
              <div className="builder-warning-list">
                {artifact.humanConfirmed ? (
                  <span className="positive">已人工确认：发布限制已解除。</span>
                ) : (
                  <>
                    <span>
                      已批准但受发布门禁限制：批量批准不会带入人工确认，勾选后提交确认才会解除发布限制。
                    </span>
                    <label className="builder-confirm-check">
                      <input
                        type="checkbox"
                        checked={humanConfirmed}
                        onChange={(event) => onHumanConfirmedChange(event.target.checked)}
                      />
                      我已查看原始页面并确认内容正确
                    </label>
                    <Button
                      size="small"
                      appearance="primary"
                      disabled={busy === 'review' || !humanConfirmed}
                      onClick={() => onReviewArtifact('approved')}
                    >
                      提交人工确认
                    </Button>
                  </>
                )}
              </div>
            )}
            {artifact.warnings.length > 0 && (
              <div className="builder-warning-list">
                {artifact.warnings.map((warning) => (
                  <span key={warning}>{warning}</span>
                ))}
              </div>
            )}
            {artifact.status !== 'published' && (
              <div
                className="button-row"
                style={{ alignItems: 'center', margin: '10px 0' }}
                data-testid="artifact-actions-row"
              >
                {vlmConfig?.enabled && hasProofreadPages(artifact) && (
                  <Button
                    size="small"
                    appearance="secondary"
                    icon={<SparkleIcon />}
                    disabled={busy === 'vlm'}
                    data-testid="vlm-proofread-button"
                    title="按来源页调用视觉模型核对表格数字与材料文本，返回建议供你对比采纳"
                    onClick={onRunVlmProofread}
                  >
                    {busy === 'vlm' ? '精校中…' : 'VLM 按页精校'}
                  </Button>
                )}
                <Button
                  size="small"
                  appearance="subtle"
                  disabled={busy !== ''}
                  data-testid="edit-markdown-button"
                  onClick={() => onStartManualEdit(artifact.markdown)}
                >
                  编辑正文
                </Button>
                {!vlmConfig?.enabled && hasProofreadPages(artifact) && (
                  <small className="muted-copy">
                    开启顶部「VLM 按页精校」开关后，可对来源页调用视觉模型辅助核对。
                  </small>
                )}
              </div>
            )}
            {editorMode === 'vlm' && vlmSuggestion && (
              <div className="builder-editor-panel" data-testid="vlm-suggestion-panel">
                <strong>精校建议（未落盘，对比后采纳）</strong>
                {vlmSuggestion.summary && <span>{vlmSuggestion.summary}</span>}
                {vlmSuggestion.changes.length > 0 && (
                  <span>变更：{vlmSuggestion.changes.slice(0, 8).join('；')}</span>
                )}
                {vlmSuggestion.uncertainItems.length > 0 && (
                  <span className="warning">
                    存疑：{vlmSuggestion.uncertainItems.slice(0, 8).join('；')}
                  </span>
                )}
                <span className="muted-copy">
                  精校页：
                  {vlmSuggestion.pages.map((page) => `第${page.pageNumber}页`).join('、')}
                  ；frontmatter（id、参考答案、选项图片绑定）由应用原样保留，视觉模型无法改动。
                </span>
                <Textarea
                  data-testid="vlm-suggestion-editor"
                  value={editorContent}
                  resize="vertical"
                  rows={14}
                  onChange={(_, data) => onEditorContentChange(data.value)}
                />
                <div className="button-row">
                  <Button
                    size="small"
                    appearance="primary"
                    disabled={busy === 'save' || !editorContent.trim()}
                    onClick={() => onSaveMarkdown('vlm')}
                  >
                    {busy === 'save' ? '保存中…' : '采纳并保存'}
                  </Button>
                  <Button size="small" onClick={onCloseEditor}>
                    放弃建议
                  </Button>
                </div>
              </div>
            )}
            {editorMode === 'manual' && (
              <div className="builder-editor-panel" data-testid="manual-editor-panel">
                <strong>编辑正文</strong>
                <span className="muted-copy">
                  可直接修正错别字与错数字；frontmatter 中的
                  id、参考答案与选项图片绑定会被服务端强校验，改动会被拒绝。
                </span>
                <Textarea
                  data-testid="manual-editor"
                  value={editorContent}
                  resize="vertical"
                  rows={14}
                  onChange={(_, data) => onEditorContentChange(data.value)}
                />
                <div className="button-row">
                  <Button
                    size="small"
                    appearance="primary"
                    disabled={busy === 'save' || !editorContent.trim()}
                    onClick={() => onSaveMarkdown('manual')}
                  >
                    {busy === 'save' ? '保存中…' : '保存正文'}
                  </Button>
                  <Button size="small" onClick={onCloseEditor}>
                    取消编辑
                  </Button>
                </div>
              </div>
            )}
            <MarkdownContent
              content={artifact.markdown.replace(/^---\s*[\s\S]*?\s*---\s*/m, '')}
              sourceFilePath={`${job.outputPath.replace(/[\\/]+$/, '')}/raw/${artifact.sourceId}.md`}
            />
          </>
        ) : job.pendingArtifacts === 0 && job.artifacts.length > 0 ? (
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
  )
}
