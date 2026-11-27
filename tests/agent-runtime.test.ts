import { createServer, type AddressInfo, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../src/main/services/agent-runtime'
import { executeAgentTool, executeApprovedAction } from '../src/main/services/agent-tools'
import {
  AiService,
  extractFallbackToolCalls,
  isToolsUnsupportedError,
  parseToolTurnResponse,
  requestSpec,
  toolRequestSpec,
  type AgentToolDefinition,
  type StoredAiConfig,
  type ToolTurnMessage
} from '../src/main/services/ai'
import { DatabaseService } from '../src/main/services/database'
import { StudyService } from '../src/main/services/study'
import type {
  AgentStreamEvent,
  KnowledgeDocument,
  Question,
  VaultInfo
} from '../src/shared/contracts'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) =>
      Buffer.from(buffer.toString('utf8').replace(/^enc:/, ''), 'utf8')
  }
}))

const tempDirs: string[] = []
const openDbs: DatabaseService[] = []
const servers: Server[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeDb(): DatabaseService {
  const dir = makeTempDir('tizhou-agent-')
  const db = new DatabaseService(join(dir, 'workbench.sqlite'), dir, join(dir, 'backups'))
  openDbs.push(db)
  return db
}

async function startHttpServer(
  handler: Parameters<typeof createServer>[0]
): Promise<{ url: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}` }
}

function readJsonBody(
  req: Parameters<NonNullable<Parameters<typeof createServer>[0]>>[0]
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function seedWorkbench(db: DatabaseService): { questions: Question[] } {
  const nowIso = new Date().toISOString()
  const vault: VaultInfo = {
    id: 'vault-agent-test',
    name: '测试备考库',
    path: makeTempDir('tizhou-vault-'),
    connectedAt: nowIso,
    lastIndexedAt: nowIso,
    questionCount: 4,
    documentCount: 1,
    warnings: [],
    isBuiltin: true
  }
  const questions: Question[] = [
    {
      id: 'q-zl-1',
      subject: 'xingce',
      category: '资料分析',
      type: 'single',
      stem: '2025 年某省粮食产量同比增长 4.2%，求基期产量约为多少？',
      options: [
        { key: 'A', text: '1000 万吨' },
        { key: 'B', text: '1042 万吨' },
        { key: 'C', text: '960 万吨' },
        { key: 'D', text: '980 万吨' }
      ],
      answer: ['A'],
      explanation: '基期量 = 现期量 / (1 + r)。',
      difficulty: 2,
      source: '测试真题',
      tags: ['基期量'],
      contentHash: 'hash-zl-1'
    },
    {
      id: 'q-zl-2',
      subject: 'xingce',
      category: '资料分析',
      type: 'single',
      stem: '2025 年该省夏粮比重变化约为多少百分点？',
      options: [
        { key: 'A', text: '上升 1.2 个百分点' },
        { key: 'B', text: '下降 1.2 个百分点' }
      ],
      answer: ['B'],
      explanation: '部分增长率小于整体增长率，比重下降。',
      difficulty: 3,
      source: '测试真题',
      tags: ['两期比重'],
      contentHash: 'hash-zl-2'
    },
    {
      id: 'q-yy-1',
      subject: 'xingce',
      category: '言语理解',
      type: 'single',
      stem: '依次填入画横线部分最恰当的一项是：治理需要久久为功，不能____。',
      options: [
        { key: 'A', text: '一蹴而就' },
        { key: 'B', text: '循序渐进' }
      ],
      answer: ['A'],
      explanation: '与“久久为功”形成对比，应选“一蹴而就”。',
      difficulty: 2,
      source: '测试真题',
      tags: ['逻辑填空'],
      contentHash: 'hash-yy-1'
    },
    {
      id: 'q-pd-1',
      subject: 'xingce',
      category: '判断推理',
      type: 'single',
      stem: '从所给的四个选项中，选择最合适的一个填入问号处。',
      options: [
        { key: 'A', text: '图 A' },
        { key: 'B', text: '图 B' }
      ],
      answer: ['A'],
      explanation: '对称轴依次顺时针旋转 45 度。',
      difficulty: 2,
      source: '测试真题',
      tags: ['图形对称'],
      contentHash: 'hash-pd-1'
    }
  ]
  const docs: KnowledgeDocument[] = [
    {
      id: 'doc-1',
      subject: 'xingce',
      kind: 'method',
      title: '资料分析两期比重速算',
      summary: '比较部分增长率 a 与整体增长率 b 的大小关系',
      content: '当 a > b 时现期比重大于基期比重，变化量小于 |a - b|。',
      tags: ['资料分析', '两期比重']
    }
  ]

  db.upsertVault(vault, true)
  db.replaceVaultContent(vault, questions, docs, false)

  db.submitAttempt({
    questionId: 'q-zl-1',
    answer: ['B'],
    durationSeconds: 110,
    mode: 'practice',
    wrongCause: '概念混淆'
  })
  db.submitAttempt({
    questionId: 'q-yy-1',
    answer: ['B'],
    durationSeconds: 45,
    mode: 'practice',
    wrongCause: '粗心大意'
  })

  const exam = db.createExam(
    { title: '测试仿真模考', subject: 'xingce', durationMinutes: 30, questionCount: 2 },
    [questions[0]!, questions[2]!]
  )
  db.saveExamAnswer(exam.id, { questionId: 'q-zl-1', answer: ['B'], durationSeconds: 150 })
  db.saveExamAnswer(exam.id, { questionId: 'q-yy-1', answer: ['A'], durationSeconds: 35 })
  db.finishExam(exam.id)

  return { questions }
}

afterEach(async () => {
  for (const srv of servers.splice(0)) {
    srv.closeAllConnections?.()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  for (const db of openDbs.splice(0)) {
    db.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('learner_memories & ai_conversations persistence', () => {
  it('supports memory CRUD, whitespace-dedup with evidence preservation, toggle, and resetLearningData', () => {
    const db = makeDb()
    const m1 = db.saveLearnerMemory({
      category: '常见错因',
      content: '资料分析 两期比重 常混淆 a 与 b',
      evidence: '第 1 次错题统计',
      source: 'agent'
    })
    const m1Dup = db.saveLearnerMemory({
      category: '常见错因',
      content: '资料分析两期比重常混淆a与b',
      evidence: '',
      source: 'user'
    })
    expect(m1Dup.id).toBe(m1.id)
    expect(m1Dup.evidence).toBe('第 1 次错题统计')
    expect(db.listLearnerMemories()).toHaveLength(1)

    const m2 = db.saveLearnerMemory({
      category: '配速偏好',
      content: '数量关系超过 90 秒果断跳过',
      evidence: '模考复盘',
      source: 'user'
    })
    const toggled = db.toggleLearnerMemory(m2.id, false)
    expect(toggled.enabled).toBe(false)
    expect(db.listLearnerMemories(true).map((m) => m.id)).toEqual([m1.id])
    expect(db.listLearnerMemories()).toHaveLength(2)

    db.deleteLearnerMemory(m1.id)
    expect(db.listLearnerMemories().map((m) => m.id)).toEqual([m2.id])

    db.resetLearningData()
    expect(db.listLearnerMemories()).toEqual([])
  })

  it('persists toolSteps & proposals on AiMessage while remaining backwards-compatible', () => {
    const db = makeDb()
    const saved = db.saveAiConversation({
      title: '备考复盘会话',
      messages: [
        { role: 'user', content: '帮我分析错题' },
        {
          role: 'assistant',
          content: '已完成诊断',
          toolSteps: [
            {
              id: 's1',
              toolName: 'get_study_overview',
              label: '读取备考总览与学情诊断',
              mode: 'read',
              argsSummary: 'days=14',
              status: 'done',
              resultSummary: '累计 2 题',
              durationMs: 5
            }
          ],
          proposals: [
            {
              id: 'p1',
              kind: 'enqueue_review',
              title: '加入复习队列',
              summary: '共 1 题',
              reason: '资料分析错题较多',
              payload: { questionIds: ['q-zl-1'] },
              status: 'approved',
              resultMessage: '已加入 1 道题',
              navigateTo: '/review'
            }
          ]
        }
      ]
    })

    const listed = db.listAiConversations()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(saved.id)
    expect(listed[0]!.messages[0]).toEqual({ role: 'user', content: '帮我分析错题' })
    expect(listed[0]!.messages[1]!.toolSteps?.[0]?.toolName).toBe('get_study_overview')
    expect(listed[0]!.messages[1]!.proposals?.[0]?.resultMessage).toBe('已加入 1 道题')
    expect(listed[0]!.messages[1]!.proposals?.[0]?.navigateTo).toBe('/review')
  })
})

describe('Multi-protocol Tool Calling adapters & fallback parser', () => {
  const tools: AgentToolDefinition[] = [
    {
      name: 'get_study_overview',
      description: '读取备考总览',
      parameters: { type: 'object', properties: { days: { type: 'integer' } } }
    }
  ]

  const multiToolHistory: ToolTurnMessage[] = [
    { role: 'system', content: '你是公考教练' },
    { role: 'user', content: '查一下数据' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'get_study_overview',
          arguments: { days: 7 },
          thoughtSignature: 'sig-abc'
        },
        { id: 'c2', name: 'list_learner_memories', arguments: {} }
      ]
    },
    { role: 'tool', toolCallId: 'c1', toolName: 'get_study_overview', content: '{"total":10}' },
    { role: 'tool', toolCallId: 'c2', toolName: 'list_learner_memories', content: '{"count":0}' }
  ]

  const baseConfig: StoredAiConfig = {
    provider: 'openai',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    maxTokens: 2048
  }

  it('builds specs and parses responses across openai-chat, ollama-openai, and openai-responses', () => {
    const openAiSpec = toolRequestSpec(baseConfig, 'sk-test', multiToolHistory, tools)
    expect(openAiSpec.body.tool_choice).toBe('auto')
    expect((openAiSpec.body.tools as unknown[]).length).toBe(1)

    const ollamaSpec = toolRequestSpec(
      {
        ...baseConfig,
        provider: 'ollama',
        protocol: 'ollama-openai',
        baseUrl: 'http://127.0.0.1:11434'
      },
      '',
      multiToolHistory,
      tools
    )
    expect(ollamaSpec.body.tool_choice).toBeUndefined()
    expect((ollamaSpec.body.tools as unknown[]).length).toBe(1)

    const chatParsed = parseToolTurnResponse('openai-chat', {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc-1',
                type: 'function',
                function: { name: 'get_study_overview', arguments: '{"days":14}' }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
    expect(chatParsed.toolCalls).toEqual([
      { id: 'tc-1', name: 'get_study_overview', arguments: { days: 14 } }
    ])
    expect(chatParsed.usage?.totalTokens).toBe(15)

    const respSpec = toolRequestSpec(
      { ...baseConfig, protocol: 'openai-responses' },
      'sk-test',
      multiToolHistory,
      tools
    )
    expect(respSpec.body.instructions).toBe('你是公考教练')
    expect(
      (respSpec.body.input as Array<Record<string, unknown>>).some(
        (item) => item.type === 'function_call_output' && item.call_id === 'c2'
      )
    ).toBe(true)

    const respParsed = parseToolTurnResponse('openai-responses', {
      output: [
        {
          type: 'function_call',
          call_id: 'call_99',
          name: 'get_study_overview',
          arguments: '{"days":30}'
        }
      ]
    })
    expect(respParsed.toolCalls).toEqual([
      { id: 'call_99', name: 'get_study_overview', arguments: { days: 30 } }
    ])
  })

  it('merges adjacent tool turns for anthropic-messages & google-generate-content and preserves thoughtSignature', () => {
    const anthropicSpec = toolRequestSpec(
      {
        ...baseConfig,
        provider: 'anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com'
      },
      'ak-test',
      multiToolHistory,
      tools
    )
    const antMsgs = anthropicSpec.body.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    expect(antMsgs).toHaveLength(3) // user -> assistant(2 tool_use) -> user(2 tool_result merged)
    expect(antMsgs[2]!.role).toBe('user')
    expect(antMsgs[2]!.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result'])

    const antParsed = parseToolTurnResponse('anthropic-messages', {
      content: [
        { type: 'text', text: '我来查一下' },
        { type: 'tool_use', id: 'tu-1', name: 'get_study_overview', input: { days: 7 } }
      ]
    })
    expect(antParsed.content).toBe('我来查一下')
    expect(antParsed.toolCalls[0]).toEqual({
      id: 'tu-1',
      name: 'get_study_overview',
      arguments: { days: 7 }
    })

    const googleSpec = toolRequestSpec(
      {
        ...baseConfig,
        provider: 'google',
        protocol: 'google-generate-content',
        baseUrl: 'https://generativelanguage.googleapis.com'
      },
      'gk-test',
      multiToolHistory,
      tools
    )
    const contents = googleSpec.body.contents as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    expect(contents).toHaveLength(3)
    expect(contents[1]!.parts[0]!.thoughtSignature).toBe('sig-abc')
    expect(contents[2]!.role).toBe('user')
    expect(contents[2]!.parts).toHaveLength(2)
    expect((contents[2]!.parts[0]!.functionResponse as Record<string, unknown>).response).toEqual({
      total: 10
    })

    const googleParsed = parseToolTurnResponse('google-generate-content', {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'get_study_overview', args: { days: 5 } },
                thoughtSignature: 'sig-xyz'
              }
            ]
          }
        }
      ]
    })
    expect(googleParsed.toolCalls[0]!.name).toBe('get_study_overview')
    expect(googleParsed.toolCalls[0]!.arguments).toEqual({ days: 5 })
    expect(googleParsed.toolCalls[0]!.thoughtSignature).toBe('sig-xyz')
  })

  it('extracts fallback <tool_call> XML blocks and detects unsupported-tools HTTP errors', () => {
    const raw = [
      '先为你查询错误记录：',
      '<tool_call>```json\n{"name":"query_wrong_questions","arguments":{"category":"资料分析"}}\n```</tool_call>',
      '<tool_call>{"name":"list_learner_memories","arguments":{"onlyEnabled":true}}</tool_call>'
    ].join('\n')
    const extracted = extractFallbackToolCalls(raw)
    expect(extracted.calls).toHaveLength(2)
    expect(extracted.calls[0]!.name).toBe('query_wrong_questions')
    expect(extracted.calls[0]!.arguments).toEqual({ category: '资料分析' })
    expect(extracted.calls[1]!.name).toBe('list_learner_memories')
    expect(extracted.cleanContent).toBe('先为你查询错误记录：')

    expect(
      isToolsUnsupportedError(400, '{"error":{"message":"Unknown parameter: \'tools\'"}}')
    ).toBe(true)
    expect(isToolsUnsupportedError(422, 'tool_choice is not supported by this model')).toBe(true)
    expect(isToolsUnsupportedError(500, 'tools unsupported internal error')).toBe(false)
    expect(isToolsUnsupportedError(400, 'Invalid API key provided')).toBe(false)
  })
})

describe('AgentRuntime execution, human confirmation, fallback, memories, and cancellation', () => {
  it('runs multi-step tool loop, avoids premature mutation until executeAction, and executes all 5 proposal kinds', async () => {
    const db = makeDb()
    seedWorkbench(db)

    let round = 0
    const seenSystems: string[] = []
    const { url } = await startHttpServer(async (req, res) => {
      const body = await readJsonBody(req)
      const msgs = (body.messages as Array<{ role: string; content: string | null }>) ?? []
      seenSystems.push(msgs.find((m) => m.role === 'system')?.content ?? '')
      round += 1

      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (round === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'r1-1',
                      type: 'function',
                      function: { name: 'get_study_overview', arguments: '{"days":14}' }
                    },
                    {
                      id: 'r1-2',
                      type: 'function',
                      function: {
                        name: 'query_wrong_questions',
                        arguments: '{"category":"资料分析"}'
                      }
                    },
                    {
                      id: 'r1-3',
                      type: 'function',
                      function: { name: 'get_exam_sunk_cost', arguments: '{"limit":1}' }
                    },
                    {
                      id: 'r1-4',
                      type: 'function',
                      function: {
                        name: 'search_knowledge_and_notes',
                        arguments: '{"query":"比重"}'
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
        return
      }
      if (round === 2) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'r2-1',
                      type: 'function',
                      function: {
                        name: 'propose_practice_session',
                        arguments: JSON.stringify({
                          category: '资料分析',
                          count: 2,
                          onlyWrong: true,
                          reason: '重点攻克资料分析错题'
                        })
                      }
                    },
                    {
                      id: 'r2-2',
                      type: 'function',
                      function: {
                        name: 'propose_enqueue_review',
                        arguments: JSON.stringify({
                          questionIds: ['q-pd-1'],
                          reason: '巩固图形对称规律'
                        })
                      }
                    },
                    {
                      id: 'r2-3',
                      type: 'function',
                      function: {
                        name: 'propose_save_note',
                        arguments: JSON.stringify({
                          questionId: 'q-zl-1',
                          content: '基期量注意分清现期与增长率',
                          mode: 'append'
                        })
                      }
                    },
                    {
                      id: 'r2-4',
                      type: 'function',
                      function: {
                        name: 'propose_save_memory',
                        arguments: JSON.stringify({
                          category: '薄弱环节',
                          content: '资料分析单题耗时偏高',
                          evidence: '模考耗时 150 秒'
                        })
                      }
                    },
                    {
                      id: 'r2-5',
                      type: 'function',
                      function: {
                        name: 'propose_learning_plan',
                        arguments: JSON.stringify({
                          durationDays: 7,
                          dailyMinutes: 60,
                          focus: ['资料分析'],
                          title: '7天资料分析攻坚'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: '已完成资料分析与模考沉没成本诊断，请按需确认下方行动提案。' } }
          ]
        })
      )
    })

    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'local-qwen',
      temperature: 0.2,
      maxTokens: 2048
    })
    const study = new StudyService(db, ai)
    const runtime = new AgentRuntime(db, study, ai)

    const events: AgentStreamEvent[] = []
    const result = await runtime.run(
      {
        requestId: 'agent-e2e-1',
        messages: [{ role: 'user', content: '诊断我的薄弱模块并给出改进方案' }]
      },
      (ev) => events.push(ev)
    )

    expect(result.aborted).toBeUndefined()
    expect(result.content).toContain('资料分析')
    expect(result.toolSteps).toHaveLength(9)
    expect(result.proposals).toHaveLength(5)
    expect(events.some((e) => e.type === 'tool_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_result')).toBe(true)
    expect(events.some((e) => e.type === 'proposal')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)

    // 验证提案生成阶段绝不提前修改任何本地学习数据
    expect(db.getActivePracticeSession('practice')).toBeUndefined()
    expect(db.listQuestionLibrary({ tab: 'wrong' }).some((r) => r.question.id === 'q-pd-1')).toBe(
      false
    )
    expect(db.getNote('q-zl-1')).toBe('')
    expect(db.listLearnerMemories()).toHaveLength(0)
    expect(db.getActivePlan()).toBeUndefined()

    // 逐一确认执行 5 类提案并核对真实落库结果
    const byKind = new Map(result.proposals.map((p) => [p.kind, p]))

    const execPractice = runtime.executeAction(byKind.get('start_practice')!)
    expect(execPractice.ok).toBe(true)
    expect(execPractice.navigateTo).toBe('/practice?resumeActive=1')
    expect(db.getActivePracticeSession('practice')?.questionIds.length).toBeGreaterThan(0)

    const execReview = runtime.executeAction(byKind.get('enqueue_review')!)
    expect(execReview.ok).toBe(true)
    expect(execReview.navigateTo).toBe('/review')
    expect(execReview.message).toContain('1 道题')
    const queued = db.listQuestionLibrary({ tab: 'wrong' }).find((r) => r.question.id === 'q-pd-1')
    expect(queued?.dueAt).toBeTruthy()

    const execNote = runtime.executeAction(byKind.get('save_note')!)
    expect(execNote.ok).toBe(true)
    expect(db.getNote('q-zl-1')).toContain('基期量注意分清现期与增长率')

    const execMemory = runtime.executeAction(byKind.get('save_memory')!)
    expect(execMemory.ok).toBe(true)
    expect(execMemory.savedMemory?.content).toBe('资料分析单题耗时偏高')
    expect(db.listLearnerMemories()).toHaveLength(1)

    const execPlan = runtime.executeAction(byKind.get('apply_plan')!)
    expect(execPlan.ok).toBe(true)
    expect(execPlan.navigateTo).toBe('/diagnosis')
    expect(db.getActivePlan()?.title).toBe('7天资料分析攻坚')
  })

  it('automatically falls back to XML <tool_call> protocol when endpoint returns HTTP 400 unsupported-tools', async () => {
    const db = makeDb()
    seedWorkbench(db)

    let requestCount = 0
    const receivedBodies: Array<Record<string, unknown>> = []
    const { url } = await startHttpServer(async (req, res) => {
      const body = await readJsonBody(req)
      receivedBodies.push(body)
      requestCount += 1

      if (body.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: "Unknown parameter: 'tools'" } }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (requestCount === 2) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '<tool_call>{"name":"get_study_overview","arguments":{"days":7}}</tool_call>'
                }
              }
            ]
          })
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '已通过降级协议读取到你的近 7 天学习总览。' } }]
        })
      )
    })

    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'no-tools-model',
      temperature: 0.2,
      maxTokens: 1024
    })
    const runtime = new AgentRuntime(db, new StudyService(db, ai), ai)

    const result = await runtime.run(
      { requestId: 'agent-fallback-1', messages: [{ role: 'user', content: '看看近 7 天情况' }] },
      () => {}
    )

    expect(requestCount).toBe(3)
    const fallbackSys = (
      receivedBodies[1]!.messages as Array<{ role: string; content: string }>
    )[0]!.content
    expect(fallbackSys).toContain('<tool_call>')
    const toolResultMsg = (
      receivedBodies[2]!.messages as Array<{ role: string; content: string }>
    ).find((m) => m.role === 'user' && m.content.includes('<tool_result'))
    expect(toolResultMsg?.content).toContain('get_study_overview')
    expect(result.toolSteps).toHaveLength(1)
    expect(result.content).toBe('已通过降级协议读取到你的近 7 天学习总览。')
  })

  it('injects enabled learner memories into system prompt and excludes disabled ones', async () => {
    const db = makeDb()
    db.saveLearnerMemory({
      category: '配速偏好',
      content: 'ENABLED_MEMORY_TOKEN_资料分析优先保准确率',
      source: 'user'
    })
    const disabled = db.saveLearnerMemory({
      category: '常见错因',
      content: 'DISABLED_MEMORY_TOKEN_不应出现在系统提示',
      source: 'agent'
    })
    db.toggleLearnerMemory(disabled.id, false)

    let capturedSystem = ''
    const { url } = await startHttpServer(async (req, res) => {
      const body = await readJsonBody(req)
      const msgs = (body.messages as Array<{ role: string; content: string }>) ?? []
      capturedSystem = msgs.find((m) => m.role === 'system')?.content ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '明白，已参考记忆。' } }] }))
    })

    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'm',
      temperature: 0.2,
      maxTokens: 1024
    })
    const runtime = new AgentRuntime(db, new StudyService(db, ai), ai)
    const result = await runtime.run(
      { requestId: 'agent-mem-1', messages: [{ role: 'user', content: '给我建议' }] },
      () => {}
    )

    expect(result.content).toBe('明白，已参考记忆。')
    expect(capturedSystem).toContain('ENABLED_MEMORY_TOKEN_资料分析优先保准确率')
    expect(capturedSystem).not.toContain('DISABLED_MEMORY_TOKEN_不应出现在系统提示')
  })

  it('cancels an in-flight agent run cleanly and emits aborted event', async () => {
    const db = makeDb()
    let releaseServer!: () => void
    let arrived!: () => void
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const { url } = await startHttpServer((_req, res) => {
      arrived()
      releaseServer = () => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }))
        }
      }
    })

    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'm',
      temperature: 0.2,
      maxTokens: 1024
    })
    const runtime = new AgentRuntime(db, new StudyService(db, ai), ai)
    const events: AgentStreamEvent[] = []
    const runPromise = runtime.run(
      { requestId: 'agent-cancel-1', messages: [{ role: 'user', content: '帮我规划' }] },
      (ev) => events.push(ev)
    )

    await requestArrived
    await new Promise((r) => setTimeout(r, 25))
    expect(runtime.cancel('agent-cancel-1')).toBe(true)

    const result = await runPromise
    releaseServer?.()
    expect(result.aborted).toBe(true)
    expect(events.some((e) => e.type === 'aborted')).toBe(true)
  })
})

describe('Agent regression fixes', () => {
  it('re-enables a disabled learner memory when re-saved with duplicate content', () => {
    const db = makeDb()
    const saved = db.saveLearnerMemory({
      category: '配速偏好',
      content: '言语理解控制在 45 秒以内',
      evidence: '初始统计',
      source: 'user'
    })
    db.toggleLearnerMemory(saved.id, false)
    expect(db.listLearnerMemories(true)).toHaveLength(0)

    const reEnabled = db.saveLearnerMemory({
      category: '配速偏好',
      content: '言语理解控制在45秒以内',
      evidence: '',
      source: 'agent'
    })
    expect(reEnabled.id).toBe(saved.id)
    expect(reEnabled.enabled).toBe(true)
    expect(db.listLearnerMemories(true).map((m) => m.id)).toEqual([saved.id])
  })

  it('strips toolSteps/proposals in requestSpec, adds strict:false/DeepSeek thinking/toolChoice:none', () => {
    const tools: AgentToolDefinition[] = [
      {
        name: 'get_study_overview',
        description: '读取备考总览',
        parameters: { type: 'object', properties: { days: { type: 'integer' } } }
      }
    ]
    const mixedMessages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: 'prev',
        toolSteps: [
          {
            id: 's1',
            toolName: 't',
            label: 't',
            mode: 'read' as const,
            argsSummary: '',
            status: 'done' as const
          }
        ],
        proposals: [
          {
            id: 'p1',
            kind: 'enqueue_review' as const,
            title: 'x',
            summary: 'x',
            reason: 'x',
            payload: {},
            status: 'pending' as const
          }
        ]
      }
    ]

    const dsSpec = requestSpec(
      {
        provider: 'deepseek',
        protocol: 'openai-chat',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        temperature: 0.2,
        maxTokens: 2048
      },
      mixedMessages,
      'sk-ds'
    )
    expect(dsSpec.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'prev' }
    ])

    const respPlainSpec = requestSpec(
      {
        provider: 'openai',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        temperature: 0.2,
        maxTokens: 2048
      },
      mixedMessages,
      'sk-oai'
    )
    expect(respPlainSpec.body.input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'prev' }
    ])

    const respToolNone = toolRequestSpec(
      {
        provider: 'openai',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        temperature: 0.2,
        maxTokens: 2048
      },
      'sk-oai',
      [{ role: 'user', content: 'hi' }],
      tools,
      { toolChoice: 'none' }
    )
    expect((respToolNone.body.tools as Array<Record<string, unknown>>)[0]!.strict).toBe(false)
    expect(respToolNone.body.tool_choice).toBe('none')

    const dsToolSpec = toolRequestSpec(
      {
        provider: 'deepseek',
        protocol: 'openai-chat',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        temperature: 0.2,
        maxTokens: 2048
      },
      'sk-ds',
      [{ role: 'user', content: 'hi' }],
      tools
    )
    expect(dsToolSpec.body.thinking).toEqual({ type: 'disabled' })

    const antToolNone = toolRequestSpec(
      {
        provider: 'anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-7',
        temperature: 0.2,
        maxTokens: 2048
      },
      'ak',
      [{ role: 'user', content: 'hi' }],
      tools,
      { toolChoice: 'none' }
    )
    expect(antToolNone.body.tool_choice).toEqual({ type: 'none' })

    const googleToolNone = toolRequestSpec(
      {
        provider: 'google',
        protocol: 'google-generate-content',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash',
        temperature: 0.2,
        maxTokens: 2048
      },
      'gk',
      [{ role: 'user', content: 'hi' }],
      tools,
      { toolChoice: 'none' }
    )
    expect(googleToolNone.body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' }
    })
  })

  it('preserves existing note when append substring already exists and navigates to /review?tab=notes', () => {
    const db = makeDb()
    const { questions } = seedWorkbench(db)
    const study = new StudyService(db, new AiService(db))

    db.saveNote('q-zl-1', '先算现期再求基期；注意排除百分数混淆')
    const res = executeApprovedAction(
      {
        id: 'p-note-dup',
        kind: 'save_note',
        title: '保存笔记',
        summary: '追加',
        reason: 'r',
        payload: { questionId: 'q-zl-1', content: '注意排除百分数混淆', mode: 'append' },
        status: 'pending'
      },
      { database: db, study }
    )
    expect(res.ok).toBe(true)
    expect(res.navigateTo).toBe('/review?tab=notes')
    expect(db.getNote('q-zl-1')).toBe('先算现期再求基期；注意排除百分数混淆')
    expect(questions.length).toBe(4)
  })

  it('creates review session without abandoning active practice session and routes to /review', () => {
    const db = makeDb()
    const { questions } = seedWorkbench(db)
    const study = new StudyService(db, new AiService(db))

    const existingPractice = db.createPracticeSession(
      { mode: 'sequence', count: 1, feedbackMode: 'immediate' },
      [questions[1]!]
    )

    const execRes = executeApprovedAction(
      {
        id: 'p-review-mode',
        kind: 'start_practice',
        title: '复习训练',
        summary: '复习模式',
        reason: '巩固错题',
        payload: {
          selection: {
            mode: 'review',
            count: 1,
            feedbackMode: 'immediate',
            questionIds: ['q-zl-1']
          }
        },
        status: 'pending'
      },
      { database: db, study }
    )

    expect(execRes.ok).toBe(true)
    expect(execRes.navigateTo).toBe('/review')
    expect(db.getActivePracticeSession('practice')?.id).toBe(existingPractice.id)
    expect(db.getActivePracticeSession('review')?.questionIds).toEqual(['q-zl-1'])
  })

  it('excludes shenlun exams, sums multi-exam sunk costs, expands category aliases, and skips already-queued review items', () => {
    const db = makeDb()
    seedWorkbench(db)
    const ai = new AiService(db)
    const study = new StudyService(db, ai)

    const essayQ: Question = {
      id: 'q-sl-1',
      subject: 'shenlun',
      category: '单一题',
      type: 'essay',
      stem: '概括主要做法',
      options: [],
      answer: ['要点一'],
      explanation: '参考要点',
      difficulty: 3,
      source: '申论测试',
      tags: [],
      contentHash: 'hash-sl-1'
    }
    const shenlunExam = db.createExam(
      { title: '申论模考应排除', subject: 'shenlun', durationMinutes: 120, questionCount: 1 },
      [essayQ]
    )
    db.saveExamAnswer(shenlunExam.id, {
      questionId: 'q-sl-1',
      answer: ['个人作答内容'],
      durationSeconds: 900
    })
    db.finishExam(shenlunExam.id)

    const xingceExam2 = db.createExam(
      { title: '第二次行测模考', subject: 'xingce', durationMinutes: 30, questionCount: 1 },
      [db.getQuestion('q-yy-1')!]
    )
    db.saveExamAnswer(xingceExam2.id, {
      questionId: 'q-yy-1',
      answer: ['B'],
      durationSeconds: 130
    })
    db.finishExam(xingceExam2.id)

    const sunkOut = executeAgentTool('get_exam_sunk_cost', { limit: 3 }, { database: db, study })
    const sunkParsed = JSON.parse(sunkOut.outputJson) as { exams: Array<{ id: string }> }
    expect(sunkParsed.exams).toHaveLength(2)
    expect(sunkParsed.exams.map((e) => e.id)).not.toContain(shenlunExam.id)
    expect(sunkOut.summary).toContain('发现 2 道超时错题')

    // 别名兼容：「言语理解与表达」可查出存储为「言语理解」的题
    const wrongAlias = executeAgentTool(
      'query_wrong_questions',
      { category: '言语理解与表达' },
      { database: db, study }
    )
    expect(JSON.parse(wrongAlias.outputJson).count).toBe(1)

    const searchAlias = executeAgentTool(
      'search_vault_questions',
      { category: '言语理解与表达' },
      { database: db, study }
    )
    expect(JSON.parse(searchAlias.outputJson).count).toBe(1)

    const practiceAlias = executeAgentTool(
      'propose_practice_session',
      { category: '言语理解与表达', count: 1 },
      { database: db, study }
    )
    expect(practiceAlias.ok).toBe(true)
    expect(practiceAlias.proposal).toBeDefined()

    // q-zl-1 已在活跃复习队列中，单独入队应跳过不生成空提案；混合 q-pd-1 只保留未入队项
    const allQueued = executeAgentTool(
      'propose_enqueue_review',
      { questionIds: ['q-zl-1'] },
      { database: db, study }
    )
    expect(allQueued.ok).toBe(true)
    expect(allQueued.proposal).toBeUndefined()
    expect(JSON.parse(allQueued.outputJson).alreadyQueuedCount).toBe(1)

    const partialQueued = executeAgentTool(
      'propose_enqueue_review',
      { questionIds: ['q-zl-1', 'q-pd-1'] },
      { database: db, study }
    )
    expect(partialQueued.proposal?.payload.questionIds).toEqual(['q-pd-1'])
  })

  it('passes tools with tool_choice:none on MAX_AGENT_STEPS closing turn, rejects round-0 empty content, and skips mid-loop fallback', async () => {
    const db = makeDb()
    seedWorkbench(db)

    let mode: 'max-steps' | 'empty-r0' | 'mid-400' = 'max-steps'
    let round = 0
    const closingPayloads: Array<Record<string, unknown>> = []

    const { url } = await startHttpServer(async (req, res) => {
      const body = await readJsonBody(req)
      round += 1

      if (mode === 'max-steps') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (round <= 6) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `loop-${round}`,
                        type: 'function',
                        function: { name: 'list_learner_memories', arguments: '{}' }
                      }
                    ]
                  }
                }
              ]
            })
          )
          return
        }
        closingPayloads.push(body)
        res.end(
          JSON.stringify({ choices: [{ message: { content: '达到轮次上限后的汇总回复。' } }] })
        )
        return
      }

      if (mode === 'empty-r0') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }))
        return
      }

      if (round === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'list_learner_memories', arguments: '{}' }
                    }
                  ]
                }
              }
            ]
          })
        )
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid tool_use block in history' } }))
    })

    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'm',
      temperature: 0.2,
      maxTokens: 1024
    })
    const runtime = new AgentRuntime(db, new StudyService(db, ai), ai)

    const resMax = await runtime.run(
      { requestId: 'req-max-steps', messages: [{ role: 'user', content: '查到底' }] },
      () => {}
    )
    expect(resMax.content).toBe('达到轮次上限后的汇总回复。')
    expect(closingPayloads).toHaveLength(1)
    expect((closingPayloads[0]!.tools as unknown[]).length).toBeGreaterThan(0)
    expect(closingPayloads[0]!.tool_choice).toBe('none')

    mode = 'empty-r0'
    round = 0
    await expect(
      runtime.run(
        { requestId: 'req-empty-r0', messages: [{ role: 'user', content: '你好' }] },
        () => {}
      )
    ).rejects.toThrow('模型返回了空内容')

    mode = 'mid-400'
    round = 0
    await expect(
      runtime.run(
        { requestId: 'req-mid-400', messages: [{ role: 'user', content: '再试' }] },
        () => {}
      )
    ).rejects.toThrow('模型端点不支持原生工具调用')
  })

  it('throws localized Chinese timeout message from askToolTurn instead of raw TIMEOUT', async () => {
    const db = makeDb()
    let release!: () => void
    const { url } = await startHttpServer((_req, res) => {
      release = () => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
      }
    })
    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'm',
      temperature: 0.2,
      maxTokens: 1024
    })

    await expect(
      ai.askToolTurn([{ role: 'user', content: 'hi' }], [], {
        requestId: 'req-timeout-1',
        timeoutMs: 60
      })
    ).rejects.toThrow('模型请求超时，请检查网络或服务地址')
    release?.()
  })
})
