// 导入质量模型：把「一个 OCR 平均置信度」拆成可核对的维度。
// 原则：能算的才算（不做假的版面分）；异常只告警不静默修正；无法确认的标记人工审核。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RegionBlock {
  type: string
  page: number
  bbox: number[]
  imgPath: string
  text: string
}

export interface StructuredRegions {
  pages: number
  regions: RegionBlock[]
  removedNoise?: number
}

/** 读取结构解析产出的版面块清单（images/_regions.json，随图片归档走缓存） */
export function loadStructuredRegions(imagesDirectory: string): StructuredRegions | undefined {
  try {
    const path = join(imagesDirectory, '_regions.json')
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StructuredRegions>
    if (!parsed || !Array.isArray(parsed.regions)) return undefined
    return {
      pages: Number(parsed.pages) || 0,
      regions: parsed.regions.filter(
        (block): block is RegionBlock =>
          Boolean(block) && typeof block.type === 'string' && Array.isArray(block.bbox)
      ),
      removedNoise: Number(parsed.removedNoise) || 0
    }
  } catch {
    return undefined
  }
}

export interface NumericAnomalies {
  count: number
  samples: string[]
  /** 数字流行数：坐标轴/表格残渣被拼成正文的主要形态 */
  numberStreamLines: number
}

const NUMERIC_TOKEN = /^[-+]?[\d,，]+(?:\.\d+)?[%％]?$/

/** 数字流行判定：≥6 个纯数字 token 且占比 ≥60%，且不含中文散文——
 *  含中文的混排行走行内数字串隔离（保留散文、隔离数字串） */
export function isNumberStreamLine(line: string): boolean {
  if (/[\u4e00-\u9fff]/.test(line)) return false
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length < 6) return false
  const numeric = tokens.filter((token) => NUMERIC_TOKEN.test(token)).length
  return numeric / tokens.length >= 0.6
}

/** 解析文本行隔离：整行数字流替换为占位标记；行内 ≥3 个连续裸数字 token 的
 * 串以审计块保留原数字（不静默删除、不猜测语义）。公式与带单位数字不受影响
 * （「6390- 5980 410 ≈100亿元」「已知1.24 = 2.07」等含运算符/单位的不命中）。 */
export function quarantineNumberStreamLine(line: string): string {
  if (isNumberStreamLine(line)) return '> [图表数据区已隔离，建议对照原图核对数字]'
  return line.replace(
    /(?:[-+]?\d[\d,.]*%?[（(]?\s+){2,}[-+]?\d[\d,.]*%?[）)]?/g,
    (match) => `\n> [图表数字串，OCR 无法确认语义，请对照原图]\n> ${match.trim()}\n`
  )
}

const WATERMARK_PATTERNS = [
  /公考最新资料[、，]?\s*更新进度微信\S*/g,
  /微信SKA\d+/g,
  /公众号[：:]\S+/g,
  /超格学员专用/g,
  /资料分析600[贴折]/g
] as const

/** 行内水印剥离：只删命中的机构宣传片段，题目出处/年份/地区/资料来源不动 */
export function stripWatermarkFragments(lines: string[]): {
  lines: string[]
  removedFragments: number
} {
  let removedFragments = 0
  const cleaned = lines.map((line) => {
    let result = line
    for (const pattern of WATERMARK_PATTERNS) {
      result = result.replace(pattern, () => {
        removedFragments += 1
        return ''
      })
    }
    return result.replace(/\s{2,}/g, ' ').trim()
  })
  return { lines: cleaned.filter(Boolean), removedFragments }
}

// 资料分析专用数字异常扫描：
// 1) 数字流行——统计图坐标标签混入正文
// 2) 多小数点（1.2.3）——小数点/分隔符识别错误
// 3) 全角数字（０-９）——未规范化
// 只产生告警与计数，不静默改写数字内容。
export function scanNumericAnomalies(lines: string[]): NumericAnomalies {
  let count = 0
  let numberStreamLines = 0
  const samples: string[] = []
  const note = (kind: string, line: string): void => {
    count += 1
    if (samples.length < 5) samples.push(`[${kind}] ${line.slice(0, 60)}`)
  }
  for (const line of lines) {
    if (isNumberStreamLine(line)) {
      numberStreamLines += 1
      note('数字流', line)
      continue
    }
    if (/\d\.\d+\.\d/.test(line)) note('多小数点', line)
    else if (/[０-９]/.test(line)) note('全角数字', line)
  }
  return { count, samples, numberStreamLines }
}

export interface TableQuality {
  /** markdown 表格数量 */
  tables: number
  /** 列数不一致（单元格残缺）的表格数 */
  ragged: number
  /** 表格结构置信度：1 - 残缺占比；无表格时缺省不发布误导数值 */
  confidence?: number
}

// 表格结构一致性：识别 markdown 管道表格与 HTML 表格（RapidDoc 还原输出形态），
// 列/单元格数不一致说明单元格识别残缺——不强行补齐，按数量产生告警。
export function scanTableQuality(markdown: string): TableQuality {
  let tables = 0
  let ragged = 0
  // markdown 管道表格：连续 | 行，各行列数需一致
  let current: number[] | undefined
  const close = (): void => {
    if (!current) return
    tables += 1
    if (current.some((cells) => cells !== current![0])) ragged += 1
    current = undefined
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split('|').length - 2
      if (!current) current = [cells]
      else current.push(cells)
    } else {
      close()
    }
  }
  close()
  // HTML 表格：逐表比较各行 td/th 单元格数
  const htmlTables = markdown.match(/<table[\s\S]*?<\/table>/gi) ?? []
  for (const table of htmlTables) {
    tables += 1
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const counts = rows.map((row) => (row.match(/<t[dh][\s>]/gi) ?? []).length)
    if (counts.some((cells) => cells !== counts[0])) ragged += 1
  }
  return {
    tables,
    ragged,
    ...(tables > 0 ? { confidence: Math.round((1 - ragged / tables) * 100) / 100 } : {})
  }
}

export interface Completeness {
  total: number
  complete: number
  /** 题目切分置信度：题干与选项结构完整的题目占比 */
  confidence: number
}

export function questionCompleteness(
  questions: Array<{ stem?: string; options: Array<{ key: string }> }>
): Completeness {
  const total = questions.length
  const complete = questions.filter(
    (question) => (question.stem?.length ?? 0) >= 8 && question.options.length >= 2
  ).length
  return {
    total,
    complete,
    confidence: total ? Math.round((complete / total) * 100) / 100 : 0
  }
}

// 结构性噪声行：单独成行的「请回答1～5题」「（第1~5题）」等组题指引，
// 不是题干也不是材料——过滤而非并入材料/题干（不允许当普通题干）。
export const STRUCTURAL_NOISE_LINE =
  /^[（(]?\s*(?:请回答|请根据.*回答)?\s*第?\s*\d{1,3}\s*[～～~-]\s*\d{1,3}\s*题\s*[)）]?$/

export function stripStructuralNoise(lines: string[]): { lines: string[]; removed: number } {
  const kept = lines.filter((line) => !STRUCTURAL_NOISE_LINE.test(line))
  return { lines: kept, removed: lines.length - kept.length }
}

// ---- 解析文本清洗阶段：parseSolutionBook 之后、生成题目之前的纯函数 ----
// 原则：不猜语义、不改数值；水印只删宣传片段；圆圈数字分类而非删除；
// 断句问题只告警提示人工对照，不自动补写。

const WATERMARK_TRAINS = [
  /公考最新资料[、，]?\s*更新进度微信\S*/g,
  /微信SKA\d+/g,
  /公众号[：:]\S+/g,
  /超格学员专用/g,
  /资料分析600[贴折]/g,
  /(?:^|[\s，、。])花生十[三]?(?=\s*[，、。]|(?:\s|$))/g
] as const

const CIRCLE_MARK = /[①②③④⑤⑥⑦⑧⑨⑩]/
const STEP_MARK_START = /^\s*[①②③④⑤⑥⑦⑧⑨⑩]/
const AUDIT_PREFIX = '> '
const ENDS_WITH_PARAGRAPH_PUNCT = /[。；：！？”」』]$/
const ENDS_WITH_STOPWORD = /(的|在|和|比|该|与|及|或|占|为)$/

export interface ExplanationCleanupResult {
  cleaned: string
  removedWatermarks: string[]
  removedFragments: string[]
  preservedNumericTokens: string[]
  suspiciousFragments: string[]
  readabilityWarnings: string[]
}

/** 圆圈数字分类：孤立即无句子上下文（整行只有标记及其零星数字）→ 审计块；
 *  句中则保留为原书的步骤编号，不做改动。 */
function classifyCircleMarks(line: string): { text: string; audited: boolean } {
  if (!CIRCLE_MARK.test(line)) return { text: line, audited: false }
  const stripped = line.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '').replace(/[\s\d.,，。、%％～～-]/g, '')
  if (stripped.length === 0) {
    const marks = (line.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) ?? []).join('')
    return { text: `${AUDIT_PREFIX}[原始图表标记：${marks}]`, audited: true }
  }
  return { text: line, audited: false }
}

/** 段落重建：中文行直接相接（不加空格），短行并入同段；审计块、步骤编号行、
 *  数字流行占位保持独立。禁止无脑 lines.join(' ')。 */
function rebuildParagraphs(lines: string[]): string[] {
  const output: string[] = []
  let paragraph = ''
  const flush = (): void => {
    if (paragraph.trim()) output.push(paragraph.trim())
    paragraph = ''
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    if (
      trimmed.startsWith(AUDIT_PREFIX) ||
      STEP_MARK_START.test(trimmed) ||
      trimmed.startsWith('【') ||
      trimmed.startsWith('#') ||
      isNumberStreamLine(trimmed)
    ) {
      flush()
      output.push(trimmed)
      continue
    }
    if (!paragraph) {
      paragraph = trimmed
      continue
    }
    // 中文相邻不加空格；前段以 ASCII 字母数字结尾且新行以 ASCII 开头时补一个空格
    const prevEnd = paragraph.slice(-1)
    const nextStart = trimmed.slice(0, 1)
    const needsSpace = /[A-Za-z0-9%）)]/.test(prevEnd) && /[A-Za-z0-9（(]/.test(nextStart)
    paragraph += (needsSpace ? ' ' : '') + trimmed
    if (ENDS_WITH_PARAGRAPH_PUNCT.test(trimmed)) flush()
  }
  flush()
  return output
}

export function cleanExplanation(raw: string): ExplanationCleanupResult {
  const removedWatermarks: string[] = []
  const removedFragments: string[] = []
  const preservedNumericTokens: string[] = []
  const suspiciousFragments: string[] = []
  const readabilityWarnings: string[] = []

  // 1) 行级清洗：水印片段剥离（保留审计记录）+ 圆圈数字分类
  const classified: string[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) {
      classified.push('')
      continue
    }
    for (const pattern of WATERMARK_TRAINS) {
      line = line.replace(pattern, (match) => {
        removedWatermarks.push(match.trim())
        return ' '
      })
    }
    line = line.replace(/\s{2,}/g, ' ').trim()
    if (!line) {
      classified.push('')
      continue
    }
    const circle = classifyCircleMarks(line)
    classified.push(circle.text)
  }

  // 2) 审计块收集（数字串占位已由 quarantineNumberStreamLine 在上游产出）
  for (const line of classified) {
    if (line.includes('图表数字串，OCR 无法确认语义'))
      preservedNumericTokens.push(line.replace(AUDIT_PREFIX, '').slice(0, 80))
  }

  // 3) 段落重建
  const rebuilt = rebuildParagraphs(classified)

  // 4) 可读性检查（只告警，不补写语义）
  const prose = rebuilt.filter((line) => !line.startsWith(AUDIT_PREFIX)).join('\n')
  if (removedWatermarks.length === 0 && /公考最新资料|微信SKA\d+|超格学员专用/.test(prose))
    readabilityWarnings.push('解析仍存在已知水印，请人工清理')
  if (/\d[.,]?\s+\d[.,]?\s+\d[.,]?\s+\d/.test(prose))
    readabilityWarnings.push('解析存在疑似 OCR 断句，请对照原图')
  const open = (prose.match(/（/g) ?? []).length
  const close = (prose.match(/）/g) ?? []).length
  if (open !== close) readabilityWarnings.push('解析存在未闭合括号，可能存在断行丢失')
  for (const line of rebuilt) {
    if (line.startsWith(AUDIT_PREFIX) || line.startsWith('【') || line.startsWith('>')) continue
    if (ENDS_WITH_STOPWORD.test(line.trim()) && line.trim().length > 4)
      readabilityWarnings.push('解析存在疑似 OCR 断句，请对照原图')
  }
  if (prose.replace(/\s/g, '').length > 0 && prose.replace(/[\d\s.,%％～～-]/g, '').length === 0)
    readabilityWarnings.push('解析只剩数字或符号，请对照原图')

  return {
    cleaned: rebuilt.join('\n'),
    removedWatermarks: [...new Set(removedWatermarks)],
    removedFragments,
    preservedNumericTokens: [...new Set(preservedNumericTokens)],
    suspiciousFragments,
    readabilityWarnings: [...new Set(readabilityWarnings)]
  }
}

// ---- 能力边界收敛：诚实标注每份资料能被自动结构化到什么程度 ----
import type { ImportCapability } from '../../shared/contracts'

export const CAPABILITY_LABELS: Record<ImportCapability, string> = {
  'text-supported': '文字题 · 可自动导入',
  'table-review': '统计图/复杂表格 · 建议人工抽查',
  'image-only-review': '图片题 · 人工审核',
  'graphic-review': '图形推理图片题 · 暂不支持自动结构化',
  'unsupported-auto-structure': '无法可靠结构化 · 仅保留原始资料'
}

export interface CapabilityInput {
  structured: boolean
  questionCount: number
  completeCount: number
  tableCount: number
  numericAnomalies: number
  graphicCandidate: boolean
  figureImages: number
  solutionMarks: number
}

export function classifyFileCapability(input: CapabilityInput): ImportCapability {
  if (input.graphicCandidate) return 'graphic-review'
  if (input.questionCount === 0) {
    if (input.structured && input.figureImages >= 5) return 'image-only-review'
    return 'unsupported-auto-structure'
  }
  if (input.tableCount > 0 || input.numericAnomalies >= 10) return 'table-review'
  return 'text-supported'
}

// ---- 导入质量分层（产物级，向后兼容的可选字段）----
// 只反映「生成了什么形态的产物」，不表示 OCR 内容正确：
// - structured：生成了可作答结构（客观题有选项、申论有作答输入），不代表识别准确
// - review-required：产物落在能力边界（图片/表格/图推等），需要人工核对
// - preserved-source：只保留原始资料，没有生成可作答题目
// 分层依据是产物的 kind 与 capability（导入管线写入的显式元数据），
// 不解析 Markdown、不猜测选项完整度。文件转换失败由 file.state=failed 表达，
// 不伪造对应产物。

export type ImportQualityTier = 'structured' | 'review-required' | 'preserved-source'

export function tierForArtifact(artifact: {
  kind: string
  capability?: string
}): ImportQualityTier {
  if (artifact.kind === 'document') return 'preserved-source'
  const capability = artifact.capability
  if (!capability || capability === 'text-supported') return 'structured'
  return 'review-required'
}

/** 批次质量汇总：只使用可观测事实（真实计数与转换报告的页数），不推算、不猜 */
export interface ImportBatchFacts {
  /** 文件总数 */
  fileCount: number
  /** 处理失败或被拦截的文件数（file.state=failed：含转换异常/中断/配对拦截等，不区分原因） */
  failedFileCount: number
  /** 提供了有效 ocrQuality.totalPages 的文件数 */
  filesWithKnownPages: number
  /** 已知输入页数之和（仅来自转换质量报告的有效页数） */
  knownInputPages: number
  /** 已知空白页数之和（仅来自转换器报告，不代表确认丢题） */
  knownEmptyPages: number
  /** structured 产物数 */
  structuredArtifacts: number
  /** review-required 产物数 */
  reviewRequiredArtifacts: number
  /** preserved-source（原始资料）产物数 */
  preservedSourceArtifacts: number
  /** 真实跳过计数（来自配对管线） */
  skippedNoAnswer: number
  skippedIncomplete: number
  skippedMisaligned: number
  skippedDuplicate: number
  /** 因疑似套号错位被整书拦截的本数 */
  abortedBooks: number
}

/** 页数有效性：只有非负整数才是可用的转换器报告页数（拒绝 undefined/NaN/小数/负数） */
export function isValidPageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 汇总文案：页数缺失与无法计算项必须如实显示，不用题目数反推页数 */
export function batchFactsMessage(facts: ImportBatchFacts): string {
  const parts: string[] = []
  if (facts.knownInputPages > 0 || facts.filesWithKnownPages > 0) {
    parts.push(
      facts.filesWithKnownPages === facts.fileCount
        ? `输入 ${facts.knownInputPages} 页`
        : `已知 ${facts.filesWithKnownPages}/${facts.fileCount} 个文件的页数，共 ${facts.knownInputPages} 页`
    )
  } else {
    parts.push('输入页数未知，转换器未提供页数')
  }
  // 空白页仅来自转换器报告，不是确认丢题
  if (facts.knownEmptyPages > 0) parts.push(`报告空白页 ${facts.knownEmptyPages} 页`)
  parts.push(`结构化题目 ${facts.structuredArtifacts}`)
  parts.push(`待人工审核 ${facts.reviewRequiredArtifacts}`)
  parts.push(`原始资料保留 ${facts.preservedSourceArtifacts}`)
  const skips = [
    `无答案 ${facts.skippedNoAnswer}`,
    `不完整 ${facts.skippedIncomplete}`,
    `错位剔除 ${facts.skippedMisaligned}`,
    `重复 ${facts.skippedDuplicate}`
  ]
  parts.push(`跳过（${skips.join('·')}）`)
  // failed 状态可能来自转换异常/中断/配对拦截——统一为「处理失败或被拦截」，不猜原因
  if (facts.failedFileCount > 0) parts.push(`处理失败或被拦截文件 ${facts.failedFileCount} 个`)
  if (facts.abortedBooks > 0) parts.push(`${facts.abortedBooks} 本书因疑似套号错位被拦截`)
  parts.push('缺题数和原图页覆盖率无法计算：当前未建立来源页到题目/图片的完整映射')
  return parts.join(' · ')
}
