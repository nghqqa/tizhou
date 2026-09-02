// 顺序配对兜底：当套号钥匙配对失败（两本账本套号漂移不一致）时，
// 按「题本各套 ↔ 解析册各套」分组、套内按文档顺序位置配对，并用题干相似度逐对验证。
// 按套分组隔离漂移：一套内的错位不会传播到其他套。
import { createHash } from 'node:crypto'
import {
  alignmentScore,
  type DirectQuestion,
  type ParsedQuestion,
  type ParsedSolution
} from './question-import'

export interface SequentialMergeOptions {
  subject: string
  category: string
  sourceFile: string
  tags: string[]
}

export interface SequentialMergeResult {
  items: DirectQuestion[]
  paired: number
  skippedNoAnswer: number
  skippedIncomplete: number
  skippedMisaligned: number
}

export function mergeByDocumentOrder(
  questions: ParsedQuestion[],
  solutions: Map<string, ParsedSolution>,
  options: SequentialMergeOptions
): SequentialMergeResult {
  const items: DirectQuestion[] = []
  let paired = 0
  let skippedNoAnswer = 0
  let skippedIncomplete = 0
  let skippedMisaligned = 0

  // 按套分组（解析册按 key 的套号前缀，题本按 set 字段），套间独立配对互不传播
  const solutionsBySet = new Map<number, ParsedSolution[]>()
  for (const [key, solution] of solutions) {
    const set = Number(key.split('-')[0]) || 0
    const list = solutionsBySet.get(set)
    if (list) list.push(solution)
    else solutionsBySet.set(set, [solution])
  }
  const questionsBySet = new Map<number, ParsedQuestion[]>()
  for (const question of questions) {
    const list = questionsBySet.get(question.set)
    if (list) list.push(question)
    else questionsBySet.set(question.set, [question])
  }

  // 每套内按文档顺序位置配对（套内题号两边都从 1 递增）
  for (const [set, questionList] of questionsBySet) {
    const solutionList = solutionsBySet.get(set) ?? []
    const count = Math.min(questionList.length, solutionList.length)
    for (let index = 0; index < count; index += 1) {
      const question = questionList[index]!
      const solution = solutionList[index]!
      if (!question.stem || question.stem.length < 8 || question.options.length < 2) {
        skippedIncomplete += 1
        continue
      }
      const answerText = (solution.answer || '').toUpperCase().replace(/[^A-D]/g, '')
      if (!answerText) {
        skippedNoAnswer += 1
        continue
      }
      if (solution.stemExcerpt) {
        // 解析册的重印片段可能是题干，也可能是选项区/图表噪声——
        // 题干或选项任一与重印片段相似即认定同题
        const optionsText = question.options.map((option) => option.text).join(' ')
        const score = Math.max(
          alignmentScore(question.stem, solution.stemExcerpt),
          alignmentScore(optionsText, solution.stemExcerpt)
        )
        if (score < 0.55) {
          skippedMisaligned += 1
          continue
        }
      }
      const explanation =
        [solution.qtype, solution.explanation].filter(Boolean).join('\n\n') || '该题暂未提供解析。'
      items.push({
        id: `kb-b${createHash('sha256')
          .update(`${options.sourceFile}\n${set}-${index}`)
          .digest('hex')
          .slice(0, 19)}`,
        set: question.set,
        num: question.num,
        groupId: `kbg-${createHash('sha256')
          .update(`${options.sourceFile}\n${set}`)
          .digest('hex')
          .slice(0, 16)}`,
        groupOrder: question.num,
        subject: options.subject,
        category: options.category,
        tags: [...new Set([...options.tags, `第${question.set}套`])],
        sourceFile: options.sourceFile,
        year: solution.origin?.year,
        region: solution.origin?.region || undefined,
        questionType: answerText.length > 1 ? 'multiple' : 'single',
        difficulty:
          solution.origin?.rate === undefined
            ? 2
            : solution.origin.rate >= 80
              ? 1
              : solution.origin.rate >= 65
                ? 2
                : solution.origin.rate >= 50
                  ? 3
                  : solution.origin.rate >= 35
                    ? 4
                    : 5,
        stem: question.stem,
        options: question.options,
        material: question.material,
        answer: answerText.split(''),
        explanation
      })
      paired += 1
    }
  }
  return { items, paired, skippedNoAnswer, skippedIncomplete, skippedMisaligned }
}
