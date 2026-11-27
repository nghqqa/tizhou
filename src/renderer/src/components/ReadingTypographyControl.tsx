import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  READING_SCALE_MAX,
  READING_SCALE_MIN,
  READING_SCALE_STEP,
  clampReadingScale,
  loadReadingTypography,
  resolveReadingFontFamily,
  saveReadingTypography,
  type ReadingFontPreset,
  type ReadingTypography
} from '../services/reading-typography'

const SYNC_EVENT = 'tizhou:reading-typography-change'

export function useReadingTypography(): {
  typography: ReadingTypography
  update: (patch: Partial<ReadingTypography>) => void
  stepScale: (delta: number) => void
  resetScale: () => void
  surfaceRef: RefObject<HTMLDivElement | null>
  surfaceStyle: CSSProperties
} {
  const [typography, setTypography] = useState<ReadingTypography>(() => loadReadingTypography())
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onSync = (event: Event): void => {
      const detail = (event as CustomEvent<ReadingTypography>).detail
      if (detail) setTypography(detail)
    }
    window.addEventListener(SYNC_EVENT, onSync)
    return () => window.removeEventListener(SYNC_EVENT, onSync)
  }, [])

  const commit = useCallback((next: ReadingTypography) => {
    const saved = saveReadingTypography(next)
    setTypography(saved)
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: saved }))
  }, [])

  const update = useCallback(
    (patch: Partial<ReadingTypography>) => {
      commit({ ...typography, ...patch })
    },
    [commit, typography]
  )

  const stepScale = useCallback(
    (delta: number) => {
      const nextScale = clampReadingScale(typography.scale + delta)
      if (nextScale !== typography.scale) {
        commit({ ...typography, scale: nextScale })
      }
    },
    [commit, typography]
  )

  const resetScale = useCallback(() => {
    if (typography.scale !== 100) {
      commit({ ...typography, scale: 100 })
    }
  }, [commit, typography])

  useEffect(() => {
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const element = surfaceRef.current
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return
      event.preventDefault()
      stepScale(event.deltaY < 0 ? READING_SCALE_STEP : -READING_SCALE_STEP)
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [stepScale])

  const fontFamily = resolveReadingFontFamily(typography)
  const surfaceStyle = {
    '--tz-read-scale': String(typography.scale / 100),
    ...(fontFamily ? { '--tz-read-font': fontFamily } : {})
  } as CSSProperties

  return { typography, update, stepScale, resetScale, surfaceRef, surfaceStyle }
}

export function ReadingTypographyBar(props: {
  typography: ReadingTypography
  onUpdate: (patch: Partial<ReadingTypography>) => void
  onStepScale: (delta: number) => void
  onResetScale: () => void
  contextLabel?: string
}): React.JSX.Element {
  const { typography, onUpdate, onStepScale, onResetScale, contextLabel = '题目阅读' } = props
  return (
    <div
      className="reading-toolbar"
      role="group"
      aria-label={`${contextLabel}字号与字体调节`}
      title={`支持按钮、滑块或按住 Ctrl 滚动滚轮自由缩放${contextLabel}字号`}
    >
      <div className="reading-scale-group">
        <button
          type="button"
          className="reading-scale-btn"
          aria-label={`缩小${contextLabel}字号`}
          disabled={typography.scale <= READING_SCALE_MIN}
          onClick={() => onStepScale(-READING_SCALE_STEP)}
        >
          A-
        </button>
        <input
          type="range"
          className="reading-scale-slider"
          aria-label={`${contextLabel}字号缩放比例`}
          min={READING_SCALE_MIN}
          max={READING_SCALE_MAX}
          step={READING_SCALE_STEP}
          value={typography.scale}
          onChange={(event) => onUpdate({ scale: Number(event.target.value) })}
        />
        <button
          type="button"
          className="reading-scale-btn"
          aria-label={`放大${contextLabel}字号`}
          disabled={typography.scale >= READING_SCALE_MAX}
          onClick={() => onStepScale(READING_SCALE_STEP)}
        >
          A+
        </button>
        <button
          type="button"
          className={`reading-scale-value${typography.scale !== 100 ? ' is-scaled' : ''}`}
          title="点击重置为 100%"
          onClick={onResetScale}
        >
          {typography.scale}%
        </button>
      </div>
      <select
        className="reading-font-select"
        aria-label={`${contextLabel}字体`}
        value={typography.font}
        onChange={(event) => onUpdate({ font: event.target.value as ReadingFontPreset })}
      >
        <option value="sans">默认黑体</option>
        <option value="serif">书卷宋体</option>
        <option value="fangsong">公文仿宋</option>
        <option value="kaiti">舒朗楷体</option>
        <option value="custom">自定义字体</option>
      </select>
      {typography.font === 'custom' && (
        <input
          type="text"
          className="reading-custom-font"
          aria-label="自定义本机字体名称"
          placeholder="本机字体名（如 霞鹜文楷）"
          value={typography.customFont}
          onChange={(event) => onUpdate({ customFont: event.target.value })}
        />
      )}
    </div>
  )
}
