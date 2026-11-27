import { XINGCE_MODULE_ORDER, normalizeXingceModule } from '../../../shared/study-constants'

export type ScoreTemplateId = 'guokao-dishi' | 'guokao-fusheng' | 'shengkao-120'

export interface ScoreTemplateModule {
  moduleName: (typeof XINGCE_MODULE_ORDER)[number]
  questionCount: number
  pointsPerQuestion: number
  /** 公考高分（75分档）标准基准正确率 */
  baselineTargetAccuracy: number
  /** 短期提分弹性系数（用于排序 ROI 突破优先级） */
  breakthroughWeight: number
}

export interface ScoreTemplate {
  id: ScoreTemplateId
  label: string
  totalQuestions: number
  totalScore: number
  modules: ScoreTemplateModule[]
}

export const SCORE_ESTIMATOR_STORAGE_KEY = 'tizhou.scoreEstimator.v1'

export const SCORE_TEMPLATES: Record<ScoreTemplateId, ScoreTemplate> = {
  'guokao-dishi': {
    id: 'guokao-dishi',
    label: '国考地市（130题 · 100分）',
    totalQuestions: 130,
    totalScore: 100,
    modules: [
      {
        moduleName: '常识判断',
        questionCount: 20,
        pointsPerQuestion: 0.5,
        baselineTargetAccuracy: 0.55,
        breakthroughWeight: 0.65
      },
      {
        moduleName: '言语理解与表达',
        questionCount: 40,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.15
      },
      {
        moduleName: '数量关系',
        questionCount: 10,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.6,
        breakthroughWeight: 0.85
      },
      {
        moduleName: '判断推理',
        questionCount: 40,
        pointsPerQuestion: 0.75,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.2
      },
      {
        moduleName: '资料分析',
        questionCount: 20,
        pointsPerQuestion: 1.0,
        baselineTargetAccuracy: 0.85,
        breakthroughWeight: 1.35
      }
    ]
  },
  'guokao-fusheng': {
    id: 'guokao-fusheng',
    label: '国考副省（135题 · 100分）',
    totalQuestions: 135,
    totalScore: 100,
    modules: [
      {
        moduleName: '常识判断',
        questionCount: 20,
        pointsPerQuestion: 0.5,
        baselineTargetAccuracy: 0.55,
        breakthroughWeight: 0.65
      },
      {
        moduleName: '言语理解与表达',
        questionCount: 40,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.15
      },
      {
        moduleName: '数量关系',
        questionCount: 15,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.6,
        breakthroughWeight: 0.85
      },
      {
        moduleName: '判断推理',
        questionCount: 40,
        pointsPerQuestion: 0.7,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.2
      },
      {
        moduleName: '资料分析',
        questionCount: 20,
        pointsPerQuestion: 0.9,
        baselineTargetAccuracy: 0.85,
        breakthroughWeight: 1.35
      }
    ]
  },
  'shengkao-120': {
    id: 'shengkao-120',
    label: '省考联考（120题 · 100分）',
    totalQuestions: 120,
    totalScore: 100,
    modules: [
      {
        moduleName: '常识判断',
        questionCount: 20,
        pointsPerQuestion: 0.6,
        baselineTargetAccuracy: 0.55,
        breakthroughWeight: 0.65
      },
      {
        moduleName: '言语理解与表达',
        questionCount: 35,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.15
      },
      {
        moduleName: '数量关系',
        questionCount: 10,
        pointsPerQuestion: 1.0,
        baselineTargetAccuracy: 0.6,
        breakthroughWeight: 0.85
      },
      {
        moduleName: '判断推理',
        questionCount: 35,
        pointsPerQuestion: 0.8,
        baselineTargetAccuracy: 0.8,
        breakthroughWeight: 1.2
      },
      {
        moduleName: '资料分析',
        questionCount: 20,
        pointsPerQuestion: 1.1,
        baselineTargetAccuracy: 0.85,
        breakthroughWeight: 1.35
      }
    ]
  }
}

export interface CategoryStatInput {
  category: string
  attempts: number
  correct: number
  accuracy: number
}

export interface ModuleScoreBreakdown {
  moduleName: string
  questionCount: number
  pointsPerQuestion: number
  maxScore: number
  attempts: number
  hasData: boolean
  lowSample: boolean
  currentAccuracy: number
  estimatedScore: number
  targetAccuracy: number
  targetScore: number
  scoreGap: number
  questionsNeeded: number
  roiScore: number
  recommended: boolean
}

export interface ScoreEstimateResult {
  template: ScoreTemplate
  targetTotalScore: number
  estimatedTotalScore: number
  totalGap: number
  totalQuestionsNeeded: number
  reachedTarget: boolean
  modules: ModuleScoreBreakdown[]
  topRecommendation: string
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 按公考分模块题量与单题分值权重拆解当前估分与目标分数。
 */
export function estimateXingceScore(
  categoryStats: CategoryStatInput[],
  templateId: ScoreTemplateId,
  rawTargetScore: number
): ScoreEstimateResult {
  const template = SCORE_TEMPLATES[templateId] ?? SCORE_TEMPLATES['guokao-dishi']
  const targetTotalScore = clamp(
    Number.isFinite(rawTargetScore) ? Math.round(rawTargetScore) : 75,
    50,
    95
  )

  const byModule = new Map<string, { attempts: number; correct: number }>()
  for (const row of categoryStats) {
    const mod = normalizeXingceModule(row.category)
    const entry = byModule.get(mod) ?? { attempts: 0, correct: 0 }
    entry.attempts += Math.max(0, row.attempts)
    entry.correct += Math.max(0, row.correct)
    byModule.set(mod, entry)
  }

  // 计算基准高分模板下的参考总分，按用户设定的目标总分等比缩放各模块目标正确率；
  // 若部分模块触及 95% 上限，将截断差额按比例水填到未触顶模块，确保各模块目标分之和与目标总分一致
  const baselineTotal = template.modules.reduce(
    (sum, mod) => sum + mod.questionCount * mod.pointsPerQuestion * mod.baselineTargetAccuracy,
    0
  )
  const scaleFactor = baselineTotal > 0 ? targetTotalScore / baselineTotal : 1
  const targetAccuracies = template.modules.map((mod) =>
    clamp(mod.baselineTargetAccuracy * scaleFactor, 0.35, 0.95)
  )
  for (let pass = 0; pass < 6; pass += 1) {
    const currentTargetSum = template.modules.reduce(
      (sum, mod, i) => sum + mod.questionCount * mod.pointsPerQuestion * targetAccuracies[i]!,
      0
    )
    const deficit = targetTotalScore - currentTargetSum
    if (Math.abs(deficit) < 0.05) break
    const adjustable = template.modules
      .map((mod, i) => ({
        i,
        room:
          deficit > 0
            ? (0.95 - targetAccuracies[i]!) * mod.questionCount * mod.pointsPerQuestion
            : (targetAccuracies[i]! - 0.35) * mod.questionCount * mod.pointsPerQuestion,
        maxScore: mod.questionCount * mod.pointsPerQuestion
      }))
      .filter((item) => item.room > 1e-4)
    const totalRoom = adjustable.reduce((sum, item) => sum + item.room, 0)
    if (totalRoom <= 1e-4) break
    const shareRatio = Math.min(1, Math.abs(deficit) / totalRoom)
    for (const item of adjustable) {
      const deltaScore = (deficit > 0 ? 1 : -1) * item.room * shareRatio
      targetAccuracies[item.i] = clamp(
        targetAccuracies[item.i]! + deltaScore / item.maxScore,
        0.35,
        0.95
      )
    }
  }

  const rawRows = template.modules.map((mod, idx) => {
    const stat = byModule.get(mod.moduleName)
    const attempts = stat?.attempts ?? 0
    const hasData = attempts > 0
    const lowSample = hasData && attempts < 10
    const currentAccuracy = hasData ? clamp(stat!.correct / attempts, 0, 1) : 0.5
    const maxScore = round1(mod.questionCount * mod.pointsPerQuestion)
    const estimatedScore = round1(maxScore * currentAccuracy)

    const targetAccuracy = targetAccuracies[idx]!
    const targetScore = round1(maxScore * targetAccuracy)
    const rawGap = Math.max(0, targetScore - estimatedScore)
    const questionsNeeded = Math.max(0, Math.ceil(rawGap / mod.pointsPerQuestion))
    const roiScore =
      mod.pointsPerQuestion * Math.max(0, 0.92 - currentAccuracy) * mod.breakthroughWeight

    return {
      moduleName: mod.moduleName,
      questionCount: mod.questionCount,
      pointsPerQuestion: mod.pointsPerQuestion,
      maxScore,
      attempts,
      hasData,
      lowSample,
      currentAccuracy: Math.round(currentAccuracy * 100),
      estimatedScore,
      targetAccuracy: Math.round(targetAccuracy * 100),
      targetScore,
      scoreGap: round1(rawGap),
      questionsNeeded,
      roiScore,
      recommended: false
    }
  })

  const priorityCandidates = rawRows
    .filter((row) => row.questionsNeeded > 0 || row.currentAccuracy < 85)
    .sort((a, b) => b.roiScore - a.roiScore)

  const topNames = new Set(priorityCandidates.slice(0, 2).map((item) => item.moduleName))
  const modules: ModuleScoreBreakdown[] = rawRows.map((row) => ({
    ...row,
    recommended: topNames.has(row.moduleName)
  }))

  const estimatedTotalScore = round1(modules.reduce((sum, mod) => sum + mod.estimatedScore, 0))
  const totalGap = round1(Math.max(0, targetTotalScore - estimatedTotalScore))
  const totalQuestionsNeeded = modules.reduce((sum, mod) => sum + mod.questionsNeeded, 0)
  const reachedTarget = estimatedTotalScore >= targetTotalScore

  const top1 = priorityCandidates[0]
  const top2 = priorityCandidates[1]
  let topRecommendation = ''
  if (reachedTarget) {
    topRecommendation = top1
      ? `已达到 ${targetTotalScore} 分目标线，下一步可重点巩固「${top1.moduleName}」冲刺更高分。`
      : `当前各模块表现均衡，已稳站 ${targetTotalScore} 分目标线以上。`
  } else if (top1) {
    topRecommendation = top2
      ? `距目标还差 ${totalGap.toFixed(1)} 分：优先突破「${top1.moduleName}」（${top1.pointsPerQuestion}分/题）与「${top2.moduleName}」，投入产出比最高。`
      : `距目标还差 ${totalGap.toFixed(1)} 分：优先突破「${top1.moduleName}」最容易补齐分差。`
  } else {
    topRecommendation = `继续保持稳定刷题节奏，逐步补齐各模块准确率即可达成 ${targetTotalScore} 分目标。`
  }

  return {
    template,
    targetTotalScore,
    estimatedTotalScore,
    totalGap,
    totalQuestionsNeeded,
    reachedTarget,
    modules,
    topRecommendation
  }
}

export interface ScoreEstimatorPrefs {
  templateId: ScoreTemplateId
  targetScore: number
}

export function loadScoreEstimatorPrefs(): ScoreEstimatorPrefs {
  const fallback: ScoreEstimatorPrefs = { templateId: 'guokao-dishi', targetScore: 75 }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(SCORE_ESTIMATOR_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ScoreEstimatorPrefs> | null
    if (!parsed) return fallback
    const templateId =
      parsed.templateId && parsed.templateId in SCORE_TEMPLATES
        ? parsed.templateId
        : fallback.templateId
    const targetScore =
      typeof parsed.targetScore === 'number' && Number.isFinite(parsed.targetScore)
        ? clamp(Math.round(parsed.targetScore), 50, 95)
        : fallback.targetScore
    return { templateId, targetScore }
  } catch {
    return fallback
  }
}

export function saveScoreEstimatorPrefs(prefs: ScoreEstimatorPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCORE_ESTIMATOR_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* 忽略受限存储异常 */
  }
}
