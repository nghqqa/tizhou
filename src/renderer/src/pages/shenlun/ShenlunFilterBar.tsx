import { Field, Input } from '@fluentui/react-components'
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { QuestionSummary } from '@shared/contracts'
import {
  SHENLUN_QUESTION_TYPES,
  classifyShenlunType,
  type ShenlunQuestionType
} from '@shared/shenlun'
import { RegionCascadePicker } from '../../components/RegionCascadePicker'
import { ShenlunPromptPicker } from '../../components/ShenlunPromptPicker'
import type { useImeSearchInput } from '../../services/search-input'
import { formatMaterialSource } from '../../services/study-helpers'
import { stemPreview, type ShenlunQualityFilter } from './constants'

interface ShenlunFilterBarProps {
  regions: string[]
  regionCounts: Array<{ region: string; count: number }>
  region: string
  promptId: string
  promptsCount: number
  qualityFilteredCount?: number
  visiblePrompts: QuestionSummary[]
  statusByPrompt: Map<string, { count: number; latestScore: number; latestAt: string }>
  search: ReturnType<typeof useImeSearchInput>
  shenlunType: '' | ShenlunQuestionType
  typeCounts: Record<ShenlunQuestionType, number>
  qualityFilter: ShenlunQualityFilter
  qualityCounts: { all: number; cleanable: number; verified: number; incomplete: number }
  evaluating: boolean
  onRegionOrPromptChange: (nextRegion: string, nextPromptId?: string) => void
  onSelectPrompt: (id: string) => void
  onSelectType: (type: '' | ShenlunQuestionType) => void
  onSelectQualityFilter: (filter: ShenlunQualityFilter) => void
}

export function ShenlunFilterBar({
  regions,
  regionCounts,
  region,
  promptId,
  promptsCount,
  qualityFilteredCount,
  visiblePrompts,
  statusByPrompt,
  search,
  shenlunType,
  typeCounts,
  qualityFilter,
  qualityCounts,
  evaluating,
  onRegionOrPromptChange,
  onSelectPrompt,
  onSelectType,
  onSelectQualityFilter
}: ShenlunFilterBarProps): React.JSX.Element {
  return (
    <>
      <div className="shenlun-filter-grid">
        <Field label="地区 / 分类">
          <RegionCascadePicker
            regions={regions}
            regionCounts={regionCounts}
            value={region}
            disabled={evaluating}
            items={visiblePrompts.map((prompt) => {
              const status = statusByPrompt.get(prompt.id)
              const metaParts = [
                prompt.region,
                prompt.year ? `${prompt.year}年` : '',
                classifyShenlunType(prompt.category, prompt.stemPreview),
                prompt.source ? formatMaterialSource(prompt.source) : '',
                status ? `已评 ${status.latestScore} 分` : ''
              ].filter(Boolean)
              return {
                id: prompt.id,
                label: stemPreview(prompt.stemPreview, 42),
                meta: metaParts.join(' · ')
              }
            })}
            selectedItemId={promptId}
            onChange={(nextRegion, _paper, nextPromptId) =>
              onRegionOrPromptChange(nextRegion, nextPromptId)
            }
          />
        </Field>
        <Field className="grow" label="搜索题目">
          <Input
            value={search.value}
            disabled={evaluating}
            contentBefore={<MagnifyingGlassIcon />}
            contentAfter={
              search.value ? (
                <button
                  type="button"
                  className="search-clear-btn"
                  aria-label="清除搜索关键词"
                  disabled={evaluating}
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
            placeholder="按题干、材料、卷名或年份搜索（空格分隔多词）"
          />
        </Field>
        <Field className="grow" label="选择题目">
          <ShenlunPromptPicker
            prompts={visiblePrompts}
            value={promptId}
            statusByPrompt={statusByPrompt}
            disabled={evaluating || !visiblePrompts.length}
            onSelect={onSelectPrompt}
          />
        </Field>
      </div>
      <div className="shenlun-chip-strip">
        <div className="shenlun-type-bar" role="tablist" aria-label="申论题型分类">
          <button
            type="button"
            role="tab"
            aria-selected={shenlunType === ''}
            className={`shenlun-type-chip${shenlunType === '' ? ' is-active' : ''}`}
            disabled={evaluating}
            onClick={() => onSelectType('')}
          >
            全部题型 ({qualityFilteredCount ?? promptsCount})
          </button>
          {SHENLUN_QUESTION_TYPES.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={shenlunType === kind}
              className={`shenlun-type-chip${shenlunType === kind ? ' is-active' : ''}`}
              disabled={evaluating}
              onClick={() => onSelectType(kind)}
            >
              {kind} ({typeCounts[kind]})
            </button>
          ))}
        </div>
        <span className="shenlun-chip-divider" aria-hidden="true" />
        <div className="shenlun-quality-bar" role="group" aria-label="材料完整度筛选">
          <span className="shenlun-quality-label">材料完整度：</span>
          <button
            type="button"
            aria-pressed={qualityFilter === 'all'}
            className={`shenlun-quality-chip${qualityFilter === 'all' ? ' is-active' : ''}`}
            disabled={evaluating}
            onClick={() => onSelectQualityFilter('all')}
          >
            全部材料 ({qualityCounts.all})
          </button>
          <button
            type="button"
            aria-pressed={qualityFilter === 'hide-incomplete'}
            className={`shenlun-quality-chip${qualityFilter === 'hide-incomplete' ? ' is-active' : ''}`}
            disabled={evaluating}
            onClick={() => onSelectQualityFilter('hide-incomplete')}
          >
            隐藏残缺 ({qualityCounts.cleanable})
          </button>
          <button
            type="button"
            aria-pressed={qualityFilter === 'verified'}
            className={`shenlun-quality-chip${qualityFilter === 'verified' ? ' is-active' : ''}`}
            disabled={evaluating}
            onClick={() => onSelectQualityFilter('verified')}
          >
            精校带解析 ({qualityCounts.verified})
          </button>
        </div>
      </div>
    </>
  )
}
