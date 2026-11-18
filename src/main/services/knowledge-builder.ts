import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import matter from 'gray-matter'
import type {
  AiImageInput,
  AiMessage,
  BatchReviewResult,
  ImportCapability,
  KnowledgeArtifactDetail,
  KnowledgeArtifactStatus,
  KnowledgeArtifactSummary,
  KnowledgeBuildFile,
  KnowledgeBuildJob,
  KnowledgeBuildOptions,
  KnowledgeEngineStatus,
  KnowledgeSourceFile,
  OcrQualityReport,
  KnowledgeSourceScan,
  SourceEvidence,
  SourceReference,
  Subject,
  VaultIndexResult,
  VlmProofreadSuggestion
} from '../../shared/contracts'
import { parseOcrWorkerLine } from '../../shared/ocr-payload'
import { FEATURE_PROMPTS, sourceEnvelope, taskDataEnvelope } from '../../shared/prompts'
import { AiService } from './ai'
import { ConversionCache } from './conversion-cache'
import {
  CPU_ONNXRUNTIME_SPEC,
  DIRECTML_PACKAGE,
  pickGpuAdapter,
  setRapidocrDmlEnabled
} from './ocr-accelerator'
import { mergeByDocumentOrder } from './direct-sequential-merge'
import {
  CAPABILITY_LABELS,
  batchFactsMessage,
  classifyFileCapability,
  collectPageFacts,
  tierForArtifact,
  loadStructuredRegions,
  scanNumericAnomalies,
  scanTableQuality,
  type ImportBatchFacts
} from './import-quality'
import {
  buildSourceEvidence,
  EVIDENCE_PAGE_LIMIT,
  collectEvidencePageKeys,
  evidenceAssetId,
  finalizeSourceEvidenceStatus,
  manifestFromRegions,
  computeTraceCoverage,
  pageKey,
  parsePageManifest,
  traceCoverageMessage,
  type PageManifest,
  type ReferenceBuildInput
} from './source-evidence'
import {
  bindGraphicOptionsByGeometry,
  buildGraphicPreservation,
  extractGraphicQuestions,
  GRAPHIC_AUTO_STRUCTURE,
  isGraphicCandidate,
  mergeGraphicQuestions
} from './graphic-import'
import {
  envPipIndexUrl,
  installWithMirrorQueue,
  mirrorById,
  mirrorQueueFromProbes,
  normalizeMirrorPreference,
  pipMirrorFailureHint,
  PipSourceFailure,
  probeMirror,
  type PipSource
} from './pip-mirror'
import { PIP_MIRRORS } from '../../shared/pip-mirrors'
import {
  ensurePortablePythonRuntime,
  ensureVirtualEnvironment,
  findPythonLauncher as findPythonLauncherCandidate,
  resolveInstallLauncher,
  type CommandRunner
} from './python-runtime'

// 文档结构解析组件（RapidAI 生态，表格还原/图形保真/阅读顺序）
const STRUCTURED_PACKAGE = 'rapid-doc==0.9.10'
import {
  directQuestionMarkdown,
  directSignature,
  mergeDirectQuestions,
  parseAnswerGroups,
  parseEssayBook,
  parseQuestionBook,
  parseSolutionBook,
  toLines,
  toLinesWithPageMap,
  type DirectQuestion,
  type ParsedEssayUnit,
  type ParsedSolution
} from './question-import'
import { VaultService } from './vault'

const execFileAsync = promisify(execFile)

// 文字通道切出的可用题少于此数时，"题号+图片页充足"的文件才按纯图推题本走保留通道；
// 行测整卷有大量图表页但文字题健康，不能因此整文件放弃结构化
const GRAPHIC_ONLY_MAX_TEXT_QUESTIONS = 5

// 随产物入库的图片资产白名单后缀：_regions.json/_pages.json 等 sidecar 不进题库
const IMAGE_ASSET_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff)$/i

const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.xls',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.txt',
  '.md',
  '.epub',
  '.msg',
  '.eml'
]
const INCOMPLETE_EXTENSIONS = new Set(['.downloading', '.part', '.tmp', '.crdownload'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm'])
const IGNORED_DIRECTORIES = new Set(['.git', '.obsidian', 'node_modules', '$recycle.bin'])
const MAX_SOURCE_FILES = 10_000
const MAX_SELECTED_FILES = 500
const MAX_SOURCE_FILE_BYTES = 256 * 1024 * 1024
const MAX_RAW_MARKDOWN_BYTES = 20 * 1024 * 1024
// 题本类材料约 300 字/题：块大小与每块条数上限对齐，避免高密度题目被上限整批丢弃
const MAX_CHUNK_CHARACTERS = 3_000
const MAX_CHUNKS_PER_FILE = 240
const MARKITDOWN_VERSION = '0.1.6'
// OCR 组件：RapidOCR 与 PaddleOCR 使用同源 PP-OCR 模型（ONNX 版），wheel 内置默认模型，离线可用
const OCR_PACKAGES = [
  'rapidocr==3.9.2',
  // 不设上限：pip 按各 Python 版本的 requires_python 自动选择（3.10 → 1.22，3.14 → 1.24+）
  'onnxruntime>=1.20',
  'pypdfium2>=4.30,<7'
]

interface CandidateItem {
  kind: 'question' | 'document'
  documentKind: 'knowledge' | 'method' | 'pattern'
  subject: Subject | 'common'
  category: string
  questionType: 'single' | 'multiple' | 'judge' | 'essay'
  stem: string
  options: Array<{ key: string; text: string }>
  answer: string[]
  explanation: string
  title: string
  summary: string
  content: string
  tags: string[]
  year?: number
  region?: string
  paper?: string
  difficulty: number
  confidence: number
  evidenceExcerpt: string
  warnings: string[]
}

interface StoredArtifact extends KnowledgeArtifactDetail {
  jobId: string
  relativeSourcePath: string
}

interface StoredJob {
  id: string
  sourcePath: string
  createdAt: string
  updatedAt: string
  status: KnowledgeBuildJob['status']
  options: KnowledgeBuildOptions
  files: KnowledgeBuildFile[]
  artifactIds: string[]
  currentFile?: string
  message?: string
  cancelRequested: boolean
  outputPath: string
}

function now(): string {
  return new Date().toISOString()
}

/** best-effort 文本读取：缺失/损坏返回 undefined（页清单等 sidecar 容错） */
function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function compact(value: string): string {
  return value.replace(/\s+/g, '').trim()
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeString(item)).filter(Boolean))]
    : []
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return (
    path === '' ||
    (path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path))
  )
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

function jsonObject(value: string): Record<string, unknown> {
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

function yaml(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''))
}

function isPdfFile(path: string): boolean {
  return /\.pdf$/i.test(path)
}

// ---- VLM 按页精校（可选，默认关闭）：常量与纯文本辅助 ----

/** 任务级批量预精校的硬编码页数上限：超出部分跳过并如实提示，可在审核页单页补校 */
export const MAX_AUTO_VLM_PAGES = 10

/** 单产物按页精校最多取 3 个关联来源页（question/material/preserved-page，解析册页不参与） */
export const VLM_PROOFREAD_MAX_PAGES = 3

/** VLM 精校页面渲染长边：1280px 下资料分析表格小字发虚，精校用 2000px 高清页图 */
export const VLM_RENDER_MAX_SIDE = 2000

/** 采纳 VLM 精校结果后的固定复核提示（进 warnings，不解除发布门禁） */
export const VLM_REVIEW_WARNING = '已完成 VLM 按页精校，仍需人工复核确认'

/** 人工编辑/采纳精校后的正文大小上限（与产物常规体量同量级，防异常大文本） */
const MAX_MARKDOWN_EDIT_BYTES = 2 * 1024 * 1024

/** 来源页角色优先级：材料页是资料分析精校的主依据，解析册页码不参与精校正页 */
const PROOFREAD_ROLE_ORDER: Record<SourceReference['role'], number> = {
  material: 0,
  question: 1,
  'preserved-page': 2,
  solution: 3
}

/** 收集产物可精校的来源页：材料/题本/保留页去重后按角色优先排序，解析册页不参与 */
function collectProofreadPages(
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
function splitFrontmatter(markdown: string): { frontmatter: string; body: string } | undefined {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return undefined
  return {
    frontmatter: match[1] ?? '',
    body: markdown.slice(match[0].length).replace(/^\r?\n/, '')
  }
}

// ---- frontmatter 校验与同步（gray-matter 统一收口，支持多行 YAML）----
// 发布入库（VaultService.parseFile）优先读 frontmatter 的 material/stem/options/explanation，
// 精校或人工编辑只改正文会导致题库仍显示旧文本：保存时必须把正文修订同步回这些字段。

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
function assertFrontmatterIntact(
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

/** 提取正文中的标题区块（从 startHeading 行后到下一个匹配 stop 标题为止）；缺失返回 undefined */
function sectionBetween(body: string, startHeading: string, stop: RegExp): string | undefined {
  const header = body.indexOf(startHeading)
  if (header < 0) return undefined
  const lineEnd = body.indexOf('\n', header)
  if (lineEnd < 0) return undefined
  const rest = body.slice(lineEnd + 1)
  const matched = rest.match(stop)
  return (matched && matched.index !== undefined ? rest.slice(0, matched.index) : rest).trim()
}

/** 解析「## 选项」区块的选项文字行：剥掉 ![...](...) 图片标记，只留文字 */
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
function syncFrontmatterFromBody(
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

/** 行式 YAML 序列化：字符串走 yaml()（JSON 带引号），其余 JSON——与直导/模型提炼生成器同风格，
 *  保证 publish 的 reviewStatus 字符串替换与 vault 的 gray-matter 解析保持兼容 */
function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${typeof value === 'string' ? yaml(value) : JSON.stringify(value)}`)
  }
  lines.push('---', '', body.trimEnd())
  return `${lines.join('\n')}\n`
}

/** 修订正文重组完整 Markdown：红线字段强校验 + 图片引用保底 + material/stem/options[].text/explanation
 *  从正文同步回 frontmatter（VLM 建议与人工编辑共用同一收口，发布入库读到的就是修订值） */
function rebuildArtifactMarkdown(originalMarkdown: string, correctedBody: string): string {
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
function buildVlmProofreadMessages(
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
function materialSectionRange(markdown: string): { start: number; end: number } | undefined {
  const header = markdown.indexOf('## 共享材料')
  if (header < 0) return undefined
  const bodyStart = markdown.indexOf('\n\n', header)
  if (bodyStart < 0) return undefined
  const nextSection = markdown.indexOf('\n# 题目', bodyStart)
  if (nextSection < 0) return undefined
  return { start: bodyStart + 2, end: nextSection }
}

/** scope=material：只替换共享材料区块，并把修正文本同步回 frontmatter.material */
function applyCorrectedMaterial(originalMarkdown: string, correctedMaterial: string): string {
  const parsed = splitFrontmatter(originalMarkdown)
  if (!parsed) return originalMarkdown
  const range = materialSectionRange(parsed.body)
  if (!range) return originalMarkdown
  const newBody = `${parsed.body.slice(0, range.start)}${correctedMaterial.trim()}${parsed.body.slice(range.end)}`
  const synced = syncFrontmatterFromBody(matter(originalMarkdown).data, newBody)
  return serializeFrontmatter(synced, newBody)
}

/** VLM JSON 契约校验：correctedBody 必须为非空正文，且绝不允许夹带 frontmatter */
function validateVlmPayload(payload: Record<string, unknown>): {
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

// rebuildWithCorrectedBody 已由 rebuildArtifactMarkdown 取代（见 frontmatter 同步收口段）

// 统计申论教材的「训练」式单元标题行数（【训练N】xxx / 训练N：xxx 两种版式），
// 直导零产出时用于判断这本书是否主观题教材并给出模式建议
function countEssayTrainingMarks(lines: string[]): number {
  return lines.filter((line) =>
    /^【?训练\s*[一二三四五六七八九十百0-9]{1,4}\s*】?\s*[:：]?/.test(line)
  ).length
}

function safeTitle(value: string, fallback: string): string {
  const cleaned = value
    // 图推等题干常内嵌 Markdown 图片（如 ![](images/xxx.png)），展示标题前先剥离，
    // 否则列表标题会裸露成「![](images xxxxx)」式的原始语法碎片
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, 80)
}

function chunkText(value: string): string[] {
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

/** 发布门禁：能力边界产物（图推/图片题/表格待核）与配对待确认的产物，
 *  未人工确认前不允许发布。纯函数，便于单测。 */
export function partitionByPublishGate<
  T extends { capability?: ImportCapability; humanConfirmed?: boolean; warnings: string[] }
>(artifacts: T[]): { allowed: T[]; blocked: T[] } {
  const isGated = (artifact: T): boolean =>
    (Boolean(artifact.capability) && artifact.capability !== 'text-supported') ||
    artifact.warnings.some((warning) => warning.includes('配对待确认'))
  return {
    allowed: artifacts.filter((artifact) => !isGated(artifact) || artifact.humanConfirmed),
    blocked: artifacts.filter((artifact) => isGated(artifact) && !artifact.humanConfirmed)
  }
}

export class KnowledgeBuilderService {
  private readonly rootDirectory: string
  private readonly jobsDirectory: string
  private readonly engineDirectory: string
  private readonly managedVaultDirectory: string
  private readonly conversionCache: ConversionCache
  private runningJobId?: string
  private runningChild?: ReturnType<typeof spawn>
  private installing = false
  private installProgress?: { phase: string; percent: number }
  private engineCache?: KnowledgeEngineStatus
  private gpuAdapterProbe?: Promise<string | undefined>
  private resolvedMirrorQueue?: PipSource[]

  constructor(
    dataDirectory: string,
    private readonly resourceDirectory: string,
    private readonly ai: AiService,
    private readonly vaults: VaultService
  ) {
    this.rootDirectory = join(dataDirectory, 'knowledge-builder')
    this.jobsDirectory = join(this.rootDirectory, 'jobs')
    this.engineDirectory = join(this.rootDirectory, 'engine')
    this.managedVaultDirectory = join(this.rootDirectory, 'managed-vault')
    this.conversionCache = new ConversionCache(join(this.rootDirectory, 'conversion-cache'))
    mkdirSync(this.jobsDirectory, { recursive: true })
    mkdirSync(this.engineDirectory, { recursive: true })
    mkdirSync(this.managedVaultDirectory, { recursive: true })
    this.recoverInterruptedJobs()
  }

  scan(sourcePath: string): KnowledgeSourceScan {
    const requested = resolve(sourcePath)
    if (!existsSync(requested) || !statSync(requested).isDirectory())
      throw new Error('所选原料路径不是可读取目录')
    const root = realpathSync(requested)
    const files: KnowledgeSourceFile[] = []
    const warnings: string[] = []
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= MAX_SOURCE_FILES)
          throw new Error(`原料超过 ${MAX_SOURCE_FILES} 个文件，请拆分目录后分批处理`)
        const path = resolve(directory, entry.name)
        if (!isWithin(root, path)) continue
        if (entry.isSymbolicLink()) {
          warnings.push(`${relative(root, path)}：符号链接未读取`)
          continue
        }
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) visit(path)
          continue
        }
        if (!entry.isFile()) continue
        const info = lstatSync(path)
        const extension = extname(entry.name).toLowerCase()
        let eligible = SUPPORTED_EXTENSIONS.includes(extension)
        let reason: string | undefined
        if (INCOMPLETE_EXTENSIONS.has(extension)) {
          eligible = false
          reason = '下载尚未完成'
        } else if (IMAGE_EXTENSIONS.has(extension)) {
          eligible = false
          reason = '需要可靠 OCR，当前版本不会仅凭图片元数据入库'
        } else if (VIDEO_EXTENSIONS.has(extension)) {
          eligible = false
          reason = '视频暂不属于本地 MarkItDown 转换范围'
        } else if (!eligible) reason = extension ? '暂不支持此格式' : '文件没有扩展名'
        if (info.size > MAX_SOURCE_FILE_BYTES) {
          eligible = false
          reason = '单文件超过 256 MB，请先拆分或压缩'
        }
        const relativePath = relative(root, path).replace(/\\/g, '/')
        files.push({
          id: hash(`${relativePath}\u0000${info.size}\u0000${info.mtimeMs}`).slice(0, 24),
          relativePath,
          extension: extension || '[none]',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          eligible,
          reason
        })
      }
    }
    visit(root)
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'))
    return {
      sourcePath: root,
      scannedAt: now(),
      files,
      eligibleCount: files.filter((file) => file.eligible).length,
      eligibleSize: files.filter((file) => file.eligible).reduce((sum, file) => sum + file.size, 0),
      skippedCount: files.filter((file) => !file.eligible).length,
      warnings: warnings.slice(0, 100)
    }
  }

  async engineStatus(): Promise<KnowledgeEngineStatus> {
    const progress = this.installing ? this.installProgress : undefined
    if (
      this.engineCache?.available &&
      this.engineCache.pythonPath &&
      existsSync(this.engineCache.pythonPath)
    ) {
      const cachedPythonPath = this.engineCache.pythonPath
      return {
        ...this.engineCache,
        ocrAccelerator: this.ocrAcceleratorMode(),
        gpuAdapterName: await this.detectGpuAdapter(),
        pipMirrorId: this.pipMirrorPreference(),
        structuredParseAvailable: await this.structuredParseAvailable(cachedPythonPath),
        installing: this.installing,
        installProgress: progress
      }
    }
    const candidates = this.pythonCandidates()
    for (const pythonPath of candidates) {
      if (!existsSync(pythonPath)) continue
      const version = await this.markitdownVersion(pythonPath)
      if (version) {
        const structuredParseAvailable = await this.structuredParseAvailable(pythonPath)
        this.engineCache = {
          available: true,
          installing: this.installing,
          version,
          pythonPath,
          ocrAvailable: await this.ocrComponentsAvailable(pythonPath),
          structuredParseAvailable,
          message: `MarkItDown ${version} 已就绪`,
          supportedExtensions: [...SUPPORTED_EXTENSIONS]
        }
        return {
          ...this.engineCache,
          ocrAccelerator: this.ocrAcceleratorMode(),
          gpuAdapterName: await this.detectGpuAdapter(),
          pipMirrorId: this.pipMirrorPreference(),
          structuredParseAvailable,
          installProgress: progress
        }
      }
    }
    return {
      available: false,
      installing: this.installing,
      ocrAvailable: false,
      pipMirrorId: this.pipMirrorPreference(),
      structuredParseAvailable: false,
      message: '尚未安装独立 MarkItDown 转换环境',
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
      installProgress: progress
    }
  }

  async installEngine(): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (this.runningJobId) throw new Error('知识构建任务运行时不能更新转换引擎')
    this.installing = true
    try {
      this.installProgress = { phase: '正在定位 Python 环境', percent: 2 }
      // 本机深度发现（PATH + 固定安装位置，免重启即可发现新装 Python）；
      // Windows 下完全找不到时自动下载独立便携版 Python 3.12 零门槛兜底
      const launcher = await resolveInstallLauncher({
        findLocal: () => this.findPythonLauncher(),
        ensurePortable: () => this.ensurePortableLauncher()
      })
      const environment = join(this.engineDirectory, '.venv')
      const pythonPath = this.managedPythonPath()
      this.installProgress = { phase: '创建独立虚拟环境', percent: 13 }
      // 半残 .venv 自愈：pip 可用直接过；否则 ensurepip 补装；仍不行删目录重建
      await ensureVirtualEnvironment({
        runner: this.commandRunner(),
        launcher,
        environment,
        pythonPath
      })
      // 分组件安装并解析 pip 输出推进进度：大块是 OCR 模型与推理运行时。
      // 安装源在批次开始时解析一次（探活排序或用户钉死），整批共用；
      // 某个源失败自动切换下一个，成功后提升为后续包的首选源。
      const firstSource = (await this.resolveMirrorQueue())[0]
      this.installProgress = { phase: `安装源：${firstSource?.label ?? '自动'}`, percent: 14 }
      await this.pipInstallWithProgress(
        pythonPath,
        `markitdown[pdf,docx,pptx,xlsx,xls,outlook]==${MARKITDOWN_VERSION}`,
        15,
        20,
        '安装文档转换组件 MarkItDown'
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[0]!,
        36,
        20,
        '安装 OCR 组件 RapidOCR（含识别模型）'
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[1]!,
        56,
        30,
        '安装推理运行时 onnxruntime（体积较大）'
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[2]!,
        86,
        5,
        '安装 PDF 渲染组件 pypdfium2'
      )
      await this.pipInstallWithProgress(
        pythonPath,
        STRUCTURED_PACKAGE,
        91,
        5,
        '安装文档结构解析组件 RapidDoc（表格还原）'
      )
      this.installProgress = { phase: '验证安装结果', percent: 97 }
      this.engineCache = undefined
      const status = await this.engineStatus()
      if (!status.available) throw new Error('安装命令已结束，但 MarkItDown 无法导入')
      this.installProgress = { phase: '安装完成', percent: 100 }
      return status
    } catch (error) {
      throw new Error(`转换引擎安装失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      this.installing = false
    }
  }

  // 统一的子进程执行器（venv / pip 校验、版本探测、tar 解压等命令探测类调用），
  // 非 0 退出与启动失败一律以异常呈现
  private commandRunner(): CommandRunner {
    return (command, args, options) =>
      execFileAsync(command, args, {
        timeout: options?.timeout ?? 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
  }

  // 本机完全没有可用 Python 时的零门槛兜底：下载独立便携版 Python 3.12 到
  // 应用数据目录（约 21 MB，SHA-256 硬校验，双源自动回退，不污染系统）
  private async ensurePortableLauncher(): Promise<{ command: string; args: string[] }> {
    const pythonExe = await ensurePortablePythonRuntime({
      runtimeRoot: join(this.engineDirectory, 'runtime'),
      runner: this.commandRunner(),
      onProgress: (phase, percent) => (this.installProgress = { phase, percent })
    })
    return { command: pythonExe, args: [] }
  }

  /** GPU 加速（DirectML）组件：检测、安装、移除。仅 Windows；失败自动回退 CPU 后端 */
  private rapidocrConfigPath(): string {
    return join(this.engineDirectory, '.venv', 'Lib', 'site-packages', 'rapidocr', 'config.yaml')
  }

  private dmlInstalled(): boolean {
    // onnxruntime-directml 与 CPU 版 import 名相同（onnxruntime），只能靠 dist-info 区分
    const sitePackages = join(this.engineDirectory, '.venv', 'Lib', 'site-packages')
    try {
      return readdirSync(sitePackages).some((entry) =>
        entry.toLowerCase().startsWith('onnxruntime_directml')
      )
    } catch {
      return false
    }
  }

  private dmlEnabled(): boolean {
    try {
      return /use_dml:\s*true/.test(readFileSync(this.rapidocrConfigPath(), 'utf8'))
    } catch {
      return false
    }
  }

  private ocrAcceleratorMode(): 'cpu' | 'dml' {
    return this.dmlInstalled() && this.dmlEnabled() ? 'dml' : 'cpu'
  }

  private setRapidocrDml(enabled: boolean): void {
    const configPath = this.rapidocrConfigPath()
    if (!existsSync(configPath)) return
    this.atomicWrite(configPath, setRapidocrDmlEnabled(readFileSync(configPath, 'utf8'), enabled))
  }

  private detectGpuAdapter(): Promise<string | undefined> {
    // 显卡型号基本不变，进程生命周期内只探测一次（PowerShell 冷启动 ~200ms，不能进轮询路径）
    if (!this.gpuAdapterProbe) {
      this.gpuAdapterProbe = execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "`n"'],
        { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }
      )
        .then(({ stdout }) => pickGpuAdapter(stdout.split(/\r?\n/)))
        .catch(() => undefined)
    }
    return this.gpuAdapterProbe
  }

  // 装后探针：初始化 RapidOCR 并捕获 ORT 的回退告警。DML 创建失败时 ORT 会静默降级 CPU，
  // 只有从日志里识别失败特征才能发现「装了等于没装」——这正是探针要拦住的情况。
  private async probeDml(pythonPath: string): Promise<boolean> {
    const snippet = [
      'import sys, io, contextlib',
      'try:',
      '    import onnxruntime as ort',
      "    if 'DmlExecutionProvider' not in ort.get_available_providers():",
      "        print('dml-probe: missing-provider'); sys.exit(0)",
      '    from rapidocr import RapidOCR',
      '    buf = io.StringIO()',
      '    with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(buf):',
      '        RapidOCR()',
      '    captured = buf.getvalue()',
      "    bad = 'Failed to create DML' in captured or 'automatically shifted' in captured",
      "    print('dml-probe:', 'fallback' if bad else 'ok')",
      'except Exception as error:',
      "    print('dml-probe: error', error)"
    ].join('\n')
    try {
      const { stdout } = await execFileAsync(pythonPath, ['-c', snippet], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return stdout.includes('dml-probe: ok')
    } catch {
      return false
    }
  }

  async installGpuAccelerator(): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (this.runningJobId) throw new Error('知识构建任务运行时不能更新转换引擎')
    const current = await this.engineStatus()
    if (!current.available || !current.ocrAvailable || !current.pythonPath)
      throw new Error('请先安装转换引擎与 OCR 组件，再启用 GPU 加速')
    this.installing = true
    try {
      const pythonPath = current.pythonPath
      this.installProgress = { phase: '卸载 CPU 推理后端 onnxruntime', percent: 8 }
      await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime'], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })
      await this.pipInstallWithProgress(
        pythonPath,
        DIRECTML_PACKAGE,
        25,
        55,
        '安装 DirectML 推理后端（DX12 显卡通用）'
      )
      this.installProgress = { phase: '启用 GPU 推理开关', percent: 86 }
      this.setRapidocrDml(true)
      this.installProgress = { phase: '验证 GPU 推理是否真实生效', percent: 92 }
      if (!(await this.probeDml(pythonPath))) {
        // 显卡驱动不支持/初始化失败：自动回退，绝不让用户停在「装了等于没装」的状态
        this.installProgress = { phase: 'GPU 未生效，自动回退 CPU 推理后端', percent: 95 }
        await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime-directml'], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })
        // 回退重装 CPU 后端必须走候选源队列（此前漏传镜像源，默认源不可达时直接卡死）
        await this.pipInstallWithProgress(
          pythonPath,
          CPU_ONNXRUNTIME_SPEC,
          95,
          3,
          '回退安装 CPU 推理后端 onnxruntime'
        )
        this.setRapidocrDml(false)
        this.engineCache = undefined
        throw new Error(
          '本机显卡不支持 DirectML 加速，已自动回退 CPU 后端（识别质量与速度不受影响）'
        )
      }
      this.engineCache = undefined
      this.installProgress = { phase: 'GPU 加速已启用', percent: 100 }
      return await this.engineStatus()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('本机显卡不支持')) throw error
      throw new Error(
        `GPU 加速组件安装失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      this.installing = false
    }
  }

  async removeGpuAccelerator(): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (this.runningJobId) throw new Error('知识构建任务运行时不能更新转换引擎')
    const current = await this.engineStatus()
    if (!current.available || !current.pythonPath)
      throw new Error('转换引擎尚未安装，无需移除 GPU 加速')
    if (!this.dmlInstalled()) throw new Error('当前未启用 GPU 加速')
    this.installing = true
    try {
      const pythonPath = current.pythonPath
      this.installProgress = { phase: '卸载 DirectML 推理后端', percent: 15 }
      await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime-directml'], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })
      this.installProgress = { phase: '恢复 CPU 推理后端 onnxruntime', percent: 45 }
      await this.pipInstallWithProgress(
        pythonPath,
        CPU_ONNXRUNTIME_SPEC,
        45,
        40,
        '恢复 CPU 推理后端 onnxruntime'
      )
      this.installProgress = { phase: '恢复 CPU 推理开关', percent: 90 }
      this.setRapidocrDml(false)
      this.engineCache = undefined
      this.installProgress = { phase: '已恢复 CPU 推理', percent: 100 }
      return await this.engineStatus()
    } catch (error) {
      throw new Error(
        `GPU 加速组件移除失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      this.installing = false
    }
  }

  // ---- pip 安装源：安装时探活优选，可手动钉死；只影响本应用的 pip 命令，不动系统配置 ----

  private mirrorPreferencePath(): string {
    return join(this.engineDirectory, 'pip-mirror.json')
  }

  private pipMirrorPreference(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.mirrorPreferencePath(), 'utf8')) as {
        mirrorId?: string
      }
      return normalizeMirrorPreference(parsed.mirrorId)
    } catch {
      return 'auto'
    }
  }

  async setPipMirror(mirrorId: string): Promise<void> {
    const preference = normalizeMirrorPreference(mirrorId)
    this.atomicWrite(
      this.mirrorPreferencePath(),
      JSON.stringify({ mirrorId: preference, updatedAt: new Date().toISOString() }, null, 2)
    )
    this.resolvedMirrorQueue = undefined
  }

  // 解析「有序候选源队列」：环境变量显式源 / 用户钉死源各只有一个候选；
  // auto 模式并发探活全部源产出完整队列——可达国内源按耗时升序、可达官方源次之、
  // 探活未过的源按固定兜底顺序排末尾（pip 走系统代理时的网络视图可能不同于探活）。
  private async resolveMirrorQueue(): Promise<PipSource[]> {
    if (this.resolvedMirrorQueue) return this.resolvedMirrorQueue
    // 用户环境变量显式指定的源优先——那是用户自己配置的环境，不应被应用覆盖
    const fromEnv = envPipIndexUrl()
    if (fromEnv)
      return (this.resolvedMirrorQueue = [{ url: fromEnv, label: '环境变量 PIP_INDEX_URL' }])
    const preference = this.pipMirrorPreference()
    if (preference !== 'auto') {
      const mirror = mirrorById(preference)
      if (mirror)
        return (this.resolvedMirrorQueue = [{ url: mirror.indexUrl, label: mirror.label }])
    }
    const probes = await Promise.all(
      PIP_MIRRORS.map(async (mirror) => {
        const startedAt = Date.now()
        const reachable = await probeMirror(mirror.indexUrl)
        return { ...mirror, reachable, elapsedMs: Date.now() - startedAt }
      })
    )
    const queue = mirrorQueueFromProbes(probes).map((mirror) => ({
      url: mirror.indexUrl,
      label: mirror.label
    }))
    return (this.resolvedMirrorQueue = queue)
  }

  // 首个安装成功的源提升为队首：同一批次后续包不再重复踩已失败的源
  private promoteMirrorSource(source: PipSource): void {
    const queue = this.resolvedMirrorQueue
    if (!queue) return
    const rest = queue.filter((item) => item.url !== source.url)
    this.resolvedMirrorQueue = [source, ...rest]
  }

  // 逐包安装并按 pip 输出行(Collecting/Downloading/Successfully)估算完成度，驱动安装进度条；
  // 内部按候选源队列自动换源重试，手动钉死源失败时附带可操作的排障指引。
  // 候选队列每次实时读取：获胜源提升写在 this.resolvedMirrorQueue 上，
  // 调用方若传入开头取好的旧快照，后续包会重复先撞已失败的首源
  private async pipInstallWithProgress(
    pythonPath: string,
    spec: string,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    const queue = await this.resolveMirrorQueue()
    this.installProgress = { phase, percent: base }
    await installWithMirrorQueue({
      queue,
      run: (source) => this.runPipInstall(pythonPath, spec, source, base, span, phase),
      onSourceFailure: (_failed, next) => {
        this.installProgress = {
          phase: `${phase}（当前源安装失败，自动切换至 ${next.label} 重试…）`,
          percent: base
        }
      },
      onSourceSuccess: (source) => this.promoteMirrorSource(source),
      buildHint: (combinedOutput) => {
        // 环境变量源是用户自配的，指引去 UI 改设置没有意义
        if (envPipIndexUrl()) return undefined
        return pipMirrorFailureHint(combinedOutput, this.pipMirrorPreference())
      }
    })
  }

  // 单源 pip 安装：非 0 退出时把 stdout 与 stderr 尾部一起抛出
  //（部分 pip 错误如 from versions: none 输出在 stdout）
  private runPipInstall(
    pythonPath: string,
    spec: string,
    source: PipSource,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        pythonPath,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', source.url, spec],
        {
          windowsHide: true,
          shell: false,
          env: { ...process.env, PIP_NO_INPUT: '1', PYTHONUTF8: '1' }
        }
      )
      let stderr = ''
      let stdoutTail = ''
      let buffer = ''
      let collected = 0
      let finished = 0
      const timer = setTimeout(() => child.kill(), 20 * 60_000)
      const update = (): void => {
        const fraction = collected > 0 ? Math.min(1, finished / collected) : 0
        this.installProgress = {
          phase,
          percent: Math.max(base, Math.min(base + span, Math.round(base + span * fraction)))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutTail = `${stdoutTail}${chunk}`.slice(-20_000)
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (/^Collecting /.test(line)) collected += 1
          else if (/^(Downloading |Using cached )/.test(line)) {
            finished += 1
            update()
          } else if (/^Successfully installed /.test(line)) {
            finished = collected
            update()
          }
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolvePromise()
        const output = [stderr.trim(), stdoutTail.trim()].filter(Boolean).join('\n')
        reject(new PipSourceFailure(output || `pip 进程退出码 ${code ?? '未知'}`))
      })
    })
  }

  async startJob(input: {
    sourcePath: string
    fileIds: string[]
    options: KnowledgeBuildOptions
  }): Promise<KnowledgeBuildJob> {
    if (this.runningJobId) throw new Error('已有知识构建任务正在运行')
    if (!input.options.rightsConfirmed)
      throw new Error('请先确认你有权处理所选资料，并会在发布前人工复核')
    const ids = [...new Set(input.fileIds)]
    if (!ids.length) throw new Error('至少选择一个可转换文件')
    if (ids.length > MAX_SELECTED_FILES)
      throw new Error(`单个批次最多处理 ${MAX_SELECTED_FILES} 个文件`)
    const engine = await this.engineStatus()
    if (!engine.available) throw new Error('请先安装 MarkItDown 转换引擎')
    if (input.options.mode !== 'convert-only' && input.options.mode !== 'direct') {
      const config = this.ai.getConfig()
      if (!config.hasApiKey && !['ollama', 'lmstudio'].includes(config.provider))
        throw new Error('请先在模型设置中保存 API Key，或配置本地模型')
    }
    const scan = this.scan(input.sourcePath)
    const selected = scan.files.filter((file) => file.eligible && ids.includes(file.id))
    if (selected.length !== ids.length)
      throw new Error('部分文件已变化或不再可处理，请重新扫描后选择')
    const id = `kbjob-${randomUUID()}`
    const outputPath = join(this.jobsDirectory, id)
    mkdirSync(join(outputPath, 'raw'), { recursive: true })
    mkdirSync(join(outputPath, 'artifacts'), { recursive: true })
    const job: StoredJob = {
      id,
      sourcePath: scan.sourcePath,
      createdAt: now(),
      updatedAt: now(),
      status: 'queued',
      options: {
        ...input.options,
        tags: [...new Set(input.options.tags.map((tag) => tag.trim()).filter(Boolean))].slice(
          0,
          20
        ),
        instruction: input.options.instruction.trim().slice(0, 2000)
      },
      files: selected.map((file) => ({
        sourceId: file.id,
        relativePath: file.relativePath,
        size: file.size,
        state: 'queued',
        artifactCount: 0,
        chunkCount: 0
      })),
      artifactIds: [],
      cancelRequested: false,
      outputPath
    }
    this.saveJob(job)
    void this.runJob(id).catch((error) => {
      const failed = this.loadJob(id)
      failed.status = 'failed'
      failed.message = error instanceof Error ? error.message : '后台任务异常结束'
      failed.updatedAt = now()
      this.saveJob(failed)
      this.runningJobId = undefined
      this.runningChild = undefined
    })
    return this.jobView(job)
  }

  latestJob(): KnowledgeBuildJob | undefined {
    const manifests = readdirSync(this.jobsDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(this.jobsDirectory, entry.name, 'job.json'))
      )
      .map((entry) => this.loadJob(entry.name))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return manifests[0] ? this.jobView(manifests[0]) : undefined
  }

  getJob(id: string): KnowledgeBuildJob {
    return this.jobView(this.loadJob(id))
  }

  cancelJob(id: string): KnowledgeBuildJob {
    const job = this.loadJob(id)
    if (!['queued', 'running', 'cancelling'].includes(job.status)) return this.jobView(job)
    job.cancelRequested = true
    job.status = 'cancelling'
    job.message = '正在停止，当前模型请求可能需要先结束'
    job.updatedAt = now()
    this.saveJob(job)
    if (this.runningJobId === id && this.runningChild) this.runningChild.kill()
    return this.jobView(job)
  }

  async retryJob(id: string, sourceIds?: string[]): Promise<KnowledgeBuildJob> {
    if (this.runningJobId) throw new Error('已有知识构建任务正在运行')
    const job = this.loadJob(id)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('当前任务尚未结束')
    const requested = sourceIds?.length ? new Set(sourceIds) : undefined
    let count = 0
    for (const file of job.files) {
      if (
        (file.state === 'failed' || file.state === 'cancelled') &&
        (!requested || requested.has(file.sourceId))
      ) {
        file.state = 'queued'
        file.message = undefined
        file.artifactCount = 0
        file.chunkCount = 0
        count += 1
      }
    }
    if (!count) throw new Error('没有可重试的失败或已取消文件')
    job.cancelRequested = false
    job.status = 'queued'
    job.message = undefined
    job.updatedAt = now()
    this.saveJob(job)
    void this.runJob(id).catch((error) => {
      const failed = this.loadJob(id)
      failed.status = 'failed'
      failed.message = error instanceof Error ? error.message : '重试任务异常结束'
      failed.updatedAt = now()
      this.saveJob(failed)
      this.runningJobId = undefined
      this.runningChild = undefined
    })
    return this.jobView(job)
  }

  getArtifact(jobId: string, artifactId: string): KnowledgeArtifactDetail {
    const job = this.loadJob(jobId)
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    return this.loadArtifact(job, artifactId)
  }

  reviewArtifact(
    jobId: string,
    artifactId: string,
    status: Extract<KnowledgeArtifactStatus, 'pending' | 'approved' | 'rejected'>,
    confirmHumanReview = false
  ): KnowledgeBuildJob {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再审核')
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    const artifact = this.loadArtifact(job, artifactId)
    if (artifact.status === 'published') throw new Error('已发布产物不能改回审核状态')
    if (confirmHumanReview && status === 'approved') artifact.humanConfirmed = true
    // 恢复待审核只允许从已拒绝或已批准状态
    if (status === 'pending' && artifact.status === 'pending')
      throw new Error('该产物已处于待审核状态')
    artifact.status = status
    this.saveArtifact(job, artifact)
    job.updatedAt = now()
    this.saveJob(job)
    return this.jobView(job)
  }

  /** 批量审核：一次 IPC 完成全部状态变更，避免前端逐条调用的性能问题 */
  reviewArtifacts(
    jobId: string,
    artifactIds: string[] | undefined,
    status: Extract<KnowledgeArtifactStatus, 'approved' | 'rejected'>
  ): BatchReviewResult {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再审核')
    const targets = artifactIds?.length
      ? artifactIds
      : job.artifactIds.filter((id) => {
          const artifact = this.loadArtifact(job, id)
          return artifact.status === 'pending'
        })
    let processed = 0
    let skipped = 0
    let failed = 0
    const errors: string[] = []
    for (const id of targets) {
      try {
        const artifact = this.loadArtifact(job, id)
        if (artifact.status === 'published') {
          skipped += 1
          errors.push(`${id}：已发布产物不能修改`)
          continue
        }
        if (artifact.status === status) {
          skipped += 1
          continue
        }
        artifact.status = status
        this.saveArtifact(job, artifact)
        processed += 1
      } catch (error) {
        failed += 1
        errors.push(`${id}：${error instanceof Error ? error.message : '处理失败'}`)
      }
    }
    job.updatedAt = now()
    this.saveJob(job)
    return {
      job: this.jobView(job),
      processed,
      skipped,
      failed,
      errors: errors.slice(0, 10)
    }
  }

  /** 转换缓存清单（条目/来源/体积），供工坊展示 */
  cacheStats() {
    return this.conversionCache.stats()
  }

  /** 清空转换缓存；指定来源文件名时只清除该文件的条目 */
  clearConversionCache(sourceName?: string): { removed: number } {
    return this.conversionCache.clear(sourceName)
  }

  publish(jobId: string): VaultIndexResult {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再发布')
    const approved = job.artifactIds
      .map((id) => this.loadArtifact(job, id))
      .filter((artifact) => artifact.status === 'approved')
    // 发布门禁：能力边界（图推/图片题/表格待核）与配对待确认的产物，
    // 必须人工在审核中显式确认后才允许进入题库；未确认的一律拦下
    const { allowed, blocked } = partitionByPublishGate(approved)
    if (!approved.length) throw new Error('没有已批准且尚未发布的产物')
    if (!allowed.length)
      throw new Error(
        `没有可发布的产物：${blocked.length} 项处于能力边界限制（图形推理图片题/配对待确认等），` +
          '请在审核详情中查看原始页面并勾选人工确认后重试'
      )
    // 直导任务发布到目标库的「直导题库」子目录（活动用户库原位；内置示例库回退应用自管库）
    const isDirect = job.options.mode === 'direct'
    const activeVault = this.vaults.ensureBuiltinVault()
    const directToUserVault = isDirect && !activeVault.isBuiltin
    const targetRoot = directToUserVault ? activeVault.path : this.managedVaultDirectory
    const staged: Array<{ artifact: StoredArtifact; target: string; content: string }> = []
    // 严格只发布通过门禁的产物：blocked 项保持 approved 不落盘（此前误遍历 approved 会连
    // 未确认的受限产物一并写入题库，同时统计口径又报告其未发布）
    for (const artifact of allowed) {
      const directory = isDirect
        ? join(targetRoot, '直导题库')
        : join(
            this.managedVaultDirectory,
            artifact.kind === 'question' ? '题库' : '知识',
            artifact.subject
          )
      mkdirSync(directory, { recursive: true })
      const target = join(directory, `${safeTitle(artifact.title, artifact.id)}-${artifact.id}.md`)
      const content = artifact.markdown.replace(
        'reviewStatus: "pending"',
        'reviewStatus: "approved"'
      )
      staged.push({ artifact, target, content })
    }
    for (const item of staged) this.atomicWrite(item.target, item.content)
    // 结构解析产出的图片资产随 md 入库（材料内相对引用 images/…）：
    // 只拷贝普通图片文件，跳过 _regions.json/_pages.json 等 sidecar 与子目录
    const rawImagesDir = join(job.outputPath, 'raw', 'images')
    if (existsSync(rawImagesDir)) {
      const vaultImagesDir = join(targetRoot, '直导题库', 'images')
      mkdirSync(vaultImagesDir, { recursive: true })
      for (const imageName of readdirSync(rawImagesDir)) {
        if (!IMAGE_ASSET_PATTERN.test(imageName)) continue
        const from = join(rawImagesDir, imageName)
        try {
          if (!statSync(from).isFile()) continue
        } catch {
          continue
        }
        const to = join(vaultImagesDir, imageName)
        if (!existsSync(to)) copyFileSync(from, to)
      }
    }
    const result = this.vaults.connect(targetRoot)
    for (const item of staged) {
      item.artifact.status = 'published'
      this.saveArtifact(job, item.artifact)
    }
    job.status = 'completed'
    job.message = isDirect
      ? `已发布 ${staged.length} 题到${directToUserVault ? '当前题库' : '应用管理知识库'}的「直导题库」目录并完成重索引` +
        (blocked.length ? `；${blocked.length} 项因能力边界未发布，需人工确认` : '')
      : `已发布 ${staged.length} 个产物并切换到应用管理知识库`
    job.updatedAt = now()
    this.saveJob(job)
    return result
  }

  /** 撤销一次直导导入：删除该任务发布的题目文件并重索引（事后兜底） */
  revertImport(jobId: string): { removed: number } {
    const job = this.loadJob(jobId)
    if (job.options.mode !== 'direct') throw new Error('仅直导任务支持撤销导入')
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('任务运行中不能撤销')
    const published = job.artifactIds
      .map((id) => this.loadArtifact(job, id))
      .filter((artifact) => artifact.status === 'published')
    if (!published.length) throw new Error('该任务没有已发布的产物可撤销')
    const activeVault = this.vaults.ensureBuiltinVault()
    const targetRoot = activeVault.isBuiltin ? this.managedVaultDirectory : activeVault.path
    const importDirectory = join(targetRoot, '直导题库')
    let removed = 0
    for (const artifact of published) {
      const file = join(
        importDirectory,
        `${safeTitle(artifact.title, artifact.id)}-${artifact.id}.md`
      )
      if (existsSync(file)) {
        unlinkSync(file)
        removed += 1
      }
      artifact.status = 'rejected'
      artifact.warnings = [...artifact.warnings, '已撤销导入：文件已从题库移除']
      this.saveArtifact(job, artifact)
    }
    this.vaults.connect(targetRoot)
    job.status = 'completed'
    job.message = `已撤销本次导入：移除 ${removed} 个题目文件并重新索引`
    job.updatedAt = now()
    this.saveJob(job)
    return { removed }
  }

  private async runJob(id: string): Promise<void> {
    if (this.runningJobId) throw new Error('已有知识构建任务正在运行')
    this.runningJobId = id
    try {
      let job = this.loadJob(id)
      job.status = 'running'
      job.message =
        job.options.mode === 'direct'
          ? '文件处理中——批次完成后自动配对、去重并写入当前题库'
          : undefined
      job.updatedAt = now()
      this.saveJob(job)
      const engine = await this.engineStatus()
      if (!engine.available || !engine.pythonPath) throw new Error('MarkItDown 转换引擎不可用')
      const workerPath = this.workerPath()
      // 直导模式：批次内题本与解析/答案册先分拣，全部文件转换完后再统一合并发布
      const directBooks: Array<{
        sourceId: string
        relativePath: string
        questions: ReturnType<typeof parseQuestionBook>
        groups: Map<string, string>
        /** 图形推理图片优先通道产出（题本为图推时走专用合并） */
        graphic?: {
          items: ReturnType<typeof mergeGraphicQuestions>['items']
          itemWarnings: string[][]
          notes: string[]
          summary: string
        }
        /** 书级质量警告（数字异常/表格残缺/噪声剥离），随产物落审核页 */
        qualityWarnings?: string[]
        /** 混合卷里图推小题的选项图几何绑定提示（按 `${set}-${num}` 键控），绑定题一律进人工核对 */
        graphicNotes?: Map<string, string[]>
        /** 能力边界分类（题本通道） */
        capability?: ImportCapability
        /** 题本行 → 页映射（与 parseQuestionBook 消费的行数组平行；来源页证据） */
        linePageMap?: Array<number | undefined>
      }> = []
      // 能力边界保留通道：图推/图片题/无法结构化的资料——不生成题目，保留原始资料进人工审核
      const directPreservation: Array<{
        sourceId: string
        relativePath: string
        capability: ImportCapability
        summary: string
        docs: Array<{ id: string; title: string; markdown: string; warnings: string[] }>
        /** 保留文件的页清单页码（整页证据：preserved-page role） */
        pages?: number[]
      }> = []
      const directEssays: Array<{
        sourceId: string
        relativePath: string
        units: ParsedEssayUnit[]
        /** 行 → 页映射（与 parseEssayBook 消费的行数组平行） */
        linePageMap?: Array<number | undefined>
      }> = []
      // 无客观题书的面板提示线索：全文含训练式标题的行数（用于收尾时给出模式建议）
      let trainingMarkers = 0
      const directSolutions = new Map<string, ParsedSolution>()
      // 解析册行 → 页映射（与 directSolutions 的行号对齐；解析册是独立文件独立转换）
      const solutionPageMaps = new Map<string, Array<number | undefined>>()
      // 解析条目 → 解析册 sourceId（来源证据按题本/解析册分别记录）
      const solutionSourceOf = new Map<string, string>()
      const subject = job.options.subject === 'auto' ? 'xingce' : job.options.subject
      const subjectLabel =
        subject === 'xingce' ? '行测' : subject === 'shenlun' ? '申论' : '公共知识'
      for (const entry of job.files) {
        job = this.loadJob(id)
        if (job.cancelRequested) break
        const file = job.files.find((candidate) => candidate.sourceId === entry.sourceId)
        if (!file || file.state !== 'queued') continue
        job.currentFile = file.relativePath
        file.state = 'converting'
        file.message = '正在转换为 Markdown'
        job.updatedAt = now()
        this.saveJob(job)
        try {
          const source = this.resolveSourceFile(job, file)
          const rawPath = join(job.outputPath, 'raw', `${file.sourceId}.md`)
          // PDF 始终由 OCR worker 处理：worker 内部逐页判断文字层是否足够，
          // 文字层页直接使用原始文本，扫描页 OCR，混合 PDF 不漏识别；
          // MarkItDown 首跑的结果必然被覆盖，OCR 可用时不再先跑一遍。
          // 解析册/答案册是纯文本流：结构重排会挤压相邻题块（实测解析串题、配对校验失效），
          // 题本保留结构化的表格/图片保真，解析册直接走逐页 OCR。
          const useStructured =
            engine.structuredParseAvailable &&
            isPdfFile(file.relativePath) &&
            !/解析|答案/.test(basename(file.relativePath))
          const useOcr = engine.ocrAvailable && isPdfFile(file.relativePath)
          let structuredOk: boolean | undefined = true
          const converter = useStructured
            ? `structured@${STRUCTURED_PACKAGE}`
            : useOcr
              ? `ocr@${OCR_PACKAGES.join('+')}`
              : `markitdown@${MARKITDOWN_VERSION}`
          // 兜底回退 OCR 时改用 ocr@ 键缓存，structured@ 键留待重试
          let effectiveConverter = converter
          let ocrQuality: OcrQualityReport | undefined
          // 每文件转换/恢复前只清理上一文件残留的 sidecar（页映射按文件生成，旧文件的
          // _regions.json/_pages.json 会误导当前文件的行→页映射）；raw/images 目录整体保留，
          // 同批多文件的图片都要完整留存到 publish()
          for (const sidecar of ['_regions.json', '_pages.json'])
            rmSync(join(job.outputPath, 'raw', 'images', sidecar), { force: true })
          // 「忽略缓存重新转换」：跳过缓存读取（结果照常写回），排查识别问题时使用
          const cached = job.options.ignoreConversionCache
            ? undefined
            : await this.conversionCache.fetch(source, converter)
          if (cached) {
            copyFileSync(cached.markdownPath, rawPath)
            // 结构解析命中：把缓存的图片归档恢复到任务 raw/images（同名覆盖，不清空目录），
            // 否则 markdown 引用悬空
            if (cached.imagesDir) {
              try {
                const imagesTarget = join(dirname(rawPath), 'images')
                mkdirSync(imagesTarget, { recursive: true })
                for (const name of readdirSync(cached.imagesDir)) {
                  copyFileSync(join(cached.imagesDir, name), join(imagesTarget, name))
                }
              } catch {
                // 图片恢复失败只影响图表附件，不阻塞文本管线
              }
            }
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            if (job.cancelRequested) throw new Error('任务已取消')
            ocrQuality = cached.ocrQuality
          } else if (useStructured) {
            file.message = '结构解析中（表格还原 / 图形保真）'
            this.saveJob(job)
            const structuredResult = await this.structuredConvert(
              engine.pythonPath,
              source,
              rawPath
            )
            structuredOk = structuredResult.ok
            if (structuredResult.quality) ocrQuality = structuredResult.quality
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            if (job.cancelRequested) throw new Error('任务已取消')
            if (!structuredOk) {
              // 结构解析失败：回退逐页 OCR 保证批次不中断；兜底结果按 ocr@ 键缓存，
              // structured@ 键留待重试——错存会让毒缓存永久短路结构解析
              effectiveConverter = `ocr@${OCR_PACKAGES.join('+')}`
              file.message = '结构解析不可用，回退 OCR 识别'
              this.saveJob(job)
              ocrQuality = await this.ocrConvert(job, file, engine.pythonPath, source, rawPath)
              job.cancelRequested ||= this.loadJob(id).cancelRequested
              if (job.cancelRequested) throw new Error('任务已取消')
            }
          } else if (!useOcr) {
            file.message = '正在转换为 Markdown'
            this.saveJob(job)
            await this.convert(engine.pythonPath, workerPath, source, rawPath)
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            if (job.cancelRequested) throw new Error('任务已取消')
          } else {
            file.message = `正在逐页检测文字层并识别${this.ocrAcceleratorMode() === 'dml' ? '（GPU 加速）' : ''}`
            this.saveJob(job)
            ocrQuality = await this.ocrConvert(job, file, engine.pythonPath, source, rawPath)
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            if (job.cancelRequested) throw new Error('任务已取消')
          }
          if (statSync(rawPath).size > MAX_RAW_MARKDOWN_BYTES)
            throw new Error(
              useStructured || useOcr
                ? 'OCR 结果超过 20 MB，请先拆分原文件'
                : '转换结果超过 20 MB，请先拆分原文件'
            )
          if (!cached)
            await this.conversionCache.store(
              source,
              effectiveConverter,
              rawPath,
              ocrQuality,
              useStructured && structuredOk ? join(dirname(rawPath), 'images') : undefined
            )
          // 文件名没带「解析/答案」字样的解析册兜底：转换完成后按参考答案标记密度识别，
          // 改用逐页 OCR 文本切块（结果按 ocr@ 键缓存，此后秒级复用）
          if (useStructured) {
            const structuredText = readFileSync(rawPath, 'utf8')
            if ((structuredText.match(/【参考答案(及正确率)?】/g) ?? []).length >= 3) {
              file.message = '解析册：结构重排不利切块，改用逐页 OCR 文本'
              this.saveJob(job)
              const ocrConverterKey = `ocr@${OCR_PACKAGES.join('+')}`
              const ocrCached = await this.conversionCache.fetch(source, ocrConverterKey)
              if (ocrCached) {
                copyFileSync(ocrCached.markdownPath, rawPath)
                ocrQuality = ocrCached.ocrQuality
              } else {
                ocrQuality = await this.ocrConvert(job, file, engine.pythonPath, source, rawPath)
                await this.conversionCache.store(source, ocrConverterKey, rawPath, ocrQuality)
              }
              job.cancelRequested ||= this.loadJob(id).cancelRequested
              if (job.cancelRequested) throw new Error('任务已取消')
            }
          }
          const raw = readFileSync(rawPath, 'utf8').trim()
          file.fromCache = Boolean(cached)
          // 保存质量报告到文件元数据
          if (ocrQuality) {
            file.ocrQuality = ocrQuality
            const parts = [
              `${ocrQuality.textLayerPages}/${ocrQuality.totalPages} 页文字层`,
              ocrQuality.ocrPages > 0 ? `${ocrQuality.ocrPages} 页 OCR` : null,
              ocrQuality.emptyPages > 0 ? `${ocrQuality.emptyPages} 页空白` : null,
              ocrQuality.averageConfidence
                ? `平均置信度 ${(ocrQuality.averageConfidence * 100).toFixed(0)}%`
                : null
            ].filter(Boolean)
            file.message = `${cached ? '缓存命中' : '转换完成'}：${parts.join(' · ')}`
          } else if (cached) {
            file.message = '缓存命中：复用上次转换结果'
          }
          if (raw.length < 50)
            throw new Error(
              engine.ocrAvailable
                ? 'OCR 后仍未提取到足够文本，请确认文件内容清晰后重试'
                : '没有提取到足够文本，文件可能是扫描件；安装 OCR 组件后可自动识别'
            )
          file.state = 'converted'
          file.message = cached
            ? ocrQuality?.structured
              ? '缓存命中：结构解析结果已复用（图表保真）'
              : ocrQuality?.averageConfidence
                ? `缓存命中：平均置信度 ${(ocrQuality.averageConfidence * 100).toFixed(0)}%`
                : '缓存命中：复用上次转换结果'
            : useStructured
              ? '结构解析完成（表格还原 / 图形保真）'
              : 'Markdown 转换完成'
          this.saveJob(job)
          if (job.options.mode === 'direct') {
            // 页清单（OCR=_pages.json / structured=_regions.json 派生）：行→页映射与来源证据
            // 结构解析失败回退 OCR 时 images/ 下是 _pages.json 而非 _regions.json——
            // 两种 sidecar 都要尝试，否则回退批次全部页映射丢失
            const imagesDir = join(dirname(rawPath), 'images')
            let pageManifest: PageManifest | undefined
            const structuredRegions = loadStructuredRegions(imagesDir)
            if (useStructured && structuredRegions) {
              pageManifest = manifestFromRegions(structuredRegions.regions)
            }
            if (!pageManifest) {
              pageManifest = parsePageManifest(readFileSyncSafe(join(imagesDir, '_pages.json')))
            }
            const { lines: directLines, pageMap: fileLinePageMap } = toLinesWithPageMap(
              raw,
              pageManifest
            )
            const solutionMarks = (raw.match(/【参考答案(及正确率)?】/g) ?? []).length
            // 质量模型：数字异常/表格结构/噪声剥离按书统计——只告警不静默修正
            const numeric = scanNumericAnomalies(directLines)
            const tables = scanTableQuality(raw)
            const qualityWarnings = [
              ...(numeric.count ? [`数字异常 ${numeric.count} 处，请人工核对`] : []),
              ...(tables.tables && tables.ragged
                ? [`表格列数不一致 ${tables.ragged}/${tables.tables}，请对照原图`]
                : []),
              ...(ocrQuality?.removedNoiseLines
                ? [`已剥离页眉/水印文本 ${ocrQuality.removedNoiseLines} 处`]
                : [])
            ]
            if (ocrQuality)
              for (const warning of qualityWarnings)
                if (!ocrQuality.warnings.includes(warning)) ocrQuality.warnings.push(warning)
            if (solutionMarks >= 3) {
              const solutions = parseSolutionBook(directLines)
              for (const [key, value] of solutions) {
                directSolutions.set(key, value)
                solutionSourceOf.set(key, file.sourceId)
              }
              solutionPageMaps.set(file.sourceId, fileLinePageMap)
              file.state = 'ready'
              file.message = `解析册：提取 ${solutions.size} 条参考答案`
            } else {
              const questions = parseQuestionBook(directLines)
              const essays = parseEssayBook(directLines)
              const fileTrainingMarks =
                solutionMarks === 0 ? countEssayTrainingMarks(directLines) : 0
              trainingMarkers += fileTrainingMarks
              // 通道按产出规模择优：申论书的 OCR 残渣常让客观题解析器切出个位数伪题，
              // 按"客观题>0 就走客观题"会把整本申论错送管线（实测夸夸刷 58 单元 vs 3 伪题）。
              // 反向同理，行测题本的偶发训练字样不会盖过数百道客观题。
              // 图形推理图片优先通道：题号+图片页充足而文字选项通道失灵时走图推绑定，
              // 图片选项不再因没有文字标签而整批丢弃（低置信度带警告进人工审核）
              const regions = useStructured
                ? loadStructuredRegions(join(dirname(rawPath), 'images'))
                : undefined
              const graphicCandidate = regions ? isGraphicCandidate(regions) : false
              const graphic =
                graphicCandidate && GRAPHIC_AUTO_STRUCTURE.enabled
                  ? extractGraphicQuestions(regions!)
                  : undefined
              const textUsable = questions.filter((question) => question.options.length >= 2).length
              // 混合试卷（行测整卷）同样满足"题号+图片页充足"，但文字通道健康时不能整文件
              // 送进图推保留通道——只有文字通道近乎失灵才按纯图推题本处理
              const graphicOnly = graphicCandidate && textUsable < GRAPHIC_ONLY_MAX_TEXT_QUESTIONS
              if (graphicOnly && !GRAPHIC_AUTO_STRUCTURE.enabled) {
                // 能力边界收敛：图形推理默认不做自动结构化（实验性绑定默认关闭）——
                // 逐页保留原始页面图片与 OCR 文字，进人工审核；资料不丢失、能力边界诚实可见
                const pages = buildGraphicPreservation(regions!, file.relativePath)
                directPreservation.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  capability: 'graphic-review',
                  docs: pages.map((page) => ({
                    id: page.id,
                    title: page.title,
                    markdown: page.markdown,
                    warnings: [...page.warnings, ...qualityWarnings]
                  })),
                  summary: `图形推理图片题 · 暂不支持自动结构化：已保留 ${pages.length} 页原始页面，请人工审核`,
                  pages: (pageManifest?.pages ?? []).map((page) => page.pageNumber)
                })
                file.state = 'ready'
                file.message = `${CAPABILITY_LABELS['graphic-review']} · 已保留 ${pages.length} 页原始页面，请人工审核`
              } else if (
                graphic &&
                graphic.questions.length >= 3 &&
                textUsable < graphic.questions.length
              ) {
                const merged = mergeGraphicQuestions(
                  graphic.questions,
                  directSolutions,
                  {
                    subject,
                    category: `${subjectLabel}-直导题库`,
                    sourceFile: file.relativePath,
                    tags: job.options.tags
                  },
                  graphic.notes
                )
                directBooks.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  questions: graphic.questions,
                  groups: parseAnswerGroups(directLines),
                  graphic: {
                    items: merged.items,
                    itemWarnings: merged.itemWarnings,
                    notes: graphic.notes,
                    summary: `图推：切出 ${graphic.questions.length} 题（整图版式 ${graphic.singleFigureGroups}、四图绑定 ${graphic.boundOptionGroups}、待人工核对 ${graphic.incompleteOptionQuestions}、未绑定图片 ${graphic.unboundImages}）`
                  },
                  qualityWarnings,
                  capability: 'graphic-review',
                  linePageMap: fileLinePageMap
                })
                file.state = 'ready'
                file.message = `${CAPABILITY_LABELS['graphic-review']} · ${graphic.questions.length} 题走实验性图形通道（发布需人工确认）`
              } else if (essays.units.length >= questions.length && essays.units.length > 0) {
                directEssays.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  units: essays.units,
                  linePageMap: fileLinePageMap
                })
                file.state = 'ready'
                file.message = `切出 ${essays.units.length} 道申论题（无参考答案），批次结束后生成待审核产物`
              } else if (questions.length === 0 && fileTrainingMarks === 0) {
                // 能力边界降级：无题可切——保留原始资料与诊断信息，不硬造题目
                const figureImages =
                  regions?.regions.filter((r) => r.type === 'image' && r.imgPath).length ?? 0
                const capability: ImportCapability =
                  useStructured && figureImages >= 5
                    ? 'image-only-review'
                    : 'unsupported-auto-structure'
                directPreservation.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  capability,
                  pages: (pageManifest?.pages ?? []).map((page) => page.pageNumber),
                  summary: CAPABILITY_LABELS[capability],
                  docs: [
                    {
                      id: `kb-${hash(`preserve${file.relativePath}`).slice(0, 19)}`,
                      title: '保留原始资料 · 未能自动结构化',
                      markdown: [
                        '---',
                        'kind: "document"',
                        'category: "原始资料"',
                        'generatedBy: "direct-import"',
                        '---',
                        '',
                        '# 保留原始资料',
                        '',
                        capability === 'image-only-review'
                          ? '本资料主要内容为图片，系统已保留全部页面图片与 OCR 文本，不自动生成可发布题目。'
                          : '当前资料无法可靠结构化，系统仅保留原始资料与诊断信息。',
                        '',
                        '## 转换文本（节选）',
                        '',
                        raw.slice(0, 2000)
                      ].join('\n'),
                      warnings: [
                        CAPABILITY_LABELS[capability],
                        '原始 PDF、OCR 文本与页面图片均已保留，请人工处理后入库。'
                      ]
                    }
                  ]
                })
                file.state = 'ready'
                file.message = `${CAPABILITY_LABELS[capability]} · 原始资料已保留`
              } else {
                const capability = classifyFileCapability({
                  structured: useStructured,
                  questionCount: questions.length,
                  completeCount: textUsable,
                  tableCount: tables.tables,
                  numericAnomalies: numeric.count,
                  graphicCandidate: false,
                  figureImages: 0,
                  solutionMarks
                })
                // 混合卷里的图推小题：按版面坐标把选项图绑上（结构解析产物才有坐标）
                const binding = regions
                  ? bindGraphicOptionsByGeometry(questions, regions)
                  : undefined
                directBooks.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  questions,
                  groups: parseAnswerGroups(directLines),
                  qualityWarnings,
                  graphicNotes: binding?.notes,
                  capability,
                  linePageMap: fileLinePageMap
                })
                const bindingNote =
                  binding &&
                  binding.bound + binding.partial + binding.stemOnly + binding.skipped > 0
                    ? `，图推 ${binding.bound + binding.partial + binding.stemOnly} 题已附图（待核对 ${binding.skipped} 题）`
                    : ''
                file.state = 'ready'
                file.message = `${CAPABILITY_LABELS[capability]} · 切出 ${questions.length} 题${bindingNote}，批次结束后自动合并发布`
              }
            }
          } else if (job.options.mode === 'convert-only') {
            file.state = 'ready'
            file.message = '原始 Markdown 已保存在任务目录'
          } else {
            file.state = 'organizing'
            file.message = '正在由模型提炼并校验'
            this.saveJob(job)
            const artifacts = await this.organize(job, file, raw)
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            for (const artifact of artifacts) {
              this.saveArtifact(job, artifact)
              if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
            }
            file.artifactCount = artifacts.length
            file.state = 'ready'
            file.message = artifacts.length
              ? `生成 ${artifacts.length} 个待审核产物`
              : '未发现足够完整、可入库的内容'
          }
        } catch (error) {
          job.cancelRequested ||= this.loadJob(id).cancelRequested
          file.state = job.cancelRequested ? 'cancelled' : 'failed'
          file.message = error instanceof Error ? error.message : '处理失败'
        }
        job.currentFile = undefined
        job.updatedAt = now()
        this.saveJob(job)
      }
      job = this.loadJob(id)
      if (job.cancelRequested) {
        for (const file of job.files) if (file.state === 'queued') file.state = 'cancelled'
        job.status = 'cancelled'
        job.message = '任务已取消，已完成的转换和审核产物仍被保留'
      } else if (job.options.mode === 'direct') {
        // 两段式：先切题+配对校验生成待审核产物（不落库），抽查后经「全部批准→发布」入库
        let staged = 0
        let skippedNoAnswer = 0
        let skippedIncomplete = 0
        let skippedMisaligned = 0
        let skippedDuplicate = 0
        let abortedBooks = 0
        // 去重基准：当前活动题库（发布目标与之一致）
        const activeVault = this.vaults.ensureBuiltinVault()
        const targetRoot = activeVault.isBuiltin ? this.managedVaultDirectory : activeVault.path
        const existingSignatures = this.vaults.questionSignatures(targetRoot)
        const batchSeen = new Set<string>()
        // 能力边界保留通道：图推/图片题/无法结构化的资料——不生成题目，保留原始资料进人工审核
        for (const preserved of directPreservation) {
          const bookFile = job.files.find((file) => file.sourceId === preserved.sourceId)
          let preservedStaged = 0
          for (const doc of preserved.docs) {
            if (batchSeen.has(doc.id)) {
              skippedDuplicate += 1
              continue
            }
            batchSeen.add(doc.id)
            const artifact: StoredArtifact = {
              id: doc.id,
              jobId: job.id,
              sourceId: preserved.sourceId,
              sourcePath: preserved.relativePath,
              relativeSourcePath: preserved.relativePath,
              kind: 'document',
              subject,
              title: safeTitle(doc.title, doc.id),
              category: '原始资料',
              confidence: 1,
              generatedBy: 'direct-import',
              status: 'pending',
              warnings: doc.warnings,
              preview: doc.title,
              markdown: doc.markdown,
              evidenceExcerpt: doc.title,
              capability: preserved.capability,
              // 整页证据：保留文件的全部页清单页（无法定位具体页时 unavailable，不猜）
              sourceEvidence: buildSourceEvidence({
                references: (preserved.pages ?? []).length
                  ? ([
                      {
                        role: 'preserved-page',
                        sourceId: preserved.sourceId,
                        relativePath: preserved.relativePath,
                        exactPages: preserved.pages ?? []
                      }
                    ] as ReferenceBuildInput[])
                  : []
              })
            }
            this.saveArtifact(job, artifact)
            if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
            staged += 1
            preservedStaged += 1
          }
          if (bookFile) {
            bookFile.state = 'ready'
            bookFile.artifactCount = preservedStaged
            bookFile.message = preserved.summary
          }
        }
        for (const book of directBooks) {
          const bookFile = job.files.find((file) => file.sourceId === book.sourceId)
          if (book.graphic) {
            // 图形通道：不套用客观题「无答案即丢」的门槛——未配到答案的题目
            // 带警告进入待审核，由人工决定是否发布（不静默删除）
            let graphicStaged = 0
            for (const [index, item] of book.graphic.items.entries()) {
              const signature = directSignature(
                item.stem,
                item.material ?? '',
                item.options[0]?.text ?? ''
              )
              if (existingSignatures.has(signature) || batchSeen.has(signature)) {
                skippedDuplicate += 1
                continue
              }
              batchSeen.add(signature)
              const artifact: StoredArtifact = {
                id: item.id,
                jobId: job.id,
                sourceId: book.sourceId,
                sourcePath: book.relativePath,
                relativeSourcePath: book.relativePath,
                kind: 'question',
                subject,
                title: safeTitle(item.stem.slice(0, 60), '未命名题目'),
                category: item.category,
                confidence: 1,
                generatedBy: 'direct-import',
                status: 'pending',
                warnings: [
                  ...(book.qualityWarnings ?? []),
                  ...(book.graphic.itemWarnings[index] ?? [])
                ],
                preview: item.stem.slice(0, 180),
                markdown: directQuestionMarkdown(item),
                evidenceExcerpt: item.stem.slice(0, 80),
                capability: 'graphic-review'
              }
              this.saveArtifact(job, artifact)
              if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
              staged += 1
              graphicStaged += 1
            }
            if (bookFile) {
              bookFile.state = 'ready'
              bookFile.artifactCount = graphicStaged
              bookFile.message = `${book.graphic.summary} · 入库待审核 ${graphicStaged} 题`
            }
            continue
          }
          let merged = mergeDirectQuestions(book.questions, directSolutions, book.groups, {
            subject,
            category: `${subjectLabel}-直导题库`,
            sourceFile: book.relativePath,
            tags: job.options.tags,
            solutionSourceOf
          })
          // 顺序配对兜底：套号钥匙配对失败（中止或近零产出）而解析册有答案时，
          // 按文档顺序位置配对，并用题干相似度逐对验证——两本书的题目顺序天然一致
          if ((merged.aborted || merged.items.length === 0) && directSolutions.size > 0) {
            const sequential = mergeByDocumentOrder(book.questions, directSolutions, {
              subject,
              category: `${subjectLabel}-直导题库`,
              sourceFile: book.relativePath,
              tags: job.options.tags
            })
            if (sequential.items.length > merged.items.length) {
              merged = {
                items: sequential.items,
                skippedNoAnswer: sequential.skippedNoAnswer,
                skippedIncomplete: sequential.skippedIncomplete,
                skippedMisaligned: sequential.skippedMisaligned,
                verifiable: sequential.verified,
                verifiedPassed: sequential.verifiedPassed,
                offsetAdjustedSets: sequential.offsetAdjustedSets,
                aborted: false
              }
              if (bookFile) {
                bookFile.message = `套号配对失败，已按文档顺序配对 ${sequential.items.length} 题${
                  sequential.offsetAdjustedSets
                    ? `（${sequential.offsetAdjustedSets} 套内错位已按相似度校正）`
                    : ''
                }`
              }
            }
          }
          if (merged.aborted) {
            // 整书对齐率过低：题本与解析册疑似套号错位，拦截防止题目批量配错答案
            abortedBooks += 1
            if (bookFile) {
              bookFile.state = 'failed'
              bookFile.message = `配对校验拦截：${merged.verifiable} 题可验证中对齐率过低（剔除 ${merged.skippedMisaligned} 题），题本与解析疑似套号错位，请核对两册的套号是否一致`
            }
            continue
          }
          skippedNoAnswer += merged.skippedNoAnswer
          skippedIncomplete += merged.skippedIncomplete
          skippedMisaligned += merged.skippedMisaligned
          // 配对待确认：可验证配对全部未通过相似度校验——答案可能整体错位，
          // 状态上明确标注，不允许当成普通可发布题目
          const pairingUnconfirmed =
            merged.verifiable > 0 &&
            (merged.verifiedPassed ?? merged.verifiable - merged.skippedMisaligned) === 0
          const offsetAdjusted = merged.offsetAdjustedSets ?? 0
          // 共享材料级警告只在每组第一题显示一次（不重复到组内每道题）
          const materialWarnedGroups = new Set<string>()
          let bookStaged = 0
          for (const item of merged.items) {
            // 与 listQuestionSignatures 同口径：共享材料参与去重，资料分析题不因漏传材料而重复入库
            const signature = directSignature(
              item.stem,
              item.material ?? '',
              item.options[0]?.text ?? ''
            )
            if (existingSignatures.has(signature) || batchSeen.has(signature)) {
              skippedDuplicate += 1
              continue
            }
            batchSeen.add(signature)
            const markdown = directQuestionMarkdown(item)
            const groupFirst = !item.groupId || !materialWarnedGroups.has(item.groupId)
            if (item.groupId) materialWarnedGroups.add(item.groupId)
            // 图推题一律按能力边界进人工核对（不自动发布）：凡几何绑定产生提示的题
            // （含"分为两类"文字选项 stemOnly、兜底 partial、绑定失败 skipped）都需人工核对，
            // 不得以 text-supported 绕过审核
            const graphicNotes = book.graphicNotes?.get(`${item.set}-${item.num}`) ?? []
            const needsGraphicReview =
              graphicNotes.length > 0 || item.options.some((option) => option.image)
            const artifact: StoredArtifact = {
              id: item.id,
              jobId: job.id,
              sourceId: book.sourceId,
              sourcePath: book.relativePath,
              relativeSourcePath: book.relativePath,
              kind: 'question',
              subject,
              title: safeTitle(item.stem.slice(0, 60), '未命名题目'),
              category: item.category,
              confidence: 1,
              generatedBy: 'direct-import',
              status: 'pending',
              warnings: [
                ...(groupFirst ? (book.qualityWarnings ?? []) : []),
                ...(pairingUnconfirmed
                  ? ['配对待确认：题本与解析未通过相似度校验，答案需人工核对']
                  : []),
                ...(offsetAdjusted ? ['答案已通过相似度校正，建议抽查'] : []),
                ...(item.cleanupWarnings ?? []),
                ...graphicNotes
              ],
              capability: needsGraphicReview ? 'graphic-review' : book.capability,
              preview: item.stem.slice(0, 180),
              markdown,
              evidenceExcerpt: item.stem.slice(0, 80),
              sourceEvidence: this.buildArtifactEvidence(
                item,
                book.sourceId,
                book.relativePath,
                book.linePageMap,
                solutionPageMaps
              )
            }
            this.saveArtifact(job, artifact)
            if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
            staged += 1
            bookStaged += 1
          }
          if (bookFile) {
            const verifiedPassed =
              merged.verifiedPassed ?? merged.verifiable - merged.skippedMisaligned
            bookFile.state = 'ready'
            bookFile.artifactCount = bookStaged
            bookFile.message = `切出 ${bookStaged} 题${
              merged.verifiable
                ? `，配对校验 ${verifiedPassed}/${merged.verifiable} 通过${
                    pairingUnconfirmed ? '（配对待确认）' : ''
                  }`
                : ''
            }${book.qualityWarnings?.length || pairingUnconfirmed ? ' · 需要人工抽查' : ''}`
          }
        }
        // 申论直导通道：主观题没有标准答案也允许入库——「申论作答」页对空参考要点有
        // AI 批改兜底，硬卡答案会把这两类教材永远挡在门外（validateCandidate 仅约束模型提炼路径）
        let stagedEssays = 0
        for (const book of directEssays) {
          const bookFile = job.files.find((file) => file.sourceId === book.sourceId)
          let bookStaged = 0
          for (const unit of book.units) {
            const item: DirectQuestion = {
              id: `kb-e${hash(`${book.relativePath}\n${unit.chapter}\n${compact(unit.stem).slice(0, 120)}`).slice(0, 19)}`,
              set: 1,
              num: unit.seq,
              subject: 'shenlun',
              category: unit.chapter || '申论综合',
              tags: [...new Set([...job.options.tags, ...(unit.chapter ? [unit.chapter] : [])])],
              sourceFile: book.relativePath,
              year: unit.year,
              paper: unit.paper,
              questionType: 'essay',
              difficulty: 3,
              stem: unit.stem,
              options: [],
              answer: [],
              explanation: unit.explanation || '暂无参考答案；可在「申论作答」页配合 AI 批改练习。',
              material: unit.material
            }
            // 与库内签名同口径：材料参与去重，避免跨批次重复导入同一篇训练
            const signature = directSignature(item.stem, item.material ?? '', '')
            if (existingSignatures.has(signature) || batchSeen.has(signature)) {
              skippedDuplicate += 1
              continue
            }
            batchSeen.add(signature)
            const markdown = directQuestionMarkdown(item)
            const artifact: StoredArtifact = {
              id: item.id,
              jobId: job.id,
              sourceId: book.sourceId,
              sourcePath: book.relativePath,
              relativeSourcePath: book.relativePath,
              kind: 'question',
              subject: 'shenlun',
              title: safeTitle(unit.title || unit.stem.slice(0, 40), '未命名题目'),
              category: item.category,
              confidence: 1,
              generatedBy: 'direct-import',
              status: 'pending',
              warnings: unit.explanation
                ? []
                : ['暂无参考答案，建议在备考开始前用 AI 批改补齐要点'],
              preview: unit.stem.slice(0, 180),
              markdown,
              evidenceExcerpt: unit.stem.slice(0, 80),
              sourceEvidence: this.buildArtifactEvidence(
                { lineStart: unit.lineStart },
                book.sourceId,
                book.relativePath,
                book.linePageMap,
                solutionPageMaps
              )
            }
            this.saveArtifact(job, artifact)
            if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
            staged += 1
            stagedEssays += 1
            bookStaged += 1
          }
          if (bookFile) {
            bookFile.state = 'ready'
            bookFile.artifactCount = bookStaged
            bookFile.message = `切出 ${bookStaged} 道申论题${
              bookStaged ? '（无参考答案，练习配合 AI 批改）' : ''
            }`
          }
        }
        job.status = staged > 0 ? 'review' : 'completed'
        // 批次质量汇总：只用可观测事实（真实计数与转换报告页数），不推算不猜
        const allArtifacts = job.artifactIds
          .map((id) => this.loadArtifact(job, id))
          .filter((a): a is StoredArtifact => Boolean(a))
        // 产物级质量分层持久化（kind + capability 派生，与审核页展示一致）
        for (const artifact of allArtifacts) {
          artifact.importQualityTier = tierForArtifact(artifact)
          this.saveArtifact(job, artifact)
        }
        // 来源证据页渲染（job 内去重 + 容量上限；.md 源等失败不阻塞）
        const persistedEvidencePages = await this.renderJobEvidence(job, allArtifacts)
        // 任务级 VLM 批量预精校（次路径，默认关闭）：仅当新建任务时显式勾选且总开关已开启，
        // 只处理表格/数字异常页；失败不阻塞批次，结果如实写进任务消息
        let vlmProofreadNote = ''
        if (job.options.enableVlmProofread) {
          try {
            const stats = await this.autoVlmPreproofread(job, allArtifacts)
            if (stats.calls > 0 || stats.failedPages > 0)
              vlmProofreadNote =
                ` [VLM 预精校] 已精校 ${stats.pages} 个异常页（${stats.applied} 个产物已修订，均需人工复核）` +
                (stats.uncoveredArtifacts
                  ? `，同页另有 ${stats.uncoveredArtifacts} 道独立题未覆盖（请在审核页逐题精校）`
                  : '') +
                (stats.failedPages
                  ? `，${stats.failedPages} 页精校失败（可在审核页单页重试）`
                  : '') +
                (stats.skippedPages ? `，其余 ${stats.skippedPages} 页可在审核页按需单页精校` : '')
          } catch (error) {
            vlmProofreadNote = ` [VLM 预精校失败] ${error instanceof Error ? error.message : '未知错误'}`
          }
        }
        // 页数事实统一走 collectPageFacts（唯一规则：有效性 + 空白页钳制）
        const pageFacts = collectPageFacts(job.files)
        const facts: ImportBatchFacts = {
          fileCount: job.files.length,
          failedFileCount: job.files.filter((file) => file.state === 'failed').length,
          filesWithKnownPages: pageFacts.filesWithKnownPages,
          knownInputPages: pageFacts.knownInputPages,
          knownEmptyPages: pageFacts.knownEmptyPages,
          structuredArtifacts: allArtifacts.filter((a) => a.importQualityTier === 'structured')
            .length,
          reviewRequiredArtifacts: allArtifacts.filter(
            (a) => a.importQualityTier === 'review-required'
          ).length,
          preservedSourceArtifacts: allArtifacts.filter(
            (a) => a.importQualityTier === 'preserved-source'
          ).length,
          skippedNoAnswer,
          skippedIncomplete,
          skippedMisaligned,
          skippedDuplicate,
          abortedBooks,
          inconsistentQualityReports: pageFacts.inconsistentQualityReports
        }
        job.message =
          (staged
            ? `已切出 ${staged} 题${
                stagedEssays
                  ? `，其中申论主观题 ${stagedEssays} 道（无参考答案，发布后经「申论作答」页 AI 批改练习）`
                  : ''
              }（配对验证错位剔除 ${skippedMisaligned}、无答案跳过 ${skippedNoAnswer}、不完整 ${skippedIncomplete}、与现有题库重复 ${skippedDuplicate}）——请抽查后「全部批准」并「发布」入库${
                abortedBooks ? `；${abortedBooks} 本书因疑似套号错位被拦截` : ''
              }`
            : skippedDuplicate
              ? `直导完成：${skippedDuplicate} 题与现有题库重复，未生成新题${abortedBooks ? `；${abortedBooks} 本书因疑似套号错位被拦截` : ''}`
              : abortedBooks
                ? `直导完成：全部题本被配对校验拦截（疑似套号错位），未生成产物`
                : trainingMarkers >= 3
                  ? `直导完成：检测到 ${trainingMarkers} 处训练式标题但未能稳定切分出题目——这本书大概率是主观题教材，请改用「模型提炼」模式导入`
                  : '直导完成：未切出题目（未识别出题目或全部缺少答案）') +
          ` [质量] ${batchFactsMessage(facts)}` +
          ` [来源] ${traceCoverageMessage(computeTraceCoverage(allArtifacts, persistedEvidencePages))}` +
          vlmProofreadNote
      } else {
        const artifacts = job.artifactIds.map((artifactId) => this.loadArtifact(job, artifactId))
        job.status = artifacts.some((artifact) => artifact.status === 'pending')
          ? 'review'
          : 'completed'
        job.message = artifacts.length
          ? '批次处理完成，请逐项审核后发布'
          : '批次处理完成，未生成待发布产物'
      }
      job.currentFile = undefined
      job.updatedAt = now()
      this.saveJob(job)
    } finally {
      this.runningJobId = undefined
      this.runningChild = undefined
    }
  }

  private async organize(
    job: StoredJob,
    file: KnowledgeBuildFile,
    raw: string
  ): Promise<StoredArtifact[]> {
    const chunks = chunkText(raw)
    if (!chunks.length) return []
    file.chunkCount = chunks.length
    const artifacts: StoredArtifact[] = []
    const seen = new Set<string>()
    for (let index = 0; index < chunks.length; index += 1) {
      const latest = this.loadJob(job.id)
      if (latest.cancelRequested) break
      const chunk = chunks[index]!
      file.message = `模型整理 ${index + 1}/${chunks.length}`
      this.saveJob(job)
      const context = taskDataEnvelope('知识整理任务参数', {
        sourceFile: file.relativePath,
        chunk: { current: index + 1, total: chunks.length },
        outputMode: job.options.mode,
        defaultSubject: job.options.subject,
        batchTags: job.options.tags,
        customInstruction: job.options.instruction || ''
      })
      const extracted = await this.ai.ask(
        {
          purpose: 'knowledge',
          messages: [
            { role: 'system', content: FEATURE_PROMPTS.knowledgeExtract },
            { role: 'user', content: `${context}\n${sourceEnvelope(file.relativePath, chunk)}` }
          ]
        },
        120_000
      )
      let payload = jsonObject(extracted.content)
      if (job.options.quality === 'high') {
        const reviewed = await this.ai.ask(
          {
            purpose: 'knowledge',
            messages: [
              { role: 'system', content: FEATURE_PROMPTS.knowledgeReview },
              {
                role: 'user',
                content: `${context}\n${sourceEnvelope(file.relativePath, chunk)}\n${taskDataEnvelope('待终审候选 JSON', payload)}`
              }
            ]
          },
          120_000
        )
        payload = jsonObject(reviewed.content)
      }
      const items = Array.isArray(payload.items) ? payload.items : []
      for (const value of items.slice(0, 10)) {
        const candidate = this.validateCandidate(value, job.options, chunk)
        if (!candidate) continue
        const signature = hash(
          candidate.kind === 'question'
            ? `${candidate.subject}\n${candidate.stem}\n${JSON.stringify(candidate.options)}`
            : `${candidate.subject}\n${candidate.title}\n${candidate.content}`
        )
        if (seen.has(signature)) continue
        seen.add(signature)
        const artifactId = `kb-${hash(`${file.sourceId}\n${signature}`).slice(0, 24)}`
        const title =
          candidate.kind === 'question'
            ? safeTitle(candidate.stem.slice(0, 60), '未命名题目')
            : safeTitle(candidate.title, '未命名知识')
        const markdown = this.candidateMarkdown(
          artifactId,
          candidate,
          file.relativePath,
          job.options.tags
        )
        artifacts.push({
          id: artifactId,
          jobId: job.id,
          sourceId: file.sourceId,
          sourcePath: file.relativePath,
          relativeSourcePath: file.relativePath,
          kind: candidate.kind,
          subject: candidate.subject,
          title,
          category: candidate.category,
          confidence: candidate.confidence,
          generatedBy: 'model',
          status: 'pending',
          warnings: candidate.warnings,
          preview:
            candidate.kind === 'question'
              ? candidate.stem.slice(0, 180)
              : (candidate.summary || candidate.content).slice(0, 180),
          markdown,
          evidenceExcerpt: candidate.evidenceExcerpt
        })
      }
    }
    return artifacts
  }

  private validateCandidate(
    value: unknown,
    options: KnowledgeBuildOptions,
    source: string
  ): CandidateItem | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    let kind: CandidateItem['kind'] = record.kind === 'question' ? 'question' : 'document'
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
      documentKind: ['knowledge', 'method', 'pattern'].includes(
        normalizeString(record.documentKind)
      )
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

  private candidateMarkdown(
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

  private async convert(
    pythonPath: string,
    workerPath: string,
    sourcePath: string,
    outputPath: string
  ): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonPath, [workerPath, sourcePath, outputPath], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })
      this.runningChild = child
      let stderr = ''
      const timer = setTimeout(() => child.kill(), 10 * 60_000)
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.runningChild = undefined
        if (code === 0 && existsSync(outputPath)) resolvePromise()
        else reject(new Error(stderr.trim() || `MarkItDown 进程退出码 ${code ?? '未知'}`))
      })
    })
  }

  /** 结构解析模式：spawn ocr-worker --structured（RapidDoc 表格还原/图形保真）。失败回退 OCR */
  private async structuredConvert(
    pythonPath: string,
    sourcePath: string,
    rawPath: string
  ): Promise<{ ok: boolean; quality?: OcrQualityReport }> {
    return new Promise((resolvePromise) => {
      // --structured 由 ocr-worker.py 实现；markitdown-worker 不认识该参数（历史上曾调错脚本导致恒回退）
      const workerPath = this.ocrWorkerPath()
      const child = spawn(pythonPath, [workerPath, sourcePath, rawPath, '--structured'], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      this.runningChild = child
      let done = false
      let quality: OcrQualityReport | undefined
      const finish = (ok: boolean): void => {
        this.runningChild = undefined
        resolvePromise({ ok, quality })
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const parsed = parseOcrWorkerLine(line)
          if (parsed?.type === 'quality') {
            done = true
            quality = parsed
            break
          }
        }
      })
      child.stderr.on('data', (chunk: string) => {
        void chunk
      })
      const timer = setTimeout(() => child.kill(), 60 * 60_000)
      child.once('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        finish(done && code === 0)
      })
    })
  }

  private async ocrConvert(
    job: StoredJob,
    file: KnowledgeBuildFile,
    pythonPath: string,
    sourcePath: string,
    outputPath: string
  ): Promise<OcrQualityReport | undefined> {
    const worker = this.ocrWorkerPath()
    let qualityReport: OcrQualityReport | undefined
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonPath, [worker, sourcePath, outputPath], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })
      this.runningChild = child
      let stderr = ''
      let stdoutBuffer = ''
      // 扫描件按页识别耗时较长，长超时但保持可取消
      const timer = setTimeout(() => child.kill(), 45 * 60_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const payload = parseOcrWorkerLine(line)
          if (!payload) continue
          if (payload.type === 'quality') {
            qualityReport = payload
            continue
          }
          if (payload.type === 'progress') {
            const source = payload.source === 'text-layer' ? '文字层' : 'OCR'
            file.message = `第 ${payload.page}/${payload.total} 页 · ${source}`
            this.saveJob(job)
          }
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        this.runningChild = undefined
        // 解析 stdoutBuffer 中残留的最后一行（无换行符的情况）
        if (stdoutBuffer.trim()) {
          const payload = parseOcrWorkerLine(stdoutBuffer)
          if (payload?.type === 'quality') {
            qualityReport = payload
          }
        }
        if (code === 0 && existsSync(outputPath)) resolvePromise()
        else reject(new Error(stderr.trim() || `OCR 进程退出码 ${code ?? '未知'}`))
      })
    })
    return qualityReport
  }

  private resolveSourceFile(job: StoredJob, file: KnowledgeBuildFile): string {
    const root = realpathSync(job.sourcePath)
    const candidate = resolve(root, file.relativePath)
    if (!isWithin(root, candidate) || !existsSync(candidate))
      throw new Error('原料文件不存在或超出目录')
    const info = lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('原料不是普通文件')
    const actual = realpathSync(candidate)
    if (!isWithin(root, actual)) throw new Error('原料路径超出所选目录')
    if (info.size !== file.size) throw new Error('原料文件在扫描后发生变化，请重新扫描')
    return actual
  }

  private jobView(job: StoredJob): KnowledgeBuildJob {
    const artifacts = job.artifactIds.flatMap((id) => {
      try {
        return [this.artifactSummary(this.loadArtifact(job, id))]
      } catch {
        return []
      }
    })
    return {
      id: job.id,
      sourcePath: job.sourcePath,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      status: job.status,
      options: job.options,
      files: job.files,
      artifacts,
      processedFiles: job.files.filter((file) =>
        ['ready', 'failed', 'skipped', 'cancelled'].includes(file.state)
      ).length,
      totalFiles: job.files.length,
      approvedArtifacts: artifacts.filter((artifact) => artifact.status === 'approved').length,
      pendingArtifacts: artifacts.filter((artifact) => artifact.status === 'pending').length,
      failedFiles: job.files.filter((file) => file.state === 'failed').length,
      currentFile: job.currentFile,
      message: job.message,
      outputPath: job.outputPath
    }
  }

  private artifactSummary(artifact: StoredArtifact): KnowledgeArtifactSummary {
    const {
      markdown: _markdown,
      evidenceExcerpt: _evidence,
      jobId: _jobId,
      relativeSourcePath: _path,
      ...summary
    } = artifact
    return summary
  }

  /** 证据资产大小上限（JPEG 页面预览 ≤ 2MB，防异常大文件） */
  private static readonly EVIDENCE_ASSET_MAX_BYTES = 2 * 1024 * 1024

  /** 读取证据资产 dataUrl：只允许 evidence/index.json 登记的相对路径。
   *  安全链：assetId 格式 → index 损坏容错 → 相对路径 → 解析位于 evidence/ 目录 →
   *  lstat 拒符号链接/目录/特殊文件 → realpath 再校验边界 → 大小上限。 */
  readEvidenceAsset(jobId: string, assetId: string): string {
    if (!/^ev-[0-9a-f]{20}$/.test(assetId)) throw new Error('证据资产 ID 无效')
    const job = this.loadJob(jobId)
    // evidence 目录自身安全链：存在 → lstat 拒符号链接/junction → realpath 位于真实 outputPath 内
    const evidenceDir = join(job.outputPath, 'evidence')
    let evidenceStats
    try {
      evidenceStats = lstatSync(evidenceDir)
    } catch {
      throw new Error('证据资产索引不存在或已损坏，请重新导入生成证据')
    }
    if (evidenceStats.isSymbolicLink())
      throw new Error('证据目录非法（符号链接/junction），拒绝读取')
    if (!evidenceStats.isDirectory()) throw new Error('证据目录不是目录')
    const realEvidenceDir = realpathSync(evidenceDir)
    const realOutputPath = realpathSync(job.outputPath)
    const evidenceRel = relative(realOutputPath, realEvidenceDir)
    if (evidenceRel === '' || evidenceRel.startsWith('..') || isAbsolute(evidenceRel))
      throw new Error('证据目录逃逸（realpath 校验失败）')
    const indexPath = join(evidenceDir, 'index.json')
    let index: Record<string, string>
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, string>
    } catch {
      throw new Error('证据资产索引不存在或已损坏，请重新导入生成证据')
    }
    const registered = index[assetId]
    if (!registered || typeof registered !== 'string') throw new Error('证据资产不存在')
    if (registered.includes('..') || isAbsolute(registered)) throw new Error('证据路径非法')
    // 统一契约：index 值相对 evidenceDir（<hash>/evidence-pN.jpg）——
    // 旧格式（evidence/ 前缀）会解析成 evidence/evidence/...，按非法路径拒绝
    if (
      registered === 'index.json' ||
      registered.startsWith('evidence/') ||
      registered.startsWith('evidence\\')
    )
      throw new Error('证据路径非法（索引格式不兼容）')
    const file = resolve(evidenceDir, registered)
    const rel = relative(evidenceDir, file)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('证据路径超出证据目录')
    // lstat 不跟随链接：符号链接/junction 直接拒绝
    let stats
    try {
      stats = lstatSync(file)
    } catch {
      throw new Error('证据文件不存在')
    }
    if (stats.isSymbolicLink()) throw new Error('证据路径非法（符号链接）')
    if (!stats.isFile()) throw new Error('证据目标不是普通文件')
    if (stats.size > KnowledgeBuilderService.EVIDENCE_ASSET_MAX_BYTES)
      throw new Error('证据文件超出大小上限')
    // 最终文件 realpath 也必须位于真实 evidence 目录内（双重逃逸防线）
    const real = realpathSync(file)
    const realRel = relative(realEvidenceDir, real)
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel))
      throw new Error('证据路径逃逸（realpath 校验失败）')
    return `data:image/jpeg;base64,${readFileSync(real).toString('base64')}`
  }

  // ---- VLM 按页精校（可选能力）：人工编辑保存 / 单产物按页精校 / 任务级批量预精校 ----

  /** 人工编辑或采纳 VLM 精校后保存：gray-matter 解析 frontmatter 做红线强校验
   *  （id/answer/options[].key·image 等绝不改动），并把正文修订同步回
   *  material/stem/options[].text/explanation 与 preview——发布入库（VaultService.parseFile
   *  优先读 frontmatter）与刷题/模考读到的才是修订后的文本 */
  updateArtifactMarkdown(
    jobId: string,
    artifactId: string,
    markdown: string,
    origin: 'vlm' | 'manual' = 'manual'
  ): KnowledgeArtifactDetail {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再编辑正文')
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    const artifact = this.loadArtifact(job, artifactId)
    if (artifact.status === 'published') throw new Error('已发布产物不能修改，请先撤销导入')
    const content = markdown.replace(/\r\n/g, '\n')
    if (!content.trim()) throw new Error('正文不能为空')
    if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_EDIT_BYTES)
      throw new Error('编辑后的正文超过大小上限')
    let revised: matter.GrayMatterFile<string>
    try {
      revised = matter(content)
    } catch {
      throw new Error('保存失败：YAML frontmatter 无法解析，请检查格式')
    }
    const revisedData = revised.data as Record<string, unknown>
    if (!revisedData || Object.keys(revisedData).length === 0 || !revisedData.id)
      throw new Error('保存失败：Markdown 缺少 YAML frontmatter，无法确认题目身份与答案字段')
    const originalData = matter(artifact.markdown).data as Record<string, unknown>
    if (!originalData || Object.keys(originalData).length === 0 || !originalData.id)
      throw new Error('产物缺少 YAML frontmatter，无法安全保存（数据异常）')
    // 红线校验：id/answer/options 绑定等任何改动一律拒绝；正文修订随后同步回可变字段
    assertFrontmatterIntact(originalData, revisedData)
    const synced = syncFrontmatterFromBody(revisedData, revised.content)
    artifact.markdown = serializeFrontmatter(synced, revised.content)
    const syncedStem = normalizeString(synced.stem)
    if (syncedStem) artifact.preview = syncedStem.slice(0, 180)
    if (origin === 'vlm' && !artifact.warnings.includes(VLM_REVIEW_WARNING))
      artifact.warnings = [...artifact.warnings, VLM_REVIEW_WARNING]
    this.saveArtifact(job, artifact)
    job.updatedAt = now()
    this.saveJob(job)
    return artifact
  }

  /** 单产物按页 VLM 精校：渲染关联来源页高清图并调用视觉模型，返回建议但不落盘；
   *  用户对比采纳后经 updateMarkdown 持久化，发布门禁不因此放松 */
  async vlmProofreadArtifact(jobId: string, artifactId: string): Promise<VlmProofreadSuggestion> {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再精校')
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    const artifact = this.loadArtifact(job, artifactId)
    if (artifact.status === 'published') throw new Error('已发布产物不能修改，无需精校')
    const vlm = this.ai.getVlmConfig()
    if (!vlm.enabled) throw new Error('VLM 按页精校未开启：请在工坊顶部或模型设置打开开关后再使用')
    const pages = collectProofreadPages(artifact.sourceEvidence)
    if (!pages.length)
      throw new Error('该产物没有可用的来源 PDF 页（来源证据缺失或不可渲染），无法按页精校')
    const imageDataUrls = await this.renderVlmPageImages(job, pages)
    const images: AiImageInput[] = pages.map((page) => ({
      mimeType: 'image/jpeg' as const,
      dataUrl: imageDataUrls.get(pageKey(page.sourceId, page.pageNumber)) ?? ''
    }))
    if (images.some((image) => !image.dataUrl)) throw new Error('精校页面图片渲染失败，请稍后重试')
    const response = await this.ai.askVision({
      messages: buildVlmProofreadMessages(artifact.markdown, pages, 'body', images)
    })
    let payload: Record<string, unknown>
    try {
      payload = jsonObject(response.content)
    } catch (error) {
      throw new Error(`模型返回无法解析：${error instanceof Error ? error.message : 'JSON 无效'}`)
    }
    const validated = validateVlmPayload(payload)
    return {
      jobId,
      artifactId,
      // 建议即最终形态：红线字段保留原值，material/stem/options text/explanation 已从修订正文同步
      correctedMarkdown: rebuildArtifactMarkdown(artifact.markdown, validated.correctedBody),
      changes: validated.changes,
      uncertainItems: validated.uncertainItems,
      summary: validated.summary,
      pages
    }
  }

  /** 渲染 VLM 精校用高清页图（独立 vlm-pages/ 缓存目录，与 evidence/ 预览资产契约隔离，
   *  文件名契约同为 evidence-p{N}.jpg；同一任务同一页只渲染一次） */
  private async renderVlmPageImages(
    job: StoredJob,
    pages: Array<{ sourceId: string; pageNumber: number }>
  ): Promise<Map<string, string>> {
    const engine = await this.engineStatus()
    if (!engine.available || !engine.pythonPath)
      throw new Error('转换引擎不可用，无法渲染精校页面图片')
    const bySource = new Map<string, number[]>()
    for (const page of pages) {
      if (!job.files.some((file) => file.sourceId === page.sourceId))
        throw new Error('来源文件不属于当前任务')
      const list = bySource.get(page.sourceId) ?? []
      if (!list.includes(page.pageNumber)) list.push(page.pageNumber)
      bySource.set(page.sourceId, list)
    }
    const result = new Map<string, string>()
    const worker = this.ocrWorkerPath()
    for (const [sourceId, pageNumbers] of bySource) {
      const file = job.files.find((candidate) => candidate.sourceId === sourceId)
      if (!file) continue
      const dir = join(job.outputPath, 'vlm-pages', hash(sourceId).slice(0, 10))
      mkdirSync(dir, { recursive: true })
      const missing = pageNumbers.filter((n) => !existsSync(join(dir, `evidence-p${n}.jpg`)))
      if (missing.length) {
        const source = this.resolveSourceFile(job, file)
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn(
            engine.pythonPath!,
            [
              worker,
              source,
              dir,
              '--render-evidence',
              [...missing].sort((a, b) => a - b).join(','),
              '--max-side',
              String(VLM_RENDER_MAX_SIDE)
            ],
            { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'] }
          )
          child.once('error', rejectPromise)
          child.once('close', (code) =>
            code === 0 ? resolvePromise() : rejectPromise(new Error('精校页面渲染失败'))
          )
        })
      }
      for (const pageNumber of pageNumbers) {
        const image = join(dir, `evidence-p${pageNumber}.jpg`)
        if (!existsSync(image)) continue
        result.set(
          pageKey(sourceId, pageNumber),
          `data:image/jpeg;base64,${readFileSync(image).toString('base64')}`
        )
      }
    }
    return result
  }

  /** 任务级批量预精校（runJob 直导收尾调用）：只处理表格/数字异常页，绝不跑普通纯文字页；
   *  按 sourceId#pageNumber 去重（共享材料 5 小题只调一次 VLM），超上限跳过并如实回报。
   *  单页失败只计入 failedPages 继续下一页，不覆盖已完成页的统计；
   *  scope=body 时同页多道独立题只修订首题，其余按 uncoveredArtifacts 如实累计 */
  private async autoVlmPreproofread(
    job: StoredJob,
    artifacts: StoredArtifact[]
  ): Promise<{
    pages: number
    calls: number
    applied: number
    skippedPages: number
    failedPages: number
    uncoveredArtifacts: number
  }> {
    const vlm = this.ai.getVlmConfig()
    if (!vlm.enabled) throw new Error('VLM 按页精校开关未开启，本批未执行预精校')
    const candidates = artifacts.filter(
      (artifact) =>
        artifact.status === 'pending' &&
        (artifact.capability === 'table-review' ||
          artifact.warnings.some((warning) => /数字异常|表格列数不一致/.test(warning)))
    )
    if (!candidates.length)
      return {
        pages: 0,
        calls: 0,
        applied: 0,
        skippedPages: 0,
        failedPages: 0,
        uncoveredArtifacts: 0
      }
    // 按主来源页分组去重：同页产物共享一次 VLM 调用
    const groups = new Map<
      string,
      { sourceId: string; pageNumber: number; artifacts: StoredArtifact[] }
    >()
    for (const artifact of candidates) {
      const pages = collectProofreadPages(artifact.sourceEvidence)
      if (!pages.length) continue
      const primary = pages[0]!
      const key = pageKey(primary.sourceId, primary.pageNumber)
      const group = groups.get(key) ?? { ...primary, artifacts: [] }
      group.artifacts.push(artifact)
      groups.set(key, group)
    }
    const keys = [...groups.keys()]
    const processedKeys = keys.slice(0, MAX_AUTO_VLM_PAGES)
    const skippedPages = keys.length - processedKeys.length
    if (!processedKeys.length)
      return { pages: 0, calls: 0, applied: 0, skippedPages, failedPages: 0, uncoveredArtifacts: 0 }
    const imageDataUrls = await this.renderVlmPageImages(
      job,
      processedKeys.map((key) => {
        const group = groups.get(key)!
        return { sourceId: group.sourceId, pageNumber: group.pageNumber }
      })
    )
    let calls = 0
    let applied = 0
    let failedPages = 0
    let uncoveredArtifacts = 0
    for (const key of processedKeys) {
      // 支持任务取消：每组开始前检查，已完成页保留
      if (this.loadJob(job.id).cancelRequested) break
      const group = groups.get(key)!
      const dataUrl = imageDataUrls.get(key)
      if (!dataUrl) {
        failedPages += 1
        continue
      }
      const representative = group.artifacts[0]!
      const parsed = splitFrontmatter(representative.markdown)
      const materialRange = parsed ? materialSectionRange(parsed.body) : undefined
      const scope: 'body' | 'material' = materialRange ? 'material' : 'body'
      try {
        const content = materialRange
          ? parsed!.body.slice(materialRange.start, materialRange.end)
          : representative.markdown
        const response = await this.ai.askVision({
          messages: buildVlmProofreadMessages(
            content,
            [{ sourceId: group.sourceId, pageNumber: group.pageNumber }],
            scope,
            [{ mimeType: 'image/jpeg', dataUrl }]
          )
        })
        calls += 1
        const validated = validateVlmPayload(jsonObject(response.content))
        // scope=material：修正的是共享材料，组内全部产物同步；scope=body：正文按题独立，
        // 同页多道独立题只有首题被修订，其余如实计入未覆盖（不静默）
        const targets = scope === 'material' ? group.artifacts : [representative]
        if (scope === 'body' && group.artifacts.length > 1)
          uncoveredArtifacts += group.artifacts.length - 1
        for (const artifact of targets) {
          const corrected =
            scope === 'material'
              ? applyCorrectedMaterial(artifact.markdown, validated.correctedBody)
              : rebuildArtifactMarkdown(artifact.markdown, validated.correctedBody)
          if (corrected === artifact.markdown) continue
          artifact.markdown = corrected
          const syncedStem = normalizeString(matter(corrected).data.stem)
          if (syncedStem) artifact.preview = syncedStem.slice(0, 180)
          if (!artifact.warnings.includes(VLM_REVIEW_WARNING))
            artifact.warnings = [...artifact.warnings, VLM_REVIEW_WARNING]
          this.saveArtifact(job, artifact)
          applied += 1
        }
      } catch {
        // 单页失败（超时/解析失败/图片引用丢失）只记账，继续下一页；已完成页统计不受影响
        failedPages += 1
      }
    }
    return {
      pages: processedKeys.length,
      calls,
      applied,
      skippedPages,
      failedPages,
      uncoveredArtifacts
    }
  }

  /** 渲染证据页并回填 evidenceAssetId：按 sourceId+pageNumber 在 job 内去重，
   *  上限 EVIDENCE_PAGE_LIMIT；渲染失败（如 .md 源）跳过该文件不阻塞。
   *  输出 evidence/{源短哈希}/evidence-p{N}.jpg + index.json 资产表（渲染层经 IPC 取图）。 */
  private async renderJobEvidence(job: StoredJob, artifacts: StoredArtifact[]): Promise<number> {
    const pageKeys = collectEvidencePageKeys(artifacts)
    if (pageKeys.size === 0 || pageKeys.size > EVIDENCE_PAGE_LIMIT) {
      // 超限：不渲染任何图；清除全部陈旧 assetId 后 finalize（不得显示 available）
      for (const artifact of artifacts) {
        if (!artifact.sourceEvidence) continue
        for (const reference of artifact.sourceEvidence.references)
          for (const page of reference.pages) delete page.evidenceAssetId
        finalizeSourceEvidenceStatus(artifact.sourceEvidence)
        this.saveArtifact(job, artifact)
      }
      return 0
    }
    const bySource = new Map<string, Set<number>>()
    for (const key of pageKeys) {
      const [sourceId, pagePart] = key.split('#p')
      const pageNumber = Number(pagePart)
      const list = bySource.get(sourceId!) ?? new Set<number>()
      list.add(pageNumber)
      bySource.set(sourceId!, list)
    }
    const evidenceDir = join(job.outputPath, 'evidence')
    const assetIndex = new Map<string, string>()
    const engine = await this.engineStatus()
    for (const [sourceId, pageNumbers] of bySource) {
      const file = job.files.find((candidate) => candidate.sourceId === sourceId)
      if (!file || !engine.pythonPath) continue
      try {
        const source = this.resolveSourceFile(job, file)
        const dirHash = hash(sourceId).slice(0, 10)
        const dir = join(evidenceDir, dirHash)
        mkdirSync(dir, { recursive: true })
        const pagesArg = [...pageNumbers].sort((a, b) => a - b).join(',')
        const worker = this.ocrWorkerPath()
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const child = spawn(
            engine.pythonPath!,
            [worker, source, dir, '--render-evidence', pagesArg],
            { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'] }
          )
          child.once('error', rejectPromise)
          child.once('close', (code) =>
            code === 0 ? resolvePromise() : rejectPromise(new Error('render failed'))
          )
        })
        for (const pageNumber of pageNumbers) {
          const image = join(dir, `evidence-p${pageNumber}.jpg`)
          if (!existsSync(image)) continue
          const assetId = evidenceAssetId(sourceId, pageNumber)
          assetIndex.set(assetId, join(dirHash, `evidence-p${pageNumber}.jpg`))
        }
      } catch {
        // 渲染失败（非 PDF 源/引擎不可用）：该文件证据缺图，页映射保留、预览不可用
      }
    }
    if (assetIndex.size > 0)
      writeFileSync(
        join(evidenceDir, 'index.json'),
        JSON.stringify(Object.fromEntries([...assetIndex.entries()].sort()), null, 1),
        'utf8'
      )
    // 回填 assetId：命中写入、未命中清除陈旧引用（防上一批残留 assetId 指向已删图片），
    // 页码与 exact/estimated 映射不动——只更新资产可用性，随后统一 finalize
    for (const artifact of artifacts) {
      const evidence = artifact.sourceEvidence
      if (!evidence) continue
      for (const reference of evidence.references)
        for (const page of reference.pages) {
          const assetId = evidenceAssetId(reference.sourceId, page.pageNumber)
          if (assetIndex.has(assetId)) page.evidenceAssetId = assetId
          else delete page.evidenceAssetId
        }
      finalizeSourceEvidenceStatus(evidence)
      this.saveArtifact(job, artifact)
    }
    return assetIndex.size
  }

  /** 产物级来源证据：题本页（question/material role）与解析册页（solution role）分别记录 */
  private buildArtifactEvidence(
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

  private jobDirectory(id: string): string {
    if (!/^kbjob-[0-9a-f-]+$/i.test(id)) throw new Error('任务 ID 无效')
    const directory = resolve(this.jobsDirectory, id)
    if (!isWithin(this.jobsDirectory, directory)) throw new Error('任务路径无效')
    return directory
  }

  private loadJob(id: string): StoredJob {
    const path = join(this.jobDirectory(id), 'job.json')
    if (!existsSync(path)) throw new Error('知识构建任务不存在')
    return JSON.parse(readFileSync(path, 'utf8')) as StoredJob
  }

  private saveJob(job: StoredJob): void {
    job.updatedAt = now()
    mkdirSync(this.jobDirectory(job.id), { recursive: true })
    this.atomicWrite(join(this.jobDirectory(job.id), 'job.json'), JSON.stringify(job, null, 2))
  }

  private artifactPath(job: StoredJob, artifactId: string): string {
    if (!/^kb-[0-9a-f]+$/i.test(artifactId)) throw new Error('产物 ID 无效')
    return join(this.jobDirectory(job.id), 'artifacts', `${artifactId}.json`)
  }

  private loadArtifact(job: StoredJob, artifactId: string): StoredArtifact {
    const path = this.artifactPath(job, artifactId)
    if (!existsSync(path)) throw new Error('知识产物不存在')
    return JSON.parse(readFileSync(path, 'utf8')) as StoredArtifact
  }

  private saveArtifact(job: StoredJob, artifact: StoredArtifact): void {
    mkdirSync(join(this.jobDirectory(job.id), 'artifacts'), { recursive: true })
    this.atomicWrite(this.artifactPath(job, artifact.id), JSON.stringify(artifact, null, 2))
  }

  private atomicWrite(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  }

  private managedPythonPath(): string {
    return process.platform === 'win32'
      ? join(this.engineDirectory, '.venv', 'Scripts', 'python.exe')
      : join(this.engineDirectory, '.venv', 'bin', 'python')
  }

  private pythonCandidates(): string[] {
    const override = process.env.WORKBENCH_MARKITDOWN_PYTHON
    const development =
      process.platform === 'win32'
        ? resolve(process.cwd(), '.venv-markitdown', 'Scripts', 'python.exe')
        : resolve(process.cwd(), '.venv-markitdown', 'bin', 'python')
    return [
      ...new Set([override, this.managedPythonPath(), development].filter(Boolean) as string[])
    ]
  }

  private async markitdownVersion(pythonPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        pythonPath,
        ['-c', "import importlib.metadata as m; import markitdown; print(m.version('markitdown'))"],
        {
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: '1' }
        }
      )
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  private async structuredParseAvailable(pythonPath: string): Promise<boolean> {
    try {
      // 冷启动时杀毒软件首次扫描 venv 可能拖慢 import，30s 不够用
      await execFileAsync(pythonPath, ['-c', 'import rapid_doc'], {
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return true
    } catch {
      return false
    }
  }

  private async ocrComponentsAvailable(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(pythonPath, ['-c', 'import rapidocr, pypdfium2'], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return true
    } catch {
      return false
    }
  }

  // Python 深度发现：PATH 候选之外补充扫描 Windows 常见固定安装位置
  //（免重启应用即可发现新装 Python；显式跳过微软商店假快捷桩），
  // 每个候选都要通过「版本 ≥3.10」与「venv 可导入」双重校验
  private async findPythonLauncher(): Promise<{ command: string; args: string[] }> {
    const override = process.env.WORKBENCH_MARKITDOWN_PYTHON?.trim()
    return findPythonLauncherCandidate({
      runner: this.commandRunner(),
      extraCandidates: override ? [{ command: override, args: [] }] : []
    })
  }

  private workerPath(): string {
    const candidates = [
      join(this.resourceDirectory, 'tools', 'markitdown-worker.py'),
      resolve(process.cwd(), 'tools', 'markitdown-worker.py')
    ]
    const path = candidates.find((candidate) => existsSync(candidate))
    if (!path) throw new Error('MarkItDown 本地转换脚本缺失')
    return path
  }

  private ocrWorkerPath(): string {
    const candidates = [
      join(this.resourceDirectory, 'tools', 'ocr-worker.py'),
      resolve(process.cwd(), 'tools', 'ocr-worker.py')
    ]
    const path = candidates.find((candidate) => existsSync(candidate))
    if (!path) throw new Error('OCR 本地识别脚本缺失')
    return path
  }

  // 暂存产物的图片附件读取：来源文档与附件都必须落在知识构建根目录（任务 raw 输出）内
  readJobAssetDataUrl(sourceFilePath: string, assetPath: string): string {
    const root = realpathSync(this.rootDirectory)
    const source = realpathSync(resolve(sourceFilePath))
    const sourceRel = relative(root, source)
    if (!(sourceRel === '' || (!sourceRel.startsWith('..') && !isAbsolute(sourceRel))))
      throw new Error('附件来源文档不在知识构建任务目录内')
    let decoded: string
    try {
      decoded = decodeURIComponent(assetPath.split(/[?#]/, 1)[0] ?? '')
    } catch {
      throw new Error('附件路径编码无效')
    }
    if (!decoded || /^[a-z][a0-9+.-]*:/i.test(decoded))
      throw new Error('只允许读取任务目录内的相对附件')
    const candidate = resolve(dirname(source), decoded)
    if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error('附件文件不存在')
    const file = realpathSync(candidate)
    const fileRel = relative(root, file)
    if (!(fileRel === '' || (!fileRel.startsWith('..') && !isAbsolute(fileRel))))
      throw new Error('附件路径超出任务目录')
    const mime =
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      }[extname(file).toLowerCase()] ?? ''
    if (!mime) throw new Error('不支持的附件类型')
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  }

  private recoverInterruptedJobs(): void {
    for (const entry of readdirSync(this.jobsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(this.jobsDirectory, entry.name, 'job.json')
      if (!existsSync(path)) continue
      try {
        const job = this.loadJob(entry.name)
        if (!['queued', 'running', 'cancelling'].includes(job.status)) continue
        for (const file of job.files)
          if (['converting', 'converted', 'organizing'].includes(file.state)) {
            file.state = 'failed'
            file.message = '应用在处理期间退出，可使用重试继续'
          }
        job.status = 'failed'
        job.currentFile = undefined
        job.cancelRequested = false
        job.message = '上次任务被应用退出中断，已完成内容仍被保留'
        this.saveJob(job)
      } catch {
        // A damaged manifest is isolated from other jobs and can be inspected in its folder.
      }
    }
  }
}
