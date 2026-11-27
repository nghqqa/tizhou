// 直导题库解析器：把 OCR/转换后的题本与解析/答案文本确定性切分为题目，不调用模型。
// 版式假设来自实测的花生/四海/超格系题本：套标题 + 「N. 题干 + A-D 选项」+ 解析册【参考答案】标记块，
// 或书尾「第N篇 + 1-5:BBDBC」分组答案页。
import { createHash } from 'node:crypto'
import { yamlQuote } from '../utils/common'
import { extractRegionFromText } from '../../shared/region'
import { classifyShenlunType } from '../../shared/shenlun'
import type { PageManifest } from './source-evidence'
import {
  STRUCTURAL_NOISE_LINE,
  WATERMARK_PATTERNS,
  cleanExplanation,
  quarantineNumberStreamLine,
  stripStructuralNoise,
  stripWatermarkFragments
} from './import-quality'

export interface DirectOption {
  key: string
  text: string
  /** 图形题选项图片（images/ 相对路径）；图片选项允许 text 为空 */
  image?: string
}

export interface ParsedQuestion {
  set: number
  num: number
  stem: string
  options: DirectOption[]
  /** 所属段/小节规范化标题（如「考点刷题1」「练习1增量」），用于与独立答案册精准按段配对 */
  sectionTitle?: string
  /** 段内连续题号（如四海「图推刷题1」下分「第一组/第二组」各自 1~10 题，段内连续号为 1~40），用于与独立答案册连续题号对齐 */
  sectionQuestionNum?: number
  /** 该题所属套的共享材料（统计表/文字资料），资料分析类书籍专用 */
  material?: string
  /** 题目在输入行数组中的起始行号（0-based，TOC 过滤后）：来源页证据用 */
  lineStart?: number
  /** 套内共享材料在输入行数组中的行区间（含端点）：材料页映射传递给组内题目用 */
  materialLineRange?: { start: number; end: number }
}

export interface ParsedSolution {
  set: number
  num: number
  answer: string
  qtype: string
  explanation: string
  /** 解析册在【参考答案】前重印的题干开头，用于配对一致性校验 */
  stemExcerpt?: string
  origin?: { year: number; region: string; rate: number }
  /** 答案标记内嵌的正确率（如【参考答案及正确率】C，89% → 0.89），无则缺省 */
  answerRate?: number
  /** 解析清洗阶段的可读性/水印警告（人工审核提示） */
  cleanupWarnings?: string[]
  /** 解析条目在解析册输入行数组中的起始行号（0-based）：解析册来源页证据用 */
  lineStart?: number
}

export interface DirectQuestion {
  id: string
  set: number
  num: number
  subject: string
  category: string
  tags: string[]
  sourceFile: string
  year?: number
  region?: string
  paper?: string
  questionType: string
  difficulty: number
  stem: string
  options: DirectOption[]
  answer: string[]
  explanation: string
  /** 主观题材料原文（申论直导）；客观题不产出该字段 */
  material?: string
  /** 组题标识：同源同套的小题共享，练习抽题时整组连续（资料分析一组材料带 N 题） */
  groupId?: string
  /** 组内小题序号 */
  groupOrder?: number
  /** 解析清洗警告（水印/断句/括号未闭），人工审核提示 */
  cleanupWarnings?: string[]
  /** 来源页证据透传：题本行号（与题本行页映射平行） */
  lineStart?: number
  /** 套内共享材料行区间（题本行号） */
  materialLineRange?: { start: number; end: number }
  /** 配对解析条目的行号（解析册行号）与解析册 sourceId */
  solutionLineStart?: number
  solutionSourceId?: string
}

const SET_TITLE = /^#{0,4}\s*练习题\s*0*(\d{1,3})\s*套?\s*#*\s*$/
const CHAPTER_TITLE = /^#{0,4}\s*第[一二三四五六七八九十百0-9]{1,4}[篇章套]/
// 具名段内分组标题（如四海「图推刷题1」下的「第一组」「第二组」）：重置印制题号但延续段名与段内连续题号
const SUBGROUP_TITLE = /^#{0,4}\s*第[一二三四五六七八九十0-9]{1,2}组\s*$/
// 资料分析 / 篇章阅读同套内多篇共享材料分隔头（如「# 二、根据所给材料，回答6～10题。」「阅读下文，回答26~30题。」「材料二」）；
// 分组 1 捕获起始题号，供状态机在跳号/篇章阅读（如 26~30 题、111~115 题）场景同步 expected
const MATERIAL_GROUP_HEADER =
  /^#{0,4}\s*(?:[一二三四五六七八九十0-9]{1,3}\s*[、.．]\s*)?(?:(?:请?根据(?:所给|以下|下列|下面|上述)?(?:文字|统计|图表)?(?:材料|资料)|阅读(?:下文|下面文章|以下文章|下列文章|材料))[，,]?\s*(?:回答|完成)\s*第?\s*(\d{1,3})\s*[～~—-]\s*\d{1,3}\s*题[。.:：]?|(?:文字|图表|表格|综合)?(?:材料|资料)\s*[一二三四五六七八九十0-9]{1,2}\s*[:：]?)\s*$/
// 目录页头与练习册结构性板块提示（不并入共享材料）
const TOC_HEADER = /^#{0,4}\s*目\s*录\s*$/
const BOILERPLATE_HEADING =
  /^#{0,4}\s*(?:复盘心得|用时|正确率|引言|前言|课程设置|第[一二三四五六七八九十百0-9]{1,3}[章节]\s*[^\n]{0,24}|（[一二三四五六七八九十]+）[^\n]{2,18}|[一二三四五六七八九十]+、[^\n]{2,18})\s*[:：]?[^\n]{0,16}$/
// 答案区内的中文序号小节（如夸夸刷「一、部分数、个数」「二、对称轴」）
const ANSWER_SUBSECTION_TITLE = /^#{0,4}\s*[一二三四五六七八九十]{1,3}、\s*[^\n]{1,28}\s*$/
// 四海系（考点刷题 1 / 套题训练 1 / 图推刷题 1）、酷酷刷系（专项刷题一 / 练习1 增量 / 第一练：①和差倍比）与夸夸刷系（实战演练一）段标题
const NAMED_SECTION_TITLE =
  /^#{0,4}\s*(?:(?:考点|综合|专项|套题|实战|图推|类比|定义|逻辑|判断|言语|数量|资料|选词|片段)(?:刷题|套题|训练|演练)\s*0*[一二三四五六七八九十百0-9]{1,3}\s*[:：]?|练习\s*0*\d{1,3}\s*[\u4e00-\u9fff][^\n]{0,30}|第[一二三四五六七八九十百0-9]{1,3}练\s*[:：]\s*[^\n]{1,36})\s*$/
// 目录引导行（如「考点刷题1…… 1」「练习1 增量.... ...1」），避免误认作正文段标题
const TOC_LEADER_TAIL = /(?:[.。…·•]{2,}\s*\d{0,4}|[.。…·•]\s+\d{1,4})\s*$/
// 夸夸刷小节分隔（如「（二）渐入佳境（20题）」）与随节内嵌答案行（如「答案：1-5：ABADD 6-7：CA」）
const INLINE_ANSWER_LINE = /^#{0,4}\s*(?:参考)?答案\s*[:：]\s*\d{1,3}\s*(?:[-—~～]\s*\d{1,3})?/
// 题号匹配：允许 RapidDoc 产出的 Markdown 标题前缀（如「# 32.」），
// 仍拦截小数（如「1.5亿元」「2.5」），但放行点后紧跟四位年份的资料分析题干（如「2.2022年…」「16.2020年，…」）
const QUESTION_NO =
  /^#{0,4}\s*(\d{1,3})\s*[.、．](?:(?!\d)\s*(.*)|(?=(?:19|20)\d{2}(?:[^\d.]|$))(.*)$)/
// 夸夸刷 / 酷酷刷例题与速算练习题号（如「【例1】（2020联考）…」「# 【例题11】…」「练习1：现期=…」）
const EXAMPLE_QUESTION_NO =
  /^#{0,4}\s*(?:【\s*例题?\s*0*(\d{1,3})\s*】\s*(.*)|练习\s*0*(\d{1,3})\s*[:：]\s*(.+))$/

function matchQuestionNo(line: string): { num: number; rest: string } | undefined {
  const example = line.match(EXAMPLE_QUESTION_NO)
  if (example) {
    return {
      num: Number(example[1] ?? example[3] ?? '0'),
      rest: example[2] ?? example[4] ?? ''
    }
  }
  const match = line.match(QUESTION_NO)
  if (!match) return undefined
  return { num: Number(match[1] ?? '0'), rest: match[2] ?? match[3] ?? '' }
}

/** 规范化段标题（去 #、空白、标点差异），用于题本与独立答案册精准按段名对齐 */
export function normalizeSectionTitle(line: string): string {
  return line
    .replace(/^#{0,4}\s*/, '')
    .replace(/[\s:：、，,（）()]+/g, '')
    .trim()
}

function isNamedSectionTitle(line: string): boolean {
  if (TOC_LEADER_TAIL.test(line)) return false
  return NAMED_SECTION_TITLE.test(line)
}

// 严格要求标点或空白后有实质内容，防止图片题孤立标签行「A.」「B.」把句点当成选项正文
const OPTION_NO = /^([A-D])(?:\s*[.、．]\s*(.+)|\s+(.+))$/
const ANSWER_MARK = /【参考答案】\s*([A-D]+)/
const ANSWER_RATE_MARK = /【参考答案及正确率】\s*([A-D]+)(?:[，,]\s*(\d{1,3})\s*%)?/
// 花生十三系解析册的加长变体：【参考答案及正确率】C，89%（正确率喂难度映射）
const META_MARK = /【题型(?:与文段类型|分类)】\s*(.+)/
const EXPLAIN_MARK = /【实战解析】/
const ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]*?)\s+(\d{1,3})\s*%\s*[)）]/
const ANSWER_SECTION =
  /^#{0,4}\s*(?:参考答案|(?:参考)?答案(?:速查|对照表|一览表)|(?:【[^】]{1,12}】)?[^\n]{0,28}题本(?:[（(]?参考)?答案[）)]?)\s*$/
// 支持冒号缺省（四海「1-5 CADAD 6-10 BABBD」）与冒号形式（花生/酷酷刷「1-5:BBDBC」），全局匹配同行多段
const ANSWER_RANGE_GLOBAL = /(\d{1,3})\s*[-—~～]\s*(\d{1,3})\s*(?:[:：]\s*|\s+)([A-Da-d]{1,30})/g
// 酷酷刷单题答案格（如「6：B」「26：B」，兼容 RapidDoc <td>6：B</td> 表格形态）
const SINGLE_ANSWER_GLOBAL = /(?:^|[\s>])(\d{1,3})\s*[:：]\s*([A-Da-d]{1,4})(?=[\s<]|$)/g
const NOISE = /^(四海公考|SIHAIGONGKAO|花生十三|花生[+＋十]三?|超格学员专用|公众号[：:].*)$/i
const OPTION_LINE = /^[A-D]\s*[.、．]/

/**
 * 题号漂移修复。粉笔系试卷 PDF 用悬挂缩进排版（题号独立成一列），其文字流把题号写在
 * 题干换行文本之后，版面引擎按流合并后题号会拼进题干中间（"坚持以人民为中1.心"）或
 * 挂在上一段末尾（"…云服务、114."）。按"下一个期望题号"在段落中/行尾找到它并归位：
 * 行中漂移提到行首，行尾漂移移交给下一行开头。只改行内容、不增删行，
 * 来源页证据依赖的行号映射不受影响；容忍一个题号缺失（接受期望值 +1）。
 */
export function repairDriftedQuestionNumbers(lines: string[]): string[] {
  const out: string[] = []
  let expected = 1
  let carried: number | undefined
  // 题干以数字开头（"2024年…"）时题号后补空格，否则会被 QUESTION_NO 的防小数规则拒收
  const prefix = (num: number, rest: string): string =>
    `${num}.${/^\d/.test(rest) ? ' ' : ''}${rest}`
  for (const rawLine of lines) {
    let line = rawLine
    if (carried !== undefined && line.trim()) {
      // carried 只拼给普通正文行：套标题/答案区/噪声/选项/图片表格行是结构边界，
      // 拼接会破坏结构识别（如"12.练习题02套"不再是合法套标题）。此时丢弃 carried——
      // 该题号本就来自行尾漂移，宁缺不串
      const structural =
        SET_TITLE.test(line) ||
        CHAPTER_TITLE.test(line) ||
        SUBGROUP_TITLE.test(line) ||
        isNamedSectionTitle(line) ||
        INLINE_ANSWER_LINE.test(line) ||
        ANSWER_SECTION.test(line) ||
        NOISE.test(line) ||
        OPTION_LINE.test(line) ||
        /^(!\[|\||<table\b)/i.test(line)
      if (!structural) {
        line = prefix(carried, line)
        carried = undefined
      } else carried = undefined
    }
    if (
      SET_TITLE.test(line) ||
      SUBGROUP_TITLE.test(line) ||
      isNamedSectionTitle(line) ||
      INLINE_ANSWER_LINE.test(line)
    ) {
      expected = 1
      out.push(line)
      continue
    }
    const head = matchQuestionNo(line)
    if (head) {
      const num = head.num
      // 行首出现的合理题号即重同步：引擎整个丢掉几道题的题号时（73/74/75 全无），
      // 后续真题号不能被死等的期望值卡住
      if (num === 1) expected = 2
      else if (num >= expected && num - expected <= 10) expected = num + 1
      out.push(line)
      continue
    }
    const matGroup = line.match(MATERIAL_GROUP_HEADER)
    if (matGroup) {
      const rangeStart = Number(matGroup[1] ?? '0')
      if (rangeStart >= 1 && rangeStart <= 200) expected = rangeStart
      out.push(line)
      continue
    }
    if (
      OPTION_LINE.test(line) ||
      ANSWER_SECTION.test(line) ||
      CHAPTER_TITLE.test(line) ||
      TOC_HEADER.test(line) ||
      TOC_LEADER_TAIL.test(line) ||
      /^(!\[|\||<table\b)/i.test(line)
    ) {
      // 选项行、答案区与图片/Markdown 表格/HTML 表格不修题号漂移（防止「<td>5.外商企业</td>」被误判为漂移题号）
      out.push(line)
      continue
    }
    let repaired: string | undefined
    for (const candidate of [expected, expected + 1]) {
      // 行尾漂移：题号前一字符不得是数字（"2025."），且紧邻顿号时顿号前不得是数字——
      // "…云服务、114." 是真漂移（顿号前是文字），"…10、11、" 是顿号枚举（顿号前是数字）
      const tail = line.match(
        new RegExp(`^(.*\\S)\\s*(?<!\\d)(?<![0-9][.、．,，;；])(${candidate})[.、．]\\s*$`)
      )
      if (tail) {
        carried = candidate
        repaired = tail[1]!
        expected = candidate + 1
        break
      }
      // 行中漂移：题号后不得紧跟数字或小写字母（排除小数 "2.5" 与文件后缀 "a77.png"），
      // 也不得处于"数字+顿号"枚举中段（"10、11、12" 的 11：前是顿号且顿号前是数字）
      const mid = line.match(
        new RegExp(
          `^(.{4,}?)\\s*(?<!\\d)(?<![0-9][.、．,，;；])(${candidate})[.、．](?![\\da-z])(?![.、．,，;；][0-9])(.*)$`
        )
      )
      if (mid) {
        repaired = prefix(candidate, `${mid[1]}${mid[3]}`)
        expected = candidate + 1
        break
      }
    }
    out.push(repaired ?? line)
  }
  return out
}

// ---- 申论主观题教材（直导）：单元式「训练 + 资料 + 提问 + 要求」结构 ----
// 两种实测版式：【训练一】标题（夸夸刷系） / 训练一：标题（酷酷刷系）；兼容 --structured 产出的 Markdown # 标题前缀
const ESSAY_UNIT_MARK =
  /^#{0,4}\s*【?训练\s*[一二三四五六七八九十百0-9]{1,4}\s*】?\s*[:：]?\s*(.+)$/
const ESSAY_CHAPTER_MARK = /^#{0,4}\s*第[一二三四五六七八九十百0-9]{1,4}章\s*(.*)$/
const ESSAY_MATERIAL_HEADER =
  /^#{0,4}\s*(?:资料|给定资料)\s*[0-9一二三四五六七八九十]{0,3}\s*[:：]?$/
const ESSAY_REQUIREMENT_MARK = /^#{0,4}\s*要求[:：]\s*(.+)$/
const ESSAY_ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]{1,24}?)\s*[)）]\s*$/
// 题干段尾内联真题出处（如「……(2023 年山东 B 卷)」「……(2026年国考市地卷）」）
const ESSAY_INLINE_ORIGIN =
  /[（(]\s*((?:19|20)\d{2})\s*年\s*([^)）]{1,28}?)\s*[)）](?:\s*[（(]\s*\d{1,2}\s*分\s*[)）])?[。.]?\s*$/
// 剔除 RapidDoc 将「要求：」与下方虚线名言框粘连的装饰尾段（如 `---一·一·一…► 唯物辩证法…`）
const ESSAY_DASHED_DECORATION = /\s*(?:[-－—–=]{3,}|(?:[-－—–一]\s*[·•.．]\s*){3,})[\s\S]*$/
const ESSAY_ANSWER_HEADER = /^#{0,4}\s*(?:【)?(?:参考答案|答案要点)(?:】)?\s*[:：]?$/
// 目录页点线引导符与孤立页码（OCR 常产出「.2」「…38」「100」这类残渣行）
const ESSAY_LEADER_LINE = /^[.。…·•]{2,}\s*\d{0,4}$/
const ESSAY_PAGE_NUMBER = /^\d{1,4}$/

export function toLines(raw: string): string[] {
  return toLinesWithPageMap(raw).lines
}

/** toLines 的带页版本：过滤链逐行判定与 toLines 完全一致（trim/波浪线/全篇答案/
 *  水印片段/结构噪声都是行级操作），页标签与输出行严格平行。
 *  页标签来自页清单（worker _pages.json 的行序 = markdown 非空行序）；
 *  解析状态机消费这些行（LocatedLine）时的页标签即 exact 依据；无清单时全 undefined。 */
export function toLinesWithPageMap(
  raw: string,
  manifest?: PageManifest
): { lines: string[]; pageMap: Array<number | undefined> } {
  const rawPageOf: Array<number | undefined> = []
  if (manifest)
    for (const page of manifest.pages) for (const _ of page.lines) rawPageOf.push(page.pageNumber)
  let manifestCursor = 0
  const lines: string[] = []
  const pageMap: Array<number | undefined> = []
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim()
    const isBlank = !line
    // markdown 非空行序与页清单行序一致（同一 worker 生成）：非空行依序消费标签
    const label = manifest && !isBlank ? (rawPageOf[manifestCursor++] ?? undefined) : undefined
    if (isBlank) continue
    line = line.replace(/\\?~+/g, '～')
    line = line.replace(/【全篇答案】[A-D]{2,}/g, '').trim()
    if (!line) continue
    // 行内水印剥离（与 stripWatermarkFragments 同一模式表：只删片段、保留其余内容）
    for (const pattern of WATERMARK_PATTERNS) line = line.replace(pattern, '')
    line = line.replace(/\s{2,}/g, ' ').trim()
    if (!line) continue
    if (STRUCTURAL_NOISE_LINE.test(line)) continue
    lines.push(line)
    pageMap.push(label)
  }
  return { lines, pageMap }
}
// 书首目录过滤（双通道规则）：
// 题本/解析册常在开头整页印「练习题01套…练习题30套」目录，使按序递增的套号状态机在
// 正文开始前就被推到最大套号（实测解析册 392 页全程错位，只识别出最后一套）。
// 判定：把所有套标题按相邻间距聚簇；只有当某簇的套号集合在后文【再次】成簇出现时，
// 该簇才是目录副本并删除——真实正文锚点不会原样重现。无重复证据的小夹具/普通书不受影响。
/** TOC 过滤结果：lines 为过滤后数组，removedRows 为被删的输入行号（来源页证据行号修正用） */
export interface TocStrippedLines {
  lines: string[]
  removedRows: Set<number>
}

function stripTocSetTitleRuns(lines: string[]): TocStrippedLines {
  const titleRows: Array<{ row: number; set: number }> = []
  lines.forEach((line, row) => {
    const match = line.match(SET_TITLE)
    if (!match) return
    titleRows.push({ row, set: Number(match[1] ?? '0') })
  })
  if (titleRows.length < 2) return { lines, removedRows: new Set<number>() }

  // 相邻标题行间距 <= TOC_GAP 且套号单调递增才视为同一目录簇；
  // 一旦套号回落（如目录到 30 套结束、紧接着正文从 16 套或 1 套开始），必须切开为新簇，
  // 防止把紧邻目录尾行的正文首套标题一并吞进目录簇删除。
  const TOC_GAP = 3
  interface TitleCluster {
    rows: Array<{ row: number; set: number }>
  }
  const clusters: TitleCluster[] = []
  let clusterBuf: TitleCluster | undefined
  let lastRow = -10
  for (const entry of titleRows) {
    const prevSet = clusterBuf?.rows[clusterBuf.rows.length - 1]?.set ?? -1
    if (!clusterBuf || entry.row - lastRow > TOC_GAP || entry.set <= prevSet) {
      clusterBuf = { rows: [entry] }
      clusters.push(clusterBuf)
    } else {
      clusterBuf.rows.push(entry)
    }
    lastRow = entry.row
  }

  // 簇 A（至少 2 个紧凑标题）是目录副本当且仅当：其后所有簇合计重现了至少一半的本簇套号，
  // 或覆盖了后文全部套号的至少一半（应对合订总目录套数远超当前分册正文套数的场景），且至少 2 套重现。
  // 正文套标题彼此相隔上百行、各自形成长度 1 的孤立簇，若只与单个后文簇比较会永远漏判目录。
  const poisonedClusters = new Set<number>()
  for (let a = 0; a < clusters.length - 1; a += 1) {
    if (clusters[a]!.rows.length < 2) continue
    const laterSets = new Set<number>()
    for (let b = a + 1; b < clusters.length; b += 1) {
      for (const item of clusters[b]!.rows) laterSets.add(item.set)
    }
    const shared = clusters[a]!.rows.filter((item) => laterSets.has(item.set)).length
    const threshold = Math.max(
      2,
      Math.min(Math.floor(clusters[a]!.rows.length / 2), Math.ceil(laterSets.size / 2))
    )
    // 整书总目录（≥5 条连续套标题）出现在单套分册/单套切片头部时，后文仅重现 1 套也必为目录
    const denseSingleSetToc = clusters[a]!.rows.length >= 5 && laterSets.size === 1 && shared >= 1
    if (shared >= threshold || denseSingleSetToc) {
      poisonedClusters.add(a)
    }
  }
  if (!poisonedClusters.size) return { lines, removedRows: new Set<number>() }

  const removeRows = new Set<number>()
  for (const clusterIndex of poisonedClusters)
    for (const item of clusters[clusterIndex]!.rows) removeRows.add(item.row)
  const kept = lines.filter((_, index) => !removeRows.has(index))
  return { lines: kept, removedRows: removeRows }
}

// 套内共享材料行拼合为材料文本（过滤纯页码行与混入的套标题行——结构解析 md 的标题常带 # 前缀）
function materialText(materialLines: string[]): string | undefined {
  const cleaned = materialLines
    .filter((line) => !/^\d{1,3}$/.test(line))
    .filter((line) => !/^#{0,6}\s*练习题\s*\d+\s*套?\s*#*\s*$/.test(line))
    .join('\n\n')
    .trim()
  return cleaned.length >= 30 ? cleaned : undefined
}

// D 选项完整后的新材料边界判定（夸夸刷「材料在前、题号在后」单题资料分析 & 表格/图表题）：
// 防止将下一题的前置统计表、图表或资料段落错并进上一题的 D 选项。
const STANDALONE_IMAGE_LINE = /^!\[[^\]]*\]\([^)]+\)$/
const TABLE_OR_CHART_CAPTION =
  /^#{0,4}\s*(?:(?:表|图)\s*\d*\s+\S.{3,}|(?:19|20)\d{2}(?:年)?\s*[～~—-]\s*(?:19|20)\d{2}年?[^\n]{4,}(?:表|图|情况|统计|构成)|(?:19|20)\d{2}年[^\n]{4,}(?:成本|增速|产量|收入|授权量|情况|统计|构成|销售|出口|进口)(?:[^\n]{0,12}$))/
const DATA_PARAGRAPH_START =
  /^(?:截至\s*)?(?:(?:19|20)\d{2}\s*年|《[^》]{4,30}》|据[^\n]{2,18}统计|全国\d+%人口)/
const STAT_METRIC_GLOBAL =
  /\d+(?:\.\d+)?\s*(?:%|％|亿元|万元|元|万吨|万件|万人|万户|亿户|亿个|亿千瓦时|万千瓦|千公顷|万亩|个百分点|倍)/g

function isNewMaterialAfterOptions(line: string, lastOptionText: string): boolean {
  if (/^<table\b/i.test(line)) return true
  if (STANDALONE_IMAGE_LINE.test(line) && lastOptionText.trim().length > 0) return true
  const optTrim = lastOptionText.trim()
  const optLooksComplete =
    optTrim.length <= 28 ||
    /[。！？）)]$/.test(optTrim) ||
    /\d\s*(?:万|亿|%|％|元|件|人|个|倍)?$/.test(optTrim)
  if (!optLooksComplete) return false
  if (TABLE_OR_CHART_CAPTION.test(line)) return true
  if (line.length >= 38 && DATA_PARAGRAPH_START.test(line)) {
    const metrics = line.match(STAT_METRIC_GLOBAL) ?? []
    if (metrics.length >= 2) return true
  }
  return false
}

// RapidDoc 版面还原偶将上一题末选项与下一题真题头粘连到同一行（如 `D. xxx2.【2023事业联考】互联网时代…`）；
// 严格锚定「期望题号 + 年份考期括号头」拆分，既抢救失踪题目又绝不误切选项中的小数/序号
function splitGluedQuestionInOption(
  text: string,
  expectedNum: number
): { optionTail: string; num: number; rest: string } | null {
  for (const candidate of [expectedNum, expectedNum + 1]) {
    if (candidate < 1 || candidate > 200) continue
    const pattern = new RegExp(
      `^(.+?)(?<!\\d)(${candidate})\\s*[.、．]\\s*([【（(]\\s*(?:19|20)\\d{2}[\\s\\S]+)$`
    )
    const hit = text.match(pattern)
    if (hit && (hit[1]?.trim().length ?? 0) >= 2 && (hit[3]?.trim().length ?? 0) >= 6) {
      return {
        optionTail: hit[1]!.trim(),
        num: candidate,
        rest: hit[3]!.trim()
      }
    }
  }
  return null
}

// 题本切题：期望题号状态机；目录页连续标题只认第一行；题号行丢失时跳号续切；选项换行并入末选项
// lineStart 为输入行数组的 0-based 起始行号（TOC 删除行已修正回输入索引），
// 与调用方 toLines 输出的行号对齐——来源页证据用
export function parseQuestionBook(inputLines: string[]): ParsedQuestion[] {
  const { lines: tocLines, removedRows } = stripTocSetTitleRuns(inputLines)
  // 过滤后索引 → 输入索引（TOC 删除仅发生在书首目录，正文索引平移由此修正）
  const inputIndexOf: number[] = []
  for (let index = 0; index < inputLines.length; index += 1)
    if (!removedRows.has(index)) inputIndexOf.push(index)
  // 题号漂移修复逐行等长替换，不影响上面的索引映射
  const lines = repairDriftedQuestionNumbers(tocLines)
  const questions: ParsedQuestion[] = []
  let setNo = 0
  let sectionTitle: string | undefined
  let sectionOffset = 0
  let sectionQuestionCount = 0
  let current: ParsedQuestion | null = null
  let expected = 1
  let nextOption: string | null = null
  let lastLineWasHeader = false
  let currentStartLine = 0
  // 套内/篇内共享材料：套标题或「二、根据所给材料…」之后、小题之前的统计表/文字资料，附着给组内小题
  let setMaterial: string[] = []
  let materialRange: { start: number; end: number } | undefined
  const closeQuestion = () => {
    if (current && current.stem) {
      current.lineStart = currentStartLine
      questions.push(current)
      if (sectionTitle) sectionQuestionCount += 1
    }
  }
  const createQuestion = (num: number, rest: string, inputLine: number): ParsedQuestion => {
    currentStartLine = inputLine
    expected = num + 1
    nextOption = 'A'
    return {
      set: setNo,
      num,
      stem: rest,
      options: [],
      ...(sectionTitle ? { sectionTitle } : {}),
      ...(sectionTitle && sectionOffset > 0 ? { sectionQuestionNum: sectionOffset + num } : {}),
      material: materialText(setMaterial),
      materialLineRange: materialRange
    }
  }
  for (const [lineIndex, line] of lines.entries()) {
    if (NOISE.test(line)) continue
    if (ANSWER_SECTION.test(line)) break // 书尾分组答案区不再属于题干
    // 目录页头与点线目录引导行不并入共享材料，并清空此前累积的封面文字
    if (!current && (TOC_HEADER.test(line) || TOC_LEADER_TAIL.test(line))) {
      setMaterial = []
      materialRange = undefined
      continue
    }
    // 随节内嵌答案行（如夸夸刷「答案：1-5：ABADD 6-7：CA」）：结束上一题并开启下一节，防止污染末选项
    if (INLINE_ANSWER_LINE.test(line)) {
      closeQuestion()
      current = null
      nextOption = null
      setNo += 1
      expected = 1
      sectionTitle = undefined
      sectionOffset = 0
      sectionQuestionCount = 0
      setMaterial = []
      materialRange = undefined
      lastLineWasHeader = false
      continue
    }
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1] ?? '0')
      if (header > setNo && !lastLineWasHeader) {
        closeQuestion()
        setNo = header
        sectionTitle = undefined
        sectionOffset = 0
        sectionQuestionCount = 0
        current = null
        expected = 1
        nextOption = null
        setMaterial = []
        materialRange = undefined
      }
      lastLineWasHeader = true
      continue
    }
    // 四海/酷酷刷具名段标题（如「考点刷题 1」「套题训练 1」「专项刷题一」「练习1 增量」）：切分新套并记录段名
    if (isNamedSectionTitle(line)) {
      const normalized = normalizeSectionTitle(line)
      if (!lastLineWasHeader && normalized !== sectionTitle) {
        closeQuestion()
        setNo += 1
        sectionTitle = normalized
        sectionOffset = 0
        sectionQuestionCount = 0
        current = null
        expected = 1
        nextOption = null
        setMaterial = []
        materialRange = undefined
      }
      lastLineWasHeader = true
      continue
    }
    // 具名段内分组标题（如四海「图推刷题1」下分「第一组/第二组」各 1~10 题）：
    // setNo 递增保持 (set, num) 与版面锚点唯一不冲突，同时延续 sectionTitle 与段内连续偏移量
    if (sectionTitle && SUBGROUP_TITLE.test(line)) {
      closeQuestion()
      if (sectionQuestionCount > 0) {
        setNo += 1
        sectionOffset = sectionQuestionCount
      }
      current = null
      expected = 1
      nextOption = null
      setMaterial = []
      materialRange = undefined
      lastLineWasHeader = false
      continue
    }
    // 资料分析 / 篇章阅读同套内多篇材料分隔头（如「# 二、根据所给材料，回答6～10题。」「阅读下文，回答26~30题。」）：
    // 结束前一篇末题并切换新材料缓冲，且当分隔头给出起始题号时同步 expected（支持 26~30、111~115 跳段衔接）
    const materialHeader = line.match(MATERIAL_GROUP_HEADER)
    if (materialHeader) {
      closeQuestion()
      current = null
      nextOption = null
      setMaterial = []
      materialRange = undefined
      const rangeStart = Number(materialHeader[1] ?? '0')
      if (rangeStart >= 1 && rangeStart <= 200) expected = rangeStart
      lastLineWasHeader = false
      continue
    }
    lastLineWasHeader = false
    const match = matchQuestionNo(line)
    if (match) {
      const num = match.num
      const rest = match.rest
      const inputLine = inputIndexOf[lineIndex] ?? lineIndex
      const isExample = EXAMPLE_QUESTION_NO.test(line)
      if (
        !current &&
        (num === 1 ||
          num === expected ||
          (setNo > 0 && num > expected && num <= expected + 5) ||
          (isExample && num >= 1))
      ) {
        if (setNo === 0) setNo = 1
        // 前一题已因独立图/新材料提前收尾（expected > 5）时，新题号回到 1 须递增套号防 1-1 碰撞
        else if (num === 1 && expected > 5) {
          setNo += 1
          sectionTitle = undefined
          sectionOffset = 0
          sectionQuestionCount = 0
        }
        current = createQuestion(num, rest, inputLine)
        continue
      }
      if (num === expected && current) {
        closeQuestion()
        current = createQuestion(num, rest, inputLine)
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        closeQuestion()
        setNo += 1
        sectionTitle = undefined
        sectionOffset = 0
        sectionQuestionCount = 0
        setMaterial = []
        materialRange = undefined
        current = createQuestion(1, rest, inputLine)
        continue
      }
      // OCR 偶尔丢失题号行（或例题跨页跳号）：当前题结构完整时允许跳号续切，避免后续题目全部并入前一题
      if (
        num > expected &&
        num <= expected + (isExample ? 10 : 5) &&
        current &&
        current.options.length >= 3
      ) {
        closeQuestion()
        current = createQuestion(num, rest, inputLine)
        continue
      }
    }
    // 题目未开始时：非题号/选项的正文行累积为该篇共享材料（过滤复盘/用时等册页结构性提示行）
    if (!current) {
      if (BOILERPLATE_HEADING.test(line)) continue
      setMaterial.push(line)
      const inputLine = inputIndexOf[lineIndex] ?? lineIndex
      materialRange = materialRange
        ? { start: materialRange.start, end: inputLine }
        : { start: inputLine, end: inputLine }
      continue
    }
    if (current && nextOption) {
      const option = line.match(OPTION_NO)
      if (option && option[1] === nextOption) {
        const optText = option[2] ?? option[3] ?? ''
        if (nextOption === 'D') {
          const glued = splitGluedQuestionInOption(optText, expected)
          if (glued) {
            current.options.push({ key: 'D', text: glued.optionTail })
            closeQuestion()
            const inputLine = inputIndexOf[lineIndex] ?? lineIndex
            current = createQuestion(glued.num, glued.rest, inputLine)
            continue
          }
        }
        current.options.push({ key: option[1] ?? '', text: optText })
        nextOption =
          nextOption === 'A' ? 'B' : nextOption === 'B' ? 'C' : nextOption === 'C' ? 'D' : null
        continue
      }
    }
    if (current) {
      const lastOption = current.options[current.options.length - 1]
      if (current.options.length > 0 && lastOption) {
        // D 选项续行粘连下一题真题头（如 `……的新动力9.【2026国考】…`）：拆出下一题
        if (current.options.length === 4) {
          const glued = splitGluedQuestionInOption(line, expected)
          if (glued) {
            lastOption.text += glued.optionTail
            closeQuestion()
            const inputLine = inputIndexOf[lineIndex] ?? lineIndex
            current = createQuestion(glued.num, glued.rest, inputLine)
            continue
          }
        }
        // D 选项完整后紧跟独立统计表/图片/新资料段：结束本题并转为下一题的前置材料，绝不污染 D 选项
        if (current.options.length === 4 && isNewMaterialAfterOptions(line, lastOption.text)) {
          closeQuestion()
          current = null
          nextOption = null
          const inputLine = inputIndexOf[lineIndex] ?? lineIndex
          setMaterial = [line]
          materialRange = { start: inputLine, end: inputLine }
          continue
        }
        lastOption.text += line
      } else {
        current.stem += line
      }
    }
  }
  closeQuestion()
  return questions
}

// 解析册：只提取【参考答案】【题型与文段类型】【实战解析】标记块
// events 参数仅供诊断（传入数组时输出状态机轨迹），生产调用不传
export function parseSolutionBook(
  inputLines: string[],
  events?: string[]
): Map<string, ParsedSolution> {
  const { lines: tocLines, removedRows } = stripTocSetTitleRuns(inputLines)
  const inputIndexOf: number[] = []
  for (let index = 0; index < inputLines.length; index += 1)
    if (!removedRows.has(index)) inputIndexOf.push(index)
  const lines = tocLines
  const solutions = new Map<string, ParsedSolution>()
  const emit = (message: string): void => {
    if (events) events.push(message)
  }
  let setNo = 0
  let current: ParsedSolution | null = null
  let expected = 1
  let inExplanation = false
  let lastLineWasHeader = false
  let excerptLines: string[] = []
  let lineNumber = 0
  let solutionStartLine = 0
  const registerSolution = (key: string): void => {
    current!.lineStart = solutionStartLine
    solutions.set(key, current!)
  }
  for (const [lineIndex, line] of lines.entries()) {
    lineNumber += 1
    solutionStartLine = inputIndexOf[lineIndex] ?? lineIndex
    if (NOISE.test(line)) continue
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1] ?? '0')
      // 与题本同规则：连续标题串只认第一行，防目录页推高套号
      if (header > setNo && !lastLineWasHeader) {
        emit(`SET ${setNo}->${header} @${lineNumber}`)
        setNo = header
        expected = 1
        current = null
      } else {
        emit(`SET-IGNORE ${header} @${lineNumber} (cur=${setNo})`)
      }
      lastLineWasHeader = true
      continue
    }
    lastLineWasHeader = false
    const match = matchQuestionNo(line)
    if (match) {
      const num = match.num
      emit(`Q num=${num} exp=${expected} @${lineNumber}`)
      const rest = match.rest
      const origin = rest.match(ORIGIN_MARK)
      const originData = origin
        ? {
            year: Number(origin[1] ?? '0'),
            region: origin[2] ?? '',
            rate: Number(origin[3] ?? '0')
          }
        : undefined
      // 保留题号同行的重印题干首行（剥离出处括号标记）：资料分析题干多为单行，
      // 丢弃首行会导致 stemExcerpt 只剩 A-D 选项，触发整书配对误拦截
      const stemHead = (origin ? rest.slice(origin[0].length) : rest).trim()
      if (current && (num === expected || (num > expected && num <= expected + 5))) {
        // 跳号容错：解析册里常有题干行被吞（如「2.2022年」被当小数），导致后续题号整体
        // 前移一位。允许 ≤5 的前进跳号按真实题号落位，否则一套之内一旦错位整批失配。
        current = {
          set: setNo,
          num,
          answer: '',
          qtype: '',
          explanation: '',
          stemExcerpt: undefined,
          origin: originData
        }
        registerSolution(`${setNo}-${num}`)
        inExplanation = false
        excerptLines = stemHead ? [stemHead] : []
        expected = num + 1
        continue
      }
      if (num === 1 && !current) {
        if (setNo === 0) setNo = 1
        current = {
          set: setNo,
          num: 1,
          answer: '',
          qtype: '',
          explanation: '',
          stemExcerpt: undefined,
          origin: originData
        }
        registerSolution(`${setNo}-1`)
        inExplanation = false
        excerptLines = stemHead ? [stemHead] : []
        expected = 2
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        setNo += 1
        current = {
          set: setNo,
          num: 1,
          answer: '',
          qtype: '',
          explanation: '',
          stemExcerpt: undefined,
          origin: originData
        }
        registerSolution(`${setNo}-1`)
        inExplanation = false
        excerptLines = stemHead ? [stemHead] : []
        expected = 2
        continue
      }
      if (current && inExplanation) {
        // 解析途中出现无序题号行：下一题块的重印题干（题号被 OCR 重排或跳号超限）——
        // 终止当前块，重印内容不并入上一题的解析
        current = null
        inExplanation = false
        excerptLines = []
        continue
      }
    }
    if (!current) continue
    const answer = line.match(ANSWER_MARK)
    const rateAnswer = line.match(ANSWER_RATE_MARK)
    if (answer || rateAnswer) {
      if (current && current.answer) {
        // 当前块已有答案却又出现答案标记：下一题块的重印区已开始而题号行被 OCR
        // 吞掉——终止当前块，下一题的题干/答案/解析不串入上一题
        current = null
        inExplanation = false
        excerptLines = []
        continue
      }
      // 【参考答案】前的重印文本冻结为配对校验依据
      current.stemExcerpt = excerptLines.join('').slice(0, 160)
      excerptLines = []
      if (answer) {
        current.answer = answer[1] ?? ''
        inExplanation = false
        continue
      }
      current.answer = rateAnswer![1] ?? ''
      const ratePercent = Number(rateAnswer![2] ?? '')
      if (Number.isFinite(ratePercent) && ratePercent > 0)
        current.answerRate = Math.min(1, Math.max(0, ratePercent / 100))
      inExplanation = false
      continue
    }
    const meta = line.match(META_MARK)
    if (meta) {
      current.qtype = (meta[1] ?? '').trim()
      inExplanation = false
      continue
    }
    if (EXPLAIN_MARK.test(line)) {
      inExplanation = true
      continue
    }
    if (inExplanation)
      current.explanation += (current.explanation ? '\n' : '') + quarantineNumberStreamLine(line)
    else excerptLines.push(line)
  }
  // 解析清洗阶段：水印剥离/圆圈数字分类/段落重建/可读性检查（纯函数，可独立测试）
  for (const solution of solutions.values()) {
    if (!solution.explanation) continue
    const cleanup = cleanExplanation(solution.explanation)
    solution.explanation = cleanup.cleaned
    const warnings = [...cleanup.readabilityWarnings]
    if (cleanup.removedWatermarks.length)
      warnings.unshift(`解析已清洗 ${cleanup.removedWatermarks.length} 个水印片段`)
    if (warnings.length) solution.cleanupWarnings = warnings
  }
  return solutions
}

export interface ParsedAnswerGroupsDetail {
  /** 按「段序-题号」索引（如 "1-5" -> "A"），与 parseAnswerGroups 完全兼容 */
  bySet: Map<string, string>
  /** 按「规范化段标题-题号」索引（如 "考点刷题1-5" -> "A"），跨文件配对首选 */
  bySection: Map<string, string>
  /** 共提取的答案总条数 */
  count: number
}

// 书尾分组答案 / 独立答案册 / 随节内嵌答案：
// 支持「第N篇」「考点刷题 1」「练习1 增量」「第一练：①...」等段标题；
// 支持同行多段与无冒号（四海「1-5 CADAD 6-10 BABBD」）、带冒号（花生/酷酷刷「1-5:BBDBC」）、
// 随节内嵌（「答案：1-5：ABADD 6-7：CA」）及单题答案（「6：B」）。
// OCR/印刷偶发起止号印重（如「11-15 ... 15-20 ...」），以每段上一组的结束号 +1 自动修正起始号。
export function parseAnswerGroupsDetailed(lines: string[]): ParsedAnswerGroupsDetail {
  const bySet = new Map<string, string>()
  const bySection = new Map<string, string>()
  let chapter = 0
  let sectionTitle: string | undefined
  let inAnswerSection = false
  let inlineSectionOpen = false
  let lastEnd = 0

  const recordRange = (startRaw: number, printedEnd: number, lettersRaw: string): void => {
    if (chapter === 0) chapter = 1
    let start = startRaw
    const letters = lettersRaw.toUpperCase()
    if (start <= lastEnd && lastEnd > 0) start = lastEnd + 1
    const count = Math.min(letters.length, Math.max(1, printedEnd - start + 1))
    for (let offset = 0; offset < count; offset += 1) {
      const ans = letters[offset] ?? ''
      if (!ans) continue
      const num = start + offset
      bySet.set(`${chapter}-${num}`, ans)
      if (sectionTitle) bySection.set(`${sectionTitle}-${num}`, ans)
    }
    lastEnd = start + count - 1
  }

  const extractAnswersFromLine = (text: string): number => {
    let hits = 0
    for (const hit of text.matchAll(ANSWER_RANGE_GLOBAL)) {
      recordRange(Number(hit[1] ?? '0'), Number(hit[2] ?? '0'), hit[3] ?? '')
      hits += 1
    }
    // 剥离已匹配的区间片段后再扫同行残留单题答案（如「1-1：B 2：A」「1-5：ABADD 6：C」）
    const remainder = hits > 0 ? text.replace(ANSWER_RANGE_GLOBAL, ' ') : text
    for (const hit of remainder.matchAll(SINGLE_ANSWER_GLOBAL)) {
      const num = Number(hit[1] ?? '0')
      const ans = (hit[2] ?? '').toUpperCase()
      if (num <= 0 || !ans) continue
      if (chapter === 0) chapter = 1
      bySet.set(`${chapter}-${num}`, ans)
      if (sectionTitle) bySection.set(`${sectionTitle}-${num}`, ans)
      lastEnd = Math.max(lastEnd, num)
      hits += 1
    }
    return hits
  }

  const expandAnswerLine = (rawLine: string): string[] => {
    // RapidDoc 常把整页多套参考答案合并进单个 HTML <table>（如「专项刷题一：…专项刷题二：…」），
    // 按 <tr> 拆行后逐行识别段标题与区间答案，避免跨段覆盖
    if (!/<tr\b/i.test(rawLine)) return [rawLine]
    const rows = rawLine.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
    if (rows.length === 0) return [rawLine]
    return rows
      .map((row) => {
        const cells = row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []
        return (cells.length ? cells : [row])
          .map((cell) =>
            cell
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(Boolean)
          .join(' ')
      })
      .filter(Boolean)
  }

  for (const line of lines) {
    if (ANSWER_SECTION.test(line)) {
      inAnswerSection = true
      inlineSectionOpen = false
      continue
    }
    // 随节内嵌答案行（如夸夸刷「答案：1-5：ABADD 6-7：CA」）：不必等待书尾参考答案区
    if (!inAnswerSection && INLINE_ANSWER_LINE.test(line)) {
      chapter += 1
      sectionTitle = undefined
      lastEnd = 0
      inlineSectionOpen = true
      const body = line.replace(/^#{0,4}\s*(?:参考)?答案\s*[:：]\s*/, '')
      extractAnswersFromLine(body)
      continue
    }
    if (!inAnswerSection && inlineSectionOpen) {
      if (extractAnswersFromLine(line) > 0) continue
      inlineSectionOpen = false
    }
    if (!inAnswerSection) continue
    for (const subLine of expandAnswerLine(line)) {
      if (
        CHAPTER_TITLE.test(subLine) ||
        isNamedSectionTitle(subLine) ||
        ANSWER_SUBSECTION_TITLE.test(subLine)
      ) {
        chapter += 1
        sectionTitle = isNamedSectionTitle(subLine) ? normalizeSectionTitle(subLine) : undefined
        lastEnd = 0
        continue
      }
      extractAnswersFromLine(subLine)
    }
  }
  return { bySet, bySection, count: bySet.size }
}

export function parseAnswerGroups(lines: string[]): Map<string, string> {
  return parseAnswerGroupsDetailed(lines).bySet
}

// ---- 申论主观题解析：确定性切分「章节 + 训练单元」式教材，不调用模型 ----

export interface ParsedEssayUnit {
  /** 全书内被采纳单元的顺序号（1 起），配合源文件名生成稳定 id */
  seq: number
  /** 分类：所在章节标题（如 归纳概括），无章节信息时回退「申论综合」 */
  chapter: string
  title: string
  /** 提问句（含「要求：」行）；提问段无法单独辨识时以单元标题兜底拼接 */
  stem: string
  /** 资料正文 */
  material: string
  year?: number
  region?: string
  paper?: string
  /** 单元内的参考答案/要点段（现版教材通常没有） */
  explanation: string
  /** 单元起始行号（输入行数组 0-based）：来源页证据用 */
  lineStart?: number
  /** 提问段行号（材料结束后、提问句所在行区间） */
  promptLineStart?: number
}

export interface ParsedEssayBook {
  units: ParsedEssayUnit[]
  skipped: number
}

function isEssayNoiseLine(line: string): boolean {
  return NOISE.test(line) || ESSAY_LEADER_LINE.test(line) || ESSAY_PAGE_NUMBER.test(line)
}

function cleanEssayTitle(value: string): string {
  let title = value.replace(/\s+/g, ' ').trim()
  // 目录行尾巴是「点线 + 可选页码」的循环结构（如「……….38」「做法.」），循环剥离直到稳定
  let previous = ''
  while (title !== previous) {
    previous = title
    title = title
      .replace(/[.。…·•]{1,}\s*(?:\d{1,4})?\s*$/, '')
      .replace(/(?:\d{1,4}\s*)?[.。…·•]{2,}\s*$/, '')
      .replace(/\s+\d{1,4}$/, '')
      .trim()
  }
  // 书尾推广水印（OCR 混入标题行尾部）
  return title
    .replace(/公考资料免费更新.*$/i, '')
    .replace(/加微[a-z0-9_]{2,}.*$/i, '')
    .trim()
}

// 段落级设问语式：命中且长度受限的段落判定为题干段。
// 关键词组合成「动宾语式」而非单词——「质量发展若干措施》《xx问题》」这类书名/叙事
// 不会因孤立名词误命中。

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
// 全角区（CJK 标点、全角字母数字），空格同样视为断字噪声
const WIDE_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
// OCR 断字噪声清理：影印件换行/分栏常在词中间留空格（如「F银 行」「需求一提 出」「求 ：」）。
// 删除全角字符之间及全角与汉字之间的空白；中英混排的正常空格（AI 批改、rapidocr 快速）原样保留。
export function normalizeOcrText(value: string): string {
  return String(value ?? '')
    .replace(/\u3000/g, ' ')
    .replace(new RegExp(`(${WIDE_CHAR.source})[ \\t]+(?=${CJK_CHAR.source})`, 'g'), '$1')
    .replace(new RegExp(`(${CJK_CHAR.source})[ \\t]+(?=${WIDE_CHAR.source})`, 'g'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

const ESSAY_REQUIREMENT_PREFIX = /^#{0,4}\s*要求[:：]/

function startsEssayStructuralLine(line: string): boolean {
  return (
    ESSAY_MATERIAL_HEADER.test(line) ||
    ESSAY_UNIT_MARK.test(line) ||
    ESSAY_CHAPTER_MARK.test(line) ||
    ESSAY_REQUIREMENT_PREFIX.test(line) ||
    ESSAY_ANSWER_HEADER.test(line) ||
    ESSAY_ORIGIN_MARK.test(line)
  )
}

// 段落级设问语式：命中且长度受限的段落判定为题干段候选。
// 关键词覆盖动宾式与口语式；位置约束（紧邻要求的连续带）由调用方保证。
const ESSAY_QUESTION_PARAGRAPH =
  /(请你|请您|^请[根结]|根据[“"「]?给定资料|谈谈|如何理解|如何看待|怎么看|归纳|概括|概述|简要说明|分析|梳理|提出了?哪些|有哪些|什么问题|原因是什么|启示|撰写|起草|写一篇|宣讲提纲|公开信|新闻稿|短评|汇报)/

// OCR 输出是逐视觉行的：行尾没有句末标点的都是被版面折断的半句话，
// 与下一行无缝拼接；遇到结构标记（资料头/新训练/要求/答案头/出处）或句子收束才真正分段。
function joinProseParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim()) paragraphs.push(buffer.trim())
    buffer = ''
  }
  for (const raw of lines) {
    const line = normalizeOcrText(raw)
    if (!line) continue
    if (!buffer) {
      buffer = line
      continue
    }
    if (startsEssayStructuralLine(line)) {
      flush()
      buffer = line
      continue
    }
    if (endsSentence(buffer)) {
      flush()
      buffer = line
      continue
    }
    buffer += line
  }
  flush()
  return paragraphs
}

function endsSentence(line: string): boolean {
  return /[。！？；…”"』」）)]$/.test(line.trim())
}

function joinProse(lines: string[]): string {
  return joinProseParagraphs(lines).join('\n\n')
}

interface EssayUnitEntry {
  chapter: string
  title: string
  body: string[]
  /** 单元起始行（输入行数组 0-based）与最近正文行（提问段近似位置） */
  startLine: number
  promptLine: number
}

function buildEssayUnit(entry: EssayUnitEntry, seq: number): ParsedEssayUnit | undefined {
  const body = entry.body
  const lineStart = entry.startLine
  const promptLineStart = entry.promptLine
  let requirement = ''
  let requirementIndex = -1
  let originYear: number | undefined
  let originPaper: string | undefined
  let answerIndex = -1
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index] ?? ''
    const requirementMatch = line.match(ESSAY_REQUIREMENT_MARK)
    if (requirementMatch) {
      requirement = (requirementMatch[1] ?? '').replace(ESSAY_DASHED_DECORATION, '').trim()
      requirementIndex = index
    }
    const originMatch = line.match(ESSAY_ORIGIN_MARK)
    if (originMatch) {
      originYear = Number(originMatch[1])
      originPaper = cleanEssayTitle(originMatch[2] ?? '')
    }
    if (requirementIndex >= 0 && answerIndex < 0 && ESSAY_ANSWER_HEADER.test(line))
      answerIndex = index
  }
  const absoluteEnd = requirementIndex >= 0 ? requirementIndex : body.length

  // 提问段识别在「段落」粒度进行：先按折行拼段（处理 OCR 的逐视觉行输出），
  // 再用设问语式挑出题干段，其余段落归还材料。
  // 行级线索词不可靠——叙事文常含「措施」「问题」「建议」等名词（如『质量发展若干措施》』
  // 会被误判为设问句导致题干截断）。
  let materialHeaderIndex = -1
  for (let index = 0; index < absoluteEnd; index += 1) {
    if (ESSAY_MATERIAL_HEADER.test(body[index] ?? '')) {
      materialHeaderIndex = index
      break
    }
  }
  const zoneRows = body.slice(materialHeaderIndex + 1, absoluteEnd)
  const paragraphs = joinProseParagraphs(zoneRows).filter(
    // 结构残行（资料头/孤行出处/装饰配图）不参与题干与材料
    (paragraph) =>
      !STANDALONE_IMAGE_LINE.test(paragraph) &&
      !(paragraph.length <= 16 && startsEssayStructuralLine(paragraph))
  )
  const questionParas: string[] = []
  // 题干段只从「要求」上方取连续的一段带：典型版式里设问句紧邻出处行与要求，
  // 叙述性段落即使含弱动词也隔在其上，不应倒灌进题干。
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    let paragraph = paragraphs[index]!
    if (paragraph.length > 320) {
      // 材料尾段与设问句粘连成超长段时，从最后一个「请」起头截取设问部分
      const lastRequest = paragraph.lastIndexOf('请')
      const tail = lastRequest >= 0 ? paragraph.slice(lastRequest) : ''
      if (tail.length >= 12 && tail.length <= 320 && ESSAY_QUESTION_PARAGRAPH.test(tail))
        paragraph = tail
    }
    if (paragraph.length > 400 || !ESSAY_QUESTION_PARAGRAPH.test(paragraph)) break
    questionParas.unshift(paragraph)
  }
  const questionFound = questionParas.length > 0
  if (!originYear) {
    for (let index = questionParas.length - 1; index >= 0; index -= 1) {
      const inlineMatch = questionParas[index]?.match(ESSAY_INLINE_ORIGIN)
      if (inlineMatch) {
        originYear = Number(inlineMatch[1])
        originPaper = cleanEssayTitle(inlineMatch[2] ?? '')
        break
      }
    }
  }

  const material = joinProseParagraphs(
    paragraphs.filter((paragraph) => !questionParas.includes(paragraph))
  ).join('\n\n')
  const requirementText = requirement ? `要求：${requirement}` : ''
  let stem = joinProseParagraphs(questionParas).join('\n')
  if (!questionFound || stem.replace(/\s+/g, '').length < 10)
    stem = `${entry.title}${requirement ? ` 要求：${requirement}` : ''}`
  if (questionFound && requirementText) stem = `${stem}\n${requirementText}`

  // 完整性门槛：材料是申论练习的必要条件——没有材料的题目（纯目录残片、题干兜底单元）一律跳过。
  // 仅凭长标题放行会让目录幽灵以「标题=题干、零材料」形态污染审核列表。
  if (material.replace(/\s+/g, '').length < 40) return undefined

  const originRegion = extractRegionFromText(originPaper, entry.title, entry.chapter)

  return {
    seq,
    chapter: entry.chapter || classifyShenlunType('', stem),
    title: entry.title,
    stem,
    material,
    ...(originYear && Number.isFinite(originYear) ? { year: originYear } : {}),
    ...(originRegion ? { region: originRegion } : {}),
    ...(originPaper ? { paper: originPaper } : {}),
    explanation: answerIndex >= 0 ? joinProse(body.slice(answerIndex + 1)).trim() : '',
    lineStart,
    promptLineStart
  }
}

export function parseEssayBook(lines: string[]): ParsedEssayBook {
  const entries: EssayUnitEntry[] = []
  let chapter = ''
  let promptLine = 0
  for (const [lineIndex, rawLine] of lines.entries()) {
    // OCR 断字噪声在收集入口统一清洗：后续所有标记匹配、题干、材料、解析都继承干净文本
    const line = normalizeOcrText(rawLine)
    if (!line || isEssayNoiseLine(line)) continue
    promptLine = lineIndex
    const chapterMatch = line.match(ESSAY_CHAPTER_MARK)
    if (chapterMatch) {
      chapter = cleanEssayTitle(chapterMatch[1] ?? '')
      continue
    }
    const unitMatch = line.match(ESSAY_UNIT_MARK)
    if (unitMatch) {
      // 目录页会先印一遍单元标题（无正文）；同名单元取最后一次出现（带正文的那个）。
      // OCR 损坏真实单元头时按「标题互相包含」认亲，防止目录残条目以空材料存活。
      const title = cleanEssayTitle(unitMatch[1] ?? '')
      let twinIndex = entries.findIndex(
        (candidate) => candidate.chapter === chapter && candidate.title === title
      )
      if (twinIndex < 0 && title.length >= 8) {
        twinIndex = entries.findIndex(
          (candidate) =>
            candidate.chapter === chapter &&
            (title.includes(candidate.title) || candidate.title.includes(title)) &&
            Math.min(candidate.title.length, title.length) >= 6
        )
      }
      if (twinIndex >= 0) entries.splice(twinIndex, 1)
      entries.push({ chapter, title, body: [], startLine: lineIndex, promptLine })
      continue
    }
    const last = entries[entries.length - 1]
    if (last) {
      last.body.push(line)
      last.promptLine = lineIndex
    }
  }

  const units: ParsedEssayUnit[] = []
  let skipped = 0
  for (const entry of entries) {
    const unit = buildEssayUnit(entry, units.length + 1)
    if (unit) units.push(unit)
    else skipped += 1
  }
  return { units, skipped }
}

export function mergeDirectQuestions(
  questions: ParsedQuestion[],
  solutions: Map<string, ParsedSolution>,
  answerGroups: Map<string, string>,
  options: {
    subject: string
    category: string
    sourceFile: string
    tags: string[]
    /** 解析条目 → 解析册 sourceId（来源证据分别记录题本页与解析册页） */
    solutionSourceOf?: Map<string, string>
    /** 独立答案册按段标题索引的答案（如 "考点刷题1-5" -> "A"），优先于纯套号匹配 */
    sectionAnswers?: Map<string, string>
  }
): {
  items: DirectQuestion[]
  skippedNoAnswer: number
  skippedIncomplete: number
  skippedMisaligned: number
  verifiable: number
  verifiedPassed: number
  offsetAdjustedSets: number
  aborted: boolean
} {
  const items: DirectQuestion[] = []
  let skippedNoAnswer = 0
  let skippedIncomplete = 0
  let skippedMisaligned = 0
  let verifiable = 0
  const scores: number[] = []
  for (const question of questions) {
    if (!question.stem || question.stem.length < 8 || question.options.length < 2) {
      skippedIncomplete += 1
      continue
    }
    const key = `${question.set}-${question.num}`
    const solution = solutions.get(key)
    const sectionAnswer = question.sectionTitle
      ? options.sectionAnswers?.get(
          `${question.sectionTitle}-${question.sectionQuestionNum ?? question.num}`
        )
      : undefined
    const groupAnswer = sectionAnswer ?? answerGroups.get(key)
    const answerText = (solution?.answer || groupAnswer || '').toUpperCase().replace(/[^A-D]/g, '')
    if (!answerText) {
      skippedNoAnswer += 1
      continue
    }
    // 配对校验：解析册重印题干与题本题干不匹配 → 疑似套号错位，剔除该题
    if (solution?.stemExcerpt) {
      verifiable += 1
      const score = alignmentScore(question.stem, solution.stemExcerpt)
      scores.push(score)
      if (score < ALIGNMENT_THRESHOLD) {
        skippedMisaligned += 1
        continue
      }
    }
    const rate =
      solution?.origin?.rate ??
      (solution?.answerRate !== undefined ? solution.answerRate * 100 : undefined)
    const difficulty =
      rate === undefined ? 2 : rate >= 80 ? 1 : rate >= 65 ? 2 : rate >= 50 ? 3 : rate >= 35 ? 4 : 5
    const explanation =
      [solution?.qtype, solution?.explanation].filter(Boolean).join('\n\n') || '该题暂未提供解析。'
    items.push({
      id: `kb-d${createHash('sha256')
        .update(`${options.sourceFile}\n${key}`)
        .digest('hex')
        .slice(0, 19)}`,
      set: question.set,
      num: question.num,
      groupId: groupKey(options.sourceFile, question.set),
      groupOrder: question.num,
      subject: options.subject,
      category: options.category,
      tags: [...new Set([...options.tags, `第${question.set}套`])],
      sourceFile: options.sourceFile,
      year: solution?.origin?.year,
      region: solution?.origin?.region || undefined,
      questionType: answerText.length > 1 ? 'multiple' : 'single',
      difficulty,
      stem: question.stem,
      options: question.options,
      material: question.material,
      cleanupWarnings: solution?.cleanupWarnings,
      lineStart: question.lineStart,
      materialLineRange: question.materialLineRange,
      solutionLineStart: solution?.lineStart,
      solutionSourceId: solution
        ? options.solutionSourceOf?.get(`${question.set}-${question.num}`)
        : undefined,
      answer: answerText.split(''),
      explanation
    })
  }
  // 整书对齐率过低 → 题本与解析册疑似套号错位，中止该书导入（防止题目配错答案整批入库）
  const aborted =
    verifiable >= ALIGNMENT_MIN_VERIFIABLE && skippedMisaligned / verifiable > ALIGNMENT_ABORT_RATE
  return {
    items,
    skippedNoAnswer,
    skippedIncomplete,
    skippedMisaligned,
    verifiable,
    verifiedPassed: verifiable - skippedMisaligned,
    offsetAdjustedSets: 0,
    aborted
  }
}

// 组题标识：同一来源同一套的小题共享 groupId（资料分析一组材料带 N 道连续小题）
function groupKey(sourceFile: string, set: number): string {
  return `kbg-${createHash('sha256').update(`${sourceFile}\n${set}`).digest('hex').slice(0, 16)}`
}

// 去重签名：题干+材料全量归一化 + 首选项前缀，跨来源按精确匹配（OCR 与网络文本的标点差异不保证命中）
export function directSignature(stem: string, material: string, firstOption: string): string {
  return `${String(stem ?? '').replace(/\s+/g, '')}|${String(material ?? '').replace(/\s+/g, '')}|${String(
    firstOption ?? ''
  )
    .replace(/\s+/g, '')
    .slice(0, 50)}`
}

// ---- 配对一致性校验：解析册重印题干 vs 题本题干的字符二元组包含度 ----

function normalizeForAlignment(value: string): string {
  return String(value ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 140)
}

export function alignmentScore(stem: string, stemExcerpt: string | undefined): number {
  if (!stemExcerpt) return 1 // 无重印可比（如书尾分组答案），不参与对齐判定
  const query = normalizeForAlignment(stem)
  const target = normalizeForAlignment(stemExcerpt)
  if (query.length < 4 || target.length < 4) return 0
  const queryGrams = new Set<string>()
  for (let index = 0; index + 1 < query.length; index += 1)
    queryGrams.add(query.slice(index, index + 2))
  let hit = 0
  for (let index = 0; index + 1 < target.length; index += 1) {
    if (queryGrams.has(target.slice(index, index + 2))) hit += 1
  }
  return hit / queryGrams.size
}

export const ALIGNMENT_THRESHOLD = 0.55
export const ALIGNMENT_ABORT_RATE = 0.4
export const ALIGNMENT_MIN_VERIFIABLE = 10

export function directQuestionMarkdown(question: DirectQuestion): string {
  const frontmatter = [
    '---',
    `id: ${yamlQuote(question.id)}`,
    `subject: ${yamlQuote(question.subject)}`,
    `category: ${yamlQuote(question.category)}`,
    `tags: ${JSON.stringify(question.tags)}`,
    `source: ${yamlQuote(`本地资料/${question.sourceFile}`)}`,
    `sourceFile: ${yamlQuote(question.sourceFile)}`,
    'confidence: 1.00',
    'reviewStatus: "pending"',
    'generatedBy: "direct-import"',
    ...(question.year ? [`year: ${question.year}`] : []),
    ...(question.region ? [`region: ${yamlQuote(question.region)}`] : []),
    ...(question.paper ? [`paper: ${yamlQuote(question.paper)}`] : []),
    'kind: "question"',
    `questionType: ${yamlQuote(question.questionType)}`,
    `difficulty: ${question.difficulty}`,
    `stem: ${yamlQuote(question.stem)}`,
    ...(question.material ? [`material: ${yamlQuote(question.material)}`] : []),
    ...(question.groupId ? [`groupId: ${yamlQuote(question.groupId)}`] : []),
    ...(question.groupOrder !== undefined ? [`groupOrder: ${question.groupOrder}`] : []),
    `options: ${JSON.stringify(question.options)}`,
    `answer: ${JSON.stringify(question.answer)}`,
    `explanation: ${yamlQuote(question.explanation)}`,
    '---'
  ]
  const body = [
    '',
    // 共享材料（含图表/表格）置顶：资料分析先看材料再看题，图表缺失一眼可见
    ...(question.material ? ['## 共享材料', '', question.material, ''] : []),
    '# 题目',
    '',
    question.stem,
    '',
    ...(question.options.length
      ? [
          '## 选项',
          '',
          ...question.options.map((option) =>
            option.image
              ? `${option.key}. ${option.text ? `${option.text} ` : ''}![选项${option.key}](${option.image})`
              : `${option.key}. ${option.text}`
          ),
          ''
        ]
      : []),
    '## 答案',
    '',
    question.answer.join('、'),
    '',
    '## 解析',
    '',
    question.explanation
  ]
  return [...frontmatter, ...body].join('\n') + '\n'
}
