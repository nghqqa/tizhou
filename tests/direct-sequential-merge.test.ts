// 顺序配对兜底（套号漂移时的按位置配对）回归测试
import { describe, expect, it } from 'vitest'
import { mergeByDocumentOrder } from '../src/main/services/direct-sequential-merge'
import type { ParsedQuestion, ParsedSolution } from '../src/main/services/question-import'

const MATERIAL =
  '2022年城镇居民国内旅游人次19.28亿，农村居民6.02亿，旅游总收入2.05万亿元，为2019年的35.8%。'

function question(set: number, num: number, stem: string): ParsedQuestion {
  return {
    set,
    num,
    stem,
    options: [
      { key: 'A', text: `${stem.slice(0, 4)}的1.7倍` },
      { key: 'B', text: `${stem.slice(0, 4)}的2.4倍` }
    ],
    material: MATERIAL
  }
}

function solution(
  set: number,
  num: number,
  answer: string,
  stemExcerpt?: string
): [string, ParsedSolution] {
  return [
    `${set}-${num}`,
    {
      set,
      num,
      answer,
      qtype: '单选',
      explanation: '根据材料计算可得。',
      ...(stemExcerpt ? { stemExcerpt } : {})
    }
  ]
}

const OPTS = { subject: 'xingce', category: '行测-直导题库', sourceFile: '题本.pdf', tags: [] }

describe('mergeByDocumentOrder（顺序配对兜底）', () => {
  it('套内按位置配对并透传套共享材料', () => {
    const stemA = '2022年中国国内旅游总人次同比约下降了百分之多少'
    const stemB = '2018至2022年中国国内旅游收入同比增速最大的年份是哪一个'
    const questions = [question(16, 1, stemA), question(16, 2, stemB)]
    const solutions = new Map([solution(16, 1, 'D', stemA), solution(16, 2, 'B', stemB)])
    const result = mergeByDocumentOrder(questions, solutions, OPTS)
    expect(result.items).toHaveLength(2)
    expect(result.paired).toBe(2)
    expect(result.items[0]?.material).toBe(MATERIAL)
    expect(result.items[1]?.material).toBe(MATERIAL)
    expect(result.items[0]?.answer).toEqual(['D'])
    expect(result.items[1]?.answer).toEqual(['B'])
    expect(result.items[0]?.tags).toContain('第16套')
  })

  it('重印片段与题干/选项均不相似时保守剔除该题', () => {
    const stem = '2022年中国国内旅游总人次同比约下降了百分之多少'
    const questions = [question(16, 1, stem)]
    const solutions = new Map([solution(16, 1, 'D', '完全无关的量子物理实验记录片段')])
    const result = mergeByDocumentOrder(questions, solutions, OPTS)
    expect(result.items).toHaveLength(0)
    expect(result.skippedMisaligned).toBe(1)
  })

  it('解析册缺少对应套时该套不产出', () => {
    const questions = [question(18, 1, '2022年中国国内旅游总人次同比约下降了百分之多少')]
    const solutions = new Map([solution(19, 1, 'A')])
    const result = mergeByDocumentOrder(questions, solutions, OPTS)
    expect(result.items).toHaveLength(0)
  })
})
