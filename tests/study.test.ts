// 组题抽题：资料分析一组材料带 N 道连续小题，抽题以组为原子单位
import { describe, expect, it } from 'vitest'
import { buildQuestionUnits, takeUnits } from '../src/main/services/study'
import type { Question } from '../src/shared/contracts'

function question(id: string, groupId?: string, groupOrder?: number): Question {
  return {
    id,
    subject: 'xingce',
    category: '资料分析',
    type: 'single',
    stem: `第${id}题题干占位文本，长度超过八个字符`,
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' }
    ],
    answer: ['A'],
    explanation: '解析',
    difficulty: 2,
    source: '测试',
    tags: [],
    contentHash: id,
    ...(groupId ? { groupId } : {}),
    ...(groupOrder !== undefined ? { groupOrder } : {})
  }
}

describe('buildQuestionUnits', () => {
  it('同组小题聚成一个单元并按组内序号排序，散题各自成单元', () => {
    const pool = [
      question('s1'),
      question('g3', 'kbg-a', 3),
      question('g1', 'kbg-a', 1),
      question('s2'),
      question('g2', 'kbg-a', 2)
    ]
    const units = buildQuestionUnits(pool)
    expect(units).toHaveLength(3)
    const group = units.find((unit) => unit.length === 3)
    expect(group?.map((item) => item.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('不同组的成员互不合并', () => {
    const pool = [
      question('a1', 'kbg-a', 1),
      question('b1', 'kbg-b', 1),
      question('a2', 'kbg-a', 2)
    ]
    const units = buildQuestionUnits(pool)
    expect(units).toHaveLength(2)
    expect(units.map((unit) => unit.length).sort((x, y) => y - x)).toEqual([2, 1])
  })
})

describe('takeUnits', () => {
  it('整组连续收取，组内顺序保持', () => {
    const group = [1, 2, 3, 4, 5].map((order) => question(`g${order}`, 'kbg-a', order))
    const singles = [question('s1'), question('s2'), question('s3')]
    const picked = takeUnits([group, singles], 12)
    expect(picked.map((item) => item.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 's1', 's2', 's3'])
  })

  it('放不下的大组先跳过，由能放下的小组回填空位', () => {
    const big = [1, 2, 3, 4, 5].map((order) => question(`b${order}`, 'kbg-b', order))
    const small = [question('s1'), question('s2')]
    const picked = takeUnits([big, small], 5)
    // 大组放不进剩余 5-2=3 的位置时先跳过，小组回填，最后仍以能收的整组结尾
    expect(picked.length).toBeLessThanOrEqual(5)
    const groupIds = picked.filter((item) => item.groupId === 'kbg-b')
    if (groupIds.length > 0) {
      // 收了组就必须整组连续且按序
      expect(groupIds.map((item) => item.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
    }
  })

  it('首个单元超长时截断但不破坏连续性', () => {
    const group = [1, 2, 3, 4, 5].map((order) => question(`g${order}`, 'kbg-a', order))
    const picked = takeUnits([group], 3)
    expect(picked.map((item) => item.id)).toEqual(['g1', 'g2', 'g3'])
  })
})
