import type {
  ImportCapability,
  KnowledgeArtifactDetail,
  KnowledgeBuildFile,
  KnowledgeBuildJob,
  KnowledgeBuildOptions,
  SourceReference,
  Subject
} from '../../../shared/contracts'
import type { mergeGraphicQuestions } from '../graphic-import'
import type { ParsedEssayUnit, ParsedSolution, parseQuestionBook } from '../question-import'

// 文档结构解析组件（RapidAI 生态，表格还原/图形保真/阅读顺序）
export const STRUCTURED_PACKAGE = 'rapid-doc==0.9.10'

// OCR worker 预处理/过滤策略版本：修改渲染 DPI、去水印预处理或页眉剔除策略时递增，
// 让旧转换缓存自然失效，避免已导过的 PDF 重导时命中旧结果
export const OCR_WORKER_POLICY_VERSION = 'p3'

// 文字通道切出的可用题少于此数时，"题号+图片页充足"的文件才按纯图推题本走保留通道；
// 行测整卷有大量图表页但文字题健康，不能因此整文件放弃结构化
export const GRAPHIC_ONLY_MAX_TEXT_QUESTIONS = 5

// 随产物入库的图片资产白名单后缀：_regions.json/_pages.json 等 sidecar 不进题库
export const IMAGE_ASSET_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff)$/i

export const SUPPORTED_EXTENSIONS = [
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

export const INCOMPLETE_EXTENSIONS = new Set(['.downloading', '.part', '.tmp', '.crdownload'])
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'])
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm'])
export const IGNORED_DIRECTORIES = new Set(['.git', '.obsidian', 'node_modules', '$recycle.bin'])
export const MAX_SOURCE_FILES = 10_000
export const MAX_SELECTED_FILES = 500
export const MAX_SOURCE_FILE_BYTES = 256 * 1024 * 1024
export const MAX_RAW_MARKDOWN_BYTES = 20 * 1024 * 1024

// 题本类材料约 300 字/题：块大小与每块条数上限对齐，避免高密度题目被上限整批丢弃
export const MAX_CHUNK_CHARACTERS = 3_000
export const MAX_CHUNKS_PER_FILE = 240
export const MARKITDOWN_VERSION = '0.1.6'

// OCR 组件：RapidOCR 与 PaddleOCR 使用同源 PP-OCR 模型（ONNX 版），wheel 内置默认模型，离线可用
export const OCR_PACKAGES = [
  'rapidocr==3.9.2',
  // 不设上限：pip 按各 Python 版本的 requires_python 自动选择（3.10 → 1.22，3.14 → 1.24+）
  'onnxruntime>=1.20',
  'pypdfium2>=4.30,<7'
]

/** 任务级批量预精校的硬编码页数上限：超出部分跳过并如实提示，可在审核页单页补校 */
export const MAX_AUTO_VLM_PAGES = 10

/** 单产物按页精校最多取 3 个关联来源页（question/material/preserved-page，解析册页不参与） */
export const VLM_PROOFREAD_MAX_PAGES = 3

/** VLM 精校页面渲染长边：1280px 下资料分析表格小字发虚，精校用 2000px 高清页图 */
export const VLM_RENDER_MAX_SIDE = 2000

/** 采纳 VLM 精校结果后的固定复核提示（进 warnings，不解除发布门禁） */
export const VLM_REVIEW_WARNING = '已完成 VLM 按页精校，仍需人工复核确认'

/** 人工编辑/采纳精校后的正文大小上限（与产物常规体量同量级，防异常大文本） */
export const MAX_MARKDOWN_EDIT_BYTES = 2 * 1024 * 1024

/** 证据资产大小上限（JPEG 页面预览 ≤ 2MB，防异常大文件） */
export const EVIDENCE_ASSET_MAX_BYTES = 2 * 1024 * 1024

/** 来源页角色优先级：材料页是资料分析精校的主依据，解析册页码不参与精校正页 */
export const PROOFREAD_ROLE_ORDER: Record<SourceReference['role'], number> = {
  material: 0,
  question: 1,
  'preserved-page': 2,
  solution: 3
}

/** 构造转换缓存的 converter 键（拼接 OCR worker 策略版本，策略升级时自然绕过旧缓存） */
export function buildConversionConverterKey(mode: 'structured' | 'ocr' | 'markitdown'): string {
  if (mode === 'structured') return `structured@${STRUCTURED_PACKAGE}+${OCR_WORKER_POLICY_VERSION}`
  if (mode === 'ocr') return `ocr@${OCR_PACKAGES.join('+')}+${OCR_WORKER_POLICY_VERSION}`
  return `markitdown@${MARKITDOWN_VERSION}`
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

export interface CandidateItem {
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

export interface StoredArtifact extends KnowledgeArtifactDetail {
  jobId: string
  relativeSourcePath: string
}

export interface StoredJob {
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

export interface DirectBookEntry {
  sourceId: string
  relativePath: string
  questions: ReturnType<typeof parseQuestionBook>
  groups: Map<string, string>
  graphic?: {
    items: ReturnType<typeof mergeGraphicQuestions>['items']
    itemWarnings: string[][]
    notes: string[]
    summary: string
  }
  qualityWarnings?: string[]
  graphicNotes?: Map<string, string[]>
  capability?: ImportCapability
  linePageMap?: Array<number | undefined>
}

export interface DirectPreservationEntry {
  sourceId: string
  relativePath: string
  capability: ImportCapability
  summary: string
  docs: Array<{ id: string; title: string; markdown: string; warnings: string[] }>
  pages?: number[]
}

export interface DirectEssayEntry {
  sourceId: string
  relativePath: string
  units: ParsedEssayUnit[]
  linePageMap?: Array<number | undefined>
}

export interface DirectBatchCollector {
  directBooks: DirectBookEntry[]
  directPreservation: DirectPreservationEntry[]
  directEssays: DirectEssayEntry[]
  directSolutions: Map<string, ParsedSolution>
  solutionPageMaps: Map<string, Array<number | undefined>>
  solutionSourceOf: Map<string, string>
  trainingMarkers: number
}

export interface AutoVlmStats {
  pages: number
  calls: number
  applied: number
  skippedPages: number
  failedPages: number
  uncoveredArtifacts: number
}
