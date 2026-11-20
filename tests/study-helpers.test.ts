import { describe, expect, it } from 'vitest'
import {
  computeExamCountdown,
  extractMarkdownHeadings,
  extractSearchSnippet,
  extractWordLimit
} from '../src/renderer/src/services/study-helpers'

describe('study-helpers（申论字数识别、文档目录/正文检索、考试倒计时）', () => {
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

  it('extractMarkdownHeadings 提取 H2/H3 并忽略代码块中的注释井号', () => {
    const md = [
      '# 一级主标题',
      '## 第一部分：核心原则',
      '正文内容',
      '```python',
      '## 代码块内不是标题',
      '```',
      '### 1.1 **具体步骤**',
      '## [第二部分](https://example.com) ##'
    ].join('\n')
    expect(extractMarkdownHeadings(md)).toEqual([
      { level: 2, text: '第一部分：核心原则', index: 0 },
      { level: 3, text: '1.1 具体步骤', index: 1 },
      { level: 2, text: '第二部分', index: 2 }
    ])
  })

  it('extractSearchSnippet 返回正文命中上下文片段', () => {
    const doc =
      '# 标题\n\n在资料分析中，遇到基期比重变化问题，可以先判断部分增长率与整体增长率的大小关系。'
    const snippet = extractSearchSnippet(doc, '基期比重')
    expect(snippet).toContain('基期比重')
    expect(extractSearchSnippet(doc, '不存在的词')).toBeNull()
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
})
