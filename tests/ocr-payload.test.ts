// OCR worker stdout 载荷解析：quality/progress 类型推导与 structured 标记
import { describe, expect, it } from 'vitest'
import { parseOcrWorkerLine } from '../src/shared/ocr-payload'

describe('ocr worker payload', () => {
  it('carries the structured marker from structured conversions', () => {
    const line = JSON.stringify({
      done: true,
      structured: true,
      characters: 120,
      totalPages: 2,
      textLayerPages: 0,
      ocrPages: 2,
      emptyPages: 0,
      ocrLineCount: 0,
      averageConfidence: null,
      lowConfidenceLines: 0,
      removedPageNumbers: 0,
      warnings: ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录']
    })
    const payload = parseOcrWorkerLine(line)
    expect(payload?.type).toBe('quality')
    if (payload?.type === 'quality') expect(payload.structured).toBe(true)
  })

  it('leaves plain ocr quality reports unmarked', () => {
    const payload = parseOcrWorkerLine(
      JSON.stringify({
        done: true,
        totalPages: 2,
        textLayerPages: 1,
        ocrPages: 1,
        emptyPages: 0,
        ocrLineCount: 10,
        averageConfidence: 0.9,
        lowConfidenceLines: 0,
        removedPageNumbers: 1,
        warnings: [],
        characters: 50
      })
    )
    expect(payload?.type).toBe('quality')
    if (payload?.type === 'quality') expect(payload.structured).toBeUndefined()
  })
})
