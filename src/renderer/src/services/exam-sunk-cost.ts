import {
  XINGCE_PACE_SECONDS_PER_QUESTION,
  normalizeXingceModule
} from '../../../shared/study-constants'

export interface SunkCostQuestionInput {
  index: number
  questionId: string
  category: string
  stem: string
  correct: boolean
  answered: boolean
  durationSeconds: number
}

export interface SunkCostEntry {
  index: number
  questionId: string
  category: string
  moduleName: string
  stemPreview: string
  correct: boolean
  answered: boolean
  durationSeconds: number
  suggestedSeconds: number
  overtimeThreshold: number
  overtimeRatio: number
  isOvertime: boolean
  isSunkCost: boolean
}

export interface ExamSunkCostReport {
  topSlowItems: SunkCostEntry[]
  sunkCostItems: SunkCostEntry[]
  sunkCostTotalSeconds: number
  totalTrackedSeconds: number
  sunkCostSharePercent: number
}

function buildStemPreview(stem: string): string {
  const plain = stem
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[图]')
    .replace(/[`*_#>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return '（无文字题干）'
  return plain.length > 46 ? `${plain.slice(0, 46)}…` : plain
}

/**
 * 分析单场行测模考中的单题耗时，识别「高耗时但仍答错/未答」的沉没成本黑洞题。
 */
export function analyzeExamSunkCost(items: SunkCostQuestionInput[]): ExamSunkCostReport {
  const enriched: SunkCostEntry[] = []
  let totalTrackedSeconds = 0

  for (const item of items) {
    const duration = Math.max(0, Math.round(item.durationSeconds))
    totalTrackedSeconds += duration
    if (duration <= 0) continue

    const moduleName = normalizeXingceModule(item.category)
    const suggestedSeconds =
      XINGCE_PACE_SECONDS_PER_QUESTION[item.category] ??
      XINGCE_PACE_SECONDS_PER_QUESTION[moduleName] ??
      55
    const overtimeThreshold = Math.min(120, Math.max(90, Math.round(suggestedSeconds * 1.5)))
    const overtimeRatio = Math.round((duration / suggestedSeconds) * 10) / 10
    const isOvertime = duration >= overtimeThreshold
    const isSunkCost = !item.correct && isOvertime

    enriched.push({
      index: item.index,
      questionId: item.questionId,
      category: item.category,
      moduleName,
      stemPreview: buildStemPreview(item.stem),
      correct: item.correct,
      answered: item.answered,
      durationSeconds: duration,
      suggestedSeconds,
      overtimeThreshold,
      overtimeRatio,
      isOvertime,
      isSunkCost
    })
  }

  const sortedByDuration = [...enriched].sort(
    (a, b) => b.durationSeconds - a.durationSeconds || a.index - b.index
  )
  const topSlowItems = sortedByDuration.slice(0, 10)
  const sunkCostItems = sortedByDuration.filter((entry) => entry.isSunkCost)
  const sunkCostTotalSeconds = sunkCostItems.reduce((sum, entry) => sum + entry.durationSeconds, 0)
  const sunkCostSharePercent =
    totalTrackedSeconds > 0 ? Math.round((sunkCostTotalSeconds / totalTrackedSeconds) * 100) : 0

  return {
    topSlowItems,
    sunkCostItems,
    sunkCostTotalSeconds,
    totalTrackedSeconds,
    sunkCostSharePercent
  }
}
