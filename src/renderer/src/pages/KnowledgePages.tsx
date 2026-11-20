import { useEffect, useMemo, useRef, useState } from 'react'
import { Field, Input } from '@fluentui/react-components'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { KnowledgeDocument, Subject } from '@shared/contracts'
import { invoke } from '../api'
import { MarkdownContent } from '../components/MarkdownContent'
import { ReadingTypographyBar, useReadingTypography } from '../components/ReadingTypographyControl'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/ui'
import { extractSearchSnippet } from '../services/study-helpers'

interface KnowledgePageProps {
  subject: Subject
  kind: 'knowledge' | 'method'
}

export function KnowledgePage({ subject, kind }: KnowledgePageProps): React.JSX.Element {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedDocId = searchParams.get('docId') ?? ''
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [selectedId, setSelectedId] = useState(requestedDocId)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const reading = useReadingTypography()
  useEffect(() => {
    if (requestedDocId) setSelectedId(requestedDocId)
  }, [requestedDocId])
  useEffect(() => {
    setDocuments(undefined)
    setError('')
    void invoke<KnowledgeDocument[]>({ method: 'documents.list', params: { subject, kind } })
      .then((items) => {
        setDocuments(items)
        setSelectedId((prev) =>
          prev && items.some((item) => item.id === prev) ? prev : (items[0]?.id ?? '')
        )
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '文档读取失败'))
  }, [subject, kind])
  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!documents) return []
    if (!trimmed) return documents
    return documents.filter((document) =>
      `${document.title}\n${document.summary}\n${document.tags.join(' ')}\n${document.content}`
        .toLowerCase()
        .includes(trimmed)
    )
  }, [documents, query])
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0]
  const contentRef = useRef<HTMLElement>(null)
  const [headings, setHeadings] = useState<
    Array<{ level: 2 | 3; text: string; element: HTMLElement }>
  >([])
  useEffect(() => {
    // 切换文档后内容区回到顶部，避免停留在上一篇的滚动位置
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
  }, [selected?.id, selected?.content])

  function scrollToHeading(element: HTMLElement): void {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const title = `${subject === 'xingce' ? '行测' : '申论'}${kind === 'knowledge' ? '知识' : '方法'}中心`
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
            <Field label="搜索文档（含正文）">
              <Input
                value={query}
                contentBefore={<MagnifyingGlassIcon />}
                onChange={(_, data) => setQuery(data.value)}
                placeholder="标题、摘要、标签或正文关键词"
              />
            </Field>
            <div style={{ marginTop: 12 }}>
              {filtered.map((document) => {
                const snippet = query.trim() ? extractSearchSnippet(document.content, query) : null
                return (
                  <button
                    type="button"
                    className={`document-item ${selected?.id === document.id ? 'active' : ''}`}
                    key={document.id}
                    onClick={() => setSelectedId(document.id)}
                  >
                    <strong>{document.title}</strong>
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
                  <ReadingTypographyBar
                    typography={reading.typography}
                    onUpdate={reading.update}
                    onStepScale={reading.stepScale}
                    onResetScale={reading.resetScale}
                  />
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
                <div
                  ref={reading.surfaceRef}
                  className="question-reading-surface doc-reading-body"
                  data-reading-font={reading.typography.font}
                  style={reading.surfaceStyle}
                >
                  <MarkdownContent content={selected.content} sourceFilePath={selected.filePath} />
                </div>
              </>
            ) : (
              <EmptyState title="没有匹配文档" description="尝试缩短搜索词。" />
            )}
          </article>
        </Section>
      )}
    </div>
  )
}

export function PatternsPage(): React.JSX.Element {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [selectedId, setSelectedId] = useState('')
  useEffect(() => {
    void invoke<KnowledgeDocument[]>({
      method: 'documents.list',
      params: { kind: 'pattern' }
    }).then((items) => {
      setDocuments(items)
      setSelectedId(items[0]?.id ?? '')
    })
  }, [])
  const selected = documents?.find((item) => item.id === selectedId)
  return (
    <div className="page">
      <PageHeader
        eyebrow="知识 · 规律中心"
        title="规律中心"
        description="把跨模块可复用的错因、检查步骤和思维模式集中起来。"
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
          {documents.map((document) => (
            <Section
              key={document.id}
              title={document.title}
              description={document.summary}
              actions={
                <button type="button" className="pill" onClick={() => setSelectedId(document.id)}>
                  展开
                </button>
              }
            >
              {selectedId === document.id ? (
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
          ))}
        </div>
      )}
      {selected && documents && documents.length > 4 && (
        <Section title={selected.title}>
          <MarkdownContent content={selected.content} sourceFilePath={selected.filePath} />
        </Section>
      )}
    </div>
  )
}
