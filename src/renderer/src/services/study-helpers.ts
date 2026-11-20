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

export interface MarkdownHeading {
  level: 2 | 3
  text: string
  index: number
}

/** 提取 Markdown 文档中的二级/三级标题用于目录跳转（自动忽略代码块内注释行） */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  if (!markdown) return []
  const headings: MarkdownHeading[] = []
  let inFence = false
  let order = 0
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = line.match(/^(#{2,3})\s+(.+?)\s*#*$/)
    if (!match) continue
    const level = match[1]!.length as 2 | 3
    const text = match[2]!
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim()
    if (!text) continue
    headings.push({ level, text, index: order })
    order += 1
  }
  return headings
}

/** 在正文中查找关键词匹配片段（用于知识中心全文搜索预览） */
export function extractSearchSnippet(
  content: string,
  query: string,
  maxLength = 72
): string | null {
  const needle = query.trim().toLowerCase()
  if (!needle || !content) return null
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const idx = plain.toLowerCase().indexOf(needle)
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
