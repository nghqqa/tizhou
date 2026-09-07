// 来源页证据：产物 → PDF 页的可追溯映射（仅供人工对照原页，不代表 OCR 内容正确）。
// 架构约束：
// - exact 仅在 LocatedLine（解析状态机消费的行，页标签与解析器输入数组平行生成）或
//   版面 region（聚类直接给出 page）时产生；事后文本匹配/题号顺序/邻近关系一律 estimated
// - 无可靠依据必须 unavailable，不猜页码
// - bbox 为 [0,1] 归一化坐标，校验顺序与范围
// - status 表证据资产可用性，mapping 表页码来源，两者独立
// - 页面证据按 sourceId+pageNumber 在 job 内去重，容量上限超限标 partial
// - 历史产物无 sourceEvidence 字段时正常加载
import { createHash } from 'node:crypto'
import type { SourceEvidence, SourceEvidencePage, SourceReference } from '../../shared/contracts'

/** 页清单（worker _pages.json 或从 _regions.json 派生）：每页过滤后的行内容 */
export interface PageManifest {
  pages: Array<{ pageNumber: number; source: string; lines: string[] }>
}

export interface RegionLike {
  type: string
  page: number
  bbox: number[]
  imgPath: string
  text: string
}

/** 单任务证据页容量上限：超限标记 partial 并显示原因 */
export const EVIDENCE_PAGE_LIMIT = 60

/** 解析确定性：JSON 字段缺失/损坏时返回 undefined，不抛错 */
export function parsePageManifest(raw: string | undefined): PageManifest | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<PageManifest>
    if (!parsed || !Array.isArray(parsed.pages)) return undefined
    const pages = parsed.pages.flatMap((page) => {
      const pageNumber = Number(page?.pageNumber)
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return []
      const lines = Array.isArray(page?.lines) ? page.lines.map(String) : []
      return [{ pageNumber, source: String(page?.source ?? 'ocr'), lines }]
    })
    if (pages.length === 0) return undefined
    return { pages }
  } catch {
    return undefined
  }
}

/** 从版面 region 派生页清单（structured 模式复用 _regions.json） */
export function manifestFromRegions(regions: RegionLike[]): PageManifest {
  const byPage = new Map<number, string[]>()
  for (const region of regions) {
    if (!Number.isInteger(region.page) || region.page < 0) continue
    const list = byPage.get(region.page) ?? []
    if (region.text) list.push(region.text)
    byPage.set(region.page, list)
  }
  return {
    pages: [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageIndex, lines]) => ({
        pageNumber: pageIndex + 1,
        source: 'structured',
        lines
      }))
  }
}

/** 归一化 bbox 有效性：4 个 [0,1] 内有限数，x1≥x0、y1≥y0 */
export function isValidNormalizedBbox(bbox: unknown): bbox is [number, number, number, number] {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false
  const [x0, y0, x1, y1] = bbox as unknown[]
  const values = [x0, y0, x1, y1]
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))
    return false
  return (x1 as number) >= (x0 as number) && (y1 as number) >= (y0 as number)
}

/** 页码有效性：1-based 正整数 */
export function isValidPageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** 原始 markdown 行 → 页标签（与 toLines 输入同源同序；toLines 过滤链在
 *  buildLinePageMap 中同步应用，保证与解析器消费的行严格平行） */
export function buildLinePageMap(
  rawLines: string[],
  manifest: PageManifest | undefined
): Array<number | undefined> {
  if (!manifest) return rawLines.map(() => undefined)
  const rawPageOf: Array<number | undefined> = []
  for (const page of manifest.pages)
    for (let index = 0; index < page.lines.length; index += 1) rawPageOf.push(page.pageNumber)
  // 非空行依序消费标签（空行跳过不消耗，与 toLinesWithPageMap 同规则）
  let manifestCursor = 0
  return rawLines.map((rawLine) => {
    if (!rawLine.trim()) return undefined
    return rawPageOf[manifestCursor++] ?? undefined
  })
}

export interface ReferenceBuildInput {
  role: SourceReference['role']
  sourceId: string
  relativePath: string
  /** 题目（或材料）在解析器输入行数组中的 0-based 起始行号（LocatedLine） */
  lineStart?: number
  /** 与解析器输入平行的行页映射 */
  linePageMap: Array<number | undefined>
  /** exact 来源的页集合（structured region / graphic 聚类直接给出） */
  exactPages?: number[]
  /** 行区间（含端点）内出现的全部页（材料跨页）：行标签来自同一平行数组，视为 exact */
  lineRange?: { start: number; end: number }
}

export interface EvidenceBuildInput {
  references: ReferenceBuildInput[]
  /** 本 job 已持久化的证据页键集合（容量控制在外层做） */
  persistedPageKeys?: Set<string>
}

function collectReferencePages(input: ReferenceBuildInput): SourceEvidencePage[] {
  const pages: SourceEvidencePage[] = []
  const seen = new Set<number>()
  const push = (pageNumber: number, mapping: 'exact' | 'estimated'): void => {
    if (!isValidPageNumber(pageNumber) || seen.has(pageNumber)) return
    seen.add(pageNumber)
    pages.push({ pageNumber, mapping })
  }
  if (input.exactPages) for (const pageNumber of input.exactPages) push(pageNumber, 'exact')
  if (input.lineStart !== undefined) {
    const page = input.linePageMap[input.lineStart]
    // 行标签与解析器输入平行生成（状态机消费的 LocatedLine）→ exact
    if (page !== undefined) push(page, 'exact')
  }
  if (input.lineRange) {
    for (let index = input.lineRange.start; index <= input.lineRange.end; index += 1) {
      const page = input.linePageMap[index]
      if (page !== undefined) push(page, 'exact')
    }
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber)
  return pages
}

export function pageKey(sourceId: string, pageNumber: number): string {
  return `${sourceId}#p${pageNumber}`
}

/** 证据资产 ID：job 内稳定（sourceId+page 的哈希），渲染层经 IPC 用它取图 */
export function evidenceAssetId(sourceId: string, pageNumber: number): string {
  return `ev-${createHash('sha256').update(pageKey(sourceId, pageNumber)).digest('hex').slice(0, 20)}`
}

/** 构建产物级来源证据：无任何可靠页时 unavailable（不猜） */
export function buildSourceEvidence(input: EvidenceBuildInput): SourceEvidence {
  const references: SourceReference[] = []
  for (const ref of input.references) {
    const pages = collectReferencePages(ref)
    if (pages.length === 0) continue
    references.push({
      role: ref.role,
      sourceId: ref.sourceId,
      relativePath: ref.relativePath,
      pages
    })
  }
  if (references.length === 0) {
    return { status: 'unavailable', references: [] }
  }
  // 容量控制：引用页总数超过任务上限时降 partial（保留引用，不渲染超限页）
  const pageCount = references.reduce((sum, ref) => sum + ref.pages.length, 0)
  if (pageCount > EVIDENCE_PAGE_LIMIT) {
    return {
      status: 'partial',
      partialReason: `引用页 ${pageCount} 超过任务证据上限 ${EVIDENCE_PAGE_LIMIT}，超限页不渲染预览`,
      references
    }
  }
  return { status: 'available', references }
}

/** 收集产物引用的全部 (sourceId, page) 键（去重），供渲染计划与容量控制 */
export function collectEvidencePageKeys(
  artifacts: Array<{ sourceEvidence?: SourceEvidence }>
): Set<string> {
  const keys = new Set<string>()
  for (const artifact of artifacts) {
    const evidence = artifact.sourceEvidence
    if (!evidence || evidence.status === 'unavailable') continue
    for (const ref of evidence.references)
      for (const page of ref.pages) keys.add(pageKey(ref.sourceId, page.pageNumber))
  }
  return keys
}

/** 可追溯覆盖指标（只统计真实映射，不称准确率/召回率） */
export interface TraceCoverage {
  available: number
  partial: number
  unavailable: number
  exactPages: number
  estimatedPages: number
  evidencePagesPersisted: number
}

export function computeTraceCoverage(
  artifacts: Array<{ sourceEvidence?: SourceEvidence }>,
  persistedEvidencePages: number
): TraceCoverage {
  let available = 0
  let partial = 0
  let unavailable = 0
  let exactPages = 0
  let estimatedPages = 0
  for (const artifact of artifacts) {
    const evidence = artifact.sourceEvidence
    if (!evidence || evidence.status === 'unavailable' || evidence.references.length === 0) {
      unavailable += 1
      continue
    }
    if (evidence.status === 'available') available += 1
    else partial += 1
    for (const ref of evidence.references)
      for (const page of ref.pages) {
        if (page.mapping === 'exact') exactPages += 1
        else estimatedPages += 1
      }
  }
  return {
    available,
    partial,
    unavailable,
    exactPages,
    estimatedPages,
    evidencePagesPersisted: persistedEvidencePages
  }
}

export function traceCoverageMessage(coverage: TraceCoverage): string {
  return (
    `来源证据可用 ${coverage.available} · 部分 ${coverage.partial} · 无法定位 ${coverage.unavailable}` +
    `（exact 页 ${coverage.exactPages} · estimated 页 ${coverage.estimatedPages} · 已存证据页 ${coverage.evidencePagesPersisted}）`
  )
}
