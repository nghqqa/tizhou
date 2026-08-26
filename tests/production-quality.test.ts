import { describe, expect, it, vi } from 'vitest'
import {
  EssaySaveController,
  type EssaySaveStatus,
  type PendingEssaySave
} from '../src/renderer/src/services/exam-essay-save'
import {
  parseOcrWorkerLine,
  parseOcrWorkerPayload,
  type OcrQualityPayload
} from '../src/renderer/src/services/ocr-payload'

describe('EssaySaveController (production module)', () => {
  function createController(options?: { saveImpl?: (save: PendingEssaySave) => Promise<void> }): {
    controller: EssaySaveController
    saves: PendingEssaySave[]
    statuses: EssaySaveStatus[]
  } {
    const saves: PendingEssaySave[] = []
    const statuses: EssaySaveStatus[] = []
    const defaultSave = async (save: PendingEssaySave): Promise<void> => {
      saves.push(save)
    }
    const controller = new EssaySaveController(options?.saveImpl ?? defaultSave, (status) =>
      statuses.push(status)
    )
    return { controller, saves, statuses }
  }

  it('marks dirty and captures questionId at input time', () => {
    const { controller, statuses } = createController()
    controller.markDirty('exam1', 'q1', '答案内容')
    expect(statuses).toContain('dirty')
    expect(controller.status).toBe('dirty')
  })

  it('converts empty text to empty array', async () => {
    const { controller, saves } = createController()
    controller.markDirty('exam1', 'q1', '')
    await controller.flushPending()
    await controller.drain()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.answer).toEqual([])
  })

  it('saves non-empty text as single-element array', async () => {
    const { controller, saves } = createController()
    controller.markDirty('exam1', 'q1', '主观题答案')
    await controller.flushPending()
    await controller.drain()
    expect(saves[0]?.answer).toEqual(['主观题答案'])
  })

  it('only saves latest version on rapid input', async () => {
    const { controller, saves } = createController()
    controller.markDirty('exam1', 'q1', '第一版')
    controller.markDirty('exam1', 'q1', '第二版')
    controller.markDirty('exam1', 'q1', '第三版')
    await controller.flushPending()
    await controller.drain()
    // Only the latest version should be saved
    expect(saves).toHaveLength(1)
    expect(saves[0]?.answer).toEqual(['第三版'])
  })

  it('preserves old questionId when switching questions', async () => {
    const { controller, saves } = createController()
    controller.markDirty('exam1', 'q-old', '旧题答案')
    // Switch to new question before flush
    controller.markDirty('exam1', 'q-new', '新题答案')
    await controller.flushPending()
    await controller.drain()
    // Only latest (new question) should be pending; old was overwritten
    expect(saves).toHaveLength(1)
    expect(saves[0]?.questionId).toBe('q-new')
  })

  it('flushes old question data on explicit flushPending before markDirty new', async () => {
    const { controller, saves } = createController()
    controller.markDirty('exam1', 'q-old', '旧题答案')
    // Simulate what question switch does: flush pending, then mark new
    await controller.flushPending()
    controller.markDirty('exam1', 'q-new', '新题答案')
    await controller.flushPending()
    await controller.drain()
    expect(saves).toHaveLength(2)
    expect(saves[0]?.questionId).toBe('q-old')
    expect(saves[1]?.questionId).toBe('q-new')
  })

  it('serializes saves in order even with variable delays', async () => {
    const saves: PendingEssaySave[] = []
    const controller = new EssaySaveController(
      async (save) => {
        // Deterministic delay: later saves complete faster
        await new Promise((r) => setTimeout(r, 10))
        saves.push(save)
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', 'A')
    await controller.flushPending()
    controller.markDirty('exam1', 'q2', 'B')
    await controller.flushPending()
    controller.markDirty('exam1', 'q3', 'C')
    await controller.flushPending()
    const result = await controller.drain()
    expect(result.hasFailure).toBe(false)
    expect(saves.map((s) => s.answer[0])).toEqual(['A', 'B', 'C'])
  })

  it('retains failed save and reports hasFailure', async () => {
    let callCount = 0
    const controller = new EssaySaveController(
      async () => {
        callCount++
        if (callCount === 1) throw new Error('network error')
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', '重要答案')
    await controller.flushPending()
    const result = await controller.drain()
    expect(result.hasFailure).toBe(true)
    expect(result.failedQuestionId).toBe('q1')
    expect(controller.hasFailedSave).toBe(true)
  })

  it('retry succeeds after initial failure', async () => {
    let callCount = 0
    const controller = new EssaySaveController(
      async () => {
        callCount++
        if (callCount === 1) throw new Error('fail')
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', '重要答案')
    await controller.flushPending()
    const failResult = await controller.drain()
    expect(failResult.hasFailure).toBe(true)

    const retryResult = await controller.retry()
    expect(retryResult.hasFailure).toBe(false)
    expect(controller.hasFailedSave).toBe(false)
  })

  it('destroy prevents further input but allows queue to complete', async () => {
    const saves: PendingEssaySave[] = []
    const controller = new EssaySaveController(
      async (save) => {
        saves.push(save)
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', 'before destroy')
    await controller.flushPending()
    controller.destroy()
    controller.markDirty('exam1', 'q2', 'after destroy')
    await controller.flushPending()
    await controller.drain()
    // Only the pre-destroy save should exist
    expect(saves).toHaveLength(1)
    expect(saves[0]?.answer).toEqual(['before destroy'])
  })
})

describe('parseOcrWorkerPayload (production module)', () => {
  it('parses a valid quality report', () => {
    const payload = parseOcrWorkerPayload({
      done: true,
      totalPages: 20,
      textLayerPages: 8,
      ocrPages: 12,
      emptyPages: 2,
      ocrLineCount: 340,
      averageConfidence: 0.87,
      lowConfidenceLines: 15,
      removedPageNumbers: 18,
      warnings: ['第 3 页 OCR 结果过短'],
      characters: 45678
    })
    expect(payload?.type).toBe('quality')
    const quality = payload as OcrQualityPayload
    expect(quality.totalPages).toBe(20)
    expect(quality.textLayerPages).toBe(8)
    expect(quality.ocrPages).toBe(12)
    expect(quality.ocrLineCount).toBe(340)
    expect(quality.averageConfidence).toBeCloseTo(0.87)
  })

  it('parses progress events', () => {
    const payload = parseOcrWorkerPayload({
      page: 5,
      total: 20,
      source: 'ocr',
      characters: 1234
    })
    expect(payload?.type).toBe('progress')
  })

  it('handles null averageConfidence for pure text-layer PDFs', () => {
    const payload = parseOcrWorkerPayload({
      done: true,
      totalPages: 10,
      textLayerPages: 10,
      ocrPages: 0,
      emptyPages: 0,
      ocrLineCount: 0,
      averageConfidence: null,
      lowConfidenceLines: 0,
      removedPageNumbers: 0,
      warnings: []
    })
    const quality = payload as OcrQualityPayload
    expect(quality.averageConfidence).toBeUndefined()
  })

  it('clamps confidence outside 0-1 range', () => {
    const payload = parseOcrWorkerPayload({
      done: true,
      totalPages: 5,
      averageConfidence: 1.5
    })
    const quality = payload as OcrQualityPayload
    expect(quality.averageConfidence).toBe(1)
  })

  it('sanitizes warnings array', () => {
    const payload = parseOcrWorkerPayload({
      done: true,
      warnings: ['warn1', 123, null, 'warn2', 'warn3', 'warn4', 'warn5', 'warn6']
    })
    const quality = payload as OcrQualityPayload
    expect(quality.warnings).toHaveLength(5)
    expect(quality.warnings.every((w) => typeof w === 'string')).toBe(true)
  })

  it('returns undefined for invalid payload', () => {
    expect(parseOcrWorkerPayload(null)).toBeUndefined()
    expect(parseOcrWorkerPayload('string')).toBeUndefined()
    expect(parseOcrWorkerPayload(123)).toBeUndefined()
    expect(parseOcrWorkerPayload({})).toBeUndefined()
  })

  it('parses JSON line string', () => {
    const line = JSON.stringify({ page: 1, total: 10, source: 'text-layer' })
    const payload = parseOcrWorkerLine(line)
    expect(payload?.type).toBe('progress')
  })

  it('returns undefined for non-JSON line', () => {
    expect(parseOcrWorkerLine('not json')).toBeUndefined()
    expect(parseOcrWorkerLine('')).toBeUndefined()
  })

  it('handles missing optional fields gracefully', () => {
    const payload = parseOcrWorkerPayload({ done: true })
    const quality = payload as OcrQualityPayload
    expect(quality.totalPages).toBe(0)
    expect(quality.averageConfidence).toBeUndefined()
    expect(quality.warnings).toEqual([])
  })
})
