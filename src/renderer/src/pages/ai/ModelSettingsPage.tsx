import { useEffect, useState } from 'react'
import { Button, Field, Input, Select, Slider } from '@fluentui/react-components'
import { ArrowRightIcon, WarningCircleIcon } from '@phosphor-icons/react'
import type {
  AiConfigInput,
  AiConfigView,
  AiProviderInfo,
  VlmConfigInput,
  VlmConfigView
} from '@shared/contracts'
import { formatFullDate, invoke } from '../../api'
import { ConfirmDialog, ErrorState, PageHeader, Section, StatusDot } from '../../components/ui'
import { useAppStore } from '../../store'
import { VlmSettingsSection } from './VlmSettingsSection'

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

  function handleVlmModeChange(nextMode: VlmConfigView['mode']): void {
    setVlmMode(nextMode)
    // 切到 custom 且地址/模型为空（也无已保存的 custom 配置）时，
    // 按当前选中 provider 预填默认协议/地址/模型，避免空表单直接保存报错
    if (nextMode === 'custom' && !vlm?.baseUrl && !vlmBaseUrl.trim() && !vlmModel.trim()) {
      const provider = providers.find((item) => item.id === vlmProvider)
      if (provider) {
        setVlmProtocol(provider.protocol)
        setVlmBaseUrl(provider.defaultBaseUrl)
        setVlmModel(provider.defaultModel)
      }
    }
  }

  function handleVlmProviderChange(providerId: string): void {
    setVlmProvider(providerId)
    const provider = providers.find((item) => item.id === providerId)
    if (provider) {
      setVlmProtocol(provider.protocol)
      setVlmBaseUrl(provider.defaultBaseUrl)
      setVlmModel(provider.defaultModel)
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
      <VlmSettingsSection
        providers={providers}
        vlm={vlm}
        vlmMode={vlmMode}
        vlmProvider={vlmProvider}
        vlmProtocol={vlmProtocol}
        vlmBaseUrl={vlmBaseUrl}
        vlmModel={vlmModel}
        vlmApiKey={vlmApiKey}
        vlmBusy={vlmBusy}
        onToggleEnabled={(checked) => void toggleVlmEnabled(checked)}
        onModeChange={handleVlmModeChange}
        onProviderChange={handleVlmProviderChange}
        onProtocolChange={setVlmProtocol}
        onBaseUrlChange={setVlmBaseUrl}
        onModelChange={setVlmModel}
        onApiKeyChange={setVlmApiKey}
        onSave={() => void saveVlmConfig()}
        onTest={() => void testVlm()}
        onRequestClearCredential={() => setPendingClearKind('vlm')}
      />
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
