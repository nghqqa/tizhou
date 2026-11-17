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
})
