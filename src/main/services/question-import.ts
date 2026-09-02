// 直导题库解析器：把 OCR/转换后的题本与解析/答案文本确定性切分为题目，不调用模型。
// 版式假设来自实测的花生/四海/超格系题本：套标题 + 「N. 题干 + A-D 选项」+ 解析册【参考答案】标记块，
// 或书尾「第N篇 + 1-5:BBDBC」分组答案页。
import { createHash } from 'node:crypto'

export interface DirectOption {
  key: string
  text: string
}

export interface ParsedQuestion {
  set: number
  num: number
  stem: string
  options: DirectOption[]
  /** 该题所属套的共享材料（统计表/文字资料），资料分析类书籍专用 */
  material?: string
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
}

const SET_TITLE = /^#{0,4}\s*练习题\s*0*(\d{1,3})\s*套?\s*#*\s*$/
const CHAPTER_TITLE = /^第[一二三四五六七八九十百0-9]{1,4}[篇章套]/
const QUESTION_NO = /^(\d{1,3})\s*[.、．](?!\d)\s*(.*)$/
const OPTION_NO = /^([A-D])\s*[.、．]?\s*(.+)$/
const ANSWER_MARK = /【参考答案】\s*([A-D]+)/
const ANSWER_RATE_MARK = /【参考答案及正确率】\s*([A-D]+)(?:[，,]\s*(\d{1,3})\s*%)?/
// 花生十三系解析册的加长变体：【参考答案及正确率】C，89%（正确率喂难度映射）
const META_MARK = /【题型与文段类型】\s*(.+)/
const EXPLAIN_MARK = /【实战解析】/
const ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]*?)\s+(\d{1,3})\s*%\s*[)）]/
const ANSWER_SECTION = /^参考答案$|^答案速查$/
const ANSWER_RANGE = /^(\d{1,3})\s*[-—~]\s*(\d{1,3})\s*[:：]\s*([A-Da-d]{1,30})/
const NOISE = /^(四海公考|SIHAIGONGKAO|花生十三|花生\+三|超格学员专用|公众号[：:].*)$/i

// ---- 申论主观题教材（直导）：单元式「训练 + 资料 + 提问 + 要求」结构 ----
// 两种实测版式：【训练一】标题（夸夸刷系） / 训练一：标题（酷酷刷系）
const ESSAY_UNIT_MARK = /^【?训练\s*[一二三四五六七八九十百0-9]{1,4}\s*】?\s*[:：]?\s*(.+)$/
const ESSAY_CHAPTER_MARK = /^第[一二三四五六七八九十百0-9]{1,4}章\s*(.*)$/
const ESSAY_MATERIAL_HEADER = /^(?:资料|给定资料)\s*[0-9一二三四五六七八九十]{0,3}\s*[:：]?$/
const ESSAY_REQUIREMENT_MARK = /^要求[:：]\s*(.+)$/
const ESSAY_ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]{1,24}?)\s*[)）]\s*$/
const ESSAY_ANSWER_HEADER = /^(?:【)?(?:参考答案|答案要点)(?:】)?\s*[:：]?$/
// 目录页点线引导符与孤立页码（OCR 常产出「.2」「…38」「100」这类残渣行）
const ESSAY_LEADER_LINE = /^[.。…·•]{2,}\s*\d{0,4}$/
const ESSAY_PAGE_NUMBER = /^\d{1,4}$/

export function toLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
// 书首目录过滤（双通道规则）：
// 题本/解析册常在开头整页印「练习题01套…练习题30套」目录，使按序递增的套号状态机在
// 正文开始前就被推到最大套号（实测解析册 392 页全程错位，只识别出最后一套）。
// 判定：把所有套标题按相邻间距聚簇；只有当某簇的套号集合在后文【再次】成簇出现时，
// 该簇才是目录副本并删除——真实正文锚点不会原样重现。无重复证据的小夹具/普通书不受影响。
function stripTocSetTitleRuns(lines: string[]): string[] {
  const titleRows: Array<{ row: number; set: number }> = []
  lines.forEach((line, row) => {
    const match = line.match(SET_TITLE)
    if (!match) return
    titleRows.push({ row, set: Number(match[1] ?? '0') })
  })
  if (titleRows.length < 2) return lines

  // 相邻标题行间距 <= TOC_GAP 视为同一簇（簇内保留行间内容不动）
  const TOC_GAP = 3
  interface TitleCluster {
    rows: Array<{ row: number; set: number }>
  }
  const clusters: TitleCluster[] = []
  let clusterBuf: TitleCluster | undefined
  let lastRow = -10
  for (const entry of titleRows) {
    if (!clusterBuf || entry.row - lastRow > TOC_GAP) {
      clusterBuf = { rows: [entry] }
      clusters.push(clusterBuf)
    } else {
      clusterBuf.rows.push(entry)
    }
    lastRow = entry.row
  }

  // 簇 A 是目录副本当且仅当：其后存在另一簇 B，共享 ≥ 一半的套号（且至少 2 个）
  const sharedNumbers = (a: TitleCluster, b: TitleCluster): number => {
    const setsB = new Set(b.rows.map((item) => item.set))
    return a.rows.filter((item) => setsB.has(item.set)).length
  }
  const poisonedClusters = new Set<number>()
  for (let a = 0; a < clusters.length - 1; a += 1)
    for (let b = a + 1; b < clusters.length; b += 1) {
      if (
        sharedNumbers(clusters[a]!, clusters[b]!) >=
        Math.max(2, Math.floor(Math.min(clusters[a]!.rows.length, clusters[b]!.rows.length) / 2))
      ) {
        poisonedClusters.add(a)
      }
    }
  if (!poisonedClusters.size) return lines

  const removeRows = new Set<number>()
  for (const clusterIndex of poisonedClusters)
    for (const item of clusters[clusterIndex]!.rows) removeRows.add(item.row)
  return lines.filter((_, index) => !removeRows.has(index))
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

// 题本切题：期望题号状态机；目录页连续标题只认第一行；题号行丢失时跳号续切；选项换行并入末选项
export function parseQuestionBook(inputLines: string[]): ParsedQuestion[] {
  const lines = stripTocSetTitleRuns(inputLines)
  const questions: ParsedQuestion[] = []
  let setNo = 0
  let current: ParsedQuestion | null = null
  let expected = 1
  let nextOption: string | null = null
  let lastLineWasHeader = false
  // 套内共享材料：套标题之后、第一道题之前的统计表/文字资料，附着给套内每道题
  let setMaterial: string[] = []
  const closeQuestion = () => {
    if (current && current.stem) questions.push(current)
  }
  for (const line of lines) {
    if (NOISE.test(line)) continue
    if (ANSWER_SECTION.test(line)) break // 书尾分组答案区不再属于题干
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1] ?? '0')
      if (header > setNo && !lastLineWasHeader) {
        closeQuestion()
        setNo = header
        current = null
        expected = 1
        nextOption = null
        setMaterial = []
      }
      lastLineWasHeader = true
      continue
    }
    lastLineWasHeader = false
    const match = line.match(QUESTION_NO)
    if (match) {
      const num = Number(match[1] ?? '0')
      const rest = match[2] ?? ''
      if (!current && num === 1) {
        if (setNo === 0) setNo = 1
        current = {
          set: setNo,
          num: 1,
          stem: rest,
          options: [],
          material: materialText(setMaterial)
        }
        expected = 2
        nextOption = 'A'
        continue
      }
      if (num === expected && current) {
        closeQuestion()
        current = { set: setNo, num, stem: rest, options: [], material: materialText(setMaterial) }
        expected = num + 1
        nextOption = 'A'
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        closeQuestion()
        setNo += 1
        current = {
          set: setNo,
          num: 1,
          stem: rest,
          options: [],
          material: materialText(setMaterial)
        }
        expected = 2
        nextOption = 'A'
        continue
      }
      // OCR 偶尔丢失题号行：当前题结构完整时允许跳号续切，避免后续题目全部并入前一题
      if (num > expected && num <= expected + 5 && current && current.options.length >= 3) {
        closeQuestion()
        current = { set: setNo, num, stem: rest, options: [] }
        expected = num + 1
        nextOption = 'A'
        continue
      }
    }
    // 题目未开始时：非题号/选项的正文行累积为该套共享材料（统计表/文字资料）
    if (!current) {
      setMaterial.push(line)
      continue
    }
    if (current && nextOption) {
      const option = line.match(OPTION_NO)
      if (option && option[1] === nextOption) {
        current.options.push({ key: option[1] ?? '', text: option[2] ?? '' })
        nextOption =
          nextOption === 'A' ? 'B' : nextOption === 'B' ? 'C' : nextOption === 'C' ? 'D' : null
        continue
      }
    }
    if (current) {
      const lastOption = current.options[current.options.length - 1]
      if (current.options.length > 0 && lastOption) {
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
  const lines = stripTocSetTitleRuns(inputLines)
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
  for (const line of lines) {
    lineNumber += 1
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
    const match = line.match(QUESTION_NO)
    if (match) {
      const num = Number(match[1] ?? '0')
      emit(`Q num=${num} exp=${expected} @${lineNumber}`)
      const rest = match[2] ?? ''
      const origin = rest.match(ORIGIN_MARK)
      const originData = origin
        ? {
            year: Number(origin[1] ?? '0'),
            region: origin[2] ?? '',
            rate: Number(origin[3] ?? '0')
          }
        : undefined
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
        solutions.set(`${setNo}-${num}`, current)
        inExplanation = false
        excerptLines = []
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
        solutions.set(`${setNo}-1`, current)
        inExplanation = false
        excerptLines = []
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
        solutions.set(`${setNo}-1`, current)
        inExplanation = false
        excerptLines = []
        expected = 2
        continue
      }
    }
    if (!current) continue
    const answer = line.match(ANSWER_MARK)
    const rateAnswer = line.match(ANSWER_RATE_MARK)
    if (answer || (rateAnswer && !current.answer)) {
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
    if (inExplanation) current.explanation += (current.explanation ? '\n' : '') + line
    else excerptLines.push(line)
  }
  return solutions
}

// 书尾分组答案：「第N篇」+「1-5:BBDBC」。OCR 常把起止号印重（如连续两个 25-30），
// 以每组上一行的结束号 +1 修正起始号，答案字母数不足时按实际长度截取。
export function parseAnswerGroups(lines: string[]): Map<string, string> {
  const answers = new Map<string, string>()
  let chapter = 0
  let inAnswerSection = false
  let lastEnd = 0
  for (const line of lines) {
    if (ANSWER_SECTION.test(line)) {
      inAnswerSection = true
      continue
    }
    if (!inAnswerSection) continue
    if (CHAPTER_TITLE.test(line)) {
      chapter += 1
      lastEnd = 0
      continue
    }
    const range = line.match(ANSWER_RANGE)
    if (!range) continue
    let start = Number(range[1] ?? '0')
    const printedEnd = Number(range[2] ?? '0')
    const letters = (range[3] ?? '').toUpperCase()
    if (start <= lastEnd && lastEnd > 0) start = lastEnd + 1
    const count = Math.min(letters.length, Math.max(1, printedEnd - start + 1))
    for (let offset = 0; offset < count; offset += 1)
      answers.set(`${chapter}-${start + offset}`, letters[offset] ?? '')
    lastEnd = start + count - 1
  }
  return answers
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
  paper?: string
  /** 单元内的参考答案/要点段（现版教材通常没有） */
  explanation: string
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

const ESSAY_REQUIREMENT_PREFIX = /^要求[:：]/

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
  /(请你|请您|^请[根根结]|谈谈|如何理解|如何看待|怎么看|归纳|概括|分析|梳理|提出了?哪些|有哪些|什么问题|原因是什么|启示|撰写|起草|写一篇|宣讲提纲|公开信|新闻稿|短评|汇报)/

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
}

function buildEssayUnit(entry: EssayUnitEntry, seq: number): ParsedEssayUnit | undefined {
  const body = entry.body
  let requirement = ''
  let requirementIndex = -1
  let originYear: number | undefined
  let originPaper: string | undefined
  let answerIndex = -1
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index] ?? ''
    const requirementMatch = line.match(ESSAY_REQUIREMENT_MARK)
    if (requirementMatch) {
      requirement = requirementMatch[1]?.trim() ?? ''
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
    // 结构残行（资料头/孤行出处等）不参与题干与材料
    (paragraph) => !(paragraph.length <= 16 && startsEssayStructuralLine(paragraph))
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

  return {
    seq,
    chapter: entry.chapter,
    title: entry.title,
    stem,
    material,
    ...(originYear && Number.isFinite(originYear) ? { year: originYear } : {}),
    ...(originPaper ? { paper: originPaper } : {}),
    explanation: answerIndex >= 0 ? joinProse(body.slice(answerIndex + 1)).trim() : ''
  }
}

export function parseEssayBook(lines: string[]): ParsedEssayBook {
  const entries: EssayUnitEntry[] = []
  let chapter = ''
  for (const rawLine of lines) {
    // OCR 断字噪声在收集入口统一清洗：后续所有标记匹配、题干、材料、解析都继承干净文本
    const line = normalizeOcrText(rawLine)
    if (!line || isEssayNoiseLine(line)) continue
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
      entries.push({ chapter, title, body: [] })
      continue
    }
    const last = entries[entries.length - 1]
    if (last) last.body.push(line)
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
  options: { subject: string; category: string; sourceFile: string; tags: string[] }
): {
  items: DirectQuestion[]
  skippedNoAnswer: number
  skippedIncomplete: number
  skippedMisaligned: number
  verifiable: number
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
    const groupAnswer = answerGroups.get(key)
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
      answer: answerText.split(''),
      explanation
    })
  }
  // 整书对齐率过低 → 题本与解析册疑似套号错位，中止该书导入（防止题目配错答案整批入库）
  const aborted =
    verifiable >= ALIGNMENT_MIN_VERIFIABLE && skippedMisaligned / verifiable > ALIGNMENT_ABORT_RATE
  return { items, skippedNoAnswer, skippedIncomplete, skippedMisaligned, verifiable, aborted }
}

function yamlQuote(value: string): string {
  return JSON.stringify(String(value ?? ''))
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
    '# 题目',
    '',
    question.stem,
    '',
    ...(question.material ? ['## 材料', '', question.material, ''] : []),
    ...(question.options.length
      ? ['## 选项', '', ...question.options.map((option) => `${option.key}. ${option.text}`), '']
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
