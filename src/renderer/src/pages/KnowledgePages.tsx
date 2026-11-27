import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Field, Input } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookBookmarkIcon,
  CardsIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  MagnifyingGlassIcon,
  XIcon
} from '@phosphor-icons/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { KnowledgeDocument, Subject } from '@shared/contracts'
import { matchesSearchTerms } from '@shared/search'
import { invoke } from '../api'
import { KnowledgeFlashcardDialog } from '../components/KnowledgeFlashcardDialog'
import { MarkdownContent } from '../components/MarkdownContent'
import { ReadingTypographyBar, useReadingTypography } from '../components/ReadingTypographyControl'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { useImeSearchInput } from '../services/search-input'
import {
  classifyDocumentFilters,
  extractSearchSnippet,
  filterDocumentsByCategory,
  sortDocumentsForReading
} from '../services/study-helpers'
import { useAppStore } from '../store'

interface KnowledgePageProps {
  subject: Subject
  kind: 'knowledge' | 'method'
}

export function KnowledgePage({ subject, kind }: KnowledgePageProps): React.JSX.Element {
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const refreshDashboard = useAppStore((state) => state.refreshDashboard)
  const [searchParams] = useSearchParams()
  const requestedDocId = searchParams.get('docId') ?? ''
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [selectedId, setSelectedId] = useState(requestedDocId)
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [copiedId, setCopiedId] = useState('')
  const search = useImeSearchInput({ delayMs: 0 })
  const [error, setError] = useState('')
  const [flashcardOpen, setFlashcardOpen] = useState(false)
  const [recordingRead, setRecordingRead] = useState(false)
  const [selectedQuote, setSelectedQuote] = useState('')
  const [savingQuote, setSavingQuote] = useState(false)
  const reading = useReadingTypography()

  useEffect(() => {
    if (requestedDocId) {
      setSelectedId(requestedDocId)
      setCategoryFilter('all')
      search.clear()
    }
  }, [requestedDocId, search.clear])

  useEffect(() => {
    setDocuments(undefined)
    setError('')
    setCategoryFilter('all')
    void invoke<KnowledgeDocument[]>({ method: 'documents.list', params: { subject, kind } })
      .then((items) => {
        const sorted = sortDocumentsForReading(items)
        setDocuments(sorted)
        setSelectedId((prev) =>
          prev && sorted.some((item) => item.id === prev) ? prev : (sorted[0]?.id ?? '')
        )
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '文档读取失败'))
  }, [subject, kind])

  const categoryBuckets = useMemo(() => {
    if (!documents) return []
    return classifyDocumentFilters(documents, subject, kind)
  }, [documents, subject, kind])

  const filtered = useMemo(() => {
    if (!documents) return []
    const byCategory = filterDocumentsByCategory(documents, categoryFilter, subject, kind)
    const committed = search.committedValue.trim()
    if (!committed) return byCategory
    return byCategory.filter((document) =>
      matchesSearchTerms(
        `${document.title}\n${document.summary}\n${document.tags.join(' ')}\n${document.content}`,
        committed
      )
    )
  }, [documents, categoryFilter, subject, kind, search.committedValue])

  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0]
  const selectedIndex = selected ? filtered.findIndex((item) => item.id === selected.id) : -1
  const hasPrev = selectedIndex > 0
  const hasNext = selectedIndex >= 0 && selectedIndex < filtered.length - 1

  const contentRef = useRef<HTMLElement>(null)
  const [headings, setHeadings] = useState<
    Array<{ level: 2 | 3; text: string; element: HTMLElement }>
  >([])

  useEffect(() => {
    const container = contentRef.current
    container?.scrollTo({ top: 0 })
    if (!container || !selected) {
      setHeadings([])
      return
    }
    // 直接从已渲染 DOM 采集 h2/h3 节点，消除 ATX / Setext / HTML 标题 / 引用块标题的下标错位
    const collected: Array<{ level: 2 | 3; text: string; element: HTMLElement }> = []
    for (const node of container.querySelectorAll('.markdown h2, .markdown h3')) {
      if (!(node instanceof HTMLElement)) continue
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      collected.push({
        level: node.tagName === 'H3' ? 3 : 2,
        text,
        element: node
      })
    }
    setHeadings(collected)
    setSelectedQuote('')
  }, [selected?.id, selected?.content])

  async function recordReadingCheckin(): Promise<void> {
    if (recordingRead) return
    setRecordingRead(true)
    try {
      await invoke({
        method: 'plan.recordRead',
        params: {
          category: selected?.tags[0] || (subject === 'shenlun' ? '申论' : '行测'),
          minutes: 10
        }
      })
      await refreshDashboard()
      showToast('已完成今日知识阅读打卡（已同步学习计划进度）')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '打卡失败')
    } finally {
      setRecordingRead(false)
    }
  }

  function handleReadingMouseUp(): void {
    const text = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim()
    if (text.length >= 4 && text.length <= 400) {
      setSelectedQuote(text)
    } else {
      setSelectedQuote('')
    }
  }

  async function saveSelectedQuote(): Promise<void> {
    if (!selected || !selectedQuote || savingQuote) return
    setSavingQuote(true)
    try {
      await invoke({
        method: 'snippets.save',
        params: {
          kind: 'quote',
          title: selected.title.slice(0, 40),
          content: selectedQuote,
          sourceDocId: selected.id,
          tags: selected.tags.slice(0, 4)
        }
      })
      showToast('已收藏至申论金句/素材抽屉')
      setSelectedQuote('')
      window.getSelection()?.removeAllRanges()
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '收藏失败')
    } finally {
      setSavingQuote(false)
    }
  }

  function scrollToHeading(element: HTMLElement): void {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function copyContent(): Promise<void> {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected.content)
      setCopiedId(selected.id)
      showToast('已复制文档正文')
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === selected.id ? '' : prev))
      }, 1500)
    } catch {
      showToast('复制失败，请手动选中文本复制')
    }
  }

  const title = `${subject === 'xingce' ? '行测' : '申论'}${kind === 'knowledge' ? '知识' : '方法'}中心`
  const totalCount = documents?.length ?? 0
  const charCount = selected ? selected.content.replace(/\s+/g, '').length : 0

  if (error)
    return (
      <div className="page">
        <PageHeader title={title} />
        <ErrorState message={error} />
      </div>
    )
  return (
    <div className="page">
      <PageHeader
        eyebrow="知识 · 知识与方法"
        title={title}
        description="直接读取当前 Markdown 知识库，保留标题、列表、表格与公式结构。"
        actions={
          <>
            <Button
              appearance="secondary"
              icon={<CardsIcon />}
              disabled={!filtered.length}
              onClick={() => setFlashcardOpen(true)}
            >
              闪卡自测
            </Button>
            <Button
              appearance="subtle"
              icon={<CheckCircleIcon />}
              disabled={recordingRead}
              onClick={() => void recordReadingCheckin()}
            >
              {recordingRead ? '打卡中…' : '打卡今日阅读'}
            </Button>
          </>
        }
      />
      {!documents ? (
        <LoadingState label="正在读取知识文档" />
      ) : !documents.length ? (
        <EmptyState
          title="当前分类没有文档"
          description="在知识库 Markdown frontmatter 中设置 subject 与 kind 后重新索引，或到知识构建导入本地资料。"
          actionLabel="去知识构建导入"
          onAction={() => navigate('/knowledge-builder')}
        />
      ) : (
        <Section className="document-layout">
          <div className="document-list">
            <div className="document-list-head">
              <Field label="搜索文档（含正文）">
                <Input
                  value={search.value}
                  contentBefore={<MagnifyingGlassIcon />}
                  contentAfter={
                    search.value ? (
                      <button
                        type="button"
                        className="search-clear-btn"
                        aria-label="清除搜索关键词"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => search.clear()}
                      >
                        <XIcon size={13} />
                      </button>
                    ) : undefined
                  }
                  onChange={(event, data) => search.handleChange(data.value, event.nativeEvent)}
                  onCompositionStart={search.handleCompositionStart}
                  onCompositionEnd={search.handleCompositionEnd}
                  onKeyDown={search.handleKeyDown}
                  placeholder="标题、摘要、标签或正文关键词（空格分隔多词）"
                />
              </Field>
              {categoryBuckets.length > 1 && (
                <div className="doc-filter-chips" role="tablist" aria-label="文档分类筛选">
                  {categoryBuckets.map((bucket) => (
                    <button
                      key={bucket.key}
                      type="button"
                      role="tab"
                      aria-selected={categoryFilter === bucket.key}
                      className={`doc-filter-chip${categoryFilter === bucket.key ? ' is-active' : ''}`}
                      onClick={() => setCategoryFilter(bucket.key)}
                    >
                      <span>{bucket.label}</span>
                      <small>{bucket.count}</small>
                    </button>
                  ))}
                </div>
              )}
              <div className="doc-list-meta">
                <span>
                  {filtered.length === totalCount
                    ? `共 ${totalCount} 篇`
                    : `当前命中 ${filtered.length} / ${totalCount} 篇`}
                </span>
                {selectedIndex >= 0 && (
                  <span>
                    第 {selectedIndex + 1} / {filtered.length} 篇
                  </span>
                )}
              </div>
            </div>
            <div className="document-list-items">
              {filtered.map((document) => {
                const snippet = search.committedValue.trim()
                  ? extractSearchSnippet(document.content, search.committedValue)
                  : null
                const visibleTags = document.tags.slice(0, 2)
                return (
                  <button
                    type="button"
                    className={`document-item ${selected?.id === document.id ? 'active' : ''}`}
                    key={document.id}
                    onClick={() => setSelectedId(document.id)}
                  >
                    <strong>{document.title}</strong>
                    {visibleTags.length > 0 && (
                      <div className="doc-item-tags">
                        {visibleTags.map((tag) => (
                          <span className="doc-item-tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <small className={snippet ? 'doc-snippet' : undefined}>
                      {snippet ?? document.summary}
                    </small>
                  </button>
                )
              })}
            </div>
          </div>
          <article className="document-content" ref={contentRef}>
            {selected ? (
              <>
                <div className="doc-header-bar">
                  <div className="doc-meta-bar">
                    {selected.tags.slice(0, 4).map((tag) => (
                      <span className="pill" key={tag}>
                        {tag}
                      </span>
                    ))}
                    <span className="doc-word-count">
                      约 {charCount.toLocaleString('zh-CN')} 字
                    </span>
                  </div>
                  <div className="doc-header-tools">
                    <ReadingTypographyBar
                      contextLabel="文档"
                      typography={reading.typography}
                      onUpdate={reading.update}
                      onStepScale={reading.stepScale}
                      onResetScale={reading.resetScale}
                    />
                    <div className="doc-pager-actions">
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={copiedId === selected.id ? <CheckIcon /> : <CopyIcon />}
                        onClick={() => void copyContent()}
                      >
                        {copiedId === selected.id ? '已复制' : '复制正文'}
                      </Button>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowLeftIcon />}
                        disabled={!hasPrev}
                        aria-label="上一篇"
                        title="上一篇"
                        onClick={() => hasPrev && setSelectedId(filtered[selectedIndex - 1]!.id)}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowRightIcon />}
                        disabled={!hasNext}
                        aria-label="下一篇"
                        title="下一篇"
                        onClick={() => hasNext && setSelectedId(filtered[selectedIndex + 1]!.id)}
                      />
                    </div>
                  </div>
                </div>
                {headings.length >= 2 && (
                  <nav className="doc-toc" aria-label="文档目录">
                    <span className="doc-toc-label">目录</span>
                    <div className="doc-toc-items">
                      {headings.map((heading, headingIndex) => (
                        <button
                          key={`${headingIndex}-${heading.text}`}
                          type="button"
                          className={`doc-toc-item${heading.level === 3 ? ' is-sub' : ''}`}
                          onClick={() => scrollToHeading(heading.element)}
                        >
                          {heading.text}
                        </button>
                      ))}
                    </div>
                  </nav>
                )}
                {selected && selectedQuote && (
                  <div className="doc-selection-popover" role="region" aria-label="划词收藏">
                    <span className="doc-selection-preview" title={selectedQuote}>
                      已选中：{selectedQuote}
                    </span>
                    <div className="button-row">
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<BookBookmarkIcon />}
                        disabled={savingQuote}
                        onClick={() => void saveSelectedQuote()}
                      >
                        {savingQuote ? '收藏中…' : '+ 收藏为金句/素材卡'}
                      </Button>
                      <button
                        type="button"
                        className="search-clear-btn"
                        aria-label="关闭划词收藏提示"
                        onClick={() => setSelectedQuote('')}
                      >
                        <XIcon size={13} />
                      </button>
                    </div>
                  </div>
                )}
                <div
                  ref={reading.surfaceRef}
                  className="question-reading-surface doc-reading-body"
                  data-reading-font={reading.typography.font}
                  style={reading.surfaceStyle}
                  onMouseUp={handleReadingMouseUp}
                >
                  <MarkdownContent content={selected.content} sourceFilePath={selected.filePath} />
                </div>
              </>
            ) : (
              <EmptyState
                title="没有匹配文档"
                description="尝试切换上方的分类筛选，或缩短搜索关键词。"
              />
            )}
          </article>
        </Section>
      )}
      <KnowledgeFlashcardDialog
        open={flashcardOpen}
        title={title}
        documents={filtered}
        selectedDocument={selected}
        onClose={() => setFlashcardOpen(false)}
      />
    </div>
  )
}

export function PatternsPage(): React.JSX.Element {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [selectedId, setSelectedId] = useState('')
  const [flashcardOpen, setFlashcardOpen] = useState(false)
  useEffect(() => {
    void invoke<KnowledgeDocument[]>({
      method: 'documents.list',
      params: { kind: 'pattern' }
    }).then((items) => {
      setDocuments(items)
      setSelectedId(items[0]?.id ?? '')
    })
  }, [])
  return (
    <div className="page">
      <PageHeader
        eyebrow="知识 · 规律中心"
        title="规律中心"
        description="把跨模块可复用的错因、检查步骤和思维模式集中起来。"
        actions={
          <Button
            appearance="secondary"
            icon={<CardsIcon />}
            disabled={!documents?.length}
            onClick={() => setFlashcardOpen(true)}
          >
            闪卡自测
          </Button>
        }
      />
      {!documents ? (
        <LoadingState />
      ) : !documents.length ? (
        <EmptyState
          title="还没有规律文档"
          description="在 Markdown frontmatter 中设置 kind: pattern 后重新索引。"
        />
      ) : (
        <div className={documents.length > 1 ? 'grid two' : undefined}>
          {documents.map((document) => {
            const expanded = selectedId === document.id
            return (
              <Section
                key={document.id}
                title={document.title}
                description={document.summary}
                actions={
                  <button
                    type="button"
                    className="pill"
                    onClick={() =>
                      setSelectedId((prev) => (prev === document.id ? '' : document.id))
                    }
                  >
                    {expanded ? '收起' : '展开'}
                  </button>
                }
              >
                {expanded ? (
                  <MarkdownContent content={document.content} sourceFilePath={document.filePath} />
                ) : (
                  <div className="button-row">
                    {document.tags.map((tag) => (
                      <span className="pill" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Section>
            )
          })}
        </div>
      )}
      <KnowledgeFlashcardDialog
        open={flashcardOpen}
        title="规律中心"
        documents={documents ?? []}
        selectedDocument={documents?.find((item) => item.id === selectedId)}
        onClose={() => setFlashcardOpen(false)}
      />
    </div>
  )
}
