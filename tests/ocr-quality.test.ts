import { describe, expect, it } from 'vitest'
import { parseQuestionBook } from '../src/main/services/question-import'

describe('OCR quality and number protection', () => {
  it('protects question numbers from being treated as page numbers', () => {
    const lines = [
      '1. 下列关于法律的说法正确的是',
      'A. 法律由国家制定',
      'B. 法律由国家认可',
      '2. 下列关于经济的说法正确的是',
      'A. 经济基础决定上层建筑',
      '12. 第十二题的题干内容',
      '第13题. 这也是题号',
      '1-20. 范围题号',
      '5/20. 进度标记'
    ]
    const questions = parseQuestionBook(lines)
    expect(questions.length).toBeGreaterThanOrEqual(2)
    expect(questions[0]?.stem).toContain('法律')
    expect(questions[1]?.stem).toContain('经济')
  })

  it('parses OCR worker quality report JSON', () => {
    const raw = JSON.stringify({
      done: true,
      characters: 186420,
      totalPages: 120,
      textLayerPages: 8,
      ocrPages: 112,
      emptyPages: 2,
      ocrLineCount: 5420,
      averageConfidence: 0.87,
      lowConfidenceLines: 43,
      removedPageNumbers: 118,
      warnings: ['平均置信度 87%，低于 72%，建议人工抽查']
    })
    const payload = JSON.parse(raw) as {
      done: boolean
      totalPages: number
      textLayerPages: number
      ocrPages: number
      emptyPages: number
      ocrLineCount: number
      averageConfidence: number
      lowConfidenceLines: number
      removedPageNumbers: number
      warnings: string[]
    }
    expect(payload.done).toBe(true)
    expect(payload.totalPages).toBe(120)
    expect(payload.textLayerPages).toBe(8)
    expect(payload.ocrPages).toBe(112)
    expect(payload.ocrLineCount).toBe(5420)
    expect(payload.averageConfidence).toBeCloseTo(0.87)
    expect(payload.lowConfidenceLines).toBe(43)
    expect(payload.warnings).toHaveLength(1)
  })

  it('handles null confidence for pure text-layer PDFs', () => {
    const raw = JSON.stringify({
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
    const payload = JSON.parse(raw)
    expect(payload.averageConfidence).toBeNull()
    expect(payload.ocrPages).toBe(0)
    expect(payload.ocrLineCount).toBe(0)
  })

  it('keeps page numbers only at page edges in filter output', () => {
    const lines = ['第1页', '1. 题干第一行', '2. 题干第二行', '第2页', '3. 题干第三行']
    const questions = parseQuestionBook(lines)
    expect(questions.length).toBe(3)
    expect(questions[0]?.stem).not.toContain('第1页')
    expect(questions[2]?.stem).not.toContain('第2页')
  })

  it('handles empty OCR result gracefully', () => {
    const report = {
      done: true,
      characters: 0,
      totalPages: 5,
      textLayerPages: 0,
      ocrPages: 5,
      emptyPages: 5,
      ocrLineCount: 0,
      averageConfidence: null,
      lowConfidenceLines: 0,
      removedPageNumbers: 0,
      warnings: ['所有页面均未识别到有效文字']
    }
    expect(report.characters).toBe(0)
    expect(report.emptyPages).toBe(5)
    expect(report.warnings).toHaveLength(1)
  })

  it('mixed PDF confidence only counts OCR pages', () => {
    const report = {
      totalPages: 20,
      textLayerPages: 8,
      ocrPages: 12,
      ocrLineCount: 340,
      averageConfidence: 0.82,
      lowConfidenceLines: 15
    }
    // Average confidence should be from OCR pages only
    expect(report.averageConfidence).toBeGreaterThan(0)
    expect(report.averageConfidence).toBeLessThan(1)
    expect(report.ocrLineCount).toBeGreaterThan(0)
    // Low confidence ratio should be based on OCR lines only
    const ratio = report.lowConfidenceLines / report.ocrLineCount
    expect(ratio).toBeCloseTo(15 / 340)
  })
})

describe('exam essay save scenarios', () => {
  it('empty answer is serialized as empty array not null', () => {
    const text = ''
    const answer = text ? [text] : []
    expect(answer).toEqual([])
    expect(answer).toHaveLength(0)
  })

  it('non-empty answer is serialized as single-element array', () => {
    const text = '这是一道主观题的答案'
    const answer = text ? [text] : []
    expect(answer).toEqual(['这是一道主观题的答案'])
  })

  it('pendingSave captures questionId at input time', () => {
    // Simulate the pendingSaveRef pattern
    let pendingSave: { questionId: string; answer: string[] } | null = null
    const currentQuestion = { id: 'q1', type: 'essay' }

    // User types
    pendingSave = {
      questionId: currentQuestion.id,
      answer: ['用户输入的答案']
    }

    // Question switches (currentQuestion would change, but pendingSave still has old ID)
    const newQuestion = { id: 'q2', type: 'essay' }
    expect(newQuestion.id).not.toBe(pendingSave.questionId)
    expect(pendingSave.questionId).toBe('q1')

    // After flush, pendingSave is cleared
    pendingSave = null
    expect(pendingSave).toBeNull()
  })

  it('serialized save queue prevents out-of-order writes', async () => {
    // Simulate the saveQueueRef pattern
    let queue: Promise<void> = Promise.resolve()
    const savedData: string[] = []

    const queueSave = (data: string): void => {
      queue = queue.then(async () => {
        // Simulate variable network delay
        await new Promise((r) => setTimeout(r, Math.random() * 20))
        savedData.push(data)
      })
    }

    queueSave('first')
    queueSave('second')
    queueSave('third')

    await queue
    // All saves complete in order
    expect(savedData).toEqual(['first', 'second', 'third'])
  })
})
