import type { KnowledgeDocument, StudySnippet } from '@shared/contracts'

export interface FlashcardItem {
  id: string
  front: string
  back: string
  hint?: string
  tags: string[]
  sourceTitle: string
}

function cleanCardText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从知识/方法/规律 Markdown 文档抽取出正反面主动回忆闪卡（零外部依赖，支持标题段落、加粗词条与表格行） */
export function extractFlashcardsFromDocuments(
  docs: KnowledgeDocument[],
  maxCards = 40
): FlashcardItem[] {
  const cards: FlashcardItem[] = []
  const seenFront = new Set<string>()
  const pushCard = (item: FlashcardItem): void => {
    const front = item.front.trim()
    const back = item.back.trim()
    if (front.length < 3 || back.length < 4 || seenFront.has(front)) return
    seenFront.add(front)
    cards.push(item)
  }

  for (const doc of docs) {
    const lines = doc.content.replace(/\r\n?/g, '\n').split('\n')
    let currentHeading = ''
    let bodyLines: string[] = []

    const flushHeadingSection = (lineIndex: number): void => {
      if (currentHeading && bodyLines.length > 0) {
        const cleanBody = cleanCardText(bodyLines.join(' '))
        if (cleanBody.length >= 10 && cleanBody.length <= 420) {
          pushCard({
            id: `fc-sec-${doc.id}-${lineIndex}`,
            front: `${doc.title} · 「${currentHeading}」的核心要点是什么？`,
            back: cleanBody,
            hint: doc.tags.slice(0, 3).join(' / ') || undefined,
            tags: doc.tags,
            sourceTitle: doc.title
          })
        }
      }
      bodyLines = []
    }

    for (let i = 0; i < lines.length; i += 1) {
      if (cards.length >= maxCards) return cards
      const trimmed = lines[i]!.trim()
      if (!trimmed) continue

      // 1) 加粗「概念：解释」列表项，如 `- **基期量**：现期 ÷ (1 + r)`
      const boldBulletMatch = trimmed.match(
        /^(?:[-*+]|\d+\.)\s+\*\*([^*]{2,40})\*\*\s*[：:]\s*(.+)$/
      )
      if (boldBulletMatch) {
        const term = cleanCardText(boldBulletMatch[1]!)
        const detail = cleanCardText(boldBulletMatch[2]!)
        if (term && detail) {
          pushCard({
            id: `fc-term-${doc.id}-${i}`,
            front: currentHeading ? `【${currentHeading}】${term}` : `${doc.title}：${term}`,
            back: detail,
            hint: doc.title,
            tags: doc.tags,
            sourceTitle: doc.title
          })
          continue
        }
      }

      // 2) 两列表或以上 Markdown 表格行（跳过分隔符 `|---|---` 和表头）
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed
          .slice(1, -1)
          .split('|')
          .map((c) => cleanCardText(c))
        const isSeparator = cells.every((c) => /^:?-+:?$/.test(c) || c === '')
        const looksHeader =
          cells[0] && /^(?:词条|名词|概念|类型|口语|原表达|题型|项目|名称)$/.test(cells[0])
        if (!isSeparator && !looksHeader && cells.length >= 2 && cells[0] && cells[1]) {
          pushCard({
            id: `fc-tbl-${doc.id}-${i}`,
            front: currentHeading ? `【${currentHeading}】${cells[0]}` : cells[0],
            back: cells.slice(1).filter(Boolean).join(' · '),
            hint: doc.title,
            tags: doc.tags,
            sourceTitle: doc.title
          })
          continue
        }
      }

      // 3) ## / ### 标题分节卡片
      const headingMatch = trimmed.match(/^#{2,3}\s+(.+)$/)
      if (headingMatch) {
        flushHeadingSection(i)
        currentHeading = cleanCardText(headingMatch[1]!)
        continue
      }

      if (currentHeading && !trimmed.startsWith('```')) {
        bodyLines.push(trimmed)
      }
    }
    flushHeadingSection(lines.length)

    // 若整篇文档结构偏散（如单段短金句/政策卡片），保底生成 1 张整篇摘要闪卡
    const hadFromDoc = cards.some((c) => c.sourceTitle === doc.title)
    if (!hadFromDoc && cards.length < maxCards) {
      const fullClean = cleanCardText(doc.content).slice(0, 380)
      if (fullClean.length >= 12) {
        pushCard({
          id: `fc-doc-${doc.id}`,
          front: `请背诵/复述「${doc.title}」的核心内容${doc.summary ? `（${doc.summary.slice(0, 36)}）` : ''}`,
          back: fullClean,
          hint: doc.tags.slice(0, 3).join(' / ') || undefined,
          tags: doc.tags,
          sourceTitle: doc.title
        })
      }
    }
  }
  return cards.slice(0, maxCards)
}

/** 将个人收藏的规范词与金句素材转为主动回忆闪卡 */
export function extractFlashcardsFromSnippets(snippets: StudySnippet[]): FlashcardItem[] {
  return snippets.map((snippet) => ({
    id: `fc-snip-${snippet.id}`,
    front:
      snippet.kind === 'norm'
        ? `规范词转换：如何规范表达「${snippet.title}」？`
        : `金句/素材默写：${snippet.title}`,
    back: snippet.content,
    hint: snippet.tags.join(' / ') || (snippet.kind === 'norm' ? '规范词库' : '金句收藏'),
    tags: snippet.tags,
    sourceTitle: snippet.kind === 'norm' ? '个人规范词库' : '个人金句卡'
  }))
}
