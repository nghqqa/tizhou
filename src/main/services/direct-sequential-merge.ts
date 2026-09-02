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
  /** 重印片段相似度可验证的配对数 */
  verified: number
  /** 其中通过相似度校验的数量（0 时配对待确认） */
  verifiedPassed: number
  /** 套内错位被内容相似度校正的套数 */
  offsetAdjustedSets: number
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

  // 每套内按文档顺序位置配对，但先做确定性错位校正：
  // 两册套内题号可能整体漂移（题本从 1、解析册从 0 或吞号偏移），实测会整批配错。
  // 对 -2..+2 的偏移分别计算「重印片段相似度通过数」，取最高者（并列取偏移 0）。
  // 这是确定性的内容校正——不猜答案，只让相似度证据决定对位。
  let verifiedTotal = 0
  let verifiedPassedTotal = 0
  let offsetAdjustedSets = 0
  for (const [set, questionList] of questionsBySet) {
    const solutionList = solutionsBySet.get(set) ?? []
    const scorePair = (question: ParsedQuestion, solution: ParsedSolution): number | undefined => {
      if (!solution.stemExcerpt) return undefined
      const optionsText = question.options.map((option) => option.text).join(' ')
      return Math.max(
        alignmentScore(question.stem, solution.stemExcerpt),
        alignmentScore(optionsText, solution.stemExcerpt)
      )
    }
    let bestOffset = 0
    let bestPassed = -1
    for (const offset of [-2, -1, 0, 1, 2]) {
      let passed = 0
      let verified = 0
      const count = Math.min(questionList.length, solutionList.length - Math.max(0, offset))
      for (let index = 0; index < count; index += 1) {
        const solution = solutionList[index + offset]
        if (!solution) continue
        const score = scorePair(questionList[index]!, solution)
        if (score === undefined) continue
        verified += 1
        if (score >= 0.55) passed += 1
      }
      if (passed > bestPassed || (passed === bestPassed && offset === 0)) {
        bestPassed = passed
        bestOffset = offset
      }
    }
    if (bestOffset !== 0 && bestPassed > 0) offsetAdjustedSets += 1
    const count = Math.min(
      questionList.length,
      bestOffset >= 0 ? solutionList.length - bestOffset : solutionList.length
    )
    for (let index = 0; index < count; index += 1) {
      const question = questionList[index]!
      const solution = solutionList[index + bestOffset]
      if (!question.stem || question.stem.length < 8 || question.options.length < 2) {
        skippedIncomplete += 1
        continue
      }
      if (!solution) {
        skippedIncomplete += 1
        continue
      }
      const answerText = (solution.answer || '').toUpperCase().replace(/[^A-D]/g, '')
      if (!answerText) {
        skippedNoAnswer += 1
        continue
      }
      const score = scorePair(question, solution)
      if (score !== undefined) {
        verifiedTotal += 1
        if (score >= 0.55) verifiedPassedTotal += 1
        else {
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
  return {
    items,
    paired,
    skippedNoAnswer,
    skippedIncomplete,
    skippedMisaligned,
    verified: verifiedTotal,
    verifiedPassed: verifiedPassedTotal,
    offsetAdjustedSets
  }
}
