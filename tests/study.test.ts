// 组题抽题：资料分析一组材料带 N 道连续小题，抽题以组为原子单位
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildQuestionUnits,
  normalizeDataAnalysisUnits,
  StudyService,
  takeUnits
} from '../src/main/services/study'
import { DatabaseService } from '../src/main/services/database'
import { VaultService } from '../src/main/services/vault'
import type { Question } from '../src/shared/contracts'

function question(
  id: string,
  groupId?: string,
  groupOrder?: number,
  extra: Partial<Question> = {}
): Question {
  return {
    id,
    subject: 'xingce',
    category: '资料分析',
    type: 'single',
    stem: `第${id}题题干占位文本，长度超过八个字符`,
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' }
    ],
    answer: ['A'],
    explanation: '解析',
    difficulty: 2,
    source: '测试',
    tags: [],
    contentHash: id,
    ...(groupId ? { groupId } : {}),
    ...(groupOrder !== undefined ? { groupOrder } : {}),
    ...extra
  }
}

describe('buildQuestionUnits', () => {
  it('同组小题聚成一个单元并按组内序号排序，散题各自成单元', () => {
    const pool = [
      question('s1'),
      question('g3', 'kbg-a', 3),
      question('g1', 'kbg-a', 1),
      question('s2'),
      question('g2', 'kbg-a', 2)
    ]
    const units = buildQuestionUnits(pool)
    expect(units).toHaveLength(3)
    const group = units.find((unit) => unit.length === 3)
    expect(group?.map((item) => item.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('不同组的成员互不合并', () => {
    const pool = [
      question('a1', 'kbg-a', 1),
      question('b1', 'kbg-b', 1),
      question('a2', 'kbg-a', 2)
    ]
    const units = buildQuestionUnits(pool)
    expect(units).toHaveLength(2)
    expect(units.map((unit) => unit.length).sort((x, y) => y - x)).toEqual([2, 1])
  })

  it('跨模块或不同材料发生 groupId 碰撞时严格拆分为独立组', () => {
    const da = [3, 1, 5, 2, 4].map((order) =>
      question(`da-${order}`, 'xz-mat-collide', order, {
        category: '资料分析',
        material: '资料分析专属图表材料'
      })
    )
    const lang = [2, 5, 1, 4, 3].map((order) =>
      question(`yy-${order}`, 'xz-mat-collide', order, {
        category: '言语理解与表达',
        material: '悬泉置遗址篇章阅读材料'
      })
    )
    const daOther = [1, 2, 3, 4, 5].map((order) =>
      question(`da2-${order}`, 'xz-mat-collide', order, {
        category: '资料分析',
        material: '另一份资料分析材料'
      })
    )
    const interleaved = [
      da[0]!,
      lang[0]!,
      da[1]!,
      lang[1]!,
      da[2]!,
      lang[2]!,
      da[3]!,
      lang[3]!,
      da[4]!,
      lang[4]!,
      ...daOther
    ]
    const units = buildQuestionUnits(interleaved)
    expect(units).toHaveLength(3)
    expect(units.map((u) => u.map((q) => q.id))).toEqual([
      ['da-1', 'da-2', 'da-3', 'da-4', 'da-5'],
      ['yy-1', 'yy-2', 'yy-3', 'yy-4', 'yy-5'],
      ['da2-1', 'da2-2', 'da2-3', 'da2-4', 'da2-5']
    ])
  })

  it('无 groupId 的纯图片短材料按 papers 卷内序号连续归组为 1→5', () => {
    const pool = [4, 2, 5, 1, 3].map((idx) =>
      question(`oej-${idx}`, undefined, undefined, {
        material: '![](assets/chart-1.png)',
        paper: '2026国考',
        papers: [{ paper: '2026国考', order: 90 + idx }]
      })
    )
    const units = buildQuestionUnits(pool)
    expect(units).toHaveLength(1)
    expect(units[0]!.map((item) => item.id)).toEqual(['oej-1', 'oej-2', 'oej-3', 'oej-4', 'oej-5'])
  })
})

describe('normalizeDataAnalysisUnits', () => {
  it('超长资料分析组截锁前 5 题；存在完整 5 题套时清除全部残题，无完整套时仅豁免 builtin-* 示例题', () => {
    const over6 = [1, 2, 3, 4, 5, 6].map((o) => question(`over-${o}`, 'g-over', o))
    const frag2 = [1, 2].map((o) => question(`frag-${o}`, 'g-frag', o))
    const nonDa = [question('yy-1', undefined, undefined, { category: '言语理解与表达' })]
    const builtinDa = [question('builtin-data-001')]

    const strictWithFullSet = normalizeDataAnalysisUnits([over6, frag2, nonDa, builtinDa], true)
    expect(strictWithFullSet).toHaveLength(2)
    expect(strictWithFullSet[0]!.map((q) => q.id)).toEqual([
      'over-1',
      'over-2',
      'over-3',
      'over-4',
      'over-5'
    ])
    expect(strictWithFullSet[1]!.map((q) => q.id)).toEqual(['yy-1'])

    const strictBuiltinFallback = normalizeDataAnalysisUnits([frag2, nonDa, builtinDa], true)
    expect(strictBuiltinFallback).toHaveLength(2)
    expect(strictBuiltinFallback[0]!.map((q) => q.id)).toEqual(['yy-1'])
    expect(strictBuiltinFallback[1]!.map((q) => q.id)).toEqual(['builtin-data-001'])

    const nonStrict = normalizeDataAnalysisUnits([over6, frag2, nonDa], false)
    expect(nonStrict).toHaveLength(3)
    expect(nonStrict[0]!).toHaveLength(5)
    expect(nonStrict[1]!).toHaveLength(2)

    const pureFragOnly = normalizeDataAnalysisUnits([frag2], true)
    expect(pureFragOnly).toHaveLength(1)
    expect(pureFragOnly[0]!).toHaveLength(2)
  })
})

describe('takeUnits', () => {
  it('整组连续收取，组内顺序保持', () => {
    const group = [1, 2, 3, 4, 5].map((order) => question(`g${order}`, 'kbg-a', order))
    const singles = [question('s1'), question('s2'), question('s3')]
    const picked = takeUnits([group, singles], 12)
    expect(picked.map((item) => item.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 's1', 's2', 's3'])
  })

  it('放不下的大组先跳过，由能放下的小组回填空位', () => {
    const big = [1, 2, 3, 4, 5].map((order) => question(`b${order}`, 'kbg-b', order))
    const small = [question('s1'), question('s2')]
    const picked = takeUnits([big, small], 5)
    expect(picked.length).toBeLessThanOrEqual(5)
    const groupIds = picked.filter((item) => item.groupId === 'kbg-b')
    if (groupIds.length > 0) {
      expect(groupIds.map((item) => item.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
    }
  })

  it('锁定 5 题资料分析组在 count 不足 5 时也绝不截断为残缺题数', () => {
    const daGroup = [1, 2, 3, 4, 5].map((order) => question(`g${order}`, 'kbg-a', order))
    expect(takeUnits([daGroup], 3).map((item) => item.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])

    // 混合池存在可放下的非资料分析小题时，整组跳过 5 题资料分析而不破坏其完整性
    const nonDaSingles = [1, 2, 3].map((n) => [
      question(`n${n}`, undefined, undefined, { category: '言语理解' })
    ])
    expect(takeUnits([daGroup, ...nonDaSingles], 3).map((item) => item.id)).toEqual([
      'n1',
      'n2',
      'n3'
    ])

    // 非资料分析多题单元仍支持按 count 截断
    const langGroup = [1, 2, 3, 4, 5].map((order) =>
      question(`l${order}`, 'yy-a', order, { category: '言语理解' })
    )
    expect(takeUnits([langGroup], 3).map((item) => item.id)).toEqual(['l1', 'l2', 'l3'])
  })
})

describe('StudyService.selectPractice（抽题池与筛选）', () => {
  let directory: string
  let database: DatabaseService
  let study: StudyService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-study-select-'))
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    new VaultService(database).ensureBuiltinVault()
    study = new StudyService(database, {} as never)
    // 补充带唯一关键词的种子题（内置 8 题之外，验证筛选走 listQuestionsForPool 的完整链路）
    const vaultId = database.getActiveVault()!.id
    const insert = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'xingce', '判断推理', 'single', ?, ?, '["A"]', '解析',
        3, '本地资料/筛选', '[]', ?, '2024-01-01')`
    )
    for (let index = 1; index <= 3; index += 1) {
      insert.run(
        `filter-q-${index}`,
        vaultId,
        `第${index}题：斑马条纹筛选独一无二占位词${index}的研究题干`,
        JSON.stringify([
          { key: 'A', text: '甲' },
          { key: 'B', text: '乙' }
        ]),
        `hash-filter-${index}`
      )
    }
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('onlyWrong 只从未掌握错题中抽题', () => {
    // filter-q-1 答错（答案 A，提交 B）
    database.submitAttempt({
      questionId: 'filter-q-1',
      answer: ['B'],
      durationSeconds: 5,
      mode: 'practice'
    })
    const picked = study.selectPractice({
      mode: 'random',
      count: 50,
      feedbackMode: 'immediate',
      filter: { onlyWrong: true }
    })
    expect(picked.map((item) => item.id)).toEqual(['filter-q-1'])
  })

  it('onlyFavorite 只从收藏题中抽题', () => {
    database.setFavorite('filter-q-2', true)
    const picked = study.selectPractice({
      mode: 'random',
      count: 50,
      feedbackMode: 'immediate',
      filter: { onlyFavorite: true }
    })
    expect(picked.map((item) => item.id)).toEqual(['filter-q-2'])
  })

  it('关键词 query 命中题干（listQuestionsForPool 的 LIKE 过滤链路）', () => {
    const picked = study.selectPractice({
      mode: 'sequence',
      count: 10,
      feedbackMode: 'immediate',
      filter: { query: '独一无二占位词2' }
    })
    expect(picked.map((item) => item.id)).toEqual(['filter-q-2'])
  })

  it('全库顺序训练不受列表查询默认条数影响（池走专用查询）', () => {
    const picked = study.selectPractice({
      mode: 'sequence',
      count: 50,
      feedbackMode: 'immediate',
      filter: {}
    })
    // 内置 8 题 + 3 道筛选种子全部进入池（列表查询默认 500 不截断本规模）
    expect(picked.length).toBeGreaterThanOrEqual(11)
    expect(picked.map((item) => item.id)).toContain('filter-q-3')
  })

  it('资料分析抽题严格锁定 5 题连续：防碰撞、去残组、截超组且随机与自适应不打乱题序', () => {
    const vaultId = database.getActiveVault()!.id
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    const insertRich = db.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, paper, group_id, group_order, material, papers_json,
        tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'xingce', ?, 'single', ?, ?, '["A"]', '解析',
        3, '真题测试', '2026国考', ?, ?, ?, ?, '["资料套题"]', ?, '2026-01-01')`
    )
    const opts = JSON.stringify([
      { key: 'A', text: '1' },
      { key: 'B', text: '2' }
    ])
    const seedRow = (
      id: string,
      category: string,
      groupId: string | null,
      groupOrder: number | null,
      material: string | null,
      paperOrder?: number
    ): void => {
      insertRich.run(
        id,
        vaultId,
        category,
        `测试题干 ${id}`,
        opts,
        groupId,
        groupOrder,
        material,
        paperOrder ? JSON.stringify([{ paper: '2026国考', order: paperOrder }]) : null,
        `hash-${id}`
      )
    }

    // 1) 与言语理解碰撞同一 group_id 的 5 题资料分析
    for (let i = 1; i <= 5; i += 1) {
      seedRow(`col-da-${i}`, '资料分析', 'xz-mat-collide', i, '材料A：基本医保统筹基金')
      seedRow(`col-yy-${i}`, '言语理解与表达', 'xz-mat-collide', i, '材料B：悬泉置遗址篇章阅读')
    }
    // 2) 超长 6 题脏组（第 6 题必须被裁剪）
    for (let i = 1; i <= 6; i += 1) {
      seedRow(`over-da-${i}`, '资料分析', 'da-over6', i, '材料C：超长脏组材料')
    }
    // 3) 无 group_id / 无 group_order 的纯图片短材料（仅靠 papers_json 保序）
    for (let i = 1; i <= 5; i += 1) {
      seedRow(`img-da-${i}`, '资料分析', null, null, '![](assets/chart-short.png)', 90 + i)
    }
    // 4) 残缺 2 题组与无材料散题（正常出题必须过滤，错题模式仍可取出）
    seedRow('frag-da-1', '资料分析', 'da-frag2', 1, '材料D：残缺2题')
    seedRow('frag-da-2', '资料分析', 'da-frag2', 2, '材料D：残缺2题')
    seedRow('single-da-1', '资料分析', null, null, null)

    const assertValidDaBlocks = (picked: Question[], expectedCount: number): void => {
      expect(picked).toHaveLength(expectedCount)
      expect(picked.every((item) => item.category === '资料分析')).toBe(true)
      for (const item of picked) {
        expect(item.id).not.toBe('over-da-6')
        expect(item.id).not.toMatch(/^frag-da-/)
        expect(item.id).not.toBe('single-da-1')
        expect(item.id).not.toMatch(/^col-yy-/)
      }
      for (let start = 0; start < picked.length; start += 5) {
        const block = picked.slice(start, start + 5)
        expect(block).toHaveLength(5)
        const mats = new Set(block.map((item) => item.material))
        expect(mats.size).toBe(1)
        const prefix = block[0]!.id.replace(/-\d+$/, '')
        expect(block.map((item) => item.id)).toEqual(
          [1, 2, 3, 4, 5].map((idx) => `${prefix}-${idx}`)
        )
      }
    }

    // 顺序训练：3 套共 15 题；若请求 7 题则锁定只返回 1 套完整 5 题，绝不凑残题
    assertValidDaBlocks(
      study.selectPractice({
        mode: 'sequence',
        count: 15,
        feedbackMode: 'immediate',
        filter: { category: '资料分析' }
      }),
      15
    )
    assertValidDaBlocks(
      study.selectPractice({
        mode: 'sequence',
        count: 7,
        feedbackMode: 'immediate',
        filter: { category: '资料分析' }
      }),
      5
    )

    // 制造一条资料分析错题记录以触发自适应加权分支，验证随机和自适应多次抽题均 5 题连续不乱序
    database.submitAttempt({
      questionId: 'frag-da-1',
      answer: ['B'],
      durationSeconds: 10,
      mode: 'practice'
    })
    for (const mode of ['random', 'adaptive'] as const) {
      for (let round = 0; round < 15; round += 1) {
        assertValidDaBlocks(
          study.selectPractice({
            mode,
            count: 15,
            feedbackMode: 'immediate',
            filter: { category: '资料分析' }
          }),
          15
        )
      }
    }

    // 全库混合训练：池内存在完整 5 题资料分析套题时，全部不足 5 题的资料分析残题（含内置单题）均被严格剔除
    const mixed = study.selectPractice({
      mode: 'sequence',
      count: 60,
      feedbackMode: 'immediate',
      filter: {}
    })
    expect(mixed.map((q) => q.id)).not.toContain('frag-da-1')
    expect(mixed.map((q) => q.id)).not.toContain('single-da-1')
    expect(mixed.map((q) => q.id)).not.toContain('builtin-data-001')
    assertValidDaBlocks(
      mixed.filter((q) => q.category === '资料分析'),
      15
    )

    // 错题专项模式下仍允许精准取出单道错题（不因未满 5 题而无法复习错题）
    const wrongPicked = study.selectPractice({
      mode: 'random',
      count: 10,
      feedbackMode: 'immediate',
      filter: { category: '资料分析', onlyWrong: true }
    })
    expect(wrongPicked.map((item) => item.id)).toEqual(['frag-da-1'])
  })
})

describe('StudyService.getDiagnosis（强弱项门槛与严格互斥）', () => {
  let directory: string
  let database: DatabaseService
  let study: StudyService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-study-diagnosis-'))
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    new VaultService(database).ensureBuiltinVault()
    study = new StudyService(database, {} as never)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  /** 种入指定模块的种子题并批量作答（前 correctCount 题答对，其余答错） */
  function seedAndAnswer(category: string, count: number, correctCount: number, tag: string): void {
    const vaultId = database.getActiveVault()!.id
    const insert = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'xingce', ?, 'single', ?, ?, '["A"]', '解析',
        2, '本地资料/诊断', '[]', ?, '2024-01-01')`
    )
    for (let index = 1; index <= count; index += 1) {
      const id = `${tag}-q-${index}`
      insert.run(
        id,
        vaultId,
        category,
        `第${index}题：${category}独有占位词${tag}${index}的题干`,
        JSON.stringify([
          { key: 'A', text: '甲' },
          { key: 'B', text: '乙' }
        ]),
        `hash-${id}`
      )
    }
    for (let index = 1; index <= count; index += 1) {
      database.submitAttempt({
        questionId: `${tag}-q-${index}`,
        answer: index <= correctCount ? ['A'] : ['B'],
        durationSeconds: 20,
        mode: 'practice'
      })
    }
  }

  it('单模块 7 题 57.1%：不进相对优势只进优先补强，建议使用直角引号', () => {
    seedAndAnswer('资料分析', 7, 4, 'da')
    const diagnosis = study.getDiagnosis()
    expect(diagnosis.strengths).toEqual([])
    expect(diagnosis.weaknesses.map((item) => item.category)).toEqual(['资料分析'])
    expect(diagnosis.weaknesses[0]?.accuracy).toBe(57.1)
    const joined = diagnosis.recommendations.join('')
    for (const quote of ['“', '”']) expect(joined).not.toContain(quote)
    expect(joined).toContain('「资料分析」')
  })

  it('优势与补强两栏严格互斥，补强按正确率升序，低样本高正确率两栏都不进', () => {
    seedAndAnswer('资料分析', 4, 4, 'zl') // 100% × 4 题 → 优势（题量降序在前）
    seedAndAnswer('常识判断', 3, 3, 'cs') // 100% × 3 题 → 优势
    seedAndAnswer('言语理解', 6, 2, 'yy') // 33.3% → 补强
    seedAndAnswer('判断推理', 6, 4, 'pd') // 66.7% → 补强
    seedAndAnswer('数量关系', 2, 2, 'sl') // 100% 但仅 2 题 → 两栏都不进
    const diagnosis = study.getDiagnosis()
    const strengthNames = diagnosis.strengths.map((item) => item.category)
    const weakNames = diagnosis.weaknesses.map((item) => item.category)
    expect(strengthNames).toEqual(['资料分析', '常识判断'])
    expect(weakNames).toEqual(['言语理解', '判断推理'])
    for (const name of strengthNames) expect(weakNames).not.toContain(name)
    expect(strengthNames).not.toContain('数量关系')
    expect(weakNames).not.toContain('数量关系')
  })

  it('边界：恰好满 3 题 70% 进入优势；正确率 80% 及以上不进补强', () => {
    seedAndAnswer('资料分析', 10, 7, 'da2') // 70.0% × 10 题 → 优势下边界
    seedAndAnswer('判断推理', 5, 4, 'pd2') // 80.0% × 5 题 → ≥3 题且 ≥70% → 优势，不进补强
    const diagnosis = study.getDiagnosis()
    // 优势按正确率降序：80% 的判断推理排在 70% 的资料分析前面
    expect(diagnosis.strengths.map((item) => item.category)).toEqual(['判断推理', '资料分析'])
    expect(diagnosis.weaknesses).toEqual([])
  })

  it('正确率 80% 但样本不足 3 题：不进优势也不进补强（避免假优势与假弱项）', () => {
    seedAndAnswer('言语理解', 2, 2, 'yy3') // 100% × 2 题 → 两栏都不进
    seedAndAnswer('资料分析', 6, 3, 'da3') // 50% × 6 题 → 补强
    const diagnosis = study.getDiagnosis()
    expect(diagnosis.strengths).toEqual([])
    expect(diagnosis.weaknesses.map((item) => item.category)).toEqual(['资料分析'])
  })
})
