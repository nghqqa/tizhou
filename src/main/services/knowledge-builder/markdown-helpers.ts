import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import matter from 'gray-matter'
import type {
  AiImageInput,
  AiMessage,
  KnowledgeBuildOptions,
  SourceEvidence
} from '../../../shared/contracts'
import { FEATURE_PROMPTS, sourceEnvelope, taskDataEnvelope } from '../../../shared/prompts'
import { clamp, sha256Hex as hash, yamlQuote as yaml } from '../../utils/common'
import { buildSourceEvidence, pageKey } from '../source-evidence'
import {
  type CandidateItem,
  MAX_CHUNKS_PER_FILE,
  MAX_CHUNK_CHARACTERS,
  PROOFREAD_ROLE_ORDER,
  VLM_PROOFREAD_MAX_PAGES,
  VLM_RENDER_MAX_SIDE
} from './constants'

export function atomicWriteFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

/** best-effort 文本读取：缺失/损坏返回 undefined（页清单等 sidecar 容错） */
export function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function compact(value: string): string {
  return value.replace(/\s+/g, '').trim()
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeString(item)).filter(Boolean))]
    : []
}

function closeOpenJsonBrackets(fragment: string): string {
  // 模型输出被长度截断时，按字符串/转义状态补齐未闭合的括号，抢救已完整的条目
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of fragment) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[' || char === '{') stack.push(char)
    else if (char === ']' || char === '}') stack.pop()
  }
  let repaired = fragment
  if (inString) repaired += '"'
  for (let index = stack.length - 1; index >= 0; index -= 1)
    repaired += stack[index] === '[' ? ']' : '}'
  return repaired
}

export function jsonObject(value: string): Record<string, unknown> {
  const withoutFence = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) {
    // 个别模型会把 items 数组作为顶层输出，包一层再走统一校验
    const arrayStart = withoutFence.indexOf('[')
    const arrayEnd = withoutFence.lastIndexOf(']')
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        const parsed = JSON.parse(withoutFence.slice(arrayStart, arrayEnd + 1)) as unknown
        if (Array.isArray(parsed)) return { items: parsed }
      } catch {
        // 保持下方统一报错
      }
    }
    throw new Error('模型没有返回可解析的 JSON 对象')
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('JSON 顶层必须是对象')
    return parsed as Record<string, unknown>
  } catch (error) {
    const repaired = closeOpenJsonBrackets(withoutFence.slice(start, end + 1))
    if (repaired !== withoutFence.slice(start, end + 1)) {
      try {
        const parsedRepaired = JSON.parse(repaired) as unknown
        if (parsedRepaired && typeof parsedRepaired === 'object' && !Array.isArray(parsedRepaired))
          return parsedRepaired as Record<string, unknown>
      } catch {
        // 修复仍失败，落入统一报错
      }
    }
    throw new Error(`模型 JSON 格式无效：${error instanceof Error ? error.message : '解析失败'}`)
  }
}

export function isPdfFile(path: string): boolean {
  return /\.pdf$/i.test(path)
}

/** 收集产物可精校的来源页：材料/题本/保留页去重后按角色优先排序，解析册页不参与 */
export function collectProofreadPages(
  evidence: SourceEvidence | undefined
): Array<{ sourceId: string; pageNumber: number }> {
  if (!evidence || evidence.status === 'unavailable') return []
  const pages: Array<{ sourceId: string; pageNumber: number }> = []
  const seen = new Set<string>()
  for (const reference of [...evidence.references].sort(
    (a, b) => PROOFREAD_ROLE_ORDER[a.role] - PROOFREAD_ROLE_ORDER[b.role]
  )) {
    if (reference.role === 'solution') continue
    for (const page of [...reference.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
      const key = pageKey(reference.sourceId, page.pageNumber)
      if (seen.has(key)) continue
      seen.add(key)
      pages.push({ sourceId: reference.sourceId, pageNumber: page.pageNumber })
    }
  }
  return pages.slice(0, VLM_PROOFREAD_MAX_PAGES)
}

/** 拆分 YAML frontmatter：产物契约要求首行 --- 到闭合 ---；缺失返回 undefined */
export function splitFrontmatter(
  markdown: string
): { frontmatter: string; body: string } | undefined {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return undefined
  return {
    frontmatter: match[1] ?? '',
    body: markdown.slice(match[0].length).replace(/^\r?\n/, '')
  }
}

/** 精校/人工编辑的红线字段：任何改动一律拒绝（答案与题目身份绝不经过模型或编辑器） */
const PROTECTED_FRONTMATTER_FIELDS = [
  'id',
  'subject',
  'kind',
  'questionType',
  'answer',
  'groupId',
  'groupOrder',
  'papers',
  'source',
  'sourceFile',
  'year',
  'region',
  'paper',
  'difficulty'
] as const

function fieldUnchanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null)
}

/** options 每项的 key 与图片绑定指纹（text 可同步修订，key/image 绑定不可丢失或改变） */
function optionBindings(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    return [`${String(record.key ?? '')}\u0000${String(record.image ?? '')}`]
  })
}

/** 红线字段与选项绑定强校验：违规抛错并指明字段 */
export function assertFrontmatterIntact(
  original: Record<string, unknown>,
  revised: Record<string, unknown>
): void {
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    if (!fieldUnchanged(original[field], revised[field]))
      throw new Error(`保存失败：frontmatter 的 ${field} 必须保持不变，请在正文中修正文字内容`)
  }
  if (
    JSON.stringify(optionBindings(original.options)) !==
    JSON.stringify(optionBindings(revised.options))
  )
    throw new Error('保存失败：选项 key 与图片绑定（options[].key/image）必须保持不变')
}

function sectionBetween(body: string, startHeading: string, stop: RegExp): string | undefined {
  const header = body.indexOf(startHeading)
  if (header < 0) return undefined
  const lineEnd = body.indexOf('\n', header)
  if (lineEnd < 0) return undefined
  const rest = body.slice(lineEnd + 1)
  const matched = rest.match(stop)
  return (matched && matched.index !== undefined ? rest.slice(0, matched.index) : rest).trim()
}

function optionTextsFrom(body: string): Array<{ key: string; text: string }> {
  const section = sectionBetween(body, '## 选项', /^\s*##\s/m)
  if (section === undefined) return []
  return section.split('\n').flatMap((line) => {
    const matched = line.trim().match(/^([A-HＡ-Ｈ])[.、．:：)]\s*(.+)$/i)
    if (!matched?.[1] || matched[2] === undefined) return []
    const text = matched[2].replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()
    return [{ key: matched[1].toUpperCase(), text }]
  })
}

/** 用修订正文同步 frontmatter 可变字段（material/stem/options[].text/explanation）。
 *  区块缺失时保留原值（不误删）；options 按 key 匹配，只改 text，key/image 原样保留。 */
export function syncFrontmatterFromBody(
  data: Record<string, unknown>,
  body: string
): Record<string, unknown> {
  const synced: Record<string, unknown> = { ...data }
  const material = sectionBetween(body, '## 共享材料', /^\s*#\s/m)
  if (material) synced.material = material
  const stem = sectionBetween(body, '# 题目', /^\s*##/m)
  if (stem) synced.stem = stem
  const explanation = sectionBetween(body, '## 解析', /^\s*#\s/m)
  if (explanation) synced.explanation = explanation
  const texts = optionTextsFrom(body)
  if (texts.length > 0 && Array.isArray(synced.options)) {
    synced.options = (synced.options as Array<Record<string, unknown>>).map((option) => {
      const found = texts.find((item) => item.key === String(option.key ?? '').toUpperCase())
      return found ? { ...option, text: found.text } : option
    })
  }
  return synced
}

/** 行式 YAML 序列化：字符串走 yaml()（JSON 带引号），其余 JSON——与直导/模型提炼生成器同风格 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${typeof value === 'string' ? yaml(value) : JSON.stringify(value)}`)
  }
  lines.push('---', '', body.trimEnd())
  return `${lines.join('\n')}\n`
}

/** 修订正文重组完整 Markdown：红线字段强校验 + 图片引用保底 + material/stem/options[].text/explanation */
export function rebuildArtifactMarkdown(originalMarkdown: string, correctedBody: string): string {
  if (/^\s*---/.test(correctedBody.trimStart()))
    throw new Error('模型返回的正文包含 YAML frontmatter，已拒绝本次建议（结构只能由应用重组）')
  const original = matter(originalMarkdown)
  const originalData = original.data as Record<string, unknown>
  if (!originalData || Object.keys(originalData).length === 0)
    throw new Error('产物缺少 YAML frontmatter，无法安全重组精校结果')
  // 图片引用保底：原正文的所有 images/ 引用必须在修订正文中保留（防 VLM 删图）
  const originalImages = [
    ...new Set([...original.content.matchAll(/images\/[^\s)\]]+/g)].map((m) => m[0]))
  ]
  const missingImages = originalImages.filter((reference) => !correctedBody.includes(reference))
  if (missingImages.length > 0)
    throw new Error(`修订正文丢失了图片引用（${missingImages.join('、')}），已拒绝本次建议`)
  const synced = syncFrontmatterFromBody(originalData, correctedBody)
  return serializeFrontmatter(synced, correctedBody)
}

/** VLM 精校提示词组装：任务参数走 taskDataEnvelope，原文走 sourceEnvelope，防注入 */
export function buildVlmProofreadMessages(
  content: string,
  pages: Array<{ sourceId: string; pageNumber: number }>,
  scope: 'body' | 'material',
  images: AiImageInput[]
): AiMessage[] {
  const params = taskDataEnvelope('VLM 按页精校任务参数', {
    scope,
    pages: pages.map((page) => `${page.sourceId} 第 ${page.pageNumber} 页`),
    renderMaxSide: VLM_RENDER_MAX_SIDE,
    rules: [
      '只修正识别错误，不改变答案与结论',
      '看不清写 [模糊待人工确认]',
      '保留全部 images/ 图片引用'
    ]
  })
  const source = sourceEnvelope(
    scope === 'material' ? '原始切分 Markdown（共享材料部分）' : '原始切分 Markdown（正文）',
    content
  )
  return [
    { role: 'system', content: FEATURE_PROMPTS.vlmPageProofread },
    { role: 'user', content: `${params}\n${source}`, images }
  ]
}

/** 共享材料区块定位（directQuestionMarkdown 结构：## 共享材料 空行 材料文本 空行 # 题目） */
export function materialSectionRange(markdown: string): { start: number; end: number } | undefined {
  const header = markdown.indexOf('## 共享材料')
  if (header < 0) return undefined
  const bodyStart = markdown.indexOf('\n\n', header)
  if (bodyStart < 0) return undefined
  const nextSection = markdown.indexOf('\n# 题目', bodyStart)
  if (nextSection < 0) return undefined
  return { start: bodyStart + 2, end: nextSection }
}

/** scope=material：只替换共享材料区块，并把修正文本同步回 frontmatter.material */
export function applyCorrectedMaterial(
  originalMarkdown: string,
  correctedMaterial: string
): string {
  const parsed = splitFrontmatter(originalMarkdown)
  if (!parsed) return originalMarkdown
  const range = materialSectionRange(parsed.body)
  if (!range) return originalMarkdown
  const newBody = `${parsed.body.slice(0, range.start)}${correctedMaterial.trim()}${parsed.body.slice(range.end)}`
  const synced = syncFrontmatterFromBody(matter(originalMarkdown).data, newBody)
  return serializeFrontmatter(synced, newBody)
}

/** VLM JSON 契约校验：correctedBody 必须为非空正文，且绝不允许夹带 frontmatter */
export function validateVlmPayload(payload: Record<string, unknown>): {
  correctedBody: string
  changes: string[]
  uncertainItems: string[]
  summary: string
} {
  const correctedBody = normalizeString(payload.correctedBody)
  if (!correctedBody) throw new Error('模型返回的 correctedBody 为空，无法生成精校建议')
  if (/^\s*---/.test(correctedBody))
    throw new Error('模型返回的正文包含 YAML frontmatter，已拒绝本次建议（结构只能由应用重组）')
  return {
    correctedBody,
    changes: stringArray(payload.changes).slice(0, 30),
    uncertainItems: stringArray(payload.uncertainItems).slice(0, 30),
    summary: normalizeString(payload.summary)
  }
}

export function countEssayTrainingMarks(lines: string[]): number {
  return lines.filter((line) =>
    /^【?训练\s*[一二三四五六七八九十百0-9]{1,4}\s*】?\s*[:：]?/.test(line)
  ).length
}

export function safeTitle(value: string, fallback: string): string {
  const cleaned = value
    // 图推等题干常内嵌 Markdown 图片（如 ![](images/xxx.png)），展示标题前先剥离
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, 80)
}

export function chunkText(value: string): string[] {
  const paragraphs = value
    .replace(/\u0000/g, '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARACTERS) {
      flush()
      for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARACTERS - 300)
        chunks.push(paragraph.slice(start, start + MAX_CHUNK_CHARACTERS))
      continue
    }
    if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARACTERS) flush()
    current += `${current ? '\n\n' : ''}${paragraph}`
  }
  flush()
  return chunks.slice(0, MAX_CHUNKS_PER_FILE)
}

export function validateCandidate(
  value: unknown,
  options: KnowledgeBuildOptions,
  source: string
): CandidateItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind: CandidateItem['kind'] = record.kind === 'question' ? 'question' : 'document'
  if (options.mode === 'questions' && kind !== 'question') return undefined
  if (options.mode === 'documents' && kind !== 'document') return undefined
  const rawSubject = normalizeString(record.subject)
  const subject: CandidateItem['subject'] =
    options.subject !== 'auto'
      ? options.subject
      : rawSubject === 'xingce' || rawSubject === 'shenlun' || rawSubject === 'common'
        ? rawSubject
        : 'common'
  const evidenceExcerpt = normalizeString(record.evidenceExcerpt).slice(0, 80)
  const warnings = stringArray(record.warnings).slice(0, 8)
  if (evidenceExcerpt && !compact(source).includes(compact(evidenceExcerpt).slice(0, 20)))
    warnings.push('定位依据未能在当前片段中直接匹配，请重点人工复核')
  const confidence = clamp(Number(record.confidence) || 0.5, 0, 1)
  if (confidence < 0.75 && warnings.length === 0) warnings.push('模型置信度较低')
  const tags = stringArray(record.tags).slice(0, 12)
  const category =
    normalizeString(record.category) || (subject === 'shenlun' ? '申论综合' : '未分类')
  const yearValue = Number(record.year)
  const year =
    Number.isInteger(yearValue) && yearValue >= 1900 && yearValue <= 2200 ? yearValue : undefined
  if (kind === 'question') {
    const stem = normalizeString(record.stem)
    const answer = stringArray(record.answer).map((item) => item.toUpperCase())
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const questionOptions = rawOptions.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const option = item as Record<string, unknown>
      const key = normalizeString(option.key).toUpperCase()
      const text = normalizeString(option.text)
      return key && text ? [{ key, text }] : []
    })
    const questionTypeRaw = normalizeString(record.questionType)
    const questionType: CandidateItem['questionType'] = [
      'single',
      'multiple',
      'judge',
      'essay'
    ].includes(questionTypeRaw)
      ? (questionTypeRaw as CandidateItem['questionType'])
      : questionOptions.length
        ? answer.length > 1
          ? 'multiple'
          : 'single'
        : 'essay'
    if (stem.length < 6 || answer.length === 0) return undefined
    if (questionType !== 'essay') {
      if (questionOptions.length < 2) return undefined
      const keys = new Set(questionOptions.map((item) => item.key))
      if (answer.some((item) => !keys.has(item))) return undefined
    }
    const explanation = normalizeString(record.explanation)
    if (explanation.length < 8) warnings.push('解析较短，请在发布前补充核验过程')
    return {
      kind,
      documentKind: 'knowledge',
      subject,
      category,
      questionType,
      stem,
      options: questionOptions,
      answer,
      explanation: explanation || '当前来源未提供足够解析，请人工补充。',
      title: '',
      summary: '',
      content: '',
      tags,
      year,
      region: normalizeString(record.region) || undefined,
      paper: normalizeString(record.paper) || undefined,
      difficulty: clamp(Math.round(Number(record.difficulty) || 2), 1, 5),
      confidence,
      evidenceExcerpt,
      warnings: [...new Set(warnings)]
    }
  }
  const title = normalizeString(record.title)
  const content = normalizeString(record.content)
  if (title.length < 2 || content.length < 50) return undefined
  if (/添加.{0,6}(微信|群)|扫码|领取更多|下载地址/i.test(`${title}\n${content}`)) return undefined
  return {
    kind,
    documentKind: ['knowledge', 'method', 'pattern'].includes(normalizeString(record.documentKind))
      ? (normalizeString(record.documentKind) as CandidateItem['documentKind'])
      : 'knowledge',
    subject,
    category,
    questionType: 'essay',
    stem: '',
    options: [],
    answer: [],
    explanation: '',
    title,
    summary: normalizeString(record.summary) || content.replace(/[#>*_`]/g, '').slice(0, 140),
    content,
    tags,
    year,
    region: normalizeString(record.region) || undefined,
    paper: normalizeString(record.paper) || undefined,
    difficulty: clamp(Math.round(Number(record.difficulty) || 2), 1, 5),
    confidence,
    evidenceExcerpt,
    warnings: [...new Set(warnings)]
  }
}

export function candidateMarkdown(
  id: string,
  item: CandidateItem,
  sourcePath: string,
  batchTags: string[]
): string {
  const tags = [...new Set([...item.tags, ...batchTags])]
  const common = [
    '---',
    `id: ${yaml(id)}`,
    `subject: ${yaml(item.subject)}`,
    `category: ${yaml(item.category)}`,
    `tags: ${JSON.stringify(tags)}`,
    `source: ${yaml(`本地资料/${sourcePath}`)}`,
    `sourceFile: ${yaml(sourcePath)}`,
    `confidence: ${item.confidence.toFixed(2)}`,
    `reviewStatus: "pending"`,
    `generatedBy: "MarkItDown + configured LLM"`
  ]
  if (item.year) common.push(`year: ${item.year}`)
  if (item.region) common.push(`region: ${yaml(item.region)}`)
  if (item.paper) common.push(`paper: ${yaml(item.paper)}`)
  if (item.kind === 'question') {
    return [
      ...common,
      'kind: "question"',
      `questionType: ${yaml(item.questionType)}`,
      `difficulty: ${item.difficulty}`,
      `stem: ${yaml(item.stem)}`,
      `options: ${JSON.stringify(item.options)}`,
      `answer: ${JSON.stringify(item.answer)}`,
      `explanation: ${yaml(item.explanation)}`,
      '---',
      '',
      '# 题目',
      '',
      item.stem,
      ...(item.options.length
        ? ['', '## 选项', '', ...item.options.map((option) => `${option.key}. ${option.text}`)]
        : []),
      '',
      '## 答案',
      '',
      item.answer.join('、'),
      '',
      '## 解析',
      '',
      item.explanation,
      ''
    ].join('\n')
  }
  return [
    ...common,
    `kind: ${yaml(item.documentKind)}`,
    `title: ${yaml(item.title)}`,
    `summary: ${yaml(item.summary)}`,
    '---',
    '',
    `# ${item.title}`,
    '',
    item.content.replace(/^#\s+.+\n+/, ''),
    ''
  ].join('\n')
}

/** 产物级来源证据：题本页（question/material role）与解析册页（solution role）分别记录 */
export function buildArtifactEvidence(
  item: {
    lineStart?: number
    materialLineRange?: { start: number; end: number }
    solutionLineStart?: number
    solutionSourceId?: string
  },
  sourceId: string,
  relativePath: string,
  linePageMap: Array<number | undefined> | undefined,
  solutionPageMaps: Map<string, Array<number | undefined>>
): SourceEvidence {
  const solutionMap = item.solutionSourceId
    ? solutionPageMaps.get(item.solutionSourceId)
    : undefined
  return buildSourceEvidence({
    references: [
      {
        role: 'question',
        sourceId,
        relativePath,
        lineStart: item.lineStart,
        linePageMap: linePageMap ?? []
      },
      ...(item.materialLineRange
        ? [
            {
              role: 'material' as const,
              sourceId,
              relativePath,
              lineRange: item.materialLineRange,
              linePageMap: linePageMap ?? []
            }
          ]
        : []),
      ...(item.solutionLineStart !== undefined && item.solutionSourceId && solutionMap
        ? [
            {
              role: 'solution' as const,
              sourceId: item.solutionSourceId,
              relativePath: item.solutionSourceId,
              lineStart: item.solutionLineStart,
              linePageMap: solutionMap
            }
          ]
        : [])
    ]
  })
}
