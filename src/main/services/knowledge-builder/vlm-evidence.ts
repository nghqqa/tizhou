import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import type {
  AiImageInput,
  KnowledgeBuildFile,
  KnowledgeEngineStatus,
  VlmProofreadSuggestion
} from '../../../shared/contracts'
import { sha256Hex as hash } from '../../utils/common'
import type { AiService } from '../ai'
import {
  EVIDENCE_PAGE_LIMIT,
  collectEvidencePageKeys,
  evidenceAssetId,
  finalizeSourceEvidenceStatus,
  pageKey
} from '../source-evidence'
import {
  type AutoVlmStats,
  EVIDENCE_ASSET_MAX_BYTES,
  MAX_AUTO_VLM_PAGES,
  type StoredArtifact,
  type StoredJob,
  VLM_RENDER_MAX_SIDE,
  VLM_REVIEW_WARNING
} from './constants'
import {
  applyCorrectedMaterial,
  buildVlmProofreadMessages,
  collectProofreadPages,
  jsonObject,
  materialSectionRange,
  normalizeString,
  rebuildArtifactMarkdown,
  splitFrontmatter,
  validateVlmPayload
} from './markdown-helpers'

/** 读取证据资产 dataUrl：只允许 evidence/index.json 登记的相对路径，并做符号链接/realpath 双重逃逸校验。 */
export function readEvidenceAssetDataUrl(job: StoredJob, assetId: string): string {
  if (!/^ev-[0-9a-f]{20}$/.test(assetId)) throw new Error('证据资产 ID 无效')
  const evidenceDir = join(job.outputPath, 'evidence')
  let evidenceStats
  try {
    evidenceStats = lstatSync(evidenceDir)
  } catch {
    throw new Error('证据资产索引不存在或已损坏，请重新导入生成证据')
  }
  if (evidenceStats.isSymbolicLink()) throw new Error('证据目录非法（符号链接/junction），拒绝读取')
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
  if (
    registered === 'index.json' ||
    registered.startsWith('evidence/') ||
    registered.startsWith('evidence\\')
  )
    throw new Error('证据路径非法（索引格式不兼容）')
  const file = resolve(evidenceDir, registered)
  const rel = relative(evidenceDir, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('证据路径超出证据目录')
  let stats
  try {
    stats = lstatSync(file)
  } catch {
    throw new Error('证据文件不存在')
  }
  if (stats.isSymbolicLink()) throw new Error('证据路径非法（符号链接）')
  if (!stats.isFile()) throw new Error('证据目标不是普通文件')
  if (stats.size > EVIDENCE_ASSET_MAX_BYTES) throw new Error('证据文件超出大小上限')
  const real = realpathSync(file)
  const realRel = relative(realEvidenceDir, real)
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel))
    throw new Error('证据路径逃逸（realpath 校验失败）')
  return `data:image/jpeg;base64,${readFileSync(real).toString('base64')}`
}

export function readJobAssetDataUrlImpl(
  rootDirectory: string,
  sourceFilePath: string,
  assetPath: string
): string {
  const root = realpathSync(rootDirectory)
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

export async function renderVlmImagesForJob(params: {
  job: StoredJob
  pages: Array<{ sourceId: string; pageNumber: number }>
  engineStatus: () => Promise<KnowledgeEngineStatus>
  resolveSourceFile: (job: StoredJob, file: KnowledgeBuildFile) => string
  ocrWorkerPath: () => string
}): Promise<Map<string, string>> {
  const engine = await params.engineStatus()
  if (!engine.available || !engine.pythonPath)
    throw new Error('转换引擎不可用，无法渲染精校页面图片')
  const bySource = new Map<string, number[]>()
  for (const page of params.pages) {
    if (!params.job.files.some((file) => file.sourceId === page.sourceId))
      throw new Error('来源文件不属于当前任务')
    const list = bySource.get(page.sourceId) ?? []
    if (!list.includes(page.pageNumber)) list.push(page.pageNumber)
    bySource.set(page.sourceId, list)
  }
  const result = new Map<string, string>()
  const worker = params.ocrWorkerPath()
  for (const [sourceId, pageNumbers] of bySource) {
    const file = params.job.files.find((candidate) => candidate.sourceId === sourceId)
    if (!file) continue
    const dir = join(params.job.outputPath, 'vlm-pages', hash(sourceId).slice(0, 10))
    mkdirSync(dir, { recursive: true })
    const missing = pageNumbers.filter((n) => !existsSync(join(dir, `evidence-p${n}.jpg`)))
    if (missing.length) {
      const source = params.resolveSourceFile(params.job, file)
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

export async function renderEvidencePagesForJob(params: {
  job: StoredJob
  artifacts: StoredArtifact[]
  engineStatus: () => Promise<KnowledgeEngineStatus>
  resolveSourceFile: (job: StoredJob, file: KnowledgeBuildFile) => string
  ocrWorkerPath: () => string
  saveArtifact: (job: StoredJob, artifact: StoredArtifact) => void
}): Promise<number> {
  const { job, artifacts } = params
  const pageKeys = collectEvidencePageKeys(artifacts)
  if (pageKeys.size === 0 || pageKeys.size > EVIDENCE_PAGE_LIMIT) {
    for (const artifact of artifacts) {
      if (!artifact.sourceEvidence) continue
      for (const reference of artifact.sourceEvidence.references)
        for (const page of reference.pages) delete page.evidenceAssetId
      finalizeSourceEvidenceStatus(artifact.sourceEvidence)
      params.saveArtifact(job, artifact)
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
  const engine = await params.engineStatus()
  for (const [sourceId, pageNumbers] of bySource) {
    const file = job.files.find((candidate) => candidate.sourceId === sourceId)
    if (!file || !engine.pythonPath) continue
    try {
      const source = params.resolveSourceFile(job, file)
      const dirHash = hash(sourceId).slice(0, 10)
      const dir = join(evidenceDir, dirHash)
      mkdirSync(dir, { recursive: true })
      const pagesArg = [...pageNumbers].sort((a, b) => a - b).join(',')
      const worker = params.ocrWorkerPath()
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
          engine.pythonPath!,
          [worker, source, dir, '--render-evidence', pagesArg],
          {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'ignore', 'ignore']
          }
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
    params.saveArtifact(job, artifact)
  }
  return assetIndex.size
}

export async function runVlmProofreadArtifact(params: {
  job: StoredJob
  artifact: StoredArtifact
  ai: AiService
  renderVlmPageImages: (
    job: StoredJob,
    pages: Array<{ sourceId: string; pageNumber: number }>
  ) => Promise<Map<string, string>>
}): Promise<VlmProofreadSuggestion> {
  const { job, artifact, ai } = params
  const vlm = ai.getVlmConfig()
  if (!vlm.enabled) throw new Error('VLM 按页精校未开启：请在工坊顶部或模型设置打开开关后再使用')
  const pages = collectProofreadPages(artifact.sourceEvidence)
  if (!pages.length)
    throw new Error('该产物没有可用的来源 PDF 页（来源证据缺失或不可渲染），无法按页精校')
  const imageDataUrls = await params.renderVlmPageImages(job, pages)
  const images: AiImageInput[] = pages.map((page) => ({
    mimeType: 'image/jpeg' as const,
    dataUrl: imageDataUrls.get(pageKey(page.sourceId, page.pageNumber)) ?? ''
  }))
  if (images.some((image) => !image.dataUrl)) throw new Error('精校页面图片渲染失败，请稍后重试')
  const response = await ai.askVision({
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
    jobId: job.id,
    artifactId: artifact.id,
    correctedMarkdown: rebuildArtifactMarkdown(artifact.markdown, validated.correctedBody),
    changes: validated.changes,
    uncertainItems: validated.uncertainItems,
    summary: validated.summary,
    pages
  }
}

export async function runAutoVlmPreproofread(params: {
  job: StoredJob
  artifacts: StoredArtifact[]
  ai: AiService
  isCancelled: () => boolean
  renderVlmPageImages: (
    job: StoredJob,
    pages: Array<{ sourceId: string; pageNumber: number }>
  ) => Promise<Map<string, string>>
  saveArtifact: (job: StoredJob, artifact: StoredArtifact) => void
}): Promise<AutoVlmStats> {
  const { job, artifacts, ai } = params
  const vlm = ai.getVlmConfig()
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
  const imageDataUrls = await params.renderVlmPageImages(
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
    if (params.isCancelled()) break
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
      const response = await ai.askVision({
        messages: buildVlmProofreadMessages(
          content,
          [{ sourceId: group.sourceId, pageNumber: group.pageNumber }],
          scope,
          [{ mimeType: 'image/jpeg', dataUrl }]
        )
      })
      calls += 1
      const validated = validateVlmPayload(jsonObject(response.content))
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
        params.saveArtifact(job, artifact)
        applied += 1
      }
    } catch {
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
