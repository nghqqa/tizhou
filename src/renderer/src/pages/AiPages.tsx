import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Field,
  Input,
  Select,
  Slider,
  Spinner,
  Switch,
  Textarea
} from '@fluentui/react-components'
import {
  ArrowRightIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  WarningCircleIcon
} from '@phosphor-icons/react'
import type {
  AiAskResult,
  AiConfigInput,
  AiConfigView,
  AiConversation,
  AiMessage,
  AiProviderInfo,
  AiTrainingRecord,
  Question,
  QuestionOption,
  VlmConfigInput,
  VlmConfigView
} from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MarkdownContent } from '../components/MarkdownContent'
import { formatDate, formatFullDate, invoke } from '../api'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatusDot
} from '../components/ui'
import { useAppStore } from '../store'

function canUseModel(config: AiConfigView): boolean {
  return config.hasApiKey || config.provider === 'ollama' || config.provider === 'lmstudio'
}

function buildQuestionContextPrompt(question: Question): string {
  return taskDataEnvelope('关联追问原题背景', {
    category: question.category,
    subject: question.subject,
    type: question.type,
    material: question.material ?? '',
    stem: question.stem,
    options: question.options.map((opt) => `${opt.key}. ${opt.text}`),
    referenceAnswer: question.answer,
    referenceExplanation: question.explanation
  })
}

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
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeConvIdRef = useRef<string | undefined>(activeConvId)
  activeConvIdRef.current = activeConvId

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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  function startNewConversation(): void {
    if (busy) return
    setActiveConvId(undefined)
    setActiveTitle('新对话')
    setMessages([])
    setContextQuestion(null)
    setShowContextDetail(false)
    setError('')
  }

  function selectConversation(conv: AiConversation): void {
    if (busy) return
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
    const userMessage: AiMessage = { role: 'user', content }
    const next = [...messages, userMessage]
    const convTitle =
      messages.length === 0 && activeTitle === '新对话' ? content.slice(0, 28) : activeTitle
    setMessages(next)
    setActiveTitle(convTitle)
    setInput('')
    setBusy(true)
    setError('')
    try {
      const systemMessages: AiMessage[] = [{ role: 'system', content: FEATURE_PROMPTS.chat }]
      if (contextQuestion) {
        systemMessages.push({
          role: 'system',
          content: `用户正在围绕以下真题向你追问，请结合题干、选项、参考答案与解析精准作答：\n\n${buildQuestionContextPrompt(contextQuestion)}`
        })
      }
      const response = await invoke<AiAskResult>({
        method: 'ai.ask',
        params: {
          purpose: 'chat',
          messages: [...systemMessages, ...next]
        }
      })
      const completed: AiMessage[] = [...next, { role: 'assistant', content: response.content }]
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 请求失败')
    } finally {
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
              <div className="chat-messages">
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
                {busy && (
                  <div className="chat-message">
                    <Spinner size="tiny" label="助教正在整理" />
                  </div>
                )}
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
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                />
                <Button
                  appearance="primary"
                  icon={<PaperPlaneTiltIcon />}
                  disabled={!input.trim() || busy}
                  onClick={() => void send()}
                >
                  发送
                </Button>
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

interface VariantQuestion {
  sourceQuestionId: string
  stem: string
  options: QuestionOption[]
  answer: string[]
  explanation: string
}

function parseVariant(content: string, sourceQuestionId: string): VariantQuestion {
  const raw = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content
  const value = JSON.parse(raw.trim()) as Record<string, unknown>
  if (
    typeof value.stem !== 'string' ||
    !Array.isArray(value.options) ||
    !Array.isArray(value.answer) ||
    typeof value.explanation !== 'string'
  )
    throw new Error('模型返回格式不完整，请重新生成')
  const options = value.options.flatMap((item, index) => {
    if (typeof item === 'string') return [{ key: String.fromCharCode(65 + index), text: item }]
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      return typeof record.text === 'string'
        ? [
            {
              key: String(record.key ?? String.fromCharCode(65 + index)).toUpperCase(),
              text: record.text
            }
          ]
        : []
    }
    return []
  })
  if (options.length < 2) throw new Error('模型没有返回有效选项')
  return {
    sourceQuestionId,
    stem: value.stem,
    options,
    answer: value.answer.map(String).map((item) => item.toUpperCase()),
    explanation: value.explanation
  }
}

export function AiTrainingPage(): React.JSX.Element {
  const navigate = useNavigate()
  const ai = useAppStore((state) => state.data!.ai)
  const [variant, setVariant] = useState<VariantQuestion>()
  const [source, setSource] = useState<Question>()
  const [selected, setSelected] = useState<string[]>([])
  const [record, setRecord] = useState<AiTrainingRecord>()
  const [history, setHistory] = useState<AiTrainingRecord[]>([])
  const [expandedHistoryId, setExpandedHistoryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void invoke<AiTrainingRecord[]>({ method: 'aiTraining.history' }).then(setHistory)
  }, [])

  async function generate(): Promise<void> {
    setBusy(true)
    setError('')
    setVariant(undefined)
    setRecord(undefined)
    setSelected([])
    try {
      const questions = await invoke<Question[]>({
        method: 'practice.select',
        params: { mode: 'adaptive', count: 1, filter: { subject: 'xingce' } }
      })
      const selectedSource = questions[0]
      if (!selectedSource) throw new Error('当前知识库没有可用于变式训练的行测题')
      setSource(selectedSource)
      const response = await invoke<AiAskResult>({
        method: 'ai.ask',
        params: {
          purpose: 'variant',
          messages: [
            {
              role: 'system',
              content: FEATURE_PROMPTS.variantCreate
            },
            {
              role: 'user',
              content: taskDataEnvelope('变式题生成输入', {
                sourceQuestion: {
                  subject: selectedSource.subject,
                  category: selectedSource.category,
                  type: selectedSource.type,
                  material: selectedSource.material ?? '',
                  stem: selectedSource.stem,
                  options: selectedSource.options,
                  answer: selectedSource.answer,
                  explanation: selectedSource.explanation
                }
              })
            }
          ]
        }
      })
      const draft = parseVariant(response.content, selectedSource.id)
      const review = await invoke<AiAskResult>({
        method: 'ai.ask',
        params: {
          purpose: 'variant',
          messages: [
            {
              role: 'system',
              content: FEATURE_PROMPTS.variantReview
            },
            {
              role: 'user',
              content: taskDataEnvelope('变式题终审输入', {
                sourceFocus: {
                  subject: selectedSource.subject,
                  category: selectedSource.category,
                  stem: selectedSource.stem
                },
                candidate: draft
              })
            }
          ]
        }
      })
      setVariant(parseVariant(review.content, selectedSource.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '变式题生成失败')
    } finally {
      setBusy(false)
    }
  }
  async function submit(): Promise<void> {
    if (!variant || !selected.length) return
    try {
      const saved = await invoke<AiTrainingRecord>({
        method: 'aiTraining.record',
        params: { ...variant, userAnswer: selected }
      })
      setRecord(saved)
      setHistory((items) => [saved, ...items])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '训练记录保存失败')
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="提升 · AI 变式训练"
        title="AI 变式训练"
        description="从当前薄弱模块抽取原题，再生成同考点新情境。每次结果单独保存，不混入官方题库。"
        actions={
          <Button
            appearance="primary"
            icon={<SparkleIcon />}
            disabled={busy || !canUseModel(ai)}
            onClick={() => void generate()}
          >
            {busy ? '生成中' : '生成变式题'}
          </Button>
        }
      />
      {!canUseModel(ai) ? (
        <EmptyState
          title="模型尚未配置"
          description="变式题依赖可用模型，本地核心训练不受影响。"
          actionLabel="前往模型设置"
          onAction={() => navigate('/model-settings')}
        />
      ) : (
        <>
          {error && <ErrorState message={error} />}
          {busy && (
            <Section>
              <Spinner label="正在核对考点并生成新题" />
            </Section>
          )}
          {!busy && !variant && (
            <Section>
              <EmptyState
                title="准备生成第一道变式题"
                description="系统会优先选择当前相对薄弱的模块，生成结果不会覆盖原题。"
                actionLabel="开始生成"
                onAction={() => void generate()}
              />
            </Section>
          )}
          {variant && (
            <div className="question-shell">
              <Section>
                <div className="question-meta">
                  <span className="pill">AI 变式</span>
                  {source && <span className="pill">源模块：{source.category}</span>}
                </div>
                <MarkdownContent className="question-stem" content={variant.stem} />
                <div className="options">
                  {variant.options.map((option) => {
                    const isSelected = selected.includes(option.key)
                    const isAnswer = Boolean(record?.answer.includes(option.key))
                    const stateClass = record
                      ? isAnswer
                        ? 'correct'
                        : isSelected
                          ? 'wrong'
                          : 'dimmed'
                      : isSelected
                        ? 'selected'
                        : ''
                    return (
                      <button
                        type="button"
                        key={option.key}
                        className={`option-button ${stateClass}`.trim()}
                        disabled={Boolean(record)}
                        onClick={() => setSelected([option.key])}
                      >
                        <span className="option-key">{option.key}</span>
                        <MarkdownContent content={option.text} />
                      </button>
                    )
                  })}
                </div>
                {record && (
                  <div className="answer-panel">
                    <h3 className={record.correct ? 'positive' : 'negative'}>
                      {record.correct ? '回答正确' : '回答错误'}
                    </h3>
                    <p>参考答案：{record.answer.join('、')}</p>
                    <MarkdownContent content={record.explanation} />
                  </div>
                )}
                <div className="question-footer">
                  <Button onClick={() => void generate()}>换一题</Button>
                  {!record && (
                    <Button
                      appearance="primary"
                      disabled={!selected.length}
                      onClick={() => void submit()}
                    >
                      提交答案
                    </Button>
                  )}
                </div>
              </Section>
              <Section title="源题对照" description="仅用于核对考点迁移，不显示在新题作答区。">
                <MarkdownContent
                  className="question-stem muted"
                  content={source?.stem ?? ''}
                  sourceFilePath={source?.filePath}
                />
              </Section>
            </div>
          )}
          <Section title="最近变式记录" description="点击记录可展开题面、作答情况与解析对照。">
            {history.length ? (
              <ul className="data-list">
                {history.slice(0, 8).map((item) => {
                  const expanded = expandedHistoryId === item.id
                  return (
                    <li className="similar-row-item" key={item.id}>
                      <button
                        type="button"
                        className="similar-row-btn"
                        onClick={() =>
                          setExpandedHistoryId((prev) => (prev === item.id ? '' : item.id))
                        }
                      >
                        <div className="ai-history-head">
                          <strong>{item.stem}</strong>
                          <span className={item.correct ? 'positive' : 'negative'}>
                            {item.correct ? '正确' : '错误'}
                          </span>
                        </div>
                        <span>
                          {formatFullDate(item.createdAt)} · {expanded ? '收起详情' : '查看解析'}
                        </span>
                      </button>
                      {expanded && (
                        <div className="similar-preview-box">
                          <MarkdownContent content={item.stem} />
                          {item.options.length > 0 && (
                            <ul className="ai-context-options">
                              {item.options.map((opt) => (
                                <li key={opt.key}>
                                  <strong>{opt.key}.</strong> {opt.text}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p>
                            你的作答：{item.userAnswer.join('、') || '未作答'} · 参考答案：
                            {item.answer.join('、')}
                          </p>
                          <MarkdownContent content={item.explanation} />
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <EmptyState title="暂无变式训练记录" description="完成并提交一道变式题后显示。" />
            )}
          </Section>
        </>
      )}
    </div>
  )
}

export function ModelSettingsPage(): React.JSX.Element {
  const initial = useAppStore((state) => state.data!.ai)
  const initialize = useAppStore((state) => state.initialize)
  const showToast = useAppStore((state) => state.showToast)
  const [config, setConfig] = useState<AiConfigView>(initial)
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [models, setModels] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  // VLM 按页精校配置（默认关闭；reuse-main 复用主模型，custom 单独配置视觉模型）
  const [vlm, setVlm] = useState<VlmConfigView>()
  const [vlmMode, setVlmMode] = useState<VlmConfigView['mode']>('reuse-main')
  const [vlmProvider, setVlmProvider] = useState('qwen')
  const [vlmProtocol, setVlmProtocol] = useState('openai-chat')
  const [vlmBaseUrl, setVlmBaseUrl] = useState('')
  const [vlmModel, setVlmModel] = useState('')
  const [vlmApiKey, setVlmApiKey] = useState('')
  const [vlmBusy, setVlmBusy] = useState(false)
  const [pendingClearKind, setPendingClearKind] = useState<'main' | 'vlm' | null>(null)

  useEffect(() => {
    void invoke<AiProviderInfo[]>({ method: 'ai.providers' })
      .then(setProviders)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '提供商列表加载失败'))
  }, [])

  useEffect(() => {
    void invoke<VlmConfigView>({ method: 'ai.vlmConfig.get' })
      .then((view) => {
        setVlm(view)
        setVlmMode(view.mode)
        if (view.mode === 'custom') {
          setVlmProvider(view.provider ?? 'qwen')
          setVlmProtocol(view.protocol ?? 'openai-chat')
          setVlmBaseUrl(view.baseUrl ?? '')
          setVlmModel(view.model ?? '')
        }
      })
      .catch(() => undefined)
  }, [])

  const selectedProvider = providers.find((provider) => provider.id === config.provider)

  function inputConfig(): AiConfigInput {
    return {
      provider: config.provider,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      apiKey: apiKey || undefined
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setConfig(await invoke<AiConfigView>({ method: 'ai.config.save', params: inputConfig() }))
      await initialize()
      setApiKey('')
      setMessage('配置已保存，请继续测试连接。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置保存失败')
    } finally {
      setBusy(false)
    }
  }
  async function test(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await invoke<AiConfigView>({ method: 'ai.test' })
      setConfig(result)
      await initialize()
      result.verified ? setMessage('连接测试通过。') : setError(result.lastError ?? '连接测试失败')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败')
    } finally {
      setBusy(false)
    }
  }

  async function discoverModels(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const saved = await invoke<AiConfigView>({
        method: 'ai.config.save',
        params: inputConfig()
      })
      setConfig(saved)
      setApiKey('')
      const available = await invoke<string[]>({ method: 'ai.models.discover' })
      setModels(available)
      setMessage(
        available.length ? `已发现 ${available.length} 个可用模型。` : '服务未返回可选模型。'
      )
      await initialize()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型列表获取失败')
    } finally {
      setBusy(false)
    }
  }

  async function performClearCredential(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setConfig(await invoke<AiConfigView>({ method: 'ai.config.clearCredential' }))
      setApiKey('')
      setMessage('已删除本机加密凭据。')
      setPendingClearKind(null)
      showToast('已删除工作台模型凭据')
      await initialize()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '凭据删除失败')
    } finally {
      setBusy(false)
    }
  }

  function buildVlmParams(): VlmConfigInput {
    return {
      enabled: vlm?.enabled ?? false,
      mode: vlmMode,
      provider: vlmMode === 'custom' ? (vlmProvider as VlmConfigInput['provider']) : undefined,
      protocol: vlmMode === 'custom' ? (vlmProtocol as VlmConfigInput['protocol']) : undefined,
      baseUrl: vlmMode === 'custom' ? vlmBaseUrl : undefined,
      model: vlmMode === 'custom' ? vlmModel : undefined,
      apiKey: vlmApiKey || undefined
    }
  }

  async function saveVlmConfig(): Promise<void> {
    setVlmBusy(true)
    setError('')
    setMessage('')
    try {
      const view = await invoke<VlmConfigView>({
        method: 'ai.vlmConfig.save',
        params: buildVlmParams()
      })
      setVlm(view)
      setVlmApiKey('')
      setMessage('VLM 精校配置已保存。请点「测试视觉模型」验证图片输入可用。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'VLM 配置保存失败')
    } finally {
      setVlmBusy(false)
    }
  }

  async function testVlm(): Promise<void> {
    setVlmBusy(true)
    setError('')
    setMessage('')
    try {
      const view = await invoke<VlmConfigView>({ method: 'ai.vlmConfig.test' })
      setVlm(view)
      view.verified
        ? setMessage('视觉模型探活通过：图片输入可用。')
        : setError(view.lastError ?? '探活失败')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '探活失败')
    } finally {
      setVlmBusy(false)
    }
  }

  async function toggleVlmEnabled(checked: boolean): Promise<void> {
    setVlmBusy(true)
    setError('')
    setMessage('')
    try {
      const view = await invoke<VlmConfigView>({
        method: 'ai.vlmConfig.save',
        // 用当前下拉选中的模式保存，避免开关操作把用户刚切换、尚未保存的模式回退成旧值
        params: { enabled: checked, mode: vlmMode }
      })
      setVlm(view)
      setVlmMode(view.mode)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '开关保存失败')
    } finally {
      setVlmBusy(false)
    }
  }

  async function performClearVlmCredential(): Promise<void> {
    setVlmBusy(true)
    setError('')
    setMessage('')
    try {
      const view = await invoke<VlmConfigView>({ method: 'ai.vlmConfig.clearCredential' })
      setVlm(view)
      setVlmApiKey('')
      setMessage('已删除视觉模型的加密凭据。')
      setPendingClearKind(null)
      showToast('已删除视觉模型加密凭据')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '凭据删除失败')
    } finally {
      setVlmBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="系统 · 模型设置"
        title="模型设置"
        description="API Key 使用操作系统加密存储。保存状态和验证状态分开显示，避免把“写入成功”误认为“连接可用”。"
      />
      {error && <ErrorState message={error} />}
      {message && (
        <div className="answer-panel">
          <p className="positive">{message}</p>
        </div>
      )}
      <div className="grid two">
        <Section
          title="连接配置"
          description="内置国内外主流服务与本地模型适配，端点和模型名称仍可按账户实际情况调整。"
        >
          <div className="form-grid">
            <Field label="服务类型">
              <Select
                value={config.provider}
                onChange={(_, data) => {
                  const provider = providers.find((item) => item.id === data.value)
                  if (!provider) return
                  setModels([])
                  setConfig({
                    ...config,
                    provider: provider.id,
                    protocol: provider.protocol,
                    baseUrl: provider.defaultBaseUrl,
                    model: provider.defaultModel,
                    verified: false,
                    lastError: undefined
                  })
                }}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="接口协议">
              <Select
                value={config.protocol}
                disabled={config.provider !== 'openai-compatible'}
                onChange={(_, data) =>
                  setConfig({ ...config, protocol: data.value as AiConfigView['protocol'] })
                }
              >
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generate-content">Google generateContent</option>
                <option value="ollama-openai">Ollama OpenAI</option>
              </Select>
            </Field>
            <Field label="模型名称">
              <Input
                value={config.model}
                onChange={(_, data) => setConfig({ ...config, model: data.value })}
              />
            </Field>
            {models.length > 0 && (
              <Field label="发现的模型">
                <Select
                  value={models.includes(config.model) ? config.model : ''}
                  onChange={(_, data) => setConfig({ ...config, model: data.value })}
                >
                  <option value="">选择服务返回的模型</option>
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field className="full" label="服务地址">
              <Input
                value={config.baseUrl}
                onChange={(_, data) => setConfig({ ...config, baseUrl: data.value })}
              />
            </Field>
            <Field
              className="full"
              label={config.hasApiKey ? 'API Key（已保存，留空保持不变）' : 'API Key'}
            >
              <Input
                type="password"
                value={apiKey}
                autoComplete="off"
                onChange={(_, data) => setApiKey(data.value)}
                placeholder={
                  selectedProvider && !selectedProvider.apiKeyRequired
                    ? '本地服务通常无需填写'
                    : '输入完整 API Key'
                }
              />
            </Field>
            <Field label={`温度 ${config.temperature.toFixed(1)}`}>
              <Slider
                min={0}
                max={2}
                step={0.1}
                value={config.temperature}
                onChange={(_, data) => setConfig({ ...config, temperature: data.value })}
              />
            </Field>
            <Field label="最大输出 Token">
              <Input
                type="number"
                min={256}
                max={32768}
                value={String(config.maxTokens)}
                onChange={(_, data) =>
                  setConfig({ ...config, maxTokens: Number(data.value) || 4096 })
                }
              />
            </Field>
          </div>
          <div className="button-row" style={{ marginTop: 18 }}>
            <Button appearance="primary" disabled={busy} onClick={() => void save()}>
              保存配置
            </Button>
            <Button disabled={busy} onClick={() => void discoverModels()}>
              获取模型列表
            </Button>
            <Button
              disabled={busy || (selectedProvider?.apiKeyRequired !== false && !config.hasApiKey)}
              onClick={() => void test()}
            >
              测试连接
            </Button>
            {config.hasApiKey && (
              <Button
                className="btn-danger"
                disabled={busy}
                onClick={() => setPendingClearKind('main')}
              >
                删除凭据
              </Button>
            )}
          </div>
        </Section>
        <Section title="当前状态">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>凭据</strong>
                <span>只显示是否存在，不回传密文</span>
              </div>
              <span>
                <StatusDot
                  status={
                    config.hasApiKey || selectedProvider?.apiKeyRequired === false
                      ? 'ok'
                      : 'warning'
                  }
                />{' '}
                {config.hasApiKey
                  ? '已保存'
                  : selectedProvider?.apiKeyRequired === false
                    ? '无需凭据'
                    : '未配置'}
              </span>
            </li>
            <li className="data-row">
              <div>
                <strong>连接验证</strong>
                <span>
                  {config.lastCheckedAt ? formatFullDate(config.lastCheckedAt) : '尚未测试'}
                </span>
              </div>
              <span>
                <StatusDot status={config.verified ? 'ok' : 'warning'} />{' '}
                {config.verified ? '已通过' : '待验证'}
              </span>
            </li>
            <li className="data-row">
              <div>
                <strong>协议端点</strong>
                <span>主进程请求，不经过渲染端</span>
              </div>
              <span>{config.protocol}</span>
            </li>
          </ul>
          {config.lastError && (
            <div className="answer-panel">
              <WarningCircleIcon className="warning" />
              <p>{config.lastError}</p>
            </div>
          )}
          <Button
            appearance="subtle"
            icon={<ArrowRightIcon />}
            style={{ marginTop: 14 }}
            onClick={() => (window.location.hash = '#/ai')}
          >
            打开 AI 助教
          </Button>
        </Section>
      </div>
      <Section
        title="VLM 按页精校（知识工坊可选）"
        description="默认关闭，知识工坊保持 100% 本地离线。开启后仅把触发精校的当前 PDF 页面图片发送至你配置的模型服务，用于核对资料分析表格与数字，结果仍需人工复核。"
      >
        <div className="data-row">
          <div>
            <strong>启用 VLM 按页精校</strong>
            <span>关闭即绝不发送任何图片到外部；审核页的精校按钮随之隐藏</span>
          </div>
          <Switch
            data-testid="vlm-enable-switch"
            checked={vlm?.enabled === true}
            disabled={vlmBusy}
            onChange={(_, data) => void toggleVlmEnabled(data.checked)}
          />
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <Field label="模型来源">
            <Select
              value={vlmMode}
              onChange={(_, data) => {
                const nextMode = data.value as VlmConfigView['mode']
                setVlmMode(nextMode)
                // 切到 custom 且地址/模型为空（也无已保存的 custom 配置）时，
                // 按当前选中 provider 预填默认协议/地址/模型，避免空表单直接保存报错
                if (
                  nextMode === 'custom' &&
                  !vlm?.baseUrl &&
                  !vlmBaseUrl.trim() &&
                  !vlmModel.trim()
                ) {
                  const provider = providers.find((item) => item.id === vlmProvider)
                  if (provider) {
                    setVlmProtocol(provider.protocol)
                    setVlmBaseUrl(provider.defaultBaseUrl)
                    setVlmModel(provider.defaultModel)
                  }
                }
              }}
            >
              <option value="reuse-main">复用主模型（{vlm?.mainModel ?? '未配置'}）</option>
              <option value="custom">单独配置视觉模型（主模型为纯文本时使用）</option>
            </Select>
          </Field>
          {vlmMode === 'custom' && (
            <>
              <Field label="视觉模型服务">
                <Select
                  value={vlmProvider}
                  onChange={(_, data) => {
                    setVlmProvider(data.value)
                    const provider = providers.find((item) => item.id === data.value)
                    if (provider) {
                      setVlmProtocol(provider.protocol)
                      setVlmBaseUrl(provider.defaultBaseUrl)
                      setVlmModel(provider.defaultModel)
                    }
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="接口协议">
                <Select value={vlmProtocol} onChange={(_, data) => setVlmProtocol(data.value)}>
                  <option value="openai-chat">OpenAI Chat Completions</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                  <option value="google-generate-content">Google generateContent</option>
                  <option value="ollama-openai">Ollama OpenAI</option>
                </Select>
              </Field>
              <Field className="full" label="服务地址">
                <Input value={vlmBaseUrl} onChange={(_, data) => setVlmBaseUrl(data.value)} />
              </Field>
              <Field label="模型名称">
                <Input value={vlmModel} onChange={(_, data) => setVlmModel(data.value)} />
              </Field>
              <Field
                className="full"
                label={vlm?.hasApiKey ? 'API Key（已保存，留空保持不变）' : 'API Key'}
              >
                <Input
                  type="password"
                  value={vlmApiKey}
                  autoComplete="off"
                  onChange={(_, data) => setVlmApiKey(data.value)}
                />
              </Field>
            </>
          )}
        </div>
        <div className="button-row" style={{ marginTop: 14 }}>
          {/* 两种模式都允许保存：reuse-main 下保存 = 持久化模式切换（不丢已存 custom 配置） */}
          <Button disabled={vlmBusy} onClick={() => void saveVlmConfig()}>
            {vlmMode === 'custom' ? '保存视觉模型配置' : '保存为复用主模型'}
          </Button>
          <Button disabled={vlmBusy} onClick={() => void testVlm()}>
            测试视觉模型
          </Button>
          {vlm?.hasApiKey && vlmMode === 'custom' && (
            <Button
              className="btn-danger"
              disabled={vlmBusy}
              onClick={() => setPendingClearKind('vlm')}
            >
              删除视觉凭据
            </Button>
          )}
        </div>
        <ul className="data-list" style={{ marginTop: 14 }}>
          <li className="data-row">
            <div>
              <strong>视觉凭据</strong>
              <span>只显示是否存在，不回传明文密钥</span>
            </div>
            <span>
              {vlm?.hasApiKey
                ? vlmMode === 'custom'
                  ? '已保存'
                  : '复用主模型凭据'
                : vlmMode === 'reuse-main'
                  ? '复用主模型凭据'
                  : '未配置'}
            </span>
          </li>
          <li className="data-row">
            <div>
              <strong>最近探活</strong>
              <span>{vlm?.lastCheckedAt ? formatFullDate(vlm.lastCheckedAt) : '尚未测试'}</span>
            </div>
            <span>
              <StatusDot status={vlm?.verified ? 'ok' : 'warning'} />{' '}
              {vlm?.verified ? '图片输入可用' : '待验证'}
            </span>
          </li>
        </ul>
        {vlm?.lastError && (
          <div className="answer-panel">
            <WarningCircleIcon className="warning" />
            <p>{vlm.lastError}</p>
          </div>
        )}
      </Section>
      <ConfirmDialog
        open={Boolean(pendingClearKind)}
        title={pendingClearKind === 'main' ? '删除主模型加密凭据？' : '删除视觉模型加密凭据？'}
        description={
          pendingClearKind === 'main'
            ? '确认删除此工作台保存的主模型 API 凭据？此操作不会影响提供商账户，也不会影响本地训练。'
            : '确认删除视觉模型（VLM）的本地加密凭据？'
        }
        confirmLabel="确认删除"
        danger
        busy={pendingClearKind === 'main' ? busy : vlmBusy}
        onCancel={() => setPendingClearKind(null)}
        onConfirm={() => {
          if (pendingClearKind === 'main') return performClearCredential()
          if (pendingClearKind === 'vlm') return performClearVlmCredential()
        }}
      />
    </div>
  )
}
