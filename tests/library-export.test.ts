import { describe, expect, it } from 'vitest'
import type { QuestionLibraryItem } from '../src/shared/contracts'
import {
  libraryExportFileName,
  renderQuestionLibraryHtml,
  renderQuestionLibraryMarkdown,
  renderQuestionLibraryPdfHtml
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

  it('支持 A4 试卷级 PDF HTML 生成（试卷附后解析版 / 题解对照版）与本地安全图片嵌入', () => {
    const fixedDate = new Date(2026, 10, 25)
    expect(
      libraryExportFileName(
        {
          tab: 'wrong',
          category: '判断推理',
          includeAnswers: true,
          format: 'pdf',
          pdfLayout: 'exam'
        },
        fixedDate
      )
    ).toBe('题舟错题本-判断推理-A4试卷版-2026-11-25.pdf')

    expect(
      libraryExportFileName(
        {
          tab: 'wrong',
          includeAnswers: true,
          format: 'pdf',
          pdfLayout: 'annotated'
        },
        fixedDate
      )
    ).toBe('题舟错题本-A4题解对照-2026-11-25.pdf')

    const imgItems = [
      {
        ...SAMPLE_ITEMS[0]!,
        question: {
          ...SAMPLE_ITEMS[0]!.question,
          filePath: 'E:/vault/demo.md',
          stem: '观察规律 ![图形](assets/fig1.png) <script>bad()</script>',
          options: [
            { key: 'A', text: '图A', image: 'assets/optA.png' },
            { key: 'B', text: '图B', image: 'javascript:alert(1)' }
          ]
        }
      }
    ]

    const examPdfHtml = renderQuestionLibraryPdfHtml(
      imgItems,
      { tab: 'wrong', includeAnswers: true, includeNotes: true, pdfLayout: 'exam' },
      {
        generatedAt: fixedDate,
        resolveAssetDataUrl: (_file, asset) =>
          asset.startsWith('assets/')
            ? `data:image/png;base64,ZmFrZQ==`
            : 'http://evil.example/x.png'
      }
    )

    expect(examPdfHtml).toContain('@page { size: A4;')
    expect(examPdfHtml).toContain('参考答案速查与解析')
    expect(examPdfHtml).toContain('class="ans-grid"')
    expect(examPdfHtml).toContain('src="data:image/png;base64,ZmFrZQ=="')
    expect(examPdfHtml).not.toContain('javascript:alert(1)')
    expect(examPdfHtml).not.toContain('<script>bad()</script>')
    expect(examPdfHtml).toContain('&lt;script&gt;bad()&lt;/script&gt;')

    const annotatedPdfHtml = renderQuestionLibraryPdfHtml(
      imgItems,
      { tab: 'wrong', includeAnswers: true, includeNotes: true, pdfLayout: 'annotated' },
      { generatedAt: fixedDate }
    )
    expect(annotatedPdfHtml).not.toContain('class="ans-grid"')
    expect(annotatedPdfHtml).toContain('A4 题解对照版')
    expect(annotatedPdfHtml).toContain('<strong>参考答案：</strong>')
  })

  it('MD/HTML 支持选项配图，无答案试卷 PDF 保留笔记且申论长答案不撑爆速查网格', () => {
    const fixedDate = new Date(2026, 3, 18)
    const essayAndImgItems: QuestionLibraryItem[] = [
      {
        ...SAMPLE_ITEMS[0]!,
        question: {
          ...SAMPLE_ITEMS[0]!.question,
          filePath: 'E:/vault/img.md',
          options: [{ key: 'A', text: '图形项', image: 'assets/a.png' }]
        }
      },
      {
        ...SAMPLE_ITEMS[0]!,
        note: '二刷必须牢记材料结构',
        question: {
          ...SAMPLE_ITEMS[0]!.question,
          id: 'sl-essay-1',
          subject: 'shenlun',
          type: 'essay',
          category: '归纳概括',
          options: [],
          answer: ['要点一完善制度', '要点二强化监管', '要点三群众参与']
        }
      }
    ]

    const md = renderQuestionLibraryMarkdown(
      essayAndImgItems,
      { tab: 'wrong', includeAnswers: false, includeNotes: true },
      fixedDate
    )
    expect(md).toContain('![A](assets/a.png)')

    const html = renderQuestionLibraryHtml(
      essayAndImgItems,
      { tab: 'wrong', includeAnswers: false, includeNotes: true },
      fixedDate,
      (_file, asset) => (asset === 'assets/a.png' ? 'data:image/png;base64,QUFB' : null)
    )
    expect(html).toContain('src="data:image/png;base64,QUFB"')

    const noAnsPdf = renderQuestionLibraryPdfHtml(
      essayAndImgItems,
      { tab: 'wrong', includeAnswers: false, includeNotes: true, pdfLayout: 'exam' },
      { generatedAt: fixedDate }
    )
    expect(noAnsPdf).toContain('二刷必须牢记材料结构')

    const withAnsPdf = renderQuestionLibraryPdfHtml(
      essayAndImgItems,
      { tab: 'wrong', includeAnswers: true, includeNotes: true, pdfLayout: 'exam' },
      { generatedAt: fixedDate }
    )
    expect(withAnsPdf).toContain('<span class="ans-val">主观</span>')
  })
})
