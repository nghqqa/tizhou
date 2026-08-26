/**
 * 解析 OCR worker 的 stdout JSON 行。
 * 生产函数：knowledge-builder.ts 的 ocrConvert 直接调用此模块。
 */

export interface OcrProgressEvent {
  type: 'progress'
  page: number
  total: number
  source: string
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
}

export type OcrWorkerPayload = OcrProgressEvent | OcrQualityPayload

function clampConfidence(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.max(0, Math.min(1, num))
}

function sanitizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, 200))
    .slice(0, 5)
}

export function parseOcrWorkerPayload(payload: unknown): OcrWorkerPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>

  if (record.done === true) {
    return {
      type: 'quality',
      totalPages: Math.max(0, Number(record.totalPages) || 0),
      textLayerPages: Math.max(0, Number(record.textLayerPages) || 0),
      ocrPages: Math.max(0, Number(record.ocrPages) || 0),
      emptyPages: Math.max(0, Number(record.emptyPages) || 0),
      ocrLineCount: Math.max(0, Number(record.ocrLineCount) || 0),
      averageConfidence: clampConfidence(record.averageConfidence),
      lowConfidenceLines: Math.max(0, Number(record.lowConfidenceLines) || 0),
      removedPageNumbers: Math.max(0, Number(record.removedPageNumbers) || 0),
      warnings: sanitizeWarnings(record.warnings),
      characters: Math.max(0, Number(record.characters) || 0)
    }
  }

  if (typeof record.page === 'number' && typeof record.total === 'number') {
    return {
      type: 'progress',
      page: Math.max(1, Math.floor(record.page)),
      total: Math.max(1, Math.floor(record.total)),
      source: typeof record.source === 'string' ? record.source : 'ocr',
      characters: Math.max(0, Number(record.characters) || 0)
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
