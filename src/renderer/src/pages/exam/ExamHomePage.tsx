import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input, Select } from '@fluentui/react-components'
import { CheckCircleIcon, ExamIcon } from '@phosphor-icons/react'
import type { ExamSession, QuestionFacets } from '@shared/contracts'
import { formatFullDate, invoke } from '../../api'
import { RegionCascadePicker } from '../../components/RegionCascadePicker'
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../../components/ui'
import { readStoredRegion, writeStoredRegion } from '../../services/study-helpers'
import { useAppStore } from '../../store'
import { pruneStaleExamUncertainKeys } from './shared'

export function ExamHomePage(): React.JSX.Element {
  const navigate = useNavigate()
  const data = useAppStore((state) => state.data)!
  const [title, setTitle] = useState('行测自定义模考')
  const subject = 'xingce' as const
  const [durationMinutes, setDurationMinutes] = useState(data.settings.defaultExamMinutes)
  const [questionCount, setQuestionCount] = useState(20)
  const [facets, setFacets] = useState<QuestionFacets>({ years: [], regions: [], papers: [] })
  const [year, setYear] = useState('')
  const [region, setRegion] = useState(() =>
    readStoredRegion('tizhou:exam-region', data.settings.defaultRegion ?? '')
  )
  const [paper, setPaper] = useState('')
  const [history, setHistory] = useState<ExamSession[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [papers, setPapers] = useState<Array<{ paper: string; count: number; year?: number }>>([])
  const [paperChoice, setPaperChoice] = useState('')

  useEffect(() => {
    void invoke<ExamSession[]>({ method: 'exam.history' })
      .then((items) => {
        setHistory(items)
        pruneStaleExamUncertainKeys(items.find((item) => item.status === 'active')?.id)
      })
      .catch(() => setHistory([]))
    void invoke<Array<{ paper: string; count: number; year?: number }>>({ method: 'exam.papers' })
      .then(setPapers)
      .catch(() => setPapers([]))
  }, [])

  useEffect(() => {
    void invoke<QuestionFacets>({
      method: 'vault.facets',
      params: { subject: 'xingce', region: region || undefined }
    })
      .then((nextFacets) => {
        setFacets(nextFacets)
        setPaper((currentPaper) =>
          currentPaper && !nextFacets.papers.includes(currentPaper) ? '' : currentPaper
        )
      })
      .catch(() => setFacets({ years: [], regions: [], papers: [] }))
  }, [region])

  async function createPaperExam(): Promise<void> {
    if (!paperChoice) return
    setBusy(true)
    setError('')
    try {
      await invoke<ExamSession>({ method: 'exam.createPaper', params: { paper: paperChoice } })
      navigate('/exam/run')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '原卷组卷失败')
    } finally {
      setBusy(false)
    }
  }

  async function createExam(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke<ExamSession>({
        method: 'exam.create',
        params: {
          title,
          subject,
          durationMinutes,
          questionCount,
          filter: {
            year: year ? Number(year) : undefined,
            region: region || undefined,
            paper: paper || undefined
          }
        }
      })
      navigate('/exam/run')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建模考失败')
    } finally {
      setBusy(false)
    }
  }

  const active = history?.find((exam) => exam.status === 'active')
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 模拟考试"
        title="模拟考试"
        description="答案会逐题落盘，关闭应用后仍可继续；交卷时基于题目快照形成完整记录。"
        actions={
          active && (
            <Button appearance="primary" onClick={() => navigate('/exam/run')}>
              继续未完成模考
            </Button>
          )
        }
      />
      <div className="grid two">
        <Section title="新建模考" description="只从当前活动知识库选题。">
          {error && <ErrorState message={error} />}
          <div className="form-grid">
            <Field className="full" label="考试名称">
              <Input value={title} onChange={(_, dataValue) => setTitle(dataValue.value)} />
            </Field>
            <Field label="科目">
              <Input value="行政职业能力测验" readOnly />
            </Field>
            <Field label="题目数量">
              <Input
                type="number"
                min={1}
                max={100}
                value={String(questionCount)}
                onChange={(_, dataValue) =>
                  setQuestionCount(Math.max(1, Math.min(100, Number(dataValue.value) || 1)))
                }
              />
            </Field>
            <Field label="限时分钟">
              <Input
                type="number"
                min={10}
                max={300}
                value={String(durationMinutes)}
                onChange={(_, dataValue) =>
                  setDurationMinutes(Math.max(10, Math.min(300, Number(dataValue.value) || 10)))
                }
              />
            </Field>
            <Field label="年份">
              <Select value={year} onChange={(_, dataValue) => setYear(dataValue.value)}>
                <option value="">全部年份</option>
                {facets.years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="地区 / 分类">
              <RegionCascadePicker
                regions={facets.regions}
                regionCounts={facets.regionCounts}
                value={region}
                papers={facets.papers}
                selectedPaper={paper}
                onChange={(nextRegion, nextPaper) => {
                  setRegion(nextRegion)
                  writeStoredRegion('tizhou:exam-region', nextRegion)
                  if (nextPaper !== undefined) setPaper(nextPaper)
                }}
              />
            </Field>
            {facets.papers.length > 0 && (
              <Field className="full" label="指定试卷">
                <Select value={paper} onChange={(_, dataValue) => setPaper(dataValue.value)}>
                  <option value="">全部试卷</option>
                  {facets.papers.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Button
            appearance="primary"
            icon={<ExamIcon />}
            className="field-gap-top"
            disabled={busy || Boolean(active)}
            onClick={() => void createExam()}
          >
            {active ? '请先完成当前模考' : '创建并开始'}
          </Button>
        </Section>
        <Section title="考试规则">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>断点续答</strong>
                <span>每次选择答案后立即保存</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
            <li className="data-row">
              <div>
                <strong>统一交卷</strong>
                <span>交卷后才进入训练统计和错题系统</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
            <li className="data-row">
              <div>
                <strong>题目快照</strong>
                <span>知识库更新不会篡改历史作答</span>
              </div>
              <CheckCircleIcon className="positive" />
            </li>
          </ul>
        </Section>
      </div>
      <Section
        title="真题原卷模考"
        description="按试卷原题号顺序整卷组卷、限时 120 分钟；题目来自当前知识库，联考共用题已去重，题量不足 30 的卷不出现在列表。"
      >
        <div className="toolbar exam-paper-toolbar">
          <Field label="选择真题卷" className="grow">
            <Select
              value={paperChoice}
              onChange={(_, dataValue) => setPaperChoice(dataValue.value)}
            >
              <option value="">选择试卷…</option>
              {papers.map((item) => (
                <option key={item.paper} value={item.paper}>
                  {item.paper}（{item.count} 题）
                </option>
              ))}
            </Select>
          </Field>
          <Button
            appearance="primary"
            icon={<ExamIcon />}
            disabled={busy || !paperChoice || Boolean(active)}
            onClick={() => void createPaperExam()}
          >
            {active ? '请先完成当前模考' : '开始整卷模考'}
          </Button>
        </div>
        {!papers.length && (
          <p className="muted exam-empty-hint">
            当前知识库没有带试卷归属信息的题目（真题库导入后自动出现）。
          </p>
        )}
      </Section>
      <Section title="历史模考">
        {!history ? (
          <LoadingState />
        ) : history.length ? (
          <table className="report-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>科目</th>
                <th>进度</th>
                <th>分数</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {history.map((exam) => (
                <tr key={exam.id}>
                  <td>{exam.title}</td>
                  <td>{exam.subject === 'xingce' ? '行测' : '申论'}</td>
                  <td>
                    {exam.status === 'active'
                      ? `已答 ${Object.values(exam.answers).filter((a) => a.answer.some((v) => v.trim())).length}/${exam.questionIds.length}`
                      : '已交卷'}
                  </td>
                  <td>{exam.score === undefined ? '暂未评分' : `${exam.score} 分`}</td>
                  <td>{formatFullDate(exam.updatedAt)}</td>
                  <td>
                    <Button
                      size="small"
                      appearance="secondary"
                      onClick={() =>
                        navigate(
                          exam.status === 'finished' ? `/exam/result/${exam.id}` : '/exam/run'
                        )
                      }
                    >
                      {exam.status === 'finished' ? '查看复盘' : '继续作答'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="暂无模考记录"
            description="创建第一场自定义模考后，成绩和作答进度会显示在这里。"
          />
        )}
      </Section>
    </div>
  )
}
