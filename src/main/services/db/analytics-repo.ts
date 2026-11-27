import type { DatabaseSync } from 'node:sqlite'
import type {
  DashboardData,
  LearningPlan,
  PlanItemType,
  ReportData
} from '../../../shared/contracts'
import { normalizeXingceModule } from '../../../shared/study-constants'
import { now } from '../../utils/common'
import {
  LOCAL_DATE,
  type Row,
  addDays,
  dateKey,
  numberValue,
  parseJson,
  runInTransaction
} from './mappers'
import { getActiveExam, getConstructedAttemptSummary } from './study-repo'
import { getAppSettings } from './system-repo'

export function savePlan(db: DatabaseSync, plan: LearningPlan): LearningPlan {
  const timestamp = now()
  runInTransaction(db, () => {
    if (plan.status === 'active')
      db.prepare(
        "UPDATE learning_plans SET status='cancelled', updated_at=? WHERE status='active'"
      ).run(timestamp)
    db.prepare(
      `INSERT INTO learning_plans(id, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, status=excluded.status, updated_at=excluded.updated_at`
    ).run(plan.id, JSON.stringify(plan), plan.status, plan.createdAt, timestamp)
  })
  return plan
}

export function getActivePlan(db: DatabaseSync): LearningPlan | undefined {
  const row = db
    .prepare(
      "SELECT payload_json FROM learning_plans WHERE status='active' ORDER BY updated_at DESC LIMIT 1"
    )
    .get() as Row | undefined
  if (!row) return undefined
  const plan = parseJson<LearningPlan | undefined>(row.payload_json, undefined)
  if (!plan) return undefined
  const completionRows = db
    .prepare('SELECT item_id, completed FROM plan_completions WHERE plan_id=?')
    .all(plan.id) as Row[]
  const completions = new Map(
    completionRows.map((item) => [String(item.item_id), numberValue(item.completed)])
  )
  plan.items = plan.items.map((item) => {
    const completed = completions.get(item.id) ?? item.completed
    return { ...item, completed, done: completed >= item.target }
  })
  return plan
}

export function completePlanItem(
  db: DatabaseSync,
  planId: string,
  itemId: string,
  completed: number
): LearningPlan {
  const plan = getActivePlan(db)
  if (!plan || plan.id !== planId) throw new Error('当前学习计划不存在')
  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (!item) throw new Error('计划项不存在')
  const safeCompleted = Math.max(0, Math.min(item.target, Math.round(completed)))
  db.prepare(
    `INSERT INTO plan_completions(plan_id,item_id,completed,completed_at) VALUES(?,?,?,?)
    ON CONFLICT(plan_id,item_id) DO UPDATE SET completed=excluded.completed, completed_at=excluded.completed_at`
  ).run(planId, itemId, safeCompleted, now())
  const updated = getActivePlan(db)!
  if (updated.items.every((candidate) => candidate.done)) {
    updated.status = 'completed'
    db.prepare(
      "UPDATE learning_plans SET status='completed', payload_json=?, updated_at=? WHERE id=?"
    ).run(JSON.stringify(updated), now(), planId)
  }
  return updated
}

export function cancelPlan(db: DatabaseSync, planId: string): void {
  db.prepare("UPDATE learning_plans SET status='cancelled', updated_at=? WHERE id=?").run(
    now(),
    planId
  )
}

function localDayStart(value: string | Date): number {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 0
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function extractPlanItemCategory(title: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim()
  const idx = title.indexOf('：')
  if (idx < 0) return ''
  return title
    .slice(idx + 1)
    .replace(/核心方法$/, '')
    .trim()
}

function planCategoryMatches(itemCategory: string, eventCategory?: string): boolean {
  if (!itemCategory || itemCategory === '综合能力' || itemCategory === '全部') return true
  if (!eventCategory?.trim()) return true
  const left = normalizeXingceModule(itemCategory)
  const right = normalizeXingceModule(eventCategory)
  return (
    left === right ||
    itemCategory === eventCategory ||
    itemCategory.includes(eventCategory) ||
    eventCategory.includes(itemCategory)
  )
}

/** 联动日常刷题/复习/变式/阅读行为与当前活跃学习计划，满足目标题量时自动推进或勾选完成 */
export function syncActivePlanProgress(
  db: DatabaseSync,
  event: { type: PlanItemType; category?: string; delta: number }
): LearningPlan | undefined {
  const plan = getActivePlan(db)
  if (!plan || plan.status !== 'active' || !plan.items.length) return undefined
  const startMs = localDayStart(plan.startDate)
  const todayMs = localDayStart(new Date())
  const dayOffset = startMs ? Math.floor((todayMs - startMs) / 86_400_000) + 1 : 1
  const currentDay = Math.max(1, Math.min(plan.durationDays, dayOffset))
  const candidates = plan.items.filter(
    (item) =>
      !item.done &&
      item.type === event.type &&
      planCategoryMatches(extractPlanItemCategory(item.title, item.category), event.category)
  )
  const target =
    candidates.find((item) => item.day === currentDay) ??
    candidates.sort((a, b) => a.day - b.day)[0]
  if (!target) return undefined
  const step = Math.max(1, Math.round(event.delta))
  return completePlanItem(db, plan.id, target.id, target.completed + step)
}

export function getDashboard(db: DatabaseSync): DashboardData {
  const settings = getAppSettings(db)
  const today = dateKey()
  const todayRow = db
    .prepare(
      `SELECT COUNT(*) AS attempts, COALESCE(SUM(duration_seconds), 0) AS seconds,
      COALESCE(SUM(correct), 0) AS correct FROM attempts WHERE ${LOCAL_DATE} = ?`
    )
    .get(today) as Row
  const overall = db
    .prepare('SELECT COUNT(*) AS attempts, COALESCE(SUM(correct), 0) AS correct FROM attempts')
    .get() as Row
  const due = db
    .prepare(
      `SELECT COUNT(*) AS count FROM review_tasks r
      JOIN wrong_questions w ON w.question_id=r.question_id
      JOIN questions q ON q.id=w.question_id
      JOIN vault_registry v ON v.id=q.vault_id AND v.active=1
      WHERE r.completed_at IS NULL AND r.due_at <= ? AND w.mastered=0`
    )
    .get(now()) as Row
  const wrong = db
    .prepare(
      `SELECT COUNT(*) AS count FROM wrong_questions w
      JOIN questions q ON q.id=w.question_id
      JOIN vault_registry v ON v.id=q.vault_id AND v.active=1
      WHERE w.mastered=0`
    )
    .get() as Row
  const mastered = db
    .prepare(
      `SELECT COUNT(*) AS count FROM wrong_questions w
      JOIN questions q ON q.id=w.question_id
      JOIN vault_registry v ON v.id=q.vault_id AND v.active=1
      WHERE w.mastered=1`
    )
    .get() as Row
  const total = db
    .prepare(
      'SELECT COUNT(*) AS count FROM questions q JOIN vault_registry v ON v.id=q.vault_id WHERE v.active=1'
    )
    .get() as Row
  const recentRows = db
    .prepare(
      `SELECT a.id, a.question_id, a.correct, a.created_at, q.stem
      FROM attempts a LEFT JOIN questions q ON q.id=a.question_id ORDER BY a.created_at DESC LIMIT 8`
    )
    .all() as Row[]
  const activityRows = db
    .prepare(
      `SELECT ${LOCAL_DATE} AS date, COUNT(*) AS attempts,
      ROUND(100.0 * SUM(correct) / COUNT(*), 1) AS accuracy
      FROM attempts WHERE created_at >= ? GROUP BY ${LOCAL_DATE} ORDER BY date`
    )
    .all(addDays(-13)) as Row[]
  const subjectRows = db
    .prepare(
      `SELECT q.subject, COUNT(*) AS attempts,
      ROUND(100.0 * SUM(a.correct) / COUNT(*), 1) AS accuracy
      FROM attempts a JOIN questions q ON q.id=a.question_id
      JOIN vault_registry v ON v.id=q.vault_id AND v.active=1
      GROUP BY q.subject ORDER BY attempts DESC`
    )
    .all() as Row[]
  const learningDates = new Set(
    (
      db
        .prepare(`SELECT DISTINCT ${LOCAL_DATE} AS date FROM attempts ORDER BY date DESC`)
        .all() as Row[]
    ).map((row) => String(row.date))
  )
  let streak = 0
  const cursor = new Date()
  if (!learningDates.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (learningDates.has(dateKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  const attempts = numberValue(overall.attempts)
  return {
    todayAttempts: numberValue(todayRow.attempts),
    todayMinutes: Math.round(numberValue(todayRow.seconds) / 60),
    dailyTarget: settings.dailyTarget,
    accuracy: attempts ? Math.round((numberValue(overall.correct) / attempts) * 1000) / 10 : 0,
    dueReviews: numberValue(due.count),
    wrongQuestions: numberValue(wrong.count),
    masteredQuestions: numberValue(mastered.count),
    totalQuestions: numberValue(total.count),
    studyStreak: streak,
    subjectMastery: subjectRows.map((row) => ({
      subject: String(row.subject) as 'xingce' | 'shenlun',
      attempts: numberValue(row.attempts),
      accuracy: numberValue(row.accuracy)
    })),
    activeExam: getActiveExam(db),
    activePlan: getActivePlan(db),
    recentAttempts: recentRows.map((row) => ({
      id: String(row.id),
      questionId: String(row.question_id),
      questionTitle: String(row.stem ?? '知识库中已无此题'),
      correct: Boolean(row.correct),
      createdAt: String(row.created_at)
    })),
    activity: activityRows.map((row) => ({
      date: String(row.date),
      attempts: numberValue(row.attempts),
      accuracy: numberValue(row.accuracy)
    }))
  }
}

export function getReport(db: DatabaseSync, range: ReportData['range']): ReportData {
  const cutoff =
    range === '7d' ? addDays(-7) : range === '30d' ? addDays(-30) : '1970-01-01T00:00:00.000Z'
  const overall = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(correct),0) AS correct,
      COALESCE(SUM(duration_seconds),0) AS seconds FROM attempts WHERE created_at >= ?`
    )
    .get(cutoff) as Row
  const categoryRows = db
    .prepare(
      `SELECT CASE WHEN json_valid(a.question_snapshot_json) THEN COALESCE(NULLIF(json_extract(a.question_snapshot_json, '$.category'), ''), '未分类') ELSE '未分类' END AS category,
      COUNT(*) AS attempts, SUM(a.correct) AS correct, AVG(a.duration_seconds) AS duration
      FROM attempts a WHERE a.created_at >= ? GROUP BY category ORDER BY attempts DESC`
    )
    .all(cutoff) as Row[]
  const dailyRows = db
    .prepare(
      `SELECT ${LOCAL_DATE} AS date, COUNT(*) AS attempts, SUM(correct) AS correct,
      SUM(duration_seconds) AS seconds FROM attempts WHERE created_at >= ? GROUP BY ${LOCAL_DATE} ORDER BY date`
    )
    .all(cutoff) as Row[]
  const causeRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(trim(wrong_cause), ''), '未标注') AS cause, COUNT(*) AS count
      FROM attempts WHERE correct=0 AND created_at >= ? GROUP BY cause ORDER BY count DESC`
    )
    .all(cutoff) as Row[]
  const totalAttempts = numberValue(overall.total)
  const correctAttempts = numberValue(overall.correct)
  return {
    range,
    totalAttempts,
    correctAttempts,
    accuracy: totalAttempts ? Math.round((correctAttempts / totalAttempts) * 1000) / 10 : 0,
    studyMinutes: Math.round(numberValue(overall.seconds) / 60),
    categoryStats: categoryRows.map((row) => {
      const attempts = numberValue(row.attempts)
      const correct = numberValue(row.correct)
      return {
        category: String(row.category ?? '未分类'),
        attempts,
        correct,
        accuracy: attempts ? Math.round((correct / attempts) * 1000) / 10 : 0,
        averageDurationSeconds: Math.round(numberValue(row.duration))
      }
    }),
    dailyStats: dailyRows.map((row) => {
      const attempts = numberValue(row.attempts)
      return {
        date: String(row.date),
        attempts,
        accuracy: attempts ? Math.round((numberValue(row.correct) / attempts) * 1000) / 10 : 0,
        minutes: Math.round(numberValue(row.seconds) / 60)
      }
    }),
    wrongCauses: causeRows.map((row) => ({
      cause: String(row.cause),
      count: numberValue(row.count)
    })),
    essaySummary: getConstructedAttemptSummary(db, range)
  }
}
