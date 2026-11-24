import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AttemptInput,
  AttemptResult,
  ConstructedAttemptRecord,
  ConstructedDraft,
  ConstructedEvaluation,
  ExamAnswer,
  ExamConfig,
  ExamSession,
  PracticeSelection,
  PracticeSession,
  Question,
  ReportData,
  ReviewItem,
  StudySnippet
} from '../../../shared/contracts'
import { REVIEW_WRONG_DELAY_DAYS } from '../../../shared/defaults'
import { computeReviewSchedule, isAnswerCorrect } from '../../../shared/study-constants'
import { now } from '../../utils/common'
import {
  type Row,
  addDays,
  mapExam,
  mapQuestion,
  numberValue,
  parseJson,
  runInTransaction
} from './mappers'
import { getQuestion, getQuestionsByIds } from './question-repo'

export function getRecentAttemptQuestionIds(db: DatabaseSync, limit = 100): string[] {
  const rows = db
    .prepare('SELECT question_id FROM attempts ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(1000, limit))) as Row[]
  return [...new Set(rows.map((row) => String(row.question_id)))]
}

export function getAttemptedQuestionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT DISTINCT question_id FROM attempts').all() as Row[]
  return new Set(rows.map((row) => String(row.question_id)))
}

export function createPracticeSession(
  db: DatabaseSync,
  selection: PracticeSelection,
  questions: Question[]
): PracticeSession {
  if (!questions.length) throw new Error('当前筛选条件下没有可用题目')
  const sessionKind = selection.mode === 'review' ? 'review' : 'practice'
  const timestamp = now()
  const session: PracticeSession = {
    id: randomUUID(),
    mode: selection.mode,
    feedbackMode: selection.feedbackMode ?? 'immediate',
    createdAt: timestamp,
    updatedAt: timestamp,
    questionIds: questions.map((question) => question.id),
    questionSnapshots: Object.fromEntries(questions.map((question) => [question.id, question])),
    currentIndex: 0,
    uncertainIds: [],
    status: 'active'
  }
  runInTransaction(db, () => {
    db.prepare(
      "UPDATE learning_sessions SET ended_at=?, metadata_json=json_set(metadata_json,'$.status','abandoned') WHERE kind=? AND ended_at IS NULL"
    ).run(timestamp, sessionKind)
    db.prepare(
      'INSERT INTO learning_sessions(id,kind,started_at,ended_at,duration_seconds,metadata_json) VALUES(?,?,?,NULL,0,?)'
    ).run(session.id, sessionKind, timestamp, JSON.stringify(session))
  })
  return session
}

export function getActivePracticeSession(
  db: DatabaseSync,
  mode: 'practice' | 'review'
): PracticeSession | undefined {
  const row = db
    .prepare(
      'SELECT metadata_json FROM learning_sessions WHERE kind=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    )
    .get(mode) as Row | undefined
  return row ? parseJson<PracticeSession | undefined>(row.metadata_json, undefined) : undefined
}

export function getSessionAttempts(
  db: DatabaseSync,
  sessionId: string
): Array<{ questionId: string; answer: string[]; correct: boolean }> {
  const rows = db
    .prepare(
      'SELECT question_id, answer_json, correct FROM attempts WHERE session_id = ? ORDER BY created_at, id'
    )
    .all(sessionId) as Row[]
  return rows.map((row) => ({
    questionId: String(row.question_id),
    answer: parseJson<string[]>(row.answer_json, []),
    correct: Boolean(row.correct)
  }))
}

export function updatePracticeSession(
  db: DatabaseSync,
  id: string,
  patch: { currentIndex?: number; uncertainIds?: string[]; appendQuestionIds?: string[] }
): PracticeSession {
  const row = db
    .prepare('SELECT metadata_json FROM learning_sessions WHERE id=? AND ended_at IS NULL')
    .get(id) as Row | undefined
  if (!row) throw new Error('训练会话不存在或已经结束')
  const session = parseJson<PracticeSession | undefined>(row.metadata_json, undefined)
  if (!session) throw new Error('训练会话数据损坏')
  if (patch.appendQuestionIds?.length) {
    const existingSet = new Set(session.questionIds)
    const candidates = getQuestionsByIds(db, patch.appendQuestionIds)
    for (const question of candidates) {
      if (existingSet.has(question.id)) continue
      existingSet.add(question.id)
      session.questionIds.push(question.id)
      session.questionSnapshots[question.id] = question
    }
  }
  if (patch.currentIndex !== undefined) {
    session.currentIndex = Math.max(
      0,
      Math.min(session.questionIds.length - 1, Math.round(patch.currentIndex))
    )
  }
  if (patch.uncertainIds !== undefined) {
    session.uncertainIds = [
      ...new Set(patch.uncertainIds.filter((idValue) => session.questionIds.includes(idValue)))
    ]
  }
  session.updatedAt = now()
  db.prepare('UPDATE learning_sessions SET metadata_json=? WHERE id=?').run(
    JSON.stringify(session),
    id
  )
  return session
}

export function completePracticeSession(
  db: DatabaseSync,
  id: string,
  abandoned = false
): PracticeSession {
  const row = db
    .prepare('SELECT metadata_json,started_at FROM learning_sessions WHERE id=?')
    .get(id) as Row | undefined
  if (!row) throw new Error('训练会话不存在')
  const session = parseJson<PracticeSession | undefined>(row.metadata_json, undefined)
  if (!session) throw new Error('训练会话数据损坏')
  session.status = abandoned ? 'abandoned' : 'completed'
  session.updatedAt = now()
  const durationSeconds = Math.max(
    0,
    Math.round((Date.now() - new Date(String(row.started_at)).getTime()) / 1000)
  )
  db.prepare(
    'UPDATE learning_sessions SET ended_at=?,duration_seconds=?,metadata_json=? WHERE id=?'
  ).run(session.updatedAt, durationSeconds, JSON.stringify(session), id)
  return session
}

export function recordAttempt(
  db: DatabaseSync,
  input: AttemptInput,
  questionSnapshot?: Question
): AttemptResult {
  const question = questionSnapshot ?? getQuestion(db, input.questionId)
  if (!question) throw new Error('题目不存在或知识库已切换')
  const correct = isAnswerCorrect(question.answer, input.answer)
  const attemptId = randomUUID()
  let nextReviewAt: string | undefined
  let mastered = false
  // 模考快照路径（questionSnapshot 直传）不保证题目仍在当前 questions 表：
  // 中途切换/重索引题库后，wrong_questions/review_tasks 的外键会让交整卷直接卡死。
  // attempts 表无外键照常落盘；错题与复习任务只对仍存在的题目登记
  const questionStillIndexed = questionSnapshot
    ? Boolean(db.prepare('SELECT 1 FROM questions WHERE id = ?').get(question.id))
    : true
  db.prepare(
    `INSERT INTO attempts(
      id, question_id, answer_json, correct, duration_seconds, mode, session_id,
      wrong_cause, question_snapshot_json, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    attemptId,
    question.id,
    JSON.stringify(input.answer),
    correct ? 1 : 0,
    Math.max(0, Math.round(input.durationSeconds)),
    input.mode,
    input.sessionId ?? null,
    input.wrongCause?.trim() || null,
    JSON.stringify(question),
    question.contentHash,
    now()
  )
  if (!questionStillIndexed) {
    return {
      attemptId,
      correct,
      expected: question.answer,
      explanation: question.explanation,
      nextReviewAt: undefined,
      mastered: false
    }
  }
  const wrong = db
    .prepare('SELECT * FROM wrong_questions WHERE question_id = ?')
    .get(question.id) as Row | undefined
  let reviewBaseline: AttemptResult['reviewBaseline']
  let intervalDays: number | undefined
  if (!correct) {
    const firstWrongAt = wrong ? String(wrong.first_wrong_at) : now()
    db.prepare(
      `INSERT INTO wrong_questions(
        question_id, wrong_count, correct_streak, review_stage, mastered, last_wrong_cause, first_wrong_at, last_attempt_at
      ) VALUES (?, ?, 0, 0, 0, ?, ?, ?)
      ON CONFLICT(question_id) DO UPDATE SET
        wrong_count = wrong_questions.wrong_count + 1,
        correct_streak = 0,
        review_stage = 0,
        mastered = 0,
        last_wrong_cause = COALESCE(NULLIF(trim(excluded.last_wrong_cause), ''), wrong_questions.last_wrong_cause),
        last_attempt_at = excluded.last_attempt_at`
    ).run(
      question.id,
      wrong ? numberValue(wrong.wrong_count) + 1 : 1,
      input.wrongCause?.trim() || null,
      firstWrongAt,
      now()
    )
    intervalDays = REVIEW_WRONG_DELAY_DAYS
    nextReviewAt = addDays(REVIEW_WRONG_DELAY_DAYS)
  } else if (wrong) {
    const feedback = input.reviewFeedback ?? 'normal'
    const previousStreak = numberValue(wrong.correct_streak)
    const previousStage = numberValue(wrong.review_stage)
    const wrongCount = numberValue(wrong.wrong_count)
    reviewBaseline = { streak: previousStreak, stage: previousStage, wrongCount }
    const schedule = computeReviewSchedule({
      previousStreak,
      previousStage,
      wrongCount,
      feedback
    })
    mastered = schedule.mastered
    intervalDays = schedule.delayDays
    db.prepare(
      'UPDATE wrong_questions SET correct_streak = ?, review_stage = ?, mastered = ?, last_attempt_at = ? WHERE question_id = ?'
    ).run(schedule.streak, schedule.stage, mastered ? 1 : 0, now(), question.id)
    nextReviewAt = mastered || !schedule.delayDays ? undefined : addDays(schedule.delayDays)
  }
  if (nextReviewAt) {
    db.prepare(
      `INSERT INTO review_tasks(question_id, due_at, completed_at) VALUES (?, ?, NULL)
        ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, completed_at = NULL`
    ).run(question.id, nextReviewAt)
  } else if (mastered) {
    db.prepare('UPDATE review_tasks SET completed_at = ? WHERE question_id = ?').run(
      now(),
      question.id
    )
  }
  return {
    attemptId,
    correct,
    expected: question.answer,
    explanation: question.explanation,
    nextReviewAt,
    mastered,
    ...(intervalDays !== undefined ? { intervalDays } : {}),
    ...(reviewBaseline ? { reviewBaseline } : {})
  }
}

export function submitAttempt(db: DatabaseSync, input: AttemptInput): AttemptResult {
  return runInTransaction(db, () => recordAttempt(db, input))
}

/** 复习模式提交查看解析后，按作答前基线幂等调整艾宾浩斯记忆评级与下次间隔 */
export function rateReviewAttempt(
  db: DatabaseSync,
  params: {
    questionId: string
    feedback: 'forgot' | 'hard' | 'normal' | 'easy'
    baselineStreak?: number
    baselineStage?: number
  }
): {
  nextReviewAt?: string
  mastered: boolean
  intervalDays?: number
  reviewStage: number
} {
  return runInTransaction(db, () => {
    const wrong = db
      .prepare('SELECT * FROM wrong_questions WHERE question_id = ?')
      .get(params.questionId) as Row | undefined
    if (!wrong) throw new Error('当前题目未在错题复习队列中')
    const wrongCount = numberValue(wrong.wrong_count)
    const schedule = computeReviewSchedule({
      previousStreak: params.baselineStreak ?? numberValue(wrong.correct_streak),
      previousStage: params.baselineStage ?? numberValue(wrong.review_stage),
      wrongCount,
      feedback: params.feedback
    })
    const nextReviewAt =
      schedule.mastered || !schedule.delayDays ? undefined : addDays(schedule.delayDays)
    db.prepare(
      'UPDATE wrong_questions SET correct_streak = ?, review_stage = ?, mastered = ?, last_attempt_at = ? WHERE question_id = ?'
    ).run(schedule.streak, schedule.stage, schedule.mastered ? 1 : 0, now(), params.questionId)
    if (nextReviewAt) {
      db.prepare(
        `INSERT INTO review_tasks(question_id, due_at, completed_at) VALUES (?, ?, NULL)
          ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, completed_at = NULL`
      ).run(params.questionId, nextReviewAt)
    } else if (schedule.mastered) {
      db.prepare('UPDATE review_tasks SET completed_at = ? WHERE question_id = ?').run(
        now(),
        params.questionId
      )
    }
    return {
      nextReviewAt,
      mastered: schedule.mastered,
      intervalDays: schedule.delayDays,
      reviewStage: schedule.stage
    }
  })
}

/** 将「蒙对 / 标记不确定」等题目批量加入次日到期复习队列 */
export function enqueueReviewQuestions(
  db: DatabaseSync,
  questionIds: string[],
  reason = '蒙对/不确定'
): { added: number; skipped: number } {
  const uniqueIds = [...new Set(questionIds.map((id) => id.trim()).filter(Boolean))].slice(0, 200)
  if (!uniqueIds.length) return { added: 0, skipped: 0 }
  return runInTransaction(db, () => {
    const dueAt = addDays(REVIEW_WRONG_DELAY_DAYS)
    const timestamp = now()
    let added = 0
    let skipped = 0
    const existsQuestion = db.prepare('SELECT 1 FROM questions WHERE id = ?')
    const getWrong = db.prepare('SELECT mastered FROM wrong_questions WHERE question_id = ?')
    const getTask = db.prepare('SELECT completed_at FROM review_tasks WHERE question_id = ?')
    for (const id of uniqueIds) {
      if (!existsQuestion.get(id)) {
        skipped += 1
        continue
      }
      const wrong = getWrong.get(id) as Row | undefined
      const task = getTask.get(id) as Row | undefined
      if (wrong && !numberValue(wrong.mastered) && task && task.completed_at === null) {
        skipped += 1
        continue
      }
      db.prepare(
        `INSERT INTO wrong_questions(
          question_id, wrong_count, correct_streak, review_stage, mastered, last_wrong_cause, first_wrong_at, last_attempt_at
        ) VALUES (?, 1, 0, 0, 0, ?, ?, ?)
        ON CONFLICT(question_id) DO UPDATE SET
          correct_streak = 0,
          review_stage = 0,
          mastered = 0,
          last_wrong_cause = COALESCE(NULLIF(trim(wrong_questions.last_wrong_cause), ''), excluded.last_wrong_cause),
          last_attempt_at = excluded.last_attempt_at`
      ).run(id, reason.trim().slice(0, 40) || null, timestamp, timestamp)
      db.prepare(
        `INSERT INTO review_tasks(question_id, due_at, completed_at) VALUES (?, ?, NULL)
          ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, completed_at = NULL`
      ).run(id, dueAt)
      added += 1
    }
    return { added, skipped }
  })
}

export function setFavorite(db: DatabaseSync, questionId: string, favorite: boolean): void {
  if (favorite)
    db.prepare('INSERT OR IGNORE INTO favorites(question_id, created_at) VALUES (?, ?)').run(
      questionId,
      now()
    )
  else db.prepare('DELETE FROM favorites WHERE question_id = ?').run(questionId)
}

export function isFavorite(db: DatabaseSync, questionId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM favorites WHERE question_id = ?').get(questionId))
}

export function saveNote(db: DatabaseSync, questionId: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > 200 * 1024) throw new Error('单题笔记不能超过 200 KB')
  db.prepare(
    `INSERT INTO user_notes(question_id, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(question_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).run(questionId, content, now())
}

export function getNote(db: DatabaseSync, questionId: string): string {
  const row = db.prepare('SELECT content FROM user_notes WHERE question_id = ?').get(questionId) as
    Row | undefined
  return row ? String(row.content) : ''
}

export function getDueReviews(db: DatabaseSync, limit = 100): ReviewItem[] {
  const rows = db
    .prepare(
      `SELECT q.*, r.due_at, w.wrong_count, w.correct_streak, w.review_stage, w.last_wrong_cause
      FROM review_tasks r
      JOIN questions q ON q.id = r.question_id
      JOIN vault_registry v ON v.id = q.vault_id AND v.active = 1
      JOIN wrong_questions w ON w.question_id = q.id
      WHERE r.completed_at IS NULL AND r.due_at <= ? AND w.mastered = 0
      ORDER BY r.due_at LIMIT ?`
    )
    .all(now(), Math.max(1, Math.min(500, limit))) as Row[]
  return rows.map((row) => ({
    question: mapQuestion(row),
    dueAt: String(row.due_at),
    wrongCount: numberValue(row.wrong_count),
    correctStreak: numberValue(row.correct_streak),
    reviewStage: numberValue(row.review_stage),
    lastWrongCause: row.last_wrong_cause === null ? undefined : String(row.last_wrong_cause)
  }))
}

export function createExam(
  db: DatabaseSync,
  config: ExamConfig,
  questions: Question[]
): ExamSession {
  if (questions.length === 0) throw new Error('当前筛选条件下没有可用题目')
  const timestamp = now()
  const exam: ExamSession = {
    id: randomUUID(),
    title: config.title.trim() || '自定义模考',
    subject: config.subject,
    startedAt: timestamp,
    updatedAt: timestamp,
    durationMinutes: Math.max(10, Math.min(300, Math.round(config.durationMinutes))),
    questionIds: questions.map((question) => question.id),
    questionSnapshots: Object.fromEntries(questions.map((question) => [question.id, question])),
    answers: {},
    status: 'active'
  }
  db.prepare(
    `INSERT INTO exam_sessions(
      id, title, subject, started_at, updated_at, duration_minutes,
      question_ids_json, question_snapshots_json, answers_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active')`
  ).run(
    exam.id,
    exam.title,
    exam.subject,
    exam.startedAt,
    exam.updatedAt,
    exam.durationMinutes,
    JSON.stringify(exam.questionIds),
    JSON.stringify(exam.questionSnapshots)
  )
  return exam
}

export function getActiveExam(db: DatabaseSync): ExamSession | undefined {
  const row = db
    .prepare("SELECT * FROM exam_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
    .get() as Row | undefined
  return row ? mapExam(row) : undefined
}

export function getExamById(db: DatabaseSync, id: string): ExamSession | undefined {
  const row = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(id) as Row | undefined
  return row ? mapExam(row) : undefined
}

export function saveExamAnswer(db: DatabaseSync, examId: string, answer: ExamAnswer): ExamSession {
  const exam = getExamById(db, examId)
  if (!exam || exam.status !== 'active') throw new Error('模考已结束或不存在')
  if (!exam.questionIds.includes(answer.questionId)) throw new Error('该题不属于当前模考')
  exam.answers[answer.questionId] = answer
  exam.updatedAt = now()
  db.prepare('UPDATE exam_sessions SET answers_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(exam.answers),
    exam.updatedAt,
    examId
  )
  return exam
}

export function finishExam(db: DatabaseSync, examId: string, uncertainIds?: string[]): ExamSession {
  const exam = getExamById(db, examId)
  if (!exam) throw new Error('模考不存在')
  if (exam.status === 'finished') return exam
  const cleanUncertain = [
    ...new Set(
      (uncertainIds ?? exam.uncertainIds ?? []).filter((id) => exam.questionIds.includes(id))
    )
  ]
  runInTransaction(db, () => {
    const finishedAt = now()
    if (exam.subject === 'shenlun') {
      // 申论整卷连作交卷：非空作答落入草稿箱并在 attempts 记入训练耗时，绝不按客观题判 0 分污染错题本
      for (const questionId of exam.questionIds) {
        const answer = exam.answers[questionId] ?? { questionId, answer: [], durationSeconds: 0 }
        const snapshot = exam.questionSnapshots[questionId]
        if (!snapshot) throw new Error(`模考快照缺少题目 ${questionId}`)
        const text = (answer.answer[0] ?? '').trim()
        if (text) {
          saveDraft(db, {
            id: `draft-${snapshot.id}`,
            promptId: snapshot.id,
            title: snapshot.stem.slice(0, 60),
            content: answer.answer[0] ?? ''
          })
          db.prepare(
            `INSERT INTO attempts(
              id, question_id, answer_json, correct, duration_seconds, mode, session_id,
              wrong_cause, question_snapshot_json, content_hash, created_at
            ) VALUES (?, ?, ?, 1, ?, 'exam', ?, NULL, ?, ?, ?)`
          ).run(
            randomUUID(),
            snapshot.id,
            JSON.stringify(answer.answer),
            Math.max(0, Math.round(answer.durationSeconds)),
            exam.id,
            JSON.stringify(snapshot),
            snapshot.contentHash,
            finishedAt
          )
        }
      }
      db.prepare(
        "UPDATE exam_sessions SET status = 'finished', finished_at = ?, updated_at = ?, uncertain_ids_json = ? WHERE id = ?"
      ).run(finishedAt, finishedAt, JSON.stringify(cleanUncertain), examId)
      return
    }
    let correctCount = 0
    for (const questionId of exam.questionIds) {
      const answer = exam.answers[questionId] ?? { questionId, answer: [], durationSeconds: 0 }
      const snapshot = exam.questionSnapshots[questionId]
      if (!snapshot) throw new Error(`模考快照缺少题目 ${questionId}`)
      const result = recordAttempt(db, { ...answer, mode: 'exam', sessionId: exam.id }, snapshot)
      if (result.correct) correctCount += 1
    }
    const score = Math.round((correctCount / exam.questionIds.length) * 1000) / 10
    db.prepare(
      "UPDATE exam_sessions SET status = 'finished', finished_at = ?, updated_at = ?, score = ?, correct_count = ?, uncertain_ids_json = ? WHERE id = ?"
    ).run(finishedAt, finishedAt, score, correctCount, JSON.stringify(cleanUncertain), examId)
  })
  return getExamById(db, examId)!
}

export function listExams(db: DatabaseSync): ExamSession[] {
  return (
    db.prepare('SELECT * FROM exam_sessions ORDER BY updated_at DESC LIMIT 100').all() as Row[]
  ).map((row) => mapExam(row))
}

export function saveDraft(
  db: DatabaseSync,
  draft: Omit<ConstructedDraft, 'updatedAt'>
): ConstructedDraft {
  const saved: ConstructedDraft = { ...draft, updatedAt: now() }
  db.prepare(
    `INSERT INTO constructed_drafts(id, prompt_id, title, content, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=excluded.updated_at`
  ).run(saved.id, saved.promptId, saved.title, saved.content, saved.updatedAt)
  return saved
}

export function getDraft(db: DatabaseSync, id: string): ConstructedDraft | undefined {
  const row = db.prepare('SELECT * FROM constructed_drafts WHERE id = ?').get(id) as Row | undefined
  return row
    ? {
        id: String(row.id),
        promptId: String(row.prompt_id),
        title: String(row.title),
        content: String(row.content),
        updatedAt: String(row.updated_at)
      }
    : undefined
}

export function saveConstructedAttempt(
  db: DatabaseSync,
  payload: {
    id: string
    promptId: string
    title: string
    content: string
    evaluation: unknown
    createdAt: string
  }
): void {
  db.prepare(
    'INSERT INTO constructed_attempts(id, prompt_id, title, content, evaluation_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    payload.id,
    payload.promptId,
    payload.title,
    payload.content,
    JSON.stringify(payload.evaluation),
    payload.createdAt
  )
}

export function listConstructedAttempts(
  db: DatabaseSync,
  params?: { promptId?: string; limit?: number; range?: ReportData['range'] }
): ConstructedAttemptRecord[] {
  const clauses: string[] = []
  const values: Array<string | number> = []
  if (params?.promptId) {
    clauses.push('prompt_id = ?')
    values.push(params.promptId)
  }
  if (params?.range && params.range !== 'all') {
    const cutoff = params.range === '7d' ? addDays(-7) : addDays(-30)
    clauses.push('created_at >= ?')
    values.push(cutoff)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(500, params?.limit ?? 100))
  const rows = db
    .prepare(`SELECT * FROM constructed_attempts ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, limit) as Row[]
  const records: ConstructedAttemptRecord[] = []
  for (const row of rows) {
    try {
      const evaluation = JSON.parse(String(row.evaluation_json)) as ConstructedEvaluation
      if (!evaluation || typeof evaluation.score !== 'number') continue
      records.push({
        id: String(row.id),
        promptId: String(row.prompt_id),
        title: String(row.title),
        content: String(row.content),
        evaluation,
        createdAt: String(row.created_at)
      })
    } catch {
      /* 跳过损坏的历史评估 JSON，避免影响其他记录读取 */
    }
  }
  return records
}

export function getConstructedAttemptSummary(
  db: DatabaseSync,
  range: ReportData['range'] = 'all'
): NonNullable<ReportData['essaySummary']> {
  const clauses: string[] = []
  const values: Array<string | number> = []
  if (range !== 'all') {
    const cutoff = range === '7d' ? addDays(-7) : addDays(-30)
    clauses.push('created_at >= ?')
    values.push(cutoff)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT prompt_id, evaluation_json FROM constructed_attempts ${where}`)
    .all(...values) as Row[]
  const prompts = new Set<string>()
  let count = 0
  let sum = 0
  let best = 0
  for (const row of rows) {
    try {
      const evaluation = JSON.parse(String(row.evaluation_json)) as ConstructedEvaluation
      if (!evaluation || typeof evaluation.score !== 'number') continue
      count += 1
      sum += evaluation.score
      if (count === 1 || evaluation.score > best) best = evaluation.score
      prompts.add(String(row.prompt_id))
    } catch {
      /* 跳过损坏的历史评估 JSON */
    }
  }
  return {
    count,
    uniquePrompts: prompts.size,
    average: count ? Math.round(sum / count) : 0,
    best
  }
}

export function listStudySnippets(
  db: DatabaseSync,
  params?: { kind?: 'norm' | 'quote'; query?: string }
): StudySnippet[] {
  const where: string[] = []
  const values: string[] = []
  if (params?.kind) {
    where.push('kind = ?')
    values.push(params.kind)
  }
  if (params?.query?.trim()) {
    const pattern = `%${params.query.trim().replace(/[%_\\]/g, '\\$&')}%`
    where.push(
      "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')"
    )
    values.push(pattern, pattern, pattern)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM study_snippets ${whereSql} ORDER BY created_at DESC LIMIT 300`)
    .all(...values) as Row[]
  return rows.map((row) => ({
    id: String(row.id),
    kind: (String(row.kind) === 'norm' ? 'norm' : 'quote') as 'norm' | 'quote',
    title: String(row.title),
    content: String(row.content),
    sourceDocId: row.source_doc_id ? String(row.source_doc_id) : undefined,
    tags: parseJson<string[]>(row.tags_json, []),
    createdAt: String(row.created_at)
  }))
}

export function saveStudySnippet(
  db: DatabaseSync,
  input: {
    id?: string
    kind: 'norm' | 'quote'
    title: string
    content: string
    sourceDocId?: string
    tags?: string[]
  }
): StudySnippet {
  const title = input.title.trim().slice(0, 80)
  const content = input.content.trim().slice(0, 4000)
  if (!title || !content) throw new Error('标题和正文内容不能为空')
  const id = input.id?.trim() || randomUUID()
  const createdAt = now()
  const tags = (input.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8)
  db.prepare(
    `INSERT INTO study_snippets(id, kind, title, content, source_doc_id, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       title = excluded.title,
       content = excluded.content,
       source_doc_id = COALESCE(excluded.source_doc_id, study_snippets.source_doc_id),
       tags_json = excluded.tags_json`
  ).run(id, input.kind, title, content, input.sourceDocId ?? null, JSON.stringify(tags), createdAt)
  return {
    id,
    kind: input.kind,
    title,
    content,
    sourceDocId: input.sourceDocId,
    tags,
    createdAt
  }
}

export function deleteStudySnippet(db: DatabaseSync, id: string): boolean {
  const info = db.prepare('DELETE FROM study_snippets WHERE id = ?').run(id)
  return Number(info.changes ?? 0) > 0
}

export function saveSelfCheckConstructed(
  db: DatabaseSync,
  input: {
    promptId: string
    title: string
    content: string
    hitPoints: string[]
    totalPoints: number
    score: number
  }
): ConstructedAttemptRecord {
  const createdAt = now()
  const total = Math.max(1, Math.round(input.totalPoints))
  const hits = input.hitPoints.map((p) => p.trim()).filter(Boolean)
  const score = Math.max(0, Math.min(100, Math.round(input.score)))
  const evaluation: ConstructedEvaluation = {
    id: randomUUID(),
    promptId: input.promptId,
    score,
    dimensions: [
      {
        name: '采分点自查命中',
        score,
        comment: `已勾选命中 ${hits.length} / ${total} 个参考要点${hits.length ? `（${hits.slice(0, 4).join('、')}${hits.length > 4 ? ' 等' : ''}）` : ''}。`
      }
    ],
    summary: `自主对标参考要点自查：命中 ${hits.length}/${total} 个采分点，自评估分 ${score} 分。`,
    suggestions:
      hits.length < total
        ? ['优先回看未勾选的参考采分点，核对材料对应段落并重写二稿补全。']
        : ['已覆盖全部参考要点，可进一步精简表述或使用 AI 批改复核论证表达。'],
    createdAt,
    provider: 'self-check'
  }
  saveConstructedAttempt(db, {
    id: evaluation.id,
    promptId: input.promptId,
    title: input.title,
    content: input.content,
    evaluation,
    createdAt
  })
  return {
    id: evaluation.id,
    promptId: input.promptId,
    title: input.title,
    content: input.content,
    evaluation,
    createdAt
  }
}
