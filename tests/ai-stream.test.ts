import { createServer, type AddressInfo, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import {
  AiService,
  consumeSseStream,
  requestSpec,
  type StoredAiConfig
} from '../src/main/services/ai'
import { StudyService } from '../src/main/services/study'
import { extractShenlunStreamPreview } from '../src/renderer/src/services/ai-stream'
import type { AiMessage } from '../src/shared/contracts'

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
  const dir = makeTempDir('tizhou-stream-')
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

afterEach(async () => {
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  for (const db of openDbs.splice(0)) {
    db.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
      }
      controller.close()
    }
  })
}

describe('AI SSE requestSpec & consumeSseStream', () => {
  const baseConfig: StoredAiConfig = {
    provider: 'deepseek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.2,
    maxTokens: 2048
  }
  const messages: AiMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]

  it('requestSpec keeps stream: false by default and enables per-protocol streaming when requested', () => {
    const offSpec = requestSpec(baseConfig, messages, 'k')
    expect(offSpec.body.stream).toBe(false)

    const chatOn = requestSpec(baseConfig, messages, 'k', { stream: true })
    expect(chatOn.body.stream).toBe(true)
    expect(chatOn.headers.Accept).toContain('text/event-stream')

    const respOn = requestSpec(
      {
        ...baseConfig,
        provider: 'openai',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1'
      },
      messages,
      'k',
      { stream: true }
    )
    expect(respOn.body.stream).toBe(true)

    const anthropicOn = requestSpec(
      {
        ...baseConfig,
        provider: 'anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com'
      },
      messages,
      'k',
      { stream: true }
    )
    expect(anthropicOn.body.stream).toBe(true)

    const googleOn = requestSpec(
      {
        ...baseConfig,
        provider: 'google',
        protocol: 'google-generate-content',
        baseUrl: 'https://generativelanguage.googleapis.com'
      },
      messages,
      'k',
      { stream: true }
    )
    expect(googleOn.endpoint).toContain(':streamGenerateContent?alt=sse')
  })

  it('consumeSseStream handles split UTF-8 bytes and openai-chat SSE chunks', async () => {
    const enc = new TextEncoder()
    const line1 = enc.encode('data: {"choices":[{"delta":{"content":"你好，"}}]}\n\n')
    const line2 = enc.encode(
      'data: {"choices":[{"delta":{"content":"申论思路"}}],"usage":{"total_tokens":42}}\n\n'
    )
    const done = enc.encode('data: [DONE]\n\n')
    // 将多字节中文在 UTF-8 字节边界处切断
    const splitA = line1.slice(0, 38)
    const splitB = line1.slice(38)
    const deltas: string[] = []
    const res = await consumeSseStream(
      'openai-chat',
      streamFromChunks([splitA, splitB, line2, done]),
      (delta) => deltas.push(delta)
    )
    expect(res.content).toBe('你好，申论思路')
    expect(deltas).toEqual(['你好，', '申论思路'])
    expect(res.usage?.totalTokens).toBe(42)
  })

  it('consumeSseStream extracts deltas for openai-responses, anthropic-messages, and google', async () => {
    const r1 = await consumeSseStream(
      'openai-responses',
      streamFromChunks([
        'data: {"type":"response.output_text.delta","delta":"段"}\n',
        'data: {"type":"response.output_text.delta","delta":"落"}\n'
      ]),
      () => {}
    )
    expect(r1.content).toBe('段落')

    const r2 = await consumeSseStream(
      'anthropic-messages',
      streamFromChunks([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"对策"}}\n'
      ]),
      () => {}
    )
    expect(r2.content).toBe('对策')

    const r3 = await consumeSseStream(
      'google-generate-content',
      streamFromChunks([
        'data: {"candidates":[{"content":{"parts":[{"text":"要点一"}]}}]}\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"与二"}]}}]}\n'
      ]),
      () => {}
    )
    expect(r3.content).toBe('要点一与二')
  })
})

describe('AiService.askStream & cancelStream & Shenlun abort', () => {
  it('streams chunks via HTTP SSE and falls back when provider returns plain JSON', async () => {
    let mode: 'sse' | 'json' = 'sse'
    const { url } = await startHttpServer((_req, res) => {
      if (mode === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":"内容"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '整段非流式响应' } }] }))
      }
    })

    const db = makeDb()
    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'local-model',
      temperature: 0.2,
      maxTokens: 1024
    })

    const sseDeltas: string[] = []
    const res1 = await ai.askStream(
      { requestId: 'req-sse', purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] },
      { onChunk: (d) => sseDeltas.push(d) }
    )
    expect(res1.aborted).toBeUndefined()
    expect(res1.content).toBe('第一段内容')
    expect(sseDeltas).toEqual(['第一段', '内容'])

    mode = 'json'
    const jsonDeltas: string[] = []
    const res2 = await ai.askStream(
      { requestId: 'req-json', purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] },
      { onChunk: (d) => jsonDeltas.push(d) }
    )
    expect(res2.content).toBe('整段非流式响应')
    expect(jsonDeltas).toEqual(['整段非流式响应'])
  })

  it('aborts active stream on cancelStream and returns partial content', async () => {
    let firstChunkSent!: () => void
    const waited = new Promise<void>((resolve) => {
      firstChunkSent = resolve
    })
    const { url } = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"已吐出一半"}}]}\n\n')
      firstChunkSent()
      // 保持连接打开等待客户端中止
    })

    const db = makeDb()
    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'local-model',
      temperature: 0.2,
      maxTokens: 1024
    })

    const promise = ai.askStream(
      { requestId: 'req-abort', purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] },
      { onChunk: () => {} }
    )
    await waited
    await new Promise((r) => setTimeout(r, 30))
    expect(ai.cancelStream('req-abort')).toBe(true)
    const res = await promise
    expect(res.aborted).toBe(true)
    expect(res.content).toBe('已吐出一半')
  })

  it('StudyService.evaluateConstructed rejects on user abort without local rubric fallback', async () => {
    const db = makeDb()
    const fakeAi = {
      getConfig: () => ({
        provider: 'lmstudio',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1234',
        model: 'm',
        temperature: 0.2,
        maxTokens: 2048,
        hasApiKey: false,
        verified: true
      }),
      askStream: vi.fn(async () => ({
        content: '{"score": 80',
        provider: 'lmstudio',
        model: 'm',
        aborted: true
      }))
    } as unknown as AiService

    const study = new StudyService(db, fakeAi)
    await expect(
      study.evaluateConstructed({
        promptId: 'p1',
        title: '测试申论',
        content: '这是一段超过二十个字的申论作答内容用于验证流式中断行为。',
        requestId: 'eval-abort-1'
      })
    ).rejects.toThrow('已停止本次 AI 批改')
    expect(db.listConstructedAttempts({ promptId: 'p1' })).toHaveLength(0)
  })

  it('throws upstream SSE error payload instead of treating stream as empty', async () => {
    const { url } = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('data: {"error":{"message":"quota exceeded"}}\n\n')
      res.end()
    })

    const db = makeDb()
    const ai = new AiService(db)
    ai.saveConfig({
      provider: 'lmstudio',
      protocol: 'openai-chat',
      baseUrl: url,
      model: 'local-model',
      temperature: 0.2,
      maxTokens: 1024
    })

    await expect(
      ai.askStream(
        { requestId: 'req-sse-err', purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] },
        { onChunk: () => {} }
      )
    ).rejects.toThrow('quota exceeded')
  })

  it('calls onReset when StudyService.evaluateConstructed retries after invalid JSON', async () => {
    const db = makeDb()
    let callCount = 0
    const fakeAi = {
      getConfig: () => ({
        provider: 'lmstudio',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1234',
        model: 'm',
        temperature: 0.2,
        maxTokens: 2048,
        hasApiKey: false,
        verified: true
      }),
      askStream: vi.fn(async (_input, callbacks: { onChunk: (delta: string) => void }) => {
        callCount += 1
        if (callCount === 1) {
          callbacks.onChunk('非JSON残片')
          return { content: '非JSON残片', provider: 'lmstudio', model: 'm' }
        }
        const okJson = JSON.stringify({
          score: 86,
          dimensions: [{ name: '要点覆盖', score: 86, comment: '完整' }],
          summary: '总体良好',
          suggestions: ['继续保持']
        })
        callbacks.onChunk(okJson)
        return { content: okJson, provider: 'lmstudio', model: 'm' }
      })
    } as unknown as AiService

    const onReset = vi.fn()
    const onChunk = vi.fn()
    const study = new StudyService(db, fakeAi)
    const evaluation = await study.evaluateConstructed(
      {
        promptId: 'p2',
        title: '测试申论重试',
        content: '这是一段超过二十个字的申论作答内容用于验证重试重置流式预览行为。',
        requestId: 'eval-retry-1'
      },
      { onChunk, onReset }
    )

    expect(callCount).toBe(2)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(evaluation.score).toBe(86)
  })

  it('extractShenlunStreamPreview ignores dimension sub-scores and avoids double unescaping \\\\n', () => {
    const partial =
      '{"dimensions":[{"name":"要点","score":75,"comment":"[good]"}],"summary":"第一句\\\\n第二句\\n第三句"'
    const preview1 = extractShenlunStreamPreview(partial)
    expect(preview1.score).toBeUndefined()
    expect(preview1.summary).toBe('第一句\\n第二句\n第三句')

    const withTotal = `${partial},"score":84}`
    const preview2 = extractShenlunStreamPreview(withTotal)
    expect(preview2.score).toBe(84)
  })
})
