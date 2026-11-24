import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import { StudyService } from '../src/main/services/study'
import { VaultService } from '../src/main/services/vault'
import type { LearningPlan } from '../src/shared/contracts'
import { computeReviewSchedule } from '../src/shared/study-constants'

describe('Exam, Review, Snippets & Plan Sync Features', () => {
  let directory: string
  let database: DatabaseService
  let study: StudyService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-features-'))
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

  it('computes stepped 1/3/7/15/30 intervals and raises mastery threshold for stubborn errors', () => {
    // 普通错题（wrongCount = 1）：连对 2 次即掌握
    const s1 = computeReviewSchedule({
      previousStreak: 0,
      previousStage: 0,
      wrongCount: 1,
      feedback: 'normal'
    })
    expect(s1).toEqual({ streak: 1, stage: 1, mastered: false, delayDays: 3 })

    const s2 = computeReviewSchedule({
      previousStreak: 1,
      previousStage: 1,
      wrongCount: 1,
      feedback: 'normal'
    })
    expect(s2).toEqual({ streak: 2, stage: 2, mastered: true, delayDays: undefined })

    // 顽固错题（wrongCount >= 2）：连对 2 次仍未掌握（停留在第 2 阶 7 天），连对第 3 次方掌握
    const stubborn2 = computeReviewSchedule({
      previousStreak: 1,
      previousStage: 1,
      wrongCount: 2,
      feedback: 'normal'
    })
    expect(stubborn2).toEqual({ streak: 2, stage: 2, mastered: false, delayDays: 7 })

    const stubborn3 = computeReviewSchedule({
      previousStreak: 2,
      previousStage: 2,
      wrongCount: 2,
      feedback: 'normal'
    })
    expect(stubborn3).toEqual({ streak: 3, stage: 3, mastered: true, delayDays: undefined })

    // easy 跃迁 2 阶、forgot 重置阶段与连对、hard 留在短期 1~3 天
    const easyJump = computeReviewSchedule({
      previousStreak: 0,
      previousStage: 0,
      wrongCount: 3,
      feedback: 'easy'
    })
    expect(easyJump).toEqual({ streak: 1, stage: 2, mastered: false, delayDays: 7 })

    const forgotReset = computeReviewSchedule({
      previousStreak: 2,
      previousStage: 3,
      wrongCount: 2,
      feedback: 'forgot'
    })
    expect(forgotReset).toEqual({ streak: 0, stage: 0, mastered: false, delayDays: 1 })

    const hardShort = computeReviewSchedule({
      previousStreak: 1,
      previousStage: 2,
      wrongCount: 2,
      feedback: 'hard'
    })
    expect(hardShort).toEqual({ streak: 1, stage: 1, mastered: false, delayDays: 3 })
  })

  it('re-rates post-explanation memory idempotently from reviewBaseline without double counting', () => {
    database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['A'],
      durationSeconds: 10,
      mode: 'practice'
    })

    const reviewed = database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['C'],
      durationSeconds: 8,
      mode: 'review'
    })
    expect(reviewed.correct).toBe(true)
    expect(reviewed.intervalDays).toBe(3)
    expect(reviewed.reviewBaseline).toEqual({ streak: 0, stage: 0, wrongCount: 1 })

    const baseStreak = reviewed.reviewBaseline!.streak
    const baseStage = reviewed.reviewBaseline!.stage

    const hardRated = database.rateReviewAttempt({
      questionId: 'builtin-language-001',
      feedback: 'hard',
      baselineStreak: baseStreak,
      baselineStage: baseStage
    })
    expect(hardRated.mastered).toBe(false)
    expect(hardRated.reviewStage).toBe(0)
    expect(hardRated.intervalDays).toBe(1)

    const easyRated = database.rateReviewAttempt({
      questionId: 'builtin-language-001',
      feedback: 'easy',
      baselineStreak: baseStreak,
      baselineStage: baseStage
    })
    expect(easyRated.mastered).toBe(false)
    expect(easyRated.reviewStage).toBe(2)
    expect(easyRated.intervalDays).toBe(7)

    const forgotRated = database.rateReviewAttempt({
      questionId: 'builtin-language-001',
      feedback: 'forgot',
      baselineStreak: baseStreak,
      baselineStage: baseStage
    })
    expect(forgotRated.mastered).toBe(false)
    expect(forgotRated.reviewStage).toBe(0)
    expect(forgotRated.intervalDays).toBe(1)
  })

  it('enqueues uncertain-correct questions into spaced review queue idempotently and filters stubborn errors', () => {
    // 1. 将未答错的题以「蒙对」入队并验证幂等跳过
    const first = database.enqueueReviewQuestions(['builtin-logic-001'], '蒙对')
    expect(first).toEqual({ added: 1, skipped: 0 })

    const second = database.enqueueReviewQuestions(['builtin-logic-001'], '蒙对')
    expect(second).toEqual({ added: 0, skipped: 1 })

    const wrongList = database.listQuestionLibrary({ tab: 'wrong' })
    expect(wrongList.some((item) => item.question.id === 'builtin-logic-001')).toBe(true)

    // 2. builtin-language-001 答错 1 次、builtin-quantity-001 答错 2 次 -> minWrongCount: 2 仅命中顽固错题
    database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['A'],
      durationSeconds: 10,
      mode: 'practice'
    })
    database.submitAttempt({
      questionId: 'builtin-quantity-001',
      answer: ['A'],
      durationSeconds: 10,
      mode: 'practice'
    })
    database.submitAttempt({
      questionId: 'builtin-quantity-001',
      answer: ['C'],
      durationSeconds: 10,
      mode: 'practice'
    })

    const stubbornItems = database.listQuestionLibrary({ tab: 'wrong', minWrongCount: 2 })
    expect(stubbornItems.map((item) => item.question.id)).toEqual(['builtin-quantity-001'])
    expect(stubbornItems[0]?.wrongCount).toBe(2)
  })

  it('selectExamByQuotas matches category aliases and keeps Data Analysis locked to 5 consecutive questions', () => {
    const vaultId = database.getActiveVault()!.id
    const rawDb = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    const insert = rawDb.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, paper, group_id, group_order, material, papers_json, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'xingce', ?, 'single', ?, ?, '["A"]', '解析', 2, '配比测试', '2026配比测试卷', ?, ?, ?, null, '[]', ?, '2026-01-01')`
    )
    const opts = JSON.stringify([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' }
    ])
    for (let i = 1; i <= 3; i += 1) {
      insert.run(
        `alias-yy-${i}`,
        vaultId,
        '言语理解',
        `言语别名测试题 ${i}`,
        opts,
        null,
        null,
        null,
        `hyy-${i}`
      )
    }
    for (const [groupIdx, gid] of ['da-grp-a', 'da-grp-b'].entries()) {
      for (let order = 1; order <= 5; order += 1) {
        insert.run(
          `${gid}-${order}`,
          vaultId,
          '资料分析',
          `资料 ${gid} 第${order}问`,
          opts,
          gid,
          order,
          `资料分析测试材料 ${groupIdx + 1}`,
          `hda-${gid}-${order}`
        )
      }
    }

    const selected = study.selectExamByQuotas([
      { category: '言语理解与表达', count: 2 },
      { category: '资料分析', count: 5 }
    ])

    const yyPicked = selected.filter(
      (q) => q.category === '言语理解' || q.category === '言语理解与表达'
    )
    const daPicked = selected.filter((q) => q.category === '资料分析')
    expect(yyPicked).toHaveLength(2)
    expect(daPicked).toHaveLength(5)
    expect(new Set(daPicked.map((q) => q.groupId)).size).toBe(1)
    expect(daPicked.map((q) => q.groupOrder)).toEqual([1, 2, 3, 4, 5])
  })

  it('supports Shenlun full-paper mock exams without polluting wrong_questions and aggregates paper progress matrix', () => {
    const vaultId = database.getActiveVault()!.id
    const rawDb = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    const paperName = '2026国考申论测试卷'
    const insertShenlun = rawDb.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, year, region, paper, group_id, group_order, material, papers_json, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'shenlun', '归纳概括', 'essay', ?, '[]', '["要点一","要点二"]', '参考解析',
        3, '申论测试', 2026, '国家', ?, ?, ?, '给定资料1：推动基层治理现代化。', ?, '["申论"]', ?, '2026-01-01')`
    )
    const ids = ['sl-test-1', 'sl-test-2', 'sl-test-3']
    ids.forEach((id, idx) => {
      insertShenlun.run(
        id,
        vaultId,
        `申论第 ${idx + 1} 题作答要求`,
        paperName,
        'sl-group-2026',
        idx + 1,
        JSON.stringify([{ paper: paperName, order: idx + 1 }]),
        `hsl-${id}`
      )
    })

    const papers = database.listShenlunPapers()
    const targetPaper = papers.find((p) => p.paper === paperName)
    expect(targetPaper?.count).toBe(3)

    const paperQuestions = database.listShenlunQuestionsByPaper(paperName)
    expect(paperQuestions.map((q) => q.id)).toEqual(ids)

    const exam = database.createExam(
      {
        title: paperName,
        subject: 'shenlun',
        durationMinutes: 150,
        questionCount: 3,
        paper: paperName
      },
      paperQuestions
    )
    database.saveExamAnswer(exam.id, {
      questionId: ids[0]!,
      answer: ['第一题作答要点汇总内容，确保逻辑清晰且条理分明。'],
      durationSeconds: 320
    })

    const finished = database.finishExam(exam.id, [ids[0]!])
    expect(finished.status).toBe('finished')
    expect(finished.score).toBeUndefined()
    expect(finished.uncertainIds).toEqual([ids[0]!])
    expect(database.getDraft(`draft-${ids[0]!}`)?.content).toBe(
      '第一题作答要点汇总内容，确保逻辑清晰且条理分明。'
    )

    // 申论整卷交卷后绝不污染客观错题本
    const wrongIds = database.listQuestionLibrary({ tab: 'wrong' }).map((item) => item.question.id)
    for (const slId of ids) {
      expect(wrongIds).not.toContain(slId)
    }

    // 进度矩阵汇总验证
    const shenlunMatrix = database.listPaperProgressMatrix('shenlun')
    expect(shenlunMatrix.every((item) => item.subject === 'shenlun')).toBe(true)
    const matrixItem = shenlunMatrix.find((item) => item.paper === paperName)
    expect(matrixItem).toBeDefined()
    expect(matrixItem?.questionCount).toBe(3)
    expect(matrixItem?.examCount).toBe(1)
    expect(matrixItem?.practicedQuestionCount).toBeGreaterThanOrEqual(1)
  })

  it('persists study snippets CRUD and Shenlun point self-check records', () => {
    const norm = database.saveStudySnippet({
      kind: 'norm',
      title: '政策落不了地',
      content: '政策执行“最后一公里”存在梗阻，缺乏有效闭环督导机制',
      tags: ['执行落地']
    })
    const quote = database.saveStudySnippet({
      kind: 'quote',
      title: '基层治理金句',
      content: '治国有常，利民为本；政之所兴，在顺民心。',
      sourceDocId: 'builtin-doc-shenlun',
      tags: ['民生']
    })

    expect(database.listStudySnippets({ kind: 'quote' }).map((s) => s.id)).toContain(quote.id)
    expect(database.listStudySnippets({ query: '最后一公里' }).map((s) => s.id)).toEqual([norm.id])

    const allBefore = database.listStudySnippets()
    expect(database.deleteStudySnippet(norm.id)).toBe(true)
    expect(database.listStudySnippets()).toHaveLength(allBefore.length - 1)

    const savedCheck = database.saveSelfCheckConstructed({
      promptId: 'builtin-essay-001',
      title: '数字赋能基层治理',
      content: '构建一体化数字治理平台，提升协同响应效能。',
      hitPoints: ['建设统一数据共享平台', '完善线上线下联动机制'],
      totalPoints: 4,
      score: 50
    })
    expect(savedCheck.evaluation.score).toBe(50)
    const history = database.listConstructedAttempts({ promptId: 'builtin-essay-001' })
    expect(history[0]?.id).toBe(savedCheck.id)
    expect(history[0]?.evaluation.score).toBe(50)
  })

  it('automatically syncs active learning plan progress across practice, review, AI variant, and reading', () => {
    const plan: LearningPlan = {
      id: 'plan-sync-test',
      title: '当日全链路联动测试计划',
      createdAt: new Date().toISOString(),
      startDate: new Date().toISOString(),
      durationDays: 1,
      dailyMinutes: 60,
      status: 'active',
      focus: ['言语理解与表达'],
      items: [
        {
          id: 'item-practice',
          day: 1,
          type: 'official_practice',
          title: '专项训练：言语理解与表达',
          category: '言语理解与表达',
          target: 1,
          completed: 0,
          done: false
        },
        {
          id: 'item-review',
          day: 1,
          type: 'official_review',
          title: '到期错题复习',
          target: 1,
          completed: 0,
          done: false
        },
        {
          id: 'item-ai',
          day: 1,
          type: 'ai_variant',
          title: '变式训练：言语理解与表达',
          category: '言语理解与表达',
          target: 1,
          completed: 0,
          done: false
        },
        {
          id: 'item-read',
          day: 1,
          type: 'read_knowledge',
          title: '阅读：言语理解与表达核心方法',
          category: '言语理解与表达',
          target: 10,
          completed: 0,
          done: false
        }
      ]
    }
    database.savePlan(plan)

    // 1) 日常专项作答触发 official_practice（同时验证 言语理解 -> 言语理解与表达 归一化匹配）
    database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['C'],
      durationSeconds: 12,
      mode: 'practice'
    })
    let current = database.getActivePlan()!
    expect(current.items.find((i) => i.id === 'item-practice')?.done).toBe(true)

    // 2) 到期错题复习作答触发 official_review
    database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['C'],
      durationSeconds: 8,
      mode: 'review'
    })
    current = database.getActivePlan()!
    expect(current.items.find((i) => i.id === 'item-review')?.done).toBe(true)

    // 3) AI 变式训练提交触发 ai_variant
    database.saveAiTrainingRecord({
      sourceQuestionId: 'builtin-language-001',
      stem: '变式测试题',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' }
      ],
      answer: ['A'],
      explanation: '解析',
      userAnswer: ['A']
    })
    current = database.getActivePlan()!
    expect(current.items.find((i) => i.id === 'item-ai')?.done).toBe(true)

    // 4) 知识阅读打卡触发 read_knowledge 并完成全部计划项
    const completedPlan = database.recordPlanRead('言语理解', 10)
    expect(completedPlan?.items.find((i) => i.id === 'item-read')?.done).toBe(true)
    expect(completedPlan?.status).toBe('completed')
    expect(database.getActivePlan()).toBeUndefined()
  })
})
