import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input, Select } from '@fluentui/react-components'
import { CheckCircleIcon, ExamIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { ExamSession, PaperProgressItem, Subject } from '@shared/contracts'
import { formatDate, invoke } from '../../api'
import { EmptyState, ErrorState, LoadingState, Section } from '../../components/ui'
import { useImeSearchInput } from '../../services/search-input'

/** 真题套卷刷题进度矩阵（“考公人的打勾表”） */
export function PaperProgressWall({
  hasAnyActiveExam,
  onBusyChange
}: {
  hasAnyActiveExam: boolean
  onBusyChange?: (busy: boolean) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const [items, setItems] = useState<PaperProgressItem[]>()
  const [subject, setSubject] = useState<'' | Subject>('')
  const [year, setYear] = useState('')
  const [region, setRegion] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'unseen' | 'once' | 'multi'>('all')
  const search = useImeSearchInput({ delayMs: 120 })
  const [startingPaper, setStartingPaper] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void invoke<PaperProgressItem[]>({ method: 'exam.paperMatrix', params: {} })
      .then(setItems)
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : '套卷进度加载失败')
        setItems([])
      })
  }, [])

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const item of items ?? []) if (item.year) set.add(item.year)
    return [...set].sort((a, b) => b - a)
  }, [items])

  const regions = useMemo(() => {
    const set = new Set<string>()
    for (const item of items ?? []) if (item.region) set.add(item.region)
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [items])

  const filtered = useMemo(() => {
    const query = search.committedValue.trim().toLowerCase()
    return (items ?? []).filter((item) => {
      if (subject && item.subject !== subject) return false
      if (year && String(item.year ?? '') !== year) return false
      if (region && item.region !== region) return false
      if (statusFilter === 'unseen' && (item.examCount > 0 || item.practicedQuestionCount > 0)) {
        return false
      }
      if (statusFilter === 'once' && item.examCount !== 1) return false
      if (statusFilter === 'multi' && item.examCount < 2) return false
      if (query && !item.paper.toLowerCase().includes(query)) return false
      return true
    })
  }, [items, subject, year, region, statusFilter, search.committedValue])

  const summaryStats = useMemo(() => {
    const list = items ?? []
    return {
      total: list.length,
      donePapers: list.filter((item) => item.examCount >= 1).length,
      secondPassPapers: list.filter((item) => item.examCount >= 2).length
    }
  }, [items])

  async function startPaperExam(item: PaperProgressItem): Promise<void> {
    if (item.hasActiveExam) {
      navigate('/exam/run')
      return
    }
    if (hasAnyActiveExam) {
      setError('当前已有进行中的模考，请先交卷或继续当前场次。')
      return
    }
    setStartingPaper(`${item.subject}:${item.paper}`)
    onBusyChange?.(true)
    setError('')
    try {
      await invoke<ExamSession>(
        item.subject === 'shenlun'
          ? {
              method: 'exam.createShenlunPaper',
              params: { paper: item.paper, durationMinutes: 150 }
            }
          : { method: 'exam.createPaper', params: { paper: item.paper } }
      )
      navigate('/exam/run')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发起整卷模考失败')
    } finally {
      setStartingPaper('')
      onBusyChange?.(false)
    }
  }

  return (
    <Section
      title="真题套卷进度墙"
      description={
        items
          ? `共收录 ${summaryStats.total} 套真题卷 · 已完成模考 ${summaryStats.donePapers} 套 · 二刷以上 ${summaryStats.secondPassPapers} 套`
          : '正在聚合历年真题套卷完成进度…'
      }
    >
      {error && <ErrorState message={error} />}
      <div className="toolbar">
        <Field label="搜索套卷" className="grow">
          <Input
            value={search.value}
            contentBefore={<MagnifyingGlassIcon />}
            contentAfter={
              search.value ? (
                <button
                  type="button"
                  className="search-clear-btn"
                  aria-label="清除搜索"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => search.clear()}
                >
                  <XIcon size={13} />
                </button>
              ) : undefined
            }
            placeholder="输入年份、地区或试卷关键词"
            onChange={(event, data) => search.handleChange(data.value, event.nativeEvent)}
            onCompositionStart={search.handleCompositionStart}
            onCompositionEnd={search.handleCompositionEnd}
            onKeyDown={search.handleKeyDown}
          />
        </Field>
        <Field label="科目">
          <Select value={subject} onChange={(_, d) => setSubject(d.value as '' | Subject)}>
            <option value="">全部科目</option>
            <option value="xingce">行测</option>
            <option value="shenlun">申论</option>
          </Select>
        </Field>
        <Field label="年份">
          <Select value={year} onChange={(_, d) => setYear(d.value)}>
            <option value="">全部年份</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="考区">
          <Select value={region} onChange={(_, d) => setRegion(d.value)}>
            <option value="">全部地区</option>
            {regions.map((reg) => (
              <option key={reg} value={reg}>
                {reg}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="进度状态">
          <Select
            value={statusFilter}
            onChange={(_, d) => setStatusFilter(d.value as 'all' | 'unseen' | 'once' | 'multi')}
          >
            <option value="all">全部套卷</option>
            <option value="unseen">尚未开刷</option>
            <option value="once">已一刷</option>
            <option value="multi">二刷及以上</option>
          </Select>
        </Field>
      </div>
      {!items ? (
        <LoadingState label="正在盘点套卷记录" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="当前筛选下没有匹配的真题卷"
          description="真题导入后会自动按年份与考区汇总成套卷矩阵，可点击清空筛选查看全部。"
        />
      ) : (
        <div className="paper-matrix-grid">
          {filtered.map((item) => {
            const stateLabel = item.hasActiveExam
              ? '进行中'
              : item.examCount >= 2
                ? `已 ${item.examCount} 刷`
                : item.examCount === 1
                  ? '已一刷'
                  : item.practicedQuestionCount > 0
                    ? `散刷 ${item.practicedQuestionCount}/${item.questionCount}`
                    : '未刷'
            const stateClass = item.hasActiveExam
              ? ' is-active'
              : item.examCount >= 1
                ? ' is-done'
                : item.practicedQuestionCount > 0
                  ? ' is-partial'
                  : ''
            const busyKey = `${item.subject}:${item.paper}`
            return (
              <div className={`paper-matrix-card${stateClass}`} key={busyKey}>
                <div className="paper-matrix-head">
                  <div className="question-meta">
                    <span className="pill">{item.subject === 'xingce' ? '行测' : '申论'}</span>
                    {item.year && <span className="pill">{item.year}</span>}
                    {item.region && <span className="pill">{item.region}</span>}
                    <span className="pill">{item.questionCount} 题</span>
                  </div>
                  <span className={`paper-status-badge${stateClass}`}>
                    {item.examCount >= 1 && <CheckCircleIcon size={12} weight="fill" />}
                    {stateLabel}
                  </span>
                </div>
                <strong className="paper-matrix-title" title={item.paper}>
                  {item.paper}
                </strong>
                <div className="paper-matrix-metrics">
                  {item.examCount > 0 ? (
                    <>
                      <span>
                        {item.latestScore !== undefined
                          ? `最近 ${item.latestScore} 分（最高 ${item.bestScore ?? item.latestScore} 分）`
                          : '已完成申论连作'}
                      </span>
                      <span>
                        {item.latestDurationMinutes
                          ? `耗时 ${item.latestDurationMinutes} 分钟 · `
                          : ''}
                        {item.latestFinishedAt ? formatDate(item.latestFinishedAt) : ''}
                      </span>
                    </>
                  ) : (
                    <span className="muted">
                      {item.practicedQuestionCount > 0
                        ? `专项中已刷 ${item.practicedQuestionCount} / ${item.questionCount} 题`
                        : '尚未整卷模考，适合按考场计时检验配速'}
                    </span>
                  )}
                </div>
                <div className="button-row">
                  <Button
                    size="small"
                    appearance={
                      item.hasActiveExam || item.examCount === 0 ? 'primary' : 'secondary'
                    }
                    icon={<ExamIcon />}
                    disabled={
                      startingPaper === busyKey || (!item.hasActiveExam && hasAnyActiveExam)
                    }
                    onClick={() => void startPaperExam(item)}
                  >
                    {item.hasActiveExam
                      ? '继续作答'
                      : item.examCount >= 1
                        ? '再刷一次'
                        : '整卷开考'}
                  </Button>
                  {item.latestExamId && item.examCount >= 1 && (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => navigate(`/exam/result/${item.latestExamId}`)}
                    >
                      查看复盘
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
