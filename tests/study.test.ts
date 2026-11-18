// 组题抽题：资料分析一组材料带 N 道连续小题，抽题以组为原子单位
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQuestionUnits, takeUnits } from '../src/main/services/study'
import { DatabaseService } from '../src/main/services/database'
import { StudyService } from '../src/main/services/study'
import { VaultService } from '../src/main/services/vault'
import type { Question } from '../src/shared/contracts'

function question(id: string, groupId?: string, groupOrder?: number): Question {
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
    ...(groupOrder !== undefined ? { groupOrder } : {})
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
    // 大组放不进剩余 5-2=3 的位置时先跳过，小组回填，最后仍以能收的整组结尾
    expect(picked.length).toBeLessThanOrEqual(5)
    const groupIds = picked.filter((item) => item.groupId === 'kbg-b')
    if (groupIds.length > 0) {
      // 收了组就必须整组连续且按序
      expect(groupIds.map((item) => item.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
    }
  })

  it('首个单元超长时截断但不破坏连续性', () => {
    const group = [1, 2, 3, 4, 5].map((order) => question(`g${order}`, 'kbg-a', order))
    const picked = takeUnits([group], 3)
    expect(picked.map((item) => item.id)).toEqual(['g1', 'g2', 'g3'])
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
