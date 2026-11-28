import { unescapeEvalText } from '../../shared/shenlun-rubric'
import { clamp } from '../utils/common'

export interface ParsedConstructedEvaluation {
  score: number
  dimensions: Array<{ name: string; score: number; comment: string }>
  summary: string
  suggestions: string[]
}

const THINK_BLOCK_RE =
  /<(?:think|thought|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thought|reasoning)>/gi
const UNCLOSED_THINK_OPEN_RE = /<(?:think|thought|reasoning)\b[^>]*>/i
const FENCED_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/gi
const UNCLOSED_FENCE_RE = /```(?:json)?\s*([\s\S]+)$/i

const WRAPPER_KEYS = ['evaluation', 'result', 'data', 'assessment', 'output'] as const
const SCORE_KEYS = ['score', 'totalScore', 'total_score', 'overallScore', '总分'] as const
const DIMENSION_KEYS = ['dimensions', 'criteria', 'items', 'aspects', '评分维度', '维度'] as const
const SUMMARY_KEYS = ['summary', 'overall', 'conclusion', 'feedback', '综合反馈', '总评'] as const
const SUGGESTION_KEYS = ['suggestions', 'advice', 'improvements', '修改建议', '建议'] as const

const KNOWN_DIMENSION_NAMES = [
  '要点覆盖',
  '结构组织',
  '表达规范',
  '内容要点',
  '逻辑结构',
  '语言表达',
  '公文格式',
  '立意论证'
]

/** 移除模型输出中的思考标签（<think>/<thought>/<reasoning>）及不可见 BOM/零宽字符 */
export function stripReasoningTags(raw: string): string {
  return raw
    .replace(/[\uFEFF\u200B-\u200D]/g, '')
    .replace(THINK_BLOCK_RE, '')
    .trim()
}

function skipWs(text: string, start: number): number {
  let i = start
  while (i < text.length && /\s/.test(text[i]!)) {
    i += 1
  }
  return i
}

function skipWsAndComments(text: string, start: number): number {
  let i = start
  while (i < text.length) {
    i = skipWs(text, i)
    if (text[i] === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2)
      i = nl >= 0 ? nl + 1 : text.length
      continue
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close >= 0 ? close + 2 : text.length
      continue
    }
    break
  }
  return i
}

/**
 * 字符级 JSON 清洗状态机：
 * 1. 字符串字面量内部：转义裸换行/回车/制表符，修复非法反斜杠转义，剔除非法控制字符；
 * 2. 字符串字面量外部：移除 // 与 /* * / 注释，以及 ]/} 前的尾逗号（支持逗号与括号间夹带注释）。
 */
export function sanitizeJsonText(input: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]!
    if (inString) {
      if (escaped) {
        if (ch === '\n') {
          out.push('n')
        } else if (ch === '\r') {
          out.push('r')
        } else if (ch === '\t') {
          out.push('t')
        } else if (
          ch === '"' ||
          ch === '\\' ||
          ch === '/' ||
          ch === 'b' ||
          ch === 'f' ||
          ch === 'n' ||
          ch === 'r' ||
          ch === 't' ||
          (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 1, i + 5)))
        ) {
          out.push(ch)
        } else {
          out.push('\\', ch)
        }
        escaped = false
        i += 1
        continue
      }
      if (ch === '\\') {
        out.push(ch)
        escaped = true
        i += 1
        continue
      }
      if (ch === '"') {
        out.push(ch)
        inString = false
        i += 1
        continue
      }
      if (ch === '\n') {
        out.push('\\n')
        i += 1
        continue
      }
      if (ch === '\r') {
        if (input[i + 1] === '\n') {
          out.push('\\n')
          i += 2
        } else {
          out.push('\\r')
          i += 1
        }
        continue
      }
      if (ch === '\t') {
        out.push('\\t')
        i += 1
        continue
      }
      if (ch.charCodeAt(0) < 0x20) {
        i += 1
        continue
      }
      out.push(ch)
      i += 1
      continue
    }

    // 字符串外部处理注释
    if (ch === '/' && input[i + 1] === '/') {
      const nl = input.indexOf('\n', i + 2)
      i = nl >= 0 ? nl : input.length
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2)
      i = close >= 0 ? close + 2 : input.length
      continue
    }
    if (ch === ',') {
      const nextIdx = skipWsAndComments(input, i + 1)
      const nextCh = input[nextIdx]
      if (nextCh === ']' || nextCh === '}') {
        i += 1
        continue
      }
    }
    if (ch === '"') {
      inString = true
    }
    out.push(ch)
    i += 1
  }

  return out.join('')
}

type ContainerFrame =
  | { kind: '{'; expect: 'key-or-end' | 'colon' | 'value' | 'after-value' }
  | { kind: '['; expect: 'value-or-end' | 'after-value' }

type StringRole = 'object-key' | 'object-value' | 'array-value' | 'root'

function isLikelyJsonArrayNextString(text: string, quoteIdx: number): boolean {
  // 判断数组逗号后的 "..." 是否为真实下一条元素（例如 ["建议1", "建议2"]），
  // 而不是字符串正文内部举例（例如 ["写了"A", "B"两项"]）
  let i = quoteIdx + 1
  let escaped = false
  while (i < text.length) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      i += 1
      continue
    }
    if (ch === '\\') {
      escaped = true
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') return false
    if (ch === '"') {
      const after = text[skipWs(text, i + 1)]
      return after === ',' || after === ']' || after === undefined
    }
    i += 1
  }
  return false
}

function isLikelyJsonObjectNextKey(text: string, quoteIdx: number): boolean {
  let i = quoteIdx + 1
  const limit = Math.min(text.length, quoteIdx + 64)
  let escaped = false
  while (i < limit) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      i += 1
      continue
    }
    if (ch === '\\') {
      escaped = true
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') return false
    if (ch === '"') {
      return text[skipWs(text, i + 1)] === ':'
    }
    i += 1
  }
  return false
}

function isClosingQuoteForRole(text: string, quoteIdx: number, role: StringRole): boolean {
  const afterIdx = skipWs(text, quoteIdx + 1)
  if (afterIdx >= text.length) return true
  const next = text[afterIdx]!

  if (role === 'object-key') {
    return next === ':'
  }
  if (role === 'object-value') {
    if (next === '}') return true
    if (next !== ',') return false
    const afterCommaIdx = skipWs(text, afterIdx + 1)
    if (afterCommaIdx >= text.length) return true
    const afterComma = text[afterCommaIdx]!
    if (afterComma === '}') return true
    if (afterComma === '"') return isLikelyJsonObjectNextKey(text, afterCommaIdx)
    return false
  }
  if (role === 'array-value') {
    if (next === ']') return true
    if (next !== ',') return false
    const afterCommaIdx = skipWs(text, afterIdx + 1)
    if (afterCommaIdx >= text.length) return true
    const afterComma = text[afterCommaIdx]!
    if (afterComma === ']' || afterComma === '{' || afterComma === '[') return true
    if (afterComma === '"') return isLikelyJsonArrayNextString(text, afterCommaIdx)
    return /[-0-9tfn]/.test(afterComma)
  }
  return true
}

/**
 * 兜底修复字符串值内部未转义的英文双引号（例如 "考生写了"累进式执法"并分析"）。
 * 仅在常规与 sanitize 解析均失败时使用，防止误伤合法 JSON。
 */
export function escapeStrayInnerQuotes(input: string): string {
  const out: string[] = []
  const stack: ContainerFrame[] = []
  let inString = false
  let escaped = false
  let role: StringRole = 'root'

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (inString) {
      if (escaped) {
        out.push(ch)
        escaped = false
        continue
      }
      if (ch === '\\') {
        out.push(ch)
        escaped = true
        continue
      }
      if (ch === '"') {
        if (isClosingQuoteForRole(input, i, role)) {
          out.push(ch)
          inString = false
          const top = stack[stack.length - 1]
          if (top?.kind === '{') {
            top.expect = role === 'object-key' ? 'colon' : 'after-value'
          } else if (top?.kind === '[') {
            top.expect = 'after-value'
          }
        } else {
          out.push('\\"')
        }
        continue
      }
      out.push(ch)
      continue
    }

    if (ch === '"') {
      const top = stack[stack.length - 1]
      if (!top) {
        role = 'root'
      } else if (top.kind === '{') {
        role = top.expect === 'value' ? 'object-value' : 'object-key'
      } else {
        role = 'array-value'
      }
      inString = true
      out.push(ch)
      continue
    }

    if (ch === '{') {
      stack.push({ kind: '{', expect: 'key-or-end' })
      out.push(ch)
      continue
    }
    if (ch === '[') {
      stack.push({ kind: '[', expect: 'value-or-end' })
      out.push(ch)
      continue
    }
    if (ch === '}' || ch === ']') {
      if (stack.length > 0) stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent.expect = 'after-value'
      out.push(ch)
      continue
    }
    const top = stack[stack.length - 1]
    if (top?.kind === '{') {
      if (ch === ':') top.expect = 'value'
      else if (ch === ',') top.expect = 'key-or-end'
    } else if (top?.kind === '[') {
      if (ch === ',') top.expect = 'value-or-end'
    }
    out.push(ch)
  }

  return out.join('')
}

function closeJsonFragment(fragment: string): string {
  // 去掉末尾悬空反斜杠与字符串外空白
  let trimmed = fragment.trimEnd()
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      stack.pop()
    }
  }

  // 若在转义状态被截断，剥去最后单个悬空反斜杠以免把闭合引号转义掉
  if (inString && escaped && trimmed.endsWith('\\')) {
    trimmed = trimmed.slice(0, -1)
  }
  if (inString) {
    trimmed += '"'
  } else {
    trimmed = trimmed.replace(/,\s*$/, '')
  }

  const closers: string[] = []
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    closers.push(stack[i] === '[' ? ']' : '}')
  }
  return trimmed + closers.join('')
}

/**
 * 修复因 max_tokens 截断导致的半截 JSON，返回按完整度降序的闭合候选列表：
 * 1. 在当前截断处闭合字符串与未闭合括号；
 * 2. 若断在半截 key 或冒号后，依次向前回溯最近几个逗号断掉残缺字段后再闭合。
 */
export function repairTruncatedJson(input: string): string[] {
  const candidates: string[] = []
  const commaIndices: number[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === ',') {
      commaIndices.push(i)
    }
  }

  candidates.push(closeJsonFragment(input))
  for (let step = 0; step < 4; step += 1) {
    const idx = commaIndices[commaIndices.length - 1 - step]
    if (idx === undefined) break
    candidates.push(closeJsonFragment(input.slice(0, idx)))
  }

  return [...new Set(candidates.filter(Boolean))]
}

function extractBalancedObjects(text: string): string[] {
  const objects: string[] = []
  let inString = false
  let escaped = false
  let depth = 0
  let start = -1

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return objects
}

/** 从原始模型输出中按优先级提取待尝试解析的 JSON 片段候选 */
export function extractJsonCandidates(raw: string): string[] {
  const stripped = stripReasoningTags(raw)
  const list: string[] = []
  const push = (item?: string): void => {
    const trimmed = item?.trim()
    if (trimmed) list.push(trimmed)
  }

  // 1. 优先尝试提取所有闭合代码围栏
  for (const match of stripped.matchAll(FENCED_BLOCK_RE)) {
    push(match[1])
  }
  // 2. 提取未闭合代码围栏（响应被长度截断时常见）
  const unclosedFence = stripped.match(UNCLOSED_FENCE_RE)
  if (unclosedFence?.[1]) {
    push(unclosedFence[1])
  }

  // 3. 字符串感知扫描所有平衡的顶层 {...}
  for (const obj of extractBalancedObjects(stripped)) {
    push(obj)
  }

  // 4. 整段去思考文本、first '{' .. EOF（保留尾部截断字段）、再尝试 first '{' .. last '}'
  push(stripped)
  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')
  if (firstBrace >= 0) {
    push(stripped.slice(firstBrace))
  }
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    push(stripped.slice(firstBrace, lastBrace + 1))
  }

  // 5. 若模型未闭合 <think> 标签，尝试在原文内查找首个包含评分字段的 JSON 起点
  if (UNCLOSED_THINK_OPEN_RE.test(raw) && !raw.includes('</think>')) {
    const keyIdx = raw.search(/"(?:score|totalScore|dimensions|总分)"\s*:/)
    if (keyIdx > 0) {
      const braceBefore = raw.lastIndexOf('{', keyIdx)
      if (braceBefore >= 0) {
        push(raw.slice(braceBefore))
      }
    }
  }

  return [...new Set(list)]
}

function tryParsePlainObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

function parseCandidateVariants(candidate: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const pushObj = (obj: Record<string, unknown> | undefined): void => {
    if (!obj) return
    const key = JSON.stringify(obj)
    if (seen.has(key)) return
    seen.add(key)
    results.push(obj)
  }

  pushObj(tryParsePlainObject(candidate))
  if (results.length > 0) return results

  const sanitized = sanitizeJsonText(candidate)
  pushObj(tryParsePlainObject(sanitized))
  if (results.length > 0) return results

  const escapedQuotes = sanitizeJsonText(escapeStrayInnerQuotes(sanitized))
  pushObj(tryParsePlainObject(escapedQuotes))
  if (results.length > 0) return results

  for (const repaired of repairTruncatedJson(sanitized)) {
    const parsed = tryParsePlainObject(repaired)
    if (parsed) {
      pushObj(parsed)
      break
    }
  }
  if (results.length === 0) {
    for (const repaired of repairTruncatedJson(escapedQuotes)) {
      const parsed = tryParsePlainObject(repaired)
      if (parsed) {
        pushObj(parsed)
        break
      }
    }
  }
  return results
}

function pickFirstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      return record[key]
    }
  }
  return undefined
}

function parseScoreNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 100) return undefined
    return Math.round(value)
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const ratioMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  if (ratioMatch?.[1] && ratioMatch[2]) {
    const num = Number(ratioMatch[1])
    const denom = Number(ratioMatch[2])
    if (Number.isFinite(num) && Number.isFinite(denom) && denom > 0) {
      const scaled = denom === 100 ? num : (num / denom) * 100
      if (scaled >= 0 && scaled <= 100) return Math.round(scaled)
    }
  }
  const unitMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*(?:分|pts?|points?)/i)
  if (unitMatch?.[1]) {
    const num = Number(unitMatch[1])
    if (Number.isFinite(num) && num >= 0 && num <= 100) return Math.round(num)
  }
  const plainMatch = trimmed.match(/(-?\d+(?:\.\d+)?)/)
  if (plainMatch?.[1]) {
    const num = Number(plainMatch[1])
    if (Number.isFinite(num) && num >= 0 && num <= 100) return Math.round(num)
  }
  return undefined
}

function unwrapEvaluationObject(raw: Record<string, unknown>): Record<string, unknown> {
  const hasTopLevelSignal =
    pickFirstField(raw, SCORE_KEYS) !== undefined ||
    pickFirstField(raw, DIMENSION_KEYS) !== undefined
  if (hasTopLevelSignal) return raw
  for (const wrapper of WRAPPER_KEYS) {
    const inner = raw[wrapper]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as Record<string, unknown>
    }
  }
  return raw
}

function normalizeDimensions(
  value: unknown
): Array<{ name: string; score?: number; comment: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const record = item as Record<string, unknown>
      const rawName = pickFirstField(record, ['name', 'title', 'dimension', 'label'])
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : '综合'
      const rawScore = pickFirstField(record, ['score', 'points', 'value'])
      const score = parseScoreNumber(rawScore)
      const rawComment = pickFirstField(record, [
        'comment',
        'feedback',
        'detail',
        'reason',
        'analysis'
      ])
      const comment = typeof rawComment === 'string' ? unescapeEvalText(rawComment).trim() : ''
      return [{ name, score, comment }]
    })
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.flatMap(([name, detail]) => {
      if (!name.trim()) return []
      if (typeof detail === 'number' || typeof detail === 'string') {
        return [{ name: name.trim(), score: parseScoreNumber(detail), comment: '' }]
      }
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const record = detail as Record<string, unknown>
        const score = parseScoreNumber(pickFirstField(record, ['score', 'points', 'value']))
        const rawComment = pickFirstField(record, [
          'comment',
          'feedback',
          'detail',
          'reason',
          'analysis'
        ])
        const comment = typeof rawComment === 'string' ? unescapeEvalText(rawComment).trim() : ''
        return [{ name: name.trim(), score, comment }]
      }
      return []
    })
  }
  return []
}

function splitSuggestionsText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const sampleMatch = trimmed.match(
    /(?:^|\n)\s*(?:(?:#{1,4}|\d+[.、)）]|[-*•])\s*)*(?=【参考思路\/示范作答】)/
  )
  const splitIdx = sampleMatch?.index ?? -1
  const beforeSample = splitIdx >= 0 ? trimmed.slice(0, splitIdx).trim() : trimmed
  const samplePart =
    splitIdx >= 0
      ? trimmed
          .slice(splitIdx)
          .replace(/^\s*(?:(?:#{1,4}|\d+[.、)）]|[-*•])\s*)+/, '')
          .trim()
      : ''

  const splitPart = (part: string): string[] => {
    if (!part) return []
    const numbered = part
      .split(/\n(?=\s*(?:\d+[.、)）]|[-*•])\s+)/)
      .map((line) => line.replace(/^\s*(?:\d+[.、)）]|[-*•])\s+/, '').trim())
      .filter(Boolean)
    if (numbered.length > 1) return numbered
    const lines = part
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:\d+[.、)）]|[-*•])\s+/, '').trim())
      .filter(Boolean)
    return lines.length > 1 ? lines : [part.replace(/^\s*(?:\d+[.、)）]|[-*•])\s+/, '').trim()]
  }

  const items = [...splitPart(beforeSample)]
  if (samplePart) items.push(samplePart)
  return items.slice(0, 8)
}

function formatSuggestionItem(item: unknown): string {
  if (typeof item === 'string') return unescapeEvalText(item).trim()
  if (!item || typeof item !== 'object') return ''
  const record = item as Record<string, unknown>
  const heading = pickFirstField(record, ['title', 'point', 'heading', 'name'])
  const body = pickFirstField(record, ['content', 'detail', 'suggestion', 'action', 'text'])
  const headStr = typeof heading === 'string' ? unescapeEvalText(heading).trim() : ''
  const bodyStr = typeof body === 'string' ? unescapeEvalText(body).trim() : ''
  if (headStr && bodyStr) return `${headStr}：${bodyStr}`
  return headStr || bodyStr
}

function normalizeSuggestions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(formatSuggestionItem).filter(Boolean).slice(0, 8)
  }
  if (typeof value === 'string') {
    return splitSuggestionsText(unescapeEvalText(value))
  }
  return []
}

/** 校验并规范化申论评估 JSON 对象；对空对象、错误对象或缺失有效评分/内容的对象返回 undefined */
export function normalizeConstructedEvaluation(
  rawObj: Record<string, unknown>
): ParsedConstructedEvaluation | undefined {
  const target = unwrapEvaluationObject(rawObj)
  const rawTopScore = pickFirstField(target, SCORE_KEYS)
  const topScore = parseScoreNumber(rawTopScore)
  const rawDimensions = normalizeDimensions(pickFirstField(target, DIMENSION_KEYS))

  const scoredDimensions = rawDimensions.filter(
    (d): d is { name: string; score: number; comment: string } => d.score !== undefined
  )
  const resolvedScore =
    topScore !== undefined
      ? topScore
      : scoredDimensions.length > 0
        ? clamp(
            Math.round(
              scoredDimensions.reduce((sum, item) => sum + item.score, 0) / scoredDimensions.length
            ),
            0,
            100
          )
        : undefined

  if (resolvedScore === undefined) return undefined

  const dimensions = rawDimensions.map((item) => ({
    name: item.name,
    score: item.score ?? resolvedScore,
    comment: item.comment
  }))

  const rawSummary = pickFirstField(target, SUMMARY_KEYS)
  const summaryText = typeof rawSummary === 'string' ? unescapeEvalText(rawSummary).trim() : ''
  const suggestions = normalizeSuggestions(pickFirstField(target, SUGGESTION_KEYS))
  const hasDimensionComment = dimensions.some((item) => item.comment.length > 0)

  if (!summaryText && !hasDimensionComment && suggestions.length === 0) {
    return undefined
  }

  return {
    score: resolvedScore,
    dimensions,
    summary: summaryText || '评估完成',
    suggestions
  }
}

/** 从模型输出中稳健解析并修复申论评估 JSON；失败返回 undefined */
export function parseConstructedEvaluationJson(
  raw: string
): ParsedConstructedEvaluation | undefined {
  if (!raw || !raw.trim()) return undefined
  const candidates = extractJsonCandidates(raw)
  for (const candidate of candidates) {
    const parsedVariants = parseCandidateVariants(candidate)
    for (const obj of parsedVariants) {
      const normalized = normalizeConstructedEvaluation(obj)
      if (normalized) return normalized
    }
  }
  return undefined
}

/**
 * 兜底抢救：当模型多次均未输出 JSON，但已返回完整中文 Markdown 评估正文时，
 * 提取总分、维度评价、综合反馈与建议，避免白白回退到纯关键词本地规则。
 */
export function parseConstructedEvaluationMarkdown(
  raw: string
): ParsedConstructedEvaluation | undefined {
  let cleaned = stripReasoningTags(raw)
  if (UNCLOSED_THINK_OPEN_RE.test(cleaned)) {
    const lines = cleaned.split(/\r?\n/)
    const scoreLineIdx = lines.findIndex((line) =>
      /(?:综合得分|最终得分|评估得分|总分|得分|评分)[：:\s*]*\d/.test(line)
    )
    if (scoreLineIdx < 0) return undefined
    cleaned = lines.slice(scoreLineIdx).join('\n').trim()
  }
  if (cleaned.length < 30) return undefined
  if (/^\s*\{[\s\S]*"error"\s*:/.test(cleaned)) return undefined

  const totalScoreMatch = cleaned.match(
    /(?:^|[\n\s#*>\-—])(?:综合得分|最终得分|评估得分|总体得分|总分|得分|评分)[：: \t*]*(\d{1,3}(?:\.\d+)?)\s*(?:\/\s*(\d{1,3})|分)?/m
  )
  if (!totalScoreMatch?.[1]) return undefined
  const rawScoreToken = totalScoreMatch[2]
    ? `${totalScoreMatch[1]}/${totalScoreMatch[2]}`
    : totalScoreMatch[1]
  const score = parseScoreNumber(rawScoreToken)
  if (score === undefined) return undefined

  const dimensions: Array<{ name: string; score: number; comment: string }> = []
  const seenDim = new Set<string>()
  const dimPattern = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,4}\\s*|[-*•]\\s*|\\d+[.、)\\s]+|\\*{1,2})?(?:\\*{0,2})(${KNOWN_DIMENSION_NAMES.join('|')})(?:\\*{0,2})(?:\\s*[（(【]\\s*(\\d{1,3}(?:\\.\\d+)?\\s*(?:\\/\\s*\\d{1,3}|分)?)\\s*[)）】])?[：:\\s-]*([^\\n]*(?:\\n(?!(?:#{1,4}\\s|[-*•]\\s|\\d+[.、)]|【|\\*{0,2}(?:${KNOWN_DIMENSION_NAMES.join('|')}|总评|综合|修改|改进|建议))).+)*)`,
    'g'
  )
  for (const match of cleaned.matchAll(dimPattern)) {
    const name = match[1]?.trim()
    if (!name || seenDim.has(name)) continue
    seenDim.add(name)
    const dimScore = match[2] ? (parseScoreNumber(match[2]) ?? score) : score
    const comment = unescapeEvalText((match[3] ?? '').replace(/\*\*|__/g, '')).trim()
    dimensions.push({ name, score: dimScore, comment })
  }

  const summarySection = cleaned.match(
    /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*{0,2})(?:综合反馈|综合评价|总体评价|总评|评估总结)(?:\*{0,2})[：:\s]*\n?([\s\S]*?)(?=\n\s*(?:#{1,4}\s|\*{0,2}(?:修改建议|改进建议|优化建议|提分建议|建议|参考思路)|$))/i
  )
  const suggestionSection = cleaned.match(
    /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*{0,2})(?:修改建议|改进建议|优化建议|提分建议|建议)(?:\*{0,2})[：:\s]*\n([\s\S]*)$/i
  )

  const suggestions = suggestionSection?.[1]
    ? splitSuggestionsText(unescapeEvalText(suggestionSection[1].replace(/\*\*|__/g, '')))
    : []

  let summary = unescapeEvalText(summarySection?.[1]?.replace(/\*\*|__/g, '') ?? '').trim()
  if (!summary) {
    summary = cleaned
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\*\*|__/g, '')
      .trim()
      .slice(0, 800)
  }

  if (!summary && dimensions.length === 0 && suggestions.length === 0) {
    return undefined
  }

  return {
    score,
    dimensions,
    summary: summary || '评估完成',
    suggestions
  }
}
