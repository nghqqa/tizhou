import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { safeStorage } from 'electron'
import type {
  AiAskInput,
  AiAskResult,
  AiConfigInput,
  AiConfigView,
  AiImageInput,
  AiMessage,
  AiProtocol,
  AiProvider,
  AiProviderInfo,
  VlmConfigInput,
  VlmConfigView,
  VlmModelMode
} from '../../shared/contracts'
import { DEFAULT_AI_CONFIG } from '../../shared/defaults'
import { basePromptForPurpose, FEATURE_PROMPTS } from '../../shared/prompts'
import { now, safeParseJson as safeParse } from '../utils/common'
import { DatabaseService } from './database'

/** 已存模型配置（不含密钥）：导出供单测构造多模态请求体 */
export interface StoredAiConfig {
  provider: AiProvider
  protocol: AiProtocol
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
}

/** vlm_config.payload_json：开关与（custom 模式的）视觉模型元数据；密钥单独加密存列 */
interface StoredVlmMeta {
  enabled: boolean
  mode: VlmModelMode
  provider?: AiProvider
  protocol?: AiProtocol
  baseUrl?: string
  model?: string
}

/** 模型返回明确的不支持图像/多模态错误时，统一转化为可操作的中文引导 */
const VISION_UNSUPPORTED_MESSAGE = '当前模型不支持图片输入，请切换或单独配置支持视觉的模型'

/** VLM 探活用 1x1 PNG（合法最小图片，只为验证服务端接受图像载荷） */
const VISION_PROBE_IMAGE: AiImageInput = {
  mimeType: 'image/png',
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
}

// 视觉请求防爆上限：单次最多 3 页图（与按页精校页数上限一致），
// 单张 data URL 上限 600 万字符（约 4.5 MB 原始字节，2000px JPEG 页图远低于此）
export const MAX_VISION_IMAGES_PER_REQUEST = 3
export const MAX_VISION_IMAGE_DATAURL_CHARS = 6_000_000

function hasImages(messages: AiMessage[]): boolean {
  return messages.some((message) => (message.images?.length ?? 0) > 0)
}

function rawBase64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

function validateVisionMessages(messages: AiMessage[]): void {
  let count = 0
  for (const message of messages) {
    for (const image of message.images ?? []) {
      count += 1
      if (count > MAX_VISION_IMAGES_PER_REQUEST)
        throw new Error(`单次视觉请求最多携带 ${MAX_VISION_IMAGES_PER_REQUEST} 张页面图片`)
      if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith('data:image/'))
        throw new Error('图片载荷必须是 data:image 开头的 data URL')
      if (image.dataUrl.length > MAX_VISION_IMAGE_DATAURL_CHARS)
        throw new Error('单张页面图片超过大小上限，请降低渲染分辨率后重试')
    }
  }
}

/** openai-chat 消息内容：无图保持原字符串；有图转 text + image_url 内容数组。
 *  detail: 'high' 只加在官方 DeepSeek/OpenAI 端点（统计表小字更清晰），
 *  其余 OpenAI 兼容端点不强加未知扩展字段，避免个别实现直接报 400 */
function openAiVisionContent(
  message: AiMessage,
  useHighDetail: boolean
): string | Array<Record<string, unknown>> {
  const images = message.images ?? []
  if (!images.length) return message.content
  return [
    { type: 'text', text: message.content },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: image.dataUrl, ...(useHighDetail ? { detail: 'high' } : {}) }
    }))
  ]
}

function isVisionUnsupportedError(detail: string): boolean {
  return /image|multimodal|vision|modalit|视觉|图片|图像|多模态/i.test(detail)
}

interface RequestSpec {
  endpoint: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const PROVIDERS: AiProviderInfo[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.7',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'qwen',
    name: '通义千问',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7-flash',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'doubao',
    name: '豆包 Ark',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6-250615',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'google',
    name: 'Google Gemini',
    protocol: 'google-generate-content',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.6-flash',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5-mini',
    local: false,
    apiKeyRequired: true
  },
  {
    id: 'ollama',
    name: 'Ollama 本地服务',
    protocol: 'ollama-openai',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'qwen3:8b',
    local: true,
    apiKeyRequired: false
  },
  {
    id: 'lmstudio',
    name: 'LM Studio 本地服务',
    protocol: 'openai-chat',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    local: true,
    apiKeyRequired: false
  },
  {
    id: 'openai-compatible',
    name: '自定义 OpenAI 兼容服务',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'model-name',
    local: false,
    apiKeyRequired: true
  }
]

function providerInfo(provider: AiProvider): AiProviderInfo {
  return PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0]!
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (normalized === '::' || normalized === '::1') return true
  if (/^(fc|fd)/i.test(normalized) || /^fe[89ab]/i.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : '')
  if (!ipv4) return false
  const [a = -1, b = -1] = ipv4.split('.').map(Number)
  // 198.18.0.0/15 是 RFC 2544 基准测试网段，也是 Clash 等代理 fake-ip 模式的默认网段，需放行以兼容代理环境
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function parseBaseUrl(value: string, provider: AiProvider): URL {
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('模型服务地址不是有效 URL')
  }
  if (parsed.username || parsed.password) throw new Error('模型服务地址不能包含用户名或密码')
  const info = providerInfo(provider)
  const host = normalizeHostname(parsed.hostname)
  if (info.local) {
    if (!['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('本地模型只允许连接本机回环地址')
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('本地模型地址必须使用 http:// 或 https://')
  } else {
    if (parsed.protocol !== 'https:') throw new Error('远程模型服务必须使用 HTTPS')
    if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host))
      throw new Error('远程模型服务不能指向本机或私有网络')
  }
  return parsed
}

async function verifyNetworkTarget(value: string, provider: AiProvider): Promise<void> {
  const parsed = parseBaseUrl(value, provider)
  if (providerInfo(provider).local) return
  const results = await lookup(parsed.hostname, { all: true, verbatim: true })
  if (!results.length || results.some((result) => isPrivateAddress(result.address)))
    throw new Error('模型域名解析到了不可访问的私有或保留地址')
}

function appendEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return /(^|\.)deepseek\.com$/i.test(normalizeHostname(new URL(baseUrl).hostname))
  } catch {
    return false
  }
}

function openAiChatEndpoint(config: StoredAiConfig): string {
  if (/\/chat\/completions$/i.test(config.baseUrl)) return config.baseUrl
  if (/\/(v1|v3|v4)$/i.test(config.baseUrl))
    return appendEndpoint(config.baseUrl, 'chat/completions')
  if (config.provider === 'ollama') return appendEndpoint(config.baseUrl, 'v1/chat/completions')
  return appendEndpoint(config.baseUrl, 'chat/completions')
}

function responsesEndpoint(config: StoredAiConfig): string {
  if (/\/responses$/i.test(config.baseUrl)) return config.baseUrl
  return appendEndpoint(config.baseUrl, 'responses')
}

function anthropicEndpoint(config: StoredAiConfig): string {
  if (/\/messages$/i.test(config.baseUrl)) return config.baseUrl
  return appendEndpoint(config.baseUrl, /\/v1$/i.test(config.baseUrl) ? 'messages' : 'v1/messages')
}

function googleEndpoint(config: StoredAiConfig, stream = false): string {
  const root = /\/v1beta$/i.test(config.baseUrl)
    ? config.baseUrl
    : appendEndpoint(config.baseUrl, 'v1beta')
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return appendEndpoint(root, `models/${encodeURIComponent(config.model)}:${action}`)
}

function systemText(messages: AiMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
}

/** 构造各协议的请求体（导出供单测断言多模态/纯文本与流式开关） */
export function requestSpec(
  config: StoredAiConfig,
  messages: AiMessage[],
  apiKey: string,
  options?: { stream?: boolean }
): RequestSpec {
  const stream = Boolean(options?.stream)
  const commonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(stream ? { Accept: 'text/event-stream, application/json' } : {})
  }
  switch (config.protocol) {
    case 'openai-responses':
      return {
        endpoint: responsesEndpoint(config),
        headers: { ...commonHeaders, Authorization: `Bearer ${apiKey}` },
        body: {
          model: config.model,
          // 含图消息转 input_text/input_image 内容块；无图保持原 messages 结构不变
          input: hasImages(messages)
            ? messages.map((message) => ({
                role: message.role,
                content: message.images?.length
                  ? [
                      { type: 'input_text', text: message.content },
                      ...message.images.map((image) => ({
                        type: 'input_image',
                        image_url: image.dataUrl
                      }))
                    ]
                  : message.content
              }))
            : messages,
          temperature: config.temperature,
          max_output_tokens: config.maxTokens,
          ...(stream ? { stream: true } : {})
        }
      }
    case 'anthropic-messages':
      return {
        endpoint: anthropicEndpoint(config),
        headers: { ...commonHeaders, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: {
          model: config.model,
          system: systemText(messages) || undefined,
          messages: messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role,
              content: message.images?.length
                ? [
                    ...message.images.map((image) => ({
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: image.mimeType,
                        data: rawBase64Of(image.dataUrl)
                      }
                    })),
                    { type: 'text', text: message.content }
                  ]
                : message.content
            })),
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          ...(stream ? { stream: true } : {})
        }
      }
    case 'google-generate-content':
      return {
        endpoint: googleEndpoint(config, stream),
        headers: { ...commonHeaders, 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: systemText(messages)
            ? { parts: [{ text: systemText(messages) }] }
            : undefined,
          contents: messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [
                ...(message.images ?? []).map((image) => ({
                  inlineData: { mimeType: image.mimeType, data: rawBase64Of(image.dataUrl) }
                })),
                { text: message.content }
              ]
            })),
          generationConfig: { temperature: config.temperature, maxOutputTokens: config.maxTokens }
        }
      }
    case 'ollama-openai':
    case 'openai-chat': {
      const useHighDetail = isDeepSeekEndpoint(config.baseUrl) || config.provider === 'openai'
      return {
        endpoint: openAiChatEndpoint(config),
        headers: { ...commonHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: {
          model: config.model,
          // 无图消息保持原数组引用与字符串 content（一字节不变）；有图才转内容数组
          messages: hasImages(messages)
            ? messages.map((message) => ({
                role: message.role,
                content: openAiVisionContent(message, useHighDetail)
              }))
            : messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          stream,
          // DeepSeek V4 系列默认开启思考模式，推理会占用输出预算导致内容为空或 JSON 截断，按官方参数关闭
          ...(isDeepSeekEndpoint(config.baseUrl) ? { thinking: { type: 'disabled' } } : {})
        }
      }
    }
  }
}

function responseError(payload: Record<string, unknown>, raw: string): string {
  const error = payload.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return raw.slice(0, 300) || '未知错误'
}

function textFromResponse(protocol: AiProtocol, payload: Record<string, unknown>): string {
  if (protocol === 'openai-responses') {
    if (typeof payload.output_text === 'string') return payload.output_text
    const output = Array.isArray(payload.output) ? payload.output : []
    return output
      .flatMap((item) =>
        item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).content)
          ? ((item as Record<string, unknown>).content as unknown[])
          : []
      )
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : []
      )
      .join('\n')
  }
  if (protocol === 'anthropic-messages') {
    return (Array.isArray(payload.content) ? payload.content : [])
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).type !== 'thinking' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : []
      )
      .join('\n')
  }
  if (protocol === 'google-generate-content') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    const first = candidates[0]
    if (!first || typeof first !== 'object') return ''
    const content = (first as Record<string, unknown>).content
    if (!content || typeof content !== 'object') return ''
    const parts = (content as Record<string, unknown>).parts
    return (Array.isArray(parts) ? parts : [])
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).thought !== true &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : []
      )
      .join('')
  }
  const choices = Array.isArray(payload.choices)
    ? (payload.choices as Array<Record<string, unknown>>)
    : []
  const message =
    choices[0]?.message && typeof choices[0].message === 'object'
      ? (choices[0].message as Record<string, unknown>)
      : undefined
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return (message.content as unknown[])
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : []
      )
      .join('')
  }
  return ''
}

function usageFromResponse(
  protocol: AiProtocol,
  payload: Record<string, unknown>
): AiAskResult['usage'] {
  const source = protocol === 'google-generate-content' ? payload.usageMetadata : payload.usage
  if (!source || typeof source !== 'object') return undefined
  const usage = source as Record<string, unknown>
  const prompt = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? usage.inputTokens
  )
  const completion = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount ??
      usage.outputTokens
  )
  const total = Number(usage.total_tokens ?? usage.totalTokenCount ?? usage.totalTokens)
  return {
    promptTokens: Number.isFinite(prompt) && prompt > 0 ? prompt : undefined,
    completionTokens: Number.isFinite(completion) && completion > 0 ? completion : undefined,
    totalTokens: Number.isFinite(total) && total > 0 ? total : undefined
  }
}

function extractTextContentField(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return (value as unknown[])
      .flatMap((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : []
      )
      .join('')
  }
  return ''
}

/** 从各协议的单帧 SSE JSON 中提取增量文本、可选 token 用量与完成/思考状态（导出供单测直接验证） */
export function extractStreamDelta(
  protocol: AiProtocol,
  payload: Record<string, unknown>
): {
  delta: string
  usage?: AiAskResult['usage']
  finishReason?: string
  sawReasoning?: boolean
} {
  if (protocol === 'openai-responses') {
    const delta =
      payload.type === 'response.output_text.delta' && typeof payload.delta === 'string'
        ? payload.delta
        : ''
    const responseObj =
      (payload.type === 'response.completed' || payload.type === 'response.incomplete') &&
      payload.response &&
      typeof payload.response === 'object'
        ? (payload.response as Record<string, unknown>)
        : payload
    const finishReason =
      payload.type === 'response.incomplete' || responseObj.status === 'incomplete'
        ? 'length'
        : undefined
    return { delta, usage: usageFromResponse(protocol, responseObj), finishReason }
  }
  if (protocol === 'anthropic-messages') {
    let delta = ''
    let finishReason: string | undefined
    let sawReasoning = false
    if (
      payload.type === 'content_block_delta' &&
      payload.delta &&
      typeof payload.delta === 'object'
    ) {
      const deltaObj = payload.delta as Record<string, unknown>
      if (deltaObj.type === 'text_delta' && typeof deltaObj.text === 'string') {
        delta = deltaObj.text
      } else if (deltaObj.type === 'thinking_delta') {
        sawReasoning = true
      }
    }
    if (payload.delta && typeof payload.delta === 'object') {
      const stopReason = (payload.delta as Record<string, unknown>).stop_reason
      if (typeof stopReason === 'string' && stopReason) {
        finishReason = stopReason
      }
    }
    const usageSource =
      payload.message && typeof payload.message === 'object'
        ? (payload.message as Record<string, unknown>)
        : payload
    return {
      delta,
      usage: usageFromResponse(protocol, usageSource),
      finishReason,
      sawReasoning: sawReasoning || undefined
    }
  }
  if (protocol === 'google-generate-content') {
    const candidates = Array.isArray(payload.candidates)
      ? (payload.candidates as Array<Record<string, unknown>>)
      : []
    const first = candidates[0]
    const contentObj =
      first?.content && typeof first.content === 'object'
        ? (first.content as Record<string, unknown>)
        : undefined
    const parts = Array.isArray(contentObj?.parts) ? (contentObj.parts as unknown[]) : []
    const sawReasoning = parts.some(
      (part) =>
        part && typeof part === 'object' && (part as Record<string, unknown>).thought === true
    )
    const finishReason = typeof first?.finishReason === 'string' ? first.finishReason : undefined
    return {
      delta: textFromResponse(protocol, payload),
      usage: usageFromResponse(protocol, payload),
      finishReason,
      sawReasoning: sawReasoning || undefined
    }
  }
  const choices = Array.isArray(payload.choices)
    ? (payload.choices as Array<Record<string, unknown>>)
    : []
  const deltaObj =
    choices[0]?.delta && typeof choices[0].delta === 'object'
      ? (choices[0].delta as Record<string, unknown>)
      : undefined
  const messageObj =
    choices[0]?.message && typeof choices[0].message === 'object'
      ? (choices[0].message as Record<string, unknown>)
      : undefined
  let delta = deltaObj ? extractTextContentField(deltaObj.content) : ''
  if (!delta && !deltaObj && messageObj) {
    delta = extractTextContentField(messageObj.content)
  }
  const finishReason =
    typeof choices[0]?.finish_reason === 'string' ? choices[0].finish_reason : undefined
  const sawReasoning = Boolean(
    deltaObj?.reasoning_content ||
    deltaObj?.reasoning ||
    messageObj?.reasoning_content ||
    messageObj?.reasoning
  )
  return {
    delta,
    usage: usageFromResponse(protocol, payload),
    finishReason,
    sawReasoning: sawReasoning || undefined
  }
}

/** 解析 ReadableStream SSE 分片（处理 UTF-8 跨块解码、半行拼接与 [DONE] 终止） */
export async function consumeSseStream(
  protocol: AiProtocol,
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  options?: { onActivity?: () => void }
): Promise<{
  content: string
  usage?: AiAskResult['usage']
  finishReason?: string
  sawReasoning?: boolean
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let content = ''
  let mergedUsage: AiAskResult['usage']
  let finishReason: string | undefined
  let sawReasoning = false
  let streamFinished = false

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return false
    const data = line.slice(5).trimStart()
    if (!data) return false
    if (data === '[DONE]') {
      streamFinished = true
      return true
    }
    const payload = safeParse<Record<string, unknown> | null>(data, null)
    if (!payload) return false
    if (payload.error) {
      throw new Error(`模型服务返回错误：${responseError(payload, data)}`)
    }
    const {
      delta,
      usage,
      finishReason: frameFinishReason,
      sawReasoning: frameReasoning
    } = extractStreamDelta(protocol, payload)
    if (frameFinishReason) finishReason = frameFinishReason
    if (frameReasoning) sawReasoning = true
    if (usage) {
      mergedUsage = {
        promptTokens: usage.promptTokens ?? mergedUsage?.promptTokens,
        completionTokens: usage.completionTokens ?? mergedUsage?.completionTokens,
        totalTokens: usage.totalTokens ?? mergedUsage?.totalTokens
      }
    }
    if (delta) {
      content += delta
      onDelta(delta)
    }
    return false
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        streamFinished = true
        break
      }
      if (value?.byteLength) {
        options?.onActivity?.()
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (handleLine(line)) {
          await reader.cancel().catch(() => {})
          return {
            content,
            usage: mergedUsage,
            finishReason,
            sawReasoning: sawReasoning || undefined
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n')
    for (const line of buffer.split('\n')) {
      if (handleLine(line)) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } finally {
    if (!streamFinished) {
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
  return {
    content,
    usage: mergedUsage,
    finishReason,
    sawReasoning: sawReasoning || undefined
  }
}

export class AiService {
  private readonly activeStreams = new Map<string, AbortController>()
  private readonly userCancelled = new Set<string>()

  constructor(private readonly database: DatabaseService) {}

  providers(): AiProviderInfo[] {
    return PROVIDERS.map((provider) => ({ ...provider }))
  }

  getConfig(): AiConfigView {
    const record = this.database.getAiRecord()
    if (!record) return { ...DEFAULT_AI_CONFIG }
    const fallback = this.toStored(DEFAULT_AI_CONFIG)
    const raw = safeParse<Partial<StoredAiConfig>>(record.payload_json, fallback)
    const info = providerInfo(raw.provider ?? fallback.provider)
    const stored: StoredAiConfig = {
      provider: raw.provider ?? fallback.provider,
      protocol: raw.protocol ?? info.protocol,
      baseUrl: raw.baseUrl ?? info.defaultBaseUrl,
      model: raw.model ?? info.defaultModel,
      temperature: raw.temperature ?? fallback.temperature,
      maxTokens: raw.maxTokens ?? fallback.maxTokens
    }
    return {
      ...stored,
      hasApiKey: typeof record.encrypted_key === 'string' && record.encrypted_key.length > 0,
      verified: Boolean(record.verified),
      lastCheckedAt: record.last_checked_at ? String(record.last_checked_at) : undefined,
      lastError: record.last_error ? String(record.last_error) : undefined
    }
  }

  saveConfig(input: AiConfigInput): AiConfigView {
    const baseUrl = parseBaseUrl(input.baseUrl, input.provider).toString().replace(/\/$/, '')
    const config: StoredAiConfig = {
      provider: input.provider,
      protocol: input.protocol,
      baseUrl,
      model: input.model.trim(),
      temperature: Math.max(0, Math.min(2, input.temperature)),
      maxTokens: Math.max(256, Math.min(32768, Math.round(input.maxTokens)))
    }
    if (!config.model) throw new Error('模型名称不能为空')
    const encryptedKey = this.encryptApiKey(input.apiKey)
    this.database.saveAiRecord(JSON.stringify(config), encryptedKey, false)
    return this.getConfig()
  }

  clearCredential(): AiConfigView {
    this.database.clearAiCredential()
    return this.getConfig()
  }

  // ---- VLM 按页精校：开关、视觉模型配置与多模态请求 ----

  getVlmConfig(): VlmConfigView {
    const record = this.database.getVlmRecord()
    const stored = safeParse<Partial<StoredVlmMeta>>(record?.payload_json ?? '', {})
    const main = this.getConfig()
    return {
      enabled: Boolean(stored.enabled),
      mode: stored.mode === 'custom' ? 'custom' : 'reuse-main',
      provider: stored.provider,
      protocol: stored.protocol,
      baseUrl: stored.baseUrl,
      model: stored.model,
      hasApiKey: Boolean(record?.encrypted_key),
      verified: Boolean(record?.verified),
      lastCheckedAt: record?.last_checked_at ? String(record.last_checked_at) : undefined,
      lastError: record?.last_error ? String(record.last_error) : undefined,
      mainProvider: main.provider,
      mainModel: main.model
    }
  }

  saveVlmConfig(input: VlmConfigInput): VlmConfigView {
    const previous = safeParse<Partial<StoredVlmMeta>>(
      this.database.getVlmRecord()?.payload_json ?? '',
      {}
    )
    const mode: VlmModelMode = input.mode === 'custom' ? 'custom' : 'reuse-main'
    const meta: StoredVlmMeta = { enabled: Boolean(input.enabled), mode }
    if (mode === 'custom') {
      const provider = input.provider ?? previous.provider
      const protocol = input.protocol ?? previous.protocol
      const baseUrl = input.baseUrl ?? previous.baseUrl
      const model = input.model ?? previous.model
      if (!provider || !protocol || !baseUrl || !baseUrl.trim() || !model || !model.trim())
        throw new Error('自定义视觉模型需要提供服务类型、协议、地址与模型名称')
      // 与主模型同一套 SSRF/HTTPS 校验
      meta.provider = provider
      meta.protocol = protocol
      meta.baseUrl = parseBaseUrl(baseUrl, provider).toString().replace(/\/$/, '')
      meta.model = model.trim()
    } else if (previous.provider && previous.protocol && previous.baseUrl && previous.model) {
      // 复用主模型：保留已保存的自定义配置，切回 custom 时无需重填
      meta.provider = previous.provider
      meta.protocol = previous.protocol
      meta.baseUrl = previous.baseUrl
      meta.model = previous.model
    }
    const encryptedKey = this.encryptApiKey(input.apiKey)
    this.database.saveVlmRecord(JSON.stringify(meta), encryptedKey, false)
    return this.getVlmConfig()
  }

  clearVlmCredential(): VlmConfigView {
    this.database.clearVlmCredential()
    return this.getVlmConfig()
  }

  /** VLM 探活：带一张 1x1 测试图走真实多模态请求；纯文本模型的报错转化为清晰中文引导。
   *  总开关未开启时也允许提前探活（只校验配置并请求，不静默翻转开关）；
   *  探活结果只更新 verified/lastError，payload_json 保持用户已保存的开关状态 */
  async testVlm(timeoutMs = 40_000): Promise<VlmConfigView> {
    const storedMeta = (): string => {
      const payload = this.database.getVlmRecord()?.payload_json
      return typeof payload === 'string' && payload.trim()
        ? payload
        : // 表为空时的 fallback 必须保持关闭：探活通过不等于用户同意开启外发
          JSON.stringify({ enabled: false, mode: 'reuse-main' })
    }
    try {
      const target = this.resolveVisionTarget(false)
      const result = await this.askVision(
        {
          messages: [
            { role: 'system', content: FEATURE_PROMPTS.connectivity },
            { role: 'user', content: '执行连接测试，只回复 OK。', images: [VISION_PROBE_IMAGE] }
          ]
        },
        {
          provider: target.config.provider,
          protocol: target.config.protocol,
          baseUrl: target.config.baseUrl,
          model: target.config.model,
          temperature: target.config.temperature,
          maxTokens: target.config.maxTokens,
          apiKey: target.apiKey || undefined
        },
        timeoutMs
      )
      if (!result.content.trim())
        throw new Error('模型已连接，但未返回内容，请确认该模型支持图片输入')
      this.database.saveVlmRecord(storedMeta(), null, true, now())
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败'
      this.database.saveVlmRecord(storedMeta(), null, false, now(), message)
    }
    return this.getVlmConfig()
  }

  /** 多模态请求：完整复用 ask 的 SSRF 校验、协议分发与错误脱敏。
   *  override 供测试/特殊调用方显式指定模型；生产路径走 VLM 配置解析。 */
  async askVision(
    input: { messages: AiMessage[] },
    override?: AiConfigInput,
    timeoutMs = 120_000
  ): Promise<AiAskResult> {
    if (!input.messages.length) throw new Error('消息不能为空')
    let config: StoredAiConfig
    let apiKey: string
    if (override) {
      config = {
        provider: override.provider,
        protocol: override.protocol,
        baseUrl: parseBaseUrl(override.baseUrl, override.provider).toString().replace(/\/$/, ''),
        model: override.model,
        temperature: Math.max(0, Math.min(2, override.temperature)),
        maxTokens: Math.max(256, Math.min(32768, Math.round(override.maxTokens)))
      }
      apiKey = override.apiKey?.trim() ?? ''
    } else {
      const target = this.resolveVisionTarget(true)
      config = target.config
      apiKey = target.apiKey
    }
    validateVisionMessages(input.messages)
    if (providerInfo(config.provider).apiKeyRequired && !apiKey)
      throw new Error('请先在模型设置中保存 API Key')
    return this.executeRequest(config, input.messages, apiKey, { timeoutMs, visionMode: true })
  }

  /** 解析当前生效的视觉模型：reuse-main 直接复用全局配置；custom 读 vlm_config 存储。
   *  requireEnabled=false 供 testVlm 在开关未开启时提前探活（只校验配置，不要求先打开开关） */
  private resolveVisionTarget(requireEnabled: boolean): { config: StoredAiConfig; apiKey: string } {
    const view = this.getVlmConfig()
    if (requireEnabled && !view.enabled)
      throw new Error('VLM 按页精校未开启，请先在模型设置中打开该开关')
    if (view.mode === 'reuse-main') {
      const main = this.getConfig()
      const apiKey = this.readApiKey()
      // reuse-main 探活/精校都复用主模型：主模型密钥必须先就位
      if (providerInfo(main.provider).apiKeyRequired && !apiKey)
        throw new Error(
          requireEnabled
            ? '请先在模型设置中保存 API Key'
            : 'reuse-main 模式将复用主模型，请先在模型设置中保存主模型 API Key'
        )
      return { config: this.toStored(main), apiKey }
    }
    if (!view.provider || !view.protocol || !view.baseUrl || !view.model)
      throw new Error('视觉模型配置不完整，请在模型设置中补全服务地址与模型名称')
    const record = this.database.getVlmRecord()
    const stored = safeParse<Partial<StoredAiConfig>>(record?.payload_json ?? '', {})
    const config: StoredAiConfig = {
      provider: view.provider,
      protocol: view.protocol,
      baseUrl: view.baseUrl,
      model: view.model,
      temperature: typeof stored.temperature === 'number' ? stored.temperature : 0.2,
      maxTokens: typeof stored.maxTokens === 'number' ? Math.max(1024, stored.maxTokens) : 8192
    }
    return { config, apiKey: this.readKeyFromRecord(record, '视觉模型') }
  }

  private encryptApiKey(apiKey?: string): string | null {
    const trimmed = apiKey?.trim()
    if (!trimmed) return null
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('当前系统安全存储不可用，API Key 未保存')
    return safeStorage.encryptString(trimmed).toString('base64')
  }

  private readKeyFromRecord(
    record: ReturnType<DatabaseService['getVlmRecord']>,
    label: string
  ): string {
    if (!record?.encrypted_key || typeof record.encrypted_key !== 'string') return ''
    if (!safeStorage.isEncryptionAvailable())
      throw new Error(`当前系统安全存储不可用，无法读取${label} API Key`)
    try {
      return safeStorage.decryptString(Buffer.from(record.encrypted_key, 'base64'))
    } catch {
      throw new Error(`${label ? `${label} ` : ''}API Key 无法解密，请重新保存`)
    }
  }

  async discoverModels(): Promise<string[]> {
    const config = this.toStored(this.getConfig())
    const apiKey = this.readApiKey()
    if (providerInfo(config.provider).apiKeyRequired && !apiKey) throw new Error('请先保存 API Key')
    await verifyNetworkTarget(config.baseUrl, config.provider)
    let endpoint: string
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (config.protocol === 'google-generate-content') {
      const root = /\/v1beta$/i.test(config.baseUrl)
        ? config.baseUrl
        : appendEndpoint(config.baseUrl, 'v1beta')
      endpoint = appendEndpoint(root, 'models')
      headers['x-goog-api-key'] = apiKey
    } else {
      endpoint = appendEndpoint(
        config.baseUrl,
        /\/(v1|v3|v4)$/i.test(config.baseUrl) ? 'models' : 'v1/models'
      )
      if (config.protocol === 'anthropic-messages') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    }
    const response = await fetch(endpoint, { headers, redirect: 'error' })
    const raw = await response.text()
    const payload = safeParse<Record<string, unknown>>(raw, {})
    if (!response.ok)
      throw new Error(`模型列表返回 ${response.status}：${responseError(payload, raw)}`)
    const values = config.protocol === 'google-generate-content' ? payload.models : payload.data
    return [
      ...new Set(
        (Array.isArray(values) ? values : []).flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const key = config.protocol === 'google-generate-content' ? 'name' : 'id'
          const value = (item as Record<string, unknown>)[key]
          return typeof value === 'string' ? [value.replace(/^models\//, '')] : []
        })
      )
    ].sort((a, b) => a.localeCompare(b))
  }

  async test(): Promise<AiConfigView> {
    try {
      const result = await this.ask(
        {
          messages: [
            { role: 'system', content: FEATURE_PROMPTS.connectivity },
            { role: 'user', content: '执行连接测试。' }
          ],
          purpose: 'chat'
        },
        20_000
      )
      if (result.content.trim() !== 'OK')
        throw new Error('模型已连接，但未按连接测试协议返回 OK，请检查模型兼容性')
      const view = this.getConfig()
      this.database.saveAiRecord(JSON.stringify(this.toStored(view)), null, true, now())
    } catch (error) {
      const view = this.getConfig()
      this.database.saveAiRecord(
        JSON.stringify(this.toStored(view)),
        null,
        false,
        now(),
        error instanceof Error ? error.message : '连接失败'
      )
    }
    return this.getConfig()
  }

  private prepareAskContext(input: AiAskInput): {
    config: StoredAiConfig
    apiKey: string
    messages: AiMessage[]
  } {
    const config = this.toStored(this.getConfig())
    const apiKey = this.readApiKey()
    if (providerInfo(config.provider).apiKeyRequired && !apiKey)
      throw new Error('请先在模型设置中保存 API Key')
    if (input.messages.length === 0) throw new Error('消息不能为空')
    const messages: AiMessage[] = [
      { role: 'system', content: basePromptForPurpose(input.purpose) },
      ...input.messages
    ]
    // 知识整理与申论批改需输出大段结构化 JSON，按目的设置安全 maxTokens 下限避免中途截断
    let minTokensForPurpose = config.maxTokens
    if (input.purpose === 'knowledge') {
      minTokensForPurpose = 16384
    } else if (input.purpose === 'evaluate') {
      minTokensForPurpose =
        config.protocol === 'openai-responses' || config.protocol === 'google-generate-content'
          ? 8192
          : 4096
    }
    const effective: StoredAiConfig =
      minTokensForPurpose > config.maxTokens
        ? { ...config, maxTokens: minTokensForPurpose }
        : config
    return { config: effective, apiKey, messages }
  }

  cancelStream(requestId: string): boolean {
    const controller = this.activeStreams.get(requestId)
    if (!controller) return false
    this.userCancelled.add(requestId)
    controller.abort()
    this.activeStreams.delete(requestId)
    return true
  }

  async ask(input: AiAskInput, timeoutMs = 60_000): Promise<AiAskResult> {
    const { config, apiKey, messages } = this.prepareAskContext(input)
    return this.executeRequest(config, messages, apiKey, { timeoutMs })
  }

  async askStream(
    input: AiAskInput & { requestId: string },
    callbacks: { onChunk: (delta: string) => void },
    timeoutMs = 120_000
  ): Promise<AiAskResult & { aborted?: boolean }> {
    const { config, apiKey, messages } = this.prepareAskContext(input)
    const controller = new AbortController()
    this.activeStreams.set(input.requestId, controller)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), timeoutMs)
    }
    resetIdleTimer()
    const hardCapTimer = setTimeout(() => controller.abort(), Math.max(timeoutMs * 2, 240_000))
    let accumulated = ''
    const emitDelta = (delta: string): void => {
      if (!delta) return
      accumulated += delta
      callbacks.onChunk(delta)
    }
    try {
      await verifyNetworkTarget(config.baseUrl, config.provider)
      if (controller.signal.aborted || this.userCancelled.has(input.requestId)) {
        if (this.userCancelled.has(input.requestId)) {
          return {
            content: '',
            provider: config.provider,
            model: config.model,
            aborted: true
          }
        }
        throw new Error('模型请求超时，请检查网络或服务地址')
      }
      const request = requestSpec(config, messages, apiKey, { stream: true })
      const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error'
      })
      resetIdleTimer()
      if (!response.ok) {
        const raw = await response.text()
        const payload = safeParse<Record<string, unknown>>(raw, {})
        throw new Error(`模型服务返回 ${response.status}：${responseError(payload, raw)}`)
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      let usage: AiAskResult['usage']
      let finishReason: string | undefined
      let sawReasoning = false
      if (contentType.includes('text/event-stream') && response.body) {
        const streamed = await consumeSseStream(config.protocol, response.body, emitDelta, {
          onActivity: resetIdleTimer
        })
        usage = streamed.usage
        finishReason = streamed.finishReason
        sawReasoning = Boolean(streamed.sawReasoning)
      } else {
        const raw = await response.text()
        if (/^data:/m.test(raw.trimStart())) {
          const singleChunkStream = new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode(raw))
              streamController.close()
            }
          })
          const streamed = await consumeSseStream(config.protocol, singleChunkStream, emitDelta)
          usage = streamed.usage
          finishReason = streamed.finishReason
          sawReasoning = Boolean(streamed.sawReasoning)
        } else {
          const payload = safeParse<Record<string, unknown>>(raw, {})
          const content = textFromResponse(config.protocol, payload)
          usage = usageFromResponse(config.protocol, payload)
          if (content) emitDelta(content)
          else {
            const choices = Array.isArray(payload.choices)
              ? (payload.choices as Array<Record<string, unknown>>)
              : []
            const candidates = Array.isArray(payload.candidates)
              ? (payload.candidates as Array<Record<string, unknown>>)
              : []
            finishReason =
              (choices[0]?.finish_reason as string | undefined) ??
              (candidates[0]?.finishReason as string | undefined) ??
              (typeof payload.stop_reason === 'string' ? payload.stop_reason : undefined)
            if (payload.status === 'incomplete') finishReason = 'length'
          }
        }
      }
      if (!accumulated.trim() && !this.userCancelled.has(input.requestId)) {
        const truncated =
          finishReason === 'length' ||
          finishReason === 'MAX_TOKENS' ||
          finishReason === 'max_tokens' ||
          sawReasoning
        if (truncated) {
          throw new Error(
            '模型输出被最大长度截断（可能因思考过程占满预算），请在模型设置中调大最大输出长度或关闭思考模型'
          )
        }
        throw new Error('模型返回了空内容')
      }
      return {
        content: accumulated,
        provider: config.provider,
        model: config.model,
        usage,
        ...(this.userCancelled.has(input.requestId) ? { aborted: true } : {})
      }
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        this.userCancelled.has(input.requestId)
      ) {
        if (this.userCancelled.has(input.requestId)) {
          return {
            content: accumulated,
            provider: config.provider,
            model: config.model,
            aborted: true
          }
        }
        throw new Error('模型请求超时，请检查网络或服务地址')
      }
      throw error
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardCapTimer)
      this.activeStreams.delete(input.requestId)
      this.userCancelled.delete(input.requestId)
    }
  }

  private async executeRequest(
    config: StoredAiConfig,
    messages: AiMessage[],
    apiKey: string,
    options: { timeoutMs: number; visionMode?: boolean }
  ): Promise<AiAskResult> {
    await verifyNetworkTarget(config.baseUrl, config.provider)
    const request = requestSpec(config, messages, apiKey)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error'
      })
      const raw = await response.text()
      const payload = safeParse<Record<string, unknown>>(raw, {})
      if (!response.ok) {
        const detail = responseError(payload, raw)
        // 纯文本模型的典型报错（image/multimodal/vision 等）转为可操作引导，不泄漏原始堆栈
        if (options.visionMode && isVisionUnsupportedError(detail))
          throw new Error(VISION_UNSUPPORTED_MESSAGE)
        throw new Error(`模型服务返回 ${response.status}：${detail}`)
      }
      const content = textFromResponse(config.protocol, payload)
      if (!content.trim()) {
        const choices = Array.isArray(payload.choices)
          ? (payload.choices as Array<Record<string, unknown>>)
          : []
        const candidates = Array.isArray(payload.candidates)
          ? (payload.candidates as Array<Record<string, unknown>>)
          : []
        const finishReason =
          (choices[0]?.finish_reason as string | undefined) ??
          (candidates[0]?.finishReason as string | undefined) ??
          (typeof payload.stop_reason === 'string' ? payload.stop_reason : undefined)
        if (
          finishReason === 'length' ||
          finishReason === 'MAX_TOKENS' ||
          finishReason === 'max_tokens' ||
          payload.status === 'incomplete'
        )
          throw new Error(
            '模型输出被最大长度截断（可能因思考过程占满预算），请在模型设置中调大最大输出长度或关闭思考模型'
          )
        throw new Error('模型返回了空内容')
      }
      return {
        content,
        provider: config.provider,
        model: config.model,
        usage: usageFromResponse(config.protocol, payload)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        throw new Error('模型请求超时，请检查网络或服务地址')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private toStored(view: AiConfigView): StoredAiConfig {
    return {
      provider: view.provider,
      protocol: view.protocol,
      baseUrl: view.baseUrl,
      model: view.model,
      temperature: view.temperature,
      maxTokens: view.maxTokens
    }
  }

  private readApiKey(): string {
    return this.readKeyFromRecord(this.database.getAiRecord(), '')
  }
}
