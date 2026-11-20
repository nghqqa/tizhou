import { describe, expect, it } from 'vitest'
import type { QuestionLibraryItem } from '../src/shared/contracts'
import {
  libraryExportFileName,
  renderQuestionLibraryHtml,
  renderQuestionLibraryMarkdown
} from '../src/main/services/library-export'

const SAMPLE_ITEMS: QuestionLibraryItem[] = [
  {
    question: {
      id: 'q-exp-1',
      subject: 'xingce',
      category: '资料分析',
      type: 'single',
      material: '2025 年某省生产总值 1000 亿元，同比增长 12.5%。',
      stem: '2024 年该省生产总值约为多少？<script>alert(1)</script>',
      options: [
        { key: 'A', text: '889 亿元' },
        { key: 'B', text: '912 亿元' }
      ],
      answer: ['A'],
      explanation: '基期量 = 1000 / (1 + 1/8) = 888.9 亿元。',
      difficulty: 3,
      source: '2025国考',
      year: 2025,
      tags: ['基期'],
      contentHash: 'hash-1'
    },
    wrongCount: 2,
    correctStreak: 0,
    lastWrongCause: '计算失误',
    favorite: true,
    note: '用百化分 12.5% = 1/8 速算 <img onerror=1>'
  }
]

describe('library-export（错题本/收藏夹/笔记库导出）', () => {
  it('libraryExportFileName 按标签、分类、答案开关与格式生成安全文件名', () => {
    const fixedDate = new Date(2026, 10, 20)
    expect(
      libraryExportFileName(
        { tab: 'wrong', category: '资料/分析', includeAnswers: true, format: 'markdown' },
        fixedDate
      )
    ).toBe('题舟错题本-资料分析-2026-11-20.md')
    expect(
      libraryExportFileName({ tab: 'favorite', includeAnswers: false, format: 'html' }, fixedDate)
    ).toBe('题舟收藏夹-无答案二刷卷-2026-11-20.html')
  })

  it('renderQuestionLibraryMarkdown 支持含答案与隐藏答案二刷卷两种口径', () => {
    const withAns = renderQuestionLibraryMarkdown(
      SAMPLE_ITEMS,
      { tab: 'wrong', category: '资料分析', includeAnswers: true, includeNotes: true },
      new Date(2026, 10, 20)
    )
    expect(withAns).toContain('tz-source: tizhou-library-export')
    expect(withAns).toContain('**参考答案：** A')
    expect(withAns).toContain('基期量 = 1000')
    expect(withAns).toContain('我的笔记')

    const noAns = renderQuestionLibraryMarkdown(
      SAMPLE_ITEMS,
      { tab: 'wrong', includeAnswers: false, includeNotes: false },
      new Date(2026, 10, 20)
    )
    expect(noAns).toContain('无答案二刷卷')
    expect(noAns).not.toContain('**参考答案：**')
    expect(noAns).not.toContain('基期量 = 1000')
    expect(noAns).not.toContain('我的笔记')
  })

  it('renderQuestionLibraryHtml 严格转义 HTML 并生成打印样式', () => {
    const html = renderQuestionLibraryHtml(
      SAMPLE_ITEMS,
      { tab: 'notes', includeAnswers: true, includeNotes: true },
      new Date(2026, 10, 20)
    )
    expect(html).toContain('@media print')
    expect(html).toContain('window.print()')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<img onerror=1>')
    expect(html).toContain('&lt;img onerror=1&gt;')
  })
})
