import { Button } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BookBookmarkIcon,
  ClockIcon,
  PencilSimpleIcon
} from '@phosphor-icons/react'
import type { Question, QuestionSummary } from '@shared/contracts'
import {
  classifyShenlunType,
  type inspectShenlunMaterialQuality,
  type ShenlunQuestionType
} from '@shared/shenlun'
import {
  ReadingTypographyBar,
  type useReadingTypography
} from '../../components/ReadingTypographyControl'
import { formatMaterialSource } from '../../services/study-helpers'

interface ShenlunNavBarProps {
  current?: Question
  currentSummary?: QuestionSummary
  currentQuality: ReturnType<typeof inspectShenlunMaterialQuality> | null
  currentStatus?: { count: number; latestScore: number; latestAt: string }
  activeQuestionType: ShenlunQuestionType
  elapsedSeconds: number
  showTimer: boolean
  reading: ReturnType<typeof useReadingTypography>
  officialTypography: boolean
  onlyUnattempted: boolean
  evaluating: boolean
  hasPrev: boolean
  hasNext: boolean
  currentIndex: number
  totalVisible: number
  zenMode: boolean
  canEdit: boolean
  snippetOpen?: boolean
  onToggleTimer: () => void
  onToggleOfficialTypography: () => void
  onToggleOnlyUnattempted: () => void
  onToggleZenMode: () => void
  onToggleSnippets?: () => void
  onOpenEdit: () => void
  onGoAdjacent: (delta: -1 | 1) => void
}

export function ShenlunNavBar({
  current,
  currentSummary,
  currentQuality,
  currentStatus,
  activeQuestionType,
  elapsedSeconds,
  showTimer,
  reading,
  officialTypography,
  onlyUnattempted,
  evaluating,
  hasPrev,
  hasNext,
  currentIndex,
  totalVisible,
  zenMode,
  canEdit,
  snippetOpen = false,
  onToggleTimer,
  onToggleOfficialTypography,
  onToggleOnlyUnattempted,
  onToggleZenMode,
  onToggleSnippets,
  onOpenEdit,
  onGoAdjacent
}: ShenlunNavBarProps): React.JSX.Element {
  const summaryOrDetail = current ?? currentSummary
  const kind = summaryOrDetail
    ? classifyShenlunType(summaryOrDetail.category, current?.stem ?? currentSummary?.stemPreview)
    : null
  const paperName = (current?.paper ?? currentSummary?.paper ?? '').trim()
  const rawSource = current?.source ?? currentSummary?.source ?? ''
  const sourceLabel = formatMaterialSource(rawSource)
  const showSource = Boolean(
    sourceLabel && sourceLabel !== paperName && !paperName.includes(sourceLabel)
  )
  const overtimeThreshold = activeQuestionType === '作文题' ? 3600 : 1200
  const timerText = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`

  return (
    <div className="solution-nav-bar">
      <div className="question-meta">
        {(current?.region ?? currentSummary?.region) && (
          <span className="pill">{current?.region ?? currentSummary?.region}</span>
        )}
        {summaryOrDetail && kind && (
          <>
            <span className="pill">{kind}</span>
            {(current?.year ?? currentSummary?.year) && (
              <span className="pill">{current?.year ?? currentSummary?.year}</span>
            )}
            {paperName && <span className="pill">{paperName}</span>}
            {showSource && (
              <span className="pill" title={rawSource}>
                教材来源：{sourceLabel}
              </span>
            )}
            {summaryOrDetail.category && summaryOrDetail.category !== kind && (
              <span className="pill">{summaryOrDetail.category}</span>
            )}
          </>
        )}
        {summaryOrDetail && <span className="pill">难度 {summaryOrDetail.difficulty}</span>}
        {currentQuality?.level === 'verified' && <span className="pill is-verified">完整精校</span>}
        {currentQuality?.level === 'incomplete' && (
          <span
            className="pill is-warning"
            title={
              currentQuality.issues.length > 0
                ? `检测到：${currentQuality.issues.join('、')}`
                : '材料存在提取残缺'
            }
          >
            材料有残缺
          </span>
        )}
        {currentStatus && (
          <span className="pill is-evaluated">
            已评 {currentStatus.count} 次 · 最新 {currentStatus.latestScore} 分
          </span>
        )}
      </div>
      <div className="solution-nav-actions">
        <button
          type="button"
          className={`practice-timer${showTimer && elapsedSeconds >= overtimeThreshold ? ' is-overtime' : ''}`}
          title={
            showTimer
              ? `单题建议用时 ${activeQuestionType === '作文题' ? '60' : '20'} 分钟（点击隐藏计时）`
              : '点击显示单题计时'
          }
          onClick={onToggleTimer}
        >
          <ClockIcon size={12} />
          {showTimer ? timerText : '计时已隐藏'}
        </button>
        <ReadingTypographyBar
          contextLabel="申论阅读"
          typography={reading.typography}
          onUpdate={reading.update}
          onStepScale={reading.stepScale}
          onResetScale={reading.resetScale}
        />
        <Button
          size="small"
          appearance={officialTypography ? 'primary' : 'outline'}
          aria-pressed={officialTypography}
          title="按党政机关公文排版习惯（仿宋正文、黑体/楷体标题、首行缩进）呈现材料与作答"
          onClick={onToggleOfficialTypography}
        >
          公文体
        </Button>
        <Button
          size="small"
          appearance={onlyUnattempted ? 'primary' : 'outline'}
          disabled={evaluating}
          onClick={onToggleOnlyUnattempted}
        >
          {onlyUnattempted ? '显示全部题目' : '只看未做'}
        </Button>
        {onToggleSnippets && (
          <Button
            size="small"
            appearance={snippetOpen ? 'primary' : 'outline'}
            icon={<BookBookmarkIcon />}
            title="打开申论规范词与个人金句素材抽屉"
            onClick={onToggleSnippets}
          >
            规范词/金句
          </Button>
        )}
        <Button
          size="small"
          appearance="subtle"
          icon={<PencilSimpleIcon />}
          disabled={evaluating || !canEdit}
          title={
            canEdit
              ? '就地勘误材料/作答要求/参考解析'
              : '内置示例题库为只读，连接本地 Markdown 知识库后可勘误'
          }
          onClick={onOpenEdit}
        >
          勘误
        </Button>
        <Button
          size="small"
          appearance={zenMode ? 'secondary' : 'outline'}
          icon={zenMode ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
          title="切换沉浸专注视野（折叠侧栏 · Alt+Z）"
          onClick={onToggleZenMode}
        >
          {zenMode ? '退出专注' : '专注'}
        </Button>
        <div className="solution-pager">
          <Button
            size="small"
            icon={<ArrowLeftIcon />}
            disabled={evaluating || !hasPrev}
            onClick={() => onGoAdjacent(-1)}
          >
            上一题
          </Button>
          {totalVisible > 0 && currentIndex >= 0 && (
            <span className="solution-pager-count">
              {currentIndex + 1} / {totalVisible}
            </span>
          )}
          <Button
            size="small"
            icon={<ArrowRightIcon />}
            iconPosition="after"
            disabled={evaluating || !hasNext}
            onClick={() => onGoAdjacent(1)}
          >
            下一题
          </Button>
        </div>
      </div>
    </div>
  )
}
