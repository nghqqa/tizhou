import type { QuestionLibraryExportParams, QuestionLibraryItem } from '../../shared/contracts'

const TAB_LABELS: Record<QuestionLibraryExportParams['tab'], string> = {
  wrong: '错题本',
  favorite: '收藏夹',
  notes: '笔记库'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeFileSegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 24)
}

export function libraryExportFileName(
  params: Pick<QuestionLibraryExportParams, 'tab' | 'category' | 'includeAnswers' | 'format'>,
  date = new Date()
): string {
  const tabName = TAB_LABELS[params.tab] ?? '题单'
  const categoryPart = params.category?.trim() ? `-${safeFileSegment(params.category)}` : ''
  const modePart = params.includeAnswers ? '' : '-无答案二刷卷'
  const ext = params.format === 'html' ? 'html' : 'md'
  return `题舟${tabName}${categoryPart}${modePart}-${localDateString(date)}.${ext}`
}

export function renderQuestionLibraryMarkdown(
  items: QuestionLibraryItem[],
  params: Pick<
    QuestionLibraryExportParams,
    'tab' | 'category' | 'wrongCause' | 'includeAnswers' | 'includeNotes'
  >,
  generatedAt = new Date()
): string {
  const tabName = TAB_LABELS[params.tab] ?? '题单'
  const titleParts = [`题舟${tabName}`]
  if (params.category?.trim()) titleParts.push(params.category.trim())
  if (params.wrongCause?.trim()) titleParts.push(params.wrongCause.trim())
  const title = titleParts.join(' · ')
  const dateText = localDateString(generatedAt)

  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(title.replace(/[\r\n]+/g, ' ').trim())}`,
    `date: ${dateText}`,
    `count: ${items.length}`,
    `includeAnswers: ${params.includeAnswers}`,
    'tags:',
    '  - 题舟',
    `  - ${tabName}`,
    'tz-source: tizhou-library-export',
    '---',
    '',
    `# ${title}`,
    '',
    `> 导出日期：${dateText} · 共 ${items.length} 题 · ${params.includeAnswers ? '含参考答案与解析' : '无答案二刷卷（已隐藏参考答案）'}`,
    ''
  ]

  items.forEach((item, index) => {
    const q = item.question
    const meta = [q.category, `难度 ${q.difficulty}`]
    if (q.year) meta.push(String(q.year))
    if (item.wrongCount > 0) meta.push(`错 ${item.wrongCount} 次`)
    if (item.lastWrongCause) meta.push(item.lastWrongCause)
    lines.push(`## 第 ${index + 1} 题（${meta.join(' · ')}）`, '')
    if (q.material?.trim()) {
      lines.push('**给定材料**', '', q.material.trim(), '')
    }
    lines.push(q.stem.trim(), '')
    if (q.options.length > 0) {
      for (const option of q.options) {
        lines.push(`- **${option.key}.** ${option.text}`)
      }
      lines.push('')
    }
    if (params.includeAnswers) {
      lines.push(`**参考答案：** ${q.answer.length ? q.answer.join('、') : '见下方参考解析'}`, '')
      if (q.explanation.trim()) {
        lines.push('**解析：**', '', q.explanation.trim(), '')
      }
    }
    if (params.includeNotes && item.note.trim()) {
      lines.push(`> **我的笔记：** ${item.note.trim().replace(/\r?\n/g, '\n> ')}`, '')
    }
    lines.push('---', '')
  })

  return `${lines.join('\n')}\n`
}

export function renderQuestionLibraryHtml(
  items: QuestionLibraryItem[],
  params: Pick<
    QuestionLibraryExportParams,
    'tab' | 'category' | 'wrongCause' | 'includeAnswers' | 'includeNotes'
  >,
  generatedAt = new Date()
): string {
  const tabName = TAB_LABELS[params.tab] ?? '题单'
  const titleParts = [`题舟${tabName}`]
  if (params.category?.trim()) titleParts.push(params.category.trim())
  if (params.wrongCause?.trim()) titleParts.push(params.wrongCause.trim())
  const title = titleParts.join(' · ')
  const dateText = localDateString(generatedAt)

  const cards = items
    .map((item, index) => {
      const q = item.question
      const meta = [q.category, `难度 ${q.difficulty}`]
      if (q.year) meta.push(String(q.year))
      if (item.wrongCount > 0) meta.push(`错 ${item.wrongCount} 次`)
      if (item.lastWrongCause) meta.push(item.lastWrongCause)

      const materialHtml = q.material?.trim()
        ? `<div class="material"><strong>给定材料</strong><p>${escapeHtml(q.material.trim()).replace(/\r?\n/g, '<br>')}</p></div>`
        : ''
      const optionsHtml =
        q.options.length > 0
          ? `<ul class="options">${q.options
              .map(
                (opt) =>
                  `<li><span class="opt-key">${escapeHtml(opt.key)}</span><span>${escapeHtml(opt.text)}</span></li>`
              )
              .join('')}</ul>`
          : ''
      const answerHtml = params.includeAnswers
        ? `<div class="answer">
            <div><strong>参考答案：</strong>${escapeHtml(q.answer.length ? q.answer.join('、') : '见参考解析')}</div>
            ${q.explanation.trim() ? `<div class="explanation">${escapeHtml(q.explanation.trim()).replace(/\r?\n/g, '<br>')}</div>` : ''}
          </div>`
        : ''
      const noteHtml =
        params.includeNotes && item.note.trim()
          ? `<div class="note"><strong>我的笔记：</strong>${escapeHtml(item.note.trim()).replace(/\r?\n/g, '<br>')}</div>`
          : ''

      return `<article class="q-card">
        <header class="q-head">
          <h2>第 ${index + 1} 题</h2>
          <span class="meta">${escapeHtml(meta.join(' · '))}</span>
        </header>
        ${materialHtml}
        <div class="stem">${escapeHtml(q.stem.trim()).replace(/\r?\n/g, '<br>')}</div>
        ${optionsHtml}
        ${answerHtml}
        ${noteHtml}
      </article>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 36px;
      font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      color: #1f2328;
      background: #faf9f6;
      line-height: 1.75;
      font-size: 14.5px;
    }
    .sheet { max-width: 860px; margin: 0 auto; }
    .doc-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      padding-bottom: 14px;
      margin-bottom: 20px;
      border-bottom: 2px solid #2b4c7e;
    }
    .doc-header h1 { margin: 0 0 4px; font-size: 22px; }
    .doc-header p { margin: 0; color: #57606a; font-size: 13px; }
    .print-btn {
      padding: 8px 16px;
      border: 1px solid #2b4c7e;
      border-radius: 6px;
      background: #2b4c7e;
      color: #fff;
      font-size: 13px;
      cursor: pointer;
    }
    .q-card {
      background: #fff;
      border: 1px solid #e2dfd8;
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 14px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .q-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 8px;
    }
    .q-head h2 { margin: 0; font-size: 15px; color: #2b4c7e; }
    .meta { font-size: 12px; color: #6e7781; }
    .material {
      padding: 10px 12px;
      margin-bottom: 10px;
      background: #f5f3ee;
      border-left: 3px solid #2b4c7e;
      font-size: 13.5px;
    }
    .material p { margin: 6px 0 0; }
    .stem { font-weight: 500; margin-bottom: 10px; }
    .options { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 6px; }
    .options li { display: flex; gap: 8px; align-items: baseline; }
    .opt-key {
      display: inline-grid;
      place-items: center;
      min-width: 22px;
      height: 22px;
      border: 1px solid #d0d7de;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .answer {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed #d8d3c8;
      font-size: 13.5px;
    }
    .explanation { margin-top: 6px; color: #3c424a; }
    .note {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #fdf6e7;
      border-left: 3px solid #b57614;
      font-size: 13px;
    }
    @media print {
      body { padding: 0; background: #fff; font-size: 12.5pt; }
      .print-btn { display: none; }
      .q-card { border-color: #d0d7de; box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="doc-header">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p>导出日期：${escapeHtml(dateText)} · 共 ${items.length} 题 · ${params.includeAnswers ? '含参考答案与解析' : '无答案二刷卷'}</p>
      </div>
      <button class="print-btn" type="button" onclick="window.print()">打印 / 保存 PDF</button>
    </div>
    ${cards}
  </div>
</body>
</html>
`
}
