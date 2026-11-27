import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  ImportCapability,
  KnowledgeBuildFile,
  KnowledgeEngineStatus,
  OcrQualityReport,
  Subject
} from '../../../shared/contracts'
import { FEATURE_PROMPTS, sourceEnvelope, taskDataEnvelope } from '../../../shared/prompts'
import { inspectShenlunMaterialQuality, normalizeShenlunText } from '../../../shared/shenlun'
import { now, sha256Hex as hash } from '../../utils/common'
import type { AiService } from '../ai'
import type { ConversionCache } from '../conversion-cache'
import { mergeByDocumentOrder } from '../direct-sequential-merge'
import {
  bindGraphicOptionsByGeometry,
  buildGraphicPreservation,
  extractGraphicQuestions,
  GRAPHIC_AUTO_STRUCTURE,
  isGraphicCandidate,
  mergeGraphicQuestions
} from '../graphic-import'
import {
  CAPABILITY_LABELS,
  batchFactsMessage,
  classifyFileCapability,
  collectPageFacts,
  loadStructuredRegions,
  scanNumericAnomalies,
  scanTableQuality,
  tierForArtifact,
  type ImportBatchFacts
} from '../import-quality'
import {
  directQuestionMarkdown,
  directSignature,
  mergeDirectQuestions,
  parseAnswerGroups,
  parseEssayBook,
  parseQuestionBook,
  parseSolutionBook,
  toLinesWithPageMap,
  type DirectQuestion
} from '../question-import'
import {
  buildSourceEvidence,
  computeTraceCoverage,
  manifestFromRegions,
  parsePageManifest,
  traceCoverageMessage,
  type PageManifest,
  type ReferenceBuildInput
} from '../source-evidence'
import type { VaultService } from '../vault'
import {
  type AutoVlmStats,
  type DirectBatchCollector,
  GRAPHIC_ONLY_MAX_TEXT_QUESTIONS,
  MAX_RAW_MARKDOWN_BYTES,
  type StoredArtifact,
  type StoredJob,
  buildConversionConverterKey
} from './constants'
import {
  buildArtifactEvidence,
  candidateMarkdown,
  chunkText,
  compact,
  countEssayTrainingMarks,
  isPdfFile,
  jsonObject,
  readFileSyncSafe,
  safeTitle,
  validateCandidate
} from './markdown-helpers'

export interface JobPipelineHost {
  ai: AiService
  vaults: VaultService
  managedVaultDirectory: string
  getConversionCache: () => ConversionCache
  engineStatus: () => Promise<KnowledgeEngineStatus>
  workerPath: () => string
  ocrAcceleratorMode: () => 'cpu' | 'dml'
  loadJob: (id: string) => StoredJob
  saveJob: (job: StoredJob) => void
  loadArtifact: (job: StoredJob, artifactId: string) => StoredArtifact
  saveArtifact: (job: StoredJob, artifact: StoredArtifact) => void
  resolveSourceFile: (job: StoredJob, file: KnowledgeBuildFile) => string
  convert: (
    pythonPath: string,
    workerPath: string,
    sourcePath: string,
    outputPath: string
  ) => Promise<void>
  structuredConvert: (
    pythonPath: string,
    sourcePath: string,
    rawPath: string
  ) => Promise<{ ok: boolean; quality?: OcrQualityReport }>
  ocrConvert: (
    job: StoredJob,
    file: KnowledgeBuildFile,
    pythonPath: string,
    sourcePath: string,
    outputPath: string
  ) => Promise<OcrQualityReport | undefined>
  renderJobEvidence: (job: StoredJob, artifacts: StoredArtifact[]) => Promise<number>
  autoVlmPreproofread: (job: StoredJob, artifacts: StoredArtifact[]) => Promise<AutoVlmStats>
  clearRunningState: () => void
}

async function convertAndCacheSourceFile(
  host: JobPipelineHost,
  job: StoredJob,
  file: KnowledgeBuildFile,
  source: string,
  rawPath: string,
  engine: KnowledgeEngineStatus & { pythonPath: string },
  workerPath: string
): Promise<{ raw: string; useStructured: boolean }> {
  const conversionCache = host.getConversionCache()
  const useStructured =
    engine.structuredParseAvailable &&
    isPdfFile(file.relativePath) &&
    !/解析|答案/.test(basename(file.relativePath))
  const useOcr = engine.ocrAvailable && isPdfFile(file.relativePath)
  let structuredOk: boolean | undefined = true
  const structuredConverterKey = buildConversionConverterKey('structured')
  const ocrConverterKey = buildConversionConverterKey('ocr')
  const converter = useStructured
    ? structuredConverterKey
    : useOcr
      ? ocrConverterKey
      : buildConversionConverterKey('markitdown')
  let effectiveConverter = converter
  let ocrQuality: OcrQualityReport | undefined

  for (const sidecar of ['_regions.json', '_pages.json'])
    rmSync(join(job.outputPath, 'raw', 'images', sidecar), { force: true })

  const cached = job.options.ignoreConversionCache
    ? undefined
    : await conversionCache.fetch(source, converter)
  if (cached) {
    copyFileSync(cached.markdownPath, rawPath)
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
    job.cancelRequested ||= host.loadJob(job.id).cancelRequested
    if (job.cancelRequested) throw new Error('任务已取消')
    ocrQuality = cached.ocrQuality
  } else if (useStructured) {
    file.message = '结构解析中（表格还原 / 图形保真）'
    host.saveJob(job)
    const structuredResult = await host.structuredConvert(engine.pythonPath, source, rawPath)
    structuredOk = structuredResult.ok
    if (structuredResult.quality) ocrQuality = structuredResult.quality
    job.cancelRequested ||= host.loadJob(job.id).cancelRequested
    if (job.cancelRequested) throw new Error('任务已取消')
    if (!structuredOk) {
      effectiveConverter = ocrConverterKey
      file.message = '结构解析不可用，回退 OCR 识别'
      host.saveJob(job)
      ocrQuality = await host.ocrConvert(job, file, engine.pythonPath, source, rawPath)
      job.cancelRequested ||= host.loadJob(job.id).cancelRequested
      if (job.cancelRequested) throw new Error('任务已取消')
    }
  } else if (!useOcr) {
    file.message = '正在转换为 Markdown'
    host.saveJob(job)
    await host.convert(engine.pythonPath, workerPath, source, rawPath)
    job.cancelRequested ||= host.loadJob(job.id).cancelRequested
    if (job.cancelRequested) throw new Error('任务已取消')
  } else {
    file.message = `正在逐页检测文字层并识别${host.ocrAcceleratorMode() === 'dml' ? '（GPU 加速）' : ''}`
    host.saveJob(job)
    ocrQuality = await host.ocrConvert(job, file, engine.pythonPath, source, rawPath)
    job.cancelRequested ||= host.loadJob(job.id).cancelRequested
    if (job.cancelRequested) throw new Error('任务已取消')
  }

  if (statSync(rawPath).size > MAX_RAW_MARKDOWN_BYTES)
    throw new Error(
      useStructured || useOcr
        ? 'OCR 结果超过 20 MB，请先拆分原文件'
        : '转换结果超过 20 MB，请先拆分原文件'
    )
  const imagesDir = join(dirname(rawPath), 'images')
  if (!cached)
    await conversionCache.store(
      source,
      effectiveConverter,
      rawPath,
      ocrQuality,
      existsSync(imagesDir) ? imagesDir : undefined
    )

  if (useStructured) {
    const structuredText = readFileSync(rawPath, 'utf8')
    if ((structuredText.match(/【参考答案(及正确率)?】/g) ?? []).length >= 3) {
      file.message = '解析册：结构重排不利切块，改用逐页 OCR 文本'
      host.saveJob(job)
      const ocrCached = await conversionCache.fetch(source, ocrConverterKey)
      if (ocrCached) {
        copyFileSync(ocrCached.markdownPath, rawPath)
        if (ocrCached.imagesDir) {
          try {
            mkdirSync(imagesDir, { recursive: true })
            for (const name of readdirSync(ocrCached.imagesDir)) {
              copyFileSync(join(ocrCached.imagesDir, name), join(imagesDir, name))
            }
          } catch {
            // 图片/页码清单恢复失败不阻塞文本切块
          }
        }
        ocrQuality = ocrCached.ocrQuality
      } else {
        ocrQuality = await host.ocrConvert(job, file, engine.pythonPath, source, rawPath)
        await conversionCache.store(
          source,
          ocrConverterKey,
          rawPath,
          ocrQuality,
          existsSync(imagesDir) ? imagesDir : undefined
        )
      }
      job.cancelRequested ||= host.loadJob(job.id).cancelRequested
      if (job.cancelRequested) throw new Error('任务已取消')
    }
  }

  const raw = readFileSync(rawPath, 'utf8').trim()
  file.fromCache = Boolean(cached)
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
  host.saveJob(job)
  return { raw, useStructured }
}

function classifyDirectFile(params: {
  collector: DirectBatchCollector
  job: StoredJob
  file: KnowledgeBuildFile
  raw: string
  rawPath: string
  useStructured: boolean
  subject: Subject | 'common'
  subjectLabel: string
}): void {
  const { collector, job, file, raw, rawPath, useStructured, subject, subjectLabel } = params
  const ocrQuality = file.ocrQuality
  const imagesDir = join(dirname(rawPath), 'images')
  let pageManifest: PageManifest | undefined
  const structuredRegions = loadStructuredRegions(imagesDir)
  if (useStructured && structuredRegions) {
    pageManifest = manifestFromRegions(structuredRegions.regions)
  }
  if (!pageManifest) {
    pageManifest = parsePageManifest(readFileSyncSafe(join(imagesDir, '_pages.json')))
  }
  const { lines: directLines, pageMap: fileLinePageMap } = toLinesWithPageMap(raw, pageManifest)
  const solutionMarks = (raw.match(/【参考答案(及正确率)?】/g) ?? []).length
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
      collector.directSolutions.set(key, value)
      collector.solutionSourceOf.set(key, file.sourceId)
    }
    collector.solutionPageMaps.set(file.sourceId, fileLinePageMap)
    file.state = 'ready'
    file.message = `解析册：提取 ${solutions.size} 条参考答案`
    return
  }

  const questions = parseQuestionBook(directLines)
  const essays = parseEssayBook(directLines)
  const fileTrainingMarks = solutionMarks === 0 ? countEssayTrainingMarks(directLines) : 0
  collector.trainingMarkers += fileTrainingMarks
  const regions = useStructured
    ? loadStructuredRegions(join(dirname(rawPath), 'images'))
    : undefined
  const graphicCandidate = regions ? isGraphicCandidate(regions) : false
  const graphic =
    graphicCandidate && GRAPHIC_AUTO_STRUCTURE.enabled
      ? extractGraphicQuestions(regions!)
      : undefined
  const textUsable = questions.filter((question) => question.options.length >= 2).length
  const graphicOnly = graphicCandidate && textUsable < GRAPHIC_ONLY_MAX_TEXT_QUESTIONS

  if (graphicOnly && !GRAPHIC_AUTO_STRUCTURE.enabled) {
    const pages = buildGraphicPreservation(regions!, file.relativePath)
    collector.directPreservation.push({
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
    return
  }

  if (graphic && graphic.questions.length >= 3 && textUsable < graphic.questions.length) {
    const merged = mergeGraphicQuestions(
      graphic.questions,
      collector.directSolutions,
      {
        subject,
        category: `${subjectLabel}-直导题库`,
        sourceFile: file.relativePath,
        tags: job.options.tags
      },
      graphic.notes
    )
    collector.directBooks.push({
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
    return
  }

  if (essays.units.length >= questions.length && essays.units.length > 0) {
    collector.directEssays.push({
      sourceId: file.sourceId,
      relativePath: file.relativePath,
      units: essays.units,
      linePageMap: fileLinePageMap
    })
    file.state = 'ready'
    file.message = `切出 ${essays.units.length} 道申论题（无参考答案），批次结束后生成待审核产物`
    return
  }

  if (questions.length === 0 && fileTrainingMarks === 0) {
    const figureImages = regions?.regions.filter((r) => r.type === 'image' && r.imgPath).length ?? 0
    const capability: ImportCapability =
      useStructured && figureImages >= 5 ? 'image-only-review' : 'unsupported-auto-structure'
    collector.directPreservation.push({
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
    return
  }

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
  const binding = regions ? bindGraphicOptionsByGeometry(questions, regions) : undefined
  collector.directBooks.push({
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
    binding && binding.bound + binding.partial + binding.stemOnly + binding.skipped > 0
      ? `，图推 ${binding.bound + binding.partial + binding.stemOnly} 题已附图（待核对 ${binding.skipped} 题）`
      : ''
  file.state = 'ready'
  file.message = `${CAPABILITY_LABELS[capability]} · 切出 ${questions.length} 题${bindingNote}，批次结束后自动合并发布`
}

async function finalizeDirectBatch(
  host: JobPipelineHost,
  job: StoredJob,
  collector: DirectBatchCollector,
  subject: Subject | 'common',
  subjectLabel: string
): Promise<void> {
  let staged = 0
  let skippedNoAnswer = 0
  let skippedIncomplete = 0
  let skippedMisaligned = 0
  let skippedDuplicate = 0
  let abortedBooks = 0
  const activeVault = host.vaults.ensureBuiltinVault()
  const targetRoot = activeVault.isBuiltin ? host.managedVaultDirectory : activeVault.path
  const existingSignatures = host.vaults.questionSignatures(targetRoot)
  const batchSeen = new Set<string>()

  const pushArtifact = (artifact: StoredArtifact): void => {
    host.saveArtifact(job, artifact)
    if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
    staged += 1
  }

  for (const preserved of collector.directPreservation) {
    const bookFile = job.files.find((file) => file.sourceId === preserved.sourceId)
    let preservedStaged = 0
    for (const doc of preserved.docs) {
      if (batchSeen.has(doc.id)) {
        skippedDuplicate += 1
        continue
      }
      batchSeen.add(doc.id)
      pushArtifact({
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
      })
      preservedStaged += 1
    }
    if (bookFile) {
      bookFile.state = 'ready'
      bookFile.artifactCount = preservedStaged
      bookFile.message = preserved.summary
    }
  }

  for (const book of collector.directBooks) {
    const bookFile = job.files.find((file) => file.sourceId === book.sourceId)
    if (book.graphic) {
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
        pushArtifact({
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
          warnings: [...(book.qualityWarnings ?? []), ...(book.graphic.itemWarnings[index] ?? [])],
          preview: item.stem.slice(0, 180),
          markdown: directQuestionMarkdown(item),
          evidenceExcerpt: item.stem.slice(0, 80),
          capability: 'graphic-review'
        })
        graphicStaged += 1
      }
      if (bookFile) {
        bookFile.state = 'ready'
        bookFile.artifactCount = graphicStaged
        bookFile.message = `${book.graphic.summary} · 入库待审核 ${graphicStaged} 题`
      }
      continue
    }

    let merged = mergeDirectQuestions(book.questions, collector.directSolutions, book.groups, {
      subject,
      category: `${subjectLabel}-直导题库`,
      sourceFile: book.relativePath,
      tags: job.options.tags,
      solutionSourceOf: collector.solutionSourceOf
    })
    if ((merged.aborted || merged.items.length === 0) && collector.directSolutions.size > 0) {
      const sequential = mergeByDocumentOrder(book.questions, collector.directSolutions, {
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
    const pairingUnconfirmed =
      merged.verifiable > 0 &&
      (merged.verifiedPassed ?? merged.verifiable - merged.skippedMisaligned) === 0
    const offsetAdjusted = merged.offsetAdjustedSets ?? 0
    const materialWarnedGroups = new Set<string>()
    let bookStaged = 0
    for (const item of merged.items) {
      const signature = directSignature(item.stem, item.material ?? '', item.options[0]?.text ?? '')
      if (existingSignatures.has(signature) || batchSeen.has(signature)) {
        skippedDuplicate += 1
        continue
      }
      batchSeen.add(signature)
      const markdown = directQuestionMarkdown(item)
      const groupFirst = !item.groupId || !materialWarnedGroups.has(item.groupId)
      if (item.groupId) materialWarnedGroups.add(item.groupId)
      const graphicNotes = book.graphicNotes?.get(`${item.set}-${item.num}`) ?? []
      const needsGraphicReview =
        graphicNotes.length > 0 || item.options.some((option) => option.image)
      pushArtifact({
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
          ...(pairingUnconfirmed ? ['配对待确认：题本与解析未通过相似度校验，答案需人工核对'] : []),
          ...(offsetAdjusted ? ['答案已通过相似度校正，建议抽查'] : []),
          ...(item.cleanupWarnings ?? []),
          ...graphicNotes
        ],
        capability: needsGraphicReview ? 'graphic-review' : book.capability,
        preview: item.stem.slice(0, 180),
        markdown,
        evidenceExcerpt: item.stem.slice(0, 80),
        sourceEvidence: buildArtifactEvidence(
          item,
          book.sourceId,
          book.relativePath,
          book.linePageMap,
          collector.solutionPageMaps
        )
      })
      bookStaged += 1
    }
    if (bookFile) {
      const verifiedPassed = merged.verifiedPassed ?? merged.verifiable - merged.skippedMisaligned
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

  let stagedEssays = 0
  for (const book of collector.directEssays) {
    const bookFile = job.files.find((file) => file.sourceId === book.sourceId)
    let bookStaged = 0
    let bookClean = 0
    let bookIncomplete = 0
    for (const unit of book.units) {
      const cleanStem = normalizeShenlunText(unit.stem).trim()
      const cleanMaterial = unit.material ? normalizeShenlunText(unit.material).trim() : undefined
      const cleanExplanation = unit.explanation ? normalizeShenlunText(unit.explanation).trim() : ''
      const item: DirectQuestion = {
        id: `kb-e${hash(`${book.relativePath}\n${unit.chapter}\n${compact(cleanStem).slice(0, 120)}`).slice(0, 19)}`,
        set: 1,
        num: unit.seq,
        subject: 'shenlun',
        category: unit.chapter || '申论综合',
        tags: [...new Set([...job.options.tags, ...(unit.chapter ? [unit.chapter] : [])])],
        sourceFile: book.relativePath,
        year: unit.year,
        region: unit.region,
        paper: unit.paper,
        questionType: 'essay',
        difficulty: 3,
        stem: cleanStem,
        options: [],
        answer: [],
        explanation: cleanExplanation || '暂无参考答案；可在「申论作答」页配合 AI 批改练习。',
        material: cleanMaterial
      }
      const signature = directSignature(item.stem, item.material ?? '', '')
      if (existingSignatures.has(signature) || batchSeen.has(signature)) {
        skippedDuplicate += 1
        continue
      }
      batchSeen.add(signature)
      const quality = inspectShenlunMaterialQuality(cleanMaterial, {
        explanation: item.explanation
      })
      if (quality.level === 'incomplete') bookIncomplete += 1
      else bookClean += 1

      const warnings: string[] = []
      if (!cleanExplanation) {
        warnings.push('暂无参考答案，建议在备考开始前用 AI 批改补齐要点')
      }
      if (quality.level === 'incomplete') {
        warnings.push(`材料质检异常（${quality.issues.join('、')}），入库前请对照原书核对`)
      }

      pushArtifact({
        id: item.id,
        jobId: job.id,
        sourceId: book.sourceId,
        sourcePath: book.relativePath,
        relativeSourcePath: book.relativePath,
        kind: 'question',
        subject: 'shenlun',
        title: safeTitle(unit.title || cleanStem.slice(0, 40), '未命名题目'),
        category: item.category,
        confidence: quality.level === 'incomplete' ? 0.65 : 1,
        generatedBy: 'direct-import',
        status: 'pending',
        warnings,
        preview: cleanStem.slice(0, 180),
        markdown: directQuestionMarkdown(item),
        evidenceExcerpt: cleanStem.slice(0, 80),
        sourceEvidence: buildArtifactEvidence(
          { lineStart: unit.lineStart },
          book.sourceId,
          book.relativePath,
          book.linePageMap,
          collector.solutionPageMaps
        )
      })
      stagedEssays += 1
      bookStaged += 1
    }
    if (bookFile) {
      bookFile.state = 'ready'
      bookFile.artifactCount = bookStaged
      bookFile.message = `切出 ${bookStaged} 道申论题（质检通过 ${bookClean} / 疑似残缺 ${bookIncomplete}${
        bookStaged ? '，练习配合 AI 批改' : ''
      }）`
    }
  }

  job.status = staged > 0 ? 'review' : 'completed'
  const allArtifacts = job.artifactIds
    .map((id) => host.loadArtifact(job, id))
    .filter((a): a is StoredArtifact => Boolean(a))
  for (const artifact of allArtifacts) {
    artifact.importQualityTier = tierForArtifact(artifact)
    host.saveArtifact(job, artifact)
  }
  const persistedEvidencePages = await host.renderJobEvidence(job, allArtifacts)

  let vlmProofreadNote = ''
  if (job.options.enableVlmProofread) {
    try {
      const stats = await host.autoVlmPreproofread(job, allArtifacts)
      if (stats.calls > 0 || stats.failedPages > 0)
        vlmProofreadNote =
          ` [VLM 预精校] 已精校 ${stats.pages} 个异常页（${stats.applied} 个产物已修订，均需人工复核）` +
          (stats.uncoveredArtifacts
            ? `，同页另有 ${stats.uncoveredArtifacts} 道独立题未覆盖（请在审核页逐题精校）`
            : '') +
          (stats.failedPages ? `，${stats.failedPages} 页精校失败（可在审核页单页重试）` : '') +
          (stats.skippedPages ? `，其余 ${stats.skippedPages} 页可在审核页按需单页精校` : '')
    } catch (error) {
      vlmProofreadNote = ` [VLM 预精校失败] ${error instanceof Error ? error.message : '未知错误'}`
    }
  }

  const pageFacts = collectPageFacts(job.files)
  const facts: ImportBatchFacts = {
    fileCount: job.files.length,
    failedFileCount: job.files.filter((file) => file.state === 'failed').length,
    filesWithKnownPages: pageFacts.filesWithKnownPages,
    knownInputPages: pageFacts.knownInputPages,
    knownEmptyPages: pageFacts.knownEmptyPages,
    structuredArtifacts: allArtifacts.filter((a) => a.importQualityTier === 'structured').length,
    reviewRequiredArtifacts: allArtifacts.filter((a) => a.importQualityTier === 'review-required')
      .length,
    preservedSourceArtifacts: allArtifacts.filter((a) => a.importQualityTier === 'preserved-source')
      .length,
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
          ? '直导完成：全部题本被配对校验拦截（疑似套号错位），未生成产物'
          : collector.trainingMarkers >= 3
            ? `直导完成：检测到 ${collector.trainingMarkers} 处训练式标题但未能稳定切分出题目——这本书大概率是主观题教材，请改用「模型提炼」模式导入`
            : '直导完成：未切出题目（未识别出题目或全部缺少答案）') +
    ` [质量] ${batchFactsMessage(facts)}` +
    ` [来源] ${traceCoverageMessage(computeTraceCoverage(allArtifacts, persistedEvidencePages))}` +
    vlmProofreadNote
}

async function organizeChunksWithAi(
  host: JobPipelineHost,
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
    const latest = host.loadJob(job.id)
    if (latest.cancelRequested) break
    const chunk = chunks[index]!
    file.message = `模型整理 ${index + 1}/${chunks.length}`
    host.saveJob(job)
    const context = taskDataEnvelope('知识整理任务参数', {
      sourceFile: file.relativePath,
      chunk: { current: index + 1, total: chunks.length },
      outputMode: job.options.mode,
      defaultSubject: job.options.subject,
      batchTags: job.options.tags,
      customInstruction: job.options.instruction || ''
    })
    const extracted = await host.ai.ask(
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
      const reviewed = await host.ai.ask(
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
      const candidate = validateCandidate(value, job.options, chunk)
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
      const markdown = candidateMarkdown(artifactId, candidate, file.relativePath, job.options.tags)
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

export async function executeJobPipeline(host: JobPipelineHost, id: string): Promise<void> {
  try {
    let job = host.loadJob(id)
    job.status = 'running'
    job.message =
      job.options.mode === 'direct'
        ? '文件处理中——批次完成后自动配对、去重并写入当前题库'
        : undefined
    job.updatedAt = now()
    host.saveJob(job)

    const engine = await host.engineStatus()
    if (!engine.available || !engine.pythonPath) throw new Error('MarkItDown 转换引擎不可用')
    const readyEngine = { ...engine, pythonPath: engine.pythonPath }
    const workerPath = host.workerPath()

    const collector: DirectBatchCollector = {
      directBooks: [],
      directPreservation: [],
      directEssays: [],
      directSolutions: new Map(),
      solutionPageMaps: new Map(),
      solutionSourceOf: new Map(),
      trainingMarkers: 0
    }
    const subject = job.options.subject === 'auto' ? 'xingce' : job.options.subject
    const subjectLabel = subject === 'xingce' ? '行测' : subject === 'shenlun' ? '申论' : '公共知识'

    for (const entry of job.files) {
      job = host.loadJob(id)
      if (job.cancelRequested) break
      const file = job.files.find((candidate) => candidate.sourceId === entry.sourceId)
      if (!file || file.state !== 'queued') continue
      job.currentFile = file.relativePath
      file.state = 'converting'
      file.message = '正在转换为 Markdown'
      job.updatedAt = now()
      host.saveJob(job)

      try {
        const source = host.resolveSourceFile(job, file)
        const rawPath = join(job.outputPath, 'raw', `${file.sourceId}.md`)
        const { raw, useStructured } = await convertAndCacheSourceFile(
          host,
          job,
          file,
          source,
          rawPath,
          readyEngine,
          workerPath
        )
        if (job.options.mode === 'direct') {
          classifyDirectFile({
            collector,
            job,
            file,
            raw,
            rawPath,
            useStructured,
            subject,
            subjectLabel
          })
        } else if (job.options.mode === 'convert-only') {
          file.state = 'ready'
          file.message = '原始 Markdown 已保存在任务目录'
        } else {
          file.state = 'organizing'
          file.message = '正在由模型提炼并校验'
          host.saveJob(job)
          const artifacts = await organizeChunksWithAi(host, job, file, raw)
          job.cancelRequested ||= host.loadJob(id).cancelRequested
          for (const artifact of artifacts) {
            host.saveArtifact(job, artifact)
            if (!job.artifactIds.includes(artifact.id)) job.artifactIds.push(artifact.id)
          }
          file.artifactCount = artifacts.length
          if (job.cancelRequested) {
            file.state = 'cancelled'
            file.message = artifacts.length
              ? `任务已取消（保留已生成的 ${artifacts.length} 个产物）`
              : '任务已取消'
          } else {
            file.state = 'ready'
            file.message = artifacts.length
              ? `生成 ${artifacts.length} 个待审核产物`
              : '未发现足够完整、可入库的内容'
          }
        }
      } catch (error) {
        job.cancelRequested ||= host.loadJob(id).cancelRequested
        file.state = job.cancelRequested ? 'cancelled' : 'failed'
        file.message = error instanceof Error ? error.message : '处理失败'
      }
      job.currentFile = undefined
      job.updatedAt = now()
      host.saveJob(job)
    }

    job = host.loadJob(id)
    if (job.cancelRequested) {
      for (const file of job.files) if (file.state === 'queued') file.state = 'cancelled'
      job.status = 'cancelled'
      job.message = '任务已取消，已完成的转换和审核产物仍被保留'
    } else if (job.options.mode === 'direct') {
      await finalizeDirectBatch(host, job, collector, subject, subjectLabel)
    } else {
      const artifacts = job.artifactIds.map((artifactId) => host.loadArtifact(job, artifactId))
      job.status = artifacts.some((artifact) => artifact.status === 'pending')
        ? 'review'
        : 'completed'
      job.message = artifacts.length
        ? '批次处理完成，请逐项审核后发布'
        : '批次处理完成，未生成待发布产物'
    }
    job.currentFile = undefined
    job.updatedAt = now()
    host.saveJob(job)
  } finally {
    host.clearRunningState()
  }
}
