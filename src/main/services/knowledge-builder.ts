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
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  BatchReviewResult,
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
  Subject,
  VaultIndexResult
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
import {
  envPipIndexUrl,
  mirrorById,
  normalizeMirrorPreference,
  pickMirrorByProbes,
  probeMirror
} from './pip-mirror'
import { PIP_MIRRORS } from '../../shared/pip-mirrors'

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
  type DirectQuestion,
  type ParsedEssayUnit,
  type ParsedSolution
} from './question-import'
import { VaultService } from './vault'

const execFileAsync = promisify(execFile)

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

// 统计申论教材的「训练」式单元标题行数（【训练N】xxx / 训练N：xxx 两种版式），
// 直导零产出时用于判断这本书是否主观题教材并给出模式建议
function countEssayTrainingMarks(lines: string[]): number {
  return lines.filter((line) =>
    /^【?训练\s*[一二三四五六七八九十百0-9]{1,4}\s*】?\s*[:：]?/.test(line)
  ).length
}

function safeTitle(value: string, fallback: string): string {
  const cleaned = value
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
  private resolvedPipIndex?: { url: string; label: string }

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
      const launcher = await this.findPythonLauncher()
      const environment = join(this.engineDirectory, '.venv')
      const pythonPath = this.managedPythonPath()
      this.installProgress = { phase: '定位 Python 并创建独立环境', percent: 4 }
      if (!existsSync(pythonPath)) {
        mkdirSync(this.engineDirectory, { recursive: true })
        await execFileAsync(launcher.command, [...launcher.args, '-m', 'venv', environment], {
          timeout: 120_000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024
        })
      }
      // 分组件安装并解析 pip 输出推进进度：大块是 OCR 模型与推理运行时。
      // 安装源在批次开始时解析一次（探活优选或用户钉死），整批共用。
      const pipIndex = await this.resolvePipIndex()
      this.installProgress = { phase: `安装源：${pipIndex.label}`, percent: 3 }
      await this.pipInstallWithProgress(
        pythonPath,
        `markitdown[pdf,docx,pptx,xlsx,xls,outlook]==${MARKITDOWN_VERSION}`,
        5,
        25,
        '安装文档转换组件 MarkItDown',
        pipIndex.url
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[0]!,
        30,
        20,
        '安装 OCR 组件 RapidOCR（含识别模型）',
        pipIndex.url
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[1]!,
        50,
        38,
        '安装推理运行时 onnxruntime（体积较大）',
        pipIndex.url
      )
      await this.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[2]!,
        84,
        6,
        '安装 PDF 渲染组件 pypdfium2',
        pipIndex.url
      )
      await this.pipInstallWithProgress(
        pythonPath,
        STRUCTURED_PACKAGE,
        90,
        6,
        '安装文档结构解析组件 RapidDoc（表格还原）',
        pipIndex.url
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
      const pipIndex = await this.resolvePipIndex()
      await this.pipInstallWithProgress(
        pythonPath,
        DIRECTML_PACKAGE,
        25,
        55,
        '安装 DirectML 推理后端（DX12 显卡通用）',
        pipIndex.url
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
        await execFileAsync(
          pythonPath,
          ['-m', 'pip', 'install', '--disable-pip-version-check', CPU_ONNXRUNTIME_SPEC],
          { timeout: 20 * 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
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
      const pipIndex = await this.resolvePipIndex()
      await execFileAsync(
        pythonPath,
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--index-url',
          pipIndex.url,
          CPU_ONNXRUNTIME_SPEC
        ],
        { timeout: 20 * 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
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
    this.resolvedPipIndex = undefined
  }

  private async resolvePipIndex(): Promise<{ url: string; label: string }> {
    if (this.resolvedPipIndex) return this.resolvedPipIndex
    // 用户环境变量显式指定的源优先——那是用户自己配置的环境，不应被应用覆盖
    const fromEnv = envPipIndexUrl()
    if (fromEnv) return (this.resolvedPipIndex = { url: fromEnv, label: '环境变量 PIP_INDEX_URL' })
    const preference = this.pipMirrorPreference()
    if (preference !== 'auto') {
      const mirror = mirrorById(preference)
      if (mirror) return (this.resolvedPipIndex = { url: mirror.indexUrl, label: mirror.label })
    }
    const probes = await Promise.all(
      PIP_MIRRORS.map(async (mirror) => {
        const startedAt = Date.now()
        const reachable = await probeMirror(mirror.indexUrl)
        return { ...mirror, reachable, elapsedMs: Date.now() - startedAt }
      })
    )
    const picked = pickMirrorByProbes(probes)
    return (this.resolvedPipIndex = { url: picked.indexUrl, label: picked.label })
  }

  // 逐包安装并按 pip 输出行(Collecting/Downloading/Successfully)估算完成度，驱动安装进度条
  private async pipInstallWithProgress(
    pythonPath: string,
    spec: string,
    base: number,
    span: number,
    phase: string,
    indexUrl?: string
  ): Promise<void> {
    this.installProgress = { phase, percent: base }
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        pythonPath,
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          ...(indexUrl ? ['--index-url', indexUrl] : []),
          spec
        ],
        {
          windowsHide: true,
          shell: false,
          env: { ...process.env, PIP_NO_INPUT: '1', PYTHONUTF8: '1' }
        }
      )
      let stderr = ''
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
        if (code === 0) resolvePromise()
        else reject(new Error(stderr.trim() || `pip 进程退出码 ${code ?? '未知'}`))
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
    status: Extract<KnowledgeArtifactStatus, 'pending' | 'approved' | 'rejected'>
  ): KnowledgeBuildJob {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再审核')
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    const artifact = this.loadArtifact(job, artifactId)
    if (artifact.status === 'published') throw new Error('已发布产物不能改回审核状态')
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

  publish(jobId: string): VaultIndexResult {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再发布')
    const approved = job.artifactIds
      .map((id) => this.loadArtifact(job, id))
      .filter((artifact) => artifact.status === 'approved')
    if (!approved.length) throw new Error('没有已批准且尚未发布的产物')
    // 直导任务发布到目标库的「直导题库」子目录（活动用户库原位；内置示例库回退应用自管库）
    const isDirect = job.options.mode === 'direct'
    const activeVault = this.vaults.ensureBuiltinVault()
    const directToUserVault = isDirect && !activeVault.isBuiltin
    const targetRoot = directToUserVault ? activeVault.path : this.managedVaultDirectory
    const staged: Array<{ artifact: StoredArtifact; target: string; content: string }> = []
    for (const artifact of approved) {
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
    // 结构解析产出的图片资产随 md 一同入库（materials 内相对引用 images/…）
    const rawImagesDir = join(job.outputPath, 'raw', 'images')
    if (existsSync(rawImagesDir)) {
      const vaultImagesDir = join(targetRoot, '直导题库', 'images')
      mkdirSync(vaultImagesDir, { recursive: true })
      for (const imageName of readdirSync(rawImagesDir)) {
        const from = join(rawImagesDir, imageName)
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
      ? `已发布 ${staged.length} 题到${directToUserVault ? '当前题库' : '应用管理知识库'}的「直导题库」目录并完成重索引`
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
      }> = []
      const directEssays: Array<{
        sourceId: string
        relativePath: string
        units: ParsedEssayUnit[]
      }> = []
      // 无客观题书的面板提示线索：全文含训练式标题的行数（用于收尾时给出模式建议）
      let trainingMarkers = 0
      const directSolutions = new Map<string, ParsedSolution>()
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
          const useOcr = engine.ocrAvailable && isPdfFile(file.relativePath)
          const converter = useOcr
            ? `ocr@${OCR_PACKAGES.join('+')}`
            : `markitdown@${MARKITDOWN_VERSION}`
          let ocrQuality: OcrQualityReport | undefined
          const cached = await this.conversionCache.fetch(source, converter)
          if (cached) {
            copyFileSync(cached.markdownPath, rawPath)
            job.cancelRequested ||= this.loadJob(id).cancelRequested
            if (job.cancelRequested) throw new Error('任务已取消')
            ocrQuality = cached.ocrQuality
          } else {
            if (!useOcr) {
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
          }
          if (statSync(rawPath).size > MAX_RAW_MARKDOWN_BYTES)
            throw new Error(
              useOcr ? 'OCR 结果超过 20 MB，请先拆分原文件' : '转换结果超过 20 MB，请先拆分原文件'
            )
          if (!cached) await this.conversionCache.store(source, converter, rawPath, ocrQuality)
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
            ? ocrQuality?.averageConfidence
              ? `缓存命中：平均置信度 ${(ocrQuality.averageConfidence * 100).toFixed(0)}%`
              : '缓存命中：复用上次转换结果'
            : 'Markdown 转换完成'
          this.saveJob(job)
          if (job.options.mode === 'direct') {
            const directLines = toLines(raw)
            const solutionMarks = (raw.match(/【参考答案】/g) ?? []).length
            if (solutionMarks >= 3) {
              const solutions = parseSolutionBook(directLines)
              for (const [key, value] of solutions) directSolutions.set(key, value)
              file.state = 'ready'
              file.message = `解析册：提取 ${solutions.size} 条参考答案`
            } else {
              const questions = parseQuestionBook(directLines)
              const essays = parseEssayBook(directLines)
              trainingMarkers += solutionMarks === 0 ? countEssayTrainingMarks(directLines) : 0
              // 通道按产出规模择优：申论书的 OCR 残渣常让客观题解析器切出个位数伪题，
              // 按"客观题>0 就走客观题"会把整本申论错送管线（实测夸夸刷 58 单元 vs 3 伪题）。
              // 反向同理，行测题本的偶发训练字样不会盖过数百道客观题。
              if (essays.units.length >= questions.length && essays.units.length > 0) {
                directEssays.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  units: essays.units
                })
                file.state = 'ready'
                file.message = `切出 ${essays.units.length} 道申论题（无参考答案），批次结束后生成待审核产物`
              } else {
                directBooks.push({
                  sourceId: file.sourceId,
                  relativePath: file.relativePath,
                  questions,
                  groups: parseAnswerGroups(directLines)
                })
                file.state = 'ready'
                file.message = `题本：切出 ${questions.length} 题，批次结束后自动合并发布`
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
        const subject = job.options.subject === 'auto' ? 'xingce' : job.options.subject
        const subjectLabel =
          subject === 'xingce' ? '行测' : subject === 'shenlun' ? '申论' : '公共知识'
        // 去重基准：当前活动题库（发布目标与之一致）
        const activeVault = this.vaults.ensureBuiltinVault()
        const targetRoot = activeVault.isBuiltin ? this.managedVaultDirectory : activeVault.path
        const existingSignatures = this.vaults.questionSignatures(targetRoot)
        const batchSeen = new Set<string>()
        for (const book of directBooks) {
          const merged = mergeDirectQuestions(book.questions, directSolutions, book.groups, {
            subject,
            category: `${subjectLabel}-直导题库`,
            sourceFile: book.relativePath,
            tags: job.options.tags
          })
          const bookFile = job.files.find((file) => file.sourceId === book.sourceId)
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
          let bookStaged = 0
          for (const item of merged.items) {
            const signature = directSignature(item.stem, '', item.options[0]?.text ?? '')
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
              subject,
              title: safeTitle(item.stem.slice(0, 60), '未命名题目'),
              category: item.category,
              confidence: 1,
              generatedBy: 'direct-import',
              status: 'pending',
              warnings: [],
              preview: item.stem.slice(0, 180),
              markdown,
              evidenceExcerpt: item.stem.slice(0, 80)
            }
            this.saveArtifact(job, artifact)
            if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
            staged += 1
            bookStaged += 1
          }
          if (bookFile) {
            bookFile.state = 'ready'
            bookFile.artifactCount = bookStaged
            bookFile.message = `切出 ${bookStaged} 题${
              merged.verifiable
                ? `，配对校验 ${merged.verifiable - merged.skippedMisaligned}/${merged.verifiable} 通过`
                : ''
            }`
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
              evidenceExcerpt: unit.stem.slice(0, 80)
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
        job.message = staged
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
                : '直导完成：未切出题目（未识别出题目或全部缺少答案）'
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
      await execFileAsync(pythonPath, ['-c', 'import rapid_doc'], {
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

  private async findPythonLauncher(): Promise<{ command: string; args: string[] }> {
    const candidates =
      process.platform === 'win32'
        ? [
            { command: 'py', args: ['-3.12'] },
            { command: 'py', args: ['-3'] },
            // uv 等工具管理的 Python 只以 -V:Astral/... 标签注册，py -3 找不到，裸 py 会落到启动器默认环境
            { command: 'py', args: [] },
            { command: 'python', args: [] }
          ]
        : [
            { command: 'python3.12', args: [] },
            { command: 'python3', args: [] },
            { command: 'python', args: [] }
          ]
    for (const candidate of candidates) {
      try {
        const { stdout, stderr } = await execFileAsync(
          candidate.command,
          [...candidate.args, '--version'],
          { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }
        )
        const match = `${stdout}\n${stderr}`.match(/Python\s+(\d+)\.(\d+)/i)
        if (match && Number(match[1]) >= 3 && Number(match[2]) >= 10) return candidate
      } catch {
        // Try the next narrow launcher candidate.
      }
    }
    throw new Error('未找到 Python 3.10 或更高版本')
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
