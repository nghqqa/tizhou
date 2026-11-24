import { describe, expect, it } from 'vitest'
import { escapeSqlLike, matchesSearchTerms, splitSearchTerms } from '../src/shared/search'
import { isEventComposing } from '../src/renderer/src/services/search-input'
import {
  computeExamCountdown,
  extractSearchSnippet,
  extractWordLimit,
  formatMaterialSource
} from '../src/renderer/src/services/study-helpers'

describe('study-helpers（申论字数识别、正文检索、考试倒计时）', () => {
  it('extractWordLimit 准确识别常见申论字数要求格式', () => {
    expect(extractWordLimit('要求：全面、准确、有条理。不超过200字。')).toEqual({
      max: 200,
      label: '≤ 200 字'
    })
    expect(extractWordLimit('请写一篇文章，字数在 800—1000 字。')).toEqual({
      min: 800,
      max: 1000,
      label: '800–1000 字'
    })
    expect(extractWordLimit('请写一篇文章，字数 800–1000 字。')).toEqual({
      min: 800,
      max: 1000,
      label: '800–1000 字'
    })
    expect(extractWordLimit('自拟题目写一篇议论文，不少于1000字，不超过1200字。')).toEqual({
      min: 1000,
      max: 1200,
      label: '1000–1200 字'
    })
    expect(extractWordLimit('要求：不超过1200字，不少于800字。')).toEqual({
      min: 800,
      max: 1200,
      label: '800–1200 字'
    })
    expect(extractWordLimit('要求：300字以上，500字以内。')).toEqual({
      min: 300,
      max: 500,
      label: '300–500 字'
    })
    expect(extractWordLimit('自拟题目写一篇议论文，不少于1000字。')).toEqual({
      min: 1000,
      label: '≥ 1000 字'
    })
    expect(extractWordLimit('简明扼要，350字以内。')).toEqual({
      max: 350,
      label: '≤ 350 字'
    })
    expect(extractWordLimit('请谈谈你的理解，约 500 字左右。')).toEqual({
      min: 450,
      max: 550,
      label: '约 500 字'
    })
    expect(extractWordLimit('请概括该社区治理做法的主要特点。')).toBeNull()
  })

  it('extractSearchSnippet 返回正文命中上下文片段（含多词回退）', () => {
    const doc =
      '# 标题\n\n在资料分析中，遇到基期比重变化问题，可以先判断部分增长率与整体增长率的大小关系。'
    const snippet = extractSearchSnippet(doc, '基期比重')
    expect(snippet).toContain('基期比重')
    const multiSnippet = extractSearchSnippet(doc, '资料分析 整体增长率')
    expect(multiSnippet).toContain('整体增长率')
    expect(extractSearchSnippet(doc, '不存在的词')).toBeNull()
  })

  it('splitSearchTerms / escapeSqlLike / matchesSearchTerms 与 IME 组合态检测准确工作', () => {
    expect(splitSearchTerms('  2024\u3000法治   法治  营商环境 ')).toEqual([
      '2024',
      '法治',
      '营商环境'
    ])
    expect(splitSearchTerms('a b c d e f g h i j', 4)).toEqual(['a', 'b', 'c', 'd'])
    expect(escapeSqlLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
    expect(matchesSearchTerms('2024年国考副省级申论：优化营商环境', '2024 营商')).toBe(true)
    expect(matchesSearchTerms('2024年国考副省级申论：优化营商环境', '2024 乡村振兴')).toBe(false)

    expect(isEventComposing({ isComposing: true } as unknown as Event)).toBe(true)
    expect(isEventComposing({ keyCode: 229 } as unknown as Event)).toBe(true)
    expect(isEventComposing({ isComposing: false, keyCode: 13 } as unknown as Event)).toBe(false)
    expect(isEventComposing(undefined)).toBe(false)
  })

  it('computeExamCountdown 按本地自然日精确计算倒计时并拦截非法日期', () => {
    const base = new Date(2026, 10, 20, 16, 30, 0) // 2026-11-20
    expect(computeExamCountdown('2026-12-01', base)).toEqual({ daysLeft: 11, status: 'upcoming' })
    expect(computeExamCountdown('2026-11-20', base)).toEqual({ daysLeft: 0, status: 'today' })
    expect(computeExamCountdown('2026-11-15', base)).toEqual({ daysLeft: -5, status: 'passed' })
    expect(computeExamCountdown('2026-02-31', base)).toBeNull()
    expect(computeExamCountdown('not-a-date', base)).toBeNull()
    expect(computeExamCountdown('', base)).toBeNull()
  })

  it('formatMaterialSource 清洗本地资料前缀与文件扩展名', () => {
    expect(formatMaterialSource('本地资料/2027申论-专项提升夸夸刷.pdf')).toBe(
      '2027申论-专项提升夸夸刷'
    )
    expect(formatMaterialSource('本地资料/kaogong-bank-20260907')).toBe('kaogong-bank-20260907')
    expect(formatMaterialSource('题舟内置示例')).toBe('题舟内置示例')
    expect(formatMaterialSource('')).toBe('')
  })

  it('classifyShenlunType 准确归类单一题/综合题/公文题/作文题', async () => {
    const { classifyShenlunType } = await import('../src/shared/shenlun')
    expect(classifyShenlunType('申论-归纳概括', '概括做法')).toBe('单一题')
    expect(classifyShenlunType('申论-提出对策', '提出建议')).toBe('单一题')
    expect(classifyShenlunType('申论-综合分析', '谈谈理解')).toBe('综合题')
    expect(classifyShenlunType('申论-贯彻执行', '写一份发言稿')).toBe('公文题')
    expect(classifyShenlunType('应用文', '写一封公开信')).toBe('公文题')
    expect(classifyShenlunType('申论-大作文', '写一篇文章')).toBe('作文题')

    // 书名或默认兜底分类时按题干特征自动识别
    expect(
      classifyShenlunType(
        '申论-夸夸刷申论',
        '请结合给定资料，以“绿色发展”为主题，自拟题目写一篇文章，800—1000字。'
      )
    ).toBe('作文题')
    expect(
      classifyShenlunType(
        '申论综合',
        '假如你是某市商务局工作人员，请起草一份关于夜经济发展的倡议书。'
      )
    ).toBe('公文题')
    expect(
      classifyShenlunType('申论-酷酷刷申论', '结合给定资料，谈谈你对“电力自由”这句话的理解。')
    ).toBe('综合题')
    expect(classifyShenlunType('申论综合', '根据给定资料2，概括W市社区治理的主要做法。')).toBe(
      '单一题'
    )
  })
})
