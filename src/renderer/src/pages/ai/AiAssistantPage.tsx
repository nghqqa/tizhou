import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Spinner, Switch, Textarea } from '@fluentui/react-components'
import {
  BrainIcon,
  ChatCircleTextIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  SparkleIcon,
  StopIcon,
  TrashIcon
} from '@phosphor-icons/react'
import type {
  AgentActionExecuteResult,
  AgentActionProposal,
  AgentToolStep,
  AiConversation,
  AiMessage,
  LearnerMemory,
  Question
} from '@shared/contracts'
import { FEATURE_PROMPTS } from '@shared/prompts'
import { formatDate, invoke } from '../../api'
import { cancelAgentRun, runAgentChat } from '../../services/agent-stream'
import { streamAiAsk } from '../../services/ai-stream'
import { MarkdownContent } from '../../components/MarkdownContent'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  StatusDot
} from '../../components/ui'
import { useAppStore } from '../../store'
import { AgentProposalCard } from './AgentProposalCard'
import { AgentTraceBlock } from './AgentTraceBlock'
import { LearnerMemoryDrawer } from './LearnerMemoryDrawer'
import { buildQuestionContextPrompt, canUseModel } from './shared'

export function AiPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedQuestionId = searchParams.get('questionId') ?? ''
  const ai = useAppStore((state) => state.data!.ai)
  const showToast = useAppStore((state) => state.showToast)
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | undefined>(undefined)
  const [activeTitle, setActiveTitle] = useState('新对话')
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [contextQuestion, setContextQuestion] = useState<Question | null>(null)
  const [showContextDetail, setShowContextDetail] = useState(false)
  const [pendingDeleteConv, setPendingDeleteConv] = useState<AiConversation | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState('')
  const [agentMode, setAgentMode] = useState(true)
  const [memoryDrawerOpen, setMemoryDrawerOpen] = useState(false)
  const [memoryCount, setMemoryCount] = useState(0)
  const [liveStatus, setLiveStatus] = useState('')
  const [liveSteps, setLiveSteps] = useState<AgentToolStep[]>([])
  const [liveProposals, setLiveProposals] = useState<AgentActionProposal[]>([])
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const activeConvIdRef = useRef<string | undefined>(activeConvId)
  const messagesRefData = useRef<AiMessage[]>(messages)
  const streamCancelRef = useRef<(() => void) | null>(null)
  activeConvIdRef.current = activeConvId
  messagesRefData.current = messages
  const actionLocked = busy || Boolean(proposalBusyId)

  useEffect(() => {
    return () => {
      streamCancelRef.current?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void invoke<LearnerMemory[]>({ method: 'memory.list', params: { onlyEnabled: true } })
      .then((list) => {
        if (!cancelled) setMemoryCount(list.length)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 挂载时加载本地持久化历史会话（未指定带题追问时自动恢复最近一次对话）
  useEffect(() => {
    let cancelled = false
    void invoke<AiConversation[]>({ method: 'ai.conversations.list', params: { limit: 50 } })
      .then((list) => {
        if (cancelled) return
        setConversations(list)
        if (!requestedQuestionId && list[0]) {
          const latest = list[0]
          activeConvIdRef.current = latest.id
          setActiveConvId(latest.id)
          setActiveTitle(latest.title)
          setMessages(latest.messages)
          if (latest.questionId) {
            void invoke<Question | undefined>({
              method: 'questions.get',
              params: { id: latest.questionId }
            })
              .then((q) => {
                if (!cancelled && activeConvIdRef.current === latest.id) {
                  setContextQuestion(q ?? null)
                }
              })
              .catch(() => {
                if (!cancelled && activeConvIdRef.current === latest.id) {
                  setContextQuestion(null)
                }
              })
          }
        }
      })
      .catch(() => {
        /* 历史加载失败不阻塞新对话 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 响应从练习页 / 错题本 / 模考复盘页带入的 ?questionId=xxx
  useEffect(() => {
    if (!requestedQuestionId) return
    let cancelled = false
    void invoke<Question | undefined>({
      method: 'questions.get',
      params: { id: requestedQuestionId }
    })
      .then((q) => {
        if (cancelled || !q) return
        setActiveConvId(undefined)
        const snippet = q.stem.replace(/\s+/g, ' ').trim().slice(0, 22)
        setActiveTitle(`${q.category} · ${snippet || '带题追问'}`)
        setMessages([])
        setContextQuestion(q)
        setShowContextDetail(true)
        setInput('请帮我拆解这道题的解题思路和最容易掉进去的干扰项陷阱。')
        setSearchParams({}, { replace: true })
      })
      .catch(() => {
        /* 忽略加载失败 */
      })
    return () => {
      cancelled = true
    }
  }, [requestedQuestionId, setSearchParams])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: streamingText ? 'auto' : 'smooth' })
  }, [messages, busy, streamingText, liveSteps, liveProposals])

  function handleMessagesScroll(): void {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
  }

  function startNewConversation(): void {
    if (actionLocked) return
    stickToBottomRef.current = true
    setActiveConvId(undefined)
    setActiveTitle('新对话')
    setMessages([])
    setContextQuestion(null)
    setShowContextDetail(false)
    setError('')
  }

  function selectConversation(conv: AiConversation): void {
    if (actionLocked) return
    stickToBottomRef.current = true
    setActiveConvId(conv.id)
    setActiveTitle(conv.title)
    setMessages(conv.messages)
    setError('')
    setShowContextDetail(false)
    // 切换会话时立即清空上一会话的原题背景，避免异步拉取期间旧题上下文串入新会话
    setContextQuestion(null)
    if (conv.questionId) {
      void invoke<Question | undefined>({
        method: 'questions.get',
        params: { id: conv.questionId }
      })
        .then((q) => {
          if (activeConvIdRef.current === conv.id) setContextQuestion(q ?? null)
        })
        .catch(() => {
          if (activeConvIdRef.current === conv.id) setContextQuestion(null)
        })
    }
  }

  async function confirmRemoveConversation(): Promise<void> {
    if (!pendingDeleteConv || actionLocked) return
    setDeleteBusy(true)
    try {
      await invoke({ method: 'ai.conversations.delete', params: { id: pendingDeleteConv.id } })
      setConversations((prev) => prev.filter((item) => item.id !== pendingDeleteConv.id))
      if (activeConvId === pendingDeleteConv.id) {
        stickToBottomRef.current = true
        setActiveConvId(undefined)
        setActiveTitle('新对话')
        setMessages([])
        setContextQuestion(null)
        setShowContextDetail(false)
        setError('')
      }
      setPendingDeleteConv(null)
      showToast('已删除对话记录')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除对话失败')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function persistUpdatedMessages(
    updated: AiMessage[],
    target: { id?: string; title: string; questionId?: string }
  ): Promise<void> {
    if (!target.id) return
    const saved = await invoke<AiConversation>({
      method: 'ai.conversations.save',
      params: {
        id: target.id,
        title: target.title,
        questionId: target.questionId,
        messages: updated
      }
    })
    setConversations((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)])
  }

  async function handleApproveProposal(
    messageIndex: number,
    proposal: AgentActionProposal
  ): Promise<void> {
    if (actionLocked) return
    const targetMeta = {
      id: activeConvIdRef.current,
      title: activeTitle,
      questionId: contextQuestion?.id
    }
    setProposalBusyId(proposal.id)
    try {
      const res = await invoke<AgentActionExecuteResult>({
        method: 'agent.action.execute',
        params: { proposal }
      })
      const updated = messagesRefData.current.map((msg, idx) => {
        if (idx !== messageIndex || !msg.proposals) return msg
        return {
          ...msg,
          proposals: msg.proposals.map((p) =>
            p.id === proposal.id
              ? {
                  ...p,
                  status: 'approved' as const,
                  resultMessage: res.message,
                  navigateTo: res.navigateTo
                }
              : p
          )
        }
      })
      if (activeConvIdRef.current === targetMeta.id) {
        messagesRefData.current = updated
        setMessages(updated)
      }
      await persistUpdatedMessages(updated, targetMeta).catch(() => {
        showToast('操作已执行生效，但同步对话历史失败')
      })
      showToast(res.message)
      void refreshDashboard()
      if (res.savedMemory) {
        void invoke<LearnerMemory[]>({ method: 'memory.list', params: { onlyEnabled: true } })
          .then((list) => setMemoryCount(list.length))
          .catch(() => {})
      }
    } catch (cause) {
      const errMessage = cause instanceof Error ? cause.message : '操作执行失败'
      const updated = messagesRefData.current.map((msg, idx) => {
        if (idx !== messageIndex || !msg.proposals) return msg
        return {
          ...msg,
          proposals: msg.proposals.map((p) =>
            p.id === proposal.id ? { ...p, status: 'error' as const, resultMessage: errMessage } : p
          )
        }
      })
      if (activeConvIdRef.current === targetMeta.id) {
        messagesRefData.current = updated
        setMessages(updated)
      }
      await persistUpdatedMessages(updated, targetMeta).catch(() => {})
      showToast(errMessage)
    } finally {
      setProposalBusyId(null)
    }
  }

  async function handleDismissProposal(
    messageIndex: number,
    proposal: AgentActionProposal
  ): Promise<void> {
    if (actionLocked) return
    const targetMeta = {
      id: activeConvIdRef.current,
      title: activeTitle,
      questionId: contextQuestion?.id
    }
    setProposalBusyId(proposal.id)
    try {
      const updated = messagesRefData.current.map((msg, idx) => {
        if (idx !== messageIndex || !msg.proposals) return msg
        return {
          ...msg,
          proposals: msg.proposals.map((p) =>
            p.id === proposal.id ? { ...p, status: 'rejected' as const } : p
          )
        }
      })
      messagesRefData.current = updated
      setMessages(updated)
      await persistUpdatedMessages(updated, targetMeta).catch(() => {})
    } finally {
      setProposalBusyId(null)
    }
  }

  async function send(): Promise<void> {
    const content = input.trim()
    if (!content || actionLocked) return
    const prevMessages = messages
    const userMessage: AiMessage = { role: 'user', content }
    const next = [...messages, userMessage]
    const convTitle =
      messages.length === 0 && activeTitle === '新对话' ? content.slice(0, 28) : activeTitle
    stickToBottomRef.current = true
    setMessages(next)
    setActiveTitle(convTitle)
    setInput('')
    setBusy(true)
    setStreamingText('')
    setLiveStatus('')
    setLiveSteps([])
    setLiveProposals([])
    setError('')
    try {
      if (agentMode) {
        const requestId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        streamCancelRef.current = () => {
          void cancelAgentRun(requestId)
        }
        const { result } = await runAgentChat(
          {
            requestId,
            questionId: contextQuestion?.id,
            messages: next
              .filter(
                (m): m is AiMessage & { role: 'user' | 'assistant' } =>
                  m.role === 'user' || m.role === 'assistant'
              )
              .map((m) => ({ role: m.role, content: m.content }))
          },
          {
            onStatus: (text) => setLiveStatus(text),
            onToolStart: (step) => setLiveSteps((prev) => [...prev, step]),
            onToolResult: (step) =>
              setLiveSteps((prev) =>
                prev.some((s) => s.id === step.id)
                  ? prev.map((s) => (s.id === step.id ? step : s))
                  : [...prev, step]
              ),
            onProposal: (proposal) => setLiveProposals((prev) => [...prev, proposal]),
            onDelta: (delta) => setStreamingText((prev) => prev + delta)
          }
        )
        if (
          result.aborted &&
          !result.content.trim() &&
          result.toolSteps.length === 0 &&
          result.proposals.length === 0
        ) {
          setMessages(prevMessages)
          setInput(content)
          showToast('已停止生成')
          return
        }
        const baseText = result.content.trim()
        const finalContent = result.aborted
          ? `${baseText || '已中止本轮分析。'}\n\n*(已停止生成)*`
          : baseText ||
            (result.proposals.length > 0
              ? '已完成数据核查并生成下方操作提案，请确认后点击执行。'
              : '已完成本机数据查询。')
        const assistantMessage: AiMessage = {
          role: 'assistant',
          content: finalContent,
          ...(result.toolSteps.length > 0 ? { toolSteps: result.toolSteps } : {}),
          ...(result.proposals.length > 0 ? { proposals: result.proposals } : {})
        }
        const completed: AiMessage[] = [...next, assistantMessage]
        setMessages(completed)
        const saved = await invoke<AiConversation>({
          method: 'ai.conversations.save',
          params: {
            id: activeConvId,
            title: convTitle,
            questionId: contextQuestion?.id,
            messages: completed
          }
        })
        setActiveConvId(saved.id)
        setConversations((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)])
      } else {
        const systemMessages: AiMessage[] = [{ role: 'system', content: FEATURE_PROMPTS.chat }]
        if (contextQuestion) {
          systemMessages.push({
            role: 'system',
            content: `用户正在围绕以下真题向你追问，请结合题干、选项、参考答案与解析精准作答：\n\n${buildQuestionContextPrompt(contextQuestion)}`
          })
        }
        const handle = streamAiAsk(
          {
            purpose: 'chat',
            messages: [
              ...systemMessages,
              ...next.map((m) => ({ role: m.role, content: m.content }))
            ]
          },
          (accumulated) => {
            setStreamingText(accumulated)
          }
        )
        streamCancelRef.current = handle.cancel
        const response = await handle.promise
        if (response.aborted && !response.content.trim()) {
          setMessages(prevMessages)
          setInput(content)
          showToast('已停止生成')
          return
        }
        const finalContent = response.aborted
          ? `${response.content}\n\n*(已停止生成)*`
          : response.content
        if (finalContent) {
          const completed: AiMessage[] = [...next, { role: 'assistant', content: finalContent }]
          setMessages(completed)
          const saved = await invoke<AiConversation>({
            method: 'ai.conversations.save',
            params: {
              id: activeConvId,
              title: convTitle,
              questionId: contextQuestion?.id,
              messages: completed
            }
          })
          setActiveConvId(saved.id)
          setConversations((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)])
        }
      }
    } catch (cause) {
      setMessages(prevMessages)
      setInput(content)
      setError(cause instanceof Error ? cause.message : 'AI 请求失败')
    } finally {
      streamCancelRef.current = null
      setStreamingText('')
      setLiveStatus('')
      setLiveSteps([])
      setLiveProposals([])
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="提升 · AI 助教"
        title="AI 助教"
        description={
          agentMode
            ? '可自主查库分析错题与模考数据、结合本机长期学习记忆，并生成待你确认的一键行动提案。'
            : '会话自动持久化到本地数据库，支持多轮追问与从刷题/错题页直接带题进入讨论。'
        }
        actions={
          <div className="agent-header-controls">
            <span className={`agent-mode-pill${agentMode ? ' is-agent' : ''}`}>
              <Switch
                checked={agentMode}
                disabled={actionLocked}
                label={agentMode ? '备考规划模式' : '纯问答模式'}
                onChange={(_e, data) => setAgentMode(data.checked)}
              />
            </span>
            <Button
              appearance="outline"
              size="small"
              icon={<BrainIcon />}
              onClick={() => setMemoryDrawerOpen(true)}
            >
              学习记忆 ({memoryCount})
            </Button>
            <span className="pill">
              <StatusDot status={ai.verified ? 'ok' : ai.hasApiKey ? 'warning' : 'neutral'} />{' '}
              {ai.model}
            </span>
          </div>
        }
      />
      {!canUseModel(ai) ? (
        <EmptyState
          title="先配置模型凭据"
          description="本地训练、复习与报告无需 AI。要使用助教和变式训练，请在模型设置中单独保存 API Key。"
          actionLabel="前往模型设置"
          onAction={() => navigate('/model-settings')}
        />
      ) : (
        <>
          {error && <ErrorState message={error} />}
          <div className="ai-chat-layout">
            <aside className="ai-conv-sidebar">
              <Button
                appearance="primary"
                size="small"
                icon={<PlusIcon />}
                disabled={actionLocked}
                onClick={startNewConversation}
              >
                新建对话
              </Button>
              <div className="ai-conv-list">
                {conversations.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12, margin: '8px 4px' }}>
                    发送第一条消息后自动保存历史记录。
                  </p>
                ) : (
                  conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`ai-conv-item${conv.id === activeConvId ? ' is-active' : ''}`}
                    >
                      <button
                        type="button"
                        className="ai-conv-select"
                        disabled={actionLocked}
                        onClick={() => selectConversation(conv)}
                      >
                        <ChatCircleTextIcon size={14} className="muted" />
                        <div className="ai-conv-item-text">
                          <strong>{conv.title}</strong>
                          <small>
                            {conv.messages.length} 条 · {formatDate(conv.updatedAt)}
                          </small>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ai-conv-del"
                        disabled={actionLocked}
                        aria-label="删除对话"
                        title="删除对话"
                        onClick={() => setPendingDeleteConv(conv)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </aside>
            <Section className="chat-shell">
              {contextQuestion && (
                <div className="ai-context-card">
                  <div className="ai-context-head">
                    <span>
                      <strong>关联原题</strong> · {contextQuestion.category}
                      {contextQuestion.year ? ` (${contextQuestion.year})` : ''}
                    </span>
                    <div className="button-row">
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => setShowContextDetail((v) => !v)}
                      >
                        {showContextDetail ? '收起题面' : '展开题面'}
                      </Button>
                      {!activeConvId && (
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={() => setContextQuestion(null)}
                        >
                          取消关联
                        </Button>
                      )}
                    </div>
                  </div>
                  {showContextDetail && (
                    <div className="ai-context-body">
                      {contextQuestion.material && (
                        <div className="ai-context-material">
                          <strong>给定材料</strong>
                          <MarkdownContent
                            content={contextQuestion.material}
                            sourceFilePath={contextQuestion.filePath}
                          />
                        </div>
                      )}
                      <MarkdownContent
                        content={contextQuestion.stem}
                        sourceFilePath={contextQuestion.filePath}
                      />
                      {contextQuestion.options.length > 0 && (
                        <ul className="ai-context-options">
                          {contextQuestion.options.map((opt) => (
                            <li key={opt.key}>
                              <strong>{opt.key}.</strong> {opt.text}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                        参考答案：{contextQuestion.answer.join('、') || '见解析'}
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
                {!messages.length && (
                  <div className="empty-state">
                    <SparkleIcon size={30} className="accent" />
                    <h3>
                      {contextQuestion
                        ? '已载入原题背景，直接开始追问'
                        : agentMode
                          ? '告诉我备考目标，我先查数据再给你方案'
                          : '从一道具体问题开始'}
                    </h3>
                    <p>
                      {agentMode
                        ? '开启备考规划模式后，我会按需检索本机错题、模考耗时、笔记与学习记忆，操作写入均需你确认执行。'
                        : '可以让我解释错题、比较方法，或把知识点整理成复习清单。'}
                    </p>
                    <div className="button-row">
                      {contextQuestion ? (
                        <>
                          <Button
                            onClick={() => setInput('为什么正确选项优于最容易混淆的干扰项？')}
                          >
                            对比干扰项
                          </Button>
                          <Button
                            onClick={() =>
                              setInput('把这道题背后的考点和同类秒杀思路总结成 3 条口诀。')
                            }
                          >
                            提炼解题口诀
                          </Button>
                          {agentMode && (
                            <Button
                              onClick={() =>
                                setInput(
                                  '请把这道题加入间隔复习队列，并把关键避坑点整理成笔记和长期记忆提案。'
                                )
                              }
                            >
                              加入复习并记错因
                            </Button>
                          )}
                        </>
                      ) : agentMode ? (
                        <>
                          <Button
                            onClick={() =>
                              setInput(
                                '请盘点我最近的刷题正确率与错题分布，针对最薄弱的 1~2 个模块直接为我准备一组专项训练提案。'
                              )
                            }
                          >
                            盘点薄弱模块并开练
                          </Button>
                          <Button
                            onClick={() =>
                              setInput(
                                '帮我调取最近一次模拟考试记录，分析各模块耗时与超时失分的题目，给出复盘建议和训练提案。'
                              )
                            }
                          >
                            复盘近期模考耗时
                          </Button>
                          <Button
                            onClick={() =>
                              setInput(
                                '检索我近期的典型错题并总结共性错因，帮我生成长期学习记忆提案以便后续长期参考。'
                              )
                            }
                          >
                            沉淀错因到学习记忆
                          </Button>
                          <Button
                            onClick={() =>
                              setInput(
                                '结合我当前距离考试的天数和薄弱项，按每天 60 分钟为我规划一份 7 天冲刺计划提案。'
                              )
                            }
                          >
                            制定 7 天提分计划
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            onClick={() => setInput('请帮我总结资料分析中增长率题目的常见陷阱。')}
                          >
                            增长率陷阱
                          </Button>
                          <Button onClick={() => setInput('如何区分言语理解中的主旨项和对策项？')}>
                            主旨与对策
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
                    {message.role === 'assistant' ? (
                      <>
                        {message.toolSteps && message.toolSteps.length > 0 && (
                          <AgentTraceBlock steps={message.toolSteps} />
                        )}
                        <MarkdownContent content={message.content} />
                        {message.proposals && message.proposals.length > 0 && (
                          <div className="agent-proposals-stack">
                            {message.proposals.map((proposal) => (
                              <AgentProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                busy={actionLocked}
                                onApprove={(item) => void handleApproveProposal(index, item)}
                                onDismiss={(item) => void handleDismissProposal(index, item)}
                                onNavigate={(path) => navigate(path)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      message.content
                    )}
                  </div>
                ))}
                {busy &&
                  (agentMode ? (
                    <div className="chat-message assistant is-streaming">
                      <AgentTraceBlock
                        running
                        statusText={liveStatus || '正在规划本地数据核查…'}
                        steps={liveSteps}
                      />
                      {streamingText ? (
                        <MarkdownContent content={streamingText} />
                      ) : (
                        !liveSteps.length && (
                          <div className="ai-stream-status">
                            <Spinner size="tiny" label={liveStatus || '助教正在分析请求…'} />
                          </div>
                        )
                      )}
                      {liveProposals.length > 0 && (
                        <div className="agent-proposals-stack">
                          {liveProposals.map((proposal) => (
                            <AgentProposalCard
                              key={proposal.id}
                              proposal={proposal}
                              busy
                              onApprove={() => {}}
                              onDismiss={() => {}}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ) : streamingText ? (
                    <div className="chat-message assistant is-streaming">
                      <MarkdownContent content={streamingText} />
                      <div className="ai-stream-status">
                        <span className="ai-stream-cursor" aria-hidden="true" />
                        <span>正在生成…</span>
                      </div>
                    </div>
                  ) : (
                    <div className="chat-message">
                      <Spinner size="tiny" label="助教正在思考…" />
                    </div>
                  ))}
                <div ref={bottomRef} />
              </div>
              <div className="chat-compose">
                <Textarea
                  value={input}
                  resize="none"
                  placeholder="输入你的学习问题，Ctrl+Enter / ⌘+Enter 发送"
                  onChange={(_, data) => setInput(data.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                />
                {busy ? (
                  <Button
                    appearance="secondary"
                    icon={<StopIcon weight="fill" />}
                    onClick={() => streamCancelRef.current?.()}
                  >
                    停止生成
                  </Button>
                ) : (
                  <Button
                    appearance="primary"
                    icon={<PaperPlaneTiltIcon />}
                    disabled={!input.trim() || actionLocked}
                    onClick={() => void send()}
                  >
                    发送
                  </Button>
                )}
              </div>
            </Section>
          </div>
          <ConfirmDialog
            open={Boolean(pendingDeleteConv)}
            title="删除历史对话？"
            description={`确认删除对话「${pendingDeleteConv?.title ?? ''}」？删除后无法恢复。`}
            confirmLabel="确认删除"
            danger
            busy={deleteBusy}
            onCancel={() => setPendingDeleteConv(null)}
            onConfirm={() => void confirmRemoveConversation()}
          />
        </>
      )}
      <LearnerMemoryDrawer
        open={memoryDrawerOpen}
        onClose={() => setMemoryDrawerOpen(false)}
        onChanged={(list) => setMemoryCount(list.filter((m) => m.enabled).length)}
      />
    </div>
  )
}
