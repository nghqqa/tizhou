import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input, ProgressBar } from '@fluentui/react-components'
import {
  ArrowRightIcon,
  CheckIcon,
  ClipboardTextIcon,
  LightningIcon,
  StopIcon,
  TargetIcon
} from '@phosphor-icons/react'
import {
  planItemActionLabel,
  planItemRoute,
  type DiagnosisResult,
  type LearningPlan,
  type LearningPlanItem
} from '@shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '@shared/prompts'
import { invoke } from '../../api'
import { streamAiAsk } from '../../services/ai-stream'
import { MarkdownContent } from '../../components/MarkdownContent'
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section
} from '../../components/ui'
import { useAppStore } from '../../store'

export function DiagnosisPage(): React.JSX.Element {
  const navigate = useNavigate()
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const showToast = useAppStore((state) => state.showToast)
  const ai = useAppStore((state) => state.data!.ai)
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult>()
  const [activePlan, setActivePlan] = useState<LearningPlan>()
  const [preview, setPreview] = useState<LearningPlan>()
  const [durationDays, setDurationDays] = useState(14)
  const [dailyMinutes, setDailyMinutes] = useState(60)
  const [focusText, setFocusText] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const [error, setError] = useState('')
  const [aiInterpretation, setAiInterpretation] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const streamCancelRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)

  async function load(): Promise<void> {
    setError('')
    try {
      const [diagnosisValue, plan] = await Promise.all([
        invoke<DiagnosisResult>({ method: 'diagnosis.get' }),
        invoke<LearningPlan | undefined>({ method: 'plan.active' })
      ])
      setDiagnosis(diagnosisValue)
      setActivePlan(plan)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '诊断生成失败')
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      streamCancelRef.current?.()
    }
  }, [])

  const groupedItems = useMemo(() => {
    const plan = activePlan ?? preview
    if (!plan) return []
    return Array.from({ length: plan.durationDays }, (_, index) => ({
      day: index + 1,
      items: plan.items.filter((item) => item.day === index + 1)
    })).filter((group) => group.items.length)
  }, [activePlan, preview])

  async function generatePlan(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setPreview(
        await invoke<LearningPlan>({
          method: 'plan.preview',
          params: {
            durationDays,
            dailyMinutes,
            focus: focusText
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean)
          }
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '计划生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function interpretDiagnosis(): Promise<void> {
    if (!diagnosis || aiBusy) return
    setAiBusy(true)
    setError('')
    setAiInterpretation('')
    try {
      const handle = streamAiAsk(
        {
          purpose: 'plan',
          messages: [
            {
              role: 'system',
              content: FEATURE_PROMPTS.diagnosis
            },
            {
              role: 'user',
              content: taskDataEnvelope('本地学习诊断统计', diagnosis)
            }
          ]
        },
        (accumulated) => {
          if (mountedRef.current) setAiInterpretation(accumulated)
        }
      )
      streamCancelRef.current = handle.cancel
      const response = await handle.promise
      if (!mountedRef.current) return
      setAiInterpretation(
        response.aborted && response.content.trim()
          ? `${response.content}\n\n*(已停止生成)*`
          : response.content
      )
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : 'AI 诊断解读失败')
      }
    } finally {
      streamCancelRef.current = null
      if (mountedRef.current) setAiBusy(false)
    }
  }

  async function applyPlan(): Promise<void> {
    if (!preview) return
    setBusy(true)
    try {
      const applied = await invoke<LearningPlan>({
        method: 'plan.apply',
        params: { plan: preview }
      })
      setActivePlan(applied)
      setPreview(undefined)
      await refreshDashboard()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '计划应用失败')
    } finally {
      setBusy(false)
    }
  }

  async function completeItem(item: LearningPlanItem): Promise<void> {
    if (!activePlan) return
    try {
      setActivePlan(
        await invoke<LearningPlan>({
          method: 'plan.item.complete',
          params: { planId: activePlan.id, itemId: item.id, completed: item.target }
        })
      )
      await refreshDashboard()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '进度保存失败')
    }
  }

  async function cancelPlan(): Promise<void> {
    if (!activePlan) return
    setBusy(true)
    try {
      await invoke({ method: 'plan.cancel', params: { planId: activePlan.id } })
      setActivePlan(undefined)
      setCancelConfirmOpen(false)
      showToast('已取消当前学习计划')
      await refreshDashboard()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '计划取消失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="提升 · 能力诊断"
        title="能力诊断与计划"
        description="画像来自作答记录，不以自评替代证据；样本不足时会明确提示。"
        actions={<Button onClick={() => void load()}>重新诊断</Button>}
      />
      {error && <ErrorState message={error} />}
      {!diagnosis ? (
        <LoadingState label="正在生成能力画像" />
      ) : (
        <>
          <Section>
            <div className="diagnosis-band">
              <div
                className="score-ring"
                role="img"
                aria-label={`综合正确率 ${diagnosis.accuracy}%`}
              >
                <svg className="score-ring-svg" viewBox="0 0 120 120" aria-hidden="true">
                  <circle className="score-ring-track" cx="60" cy="60" r="52" />
                  {diagnosis.accuracy > 0 && (
                    <circle
                      className="score-ring-arc"
                      cx="60"
                      cy="60"
                      r="52"
                      strokeDasharray={`${(2 * Math.PI * 52 * Math.max(0, Math.min(100, diagnosis.accuracy))) / 100} ${2 * Math.PI * 52}`}
                      transform="rotate(-90 60 60)"
                    />
                  )}
                </svg>
                <div className="score-ring-center">
                  <strong>{diagnosis.accuracy}%</strong>
                  <span>综合正确率</span>
                </div>
              </div>
              <div>
                <h2 style={{ marginTop: 0 }}>
                  {diagnosis.totalAttempts
                    ? `基于 ${diagnosis.totalAttempts} 次有效作答`
                    : '需要一组摸底数据'}
                </h2>
                <p className="muted">
                  平均每题 {diagnosis.averageDurationSeconds} 秒。强弱项至少需要真实作答才能排序。
                </p>
                <div className="button-row">
                  {diagnosis.weaknesses.map((item) => (
                    <span className="pill" key={item.category}>
                      {item.category} {item.accuracy}%
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </Section>
          <div className="grid two">
            <Section title="相对优势">
              {diagnosis.strengths.length ? (
                <ul className="data-list">
                  {diagnosis.strengths.map((item) => (
                    <li className="data-row" key={item.category}>
                      <div>
                        <strong>{item.category}</strong>
                        <span>{item.attempts} 次作答</span>
                      </div>
                      <strong className="positive">{item.accuracy}%</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="样本不足"
                  description="单模块作答满 3 题且正确率达 70% 后列入相对优势。"
                />
              )}
            </Section>
            <Section title="优先补强">
              {diagnosis.weaknesses.length ? (
                <ul className="data-list">
                  {diagnosis.weaknesses.map((item) => (
                    <li className="data-row" key={item.category}>
                      <div>
                        <strong>{item.category}</strong>
                        <span>{item.attempts} 次作答</span>
                      </div>
                      <strong className={item.accuracy < 60 ? 'negative' : 'warning'}>
                        {item.accuracy}%
                      </strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="暂时没有需要补强的模块"
                  description="优势之外的模块按正确率升序列在这里；正确率达 80% 即移出补强清单。"
                />
              )}
            </Section>
          </div>
          <Section title="训练建议">
            <ul className="advice-list">
              {diagnosis.recommendations.map((recommendation, index) => (
                <li className="advice-row" key={recommendation}>
                  <span className="advice-badge" aria-hidden="true">
                    {index + 1}
                  </span>
                  <strong>{recommendation}</strong>
                </li>
              ))}
            </ul>
          </Section>
          {(ai.hasApiKey || ai.provider === 'ollama' || ai.provider === 'lmstudio') &&
            diagnosis.totalAttempts > 0 && (
              <Section
                title="AI 证据解读"
                description="只发送汇总统计，不发送题库正文、笔记或逐题答案。"
                actions={
                  aiBusy ? (
                    <Button
                      appearance="secondary"
                      icon={<StopIcon weight="fill" />}
                      onClick={() => streamCancelRef.current?.()}
                    >
                      停止生成
                    </Button>
                  ) : (
                    <Button onClick={() => void interpretDiagnosis()}>
                      {aiInterpretation ? '重新解读' : '生成解读'}
                    </Button>
                  )
                }
              >
                {aiInterpretation ? (
                  <div className={aiBusy ? 'ai-stream-panel' : undefined}>
                    <MarkdownContent content={aiInterpretation} />
                    {aiBusy && (
                      <div className="ai-stream-status">
                        <span className="ai-stream-cursor" aria-hidden="true" />
                        <span>正在生成解读…</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted">
                    {aiBusy
                      ? '正在连接模型并流式解读能力画像…'
                      : '本地事实已经生成。点击后由模型补充解释，事实数值不会被模型覆盖。'}
                  </p>
                )}
              </Section>
            )}
        </>
      )}
      <Section
        title={activePlan ? activePlan.title : preview ? '计划预览' : '生成学习计划'}
        description={
          activePlan
            ? `${activePlan.durationDays} 天 · 每天 ${activePlan.dailyMinutes} 分钟 · ${activePlan.focus.join('、')}`
            : '先生成预览，确认后才会替换当前活动计划。'
        }
        actions={
          activePlan ? (
            <Button appearance="subtle" onClick={() => setCancelConfirmOpen(true)}>
              取消计划
            </Button>
          ) : preview ? (
            <>
              <Button onClick={() => setPreview(undefined)}>重新配置</Button>
              <Button appearance="primary" disabled={busy} onClick={() => void applyPlan()}>
                应用计划
              </Button>
            </>
          ) : undefined
        }
      >
        {!activePlan && !preview ? (
          <div className="form-grid">
            <Field label="计划天数">
              <Input
                type="number"
                min={1}
                max={30}
                value={String(durationDays)}
                onChange={(_, data) =>
                  setDurationDays(Math.max(1, Math.min(30, Number(data.value) || 1)))
                }
              />
            </Field>
            <Field label="每天分钟">
              <Input
                type="number"
                min={10}
                max={300}
                value={String(dailyMinutes)}
                onChange={(_, data) =>
                  setDailyMinutes(Math.max(10, Math.min(300, Number(data.value) || 10)))
                }
              />
            </Field>
            <Field className="full" label="重点模块，可留空自动选择">
              <Input
                value={focusText}
                onChange={(_, data) => setFocusText(data.value)}
                placeholder="例如：资料分析，判断推理"
              />
            </Field>
            <div className="button-row full">
              <Button
                appearance="primary"
                icon={<LightningIcon />}
                disabled={busy}
                onClick={() => void generatePlan()}
              >
                {busy ? '生成中' : '生成预览'}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            {activePlan &&
              activePlan.items.length > 0 &&
              (() => {
                const doneCount = activePlan.items.filter((i) => i.done).length
                const totalCount = activePlan.items.length
                const ratio = doneCount / totalCount
                return (
                  <div className="plan-progress-summary">
                    <div className="progress-text">
                      <span>整体进度</span>
                      <span>
                        已完成 {doneCount} / {totalCount} 项（{Math.round(ratio * 100)}%）
                      </span>
                    </div>
                    <ProgressBar value={ratio} />
                  </div>
                )
              })()}
            {!activePlan && preview && (
              <p className="muted plan-preview-hint">
                预览状态仅供确认安排，点击右上角「应用计划」保存后即可从任务项直接跳转练习。
              </p>
            )}
            {groupedItems.map((group) => (
              <div className="plan-day" key={group.day}>
                <strong>第 {group.day} 天</strong>
                <div className="plan-items">
                  {group.items.map((item) => (
                    <div className="plan-item" key={item.id}>
                      <div>
                        <span>{item.title}</span>
                        <small className="muted">
                          目标 {item.target} {item.type === 'read_knowledge' ? '分钟' : '项'}
                        </small>
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {activePlan && !item.done && (
                          <button
                            type="button"
                            className="mastery-action"
                            onClick={() => navigate(planItemRoute(item))}
                          >
                            {planItemActionLabel(item)} <ArrowRightIcon size={12} />
                          </button>
                        )}
                        {activePlan && (
                          <Button
                            size="small"
                            appearance={item.done ? 'subtle' : 'secondary'}
                            icon={item.done ? <CheckIcon /> : <TargetIcon />}
                            disabled={item.done}
                            onClick={() => void completeItem(item)}
                          >
                            {item.done ? '已完成' : '完成'}
                          </Button>
                        )}
                        {!activePlan && (
                          <span className="pill">
                            {item.type === 'read_knowledge' ? (
                              <ClipboardTextIcon />
                            ) : (
                              <TargetIcon />
                            )}{' '}
                            {item.target}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
      <ConfirmDialog
        open={cancelConfirmOpen}
        title="确认取消当前学习计划？"
        description="取消后将停止追踪本次计划进度，后续仍可随时重新生成新计划。"
        confirmLabel="确认取消"
        danger
        busy={busy}
        onCancel={() => setCancelConfirmOpen(false)}
        onConfirm={() => void cancelPlan()}
      />
    </div>
  )
}
