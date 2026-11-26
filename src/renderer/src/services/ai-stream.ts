import type { AiAskInput, AiAskResult, AiStreamEvent } from '@shared/contracts'
import { invoke } from '../api'

export interface StreamHandle {
  requestId: string
  promise: Promise<AiAskResult & { aborted?: boolean }>
  cancel: () => void
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function subscribeAiStream(
  requestId: string,
  onDelta: (accumulated: string, delta: string) => void
): () => void {
  let accumulated = ''
  const off = window.workbench?.onAiStream?.((event: AiStreamEvent) => {
    if (event.requestId !== requestId) return
    if (event.type === 'reset') {
      accumulated = ''
      onDelta('', '')
    } else if (event.type === 'chunk' && event.delta) {
      accumulated += event.delta
      onDelta(accumulated, event.delta)
    } else if ((event.type === 'done' || event.type === 'aborted') && event.content !== undefined) {
      if (event.content.length > accumulated.length) {
        const diff = event.content.slice(accumulated.length)
        accumulated = event.content
        onDelta(accumulated, diff)
      }
    }
  })
  return () => {
    off?.()
  }
}

export async function cancelAiStream(requestId: string): Promise<boolean> {
  if (!requestId) return false
  try {
    return await invoke<boolean>({ method: 'ai.stream.cancel', params: { requestId } })
  } catch {
    return false
  }
}

export function streamAiAsk(
  input: AiAskInput,
  onDelta: (accumulated: string, delta: string) => void
): StreamHandle {
  const requestId = makeRequestId()
  const unsubscribe = subscribeAiStream(requestId, onDelta)
  const promise = invoke<AiAskResult & { aborted?: boolean }>({
    method: 'ai.askStream',
    params: { ...input, requestId }
  }).finally(() => {
    unsubscribe()
  })
  return {
    requestId,
    promise,
    cancel: () => {
      void cancelAiStream(requestId)
    }
  }
}

function unescapeJsonString(raw: string): string {
  return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_match, seq: string) => {
    if (seq === '"') return '"'
    if (seq === '\\') return '\\'
    if (seq === '/') return '/'
    if (seq === 'b') return '\b'
    if (seq === 'f') return '\f'
    if (seq === 'n') return '\n'
    if (seq === 'r') return ''
    if (seq === 't') return ' '
    if (seq.startsWith('u')) return String.fromCharCode(parseInt(seq.slice(1), 16))
    return seq
  })
}

/** 从申论批改模型正在流式吐出的 JSON 文本中提取可读摘要与得分，避免直接闪现原始花括号与思考过程 */
export function extractShenlunStreamPreview(raw: string): {
  chars: number
  score?: number
  summary?: string
  snippet: string
} {
  const chars = raw.length
  const visibleRaw = raw
    .replace(
      /<(?:think|thought|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|thought|reasoning)>|$)/gi,
      ''
    )
    .trim()
  if (!visibleRaw && raw.trim()) {
    return {
      chars,
      snippet: '模型正在分析材料与采分点，稍后输出批改结果…'
    }
  }
  const withoutDimensions = visibleRaw.replace(
    /"dimensions"\s*:\s*\[[\s\S]*?(?:\]\s*(?=[,}])|$)/,
    ''
  )
  const scoreMatch = withoutDimensions.match(/"score"\s*:\s*(\d{1,3}(?:\.\d+)?)/)
  const score = scoreMatch ? Number(scoreMatch[1]) : undefined
  const summaryMatch = visibleRaw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/)
  const summary = summaryMatch?.[1] ? unescapeJsonString(summaryMatch[1]).trim() : undefined
  const snippet = summary
    ? summary
    : visibleRaw
        .replace(/```(?:json)?/gi, '')
        .replace(/[{}\[\]"]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(-220)
  return { chars, score, summary, snippet }
}
