import type {
  AgentActionProposal,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolStep
} from '@shared/contracts'
import { invoke } from '../api'

export interface AgentRunCallbacks {
  onStatus?: (text: string) => void
  onToolStart?: (step: AgentToolStep) => void
  onToolResult?: (step: AgentToolStep) => void
  onProposal?: (proposal: AgentActionProposal) => void
  onDelta?: (delta: string) => void
}

function makeAgentRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 发起一次多步自主备考工具运行，并实时订阅主进程推送的轨迹与提案事件 */
export async function runAgentChat(
  input: Omit<AgentRunInput, 'requestId'> & { requestId?: string },
  callbacks?: AgentRunCallbacks
): Promise<{ requestId: string; result: AgentRunResult }> {
  const requestId = input.requestId ?? makeAgentRequestId()
  const unsubscribe = window.workbench?.onAgentEvent?.((event: AgentStreamEvent) => {
    if (event.requestId !== requestId) return
    switch (event.type) {
      case 'status':
        if (event.text) callbacks?.onStatus?.(event.text)
        break
      case 'tool_start':
        if (event.step) callbacks?.onToolStart?.(event.step)
        break
      case 'tool_result':
        if (event.step) callbacks?.onToolResult?.(event.step)
        break
      case 'proposal':
        if (event.proposal) callbacks?.onProposal?.(event.proposal)
        break
      case 'chunk':
        if (event.delta) callbacks?.onDelta?.(event.delta)
        break
      default:
        break
    }
  })

  try {
    const result = await invoke<AgentRunResult>({
      method: 'agent.run',
      params: { ...input, requestId }
    })
    return { requestId, result }
  } finally {
    unsubscribe?.()
  }
}

export async function cancelAgentRun(requestId: string): Promise<boolean> {
  if (!requestId) return false
  return invoke<boolean>({
    method: 'agent.cancel',
    params: { requestId }
  })
}
