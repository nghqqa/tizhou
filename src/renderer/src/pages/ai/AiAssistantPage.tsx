import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Spinner, Textarea } from '@fluentui/react-components'
import {
  ChatCircleTextIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  SparkleIcon,
  StopIcon,
  TrashIcon
} from '@phosphor-icons/react'
import type { AiConversation, AiMessage, Question } from '@shared/contracts'
import { FEATURE_PROMPTS } from '@shared/prompts'
import { formatDate, invoke } from '../../api'
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
import { buildQuestionContextPrompt, canUseModel } from './shared'

export function AiPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedQuestionId = searchParams.get('questionId') ?? ''
  const ai = useAppStore((state) => state.data!.ai)
  const showToast = useAppStore((state) => state.showToast)
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const activeConvIdRef = useRef<string | undefined>(activeConvId)
  const streamCancelRef = useRef<(() => void) | null>(null)
  activeConvIdRef.current = activeConvId

  useEffect(() => {
    return () => {
      streamCancelRef.current?.()
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
          setActiveConvId(latest.id)
          setActiveTitle(latest.title)
          setMessages(latest.messages)
          if (latest.questionId) {
            void invoke<Question | undefined>({
              method: 'questions.get',
              params: { id: latest.questionId }
            })
              .then((q) => {
                if (!cancelled) setContextQuestion(q ?? null)
              })
              .catch(() => {
                if (!cancelled) setContextQuestion(null)
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
  }, [messages, busy, streamingText])

  function handleMessagesScroll(): void {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
  }

  function startNewConversation(): void {
    if (busy) return
    stickToBottomRef.current = true
    setActiveConvId(undefined)
    setActiveTitle('新对话')
    setMessages([])
    setContextQuestion(null)
    setShowContextDetail(false)
    setError('')
  }

  function selectConversation(conv: AiConversation): void {
    if (busy) return
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
    if (!pendingDeleteConv || busy) return
    setDeleteBusy(true)
    try {
      await invoke({ method: 'ai.conversations.delete', params: { id: pendingDeleteConv.id } })
      setConversations((prev) => prev.filter((item) => item.id !== pendingDeleteConv.id))
      if (activeConvId === pendingDeleteConv.id) {
        startNewConversation()
      }
      setPendingDeleteConv(null)
      showToast('已删除对话记录')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除对话失败')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function send(): Promise<void> {
    const content = input.trim()
    if (!content || busy) return
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
    setError('')
    try {
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
          messages: [...systemMessages, ...next]
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 请求失败')
    } finally {
      streamCancelRef.current = null
      setStreamingText('')
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="提升 · AI 助教"
        title="AI 助教"
        description="会话自动持久化到本地数据库，支持多轮追问与从刷题/错题页直接带题进入讨论。"
        actions={
          <span className="pill">
            <StatusDot status={ai.verified ? 'ok' : ai.hasApiKey ? 'warning' : 'neutral'} />{' '}
            {ai.model}
          </span>
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
                disabled={busy}
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
                      {contextQuestion ? '已载入原题背景，直接开始追问' : '从一道具体问题开始'}
                    </h3>
                    <p>可以让我解释错题、比较方法，或把知识点整理成复习清单。</p>
                    <div className="button-row">
                      <Button
                        onClick={() =>
                          setInput(
                            contextQuestion
                              ? '为什么正确选项优于最容易混淆的干扰项？'
                              : '请帮我总结资料分析中增长率题目的常见陷阱。'
                          )
                        }
                      >
                        {contextQuestion ? '对比干扰项' : '增长率陷阱'}
                      </Button>
                      <Button
                        onClick={() =>
                          setInput(
                            contextQuestion
                              ? '把这道题背后的考点和同类秒杀思路总结成 3 条口诀。'
                              : '如何区分言语理解中的主旨项和对策项？'
                          )
                        }
                      >
                        {contextQuestion ? '提炼解题口诀' : '主旨与对策'}
                      </Button>
                    </div>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
                    {message.role === 'assistant' ? (
                      <MarkdownContent content={message.content} />
                    ) : (
                      message.content
                    )}
                  </div>
                ))}
                {busy &&
                  (streamingText ? (
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
                    disabled={!input.trim()}
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
    </div>
  )
}
