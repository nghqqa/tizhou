// VLM 按页精校：多模态协议构造、SSRF 降级、精校链路与结构保护全链路测试。
// 全部使用 mock / 本地 HTTP server，不需要真实 API Key。
import { createServer, type Server, type AddressInfo } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import {
  KnowledgeBuilderService,
  MAX_AUTO_VLM_PAGES,
  partitionByPublishGate,
  VLM_REVIEW_WARNING
} from '../src/main/services/knowledge-builder'
import {
  AiService,
  MAX_VISION_IMAGES_PER_REQUEST,
  requestSpec,
  type StoredAiConfig
} from '../src/main/services/ai'
import { VaultService } from '../src/main/services/vault'
import type {
  AiImageInput,
  AiMessage,
  KnowledgeArtifactStatus,
  SourceEvidence
} from '../src/shared/contracts'
import { FEATURE_PROMPTS, sourceEnvelope, taskDataEnvelope } from '../src/shared/prompts'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) =>
      Buffer.from(buffer.toString('utf8').replace(/^enc:/, ''), 'utf8')
  }
}))

const temporaryDirectories: string[] = []
const openDatabases: DatabaseService[] = []
function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close()
    } catch {
      // 已关闭则忽略
    }
  }
  for (const path of temporaryDirectories.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Windows 上句柄延迟释放时容忍清理失败（目录在系统临时区，不污染仓库）
    }
  }
})

const PROBE_IMAGE: AiImageInput = {
  mimeType: 'image/jpeg',
  dataUrl: 'data:image/jpeg;base64,QUJD'
}

function config(overrides: Partial<StoredAiConfig> = {}): StoredAiConfig {
  return {
    provider: 'deepseek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.3,
    maxTokens: 4096,
    ...overrides
  }
}

function makeDatabase(): DatabaseService {
  const data = temporaryDirectory('tizhou-vlm-db-')
  const database = new DatabaseService(join(data, 'workbench.sqlite'), data, join(data, 'backups'))
  openDatabases.push(database)
  return database
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('AiService 多模态请求构造', () => {
  const userWithImage: AiMessage = {
    role: 'user',
    content: '对照图片核对数字',
    images: [PROBE_IMAGE]
  }
  const systemMessage: AiMessage = { role: 'system', content: '校对协议' }

  it('openai-chat 官方 DeepSeek 端点：image_url + detail high + thinking disabled', () => {
    const spec = requestSpec(config(), [systemMessage, userWithImage], 'k')
    const messages = spec.body.messages as Array<Record<string, unknown>>
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: '对照图片核对数字' },
      { type: 'image_url', image_url: { url: PROBE_IMAGE.dataUrl, detail: 'high' } }
    ])
    expect(spec.body.thinking).toEqual({ type: 'disabled' })
    expect(spec.endpoint).toBe('https://api.deepseek.com/chat/completions')
  })

  it('openai-chat 非 DeepSeek/OpenAI 官方端点：不强加 detail 与 thinking 扩展字段', () => {
    const spec = requestSpec(
      config({
        provider: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-vl-max'
      }),
      [systemMessage, userWithImage],
      'k'
    )
    const messages = spec.body.messages as Array<Record<string, unknown>>
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: '对照图片核对数字' },
      { type: 'image_url', image_url: { url: PROBE_IMAGE.dataUrl } }
    ])
    expect(spec.body.thinking).toBeUndefined()
  })

  it('纯文本消息与原实现一字节不变：字符串 content 且保持原数组引用', () => {
    const messages: AiMessage[] = [systemMessage, { role: 'user', content: '你好' }]
    const spec = requestSpec(config(), messages, 'k')
    expect(spec.body.messages).toBe(messages)
    expect((spec.body.messages as AiMessage[])[1]!.content).toBe('你好')
  })

  it('openai-responses：input_text + input_image 内容块；无图原样透传', () => {
    const spec = requestSpec(
      config({
        provider: 'openai',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini'
      }),
      [systemMessage, userWithImage],
      'k'
    )
    const input = spec.body.input as Array<Record<string, unknown>>
    expect(input[1]!.content).toEqual([
      { type: 'input_text', text: '对照图片核对数字' },
      { type: 'input_image', image_url: PROBE_IMAGE.dataUrl }
    ])
    const plain: AiMessage[] = [systemMessage, { role: 'user', content: '你好' }]
    const noImageSpec = requestSpec(
      config({
        provider: 'openai',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1'
      }),
      plain,
      'k'
    )
    expect(noImageSpec.body.input).toBe(plain)
  })

  it('anthropic-messages：image source base64 内容块 + system 单独提升', () => {
    const spec = requestSpec(
      config({
        provider: 'anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com'
      }),
      [systemMessage, userWithImage],
      'k'
    )
    expect(spec.body.system).toBe('校对协议')
    const messages = spec.body.messages as Array<Record<string, unknown>>
    expect(messages[0]!.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' }
      },
      { type: 'text', text: '对照图片核对数字' }
    ])
  })

  it('google-generate-content：inlineData 内容块', () => {
    const spec = requestSpec(
      config({
        provider: 'google',
        protocol: 'google-generate-content',
        baseUrl: 'https://generativelanguage.googleapis.com'
      }),
      [systemMessage, userWithImage],
      'k'
    )
    const contents = spec.body.contents as Array<Record<string, unknown>>
    expect(contents[0]!.parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
      { text: '对照图片核对数字' }
    ])
  })

  it('单次请求最多 3 张图，超出拒绝', async () => {
    const service = new AiService(makeDatabase())
    const images = Array.from({ length: MAX_VISION_IMAGES_PER_REQUEST + 1 }, () => PROBE_IMAGE)
    await expect(
      service.askVision(
        { messages: [{ role: 'user', content: 'x', images }] },
        {
          provider: 'ollama',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'vl',
          temperature: 0.2,
          maxTokens: 256
        }
      )
    ).rejects.toThrow('单次视觉请求最多携带 3 张页面图片')
  })

  it('非法图片载荷（非 data:image 前缀）拒绝', async () => {
    const service = new AiService(makeDatabase())
    await expect(
      service.askVision(
        {
          messages: [
            {
              role: 'user',
              content: 'x',
              images: [{ mimeType: 'image/jpeg', dataUrl: 'http://x/y.jpg' }]
            }
          ]
        },
        {
          provider: 'ollama',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'vl',
          temperature: 0.2,
          maxTokens: 256
        }
      )
    ).rejects.toThrow('data:image')
  })

  it('askVision 远程 provider 指向回环地址被 SSRF 校验拒绝', async () => {
    const service = new AiService(makeDatabase())
    await expect(
      service.askVision(
        { messages: [userWithImage] },
        {
          provider: 'qwen',
          protocol: 'openai-chat',
          baseUrl: 'https://127.0.0.1:9000/v1',
          model: 'x',
          temperature: 0.2,
          maxTokens: 256
        }
      )
    ).rejects.toThrow('远程模型服务不能指向本机或私有网络')
  })

  it('askVision 本地回环端到端：openai-chat 请求体携带 image_url 且返回内容', async () => {
    let received: Record<string, unknown> | undefined
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        received = JSON.parse(raw) as Record<string, unknown>
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
      })
    })
    const port = await listen(server)
    try {
      const service = new AiService(makeDatabase())
      const result = await service.askVision(
        { messages: [userWithImage] },
        {
          provider: 'ollama',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'vl-test',
          temperature: 0.2,
          maxTokens: 256
        },
        10_000
      )
      expect(result.content).toBe('OK')
      const messages = received!.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(messages[0]!.content[1]).toMatchObject({ type: 'image_url' })
    } finally {
      server.close()
    }
  })

  it('纯文本模型返回不支持图片的报错时降级为清晰中文提示', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 400
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({ error: { message: 'This model does not support image input.' } })
      )
    })
    const port = await listen(server)
    try {
      const service = new AiService(makeDatabase())
      await expect(
        service.askVision(
          { messages: [userWithImage] },
          {
            provider: 'ollama',
            protocol: 'openai-chat',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: 'text-only',
            temperature: 0.2,
            maxTokens: 256
          },
          10_000
        )
      ).rejects.toThrow('当前模型不支持图片输入，请切换或单独配置支持视觉的模型')
    } finally {
      server.close()
    }
  })
})

// ---- KnowledgeBuilderService：产物 fixture 与 VLM 精校链路 ----

const SOURCE_ID = 'src1'

function questionMarkdown(overrides?: {
  optionImage?: string
  withMaterial?: boolean
  id?: string
}): string {
  const withMaterial = overrides?.withMaterial ?? true
  const artifactId = overrides?.id ?? 'kb-a1b2c3d4e5'
  const options = [
    { key: 'A', text: '选项甲' },
    { key: 'B', text: '选项乙' }
  ]
  const lines = [
    '---',
    `id: "${artifactId}"`,
    'subject: "xingce"',
    'category: "资料分析"',
    'tags: ["回归"]',
    'source: "本地资料/题本.pdf"',
    'sourceFile: "题本.pdf"',
    'confidence: 1.00',
    'reviewStatus: "pending"',
    'generatedBy: "direct-import"',
    'kind: "question"',
    'questionType: "single"',
    'difficulty: 3',
    'stem: "下列说法正确的是？"',
    'material: "2023年全国社会消费品零售总额 471495 亿元，比上年增长7.2%。"',
    'groupId: "g1"',
    'groupOrder: 1',
    `options: ${JSON.stringify(
      overrides?.optionImage
        ? [...options, { key: 'C', text: '', image: overrides.optionImage }]
        : options
    )}`,
    'answer: ["A"]',
    'explanation: "参考解析文字。"',
    '---',
    '',
    '# 题目',
    '',
    '下列说法正确的是？',
    '',
    '## 选项',
    '',
    'A. 选项甲',
    'B. 选项乙'
  ]
  if (overrides?.optionImage) lines.push('C. ![选项C](images/figure-1.png)')
  if (withMaterial) {
    // directQuestionMarkdown 契约：共享材料置顶（## 共享材料 区块在 # 题目 之前）
    lines.splice(
      lines.indexOf('---', 2) + 1,
      0,
      '',
      '## 共享材料',
      '',
      '2023年全国社会消费品零售总额 471495 亿元，比上年增长7.2%。'
    )
  }
  lines.push('', '## 答案', '', 'A', '', '## 解析', '', '参考解析文字。')
  return `${lines.join('\n')}\n`
}

function evidence(page = 3): SourceEvidence {
  return {
    status: 'available',
    references: [
      {
        role: 'material',
        sourceId: SOURCE_ID,
        relativePath: '题本.pdf',
        pages: [{ pageNumber: page, mapping: 'exact' }]
      }
    ]
  }
}

interface FixtureArtifact {
  id: string
  markdown: string
  capability?: string
  status?: KnowledgeArtifactStatus
  warnings?: string[]
  humanConfirmed?: boolean
  evidence?: SourceEvidence
}

function writeJobFixture(
  data: string,
  artifacts: FixtureArtifact[]
): { jobId: string; outputPath: string } {
  const jobId = 'kbjob-f1e2d3c4-1111-4222-8333-444444444444'
  const outputPath = join(data, 'job-output')
  mkdirSync(join(data, 'knowledge-builder', 'jobs', jobId, 'artifacts'), { recursive: true })
  const job = {
    id: jobId,
    sourcePath: join(data, 'source'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'completed',
    options: {
      mode: 'direct',
      quality: 'high',
      subject: 'xingce',
      tags: [],
      instruction: '',
      rightsConfirmed: true
    },
    files: [
      {
        sourceId: SOURCE_ID,
        relativePath: '题本.pdf',
        size: 12,
        state: 'ready',
        artifactCount: artifacts.length,
        chunkCount: 0
      }
    ],
    artifactIds: artifacts.map((artifact) => artifact.id),
    cancelRequested: false,
    outputPath
  }
  writeFileSync(
    join(data, 'knowledge-builder', 'jobs', jobId, 'job.json'),
    JSON.stringify(job, null, 2),
    'utf8'
  )
  for (const artifact of artifacts) {
    writeFileSync(
      join(data, 'knowledge-builder', 'jobs', jobId, 'artifacts', `${artifact.id}.json`),
      JSON.stringify(
        {
          id: artifact.id,
          jobId,
          sourceId: SOURCE_ID,
          sourcePath: '题本.pdf',
          relativeSourcePath: '题本.pdf',
          kind: 'question',
          subject: 'xingce',
          title: '测试题目',
          category: '资料分析',
          confidence: 1,
          generatedBy: 'direct-import',
          status: artifact.status ?? 'pending',
          warnings: artifact.warnings ?? [],
          preview: '下列说法正确的是？',
          markdown: artifact.markdown,
          evidenceExcerpt: '下列说法正确的是？',
          capability: artifact.capability,
          humanConfirmed: artifact.humanConfirmed,
          sourceEvidence: artifact.evidence ?? evidence()
        },
        null,
        2
      ),
      'utf8'
    )
  }
  return { jobId, outputPath }
}

function fakeVaults(): VaultService {
  return {
    connect: vi.fn(),
    ensureBuiltinVault: () => ({
      id: 'builtin',
      name: '内置示例库',
      path: 'C:/builtin-vault',
      connectedAt: '',
      lastIndexedAt: '',
      questionCount: 0,
      documentCount: 0,
      warnings: [],
      isBuiltin: true
    }),
    questionSignatures: () => new Set<string>()
  } as unknown as VaultService
}

function mockEngine(service: KnowledgeBuilderService): void {
  vi.spyOn(service, 'engineStatus').mockResolvedValue({
    available: true,
    installing: false,
    version: 'test',
    pythonPath: 'test-python',
    ocrAvailable: true,
    structuredParseAvailable: true,
    message: 'ready',
    supportedExtensions: []
  })
}

function mockRenderedPages(
  service: KnowledgeBuilderService,
  keys: Array<{ sourceId: string; pageNumber: number }>
): void {
  const target = service as unknown as {
    renderVlmPageImages: (
      job: unknown,
      pages: Array<{ sourceId: string; pageNumber: number }>
    ) => Promise<Map<string, string>>
  }
  vi.spyOn(target, 'renderVlmPageImages').mockImplementation(async () => {
    const map = new Map<string, string>()
    for (const key of keys) map.set(`${key.sourceId}#p${key.pageNumber}`, PROBE_IMAGE.dataUrl)
    return map
  })
}

describe('KnowledgeBuilderService VLM 精校', () => {
  function visionPayload(correctedBody: string): string {
    return JSON.stringify({
      correctedBody,
      changes: ['471495 改为 471496，依据表格末列'],
      uncertainItems: ['表格第 3 行小字无法辨认，已标注'],
      summary: '修正 1 处数字，其余一致'
    })
  }

  it('vlmProofreadArtifact：frontmatter 原样保留（id/answer/options 绑定不可篡改）并返回建议', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [
      { id: artifactId, markdown: questionMarkdown({ withMaterial: true }) }
    ])
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: visionPayload(
          '## 共享材料\n\n2023年全国社会消费品零售总额 471496 亿元，比上年增长7.2%。\n\n# 题目\n\n下列说法正确的是？\n\n## 选项\n\nA. 选项甲\nB. 选项乙\n\n## 答案\n\nA\n\n## 解析\n\n参考解析文字。'
        ),
        provider: 'test',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])

    const suggestion = await service.vlmProofreadArtifact(jobId, artifactId)

    expect(suggestion.correctedMarkdown).toContain('471496')
    expect(suggestion.correctedMarkdown).toContain('answer: ["A"]')
    expect(suggestion.correctedMarkdown).toContain('id: "kb-a1b2c3d4e5"')
    expect(suggestion.changes).toHaveLength(1)
    expect(suggestion.uncertainItems).toHaveLength(1)
    expect(suggestion.pages).toEqual([{ sourceId: SOURCE_ID, pageNumber: 3 }])
    // 输入侧：原文走 UNTRUSTED/SOURCE 边界，图片随消息附带
    const call = ai.askVision.mock.calls[0]![0] as { messages: AiMessage[] }
    expect(call.messages[1]!.content).toContain('<UNTRUSTED_TASK_DATA')
    expect(call.messages[1]!.content).toContain('<SOURCE_MATERIAL')
    expect(call.messages[1]!.images).toHaveLength(1)
    // 未落盘：产物 markdown 保持原样
    const stored = service.getArtifact(jobId, artifactId)
    expect(stored.markdown).toContain('471495')
    expect(stored.markdown).not.toContain('471496')
  })

  it('vlmProofreadArtifact：VLM 未开启、无来源页、JSON 解析失败时给出明确中文报错', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-err-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [{ id: artifactId, markdown: questionMarkdown() }])
    const disabledAi = {
      getVlmConfig: () => ({ enabled: false, mode: 'reuse-main' }),
      askVision: vi.fn()
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      disabledAi as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    await expect(service.vlmProofreadArtifact(jobId, artifactId)).rejects.toThrow(
      'VLM 按页精校未开启'
    )

    // 无来源页：evidence unavailable
    const data2 = temporaryDirectory('tizhou-vlm-kb-nopage-')
    const { jobId: jobId2 } = writeJobFixture(data2, [
      {
        id: 'kb-b1b2c3d4e5',
        markdown: questionMarkdown(),
        evidence: { status: 'unavailable', references: [] }
      }
    ])
    const service2 = new KnowledgeBuilderService(
      data2,
      process.cwd(),
      { getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }) } as unknown as AiService,
      fakeVaults()
    )
    await expect(service2.vlmProofreadArtifact(jobId2, 'kb-b1b2c3d4e5')).rejects.toThrow(
      '没有可用的来源 PDF 页'
    )

    // JSON 解析失败
    const data3 = temporaryDirectory('tizhou-vlm-kb-json-')
    const { jobId: jobId3 } = writeJobFixture(data3, [
      { id: 'kb-c1b2c3d4e5', markdown: questionMarkdown() }
    ])
    const badAi = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({ content: '这不是 JSON', provider: 't', model: 'vl' }))
    }
    const service3 = new KnowledgeBuilderService(
      data3,
      process.cwd(),
      badAi as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service3)
    mockRenderedPages(service3, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    await expect(service3.vlmProofreadArtifact(jobId3, 'kb-c1b2c3d4e5')).rejects.toThrow(
      '模型返回无法解析'
    )
  })

  it('vlmProofreadArtifact：correctedBody 夹带 frontmatter 时拒绝（结构只能由应用重组）', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-inject-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [{ id: artifactId, markdown: questionMarkdown() }])
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: JSON.stringify({
          correctedBody: '---\nid: "kb-evil"\nanswer: ["C"]\n---\n\n被注入的正文',
          changes: [],
          uncertainItems: [],
          summary: ''
        }),
        provider: 't',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    await expect(service.vlmProofreadArtifact(jobId, artifactId)).rejects.toThrow(
      '包含 YAML frontmatter'
    )
  })

  it('updateMarkdown：正文往返持久化；id/answer/options[].image 被篡改一律拒绝', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-save-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [
      { id: artifactId, markdown: questionMarkdown({ optionImage: 'images/figure-1.png' }) }
    ])
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      { getVlmConfig: () => ({ enabled: false }) } as unknown as AiService,
      fakeVaults()
    )
    const original = service.getArtifact(jobId, artifactId)
    expect(original.markdown).toContain('images/figure-1.png')

    // 只修正正文（## 共享材料 区块内）的数字；frontmatter material 随正文同步
    const edited = original.markdown.replace(
      '## 共享材料\n\n2023年全国社会消费品零售总额 471495 亿元',
      '## 共享材料\n\n2023年全国社会消费品零售总额 471496 亿元'
    )
    expect(edited).not.toBe(original.markdown)
    const saved = service.updateArtifactMarkdown(jobId, artifactId, edited, 'manual')
    expect(saved.markdown).toContain('471496 亿元')
    expect(service.getArtifact(jobId, artifactId).markdown).toContain('471496 亿元')
    // 正文修订已同步回 frontmatter.material（发布入库读到的才是修订值）
    expect(saved.markdown).toContain('material: "2023年全国社会消费品零售总额 471496 亿元')
    expect(saved.warnings).not.toContain(VLM_REVIEW_WARNING)

    // frontmatter material 行不再是红线：保存成功，但 material 会被正文区块同步覆盖（不静默采纳手改值）
    const materialAttack = original.markdown.replace('material: "2023', 'material: "1999')
    const materialSynced = service.updateArtifactMarkdown(
      jobId,
      artifactId,
      materialAttack,
      'manual'
    )
    expect(materialSynced.markdown).toContain('material: "2023')
    expect(materialSynced.markdown).not.toContain('material: "1999')

    // 篡改 id
    const idAttack = original.markdown.replace('id: "kb-a1b2c3d4e5"', 'id: "kb-9999999999"')
    expect(() => service.updateArtifactMarkdown(jobId, artifactId, idAttack, 'manual')).toThrow(
      '必须保持不变'
    )
    // 篡改 answer
    const answerAttack = original.markdown.replace('answer: ["A"]', 'answer: ["C"]')
    expect(() => service.updateArtifactMarkdown(jobId, artifactId, answerAttack, 'manual')).toThrow(
      '必须保持不变'
    )
    // 篡改 options（抹掉图推选项图绑定；frontmatter options 行是未转义 JSON）
    const optionsAttack = original.markdown.replace('"image":"images/figure-1.png"', '"image":""')
    expect(optionsAttack).not.toBe(original.markdown)
    expect(() =>
      service.updateArtifactMarkdown(jobId, artifactId, optionsAttack, 'manual')
    ).toThrow('必须保持不变')
    // 采纳 VLM 结果：补充复核提示且不重复
    const adopted = service.updateArtifactMarkdown(jobId, artifactId, edited, 'vlm')
    expect(adopted.warnings).toContain(VLM_REVIEW_WARNING)
    const adoptedAgain = service.updateArtifactMarkdown(jobId, artifactId, edited, 'vlm')
    expect(adoptedAgain.warnings.filter((warning) => warning === VLM_REVIEW_WARNING)).toHaveLength(
      1
    )
  })

  it('发布门禁：采纳 VLM 精校后 isPublishGated 产物仍未解除，partitionByPublishGate 继续拦截', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-gate-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [
      {
        id: artifactId,
        markdown: questionMarkdown(),
        capability: 'graphic-review',
        warnings: []
      }
    ])
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      { getVlmConfig: () => ({ enabled: false }) } as unknown as AiService,
      fakeVaults()
    )
    const artifact = service.getArtifact(jobId, artifactId)
    const edited = artifact.markdown.replace('参考解析文字。', '人工修订后的解析。')
    const saved = service.updateArtifactMarkdown(jobId, artifactId, edited, 'vlm')
    expect(saved.warnings).toContain(VLM_REVIEW_WARNING)
    expect(saved.humanConfirmed).toBeFalsy()
    const { allowed, blocked } = partitionByPublishGate([saved])
    expect(allowed).toHaveLength(0)
    expect(blocked.map((item) => item.id)).toEqual([artifactId])
  })

  it('published 产物禁止修改与精校', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-pub-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [
      { id: artifactId, markdown: questionMarkdown(), status: 'published' }
    ])
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      { getVlmConfig: () => ({ enabled: false }) } as unknown as AiService,
      fakeVaults()
    )
    expect(() =>
      service.updateArtifactMarkdown(jobId, artifactId, questionMarkdown(), 'manual')
    ).toThrow('已发布产物不能修改')
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    await expect(service.vlmProofreadArtifact(jobId, artifactId)).rejects.toThrow(
      '已发布产物不能修改，无需精校'
    )
  })

  it('任务级预精校：共享材料页 3 题只调 1 次 VLM，材料区块同步修订且答案不动', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-auto-')
    const ids = ['kb-d1a1b2c3d4', 'kb-d2a1b2c3d4', 'kb-d3a1b2c3d4']
    const { jobId } = writeJobFixture(
      data,
      ids.map((id) => ({ id, markdown: questionMarkdown(), capability: 'table-review' }))
    )
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: visionPayload('2023年全国社会消费品零售总额 471496 亿元，比上年增长7.2%。'),
        provider: 't',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    const internal = service as unknown as {
      loadJob: (id: string) => unknown
      loadArtifact: (job: unknown, id: string) => { markdown: string; warnings: string[] }
      autoVlmPreproofread: (
        job: unknown,
        artifacts: Array<{ markdown: string }>
      ) => Promise<{ pages: number; calls: number; applied: number; skippedPages: number }>
    }
    const job = internal.loadJob(jobId)
    const artifacts = ids.map((id) => internal.loadArtifact(job, id))
    const stats = await internal.autoVlmPreproofread(job, artifacts)
    expect(stats.calls).toBe(1)
    expect(stats.applied).toBe(3)
    expect(stats.skippedPages).toBe(0)
    for (const artifact of artifacts) {
      expect(artifact.markdown).toContain('471496 亿元')
      expect(artifact.markdown).toContain('answer: ["A"]')
      expect(artifact.warnings).toContain(VLM_REVIEW_WARNING)
    }
    // scope=material：correctedBody 只替换共享材料区块，题干/选项/答案区原样
    expect(artifacts[0]!.markdown).toContain('# 题目')
    expect(artifacts[0]!.markdown).toContain('## 答案')
  })

  it('任务级预精校：独立异常页达上限 10 页即停，其余跳过并回报', async () => {
    expect(MAX_AUTO_VLM_PAGES).toBe(10)
    const data = temporaryDirectory('tizhou-vlm-kb-cap-')
    const ids = Array.from(
      { length: 12 },
      (_, index) => `kb-e${String(index).padStart(2, '0')}a1b2c3`
    )
    const { jobId } = writeJobFixture(
      data,
      ids.map((id, index) => ({
        id,
        markdown: questionMarkdown({ withMaterial: false }),
        capability: 'table-review',
        evidence: {
          status: 'available',
          references: [
            {
              role: 'question',
              sourceId: SOURCE_ID,
              relativePath: '题本.pdf',
              pages: [{ pageNumber: index + 1, mapping: 'exact' }]
            }
          ]
        }
      }))
    )
    let calls = 0
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => {
        calls += 1
        return { content: visionPayload('修订后的正文。'), provider: 't', model: 'vl' }
      })
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(
      service,
      Array.from({ length: 12 }, (_, index) => ({ sourceId: SOURCE_ID, pageNumber: index + 1 }))
    )
    const internal = service as unknown as {
      loadJob: (id: string) => unknown
      loadArtifact: (job: unknown, id: string) => { markdown: string }
      autoVlmPreproofread: (
        job: unknown,
        artifacts: Array<{ markdown: string }>
      ) => Promise<{ pages: number; calls: number; applied: number; skippedPages: number }>
    }
    const job = internal.loadJob(jobId)
    const artifacts = ids.map((id) => internal.loadArtifact(job, id))
    const stats = await internal.autoVlmPreproofread(job, artifacts)
    expect(stats.pages).toBe(10)
    expect(stats.calls).toBe(10)
    expect(stats.skippedPages).toBe(2)
    expect(stats.applied).toBe(10)
  })
})

describe('FEATURE_PROMPTS.vlmPageProofread 安全边界', () => {
  it('协议包含结构隔离、不猜数字与图片引用保护红线', () => {
    const prompt = FEATURE_PROMPTS.vlmPageProofread
    expect(prompt).toContain('correctedBody')
    expect(prompt).toContain('changes')
    expect(prompt).toContain('uncertainItems')
    expect(prompt).toContain('summary')
    expect(prompt).toContain('[模糊待人工确认]')
    expect(prompt).toContain('禁止按常识、规律或上下文猜测补齐')
    expect(prompt).toContain('禁止修改参考答案')
    expect(prompt).toContain('images/ 开头的相对引用链接原样保留')
    expect(prompt).toContain('UNTRUSTED_TASK_DATA')
    // 现有功能协议键内容保持不变（抽查既有断言口径）
    expect(FEATURE_PROMPTS.knowledgeExtract).toContain('输出前质检')
    expect(FEATURE_PROMPTS.connectivity).toContain('只输出两个大写拉丁字母 OK')
  })

  it('数据边界信封可用于精校输入组装', () => {
    const envelope = taskDataEnvelope('测试', { scope: 'body' })
    expect(envelope).toContain('<UNTRUSTED_TASK_DATA')
    expect(sourceEnvelope('材料', '2023年数据')).toContain('<SOURCE_MATERIAL')
    expect(FEATURE_PROMPTS.vlmPageProofread).toContain('scope 为 material')
  })
})

describe('VLM 修订端到端闭环（发布入库后可验证）', () => {
  /** 修正后的完整正文：材料数字 471496、题干带「根据材料」前缀，图片引用保留 */
  function correctedBodyFixture(withImage: boolean): string {
    return [
      '## 共享材料',
      '',
      '2023年全国社会消费品零售总额 471496 亿元，比上年增长7.2%。',
      '',
      '# 题目',
      '',
      '根据材料，下列说法正确的是？',
      '',
      '## 选项',
      '',
      'A. 选项甲',
      'B. 选项乙',
      ...(withImage ? ['C. ![选项C](images/figure-1.png)'] : []),
      '',
      '## 答案',
      '',
      'A',
      '',
      '## 解析',
      '',
      '参考解析文字。'
    ].join('\n')
  }

  it('VLM 采纳与手工编辑修订 frontmatter，approve+confirm 后发布入库读到修订值', async () => {
    const data = temporaryDirectory('tizhou-vlm-e2e-')
    const database = new DatabaseService(join(data, 'db.sqlite'), data, join(data, 'backups'))
    openDatabases.push(database)
    const vaults = new VaultService(database)
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: JSON.stringify({
          correctedBody: correctedBodyFixture(true),
          changes: ['471495 改为 471496'],
          uncertainItems: [],
          summary: '修正材料数字与题干'
        }),
        provider: 't',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      vaults
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    const { jobId } = writeJobFixture(data, [
      {
        id: 'kb-e2e1a1b2c3d',
        markdown: questionMarkdown({
          withMaterial: true,
          optionImage: 'images/figure-1.png',
          id: 'kb-e2e1a1b2c3d'
        })
      },
      {
        id: 'kb-e2e2b2c3d4e',
        markdown: questionMarkdown({ withMaterial: true, id: 'kb-e2e2b2c3d4e' })
      }
    ])

    // 路径 1：VLM 精校采纳（建议阶段的 frontmatter 就已同步修订值）
    const suggestion = await service.vlmProofreadArtifact(jobId, 'kb-e2e1a1b2c3d')
    expect(suggestion.correctedMarkdown).toContain(
      'material: "2023年全国社会消费品零售总额 471496 亿元'
    )
    expect(suggestion.correctedMarkdown).toContain('stem: "根据材料，下列说法正确的是？"')
    const adopted = service.updateArtifactMarkdown(
      jobId,
      'kb-e2e1a1b2c3d',
      suggestion.correctedMarkdown,
      'vlm'
    )
    expect(adopted.warnings).toContain(VLM_REVIEW_WARNING)

    // 路径 2：人工编辑正文（材料数字 + 题干）
    const original = service.getArtifact(jobId, 'kb-e2e2b2c3d4e')
    const edited = original.markdown
      .replace(
        '## 共享材料\n\n2023年全国社会消费品零售总额 471495 亿元',
        '## 共享材料\n\n2023年全国社会消费品零售总额 471496 亿元'
      )
      .replace('# 题目\n\n下列说法正确的是？', '# 题目\n\n根据材料，下列说法正确的是？')
    expect(edited).not.toBe(original.markdown)
    const manuallySaved = service.updateArtifactMarkdown(jobId, 'kb-e2e2b2c3d4e', edited, 'manual')
    expect(manuallySaved.preview).toContain('根据材料')
    expect(manuallySaved.markdown).toContain('stem: "根据材料，下列说法正确的是？"')

    // 批准 + 人工确认 → 发布入库
    service.reviewArtifact(jobId, 'kb-e2e1a1b2c3d', 'approved', true)
    service.reviewArtifact(jobId, 'kb-e2e2b2c3d4e', 'approved', true)
    service.publish(jobId)

    // 从 SQLite 查回：材料/题干/选项 text 为修订值，answer 与 options[].image 原样
    const rows = database.listQuestions({ query: '根据材料', limit: 10 })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.material).toContain('471496')
      expect(row.stem).toContain('根据材料')
      expect(row.answer).toEqual(['A'])
      expect(row.options.map((option) => option.key)).toEqual(expect.arrayContaining(['A', 'B']))
    }
    // 索引后 id 带 vault 前缀（vault-<hash>:kb-...），按后缀定位带图片选项的题
    const withImage = rows.find((row) => row.id.endsWith('kb-e2e1a1b2c3d'))
    expect(withImage).toBeDefined()
    expect(withImage!.options.find((option) => option.key === 'C')).toEqual({
      key: 'C',
      text: '',
      image: 'images/figure-1.png'
    })
  })

  it('vlmProofreadArtifact：修订正文丢失 images/ 引用时拒绝建议', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-imgloss-')
    const artifactId = 'kb-a1b2c3d4e5'
    const { jobId } = writeJobFixture(data, [
      { id: artifactId, markdown: questionMarkdown({ optionImage: 'images/figure-1.png' }) }
    ])
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: JSON.stringify({
          correctedBody: correctedBodyFixture(false),
          changes: [],
          uncertainItems: [],
          summary: '删除了图片选项'
        }),
        provider: 't',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    await expect(service.vlmProofreadArtifact(jobId, artifactId)).rejects.toThrow('丢失了图片引用')
  })

  it('任务级预精校：单页失败只计 failedPages，不覆盖已完成页统计', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-fail-')
    const ids = ['kb-f1a1b2c3d4', 'kb-f2a1b2c3d4']
    const { jobId } = writeJobFixture(
      data,
      ids.map((id, index) => ({
        id,
        markdown: questionMarkdown({ withMaterial: false }),
        capability: 'table-review',
        evidence: {
          status: 'available',
          references: [
            {
              role: 'question',
              sourceId: SOURCE_ID,
              relativePath: '题本.pdf',
              pages: [{ pageNumber: index + 1, mapping: 'exact' }]
            }
          ]
        }
      }))
    )
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi
        .fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            correctedBody: '修订后的正文一。',
            changes: [],
            uncertainItems: [],
            summary: ''
          }),
          provider: 't',
          model: 'vl'
        })
        .mockRejectedValueOnce(new Error('模型请求超时'))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [
      { sourceId: SOURCE_ID, pageNumber: 1 },
      { sourceId: SOURCE_ID, pageNumber: 2 }
    ])
    const internal = service as unknown as {
      loadJob: (id: string) => unknown
      loadArtifact: (job: unknown, id: string) => { markdown: string }
      autoVlmPreproofread: (
        job: unknown,
        artifacts: Array<{ markdown: string }>
      ) => Promise<{
        pages: number
        calls: number
        applied: number
        skippedPages: number
        failedPages: number
        uncoveredArtifacts: number
      }>
    }
    const job = internal.loadJob(jobId)
    const artifacts = ids.map((id) => internal.loadArtifact(job, id))
    const stats = await internal.autoVlmPreproofread(job, artifacts)
    expect(stats.pages).toBe(2)
    expect(stats.calls).toBe(1)
    expect(stats.applied).toBe(1)
    expect(stats.failedPages).toBe(1)
    expect(stats.skippedPages).toBe(0)
    expect(artifacts[0]!.markdown).toContain('修订后的正文一。')
  })

  it('任务级预精校：scope=body 同页多道独立题只修订首题，其余如实计入未覆盖', async () => {
    const data = temporaryDirectory('tizhou-vlm-kb-uncovered-')
    const ids = ['kb-a2a1b2c3d4', 'kb-b3a1b2c3d4']
    const { jobId } = writeJobFixture(
      data,
      ids.map((id) => ({
        id,
        markdown: questionMarkdown({ withMaterial: false }),
        capability: 'table-review'
      }))
    )
    const ai = {
      getVlmConfig: () => ({ enabled: true, mode: 'reuse-main' }),
      askVision: vi.fn(async () => ({
        content: JSON.stringify({
          correctedBody: '修订后的共享页正文。',
          changes: [],
          uncertainItems: [],
          summary: ''
        }),
        provider: 't',
        model: 'vl'
      }))
    }
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      ai as unknown as AiService,
      fakeVaults()
    )
    mockEngine(service)
    mockRenderedPages(service, [{ sourceId: SOURCE_ID, pageNumber: 3 }])
    const internal = service as unknown as {
      loadJob: (id: string) => unknown
      loadArtifact: (job: unknown, id: string) => { markdown: string }
      autoVlmPreproofread: (
        job: unknown,
        artifacts: Array<{ markdown: string }>
      ) => Promise<{ uncoveredArtifacts: number; calls: number; applied: number }>
    }
    const job = internal.loadJob(jobId)
    const artifacts = ids.map((id) => internal.loadArtifact(job, id))
    const stats = await internal.autoVlmPreproofread(job, artifacts)
    expect(stats.calls).toBe(1)
    expect(stats.applied).toBe(1)
    expect(stats.uncoveredArtifacts).toBe(1)
    expect(artifacts[1]!.markdown).not.toContain('修订后的共享页正文。')
  })
})

describe('AiService.testVlm 探活（开关未开启也可提前验证）', () => {
  it('reuse-main 且总开关未开启：探活通过且不静默翻转开关', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    const port = await listen(server)
    try {
      const service = new AiService(makeDatabase())
      service.saveConfig({
        provider: 'ollama',
        protocol: 'ollama-openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'main-vl',
        temperature: 0.2,
        maxTokens: 256
      })
      const view = await service.testVlm()
      expect(view.verified).toBe(true)
      expect(view.enabled).toBe(false)
      expect(service.getVlmConfig().enabled).toBe(false)
    } finally {
      server.close()
    }
  })

  it('reuse-main 主模型未配密钥：探活失败并写入明确 lastError（开关保持关闭）', async () => {
    const service = new AiService(makeDatabase())
    const view = await service.testVlm()
    expect(view.verified).toBe(false)
    expect(view.lastError).toContain('保存主模型 API Key')
    expect(view.enabled).toBe(false)
  })
})
