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
  normalizeOcrText,
  parseAnswerGroups,
  parseEssayBook,
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
    const questions = parseQuestionBook(
      TIBEN.filter((line) => line !== '参考答案' && line !== '1-2:AB')
    )
    const solutions = new Map(
      [
        ...parseSolutionBook([
          '1. (2019年安徽省考 62%)',
          '【参考答案】A',
          '【实战解析】完整解析正文。'
        ])
      ].map(([key, value]) => [key, value])
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

describe('essay book parsing', () => {
  it('normalizes OCR mid-word spaces but preserves latin word spacing', () => {
    expect(normalizeOcrText('2020年3月，M市F银 行召开了普惠金 融战略启动大会，需求一提 出。')).toBe(
      '2020年3月，M市F银行召开了普惠金融战略启动大会，需求一提出。'
    )
    expect(normalizeOcrText('要求 ：全面、准确，不超　过250字。'.replace('　', '\u3000'))).toBe(
      '要求：全面、准确，不超过250字。'
    )
    // 中英混排的正常空格保留
    expect(normalizeOcrText('可在申论作答页配合 AI 批改练习')).toBe(
      '可在申论作答页配合 AI 批改练习'
    )
  })

  it('merges soft-wrapped OCR rows into paragraphs and keeps long questions intact', () => {
    // 场景一（截图回归）：材料被版面折行成多条，句末标点才分段，其余无缝拼接
    // 场景二：超长设问句不得被字数上限截断，前后两半都进题干
    const book = parseEssayBook(
      toLines(
        [
          '第一章 归纳概括',
          '【训练一】“好品山东”好在哪里',
          '资料1',
          '11月11日下午，在北京展览馆举行的“好客山东好品山东”2023北京推介活动',
          '“好品凭质量”专场推介会上，圣匠鲁班穿越2500年来到现场，',
          '与几位“好品山东推荐官”携手互动。',
          '近年来当地贯彻落实《质量发展若干措施》，将分散在各部门、各系统、各区域的品牌，',
          '整合形成良好的聚合效应，品牌矩阵持续放大增值效应。',
          '请你结合全部给定资料，谈谈“好品山东”好在',
          '哪些方面，有哪些经验可供其他省份借鉴推广。',
          '(2024年国考副省卷)',
          '要求：全面、准确、有条理，不超过250字。'
        ].join('\n')
      )
    )

    expect(book.units).toHaveLength(1)
    const unit = book.units[0]!
    const paragraphs = unit.material.split('\n\n')
    expect(paragraphs.length).toBeGreaterThan(1)
    expect(unit.material).toContain('2023北京推介活动“好品凭质量”专场推介会上')
    expect(unit.material).not.toMatch(/活动\n/)
    // 段落级采纳：叙事背景段留材料，真正的设问段整体进题干、不截半句
    expect(unit.material).toContain('贯彻落实《质量发展若干措施》')
    expect(unit.stem).not.toContain('贯彻落实《质量发展若干措施》')
    expect(unit.stem).toContain('有哪些经验可供其他省份借鉴推广')
    expect(unit.year).toBe(2024)
  })

  it('carries cleaned text through units so material has no OCR gaps', () => {
    const book = parseEssayBook(
      toLines(
        [
          '第一章 归纳概括',
          '【训练一】普惠金融案例',
          '资料4',
          'M市F银 行召开了普惠金 融战略启动大会，宣布加大对中小微企业的服务力度，企业无需再人工提交资料。',
          '谈谈你对普惠金 融惠及小微企业的看法。',
          '要求：观点明确，不超过200字。'
        ].join('\n')
      )
    )
    const unit = book.units[0]!
    expect(unit.material).toContain('F银行召开了普惠金融战略启动大会')
    expect(unit.stem).toContain('普惠金融惠及小微企业')
  })
  const KUAKUA_UNIT = [
    '第一章 归纳概括',
    '【训练一】提升基层社会治理水平经验做法',
    '资料2',
    '“不仅仅是方便，还省了不少钱呢！”一大早，小区72岁老人董先生对上门服务的义剪美爱心理发师竖起了大拇指，连夸政府为老人们办了件大实事。',
    'W市经济技术开发区在实践中探索设立社区基金，吸纳驻区单位、企业园区、社会组织、居民群众中的红色力量参与社区基金的筹建，搭建社区需求与资源对接的公益平台，形成精准化对接、项目化运作、品牌化带动新格局。目前我们已成立街道级社区基金2支、社区级基金32支，累计募捐资金达到130余万元。',
    '根据“给定资料2”，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。',
    '(2023年山东B卷）',
    '要求：全面，准确，有条理，不超过300字。'
  ]

  it('cuts bracket-style units with chapter, origin, requirement and material', () => {
    const book = parseEssayBook(
      toLines(
        [
          '2027申论',
          '目录',
          '第一章 归纳概括..',
          '【训练一】提升基层社会治理水平经验做法.',
          '.2',
          ...KUAKUA_UNIT,
          '100',
          '3',
          '第二章 提出对策',
          '【训练二】解决线上盲道问题',
          '资料1',
          '盲道被占用现象普遍，部分路段的盲道被共享单车和机动车挤占，视障人士出行困难，反映多次仍未得到有效解决。',
          '请梳理“线上盲道”在建设和使用中存在的问题，并提出解决建议。',
          '要求：问题梳理准确全面，不超过250字。'
        ].join('\n')
      )
    )

    expect(book.skipped).toBe(0)
    expect(book.units).toHaveLength(2)
    const first = book.units[0]!
    expect(first.seq).toBe(1)
    expect(first.chapter).toBe('归纳概括')
    expect(first.title).toBe('提升基层社会治理水平经验做法')
    expect(first.stem).toContain('归纳W市经开区')
    expect(first.stem).toContain('要求：全面，准确，有条理，不超过300字')
    expect(first.stem).not.toContain('山东B卷')
    expect(first.year).toBe(2023)
    expect(first.paper).toBe('山东B卷')
    // 版面标记「资料N」行在拼段时剔除，材料直接以正文开头
    expect(first.material).not.toContain('资料2')
    expect(first.material).toContain('社区基金的筹建')
    expect(first.material.length).toBeGreaterThan(80)

    const second = book.units[1]!
    expect(second.chapter).toBe('提出对策')
    expect(second.year).toBeUndefined()
    expect(second.paper).toBeUndefined()
  })

  it('falls back to title-based stems when a unit has no separate question sentence', () => {
    // 酷酷刷式：训练N：标题 + 给定资料 + 要求，没有独立提问句
    const book = parseEssayBook(
      toLines(
        [
          '实战公考',
          '酷酷刷',
          '第一章 归纳概括',
          '训练一：“好品山东”好在哪里',
          '5',
          '给定资料6',
          '好品山东为企业注入质量基因，一批制造企业在标准引领下实现品牌溢价，产品远销海外市场，区域品牌效应持续放大，形成质量与效益互促的良性循环。',
          '要求：概括“好品山东”好在哪些方面，条理清晰，不超过200字。'
        ].join('\n')
      )
    )

    expect(book.units).toHaveLength(1)
    const unit = book.units[0]!
    expect(unit.title).toBe('“好品山东”好在哪里')
    expect(unit.material).toContain('好品山东为企业注入质量基因')
    expect(unit.stem).not.toContain('好品山东为企业注入质量基因')
    expect(unit.stem).toContain('要求：概括')
  })

  it('captures an in-unit reference answer as explanation when the book provides one', () => {
    const book = parseEssayBook(
      toLines(
        [
          ...KUAKUA_UNIT,
          '参考答案：',
          '一是坚持党建引领，汇聚多方力量共建社区基金；',
          '二是搭建供需对接平台，推动项目化运作。'
        ].join('\n')
      )
    )
    expect(book.units[0]!.explanation).toContain('坚持党建引领')
  })

  it('skips units that have neither material nor a meaningful stem', () => {
    const book = parseEssayBook(
      toLines(
        ['第一章 归纳概括', '【训练一】标题甲', '【训练二】标题乙', '【训练三】标题丙'].join('\n')
      )
    )
    expect(book.units).toHaveLength(0)
    expect(book.skipped).toBe(3)
  })
})

describe('knowledge builder direct mode', () => {
  it('imports a question book and solution file without any model calls', async () => {
    const data = temporaryDirectory('tizhou-kb-direct-data-')
    const source = temporaryDirectory('tizhou-kb-direct-source-')
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
        '练习题02套',
        '1. (2020年北京市考 71%)',
        '【参考答案】C',
        '【实战解析】新套第一题解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const connect = vi.fn((path: string) => ({
      vault: {
        id: 'managed',
        name: 'managed-vault',
        path,
        connectedAt: '',
        lastIndexedAt: '',
        questionCount: 3,
        documentCount: 0,
        warnings: [],
        isBuiltin: false
      },
      added: 3,
      updated: 0,
      removed: 0,
      skipped: 0,
      warnings: []
    }))
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
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
      } as unknown as VaultService
    )
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
    expect(
      readdirSync(join(managedRoot, '直导题库')).filter((name) => name.endsWith('.md'))
    ).toHaveLength(0)
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
    const database = new DatabaseService(
      join(data, 'workbench.sqlite'),
      data,
      join(data, 'backups')
    )
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
      bookLines.push(
        `${(index % 6) + 1}. ${stem}。`,
        'A. 选项甲',
        'B. 选项乙',
        'C. 选项丙',
        'D. 选项丁'
      )
      solutionLines.push(
        `${(index % 6) + 1}. (2021年广东省考 60%)`,
        `与题干毫无关系的重印文本第${index}号，内容完全不同便于区分。`,
        '【参考答案】A',
        '【实战解析】解析正文。'
      )
    })
    writeFileSync(join(source, '题本.md'), `${bookLines.join('\n')}\n`, 'utf8')
    writeFileSync(join(source, '解析.md'), `${solutionLines.join('\n')}\n`, 'utf8')
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
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
    )
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
    expect(job.status).toBe('completed')
    expect(job.message).toContain('套号错位')
    expect(job.artifacts).toHaveLength(0)
    const failed = job.files.find((file) => file.state === 'failed')
    expect(failed?.message).toContain('配对校验拦截')
  }, 35_000)

  it('cuts shenlun essay units out of a 训练-style book, stages and publishes them without answers', async () => {
    const data = temporaryDirectory('tizhou-kb-essay-data-')
    const source = temporaryDirectory('tizhou-kb-essay-source-')
    // 夸夸刷实录版式：【训练一】标题 + 资料块 + 提问句 + (年份卷别) + 要求：
    writeFileSync(
      join(source, '申论题本.md'),
      [
        '2027申论',
        '专项提升夸夸刷',
        '目录',
        '第一章 归纳概括..',
        '【训练一】提升基层社会治理水平经验做法.',
        '.2',
        '【训练二】如何提供和优化铁路物流服务',
        '....4',
        '第二章 提出对策..',
        '..42',
        '第一章 归纳概括',
        '【训练一】提升基层社会治理水平经验做法',
        '资料2',
        '“不仅仅是方便，还省了不少钱呢！”一大早，小区72岁老人董先生对上门服务的义剪美爱心理发师竖起了大拇指。',
        'W市经济技术开发区在实践中探索设立社区基金，吸纳驻区单位、企业园区、社会组织、居民群众中的红色力量参与社区基金的筹建，搭建社区需求与资源对接的公益平台，形成精准化对接、项目化运作、品牌化带动新格局。目前我们已成立街道级社区基金2支、社区级基金32支，累计募捐资金达到130余万元。',
        '根据“给定资料2”，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。',
        '(2023年山东B卷）',
        '要求：全面，准确，有条理，不超过300字。',
        '100',
        '3',
        '读书破万卷，下笔如有神。概括题的关键在于读懂材料、抓准关键词。',
        '第二章 提出对策',
        '【训练二】解决线上盲道问题',
        '资料1',
        '盲道被占用现象普遍，部分路段的盲道被共享单车和机动车挤占，视障人士出行困难，反映多次仍未得到有效解决，管理部门职责边界不清，日常巡查机制缺失。',
        '请梳理“线上盲道”在建设和使用中存在的问题，并提出解决建议。',
        '要求：问题梳理准确全面，所提建议与问题相对应，具有可行性，不超过250字。'
      ].join('\n') + '\n',
      'utf8'
    )
    const connect = vi.fn((path: string) => ({
      vault: {
        id: 'managed',
        name: 'managed-vault',
        path,
        connectedAt: '',
        lastIndexedAt: '',
        questionCount: 2,
        documentCount: 0,
        warnings: [],
        isBuiltin: false
      },
      added: 2,
      updated: 0,
      removed: 0,
      skipped: 0,
      warnings: []
    }))
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
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
      } as unknown as VaultService
    )
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

    expect(job.status).toBe('review')
    expect(job.message).toContain('申论主观题 2 道')
    expect(job.files[0]?.message).toContain('2 道申论题')

    for (const artifact of job.artifacts) service.reviewArtifact(job.id, artifact.id, 'approved')
    service.publish(job.id)

    const managedRoot = connect.mock.calls[0]![0]
    const files = readdirSync(join(managedRoot, '直导题库'), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.md'))
    expect(files.length).toBe(2)
    const first = matter(readFileSync(join(managedRoot, '直导题库', files[0]!), 'utf8'))
    expect(first.data.questionType).toBe('essay')
    expect(first.data.subject).toBe('shenlun')
    expect(first.data.answer).toEqual([])
    expect(String(first.data.material)).toContain('社区基金')
    expect(first.data.year).toBe(2023)
    expect(first.data.paper).toBe('山东B卷')
  }, 35_000)

  it('suggests the organize mode when a book has training marks but nothing can be cut', async () => {
    const data = temporaryDirectory('tizhou-kb-guide-data-')
    const source = temporaryDirectory('tizhou-kb-guide-source-')
    // 有体量（能过 50 字防扫描件闸门）、有训练式标记，但单元全是空壳切不出内容
    writeFileSync(
      join(source, '残卷.md'),
      [
        '说明：本书为出版社赠阅样张，此处为版权页说明文字，用于排版校对与印前审读流程演示，不具备学习参考价值。',
        '第一章 归纳概括',
        '【训练一】标题甲',
        '【训练二】标题乙',
        '【训练三】标题丙'
      ].join('\n') + '\n',
      'utf8'
    )
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
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
    )
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

    expect(job.status).toBe('completed')
    expect(job.message).toContain('模型提炼')
  }, 35_000)

  it('routes a shenlun book through the essay channel even when OCR noise yields pseudo objective stems', async () => {
    // 回归：夸夸刷里存在「N. 长句」形似残渣行，旧路由「客观题>0 即走客观题」把整本书送错管线
    const data = temporaryDirectory('tizhou-kb-route-data-')
    const source = temporaryDirectory('tizhou-kb-route-source-')
    writeFileSync(
      join(source, '申论题本.md'),
      [
        '第一章 归纳概括',
        '【训练一】提升基层社会治理水平经验做法',
        '资料2',
        'W市经济技术开发区在实践中探索设立社区基金，吸纳驻区单位、企业园区、社会组织、居民群众中的红色力量参与筹建，搭建社区需求与资源对接的公益平台，形成精准化对接、项目化运作的新格局，累计募捐资金达到130余万元。',
        '根据“给定资料2”，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。',
        '(2023年山东B卷）',
        '要求：全面，准确，有条理，不超过300字。',
        '第二章 提出对策',
        '【训练二】解决线上盲道问题',
        '资料1',
        '盲道被占用现象普遍，部分路段的盲道被共享单车和机动车挤占，视障人士出行困难，反映多次仍未解决，管理部门职责边界不清。',
        '请梳理“线上盲道”在建设和使用中存在的问题，并提出解决建议。',
        '要求：梳理准确，建议可行，不超过250字。',
        '第三章 综合分析',
        '【训练三】谈谈对“夜经济”的理解',
        '资料3',
        '夜间经济已经成为城市消费的新蓝海，多地出台政策延长商圈营业时间、丰富夜间文化供给，但同时也带来噪音扰民与环卫压力等治理新课题。',
        '结合给定资料，谈谈你对发展“夜经济”的看法。',
        '要求：观点明确，分析透彻，不超过200字。',
        '1. 这是排版残渣形成的编号长句，形式与客观题题号行高度相似但绝非可入库的选择题目内容。',
        '2. 另一条同类编号残渣句子同样只是为了让客观题解析器产出非零候选数，用来锁定这条路由回归路径。'
      ].join('\n') + '\n',
      'utf8'
    )
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
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
    )
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

    expect(job.status).toBe('review')
    expect(job.files[0]?.message).toContain('道申论题')
    expect(job.message).toContain('申论主观题')
  }, 35_000)
})

describe('结构解析 markdown 容错（资料分析600题结构模式实测形态）', () => {
  it('带 # 前缀的套标题照常开套，且套标题不混入材料', () => {
    const questions = parseQuestionBook([
      '# 练习题01套',
      '一、根据所给材料，回答1～5题。',
      '2022年全国发电量8.5万亿千瓦时，同比增长3.4%，其中火电与新能源结构持续调整变化。',
      '1. 2021年7月份，全国发电量大约是多少亿千瓦时：',
      'A. 1.2',
      'B. 1.5',
      'C. 1.8',
      'D. 2.0'
    ])
    expect(questions).toHaveLength(1)
    expect(questions[0]?.set).toBe(1)
    expect(questions[0]?.material).not.toContain('练习题01套')
    expect(questions[0]?.material).toContain('发电量')
  })
})

describe('OCR 波浪线噪声收敛', () => {
  it('连续 ~~ 收敛为单字符，不再触发 GFM 删除线渲染', () => {
    const lines = toLines(
      [
        '2022年第三季度=4566-2988~~1600亿元',
        '2022年第四季度=6292-4566~~1700~~亿元、2023年第三季度~~2915-1443~~=1500亿元'
      ].join('\n')
    )
    expect(lines[0]).not.toContain('~')
    expect(lines[1]).not.toContain('~')
    expect(lines[1]).toContain('～1700～亿元')
  })
})
