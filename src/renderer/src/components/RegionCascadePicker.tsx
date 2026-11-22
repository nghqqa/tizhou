import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, CaretRightIcon, CheckIcon, MapPinIcon } from '@phosphor-icons/react'
import { UNLABELED_REGION_FILTER } from '@shared/region'

const SPECIAL_NON_CIVIL_REGIONS = new Set(['事业编', '事业单位', '军队文职', '三支一扶'])

function sortRegions(regions: string[]): string[] {
  return [...regions].sort((a, b) => {
    if (a === '国考') return -1
    if (b === '国考') return 1
    if (a === '联考') return -1
    if (b === '联考') return 1
    return a.localeCompare(b, 'zh-CN')
  })
}

export interface RegionCascadeItem {
  id: string
  label: string
  meta?: string
}

export interface RegionCascadePickerProps {
  regions: string[]
  regionCounts?: Array<{ region: string; count: number }>
  value: string
  onChange: (region: string, paper?: string, itemId?: string) => void
  papers?: string[]
  selectedPaper?: string
  items?: RegionCascadeItem[]
  selectedItemId?: string
  disabled?: boolean
  placeholder?: string
}

type CategoryKey = 'all' | 'civil' | 'public' | 'unlabeled'

const PAGE_SIZE = 60

export function RegionCascadePicker({
  regions,
  regionCounts,
  value,
  onChange,
  papers,
  selectedPaper,
  items,
  selectedItemId,
  disabled = false,
  placeholder = '全部地区'
}: RegionCascadePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const [hoverCategory, setHoverCategory] = useState<CategoryKey>('civil')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const countMap = useMemo(
    () => new Map((regionCounts ?? []).map((item) => [item.region, item.count])),
    [regionCounts]
  )

  const { civilRegions, publicRegions } = useMemo(() => {
    const civil: string[] = []
    const pub: string[] = []
    for (const region of regions) {
      if (SPECIAL_NON_CIVIL_REGIONS.has(region)) pub.push(region)
      else civil.push(region)
    }
    return { civilRegions: sortRegions(civil), publicRegions: sortRegions(pub) }
  }, [regions])

  const categories = useMemo(() => {
    const list: Array<{ key: CategoryKey; label: string; count?: number }> = [
      { key: 'all', label: '全部题库' }
    ]
    if (civilRegions.length > 0) {
      list.push({ key: 'civil', label: '公务员', count: civilRegions.length })
    }
    if (publicRegions.length > 0) {
      list.push({ key: 'public', label: '事业单位', count: publicRegions.length })
    }
    list.push({ key: 'unlabeled', label: '专项教材 / 未标注' })
    return list
  }, [civilRegions.length, publicRegions.length])

  const activeCategory: CategoryKey = useMemo(() => {
    if (!open) {
      if (value === UNLABELED_REGION_FILTER) return 'unlabeled'
      if (value && SPECIAL_NON_CIVIL_REGIONS.has(value)) return 'public'
      if (value) return 'civil'
      return civilRegions.length > 0 ? 'civil' : 'all'
    }
    return hoverCategory
  }, [open, value, hoverCategory, civilRegions.length])

  const middleRegions =
    activeCategory === 'civil' ? civilRegions : activeCategory === 'public' ? publicRegions : []

  const displayLabel = useMemo(() => {
    if (!value) return placeholder
    if (value === UNLABELED_REGION_FILTER) return '专项教材 / 未标注地区'
    if (selectedPaper) return `${value} · ${selectedPaper}`
    return value
  }, [value, selectedPaper, placeholder])

  function handleToggle(): void {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    if (value === UNLABELED_REGION_FILTER) setHoverCategory('unlabeled')
    else if (value && SPECIAL_NON_CIVIL_REGIONS.has(value)) setHoverCategory('public')
    else if (civilRegions.length > 0) setHoverCategory('civil')
    else setHoverCategory('all')
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) {
      const panelWidth = Math.min(720, window.innerWidth - 64)
      setAlignRight(
        rect.left + panelWidth > window.innerWidth - 20 && rect.right >= panelWidth + 16
      )
    }
    setOpen(true)
  }

  return (
    <div className="region-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`region-picker-trigger${value ? ' is-selected' : ''}${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-expanded={open}
        onClick={handleToggle}
      >
        <MapPinIcon size={15} />
        <span className="region-picker-text">{displayLabel}</span>
        <CaretDownIcon size={14} className="region-picker-caret" />
      </button>

      {open && (
        <div
          className={`region-cascade-popover${alignRight ? ' is-align-right' : ''}`}
          role="dialog"
          aria-label="选择考试地区与分类"
        >
          <div className="region-cascade-grid">
            {/* 第一栏：大类 */}
            <div className="region-cascade-col" role="listbox" aria-label="考试类别">
              {categories.map((cat) => {
                const isActive = activeCategory === cat.key
                return (
                  <button
                    key={cat.key}
                    type="button"
                    className={`region-cascade-option${isActive ? ' is-active' : ''}`}
                    onClick={() => {
                      setHoverCategory(cat.key)
                      if (cat.key === 'all') {
                        onChange('', '')
                        setOpen(false)
                      } else if (cat.key === 'unlabeled') {
                        onChange(UNLABELED_REGION_FILTER, '')
                      } else if (cat.key === 'public' && publicRegions.length === 1) {
                        onChange(publicRegions[0]!, '')
                      }
                    }}
                  >
                    <span>{cat.label}</span>
                    {cat.count !== undefined && (
                      <span className="region-cascade-count">{cat.count}</span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* 第二栏：地区 */}
            <div className="region-cascade-col" role="listbox" aria-label="地区列表">
              {middleRegions.length > 0 ? (
                middleRegions.map((item) => {
                  const isSelected = value === item
                  const count = countMap.get(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`region-cascade-option${isSelected ? ' is-active' : ''}`}
                      onClick={() => onChange(item, '')}
                    >
                      <span>{item}</span>
                      <span className="region-cascade-right">
                        {count !== undefined && (
                          <span className="region-cascade-region-count">{count}</span>
                        )}
                        <CaretRightIcon size={13} className="region-cascade-arrow" />
                      </span>
                    </button>
                  )
                })
              ) : (
                <div className="region-cascade-empty">
                  {activeCategory === 'unlabeled'
                    ? '已筛选专项教材及未标注地区题目'
                    : '点击左侧大类查看地区'}
                </div>
              )}
            </div>

            {/* 第三栏：当地题目或试卷 */}
            <div className="region-cascade-col region-cascade-col-wide" role="listbox">
              {items ? (
                <>
                  <button
                    type="button"
                    className="region-cascade-option is-summary"
                    onClick={() => setOpen(false)}
                  >
                    <span>
                      {value === UNLABELED_REGION_FILTER
                        ? '应用：专项教材 / 未标注地区'
                        : value
                          ? `应用：${value}全部题目（${items.length} 题）`
                          : `应用：全部题目（${items.length} 题）`}
                    </span>
                    <CheckIcon size={14} />
                  </button>
                  {items.slice(0, visibleCount).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`region-cascade-option is-item${selectedItemId === item.id ? ' is-active' : ''}`}
                      onClick={() => {
                        onChange(value, undefined, item.id)
                        setOpen(false)
                      }}
                    >
                      <div className="region-cascade-item-main">
                        <span className="region-cascade-item-title">{item.label}</span>
                        {item.meta && <span className="region-cascade-item-meta">{item.meta}</span>}
                      </div>
                    </button>
                  ))}
                  {items.length > visibleCount && (
                    <button
                      type="button"
                      className="region-cascade-option is-summary"
                      onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                    >
                      <span>加载更多（还有 {items.length - visibleCount} 题）</span>
                    </button>
                  )}
                  {items.length === 0 && (
                    <div className="region-cascade-empty">当前地区暂无申论题目</div>
                  )}
                </>
              ) : papers ? (
                <>
                  <button
                    type="button"
                    className={`region-cascade-option is-summary${!selectedPaper ? ' is-active' : ''}`}
                    onClick={() => {
                      onChange(value, '')
                      setOpen(false)
                    }}
                  >
                    <span>{value ? `${value} · 全部试卷` : '全部试卷'}</span>
                    <CheckIcon size={14} />
                  </button>
                  {papers.slice(0, visibleCount).map((paperName) => (
                    <button
                      key={paperName}
                      type="button"
                      className={`region-cascade-option${selectedPaper === paperName ? ' is-active' : ''}`}
                      onClick={() => {
                        onChange(value, paperName)
                        setOpen(false)
                      }}
                    >
                      <span className="region-cascade-item-title">{paperName}</span>
                    </button>
                  ))}
                  {papers.length > visibleCount && (
                    <button
                      type="button"
                      className="region-cascade-option is-summary"
                      onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                    >
                      <span>加载更多（还有 {papers.length - visibleCount} 份试卷）</span>
                    </button>
                  )}
                </>
              ) : (
                <div className="region-cascade-empty">选定左侧地区后点击「确定」</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
