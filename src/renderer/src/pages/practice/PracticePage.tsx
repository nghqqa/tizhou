import { useSearchParams } from 'react-router-dom'
import type { PracticeSelection } from '@shared/contracts'
import { PageHeader } from '../../components/ui'
import type { TrainerInitial } from './constants'
import { Trainer } from './Trainer'

export function PracticePage(): React.JSX.Element {
  const [searchParams] = useSearchParams()
  const recommended = searchParams.get('recommended')
  const mode = searchParams.get('mode') as PracticeSelection['mode'] | null
  const count = Number(searchParams.get('count')) || undefined
  const category = searchParams.get('category') ?? undefined
  const onlyWrong = searchParams.get('onlyWrong') === '1'
  const onlyFavorite = searchParams.get('onlyFavorite') === '1'
  const onlyUnattempted = searchParams.get('onlyUnattempted') === '1'
  const questionId = searchParams.get('questionId') ?? undefined
  const resumeActive = searchParams.get('resumeActive') === '1'
  const subjectParam = searchParams.get('subject')
  const subject =
    subjectParam === 'xingce' || subjectParam === 'shenlun' || subjectParam === 'common'
      ? subjectParam === 'common'
        ? ''
        : subjectParam
      : undefined
  const initial: TrainerInitial | undefined =
    mode ||
    count ||
    category ||
    onlyWrong ||
    onlyFavorite ||
    onlyUnattempted ||
    questionId ||
    resumeActive ||
    subject !== undefined
      ? {
          mode: mode ?? undefined,
          count,
          category,
          onlyWrong,
          onlyFavorite,
          onlyUnattempted,
          questionId,
          resumeActive,
          feedbackMode: 'immediate',
          subject: subject ?? (onlyWrong || onlyFavorite ? '' : 'xingce')
        }
      : undefined
  return (
    <div className="page">
      <PageHeader
        eyebrow="训练 · 专项练习"
        title="专项练习"
        description="支持会话恢复、内容快照、分栏材料对照、速查卡、键盘选项和自适应选题。"
      />
      {recommended && (
        <div className="answer-panel" style={{ marginBottom: 14 }}>
          <p className="positive" style={{ margin: 0 }}>
            ✓ 已根据你的薄弱模块生成训练建议：{recommended}
            {count ? ` · ${count} 题` : ''}。你可以直接开始，也可以调整下方配置。
          </p>
        </div>
      )}
      <Trainer key={questionId ?? (resumeActive ? 'resume' : 'default')} initial={initial} />
    </div>
  )
}
