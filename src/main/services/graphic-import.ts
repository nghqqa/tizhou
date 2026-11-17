// 图形推理图片优先通道：不依赖文字 OCR 是否识别出 A/B/C/D。
// 以版面块（content_list 的类型/页码/坐标）聚类题目：题号位置、图片垂直位置与间距、
// 页面边界；每题区分题干文字/题干图片组/选项图片组。绑定结果带置信度，
// 低置信度进入人工审核，绝不把题干图形组当选项、也绝不因选项无文字而静默丢题。
import { createHash } from 'node:crypto'
import type { DirectQuestion, ParsedQuestion } from './question-import'
import type { RegionBlock, StructuredRegions } from './import-quality'

export interface GraphicStats {
  /** 题干图片组数量（含至少一张题干图的题） */
  stemImageGroups: number
  /** A-D 四图分离绑定的选项组数 */
  boundOptionGroups: number
  /** 整图版式（A-D 印在题干大图里，选项以「见图」表示）的组数 */
  singleFigureGroups: number
  /** 选项不足四张、进入人工审核的题数 */
  incompleteOptionQuestions: number
  /** 未绑定图片数量（无法归属到任何题的已保存图片） */
  unboundImages: number
  /** 缺少文字标签的图片选项数量 */
  missingLabelOptions: number
  /** 低置信度绑定数 */
  lowConfidence: number
}

export interface GraphicExtraction extends GraphicStats {
  questions: ParsedQuestion[]
  /** 每题的绑定说明（与 questions 同序），供审核警告使用 */
  notes: string[]
}

/** 实验性图形题自动结构化开关：默认关闭。
 *  图形规律与图片选项语义不做自动判定，图推资料默认只保留原始页面进人工审核；
 *  绑定代码保留供显式开启后验证，其结果不得显示为「高质量」或 ready。 */
export const GRAPHIC_AUTO_STRUCTURE = { enabled: false } as const

/** 图推路由判定：页面里存在足够的「题号 + 图片」页时才走图形通道，避免误伤普通文本书 */
export function isGraphicCandidate(regions: StructuredRegions): boolean {
  const byPage = groupByPage(regions.regions)
  let questionPages = 0
  for (const blocks of byPage.values()) {
    const hasTrigger = blocks.some(
      (block) => block.type === 'text' && QUESTION_TRIGGER.test(block.text)
    )
    const hasBodyImage = blocks.some((block) => block.type === 'image' && block.imgPath)
    if (hasTrigger && hasBodyImage) questionPages += 1
  }
  return questionPages >= 4
}

const QUESTION_TRIGGER = /^\s*(\d{1,3})\s*[.、．]\s*(.+)$/

function groupByPage(regions: RegionBlock[]): Map<number, RegionBlock[]> {
  const byPage = new Map<number, RegionBlock[]>()
  for (const block of regions) {
    const list = byPage.get(block.page)
    if (list) list.push(block)
    else byPage.set(block.page, [block])
  }
  for (const list of byPage.values()) list.sort((a, b) => (a.bbox[1] ?? 0) - (b.bbox[1] ?? 0))
  return byPage
}

/** 页面噪声文本：discarded 弃置块 + 跨页重复的页眉（≥3 页顶部重复） */
function pageNoiseTexts(regions: RegionBlock[]): Set<string> {
  const noise = new Set<string>()
  const topCounts = new Map<string, Set<number>>()
  for (const block of regions) {
    const text = block.text.trim()
    if (block.type === 'discarded' && text.length >= 3) noise.add(text)
    if (
      block.type === 'text' &&
      text.length >= 3 &&
      text.length <= 40 &&
      (block.bbox[3] ?? 999) < 160
    ) {
      const pages = topCounts.get(text) ?? new Set<number>()
      pages.add(block.page)
      topCounts.set(text, pages)
    }
  }
  for (const [text, pages] of topCounts) if (pages.size >= 3) noise.add(text)
  return noise
}

function area(block: RegionBlock): number {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = block.bbox
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

/** 四图尺寸相近（面积在中位数 0.4~1.6 倍之间）视为选项组 */
function optionLike(images: RegionBlock[]): boolean {
  if (images.length !== 4) return false
  const areas = images.map(area).filter((value) => value > 0)
  if (areas.length !== 4) return false
  const median = [...areas].sort((a, b) => a - b)[1] ?? 0
  return areas.every((value) => value >= median * 0.4 && value <= median * 1.6)
}

export function extractGraphicQuestions(regions: StructuredRegions): GraphicExtraction {
  const noise = pageNoiseTexts(regions.regions)
  const byPage = groupByPage(regions.regions)
  const questions: ParsedQuestion[] = []
  const notes: string[] = []
  const stats: GraphicStats = {
    stemImageGroups: 0,
    boundOptionGroups: 0,
    singleFigureGroups: 0,
    incompleteOptionQuestions: 0,
    unboundImages: 0,
    missingLabelOptions: 0,
    lowConfidence: 0
  }
  let num = 0
  for (const [, blocks] of byPage) {
    const triggers = blocks.filter(
      (block) => block.type === 'text' && QUESTION_TRIGGER.test(block.text)
    )
    if (triggers.length === 0) continue
    const usableImages = blocks.filter((block) => block.type === 'image' && block.imgPath)
    // 本书实测版式：一页一道题（多个题号文本重复同一题干时仍按一页一题处理）
    const trigger = triggers[0]!
    const rest = trigger.text.replace(QUESTION_TRIGGER, '$2').trim()
    const bodyTexts = blocks
      .filter(
        (block) => block.type === 'text' && block !== trigger && !noise.has(block.text.trim())
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
    const stem = [rest, ...bodyTexts].filter(Boolean).join('\n')
    num += 1
    const options: ParsedQuestion['options'] = []
    let note = ''
    const stemImages: RegionBlock[] = []
    if (usableImages.length === 4 && optionLike(usableImages)) {
      const keys = ['A', 'B', 'C', 'D']
      usableImages.forEach((image, index) => {
        options.push({ key: keys[index]!, text: '', image: image.imgPath })
        stats.missingLabelOptions += 1
      })
      stats.boundOptionGroups += 1
      note = '4 个图片选项已按版面顺序绑定（置信度 85%）'
    } else if (usableImages.length >= 5 && optionLike(usableImages.slice(-4))) {
      // 题干图 + 末尾 4 张选项图：题干图归题干，末 4 张按序绑定 A-D
      const tail = usableImages.slice(-4)
      stemImages.push(...usableImages.slice(0, -4))
      const keys = ['A', 'B', 'C', 'D']
      tail.forEach((image, index) => {
        options.push({ key: keys[index]!, text: '', image: image.imgPath })
        stats.missingLabelOptions += 1
      })
      stats.boundOptionGroups += 1
      note = '题干图 + 4 个图片选项已绑定（置信度 70%），请抽查首尾题'
    } else if (usableImages.length === 1 && area(usableImages[0]!) >= 250000) {
      // 整图版式：题干图形与 A-D 选项同印在一张大图里（图推700题讲义实测），
      // 不裁剪不猜测——四选项各引用该图并注明见图，置信度中等，审核时人工核对
      const image = usableImages[0]!
      stemImages.push(image)
      const keys = ['A', 'B', 'C', 'D']
      for (const key of keys) {
        options.push({ key, text: '见图', image: image.imgPath })
      }
      stats.singleFigureGroups += 1
      note = '整图版式：选项 A-D 印在题干图内（置信度 55%），请人工核对'
      stats.lowConfidence += 1
    } else if (usableImages.length >= 1) {
      stemImages.push(...usableImages)
      stats.incompleteOptionQuestions += 1
      note = `选项图片不足（${usableImages.length} 张），暂不自动发布，请人工核对原图`
      stats.lowConfidence += 1
    } else {
      note = '本页未识别到图片'
    }
    const stemWithImages = [stem, ...stemImages.map((image) => `![](${image.imgPath})`)]
      .filter(Boolean)
      .join('\n')
    questions.push({ set: 1, num, stem: stemWithImages, options })
    notes.push(note)
  }
  // 已保存但没落在任何题页的图片
  const usedPaths = new Set(
    questions.flatMap((question) => question.options.map((o) => o.image ?? ''))
  )
  const questionStemPaths = new Set(
    questions.flatMap((question) =>
      [...question.stem.matchAll(/images\/[^\s)]+/g)].map((m) => m[0])
    )
  )
  for (const block of regions.regions) {
    if (block.type === 'image' && block.imgPath) {
      if (!usedPaths.has(block.imgPath) && !questionStemPaths.has(block.imgPath))
        stats.unboundImages += 1
    }
  }
  stats.stemImageGroups = questions.filter((question) => question.stem.includes('images/')).length
  return { questions, notes, ...stats }
}

export interface GraphicMergeOptions {
  subject: string
  category: string
  sourceFile: string
  tags: string[]
}

export interface GraphicMergeResult {
  items: DirectQuestion[]
  /** 与 items 同序：每题的审核警告（绑定说明 + 未配到答案提示） */
  itemWarnings: string[][]
  paired: number
  unpaired: number
}

// 图形题合并：答案仍只来自解析册（set-num 钥匙配对）——没有配到答案的题目
// 保留空答案进入待审核（警告标注），绝不静默丢弃，也不猜答案。
export function mergeGraphicQuestions(
  questions: ParsedQuestion[],
  solutions: Map<string, { answer: string }>,
  options: GraphicMergeOptions,
  notes: string[] = []
): GraphicMergeResult {
  const items: DirectQuestion[] = []
  const itemWarnings: string[][] = []
  let paired = 0
  let unpaired = 0
  for (const [index, question] of questions.entries()) {
    const key = `${question.set}-${question.num}`
    const answerText = (solutions.get(key)?.answer || '').toUpperCase().replace(/[^A-D]/g, '')
    if (answerText) paired += 1
    else unpaired += 1
    items.push({
      id: `kb-g${createHash('sha256')
        .update(`${options.sourceFile}\n${key}`)
        .digest('hex')
        .slice(0, 19)}`,
      set: question.set,
      num: question.num,
      subject: options.subject,
      category: options.category,
      tags: [...new Set([...options.tags, '图形推理'])],
      sourceFile: options.sourceFile,
      questionType: 'single',
      difficulty: 3,
      stem: question.stem,
      options: question.options,
      answer: answerText.split(''),
      explanation: '该题暂未提供解析。'
    })
    const warnings: string[] = []
    if (notes[index]) warnings.push(notes[index]!)
    if (!answerText) warnings.push('未配到参考答案：发布前需配对解析册/答案页')
    itemWarnings.push(warnings)
  }
  return { items, itemWarnings, paired, unpaired }
}

export interface GraphicPreservation {
  id: string
  title: string
  markdown: string
  warnings: string[]
}

/** 图推默认通道（自动结构化关闭）：逐页保留原始页面图片与 OCR 文字，进人工审核。
 *  不生成可练习题目、不判规律、不绑选项——资料不丢失，能力边界诚实可见。 */
export function buildGraphicPreservation(
  regions: StructuredRegions,
  sourceFile: string
): GraphicPreservation[] {
  const noise = pageNoiseTexts(regions.regions)
  const byPage = groupByPage(regions.regions)
  const items: GraphicPreservation[] = []
  for (const [page, blocks] of byPage) {
    const images = blocks.filter((block) => block.type === 'image' && block.imgPath)
    if (images.length === 0) continue
    const texts = blocks
      .filter((block) => block.type === 'text' && !noise.has(block.text.trim()))
      .map((block) => block.text.trim())
      .filter(Boolean)
    const id = `kb-p${createHash('sha256')
      .update(`${sourceFile}\npage-${page}`)
      .digest('hex')
      .slice(0, 19)}`
    items.push({
      id,
      title: `图形推理图片题 · 第 ${page + 1} 页`,
      markdown: [
        '---',
        'kind: "document"',
        `subject: "xingce"`,
        `category: "图形推理-原始页面"`,
        `title: ${JSON.stringify(`图形推理图片题 · 第 ${page + 1} 页`)}`,
        'generatedBy: "direct-import"',
        '---',
        '',
        `# 原始页面（第 ${page + 1} 页）`,
        '',
        '图形推理图片题：暂不支持自动识别图形规律和图片选项。原始页面已保留，请人工审核后再处理。',
        '',
        '## 原始页面图片',
        '',
        ...images.map((image) => `![](images/${image.imgPath.split('/').pop()})`),
        '',
        ...(texts.length ? ['## 页面文字（OCR）', '', ...texts, ''] : [])
      ].join('\n'),
      warnings: [
        '图形推理图片题：暂不支持自动识别图形规律和图片选项。',
        '原始页面已保留，请人工审核后再处理。'
      ]
    })
  }
  return items
}
// ---- 混合试卷中的图形推理小题：按版面坐标把选项图绑到题目上 ----
// 文字通道切出的图推题只有 "A.A" 占位选项或空选项；RapidDoc 在 2×2 选项网格上的阅读顺序
// 不可靠（标签与图片交错错位），改用 _regions.json 的坐标做几何绑定：每个选项标签块
// （"A"/"B"/"C"/"D"）正上方最近且水平对齐的图片块即该选项图。题目常跨页（题号在上页底、
// 图在下页顶），跨度按全局阅读顺序（页, y）取到下一个题号锚点。绑定结果一律进人工核对。

const GRAPHIC_STEM =
  /从所给的四个选项中|使之呈现一定的规律性|填入问号处|分为两类|每一类图形|图形的变化规律|所给图形/
const OPTION_LABEL = /^[A-DＡ-Ｄ]\s*[.、．]?$/
// 与 question-import 的 QUESTION_NO 对齐：题号后不得紧跟数字，防止 "1.5亿元" 这类小数被当题号锚点
const QUESTION_ANCHOR = /^\s*(\d{1,3})\s*[.、．](?!\d)/

export interface GraphicBindingSummary {
  /** 四个选项图全部绑定的题数 */
  bound: number
  /** 无标签、按顺序兜底绑定的题数（置信度较低） */
  partial: number
  /** 选项本身是文字（"分为两类"等题型），只把题干图附上的题数 */
  stemOnly: number
  /** 识别为图推但未能绑定的题数 */
  skipped: number
  /** 审核提示，按 `${set}-${num}` 键控：同文件多套题库时题号会重复，只按 num 会互相覆盖 */
  notes: Map<string, string[]>
}

function centerX(block: RegionBlock): number {
  const [x0 = 0, , x1 = 0] = block.bbox
  return (x0 + x1) / 2
}

function widthOf(block: RegionBlock): number {
  const [x0 = 0, , x1 = 0] = block.bbox
  return Math.max(1, x1 - x0)
}

/** 选项文本只是字母占位（"A.A"）或为空：文字通道没拿到真正的选项内容 */
function placeholderOptions(question: ParsedQuestion): boolean {
  if (question.options.length === 0) return true
  return question.options.every((option) => {
    // 版面引擎常把整行 "A.A B.B C.C D.D" 折给第一个选项、把图片引用附着在选项文字后：
    // 剥掉图片引用与「字母.字母」残片后不再有实质内容，即视为占位选项
    const text = option.text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/[A-DＡ-Ｄ][.、．][A-DＡ-Ｄ]/g, '')
      .replace(/\s+/g, '')
      .normalize('NFKC')
      .toUpperCase()
    // 只剩 A-D 字母（含散落标签拼接成的 "AB"/"BD"）即无实质内容
    return /^[A-D]*$/.test(text)
  })
}

// 题干里散落的选项标签行（"A"、"B.B"、"A.A B.B C.C D.D"）不是题干内容
function isLabelDebris(line: string): boolean {
  return /^([A-DＡ-Ｄ]([.、．][A-DＡ-Ｄ]?)?)+$/.test(line.replace(/\s+/g, ''))
}

// 题干里已有的图片引用去重后重排：先文字，再题干图（按版面顺序）
function withStemImages(stem: string, stemImages: RegionBlock[]): string {
  const text = stem
    .split('\n')
    .filter((line) => !isLabelDebris(line.trim()))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return [text, ...stemImages.map((image) => `![](${image.imgPath})`)].filter(Boolean).join('\n')
}

/** 同页版面排序：双栏页按「左栏→右栏、栏内按 y」，其余页面按 y。
 *  无条件按 (page, y) 全局重排会把右栏题号排到左栏题干前面，打乱跨度边界。
 *  双栏判定要同时满足：两簇块数各 ≥4、两簇都含题号锚点（真实双栏每栏都有题号；
 *  单栏页的 2×2 选项网格几何上左右分簇，但题号块横跨全宽不落进任何簇）、
 *  两簇 y 范围重叠过半、每簇高度过页面大半。 */
function sortRegionsInReadingOrder(regions: RegionBlock[]): RegionBlock[] {
  const byPage = new Map<number, RegionBlock[]>()
  for (const block of regions) {
    const list = byPage.get(block.page)
    if (list) list.push(block)
    else byPage.set(block.page, [block])
  }
  const byY = (a: RegionBlock, b: RegionBlock): number => (a.bbox[1] ?? 0) - (b.bbox[1] ?? 0)
  const ordered: RegionBlock[] = []
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const blocks = byPage.get(page)!
    const pageWidth = Math.max(...blocks.map((block) => block.bbox[2] ?? 0), 1)
    const mid = pageWidth / 2
    const leftOnly = blocks.filter((block) => (block.bbox[2] ?? 0) <= mid + 8)
    const rightOnly = blocks.filter((block) => (block.bbox[0] ?? 0) >= mid - 8)
    const hasAnchor = (list: RegionBlock[]): boolean =>
      list.some((block) => block.type === 'text' && QUESTION_ANCHOR.test(block.text))
    const ySpan = (list: RegionBlock[]): number =>
      list.length
        ? Math.max(...list.map((block) => block.bbox[3] ?? 0)) -
          Math.min(...list.map((block) => block.bbox[1] ?? 0))
        : 0
    const wholeSpan = ySpan(blocks)
    const overlapSpan =
      leftOnly.length && rightOnly.length && wholeSpan
        ? Math.max(
            0,
            Math.min(
              Math.max(...leftOnly.map((b) => b.bbox[3] ?? 0)),
              Math.max(...rightOnly.map((b) => b.bbox[3] ?? 0))
            ) -
              Math.max(
                Math.min(...leftOnly.map((b) => b.bbox[1] ?? 0)),
                Math.min(...rightOnly.map((b) => b.bbox[1] ?? 0))
              )
          ) / wholeSpan
        : 0
    const clustered =
      leftOnly.length >= 4 &&
      rightOnly.length >= 4 &&
      hasAnchor(leftOnly) &&
      hasAnchor(rightOnly) &&
      ySpan(leftOnly) >= wholeSpan * 0.6 &&
      ySpan(rightOnly) >= wholeSpan * 0.6 &&
      overlapSpan >= 0.5
    if (clustered) {
      // 栏归属按中心点：跨中线块按中心点归入所在栏，不丢弃
      const columns: [RegionBlock[], RegionBlock[]] = [[], []]
      for (const block of blocks) columns[centerX(block) <= mid ? 0 : 1]!.push(block)
      ordered.push(...columns[0]!.sort(byY), ...columns[1]!.sort(byY))
    } else ordered.push(...blocks.sort(byY))
  }
  return ordered
}

export function bindGraphicOptionsByGeometry(
  questions: ParsedQuestion[],
  regions: StructuredRegions
): GraphicBindingSummary {
  const summary: GraphicBindingSummary = {
    bound: 0,
    partial: 0,
    stemOnly: 0,
    skipped: 0,
    notes: new Map()
  }
  // 全局阅读顺序：先页后纵坐标（双栏页分栏）；题号锚点按该顺序取"下一个锚点"作为跨度终点（允许跨页）
  const ordered = sortRegionsInReadingOrder(regions.regions)
  const anchors: Array<{ num: number; index: number }> = []
  ordered.forEach((block, index) => {
    if (block.type !== 'text') return
    const match = block.text.match(QUESTION_ANCHOR)
    if (!match) return
    anchors.push({ num: Number(match[1]), index })
  })
  // 题号锚点按 `${set}-${num}` 键控并与 questions 顺序对齐：同文件多套题库时题号重复，
  // 只按 num 索引会把第二套全部映射回第一套的版面位置。锚点游标只前进，容忍 OCR 丢锚点；
  // 行首锚点缺失（题号漂移修复把题号留在行中）时在相邻已定锚点区间内按块内漂移题号或题干前缀兜底，
  // 兜底块同时作为上一题的终止边界，避免本题图片被吞进上一题。
  // 卷段边界：锚点题号回落（同套题号严格递增，回落或重复即新一套开始）——
  // 匹配当前题的锚点不得越过本套卷段，否则第一套某题漂移缺锚点时会误吞第二套的同号锚点
  const segments: Array<{ start: number; end: number }> = []
  let segmentStart = 0
  for (let k = 1; k < anchors.length; k += 1) {
    if (anchors[k]!.num <= anchors[k - 1]!.num) {
      segments.push({ start: segmentStart, end: k })
      segmentStart = k
    }
  }
  segments.push({ start: segmentStart, end: anchors.length })
  // question.set 与卷段按出现顺序对齐：OCR 把套边界整个吞掉时卷段数少于 set 数，
  // 超出的 set 复用最后一个卷段（退化为段内顺序匹配，不优于原行为也不更差）
  const setOrder = [...new Set(questions.map((question) => question.set))].sort((a, b) => a - b)
  const segmentOfSet = new Map<number, { start: number; end: number }>()
  setOrder.forEach((set, position) => {
    segmentOfSet.set(set, segments[Math.min(position, segments.length - 1)]!)
  })
  const anchorIndexByKey = new Map<string, number>()
  const driftAnchorIndexes = new Set<number>()
  let anchorCursor = 0
  let lastLocated = -1
  for (const question of questions) {
    const key = `${question.set}-${question.num}`
    const segment = segmentOfSet.get(question.set) ?? { start: 0, end: anchors.length }
    let start = -1
    for (let scan = Math.max(anchorCursor, segment.start); scan < segment.end; scan += 1) {
      if (anchors[scan]!.num === question.num) {
        start = anchors[scan]!.index
        anchorCursor = scan + 1
        break
      }
    }
    if (start < 0) {
      const lower = lastLocated
      // 兜底区间不越过本套卷段：上界取段内下一个未消费锚点，段耗尽时取下一套首锚点（或全文末尾）
      const cursorInSegment = Math.max(anchorCursor, segment.start)
      const upper =
        cursorInSegment < segment.end
          ? anchors[cursorInSegment]!.index
          : segment.end < anchors.length
            ? anchors[segment.end]!.index
            : ordered.length
      // 块内漂移题号："12." 出现在文本中间（题号被版面引擎挤进行中）：
      // 前一字符不得是数字，紧邻顿号时顿号前不得是数字（顿号数字枚举不是题号）
      const drift = new RegExp(
        `(?<!\\d)(?<![0-9][.、．,，;；])${question.num}[.、．](?![\\da-z])(?![.、．,，;；][0-9])`
      )
      const stemPrefix = question.stem
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\s+/g, '')
        .slice(0, 12)
      for (let index = lower + 1; index < upper; index += 1) {
        const block = ordered[index]
        if (!block || block.type !== 'text') continue
        if (
          drift.test(block.text) ||
          (stemPrefix.length >= 6 && block.text.replace(/\s+/g, '').includes(stemPrefix))
        ) {
          start = index
          driftAnchorIndexes.add(index)
          break
        }
      }
    }
    if (start >= 0) {
      anchorIndexByKey.set(key, start)
      lastLocated = start
    }
  }
  const anchorIndexes = [...anchors.map((anchor) => anchor.index), ...driftAnchorIndexes].sort(
    (a, b) => a - b
  )
  const keys = ['A', 'B', 'C', 'D']
  for (const question of questions) {
    const placeholder = placeholderOptions(question)
    if (!GRAPHIC_STEM.test(question.stem) && !placeholder) continue
    const start = anchorIndexByKey.get(`${question.set}-${question.num}`)
    if (start === undefined) {
      if (!GRAPHIC_STEM.test(question.stem)) continue
      summary.skipped += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        '图形推理：未在版面块中定位到题号，选项图未绑定，请人工核对'
      ])
      continue
    }
    const end = anchorIndexes.find((index) => index > start) ?? ordered.length
    const span = ordered.slice(start + 1, end)
    const images = span.filter((block) => block.type === 'image' && block.imgPath)
    if (images.length === 0) {
      if (!GRAPHIC_STEM.test(question.stem)) continue
      summary.skipped += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        '图形推理：题目范围内没有图片块，请人工核对原图'
      ])
      continue
    }
    if (!placeholder) {
      // 选项是真实文字（如"分为两类"的 ①②④，③⑤⑥）：图片全部属于题干
      question.stem = withStemImages(question.stem, images)
      summary.stemOnly += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        `图形推理：${images.length} 张题干图已随题附上，选项为文字，请核对图序`
      ])
      continue
    }
    const labels = span
      .filter((block) => block.type === 'text' && OPTION_LABEL.test(block.text.trim()))
      .map((block) => ({ key: block.text.trim().charAt(0).normalize('NFKC').toUpperCase(), block }))
      .sort((a, b) => a.key.localeCompare(b.key))
    const used = new Set<RegionBlock>()
    const bound = new Map<string, RegionBlock>()
    for (const label of labels) {
      if (bound.has(label.key)) continue
      const [, ly0 = 0, , ly1 = 0] = label.block.bbox
      let best: { image: RegionBlock; gap: number } | undefined
      for (const image of images) {
        if (used.has(image) || image.page !== label.block.page) continue
        const [, iy0 = 0, , iy1 = 0] = image.bbox
        const aligned =
          Math.abs(centerX(image) - centerX(label.block)) <=
          Math.max(widthOf(image), widthOf(label.block)) * 0.6
        if (!aligned) continue
        // 标签通常印在图下方，少数版式印在图上方：两种都接受，取距离最近者
        const gap =
          iy1 <= ly0 + 30 ? ly0 - iy1 : iy0 >= ly1 - 30 ? iy0 - ly1 : Number.POSITIVE_INFINITY
        if (gap > 260) continue
        if (!best || gap < best.gap) best = { image, gap }
      }
      if (best) {
        used.add(best.image)
        bound.set(label.key, best.image)
      }
    }
    if (bound.size === 4) {
      const stemImages = images.filter((image) => !used.has(image))
      question.options = keys.map((key) => ({ key, text: '', image: bound.get(key)!.imgPath }))
      question.stem = withStemImages(question.stem, stemImages)
      summary.bound += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        '图形推理：4 个选项图已按版面坐标绑定（几何匹配），发布前请人工核对'
      ])
    } else if (labels.length === 0 && images.length >= 4 && optionLike(images.slice(-4))) {
      const tail = images.slice(-4)
      question.options = keys.map((key, index) => ({ key, text: '', image: tail[index]!.imgPath }))
      question.stem = withStemImages(question.stem, images.slice(0, -4))
      summary.partial += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        '图形推理：未识别到选项标签，末尾 4 张图按顺序作为选项（置信度较低），请人工核对'
      ])
    } else {
      summary.skipped += 1
      summary.notes.set(`${question.set}-${question.num}`, [
        `图形推理：选项图绑定不完整（标签 ${labels.length}、图片 ${images.length}、已绑 ${bound.size}），请人工核对原图`
      ])
    }
  }
  return summary
}
