import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Spinner } from '@fluentui/react-components'
import { SparkleIcon } from '@phosphor-icons/react'
import type { AiAskResult, AiTrainingRecord, Question, QuestionOption } from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { formatFullDate, invoke } from '../../api'
import { MarkdownContent } from '../../components/MarkdownContent'
import { QuestionOptionList } from '../../components/QuestionOptionList'
import { EmptyState, ErrorState, PageHeader, Section } from '../../components/ui'
import { useAppStore } from '../../store'
import { canUseModel } from './shared'

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
                <QuestionOptionList
                  options={variant.options}
                  selected={selected}
                  correctKeys={record?.answer}
                  disabled={Boolean(record)}
                  onSelect={(key) => setSelected([key])}
                />
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
