/**
 * 解析 OCR worker 的 stdout JSON 行。
 * 生产函数：knowledge-builder.ts 的 ocrConvert 直接调用此模块。
 */

export interface OcrProgressEvent {
  type: 'progress'
  page: number
  total: number
  source: 'text-layer' | 'ocr'
  characters: number
}

export interface OcrQualityPayload {
  type: 'quality'
  totalPages: number
  textLayerPages: number
  ocrPages: number
  emptyPages: number
  ocrLineCount: number
  averageConfidence?: number
  lowConfidenceLines: number
  removedPageNumbers: number
  warnings: string[]
  characters: number
  /** 结构解析模式产出（表格还原 + 图片保真），用于缓存条目正名 */
  structured?: boolean
  /** 结构解析识别的表格区域数 */
  tableRegions?: number
  /** 结构解析保存的图片区域数 */
  figureRegions?: number
  /** 版面模型弃置的水印/页眉页脚区域数 */
  discardedRegions?: number
  /** 已剥离的页眉/水印文本出现次数 */
  removedNoiseLines?: number
}

export type OcrWorkerPayload = OcrProgressEvent | OcrQualityPayload

/** 非负整数：非有限数或负数返回 0 */
function nonNegInt(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.max(0, Math.floor(num))
}

/** 置信度钳位：null/undefined/非有限数返回 undefined，否则钳位到 [0, 1] */
function clampConfidence(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.max(0, Math.min(1, num))
}

/** 来源白名单：只允许 text-layer 或 ocr，未知值归为 ocr */
function sanitizeSource(value: unknown): 'text-layer' | 'ocr' {
  return value === 'text-layer' ? 'text-layer' : 'ocr'
}

/** 警告清洗：过滤非字符串、trim、去空、去重、限长 200、限数 5 */
function sanitizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed.slice(0, 200))
    if (result.length >= 5) break
  }
  return result
}

export function parseOcrWorkerPayload(payload: unknown): OcrWorkerPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>

  if (record.done === true) {
    return {
      type: 'quality',
      totalPages: nonNegInt(record.totalPages),
      textLayerPages: nonNegInt(record.textLayerPages),
      ocrPages: nonNegInt(record.ocrPages),
      emptyPages: nonNegInt(record.emptyPages),
      ocrLineCount: nonNegInt(record.ocrLineCount),
      averageConfidence: clampConfidence(record.averageConfidence),
      lowConfidenceLines: nonNegInt(record.lowConfidenceLines),
      removedPageNumbers: nonNegInt(record.removedPageNumbers),
      warnings: sanitizeWarnings(record.warnings),
      characters: nonNegInt(record.characters),
      ...(record.structured === true ? { structured: true } : {}),
      ...(nonNegInt(record.tableRegions) ? { tableRegions: nonNegInt(record.tableRegions) } : {}),
      ...(nonNegInt(record.figureRegions)
        ? { figureRegions: nonNegInt(record.figureRegions) }
        : {}),
      ...(nonNegInt(record.discardedRegions)
        ? { discardedRegions: nonNegInt(record.discardedRegions) }
        : {}),
      ...(nonNegInt(record.removedNoiseLines)
        ? { removedNoiseLines: nonNegInt(record.removedNoiseLines) }
        : {})
    }
  }

  if (
    typeof record.page === 'number' &&
    Number.isFinite(record.page) &&
    typeof record.total === 'number' &&
    Number.isFinite(record.total)
  ) {
    return {
      type: 'progress',
      page: Math.max(1, Math.floor(record.page)),
      total: Math.max(1, Math.floor(record.total)),
      source: sanitizeSource(record.source),
      characters: nonNegInt(record.characters)
    }
  }

  return undefined
}

export function parseOcrWorkerLine(line: string): OcrWorkerPayload | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return parseOcrWorkerPayload(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}
