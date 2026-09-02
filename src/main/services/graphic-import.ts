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
