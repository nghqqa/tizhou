import type { ReactNode } from 'react'
import { Badge, Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  StopIcon
} from '@phosphor-icons/react'
import type { KnowledgeBuildJob } from '@shared/contracts'
import { Section } from '../../components/ui'
import { RUNNING_STATES, getDisplayJobStatus, jobStatusTone, OcrQualitySummary } from './helpers'

interface JobProgressCardProps {
  job: KnowledgeBuildJob
  busy: string
  onOpenOutput: () => void
  onRequestCancelJob: () => void
  onRetryJob: () => void
  onReviewAll: (status: 'approved' | 'rejected') => void
  onPublish: () => void
  onRequestRevertImport: () => void
  children?: ReactNode
}

export function JobProgressCard({
  job,
  busy,
  onOpenOutput,
  onRequestCancelJob,
  onRetryJob,
  onReviewAll,
  onPublish,
  onRequestRevertImport,
  children
}: JobProgressCardProps): React.JSX.Element {
  return (
    <Section
      title="任务与审核"
      description={job.message}
      actions={
        <div className="button-row">
          <Button appearance="subtle" icon={<FolderOpenIcon />} onClick={onOpenOutput}>
            任务目录
          </Button>
          {RUNNING_STATES.has(job.status) && (
            <Button appearance="subtle" icon={<StopIcon />} onClick={onRequestCancelJob}>
              停止
            </Button>
          )}
          {job.failedFiles > 0 && !RUNNING_STATES.has(job.status) && (
            <Button
              appearance="subtle"
              icon={<ArrowClockwiseIcon />}
              disabled={busy === 'retry'}
              onClick={onRetryJob}
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
                onClick={() => onReviewAll('approved')}
              >
                {busy === 'review' ? '处理中…' : `全部批准 ${job.pendingArtifacts}`}
              </Button>
              <Button
                appearance="secondary"
                icon={<ArrowClockwiseIcon />}
                disabled={busy === 'review'}
                onClick={() => onReviewAll('rejected')}
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
              onClick={onPublish}
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
                onClick={onRequestRevertImport}
              >
                撤销本次导入
              </Button>
            )}
        </div>
      }
    >
      <div className="builder-job-head">
        <div>
          <Badge
            appearance={job.status === 'failed' ? 'filled' : 'tint'}
            className={`builder-status-badge ${jobStatusTone(job)}`}
          >
            {getDisplayJobStatus(job)}
          </Badge>
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

      {children}
    </Section>
  )
}
