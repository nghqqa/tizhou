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
}

export interface ParsedSolution {
  set: number
  num: number
  answer: string
  qtype: string
  explanation: string
  origin?: { year: number; region: string; rate: number }
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
  questionType: string
  difficulty: number
  stem: string
  options: DirectOption[]
  answer: string[]
  explanation: string
}

const SET_TITLE = /^练习题\s*0*(\d{1,3})\s*套?\s*$/
const CHAPTER_TITLE = /^第[一二三四五六七八九十百0-9]{1,4}[篇章套]/
const QUESTION_NO = /^(\d{1,3})\s*[.、．]\s*(?!\d)(.*)$/
const OPTION_NO = /^([A-D])\s*[.、．]?\s*(.+)$/
const ANSWER_MARK = /【参考答案】\s*([A-D]+)/
const META_MARK = /【题型与文段类型】\s*(.+)/
const EXPLAIN_MARK = /【实战解析】/
const ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]*?)\s+(\d{1,3})\s*%\s*[)）]/
const ANSWER_SECTION = /^参考答案$|^答案速查$/
const ANSWER_RANGE = /^(\d{1,3})\s*[-—~]\s*(\d{1,3})\s*[:：]\s*([A-Da-d]{1,30})/
const NOISE = /^(四海公考|SIHAIGONGKAO|花生十三|花生\+三|超格学员专用|公众号[：:].*)$/i

export function toLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// 题本切题：期望题号状态机；目录页连续标题只认第一行；题号行丢失时跳号续切；选项换行并入末选项
export function parseQuestionBook(lines: string[]): ParsedQuestion[] {
  const questions: ParsedQuestion[] = []
  let setNo = 0
  let current: ParsedQuestion | null = null
  let expected = 1
  let nextOption: string | null = null
  let lastLineWasHeader = false
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
        current = { set: setNo, num: 1, stem: rest, options: [] }
        expected = 2
        nextOption = 'A'
        continue
      }
      if (num === expected && current) {
        closeQuestion()
        current = { set: setNo, num, stem: rest, options: [] }
        expected = num + 1
        nextOption = 'A'
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        closeQuestion()
        setNo += 1
        current = { set: setNo, num: 1, stem: rest, options: [] }
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
    if (current && nextOption) {
      const option = line.match(OPTION_NO)
      if (option && option[1] === nextOption) {
        current.options.push({ key: option[1] ?? '', text: option[2] ?? '' })
        nextOption = nextOption === 'A' ? 'B' : nextOption === 'B' ? 'C' : nextOption === 'C' ? 'D' : null
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
export function parseSolutionBook(lines: string[]): Map<string, ParsedSolution> {
  const solutions = new Map<string, ParsedSolution>()
  let setNo = 0
  let current: ParsedSolution | null = null
  let expected = 1
  let inExplanation = false
  let lastLineWasHeader = false
  for (const line of lines) {
    if (NOISE.test(line)) continue
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1] ?? '0')
      // 与题本同规则：连续标题串只认第一行，防目录页推高套号
      if (header > setNo && !lastLineWasHeader) {
        setNo = header
        expected = 1
        current = null
      }
      lastLineWasHeader = true
      continue
    }
    lastLineWasHeader = false
    const match = line.match(QUESTION_NO)
    if (match) {
      const num = Number(match[1] ?? '0')
      const rest = match[2] ?? ''
      const origin = rest.match(ORIGIN_MARK)
      const originData = origin
        ? {
            year: Number(origin[1] ?? '0'),
            region: origin[2] ?? '',
            rate: Number(origin[3] ?? '0')
          }
        : undefined
      if (current && num === expected) {
        current = { set: setNo, num, answer: '', qtype: '', explanation: '', origin: originData }
        solutions.set(`${setNo}-${num}`, current)
        inExplanation = false
        expected = num + 1
        continue
      }
      if (num === 1 && !current) {
        if (setNo === 0) setNo = 1
        current = { set: setNo, num: 1, answer: '', qtype: '', explanation: '', origin: originData }
        solutions.set(`${setNo}-1`, current)
        inExplanation = false
        expected = 2
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        setNo += 1
        current = { set: setNo, num: 1, answer: '', qtype: '', explanation: '', origin: originData }
        solutions.set(`${setNo}-1`, current)
        inExplanation = false
        expected = 2
        continue
      }
    }
    if (!current) continue
    const answer = line.match(ANSWER_MARK)
    if (answer) {
      current.answer = answer[1] ?? ''
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

export function mergeDirectQuestions(
  questions: ParsedQuestion[],
  solutions: Map<string, ParsedSolution>,
  answerGroups: Map<string, string>,
  options: { subject: string; category: string; sourceFile: string; tags: string[] }
): { items: DirectQuestion[]; skippedNoAnswer: number; skippedIncomplete: number } {
  const items: DirectQuestion[] = []
  let skippedNoAnswer = 0
  let skippedIncomplete = 0
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
    const rate = solution?.origin?.rate
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
      answer: answerText.split(''),
      explanation
    })
  }
  return { items, skippedNoAnswer, skippedIncomplete }
}

function yamlQuote(value: string): string {
  return JSON.stringify(String(value ?? ''))
}

// 去重签名：题干+材料全量归一化 + 首选项前缀，跨来源按精确匹配（OCR 与网络文本的标点差异不保证命中）
export function directSignature(stem: string, material: string, firstOption: string): string {
  return `${String(stem ?? '').replace(/\s+/g, '')}|${String(material ?? '').replace(/\s+/g, '')}|${String(firstOption ?? '')
    .replace(/\s+/g, '')
    .slice(0, 50)}`
}

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
    'kind: "question"',
    `questionType: ${yamlQuote(question.questionType)}`,
    `difficulty: ${question.difficulty}`,
    `stem: ${yamlQuote(question.stem)}`,
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
    '## 选项',
    '',
    ...question.options.map((option) => `${option.key}. ${option.text}`),
    '',
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
