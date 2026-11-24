import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AiConversation,
  AiMessage,
  AiTrainingRecord,
  AppSettings,
  BackupInfo
} from '../../../shared/contracts'
import { DEFAULT_SETTINGS, clampUiScale } from '../../../shared/defaults'
import { isAnswerCorrect } from '../../../shared/study-constants'
import { now } from '../../utils/common'
import { type Row, isValidCalendarDate, parseJson, runInTransaction } from './mappers'

export function getSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
  return row ? parseJson(row.value, fallback) : fallback
}

export function setSetting<T>(db: DatabaseSync, key: string, value: T): void {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), now())
}

export function getAppSettings(db: DatabaseSync): AppSettings {
  return { ...DEFAULT_SETTINGS, ...getSetting<Partial<AppSettings>>(db, 'app_settings', {}) }
}

export function saveAppSettings(db: DatabaseSync, patch: Partial<AppSettings>): AppSettings {
  const settings = { ...getAppSettings(db), ...patch }
  settings.uiScale = clampUiScale(settings.uiScale)
  settings.dailyTarget = Math.max(1, Math.min(500, Math.round(settings.dailyTarget)))
  settings.defaultPracticeCount = Math.max(
    1,
    Math.min(100, Math.round(settings.defaultPracticeCount))
  )
  settings.defaultExamMinutes = Math.max(10, Math.min(300, Math.round(settings.defaultExamMinutes)))
  settings.backupRetention = Math.max(1, Math.min(100, Math.round(settings.backupRetention)))
  settings.examGoalName =
    typeof settings.examGoalName === 'string' ? settings.examGoalName.trim().slice(0, 40) : ''
  const rawGoalDate = typeof settings.examGoalDate === 'string' ? settings.examGoalDate.trim() : ''
  settings.examGoalDate = isValidCalendarDate(rawGoalDate) ? rawGoalDate : ''
  settings.defaultRegion =
    typeof settings.defaultRegion === 'string' ? settings.defaultRegion.trim().slice(0, 40) : ''
  setSetting(db, 'app_settings', settings)
  return settings
}

export function getAiRecord(db: DatabaseSync): Row | undefined {
  return db.prepare('SELECT * FROM ai_config WHERE id=1').get() as Row | undefined
}

export function saveAiRecord(
  db: DatabaseSync,
  payloadJson: string,
  encryptedKey: string | null,
  verified: boolean,
  lastCheckedAt?: string,
  lastError?: string
): void {
  db.prepare(
    `INSERT INTO ai_config(id,payload_json,encrypted_key,verified,last_checked_at,last_error,updated_at)
    VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    payload_json=excluded.payload_json,
    encrypted_key=COALESCE(excluded.encrypted_key,ai_config.encrypted_key),
    verified=excluded.verified,last_checked_at=excluded.last_checked_at,last_error=excluded.last_error,updated_at=excluded.updated_at`
  ).run(
    payloadJson,
    encryptedKey,
    verified ? 1 : 0,
    lastCheckedAt ?? null,
    lastError ?? null,
    now()
  )
}

export function clearAiCredential(db: DatabaseSync): void {
  db.prepare(
    'UPDATE ai_config SET encrypted_key=NULL,verified=0,last_error=NULL,updated_at=? WHERE id=1'
  ).run(now())
}

export function getVlmRecord(db: DatabaseSync): Row | undefined {
  return db.prepare('SELECT * FROM vlm_config WHERE id=1').get() as Row | undefined
}

export function saveVlmRecord(
  db: DatabaseSync,
  payloadJson: string,
  encryptedKey: string | null,
  verified: boolean,
  lastCheckedAt?: string,
  lastError?: string
): void {
  db.prepare(
    `INSERT INTO vlm_config(id,payload_json,encrypted_key,verified,last_checked_at,last_error,updated_at)
    VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    payload_json=excluded.payload_json,
    encrypted_key=COALESCE(excluded.encrypted_key,vlm_config.encrypted_key),
    verified=excluded.verified,last_checked_at=excluded.last_checked_at,last_error=excluded.last_error,updated_at=excluded.updated_at`
  ).run(
    payloadJson,
    encryptedKey,
    verified ? 1 : 0,
    lastCheckedAt ?? null,
    lastError ?? null,
    now()
  )
}

export function clearVlmCredential(db: DatabaseSync): void {
  db.prepare(
    'UPDATE vlm_config SET encrypted_key=NULL,verified=0,last_error=NULL,updated_at=? WHERE id=1'
  ).run(now())
}

export function saveAiTrainingRecord(
  db: DatabaseSync,
  input: Omit<AiTrainingRecord, 'id' | 'correct' | 'createdAt'>
): AiTrainingRecord {
  const record: AiTrainingRecord = {
    ...input,
    id: randomUUID(),
    correct: isAnswerCorrect(input.answer, input.userAnswer),
    createdAt: now()
  }
  db.prepare(
    `INSERT INTO ai_training_attempts(id,source_question_id,variant_json,user_answer_json,correct,created_at)
    VALUES(?,?,?,?,?,?)`
  ).run(
    record.id,
    record.sourceQuestionId,
    JSON.stringify({
      stem: record.stem,
      options: record.options,
      answer: record.answer,
      explanation: record.explanation
    }),
    JSON.stringify(record.userAnswer),
    record.correct ? 1 : 0,
    record.createdAt
  )
  return record
}

export function listAiTrainingRecords(db: DatabaseSync): AiTrainingRecord[] {
  const rows = db
    .prepare('SELECT * FROM ai_training_attempts ORDER BY created_at DESC LIMIT 100')
    .all() as Row[]
  return rows.map((row) => {
    const variant = parseJson<{
      stem: string
      options: AiTrainingRecord['options']
      answer: string[]
      explanation: string
    }>(row.variant_json, { stem: '', options: [], answer: [], explanation: '' })
    const userAnswer = parseJson<string[]>(row.user_answer_json, [])
    return {
      id: String(row.id),
      sourceQuestionId: String(row.source_question_id),
      ...variant,
      userAnswer,
      correct: Boolean(row.correct),
      createdAt: String(row.created_at)
    }
  })
}

export function getIntegrationRecord(db: DatabaseSync): Row | undefined {
  return db.prepare('SELECT * FROM integrations WHERE id=1').get() as Row | undefined
}

export function saveIntegrationRecord(db: DatabaseSync, payloadJson: string): void {
  db.prepare(
    `INSERT INTO integrations(id,payload_json,updated_at) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`
  ).run(payloadJson, now())
}

export function listAiConversations(db: DatabaseSync, limit = 50): AiConversation[] {
  const safeLimit = Math.max(
    1,
    Math.min(100, Math.round(Number.isFinite(limit) ? Number(limit) : 50))
  )
  const rows = db
    .prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC LIMIT ?')
    .all(safeLimit) as Row[]
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    questionId: row.question_id ? String(row.question_id) : undefined,
    messages: parseJson<AiMessage[]>(row.messages_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }))
}

export function saveAiConversation(
  db: DatabaseSync,
  input: {
    id?: string
    title: string
    questionId?: string
    messages: AiMessage[]
  }
): AiConversation {
  const timestamp = now()
  const id = input.id?.trim() || randomUUID()
  const existing = db
    .prepare('SELECT created_at, question_id FROM ai_conversations WHERE id = ?')
    .get(id) as Row | undefined
  const createdAt = existing ? String(existing.created_at) : timestamp
  const title = (input.title || '新对话').trim().slice(0, 60) || '新对话'
  const cleanMessages: AiMessage[] = (Array.isArray(input.messages) ? input.messages : [])
    .slice(-100)
    .filter(
      (m): m is AiMessage =>
        Boolean(m) &&
        (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
        typeof m.content === 'string'
    )
    .map((m) => ({ role: m.role, content: m.content }))
  const resolvedQuestionId =
    input.questionId?.trim() || (existing?.question_id ? String(existing.question_id) : null)
  db.prepare(
    `INSERT INTO ai_conversations(id, title, question_id, messages_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       question_id = COALESCE(excluded.question_id, ai_conversations.question_id),
       messages_json = excluded.messages_json,
       updated_at = excluded.updated_at`
  ).run(id, title, resolvedQuestionId, JSON.stringify(cleanMessages), createdAt, timestamp)
  return {
    id,
    title,
    questionId: resolvedQuestionId ?? undefined,
    messages: cleanMessages,
    createdAt,
    updatedAt: timestamp
  }
}

export function deleteAiConversation(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
}

export function createBackup(
  db: DatabaseSync,
  databasePath: string,
  backupDirectory: string,
  reason: BackupInfo['reason'] = 'manual'
): BackupInfo {
  db.exec('PRAGMA wal_checkpoint(FULL)')
  const createdAt = now()
  const safeTime = createdAt.replace(/[:.]/g, '-')
  const path = join(backupDirectory, `workbench-${reason}-${safeTime}.sqlite`)
  copyFileSync(databasePath, path)
  return { id: basename(path), path, createdAt, size: statSync(path).size, reason }
}

export function listBackups(backupDirectory: string): BackupInfo[] {
  if (!existsSync(backupDirectory)) return []
  return readdirSync(backupDirectory)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const path = join(backupDirectory, name)
      const stat = statSync(path)
      const reason: BackupInfo['reason'] = name.includes('-pre-restore-')
        ? 'pre-restore'
        : name.includes('-automatic-')
          ? 'automatic'
          : 'manual'
      return { id: name, path, createdAt: stat.birthtime.toISOString(), size: stat.size, reason }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function validateBackup(path: string): void {
  const size = statSync(path).size
  if (size <= 0 || size > 1024 * 1024 * 1024) throw new Error('备份文件为空或超过 1 GB 上限')
  let candidate: DatabaseSync | undefined
  try {
    candidate = new DatabaseSync(path, { readOnly: true })
    const integrity = candidate.prepare('PRAGMA integrity_check').get() as Row
    if (String(Object.values(integrity)[0] ?? '') !== 'ok')
      throw new Error('备份数据库完整性检查未通过')
    const tables = candidate
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_meta','settings','vault_registry')"
      )
      .all() as Row[]
    if (tables.length !== 3) throw new Error('备份缺少工作台核心数据表')
  } catch (error) {
    throw new Error(`备份验证失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    candidate?.close()
  }
}

export function pruneBackups(backupDirectory: string, retention: number): void {
  const backups = listBackups(backupDirectory)
  for (const backup of backups.slice(Math.max(1, retention))) unlinkSync(backup.path)
}

export function integrityCheck(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA integrity_check').get() as Row
  return String(Object.values(row)[0] ?? 'unknown')
}

export function databaseSize(databasePath: string): number {
  return existsSync(databasePath) ? statSync(databasePath).size : 0
}

export function resetLearningData(db: DatabaseSync): void {
  runInTransaction(db, () => {
    for (const table of [
      'attempts',
      'wrong_questions',
      'review_tasks',
      'favorites',
      'user_notes',
      'learning_sessions',
      'exam_sessions',
      'constructed_drafts',
      'constructed_attempts',
      'plan_completions',
      'learning_plans',
      'ai_training_attempts',
      'ai_conversations'
    ]) {
      db.exec(`DELETE FROM ${table}`)
    }
  })
}
