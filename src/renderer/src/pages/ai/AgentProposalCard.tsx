import { Button } from '@fluentui/react-components'
import {
  ArrowRightIcon,
  BrainIcon,
  CalendarCheckIcon,
  CheckCircleIcon,
  ListChecksIcon,
  NotePencilIcon,
  PlayIcon,
  XCircleIcon
} from '@phosphor-icons/react'
import type { AgentActionKind, AgentActionProposal } from '@shared/contracts'

interface AgentProposalCardProps {
  proposal: AgentActionProposal
  busy?: boolean
  onApprove: (proposal: AgentActionProposal) => void | Promise<void>
  onDismiss: (proposal: AgentActionProposal) => void | Promise<void>
  onNavigate?: (path: string) => void
}

const KIND_META: Record<AgentActionKind, { label: string; icon: typeof PlayIcon }> = {
  start_practice: { label: '开启专项训练', icon: PlayIcon },
  enqueue_review: { label: '加入间隔复习', icon: ListChecksIcon },
  save_note: { label: '写入错题笔记', icon: NotePencilIcon },
  save_memory: { label: '保存长期学习记忆', icon: BrainIcon },
  apply_plan: { label: '应用阶段学习计划', icon: CalendarCheckIcon }
}

export function AgentProposalCard({
  proposal,
  busy,
  onApprove,
  onDismiss,
  onNavigate
}: AgentProposalCardProps) {
  const meta = KIND_META[proposal.kind]
  const Icon = meta.icon
  const statusLabel =
    proposal.status === 'approved'
      ? '已确认执行'
      : proposal.status === 'rejected'
        ? '已暂缓'
        : proposal.status === 'error'
          ? '执行出错'
          : '待你确认'

  return (
    <div className={`agent-proposal is-${proposal.status}`}>
      <div className="agent-proposal-head">
        <span className="agent-proposal-kind">
          <Icon weight="bold" />
          <span>{meta.label}</span>
        </span>
        <span className={`agent-proposal-status is-${proposal.status}`}>{statusLabel}</span>
      </div>

      <div className="agent-proposal-title">{proposal.title}</div>
      <div className="agent-proposal-summary">{proposal.summary}</div>
      {proposal.reason && <div className="agent-proposal-reason">判断依据：{proposal.reason}</div>}

      {proposal.previewItems && proposal.previewItems.length > 0 && (
        <ul className="agent-proposal-preview">
          {proposal.previewItems.map((item, idx) => (
            <li key={`${proposal.id}-${idx}`}>{item}</li>
          ))}
        </ul>
      )}

      <div className="agent-proposal-actions">
        {proposal.status === 'pending' && (
          <>
            <Button
              appearance="primary"
              size="small"
              disabled={busy}
              onClick={() => void onApprove(proposal)}
            >
              确认执行
            </Button>
            <Button
              appearance="subtle"
              size="small"
              disabled={busy}
              onClick={() => void onDismiss(proposal)}
            >
              暂不执行
            </Button>
          </>
        )}

        {proposal.status === 'approved' && (
          <div className="agent-proposal-done">
            <span className="agent-proposal-done-text">
              <CheckCircleIcon weight="fill" />
              <span>{proposal.resultMessage || '已确认并在本地生效'}</span>
            </span>
            {proposal.navigateTo && onNavigate && (
              <Button
                appearance="outline"
                size="small"
                icon={<ArrowRightIcon />}
                onClick={() => onNavigate(proposal.navigateTo!)}
              >
                立即前往
              </Button>
            )}
          </div>
        )}

        {proposal.status === 'rejected' && (
          <div className="agent-proposal-dismissed">
            <XCircleIcon />
            <span>已暂缓此提案，未改动本机题库或学习记录。</span>
          </div>
        )}

        {proposal.status === 'error' && (
          <div className="agent-proposal-error">
            <XCircleIcon weight="fill" />
            <span>{proposal.resultMessage || '操作未能完成，请确认本地题库与参数后重试。'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
