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
import {
  CATEGORIES,
  SUB_CATEGORIES,
  backfillPapersTo,
  difficultyFromRate,
  findContainedZiliao,
  htmlToMarkdown,
  kaogongExplanation,
  kaogongOptions,
  loadPrimaryIndex,
  looseSignature,
  questionMarkdown,
  questionSignature,
  referencedMaterialOnly,
  regionFromPaperTitle,
  yamlQuote
} from './lib/import-core.mjs'
import {
  analyzeShenlunBatch,
  formatShenlunBatchReport,
  normalizeShenlunRawText,
  resolveMaterialIdRefs,
  runShenlunPreImportGate,
  stitchCrossPaperMaterials
} from './lib/shenlun-repair.mjs'

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

// 考公题库快照 → 知识库 md。默认只转行测真题（--all 加模考题海），附时政/申论真题/申论素材。
// 给 primaryDir 时做三级跨库去重（主库为准）；--backfill-papers 把命中题的快照真题卷归属回填主库原题。
function buildKaogong(dbPath, outDir, qimgDir, primaryDir, gateOpts = {}) {
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
        primaryFile = findContainedZiliao(row.question, primary.ziliaoStems)
        if (primaryFile) tier = '资料包含'
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

  // 先拆分行测与申论：对申论真题先运行入库前强制质量门禁，再决定是否落盘
  const pendingObjective = pending.filter((q) => q.subject !== 'shenlun')
  const pendingShenlun = pending.filter((q) => q.subject === 'shenlun')
  let acceptedShenlun = pendingShenlun
  if (pendingShenlun.length > 0) {
    const gate = runShenlunPreImportGate(pendingShenlun, {
      label: `${basename(dirname(dbPath))} 申论入库前质量分析`,
      ...gateOpts
    })
    if (gate.blocked) {
      db.close()
      exit(2)
    }
    if (!gate.allowWrite) {
      db.close()
      return
    }
    acceptedShenlun = gate.filtered
  }
  const finalPending = [...pendingObjective, ...acceptedShenlun]
  const finalShenlunCount = acceptedShenlun.length

  for (const question of finalPending)
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')

  // 申论素材 → 知识文档（非题目）
  const titleSeen = new Map()
  let materialDocs = 0
  for (const row of db
    .prepare('SELECT id, type, topic, content, source FROM shenlun_materials')
    .all()) {
    const content = String(row.content ?? '').trim()
    const materialType = String(row.type ?? '').trim()
    const minLen = materialType === '金句' ? 6 : 50
    if (content.length < minLen) {
      counters.incomplete += 1
      continue
    }
    const baseTitle = `${row.topic || row.type || '申论素材'}`
    const occurrence = (titleSeen.get(baseTitle) ?? 0) + 1
    titleSeen.set(baseTitle, occurrence)
    const title = occurrence > 1 ? `${baseTitle}（${occurrence}）` : baseTitle
    const id = `kg-sc-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const refSource = String(row.source ?? '').trim()
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
      ...(refSource ? ['', `> 出处：${refSource}`] : []),
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

  const written = finalPending.length
  console.log(
    `共写入 ${written} 题（行测真题 ${written - shizhengCount - finalShenlunCount} + 时政 ${shizhengCount} + 申论 ${finalShenlunCount}）＋ 素材文档 ${materialDocs} 篇；` +
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
    const region = regionFromPaperTitle(paperTitle)

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
          text: htmlToMarkdown(option.text ?? option.html ?? '', assetSink).trim()
        }))
        .filter((option) => option.text && /^[A-Z]$/.test(option.key))
      const contentHtml = String(row.contentHtml ?? '')
      const sourceContent =
        contentHtml.includes('openexam-asset') || !String(row.content ?? '').trim()
          ? contentHtml
          : String(row.content ?? '')
      const stem = htmlToMarkdown(sourceContent, assetSink).trim()
      const answer = String(row.answer ?? '')
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .split('')
      const explanation =
        htmlToMarkdown(row.analysis ?? '', assetSink) ||
        htmlToMarkdown(row.analysisHtml ?? '', assetSink)
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
          primaryFile = findContainedZiliao(stem, primary.ziliaoStems)
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
function buildShenlunEssay(ocrFile, bookTitle, outDir, gateOpts = {}) {
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
  const pendingQuestions = []
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
    const material = normalizeShenlunRawText(reflowChinese(body.slice(0, questionStart)))
    // 题干重排：题句合并、年份与“要求”行独立成段
    const stemLines = body.slice(questionStart)
    const stem = normalizeShenlunRawText(
      [reflowChinese(stemLines.filter((line) => !/^(要求[：:]|[（(]\d{4})/.test(line)))]
        .concat(stemLines.filter((line) => /^(要求[：:]|[（(]\d{4})/.test(line)))
        .join('\n')
        .trim()
    )
    if (material.length < 100 || stem.length < 15) {
      skipped += 1
      return
    }
    const match = block.header.match(splitMarker)
    const label = match?.[1] ?? ''
    const id = `sle-${createHash('sha256').update(`${bookTitle}#${blockIndex}`).digest('hex').slice(0, 18)}`
    pendingQuestions.push({
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
    })
  })

  const gate = runShenlunPreImportGate(pendingQuestions, {
    label: `${bookTitle} 申论入库前质量分析`,
    ...gateOpts
  })
  if (gate.blocked) exit(2)
  if (!gate.allowWrite) return

  for (const question of gate.filtered) {
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')
  }
  console.log(
    `${bookTitle} 作答题: ${blocks.length} 块 → 入库 ${gate.filtered.length} 题（质检拦截 ${gate.skippedIncomplete} 题，${skipped} 块未识别出题目）`
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

const XZ_MODULE_DIRS = [
  '01-政治理论',
  '02-常识判断',
  '03-言语理解与表达',
  '04-数量关系',
  '05-判断推理',
  '06-资料分析'
]

export function normalizeXzRegion(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (/国考|国家公务员|中央机关/.test(s)) return '国考'
  return s.replace(/(?:省|市|自治区)$/, '')
}

export function classifyXzShenlunType(chapter, stem) {
  const cat = String(chapter ?? '').trim()
  if (/大作文|作文|申发论述|文章写作/.test(cat)) return '作文题'
  if (/贯彻执行|应用文|公文/.test(cat)) return '公文题'
  if (/综合分析|综合题/.test(cat)) return '综合题'
  if (/归纳概括|提出对策|单一题|概括|对策/.test(cat)) return '单一题'
  const text = String(stem ?? '').replace(/\s+/g, '')
  if (
    /写一篇文章|写一篇.{0,4}(?:文章|论文)|策论文|自拟题目|议论文|800\s*[—–~-]\s*1\d{3}\s*字|不少于\s*(?:800|1000)\s*字/.test(
      text
    )
  )
    return '作文题'
  if (
    /倡议书|发言稿|讲话稿|演讲稿|公开信|感谢信|回信|汇报|简报|编者按|短评|新闻稿|调研报告|考察报告|情况说明|通知|通告|工作方案|导语|推介|讲解词|致辞|提纲|撰写|起草一[份篇]|拟写一[份篇]/.test(
      text
    )
  )
    return '公文题'
  if (
    /谈谈.{0,12}(?:理解|认识|看法|启示|体会|感悟)|如何理解|怎样理解|谈谈你对|评析|评价|辨析|启示/.test(
      text
    )
  )
    return '综合题'
  return '单一题'
}

/** 转换 ERRRC/xingcezhenti 仓库为题舟标准 Markdown 题库（支持合并进同一目标库并去重） */
function buildXingcezhenti(srcDir, outDir, primaryDir) {
  if (!srcDir || !outDir || !existsSync(srcDir)) {
    throw new Error(`源目录不存在：${srcDir}`)
  }
  mkdirSync(outDir, { recursive: true })
  const assetsOutDir = join(outDir, 'assets')
  mkdirSync(assetsOutDir, { recursive: true })

  const dedupBase = primaryDir || outDir
  const primary = existsSync(dedupBase) ? loadPrimaryIndex(dedupBase) : null
  const seenSig = new Set()
  const copiedAssets = new Set()
  const counters = { imported: 0, skippedDup: 0, skippedIncomplete: 0, copiedAssets: 0 }

  const rewriteText = (raw, fileDir) => {
    let text = String(raw ?? '')
    text = text.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, srcPath) => {
      const cleanSrc = srcPath.trim()
      if (/^https?:\/\//i.test(cleanSrc)) return ''
      const absImg = join(fileDir, cleanSrc)
      if (!existsSync(absImg)) return ''
      const fileName = basename(absImg)
      if (!copiedAssets.has(fileName)) {
        copyFileSync(absImg, join(assetsOutDir, fileName))
        copiedAssets.add(fileName)
        counters.copiedAssets += 1
      }
      return ` ![](assets/${fileName}) `
    })
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\u3000+/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  for (const modDir of XZ_MODULE_DIRS) {
    const fullMod = join(srcDir, modDir)
    if (!existsSync(fullMod)) continue
    const files = readdirSync(fullMod)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .sort()

    for (const fileName of files) {
      const filePath = join(fullMod, fileName)
      const fileDir = dirname(filePath)
      const parsed = matter(readFileSync(filePath, 'utf8'))
      const paper = String(parsed.data['试卷'] ?? basename(fileName, '.md')).trim()
      const region = normalizeXzRegion(parsed.data['地区'] ?? regionFromPaperTitle(paper))
      const yearNum = Number(parsed.data['年份'])
      const year = Number.isFinite(yearNum) && yearNum > 1990 ? yearNum : undefined
      const category = String(parsed.data['模块'] ?? modDir.replace(/^\d+-/, '')).trim()
      const source = `开源真题/xingcezhenti/${paper}`
      const content = parsed.content

      const parseQuestionChunk = (chunk, materialText, groupId, groupOrder, orderInPaper) => {
        const headerLine = chunk.split(/\r?\n/)[0] ?? ''
        const qidMatch = headerLine.match(/qid\s+(\d+)/)
        const qid = qidMatch
          ? qidMatch[1]
          : createHash('sha1').update(`${paper}\n${orderInPaper}`).digest('hex').slice(0, 12)

        const lines = chunk.split(/\r?\n/).slice(1)
        const optionStart = lines.findIndex((l) => /^\s*-\s+\*\*[A-H]\*\*\./.test(l))
        if (optionStart < 0) {
          counters.skippedIncomplete += 1
          return
        }
        const stem = rewriteText(lines.slice(0, optionStart).join('\n'), fileDir)
        const options = []
        let ansLineIdx = -1
        for (let i = optionStart; i < lines.length; i += 1) {
          const line = lines[i] ?? ''
          const optMatch = line.match(/^\s*-\s+\*\*([A-H])\*\*\.\s*(.+)$/)
          if (optMatch) {
            const optText = rewriteText(optMatch[2].replace(/\s*✅\s*$/, ''), fileDir)
            options.push({ key: optMatch[1], text: optText || optMatch[1] })
            continue
          }
          if (/^\*\*答案\*\*/.test(line)) {
            ansLineIdx = i
            break
          }
        }
        const ansRaw =
          ansLineIdx >= 0
            ? (lines[ansLineIdx] ?? '').replace(/^\*\*答案\*\*[：:]\s*/, '').trim()
            : ''
        const answer = /^[A-H]+$/i.test(ansRaw) ? ansRaw.toUpperCase().split('') : []
        if (!stem || options.length < 2 || answer.length === 0) {
          counters.skippedIncomplete += 1
          return
        }
        const expStart = lines.findIndex(
          (l, idx) => idx > ansLineIdx && /^\*\*官方解析\*\*/.test(l)
        )
        const explanation =
          expStart >= 0
            ? rewriteText(
                lines
                  .slice(expStart + 1)
                  .join('\n')
                  .replace(/\n---\s*$/, ''),
                fileDir
              )
            : '暂无解析。'

        const sig = questionSignature(stem, options, materialText ?? '')
        if (seenSig.has(sig)) {
          counters.skippedDup += 1
          return
        }
        if (primary) {
          if (
            primary.strict.has(sig) ||
            primary.loose.has(looseSignature(stem, materialText ?? '', options[0]?.text)) ||
            (category === '资料分析' &&
              materialText &&
              findContainedZiliao(stem, materialText, primary.ziliao))
          ) {
            counters.skippedDup += 1
            return
          }
        }
        seenSig.add(sig)

        const id = `xz-${createHash('sha1').update(`${qid}\n${sig}`).digest('hex').slice(0, 18)}`
        const question = {
          id,
          subject: 'xingce',
          category,
          tags: [region || '未标注', ...(year ? [`${year}`] : []), 'xingcezhenti'],
          source,
          sourceFile: `${modDir}/${fileName}`,
          year,
          region: region || undefined,
          paper,
          groupId,
          groupOrder,
          questionType: answer.length > 1 ? 'multiple' : 'single',
          difficulty: 3,
          material: materialText || undefined,
          stem,
          options,
          answer,
          explanation: explanation || '暂无解析。',
          papers: [{ paper, order: orderInPaper }]
        }
        writeFileSync(join(outDir, `${id}.md`), questionMarkdown(question), 'utf8')
        counters.imported += 1
      }

      if (content.includes('\n## 材料 ')) {
        const materialSections = content.split(/\r?\n## 材料 \d+[^\r\n]*/).slice(1)
        materialSections.forEach((matSection, matIdx) => {
          const parts = matSection.split(/\r?\n### 第 (\d+) 题/)
          const matText = rewriteText(parts[0] ?? '', fileDir)
          const groupId = `xz-mat-${createHash('sha1')
            .update(`${paper}\n${category}\n${matIdx}\n${matText.slice(0, 200)}`)
            .digest('hex')
            .slice(0, 12)}`
          for (let j = 1; j < parts.length; j += 2) {
            const qNum = Number(parts[j]) || (j + 1) / 2
            const chunk = parts[j + 1] ?? ''
            parseQuestionChunk(chunk, matText, groupId, (j + 1) / 2, qNum)
          }
        })
      } else {
        const qParts = content.split(/\r?\n## 第 (\d+) 题/)
        for (let j = 1; j < qParts.length; j += 2) {
          const qNum = Number(qParts[j]) || (j + 1) / 2
          const chunk = qParts[j + 1] ?? ''
          parseQuestionChunk(chunk, undefined, undefined, undefined, qNum)
        }
      }
    }
  }
  console.log(
    `[xingcezhenti] 完成：导入 ${counters.imported} 题（拷贝图片 ${counters.copiedAssets} 张），去重跳过 ${counters.skippedDup} 题，残缺跳过 ${counters.skippedIncomplete} 题`
  )
}

export function selectRelevantShenlunBlocks(blocks, stem, category, explanation) {
  if (blocks.length <= 1) return blocks
  if (category === '作文题') return blocks
  if (/(?:全部|所有|整篇|各则|上述|以上)\s*(?:给定)?(?:资料|材料)/.test(stem)) {
    return blocks
  }

  const cnNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const parseNum = (t) => {
    const s = String(t ?? '').trim()
    if (/^\d+$/.test(s)) return Number(s)
    if (s.length === 1 && cnNum[s]) return cnNum[s]
    if (s.startsWith('十') && s.length === 2 && cnNum[s[1]]) return 10 + cnNum[s[1]]
    if (s.endsWith('十') && s.length === 2 && cnNum[s[0]]) return cnNum[s[0]] * 10
    return null
  }

  // 1) 显式「给定资料N / 材料N」引用
  const wanted = new Set()
  const refRe =
    /(?:给定资料|给定材料|资料|材料)\s*([一二三四五六七八九十\d]+(?:\s*[、,，和与及\-～~—–]\s*[一二三四五六七八九十\d]+)*)/g
  for (const m of stem.matchAll(refRe)) {
    const expr = m[1]
    const rangeMatch = expr.match(
      /^([一二三四五六七八九十\d]+)\s*[-～~—–]\s*([一二三四五六七八九十\d]+)$/
    )
    if (rangeMatch) {
      const start = parseNum(rangeMatch[1])
      const end = parseNum(rangeMatch[2])
      if (start && end && end >= start && end - start <= 12) {
        for (let n = start; n <= end; n += 1) wanted.add(n)
        continue
      }
    }
    for (const part of expr.split(/[、,，和与及\s]+/)) {
      const n = parseNum(part)
      if (n) wanted.add(n)
    }
  }
  if (wanted.size > 0) {
    const matched = blocks.filter(
      (b) => wanted.has(b.idx) || (b.titleNum && wanted.has(b.titleNum))
    )
    if (matched.length > 0 && matched.length < blocks.length) return matched
  }

  // 2) 题干 + 参考解析实体词相关性打分
  const boilerplateRe =
    /请根据|根据给定|结合给定|给定材料|给定资料|材料|资料|谈谈|概括|归纳|梳理|分析|说明|阐述|指出|提出|结合|围绕|联系实际|要求|全面|准确|简明|扼要|条理清晰|有条理|层次分明|分条作答|不超过|左右|字数|篇幅|分值|假如你是|假设你是|作为一名|工作人员|撰写一|拟写一|写一篇|写一份|关于|主要内容|主要问题|对策建议|体现在哪些方面|哪些方面|如何理解/g
  const tokenize = (text) => {
    const quoted = []
    for (const m of text.matchAll(/[“「《]([^”」》]{2,18})[”」》]/g)) {
      const q = m[1].trim()
      if (q && !quoted.includes(q)) quoted.push(q)
    }
    const cleaned = text
      .replace(/[“”「」《》()（）、，。；：？！\s\d]/g, ' ')
      .replace(boilerplateRe, ' ')
    const terms = new Set()
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
  const countOcc = (hay, needle, cap) => {
    let c = 0
    let p = 0
    while (c < cap) {
      const i = hay.indexOf(needle, p)
      if (i === -1) break
      c += 1
      p = i + needle.length
    }
    return c
  }

  const stemTok = tokenize(normalizeShenlunRawText(stem))
  const expText =
    explanation && !explanation.startsWith('暂无参考答案')
      ? normalizeShenlunRawText(explanation.slice(0, 600))
      : ''
  const expTok = expText ? tokenize(expText) : { quoted: [], terms: [] }

  const scored = blocks.map((b, i) => {
    const text = normalizeShenlunRawText(b.text)
    let rawScore = 0
    for (const q of stemTok.quoted) rawScore += countOcc(text, q, 3) * 14
    for (const t of stemTok.terms) {
      const hits = countOcc(text, t, 4)
      if (hits > 0) rawScore += (t.length >= 3 ? 4 : 2.2) + (hits - 1) * 0.9
    }
    for (const q of expTok.quoted) rawScore += countOcc(text, q, 2) * 4
    for (const t of expTok.terms) {
      if (text.includes(t)) rawScore += t.length >= 3 ? 1.2 : 0.6
    }
    return { i, score: rawScore / Math.sqrt(text.length + 300) }
  })
  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score <= 0.05) return blocks

  const pickedIdx = [top.i]
  if (scored[1] && scored[1].score >= top.score * 0.58) pickedIdx.push(scored[1].i)
  if (category === '综合题' && scored[2] && scored[2].score >= top.score * 0.68) {
    pickedIdx.push(scored[2].i)
  }
  if (pickedIdx.length >= blocks.length) return blocks
  return pickedIdx.sort((a, b) => a - b).map((idx) => blocks[idx])
}

/** 转换 ERRRC/kaogong-shuati 申论真题 + materials.db 材料为题舟申论库（支持合并与跨库去重 + 入库前质量门禁） */
function buildKaogongShuatiShenlun(srcDir, outDir, primaryDir, gateOpts = {}) {
  const tikuPath = join(srcDir, 'tiku.db')
  const matPath = join(srcDir, 'materials.db')
  if (!existsSync(tikuPath) || !existsSync(matPath)) {
    throw new Error(
      `未在 ${srcDir} 找到 tiku.db 与 materials.db（如尚未合并分卷请先运行 node tools/reassemble-tiku.mjs）`
    )
  }
  mkdirSync(outDir, { recursive: true })
  const dedupBase = primaryDir || outDir
  const primary = existsSync(dedupBase) ? loadPrimaryIndex(dedupBase) : null
  const seenSig = new Set()

  const tikuDb = new DatabaseSync(tikuPath, { readOnly: true })
  const matDb = new DatabaseSync(matPath, { readOnly: true })

  // 读取并清洗全部给定材料分块，再执行联考跨卷自动拼补
  const paperNames = new Map()
  for (const pRow of tikuDb.prepare('SELECT id, name FROM papers').all()) {
    paperNames.set(pRow.id, String(pRow.name ?? '').trim())
  }

  const rawBlocks = []
  for (const row of matDb
    .prepare('SELECT paperId, idx, title, text FROM materials ORDER BY paperId, idx')
    .all()) {
    const text = normalizeShenlunRawText(String(row.text ?? ''))
      .replace(
        /\[materialid\]\d+\[\/materialid\](?:\s*[-～~—–]\s*\[materialid\]\d+\[\/materialid\])*/gi,
        ''
      )
      .trim()
    if (!text) continue
    const label = normalizeShenlunRawText(String(row.title ?? '').trim())
    const numMatch = label.match(/(\d+)/)
    rawBlocks.push({
      paperId: row.paperId,
      paperName: paperNames.get(row.paperId) || '',
      idx: Number(row.idx) || rawBlocks.length + 1,
      title: label,
      titleNum: numMatch ? Number(numMatch[1]) : null,
      text
    })
  }

  const stitched = stitchCrossPaperMaterials(rawBlocks)
  const materialsByPaper = new Map()
  for (const block of stitched.blocks) {
    const list = materialsByPaper.get(block.paperId) ?? []
    list.push({
      idx: Number(block.idx) || list.length + 1,
      titleNum: block.titleNum,
      text: block.text,
      rendered: block.title ? `### ${block.title}\n\n${block.text}` : block.text
    })
    materialsByPaper.set(block.paperId, list)
  }

  const rows = tikuDb
    .prepare(
      `SELECT q.questionId, q.paperId, q.chapter, q.content, q.answer, q.analysis,
              p.name AS paperName, p.category AS paperRegion
       FROM questions q
       JOIN papers p ON p.id = q.paperId
       WHERE p.subjectName LIKE '%申论%' OR p.subject = 'shenlun'
       ORDER BY q.paperId, q.id`
    )
    .all()

  const pendingQuestions = []
  let skippedDup = 0
  let skippedEmpty = 0

  for (const row of rows) {
    const rawContent = String(row.content ?? '')
    const cleanStem = normalizeShenlunRawText(rawContent)
      .replace(
        /\[materialid\]\d+\[\/materialid\](?:\s*[-～~—–]\s*\[materialid\]\d+\[\/materialid\])*/gi,
        ''
      )
      .trim()
    const paperName = String(row.paperName ?? '').trim()
    const category = classifyXzShenlunType(row.chapter, cleanStem)
    const rawAnalysis = normalizeShenlunRawText(String(row.analysis ?? '').trim())
    const rawAnswer = normalizeShenlunRawText(String(row.answer ?? '').trim())
    const explanation =
      rawAnalysis || rawAnswer || '暂无参考答案；可在「申论作答」页配合 AI 批改或本地规则评分练习。'
    const allMatBlocks = materialsByPaper.get(row.paperId) ?? []
    const pickedBlocks = selectRelevantShenlunBlocks(allMatBlocks, cleanStem, category, explanation)
    const stem = resolveMaterialIdRefs(rawContent, allMatBlocks, pickedBlocks, category)
    const material = pickedBlocks
      .map((b) => b.rendered)
      .join('\n\n')
      .trim()
    if (!stem || material.length < 40) {
      skippedEmpty += 1
      continue
    }

    const sig = questionSignature(stem, [], material)
    if (seenSig.has(sig) || primary?.strict.has(sig)) {
      skippedDup += 1
      continue
    }
    seenSig.add(sig)

    const rawRegion = String(row.paperRegion ?? '').trim() || regionFromPaperTitle(paperName) || ''
    const region = normalizeXzRegion(rawRegion)
    const yearMatch = paperName.match(/(20\d{2})/)
    const year = yearMatch ? Number(yearMatch[1]) : undefined

    const id = `kgst-sl-${row.questionId}`
    pendingQuestions.push({
      id,
      subject: 'shenlun',
      category,
      tags: [region || '未标注', ...(year ? [`${year}`] : []), 'kaogong-shuati'],
      source: `开源真题/kaogong-shuati/${paperName || row.paperId}`,
      sourceFile: `tiku.db#paper-${row.paperId}`,
      year,
      region: region || undefined,
      paper: paperName || undefined,
      questionType: 'essay',
      difficulty: 3,
      material,
      stem,
      options: [],
      answer: [],
      explanation
    })
  }

  tikuDb.close()
  matDb.close()

  const gate = runShenlunPreImportGate(pendingQuestions, {
    label: 'kaogong-shuati 申论入库前质量分析',
    ...gateOpts
  })
  if (gate.blocked) exit(2)
  if (!gate.allowWrite) return

  let withAnalysis = 0
  for (const question of gate.filtered) {
    if (!question.explanation.startsWith('暂无参考答案')) withAnalysis += 1
    writeFileSync(join(outDir, `${question.id}.md`), questionMarkdown(question), 'utf8')
  }

  console.log(
    `[kaogong-shuati-shenlun] 完成：导入 ${gate.filtered.length} 道申论真题（其中 ${withAnalysis} 题附带官方解析），跨卷拼补 ${stitched.stats.totalPatches} 处（覆盖 ${stitched.stats.patchedBlocks} 段 / ${stitched.stats.patchedPapers} 卷），去重跳过 ${skippedDup} 题，无材料/空题跳过 ${skippedEmpty} 题，质检拦截 ${gate.skippedIncomplete} 题`
  )
}

/** 解析申论入库门禁通用 CLI 参数，并返回剥离门禁 flag 后的位置参数 */
function parseShenlunGateFlags(rawArgs) {
  const gateOpts = {
    dryRun: false,
    force: false,
    skipIncomplete: false,
    maxIncompleteRate: 0.15,
    hasExplicitThreshold: false,
    jsonOut: ''
  }
  const positional = []
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === '--audit-only' || arg === '--dry-run') {
      gateOpts.dryRun = true
    } else if (arg === '--force') {
      gateOpts.force = true
    } else if (arg === '--skip-incomplete') {
      gateOpts.skipIncomplete = true
    } else if (arg === '--max-incomplete-rate') {
      const num = Number(rawArgs[++i])
      if (Number.isFinite(num) && num >= 0 && num <= 1) {
        gateOpts.maxIncompleteRate = num
        gateOpts.hasExplicitThreshold = true
      }
    } else if (arg === '--json') {
      gateOpts.jsonOut = rawArgs[++i] ?? ''
    } else {
      positional.push(arg)
    }
  }
  return { gateOpts, positional }
}

/** 独立申论题库目录质量体检命令（支持快速字符串预筛，4 万+ 题库数秒完成） */
function auditShenlunDir(targetDir, gateOpts = {}) {
  if (!targetDir || !existsSync(targetDir)) {
    throw new Error(`目标目录不存在：${targetDir}`)
  }
  const questions = []
  const skipDirs = new Set(['.git', 'node_modules'])
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name) || ent.name.startsWith('_cleaned-archive')) continue
        walk(join(dir, ent.name))
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const fp = join(dir, ent.name)
        const raw = readFileSync(fp, 'utf8')
        if (!/subject:\s*["']?shenlun["']?/i.test(raw)) continue
        const fm = matter(raw).data
        const kindLower = String(fm.kind ?? '').toLowerCase()
        if (
          fm.subject !== 'shenlun' ||
          kindLower === 'knowledge' ||
          kindLower === 'method' ||
          kindLower === 'pattern'
        )
          continue
        questions.push({
          id: fm.id || ent.name.replace(/\.md$/, ''),
          paper: fm.paper || fm.sourceFile || '',
          category: fm.category || '',
          stem: fm.stem || '',
          material: fm.material || '',
          explanation: fm.explanation || ''
        })
      }
    }
  }
  walk(targetDir)

  const report = analyzeShenlunBatch(questions)
  console.log(formatShenlunBatchReport(report, `申论目录质量体检：${targetDir}`))

  if (gateOpts.jsonOut) {
    const { itemResults: _omit, ...serializable } = report
    writeFileSync(gateOpts.jsonOut, JSON.stringify(serializable, null, 2), 'utf8')
    console.log(`[audit-shenlun] JSON 报告已保存：${gateOpts.jsonOut}`)
  }

  if (
    gateOpts.hasExplicitThreshold &&
    report.total > 0 &&
    report.incompleteRate > gateOpts.maxIncompleteRate
  ) {
    console.error(
      `[audit-shenlun] 门禁未通过：残缺率 ${(report.incompleteRate * 100).toFixed(1)}% 超过阈值 ${(gateOpts.maxIncompleteRate * 100).toFixed(1)}%`
    )
    exit(2)
  }
}

const command = argv[2]
if (
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('direct-import.mjs')
) {
  const { gateOpts, positional } = parseShenlunGateFlags(argv.slice(3))
  if (command === 'build' && positional[0] === 'pianduan600') {
    buildPianduan600(positional[1], positional[2])
  } else if (command === 'build' && positional[0] === 'openexam') {
    buildOpenExam(positional[1], positional[2], positional[3])
  } else if (command === 'build' && positional[0] === 'openexam-json') {
    buildOpenExamJson(positional[1], positional[2], positional[3])
  } else if (command === 'build' && positional[0] === 'kaogong') {
    buildKaogong(positional[1], positional[2], positional[3], positional[4], gateOpts)
  } else if (command === 'build' && positional[0] === 'xingcezhenti') {
    buildXingcezhenti(positional[1], positional[2], positional[3])
  } else if (command === 'build' && positional[0] === 'kaogong-shuati-shenlun') {
    buildKaogongShuatiShenlun(positional[1], positional[2], positional[3], gateOpts)
  } else if (command === 'build' && positional[0] === 'shenlun') {
    buildShenlun(positional[1], positional[2], positional[3])
  } else if (command === 'build' && positional[0] === 'shenlun-essay') {
    buildShenlunEssay(positional[1], positional[2], positional[3], gateOpts)
  } else if (command === 'audit-shenlun') {
    auditShenlunDir(positional[0], gateOpts)
  } else if (command === 'dedup') {
    dedupAgainst(positional[0], positional[1])
  } else if (command === 'verify') {
    verify(positional[0])
  } else if (command === 'debug-parse') {
    const questions = parseQuestionBook(readLines(positional[0]))
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
    if (first)
      console.log(`\n首题预览: ${first.stem.slice(0, 60)}... 选项${first.options.length}个`)
    if (last)
      console.log(
        `末题预览: (${last.set}-${last.num}) ${last.stem.slice(0, 60)}... 选项${last.options.length}个`
      )
  } else if (command === 'debug-solutions') {
    const solutions = parseSolutionBook(readLines(positional[0]))
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
      '用法: node tools/direct-import.mjs audit-shenlun <md目录> [--json <path>] [--max-incomplete-rate <0..1>] | build kaogong-shuati-shenlun <srcDir> <outDir> [主库目录] [--audit-only|--skip-incomplete|--force|--max-incomplete-rate <n>] | build shenlun-essay <ocr.md> <书名> <outDir> [--audit-only|--skip-incomplete|--force] | build kaogong <db> <outDir> <题图目录> [主库目录] [--all] [--backfill-papers] [--audit-only|--skip-incomplete|--force] | verify <outDir>'
    )
    exit(1)
  }
}
