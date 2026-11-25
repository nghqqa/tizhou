import { describe, expect, it } from 'vitest'
import { SCORE_TEMPLATES, estimateXingceScore } from '../src/renderer/src/services/score-estimator'

describe('score-estimator（行测目标分拆解与分模块加权估分）', () => {
  it('全部权重模板均严格合计为 100 分', () => {
    for (const tpl of Object.values(SCORE_TEMPLATES)) {
      const sum = tpl.modules.reduce((acc, m) => acc + m.questionCount * m.pointsPerQuestion, 0)
      expect(Math.round(sum * 10) / 10).toBe(100)
    }
  })

  it('兼容题库模块别名并对无样本模块按 50% 基准兜底', () => {
    const res = estimateXingceScore(
      [
        { category: '言语理解', attempts: 40, correct: 32, accuracy: 80 }, // 归并言语理解与表达 0.8
        { category: '政治理论', attempts: 20, correct: 12, accuracy: 60 }, // 归并常识判断 0.6
        { category: '资料分析', attempts: 20, correct: 16, accuracy: 80 }
      ],
      'guokao-dishi',
      75
    )

    const yanyu = res.modules.find((m) => m.moduleName === '言语理解与表达')
    const changshi = res.modules.find((m) => m.moduleName === '常识判断')
    const shuliang = res.modules.find((m) => m.moduleName === '数量关系')

    expect(yanyu?.hasData).toBe(true)
    expect(yanyu?.currentAccuracy).toBe(80)
    expect(yanyu?.estimatedScore).toBe(25.6)

    expect(changshi?.hasData).toBe(true)
    expect(changshi?.currentAccuracy).toBe(60)
    expect(changshi?.estimatedScore).toBe(6)

    expect(shuliang?.hasData).toBe(false)
    expect(shuliang?.currentAccuracy).toBe(50)
    expect(shuliang?.estimatedScore).toBe(4)
  })

  it('按目标总分拆解差距题数并标出高性价比突破模块', () => {
    const res = estimateXingceScore(
      [
        { category: '常识判断', attempts: 20, correct: 11, accuracy: 55 },
        { category: '言语理解与表达', attempts: 40, correct: 28, accuracy: 70 },
        { category: '数量关系', attempts: 10, correct: 5, accuracy: 50 },
        { category: '判断推理', attempts: 40, correct: 28, accuracy: 70 },
        { category: '资料分析', attempts: 20, correct: 10, accuracy: 50 }
      ],
      'guokao-dishi',
      75
    )

    expect(res.reachedTarget).toBe(false)
    expect(res.totalGap).toBeGreaterThan(0)
    expect(res.totalQuestionsNeeded).toBeGreaterThan(0)

    const ziliao = res.modules.find((m) => m.moduleName === '资料分析')
    expect(ziliao?.recommended).toBe(true)
    expect(ziliao?.questionsNeeded).toBeGreaterThan(0)
    expect(res.topRecommendation).toContain('资料分析')
  })
})
