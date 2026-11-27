import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Checkbox, Field, Input, Select, Textarea } from '@fluentui/react-components'
import {
  BookmarkSimpleIcon,
  ExportIcon,
  FilePdfIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  PrinterIcon,
  RobotIcon,
  XIcon
} from '@phosphor-icons/react'
import type { Question, QuestionLibraryItem } from '@shared/contracts'
import { WRONG_CAUSE_OPTIONS } from '@shared/study-constants'
import { formatDate, invoke } from '../../api'
import { MarkdownContent } from '../../components/MarkdownContent'
import { OptionContent } from '../../components/OptionContent'
import { QuestionEditDialog } from '../../components/QuestionEditDialog'
import { EmptyState, ErrorState, LoadingState, Section } from '../../components/ui'
import { useImeSearchInput } from '../../services/search-input'
import { useAppStore } from '../../store'
import type { Category } from './constants'

export function QuestionLibraryView({
  tab
}: {
  tab: 'wrong' | 'favorite' | 'notes'
}): React.JSX.Element {
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const refreshVault = useAppStore((state) => state.refreshVault)
  const vault = useAppStore((state) => state.data?.vault)
  const [items, setItems] = useState<QuestionLibraryItem[]>()
  const [categories, setCategories] = useState<Category[]>([])
  const [category, setCategory] = useState('')
  const [wrongCause, setWrongCause] = useState('')
  const [stubbornOnly, setStubbornOnly] = useState(false)
  const search = useImeSearchInput({ delayMs: 200 })
  const activeQuery = search.debouncedValue.trim()
  const [expandedId, setExpandedId] = useState('')
  const [fullStemIds, setFullStemIds] = useState<Record<string, boolean>>({})
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [savingNoteId, setSavingNoteId] = useState('')
  const [exportIncludeAnswers, setExportIncludeAnswers] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void invoke<Category[]>({ method: 'vault.categories', params: {} })
      .then(setCategories)
      .catch(() => setCategories([]))
  }, [])

  useEffect(() => {
    setPage(1)
  }, [tab, category, wrongCause, stubbornOnly, activeQuery])

  useEffect(() => {
    let cancelled = false
    setError('')
    void invoke<QuestionLibraryItem[]>({
      method: 'questions.library',
      params: {
        tab,
        category: category || undefined,
        wrongCause: tab === 'wrong' && wrongCause ? wrongCause : undefined,
        query: activeQuery || undefined,
        minWrongCount: tab === 'wrong' && stubbornOnly ? 2 : undefined,
        limit: 200
      }
    })
      .then((rows) => {
        if (cancelled) return
        setItems(rows)
        setNoteDrafts((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (!(row.question.id in next)) next[row.question.id] = row.note
          }
          return next
        })
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '题单读取失败')
      })
    return () => {
      cancelled = true
    }
  }, [tab, category, wrongCause, stubbornOnly, activeQuery])

  async function toggleFavoriteItem(item: QuestionLibraryItem): Promise<void> {
    const nextFav = !item.favorite
    try {
      await invoke({
        method: 'favorite.set',
        params: { questionId: item.question.id, favorite: nextFav }
      })
      setItems((prev) => {
        if (!prev) return prev
        if (tab === 'favorite' && !nextFav) {
          return prev.filter((row) => row.question.id !== item.question.id)
        }
        return prev.map((row) =>
          row.question.id === item.question.id ? { ...row, favorite: nextFav } : row
        )
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '收藏更新失败')
    }
  }

  async function saveLibraryNote(questionId: string): Promise<void> {
    const content = noteDrafts[questionId] ?? ''
    setSavingNoteId(questionId)
    setError('')
    try {
      await invoke({ method: 'note.save', params: { questionId, content } })
      setItems((prev) => {
        if (!prev) return prev
        if (tab === 'notes' && !content.trim()) {
          return prev.filter((row) => row.question.id !== questionId)
        }
        return prev.map((row) => (row.question.id === questionId ? { ...row, note: content } : row))
      })
      showToast('笔记已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '笔记保存失败')
    } finally {
      setSavingNoteId('')
    }
  }

  const emptyTitle =
    tab === 'wrong'
      ? '当前筛选下没有未掌握错题'
      : tab === 'favorite'
        ? '当前筛选下没有收藏题目'
        : '还没有保存过题目笔记'
  const emptyDescription =
    tab === 'wrong'
      ? '在专项练习或模考中答错的题目会自动收入错题本，连续稳定答对后移出。'
      : tab === 'favorite'
        ? '练习时点击「收藏」即可把好题、高频易错题收进收藏夹。'
        : '在专项练习右侧「本题笔记」记录做题心得后，会集中汇总在这里方便考前速览。'

  async function exportLibrary(
    format: 'markdown' | 'html' | 'pdf',
    pdfLayout?: 'exam' | 'annotated'
  ): Promise<void> {
    if (!items?.length || exporting) return
    setExporting(true)
    setError('')
    try {
      const target = await invoke<string | undefined>({
        method: 'questions.library.export',
        params: {
          tab,
          category: category || undefined,
          wrongCause: tab === 'wrong' && wrongCause ? wrongCause : undefined,
          query: activeQuery || undefined,
          minWrongCount: tab === 'wrong' && stubbornOnly ? 2 : undefined,
          includeAnswers: exportIncludeAnswers,
          includeNotes: true,
          format,
          pdfLayout
        }
      })
      if (target) showToast(`已导出：${target}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Section
      title={tab === 'wrong' ? '错题本' : tab === 'favorite' ? '我的收藏' : '我的笔记'}
      description={
        items
          ? `共找到 ${items.length} 道题目${items.length >= 200 ? '（仅展示前 200 条，可叠加筛选缩小范围）' : ''}`
          : '正在读取…'
      }
      actions={
        items && items.length > 0 ? (
          <div className="button-row library-export-bar">
            <Checkbox
              label="导出含答案"
              checked={exportIncludeAnswers}
              onChange={(_, data) => setExportIncludeAnswers(Boolean(data.checked))}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<ExportIcon />}
              disabled={exporting}
              onClick={() => void exportLibrary('markdown')}
            >
              导出 MD
            </Button>
            <Button
              size="small"
              appearance="subtle"
              icon={<PrinterIcon />}
              disabled={exporting}
              onClick={() => void exportLibrary('html')}
            >
              打印版 HTML
            </Button>
            <Button
              size="small"
              appearance="subtle"
              icon={<FilePdfIcon />}
              disabled={exporting}
              title={
                exportIncludeAnswers
                  ? '导出为 A4 试卷排版 PDF（文末附答案解析速查表）'
                  : '导出为 A4 无答案纯题 PDF（适合打印二刷）'
              }
              onClick={() => void exportLibrary('pdf', 'exam')}
            >
              A4 试卷 PDF
            </Button>
            {exportIncludeAnswers && (
              <Button
                size="small"
                appearance="subtle"
                icon={<FilePdfIcon />}
                disabled={exporting}
                title="每题紧跟参考答案、解析与个人笔记的 A4 PDF"
                onClick={() => void exportLibrary('pdf', 'annotated')}
              >
                A4 题解 PDF
              </Button>
            )}
            {tab !== 'notes' && (
              <Button
                appearance="primary"
                size="small"
                onClick={() => {
                  const params = new URLSearchParams()
                  params.set(tab === 'wrong' ? 'onlyWrong' : 'onlyFavorite', '1')
                  if (category) params.set('category', category)
                  navigate(`/practice?${params.toString()}`)
                }}
              >
                {tab === 'wrong' ? '针对当前筛选练错题' : '针对当前筛选练收藏'}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="toolbar">
        <Field label="关键词" className="grow">
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
            placeholder="按题干、材料、解析、标签、卷名或笔记搜索（空格分隔多词）"
          />
        </Field>
        <Field label="专项模块">
          <Select value={category} onChange={(_, data) => setCategory(data.value)}>
            <option value="">全部模块</option>
            {categories.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}（{item.count}）
              </option>
            ))}
          </Select>
        </Field>
        {tab === 'wrong' && (
          <>
            <Field label="错因筛选">
              <Select value={wrongCause} onChange={(_, data) => setWrongCause(data.value)}>
                <option value="">全部错因</option>
                {WRONG_CAUSE_OPTIONS.map((cause) => (
                  <option key={cause} value={cause}>
                    {cause}
                  </option>
                ))}
                <option value="未标注">未标注</option>
              </Select>
            </Field>
            <Checkbox
              label="仅看顽固错题（错≥2次）"
              checked={stubbornOnly}
              onChange={(_, data) => setStubbornOnly(Boolean(data.checked))}
            />
          </>
        )}
      </div>
      {error && <ErrorState message={error} />}
      {!items ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        (() => {
          const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
          const safePage = Math.min(page, totalPages)
          const pageItems = items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
          return (
            <>
              <div className="library-list">
                {pageItems.map((item) => {
                  const q = item.question
                  const expanded = expandedId === q.id
                  const stemExpanded = expanded || Boolean(fullStemIds[q.id])
                  const isLongStem = q.stem.replace(/\s+/g, '').length > 110
                  const noteValue = noteDrafts[q.id] ?? item.note
                  return (
                    <div key={q.id} className="library-card">
                      <div className="library-card-head">
                        <div className="question-meta">
                          <span className="pill">{q.category}</span>
                          <span className="pill">难度 {q.difficulty}</span>
                          {item.wrongCount > 0 && (
                            <span
                              className={`pill ${item.wrongCount >= 2 ? 'negative' : 'warning'}`}
                            >
                              {item.wrongCount >= 2
                                ? `顽固 ×${item.wrongCount}`
                                : `错 ${item.wrongCount} 次`}
                            </span>
                          )}
                          {item.lastWrongCause && (
                            <span className="pill">{item.lastWrongCause}</span>
                          )}
                          {item.dueAt && (
                            <span className="pill">复习 {formatDate(item.dueAt)}</span>
                          )}
                          {q.year && <span className="pill">{q.year}</span>}
                        </div>
                        <div className="button-row">
                          {!vault?.isBuiltin && q.filePath && (
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<PencilSimpleIcon />}
                              onClick={() => setEditingQuestion(q)}
                            >
                              勘误
                            </Button>
                          )}
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<RobotIcon />}
                            onClick={() => navigate(`/ai?questionId=${encodeURIComponent(q.id)}`)}
                          >
                            AI 追问
                          </Button>
                          <Button
                            size="small"
                            appearance={item.favorite ? 'secondary' : 'subtle'}
                            icon={
                              <BookmarkSimpleIcon weight={item.favorite ? 'fill' : undefined} />
                            }
                            onClick={() => void toggleFavoriteItem(item)}
                          >
                            {item.favorite ? '已收藏' : '收藏'}
                          </Button>
                          <Button
                            size="small"
                            appearance="subtle"
                            onClick={() => setExpandedId(expanded ? '' : q.id)}
                          >
                            {expanded ? '收起解析' : '展开解析与笔记'}
                          </Button>
                        </div>
                      </div>
                      <div className={`library-stem${stemExpanded ? '' : ' is-clamped'}`}>
                        <MarkdownContent content={q.stem} sourceFilePath={q.filePath} />
                      </div>
                      {isLongStem && !expanded && (
                        <button
                          type="button"
                          className="library-stem-toggle"
                          onClick={() =>
                            setFullStemIds((prev) => ({ ...prev, [q.id]: !prev[q.id] }))
                          }
                        >
                          {stemExpanded ? '收起题干' : '展开全文'}
                        </button>
                      )}
                      {item.note && !expanded && (
                        <p className="library-note-preview">笔记：{item.note}</p>
                      )}
                      {expanded && (
                        <div className="answer-panel">
                          {q.material && (
                            <div className="library-material-block">
                              <strong>给定材料</strong>
                              <MarkdownContent content={q.material} sourceFilePath={q.filePath} />
                            </div>
                          )}
                          {q.options.length > 0 && (
                            <div className="review-options">
                              {q.options.map((option) => {
                                const isAnswer = q.answer.includes(option.key)
                                return (
                                  <div
                                    key={option.key}
                                    className={`review-option ${isAnswer ? 'correct' : ''}`.trim()}
                                  >
                                    <span className="option-key">{option.key}</span>
                                    <OptionContent option={option} sourceFilePath={q.filePath} />
                                    <span className="muted">{isAnswer ? '参考答案' : ''}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <p>
                            <strong>参考答案：</strong>
                            {q.answer.length ? q.answer.join('、') : '见下方参考解析'}
                          </p>
                          <MarkdownContent content={q.explanation} sourceFilePath={q.filePath} />
                          <div className="library-note-box">
                            <Field label="本题笔记">
                              <Textarea
                                rows={3}
                                value={noteValue}
                                onChange={(_, data) =>
                                  setNoteDrafts((prev) => ({ ...prev, [q.id]: data.value }))
                                }
                                placeholder="记录解题套路、陷阱或复盘结论"
                              />
                            </Field>
                            <Button
                              size="small"
                              appearance="secondary"
                              icon={<NotePencilIcon />}
                              disabled={savingNoteId === q.id}
                              className="field-gap-top-sm"
                              onClick={() => void saveLibraryNote(q.id)}
                            >
                              {savingNoteId === q.id ? '保存中…' : '保存笔记'}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {items.length > PAGE_SIZE && (
                <div className="list-pagination">
                  <Button
                    size="small"
                    appearance="subtle"
                    disabled={safePage <= 1}
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                  >
                    上一页
                  </Button>
                  <span className="muted">
                    第 {safePage} / {totalPages} 页（共 {items.length} 题）
                  </span>
                  <Button
                    size="small"
                    appearance="subtle"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )
        })()
      )}
      <QuestionEditDialog
        question={editingQuestion}
        open={Boolean(editingQuestion)}
        onClose={() => setEditingQuestion(null)}
        onSaved={(updated) => {
          setItems((prev) =>
            prev?.map((row) =>
              row.question.id === updated.id ? { ...row, question: updated } : row
            )
          )
          void refreshVault()
          showToast('勘误已保存并重新索引')
        }}
      />
    </Section>
  )
}
