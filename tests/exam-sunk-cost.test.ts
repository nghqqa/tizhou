import { describe, expect, it } from 'vitest'
import { analyzeExamSunkCost } from '../src/renderer/src/services/exam-sunk-cost'

describe('exam-sunk-cost（模考超时黑洞榜与沉没成本分析）', () => {
  it('准确识别超时仍答错的沉没成本题并按耗时降序取 Top 10', () => {
    const sample = [
      {
        index: 1,
        questionId: 'q1',
        category: '常识判断',
        stem: '下列关于我国宪法表述正确的是？',
        correct: false,
        answered: true,
        durationSeconds: 110 // 推荐35s，阈值90s -> 沉没成本
      },
      {
        index: 2,
        questionId: 'q2',
        category: '资料分析',
        stem: '2025 年同比增量最大的是哪个季度？',
        correct: true,
        answered: true,
        durationSeconds: 135 // 超时但答对
      },
      {
        index: 3,
        questionId: 'q3',
        category: '数量关系',
        stem: '甲乙两人从相距 30 公里的两地同时相向而行……',
        correct: false,
        answered: false,
        durationSeconds: 150 // 耗时最高且未答错失 -> 沉没成本
      },
      {
        index: 4,
        questionId: 'q4',
        category: '言语理解',
        stem: '填入画横线部分最恰当的一项是：',
        correct: true,
        answered: true,
        durationSeconds: 45
      },
      {
        index: 5,
        questionId: 'q5',
        category: '判断推理',
        stem: '![img](assets/p1.png) 请选择最合适的一项',
        correct: false,
        answered: true,
        durationSeconds: 0 // 无耗时不计入榜单
      }
    ]

    const report = analyzeExamSunkCost(sample)
    expect(report.totalTrackedSeconds).toBe(440)
    expect(report.topSlowItems).toHaveLength(4)
    expect(report.topSlowItems.map((i) => i.index)).toEqual([3, 2, 1, 4])

    expect(report.sunkCostItems.map((i) => i.index)).toEqual([3, 1])
    expect(report.sunkCostTotalSeconds).toBe(260)
    expect(report.sunkCostSharePercent).toBe(Math.round((260 / 440) * 100))
    expect(report.topSlowItems[1]?.isOvertime).toBe(true)
    expect(report.topSlowItems[1]?.isSunkCost).toBe(false)
  })

  it('超 10 题时仅保留耗时最高的前 10 条', () => {
    const items = Array.from({ length: 15 }, (_, idx) => ({
      index: idx + 1,
      questionId: `q-${idx + 1}`,
      category: '判断推理',
      stem: `第 ${idx + 1} 题题干内容`,
      correct: idx % 2 === 0,
      answered: true,
      durationSeconds: (idx + 1) * 15
    }))

    const report = analyzeExamSunkCost(items)
    expect(report.topSlowItems).toHaveLength(10)
    expect(report.topSlowItems[0]?.index).toBe(15)
    expect(report.topSlowItems[9]?.index).toBe(6)
  })
})
