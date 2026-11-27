import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tab, TabList } from '@fluentui/react-components'
import type { ReviewItem } from '@shared/contracts'
import { invoke } from '../../api'
import { PageHeader } from '../../components/ui'
import { QuestionLibraryView } from './QuestionLibraryView'
import { Trainer } from './Trainer'

export function ReviewPage(): React.JSX.Element {
  const [due, setDue] = useState<ReviewItem[]>()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const tab: 'due' | 'wrong' | 'favorite' | 'notes' =
    rawTab === 'wrong' || rawTab === 'favorite' || rawTab === 'notes' ? rawTab : 'due'
  useEffect(() => {
    void invoke<ReviewItem[]>({ method: 'review.due', params: { limit: 500 } }).then(setDue)
  }, [])
  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="训练 · 错题复习"
        title="错题复习"
        description={
          due
            ? `${due.length} 道题已到期。支持今日间隔复习，以及按错题本、收藏夹与笔记库全景检索复盘。`
            : '正在读取复习队列。'
        }
      />
      <TabList
        className="review-tabs"
        selectedValue={tab}
        onTabSelect={(_, data) => {
          const next = String(data.value)
          if (next === 'due') setSearchParams({}, { replace: true })
          else setSearchParams({ tab: next }, { replace: true })
        }}
      >
        <Tab value="due">今日到期复习{due ? ` (${due.length})` : ''}</Tab>
        <Tab value="wrong">错题本</Tab>
        <Tab value="favorite">我的收藏</Tab>
        <Tab value="notes">我的笔记</Tab>
      </TabList>
      {tab === 'due' ? <Trainer review /> : <QuestionLibraryView key={tab} tab={tab} />}
    </div>
  )
}
