import type { QuestionLibraryExportParams, QuestionLibraryItem } from '../../shared/contracts'
import { localDateString } from '../utils/common'

const TAB_LABELS: Record<QuestionLibraryExportParams['tab'], string> = {
  wrong: '错题本',
  favorite: '收藏夹',
  notes: '笔记库'
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
  params: Pick<
    QuestionLibraryExportParams,
    'tab' | 'category' | 'includeAnswers' | 'format' | 'pdfLayout'
  >,
  date = new Date()
): string {
  const tabName = TAB_LABELS[params.tab] ?? '题单'
  const categoryPart = params.category?.trim() ? `-${safeFileSegment(params.category)}` : ''
  const modePart = !params.includeAnswers
    ? '-无答案二刷卷'
    : params.format === 'pdf'
      ? params.pdfLayout === 'annotated'
        ? '-A4题解对照'
        : '-A4试卷版'
      : ''
  const ext = params.format === 'pdf' ? 'pdf' : params.format === 'html' ? 'html' : 'md'
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
        const imageSuffix = option.image ? ` ![${option.key}](${option.image})` : ''
        lines.push(`- **${option.key}.** ${option.text}${imageSuffix}`.trimEnd())
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
  generatedAt = new Date(),
  resolveAssetDataUrl?: (sourceFilePath: string, assetPath: string) => string | null
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
        ? `<div class="material"><strong>给定材料</strong><p>${renderSafePdfRichText(q.material, q.filePath, resolveAssetDataUrl)}</p></div>`
        : ''
      const optionsHtml =
        q.options.length > 0
          ? `<ul class="options">${q.options
              .map((opt) => {
                const optImg =
                  opt.image && q.filePath && resolveAssetDataUrl
                    ? resolveAssetDataUrl(q.filePath, opt.image)
                    : null
                const imgTag =
                  optImg && /^data:image\//i.test(optImg)
                    ? `<img class="pdf-opt-img" src="${escapeHtml(optImg)}" alt="${escapeHtml(opt.key)}" />`
                    : opt.image
                      ? `<span class="img-placeholder">[附图：${escapeHtml(opt.key)}]</span>`
                      : ''
                return `<li><span class="opt-key">${escapeHtml(opt.key)}</span><span>${renderSafePdfRichText(opt.text, q.filePath, resolveAssetDataUrl)}${imgTag}</span></li>`
              })
              .join('')}</ul>`
          : ''
      const answerHtml = params.includeAnswers
        ? `<div class="answer">
            <div><strong>参考答案：</strong>${escapeHtml(q.answer.length ? q.answer.join('、') : '见参考解析')}</div>
            ${q.explanation.trim() ? `<div class="explanation">${renderSafePdfRichText(q.explanation, q.filePath, resolveAssetDataUrl)}</div>` : ''}
          </div>`
        : ''
      const noteHtml =
        params.includeNotes && item.note.trim()
          ? `<div class="note"><strong>我的笔记：</strong>${renderSafePdfRichText(item.note, q.filePath, resolveAssetDataUrl)}</div>`
          : ''

      return `<article class="q-card">
        <header class="q-head">
          <h2>第 ${index + 1} 题</h2>
          <span class="meta">${escapeHtml(meta.join(' · '))}</span>
        </header>
        ${materialHtml}
        <div class="stem">${renderSafePdfRichText(q.stem, q.filePath, resolveAssetDataUrl)}</div>
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

function renderSafePdfRichText(
  rawText: string,
  sourceFilePath: string | undefined,
  resolveAssetDataUrl?: (sourceFilePath: string, assetPath: string) => string | null
): string {
  const text = rawText.trim()
  if (!text) return ''
  const parts: string[] = []
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = imgRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(escapeHtml(text.slice(lastIdx, match.index)).replace(/\r?\n/g, '<br>'))
    }
    const alt = match[1] ?? ''
    const assetPath = (match[2] ?? '')
      .trim()
      .replace(/\s+["'][^"']*["']\s*$/, '')
      .replace(/^<|>$/g, '')
      .trim()
    const resolved =
      assetPath && sourceFilePath && resolveAssetDataUrl
        ? resolveAssetDataUrl(sourceFilePath, assetPath)
        : null
    if (resolved && /^data:image\//i.test(resolved)) {
      parts.push(`<img class="pdf-img" src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" />`)
    } else {
      parts.push(`<span class="img-placeholder">[附图：${escapeHtml(alt || assetPath)}]</span>`)
    }
    lastIdx = match.index + match[0].length
  }

  if (lastIdx < text.length) {
    parts.push(escapeHtml(text.slice(lastIdx)).replace(/\r?\n/g, '<br>'))
  }
  return parts.join('')
}

/**
 * 生成专用于 Electron `printToPDF` 的 A4 试卷级排版 HTML（支持纯题/答案附后与题解对照两种模式）。
 */
export function renderQuestionLibraryPdfHtml(
  items: QuestionLibraryItem[],
  params: Pick<
    QuestionLibraryExportParams,
    'tab' | 'category' | 'wrongCause' | 'includeAnswers' | 'includeNotes' | 'pdfLayout'
  >,
  options?: {
    resolveAssetDataUrl?: (sourceFilePath: string, assetPath: string) => string | null
    generatedAt?: Date
  }
): string {
  const generatedAt = options?.generatedAt ?? new Date()
  const resolveAsset = options?.resolveAssetDataUrl
  const layout: 'exam' | 'annotated' = params.pdfLayout === 'annotated' ? 'annotated' : 'exam'
  const tabName = TAB_LABELS[params.tab] ?? '题单'
  const titleParts = [`题舟${tabName}`]
  if (params.category?.trim()) titleParts.push(params.category.trim())
  if (params.wrongCause?.trim()) titleParts.push(params.wrongCause.trim())
  const title = titleParts.join(' · ')
  const dateText = localDateString(generatedAt)

  const layoutHint = !params.includeAnswers
    ? '无答案二刷卷'
    : layout === 'annotated'
      ? 'A4 题解对照版'
      : 'A4 试卷版（文末附答案解析）'

  const questionCards = items
    .map((item, index) => {
      const q = item.question
      const meta = [q.category, `难度 ${q.difficulty}`]
      if (q.year) meta.push(String(q.year))
      if (item.wrongCount > 0) meta.push(`错 ${item.wrongCount} 次`)
      if (item.lastWrongCause) meta.push(item.lastWrongCause)

      const materialHtml = q.material?.trim()
        ? `<div class="material"><strong>给定材料</strong><div class="material-body">${renderSafePdfRichText(q.material, q.filePath, resolveAsset)}</div></div>`
        : ''

      const optionsHtml =
        q.options.length > 0
          ? `<ul class="options">${q.options
              .map((opt) => {
                const optImg =
                  opt.image && q.filePath && resolveAsset
                    ? resolveAsset(q.filePath, opt.image)
                    : null
                const imgTag =
                  optImg && /^data:image\//i.test(optImg)
                    ? `<img class="pdf-opt-img" src="${escapeHtml(optImg)}" alt="${escapeHtml(opt.key)}" />`
                    : ''
                return `<li><span class="opt-key">${escapeHtml(opt.key)}</span><div class="opt-val">${renderSafePdfRichText(opt.text, q.filePath, resolveAsset)}${imgTag}</div></li>`
              })
              .join('')}</ul>`
          : ''

      const inlineAnswerHtml =
        layout === 'annotated' && params.includeAnswers
          ? `<div class="answer">
              <div><strong>参考答案：</strong>${escapeHtml(q.answer.length ? q.answer.join('、') : '见参考解析')}</div>
              ${q.explanation.trim() ? `<div class="explanation">${renderSafePdfRichText(q.explanation, q.filePath, resolveAsset)}</div>` : ''}
            </div>`
          : ''

      const inlineNoteHtml =
        (layout === 'annotated' || !params.includeAnswers) &&
        params.includeNotes &&
        item.note.trim()
          ? `<div class="note"><strong>我的笔记：</strong>${renderSafePdfRichText(item.note, q.filePath, resolveAsset)}</div>`
          : ''

      const examAnswerSlot =
        layout === 'exam' && q.options.length > 0 ? '<span class="answer-slot">（　　）</span>' : ''

      return `<article class="q-card">
        <header class="q-head">
          <h2>第 ${index + 1} 题 ${examAnswerSlot}</h2>
          <span class="meta">${escapeHtml(meta.join(' · '))}</span>
        </header>
        ${materialHtml}
        <div class="stem">${renderSafePdfRichText(q.stem, q.filePath, resolveAsset)}</div>
        ${optionsHtml}
        ${inlineAnswerHtml}
        ${inlineNoteHtml}
      </article>`
    })
    .join('\n')

  let appendixHtml = ''
  if (layout === 'exam' && params.includeAnswers) {
    const quickGridCells = items
      .map((item, index) => {
        const rawAns = item.question.answer.length ? item.question.answer.join('') : ''
        const ans = item.question.type === 'essay' || !rawAns || rawAns.length > 6 ? '主观' : rawAns
        return `<div class="ans-cell"><span class="ans-no">${index + 1}</span><span class="ans-val">${escapeHtml(ans)}</span></div>`
      })
      .join('')

    const detailItems = items
      .map((item, index) => {
        const q = item.question
        const ans = q.answer.length ? q.answer.join('、') : '见下方解析'
        const expHtml = q.explanation.trim()
          ? `<div class="explanation">${renderSafePdfRichText(q.explanation, q.filePath, resolveAsset)}</div>`
          : ''
        const noteHtml =
          params.includeNotes && item.note.trim()
            ? `<div class="note"><strong>我的笔记：</strong>${renderSafePdfRichText(item.note, q.filePath, resolveAsset)}</div>`
            : ''
        return `<div class="appendix-item">
          <div class="appendix-head"><strong>第 ${index + 1} 题</strong> · 参考答案：<span class="ans-highlight">${escapeHtml(ans)}</span></div>
          ${expHtml}
          ${noteHtml}
        </div>`
      })
      .join('\n')

    appendixHtml = `<section class="answer-appendix">
      <h2 class="appendix-title">参考答案速查与解析</h2>
      <div class="ans-grid">${quickGridCells}</div>
      <div class="appendix-list">${detailItems}</div>
    </section>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 14mm 14mm 16mm 14mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      color: #1c1917;
      background: #fff;
      font-size: 10.5pt;
      line-height: 1.65;
    }
    .paper-header {
      padding-bottom: 10px;
      margin-bottom: 14px;
      border-bottom: 2px solid #2f4f43;
    }
    .paper-header h1 {
      margin: 0 0 4px;
      font-size: 17pt;
      color: #1c1917;
    }
    .paper-meta {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 9.2pt;
      color: #57534e;
    }
    .paper-fill-line {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px dashed #d6d3d1;
      font-size: 9pt;
      color: #78716c;
    }
    .q-card {
      padding: 10px 12px;
      margin-bottom: 11px;
      border: 1px solid #e7e5e4;
      border-radius: 6px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .q-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
    }
    .q-head h2 {
      margin: 0;
      font-size: 10.8pt;
      color: #2f4f43;
    }
    .answer-slot {
      font-weight: 500;
      color: #78716c;
    }
    .meta { font-size: 8.5pt; color: #78716c; }
    .material {
      padding: 7px 10px;
      margin-bottom: 8px;
      background: #f5f5f4;
      border-left: 3px solid #2f4f43;
      font-size: 9.6pt;
    }
    .material-body { margin-top: 4px; }
    .stem { font-weight: 500; margin-bottom: 8px; }
    .options { list-style: none; padding: 0; margin: 0 0 6px; display: grid; gap: 4px; }
    .options li { display: flex; gap: 7px; align-items: flex-start; }
    .opt-key {
      display: inline-grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      border: 1px solid #a8a29e;
      border-radius: 3px;
      font-size: 8.8pt;
      font-weight: 600;
      margin-top: 2px;
    }
    .opt-val { flex: 1; min-width: 0; }
    .pdf-img, .pdf-opt-img {
      display: block;
      max-width: 100%;
      max-height: 220px;
      margin: 6px 0;
      object-fit: contain;
    }
    .pdf-opt-img { max-height: 92px; }
    .img-placeholder { color: #78716c; font-size: 9pt; }
    .answer {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed #d6d3d1;
      font-size: 9.6pt;
    }
    .explanation { margin-top: 4px; color: #44403c; font-size: 9.4pt; }
    .note {
      margin-top: 6px;
      padding: 6px 9px;
      border-radius: 4px;
      background: #fefce8;
      border-left: 3px solid #b45309;
      font-size: 9.2pt;
    }
    .answer-appendix {
      break-before: page;
      page-break-before: always;
    }
    .appendix-title {
      margin: 0 0 10px;
      padding-bottom: 6px;
      border-bottom: 1.5px solid #2f4f43;
      font-size: 13pt;
      color: #2f4f43;
    }
    .ans-grid {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: 4px;
      margin-bottom: 14px;
    }
    .ans-cell {
      display: flex;
      justify-content: space-between;
      padding: 3px 6px;
      border: 1px solid #d6d3d1;
      border-radius: 3px;
      font-size: 8.8pt;
    }
    .ans-no { color: #78716c; }
    .ans-val, .ans-highlight { font-weight: 700; color: #b45309; }
    .appendix-item {
      padding: 8px 0;
      border-bottom: 1px solid #e7e5e4;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .appendix-head { font-size: 9.8pt; margin-bottom: 3px; }
  </style>
</head>
<body>
  <header class="paper-header">
    <h1>${escapeHtml(title)}</h1>
    <div class="paper-meta">
      <span>导出日期：${escapeHtml(dateText)} · 共 ${items.length} 题</span>
      <span>${escapeHtml(layoutHint)}</span>
    </div>
    ${layout === 'exam' ? '<div class="paper-fill-line">刷题人：____________　　用时：______ 分钟　　二刷正确率：______ / ' + items.length + '</div>' : ''}
  </header>
  ${questionCards}
  ${appendixHtml}
</body>
</html>
`
}
