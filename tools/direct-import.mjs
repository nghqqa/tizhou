#!/usr/bin/env node
// 题库直导工具：把 OCR 后的题本/解析文本确定性转换为知识库 Markdown，零 API 费用。
// 用法：
//   node tools/direct-import.mjs build pianduan600 <ocrDir> <outDir>
//   node tools/direct-import.mjs verify <outDir>
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { argv, exit } from 'node:process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import matter from 'gray-matter'

const SET_TITLE = /^练习题\s*0*(\d{1,3})\s*套?\s*$/
const QUESTION_NO = /^(\d{1,3})\s*[.、．]\s*(?!\d)(.*)$/
const OPTION_NO = /^([A-D])\s*[.、．]?\s*(.+)$/
const ANSWER_MARK = /【参考答案】\s*([A-D]+)/
const META_MARK = /【题型与文段类型】\s*(.+)/
const EXPLAIN_MARK = /【实战解析】/
const ORIGIN_MARK = /^[（(]\s*(\d{4})\s*年?\s*([^)）]*?)\s+(\d{1,3})\s*%\s*[)）]/
const NOISE = /^(四海公考|SIHAIGONGKAO|花生十三|花生\+三|超格学员专用|公众号[：:].*)$/i

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// 题本切题：按“期望题号”状态机推进，题号重置到 1 视为新套；选项按 A→B→C→D 顺序锁定，防题干里数字/字母开头行误判
function parseQuestionBook(lines, onSet) {
  const questions = []
  let setNo = 0
  let current = null
  let expected = 1
  let nextOption = null
  // 目录页会连续出现多行“练习题NN套”且中间没有题目，只认连续标题串的第一行，防止套号被目录推高
  let lastLineWasHeader = false
  const startSet = () => {
    setNo += 1
    if (onSet) onSet(setNo)
  }
  const closeQuestion = () => {
    if (current && current.stem) questions.push(current)
  }
  for (const line of lines) {
    if (NOISE.test(line)) continue
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1])
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
      const num = Number(match[1])
      const rest = match[2]
      if (!current && num === 1) {
        if (setNo === 0) startSet()
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
        startSet()
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
        current.options.push({ key: option[1], text: option[2] })
        nextOption =
          nextOption === 'A' ? 'B' : nextOption === 'B' ? 'C' : nextOption === 'C' ? 'D' : null
        continue
      }
    }
    if (current) {
      if (current.options.length > 0) {
        const last = current.options[current.options.length - 1]
        last.text += line
      } else {
        current.stem += line
      }
      continue
    }
    // 首个题号出现前的行（封面、目录、前言）直接丢弃
  }
  closeQuestion()
  return questions
}

// 解析篇：只取【参考答案】与【实战解析】等标记块，题号状态机与题本一致
function parseSolutionBook(lines) {
  const solutions = new Map()
  let setNo = 0
  let current = null
  let expected = 1
  let inExplanation = false
  let lastLineWasHeader = false
  const start = (set, num) => {
    current = { set, num, answer: '', qtype: '', explanation: '', origin: null }
    solutions.set(`${set}-${num}`, current)
    inExplanation = false
  }
  for (const line of lines) {
    if (NOISE.test(line)) continue
    const setTitle = line.match(SET_TITLE)
    if (setTitle) {
      const header = Number(setTitle[1])
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
      const num = Number(match[1])
      if (current && num === expected) {
        start(setNo, num)
        expected = num + 1
        const origin = match[2].match(ORIGIN_MARK)
        if (origin)
          current.origin = { year: Number(origin[1]), region: origin[2], rate: Number(origin[3]) }
        continue
      }
      if (num === 1 && !current) {
        if (setNo === 0) setNo = 1
        start(setNo, 1)
        expected = 2
        const origin = match[2].match(ORIGIN_MARK)
        if (origin)
          current.origin = { year: Number(origin[1]), region: origin[2], rate: Number(origin[3]) }
        continue
      }
      if (num === 1 && current && current.num >= 5) {
        setNo += 1
        start(setNo, 1)
        expected = 2
        const origin = match[2].match(ORIGIN_MARK)
        if (origin)
          current.origin = { year: Number(origin[1]), region: origin[2], rate: Number(origin[3]) }
        continue
      }
    }
    if (!current) continue
    const answer = line.match(ANSWER_MARK)
    if (answer) {
      current.answer = answer[1]
      inExplanation = false
      continue
    }
    const meta = line.match(META_MARK)
    if (meta) {
      current.qtype = meta[1].trim()
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

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''))
}

function difficultyFromRate(rate) {
  if (rate >= 80) return 1
  if (rate >= 65) return 2
  if (rate >= 50) return 3
  if (rate >= 35) return 4
  return 5
}

function questionMarkdown(question) {
  const frontmatter = [
    '---',
    `id: ${yamlQuote(question.id)}`,
    `subject: ${yamlQuote(question.subject)}`,
    `category: ${yamlQuote(question.category)}`,
    `tags: ${JSON.stringify(question.tags)}`,
    `source: ${yamlQuote(question.source)}`,
    `sourceFile: ${yamlQuote(question.sourceFile)}`,
    'confidence: 1.00',
    'reviewStatus: "approved"',
    'generatedBy: "direct-import"',
    ...(question.year ? [`year: ${question.year}`] : []),
    ...(question.region ? [`region: ${yamlQuote(question.region)}`] : []),
    'kind: "question"',
    `questionType: ${yamlQuote(question.questionType)}`,
    `difficulty: ${question.difficulty}`,
    ...(question.material ? [`material: ${yamlQuote(question.material)}`] : []),
    `stem: ${yamlQuote(question.stem)}`,
    `options: ${JSON.stringify(question.options)}`,
    `answer: ${JSON.stringify(question.answer)}`,
    `explanation: ${yamlQuote(question.explanation)}`,
    ...(question.papers?.length ? [`papers: ${JSON.stringify(question.papers)}`] : []),
    '---'
  ]
  const body = [
    '',
    ...(question.material ? ['# 材料', '', question.material, ''] : []),
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
    question.explanation || '该题暂未提供解析。'
  ]
  return [...frontmatter, ...body].join('\n') + '\n'
}

function buildPianduan600(ocrDir, outDir) {
  const book = parseQuestionBook([
    ...readLines(join(ocrDir, 'pianduan-tiben-shang.md')),
    ...readLines(join(ocrDir, 'pianduan-tiben-xia.md'))
  ])
  const solutions = new Map([
    ...parseSolutionBook(readLines(join(ocrDir, 'pianduan-jiexi-shang.md'))),
    ...parseSolutionBook(readLines(join(ocrDir, 'pianduan-jiexi-xia.md')))
  ])
  mkdirSync(outDir, { recursive: true })
  let written = 0
  const problems = []
  for (const item of book) {
    const key = `${item.set}-${item.num}`
    const solution = solutions.get(key)
    if (!item.stem || item.stem.length < 8) {
      problems.push(`${key} 题干过短，跳过`)
      continue
    }
    if (item.options.length < 2) {
      problems.push(`${key} 选项不足(${item.options.length})，跳过`)
      continue
    }
    if (!solution || !solution.answer) {
      problems.push(`${key} 无答案，跳过`)
      continue
    }
    const question = {
      id: `pianduan600-s${String(item.set).padStart(2, '0')}q${String(item.num).padStart(2, '0')}`,
      subject: 'xingce',
      category: '言语理解与表达-片段阅读',
      tags: ['片段阅读', `第${item.set}套`],
      source: '本地资料/片段阅读600题',
      sourceFile: '片段阅读600题',
      year: solution.origin?.year,
      region: solution.origin?.region,
      questionType: solution.answer.length > 1 ? 'multiple' : 'single',
      difficulty: solution.origin ? difficultyFromRate(solution.origin.rate) : 2,
      stem: item.stem,
      options: item.options,
      answer: solution.answer.split(''),
      explanation:
        [solution.qtype, solution.explanation].filter(Boolean).join('\n\n') || '该题暂未提供解析。'
    }
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')
    written += 1
  }
  console.log(`题本切出 ${book.length} 题；解析覆盖 ${solutions.size} 题；成功写入 ${written} 题`)
  console.log(`跳过 ${problems.length} 题：`)
  for (const problem of problems) console.log(`  - ${problem}`)
}

function verify(outDir) {
  const files = readdirSync(outDir).filter((name) => name.endsWith('.md'))
  let missingAnswer = 0
  let missingExplanation = 0
  const frontmatter = (raw) => {
    const match = raw.match(/^---\n([\s\S]*?)\n---/)
    return match ? match[1] : ''
  }
  for (const name of files) {
    const raw = readFileSync(join(outDir, name), 'utf8')
    const fm = frontmatter(raw)
    if (!/"?answer"?\s*:\s*\[/.test(fm) && !/^answer:/m.test(fm)) missingAnswer += 1
    if (!/^explanation:/m.test(fm)) missingExplanation += 1
  }
  console.log(
    `共 ${files.length} 个题目文件；缺答案 ${missingAnswer}；缺解析 ${missingExplanation}`
  )
}

const CATEGORIES = {
  yanyu: '言语理解与表达',
  panduan: '判断推理',
  ziliao: '资料分析',
  shuliang: '数量关系',
  changshi: '常识判断'
}
const SUB_CATEGORIES = {
  xuanci: '选词填空',
  yueduan: '片段阅读',
  yuju: '语句表达',
  luoji: '逻辑判断',
  dingyi: '定义判断',
  leibi: '类比推理',
  tuxing: '图形推理',
  zonghe: '综合分析',
  jisuan: '计算问题',
  tuiri: '推理问题',
  wenzhang: '文章阅读',
  biaoge: '表格分析',
  zengzhang: '增长分析',
  zhengzhi: '政治常识',
  keji: '科技常识',
  renwen: '人文常识',
  falv: '法律常识',
  jingji: '经济常识',
  dili: '地理常识'
}

const ASSET_IMG =
  /<img[^>]*src=["']?openexam-asset:\/\/question-assets\/([0-9a-f]{40}\.[a-z0-9]+)["']?[^>]*>/gi

// HTML → Markdown：题图引用改写为知识库相对路径（![](assets/xxx.webp)），其余标签剥离
function htmlToMarkdown(html, assetSink) {
  let text = String(html ?? '')
  text = text.replace(ASSET_IMG, (_match, file) => {
    if (assetSink) assetSink.add(file)
    return `\n![](assets/${file})\n`
  })
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\u3000')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function questionSignature(stem, options, material) {
  // 全量题干参与签名：图形推理等题型的题干是“固定模板句 + 图片”，截断会把不同题误判为重复
  const normalizedStem = String(stem ?? '').replace(/\s+/g, '')
  const normalizedMaterial = String(material ?? '').replace(/\s+/g, '')
  const firstOption = String(options?.[0]?.text ?? '')
    .replace(/\s+/g, '')
    .slice(0, 50)
  return `${normalizedStem}|${normalizedMaterial}|${firstOption}`
}

// OpenExam 种子库(sqlite)→ 知识库 md。题图引用改写为 assets/ 相对路径并拷贝图片文件。
function buildOpenExam(dbPath, outDir, assetsSourceDir) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const papers = new Map()
  for (const row of db.prepare('SELECT id, title, year, province FROM papers').all())
    papers.set(row.id, row)
  const select = db.prepare(
    'SELECT id, paper_id, order_num, type, category, sub_category, content, content_html, material_html, options, answer, analysis, analysis_html, difficulty FROM questions'
  )
  mkdirSync(outDir, { recursive: true })
  const stats = new Map()
  const seen = new Map()
  const assetSink = new Set()
  const pending = []
  let skippedIncomplete = 0
  let skippedDuplicate = 0
  for (const row of select.all()) {
    const category = CATEGORIES[row.category]
    if (!category) continue
    const key = `${row.category}/${row.sub_category ?? '-'}`
    const entry = stats.get(key) ?? { imported: 0, skipped: 0 }
    const material = htmlToMarkdown(row.material_html, assetSink)
    // 图形推理等题型的纯文本 content 丢失题图：content_html 含图片引用时必须以它为准
    const contentHtml = String(row.content_html ?? '')
    const sourceContent =
      contentHtml.includes('openexam-asset') || !String(row.content ?? '').trim()
        ? contentHtml
        : String(row.content ?? '')
    const stem = htmlToMarkdown(sourceContent, assetSink)
    let options = []
    try {
      options = JSON.parse(row.options ?? '[]').map((option) => ({
        key: String(option.key ?? '').toUpperCase(),
        text: htmlToMarkdown(option.content ?? option.text ?? '', assetSink)
      }))
    } catch {
      options = []
    }
    const answer = String(row.answer ?? '')
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .split('')
    const explanation =
      htmlToMarkdown(row.analysis ?? '', assetSink) || htmlToMarkdown(row.analysis_html, assetSink)
    if (!stem || stem.length < 8 || options.length < 2 || answer.length === 0) {
      skippedIncomplete += 1
      entry.skipped += 1
      stats.set(key, entry)
      continue
    }
    const paper = papers.get(row.paper_id)
    // 同一题在多套真题卷复现（联考共用卷）时只保留一份，但记录全部试卷归属供原卷模考重组
    const membership = { paper: paper?.title ?? 'OpenExam', order: Number(row.order_num) || 0 }
    const signature = questionSignature(stem, options, material)
    const existing = seen.get(signature)
    if (existing) {
      existing.papers.push(membership)
      skippedDuplicate += 1
      entry.skipped += 1
      stats.set(key, entry)
      continue
    }
    const subCategory = SUB_CATEGORIES[row.sub_category] ?? ''
    const question = {
      id: `oe-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      subject: 'xingce',
      category: subCategory ? `${category}-${subCategory}` : category,
      tags: [category, subCategory, paper?.title].filter(Boolean),
      source: '本地资料/OpenExam',
      sourceFile: paper?.title ?? 'OpenExam',
      year: paper?.year,
      region: paper?.province || undefined,
      questionType: row.type === 'multiple' ? 'multiple' : 'single',
      difficulty: Math.max(1, Math.min(5, Number(row.difficulty) || 2)),
      material: material || undefined,
      stem,
      options,
      answer,
      explanation: explanation || '该题暂未提供解析。',
      papers: [membership]
    }
    seen.set(signature, question)
    pending.push(question)
    entry.imported += 1
    stats.set(key, entry)
  }
  for (const question of pending)
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')
  const written = pending.length
  // 拷贝被引用的题图到输出库 assets/ 目录
  let copiedAssets = 0
  if (assetsSourceDir && assetSink.size > 0) {
    const assetDir = join(outDir, 'assets')
    mkdirSync(assetDir, { recursive: true })
    for (const file of assetSink) {
      const source = join(assetsSourceDir, file)
      if (existsSync(source)) {
        copyFileSync(source, join(assetDir, file))
        copiedAssets += 1
      }
    }
  }
  console.log(
    `共写入 ${written} 题；字段不全 ${skippedIncomplete}；卷间重复 ${skippedDuplicate}；题图 ${copiedAssets}/${assetSink.size} 个`
  )
  for (const [key, entry] of [...stats].sort()) {
    console.log(`  ${key}: 入库 ${entry.imported} / 跳过 ${entry.skipped}`)
  }
}

// ---- kaogong 题库快照导入（kaogong-bank-YYYYMMDD/sqlite 快照 → 知识库 md）----

// 宽松口径：只保留 Unicode 字母/数字（含中文），去空白与全部标点。
// 注意 JS 的 \w 不含中文（[\s\W_] 会把整句汉字删光），必须用 \p{L}\p{N}。
const stripPunct = (value) => String(value ?? '').replace(/[^\p{L}\p{N}]+/gu, '')

// 宽松签名：去掉空白与全部标点（全/半角），抓“只差标点写法”的跨源重复
function looseSignature(stem, material, firstOption) {
  return stripPunct(stem) + stripPunct(material) + stripPunct(firstOption)
}

// 主库签名索引：官方签名(一级)、宽松签名(二级)、资料分析题干样本(三级包含匹配)。
// 级别越高口径越松，用于“主库为准、快照只补增量”的跨库去重。
function loadPrimaryIndex(primaryDir) {
  const strict = new Map()
  const loose = new Map()
  const ziliaoStems = new Map()
  for (const name of readdirSync(primaryDir).filter((item) => item.endsWith('.md'))) {
    const data = matter(readFileSync(join(primaryDir, name), 'utf8')).data
    const options = Array.isArray(data.options) ? data.options : []
    strict.set(questionSignature(data.stem, options, data.material), name)
    loose.set(looseSignature(data.stem, data.material, options[0]?.text), name)
    if (String(data.category ?? '').startsWith('资料分析')) {
      const stemKey = stripPunct(data.stem)
      if (stemKey.length >= 20) ziliaoStems.set(stemKey, name) // 过短题干是模板句，包含匹配会误杀异库题
    }
  }
  return { strict, loose, ziliaoStems }
}

// 把快照卷库的真题归属并入主库原题的 papers（只追加，不改动其他内容）
function backfillPapersTo(filePath, memberships) {
  const raw = readFileSync(filePath, 'utf8')
  const current = matter(raw).data.papers
  if (!Array.isArray(current)) return 0
  const key = (item) => `${item.paper}@${item.order}`
  const have = new Set(current.map(key))
  const additions = memberships.filter((item) => !have.has(key(item)))
  if (additions.length === 0) return 0
  const updated = raw.replace(
    /^papers: .*$/m,
    `papers: ${JSON.stringify([...current, ...additions])}`
  )
  if (updated === raw) return 0
  writeFileSync(filePath, updated, 'utf8')
  return additions.length
}

function kaogongOptions(raw) {
  try {
    const parsed = JSON.parse(raw ?? '{}')
    return Object.keys(parsed)
      .sort()
      .map((key) => ({ key: key.toUpperCase(), text: String(parsed[key] ?? '').trim() }))
      .filter((option) => option.text)
  } catch {
    return []
  }
}

function kaogongExplanation(row) {
  const parts = [
    row.explanation && `【标准解析】\n${row.explanation}`,
    row.hs_explanation && `【花生十三讲解】\n${row.hs_explanation}`,
    row.xp_explanation && `【小P排除法】\n${row.xp_explanation}`
  ].filter(Boolean)
  return parts.join('\n\n') || '该题暂未提供解析。'
}

// 申论材料定位：快照把整套给定资料塞进每题的 material，而题干通常只引用“材料N”。
// 按题干引用抽取对应段落；引用缺失/超范围/材料头前有前言时回退全文，宁多勿缺。
function referencedMaterialOnly(material, question) {
  const headerPattern = /^材料(\d+)\s*$/gm
  const headers = [...material.matchAll(headerPattern)]
  if (headers.length === 0 || !material.startsWith('材料')) return material
  const refs = new Set()
  for (const match of question.matchAll(/(?:给定)?资料(\d+)|材料(\d+)/g)) {
    const num = Number(match[1] || match[2])
    if (Number.isFinite(num)) refs.add(num)
  }
  if (refs.size === 0) return material
  const numbers = headers.map((header) => Number(header[1]))
  for (const ref of refs) if (!numbers.includes(ref)) return material
  const segments = material.split(/^材料(\d+)\s*$/gm)
  const blocks = new Map()
  for (let i = 1; i < segments.length; i += 2)
    blocks.set(Number(segments[i]), (segments[i + 1] ?? '').trim())
  return [...refs]
    .sort((a, b) => a - b)
    .map((ref) => `材料${ref}\n\n${blocks.get(ref)}`)
    .join('\n\n')
}

// 考公题库快照 → 知识库 md。默认只转行测真题（--all 加模考题海），附时政/申论真题/申论素材。
// 给 primaryDir 时做三级跨库去重（主库为准）；--backfill-papers 把命中题的快照真题卷归属回填主库原题。
function buildKaogong(dbPath, outDir, qimgDir, primaryDir) {
  const includeAll = argv.includes('--all')
  const backfillEnabled = argv.includes('--backfill-papers')
  const primary = primaryDir ? loadPrimaryIndex(primaryDir) : null
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const source = `本地资料/${basename(dirname(dbPath))}`

  const tag3Names = new Map()
  const taxonomyPath = join(dirname(dbPath), 'taxonomy.json')
  if (existsSync(taxonomyPath)) {
    const taxonomy = JSON.parse(readFileSync(taxonomyPath, 'utf8'))
    for (const mod of taxonomy.modules ?? [])
      for (const group of mod.groups ?? [])
        for (const topic of group.topics ?? [])
          if (topic.code) tag3Names.set(topic.code, [mod.name, group.name, topic.name].join('-'))
  }

  // 卷库：question_ids 顺序即卷面题序，只取真题卷供「真题原卷模考」重组
  const papersByQuestion = new Map()
  for (const paper of db.prepare('SELECT title, kind, question_ids FROM exam_papers').all()) {
    if (paper.kind !== 'zhenti') continue
    let ids = []
    try {
      ids = JSON.parse(paper.question_ids ?? '[]')
    } catch {
      ids = []
    }
    ids.forEach((qid, index) => {
      const list = papersByQuestion.get(String(qid)) ?? []
      list.push({ paper: paper.title, order: index + 1 })
      papersByQuestion.set(String(qid), list)
    })
  }

  mkdirSync(outDir, { recursive: true })
  const stats = new Map()
  const entry = (module) => {
    const item = stats.get(module) ?? { imported: 0, skipped: 0 }
    stats.set(module, item)
    return item
  }
  const seen = new Map()
  const assetSink = new Set()
  const backfillLedger = []
  const counters = {
    primary: 0,
    primaryStrict: 0,
    primaryLoose: 0,
    primaryZiliao: 0,
    duplicate: 0,
    incomplete: 0,
    backfilledFiles: 0,
    backfilledPapers: 0,
    noPaperReal: 0
  }
  const pending = []

  const select = db.prepare(
    `SELECT id, module, submodule, tag3, question, options, answer, explanation, hs_explanation, xp_explanation, is_real, exam_year, exam_region, source, image FROM questions${includeAll ? '' : ' WHERE is_real=1'}`
  )
  for (const row of select.all()) {
    const category = CATEGORIES[row.module]
    if (!category) {
      counters.incomplete += 1
      continue
    }
    const stat = entry(row.module)
    const options = kaogongOptions(row.options)
    let stem = String(row.question ?? '').trim()
    const image = String(row.image ?? '').trim()
    if (image) {
      const file = basename(image)
      assetSink.add(file)
      stem = `${stem}\n\n![](assets/${file})`
    }
    const answer = String(row.answer ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .split('')
    if (!stem || stem.length < 8 || options.length < 2 || answer.length === 0) {
      counters.incomplete += 1
      stat.skipped += 1
      continue
    }
    const memberships = papersByQuestion.get(String(row.id)) ?? []
    if (row.is_real === 1 && memberships.length === 0) counters.noPaperReal += 1

    if (primary) {
      const strictSig = questionSignature(stem, options, '')
      const looseSig = looseSignature(stem, '', options[0]?.text)
      let primaryFile = primary.strict.get(strictSig)
      let tier = '严格'
      if (!primaryFile) {
        primaryFile = primary.loose.get(looseSig)
        tier = '宽松'
      }
      if (!primaryFile && row.module === 'ziliao') {
        const haystack = stripPunct(row.question)
        for (const [needle, file] of primary.ziliaoStems) {
          if (haystack.includes(needle)) {
            primaryFile = file
            tier = '资料包含'
            break
          }
        }
      }
      if (primaryFile) {
        counters.primary += 1
        if (tier === '严格') counters.primaryStrict += 1
        else if (tier === '宽松') counters.primaryLoose += 1
        else counters.primaryZiliao += 1
        stat.skipped += 1
        if (backfillEnabled && memberships.length) {
          const added = backfillPapersTo(join(primaryDir, primaryFile), memberships)
          if (added > 0) {
            counters.backfilledFiles += 1
            counters.backfilledPapers += added
            backfillLedger.push({
              at: new Date().toISOString(),
              file: primaryFile,
              tier,
              sourceQuestion: `kg-${row.id}`,
              addedPapers: added,
              papers: memberships
            })
          }
        }
        continue
      }
    }

    const signature = questionSignature(stem, options, '')
    const existing = seen.get(signature)
    if (existing) {
      for (const membership of memberships)
        if (!existing.papers.some((item) => item.paper === membership.paper))
          existing.papers.push(membership)
      counters.duplicate += 1
      stat.skipped += 1
      continue
    }
    const tags = [tag3Names.get(row.tag3) ?? row.tag3 ?? '', row.submodule ?? '']
      .map((value) => String(value).trim())
      .filter(Boolean)
    const question = {
      id: `kg-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      subject: 'xingce',
      category,
      tags: [...new Set(tags)],
      source,
      sourceFile: String(row.source ?? '').trim() || 'kaogong-bank',
      year: Number(row.exam_year) || undefined,
      region: String(row.exam_region ?? '').trim() || undefined,
      questionType: answer.length > 1 ? 'multiple' : 'single',
      difficulty: 2,
      stem,
      options,
      answer,
      explanation: kaogongExplanation(row),
      papers: memberships
    }
    seen.set(signature, question)
    pending.push(question)
    stat.imported += 1
  }

  // 时政单选题：题量小，整表直转
  let shizhengCount = 0
  for (const row of db
    .prepare(
      'SELECT id, date, question, options, answer, explanation, source_note FROM shizheng_questions'
    )
    .all()) {
    const options = kaogongOptions(row.options)
    const answer = String(row.answer ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .split('')
    if (!row.question || options.length < 2 || answer.length === 0) {
      counters.incomplete += 1
      continue
    }
    const question = {
      id: `kg-sz-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      subject: 'xingce',
      category: '常识判断-时政',
      tags: ['时政', String(row.date ?? '').trim()].filter(Boolean),
      source,
      sourceFile: String(row.source_note ?? '').trim() || '时政题库',
      year: Number(String(row.date ?? '').slice(0, 4)) || undefined,
      questionType: answer.length > 1 ? 'multiple' : 'single',
      difficulty: 2,
      stem: String(row.question ?? '').trim(),
      options,
      answer,
      explanation: String(row.explanation ?? '').trim() || '该题暂未提供解析。',
      papers: []
    }
    pending.push(question)
    shizhengCount += 1
  }

  // 申论真题：材料/题干/参考要点齐全，走 essay 题型进「申论作答」
  let shenlunCount = 0
  for (const row of db
    .prepare(
      'SELECT id, exam_year, exam_region, paper, qtype, material, question, reference, notes FROM shenlun_questions'
    )
    .all()) {
    if (!row.question || !row.material) {
      counters.incomplete += 1
      continue
    }
    const explanation = [
      row.reference && `【参考要点】\n${row.reference}`,
      row.notes && `【要点说明】\n${row.notes}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const question = {
      id: `kg-sl-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      subject: 'shenlun',
      category: `申论-${row.qtype || '综合'}`,
      tags: ['申论', row.qtype, row.paper].filter(Boolean),
      source,
      sourceFile:
        String(row.paper ?? '').trim() ||
        [row.exam_year, row.exam_region].filter(Boolean).join('') ||
        '申论真题',
      year: Number(row.exam_year) || undefined,
      region: String(row.exam_region ?? '').trim() || undefined,
      questionType: 'essay',
      difficulty: 2,
      material: referencedMaterialOnly(
        String(row.material ?? '').trim(),
        String(row.question ?? '')
      ),
      stem: String(row.question ?? '').trim(),
      options: [],
      answer: [],
      explanation: explanation || '暂无参考要点；可在「申论作答」页配合 AI 批改练习。',
      papers: []
    }
    pending.push(question)
    shenlunCount += 1
  }

  for (const question of pending)
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')

  // 申论素材 → 知识文档（非题目）
  const titleSeen = new Map()
  let materialDocs = 0
  for (const row of db.prepare('SELECT id, type, topic, content FROM shenlun_materials').all()) {
    const content = String(row.content ?? '').trim()
    if (content.length < 50) {
      counters.incomplete += 1
      continue
    }
    const baseTitle = `${row.topic || row.type || '申论素材'}`
    const occurrence = (titleSeen.get(baseTitle) ?? 0) + 1
    titleSeen.set(baseTitle, occurrence)
    const title = occurrence > 1 ? `${baseTitle}（${occurrence}）` : baseTitle
    const id = `kg-sc-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const doc = [
      '---',
      `id: ${yamlQuote(id)}`,
      'subject: "shenlun"',
      'kind: "knowledge"',
      `title: ${yamlQuote(title)}`,
      `summary: ${yamlQuote(content.replace(/[#>*_`\[\]\n]/g, '').slice(0, 120))}`,
      `tags: ${JSON.stringify(['申论素材', row.type, row.topic].filter(Boolean))}`,
      `source: ${yamlQuote(source)}`,
      'reviewStatus: "approved"',
      'generatedBy: "direct-import"',
      '---',
      '',
      `# ${title}`,
      '',
      content,
      ''
    ].join('\n')
    writeFileSync(join(outDir, `${id}.md`), doc, 'utf8')
    materialDocs += 1
  }

  let copiedAssets = 0
  if (qimgDir && assetSink.size > 0) {
    const assetDir = join(outDir, 'assets')
    mkdirSync(assetDir, { recursive: true })
    for (const file of assetSink) {
      const img = join(qimgDir, file)
      if (existsSync(img)) {
        copyFileSync(img, join(assetDir, file))
        copiedAssets += 1
      }
    }
  }

  const written = pending.length
  console.log(
    `共写入 ${written} 题（行测真题 ${written - shizhengCount - shenlunCount} + 时政 ${shizhengCount} + 申论 ${shenlunCount}）＋ 素材文档 ${materialDocs} 篇；` +
      `主库重复 ${counters.primary}（严格 ${counters.primaryStrict} / 宽松 ${counters.primaryLoose} / 资料包含 ${counters.primaryZiliao}）；` +
      `卷间重复 ${counters.duplicate}；字段不全 ${counters.incomplete}；` +
      `题图 ${copiedAssets}/${assetSink.size}；无真题卷归属的真题 ${counters.noPaperReal}`
  )
  if (primary) {
    console.log(
      backfillEnabled
        ? `回填主库 papers：${counters.backfilledFiles} 个文件新增 ${counters.backfilledPapers} 条真题卷归属`
        : '未开 --backfill-papers：命中主库重复的题未回填真题卷归属'
    )
    if (backfillEnabled && backfillLedger.length) {
      const ledgerPath = join(outDir, 'papers-backfill-ledger.jsonl')
      writeFileSync(
        ledgerPath,
        backfillLedger.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf8'
      )
      console.log(`回填台账已写入 ${ledgerPath}（${backfillLedger.length} 条，可回溯可撤销）`)
    }
  }
  for (const [key, item] of [...stats].sort()) {
    console.log(`  ${key}: 入库 ${item.imported} / 跳过 ${item.skipped}`)
  }
}

// ---- OpenExam 整卷 JSON 目录导入（每卷一份 *-paper_.json，含三级去重与 papers 回填）----

// 整卷 JSON 的资料分析题不带材料文本（OpenExam 导出时材料留在 sqlite 列里）。
// 给 --material-db 指向 OpenExam 种子库时可按题 id 接回材料；否则无材料的资料题跳过。
function flagValue(name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : undefined
}

// OpenExam 整卷 JSON → 知识库 md。给主库目录时做三级跨库去重（主库为准）；
// --material-db 接 OpenExam 种子库补资料题材料，--assets-dir 提供材料图片源目录；
// --backfill-papers 把重叠题的这些新卷归属回填主库原题，让老题补进新卷的模考。
function buildOpenExamJson(jsonDir, outDir, primaryDir) {
  const backfillEnabled = argv.includes('--backfill-papers')
  const primary = primaryDir ? loadPrimaryIndex(primaryDir) : null
  const materialDbPath = flagValue('material-db')
  const assetsDir = flagValue('assets-dir')
  const materialDb = materialDbPath ? new DatabaseSync(materialDbPath, { readOnly: true }) : null
  const materialStmt = materialDb?.prepare('SELECT material_html FROM questions WHERE id = ?')
  const assetSink = new Set()
  const files = readdirSync(jsonDir).filter((name) => name.endsWith('.json'))
  if (files.length === 0) {
    console.error(`目录中没有 JSON 试卷：${jsonDir}`)
    exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const seen = new Map()
  const pending = []
  const backfillLedger = []
  const counters = {
    primary: 0,
    duplicate: 0,
    incomplete: 0,
    noMaterial: 0,
    materialJoined: 0,
    backfilledFiles: 0,
    backfilledPapers: 0
  }
  const stats = new Map()
  const entry = (module) => {
    const item = stats.get(module) ?? { imported: 0, skipped: 0 }
    stats.set(module, item)
    return item
  }

  for (const name of files) {
    let paperData
    try {
      paperData = JSON.parse(readFileSync(join(jsonDir, name), 'utf8'))
    } catch (error) {
      console.error(`跳过无法解析的卷：${name}（${error.message}）`)
      continue
    }
    const paper = paperData.paper ?? {}
    const paperTitle = String(paper.title ?? name.replace(/-paper_\.json$/, ''))
    const regionMatch = paperTitle.match(/^(\d{4})年(.+?)公务员录用考试/)
    const region = regionMatch && regionMatch[2] !== '国家' ? regionMatch[2] : undefined

    for (const row of paperData.questions ?? []) {
      const categoryKey = CATEGORIES[row.category] ? row.category : null
      if (!categoryKey) {
        counters.incomplete += 1
        continue
      }
      const stat = entry(categoryKey)
      let material
      if (categoryKey === 'ziliao') {
        const materialHtml = materialStmt
          ? materialStmt.get(String(row.id ?? ''))?.material_html
          : null
        material = materialHtml ? htmlToMarkdown(materialHtml, assetSink).trim() : ''
        if (material) counters.materialJoined += 1
        else {
          counters.noMaterial += 1
          stat.skipped += 1
          continue
        }
      }
      const options = (row.options ?? [])
        .map((option) => ({
          key: String(option.key ?? '').toUpperCase(),
          text: htmlToMarkdown(option.text ?? option.html ?? '').trim()
        }))
        .filter((option) => option.text && /^[A-Z]$/.test(option.key))
      const contentHtml = String(row.contentHtml ?? '')
      const sourceContent =
        contentHtml.includes('openexam-asset') || !String(row.content ?? '').trim()
          ? contentHtml
          : String(row.content ?? '')
      const stem = htmlToMarkdown(sourceContent).trim()
      const answer = String(row.answer ?? '')
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .split('')
      const explanation =
        htmlToMarkdown(row.analysis ?? '') || htmlToMarkdown(row.analysisHtml ?? '')
      if (!stem || stem.length < 8 || options.length < 2 || answer.length === 0) {
        counters.incomplete += 1
        stat.skipped += 1
        continue
      }
      const order = Number(row.orderNum) || 0
      const membership = { paper: paperTitle, order }

      if (primary) {
        const strictSig = questionSignature(stem, options, '')
        const looseSig = looseSignature(stem, '', options[0]?.text)
        let primaryFile = primary.strict.get(strictSig)
        if (!primaryFile) primaryFile = primary.loose.get(looseSig)
        if (!primaryFile && categoryKey === 'ziliao') {
          // JSON 资料题无独立材料列，与主库“材料拆分存”的资料题签名天然对不上，用题干包含兜底
          const haystack = stripPunct(stem)
          for (const [needle, file] of primary.ziliaoStems) {
            if (needle && haystack.includes(needle)) {
              primaryFile = file
              break
            }
          }
        }
        if (primaryFile) {
          counters.primary += 1
          stat.skipped += 1
          if (backfillEnabled) {
            const added = backfillPapersTo(join(primaryDir, primaryFile), [membership])
            if (added > 0) {
              counters.backfilledFiles += 1
              counters.backfilledPapers += added
              backfillLedger.push({
                at: new Date().toISOString(),
                file: primaryFile,
                source: 'openexam-json',
                paper: paperTitle,
                order
              })
            }
          }
          continue
        }
      }

      const signature = questionSignature(stem, options, '')
      const existing = seen.get(signature)
      if (existing) {
        if (!existing.papers.some((item) => item.paper === paperTitle))
          existing.papers.push(membership)
        counters.duplicate += 1
        stat.skipped += 1
        continue
      }
      const subCategory = SUB_CATEGORIES[row.subCategory] ?? ''
      const question = {
        id: `oej-${String(row.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '-')}`,
        subject: 'xingce',
        category: subCategory
          ? `${CATEGORIES[categoryKey]}-${subCategory}`
          : CATEGORIES[categoryKey],
        tags: [CATEGORIES[categoryKey], subCategory, paperTitle].filter(Boolean),
        source: `本地资料/${basename(jsonDir)}`,
        sourceFile: paperTitle,
        year: Number(paper.year) || Number(row.year) || undefined,
        region: region || undefined,
        questionType: answer.length > 1 ? 'multiple' : 'single',
        difficulty: Math.max(1, Math.min(5, Number(row.difficulty) || 2)),
        material: material || undefined,
        stem,
        options,
        answer,
        explanation: explanation || '该题暂未提供解析。',
        papers: [membership]
      }
      seen.set(signature, question)
      pending.push(question)
      stat.imported += 1
    }
  }

  for (const question of pending)
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')

  let copiedAssets = 0
  if (assetsDir && assetSink.size > 0) {
    const assetDir = join(outDir, 'assets')
    mkdirSync(assetDir, { recursive: true })
    for (const file of assetSink) {
      const source = join(assetsDir, file)
      if (existsSync(source)) {
        copyFileSync(source, join(assetDir, file))
        copiedAssets += 1
      }
    }
  }

  console.log(
    `共写入 ${pending.length} 题；主库重复 ${counters.primary}；卷内/联考重复 ${counters.duplicate}；` +
      `字段不全 ${counters.incomplete}；资料题接回材料 ${counters.materialJoined} / 缺材料跳过 ${counters.noMaterial}；` +
      `材料图片 ${assetsDir ? `${copiedAssets}/${assetSink.size}` : `0/${assetSink.size}（未给 --assets-dir）`}`
  )
  if (primary) {
    console.log(
      backfillEnabled
        ? `回填主库 papers：${counters.backfilledFiles} 个文件新增 ${counters.backfilledPapers} 条卷归属`
        : '未开 --backfill-papers：重叠题未回填新卷归属'
    )
    if (backfillEnabled && backfillLedger.length) {
      const ledgerPath = join(outDir, 'papers-backfill-ledger-oej.jsonl')
      writeFileSync(
        ledgerPath,
        backfillLedger.map((entryLine) => JSON.stringify(entryLine)).join('\n') + '\n',
        'utf8'
      )
      console.log(`回填台账已写入 ${ledgerPath}（${backfillLedger.length} 条）`)
    }
  }
  for (const [key, item] of [...stats].sort()) {
    console.log(`  ${key}: 入库 ${item.imported} / 跳过 ${item.skipped}`)
  }
}

// 申论训练书 → 知识文档：按【训练N】切分；无训练标记的书按“资料N”块切分
function buildShenlun(ocrFile, bookTitle, outDir) {
  const raw = readFileSync(ocrFile, 'utf8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.test(line))
  const TRAINING = /^【训练([一二三四五六七八九十百0-9]{1,4})】\s*(.*)$/
  const MATERIAL = /^资料([一二三四五六七八九十百0-9]{1,3})$/
  const splitMarker = lines.some((line) => TRAINING.test(line)) ? TRAINING : MATERIAL
  const blocks = []
  for (const line of lines) {
    if (splitMarker.test(line)) {
      blocks.push({ header: line, body: [] })
      continue
    }
    if (blocks.length > 0) blocks[blocks.length - 1].body.push(line)
  }
  mkdirSync(outDir, { recursive: true })
  let written = 0
  const titleSeen = new Map()
  blocks.forEach((block, blockIndex) => {
    const content = block.body.join('\n\n').trim()
    if (content.length < 200) return // 封面/目录/极短块不入库
    const match = block.header.match(splitMarker)
    const label = match?.[1] ?? ''
    const baseTitle = `${bookTitle}·${splitMarker === TRAINING ? '训练' : '资料'}${label}`
    // OCR 会把同一标题断成多块：重复标题加次序后缀，ID 用块序号保证唯一
    const occurrence = (titleSeen.get(baseTitle) ?? 0) + 1
    titleSeen.set(baseTitle, occurrence)
    const title = occurrence > 1 ? `${baseTitle}（${occurrence}）` : baseTitle
    const id = `sl-${createHash('sha256').update(`${bookTitle}#${blockIndex}`).digest('hex').slice(0, 19)}`
    const doc = [
      '---',
      `id: ${yamlQuote(id)}`,
      'subject: "shenlun"',
      'kind: "knowledge"',
      `title: ${yamlQuote(title)}`,
      `summary: ${yamlQuote(content.replace(/[#>*_`\[\]\n]/g, '').slice(0, 120))}`,
      `tags: ${JSON.stringify(['申论', bookTitle])}`,
      `source: ${yamlQuote(`本地资料/${bookTitle}`)}`,
      `sourceFile: ${yamlQuote(bookTitle)}`,
      'reviewStatus: "approved"',
      'generatedBy: "direct-import"',
      '---',
      '',
      `# ${title}`,
      '',
      content,
      ''
    ].join('\n')
    writeFileSync(join(outDir, `${id}.md`), doc, 'utf8')
    written += 1
  })
  console.log(`${bookTitle}: 切出 ${blocks.length} 块，写入 ${written} 篇知识文档`)
}

// 中文 OCR 行重组：原书按印刷宽度断行，逐行成段会产生大量随机换行；
// 按句末标点与结构标记（资料N/【】/序号）重新分段
function reflowChinese(lines) {
  const paragraphs = []
  let current = ''
  const STRUCTURAL =
    /^(资料|材料|【|第[一二三四五六七八九十百0-9]+|[一二三四五六七八九十]+、|\d{1,2}[.、．])/
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    const startsNew = STRUCTURAL.test(text)
    const previousClosed = /[。！？；…]”?$/.test(current)
    if (current && (startsNew || previousClosed)) {
      paragraphs.push(current)
      current = text
    } else {
      current += text
    }
  }
  if (current) paragraphs.push(current)
  return paragraphs.join('\n\n')
}

// 申论训练书 → 作答题(essay)：题干=「请/根据…+要求：…」尾段，材料=其前的给定资料。
// 题本不含参考要点，作答由申论工作台的 AI 评估承担。
function buildShenlunEssay(ocrFile, bookTitle, outDir) {
  const raw = readFileSync(ocrFile, 'utf8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.test(line) && !/^\d{1,3}$/.test(line))
  const TRAINING = /^【训练([一二三四五六七八九十百0-9]{1,4})】\s*(.*)$/
  const MATERIAL = /^资料([一二三四五六七八九十百0-9]{1,3})$/
  const QUESTION_START = /^(请|根据|结合|围绕|假设|阅读)/
  const splitMarker = lines.some((line) => TRAINING.test(line)) ? TRAINING : MATERIAL
  const blocks = []
  for (const line of lines) {
    if (splitMarker.test(line)) {
      blocks.push({ header: line, body: [] })
      continue
    }
    if (blocks.length > 0) blocks[blocks.length - 1].body.push(line)
  }
  mkdirSync(outDir, { recursive: true })
  let written = 0
  let skipped = 0
  blocks.forEach((block, blockIndex) => {
    const body = block.body
    // 定位题干起点：最后一个「要求：」行，向上找最近的提问句开头
    let requireIndex = -1
    for (let i = body.length - 1; i >= 0; i -= 1) {
      if (/^要求[：:]/.test(body[i])) {
        requireIndex = i
        break
      }
    }
    let questionStart = -1
    for (let i = requireIndex >= 0 ? requireIndex : body.length - 1; i >= 0; i -= 1) {
      if (QUESTION_START.test(body[i])) {
        questionStart = i
        break
      }
    }
    if (questionStart < 0) {
      skipped += 1
      return
    }
    const material = reflowChinese(body.slice(0, questionStart))
    // 题干重排：题句合并、年份与“要求”行独立成段
    const stemLines = body.slice(questionStart)
    const stem = [reflowChinese(stemLines.filter((line) => !/^(要求[：:]|[（(]\d{4})/.test(line)))]
      .concat(stemLines.filter((line) => /^(要求[：:]|[（(]\d{4})/.test(line)))
      .join('\n')
      .trim()
    if (material.length < 100 || stem.length < 15) {
      skipped += 1
      return
    }
    const match = block.header.match(splitMarker)
    const label = match?.[1] ?? ''
    const id = `sle-${createHash('sha256').update(`${bookTitle}#${blockIndex}`).digest('hex').slice(0, 18)}`
    const question = {
      id,
      subject: 'shenlun',
      category: `申论-${bookTitle}`,
      tags: ['申论', bookTitle],
      source: `本地资料/${bookTitle}`,
      sourceFile: bookTitle,
      questionType: 'essay',
      difficulty: 3,
      material,
      stem: `${stem}\n（${splitMarker === TRAINING ? '训练' : '资料'}${label}）`.trim(),
      options: [],
      answer: ['本题未收录参考要点，完成作答后可使用 AI 评估。'],
      explanation: '本题来自纸质题本 OCR，原书未附参考要点；建议在申论工作台作答后使用 AI 评估。'
    }
    writeFileSync(join(outDir, `${id}.md`), questionMarkdown(question), 'utf8')
    written += 1
  })
  console.log(
    `${bookTitle} 作答题: ${blocks.length} 块 → ${written} 题（${skipped} 块未识别出题目）`
  )
}

// 跨库去重：从 secondary 目录删除与 primary 重复的题目文件（保留 primary 版本）
function dedupAgainst(primaryDir, secondaryDir) {
  const signatures = new Set()
  for (const name of readdirSync(primaryDir).filter((item) => item.endsWith('.md'))) {
    const data = matter(readFileSync(join(primaryDir, name), 'utf8')).data
    signatures.add(questionSignature(data.stem, data.options, data.material))
  }
  let removed = 0
  for (const name of readdirSync(secondaryDir).filter((item) => item.endsWith('.md'))) {
    const raw = readFileSync(join(secondaryDir, name), 'utf8')
    const data = matter(raw).data
    if (signatures.has(questionSignature(data.stem, data.options, data.material))) {
      rmSync(join(secondaryDir, name))
      removed += 1
    }
  }
  console.log(`primary ${signatures.size} 题；从 secondary 删除重复 ${removed} 题`)
}

const command = argv[2]
if (command === 'build' && argv[3] === 'pianduan600') {
  buildPianduan600(argv[4], argv[5])
} else if (command === 'build' && argv[3] === 'openexam') {
  buildOpenExam(argv[4], argv[5], argv[6])
} else if (command === 'build' && argv[3] === 'openexam-json') {
  buildOpenExamJson(argv[4], argv[5], argv[6])
} else if (command === 'build' && argv[3] === 'kaogong') {
  buildKaogong(argv[4], argv[5], argv[6], argv[7])
} else if (command === 'build' && argv[3] === 'shenlun') {
  buildShenlun(argv[4], argv[5], argv[6])
} else if (command === 'build' && argv[3] === 'shenlun-essay') {
  buildShenlunEssay(argv[4], argv[5], argv[6])
} else if (command === 'dedup') {
  dedupAgainst(argv[3], argv[4])
} else if (command === 'verify') {
  verify(argv[3])
} else if (command === 'debug-parse') {
  const questions = parseQuestionBook(readLines(argv[3]))
  const bySet = new Map()
  for (const item of questions) {
    if (!bySet.has(item.set)) bySet.set(item.set, [])
    bySet.get(item.set).push(item.num)
  }
  console.log(`切出 ${questions.length} 题`)
  for (const [set, nums] of [...bySet].sort((a, b) => a[0] - b[0])) {
    const missing = Array.from({ length: Math.max(...nums) }, (_, index) => index + 1).filter(
      (num) => !nums.includes(num)
    )
    console.log(
      `  第${set}套: ${nums.length} 题${missing.length ? `，缺题号 ${missing.join(',')}` : ''}`
    )
  }
  const first = questions[0]
  const last = questions[questions.length - 1]
  if (first) console.log(`\n首题预览: ${first.stem.slice(0, 60)}... 选项${first.options.length}个`)
  if (last)
    console.log(
      `末题预览: (${last.set}-${last.num}) ${last.stem.slice(0, 60)}... 选项${last.options.length}个`
    )
} else if (command === 'debug-solutions') {
  const solutions = parseSolutionBook(readLines(argv[3]))
  const bySet = new Map()
  for (const key of solutions.keys()) {
    const set = Number(key.split('-')[0])
    bySet.set(set, (bySet.get(set) ?? 0) + 1)
  }
  console.log(`解析切出 ${solutions.size} 条`)
  for (const [set, count] of [...bySet].sort((a, b) => a[0] - b[0]))
    console.log(`  第${set}套: ${count} 条${count !== 20 ? ' ←异常' : ''}`)
} else {
  console.error(
    '用法: node tools/direct-import.mjs build pianduan600 <ocrDir> <outDir> | build openexam <db> <outDir> <题图目录> | build openexam-json <jsonDir> <outDir> [主库目录] [--material-db <seed.db>] [--assets-dir <图片目录>] [--backfill-papers] | build kaogong <db> <outDir> <题图目录> [主库目录] [--all] [--backfill-papers] | verify <outDir> | debug-parse <tiben.md> | debug-solutions <jiexi.md>'
  )
  exit(1)
}
