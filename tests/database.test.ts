import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import { VaultService } from '../src/main/services/vault'

describe('DatabaseService learning loop', () => {
  let directory: string
  let database: DatabaseService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-database-'))
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    new VaultService(database).ensureBuiltinVault()
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('seeds the self-authored starter vault', () => {
    const vault = database.getActiveVault()
    expect(vault?.isBuiltin).toBe(true)
    expect(vault?.questionCount).toBe(8)
    expect(database.listQuestions()).toHaveLength(8)
    expect(database.listDocuments({})).toHaveLength(4)
  })

  it('records wrong answers and masters an item after two consecutive correct reviews', () => {
    const wrong = database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['A'],
      durationSeconds: 12,
      mode: 'practice',
      wrongCause: '审题偏差'
    })
    expect(wrong.correct).toBe(false)
    expect(wrong.nextReviewAt).toBeTruthy()

    const firstReview = database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['C'],
      durationSeconds: 8,
      mode: 'review'
    })
    expect(firstReview.correct).toBe(true)
    expect(firstReview.mastered).toBe(false)

    const secondReview = database.submitAttempt({
      questionId: 'builtin-language-001',
      answer: ['C'],
      durationSeconds: 7,
      mode: 'review'
    })
    expect(secondReview.mastered).toBe(true)
    expect(database.getDashboard().masteredQuestions).toBe(1)
  })

  it('finishes an exam atomically and adds every question to attempts', () => {
    const questions = database.listQuestions({ subject: 'xingce', limit: 2 })
    const exam = database.createExam(
      { title: '测试模考', subject: 'xingce', durationMinutes: 30, questionCount: 2 },
      questions
    )
    for (const question of questions) {
      database.saveExamAnswer(exam.id, {
        questionId: question.id,
        answer: question.answer,
        durationSeconds: 10
      })
    }
    const finished = database.finishExam(exam.id)
    expect(finished.status).toBe('finished')
    expect(finished.correctCount).toBe(2)
    expect(finished.score).toBe(100)
    expect(database.getReport('all').totalAttempts).toBe(2)
  })

  it('creates a restorable database backup', () => {
    const backup = database.createBackup('manual')
    expect(backup.size).toBeGreaterThan(0)
    expect(database.listBackups()).toHaveLength(1)
  })

  it('rejects a tampered backup before closing the live database', () => {
    mkdirSync(database.backupDirectory, { recursive: true })
    const invalid = join(database.backupDirectory, 'workbench-manual-invalid.sqlite')
    writeFileSync(invalid, 'not a sqlite database', 'utf8')

    expect(() => database.restoreBackup(invalid)).toThrow(/备份验证失败/)
    expect(database.getActiveVault()?.questionCount).toBe(8)
  })

  it('persists practice progress, snapshots and uncertain flags for resume', () => {
    const questions = database.listQuestions({ subject: 'xingce', limit: 3 })
    const session = database.createPracticeSession(
      { mode: 'adaptive', count: 3, feedbackMode: 'summary' },
      questions
    )
    database.updatePracticeSession(session.id, {
      currentIndex: 1,
      uncertainIds: [questions[1]!.id, 'not-in-session']
    })

    const resumed = database.getActivePracticeSession('practice')
    expect(resumed?.feedbackMode).toBe('summary')
    expect(resumed?.currentIndex).toBe(1)
    expect(resumed?.uncertainIds).toEqual([questions[1]!.id])
    expect(resumed?.questionSnapshots[questions[0]!.id]?.stem).toBe(questions[0]!.stem)
  })

  it('grades an active exam from its immutable question snapshot', () => {
    const questions = database.listQuestions({ subject: 'xingce', limit: 2 })
    const original = questions[0]!
    const exam = database.createExam(
      { title: '快照模考', subject: 'xingce', durationMinutes: 30, questionCount: 2 },
      questions
    )
    database.saveExamAnswer(exam.id, {
      questionId: original.id,
      answer: original.answer,
      durationSeconds: 8
    })
    const vault = database.getActiveVault()!
    const updated = database
      .listQuestions()
      .map((question) =>
        question.id === original.id
          ? { ...question, answer: ['H'], contentHash: `${question.contentHash}-updated` }
          : question
      )
    database.replaceVaultContent(vault, updated, database.listDocuments({}))

    const finished = database.finishExam(exam.id)
    expect(finished.correctCount).toBe(1)
    expect(finished.questionSnapshots[original.id]?.answer).toEqual(original.answer)
  })

  it('creates and restores an index snapshot after content changes', () => {
    const vault = database.getActiveVault()!
    const original = database.listQuestions()[0]!
    const changedQuestions = database.listQuestions().map((question) =>
      question.id === original.id
        ? {
            ...question,
            stem: `${question.stem}（修订）`,
            contentHash: `${question.contentHash}-revision`
          }
        : question
    )
    database.replaceVaultContent(vault, changedQuestions, database.listDocuments({}))
    const snapshot = database.listVaultSnapshots(vault.id)[0]
    expect(snapshot).toBeTruthy()

    database.rollbackVaultSnapshot(snapshot!.id)
    expect(database.getQuestion(original.id)?.stem).toBe(original.stem)
  })

  it('clears learning evidence while preserving settings and vault content', () => {
    const question = database.listQuestions()[0]!
    database.saveAppSettings({ dailyTarget: 77 })
    database.submitAttempt({
      questionId: question.id,
      answer: [],
      durationSeconds: 9,
      mode: 'practice'
    })
    database.setFavorite(question.id, true)
    database.saveNote(question.id, '保留前的笔记')

    database.resetLearningData()

    expect(database.getReport('all').totalAttempts).toBe(0)
    expect(database.listQuestions()).toHaveLength(8)
    expect(database.getAppSettings().dailyTarget).toBe(77)
    expect(database.listQuestions({ onlyFavorite: true })).toHaveLength(0)
    expect(database.getNote(question.id)).toBe('')
  })

  it('preserves user state when the active vault is reindexed', () => {
    database.submitAttempt({
      questionId: 'builtin-logic-001',
      answer: ['B'],
      durationSeconds: 15,
      mode: 'practice'
    })
    database.setFavorite('builtin-logic-001', true)
    database.saveNote('builtin-logic-001', '检查逆否命题')

    new VaultService(database).reindex()

    expect(database.getDashboard().wrongQuestions).toBe(1)
    expect(database.listQuestions({ onlyFavorite: true }).map((question) => question.id)).toContain(
      'builtin-logic-001'
    )
    expect(database.getNote('builtin-logic-001')).toBe('检查逆否命题')
  })
})

describe('DatabaseService local-date statistics and exam edge cases', () => {
  let directory: string
  let database: DatabaseService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-database-local-'))
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    new VaultService(database).ensureBuiltinVault()
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  /** 本地日期键：与 DashboardPage buildCalendar 同构（本地年月日，非 UTC） */
  function localDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`
  }

  function insertAttempt(id: string, questionId: string, createdAt: string, correct = 1): void {
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    db.prepare(
      `INSERT INTO attempts(
        id, question_id, answer_json, correct, duration_seconds, mode, session_id,
        wrong_cause, question_snapshot_json, content_hash, created_at
      ) VALUES (?, ?, '["A"]', ?, 10, 'practice', NULL, NULL, '{}', 'x', ?)`
    ).run(id, questionId, correct, createdAt)
  }

  it('北京时间 00:00~08:00 的作答计入本地今天（UTC 日期仍是昨天）', () => {
    const questionId = database.listQuestions()[0]!.id
    const today = new Date()
    // 本地今天 00:30（东八区 → UTC 是昨天 16:30，UTC 日期切片是昨天）
    const localAfterMidnight = new Date(today)
    localAfterMidnight.setHours(0, 30, 0, 0)
    insertAttempt('att-early', questionId, localAfterMidnight.toISOString())

    const dashboard = database.getDashboard()
    expect(dashboard.todayAttempts).toBe(1)
    const todayKey = localDateKey(today)
    expect(dashboard.activity.map((item) => item.date)).toContain(todayKey)

    // 昨天本地 23:30（UTC 日期可能已是今天）必须归入昨天
    const yesterdayLate = new Date(today)
    yesterdayLate.setDate(yesterdayLate.getDate() - 1)
    yesterdayLate.setHours(23, 30, 0, 0)
    insertAttempt('att-late', questionId, yesterdayLate.toISOString())
    const refreshed = database.getDashboard()
    const byDate = new Map(refreshed.activity.map((item) => [item.date, item.attempts]))
    expect(byDate.get(todayKey)).toBe(1)
    const yesterdayKey = localDateKey(yesterdayLate)
    expect(byDate.get(yesterdayKey)).toBe(1)
    expect(refreshed.studyStreak).toBeGreaterThanOrEqual(2)
  })

  it('getReport dailyStats 按本地日期切片', () => {
    const questionId = database.listQuestions()[0]!.id
    const today = new Date()
    const localAfterMidnight = new Date(today)
    localAfterMidnight.setHours(1, 0, 0, 0)
    insertAttempt('att-report', questionId, localAfterMidnight.toISOString(), 0)
    const report = database.getReport('7d')
    expect(report.dailyStats.map((item) => item.date)).toContain(localDateKey(today))
  })

  it('listPapers 过滤题量不足 30 的试卷', () => {
    const vaultId = database.getActiveVault()!.id
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    const insert = (id: string, paper: string, count: number): void => {
      for (let index = 0; index < count; index += 1) {
        db.prepare(
          `INSERT INTO questions(
            id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
            difficulty, source, year, tags_json, content_hash, indexed_at, papers_json
          ) VALUES (?, ?, 'xingce', '言语理解', 'single', '题干', '[]', '["A"]', '解析',
            3, '本地资料/测试', 2024, '[]', 'hash-${id}-${index}', '2024-01-01', ?)`
        ).run(`${id}-${index}`, vaultId, JSON.stringify([{ paper, order: index + 1 }]))
      }
    }
    insert('big', '2024年国考行测', 35)
    insert('small', '2024年某省联考残卷', 12)
    const papers = database.listPapers()
    const names = papers.map((item) => item.paper)
    expect(names).toContain('2024年国考行测')
    expect(names).not.toContain('2024年某省联考残卷')
  })

  it('listQuestionsByPaper 按 papers 复现记录取整卷并按卷内题号排序', () => {
    const vaultId = database.getActiveVault()!.id
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    const rows: Array<[string, number]> = [
      ['paper-q3', 3],
      ['paper-q1', 1],
      ['paper-q2', 2]
    ]
    for (const [id, order] of rows) {
      db.prepare(
        `INSERT INTO questions(
          id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
          difficulty, source, tags_json, content_hash, indexed_at, papers_json
        ) VALUES (?, ?, 'xingce', '判断推理', 'single', ?, '[]', '["B"]', '解析',
          3, '本地资料/整卷', '[]', 'hash-${id}', '2024-01-01', ?)`
      ).run(id, vaultId, `题干 ${order}`, JSON.stringify([{ paper: '2023年国考行测', order }]))
    }
    const ordered = database.listQuestionsByPaper('2023年国考行测')
    expect(ordered.map((question) => question.id)).toEqual(['paper-q1', 'paper-q2', 'paper-q3'])
    expect(database.listQuestionsByPaper('不存在的卷')).toHaveLength(0)
  })

  it('finishExam 对快照中已删除的题目不再写 wrong_questions（外键兜底），交卷不中断', () => {
    const questions = database.listQuestions({ subject: 'xingce', limit: 3 })
    const exam = database.createExam(
      {
        title: '外键兜底模考',
        subject: 'xingce',
        durationMinutes: 30,
        questionCount: questions.length
      },
      questions
    )
    for (const question of questions)
      database.saveExamAnswer(exam.id, { questionId: question.id, answer: [], durationSeconds: 1 })
    // 中途重索引题库：快照题目已不在 questions 表
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    db.prepare('DELETE FROM questions WHERE id = ?').run(questions[0]!.id)

    const finished = database.finishExam(exam.id)
    expect(finished.status).toBe('finished')
    expect(finished.score).toBeDefined()
    // attempts 照常落盘（无外键），wrong_questions 只对仍存在的题目登记
    const attempts = (
      database as unknown as {
        db: { prepare: (sql: string) => { all: () => Array<{ id: unknown }> } }
      }
    ).db
      .prepare('SELECT id FROM attempts')
      .all()
    expect(attempts).toHaveLength(questions.length)
  })

  it('isFavorite 反映收藏状态', () => {
    const questionId = database.listQuestions()[0]!.id
    expect(database.isFavorite(questionId)).toBe(false)
    database.setFavorite(questionId, true)
    expect(database.isFavorite(questionId)).toBe(true)
    database.setFavorite(questionId, false)
    expect(database.isFavorite(questionId)).toBe(false)
  })

  it('localDateKeyOf 把 UTC ISO 时间转本地日期键（跨零点备份去重口径）', async () => {
    const { localDateKeyOf } = await import('../src/main/services/database')
    // 本地今天 00:30（东八区 → UTC 是昨天 16:30，UTC 日期切片仍是昨天）
    const today = new Date()
    const localAfterMidnight = new Date(today)
    localAfterMidnight.setHours(0, 30, 0, 0)
    expect(localDateKeyOf(localAfterMidnight.toISOString())).toBe(localDateKey(today))
    // UTC 字符串与 Date 实例同结果
    expect(localDateKeyOf(localAfterMidnight)).toBe(localDateKey(today))
    // 本地昨天 23:30（UTC 日期可能已是今天）必须归入昨天
    const yesterdayLate = new Date(today)
    yesterdayLate.setDate(yesterdayLate.getDate() - 1)
    yesterdayLate.setHours(23, 30, 0, 0)
    expect(localDateKeyOf(yesterdayLate.toISOString())).toBe(localDateKey(yesterdayLate))
    // 主进程启动去重谓词：当天创建的备份（birthtime 为 UTC ISO）必须命中今天
    const backup = database.createBackup('automatic')
    const listed = database.listBackups()
    expect(listed.some((item) => localDateKeyOf(item.createdAt) === localDateKey(new Date()))).toBe(
      true
    )
    expect(localDateKeyOf(backup.createdAt)).toBe(localDateKey(new Date()))
    // 非法输入返回空串而不是抛错（防御脏数据）
    expect(localDateKeyOf('not-a-date')).toBe('')
  })

  it('listConstructedAttempts 支持按题号与时间范围查询并跳过损坏 JSON', () => {
    const nowIso = new Date().toISOString()
    const oldIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    const evalA = {
      id: 'eval-a',
      promptId: 'prompt-1',
      score: 88,
      dimensions: [{ name: '要点覆盖', score: 90, comment: '较全' }],
      summary: '结构清晰',
      suggestions: ['补足数据'],
      createdAt: nowIso,
      provider: 'local-rule'
    }
    const evalB = {
      id: 'eval-b',
      promptId: 'prompt-2',
      score: 72,
      dimensions: [{ name: '要点覆盖', score: 72, comment: '一般' }],
      summary: '要点略少',
      suggestions: ['多提炼材料'],
      createdAt: oldIso,
      provider: 'local-rule'
    }
    database.saveConstructedAttempt({
      id: 'eval-b',
      promptId: 'prompt-2',
      title: '旧申论题',
      content: '旧作答内容',
      evaluation: evalB,
      createdAt: oldIso
    })
    database.saveConstructedAttempt({
      id: 'eval-a',
      promptId: 'prompt-1',
      title: '绿色工厂归纳概括',
      content: '一、环境绿；二、能源绿。',
      evaluation: evalA,
      createdAt: nowIso
    })
    // 写入一条损坏 JSON 记录，查询应跳过而不崩溃
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    db.prepare(
      'INSERT INTO constructed_attempts(id, prompt_id, title, content, evaluation_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('eval-bad', 'prompt-1', '坏记录', '内容', '{broken-json', nowIso)

    const all = database.listConstructedAttempts()
    expect(all.map((item) => item.id)).toEqual(['eval-a', 'eval-b'])
    const byPrompt = database.listConstructedAttempts({ promptId: 'prompt-1' })
    expect(byPrompt).toHaveLength(1)
    expect(byPrompt[0]!.evaluation.score).toBe(88)
    const recent30d = database.listConstructedAttempts({ range: '30d' })
    expect(recent30d.map((item) => item.id)).toEqual(['eval-a'])
  })

  it('getReport.essaySummary 按全量范围聚合申论统计，不受 100 条明细上限截断', () => {
    const nowIso = new Date().toISOString()
    const oldIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    // 写入 105 条近 30 天记录（超过学习报告明细列表的 limit: 100），覆盖 5 道题，分数 60..90 分布
    let scoreSum = 0
    for (let index = 0; index < 105; index += 1) {
      const score = index === 0 ? 96 : 60 + (index % 20)
      scoreSum += score
      const promptId = `essay-p-${index % 5}`
      database.saveConstructedAttempt({
        id: `essay-eval-${index}`,
        promptId,
        title: `申论题 ${index % 5}`,
        content: `第 ${index} 次作答内容`,
        evaluation: {
          id: `essay-eval-${index}`,
          promptId,
          score,
          dimensions: [{ name: '要点覆盖', score, comment: 'ok' }],
          summary: 'ok',
          suggestions: [],
          createdAt: nowIso,
          provider: 'local-rule'
        },
        createdAt: nowIso
      })
    }
    // 写入 1 条 45 天前的记录与 1 条损坏 JSON
    database.saveConstructedAttempt({
      id: 'essay-eval-old',
      promptId: 'essay-p-old',
      title: '旧申论题',
      content: '旧作答',
      evaluation: {
        id: 'essay-eval-old',
        promptId: 'essay-p-old',
        score: 99,
        dimensions: [{ name: '要点覆盖', score: 99, comment: 'ok' }],
        summary: 'ok',
        suggestions: [],
        createdAt: oldIso,
        provider: 'local-rule'
      },
      createdAt: oldIso
    })
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    db.prepare(
      'INSERT INTO constructed_attempts(id, prompt_id, title, content, evaluation_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('essay-eval-corrupt', 'essay-p-0', '坏记录', '内容', '{broken', nowIso)

    // 明细接口按 limit=100 截断，但报告汇总统计应精确覆盖全部 105 条有效记录
    expect(database.listConstructedAttempts({ range: '30d', limit: 100 })).toHaveLength(100)
    const report30d = database.getReport('30d')
    expect(report30d.essaySummary).toEqual({
      count: 105,
      uniquePrompts: 5,
      average: Math.round(scoreSum / 105),
      best: 96
    })
    const reportAll = database.getReport('all')
    expect(reportAll.essaySummary).toEqual({
      count: 106,
      uniquePrompts: 6,
      average: Math.round((scoreSum + 99) / 106),
      best: 99
    })
  })

  it('uiScale 持久化并在 85-150 范围内边界钳制，listQuestionsForPool 默认全量返回', () => {
    expect(database.getAppSettings().uiScale).toBe(100)
    expect(database.saveAppSettings({ uiScale: 120 }).uiScale).toBe(120)
    expect(database.getAppSettings().uiScale).toBe(120)
    expect(database.saveAppSettings({ uiScale: 40 }).uiScale).toBe(85)
    expect(database.saveAppSettings({ uiScale: 260 }).uiScale).toBe(150)
    expect(database.saveAppSettings({ uiScale: Number.NaN }).uiScale).toBe(100)

    expect(database.listQuestionsForPool()).toHaveLength(8)
    expect(database.listQuestionsForPool({ limit: 3 })).toHaveLength(3)
  })

  it('onlyUnattempted 过滤掉已有作答记录的题目', () => {
    const first = database.listQuestions()[0]!
    expect(database.listQuestions({ onlyUnattempted: true })).toHaveLength(8)
    database.submitAttempt({
      questionId: first.id,
      answer: first.answer,
      durationSeconds: 12,
      mode: 'practice'
    })
    const remaining = database.listQuestions({ onlyUnattempted: true })
    expect(remaining).toHaveLength(7)
    expect(remaining.some((item) => item.id === first.id)).toBe(false)
    expect(database.listQuestionsForPool({ onlyUnattempted: true })).toHaveLength(7)
  })

  it('listQuestionLibrary 支持错题本/收藏夹/笔记库全景查询与多维过滤，examGoal 设置合法校验', () => {
    const [q1, q2, q3] = database.listQuestions()
    // q1 答错带错因，q2 收藏，q3 写笔记
    database.submitAttempt({
      questionId: q1!.id,
      answer: ['Z'],
      durationSeconds: 20,
      mode: 'practice',
      wrongCause: '审题失误'
    })
    database.setFavorite(q2!.id, true)
    database.saveNote(q3!.id, '关键口诀：逆否等价')

    const wrongAll = database.listQuestionLibrary({ tab: 'wrong' })
    expect(wrongAll.map((item) => item.question.id)).toEqual([q1!.id])
    expect(wrongAll[0]!.lastWrongCause).toBe('审题失误')
    expect(database.listQuestionLibrary({ tab: 'wrong', wrongCause: '审题失误' })).toHaveLength(1)
    expect(database.listQuestionLibrary({ tab: 'wrong', wrongCause: '计算粗心' })).toHaveLength(0)

    const favs = database.listQuestionLibrary({ tab: 'favorite' })
    expect(favs.map((item) => item.question.id)).toEqual([q2!.id])
    expect(favs[0]!.favorite).toBe(true)

    const notes = database.listQuestionLibrary({ tab: 'notes', query: '逆否等价' })
    expect(notes.map((item) => item.question.id)).toEqual([q3!.id])
    expect(notes[0]!.note).toBe('关键口诀：逆否等价')

    // LIKE 通配符按字面量匹配，不把 % 当作全量通配
    expect(database.listQuestionLibrary({ tab: 'notes', query: '100%' })).toHaveLength(0)
    // limit 为 NaN 时回退默认值且非法 tab 显式抛错
    expect(database.listQuestionLibrary({ tab: 'notes', limit: Number.NaN })).toHaveLength(1)
    expect(() => database.listQuestionLibrary({ tab: 'invalid' as 'wrong' })).toThrow(
      '不支持的题单类型'
    )

    // 目标考试名称与日期校验（含非法日历日期拦截）
    const saved = database.saveAppSettings({
      examGoalName: '  2027 国考  ',
      examGoalDate: '2026-12-01'
    })
    expect(saved.examGoalName).toBe('2027 国考')
    expect(saved.examGoalDate).toBe('2026-12-01')
    expect(database.saveAppSettings({ examGoalDate: 'bad-date' }).examGoalDate).toBe('')
    expect(database.saveAppSettings({ examGoalDate: '2026-02-31' }).examGoalDate).toBe('')
    expect(database.saveAppSettings({ examGoalDate: '2026-13-45' }).examGoalDate).toBe('')
  })

  it('getQuestionsByIds / getQuestionsUserMeta / setWrongQuestionCause 与 AI 会话持久化闭环', () => {
    const [q1, q2, q3] = database.listQuestions()
    // 保序去重，跳过不存在的 ID
    const byIds = database.getQuestionsByIds([q3!.id, 'not-exist', q1!.id, q3!.id])
    expect(byIds.map((q) => q.id)).toEqual([q3!.id, q1!.id])

    // 批量元数据 + 更新错因
    database.submitAttempt({
      questionId: q1!.id,
      answer: ['Z'],
      durationSeconds: 18,
      mode: 'exam'
    })
    database.setFavorite(q1!.id, true)
    database.saveNote(q1!.id, '模考复盘笔记')
    database.setWrongQuestionCause(q1!.id, '时间压力')
    // 再次答错且未填写新错因时，保留既有错因标注不被空值冲掉
    database.submitAttempt({
      questionId: q1!.id,
      answer: ['Z'],
      durationSeconds: 10,
      mode: 'practice'
    })

    const meta = database.getQuestionsUserMeta([q1!.id, q2!.id])
    expect(meta[q1!.id]).toEqual({
      favorite: true,
      note: '模考复盘笔记',
      wrongCause: '时间压力'
    })
    expect(meta[q2!.id]).toEqual({ favorite: false, note: '' })

    // AI 多会话持久化 CRUD 及 resetLearningData 清理
    const conv = database.saveAiConversation({
      title: '资料分析追问',
      questionId: q1!.id,
      messages: [
        { role: 'user', content: '为什么选 A？' },
        { role: 'assistant', content: '因为基期量公式...' }
      ]
    })
    expect(conv.id).toBeTruthy()
    const updated = database.saveAiConversation({
      id: conv.id,
      title: '资料分析追问',
      messages: [...conv.messages, { role: 'user', content: '能再给个速算吗？' }]
    })
    expect(updated.questionId).toBe(q1!.id)
    expect(updated.messages).toHaveLength(3)
    expect(database.listAiConversations()).toHaveLength(1)

    database.deleteAiConversation(conv.id)
    expect(database.listAiConversations()).toHaveLength(0)

    database.saveAiConversation({
      title: '待重置会话',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(database.listAiConversations()).toHaveLength(1)
    database.resetLearningData()
    expect(database.listAiConversations()).toHaveLength(0)
  })

  it('地区提取、按地区级联 facets 与未标注地区过滤', async () => {
    const { extractRegionFromText, normalizeRegionName, UNLABELED_REGION_FILTER } =
      await import('../src/shared/region')
    expect(normalizeRegionName('江苏省')).toBe('江苏')
    expect(normalizeRegionName('北京市')).toBe('北京')
    expect(normalizeRegionName('2025国考')).toBe('国考')
    expect(extractRegionFromText('2024年广东省考申论（县级）')).toBe('广东')
    expect(extractRegionFromText('2024年国家公务员考试申论')).toBe('国考')
    expect(extractRegionFromText('普通练习卷')).toBeUndefined()

    const vaultId = database.getActiveVault()!.id
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } }
      }
    ).db
    const insertEssay = (id: string, region: string | null, paper: string | null): void => {
      db.prepare(
        `INSERT INTO questions(
          id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
          difficulty, source, year, region, paper, tags_json, content_hash, indexed_at
        ) VALUES (?, ?, 'shenlun', '归纳概括', 'essay', ?, '[]', '[]', '解析',
          3, '测试', 2024, ?, ?, '[]', 'hash-${id}', '2024-01-01')`
      ).run(id, vaultId, `题干-${id}`, region, paper)
    }
    insertEssay('e-js', '江苏', '2024年江苏省考申论A卷')
    insertEssay('e-gd', '广东', '2024年广东省考申论')
    insertEssay('e-none', null, '通用申论教材训练一')
    // 同义地区归并（「北京」与「北京市」在 facets 合并为「北京」并累加题量，查询时同时命中）
    insertEssay('e-bj1', '北京', '2024年北京市考申论')
    insertEssay('e-bj2', '北京市', '2023年北京市考申论')

    const allFacets = database.getQuestionFacets('shenlun')
    expect(allFacets.regions).toEqual(expect.arrayContaining(['江苏', '广东', '北京']))
    expect(allFacets.regions.filter((r) => r.startsWith('北京'))).toEqual(['北京'])
    expect(allFacets.regionCounts?.find((r) => r.region === '北京')?.count).toBe(2)
    expect(allFacets.papers).toEqual(
      expect.arrayContaining(['2024年江苏省考申论A卷', '2024年广东省考申论'])
    )

    // 按地区级联过滤 papers，同时保留 regions 列表供切换
    const jsFacets = database.getQuestionFacets('shenlun', '江苏')
    expect(jsFacets.regions).toEqual(expect.arrayContaining(['江苏', '广东']))
    expect(jsFacets.papers).toEqual(['2024年江苏省考申论A卷'])

    expect(database.listQuestions({ subject: 'shenlun', region: '广东' }).map((q) => q.id)).toEqual(
      ['e-gd']
    )
    const unlabeled = database.listQuestions({
      subject: 'shenlun',
      region: UNLABELED_REGION_FILTER
    })
    expect(unlabeled.some((q) => q.id === 'e-none')).toBe(true)
    expect(unlabeled.some((q) => q.id === 'e-js')).toBe(false)

    expect(database.listQuestions({ subject: 'shenlun', region: '北京' }).map((q) => q.id)).toEqual(
      expect.arrayContaining(['e-bj1', 'e-bj2'])
    )

    // 轻量摘要列表（不含 material）与一键整理地区标签 + defaultRegion 设置
    const summaries = database.listQuestionSummaries({ subject: 'shenlun', region: '北京' })
    expect(summaries).toHaveLength(2)
    expect('material' in summaries[0]!).toBe(false)
    expect(summaries[0]!.stemPreview).toContain('题干-')

    insertEssay('e-old', null, '2022年浙江省考申论')
    const normalized = database.normalizeActiveVaultRegions()
    expect(normalized.updated).toBeGreaterThanOrEqual(2) // e-bj2 ('北京市'->'北京') + e-old (null->'浙江')
    expect(database.getQuestion('e-bj2')?.region).toBe('北京')
    expect(database.getQuestion('e-old')?.region).toBe('浙江')

    expect(database.saveAppSettings({ defaultRegion: '浙江' }).defaultRegion).toBe('浙江')
  })

  it('supports multi-term AND search across shenlun material/paper/year/region and escapes LIKE wildcards', () => {
    const vaultId = database.getActiveVault()!.id
    const db = (
      database as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db

    db.prepare(
      `INSERT INTO questions (
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, year, region, paper, material, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'shenlun', '归纳概括', 'essay', ?, '[]', '[]', ?,
        3, ?, ?, ?, ?, ?, ?, ?, '2024-01-01')`
    ).run(
      'sl-search-1',
      vaultId,
      '根据给定资料2，概括L市优化营商环境的主要做法。',
      '要点：审批提速与法治保障。',
      '本地资料/2024国考申论真题集.pdf',
      2024,
      '国考',
      '2024年国考副省级申论',
      '给定资料2：L市推进法治政府建设，打造市场化、法治化营商环境，政务服务实现一网通办。',
      JSON.stringify(['营商环境', '法治']),
      'hash-sl-search-1'
    )

    db.prepare(
      `INSERT INTO questions (
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, year, region, paper, material, tags_json, content_hash, indexed_at
      ) VALUES (?, ?, 'shenlun', '应用文', 'essay', ?, '[]', '[]', ?,
        3, ?, ?, ?, ?, ?, ?, ?, '2024-01-01')`
    ).run(
      'sl-search-2',
      vaultId,
      '起草一份关于青年人才返乡创业的倡议书，达成率提升 100%_指标。',
      '格式规范，号召力强。',
      '本地资料/2023浙江申论精讲.pdf',
      2023,
      '浙江',
      '2023年浙江省考申论A卷',
      '给定资料1：乡村数字经济与生态旅游融合发展。',
      JSON.stringify(['乡村振兴']),
      'hash-sl-search-2'
    )

    // 检索申论给定资料内容（题干未出现“一网通办”）
    expect(
      database
        .listQuestionSummaries({ subject: 'shenlun', type: 'essay', query: '一网通办' })
        .map((item) => item.id)
    ).toEqual(['sl-search-1'])

    // 空格分隔多词 AND 匹配（跨年份 + 地区 + 材料关键词，支持全角空格）
    expect(
      database
        .listQuestionSummaries({
          subject: 'shenlun',
          type: 'essay',
          query: '2024\u3000副省级 法治政府'
        })
        .map((item) => item.id)
    ).toEqual(['sl-search-1'])

    // 多词中有任一词不命中时不返回
    expect(
      database.listQuestionSummaries({
        subject: 'shenlun',
        type: 'essay',
        query: '2024 乡村振兴'
      })
    ).toEqual([])

    // LIKE 通配符 % 和 _ 按字面量转义，不误匹配其他题目
    expect(
      database
        .listQuestionSummaries({ subject: 'shenlun', type: 'essay', query: '100%_' })
        .map((item) => item.id)
    ).toEqual(['sl-search-2'])
    expect(
      database.listQuestionSummaries({ subject: 'shenlun', type: 'essay', query: '%' })
    ).toHaveLength(1)

    // 题单（收藏/笔记）同样支持多词 + 笔记内容 + 卷名联合检索
    database.setFavorite('sl-search-1', true)
    database.saveNote('sl-search-1', '重点复习一网通办案例')
    expect(
      database
        .listQuestionLibrary({ tab: 'favorite', query: '2024 重点复习' })
        .map((item) => item.question.id)
    ).toEqual(['sl-search-1'])

    // 知识文档检索支持跨标签与正文多词 AND 及 LIKE 通配符转义
    expect(database.listDocuments({ query: '作答方法 观点在前' }).map((doc) => doc.id)).toEqual([
      'builtin-doc-shenlun'
    ])
    expect(database.listDocuments({ query: '%' })).toEqual([])
    expect(database.listDocuments({ query: '___not_match_wildcard___' })).toEqual([])
  })

  it('老库缺少 region/paper 列时迁移不报错，且原卷抽题与 Dashboard 严格按科目和活动库隔离', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const legacyDir = mkdtempSync(join(tmpdir(), 'tizhou-legacy-db-'))
    const legacyDbPath = join(legacyDir, 'workbench.sqlite')
    const raw = new DatabaseSync(legacyDbPath)
    raw.exec(`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        stem TEXT NOT NULL,
        options_json TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        explanation TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        source TEXT NOT NULL,
        year INTEGER,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
    `)
    raw.close()

    const legacySvc = new DatabaseService(legacyDbPath, legacyDir, join(legacyDir, 'backups'))
    try {
      expect(legacySvc.listQuestions()).toEqual([])
    } finally {
      legacySvc.close()
      rmSync(legacyDir, { recursive: true, force: true })
    }

    // 同名试卷中行测原卷查询不得混入申论大题
    const activeVault = database.getActiveVault()!
    database.replaceVaultContent(
      activeVault,
      [
        {
          id: 'paper-xc-1',
          subject: 'xingce',
          category: '常识判断',
          type: 'single',
          stem: '行测真题',
          options: [
            { key: 'A', text: '甲' },
            { key: 'B', text: '乙' }
          ],
          answer: ['A'],
          explanation: '解析',
          difficulty: 2,
          tags: [],
          source: '2025年国考',
          paper: '2025年国考同名卷',
          papers: [{ paper: '2025年国考同名卷', order: 1 }],
          filePath: join(activeVault.path, 'xc.md'),
          contentHash: 'h-xc-1'
        },
        {
          id: 'paper-sl-1',
          subject: 'shenlun',
          category: '归纳概括',
          type: 'essay',
          stem: '申论大题',
          options: [],
          answer: [],
          explanation: '解析',
          difficulty: 3,
          tags: [],
          source: '2025年国考',
          paper: '2025年国考同名卷',
          papers: [{ paper: '2025年国考同名卷', order: 2 }],
          filePath: join(activeVault.path, 'sl.md'),
          contentHash: 'h-sl-1'
        }
      ],
      [],
      false
    )
    const xingcePaper = database.listQuestionsByPaper('2025年国考同名卷')
    expect(xingcePaper.map((q) => q.id)).toEqual(['paper-xc-1'])
  })
})
