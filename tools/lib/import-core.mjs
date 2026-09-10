// 题库直导工具链的共享核心：Markdown 契约、跨库去重签名、OpenExam/kaogong 字段解析。
// 纯函数为主（loadPrimaryIndex / backfillPapersTo 只读写给定路径），供 direct-import.mjs 与单元测试共用。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'

export const CATEGORIES = {
  yanyu: '言语理解与表达',
  panduan: '判断推理',
  ziliao: '资料分析',
  shuliang: '数量关系',
  changshi: '常识判断'
}

export const SUB_CATEGORIES = {
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

export function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''))
}

export function difficultyFromRate(rate) {
  if (rate >= 80) return 1
  if (rate >= 65) return 2
  if (rate >= 50) return 3
  if (rate >= 35) return 4
  return 5
}

// 知识库题目 Markdown 契约：frontmatter 由应用端 vault 解析，正文供人阅读
export function questionMarkdown(question) {
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

const ASSET_IMG =
  /<img[^>]*src=["']?openexam-asset:\/\/question-assets\/([0-9a-f]{40}\.[a-z0-9]+)["']?[^>]*>/gi

// HTML → Markdown：题图引用改写为知识库相对路径（![](assets/xxx.webp)），其余标签剥离
export function htmlToMarkdown(html, assetSink) {
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

// 官方去重签名：与应用端 question-import.directSignature 同口径
export function questionSignature(stem, options, material) {
  // 全量题干参与签名：图形推理等题型的题干是“固定模板句 + 图片”，截断会把不同题误判为重复
  const normalizedStem = String(stem ?? '').replace(/\s+/g, '')
  const normalizedMaterial = String(material ?? '').replace(/\s+/g, '')
  const firstOption = String(options?.[0]?.text ?? '')
    .replace(/\s+/g, '')
    .slice(0, 50)
  return `${normalizedStem}|${normalizedMaterial}|${firstOption}`
}

// 宽松口径：只保留 Unicode 字母/数字（含中文），去空白与全部标点。
// 注意 JS 的 \w 不含中文（[\s\W_] 会把整句汉字删光），必须用 \p{L}\p{N}。
export const stripPunct = (value) => String(value ?? '').replace(/[^\p{L}\p{N}]+/gu, '')

// 宽松签名：去掉空白与全部标点（全/半角），抓“只差标点写法”的跨源重复
export function looseSignature(stem, material, firstOption) {
  return stripPunct(stem) + stripPunct(material) + stripPunct(firstOption)
}

// 主库签名索引：官方签名(一级)、宽松签名(二级)、资料分析题干样本(三级包含匹配)。
// 级别越高口径越松，用于“主库为准、新库只补增量”的跨库去重。
export function loadPrimaryIndex(primaryDir) {
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

// 资料分析三级匹配：新题题干（去标点）是否包含主库某道资料题的题干
export function findContainedZiliao(stem, ziliaoStems) {
  const haystack = stripPunct(stem)
  for (const [needle, file] of ziliaoStems) if (needle && haystack.includes(needle)) return file
  return undefined
}

// 把新卷的真题归属并入主库原题的 papers（只追加，不改动其他内容）；返回实际新增条数
export function backfillPapersTo(filePath, memberships) {
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

// kaogong 选项 {"A": "..."} → [{key, text}]，按字母序，空文本选项丢弃
export function kaogongOptions(raw) {
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

// kaogong 三套讲解体系拼成一段解析，缺失时给统一兜底文案
export function kaogongExplanation(row) {
  const parts = [
    row.explanation && `【标准解析】\n${row.explanation}`,
    row.hs_explanation && `【花生十三讲解】\n${row.hs_explanation}`,
    row.xp_explanation && `【小P排除法】\n${row.xp_explanation}`
  ].filter(Boolean)
  return parts.join('\n\n') || '该题暂未提供解析。'
}

// 申论材料定位：快照把整套给定资料塞进每题的 material，而题干通常只引用“材料N”。
// 按题干引用抽取对应段落；引用缺失/超范围/材料头前有前言时回退全文，宁多勿缺。
export function referencedMaterialOnly(material, question) {
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

// 卷名 → 地区：「2023年上海公务员录用考试《行测》A类」→「上海」；国考不设地区
export function regionFromPaperTitle(title) {
  const match = String(title ?? '').match(/^(\d{4})年(.+?)公务员录用考试/)
  return match && match[2] !== '国家' ? match[2] : undefined
}
