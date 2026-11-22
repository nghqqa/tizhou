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
  const stemTokens = extractMatchTokens(stem.normalize('NFKC'))
  const cleanExp =
    explanation && !explanation.startsWith('暂无参考答案')
      ? explanation.slice(0, 600).normalize('NFKC')
      : ''
  const expTokens = cleanExp ? extractMatchTokens(cleanExp) : { quoted: [], terms: [] }

  const scored = blocks.map((block, idx) => {
    const text = block.content.normalize('NFKC')
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
  charCoordMap: Array<{ row: number; col: number }>
}

/**
 * 将作答文本按真考申论答题卡（25 格/行，每 4 行 100 字）映射为方格矩阵，
 * 支持换行跳行、字数上限警戒线与点击方格反查光标位置。
 */
export function buildShenlunSheetGrid(
  content: string,
  maxChars: number | null,
  caretIndex: number
): ShenlunSheetGrid {
  const cols = SHENLUN_SHEET_COLS
  const targetCells = maxChars && maxChars > 0 ? maxChars + cols * 2 : 400
  const minRows = Math.max(10, Math.ceil(targetCells / cols))

  const cellMap = new Map<string, { char: string; charIndex: number }>()
  const lineEndIndex = new Map<number, number>()
  const charCoordMap: Array<{ row: number; col: number }> = new Array(content.length + 1)

  let row = 0
  let col = 0
  for (let i = 0; i < content.length; i += 1) {
    charCoordMap[i] = { row, col }
    const ch = content[i]!
    if (ch === '\r') continue
    if (ch === '\n') {
      lineEndIndex.set(row, i)
      row += 1
      col = 0
      continue
    }
    cellMap.set(`${row}:${col}`, { char: ch, charIndex: i })
    col += 1
    if (col >= cols) {
      lineEndIndex.set(row, i + 1)
      row += 1
      col = 0
    }
  }
  charCoordMap[content.length] = { row, col }
  if (!lineEndIndex.has(row)) lineEndIndex.set(row, content.length)

  const totalRows = Math.max(minRows, row + 2)
  const clampedCaret = Math.max(0, Math.min(caretIndex, content.length))
  const caretCoord = charCoordMap[clampedCaret] ?? { row, col }

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
    charCoordMap
  }
}
