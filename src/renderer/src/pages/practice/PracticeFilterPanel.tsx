import { useState } from 'react'
import { Button, Checkbox, Field, Input, Select } from '@fluentui/react-components'
import { LightningIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { PracticeSelection, QuestionFacets, Subject } from '@shared/contracts'
import { RegionCascadePicker } from '../../components/RegionCascadePicker'
import { SpeedCalcWarmupDialog } from '../../components/SpeedCalcWarmupDialog'
import { ErrorState, Section } from '../../components/ui'
import type { Category } from './constants'

interface PracticeFilterPanelProps {
  error: string
  mode: PracticeSelection['mode']
  onModeChange: (mode: PracticeSelection['mode']) => void
  subject: '' | Subject
  onSubjectChange: (subject: '' | Subject) => void
  category: string
  onCategoryChange: (category: string) => void
  categories: Category[]
  categoriesLoaded?: boolean
  difficulty: string
  onDifficultyChange: (difficulty: string) => void
  feedbackMode: 'immediate' | 'summary'
  onFeedbackModeChange: (feedbackMode: 'immediate' | 'summary') => void
  keyword: string
  onKeywordChange: (keyword: string) => void
  year: string
  onYearChange: (year: string) => void
  facets: QuestionFacets
  region: string
  paper: string
  onRegionOrPaperChange: (nextRegion: string, nextPaper?: string) => void
  onPaperChange: (paper: string) => void
  count: number
  onCountChange: (count: number) => void
  onlyUnattempted: boolean
  onOnlyUnattemptedChange: (checked: boolean) => void
  onlyWrong: boolean
  onOnlyWrongChange: (checked: boolean) => void
  onlyFavorite: boolean
  onOnlyFavoriteChange: (checked: boolean) => void
  onStart: () => void
}

export function PracticeFilterPanel({
  error,
  mode,
  onModeChange,
  subject,
  onSubjectChange,
  category,
  onCategoryChange,
  categories,
  categoriesLoaded = false,
  difficulty,
  onDifficultyChange,
  feedbackMode,
  onFeedbackModeChange,
  keyword,
  onKeywordChange,
  year,
  onYearChange,
  facets,
  region,
  paper,
  onRegionOrPaperChange,
  onPaperChange,
  count,
  onCountChange,
  onlyUnattempted,
  onOnlyUnattemptedChange,
  onlyWrong,
  onOnlyWrongChange,
  onlyFavorite,
  onOnlyFavoriteChange,
  onStart
}: PracticeFilterPanelProps): React.JSX.Element {
  const [warmupOpen, setWarmupOpen] = useState(false)
  const isDataAnalysis = category === '资料分析' || category.startsWith('资料分析')
  const lockStep5 =
    isDataAnalysis &&
    !onlyWrong &&
    !onlyFavorite &&
    !onlyUnattempted &&
    !difficulty &&
    !keyword.trim()
  const totalAvailable = categories.reduce((sum, item) => sum + item.count, 0)
  return (
    <>
      <Section
        title="训练配置"
        description="题目来自当前活动知识库，训练会话定期落盘并保留内容快照。"
        actions={
          <Button
            size="small"
            appearance="subtle"
            icon={<LightningIcon />}
            onClick={() => setWarmupOpen(true)}
          >
            2 分钟速算热身
          </Button>
        }
      >
        {error && <ErrorState message={error} />}
        <div className="form-grid">
          <Field label="选题策略">
            <Select
              value={mode}
              onChange={(_, data) => onModeChange(data.value as PracticeSelection['mode'])}
            >
              <option value="adaptive">自适应优先</option>
              <option value="random">随机抽题</option>
              <option value="sequence">顺序训练</option>
            </Select>
          </Field>
          <Field label="科目">
            <Select
              value={subject}
              onChange={(_, data) => onSubjectChange(data.value as '' | Subject)}
            >
              <option value="xingce">行测</option>
              <option value="shenlun">申论</option>
              <option value="">全部科目</option>
            </Select>
          </Field>
          <Field label="专项模块">
            <Select value={category} onChange={(_, data) => onCategoryChange(data.value)}>
              <option value="">
                {categoriesLoaded ? `全部模块（${totalAvailable}）` : '全部模块'}
              </option>
              {categories.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}（{item.count}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="难度">
            <Select value={difficulty} onChange={(_, data) => onDifficultyChange(data.value)}>
              <option value="">全部难度</option>
              <option value="1">1 · 很容易</option>
              <option value="2">2 · 较容易</option>
              <option value="3">3 · 中等</option>
              <option value="4">4 · 较难</option>
              <option value="5">5 · 很难</option>
            </Select>
          </Field>
          <Field label="解析方式">
            <Select
              value={feedbackMode}
              onChange={(_, data) => onFeedbackModeChange(data.value as 'immediate' | 'summary')}
            >
              <option value="immediate">每题立即解析</option>
              <option value="summary">整组汇总解析</option>
            </Select>
          </Field>
          <Field label="关键词" className="grow">
            <Input
              value={keyword}
              contentBefore={<MagnifyingGlassIcon />}
              contentAfter={
                keyword ? (
                  <button
                    type="button"
                    className="search-clear-btn"
                    aria-label="清除搜索关键词"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onKeywordChange('')}
                  >
                    <XIcon size={13} />
                  </button>
                ) : undefined
              }
              onChange={(_, data) => onKeywordChange(data.value)}
              placeholder="按题干、材料、解析、标签或卷名搜索（空格分隔多词）"
            />
          </Field>
          <Field label="年份">
            <Select value={year} onChange={(_, data) => onYearChange(data.value)}>
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
              onChange={onRegionOrPaperChange}
            />
          </Field>
          {facets.papers.length > 0 && (
            <Field className="full" label="试卷">
              <Select value={paper} onChange={(_, data) => onPaperChange(data.value)}>
                <option value="">全部试卷</option>
                {facets.papers.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="本组题数"
            hint={lockStep5 ? '资料分析锁定按整套材料 5 题连续出题，不打乱题序' : undefined}
          >
            <Input
              type="number"
              min={lockStep5 ? 5 : 1}
              max={100}
              step={lockStep5 ? 5 : 1}
              value={String(count)}
              onChange={(_, data) =>
                onCountChange(Math.max(1, Math.min(100, Number(data.value) || 1)))
              }
              onBlur={() => {
                if (lockStep5) {
                  onCountChange(Math.max(5, Math.min(100, Math.round(count / 5) * 5)))
                }
              }}
            />
          </Field>
          <div className="filter-toggles">
            <Checkbox
              label="只练未做"
              checked={onlyUnattempted}
              onChange={(_, data) => onOnlyUnattemptedChange(Boolean(data.checked))}
            />
            <Checkbox
              label="只练错题"
              checked={onlyWrong}
              onChange={(_, data) => onOnlyWrongChange(Boolean(data.checked))}
            />
            <Checkbox
              label="只练收藏"
              checked={onlyFavorite}
              onChange={(_, data) => onOnlyFavoriteChange(Boolean(data.checked))}
            />
          </div>
          <div className="button-row full">
            <Button appearance="primary" onClick={onStart}>
              生成训练
            </Button>
          </div>
        </div>
      </Section>
      <SpeedCalcWarmupDialog open={warmupOpen} onClose={() => setWarmupOpen(false)} />
    </>
  )
}
