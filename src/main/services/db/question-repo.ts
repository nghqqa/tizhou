import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  KnowledgeDocument,
  PaperProgressItem,
  Question,
  QuestionFacets,
  QuestionLibraryItem,
  QuestionSummary,
  QuestionUserMeta,
  ShenlunPaperSummary,
  Subject,
  VaultIndexResult,
  VaultInfo,
  VaultSnapshotInfo
} from '../../../shared/contracts'
import {
  UNLABELED_REGION_FILTER,
  expandRegionAliases,
  extractRegionFromText,
  normalizeRegionName
} from '../../../shared/region'
import { inspectShenlunMaterialQuality } from '../../../shared/shenlun'
import { now } from '../../utils/common'
import { directSignature } from '../question-import'
import {
  DOCUMENT_SEARCH_COLUMNS,
  LIBRARY_SEARCH_COLUMNS,
  type QuestionListFilter,
  type Row,
  type ShenlunQualityEntry,
  type SqlValue,
  type VaultQueryCaches,
  appendKeywordFilter,
  buildQuestionFilter,
  mapDocument,
  mapQuestion,
  mapVault,
  numberValue,
  parseJson,
  runInTransaction
} from './mappers'

export function upsertVault(db: DatabaseSync, vault: VaultInfo, active = true): void {
  if (active) db.prepare('UPDATE vault_registry SET active = 0').run()
  db.prepare(
    `INSERT INTO vault_registry(
      id, name, path, connected_at, last_indexed_at, question_count, document_count,
      warnings_json, is_builtin, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, path = excluded.path, last_indexed_at = excluded.last_indexed_at,
      question_count = excluded.question_count, document_count = excluded.document_count,
      warnings_json = excluded.warnings_json, active = excluded.active`
  ).run(
    vault.id,
    vault.name,
    vault.path,
    vault.connectedAt,
    vault.lastIndexedAt,
    vault.questionCount,
    vault.documentCount,
    JSON.stringify(vault.warnings),
    vault.isBuiltin ? 1 : 0,
    active ? 1 : 0
  )
}

export function getActiveVault(db: DatabaseSync): VaultInfo | undefined {
  const row = db.prepare('SELECT * FROM vault_registry WHERE active = 1 LIMIT 1').get() as
    Row | undefined
  return row ? mapVault(row) : undefined
}

export function getVaultById(db: DatabaseSync, id: string): VaultInfo | undefined {
  const row = db.prepare('SELECT * FROM vault_registry WHERE id=?').get(id) as Row | undefined
  return row ? mapVault(row) : undefined
}

export function listVaults(db: DatabaseSync): VaultInfo[] {
  const rows = db
    .prepare('SELECT * FROM vault_registry ORDER BY active DESC, last_indexed_at DESC')
    .all() as Row[]
  return rows.map((row) => mapVault(row))
}

export function switchVault(db: DatabaseSync, id: string, caches: VaultQueryCaches): VaultInfo {
  const row = db.prepare('SELECT * FROM vault_registry WHERE id=?').get(id) as Row | undefined
  if (!row) throw new Error('知识库不存在')
  runInTransaction(db, () => {
    db.prepare('UPDATE vault_registry SET active=0').run()
    db.prepare('UPDATE vault_registry SET active=1 WHERE id=?').run(id)
  })
  caches.facets.clear()
  caches.shenlunQuality = null
  return mapVault(row)
}

export function clearActiveVaultWarnings(db: DatabaseSync): void {
  db.prepare("UPDATE vault_registry SET warnings_json='[]' WHERE active=1").run()
}

export function listVaultQuestionIndexMeta(
  db: DatabaseSync,
  vaultId: string
): Array<{
  id: string
  filePath: string
  contentHash: string
  fileMtimeMs?: number
  fileSize?: number
}> {
  const rows = db
    .prepare(
      'SELECT id, file_path, content_hash, file_mtime_ms, file_size FROM questions WHERE vault_id = ?'
    )
    .all(vaultId) as Row[]
  return rows.map((row) => ({
    id: String(row.id),
    filePath: row.file_path == null ? '' : String(row.file_path),
    contentHash: String(row.content_hash),
    fileMtimeMs:
      row.file_mtime_ms === null || row.file_mtime_ms === undefined
        ? undefined
        : numberValue(row.file_mtime_ms),
    fileSize:
      row.file_size === null || row.file_size === undefined ? undefined : numberValue(row.file_size)
  }))
}

export function listVaultQuestions(db: DatabaseSync, vaultId: string): Question[] {
  const rows = db
    .prepare('SELECT * FROM questions WHERE vault_id = ? ORDER BY id')
    .all(vaultId) as Row[]
  return rows.map((row) => mapQuestion(row))
}

export function replaceVaultContent(
  db: DatabaseSync,
  caches: VaultQueryCaches,
  vault: VaultInfo,
  questions: Array<
    | Question
    | {
        id: string
        contentHash: string
        filePath?: string
        fileMtimeMs?: number
        fileSize?: number
        _reused: true
      }
  >,
  documents: KnowledgeDocument[],
  captureSnapshot = true
): { added: number; updated: number; removed: number } {
  const previousRows = db
    .prepare(
      'SELECT id, content_hash, file_path, file_mtime_ms, file_size FROM questions WHERE vault_id = ?'
    )
    .all(vault.id) as Row[]
  const previous = new Map(previousRows.map((row) => [String(row.id), String(row.content_hash)]))
  const previousPaths = new Map(
    previousRows.map((row) => [String(row.id), row.file_path == null ? '' : String(row.file_path)])
  )
  const previousStat = new Map(
    previousRows.map((row) => [
      String(row.id),
      {
        mtime: row.file_mtime_ms == null ? undefined : numberValue(row.file_mtime_ms),
        size: row.file_size == null ? undefined : numberValue(row.file_size)
      }
    ])
  )
  let added = 0
  let updated = 0
  for (const question of questions) {
    if (!previous.has(question.id)) added += 1
    else if (previous.get(question.id) !== question.contentHash) updated += 1
  }
  const incomingIds = new Set(questions.map((question) => question.id))
  const removed = previousRows.filter((row) => !incomingIds.has(String(row.id))).length

  const previousDocuments = db
    .prepare('SELECT * FROM documents WHERE vault_id=? ORDER BY id')
    .all(vault.id) as Row[]
  const previousVault = getVaultById(db, vault.id) ?? vault
  runInTransaction(db, () => {
    upsertVault(db, vault)
    if (
      captureSnapshot &&
      previousRows.length + previousDocuments.length > 0 &&
      added + updated + removed > 0
    ) {
      const snapshotId = randomUUID()
      const payload = gzipSync(
        JSON.stringify({
          vault: previousVault,
          // 整库一次查询取快照，逐题 getQuestion 在 2 万题级别会把重索引拖慢数十秒
          questions: listVaultQuestions(db, vault.id),
          documents: previousDocuments.map((row) => mapDocument(row))
        })
      )
      db.prepare(
        'INSERT INTO vault_snapshots(id,vault_id,created_at,question_count,document_count,payload) VALUES(?,?,?,?,?,?)'
      ).run(snapshotId, vault.id, now(), previousRows.length, previousDocuments.length, payload)
      db.prepare(
        `DELETE FROM vault_snapshots WHERE id IN (
          SELECT id FROM vault_snapshots WHERE vault_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 5
        )`
      ).run(vault.id)
    }
    db.prepare('DELETE FROM documents WHERE vault_id = ?').run(vault.id)
    const upsertQuestion = db.prepare(`INSERT INTO questions(
      id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
      difficulty, source, year, region, paper, material, content_version, tags_json, file_path,
      content_hash, papers_json, group_id, group_order, file_mtime_ms, file_size, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      vault_id=excluded.vault_id, subject=excluded.subject, category=excluded.category,
      type=excluded.type, stem=excluded.stem, options_json=excluded.options_json,
      answer_json=excluded.answer_json, explanation=excluded.explanation,
      difficulty=excluded.difficulty, source=excluded.source, year=excluded.year,
      region=excluded.region, paper=excluded.paper, material=excluded.material,
      content_version=excluded.content_version,
      tags_json=excluded.tags_json, file_path=excluded.file_path,
      content_hash=excluded.content_hash, papers_json=excluded.papers_json,
      group_id=excluded.group_id, group_order=excluded.group_order,
      file_mtime_ms=excluded.file_mtime_ms, file_size=excluded.file_size,
      indexed_at=excluded.indexed_at`)
    const updateFileStat = db.prepare(
      'UPDATE questions SET file_mtime_ms = ?, file_size = ? WHERE id = ?'
    )
    for (const question of questions) {
      // 内容哈希与路径都未变的题不重写：全量 upsert 在大库上是重索引的主要开销之一；
      // 路径也参与比较，文件被移动时哈希虽同仍需更新 file_path（题图按文件位置定位）
      if (
        previous.get(question.id) === question.contentHash &&
        previousPaths.get(question.id) === (question.filePath ?? '')
      ) {
        const prevStat = previousStat.get(question.id)
        if (
          question.fileMtimeMs !== undefined &&
          question.fileSize !== undefined &&
          (prevStat?.mtime !== question.fileMtimeMs || prevStat?.size !== question.fileSize)
        ) {
          updateFileStat.run(question.fileMtimeMs, question.fileSize, question.id)
        }
        continue
      }
      if ('_reused' in question) continue
      upsertQuestion.run(
        question.id,
        vault.id,
        question.subject,
        question.category,
        question.type,
        question.stem,
        JSON.stringify(question.options),
        JSON.stringify(question.answer),
        question.explanation,
        question.difficulty,
        question.source,
        question.year ?? null,
        question.region ?? null,
        question.paper ?? null,
        question.material ?? null,
        question.contentVersion ?? null,
        JSON.stringify(question.tags),
        question.filePath ?? null,
        question.contentHash,
        question.papers?.length ? JSON.stringify(question.papers) : null,
        question.groupId ?? null,
        question.groupOrder ?? null,
        question.fileMtimeMs ?? null,
        question.fileSize ?? null,
        now()
      )
    }
    const removeQuestion = db.prepare('DELETE FROM questions WHERE id = ? AND vault_id = ?')
    for (const row of previousRows) {
      const id = String(row.id)
      if (!incomingIds.has(id)) removeQuestion.run(id, vault.id)
    }
    const insertDocument = db.prepare(`INSERT INTO documents(
      id, vault_id, subject, kind, title, summary, content, tags_json, file_path, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const document of documents) {
      insertDocument.run(
        document.id,
        vault.id,
        document.subject,
        document.kind,
        document.title,
        document.summary,
        document.content,
        JSON.stringify(document.tags),
        document.filePath ?? null,
        now()
      )
    }
  })
  caches.facets.clear()
  caches.shenlunQuality = null
  return { added, updated, removed }
}

/** 单题就地勘误写库：增量更新单题行并同步未结束训练会话快照 */
export function upsertSingleQuestion(
  db: DatabaseSync,
  caches: VaultQueryCaches,
  vaultId: string,
  question: Question
): void {
  const updatedAt = now()
  runInTransaction(db, () => {
    const info = db
      .prepare(
        `UPDATE questions SET
          subject=?, category=?, type=?, stem=?, options_json=?, answer_json=?,
          explanation=?, difficulty=?, source=?, year=?, region=?, paper=?,
          material=?, content_version=?, tags_json=?, file_path=?, content_hash=?,
          papers_json=?, group_id=?, group_order=?, file_mtime_ms=?, file_size=?, indexed_at=?
        WHERE id=? AND vault_id=?`
      )
      .run(
        question.subject,
        question.category,
        question.type,
        question.stem,
        JSON.stringify(question.options),
        JSON.stringify(question.answer),
        question.explanation,
        question.difficulty,
        question.source,
        question.year ?? null,
        question.region ?? null,
        question.paper ?? null,
        question.material ?? null,
        question.contentVersion ?? null,
        JSON.stringify(question.tags),
        question.filePath ?? null,
        question.contentHash,
        question.papers?.length ? JSON.stringify(question.papers) : null,
        question.groupId ?? null,
        question.groupOrder ?? null,
        question.fileMtimeMs ?? null,
        question.fileSize ?? null,
        updatedAt,
        question.id,
        vaultId
      )
    if (!info.changes) throw new Error('题目在当前知识库中不存在或已被删除')
    db.prepare('UPDATE vault_registry SET last_indexed_at=? WHERE id=?').run(updatedAt, vaultId)
    const activeSessions = db
      .prepare('SELECT id, metadata_json FROM learning_sessions WHERE ended_at IS NULL')
      .all() as Row[]
    const updateSessionStmt = db.prepare('UPDATE learning_sessions SET metadata_json=? WHERE id=?')
    for (const row of activeSessions) {
      const metadata = parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined)
      const snapshots = metadata?.questionSnapshots as Record<string, Question> | undefined
      if (!snapshots || !snapshots[question.id]) continue
      snapshots[question.id] = question
      metadata!.updatedAt = updatedAt
      updateSessionStmt.run(JSON.stringify(metadata), String(row.id))
    }
  })
  caches.facets.clear()
  caches.shenlunQuality = null
}

function getShenlunQualityMap(
  db: DatabaseSync,
  caches: VaultQueryCaches
): Map<string, ShenlunQualityEntry> {
  if (caches.shenlunQuality) return caches.shenlunQuality
  const map = new Map<string, ShenlunQualityEntry>()
  const rows = db
    .prepare(
      `SELECT q.id, q.material, q.explanation
       FROM questions q
       JOIN vault_registry v ON v.id = q.vault_id
       WHERE v.active = 1 AND q.subject = 'shenlun'`
    )
    .all() as Row[]
  for (const row of rows) {
    const report = inspectShenlunMaterialQuality(row.material ? String(row.material) : '', {
      explanation: row.explanation ? String(row.explanation) : ''
    })
    map.set(String(row.id), {
      materialQuality: report.level,
      materialIssues: report.issues,
      hasReferenceAnswer: report.hasReferenceAnswer
    })
  }
  caches.shenlunQuality = map
  return map
}

export function listQuestionSummaries(
  db: DatabaseSync,
  caches: VaultQueryCaches,
  filter: QuestionListFilter = {}
): QuestionSummary[] {
  const { where, values } = buildQuestionFilter(filter)
  const rawLimit = Number.isFinite(filter.limit) ? Number(filter.limit) : 500
  const limit = Math.max(1, Math.min(5000, Math.round(rawLimit)))
  const rows = db
    .prepare(
      `SELECT q.id, q.subject, q.category, q.type, q.difficulty, q.source,
              q.year, q.region, q.paper, substr(q.stem, 1, 160) AS stem_preview
       FROM questions q JOIN vault_registry v ON v.id = q.vault_id
       WHERE ${where.join(' AND ')} ORDER BY q.year DESC, q.category, q.id LIMIT ?`
    )
    .all(...values, limit) as Row[]
  const qualityMap =
    filter.subject === 'shenlun' || rows.some((row) => String(row.subject) === 'shenlun')
      ? getShenlunQualityMap(db, caches)
      : null
  return rows.map((row) => {
    const id = String(row.id)
    const quality = qualityMap?.get(id)
    return {
      id,
      subject: String(row.subject) as Question['subject'],
      category: String(row.category),
      type: String(row.type) as Question['type'],
      difficulty: numberValue(row.difficulty) as Question['difficulty'],
      source: String(row.source),
      year: row.year === null || row.year === undefined ? undefined : numberValue(row.year),
      region: row.region ? String(row.region) : undefined,
      paper: row.paper ? String(row.paper) : undefined,
      stemPreview: String(row.stem_preview ?? ''),
      ...(quality
        ? {
            materialQuality: quality.materialQuality,
            materialIssues: quality.materialIssues,
            hasReferenceAnswer: quality.hasReferenceAnswer
          }
        : {})
    }
  })
}

export function listQuestions(db: DatabaseSync, filter: QuestionListFilter = {}): Question[] {
  const { where, values } = buildQuestionFilter(filter)
  const rawLimit = Number.isFinite(filter.limit) ? Number(filter.limit) : 500
  const limit = Math.max(1, Math.min(5000, Math.round(rawLimit)))
  const rows = db
    .prepare(
      `SELECT q.* FROM questions q JOIN vault_registry v ON v.id = q.vault_id
      WHERE ${where.join(' AND ')} ORDER BY q.year DESC, q.category, q.id LIMIT ?`
    )
    .all(...values, limit) as Row[]
  return rows.map((row) => mapQuestion(row))
}

export function listQuestionsForPool(
  db: DatabaseSync,
  filter: QuestionListFilter = {}
): Question[] {
  const { where, values } = buildQuestionFilter(filter)
  const hasExplicitLimit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
  const sql =
    `SELECT q.* FROM questions q JOIN vault_registry v ON v.id = q.vault_id ` +
    `WHERE ${where.join(' AND ')} ORDER BY q.year DESC, q.category, q.id` +
    (hasExplicitLimit ? ' LIMIT ?' : '')
  const queryValues = hasExplicitLimit
    ? [...values, Math.max(1, Math.round(filter.limit!))]
    : values
  const rows = db.prepare(sql).all(...queryValues) as Row[]
  return rows.map((row) => mapQuestion(row))
}

export function listQuestionsByPaper(db: DatabaseSync, paper: string): Question[] {
  const rows = db
    .prepare(
      `SELECT q.*, json_extract(ref.value, '$.order') AS paper_order
      FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id AND v.active = 1
      JOIN json_each(CASE WHEN json_valid(q.papers_json) AND json_type(q.papers_json) = 'array' THEN q.papers_json ELSE '[]' END) ref
        ON json_extract(ref.value, '$.paper') = ?
      WHERE q.subject = 'xingce'
      ORDER BY paper_order, q.id`
    )
    .all(paper) as Row[]
  return rows.map((row) => mapQuestion(row))
}

export function getQuestion(db: DatabaseSync, id: string): Question | undefined {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined
  return row ? mapQuestion(row) : undefined
}

export function listQuestionLibrary(
  db: DatabaseSync,
  params: {
    tab: 'wrong' | 'favorite' | 'notes'
    category?: string
    categories?: string[]
    wrongCause?: string
    query?: string
    minWrongCount?: number
    limit?: number
  }
): QuestionLibraryItem[] {
  if (params.tab !== 'wrong' && params.tab !== 'favorite' && params.tab !== 'notes') {
    throw new Error('不支持的题单类型')
  }
  const where = ['v.active = 1']
  const values: SqlValue[] = []
  let joinSql = ''
  let orderSql = ''
  if (params.tab === 'wrong') {
    joinSql = `
      JOIN wrong_questions w ON w.question_id = q.id AND w.mastered = 0
      LEFT JOIN review_tasks rt ON rt.question_id = q.id
      LEFT JOIN favorites f ON f.question_id = q.id
      LEFT JOIN user_notes n ON n.question_id = q.id`
    orderSql = 'w.last_attempt_at DESC, w.wrong_count DESC'
    if (params.wrongCause?.trim()) {
      if (params.wrongCause.trim() === '未标注') {
        where.push("(w.last_wrong_cause IS NULL OR trim(w.last_wrong_cause) = '')")
      } else {
        where.push('w.last_wrong_cause = ?')
        values.push(params.wrongCause.trim())
      }
    }
    if (params.minWrongCount && params.minWrongCount > 0) {
      where.push('w.wrong_count >= ?')
      values.push(Math.round(params.minWrongCount))
    }
  } else if (params.tab === 'favorite') {
    joinSql = `
      JOIN favorites f ON f.question_id = q.id
      LEFT JOIN wrong_questions w ON w.question_id = q.id
      LEFT JOIN review_tasks rt ON rt.question_id = q.id
      LEFT JOIN user_notes n ON n.question_id = q.id`
    orderSql = 'f.created_at DESC'
  } else {
    joinSql = `
      JOIN user_notes n ON n.question_id = q.id AND trim(n.content) != ''
      LEFT JOIN wrong_questions w ON w.question_id = q.id
      LEFT JOIN review_tasks rt ON rt.question_id = q.id
      LEFT JOIN favorites f ON f.question_id = q.id`
    orderSql = 'n.updated_at DESC'
  }
  const categories = [
    ...new Set((params.categories ?? []).map((item) => item.trim()).filter(Boolean))
  ]
  if (categories.length > 0) {
    where.push(`q.category IN (${categories.map(() => '?').join(',')})`)
    values.push(...categories)
  } else if (params.category?.trim()) {
    where.push('q.category = ?')
    values.push(params.category.trim())
  }
  appendKeywordFilter(where, values, params.query, LIBRARY_SEARCH_COLUMNS)
  const rawLimit = Number.isFinite(params.limit) ? Number(params.limit) : 200
  const limit = Math.max(1, Math.min(500, Math.round(rawLimit)))
  const rows = db
    .prepare(
      `SELECT q.*,
        COALESCE(w.wrong_count, 0) AS wrong_count,
        COALESCE(w.correct_streak, 0) AS correct_streak,
        w.last_wrong_cause AS last_wrong_cause,
        w.last_attempt_at AS last_attempt_at,
        rt.due_at AS due_at,
        CASE WHEN f.question_id IS NOT NULL THEN 1 ELSE 0 END AS is_favorite,
        COALESCE(n.content, '') AS note_content,
        n.updated_at AS note_updated_at
      FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id
      ${joinSql}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderSql}
      LIMIT ?`
    )
    .all(...values, limit) as Row[]
  return rows.map((row) => ({
    question: mapQuestion(row),
    wrongCount: numberValue(row.wrong_count),
    correctStreak: numberValue(row.correct_streak),
    lastWrongCause: row.last_wrong_cause ? String(row.last_wrong_cause) : undefined,
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : undefined,
    dueAt: row.due_at ? String(row.due_at) : undefined,
    favorite: Boolean(row.is_favorite),
    note: String(row.note_content ?? ''),
    noteUpdatedAt: row.note_updated_at ? String(row.note_updated_at) : undefined
  }))
}

export function getQuestionsByIds(db: DatabaseSync, ids: string[]): Question[] {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 200)
  if (!uniqueIds.length) return []
  const placeholders = uniqueIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`)
    .all(...uniqueIds) as Row[]
  const byId = new Map(rows.map((row) => [String(row.id), mapQuestion(row)]))
  return uniqueIds.map((id) => byId.get(id)).filter((item): item is Question => Boolean(item))
}

export function getQuestionsUserMeta(
  db: DatabaseSync,
  questionIds: string[]
): Record<string, QuestionUserMeta> {
  const uniqueIds = [...new Set(questionIds.map((id) => id.trim()).filter(Boolean))].slice(0, 500)
  const result: Record<string, QuestionUserMeta> = {}
  for (const id of uniqueIds) {
    result[id] = { favorite: false, note: '' }
  }
  if (!uniqueIds.length) return result
  const placeholders = uniqueIds.map(() => '?').join(',')
  const favRows = db
    .prepare(`SELECT question_id FROM favorites WHERE question_id IN (${placeholders})`)
    .all(...uniqueIds) as Row[]
  for (const row of favRows) {
    const id = String(row.question_id)
    if (result[id]) result[id]!.favorite = true
  }
  const noteRows = db
    .prepare(`SELECT question_id, content FROM user_notes WHERE question_id IN (${placeholders})`)
    .all(...uniqueIds) as Row[]
  for (const row of noteRows) {
    const id = String(row.question_id)
    if (result[id]) result[id]!.note = String(row.content ?? '')
  }
  const wrongRows = db
    .prepare(
      `SELECT question_id, last_wrong_cause FROM wrong_questions WHERE question_id IN (${placeholders})`
    )
    .all(...uniqueIds) as Row[]
  for (const row of wrongRows) {
    const id = String(row.question_id)
    if (result[id] && row.last_wrong_cause) {
      result[id]!.wrongCause = String(row.last_wrong_cause)
    }
  }
  return result
}

export function setWrongQuestionCause(
  db: DatabaseSync,
  questionId: string,
  wrongCause: string
): void {
  const trimmed = wrongCause.trim().slice(0, 40)
  const exists = db.prepare('SELECT 1 FROM wrong_questions WHERE question_id = ?').get(questionId)
  if (exists) {
    db.prepare('UPDATE wrong_questions SET last_wrong_cause = ? WHERE question_id = ?').run(
      trimmed || null,
      questionId
    )
  }
}

export function listPapers(
  db: DatabaseSync
): Array<{ paper: string; count: number; year?: number }> {
  const rows = db
    .prepare(
      `SELECT q.papers_json, q.year FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id
      WHERE v.active = 1 AND q.papers_json IS NOT NULL AND q.subject = 'xingce'`
    )
    .all() as Row[]
  const papers = new Map<string, { count: number; year?: number }>()
  for (const row of rows) {
    const refs = parseJson(row.papers_json, []) as Array<{ paper: string }>
    for (const ref of refs) {
      if (!ref?.paper) continue
      const entry = papers.get(ref.paper) ?? {
        count: 0,
        year: row.year === null ? undefined : numberValue(row.year)
      }
      entry.count += 1
      papers.set(ref.paper, entry)
    }
  }
  return [...papers]
    .map(([paper, info]) => ({ paper, count: info.count, year: info.year }))
    .filter((entry) => entry.count >= 30)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.count - a.count)
}

export function listShenlunPapers(db: DatabaseSync): ShenlunPaperSummary[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.paper, q.papers_json, q.year, q.region FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id
      WHERE v.active = 1 AND q.subject = 'shenlun'`
    )
    .all() as Row[]
  const byPaper = new Map<string, { ids: Set<string>; year?: number; region?: string }>()
  for (const row of rows) {
    const qId = String(row.id)
    const refs = parseJson<Array<{ paper?: string }>>(row.papers_json, [])
    const paperNames = new Set<string>()
    if (row.paper && String(row.paper).trim()) paperNames.add(String(row.paper).trim())
    for (const ref of refs) {
      if (ref?.paper?.trim()) paperNames.add(ref.paper.trim())
    }
    const year = row.year === null ? undefined : numberValue(row.year)
    const region = row.region
      ? normalizeRegionName(String(row.region)) || String(row.region)
      : undefined
    for (const paper of paperNames) {
      let bucket = byPaper.get(paper)
      if (!bucket) {
        bucket = { ids: new Set(), year, region }
        byPaper.set(paper, bucket)
      }
      bucket.ids.add(qId)
      if (!bucket.year && year) bucket.year = year
      if (!bucket.region && region) bucket.region = region
    }
  }
  return [...byPaper.entries()]
    .map(([paper, info]) => ({
      paper,
      count: info.ids.size,
      year: info.year,
      region: info.region || extractRegionFromText(paper) || undefined
    }))
    .filter((item) => item.count >= 2)
    .sort(
      (a, b) =>
        (b.year ?? 0) - (a.year ?? 0) ||
        b.count - a.count ||
        a.paper.localeCompare(b.paper, 'zh-CN')
    )
}

export function listShenlunQuestionsByPaper(db: DatabaseSync, paper: string): Question[] {
  const target = paper.trim()
  if (!target) return []
  const rows = db
    .prepare(
      `SELECT q.* FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id AND v.active = 1
      WHERE q.subject = 'shenlun'
        AND (q.paper = ? OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(q.papers_json) AND json_type(q.papers_json) = 'array' THEN q.papers_json ELSE '[]' END) ref
          WHERE json_extract(ref.value, '$.paper') = ?
        ))
      ORDER BY COALESCE(q.group_order, 999), q.id`
    )
    .all(target, target) as Row[]
  const mapped = rows.map((row) => mapQuestion(row))
  const orderOf = (question: Question): number => {
    const matched = question.papers?.find((entry) => entry.paper === target)
    if (matched && Number.isFinite(matched.order)) return matched.order
    if (typeof question.groupOrder === 'number' && Number.isFinite(question.groupOrder)) {
      return question.groupOrder
    }
    return Number.MAX_SAFE_INTEGER
  }
  return mapped.sort((a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id))
}

export function listPaperProgressMatrix(db: DatabaseSync, subject?: Subject): PaperProgressItem[] {
  const attemptedSet = new Set(
    (db.prepare('SELECT DISTINCT question_id FROM attempts').all() as Row[]).map((r) =>
      String(r.question_id)
    )
  )
  const regionMap = new Map<string, string>()
  const questionRows = db
    .prepare(
      `SELECT q.id, q.subject, q.paper, q.papers_json, q.region FROM questions q
      JOIN vault_registry v ON v.id = q.vault_id AND v.active = 1
      WHERE (q.paper IS NOT NULL OR q.papers_json IS NOT NULL)`
    )
    .all() as Row[]
  const practicedByPaperSubject = new Map<string, Set<string>>()
  for (const row of questionRows) {
    const qId = String(row.id)
    const qSub = String(row.subject)
    const reg = row.region ? normalizeRegionName(String(row.region)) || String(row.region) : ''
    const names = new Set<string>()
    if (row.paper && String(row.paper).trim()) names.add(String(row.paper).trim())
    for (const ref of parseJson<Array<{ paper?: string }>>(row.papers_json, [])) {
      if (ref?.paper?.trim()) names.add(ref.paper.trim())
    }
    for (const name of names) {
      if (reg && !regionMap.has(name)) regionMap.set(name, reg)
      if (attemptedSet.has(qId)) {
        const key = `${qSub}\u0000${name}`
        let set = practicedByPaperSubject.get(key)
        if (!set) {
          set = new Set()
          practicedByPaperSubject.set(key, set)
        }
        set.add(qId)
      }
    }
  }
  const examRows = db
    .prepare('SELECT * FROM exam_sessions ORDER BY updated_at DESC LIMIT 500')
    .all() as Row[]
  const examsByKey = new Map<
    string,
    {
      finishedCount: number
      hasActiveExam: boolean
      latestExamId?: string
      latestScore?: number
      bestScore?: number
      latestDurationMinutes?: number
      latestFinishedAt?: string
    }
  >()
  for (const row of examRows) {
    const key = `${String(row.subject)}\u0000${String(row.title).trim()}`
    let stats = examsByKey.get(key)
    if (!stats) {
      stats = { finishedCount: 0, hasActiveExam: false }
      examsByKey.set(key, stats)
    }
    const status = String(row.status)
    if (status === 'active') {
      stats.hasActiveExam = true
      if (!stats.latestExamId) stats.latestExamId = String(row.id)
    } else if (status === 'finished') {
      stats.finishedCount += 1
      const score = row.score === null ? undefined : numberValue(row.score)
      const finishedAt = row.finished_at ? String(row.finished_at) : String(row.updated_at)
      const startedMs = new Date(String(row.started_at)).getTime()
      const finishedMs = new Date(finishedAt).getTime()
      const spentMinutes =
        Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
          ? Math.max(1, Math.round((finishedMs - startedMs) / 60_000))
          : numberValue(row.duration_minutes)
      if (!stats.latestFinishedAt) {
        stats.latestExamId = String(row.id)
        stats.latestScore = score
        stats.latestDurationMinutes = spentMinutes
        stats.latestFinishedAt = finishedAt
      }
      if (score !== undefined && (stats.bestScore === undefined || score > stats.bestScore)) {
        stats.bestScore = score
      }
    }
  }

  const items: PaperProgressItem[] = []
  if (!subject || subject === 'xingce') {
    for (const paperItem of listPapers(db)) {
      const key = `xingce\u0000${paperItem.paper}`
      const ex = examsByKey.get(key)
      items.push({
        paper: paperItem.paper,
        subject: 'xingce',
        year: paperItem.year,
        region:
          regionMap.get(paperItem.paper) || extractRegionFromText(paperItem.paper) || undefined,
        questionCount: paperItem.count,
        examCount: ex?.finishedCount ?? 0,
        hasActiveExam: ex?.hasActiveExam ?? false,
        latestExamId: ex?.latestExamId,
        latestScore: ex?.latestScore,
        bestScore: ex?.bestScore,
        latestDurationMinutes: ex?.latestDurationMinutes,
        latestFinishedAt: ex?.latestFinishedAt,
        practicedQuestionCount: practicedByPaperSubject.get(key)?.size ?? 0
      })
    }
  }
  if (!subject || subject === 'shenlun') {
    for (const paperItem of listShenlunPapers(db)) {
      const key = `shenlun\u0000${paperItem.paper}`
      const ex = examsByKey.get(key)
      items.push({
        paper: paperItem.paper,
        subject: 'shenlun',
        year: paperItem.year,
        region: paperItem.region,
        questionCount: paperItem.count,
        examCount: ex?.finishedCount ?? 0,
        hasActiveExam: ex?.hasActiveExam ?? false,
        latestExamId: ex?.latestExamId,
        latestScore: ex?.latestScore,
        bestScore: ex?.bestScore,
        latestDurationMinutes: ex?.latestDurationMinutes,
        latestFinishedAt: ex?.latestFinishedAt,
        practicedQuestionCount: practicedByPaperSubject.get(key)?.size ?? 0
      })
    }
  }
  return items.sort(
    (a, b) =>
      (b.year ?? 0) - (a.year ?? 0) ||
      b.questionCount - a.questionCount ||
      a.paper.localeCompare(b.paper, 'zh-CN')
  )
}

export function listQuestionSignatures(db: DatabaseSync, vaultId: string): string[] {
  const rows = db
    .prepare('SELECT stem, material, options_json FROM questions WHERE vault_id = ?')
    .all(vaultId) as Row[]
  return rows.map((row) => {
    const options = parseJson(row.options_json, []) as Array<{ text?: string }>
    return directSignature(
      String(row.stem ?? ''),
      row.material == null ? '' : String(row.material),
      options[0]?.text ?? ''
    )
  })
}

export function listDocuments(
  db: DatabaseSync,
  filter: { subject?: string; kind?: string; query?: string }
): KnowledgeDocument[] {
  const where = ['v.active = 1']
  const values: SqlValue[] = []
  if (filter.subject) {
    where.push('d.subject = ?')
    values.push(filter.subject)
  }
  if (filter.kind) {
    where.push('d.kind = ?')
    values.push(filter.kind)
  }
  appendKeywordFilter(where, values, filter.query, DOCUMENT_SEARCH_COLUMNS)
  const rows = db
    .prepare(
      `SELECT d.* FROM documents d JOIN vault_registry v ON v.id = d.vault_id
      WHERE ${where.join(' AND ')} ORDER BY d.kind, d.title`
    )
    .all(...values) as Row[]
  return rows.map((row) => mapDocument(row))
}

export function listVaultSnapshots(db: DatabaseSync, vaultId: string): VaultSnapshotInfo[] {
  const rows = db
    .prepare(
      'SELECT id,vault_id,created_at,question_count,document_count,length(payload) AS size FROM vault_snapshots WHERE vault_id=? ORDER BY created_at DESC'
    )
    .all(vaultId) as Row[]
  return rows.map((row) => ({
    id: String(row.id),
    vaultId: String(row.vault_id),
    createdAt: String(row.created_at),
    questionCount: numberValue(row.question_count),
    documentCount: numberValue(row.document_count),
    size: numberValue(row.size)
  }))
}

export function rollbackVaultSnapshot(
  db: DatabaseSync,
  caches: VaultQueryCaches,
  snapshotId: string
): VaultIndexResult {
  const row = db.prepare('SELECT * FROM vault_snapshots WHERE id=?').get(snapshotId) as
    Row | undefined
  if (!row || !(row.payload instanceof Uint8Array)) throw new Error('索引快照不存在或已经清理')
  let decoded: {
    vault: VaultInfo
    questions: Question[]
    documents: KnowledgeDocument[]
  }
  try {
    decoded = JSON.parse(gunzipSync(row.payload).toString('utf8')) as {
      vault: VaultInfo
      questions: Question[]
      documents: KnowledgeDocument[]
    }
  } catch {
    throw new Error('索引快照已损坏，无法回滚')
  }
  const vault: VaultInfo = {
    ...decoded.vault,
    lastIndexedAt: now(),
    questionCount: decoded.questions.length,
    documentCount: decoded.documents.length,
    warnings: ['当前使用历史索引快照。重新索引会再次读取源目录。']
  }
  const changes = replaceVaultContent(db, caches, vault, decoded.questions, decoded.documents, true)
  return { vault, ...changes, skipped: 0, warnings: vault.warnings }
}

export function listCategories(
  db: DatabaseSync,
  subject?: string
): Array<{ name: string; count: number }> {
  const rows = subject
    ? (db
        .prepare(
          `SELECT q.category, COUNT(*) AS count FROM questions q JOIN vault_registry v ON v.id=q.vault_id
        WHERE v.active=1 AND q.subject=? GROUP BY q.category ORDER BY count DESC`
        )
        .all(subject) as Row[])
    : (db
        .prepare(
          `SELECT q.category, COUNT(*) AS count FROM questions q JOIN vault_registry v ON v.id=q.vault_id
        WHERE v.active=1 GROUP BY q.category ORDER BY count DESC`
        )
        .all() as Row[])
  return rows.map((row) => ({ name: String(row.category), count: numberValue(row.count) }))
}

export function getQuestionFacets(
  db: DatabaseSync,
  caches: VaultQueryCaches,
  subject?: string,
  region?: string
): QuestionFacets {
  const cacheKey = `${subject ?? ''}::${region?.trim() ?? ''}`
  const cached = caches.facets.get(cacheKey)
  if (cached) return cached

  const subjectClause = subject ? 'AND q.subject=?' : ''
  const baseParameters = subject ? [subject] : []
  const read = (
    column: 'year' | 'paper',
    extraClause = '',
    extraParams: SqlValue[] = []
  ): Array<string | number> =>
    (
      db
        .prepare(
          `SELECT DISTINCT q.${column} AS value FROM questions q
           JOIN vault_registry v ON v.id=q.vault_id
           WHERE v.active=1 AND q.${column} IS NOT NULL AND q.${column} != '' ${subjectClause} ${extraClause}
           ORDER BY q.${column} DESC`
        )
        .all(...baseParameters, ...extraParams) as Row[]
    ).map((row) => (column === 'year' ? numberValue(row.value) : String(row.value)))

  // 聚合并归并同义地区（例如旧库中的「北京」与「北京市」）
  const rawRegionRows = db
    .prepare(
      `SELECT q.region AS value, COUNT(*) AS count FROM questions q
       JOIN vault_registry v ON v.id=q.vault_id
       WHERE v.active=1 AND q.region IS NOT NULL AND q.region != '' ${subjectClause}
       GROUP BY q.region`
    )
    .all(...baseParameters) as Row[]
  const mergedCounts = new Map<string, number>()
  for (const row of rawRegionRows) {
    const normalized = normalizeRegionName(String(row.value))
    if (!normalized) continue
    mergedCounts.set(normalized, (mergedCounts.get(normalized) ?? 0) + numberValue(row.count))
  }
  const regionCounts = [...mergedCounts.entries()]
    .map(([name, count]) => ({ region: name, count }))
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region, 'zh-CN'))

  const trimmedRegion = region?.trim()
  let paperRegionClause = ''
  let paperRegionParams: SqlValue[] = []
  if (trimmedRegion === UNLABELED_REGION_FILTER) {
    paperRegionClause = "AND (q.region IS NULL OR q.region = '')"
  } else if (trimmedRegion) {
    const aliases = expandRegionAliases(trimmedRegion)
    paperRegionClause = `AND q.region IN (${aliases.map(() => '?').join(', ')})`
    paperRegionParams = aliases
  }
  const result: QuestionFacets = {
    years: read('year') as number[],
    regions: regionCounts.map((item) => item.region),
    regionCounts,
    papers: read('paper', paperRegionClause, paperRegionParams) as string[]
  }
  caches.facets.set(cacheKey, result)
  return result
}

export function normalizeActiveVaultRegions(
  db: DatabaseSync,
  caches: VaultQueryCaches
): { updated: number } {
  const active = getActiveVault(db)
  if (!active) return { updated: 0 }
  const rows = db
    .prepare('SELECT id, region, paper, source, file_path FROM questions WHERE vault_id = ?')
    .all(active.id) as Row[]
  const updateStmt = db.prepare('UPDATE questions SET region = ? WHERE id = ?')
  let updated = 0
  runInTransaction(db, () => {
    for (const row of rows) {
      const current = row.region ? String(row.region).trim() : ''
      const normalized =
        (current ? normalizeRegionName(current) : '') ||
        extractRegionFromText(
          row.paper ? String(row.paper) : undefined,
          row.source ? String(row.source) : undefined,
          row.file_path ? String(row.file_path) : undefined
        ) ||
        ''
      if (normalized && normalized !== current) {
        updateStmt.run(normalized, String(row.id))
        updated += 1
      }
    }
  })
  caches.facets.clear()
  caches.shenlunQuality = null
  return { updated }
}

export function findSimilarQuestions(db: DatabaseSync, questionId: string, limit = 5): Question[] {
  const source = getQuestion(db, questionId)
  if (!source) return []
  const candidates = listQuestions(db, { subject: source.subject, limit: 2000 }).filter(
    (question) => question.id !== source.id
  )
  const sourceTags = new Set(source.tags)
  return candidates
    .map((question) => ({
      question,
      score:
        (question.category === source.category ? 10 : 0) +
        question.tags.filter((tag) => sourceTags.has(tag)).length * 3 -
        Math.abs(question.difficulty - source.difficulty)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.question.id.localeCompare(b.question.id))
    .slice(0, Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.round(limit) : 5)))
    .map((item) => item.question)
}
