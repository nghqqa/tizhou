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

/** 阶梯艾宾浩斯间隔复习步长（天） */
export const REVIEW_INTERVAL_STEPS = [1, 3, 7, 15, 30] as const

/** 错 ≥ 2 次视为顽固错题，出队连对门槛由 2 次提升至 3 次 */
export const STUBBORN_WRONG_THRESHOLD = 2

export type ReviewFeedback = 'forgot' | 'hard' | 'normal' | 'easy'

/** 阶梯式间隔复习调度计算（前后端共用预览与落盘口径）：
 *  - wrongCount = 1 的普通错题保持连对 2 次即掌握；wrongCount >= 2 的顽固错题需连对 3 次；
 *  - 记忆反馈：forgot 重置阶段至 1 天，hard 停留短期 1~3 天，normal 推进 1 阶，easy 跃迁 2 阶 */
export function computeReviewSchedule(params: {
  previousStreak: number
  previousStage: number
  wrongCount: number
  feedback: ReviewFeedback
}): { streak: number; stage: number; mastered: boolean; delayDays?: number } {
  const prevStreak = Math.max(0, Math.round(params.previousStreak))
  const prevStage = Math.max(
    0,
    Math.min(REVIEW_INTERVAL_STEPS.length - 1, Math.round(params.previousStage))
  )
  const requiredStreak = params.wrongCount >= STUBBORN_WRONG_THRESHOLD ? 3 : 2
  const maxStage = REVIEW_INTERVAL_STEPS.length - 1
  if (params.feedback === 'forgot') {
    return { streak: 0, stage: 0, mastered: false, delayDays: REVIEW_INTERVAL_STEPS[0] }
  }
  if (params.feedback === 'hard') {
    const nextStage = Math.min(prevStage, 1)
    return {
      streak: prevStreak,
      stage: nextStage,
      mastered: false,
      delayDays: prevStage === 0 ? REVIEW_INTERVAL_STEPS[0] : REVIEW_INTERVAL_STEPS[1]
    }
  }
  const streak = prevStreak + 1
  const stepJump = params.feedback === 'easy' ? 2 : 1
  const stage = Math.min(prevStage + stepJump, maxStage)
  const mastered = streak >= requiredStreak
  return {
    streak,
    stage,
    mastered,
    delayDays: mastered ? undefined : REVIEW_INTERVAL_STEPS[stage]
  }
}

/** 行测考场五大模块标准作答顺序 */
export const XINGCE_MODULE_ORDER = [
  '常识判断',
  '言语理解与表达',
  '数量关系',
  '判断推理',
  '资料分析'
] as const

/** 将不同题库的模块及细分题型名称归并到行测五大核心模块 */
export function normalizeXingceModule(category: string): string {
  const raw = String(category ?? '').trim()
  if (!raw) return '其他'
  if (
    raw === '言语理解' ||
    raw.startsWith('言语理解') ||
    /^(?:逻辑填空|选词填空|片段阅读|语句表达|阅读理解|篇章阅读|主旨概括|意图判断|细节判断|语句排序|语句衔接)/.test(
      raw
    )
  ) {
    return '言语理解与表达'
  }
  if (
    raw === '政治理论' ||
    raw === '常识判断' ||
    /^(?:常识|政治常识|法律常识|经济常识|科技常识|人文常识|地理常识|历史常识|管理常识|公文常识|时事政治|马克思主义|习近平)/.test(
      raw
    )
  ) {
    return '常识判断'
  }
  if (raw === '数量关系' || raw.startsWith('数量关系') || /^(?:数学运算|数字推理)/.test(raw)) {
    return '数量关系'
  }
  if (
    raw === '判断推理' ||
    raw.startsWith('判断推理') ||
    /^(?:图形推理|定义判断|类比推理|逻辑判断|削弱加强|翻译推理|真假推理|科学推理)/.test(raw)
  ) {
    return '判断推理'
  }
  if (
    raw === '资料分析' ||
    raw.startsWith('资料分析') ||
    /^(?:文字资料|表格资料|图形资料|综合资料)/.test(raw)
  ) {
    return '资料分析'
  }
  return raw
}

/** 展开模块别名供按配比抽题查询兼容不同来源题库 */
export function expandCategoryAliases(category: string): string[] {
  const raw = String(category ?? '').trim()
  if (raw === '言语理解与表达' || raw === '言语理解') {
    return ['言语理解与表达', '言语理解']
  }
  if (raw === '常识判断' || raw === '政治理论') {
    return ['常识判断', '政治理论']
  }
  return raw ? [raw] : []
}

/** 行测各模块考场建议均题配速（秒/题） */
export const XINGCE_PACE_SECONDS_PER_QUESTION: Record<string, number> = {
  常识判断: 35,
  言语理解与表达: 48,
  言语理解: 48,
  政治理论: 35,
  数量关系: 75,
  判断推理: 50,
  资料分析: 75
}

export function suggestedModuleSeconds(category: string, questionCount: number): number {
  const normalized = normalizeXingceModule(category)
  const perQuestion =
    XINGCE_PACE_SECONDS_PER_QUESTION[category] ?? XINGCE_PACE_SECONDS_PER_QUESTION[normalized] ?? 55
  return Math.max(60, Math.round(perQuestion * questionCount))
}

export interface ExamPreset {
  id: string
  name: string
  badge: string
  description: string
  subject: 'xingce'
  durationMinutes: number
  questionCount: number
  categoryQuotas: Array<{ category: string; count: number }>
}

/** 高频限时专项冲刺与国省考仿真配比预设 */
export const EXAM_PRESETS: readonly ExamPreset[] = [
  {
    id: 'ziliao-sprint',
    name: '资料分析限时冲刺',
    badge: '20 题 · 25 分钟',
    description: '4 套完整 5 题材料连续出题，锻造速算与定位手感',
    subject: 'xingce',
    durationMinutes: 25,
    questionCount: 20,
    categoryQuotas: [{ category: '资料分析', count: 20 }]
  },
  {
    id: 'yanyu-sprint',
    name: '言语理解限时冲刺',
    badge: '20 题 · 16 分钟',
    description: '控制均题 48 秒内，压缩犹豫改选耗时',
    subject: 'xingce',
    durationMinutes: 16,
    questionCount: 20,
    categoryQuotas: [{ category: '言语理解与表达', count: 20 }]
  },
  {
    id: 'panduan-sprint',
    name: '判断推理限时冲刺',
    badge: '20 题 · 18 分钟',
    description: '图推/定义/类比/逻辑综合配速提效',
    subject: 'xingce',
    durationMinutes: 18,
    questionCount: 20,
    categoryQuotas: [{ category: '判断推理', count: 20 }]
  },
  {
    id: 'shuliang-sprint',
    name: '数量关系限时冲刺',
    badge: '10 题 · 12 分钟',
    description: '训练快速挑题与赋值/代入果断拿分策略',
    subject: 'xingce',
    durationMinutes: 12,
    questionCount: 10,
    categoryQuotas: [{ category: '数量关系', count: 10 }]
  },
  {
    id: 'guokao-130',
    name: '国考地市仿真配比',
    badge: '130 题 · 120 分钟',
    description: '常识 20 · 言语 40 · 数量 10 · 判断 40 · 资料 20（4 套连续）',
    subject: 'xingce',
    durationMinutes: 120,
    questionCount: 130,
    categoryQuotas: [
      { category: '常识判断', count: 20 },
      { category: '言语理解与表达', count: 40 },
      { category: '数量关系', count: 10 },
      { category: '判断推理', count: 40 },
      { category: '资料分析', count: 20 }
    ]
  },
  {
    id: 'shengkao-120',
    name: '省考联考仿真配比',
    badge: '120 题 · 120 分钟',
    description: '常识 20 · 言语 35 · 数量 10 · 判断 35 · 资料 20（4 套连续）',
    subject: 'xingce',
    durationMinutes: 120,
    questionCount: 120,
    categoryQuotas: [
      { category: '常识判断', count: 20 },
      { category: '言语理解与表达', count: 35 },
      { category: '数量关系', count: 10 },
      { category: '判断推理', count: 35 },
      { category: '资料分析', count: 20 }
    ]
  }
]
