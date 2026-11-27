import { randomUUID } from 'node:crypto'
import type {
  AgentActionExecuteResult,
  AgentActionProposal,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolStep
} from '../../shared/contracts'
import { FEATURE_PROMPTS, basePromptForPurpose, taskDataEnvelope } from '../../shared/prompts'
import {
  AGENT_TOOLS,
  executeAgentTool,
  executeApprovedAction,
  getAgentToolMeta,
  summarizeToolArgs
} from './agent-tools'
import { type AiService, type ToolTurnMessage, ToolsUnsupportedError } from './ai'
import type { DatabaseService } from './database'
import type { StudyService } from './study'

const MAX_AGENT_STEPS = 6
const MAX_TOOL_OUTPUT_CHARS = 4000

function buildFallbackToolGuide(): string {
  const schemaLines = AGENT_TOOLS.map(
    (t) =>
      `- ${t.definition.name}（${t.mode === 'read' ? '只读' : '待审批提案'}）：${t.definition.description} 参数 JSON Schema: ${JSON.stringify(t.definition.parameters)}`
  ).join('\n')
  return [
    '## 工具调用降级协议（当前模型未开启原生函数调用，请按如下 XML 标签输出调用）',
    '如需调用工具，请在回复中仅输出一个或多个如下块（勿在未拿到工具结果前编造结果）：',
    '<tool_call>{"name":"工具名","arguments":{...}}</tool_call>',
    '如果无需再调用工具，请直接用简体中文输出最终答复，不要包含 <tool_call> 标签。',
    '可用工具清单：',
    schemaLines
  ].join('\n')
}

function truncateToolOutput(raw: string): string {
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) return raw
  return `${raw.slice(0, MAX_TOOL_OUTPUT_CHARS)}...(已截断，请缩小筛选范围)`
}

export class AgentRuntime {
  private readonly cancelledIds = new Set<string>()
  private readonly database: DatabaseService
  private readonly study: StudyService
  private readonly ai: AiService

  constructor(database: DatabaseService, study: StudyService, ai: AiService) {
    this.database = database
    this.study = study
    this.ai = ai
  }

  cancel(requestId: string): boolean {
    if (!requestId) return false
    this.cancelledIds.add(requestId)
    return this.ai.cancelStream(requestId)
  }

  executeAction(proposal: AgentActionProposal): AgentActionExecuteResult {
    return executeApprovedAction(proposal, {
      database: this.database,
      study: this.study
    })
  }

  async run(
    input: AgentRunInput,
    emit: (event: AgentStreamEvent) => void
  ): Promise<AgentRunResult> {
    const { requestId } = input
    const toolSteps: AgentToolStep[] = []
    const proposals: AgentActionProposal[] = []
    const nativeDefinitions = AGENT_TOOLS.map((item) => item.definition)

    const systemParts: string[] = [
      `${basePromptForPurpose('chat')}\n\n${FEATURE_PROMPTS.agentCoach}`
    ]

    const memories = this.database.listLearnerMemories(true).slice(0, 12)
    if (memories.length > 0) {
      systemParts.push(
        `以下是本机已启用的考生长期学习记忆，请在诊断与规划时优先参考：\n${taskDataEnvelope(
          '考生长期学习记忆',
          memories.map((m) => ({
            category: m.category,
            content: m.content,
            evidence: m.evidence || undefined
          }))
        )}`
      )
    }

    if (input.questionId) {
      const question = this.database.getQuestion(input.questionId)
      if (question) {
        systemParts.push(
          `用户当前携带原题发起对话，相关原题数据如下：\n${taskDataEnvelope('当前讨论原题', {
            id: question.id,
            subject: question.subject,
            category: question.category,
            type: question.type,
            material: question.material,
            stem: question.stem,
            options: question.options,
            answer: question.answer,
            explanation: question.explanation
          })}`
        )
      }
    }

    const baseMessages: ToolTurnMessage[] = [
      { role: 'system', content: systemParts.join('\n\n') },
      ...input.messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
    ]

    let fallbackMode = false
    let messages: ToolTurnMessage[] = [...baseMessages]
    let lastProvider = ''
    let lastModel = ''
    let finalContent = ''
    let completedWithoutTools = false

    const buildAbortedResult = (): AgentRunResult => {
      emit({
        requestId,
        type: 'aborted',
        content: finalContent,
        toolSteps,
        proposals
      })
      return {
        content: finalContent,
        toolSteps,
        proposals,
        provider: lastProvider,
        model: lastModel,
        aborted: true
      }
    }

    try {
      for (let round = 0; round < MAX_AGENT_STEPS; round += 1) {
        if (this.cancelledIds.has(requestId)) {
          return buildAbortedResult()
        }
        emit({
          requestId,
          type: 'status',
          text:
            round === 0
              ? '正在分析意图并检查本机数据…'
              : `正在汇总工具结果并推理下一步（第 ${round + 1} 轮）…`
        })

        let turn
        try {
          turn = await this.ai.askToolTurn(
            fallbackMode
              ? [
                  {
                    role: 'system',
                    content: `${messages[0]!.content}\n\n${buildFallbackToolGuide()}`
                  },
                  ...messages.slice(1)
                ]
              : messages,
            fallbackMode ? [] : nativeDefinitions,
            { requestId, timeoutMs: 90_000 }
          )
        } catch (err) {
          if (!fallbackMode && round === 0 && err instanceof ToolsUnsupportedError) {
            fallbackMode = true
            emit({
              requestId,
              type: 'status',
              text: '当前端点不支持原生工具参数，已切换文本工具协议重试…'
            })
            turn = await this.ai.askToolTurn(
              [
                {
                  role: 'system',
                  content: `${messages[0]!.content}\n\n${buildFallbackToolGuide()}`
                },
                ...messages.slice(1)
              ],
              [],
              { requestId, timeoutMs: 90_000 }
            )
          } else {
            throw err
          }
        }

        lastProvider = turn.provider
        lastModel = turn.model

        if (turn.aborted || this.cancelledIds.has(requestId)) {
          return buildAbortedResult()
        }

        if (turn.toolCalls.length === 0) {
          completedWithoutTools = true
          finalContent = turn.content.trim()
          break
        }

        if (turn.fromFallback && !fallbackMode) {
          // 原生请求下模型改用 <tool_call> 文本协议时切换为文本回传模式，避免将伪造 id 塞入 role: 'tool' 触发 400
          fallbackMode = true
        }

        if (!fallbackMode) {
          messages.push({
            role: 'assistant',
            content: turn.content,
            ...(turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : {}),
            toolCalls: turn.toolCalls
          })
        } else {
          messages.push({
            role: 'assistant',
            content: turn.toolCalls
              .map(
                (c) =>
                  `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>`
              )
              .join('\n')
          })
        }

        const fallbackResults: string[] = []
        for (const call of turn.toolCalls) {
          if (this.cancelledIds.has(requestId)) {
            return buildAbortedResult()
          }
          const meta = getAgentToolMeta(call.name)
          const step: AgentToolStep = {
            id: randomUUID(),
            toolName: call.name,
            label: meta?.label ?? call.name,
            mode: meta?.mode ?? 'read',
            argsSummary: summarizeToolArgs(call.arguments),
            status: 'running'
          }
          toolSteps.push(step)
          emit({ requestId, type: 'tool_start', step: { ...step } })

          const started = Date.now()
          const outcome = executeAgentTool(call.name, call.arguments, {
            database: this.database,
            study: this.study
          })
          step.durationMs = Math.max(1, Date.now() - started)
          step.status = outcome.ok ? 'done' : 'error'
          step.resultSummary = outcome.summary
          emit({ requestId, type: 'tool_result', step: { ...step } })

          if (outcome.proposal) {
            proposals.push(outcome.proposal)
            emit({ requestId, type: 'proposal', proposal: { ...outcome.proposal } })
          }

          const truncated = truncateToolOutput(outcome.outputJson)
          if (!fallbackMode) {
            messages.push({
              role: 'tool',
              content: truncated,
              toolCallId: call.id,
              toolName: call.name
            })
          } else {
            fallbackResults.push(`<tool_result name="${call.name}">\n${truncated}\n</tool_result>`)
          }
        }

        if (fallbackMode && fallbackResults.length > 0) {
          messages.push({
            role: 'user',
            content: `${fallbackResults.join('\n\n')}\n\n请基于以上工具返回的真实数据继续处理或给出最终答复。`
          })
        }
      }

      if (
        completedWithoutTools &&
        !finalContent &&
        toolSteps.length === 0 &&
        proposals.length === 0
      ) {
        throw new Error('模型返回了空内容，请检查模型配置或重试')
      }

      if (!finalContent && !this.cancelledIds.has(requestId)) {
        emit({ requestId, type: 'status', text: '正在整理最终答复…' })
        const closingInstruction =
          '请综合上述已查证数据与已生成的提案卡片，直接给出简洁清晰的最终回复，不要再调用工具。'
        const lastMsg = messages[messages.length - 1]
        const closingMessages: ToolTurnMessage[] =
          lastMsg?.role === 'user'
            ? [
                ...messages.slice(0, -1),
                { ...lastMsg, content: `${lastMsg.content}\n\n${closingInstruction}` }
              ]
            : [...messages, { role: 'user', content: closingInstruction }]
        const closingTurn = await this.ai.askToolTurn(
          closingMessages,
          fallbackMode ? [] : nativeDefinitions,
          { requestId, timeoutMs: 90_000, ...(fallbackMode ? {} : { toolChoice: 'none' }) }
        )
        lastProvider = closingTurn.provider
        lastModel = closingTurn.model
        if (closingTurn.aborted || this.cancelledIds.has(requestId)) {
          return buildAbortedResult()
        }
        finalContent = closingTurn.content.trim()
      }

      if (!finalContent) {
        finalContent =
          proposals.length > 0
            ? '已完成数据核查并为你准备了可执行的操作提案，请确认后点击卡片执行。'
            : '已完成本地数据查询。'
      }

      emit({ requestId, type: 'chunk', delta: finalContent })
      emit({
        requestId,
        type: 'done',
        content: finalContent,
        toolSteps,
        proposals
      })
      return {
        content: finalContent,
        toolSteps,
        proposals,
        provider: lastProvider,
        model: lastModel
      }
    } catch (error) {
      if (this.cancelledIds.has(requestId)) {
        return buildAbortedResult()
      }
      const message = error instanceof Error ? error.message : String(error)
      emit({ requestId, type: 'error', error: message })
      throw error
    } finally {
      this.cancelledIds.delete(requestId)
    }
  }
}
