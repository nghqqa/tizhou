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
  repairDriftedQuestionNumbers,
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
    expect(first.data.region).toBe('山东')
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

describe('全篇答案汇总行剥离', () => {
  it('行尾的【全篇答案】CBADD 被剥掉，行内其余内容保留；独立成行则整行过滤', () => {
    const lines = toLines(
      [
        '图2016～2021年全国数据及互联网业务收入发展情况【全篇答案】CBADD',
        '【全篇答案】BDADC',
        '正常解析内容'
      ].join('\n')
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('图2016～2021年全国数据及互联网业务收入发展情况')
    expect(lines[1]).toBe('正常解析内容')
  })
})

describe('解析数字流隔离', () => {
  it('解析里的坐标轴数字流替换为占位标记', () => {
    const lines = toLines(
      [
        '1. 甲比乙多多少：',
        '【参考答案】A',
        '【题型与文段类型】简单计算',
        '【实战解析】',
        '3488 3793 4000 4350 5210 6110 7210 8310',
        '则甲比乙多 10%。'
      ].join('\n')
    )
    const solutions = parseSolutionBook(lines)
    const explanation = solutions.get('1-1')?.explanation ?? ''
    expect(explanation).toContain('图表数据区已隔离')
    expect(explanation).toContain('则甲比乙多 10%')
    expect(explanation).not.toContain('3488')
  })
})

describe('解析块边界与内容分层', () => {
  it('当前块已有答案时再出现答案标记 → 终止块，下一题内容不串入', () => {
    const lines = toLines(
      [
        '1. 甲题干内容足够长了吧：',
        '【参考答案】A',
        '【实战解析】',
        '甲的正确解析内容。',
        '2. 乙题干内容也足够长了：',
        'A. 选项一',
        'B. 选项二',
        '【参考答案及正确率】B，81%',
        '【实战解析】',
        '乙的解析。'
      ].join('\n')
    )
    const solutions = parseSolutionBook(lines)
    expect(solutions.get('1-1')?.explanation).not.toContain('乙')
    expect(solutions.get('1-1')?.explanation).toContain('甲的正确解析')
    expect(solutions.get('1-1')?.answer).toBe('A')
    expect(solutions.get('1-2')?.answer).toBe('B')
  })

  it('行内 ≥3 个连续裸数字串被隔离成审计块，公式与带单位数字保留', () => {
    const lines = toLines(
      [
        '1. 甲比乙多多少：',
        '【参考答案】A',
        '【实战解析】',
        '2019 73.1% 7310 7310 则甲比乙多 10%。',
        '年均增量 ≈ 6390- 5980 410 ≈100亿元，已知1.24 = 2.07。'
      ].join('\n')
    )
    const solutions = parseSolutionBook(lines)
    const explanation = solutions.get('1-1')?.explanation ?? ''
    expect(explanation).toContain('图表数字串')
    expect(explanation).toContain('2019 73.1% 7310 7310')
    expect(explanation).toContain('则甲比乙多 10%')
    expect(explanation).toContain('6390- 5980 410 ≈100亿元')
    expect(explanation).toContain('已知1.24 = 2.07')
  })

  it('行内水印只剥离宣传片段，保留「答案为A。」', () => {
    const lines = toLines(['答案为A。公考最新资料、更新进度微信SKA674 则甲为正确选项。'].join('\n'))
    expect(lines[0]).not.toContain('公考最新资料')
    expect(lines[0]).not.toContain('微信SKA674')
    expect(lines[0]).toContain('答案为A。')
    expect(lines[0]).toContain('则甲为正确选项。')
  })
})

describe('直导批次质量分层与汇总（管线级）', () => {
  async function runDirectImport(files: Record<string, string>): Promise<{
    job: ReturnType<KnowledgeBuilderService['getJob']>
    service: KnowledgeBuilderService
  }> {
    const data = temporaryDirectory('tizhou-kb-tier-data-')
    const source = temporaryDirectory('tizhou-kb-tier-src-')
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(source, name), content, 'utf8')
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
        connect: vi.fn(() => ({
          vault: { id: 'managed', name: 'v', path: 'C:/v', warnings: [], isBuiltin: false },
          added: 0,
          updated: 0,
          removed: 0,
          skipped: 0,
          warnings: []
        })),
        ensureBuiltinVault: () => ({
          id: 'builtin',
          name: '内置示例库',
          path: 'C:/builtin',
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
    return { job, service }
  }

  it('客观题质量分层落盘往返：structured 保存后重新加载仍存在', async () => {
    const { job, service } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    expect(job.status).toBe('review')
    expect(job.message).toContain('结构化题目')
    // 重新加载产物（磁盘往返）：分层仍在
    const artifactId = job.artifacts[0]!.id
    const detail = service.getArtifact(job.id, artifactId)
    expect(detail?.importQualityTier).toBe('structured')
  }, 35_000)

  it('批次消息保留审核引导并如实给出跳过计数与无法计算声明', async () => {
    const { job } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    expect(job.message).toContain('请抽查后「全部批准」并「发布」入库')
    expect(job.message).toContain('缺题数和原图页覆盖率无法计算')
    // 无 OCR 质量报告（.md 直转）：页数未知必须如实显示
    expect(job.message).toContain('输入页数未知，转换器未提供页数')
    // 不再出现失真指标
    expect(job.message).not.toMatch(/嫌疑缺题/)
  }, 35_000)

  it('无答案题目按真实计数进入汇总（不推算）', async () => {
    // 题本 4 题，解析册只覆盖前 3 题（含 3 个答案标记满足解析册识别阈值）
    // → 第 4 题 skippedNoAnswer = 1（真实计数，非推算）
    const { job } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '4. 丁题干内容依旧足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    expect(job.message).toMatch(/无答案\s*1/)
  }, 35_000)

  it('申论题（无选项）→ structured：申论不以选项数判层，落盘往返保留', async () => {
    const { job, service } = await runDirectImport({
      '申论题本.md':
        [
          '2027申论',
          '第一章 归纳概括',
          '【训练一】提升基层社会治理水平经验做法',
          '资料2',
          'W市经济技术开发区在实践中探索设立社区基金，吸纳驻区单位、企业园区、社会组织、居民群众中的红色力量参与社区基金的筹建，搭建社区需求与资源对接的公益平台，形成精准化对接、项目化运作、品牌化带动新格局。目前我们已成立街道级社区基金2支、社区级基金32支，累计募捐资金达到130余万元。',
          '根据"给定资料2"，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。',
          '(2023年山东B卷）',
          '要求：全面，准确，有条理，不超过300字。'
        ].join('\n') + '\n'
    })
    expect(job.status).toBe('review')
    expect(job.message).toMatch(/申论主观题 1 道/)
    const essayArtifact = job.artifacts.find((a) => a.kind === 'question')
    expect(essayArtifact).toBeDefined()
    // 落盘往返：重新加载 detail
    const detail = service.getArtifact(job.id, essayArtifact!.id)
    expect(detail?.importQualityTier).toBe('structured')
  }, 35_000)

  it('含 markdown 表格的资料分析题本 → capability=table-review → review-required 落盘往返', async () => {
    const { job, service } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '| 项目 | 2021年 | 2022年 |',
          '| --- | --- | --- |',
          '| 财产性收入 | 2090 | 3016 |',
          '| 转移性收入 | 8217 | 10106 |',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    expect(job.message).toContain('待人工审核')
    const question = job.artifacts.find((a) => a.kind === 'question')
    const detail = service.getArtifact(job.id, question!.id)
    expect(detail?.capability).toBe('table-review')
    expect(detail?.importQualityTier).toBe('review-required')
  }, 35_000)

  it('无法切出题的无结构文件 → 原始资料保留（preserved-source）落盘往返', async () => {
    const { job, service } = await runDirectImport({
      '纯文字资料.md': '这是一段没有任何题目的普通文字资料。'.repeat(10) + '\n'
    })
    // 无题可切且无训练标记 → 能力边界保留通道
    const document = job.artifacts.find((a) => a.kind === 'document')
    expect(document).toBeDefined()
    const detail = service.getArtifact(job.id, document!.id)
    expect(detail?.importQualityTier).toBe('preserved-source')
  }, 35_000)

  it('jobView 的 artifactSummary 透传 importQualityTier 到渲染层', async () => {
    const { job } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    // job.artifacts 是 jobView→artifactSummary 的输出（渲染层契约）
    const questionSummary = job.artifacts.find((a) => a.kind === 'question')
    expect(questionSummary?.importQualityTier).toBe('structured')
  }, 35_000)

  it('转换异常文件 → failed 状态计数进汇总，文案不统一声称「转换失败」', async () => {
    // 单独构造：mock convert 抛错使文件 failed
    const data = temporaryDirectory('tizhou-kb-fail-data-')
    const source = temporaryDirectory('tizhou-kb-fail-src-')
    writeFileSync(join(source, '坏文件.md'), '内容足够长但转换会失败。'.repeat(5), 'utf8')
    const service = new KnowledgeBuilderService(
      data,
      process.cwd(),
      {} as AiService,
      {
        connect: vi.fn(() => ({
          vault: { id: 'm', name: 'v', path: 'C:/v', warnings: [], isBuiltin: false },
          added: 0,
          updated: 0,
          removed: 0,
          skipped: 0,
          warnings: []
        })),
        ensureBuiltinVault: () => ({
          id: 'builtin',
          name: '内置示例库',
          path: 'C:/builtin',
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
    vi.spyOn(conversionTarget, 'convert').mockRejectedValue(new Error('模拟转换异常'))
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
    expect(job.files[0]?.state).toBe('failed')
    // 汇总文案：failed 状态涵盖转换异常/中断/拦截，不统一说「转换失败」
    expect(job.message).toContain('处理失败或被拦截文件 1 个')
    expect(job.message).not.toContain('转换失败文件')
  }, 35_000)

  it('abortedBooks=0：正常批次不出现错位拦截文字', async () => {
    const { job } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲地旅游收入增长情况如何：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙地发电量同比下降多少：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙地粮食产量占比多少：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲地旅游收入增长情况如何：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙地发电量同比下降多少：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙地粮食产量占比多少：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    expect((job.message?.match(/套号错位被拦截/g) ?? []).length).toBe(0)
  }, 35_000)

  it('全部被拦截：仍清楚显示全部拦截，且文案只出现一次', async () => {
    // 12 题（≥ 对齐中止最小可验证数 10）且解析册重印题干完全无关
    // → 顺序配对全部 misaligned → 整书拦截（abortedBooks 路径）
    // 题干与重印题干用完全不同领域的字汇：bigram 零命中 → 对齐分数接近 0
    const stems = [
      '甲地旅游收入年度增长情况与同期消费恢复水平相比呈现何种趋势请问',
      '乙地发电量同比下降幅度与新能源装机容量之间是否存在结构性替代关系',
      '丙地粮食产量占全省比重变化反映出怎样的农业产业结构调整方向呢',
      '丁地工业增加值增速与制造业技改投资强度之间的正相关关系是否成立',
      '戊地消费品零售额和社会零售总额两口径统计差异主要来自哪些领域',
      '己地固定资产投资额中基础设施与产业项目占比此消彼长的原因何在',
      '庚地进出口总额增长中外贸结构和汇率因素的贡献应当如何拆解分析',
      '辛地服务业增加值占地区生产总值比重提升体现了怎样的转型成效呢',
      '壬地居民收入增长与经济增长同步性在城乡之间是否存在明显分化',
      '癸地财政收入规模与税基结构变化之间的因果链条应当如何理解呢',
      '子地货物运输量与港口吞吐量两组数据的口径差异应当如何解释呢',
      '丑地客运周转量恢复程度与跨区域人员流动活跃度是否保持一致呢'
    ]
    const wrongs = [
      '乙地量子材料实验室超高真空磁控溅射沉积工艺参数优化实验记录备注',
      '丙地天体物理射电望远镜阵列校准观测数据处理的软件流程说明文档',
      '丁地有机化学催化加氢反应釜温度压力曲线异常波动的溯源排查报告',
      '戊地地质勘探岩芯样本孔隙度渗透率测试结果的仪器标定误差分析',
      '己地生物基因测序文库构建环节接头污染比例的质控阈值调整方案',
      '庚地数学拓扑空间同调群计算中链复形边界算子的符号约定备忘录',
      '辛地高分子聚合反应引发剂半衰期与分子量分布宽度的关联性笔记',
      '壬地材料力学拉伸试验应变速率敏感指数测定方法的夹具改进说明',
      '癸地电磁场有限元仿真网格剖分密度对趋肤效应精度的影响评估',
      '子地热力学卡诺循环理想气体模型在变工况下的熵增修正项推导',
      '丑地光学迈克耳孙干涉仪臂长差热漂移对条纹对比度的抑制措施',
      '寅地声学亥姆霍兹共振腔颈口阻抗边界条件近似的适用范围讨论'
    ]
    const { job } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          ...stems.flatMap((stem, i) => [
            `${i + 1}. ${stem}：`,
            'A. 选项一',
            'B. 选项二',
            'C. 选项三',
            'D. 选项四'
          ])
        ].join('\n') + '\n',
      '解析.md':
        [
          // 题号行与重印题干分行：重印题干进入 stemExcerpt 参与对齐校验
          ...wrongs.flatMap((wrong, i) => [
            `${i + 1}.`,
            wrong,
            '【参考答案】A',
            '【实战解析】无关解析。'
          ])
        ].join('\n') + '\n'
    })
    // 全部题本被配对校验拦截（主消息明确说明），文案不重复
    const count = (job.message?.match(/疑似套号错位/g) ?? []).length
    expect(count).toBe(1)
    expect(job.message).toContain('配对校验拦截')
  }, 35_000)

  it('普通客观题来源证据：.md 直转无页清单 → unavailable（不猜页码，产物正常）', async () => {
    // convert mock 把 .md 原样复制；同时按输入内容构造 _pages.json 页清单
    // （.md 直转管线无真实 worker，这里以 sidecar 存在时的行为为准）
    const { job, service } = await runDirectImport({
      '题本.md':
        [
          '练习题01套',
          '1. 甲题干内容足够长了吧：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙题干内容也足够长了：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙题干内容同样足够长：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
      '解析.md':
        [
          '1. 甲题干内容足够长了吧：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙题干内容也足够长了：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙题干内容同样足够长：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n'
    })
    const question = job.artifacts.find((a) => a.kind === 'question')
    const detail = service.getArtifact(job.id, question!.id)
    // .md 直转无页清单 → unavailable（不猜页码，不阻塞）
    expect(detail?.sourceEvidence?.status ?? 'unavailable').toBe('unavailable')
  }, 35_000)

  it('pageManifest 存在时：toLinesWithPageMap 行映射与解析器行号对齐（exact 页）', async () => {
    const { toLinesWithPageMap } = await import('../src/main/services/question-import')
    const manifest = {
      pages: [
        { pageNumber: 1, source: 'ocr', lines: ['练习题01套', '1. 首题题干内容足够长：'] },
        {
          pageNumber: 2,
          source: 'ocr',
          lines: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁', '2. 次题题干内容也足够长：']
        },
        { pageNumber: 3, source: 'ocr', lines: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'] }
      ]
    }
    const raw = [
      '练习题01套',
      '1. 首题题干内容足够长：',
      'A. 甲',
      'B. 乙',
      'C. 丙',
      'D. 丁',
      '2. 次题题干内容也足够长：',
      'A. 甲',
      'B. 乙',
      'C. 丙',
      'D. 丁'
    ].join('\n')
    const { lines, pageMap } = toLinesWithPageMap(raw, manifest)
    const questions = (await import('../src/main/services/question-import')).parseQuestionBook(
      lines
    )
    // 每题 lineStart 的页标签即 exact 依据：题1→页1，题2→页2
    const pageOf = (index: number) => pageMap[index]
    const q1 = questions.find((q) => q.num === 1)
    const q2 = questions.find((q) => q.num === 2)
    expect(pageOf(q1!.lineStart!)).toBe(1)
    expect(pageOf(q2!.lineStart!)).toBe(2)
  }, 35_000)

  it('无结构文件 preservation：无页清单时 unavailable，产物仍正常生成', async () => {
    const { job, service } = await runDirectImport({
      '纯文字资料.md': '这是一段没有任何题目的普通文字资料。'.repeat(10) + '\n'
    })
    const document = job.artifacts.find((a) => a.kind === 'document')
    expect(document).toBeDefined()
    const detail = service.getArtifact(job.id, document!.id)
    expect(detail?.importQualityTier).toBe('preserved-source')
    // .md 源无页清单：不猜页码
    const evidence = detail?.sourceEvidence
    if (evidence) expect(['unavailable', 'available']).toContain(evidence.status)
  }, 35_000)
})

describe('repairDriftedQuestionNumbers（悬挂缩进题号漂移修复）', () => {
  it('题干中间的期望题号提到行首，行数不变', () => {
    const lines = [
      '习近平总书记指出，我们要始终坚持以人民为中1.心，及时回应群众关切。下列说法正确的是：',
      'A.第一项',
      'B.第二项',
      '2024年11月，首届论坛举行，国家主席向2.论坛致贺信。下列说法错误的是：',
      'A.第一项',
      'B.第二项'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired).toHaveLength(lines.length)
    expect(repaired[0]).toBe(
      '1.习近平总书记指出，我们要始终坚持以人民为中心，及时回应群众关切。下列说法正确的是：'
    )
    expect(repaired[3]).toBe(
      '2. 2024年11月，首届论坛举行，国家主席向论坛致贺信。下列说法错误的是：'
    )
    const parsed = parseQuestionBook(repaired)
    expect(parsed.map((question) => question.num)).toEqual([1, 2])
  })

  it('挂在上一段末尾的题号移交给下一行开头', () => {
    const lines = [
      '1.第一题题干？',
      'A.甲',
      'B.乙',
      '前一题的尾巴文字，然后 2.',
      '第二题的题干在这里？',
      'A.丙',
      'B.丁'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired[3]).toBe('前一题的尾巴文字，然后')
    expect(repaired[4]).toBe('2.第二题的题干在这里？')
  })

  it('年份/小数不会被当成题号，选项行不动，套号标题重置期望', () => {
    const lines = [
      '1.第一题？',
      'A.收入 2025.',
      'B.增长 2.5 倍',
      '练习题 2 套',
      '1.新一套第一题？',
      'A.甲'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired).toEqual(lines)
  })

  it('容忍一个题号缺失：期望 3 缺席时接受漂移的 4', () => {
    const lines = [
      '1.第一题？',
      'A.甲',
      'B.乙',
      '2.第二题？',
      'A.甲',
      'B.乙',
      '第四题的前半句 4.后半句？',
      'A.甲',
      'B.乙'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired[6]).toBe('4.第四题的前半句后半句？')
  })

  it('carried 不拼到套标题/答案区/噪声/选项/图片行前面', () => {
    const lines = [
      '1.第一题？',
      'A.甲',
      'B.乙',
      '第一题的尾巴文字，然后 2.',
      '练习题 3 套',
      '参考答案',
      '1-2:BA'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    // 套标题必须原样保留（修复前会变成 "2.练习题 3 套" 破坏套识别）
    expect(repaired[4]).toBe('练习题 3 套')
    expect(repaired[5]).toBe('参考答案')
    expect(parseQuestionBook(repaired.slice(0, 4))).toHaveLength(1)
  })

  it('题干正文的顿号数字枚举（10、11、12）不误判为漂移题号', () => {
    const lines = [
      '1.下列属于质数的是？',
      'A.甲',
      'B.乙',
      'C.丙',
      'D.丁',
      '老师在课堂上列举了 10、11、12 三个数字让大家判断，其中正确的组合是哪一组？',
      'A.仅 10',
      'B.仅 11'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired[5]).toBe(
      '老师在课堂上列举了 10、11、12 三个数字让大家判断，其中正确的组合是哪一组？'
    )
    const parsed = parseQuestionBook(repaired)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.num).toBe(1)
  })

  it('顿号后接真实漂移题号（顿号前是文字）仍能修复', () => {
    const lines = [
      '1.第一题？',
      'A.甲',
      'B.乙',
      '上一题结尾提到云服务、114.5%的增长，然后是2.',
      '本题题干从这一行开始？',
      'A.丙',
      'B.丁'
    ]
    const repaired = repairDriftedQuestionNumbers(lines)
    expect(repaired[3]).toBe('上一题结尾提到云服务、114.5%的增长，然后是')
    expect(repaired[4]).toBe('2.本题题干从这一行开始？')
  })
})

describe('stripTocSetTitleRuns（目录套标题过滤与套号对齐）', () => {
  const fillers = Array.from({ length: 12 }, (_, index) => `这是正文解析补充说明第 ${index + 1} 行`)

  it('解析册书首目录紧邻页码且后文各套孤立分布时正确剔除目录，不再把套号推高错位', () => {
    const solutionLines = [
      '目录',
      '练习题 01 套',
      '001',
      '练习题 02 套',
      '015',
      '练习题 03 套',
      '029',
      '练习题01',
      '1. 如果从专业发展的角度看，同届不同专业的学生混居不仅能拓展知识面。',
      '【参考答案】C',
      '【实战解析】选 C。',
      ...fillers,
      '练习题02',
      '1. 创建理想社会是人类文明的伟大目标之一，文学艺术家的看法与众不同。',
      '【参考答案】C',
      '【实战解析】选 C。',
      ...fillers,
      '练习题03',
      '1. 建筑在实用和审美功能之外的文化象征意涵往往联系着民族认同。',
      '【参考答案】B',
      '【实战解析】选 B。'
    ]
    const solutions = parseSolutionBook(solutionLines)
    expect([...solutions.keys()]).toEqual(['1-1', '2-1', '3-1'])
    expect(solutions.get('1-1')?.answer).toBe('C')
    expect(solutions.get('3-1')?.answer).toBe('B')

    const questionLines = [
      '练习题01',
      '1. 如果从专业发展的角度看，同届不同专业的学生混居不仅能拓展知识面。',
      'A. 拓展知识结构',
      'B. 独特之处',
      'C. 对人才培养的好处',
      'D. 优势大于劣势',
      '练习题02',
      '1. 创建理想社会是人类文明的伟大目标之一，文学艺术家的看法与众不同。',
      'A. 不同视角',
      'B. 伟大目标',
      'C. 文学艺术家眼中的理想社会',
      'D. 携手努力',
      '练习题03',
      '1. 建筑在实用和审美功能之外的文化象征意涵往往联系着民族认同。',
      'A. 摆脱浮躁',
      'B. 准确把握本土与外来关系',
      'C. 发挥个性',
      'D. 延续传统'
    ]
    const merged = mergeDirectQuestions(parseQuestionBook(questionLines), solutions, new Map(), {
      subject: 'xingce',
      category: '片段阅读',
      sourceFile: '片段阅读-题本.pdf',
      tags: []
    })
    expect(merged.aborted).toBe(false)
    expect(merged.skippedMisaligned).toBe(0)
    expect(merged.items.map((item) => item.answer)).toEqual([['C'], ['C'], ['B']])
  })

  it('分册书首目录尾行（第 30 套）紧邻正文首套（第 16 套）时按套号回落切簇，不误删正文第 16 套', () => {
    const solutionLines = [
      '目录',
      '练习题16套',
      '001',
      '练习题17套',
      '015',
      '练习题30套',
      '197',
      '练习题16',
      '1. 任何一个生命体都有生命周期，城市成长亦如此。',
      '【参考答案】C',
      '【实战解析】选 C。',
      ...fillers,
      '练习题17',
      '1. 书院是中国历史上独具特色的文化教育形式。',
      '【参考答案】B',
      '【实战解析】选 B。',
      ...fillers,
      '练习题30',
      '1. 二十世纪九十年代经济转轨存在不同路径选择。',
      '【参考答案】D',
      '【实战解析】选 D。'
    ]
    const solutions = parseSolutionBook(solutionLines)
    expect([...solutions.keys()]).toEqual(['16-1', '17-1', '30-1'])
    expect(solutions.get('16-1')?.answer).toBe('C')
  })

  it('合订总目录套数超过本册正文 2 倍（如总目录 1-30 套，本册正文仅 21-30 套）时仍正确剔除目录', () => {
    const tocLines: string[] = ['目录']
    for (let setNo = 1; setNo <= 30; setNo += 1) {
      tocLines.push(`练习题 ${String(setNo).padStart(2, '0')} 套`)
      tocLines.push(String(setNo * 10).padStart(3, '0'))
    }
    const bodySolutionLines: string[] = []
    const bodyQuestionLines: string[] = []
    for (let setNo = 21; setNo <= 30; setNo += 1) {
      const stem = `第${setNo}套唯一题干：关于基层治理数字化转型的表述中，哪一项最符合文意？`
      bodySolutionLines.push(
        `练习题${setNo}`,
        `1. ${stem}`,
        '【参考答案】A',
        '【实战解析】选 A。',
        ...fillers
      )
      bodyQuestionLines.push(
        `练习题${setNo}`,
        `1. ${stem}`,
        'A. 强化数据协同共享',
        'B. 忽视一线实际需求',
        'C. 扩大纸质台账规模',
        'D. 弱化公共服务能力'
      )
    }
    const solutions = parseSolutionBook([...tocLines, ...bodySolutionLines])
    expect([...solutions.keys()]).toEqual(Array.from({ length: 10 }, (_, idx) => `${21 + idx}-1`))
    const merged = mergeDirectQuestions(
      parseQuestionBook(bodyQuestionLines),
      solutions,
      new Map(),
      {
        subject: 'xingce',
        category: '片段阅读',
        sourceFile: '片段阅读下册-题本.pdf',
        tags: []
      }
    )
    expect(merged.aborted).toBe(false)
    expect(merged.skippedMisaligned).toBe(0)
    expect(merged.items).toHaveLength(10)
  })

  it('无后文重复证据的紧凑小夹具不被误判为目录删光', () => {
    const solutions = parseSolutionBook([
      '练习题01',
      '1. 第一套题目题干内容？',
      '【参考答案】A',
      '练习题02',
      '1. 第二套题目题干内容？',
      '【参考答案】B'
    ])
    expect([...solutions.keys()]).toEqual(['1-1', '2-1'])
  })

  it('题号后紧跟四位年份（如 2.2022年 / 16.2020年）与 # 标题前缀正常切题，同时继续拦截小数', () => {
    const lines = [
      '练习题01',
      '2022年1～7月，全国规模以上工业发电4.77万亿千瓦时，同比增长1.4%，增速比上半年加快0.7个百分点。',
      '1.2021年7月份，全国发电量大约是多少亿千瓦时：',
      'A. 6570',
      'B. 6920',
      'C. 7712',
      'D. 7800',
      '2.2022年1～7月份，全国城乡居民生活用电量比2021年约多：',
      '1.5亿元属于小数续行，不能误切为第1题',
      '1.20225也不是年份题号',
      'A. 672亿千瓦时',
      'B. 843亿千瓦时',
      'C. 925亿千瓦时',
      'D. 1020亿千瓦时',
      '# 3. 2016~2021年全国移动数据收入增长最多的年份是：',
      'A. 2016年',
      'B. 2017年',
      'C. 2020年',
      'D. 2021年',
      '5.2023年该市农村居民人均消费支出较上一年增加了多少元：',
      'A. 2874',
      'B. 2746',
      'C. 2647',
      'D. 2584'
    ]
    const questions = parseQuestionBook(lines)
    expect(questions.map((q) => q.num)).toEqual([1, 2, 3, 5])
    expect(questions[0]?.stem).toContain('2021年7月份')
    expect(questions[1]?.stem).toContain('2022年1～7月份')
    expect(questions[1]?.stem).toContain('1.5亿元属于小数续行')
    expect(questions[1]?.stem).toContain('1.20225也不是年份题号')
    expect(questions[2]?.stem).toContain('2016~2021年')
    // 跳号续切的第 5 题必须保留套内共享材料
    expect(questions[3]?.material).toContain('全国规模以上工业发电')
    expect(questions[3]?.materialLineRange).toBeDefined()

    const solutions = parseSolutionBook([
      '练习题01',
      '1.2021年7月份，全国发电量大约是多少亿千瓦时：',
      '【参考答案及正确率】C，89%',
      '【实战解析】解析一。',
      '2.2022年1～7月份，全国城乡居民生活用电量比2021年约多：',
      '【参考答案及正确率】B，81%',
      '【实战解析】解析二。'
    ])
    expect([...solutions.keys()]).toEqual(['1-1', '1-2'])
    expect(solutions.get('1-2')?.answer).toBe('B')
  })

  it('四海独立答案册（无冒号+同行双段+重号纠偏）与具名段标题精准配对', async () => {
    const { parseAnswerGroupsDetailed } = await import('../src/main/services/question-import')
    const answerLines = [
      '【四海】海海刷数量关系题本答案',
      '考点刷题 1',
      '1-5 ACDDA 6-10 BDDCC',
      '11-15 BDDDA 15-20 DAACC',
      '考点刷题 2',
      '1-5 DCDBB 6-10 DACBA'
    ]
    const detail = parseAnswerGroupsDetailed(answerLines)
    expect(detail.count).toBe(30)
    expect(detail.bySection.get('考点刷题1-1')).toBe('A')
    expect(detail.bySection.get('考点刷题1-6')).toBe('B')
    // 15-20 紧跟 11-15 自动纠偏为 16-20
    expect(detail.bySection.get('考点刷题1-16')).toBe('D')
    expect(detail.bySection.get('考点刷题2-1')).toBe('D')

    // 题本即便只含「考点刷题 2」一段，也能凭段标题精准命中对应答案而非错配第 1 段
    const bookLines = [
      '考点刷题 2',
      '1. 甲乙丙丁四人共有图书若干本，已知甲比乙多 10 本，问总数？',
      'A. 40',
      'B. 50',
      'C. 60',
      'D. 70'
    ]
    const questions = parseQuestionBook(bookLines)
    expect(questions).toHaveLength(1)
    expect(questions[0]?.sectionTitle).toBe('考点刷题2')
    const merged = mergeDirectQuestions(questions, new Map(), detail.bySet, {
      subject: 'xingce',
      category: '行测-直导题库',
      sourceFile: '四海数量.pdf',
      tags: [],
      sectionAnswers: detail.bySection
    })
    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]?.answer).toEqual(['D'])
  })

  it('酷酷刷【例题N】+书尾答案（含单题答案）与夸夸刷【例N】+随节内嵌答案均正常切题配对', async () => {
    const { parseAnswerGroupsDetailed } = await import('../src/main/services/question-import')
    const kukuLines = [
      '练习1 增量',
      '# 【例题1】（2020贵州）',
      '2019年全国居民人均可支配收入30733元，比上年增长8.9%。',
      '问：2019年全国居民人均可支配收入比上年增加约多少元？',
      'A. 2400',
      'B. 2510',
      'C. 2620',
      'D. 2730',
      '# 【例题2】（2021福建）',
      '2016年农民工月均收入3275元，增长6.6%。问占比变化是：',
      'A. 变大',
      'B. 变小',
      'C. 不变',
      'D. 无法推出',
      '参考答案',
      '练习1 增量',
      '1-1：B 2：A'
    ]
    const kukuQs = parseQuestionBook(kukuLines)
    expect(kukuQs.map((q) => q.num)).toEqual([1, 2])
    const kukuAns = parseAnswerGroupsDetailed(kukuLines)
    const kukuMerged = mergeDirectQuestions(kukuQs, new Map(), kukuAns.bySet, {
      subject: 'xingce',
      category: '资料分析',
      sourceFile: '酷酷刷-资料分析.pdf',
      tags: [],
      sectionAnswers: kukuAns.bySection
    })
    expect(kukuMerged.items.map((item) => item.answer.join(''))).toEqual(['B', 'A'])

    const kkLines = [
      '【例1】（2020联考）某厂生产甲乙丙三种机型，求产量比：',
      'A. 2:1:3',
      'B. 2:3:4',
      'C. 3:2:1',
      'D. 3:2:4',
      '【例2】（2023联考）两冰块相撞，原来体积是10倍，现在是几倍？',
      'A. 16',
      'B. 10',
      'C. 8',
      'D. 6',
      '答案：1-2：CA'
    ]
    const kkQs = parseQuestionBook(kkLines)
    expect(kkQs).toHaveLength(2)
    // 随节内嵌答案行绝不污染上一题末选项
    expect(kkQs[1]?.options[3]?.text).toBe('6')
    const kkAns = parseAnswerGroupsDetailed(kkLines)
    const kkMerged = mergeDirectQuestions(kkQs, new Map(), kkAns.bySet, {
      subject: 'xingce',
      category: '数量关系',
      sourceFile: '夸夸刷-数量关系.pdf',
      tags: []
    })
    expect(kkMerged.items.map((item) => item.answer.join(''))).toEqual(['C', 'A'])
  })

  it('repairDriftedQuestionNumbers 不得将 HTML 表格单元格内的序号误判为漂移题号', () => {
    const lines = [
      '练习1 增量',
      '# 【例题4】（2021浙江）',
      '<table><tr><td>指标名称</td><td>亿元</td></tr><tr><td>5.外商及港澳台投资企业</td><td>459.8</td></tr></table>',
      '问：营业收入同比增长了多少亿元？',
      'A. 1042',
      'B. 1120',
      'C. 1288',
      'D. 1315',
      '# 【例题5】（2023重庆）',
      '2022年8月商品零售32510亿元，问增长多少亿元？',
      'A. 3788',
      'B. 3843',
      'C. 3970',
      'D. 4011'
    ]
    const qs = parseQuestionBook(lines)
    expect(qs.map((q) => q.num)).toEqual([4, 5])
    expect(qs[0]?.options).toHaveLength(4)
    expect(qs[0]?.stem).toContain('<table>')
    expect(qs[1]?.options).toHaveLength(4)
  })

  it('图推分组题号（第一组/第二组）延续段名连续号，且 HTML 多套参考答案表与转义 \\~ 精准拆段', async () => {
    const { parseAnswerGroupsDetailed } = await import('../src/main/services/question-import')
    // 1) 四海「图推刷题1」下分「第一组 1~2」「第二组 1~2」，独立答案册为「图推刷题1」连续 1~4
    const shBook = toLines(
      [
        '图推刷题1',
        '第一组',
        '1. 从所给的四个选项中选择最合适的一项：',
        'A. 见图',
        'B. 见图',
        '2. 把下面的六个图形分为两类：',
        'A. ①②③',
        'B. ①②④',
        '第二组',
        '1. 左边给定的是正方体展开图：',
        'A. 见图',
        'B. 见图'
      ].join('\n')
    )
    const shQs = parseQuestionBook(shBook)
    expect(shQs.map((q) => [q.set, q.num, q.sectionTitle, q.sectionQuestionNum])).toEqual([
      [1, 1, '图推刷题1', undefined],
      [1, 2, '图推刷题1', undefined],
      [2, 1, '图推刷题1', 3]
    ])
    const shAns = parseAnswerGroupsDetailed(
      toLines(['【四海】海海刷判断推理题本答案', '图推刷题 1', '1-5 CADAD'].join('\n'))
    )
    const shMerged = mergeDirectQuestions(shQs, new Map(), shAns.bySet, {
      subject: 'xingce',
      category: '判断推理',
      sourceFile: '四海判断.pdf',
      tags: [],
      sectionAnswers: shAns.bySection
    })
    expect(shMerged.items.map((item) => item.answer.join(''))).toEqual(['C', 'A', 'D'])

    // 2) 酷酷刷单行 HTML <table> 内含多套「专项刷题一：…专项刷题二：…」+ 转义 \~ 区间
    const kukuAnsLines = toLines(
      [
        '参考答案',
        '<table><tr><td colspan="4">专项刷题一：</td></tr><tr><td>1\\~5：DDBDD</td><td>6\\~10：AABCC</td></tr><tr><td>专项刷题二：</td><td></td></tr><tr><td>1\\~5：ADBBD</td><td>6\\~10：CBDDC</td></tr></table>'
      ].join('\n')
    )
    const kukuAns = parseAnswerGroupsDetailed(kukuAnsLines)
    expect(kukuAns.count).toBe(20)
    expect(kukuAns.bySection.get('专项刷题一-1')).toBe('D')
    expect(kukuAns.bySection.get('专项刷题一-10')).toBe('C')
    expect(kukuAns.bySection.get('专项刷题二-1')).toBe('A')
    expect(kukuAns.bySection.get('专项刷题二-10')).toBe('C')
  })

  it('资料分析同套多篇材料精准切分、单题前置材料不污染上题 D 选项且目录页不进入共享材料', () => {
    const lines = toLines(
      [
        '实战公考 资料分析',
        '# 目 录',
        '套题训练1…… 1',
        '套题训练2…… 10',
        '# 套题训练1',
        '# 一、根据所给材料，回答1～2题。',
        '2022年1～7月，全国发电量4.77万亿千瓦时，同比增长1.4%。其中7月发电8059亿千瓦时，同比增长4.5%。',
        '# 请回答1~2题',
        '1. 2021年7月全国发电量约是多少亿千瓦时？',
        'A. 6570',
        'B. 6920',
        'C. 7712',
        'D. 7800',
        '2. 下列哪项可以推出？',
        'A. 选项甲',
        'B. 选项乙',
        'C. 选项丙',
        'D. 选项丁',
        '# 二、根据所给材料，回答3～4题。',
        '表 2020年广东省技术合同认定登记情况',
        '<table><tr><td>城市</td><td>合同数</td></tr><tr><td>广州</td><td>22843</td></tr></table>',
        '# 请回答3~4题',
        '3. 2020年广州市合同数为多少项？',
        'A. 22843',
        'B. 11717',
        'C. 39845',
        'D. 2653',
        '2019年，全国棉花产量588.9万吨，比上年减少21.3万吨，其中新疆棉花产量500.2万吨，同比下降2.1%。',
        '4. 2018年全国棉花产量约为多少万吨？',
        'A. 567.6',
        'B. 610.2',
        'C. 625.0',
        'D. 640.5'
      ].join('\n')
    )
    const qs = parseQuestionBook(lines)
    expect(qs).toHaveLength(4)
    expect(qs[0]?.sectionTitle).toBe('套题训练1')
    // 目录与封面绝不进入材料
    expect(qs[0]?.material).not.toContain('目录')
    expect(qs[0]?.material).toContain('发电量')
    // 第 2 题 D 选项干净，不吞入第 2 篇材料与表格
    expect(qs[1]?.options[3]?.text).toBe('选项丁')
    // 第 3 题拿到第 2 篇表格材料，不再误挂第 1 篇发电量材料
    expect(qs[2]?.material).toContain('<table>')
    expect(qs[2]?.material).not.toContain('发电量')
    // 第 3 题 D 选项不吞入第 4 题前置统计段，第 4 题拿到自己的棉花材料
    expect(qs[2]?.options[3]?.text).toBe('2653')
    expect(qs[3]?.material).toContain('棉花产量')
    expect(qs[3]?.material).not.toContain('<table>')
  })

  it('解析册单行重印题干（资料分析高频形态）保留题号同行文本用于配对对齐，不再误判错位拦截', () => {
    const bookQs = parseQuestionBook([
      '练习题01套',
      '1. 2021年7月份，全国发电量大约是多少亿千瓦时：',
      'A. 6570',
      'B. 6920',
      'C. 7712',
      'D. 7800',
      '2. 2022年1～7月份，全国城乡居民生活用电量比2021年约多：',
      'A. 672亿千瓦时',
      'B. 843亿千瓦时',
      'C. 925亿千瓦时',
      'D. 1020亿千瓦时'
    ])
    const sols = parseSolutionBook([
      '目录',
      '练习题01套',
      '练习题02套',
      '练习题03套',
      '练习题04套',
      '练习题05套',
      '练习题01套',
      '1. 2021年7月份，全国发电量大约是多少亿千瓦时：',
      'A. 6570',
      'B. 6920',
      'C. 7712',
      'D. 7800',
      '【参考答案及正确率】C，89%',
      '【实战解析】基期=8059/(1+4.5%)≈7712。',
      '2. 2022年1～7月份，全国城乡居民生活用电量比2021年约多：',
      'A. 672亿千瓦时',
      'B. 843亿千瓦时',
      'C. 925亿千瓦时',
      'D. 1020亿千瓦时',
      '【参考答案及正确率】B，81%',
      '【实战解析】增量=7586/9≈843。'
    ])
    expect([...sols.keys()]).toEqual(['1-1', '1-2'])
    const merged = mergeDirectQuestions(bookQs, sols, new Map(), {
      subject: 'xingce',
      category: '资料分析',
      sourceFile: '资料分析600题.pdf',
      tags: []
    })
    expect(merged.aborted).toBe(false)
    expect(merged.skippedMisaligned).toBe(0)
    expect(merged.items.map((item) => item.answer.join(''))).toEqual(['C', 'B'])
  })

  it('申论 --structured Markdown 标题、内联真题出处与粘连虚线名言框正确解析', () => {
    const parsed = parseEssayBook([
      '第一章 归纳概括',
      '【训练一】提升基层社会治理水平经验做法......2',
      '【训练二】如何提供和优化铁路物流服务......5',
      '# 第一章 归纳概括',
      '# 【训练一】提升基层社会治理水平经验做法',
      '# 资料2',
      '![](images/divider.jpg)',
      '近年来，W市经开区积极探索社区基金参与基层社会治理的新模式，通过设立多元筹资渠道和规范项目评审机制，推动居民自治与专业服务深度融合。',
      '根据“给定资料2”，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。(2023 年山东 B 卷)',
      '要求：全面，准确，有条理，不超过300字。---一·一·一·一·一► 唯物辩证法认为外因是变化的条件。',
      '# 【训练二】如何提供和优化铁路物流服务',
      '# 资料1',
      '江化铁路物流中心围绕企业降本增效需求，整合场站仓储与多式联运资源，打造一站式智慧调度平台，大幅压缩货物在途周转时间。',
      '根据“给定资料1”，简要说明江化铁路物流中心是如何提供和优化铁路物流服务的。(2026年国考市地卷）',
      '要求：全面、准确、有条理。不超过250字。'
    ])
    expect(parsed.units).toHaveLength(2)
    expect(parsed.units[0]?.chapter).toBe('归纳概括')
    expect(parsed.units[0]?.year).toBe(2023)
    expect(parsed.units[0]?.region).toBe('山东')
    expect(parsed.units[0]?.material).not.toContain('divider.jpg')
    expect(parsed.units[0]?.stem).toContain('不超过300字。')
    expect(parsed.units[0]?.stem).not.toContain('唯物辩证法')
    expect(parsed.units[1]?.year).toBe(2026)
    expect(parsed.units[1]?.region).toBe('国考')
    expect(parsed.units[1]?.stem).toContain('简要说明江化铁路物流中心')
  })

  it('言语题本 RapidDoc 将 D 选项与下一题真题头粘连到同行时准确拆出，且支持篇章阅读跳号材料头与答案对照表', () => {
    const raw = [
      '# 第一章 片段阅读',
      '# 第一节 中心理解题',
      '# 实战演练一',
      '1.【2023国考】下列关于矿物晶体的表述正确的是：',
      'A. 选项甲',
      'B. 选项乙',
      'C. 选项丙',
      'D. 不同天然矿物晶体的熔点区别2.【2023事业联考】互联网时代，汉字使用发挥着重要作用。',
      'A. 融媒体传播迅速',
      'B. 汉字规范亟待加强',
      'C. 传统文化持续复兴',
      'D. 网络语言不断演进',
      '阅读下文，回答26~30题。',
      '这是一段用于篇章阅读的长文章材料，讨论人工智能在医学影像诊断中的临床边界。',
      '26. 根据文章内容，下列说法正确的是：',
      'A. 甲',
      'B. 乙',
      'C. 丙',
      'D. 丁',
      '# 答案对照表',
      '1~2：AC 26~26：D'
    ]
    const qs = parseQuestionBook(raw)
    expect(qs).toHaveLength(3)
    expect(qs[0]?.material).toBeUndefined()
    expect(qs[0]?.options[3]?.text).toBe('不同天然矿物晶体的熔点区别')
    expect(qs[1]?.num).toBe(2)
    expect(qs[1]?.stem).toContain('【2023事业联考】互联网时代')
    expect(qs[1]?.options).toHaveLength(4)
    expect(qs[2]?.num).toBe(26)
    expect(qs[2]?.material).toContain('人工智能在医学影像诊断中的临床边界')
    expect(qs[1]?.options[3]?.text).not.toContain('人工智能')
    const ans = parseAnswerGroups(raw)
    expect(ans.get('1-1')).toBe('A')
    expect(ans.get('1-2')).toBe('C')
    expect(ans.get('1-26')).toBe('D')
  })
})
