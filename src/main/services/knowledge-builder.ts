import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
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
  KnowledgeSourceScan,
  OcrQualityReport,
  VaultIndexResult,
  VlmProofreadSuggestion
} from '../../shared/contracts'
import { isWithin, now, sha256Hex as hash } from '../utils/common'
import { AiService } from './ai'
import { ConversionCache } from './conversion-cache'
import type { PipSource } from './pip-mirror'
import { VaultService } from './vault'
import {
  IGNORED_DIRECTORIES,
  IMAGE_ASSET_PATTERN,
  IMAGE_EXTENSIONS,
  INCOMPLETE_EXTENSIONS,
  MAX_AUTO_VLM_PAGES,
  MAX_MARKDOWN_EDIT_BYTES,
  MAX_SELECTED_FILES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  OCR_WORKER_POLICY_VERSION,
  SUPPORTED_EXTENSIONS,
  VIDEO_EXTENSIONS,
  VLM_PROOFREAD_MAX_PAGES,
  VLM_RENDER_MAX_SIDE,
  VLM_REVIEW_WARNING,
  buildConversionConverterKey,
  partitionByPublishGate,
  type AutoVlmStats,
  type StoredArtifact,
  type StoredJob
} from './knowledge-builder/constants'
import { KnowledgeEngineManager, type EngineManagerHost } from './knowledge-builder/engine-manager'
import { executeJobPipeline } from './knowledge-builder/job-stages'
import {
  assertFrontmatterIntact,
  atomicWriteFile,
  normalizeString,
  safeTitle,
  serializeFrontmatter,
  syncFrontmatterFromBody
} from './knowledge-builder/markdown-helpers'
import {
  readEvidenceAssetDataUrl,
  readJobAssetDataUrlImpl,
  renderEvidencePagesForJob,
  renderVlmImagesForJob,
  runAutoVlmPreproofread,
  runVlmProofreadArtifact
} from './knowledge-builder/vlm-evidence'

export {
  MAX_AUTO_VLM_PAGES,
  OCR_WORKER_POLICY_VERSION,
  VLM_PROOFREAD_MAX_PAGES,
  VLM_RENDER_MAX_SIDE,
  VLM_REVIEW_WARNING,
  buildConversionConverterKey,
  partitionByPublishGate
}

export class KnowledgeBuilderService {
  private readonly rootDirectory: string
  private readonly jobsDirectory: string
  private readonly engineDirectory: string
  private readonly managedVaultDirectory: string
  private readonly conversionCache: ConversionCache
  private readonly engineManager: KnowledgeEngineManager
  private runningJobId?: string
  private startingJob = false
  private runningChild?: ReturnType<typeof spawn>

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
    this.engineManager = new KnowledgeEngineManager(this.engineDirectory, this.resourceDirectory)
    mkdirSync(this.jobsDirectory, { recursive: true })
    mkdirSync(this.engineDirectory, { recursive: true })
    mkdirSync(this.managedVaultDirectory, { recursive: true })
    this.recoverInterruptedJobs()
  }

  private engineHost(): EngineManagerHost {
    return {
      hasRunningJob: () => Boolean(this.runningJobId),
      setRunningChild: (child) => {
        this.runningChild = child
      },
      pipInstallWithProgress: (pythonPath, spec, base, span, phase) =>
        this.pipInstallWithProgress(pythonPath, spec, base, span, phase),
      runPipInstall: (pythonPath, spec, source, base, span, phase) =>
        this.runPipInstall(pythonPath, spec, source, base, span, phase)
    }
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

  engineStatus(): Promise<KnowledgeEngineStatus> {
    return this.engineManager.engineStatus()
  }

  installEngine(): Promise<KnowledgeEngineStatus> {
    return this.engineManager.installEngine(this.engineHost())
  }

  installGpuAccelerator(): Promise<KnowledgeEngineStatus> {
    return this.engineManager.installGpuAccelerator(this.engineHost())
  }

  removeGpuAccelerator(): Promise<KnowledgeEngineStatus> {
    return this.engineManager.removeGpuAccelerator(this.engineHost())
  }

  setPipMirror(mirrorId: string): Promise<void> {
    return this.engineManager.setPipMirror(mirrorId)
  }

  private resolveMirrorQueue(): Promise<PipSource[]> {
    return this.engineManager.resolveMirrorQueue()
  }

  private promoteMirrorSource(source: PipSource): void {
    this.engineManager.promoteMirrorSource(source)
  }

  private pipInstallWithProgress(
    pythonPath: string,
    spec: string,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    return this.engineManager.pipInstallWithProgress(
      (py, s, src, b, sp, ph) => this.runPipInstall(py, s, src, b, sp, ph),
      pythonPath,
      spec,
      base,
      span,
      phase
    )
  }

  private runPipInstall(
    pythonPath: string,
    spec: string,
    source: PipSource,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    return this.engineManager.runPipInstall(pythonPath, spec, source, base, span, phase)
  }

  async startJob(input: {
    sourcePath: string
    fileIds: string[]
    options: KnowledgeBuildOptions
  }): Promise<KnowledgeBuildJob> {
    if (this.runningJobId || this.startingJob) throw new Error('已有知识构建任务正在运行')
    if (!input.options.rightsConfirmed)
      throw new Error('请先确认你有权处理所选资料，并会在发布前人工复核')
    const ids = [...new Set(input.fileIds)]
    if (!ids.length) throw new Error('至少选择一个可转换文件')
    if (ids.length > MAX_SELECTED_FILES)
      throw new Error(`单个批次最多处理 ${MAX_SELECTED_FILES} 个文件`)
    this.startingJob = true
    try {
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
      this.runningJobId = id
      void this.runJob(id).catch((error) => {
        const failed = this.loadJob(id)
        failed.status = 'failed'
        failed.message = error instanceof Error ? error.message : '后台任务异常结束'
        failed.updatedAt = now()
        this.saveJob(failed)
        if (this.runningJobId === id) {
          this.runningJobId = undefined
          this.runningChild = undefined
        }
      })
      return this.jobView(job)
    } finally {
      this.startingJob = false
    }
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

  dispose(): void {
    if (this.runningJobId) {
      try {
        this.cancelJob(this.runningJobId)
      } catch {
        /* 退出清理时忽略任务状态读写异常 */
      }
    }
    if (this.runningChild && !this.runningChild.killed) {
      try {
        this.runningChild.kill()
      } catch {
        /* 忽略已退出子进程 */
      }
    }
    this.runningChild = undefined
    this.runningJobId = undefined
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
    if (status === 'pending' && artifact.status === 'pending')
      throw new Error('该产物已处于待审核状态')
    artifact.status = status
    this.saveArtifact(job, artifact)
    job.updatedAt = now()
    this.saveJob(job)
    return this.jobView(job)
  }

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

  cacheStats() {
    return this.conversionCache.stats()
  }

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
    const { allowed, blocked } = partitionByPublishGate(approved)
    if (!approved.length) throw new Error('没有已批准且尚未发布的产物')
    if (!allowed.length)
      throw new Error(
        `没有可发布的产物：${blocked.length} 项处于能力边界限制（图形推理图片题/配对待确认等），` +
          '请在审核详情中查看原始页面并勾选人工确认后重试'
      )
    const isDirect = job.options.mode === 'direct'
    const activeVault = this.vaults.ensureBuiltinVault()
    const directToUserVault = isDirect && !activeVault.isBuiltin
    const targetRoot = directToUserVault ? activeVault.path : this.managedVaultDirectory
    const staged: Array<{ artifact: StoredArtifact; target: string; content: string }> = []
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
    for (const item of staged) atomicWriteFile(item.target, item.content)
    const rawImagesDir = join(job.outputPath, 'raw', 'images')
    if (existsSync(rawImagesDir)) {
      const imageTargets = isDirect
        ? [join(targetRoot, '直导题库', 'images')]
        : [...new Set(staged.map((item) => join(resolve(item.target, '..'), 'images')))]
      const imageFiles = readdirSync(rawImagesDir).filter((imageName) => {
        if (!IMAGE_ASSET_PATTERN.test(imageName)) return false
        try {
          return statSync(join(rawImagesDir, imageName)).isFile()
        } catch {
          return false
        }
      })
      for (const vaultImagesDir of imageTargets) {
        mkdirSync(vaultImagesDir, { recursive: true })
        for (const imageName of imageFiles) {
          const to = join(vaultImagesDir, imageName)
          if (!existsSync(to)) copyFileSync(join(rawImagesDir, imageName), to)
        }
      }
    }
    const result = this.vaults.connect(targetRoot)
    this.vaults.startWatching?.()
    for (const item of staged) {
      item.artifact.status = 'published'
      this.saveArtifact(job, item.artifact)
    }
    job.publishedVaultPath = targetRoot
    job.status = 'completed'
    job.message = isDirect
      ? `已发布 ${staged.length} 题到${directToUserVault ? '当前题库' : '应用管理知识库'}的「直导题库」目录并完成重索引` +
        (blocked.length ? `；${blocked.length} 项因能力边界未发布，需人工确认` : '')
      : `已发布 ${staged.length} 个产物并切换到应用管理知识库`
    job.updatedAt = now()
    this.saveJob(job)
    return result
  }

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
    const targetRoot =
      job.publishedVaultPath && existsSync(job.publishedVaultPath)
        ? job.publishedVaultPath
        : activeVault.isBuiltin
          ? this.managedVaultDirectory
          : activeVault.path
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
    try {
      this.vaults.connect(targetRoot)
      this.vaults.startWatching?.()
    } catch {
      // 若撤销后目录内已无剩余有效题库文件，安全回退到内置示例库避免崩溃
      this.vaults.ensureBuiltinVault()
    }
    job.status = 'completed'
    job.message = `已撤销本次导入：移除 ${removed} 个题目文件并重新索引`
    job.updatedAt = now()
    this.saveJob(job)
    return { removed }
  }

  private async runJob(id: string): Promise<void> {
    if (this.runningJobId && this.runningJobId !== id) throw new Error('已有知识构建任务正在运行')
    this.runningJobId = id
    await executeJobPipeline(
      {
        ai: this.ai,
        vaults: this.vaults,
        managedVaultDirectory: this.managedVaultDirectory,
        getConversionCache: () => this.conversionCache,
        engineStatus: () => this.engineStatus(),
        workerPath: () => this.engineManager.workerPath(),
        ocrAcceleratorMode: () => this.engineManager.ocrAcceleratorMode(),
        loadJob: (jobId) => this.loadJob(jobId),
        saveJob: (job) => this.saveJob(job),
        loadArtifact: (job, artifactId) => this.loadArtifact(job, artifactId),
        saveArtifact: (job, artifact) => this.saveArtifact(job, artifact),
        resolveSourceFile: (job, file) => this.resolveSourceFile(job, file),
        convert: (py, w, s, o) => this.convert(py, w, s, o),
        structuredConvert: (py, s, r) => this.structuredConvert(py, s, r),
        ocrConvert: (job, f, py, s, o) => this.ocrConvert(job, f, py, s, o),
        renderJobEvidence: (job, artifacts) => this.renderJobEvidence(job, artifacts),
        autoVlmPreproofread: (job, artifacts) => this.autoVlmPreproofread(job, artifacts),
        clearRunningState: () => {
          this.runningJobId = undefined
          this.runningChild = undefined
        }
      },
      id
    )
  }

  private convert(
    pythonPath: string,
    workerPath: string,
    sourcePath: string,
    outputPath: string
  ): Promise<void> {
    return this.engineManager.spawnMarkitdownConvert(
      pythonPath,
      workerPath,
      sourcePath,
      outputPath,
      (child) => {
        this.runningChild = child
      }
    )
  }

  private structuredConvert(
    pythonPath: string,
    sourcePath: string,
    rawPath: string
  ): Promise<{ ok: boolean; quality?: OcrQualityReport }> {
    return this.engineManager.spawnStructuredConvert(pythonPath, sourcePath, rawPath, (child) => {
      this.runningChild = child
    })
  }

  private ocrConvert(
    job: StoredJob,
    file: KnowledgeBuildFile,
    pythonPath: string,
    sourcePath: string,
    outputPath: string
  ): Promise<OcrQualityReport | undefined> {
    return this.engineManager.spawnOcrConvert(
      file,
      pythonPath,
      sourcePath,
      outputPath,
      () => this.saveJob(job),
      (child) => {
        this.runningChild = child
      }
    )
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

  readEvidenceAsset(jobId: string, assetId: string): string {
    if (!/^ev-[0-9a-f]{20}$/.test(assetId)) throw new Error('证据资产 ID 无效')
    const job = this.loadJob(jobId)
    return readEvidenceAssetDataUrl(job, assetId)
  }

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

  async vlmProofreadArtifact(jobId: string, artifactId: string): Promise<VlmProofreadSuggestion> {
    const job = this.loadJob(jobId)
    if (['queued', 'running', 'cancelling'].includes(job.status))
      throw new Error('请等待转换任务结束后再精校')
    if (!job.artifactIds.includes(artifactId)) throw new Error('产物不属于该任务')
    const artifact = this.loadArtifact(job, artifactId)
    if (artifact.status === 'published') throw new Error('已发布产物不能修改，无需精校')
    return runVlmProofreadArtifact({
      job,
      artifact,
      ai: this.ai,
      renderVlmPageImages: (targetJob, pages) => this.renderVlmPageImages(targetJob, pages)
    })
  }

  private renderVlmPageImages(
    job: StoredJob,
    pages: Array<{ sourceId: string; pageNumber: number }>
  ): Promise<Map<string, string>> {
    return renderVlmImagesForJob({
      job,
      pages,
      engineStatus: () => this.engineStatus(),
      resolveSourceFile: (targetJob, file) => this.resolveSourceFile(targetJob, file),
      ocrWorkerPath: () => this.engineManager.ocrWorkerPath()
    })
  }

  private autoVlmPreproofread(job: StoredJob, artifacts: StoredArtifact[]): Promise<AutoVlmStats> {
    return runAutoVlmPreproofread({
      job,
      artifacts,
      ai: this.ai,
      isCancelled: () => this.loadJob(job.id).cancelRequested,
      renderVlmPageImages: (targetJob, pages) => this.renderVlmPageImages(targetJob, pages),
      saveArtifact: (targetJob, artifact) => this.saveArtifact(targetJob, artifact)
    })
  }

  private renderJobEvidence(job: StoredJob, artifacts: StoredArtifact[]): Promise<number> {
    return renderEvidencePagesForJob({
      job,
      artifacts,
      engineStatus: () => this.engineStatus(),
      resolveSourceFile: (targetJob, file) => this.resolveSourceFile(targetJob, file),
      ocrWorkerPath: () => this.engineManager.ocrWorkerPath(),
      saveArtifact: (targetJob, artifact) => this.saveArtifact(targetJob, artifact)
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

  private saveJob(job: StoredJob, options?: { allowResetCancel?: boolean }): void {
    const jobFile = join(this.jobDirectory(job.id), 'job.json')
    if (!options?.allowResetCancel && !job.cancelRequested && existsSync(jobFile)) {
      try {
        const disk = JSON.parse(readFileSync(jobFile, 'utf8')) as Partial<StoredJob>
        if (disk.cancelRequested) {
          job.cancelRequested = true
          if (job.status === 'running' || job.status === 'queued') {
            job.status = 'cancelling'
          }
        }
      } catch {
        // 忽略读取失败，继续原子写入当前状态
      }
    }
    job.updatedAt = now()
    mkdirSync(this.jobDirectory(job.id), { recursive: true })
    atomicWriteFile(jobFile, JSON.stringify(job, null, 2))
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
    atomicWriteFile(this.artifactPath(job, artifact.id), JSON.stringify(artifact, null, 2))
  }

  readJobAssetDataUrl(sourceFilePath: string, assetPath: string): string {
    return readJobAssetDataUrlImpl(this.rootDirectory, sourceFilePath, assetPath)
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
        this.saveJob(job, { allowResetCancel: true })
      } catch {
        // A damaged manifest is isolated from other jobs and can be inspected in its folder.
      }
    }
  }
}
