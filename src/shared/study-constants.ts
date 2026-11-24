/** 错因主标签选项（全站作答标注、筛选与 AI 错题分析共用同一套枚举） */
export const WRONG_CAUSE_OPTIONS = [
  '知识缺口',
  '概念混淆',
  '审题失误',
  '计算失误',
  '时间压力',
  '猜测',
  '未知'
] as const

export type WrongCause = (typeof WRONG_CAUSE_OPTIONS)[number]

/** 归一化答案键列表：去空格、转大写、去重并排序，保证多选题作答判分顺序无关 */
export function normalizeAnswerKeys(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()))].sort()
}

/** 答案比对判分：与主进程入库口径一致；复盘页展示未答场景传 requireNonEmpty: true */
export function isAnswerCorrect(
  expected: string[],
  answer: string[],
  options?: { requireNonEmpty?: boolean }
): boolean {
  if (options?.requireNonEmpty && answer.length === 0) return false
  return (
    JSON.stringify(normalizeAnswerKeys(answer)) === JSON.stringify(normalizeAnswerKeys(expected))
  )
}

/** 简明耗时格式化（如 `3分12秒` / `45秒` / `未计时`） */
export function formatDurationBrief(seconds: number): string {
  if (seconds <= 0) return '未计时'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`
}
