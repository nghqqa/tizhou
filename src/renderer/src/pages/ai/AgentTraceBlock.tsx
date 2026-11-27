import { useState } from 'react'
import { Spinner } from '@fluentui/react-components'
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  WrenchIcon
} from '@phosphor-icons/react'
import type { AgentToolStep } from '@shared/contracts'

interface AgentTraceBlockProps {
  steps: AgentToolStep[]
  statusText?: string
  running?: boolean
}

export function AgentTraceBlock({ steps, statusText, running }: AgentTraceBlockProps) {
  const [expanded, setExpanded] = useState(Boolean(running))

  if (steps.length === 0 && !running && !statusText) {
    return null
  }

  const headerTitle = running
    ? statusText || `正在执行工具核查（已调用 ${steps.length} 项）…`
    : `已核查 ${steps.length} 项本机学习数据`

  return (
    <div className={`agent-trace${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="agent-trace-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="agent-trace-title">
          {running ? <Spinner size="extra-tiny" /> : <WrenchIcon weight="bold" />}
          <span>{headerTitle}</span>
        </span>
        <span className="agent-trace-chevron">
          {steps.length > 0 && <span className="agent-trace-count">{steps.length} 步</span>}
          {expanded ? <CaretDownIcon weight="bold" /> : <CaretRightIcon weight="bold" />}
        </span>
      </button>

      {expanded && steps.length > 0 && (
        <ul className="agent-trace-list">
          {steps.map((step) => (
            <li key={step.id} className={`agent-trace-item is-${step.status}`}>
              <span className="agent-trace-icon" aria-hidden="true">
                {step.status === 'running' ? (
                  <Spinner size="extra-tiny" />
                ) : step.status === 'done' ? (
                  <CheckCircleIcon weight="fill" />
                ) : (
                  <WarningCircleIcon weight="fill" />
                )}
              </span>
              <div className="agent-trace-main">
                <div className="agent-trace-row">
                  <strong className="agent-trace-label">{step.label}</strong>
                  <span className={`agent-trace-mode ${step.mode}`}>
                    {step.mode === 'read' ? '只读查询' : '行动提案'}
                  </span>
                  {typeof step.durationMs === 'number' && (
                    <span className="agent-trace-ms">{step.durationMs}ms</span>
                  )}
                </div>
                {step.argsSummary && (
                  <div className="agent-trace-meta">参数：{step.argsSummary}</div>
                )}
                {step.resultSummary && (
                  <div className="agent-trace-result">{step.resultSummary}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
