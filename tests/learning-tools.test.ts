import { describe, expect, it } from 'vitest'
import type { KnowledgeDocument, StudySnippet } from '../src/shared/contracts'
import {
  extractFlashcardsFromDocuments,
  extractFlashcardsFromSnippets
} from '../src/renderer/src/services/flashcard-parser'
import {
  generateSpeedCalcDeck,
  type SpeedCalcCategory
} from '../src/renderer/src/services/speed-calc-drill'
import { diffTexts } from '../src/renderer/src/services/text-diff'

describe('diffTexts', () => {
  it('returns single equal segment with zero changes for identical text', () => {
    const res = diffTexts('坚持以人民为中心的发展思想。', '坚持以人民为中心的发展思想。')
    expect(res.addedChars).toBe(0)
    expect(res.removedChars).toBe(0)
    expect(res.segments).toEqual([{ type: 'equal', text: '坚持以人民为中心的发展思想。' }])
  })

  it('tracks Chinese character additions and deletions accurately', () => {
    const before = '推进乡村产业发展'
    const after = '加快推进乡村特色产业高质量发展'
    const res = diffTexts(before, after)

    expect(res.addedChars).toBeGreaterThan(0)
    expect(res.removedChars).toBe(0)
    expect(res.segments.some((seg) => seg.type === 'add' && seg.text.includes('加快'))).toBe(true)

    const reconstructedBefore = res.segments
      .filter((s) => s.type !== 'add')
      .map((s) => s.text)
      .join('')
    const reconstructedAfter = res.segments
      .filter((s) => s.type !== 'remove')
      .map((s) => s.text)
      .join('')
    expect(reconstructedBefore).toBe(before)
    expect(reconstructedAfter).toBe(after)
  })

  it('handles empty inputs and complete deletion', () => {
    const cleared = diffTexts('删除全部文本', '')
    expect(cleared.removedChars).toBe(6)
    expect(cleared.addedChars).toBe(0)

    const added = diffTexts('', '新增内容')
    expect(added.addedChars).toBe(4)
    expect(added.removedChars).toBe(0)
  })
})

describe('generateSpeedCalcDeck', () => {
  it('generates well-formed 4-option questions across every speed calculation category', () => {
    const categories: SpeedCalcCategory[] = ['all', 'fraction', 'division', 'growth', 'square']
    for (const cat of categories) {
      const deck = generateSpeedCalcDeck(cat, 8)
      expect(deck).toHaveLength(8)
      for (const q of deck) {
        if (cat !== 'all') {
          expect(q.category).toBe(cat)
        }
        expect(q.prompt.trim().length).toBeGreaterThan(0)
        expect(q.explanation.trim().length).toBeGreaterThan(0)
        expect(q.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D'])
        expect(['A', 'B', 'C', 'D']).toContain(q.answerKey)
        const uniqueTexts = new Set(q.options.map((o) => o.text))
        expect(uniqueTexts.size).toBe(4)
      }
    }
  })
})

describe('flashcard-parser', () => {
  it('extracts heading sections, bold bullet terms, and markdown table rows while skipping headers', () => {
    const doc: KnowledgeDocument = {
      id: 'doc-da-1',
      subject: 'xingce',
      kind: 'knowledge',
      title: '资料分析速查',
      summary: '核心公式与百化分',
      tags: ['资料分析', '公式'],
      content: [
        '## 基期量核心关系',
        '已知现期量与增长率时，采用现期量除以一加增长率求解，注意估算精度。',
        '- **间隔增长率**：$R = r_1 + r_2 + r_1 \\times r_2$，用于隔年求增速',
        '',
        '## 常用百化分表',
        '| 分数 | 百分数 |',
        '| --- | --- |',
        '| 1/7 | 14.3% |',
        '| 1/8 | 12.5% |'
      ].join('\n')
    }

    const cards = extractFlashcardsFromDocuments([doc])
    expect(
      cards.some((c) => c.front.includes('间隔增长率') && c.back.includes('用于隔年求增速'))
    ).toBe(true)
    expect(cards.some((c) => c.front.includes('1/7') && c.back.includes('14.3%'))).toBe(true)
    expect(cards.some((c) => c.front.includes('基期量核心关系'))).toBe(true)
    // 表头与分隔符不可生成卡片
    expect(cards.some((c) => c.front.includes('---') || c.front === '【常用百化分表】分数')).toBe(
      false
    )
  })

  it('creates a fallback summary card for unstructured short documents', () => {
    const shortDoc: KnowledgeDocument = {
      id: 'doc-short',
      subject: 'shenlun',
      kind: 'knowledge',
      title: '共同富裕短卡片',
      summary: '政策要点',
      tags: ['共同富裕'],
      content:
        '共同富裕是社会主义的本质要求，是中国式现代化的重要特征，要在高质量发展中促进共同富裕。'
    }

    const cards = extractFlashcardsFromDocuments([shortDoc])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.front).toContain('共同富裕短卡片')
    expect(cards[0]?.back).toContain('中国式现代化的重要特征')
  })

  it('maps norm and quote StudySnippets to flashcards', () => {
    const snippets: StudySnippet[] = [
      {
        id: 'sn-1',
        kind: 'norm',
        title: '办不成事',
        content: '窗口服务协同不畅，群众办事满意度偏低',
        tags: ['政务服务'],
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'sn-2',
        kind: 'quote',
        title: '生态文明名言',
        content: '绿水青山就是金山银山。',
        tags: ['生态'],
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]

    const cards = extractFlashcardsFromSnippets(snippets)
    expect(cards).toHaveLength(2)
    expect(cards[0]?.front).toContain('规范词转换')
    expect(cards[0]?.sourceTitle).toBe('个人规范词库')
    expect(cards[1]?.front).toContain('金句/素材默写')
    expect(cards[1]?.sourceTitle).toBe('个人金句卡')
  })
})
