export interface ChangelogSection {
  heading: string | null
  paragraphs: string[]
  items: string[]
}

export interface ChangelogRelease {
  version: string
  date: string
  badgeNote?: string
  anchorId: string
  headline: string
  sections: ChangelogSection[]
  itemCount: number
  searchText: string
}

export type ChangelogTopicId = 'all' | 'xingce' | 'shenlun' | 'knowledge' | 'ai'

export interface ChangelogTopicOption {
  id: ChangelogTopicId
  label: string
  keywords: string[]
}

export const CHANGELOG_TOPICS: ChangelogTopicOption[] = [
  { id: 'all', label: '全部版本', keywords: [] },
  {
    id: 'xingce',
    label: '行测与模考',
    keywords: ['行测', '模考', '资料分析', '图形推理', '专项练习', '错题', '复习', '答题卡']
  },
  {
    id: 'shenlun',
    label: '申论',
    keywords: ['申论', '给定资料', '批改', '作答']
  },
  {
    id: 'knowledge',
    label: '知识库与 OCR',
    keywords: [
      '知识库',
      '工坊',
      'ocr',
      'pdf',
      '直导',
      'markitdown',
      'vlm',
      '审核',
      '入库',
      'vault',
      'obsidian'
    ]
  },
  {
    id: 'ai',
    label: 'AI 与体验',
    keywords: [
      'ai',
      '流式',
      '模型',
      '主题',
      '快捷键',
      '草稿纸',
      '缩放',
      '检索',
      '工作台',
      '学习报告'
    ]
  }
]

function stripInlineSyntax(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function buildHeadline(sections: ChangelogSection[]): string {
  const named = sections.find((sec) => Boolean(sec.heading?.trim()))
  if (named?.heading) {
    return named.heading.trim()
  }
  for (const sec of sections) {
    const candidate = sec.paragraphs[0] ?? sec.items[0]?.split('\n')[0]
    if (!candidate) continue
    const plain = stripInlineSyntax(candidate)
    if (!plain) continue
    return plain.length > 48 ? `${plain.slice(0, 48)}...` : plain
  }
  return '版本更新'
}

/**
 * 解析仓库根 CHANGELOG.md 为结构化版本时间轴数组（保持原文倒序排列）。
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const releases: ChangelogRelease[] = []

  interface DraftRelease {
    version: string
    date: string
    badgeNote?: string
    sections: ChangelogSection[]
  }

  let current: DraftRelease | null = null
  let currentSection: ChangelogSection | null = null
  let paragraphBuf: string[] = []

  const ensureSection = (): ChangelogSection => {
    if (!currentSection && current) {
      currentSection = { heading: null, paragraphs: [], items: [] }
      current.sections.push(currentSection)
    }
    return currentSection!
  }

  const flushParagraph = (): void => {
    if (paragraphBuf.length === 0 || !current) {
      paragraphBuf = []
      return
    }
    ensureSection().paragraphs.push(paragraphBuf.join(' '))
    paragraphBuf = []
  }

  const finalizeRelease = (): void => {
    flushParagraph()
    if (!current) return
    const nonEmptySections = current.sections.filter(
      (sec) => sec.heading !== null || sec.paragraphs.length > 0 || sec.items.length > 0
    )
    const headline = buildHeadline(nonEmptySections)
    const totalItems = nonEmptySections.reduce((sum, sec) => sum + sec.items.length, 0)
    const totalParagraphs = nonEmptySections.reduce((sum, sec) => sum + sec.paragraphs.length, 0)
    const itemCount = totalItems > 0 ? totalItems : totalParagraphs

    const searchParts = [
      `v${current.version}`,
      current.version,
      current.date,
      current.badgeNote ?? '',
      headline,
      ...nonEmptySections.flatMap((sec) => [sec.heading ?? '', ...sec.paragraphs, ...sec.items])
    ]

    releases.push({
      version: current.version,
      date: current.date,
      badgeNote: current.badgeNote,
      anchorId: `changelog-${current.version}`,
      headline,
      sections: nonEmptySections,
      itemCount,
      searchText: searchParts.join(' ').toLowerCase()
    })

    current = null
    currentSection = null
  }

  for (const rawLine of lines) {
    const line = rawLine ?? ''
    const trimmed = line.trim()

    const releaseMatch = trimmed.match(/^##\s+([\d.]+)\s*-\s*(\d{4}-\d{2}-\d{2})(.*)$/)
    if (releaseMatch) {
      finalizeRelease()
      const version = releaseMatch[1]!
      const date = releaseMatch[2]!
      const rawNote = (releaseMatch[3] ?? '').trim()
      const badgeNote = rawNote
        ? rawNote
            .replace(/^[（(]/, '')
            .replace(/[）)]$/, '')
            .trim()
        : undefined
      current = {
        version,
        date,
        badgeNote: badgeNote || undefined,
        sections: []
      }
      continue
    }

    if (!current) {
      continue
    }

    if (!trimmed) {
      flushParagraph()
      continue
    }

    const sectionMatch = trimmed.match(/^###\s+(.+)$/)
    if (sectionMatch) {
      flushParagraph()
      currentSection = {
        heading: sectionMatch[1]!.trim(),
        paragraphs: [],
        items: []
      }
      current.sections.push(currentSection)
      continue
    }

    if (/^\s{2,}[-*]\s+/.test(line)) {
      flushParagraph()
      const sec = ensureSection()
      const subText = trimmed.replace(/^[-*]\s+/, '· ')
      if (sec.items.length > 0) {
        const lastIdx = sec.items.length - 1
        sec.items[lastIdx] = `${sec.items[lastIdx]}\n${subText}`
      } else {
        sec.items.push(subText)
      }
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph()
      ensureSection().items.push(trimmed.replace(/^[-*]\s+/, ''))
      continue
    }

    paragraphBuf.push(trimmed)
  }

  finalizeRelease()
  return releases
}

/**
 * 按多词 AND 关键词与主题标签过滤更新日志版本。
 */
export function matchesChangelogFilter(
  release: ChangelogRelease,
  query: string,
  topicId: ChangelogTopicId
): boolean {
  if (topicId !== 'all') {
    const topic = CHANGELOG_TOPICS.find((item) => item.id === topicId)
    if (topic && !topic.keywords.some((kw) => release.searchText.includes(kw.toLowerCase()))) {
      return false
    }
  }

  const terms = query
    .trim()
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .filter(Boolean)

  if (terms.length === 0) return true
  return terms.every((term) => release.searchText.includes(term))
}
