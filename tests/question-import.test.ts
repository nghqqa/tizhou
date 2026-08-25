import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import matter from 'gray-matter'
import { KnowledgeBuilderService } from '../src/main/services/knowledge-builder'
import { DatabaseService } from '../src/main/services/database'
import { VaultService } from '../src/main/services/vault'
import {
  directQuestionMarkdown,
  mergeDirectQuestions,
  parseAnswerGroups,
  parseQuestionBook,
  parseSolutionBook,
  toLines
} from '../src/main/services/question-import'
import type { AiService } from '../src/main/services/ai'
import type { VaultService } from '../src/main/services/vault'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setOneQuestions(): string[] {
  const stems = [
    '题干一第一行，论述某个观点的正确性。',
    '题干二，另一个完整问题。',
    '题干三，第三个完整问题。',
    '题干四，第四个完整问题。',
    '题干五，第五个完整问题。',
    '题干六，第六个完整问题。'
  ]
  return stems.flatMap((stem, index) => [
    `${index + 1}. ${stem}`,
    'A. 观点甲',
    'B. 观点乙',
    'C. 观点丙',
    'D. 观点丁'
  ])
}

const TIBEN = [
  '练习题01套',
  '练习题02套',
  '练习题03套',
  ...setOneQuestions(),
  '1. 新套第一题，内容完整可入库。',
  'A. a选项',
  'B. b选项',
  'C. c选项',
  'D. d选项',
  '参考答案',
  '1-2:AB'
]

describe('question import parsers', () => {
  it('splits question books with TOC poisoning, set resets and answer sections', () => {
    const questions = parseQuestionBook(TIBEN)
    expect(questions).toHaveLength(7)
    expect(questions[0]).toMatchObject({ set: 1, num: 1 })
    expect(questions[0]?.options).toHaveLength(4)
    expect(questions[5]).toMatchObject({ set: 1, num: 6 })
    expect(questions[6]).toMatchObject({ set: 2, num: 1 })
    // 答案区内容不进入题干
    expect(questions[6]?.stem).not.toContain('1-2:AB')
  })

  it('recovers when a question number line is lost to OCR', () => {
    const questions = parseQuestionBook([
      '1. 题干一完整。',
      'A. x1',
      'B. x2',
      'C. x3',
      'D. x4',
      '3. 题干三，跳过丢失的题号二。',
      'A. y1',
      'B. y2',
      'C. y3',
      'D. y4'
    ])
    expect(questions.map((question) => question.num)).toEqual([1, 3])
  })

  it('keeps wrapped option lines with the option instead of the stem', () => {
    const questions = parseQuestionBook([
      '1. 题干足够长可以入库。',
      'A. 这是一个很长的选项内容',
      '它换行继续的部分',
      'B. bb选项',
      'C. cc选项',
      'D. dd选项'
    ])
    expect(questions[0]?.options[0]?.text).toContain('它换行继续的部分')
    expect(questions[0]?.stem).not.toContain('换行')
  })

  it('extracts marked answer blocks from solution books', () => {
    const solutions = parseSolutionBook([
      '练习题01套',
      '1. (2020年江苏省考 66%)',
      '题干重印文本',
      '【参考答案】A',
      '【题型与文段类型】中心理解题',
      '【实战解析】解析正文第一行。',
      '解析正文第二行。',
      '2. (2021年浙江省考 55%)',
      '题干重印',
      '【参考答案】BD',
      '【实战解析】多选解析正文。'
    ])
    expect(solutions.size).toBe(2)
    const first = solutions.get('1-1')
    expect(first).toMatchObject({ answer: 'A', qtype: '中心理解题' })
    expect(first?.origin).toMatchObject({ year: 2020, rate: 66 })
    expect(first?.explanation).toContain('第二行')
    expect(solutions.get('1-2')?.answer).toBe('BD')
  })

  it('parses grouped answer pages and repairs duplicated range starts', () => {
    const answers = parseAnswerGroups([
      '参考答案',
      '第一篇 中心理解（一）',
      '1-5:BBDBC',
      '6-10:BACCA',
      '11-15:ADAAA',
      '16-20:BADAC',
      '21-25:CCBAD',
      '25-30:ABCAC',
      '第二篇 标题填入',
      '1-5:CACAB'
    ])
    expect(answers.get('1-1')).toBe('B')
    expect(answers.get('1-5')).toBe('C')
    // OCR 重复印出的 25-30 被修正为 26-30
    expect(answers.get('1-26')).toBe('A')
    expect(answers.get('1-30')).toBe('C')
    expect(answers.get('2-1')).toBe('C')
  })

  it('merges solutions into questions and emits vault-compatible markdown', () => {
    const questions = parseQuestionBook(TIBEN.filter((line) => line !== '参考答案' && line !== '1-2:AB'))
    const solutions = new Map(
      [...parseSolutionBook([
        '1. (2019年安徽省考 62%)',
        '【参考答案】A',
        '【实战解析】完整解析正文。'
      ])].map(([key, value]) => [key, value])
    )
    const merged = mergeDirectQuestions(questions, solutions, new Map(), {
      subject: 'xingce',
      category: '行测-直导题库',
      sourceFile: '测试题本.md',
      tags: ['直导']
    })
    expect(merged.items.length + merged.skippedNoAnswer + merged.skippedIncomplete).toBe(7)
    const first = merged.items.find((item) => item.set === 1 && item.num === 1)
    expect(first?.answer).toEqual(['A'])
    expect(first?.year).toBe(2019)
    const parsed = matter(directQuestionMarkdown(first!))
    expect(parsed.data.stem).toContain('题干一第一行')
    expect(parsed.data.answer).toEqual(['A'])
    expect(parsed.data.options[0]).toMatchObject({ key: 'A', text: '观点甲' })
    expect(parsed.data.kind).toBe('question')
  })
})

describe('knowledge builder direct mode', () => {
  it('imports a question book and solution file without any model calls', async () => {
    const data = temporaryDirectory('tizhou-kb-direct-data-')
    const source = temporaryDirectory('tizhou-kb-direct-source-')
    writeFileSync(join(source, '题本.md'), `${TIBEN.filter((line) => line !== '参考答案' && line !== '1-2:AB').join('\n')}\n`, 'utf8')
    writeFileSync(
      join(source, '解析.md'),
      [
        '练习题01套',
        '1. (2019年安徽省考 62%)',
        '【参考答案】A',
        '【实战解析】第一题解析。',
        '2. (2019年安徽省考 58%)',
        '【参考答案】B',
        '【实战解析】第二题解析。',
        '练习题02套',
        '1. (2020年北京市考 71%)',
        '【参考答案】C',
        '【实战解析】新套第一题解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const connect = vi.fn((path: string) => ({
      vault: { id: 'managed', name: 'managed-vault', path, connectedAt: '', lastIndexedAt: '', questionCount: 3, documentCount: 0, warnings: [], isBuiltin: false },
      added: 3,
      updated: 0,
      removed: 0,
      skipped: 0,
      warnings: []
    }))
    const service = new KnowledgeBuilderService(data, process.cwd(), {} as AiService, {
      connect,
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
    } as unknown as VaultService)
    vi.spyOn(service, 'engineStatus').mockResolvedValue({
      available: true,
      installing: false,
      version: 'test',
      pythonPath: 'test-python',
      ocrAvailable: false,
      message: 'ready',
      supportedExtensions: ['.md']
    })
    const conversionTarget = service as unknown as {
      convert: (python: string, worker: string, source: string, output: string) => Promise<void>
    }
    vi.spyOn(conversionTarget, 'convert').mockImplementation(
      async (_python, _worker, sourcePath, outputPath) => {
        writeFileSync(outputPath, readFileSync(sourcePath, 'utf8'), 'utf8')
      }
    )
    const scan = service.scan(source)
    const started = await service.startJob({
      sourcePath: source,
      fileIds: scan.files.filter((file) => file.eligible).map((file) => file.id),
      options: {
        mode: 'direct',
        quality: 'standard',
        subject: 'auto',
        tags: [],
        instruction: '',
        rightsConfirmed: true
      }
    })
    let job = started
    const deadline = Date.now() + 30_000
    while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      job = service.getJob(started.id)
    }

    // 两段式：切题进入待审核，抽查后批准并发布
    expect(job.status).toBe('review')
    expect(job.message).toContain('已切出 3 题')
    for (const artifact of job.artifacts) service.reviewArtifact(job.id, artifact.id, 'approved')
    service.publish(job.id)
    job = service.getJob(started.id)
    expect(job.status).toBe('completed')
    expect(connect).toHaveBeenCalled()
    const managedRoot = connect.mock.calls[0]![0]
    const files = readdirSync(join(managedRoot, '直导题库'), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.md'))
    expect(files.length).toBe(3)
    const first = matter(readFileSync(join(managedRoot, '直导题库', files[0]!), 'utf8'))
    expect(first.data.answer).toHaveLength(1)
    expect(first.data.reviewStatus).toBe('approved')

    // 撤销导入：文件移除、产物标记拒绝
    const reverted = service.revertImport(job.id)
    expect(reverted.removed).toBe(3)
    expect(readdirSync(join(managedRoot, '直导题库')).filter((name) => name.endsWith('.md'))).toHaveLength(0)
  }, 35_000)

  it('re-importing the same book dedupes against the active vault (idempotent)', async () => {
    const data = temporaryDirectory('tizhou-kb-idem-data-')
    const source = temporaryDirectory('tizhou-kb-idem-source-')
    writeFileSync(
      join(source, '题本.md'),
      `${TIBEN.filter((line) => line !== '参考答案' && line !== '1-2:AB').join('\n')}\n`,
      'utf8'
    )
    writeFileSync(
      join(source, '解析.md'),
      [
        '练习题01套',
        '1. (2019年安徽省考 62%)',
        '【参考答案】A',
        '【实战解析】第一题解析。',
        '2. (2019年安徽省考 58%)',
        '【参考答案】B',
        '【实战解析】第二题解析。',
        '3. (2019年安徽省考 55%)',
        '【参考答案】C',
        '【实战解析】第三题解析。',
        '4. (2019年安徽省考 51%)',
        '【参考答案】D',
        '【实战解析】第四题解析。',
        '5. (2019年安徽省考 48%)',
        '【参考答案】A',
        '【实战解析】第五题解析。',
        '6. (2019年安徽省考 45%)',
        '【参考答案】B',
        '【实战解析】第六题解析。',
        '练习题02套',
        '1. (2020年北京市考 71%)',
        '【参考答案】C',
        '【实战解析】新套第一题解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const database = new DatabaseService(join(data, 'workbench.sqlite'), data, join(data, 'backups'))
    const vaults = new VaultService(database)
    const service = new KnowledgeBuilderService(data, process.cwd(), {} as AiService, vaults)
    vi.spyOn(service, 'engineStatus').mockResolvedValue({
      available: true,
      installing: false,
      version: 'test',
      pythonPath: 'test-python',
      ocrAvailable: false,
      message: 'ready',
      supportedExtensions: ['.md']
    })
    const conversionTarget = service as unknown as {
      convert: (python: string, worker: string, source: string, output: string) => Promise<void>
    }
    vi.spyOn(conversionTarget, 'convert').mockImplementation(
      async (_python, _worker, sourcePath, outputPath) => {
        writeFileSync(outputPath, readFileSync(sourcePath, 'utf8'), 'utf8')
      }
    )
    const runOnce = async () => {
      const scan = service.scan(source)
      const started = await service.startJob({
        sourcePath: source,
        fileIds: scan.files.filter((file) => file.eligible).map((file) => file.id),
        options: {
          mode: 'direct',
          quality: 'standard',
          subject: 'auto',
          tags: [],
          instruction: '',
          rightsConfirmed: true
        }
      })
      let job = started
      const deadline = Date.now() + 30_000
      while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        job = service.getJob(started.id)
      }
      // 两段式：自动批准并发布，模拟用户「全部批准 → 发布」
      if (job.status === 'review') {
        for (const artifact of job.artifacts)
          service.reviewArtifact(job.id, artifact.id, 'approved')
        service.publish(job.id)
        job = service.getJob(started.id)
      }
      return job
    }
    const firstRun = await runOnce()
    expect(firstRun.status).toBe('completed')
    expect(firstRun.message).toContain('已发布 7 题')
    const importDirectory = join(data, 'knowledge-builder', 'managed-vault', '直导题库')
    expect(readdirSync(importDirectory).filter((name) => name.endsWith('.md'))).toHaveLength(7)

    const secondRun = await runOnce()
    expect(secondRun.status).toBe('completed')
    expect(secondRun.message).toContain('7 题与现有题库重复')
    expect(readdirSync(importDirectory).filter((name) => name.endsWith('.md'))).toHaveLength(7)
    database.close()
  }, 35_000)

  it('aborts a whole book when question and solution sets are misaligned', async () => {
    const data = temporaryDirectory('tizhou-kb-mis-data-')
    const source = temporaryDirectory('tizhou-kb-mis-source-')
    // 12 题题本(两套各6题),题干与解析册重印完全不一致 → 整书拦截
    const bookLines: string[] = ['练习题01套']
    const solutionLines: string[] = ['练习题01套']
    const stems = [
      '甲地推进基层治理数字化转型遇到的问题与对策研究',
      '乙省乡村振兴人才引进政策的实施效果分析',
      '丙市老旧小区改造中的居民参与机制探讨',
      '丁县农产品电商平台发展的困境与出路研究',
      '戊区中小学课后服务供给模式的创新实践分析',
      '己市产业园区绿色低碳转型的路径选择研究',
      '庚省养老服务体系建设中的政府职责边界探讨',
      '辛市新就业形态劳动者权益保障的难点分析',
      '壬县文化遗产保护与旅游开发的平衡机制研究',
      '癸市社区卫生服务能力建设的现状与对策分析',
      '子省营商环境优化的关键指标与推进举措研究',
      '丑市科技创新与产业创新深度融合的路径分析'
    ]
    stems.forEach((stem, index) => {
      if (index === 6) {
        bookLines.push('练习题02套')
        solutionLines.push('练习题02套')
      }
      bookLines.push(`${(index % 6) + 1}. ${stem}。`, 'A. 选项甲', 'B. 选项乙', 'C. 选项丙', 'D. 选项丁')
      solutionLines.push(
        `${(index % 6) + 1}. (2021年广东省考 60%)`,
        `与题干毫无关系的重印文本第${index}号，内容完全不同便于区分。`,
        '【参考答案】A',
        '【实战解析】解析正文。'
      )
    })
    writeFileSync(join(source, '题本.md'), `${bookLines.join('\n')}\n`, 'utf8')
    writeFileSync(join(source, '解析.md'), `${solutionLines.join('\n')}\n`, 'utf8')
    const service = new KnowledgeBuilderService(data, process.cwd(), {} as AiService, {
      connect: vi.fn(),
      ensureBuiltinVault: () => ({
        id: 'builtin', name: '内置示例库', path: 'C:/builtin-vault', connectedAt: '', lastIndexedAt: '',
        questionCount: 0, documentCount: 0, warnings: [], isBuiltin: true
      }),
      questionSignatures: () => new Set<string>()
    } as unknown as VaultService)
    vi.spyOn(service, 'engineStatus').mockResolvedValue({
      available: true, installing: false, version: 'test', pythonPath: 'test-python',
      ocrAvailable: false, message: 'ready', supportedExtensions: ['.md']
    })
    const conversionTarget = service as unknown as {
      convert: (python: string, worker: string, source: string, output: string) => Promise<void>
    }
    vi.spyOn(conversionTarget, 'convert').mockImplementation(
      async (_python, _worker, sourcePath, outputPath) => {
        writeFileSync(outputPath, readFileSync(sourcePath, 'utf8'), 'utf8')
      }
    )
    const scan = service.scan(source)
    const started = await service.startJob({
      sourcePath: source,
      fileIds: scan.files.filter((file) => file.eligible).map((file) => file.id),
      options: {
        mode: 'direct', quality: 'standard', subject: 'auto', tags: [], instruction: '',
        rightsConfirmed: true
      }
    })
    let job = started
    const deadline = Date.now() + 30_000
    while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      job = service.getJob(started.id)
    }
    expect(job.status).toBe('completed')
    expect(job.message).toContain('套号错位')
    expect(job.artifacts).toHaveLength(0)
    const failed = job.files.find((file) => file.state === 'failed')
    expect(failed?.message).toContain('配对校验拦截')
  }, 35_000)
})
