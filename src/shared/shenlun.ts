export type ShenlunQuestionType = '单一题' | '综合题' | '公文题' | '作文题'

export const SHENLUN_QUESTION_TYPES: readonly ShenlunQuestionType[] = [
  '单一题',
  '综合题',
  '公文题',
  '作文题'
]

const ESSAY_ARTICLE_RE =
  /写一篇文章|写一篇.{0,4}(?:文章|论文)|策论文|自拟题目|自选角度|议论文|800\s*[—–~-]\s*1\d{3}\s*字|不少于\s*(?:800|1000)\s*字|1000\s*字左右/

const OFFICIAL_DOC_RE =
  /倡议书|发言稿|讲话稿|演讲稿|公开信|感谢信|回信|汇报|简报|编者按|短评|新闻稿|调研报告|考察报告|情况说明|通知|通告|工作方案|导语|推介|讲解词|致辞|提纲|撰写|起草一[份篇]|拟写一[份篇]|写一[份篇].{0,8}(?:稿|信|报告|书|材料|方案)/

const ANALYSIS_RE =
  /谈谈.{0,12}(?:理解|认识|看法|启示|体会|感悟)|如何理解|怎样理解|谈谈你对|评析|评价|辨析|启示/

/**
 * CJK 部首补充区（U+2E80–U+2EFF）字符向标准简化汉字映射表。
 * 字符串整体调用 NFKC 不会转化此区块，且会把中文全角标点压成半角，因此需定向替换。
 */
export const CJK_RADICAL_SUPPLEMENT_MAP: Readonly<Record<string, string>> = {
  '\u2e8e': '兀',
  '\u2e93': '幺',
  '\u2e95': '彐',
  '\u2e9f': '母',
  '\u2ea0': '民',
  '\u2ec1': '虎',
  '\u2ec4': '西',
  '\u2ec5': '见',
  '\u2ec6': '角',
  '\u2ec9': '贝',
  '\u2ecb': '车',
  '\u2ed3': '长',
  '\u2ed4': '门',
  '\u2ed8': '青',
  '\u2ed9': '韦',
  '\u2eda': '页',
  '\u2edb': '风',
  '\u2edc': '飞',
  '\u2edd': '食',
  '\u2ee2': '马',
  '\u2ee3': '骨',
  '\u2ee4': '鬼',
  '\u2ee5': '鱼',
  '\u2ee6': '鸟',
  '\u2ee7': '卤',
  '\u2ee8': '麦',
  '\u2ee9': '黄',
  '\u2eec': '齐',
  '\u2eee': '齿',
  '\u2ef0': '龙',
  '\u2ef3': '龟'
}

const PDF_FOOTER_RE = /第\s*\d+\s*页\s*[,，/]?\s*共\s*\d+\s*页/g

/**
 * 清洗申论材料/题干中的 PDF 抽取污染：
 * - 将康熙部首（U+2F00–U+2FDF）与 CJK 部首补充区（U+2E80–U+2EFF）恢复为标准汉字；
 * - 将全角数字与英文字母转为半角；
 * - 剔除残留 PDF 页脚（如「第10页,共15页」）；
 * - 绝不对整段调用 NFKC，完整保留中文全角标点（，：；？！（）《》）。
 */
export function normalizeShenlunText(text: string): string {
  if (!text) return text
  return text
    .replace(/[\u2e80-\u2eff]/g, (ch) => CJK_RADICAL_SUPPLEMENT_MAP[ch] ?? ch)
    .replace(/[\u2f00-\u2fdf\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g, (ch) =>
      ch.normalize('NFKC')
    )
    .replace(PDF_FOOTER_RE, '')
}

export type ShenlunMaterialQualityLevel = 'verified' | 'normal' | 'incomplete'

export interface ShenlunMaterialQualityReport {
  level: ShenlunMaterialQualityLevel
  issues: string[]
  hasReferenceAnswer: boolean
}

const VALID_MATERIAL_END_PUNCT_RE = /[。！？…”』」）》】.!?\)\]]$/
const OFFICIAL_DATE_OR_BYLINE_END_RE =
  /(?:\d{4}年\d{1,2}月(?:\d{1,2}日)?|[一二三四五六七八九〇○零]{2,4}年[一二三四五六七八九十]{1,3}月(?:[一二三四五六七八九十]{1,3}日)?|——[^\n]{2,20}|[（(]节选[）)])$/
const BLOCK_FOOTER_DETECT_RE = /第\s*\d+\s*页\s*[,，/]?\s*共\s*\d+\s*页/
const RADICAL_RESIDUE_RE = /[\u2e80-\u2fdf]/
const HALFWIDTH_PUNCT_IN_CN_RE = /[\u4e00-\u9fff][,:;?!][\u4e00-\u9fff“「《（\d]/g

function hasQuoteBalanceDefect(rawText: string): boolean {
  const text = rawText.replace(/“([^“”\n]{1,40})[＂"]/g, '“$1”')
  const cleaned = text.replace(/《[^《》\n]{1,60}》/g, (m) => m.replace(/[“”]/g, ''))

  let openCount = 0
  let closeCount = 0
  let midSentenceNested = 0
  let strayClose = 0
  let depth = 0
  let multiParaOpens = 0

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (ch === '“') {
      openCount += 1
      if (depth > 0) {
        const prev = cleaned.slice(Math.max(0, i - 3), i)
        if (/\n\s*$/.test(prev)) {
          multiParaOpens += 1
        } else {
          midSentenceNested += 1
        }
      }
      depth += 1
    } else if (ch === '”') {
      closeCount += 1
      if (depth <= 0) strayClose += 1
      else depth -= 1
    }
  }

  const unexplainedOpenExcess = Math.max(0, openCount - closeCount - multiParaOpens)
  const closeExcess = Math.max(0, closeCount - openCount)
  return closeExcess > 0 || unexplainedOpenExcess > 0 || strayClose > 0 || midSentenceNested > 0
}

function hasBracketBalanceDefect(text: string): boolean {
  for (const [left, right] of [
    ['（', '）'],
    ['《', '》']
  ] as const) {
    let lc = 0
    let rc = 0
    for (const ch of text) {
      if (ch === left) lc += 1
      else if (ch === right) rc += 1
    }
    if (lc !== rc) return true
  }
  return false
}

/** 评估申论给定材料的文本完整度与校对等级，供题库筛查与前台警示使用 */
export function inspectShenlunMaterialQuality(
  material?: string,
  options?: { explanation?: string }
): ShenlunMaterialQualityReport {
  const exp = (options?.explanation ?? '').trim()
  const hasReferenceAnswer = Boolean(exp && !exp.startsWith('暂无参考答案'))
  const raw = (material ?? '').trim()
  if (!raw) {
    return { level: 'incomplete', issues: ['材料过短'], hasReferenceAnswer }
  }

  const parts = raw.split(/\n\n(?=### )/)
  const issues = new Set<string>()
  let totalBodyLen = 0

  for (const part of parts) {
    const matched = part.match(/^### [^\n]+\n+([\s\S]*)$/)
    const body = (matched?.[1] ?? part).trim()
    totalBodyLen += body.length
    if (
      body.length >= 80 &&
      !VALID_MATERIAL_END_PUNCT_RE.test(body) &&
      !OFFICIAL_DATE_OR_BYLINE_END_RE.test(body)
    ) {
      issues.add('段尾腰斩')
    }
    if (hasQuoteBalanceDefect(body)) {
      issues.add('引号残缺')
    }
    if (hasBracketBalanceDefect(body)) {
      issues.add('括号/书名号未闭合')
    }
    if (BLOCK_FOOTER_DETECT_RE.test(body)) {
      issues.add('残留PDF页脚')
    }
  }

  if (totalBodyLen < 200) {
    issues.add('材料过短')
  }

  const issueList = [...issues]
  if (issueList.length > 0) {
    return { level: 'incomplete', issues: issueList, hasReferenceAnswer }
  }

  const halfPunctCount = (raw.match(HALFWIDTH_PUNCT_IN_CN_RE) || []).length
  if (hasReferenceAnswer && !RADICAL_RESIDUE_RE.test(raw) && halfPunctCount < 3) {
    return { level: 'verified', issues: [], hasReferenceAnswer }
  }

  return { level: 'normal', issues: [], hasReferenceAnswer }
}

/** 将各渠道导入的申论题目统一归类为「单一题 / 综合题 / 公文题 / 作文题」 */
export function classifyShenlunType(category?: string, stem?: string): ShenlunQuestionType {
  const cat = (category ?? '').trim()
  if (cat) {
    if (/大作文|作文|申发论述|文章写作/.test(cat)) return '作文题'
    if (/贯彻执行|应用文|公文/.test(cat)) return '公文题'
    if (/综合分析|综合题/.test(cat)) return '综合题'
    if (/归纳概括|提出对策|单一题|概括|对策/.test(cat)) return '单一题'
  }

  const text = (stem ?? '').replace(/\s+/g, '')
  if (text) {
    if (ESSAY_ARTICLE_RE.test(text)) return '作文题'
    if (OFFICIAL_DOC_RE.test(text)) return '公文题'
    if (ANALYSIS_RE.test(text)) return '综合题'
  }
  return '单一题'
}

export interface ShenlunMaterialBlock {
  title: string
  index: number | null
  content: string
  raw: string
}

const CN_NUM_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

function parseChineseOrArabicNum(token: string): number | null {
  const trimmed = token.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed.length === 1 && CN_NUM_MAP[trimmed]) return CN_NUM_MAP[trimmed] ?? null
  const c0 = trimmed[0]
  const c1 = trimmed[1]
  if (trimmed.startsWith('十') && trimmed.length === 2 && c1 && CN_NUM_MAP[c1]) {
    return 10 + CN_NUM_MAP[c1]!
  }
  if (trimmed.endsWith('十') && trimmed.length === 2 && c0 && CN_NUM_MAP[c0]) {
    return CN_NUM_MAP[c0]! * 10
  }
  return null
}

const MATERIAL_HEADING_RE =
  /^(?:#{1,4}\s*|\*\*)?(?:给定)?(?:资料|材料)\s*([一二三四五六七八九十\d]+)(?:\*\*)?(?:[：:.\s]|$)/

/** 将按「材料1 / 给定资料1」分段的申论材料拆分为独立块；不足 2 段时返回空数组 */
export function splitShenlunMaterialBlocks(material: string): ShenlunMaterialBlock[] {
  const lines = material.split(/\r?\n/)
  const starts: Array<{ lineIdx: number; title: string; index: number | null }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim()
    const match = trimmed.match(MATERIAL_HEADING_RE)
    if (!match || !match[1]) continue
    const num = parseChineseOrArabicNum(match[1])
    const cleanTitle = trimmed
      .replace(/^#{1,4}\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/[：:]$/, '')
      .trim()
    starts.push({
      lineIdx: i,
      title: cleanTitle || `材料${match[1]}`,
      index: num
    })
  }
  if (starts.length < 2) return []

  const blocks: ShenlunMaterialBlock[] = []
  for (let i = 0; i < starts.length; i += 1) {
    const cur = starts[i]!
    const next = starts[i + 1]
    const startLine = cur.lineIdx
    const endLine = next ? next.lineIdx : lines.length
    const raw = lines.slice(startLine, endLine).join('\n').trim()
    const content = lines
      .slice(startLine + 1, endLine)
      .join('\n')
      .trim()
    if (raw) {
      blocks.push({
        title: cur.title,
        index: cur.index,
        content: content || raw,
        raw
      })
    }
  }
  return blocks.length >= 2 ? blocks : []
}

const FULL_MATERIAL_RE = /(?:全部|所有|整篇|各则|上述|以上)\s*(?:给定)?(?:资料|材料)/

const EXPLICIT_MATERIAL_REF_RE =
  /(?:给定资料|给定材料|资料|材料)\s*([一二三四五六七八九十\d]+(?:\s*[、,，和与及\-～~—–]\s*[一二三四五六七八九十\d]+)*)/g

const STEM_BOILERPLATE_RE =
  /请根据|根据给定|结合给定|给定材料|给定资料|材料|资料|谈谈|概括|归纳|梳理|分析|说明|阐述|指出|提出|结合|围绕|联系实际|要求|全面|准确|简明|扼要|条理清晰|有条理|层次分明|分条作答|不超过|左右|字数|篇幅|分值|假如你是|假设你是|作为一名|工作人员|撰写一|拟写一|写一篇|写一份|关于|主要内容|主要问题|对策建议|体现在哪些方面|哪些方面|如何理解/g

function extractMatchTokens(text: string): { quoted: string[]; terms: string[] } {
  const quoted: string[] = []
  const quoteMatches = text.matchAll(/[“「《]([^”」》]{2,18})[”」》]/g)
  for (const m of quoteMatches) {
    const q = (m[1] ?? '').trim()
    if (q && !quoted.includes(q)) quoted.push(q)
  }

  const cleaned = text
    .replace(/[“”「」《》()（）、，。；：？！\s\d]/g, ' ')
    .replace(STEM_BOILERPLATE_RE, ' ')
  const terms = new Set<string>()
  for (const seg of cleaned.split(/\s+/)) {
    const s = seg.trim()
    if (s.length < 2) continue
    if (s.length <= 6) terms.add(s)
    for (let i = 0; i <= s.length - 2; i += 1) {
      terms.add(s.slice(i, i + 2))
      if (i <= s.length - 3) terms.add(s.slice(i, i + 3))
    }
  }
  return { quoted, terms: [...terms] }
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  let count = 0
  let pos = 0
  while (count < cap) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count += 1
    pos = idx + needle.length
  }
  return count
}

/**
 * 为申论非大作文小题推荐最相关的材料块下标（0-based）。
 * 返回空数组表示应保留全部材料（如大作文、明确要求全部材料、或无法区分）。
 */
export function recommendShenlunMaterialIndices(
  blocks: ShenlunMaterialBlock[],
  stem: string,
  explanation?: string,
  category?: string
): number[] {
  if (blocks.length < 2) return []
  const effectiveType = category || classifyShenlunType(undefined, stem)
  if (effectiveType === '作文题' || FULL_MATERIAL_RE.test(stem)) return []

  // 1) 题干明确引用「给定资料3 / 材料2、3 / 资料1-3」
  const wantedNums = new Set<number>()
  for (const match of stem.matchAll(EXPLICIT_MATERIAL_REF_RE)) {
    const expr = match[1] ?? ''
    if (!expr) continue
    const rangeMatch = expr.match(
      /^([一二三四五六七八九十\d]+)\s*[-～~—–]\s*([一二三四五六七八九十\d]+)$/
    )
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      const start = parseChineseOrArabicNum(rangeMatch[1])
      const end = parseChineseOrArabicNum(rangeMatch[2])
      if (start && end && end >= start && end - start <= 12) {
        for (let n = start; n <= end; n += 1) wantedNums.add(n)
        continue
      }
    }
    for (const part of expr.split(/[、,，和与及\s]+/)) {
      const n = parseChineseOrArabicNum(part)
      if (n) wantedNums.add(n)
    }
  }
  if (wantedNums.size > 0) {
    const matched = blocks
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => b.index !== null && wantedNums.has(b.index))
      .map(({ idx }) => idx)
    if (matched.length > 0 && matched.length < blocks.length) return matched
  }

  // 2) 基于题干（及参考解析）实体词与关键词相关性打分
  const stemTokens = extractMatchTokens(normalizeShenlunText(stem))
  const cleanExp =
    explanation && !explanation.startsWith('暂无参考答案')
      ? normalizeShenlunText(explanation.slice(0, 600))
      : ''
  const expTokens = cleanExp ? extractMatchTokens(cleanExp) : { quoted: [], terms: [] }

  const scored = blocks.map((block, idx) => {
    const text = normalizeShenlunText(block.content)
    let rawScore = 0
    for (const q of stemTokens.quoted) {
      rawScore += countOccurrences(text, q, 3) * 14
    }
    for (const t of stemTokens.terms) {
      const hits = countOccurrences(text, t, 4)
      if (hits > 0) rawScore += (t.length >= 3 ? 4 : 2.2) + (hits - 1) * 0.9
    }
    for (const q of expTokens.quoted) {
      rawScore += countOccurrences(text, q, 2) * 4
    }
    for (const t of expTokens.terms) {
      if (text.includes(t)) rawScore += t.length >= 3 ? 1.2 : 0.6
    }
    const normScore = rawScore / Math.sqrt(text.length + 300)
    return { idx, score: normScore }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score <= 0.05) return []

  const picked = [top.idx]
  const second = scored[1]
  if (second && second.score >= top.score * 0.58) {
    picked.push(second.idx)
  }
  if (effectiveType === '综合题' && scored[2] && scored[2].score >= top.score * 0.68) {
    picked.push(scored[2].idx)
  }
  if (picked.length >= blocks.length) return []
  return picked.sort((a, b) => a - b)
}

const SKIP_PARAGRAPH_LINE_RE = /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```|!\[)/

/**
 * 将 PDF 抽取导致的超长无换行申论材料按句读与序号智能拆分为自然段，
 * 保留已有段落与 Markdown 结构，避免整段“文字墙”影响阅读。
 */
export function formatShenlunMaterialParagraphs(text: string): string {
  if (!text) return text
  const lines = text.split(/\r?\n/)
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length <= 320 || SKIP_PARAGRAPH_LINE_RE.test(trimmed)) {
      out.push(line)
      continue
    }

    const parts: string[] = []
    let buf = ''
    let i = 0
    while (i < trimmed.length) {
      const ch = trimmed[i]!
      buf += ch

      const nextTwo = trimmed.slice(i + 1, i + 4)
      const isSentenceEnd =
        ch === '。' ||
        ch === '！' ||
        ch === '？' ||
        ((ch === '”' || ch === '」') &&
          buf.length >= 2 &&
          (buf[buf.length - 2] === '。' ||
            buf[buf.length - 2] === '！' ||
            buf[buf.length - 2] === '？'))

      if (isSentenceEnd) {
        if ((trimmed[i + 1] === '”' || trimmed[i + 1] === '」') && ch !== '”' && ch !== '」') {
          i += 1
          buf += trimmed[i]!
        }
        const remaining = trimmed.length - (i + 1)
        const nextStartsItem = /^\s*\d+\.[\u4e00-\u9fa5]/.test(trimmed.slice(i + 1, i + 8))
        if (
          remaining >= 80 &&
          ((nextStartsItem && buf.length >= 100) || (buf.length >= 220 && remaining >= 100))
        ) {
          parts.push(buf.trim())
          buf = ''
          while (i + 1 < trimmed.length && /\s/.test(trimmed[i + 1]!)) i += 1
        }
      } else if (
        buf.length >= 100 &&
        (ch === '。' || ch === '”' || ch === '；') &&
        /^\d+\.[\u4e00-\u9fa5]/.test(nextTwo)
      ) {
        parts.push(buf.trim())
        buf = ''
      }
      i += 1
    }
    if (buf.trim()) parts.push(buf.trim())
    out.push(parts.join('\n\n'))
  }

  return out.join('\n')
}

export const SHENLUN_SHEET_COLS = 25

export interface ShenlunSheetCell {
  row: number
  col: number
  char: string
  charIndex: number | null
  charEndIndex: number | null
  /** 因行首避头点挤入上一行末格右下角的标点 */
  squeezedPunct?: string
  /** 单格容纳 2 或 3 个半角字符时的紧凑排版等级 */
  compactLevel?: 0 | 2 | 3
  cellNumber: number
  isLimitBoundary: boolean
  isOverLimit: boolean
}

export interface ShenlunSheetRow {
  rowIndex: number
  cells: ShenlunSheetCell[]
  /** 每 4 行（100 格）标注字数刻度，如 "100字"、"200字" */
  hundredMark: string | null
  /** 点击该行空白尾部时应定位到的文本下标 */
  lineEndCharIndex: number
}

export interface ShenlunSheetGrid {
  rows: ShenlunSheetRow[]
  caretRow: number
  caretCol: number
  /** 光标落在多字符格内部时的水平偏移比例（0..1） */
  caretSubOffset: number
  /** 实际填入内容的方格数量 */
  filledCellCount: number
  /** 末字所落方格的 1-based 格号（对应答题卡 100/200/300 字刻度） */
  lastFilledCellNumber: number
  charCoordMap: Array<{ row: number; col: number; subOffset: number }>
}

const LINE_START_FORBIDDEN_PUNCT = new Set([
  '，',
  '。',
  '、',
  '；',
  '：',
  '？',
  '！',
  ',',
  '.',
  ';',
  ':',
  '?',
  '!',
  '》',
  '）',
  '】',
  '”',
  '’',
  '」',
  '』'
])

function isAsciiDigit(ch: string | undefined): boolean {
  return Boolean(ch && ch >= '0' && ch <= '9')
}

function isAsciiLetter(ch: string | undefined): boolean {
  return Boolean(ch && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')))
}

type SheetToken =
  | { type: 'newline'; start: number; end: number }
  | { type: 'pair-punct'; chars: [string, string]; start: number; end: number }
  | { type: 'cell'; text: string; start: number; end: number; allowSqueeze: boolean }

function pushPairChunks(tokens: SheetToken[], content: string, start: number, end: number): void {
  for (let pos = start; pos < end; pos += 2) {
    const chunkEnd = Math.min(pos + 2, end)
    tokens.push({
      type: 'cell',
      text: content.slice(pos, chunkEnd),
      start: pos,
      end: chunkEnd,
      allowSqueeze: false
    })
  }
}

/**
 * 将作答字符串切分为符合公考申论真考占格规则的方格单元：
 * - 阿拉伯数字每 2 位占 1 格；小数点、百分号、1-2 位序号点与相邻数字合占 1 格
 * - 1 位数字+1 位字母短代号（如 5G）合占 1 格；连续英文字母每 2 个占 1 格
 * - 破折号（——）与省略号（……）标记为不可断行的双格单元
 */
function tokenizeShenlunSheetContent(content: string): SheetToken[] {
  const tokens: SheetToken[] = []
  const len = content.length
  let i = 0

  while (i < len) {
    const ch = content[i]!
    if (ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      tokens.push({ type: 'newline', start: i, end: i + 1 })
      i += 1
      continue
    }

    if (content.startsWith('——', i)) {
      tokens.push({ type: 'pair-punct', chars: ['—', '—'], start: i, end: i + 2 })
      i += 2
      continue
    }
    if (content.startsWith('……', i)) {
      tokens.push({ type: 'pair-punct', chars: ['…', '…'], start: i, end: i + 2 })
      i += 2
      continue
    }

    // 阿拉伯数字开头（含整数/小数/百分数/数字序号/5G类短代号）
    if (isAsciiDigit(ch)) {
      let intEnd = i
      while (intEnd < len && isAsciiDigit(content[intEnd])) intEnd += 1

      // 1 位数字紧跟 1 位字母（如 5G/4G/3C）
      if (
        intEnd - i === 1 &&
        isAsciiLetter(content[intEnd]) &&
        !isAsciiDigit(content[intEnd + 1]) &&
        !isAsciiLetter(content[intEnd + 1])
      ) {
        tokens.push({
          type: 'cell',
          text: content.slice(i, intEnd + 1),
          start: i,
          end: intEnd + 1,
          allowSqueeze: false
        })
        i = intEnd + 1
        continue
      }

      const numericCells: Array<{ text: string; start: number; end: number }> = []
      for (let pos = i; pos < intEnd; pos += 2) {
        const chunkEnd = Math.min(pos + 2, intEnd)
        numericCells.push({
          text: content.slice(pos, chunkEnd),
          start: pos,
          end: chunkEnd
        })
      }

      let curEnd = intEnd
      if (content[curEnd] === '.') {
        const lastIntCell = numericCells[numericCells.length - 1]!
        lastIntCell.text += '.'
        lastIntCell.end = curEnd + 1
        curEnd += 1

        if (isAsciiDigit(content[curEnd])) {
          let fracEnd = curEnd
          while (fracEnd < len && isAsciiDigit(content[fracEnd])) fracEnd += 1
          for (let pos = curEnd; pos < fracEnd; pos += 2) {
            const chunkEnd = Math.min(pos + 2, fracEnd)
            numericCells.push({
              text: content.slice(pos, chunkEnd),
              start: pos,
              end: chunkEnd
            })
          }
          curEnd = fracEnd
        }
      }

      if (content[curEnd] === '%' || content[curEnd] === '‰') {
        const lastCell = numericCells[numericCells.length - 1]!
        if (lastCell.text.length < 3) {
          lastCell.text += content[curEnd]
          lastCell.end = curEnd + 1
          curEnd += 1
        }
      }

      for (const cell of numericCells) {
        tokens.push({
          type: 'cell',
          text: cell.text,
          start: cell.start,
          end: cell.end,
          allowSqueeze: false
        })
      }
      i = curEnd
      continue
    }

    // 连续 ASCII 英文字母每 2 个占 1 格
    if (isAsciiLetter(ch)) {
      let letterEnd = i
      while (letterEnd < len && isAsciiLetter(content[letterEnd])) letterEnd += 1
      pushPairChunks(tokens, content, i, letterEnd)
      i = letterEnd
      continue
    }

    const codePoint = content.codePointAt(i)
    const charLen = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    const unit = content.slice(i, i + charLen)
    tokens.push({
      type: 'cell',
      text: unit,
      start: i,
      end: i + charLen,
      allowSqueeze: LINE_START_FORBIDDEN_PUNCT.has(unit)
    })
    i += charLen
  }

  return tokens
}

function assignSpanCoords(
  charCoordMap: Array<{ row: number; col: number; subOffset: number }>,
  start: number,
  end: number,
  row: number,
  col: number
): void {
  const span = Math.max(1, end - start)
  for (let idx = start; idx < end; idx += 1) {
    charCoordMap[idx] = {
      row,
      col,
      subOffset: span <= 1 ? 0 : (idx - start) / span
    }
  }
}

/**
 * 将作答文本按真考申论答题卡（25 格/行，每 4 行 100 字）映射为方格矩阵：
 * - 支持 2 位数字/英文字母占 1 格、小数点与百分号合占、破折号/省略号不断行、行首标点自动避头挤入上一行末格；
 * - 精准维护所有源码下标的二维坐标与选中区间，支撑点击定位与拖动批量删改。
 */
export function buildShenlunSheetGrid(
  content: string,
  maxChars: number | null,
  caretIndex: number
): ShenlunSheetGrid {
  const cols = SHENLUN_SHEET_COLS
  const targetCells = maxChars && maxChars > 0 ? maxChars + cols * 2 : 400
  const minRows = Math.max(10, Math.ceil(targetCells / cols))

  interface CellEntry {
    char: string
    charIndex: number
    charEndIndex: number
    squeezedPunct?: string
    compactLevel: 0 | 2 | 3
  }

  const cellMap = new Map<string, CellEntry>()
  const lineEndIndex = new Map<number, number>()
  const charCoordMap: Array<{ row: number; col: number; subOffset: number }> = new Array(
    content.length + 1
  )

  const tokens = tokenizeShenlunSheetContent(content)
  let row = 0
  let col = 0
  let autoWrappedPrevRow = false
  let filledCellCount = 0
  let lastFilledCellNumber = 0

  const placeCell = (r: number, c: number, entry: CellEntry): void => {
    cellMap.set(`${r}:${c}`, entry)
    filledCellCount += 1
    const cellNo = r * cols + c + 1
    if (cellNo > lastFilledCellNumber) lastFilledCellNumber = cellNo
  }

  for (const token of tokens) {
    if (token.type === 'newline') {
      charCoordMap[token.start] = { row, col, subOffset: 0 }
      lineEndIndex.set(row, token.start)
      row += 1
      col = 0
      autoWrappedPrevRow = false
      continue
    }

    if (token.type === 'pair-punct') {
      // 破折号 / 省略号禁止在行末拆为两行：仅剩 1 格时整体移到下一行
      if (col === cols - 1) {
        lineEndIndex.set(row, token.start)
        row += 1
        col = 0
      }
      const mid = token.start + 1
      placeCell(row, col, {
        char: token.chars[0],
        charIndex: token.start,
        charEndIndex: mid,
        compactLevel: 0
      })
      assignSpanCoords(charCoordMap, token.start, mid, row, col)
      col += 1

      placeCell(row, col, {
        char: token.chars[1],
        charIndex: mid,
        charEndIndex: token.end,
        compactLevel: 0
      })
      assignSpanCoords(charCoordMap, mid, token.end, row, col)
      col += 1

      if (col >= cols) {
        lineEndIndex.set(row, token.end)
        row += 1
        col = 0
        autoWrappedPrevRow = true
      } else {
        autoWrappedPrevRow = false
      }
      continue
    }

    // 行首避头点：上一行写满自动换行且新行首为禁现标点时，挤入上一行末格右下角
    if (token.allowSqueeze && col === 0 && autoWrappedPrevRow && row > 0) {
      const prevCell = cellMap.get(`${row - 1}:${cols - 1}`)
      if (prevCell && !prevCell.squeezedPunct) {
        prevCell.squeezedPunct = token.text
        prevCell.charEndIndex = token.end
        lineEndIndex.set(row - 1, token.end)
        charCoordMap[token.start] = {
          row: row - 1,
          col: cols - 1,
          subOffset: 0.6
        }
        autoWrappedPrevRow = false
        continue
      }
    }

    const compactLevel: 0 | 2 | 3 = token.text.length >= 3 ? 3 : token.text.length === 2 ? 2 : 0

    placeCell(row, col, {
      char: token.text,
      charIndex: token.start,
      charEndIndex: token.end,
      compactLevel
    })
    assignSpanCoords(charCoordMap, token.start, token.end, row, col)
    col += 1

    if (col >= cols) {
      lineEndIndex.set(row, token.end)
      row += 1
      col = 0
      autoWrappedPrevRow = true
    } else {
      autoWrappedPrevRow = false
    }
  }

  // 回填可能被 \r 跳过的坐标，保证每个位置都有效
  for (let idx = 0; idx < content.length; idx += 1) {
    if (!charCoordMap[idx]) {
      charCoordMap[idx] = charCoordMap[idx - 1] ?? { row: 0, col: 0, subOffset: 0 }
    }
  }
  charCoordMap[content.length] = { row, col, subOffset: 0 }
  if (!lineEndIndex.has(row)) lineEndIndex.set(row, content.length)

  const totalRows = Math.max(minRows, row + 2)
  const clampedCaret = Math.max(0, Math.min(caretIndex, content.length))
  const caretCoord = charCoordMap[clampedCaret] ?? { row, col, subOffset: 0 }

  const rows: ShenlunSheetRow[] = []
  for (let r = 0; r < totalRows; r += 1) {
    const cells: ShenlunSheetCell[] = []
    const fallbackIndex = lineEndIndex.get(r) ?? content.length
    for (let c = 0; c < cols; c += 1) {
      const cellNumber = r * cols + c + 1
      const entry = cellMap.get(`${r}:${c}`)
      cells.push({
        row: r,
        col: c,
        char: entry?.char ?? '',
        charIndex: entry ? entry.charIndex : null,
        charEndIndex: entry ? entry.charEndIndex : null,
        squeezedPunct: entry?.squeezedPunct,
        compactLevel: entry?.compactLevel,
        cellNumber,
        isLimitBoundary: Boolean(maxChars && cellNumber === maxChars),
        isOverLimit: Boolean(maxChars && cellNumber > maxChars && entry)
      })
    }
    rows.push({
      rowIndex: r,
      cells,
      hundredMark: (r + 1) % 4 === 0 ? `${((r + 1) / 4) * 100}字` : null,
      lineEndCharIndex: fallbackIndex
    })
  }

  return {
    rows,
    caretRow: caretCoord.row,
    caretCol: caretCoord.col,
    caretSubOffset: caretCoord.subOffset,
    filledCellCount,
    lastFilledCellNumber,
    charCoordMap
  }
}
