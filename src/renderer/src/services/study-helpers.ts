import { splitSearchTerms } from '../../../shared/search'

export interface EssayWordLimit {
  min?: number
  max?: number
  label: string
}

/** 从申论题干识别字数限制（如「不超过200字」「800—1000字」「不少于1000字，不超过1200字」「1000字左右」） */
export function extractWordLimit(stem: string): EssayWordLimit | null {
  if (!stem) return null
  const compact = stem.replace(/\s+/g, '')
  const rangeMatch = compact.match(/(\d{2,4})[—–\-~～至到](\d{2,4})字/)
  if (rangeMatch) {
    const a = Number(rangeMatch[1])
    const b = Number(rangeMatch[2])
    if (a > 0 && b >= a) return { min: a, max: b, label: `${a}–${b} 字` }
  }
  const minMatch =
    compact.match(/(?:不少于|不低于|至少)(\d{2,4})字/) ?? compact.match(/(\d{2,4})字以上/)
  const maxMatch =
    compact.match(
      /(?:不超过|不高于|(?<!不)少于|控制在|限于|字数(?:控制)?在)(\d{2,4})字(?:以内|以下)?/
    ) ?? compact.match(/(\d{2,4})字(?:以内|以下)/)
  const min = minMatch ? Number(minMatch[1]) : 0
  const max = maxMatch ? Number(maxMatch[1]) : 0
  if (min > 0 && max > 0 && max >= min) {
    return { min, max, label: `${min}–${max} 字` }
  }
  const approxMatch = compact.match(/(\d{2,4})字左右/)
  if (approxMatch) {
    const target = Number(approxMatch[1])
    if (target > 0) {
      return {
        min: Math.round(target * 0.9),
        max: Math.round(target * 1.1),
        label: `约 ${target} 字`
      }
    }
  }
  if (min > 0) return { min, label: `≥ ${min} 字` }
  if (max > 0) return { max, label: `≤ ${max} 字` }
  return null
}

/** 在正文中查找关键词匹配片段（支持空格分隔多词，用于知识中心与全局检索预览） */
export function extractSearchSnippet(
  content: string,
  query: string,
  maxLength = 72
): string | null {
  const fullNeedle = query.trim().toLowerCase()
  if (!fullNeedle || !content) return null
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const lower = plain.toLowerCase()
  let idx = lower.indexOf(fullNeedle)
  if (idx < 0) {
    const terms = splitSearchTerms(query).sort((a, b) => b.length - a.length)
    for (const term of terms) {
      idx = lower.indexOf(term.toLowerCase())
      if (idx >= 0) break
    }
  }
  if (idx < 0) return null
  const start = Math.max(0, idx - 18)
  const end = Math.min(plain.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}

export interface ExamCountdown {
  daysLeft: number
  status: 'upcoming' | 'today' | 'passed'
}

/** 计算目标考试日期距今天的日历天数差（严格 YYYY-MM-DD 本地自然日） */
export function computeExamCountdown(
  examGoalDate?: string,
  nowDate: Date = new Date()
): ExamCountdown | null {
  if (!examGoalDate || !/^\d{4}-\d{2}-\d{2}$/.test(examGoalDate)) return null
  const [y, m, d] = examGoalDate.split('-').map(Number)
  if (!y || !m || !d) return null
  const target = new Date(y, m - 1, d)
  if (target.getFullYear() !== y || target.getMonth() !== m - 1 || target.getDate() !== d) {
    return null
  }
  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
  const daysLeft = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  return {
    daysLeft,
    status: daysLeft > 0 ? 'upcoming' : daysLeft === 0 ? 'today' : 'passed'
  }
}

/** 规范化展示教材/题目来源（去掉「本地资料/」前缀及常见文档后缀） */
export function formatMaterialSource(source?: string): string {
  const trimmed = source?.trim() ?? ''
  if (!trimmed) return ''
  const withoutPrefix = trimmed.replace(/^本地资料[\\/]+/, '')
  const segments = withoutPrefix.split(/[\\/]+/).filter(Boolean)
  const leaf = segments[segments.length - 1] ?? withoutPrefix
  return leaf.replace(/\.(pdf|docx?|md|txt)$/i, '')
}

/** 读取已记忆的筛选地区（页内未单独选择时回退全局默认考区） */
export function readStoredRegion(storageKey: string, fallbackRegion = ''): string {
  try {
    const stored = window.localStorage.getItem(storageKey)
    return stored !== null ? stored : fallbackRegion
  } catch {
    return fallbackRegion
  }
}

/** 持久化当前选择的筛选地区 */
export function writeStoredRegion(storageKey: string, region: string): void {
  try {
    if (region) window.localStorage.setItem(storageKey, region)
    else window.localStorage.removeItem(storageKey)
  } catch {
    /* 忽略受限环境下的 localStorage 写入失败 */
  }
}

export interface DocumentCategoryBucket {
  key: string
  label: string
  count: number
}

const GENERIC_DOC_TAGS = new Set([
  '申论',
  '行测',
  '申论方法',
  '申论知识',
  '申论素材',
  '行测方法',
  '行测知识'
])

/** 判断知识文档是否为题库切分的碎片素材（如 kg-sc-* 政策/金句卡片） */
export function isMaterialFragmentDoc(doc: { id: string }): boolean {
  return doc.id.includes(':kg-sc-') || doc.id.startsWith('kg-sc-')
}

/** 知识中心阅读排序：体系手册/专题汇编优先展示，碎片素材排后；同组按中文标题排序 */
export function sortDocumentsForReading<T extends { id: string; title: string }>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    const fragA = isMaterialFragmentDoc(a) ? 1 : 0
    const fragB = isMaterialFragmentDoc(b) ? 1 : 0
    if (fragA !== fragB) return fragA - fragB
    return a.title.localeCompare(b.title, 'zh-CN')
  })
}

const SHENLUN_KNOWLEDGE_TYPES = ['政策理论', '金句', '案例', '范文'] as const

/** 提取当前知识中心视图下的分类筛选胶囊及条数 */
export function classifyDocumentFilters<T extends { id: string; tags: string[] }>(
  docs: T[],
  subject: 'xingce' | 'shenlun' | 'common',
  kind: 'knowledge' | 'method' | 'pattern'
): DocumentCategoryBucket[] {
  const buckets: DocumentCategoryBucket[] = [{ key: 'all', label: '全部', count: docs.length }]
  if (subject === 'shenlun' && kind === 'knowledge') {
    const handbookCount = docs.filter((d) => !isMaterialFragmentDoc(d)).length
    if (handbookCount > 0) {
      buckets.push({ key: 'handbook', label: '手册与汇编', count: handbookCount })
    }
    for (const typeName of SHENLUN_KNOWLEDGE_TYPES) {
      const cnt = docs.filter((d) => isMaterialFragmentDoc(d) && d.tags.includes(typeName)).length
      if (cnt > 0) buckets.push({ key: typeName, label: typeName, count: cnt })
    }
    return buckets
  }

  const tagCounts = new Map<string, number>()
  for (const doc of docs) {
    for (const rawTag of doc.tags) {
      const tag = rawTag.trim()
      if (!tag || GENERIC_DOC_TAGS.has(tag)) continue
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }
  const topTags = [...tagCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 6)
  for (const [tag, count] of topTags) {
    buckets.push({ key: `tag:${tag}`, label: tag, count })
  }
  return buckets
}

/** 按分类键值过滤知识文档列表 */
export function filterDocumentsByCategory<T extends { id: string; tags: string[] }>(
  docs: T[],
  categoryKey: string,
  subject: 'xingce' | 'shenlun' | 'common',
  kind: 'knowledge' | 'method' | 'pattern'
): T[] {
  if (!categoryKey || categoryKey === 'all') return docs
  if (subject === 'shenlun' && kind === 'knowledge') {
    if (categoryKey === 'handbook') return docs.filter((d) => !isMaterialFragmentDoc(d))
    return docs.filter((d) => isMaterialFragmentDoc(d) && d.tags.includes(categoryKey))
  }
  if (categoryKey.startsWith('tag:')) {
    const targetTag = categoryKey.slice(4)
    return docs.filter((d) => d.tags.includes(targetTag))
  }
  return docs
}
