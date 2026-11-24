import type { AttemptResult, PracticeSelection, Subject } from '@shared/contracts'

export interface Category {
  name: string
  count: number
}

export interface SessionResult {
  questionId: string
  result: AttemptResult
  /** 用户当时的作答（汇总模式结束后复盘对照用） */
  answer: string[]
}

export interface TrainerInitial {
  mode?: PracticeSelection['mode']
  count?: number
  category?: string
  feedbackMode?: 'immediate' | 'summary'
  subject?: '' | Subject
  onlyWrong?: boolean
  onlyFavorite?: boolean
  onlyUnattempted?: boolean
  questionId?: string
  resumeActive?: boolean
}

export const BAIGUAFEN_TABLE: Array<[string, string]> = [
  ['1/2', '50%'],
  ['1/3', '33.3%'],
  ['1/4', '25%'],
  ['1/5', '20%'],
  ['1/6', '16.7%'],
  ['1/7', '14.3%'],
  ['1/8', '12.5%'],
  ['1/9', '11.1%'],
  ['1/10', '10%'],
  ['1/11', '9.1%'],
  ['1/12', '8.3%'],
  ['1/13', '7.7%'],
  ['1/14', '7.1%'],
  ['1/15', '6.7%'],
  ['1/16', '6.25%'],
  ['1/17', '5.9%'],
  ['1/18', '5.6%'],
  ['1/19', '5.3%'],
  ['1/20', '5%']
]

export const FORMULA_HINTS: Array<{ name: string; expr: string }> = [
  { name: '基期量', expr: 'A / (1 + r)' },
  { name: '增长量（r = 1/n）', expr: 'A / (n + 1)（减少：A / (n - 1)）' },
  { name: '间隔增长率', expr: 'r₁ + r₂ + r₁·r₂' },
  { name: '两期比重差', expr: '(A / B) · (a - b) / (1 + a)' },
  { name: '平均数增长率', expr: '(a - b) / (1 + b)' },
  { name: '混合增长率', expr: '居中且偏向基数（现期近似）较大者' }
]
