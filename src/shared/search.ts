/** 按半角/全角空白拆分搜索关键词，保留有效词项并按大小写不敏感去重 */
export function splitSearchTerms(query: string, maxTerms = 8): string[] {
  const trimmed = query.trim()
  if (!trimmed || maxTerms <= 0) return []
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of trimmed.split(/[\s\u3000]+/)) {
    const token = raw.trim()
    if (!token) continue
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(token)
    if (terms.length >= maxTerms) break
  }
  return terms
}

/** 转义 SQLite LIKE 通配符（配合 ESCAPE '\' 使用） */
export function escapeSqlLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

/** 前端多词 AND 匹配（任意空格分隔词均需命中，大小写不敏感） */
export function matchesSearchTerms(haystack: string, query: string): boolean {
  const terms = splitSearchTerms(query)
  if (terms.length === 0) return true
  const lower = haystack.toLowerCase()
  return terms.every((term) => lower.includes(term.toLowerCase()))
}
