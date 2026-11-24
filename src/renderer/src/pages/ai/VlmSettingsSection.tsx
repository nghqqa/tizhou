import { Button, Field, Input, Select, Switch } from '@fluentui/react-components'
import { WarningCircleIcon } from '@phosphor-icons/react'
import type { AiProviderInfo, VlmConfigView } from '@shared/contracts'
import { formatFullDate } from '../../api'
import { Section, StatusDot } from '../../components/ui'

interface VlmSettingsSectionProps {
  providers: AiProviderInfo[]
  vlm?: VlmConfigView
  vlmMode: VlmConfigView['mode']
  vlmProvider: string
  vlmProtocol: string
  vlmBaseUrl: string
  vlmModel: string
  vlmApiKey: string
  vlmBusy: boolean
  onToggleEnabled: (checked: boolean) => void
  onModeChange: (nextMode: VlmConfigView['mode']) => void
  onProviderChange: (providerId: string) => void
  onProtocolChange: (protocol: string) => void
  onBaseUrlChange: (baseUrl: string) => void
  onModelChange: (model: string) => void
  onApiKeyChange: (apiKey: string) => void
  onSave: () => void
  onTest: () => void
  onRequestClearCredential: () => void
}

export function VlmSettingsSection({
  providers,
  vlm,
  vlmMode,
  vlmProvider,
  vlmProtocol,
  vlmBaseUrl,
  vlmModel,
  vlmApiKey,
  vlmBusy,
  onToggleEnabled,
  onModeChange,
  onProviderChange,
  onProtocolChange,
  onBaseUrlChange,
  onModelChange,
  onApiKeyChange,
  onSave,
  onTest,
  onRequestClearCredential
}: VlmSettingsSectionProps): React.JSX.Element {
  return (
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
          onChange={(_, data) => onToggleEnabled(data.checked)}
        />
      </div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <Field label="模型来源">
          <Select
            value={vlmMode}
            onChange={(_, data) => onModeChange(data.value as VlmConfigView['mode'])}
          >
            <option value="reuse-main">复用主模型（{vlm?.mainModel ?? '未配置'}）</option>
            <option value="custom">单独配置视觉模型（主模型为纯文本时使用）</option>
          </Select>
        </Field>
        {vlmMode === 'custom' && (
          <>
            <Field label="视觉模型服务">
              <Select value={vlmProvider} onChange={(_, data) => onProviderChange(data.value)}>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="接口协议">
              <Select value={vlmProtocol} onChange={(_, data) => onProtocolChange(data.value)}>
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generate-content">Google generateContent</option>
                <option value="ollama-openai">Ollama OpenAI</option>
              </Select>
            </Field>
            <Field className="full" label="服务地址">
              <Input value={vlmBaseUrl} onChange={(_, data) => onBaseUrlChange(data.value)} />
            </Field>
            <Field label="模型名称">
              <Input value={vlmModel} onChange={(_, data) => onModelChange(data.value)} />
            </Field>
            <Field
              className="full"
              label={vlm?.hasApiKey ? 'API Key（已保存，留空保持不变）' : 'API Key'}
            >
              <Input
                type="password"
                value={vlmApiKey}
                autoComplete="off"
                onChange={(_, data) => onApiKeyChange(data.value)}
              />
            </Field>
          </>
        )}
      </div>
      <div className="button-row" style={{ marginTop: 14 }}>
        {/* 两种模式都允许保存：reuse-main 下保存 = 持久化模式切换（不丢已存 custom 配置） */}
        <Button disabled={vlmBusy} onClick={onSave}>
          {vlmMode === 'custom' ? '保存视觉模型配置' : '保存为复用主模型'}
        </Button>
        <Button disabled={vlmBusy} onClick={onTest}>
          测试视觉模型
        </Button>
        {vlm?.hasApiKey && vlmMode === 'custom' && (
          <Button className="btn-danger" disabled={vlmBusy} onClick={onRequestClearCredential}>
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
  )
}
