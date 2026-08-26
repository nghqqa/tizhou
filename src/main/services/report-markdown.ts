import type { ReportData } from '../../shared/contracts'

const RANGE_LABELS: Record<ReportData['range'], string> = {
  '7d': '近7天',
  '30d': '近30天',
  all: '全部'
}

/** frontmatter 标记：导出文件的身份证明，防止覆盖用户手写的同名文件 */
const GENERATED_MARKER = 'tz-source: tizhou-report'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function reportFileName(range: ReportData['range'], date = new Date()): string {
  return `题舟学习报告-${localDateString(date)}-${RANGE_LABELS[range]}.md`
}

export function isTizhouGeneratedReport(content: string): boolean {
  if (!content.startsWith('---')) return false
  return content.slice(0, 500).includes(GENERATED_MARKER)
}

export function renderReportMarkdown(report: ReportData, generatedAt = new Date()): string {
  const rangeLabel = RANGE_LABELS[report.range]
  const lines: string[] = [
    '---',
    `title: 题舟学习报告 · ${rangeLabel}`,
    `date: ${localDateString(generatedAt)}`,
    `range: ${report.range}`,
    'tags:',
    '  - 题舟',
    '  - 学习报告',
    GENERATED_MARKER,
    '---',
    '',
    `# 题舟学习报告 · ${rangeLabel}`,
    '',
    `> 由题舟导出于 ${localDateString(generatedAt)}。只统计已提交的有效作答。`,
    '',
    '## 核心统计',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    `| 有效作答 | ${report.totalAttempts} 题 |`,
    `| 答对 | ${report.correctAttempts} 题 |`,
    `| 正确率 | ${report.accuracy}% |`,
    `| 累计投入 | ${report.studyMinutes} 分钟 |`,
    ''
  ]

  if (report.categoryStats.length > 0) {
    lines.push(
      '## 科目掌握',
      '',
      '| 科目 | 作答 | 答对 | 正确率 | 平均用时 |',
      '| --- | --- | --- | --- | --- |'
    )
    for (const stat of [...report.categoryStats].sort((a, b) => b.accuracy - a.accuracy)) {
      lines.push(
        `| ${stat.category} | ${stat.attempts} | ${stat.correct} | ${stat.accuracy}% | ${Math.round(stat.averageDurationSeconds)} 秒 |`
      )
    }
    lines.push('')
  }

  if (report.wrongCauses.length > 0) {
    lines.push('## 错因分布', '', '| 错因 | 次数 |', '| --- | --- |')
    for (const cause of [...report.wrongCauses].sort((a, b) => b.count - a.count)) {
      lines.push(`| ${cause.cause} | ${cause.count} |`)
    }
    lines.push('')
  }

  if (report.dailyStats.length > 0) {
    lines.push('## 每日明细', '', '| 日期 | 作答 | 正确率 | 用时 |', '| --- | --- | --- | --- |')
    for (const day of [...report.dailyStats].sort((a, b) => a.date.localeCompare(b.date))) {
      lines.push(`| ${day.date} | ${day.attempts} | ${day.accuracy}% | ${day.minutes} 分钟 |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
