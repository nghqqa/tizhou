import type { DatabaseSync } from 'node:sqlite'
import type {
  ExamSession,
  KnowledgeDocument,
  Question,
  QuestionFacets,
  VaultInfo
} from '../../../shared/contracts'
import { UNLABELED_REGION_FILTER, expandRegionAliases } from '../../../shared/region'
import { escapeSqlLike, splitSearchTerms } from '../../../shared/search'
import type { ShenlunMaterialQualityLevel } from '../../../shared/shenlun'
import { localDateString, safeParseJson as parseJson } from '../../utils/common'

export type SqlValue = string | number | bigint | Uint8Array | null
export type Row = Record<string, SqlValue>

/** listQuestions 族共用过滤条件（渲染层 QuestionFilter 的主进程宽松版） */
export interface QuestionListFilter {
  subject?: string
  category?: string
  categories?: string[]
  type?: string
  difficulty?: number
  year?: number
  region?: string
  paper?: string
  query?: string
  onlyWrong?: boolean
  onlyFavorite?: boolean
  onlyUnattempted?: boolean
  limit?: number
}

export interface ShenlunQualityEntry {
  materialQuality: ShenlunMaterialQualityLevel
  materialIssues: string[]
  hasReferenceAnswer: boolean
}

export interface VaultQueryCaches {
  facets: Map<string, QuestionFacets>
  shenlunQuality: Map<string, ShenlunQualityEntry> | null
}

export const QUESTION_SEARCH_COLUMNS = [
  'q.stem',
  'q.explanation',
  'q.tags_json',
  "COALESCE(q.material, '')",
  "COALESCE(q.paper, '')",
  "COALESCE(q.region, '')",
  'q.source',
  'q.category',
  "COALESCE(CAST(q.year AS TEXT), '')"
] as const

export const LIBRARY_SEARCH_COLUMNS = [
  ...QUESTION_SEARCH_COLUMNS,
  "COALESCE(n.content, '')"
] as const

export const DOCUMENT_SEARCH_COLUMNS = ['d.title', 'd.summary', 'd.content', 'd.tags_json'] as const

/** attempts.created_at 存 UTC ISO：按天聚合/匹配必须转本地日期（date(x,'localtime')），
 *  否则北京时间 00:00~08:00 的作答会被记到前一天（UTC 日期仍是昨天） */
export const LOCAL_DATE = "date(created_at, 'localtime')"

export const dateKey = localDateString

export { parseJson }

export function runInTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 严格校验证实存在的公历日期 `YYYY-MM-DD`（拦截 `2026-02-31`、`2026-13-45` 等伪日期） */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return false
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function appendKeywordFilter(
  where: string[],
  values: SqlValue[],
  query: string | undefined,
  columns: readonly string[]
): void {
  const terms = splitSearchTerms(query ?? '')
  for (const term of terms) {
    const pattern = `%${escapeSqlLike(term)}%`
    where.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    for (let index = 0; index < columns.length; index += 1) {
      values.push(pattern)
    }
  }
}

export function addDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

export function numberValue(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

/** 从 papers_json 提取去空白后的卷名数组 */
export function extractPaperNamesFromJson(papersJson: SqlValue | undefined): string[] {
  const refs = parseJson<Array<{ paper?: string }>>(papersJson ?? null, [])
  if (!Array.isArray(refs)) return []
  return refs
    .map((entry) => (typeof entry?.paper === 'string' ? entry.paper.trim() : ''))
    .filter(Boolean)
}

export function buildQuestionFilter(filter: QuestionListFilter): {
  where: string[]
  values: SqlValue[]
} {
  const where = ['v.active = 1']
  const values: SqlValue[] = []
  if (filter.subject) {
    where.push('q.subject = ?')
    values.push(filter.subject)
  }
  if (filter.category) {
    where.push('q.category = ?')
    values.push(filter.category)
  }
  if (filter.categories?.length) {
    const clean = filter.categories.map((c) => c.trim()).filter(Boolean)
    if (clean.length) {
      where.push(`q.category IN (${clean.map(() => '?').join(', ')})`)
      values.push(...clean)
    }
  }
  if (filter.type) {
    where.push('q.type = ?')
    values.push(filter.type)
  }
  if (filter.difficulty) {
    where.push('q.difficulty = ?')
    values.push(filter.difficulty)
  }
  if (filter.year) {
    where.push('q.year = ?')
    values.push(filter.year)
  }
  if (filter.region?.trim()) {
    const regionValue = filter.region.trim()
    if (regionValue === UNLABELED_REGION_FILTER) {
      where.push("(q.region IS NULL OR q.region = '')")
    } else {
      const aliases = expandRegionAliases(regionValue)
      const placeholders = aliases.map(() => '?').join(', ')
      where.push(`q.region IN (${placeholders})`)
      values.push(...aliases)
    }
  }
  if (filter.paper?.trim()) {
    where.push('q.paper = ?')
    values.push(filter.paper.trim())
  }
  appendKeywordFilter(where, values, filter.query, QUESTION_SEARCH_COLUMNS)
  if (filter.onlyWrong)
    where.push(
      'EXISTS (SELECT 1 FROM wrong_questions w WHERE w.question_id = q.id AND w.mastered = 0)'
    )
  if (filter.onlyFavorite)
    where.push('EXISTS (SELECT 1 FROM favorites f WHERE f.question_id = q.id)')
  if (filter.onlyUnattempted)
    where.push('NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id)')
  return { where, values }
}

export function mapVault(row: Row): VaultInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    connectedAt: String(row.connected_at),
    lastIndexedAt: String(row.last_indexed_at),
    questionCount: numberValue(row.question_count),
    documentCount: numberValue(row.document_count),
    warnings: parseJson<string[]>(row.warnings_json, []),
    isBuiltin: Boolean(row.is_builtin)
  }
}

export function mapQuestion(row: Row): Question {
  return {
    id: String(row.id),
    subject: String(row.subject) as Question['subject'],
    category: String(row.category),
    type: String(row.type) as Question['type'],
    stem: String(row.stem),
    options: parseJson(row.options_json, []),
    answer: parseJson(row.answer_json, []),
    explanation: String(row.explanation),
    difficulty: Math.max(1, Math.min(5, numberValue(row.difficulty))) as Question['difficulty'],
    source: String(row.source),
    year: row.year === null ? undefined : numberValue(row.year),
    region: row.region == null ? undefined : String(row.region),
    paper: row.paper == null ? undefined : String(row.paper),
    material: row.material == null ? undefined : String(row.material),
    contentVersion: row.content_version == null ? undefined : String(row.content_version),
    groupId: row.group_id == null ? undefined : String(row.group_id),
    groupOrder: row.group_order == null ? undefined : Number(row.group_order),
    tags: parseJson(row.tags_json, []),
    filePath: row.file_path === null ? undefined : String(row.file_path),
    contentHash: String(row.content_hash),
    papers: row.papers_json ? parseJson(row.papers_json, []) : undefined
  }
}

export function mapDocument(row: Row): KnowledgeDocument {
  return {
    id: String(row.id),
    subject: String(row.subject) as KnowledgeDocument['subject'],
    kind: String(row.kind) as KnowledgeDocument['kind'],
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    tags: parseJson(row.tags_json, []),
    filePath: row.file_path === null ? undefined : String(row.file_path)
  }
}

export function mapExam(row: Row): ExamSession {
  return {
    id: String(row.id),
    title: String(row.title),
    subject: String(row.subject) as ExamSession['subject'],
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? undefined : String(row.finished_at),
    durationMinutes: numberValue(row.duration_minutes),
    questionIds: parseJson(row.question_ids_json, []),
    questionSnapshots: parseJson(row.question_snapshots_json, {}),
    answers: parseJson(row.answers_json, {}),
    uncertainIds: row.uncertain_ids_json ? parseJson<string[]>(row.uncertain_ids_json, []) : [],
    status: String(row.status) as ExamSession['status'],
    score: row.score === null ? undefined : numberValue(row.score),
    correctCount: row.correct_count === null ? undefined : numberValue(row.correct_count)
  }
}
