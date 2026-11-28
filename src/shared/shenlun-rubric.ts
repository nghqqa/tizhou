import type { ConstructedEvaluation, ConstructedEvaluationMeta, Question } from './contracts'
import { buildShenlunSheetGrid, classifyShenlunType, type ShenlunQuestionType } from './shenlun'

export interface EssayWordLimit {
  min?: number
  max?: number
  label: string
}

export type ShenlunSubType = '归纳概括' | '提出对策' | '综合分析' | '贯彻执行' | '文章写作'
export type DocFormatLevel = 'full' | 'semi' | 'title-only' | 'none'

export interface ShenlunRubricWeights {
  content: number
  structure: number
  expression: number
}

export interface ShenlunStemRubric {
  questionType: ShenlunQuestionType
  subType: ShenlunSubType
  fullScore?: number
  wordLimit: EssayWordLimit | null
  weights: ShenlunRubricWeights
  docFormatLevel?: DocFormatLevel
  docFormatHint?: string
  requiredTitle?: string
  requiresTitle: boolean
  requiresProblemBeforeMeasure: boolean
}

export interface ShenlunAnswerMetrics {
  wordCount: number
  sheetCellCount: number
  paragraphCount: number
  hasTitle: boolean
  matchesRequiredTitle: boolean
  hasSalutation: boolean
  hasSignOff: boolean
  hasListStructure: boolean
  materialCopyRatio: number
  residualEssay: boolean
  hardPenalties: string[]
}

const RUBRIC_WEIGHTS: Record<ShenlunQuestionType, ShenlunRubricWeights> = {
  单一题: { content: 0.6, structure: 0.2, expression: 0.2 },
  综合题: { content: 0.55, structure: 0.25, expression: 0.2 },
  公文题: { content: 0.6, structure: 0.25, expression: 0.15 },
  作文题: { content: 0.45, structure: 0.3, expression: 0.25 }
}

const DOC_FORMAT_EXEMPT_RE =
  /不考虑格式|不必拘泥于?格式|格式不限|无需考虑格式|不要求格式|不写抬头|不用写格式|只写正文/
const DOC_FORMAT_TITLE_ONLY_RE =
  /提纲|纲要|要点|编者按|短评|微评|评论|导语|简报|情况说明|备忘录|调研报告|调查报告|考察报告|新闻稿|报道|推介(?!词)|工作方案|方案|摘要|综述/
const DOC_FORMAT_SEMI_RE = /讲话稿|发言稿|演讲稿|致辞|开幕词|闭幕词|讲解词|解说词|推介词|主持词/
const DOC_FORMAT_FULL_RE =
  /倡议书|公开信|感谢信|回信|慰问信|通知|通告|通报|请示|函|建议书|承诺书|号召书/

const MEASURE_SUBTYPE_RE =
  /(?:提出|给出|制定|撰写).{0,8}(?:对策|建议|措施)|对策建议|解决办法|整改措施|如何推进|如何解决|怎么办/
const PURE_SUMMARIZE_PRACTICE_RE =
  /^(?:请根据|根据).{0,20}(?:概括|归纳).{0,8}(?:做法|举措|经验|亮点)/
const PROBLEM_BEFORE_MEASURE_RE =
  /(?:概括|指出|梳理|分析).{0,22}(?:问题|不足|困境|原因).{0,25}(?:提出|给出|制定).{0,10}(?:对策|建议|措施)/

const LIST_STRUCTURE_RE =
  /(?:^|\n)\s*(?:[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|\(\d+\)|\d+[、.．]|[①②③④⑤⑥⑦⑧]|首先|其次|再次|最后|一是|二是|三是)/
const ESSAY_LOGIC_RE =
  /首先|其次|再次|一方面|另一方面|诚然|然而|但是|归根结底|由此可见|总而言之|综上所述|因此|只有.{1,16}才能/
const ANALYSIS_STANCE_RE =
  /本质|体现|说明|反映|意味着|值得肯定|既.{1,12}又|一方面.{1,20}另一方面|辩证|启示|归根到底/
const PROBLEM_MARKER_RE = /问题|不足|短板|困境|痛点|难点|制约|滞后|缺失|薄弱|原因/
const FLUFF_PHRASE_RE =
  /加大力度|高度重视|充分认识|切实加强|在.{1,12}过程中|不断提高|进一步推进|要坚持|应该积极|需要大力/g

const STOP_SEGMENTS_RE =
  /我们|你们|他们|它们|这里|那里|这个|那个|这些|那些|什么|怎么|如何|因此|所以|但是|而且|以及|或者|如果|虽然|因为|由于|通过|根据|按照|围绕|关于|对于|针对|为了|进行|开展|加强|推进|提升|促进|实现|推动|建设|发展|工作|问题|对策|建议|措施|材料|给定资料|要求|情况|方面|主要|相关|进一步|切实|不断/g

function clampScore(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

/** 还原模型在 JSON 字符串内双重转义残留的字面换行/制表符（如 `\\n` 解析后残留的 `\n`） */
export function unescapeEvalText(text: string): string {
  if (!text || !text.includes('\\')) return text
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '  ')
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

/** 从结构化答案与参考解析中提取子项级参考采分点 */
export function extractReferencePoints(answer: string[], explanation: string): string[] {
  const seen = new Set<string>()
  const points: string[] = []
  const addPoint = (raw: string): void => {
    const clean = raw
      .replace(/^(?:[一二三四五六七八九十]+[、.．)]|\d+[、.．)]|[（(]?\d+[)）]?|[•·\-*])\s*/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim()
    if (clean.length < 3 || clean.length > 260) return
    if (/^暂无参考答案/.test(clean)) return
    if (seen.has(clean)) return
    seen.add(clean)
    points.push(clean)
  }

  for (const item of answer) {
    for (const part of String(item).split(/[；;\n]/)) {
      addPoint(part)
    }
  }
  if (points.length < 2 && explanation) {
    for (const line of explanation.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || /^(?:参考答案|官方解析|评分标准|总字数|暂无参考答案)/.test(trimmed)) continue
      if (/^(?:\d+[、.．]|[-*•]|[一二三四五六七八九十]+[、.])/.test(trimmed)) {
        addPoint(trimmed)
      }
      if (points.length >= 12) break
    }
  }
  return points.slice(0, 15)
}

function resolveDocFormat(compactStem: string): {
  level: DocFormatLevel
  hint: string
} {
  if (DOC_FORMAT_EXEMPT_RE.test(compactStem)) {
    return {
      level: 'none',
      hint: '题干已豁免格式（格式不限/不写抬头落款），仅评估正文要点与层次，不因缺称谓或落款扣分'
    }
  }
  if (DOC_FORMAT_TITLE_ONLY_RE.test(compactStem)) {
    return {
      level: 'title-only',
      hint: '弱格式/标题正文类（提纲/报告/短评/编者按等）：需具备标题与分层正文，不强求称谓与落款'
    }
  }
  if (DOC_FORMAT_SEMI_RE.test(compactStem)) {
    return {
      level: 'semi',
      hint: '半格式（现场发言/讲话/讲解类）：需具备标题、顶格称谓与正文，一般不写落款和成文日期'
    }
  }
  if (DOC_FORMAT_FULL_RE.test(compactStem)) {
    return {
      level: 'full',
      hint: '全格式公文（倡议书/公开信/通知/函等）：需完整具备标题、顶格称谓/主送机关、正文、落款与日期'
    }
  }
  return {
    level: 'title-only',
    hint: '常规事务文书：需具备明确标题与条理清晰的正文层次'
  }
}

/** 从申论题干与题目分类解析题型、分值、字数要求、公文格式层级及特殊指令约束 */
export function parseShenlunStemRubric(stem: string, category?: string): ShenlunStemRubric {
  const questionType = classifyShenlunType(category, stem)
  const cat = (category ?? '').trim()
  const compactStem = (stem ?? '').replace(/\s+/g, '')

  let subType: ShenlunSubType = '归纳概括'
  if (questionType === '作文题') {
    subType = '文章写作'
  } else if (questionType === '公文题') {
    subType = '贯彻执行'
  } else if (questionType === '综合题') {
    subType = '综合分析'
  } else if (
    /提出对策/.test(cat) ||
    (MEASURE_SUBTYPE_RE.test(compactStem) && !PURE_SUMMARIZE_PRACTICE_RE.test(compactStem))
  ) {
    subType = '提出对策'
  }

  let fullScore: number | undefined
  const parenMatches = [...stem.matchAll(/[（(]\s*(\d{1,3})\s*分\s*[）)]/g)]
  for (let i = parenMatches.length - 1; i >= 0; i -= 1) {
    const num = Number(parenMatches[i]?.[1])
    if (Number.isFinite(num) && num >= 5 && num <= 100) {
      fullScore = num
      break
    }
  }
  if (fullScore === undefined) {
    const explicitMatch = stem.match(/(?:本题|满分|共)\s*(\d{1,3})\s*分/)
    if (explicitMatch?.[1]) {
      const num = Number(explicitMatch[1])
      if (Number.isFinite(num) && num >= 5 && num <= 100) fullScore = num
    }
  }

  const wordLimit = extractWordLimit(stem)
  const weights = RUBRIC_WEIGHTS[questionType]

  const docFormat = questionType === '公文题' ? resolveDocFormat(compactStem) : undefined
  const titleMatch =
    compactStem.match(/以[“"「《]([^”"」》]{2,40})[”"」》]为题(?![目材])/) ??
    compactStem.match(/(?:起草|撰写|拟写|写)一?[份篇]?\s*《([^》]{2,40})》/)
  const requiredTitle = titleMatch?.[1]?.trim() || undefined
  const requiresTitle =
    questionType === '作文题' || (questionType === '公文题' && docFormat?.level !== 'none')

  return {
    questionType,
    subType,
    fullScore,
    wordLimit,
    weights,
    docFormatLevel: docFormat?.level,
    docFormatHint: docFormat?.hint,
    requiredTitle,
    requiresTitle,
    requiresProblemBeforeMeasure:
      subType === '提出对策' && PROBLEM_BEFORE_MEASURE_RE.test(compactStem)
  }
}

function normalizeTitleCompare(text: string): string {
  return text.replace(/[《》“”"'‘’：:\s]/g, '')
}

function measureMaterialCopyRatio(content: string, material?: string): number {
  const cleanContent = content.replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '')
  const cleanMaterial = (material ?? '').replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '')
  if (cleanMaterial.length < 120 || cleanContent.length < 60) return 0

  const windowSize = 16
  const step = 4
  let windows = 0
  let hits = 0
  for (let pos = 0; pos <= cleanContent.length - windowSize; pos += step) {
    windows += 1
    if (cleanMaterial.includes(cleanContent.slice(pos, pos + windowSize))) {
      hits += 1
    }
  }
  return windows > 0 ? Number((hits / windows).toFixed(2)) : 0
}

/** 采集作答的客观可量化特征（精确字数、25 格实考占格、格式要素与材料照搬度） */
export function inspectShenlunAnswerMetrics(
  content: string,
  rubric: ShenlunStemRubric,
  material?: string
): ShenlunAnswerMetrics {
  const wordCount = content.replace(/\s/g, '').length
  const sheetCellCount = buildShenlunSheetGrid(
    content,
    rubric.wordLimit?.max ?? null,
    content.length
  ).lastFilledCellNumber
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const paragraphCount = lines.length
  const firstLine = lines[0] ?? ''

  const looksLikeListStart =
    /^(?:[一二三四五六七八九十]+[、.．]|\d+[、.．]|（[一二三四五六七八九十\d]+）|\(\d+\))/.test(
      firstLine
    )
  const hasTitle =
    /^【?编者按】?[：:]?/.test(firstLine) ||
    (lines.length >= 2 &&
      firstLine.length >= 2 &&
      firstLine.length <= 38 &&
      !/[。；，,;]$/.test(firstLine) &&
      !looksLikeListStart)

  const matchesRequiredTitle = rubric.requiredTitle
    ? hasTitle &&
      (() => {
        const cleanFirst = normalizeTitleCompare(firstLine)
        const cleanRequired = normalizeTitleCompare(rubric.requiredTitle)
        return (
          cleanFirst.length >= 4 &&
          (cleanFirst.includes(cleanRequired) || cleanRequired.includes(cleanFirst))
        )
      })()
    : true

  const hasSalutation = lines.slice(0, 3).some((line) => {
    if (line.length > 26) return false
    if (/^(?:[一二三四五六七八九十]+[、.．]|\d+[、.．]|（\d+）|编者按|【编者按】)/.test(line)) {
      return false
    }
    return /[：:]$/.test(line)
  })

  const tailStart = lines.length > 1 ? Math.max(1, lines.length - 3) : lines.length
  const hasSignOff = lines
    .slice(tailStart)
    .some(
      (line) =>
        /(?:\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日|[X×〇○]{2,4}年[X×〇○]{1,2}月(?:[X×〇○]{1,2}日)?)$/.test(
          line
        ) ||
        (line.length >= 2 &&
          line.length <= 20 &&
          !/[。！？；…]$/.test(line) &&
          !/^(?:[一二三四五六七八九十]+[、.．]|\d+[、.．])/.test(line))
    )

  const hasListStructure = LIST_STRUCTURE_RE.test(content)
  const materialCopyRatio = measureMaterialCopyRatio(content, material)
  const essayFloor = Math.min(500, Math.round((rubric.wordLimit?.min ?? 800) * 0.6))
  const residualEssay = rubric.questionType === '作文题' && wordCount < essayFloor

  const hardPenalties: string[] = []
  if (residualEssay) {
    hardPenalties.push(
      `作文字数严重不足（${wordCount} 字），按真考标准判为残文，最高降入三类下/四类文`
    )
  } else if (rubric.wordLimit?.min && wordCount < rubric.wordLimit.min) {
    hardPenalties.push(
      `字数低于下限（${wordCount}/${rubric.wordLimit.min} 字），真考按差额每约 50 字折合扣分`
    )
  }
  if (rubric.wordLimit?.max && sheetCellCount > rubric.wordLimit.max) {
    hardPenalties.push(
      `实考 25 格占格已达 ${sheetCellCount} 格，超过 ${rubric.wordLimit.max} 字上限（超格部分存在扫不到风险）`
    )
  }
  if (rubric.requiresTitle && !hasTitle) {
    hardPenalties.push('缺少独立标题行（大作文与公文题漏写标题通常扣除格式/标题分）')
  } else if (rubric.requiredTitle && !matchesRequiredTitle) {
    hardPenalties.push(`题干已指定标题「${rubric.requiredTitle}」，首行未严格使用给定标题`)
  }
  if (rubric.questionType === '公文题' && rubric.docFormatLevel === 'full') {
    if (!hasSalutation) hardPenalties.push('全格式公文缺少称谓或主送机关（需顶格加冒号）')
    if (!hasSignOff) hardPenalties.push('全格式公文缺少落款（发文机关）或成文日期')
  } else if (rubric.questionType === '公文题' && rubric.docFormatLevel === 'semi' && hasSignOff) {
    hardPenalties.push('半格式现场发言类文书一般不写落款与日期，建议检查末尾是否多余')
  }
  if (materialCopyRatio >= 0.5) {
    hardPenalties.push(
      `约 ${Math.round(materialCopyRatio * 100)}% 内容直接照搬材料原句，缺乏归纳提炼或论证展开`
    )
  }

  return {
    wordCount,
    sheetCellCount,
    paragraphCount,
    hasTitle,
    matchesRequiredTitle,
    hasSalutation,
    hasSignOff,
    hasListStructure,
    materialCopyRatio,
    residualEssay,
    hardPenalties
  }
}

/** 计算真考申论档位标签（大作文四类文分档 / 小题四档评价） */
export function computeShenlunTierLabel(score: number, questionType: ShenlunQuestionType): string {
  if (questionType === '作文题') {
    if (score >= 88) return '一类上'
    if (score >= 78) return '一类文'
    if (score >= 68) return '二类上'
    if (score >= 55) return '二类文'
    if (score >= 30) return '三类文'
    return '四类文'
  }
  if (score >= 85) return '优秀（一类）'
  if (score >= 70) return '良好（二类）'
  if (score >= 55) return '合格（三类）'
  return '待加强（四类）'
}

/** 将百分制评分按半分粒度折算为题干实际满分（如 15/20/25/30/40 分） */
export function convertToExamScore(score100: number, fullScore: number): number {
  return Math.round((clampScore(score100) / 100) * fullScore * 2) / 2
}

/** 构造评估结果元数据（含题型、折算分、档位、字数/占格及客观风险提示） */
export function buildEvaluationMeta(
  score: number,
  rubric: ShenlunStemRubric,
  metrics: ShenlunAnswerMetrics
): ConstructedEvaluationMeta {
  return {
    questionType: rubric.questionType,
    subType: rubric.subType,
    ...(rubric.fullScore !== undefined
      ? {
          fullScore: rubric.fullScore,
          convertedScore: convertToExamScore(score, rubric.fullScore)
        }
      : {}),
    tierLabel: computeShenlunTierLabel(score, rubric.questionType),
    wordCount: metrics.wordCount,
    sheetCellCount: metrics.sheetCellCount,
    ...(rubric.wordLimit ? { wordLimitLabel: rubric.wordLimit.label } : {}),
    ...(metrics.hardPenalties.length > 0 ? { penalties: metrics.hardPenalties } : {})
  }
}

export interface CalibratableEvaluation {
  score: number
  dimensions: Array<{ name: string; score: number; comment: string }>
  summary: string
  suggestions: string[]
}

/** 对 AI（或本地规则）输出执行确定性校准：权重偏差护栏、大作文残文/照搬硬封顶与题面分折算 */
export function calibrateConstructedEvaluation<T extends CalibratableEvaluation>(
  evaluation: T,
  rubric: ShenlunStemRubric,
  metrics: ShenlunAnswerMetrics
): T & { rubricMeta: ConstructedEvaluationMeta } {
  let score = clampScore(Math.round(evaluation.score))
  let dimensions = evaluation.dimensions.map((d) => ({
    ...d,
    score: clampScore(Math.round(d.score))
  }))
  let summary = evaluation.summary.trim()

  if (dimensions.length >= 3) {
    const contentDim = dimensions.find((d) => /要点|内容|立意/.test(d.name))
    const structureDim = dimensions.find((d) => /结构|格式|逻辑/.test(d.name))
    const expressionDim = dimensions.find((d) => /表达|语言|字数/.test(d.name))
    if (contentDim && structureDim && expressionDim) {
      const weighted = Math.round(
        contentDim.score * rubric.weights.content +
          structureDim.score * rubric.weights.structure +
          expressionDim.score * rubric.weights.expression
      )
      if (Math.abs(weighted - score) > 15) {
        score = clampScore(Math.round((score + weighted) / 2))
      }
    }
  }

  let cap: number | undefined
  const capReasons: string[] = []
  if (rubric.questionType === '作文题') {
    if (metrics.wordCount < 300) {
      cap = 28
      capReasons.push(`字数仅 ${metrics.wordCount} 字（严重残文，按四类文封顶）`)
    } else if (metrics.wordCount < 500) {
      cap = 42
      capReasons.push(`字数仅 ${metrics.wordCount} 字（不足 500 字残文，按三类下封顶）`)
    } else if (rubric.wordLimit?.min && metrics.wordCount < rubric.wordLimit.min * 0.7) {
      cap = 58
      capReasons.push(
        `字数低于下限 70%（${metrics.wordCount}/${rubric.wordLimit.min} 字，按二类下限封顶）`
      )
    }
    if (metrics.materialCopyRatio >= 0.65) {
      cap = cap !== undefined ? Math.min(cap, 35) : 35
      capReasons.push(
        `原样照搬材料比例约 ${Math.round(metrics.materialCopyRatio * 100)}%（按四类/三类低档封顶）`
      )
    }
  }

  if (cap !== undefined && score > cap) {
    score = cap
    dimensions = dimensions.map((d) => ({
      ...d,
      score: Math.min(d.score, Math.min(100, cap + 8))
    }))
    const reasonNote = `【真考规则校准】${capReasons.join('；')}，总分已校准封顶至 ${cap} 分。`
    summary = summary ? `${summary}\n${reasonNote}` : reasonNote
  }

  const rubricMeta = buildEvaluationMeta(score, rubric, metrics)
  if (
    rubricMeta.fullScore !== undefined &&
    rubricMeta.convertedScore !== undefined &&
    !new RegExp(`/${rubricMeta.fullScore}(?:\\s*分)?`).test(summary)
  ) {
    const scoreSuffix = `（折合题面约 ${rubricMeta.convertedScore}/${rubricMeta.fullScore} 分 · ${rubricMeta.tierLabel}）`
    summary = summary ? `${summary} ${scoreSuffix}` : scoreSuffix
  }

  return {
    ...evaluation,
    score,
    dimensions,
    summary,
    rubricMeta
  }
}

function extractMeaningfulBigrams(text: string): string[] {
  const cleaned = text.replace(STOP_SEGMENTS_RE, ' ').replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, ' ')
  const tokens = new Set<string>()
  for (const seg of cleaned.split(/\s+/)) {
    const s = seg.trim()
    if (s.length < 2) continue
    if (s.length <= 4) {
      tokens.add(s)
    } else {
      for (let i = 0; i <= s.length - 2; i += 1) {
        tokens.add(s.slice(i, i + 2))
        if (i <= s.length - 3) tokens.add(s.slice(i, i + 3))
      }
    }
  }
  return [...tokens]
}

function evaluatePointMatchRatio(contentCompact: string, point: string): number {
  const cleanPoint = point.replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '')
  if (cleanPoint && contentCompact.includes(cleanPoint)) return 1
  const tokens = extractMeaningfulBigrams(point)
  if (tokens.length === 0) return contentCompact.includes(cleanPoint.slice(0, 4)) ? 1 : 0
  let hits = 0
  for (const token of tokens) {
    if (contentCompact.includes(token)) hits += 1
  }
  return hits / tokens.length
}

function extractMaterialCoreTokens(material: string, stem: string): string[] {
  const freq = new Map<string, number>()
  const combined = `${stem}\n${material.slice(0, 6000)}`
  for (const token of extractMeaningfulBigrams(combined)) {
    if (token.length < 2) continue
    freq.set(token, (freq.get(token) ?? 0) + 1)
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 24)
    .map(([token]) => token)
}

function resolveExpectedWordRange(rubric: ShenlunStemRubric): { min: number; max: number } {
  if (rubric.wordLimit?.min && rubric.wordLimit?.max) {
    return { min: rubric.wordLimit.min, max: rubric.wordLimit.max }
  }
  if (rubric.wordLimit?.max) {
    return { min: Math.round(rubric.wordLimit.max * 0.8), max: rubric.wordLimit.max }
  }
  if (rubric.wordLimit?.min) {
    return { min: rubric.wordLimit.min, max: Math.round(rubric.wordLimit.min * 1.25) }
  }
  if (rubric.questionType === '作文题') return { min: 800, max: 1200 }
  if (rubric.questionType === '公文题') return { min: 300, max: 600 }
  return { min: 150, max: 400 }
}

/** 升级版离线本地规则评分：分题型结构与格式核查、词元级采分点覆盖、题干字数与占格校验 */
export function evaluateShenlunLocally(
  promptId: string,
  content: string,
  prompt?: Question,
  precomputedRubric?: ShenlunStemRubric,
  precomputedMetrics?: ShenlunAnswerMetrics,
  options?: { id?: string; createdAt?: string }
): ConstructedEvaluation {
  const rubric = precomputedRubric ?? parseShenlunStemRubric(prompt?.stem ?? '', prompt?.category)
  const metrics =
    precomputedMetrics ?? inspectShenlunAnswerMetrics(content, rubric, prompt?.material)
  const compactContent = content.replace(/\s+/g, '')
  const cleanExp =
    prompt?.explanation && !prompt.explanation.startsWith('暂无参考答案') ? prompt.explanation : ''
  const points = extractReferencePoints(prompt?.answer ?? [], cleanExp)

  // 1. 要点覆盖
  let accuracy: number
  let contentComment: string
  let missingCount = 0
  if (points.length > 0) {
    let earned = 0
    const missed: string[] = []
    for (const pt of points) {
      const ratio = evaluatePointMatchRatio(compactContent, pt)
      if (ratio >= 0.55) {
        earned += 1
      } else if (ratio >= 0.28) {
        earned += 0.5
      } else {
        missed.push(pt.slice(0, 18))
      }
    }
    missingCount = missed.length
    const coverage = earned / points.length
    accuracy = clampScore(Math.round(35 + coverage * 62), 0, 97)
    const missTip = missed.length ? `；待补充：【缺：${missed.slice(0, 2).join('；')}】` : ''
    contentComment = `对照 ${points.length} 个参考要点词元，等效命中 ${earned.toFixed(1)} 项${missTip}`
  } else if ((prompt?.material ?? '').trim().length >= 200) {
    const coreTokens = extractMaterialCoreTokens(prompt!.material!, prompt?.stem ?? '')
    const hitTokens = coreTokens.filter((t) => compactContent.includes(t))
    const coverage = coreTokens.length > 0 ? hitTokens.length / coreTokens.length : 0.5
    accuracy = clampScore(Math.round(42 + Math.min(1, coverage * 1.45) * 48), 40, 90)
    contentComment = `本题暂无参考要点，已结合材料高频核心词评估贴合度（命中 ${hitTokens.length}/${coreTokens.length} 个关键概念）。`
  } else {
    accuracy = 72
    contentComment = '当前题目没有结构化参考要点或材料文本，按作答完整度估算基础分。'
  }

  if (metrics.materialCopyRatio >= 0.5) {
    const copyPenalty = Math.round((metrics.materialCopyRatio - 0.4) * 45)
    accuracy = clampScore(accuracy - copyPenalty, 20, 95)
    contentComment += `（检测到约 ${Math.round(metrics.materialCopyRatio * 100)}% 直接照搬材料，已按规则折减）`
  }

  // 2. 结构组织
  let structure = 52
  const structureHints: string[] = []
  if (rubric.questionType === '作文题') {
    if (metrics.hasTitle) {
      if (metrics.matchesRequiredTitle) {
        structure += 12
        structureHints.push('已拟独立标题')
      } else {
        structure += 2
        structureHints.push(`标题未按题干使用「${rubric.requiredTitle}」`)
      }
    } else {
      structureHints.push('缺少独立标题')
    }
    structure +=
      metrics.paragraphCount >= 4
        ? 18
        : metrics.paragraphCount >= 3
          ? 12
          : metrics.paragraphCount >= 2
            ? 6
            : 0
    if (ESSAY_LOGIC_RE.test(content)) {
      structure += 10
      structureHints.push('具备论证推进层次')
    } else {
      structureHints.push('建议补充清晰的段首中心句与递进逻辑')
    }
  } else if (rubric.questionType === '公文题') {
    const level = rubric.docFormatLevel ?? 'title-only'
    if (level === 'full') {
      if (metrics.hasTitle) structure += 10
      else structureHints.push('缺标题')
      if (metrics.hasSalutation) structure += 10
      else structureHints.push('缺称谓/主送机关')
      if (metrics.hasSignOff) structure += 10
      else structureHints.push('缺落款/成文日期')
      if (metrics.hasListStructure || metrics.paragraphCount >= 3) structure += 14
    } else if (level === 'semi') {
      if (metrics.hasTitle) structure += 12
      else structureHints.push('缺标题')
      if (metrics.hasSalutation) structure += 12
      else structureHints.push('发言稿缺开场称谓')
      if (metrics.hasListStructure || metrics.paragraphCount >= 3) structure += 18
      if (metrics.hasSignOff) {
        structure -= 6
        structureHints.push('发言稿末尾一般无需落款日期')
      }
    } else if (level === 'title-only') {
      if (metrics.hasTitle) structure += 14
      else structureHints.push('缺标题')
      if (metrics.hasListStructure) structure += 18
      else structureHints.push('建议分条列项')
      if (metrics.paragraphCount >= 2) structure += 10
    } else {
      if (metrics.hasListStructure) structure += 24
      if (metrics.paragraphCount >= 2) structure += 18
      structureHints.push('题干已豁免格式，未扣称谓/落款分')
    }
  } else if (rubric.questionType === '综合题') {
    if (metrics.paragraphCount >= 2) structure += 14
    if (metrics.hasListStructure) structure += 16
    if (ANALYSIS_STANCE_RE.test(content)) {
      structure += 10
      structureHints.push('体现了表态释义或多维辨析')
    } else {
      structureHints.push('建议按“是什么（表态）—为什么（多维分析）—怎么办”闭环组织')
    }
  } else {
    if (metrics.hasListStructure) structure += 24
    else structureHints.push('建议用“1. 2. 3.”分条列点')
    if (metrics.paragraphCount >= 2) structure += 12
    if (rubric.requiresProblemBeforeMeasure && !PROBLEM_MARKER_RE.test(content)) {
      structure -= 8
      structureHints.push('题干要求先指出问题再提对策，正文中未显式体现问题维度')
    }
  }
  structure = clampScore(structure, 25, 96)
  const structureComment =
    structureHints.length > 0
      ? structureHints.join('；')
      : '分段与条理较清楚，结构符合本题作答要求。'

  // 3. 表达规范与字数
  const expectedRange = resolveExpectedWordRange(rubric)
  const effectiveLen = metrics.sheetCellCount || metrics.wordCount
  let expression = 88
  const expHints: string[] = []

  if (effectiveLen < expectedRange.min * 0.9) {
    const shortageRatio = (expectedRange.min - effectiveLen) / Math.max(1, expectedRange.min)
    expression -= Math.min(42, Math.round(shortageRatio * 55))
    expHints.push(
      `偏短（实写 ${metrics.wordCount} 字，建议达 ${expectedRange.min}–${expectedRange.max} 字）`
    )
  } else if (rubric.wordLimit?.max && effectiveLen > rubric.wordLimit.max * 1.05) {
    const overRatio = (effectiveLen - rubric.wordLimit.max) / Math.max(1, rubric.wordLimit.max)
    expression -= Math.min(24, Math.round(overRatio * 50) + 4)
    expHints.push(`超出上限（占格 ${metrics.sheetCellCount}，上限 ${rubric.wordLimit.max} 字）`)
  } else {
    expHints.push(
      `字数与占格匹配良好（实写 ${metrics.wordCount} 字 · 占格 ${metrics.sheetCellCount}）`
    )
  }

  const fluffMatches = content.match(FLUFF_PHRASE_RE)?.length ?? 0
  if (fluffMatches >= 3) {
    expression -= Math.min(10, fluffMatches * 2)
    expHints.push('部分空泛套话偏多，可改用“动词+对象+具体动作”压实表达')
  }
  if (metrics.materialCopyRatio >= 0.5) {
    expression -= Math.min(24, Math.round((metrics.materialCopyRatio - 0.45) * 45))
    expHints.push('原样照抄材料偏多，需进行归纳提炼或论据改写')
  }
  expression = clampScore(expression, 25, 95)

  const totalScore = Math.round(
    accuracy * rubric.weights.content +
      structure * rubric.weights.structure +
      expression * rubric.weights.expression
  )

  const suggestions: string[] = []
  if (missingCount > 0 || points.length === 0) {
    suggestions.push(
      points.length > 0
        ? '优先对照遗漏采分点回查给定材料对应段落，补齐核心关键词与做法。'
        : '围绕题干问法紧扣给定材料提炼核心动词短语，避免脱离材料泛泛而谈。'
    )
  } else {
    suggestions.push('参考要点覆盖较完整，可继续用材料规范短语压缩冗余表述。')
  }
  if (metrics.hardPenalties.length > 0) {
    suggestions.push(`优先处理格式与篇幅硬项：${metrics.hardPenalties[0]}。`)
  } else if (!metrics.hasListStructure && rubric.questionType !== '作文题') {
    suggestions.push('采用“总括词：具体表现/举措”分条编号作答，提升阅卷踩点识别效率。')
  } else {
    suggestions.push('保持分条分层习惯，在每个要点前凝练前置概括词。')
  }
  suggestions.push(
    rubric.questionType === '作文题'
      ? '大作文需围绕总论点设置 3 个平行或递进分论点，并将材料案例融入说理分析中。'
      : '删除“高度重视/加大力度”等空泛水词，多用材料原词或忠实近义归纳。'
  )

  const rawResult = {
    id:
      options?.id ??
      (typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    promptId,
    score: totalScore,
    dimensions: [
      { name: '要点覆盖', score: accuracy, comment: contentComment },
      { name: '结构组织', score: structure, comment: structureComment },
      { name: '表达规范', score: expression, comment: expHints.join('；') }
    ],
    summary:
      '这是基于真考分题型与占格规则的本地评估（不替代人工或语义批改）。配置 AI 后可获得逐句语义比对与示范作答。',
    suggestions,
    createdAt: options?.createdAt ?? new Date().toISOString(),
    provider: 'local-rubric'
  }

  return calibrateConstructedEvaluation(rawResult, rubric, metrics)
}
