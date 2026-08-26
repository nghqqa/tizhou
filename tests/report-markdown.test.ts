import { describe, expect, it } from 'vitest'
import type { ReportData } from '../src/shared/contracts'
import {
  isTizhouGeneratedReport,
  renderReportMarkdown,
  reportFileName
} from '../src/main/services/report-markdown'

const fixedDate = new Date(2026, 7, 26, 21, 30)

function sampleReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    range: '30d',
    totalAttempts: 120,
    correctAttempts: 78,
    accuracy: 65,
    studyMinutes: 240,
    categoryStats: [
      { category: '言语理解', attempts: 40, correct: 30, accuracy: 75, averageDurationSeconds: 52 },
      { category: '数量关系', attempts: 20, correct: 8, accuracy: 40, averageDurationSeconds: 108 }
    ],
    dailyStats: [
      { date: '2026-08-25', attempts: 30, accuracy: 60, minutes: 60 },
      { date: '2026-08-26', attempts: 90, accuracy: 67, minutes: 180 }
    ],
    wrongCauses: [
      { cause: '概念混淆', count: 12 },
      { cause: '未标注', count: 30 }
    ],
    ...overrides
  }
}

describe('report-markdown', () => {
  it('文件名包含本地日期与范围标签', () => {
    expect(reportFileName('30d', fixedDate)).toBe('题舟学习报告-2026-08-26-近30天.md')
    expect(reportFileName('7d', fixedDate)).toBe('题舟学习报告-2026-08-26-近7天.md')
    expect(reportFileName('all', fixedDate)).toBe('题舟学习报告-2026-08-26-全部.md')
  })

  it('渲染包含 frontmatter 标记与核心统计', () => {
    const markdown = renderReportMarkdown(sampleReport(), fixedDate)
    expect(markdown.startsWith('---')).toBe(true)
    expect(markdown).toContain('tz-source: tizhou-report')
    expect(markdown).toContain('| 有效作答 | 120 题 |')
    expect(markdown).toContain('| 正确率 | 65% |')
    expect(markdown).toContain('# 题舟学习报告 · 近30天')
  })

  it('科目表按正确率降序排列', () => {
    const markdown = renderReportMarkdown(sampleReport(), fixedDate)
    const xingceIndex = markdown.indexOf('| 言语理解 |')
    const mathIndex = markdown.indexOf('| 数量关系 |')
    expect(xingceIndex).toBeGreaterThan(-1)
    expect(mathIndex).toBeGreaterThan(xingceIndex)
  })

  it('每日明细按日期升序排列', () => {
    const markdown = renderReportMarkdown(sampleReport(), fixedDate)
    expect(markdown.indexOf('| 2026-08-25 |')).toBeLessThan(markdown.indexOf('| 2026-08-26 |'))
  })

  it('空数据时省略对应章节', () => {
    const markdown = renderReportMarkdown(
      sampleReport({ categoryStats: [], dailyStats: [], wrongCauses: [] }),
      fixedDate
    )
    expect(markdown).not.toContain('## 科目掌握')
    expect(markdown).not.toContain('## 每日明细')
    expect(markdown).not.toContain('## 错因分布')
    expect(markdown).toContain('## 核心统计')
  })

  it('isTizhouGeneratedReport 识别自家导出文件', () => {
    const markdown = renderReportMarkdown(sampleReport(), fixedDate)
    expect(isTizhouGeneratedReport(markdown)).toBe(true)
  })

  it('正文里出现标记文本但不带 frontmatter 的文件不算自家导出', () => {
    const forged = '随便写的笔记，提到了 tz-source: tizhou-report 但没有 frontmatter。'
    expect(isTizhouGeneratedReport(forged)).toBe(false)
  })

  it('无标记的普通 Markdown 不算自家导出', () => {
    expect(isTizhouGeneratedReport('---\ntitle: 我的笔记\n---\n\n正文')).toBe(false)
    expect(isTizhouGeneratedReport('# 普通笔记')).toBe(false)
  })
})
