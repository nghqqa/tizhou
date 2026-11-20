export type ReadingFontPreset = 'sans' | 'serif' | 'fangsong' | 'kaiti' | 'custom'

export interface ReadingTypography {
  /** 题目阅读区相对缩放百分比（85–160，默认 100） */
  scale: number
  /** 字体预设或自定义系统字体 */
  font: ReadingFontPreset
  /** 自定义字体族名称（font === 'custom' 时生效） */
  customFont: string
}

export const READING_SCALE_MIN = 85
export const READING_SCALE_MAX = 160
export const READING_SCALE_STEP = 5
export const READING_TYPOGRAPHY_STORAGE_KEY = 'tizhou:reading-typography'

export const DEFAULT_READING_TYPOGRAPHY: ReadingTypography = {
  scale: 100,
  font: 'sans',
  customFont: ''
}

const VALID_PRESETS = new Set<ReadingFontPreset>(['sans', 'serif', 'fangsong', 'kaiti', 'custom'])

export function clampReadingScale(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 100
  return Math.max(READING_SCALE_MIN, Math.min(READING_SCALE_MAX, Math.round(numeric)))
}

/** 清理用户输入的系统字体名：剔除引号、分号、花括号与控制字符，防止破坏 CSS font-family */
export function sanitizeFontName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/['"`\\;{}<>()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
}

export function normalizeReadingTypography(input: unknown): ReadingTypography {
  if (!input || typeof input !== 'object') return { ...DEFAULT_READING_TYPOGRAPHY }
  const raw = input as Partial<ReadingTypography>
  const font =
    typeof raw.font === 'string' && VALID_PRESETS.has(raw.font as ReadingFontPreset)
      ? (raw.font as ReadingFontPreset)
      : 'sans'
  return {
    scale: clampReadingScale(raw.scale),
    font,
    customFont: sanitizeFontName(raw.customFont)
  }
}

/** 将字体偏好解析为 CSS font-family 值；默认黑体返回 undefined 沿用全局令牌 */
export function resolveReadingFontFamily(typography: ReadingTypography): string | undefined {
  switch (typography.font) {
    case 'serif':
      return 'var(--tz-font-display)'
    case 'fangsong':
      return 'var(--tz-font-official-body)'
    case 'kaiti':
      return 'var(--tz-font-official-h2)'
    case 'custom': {
      const clean = sanitizeFontName(typography.customFont)
      return clean ? `"${clean}", var(--tz-font-ui)` : undefined
    }
    default:
      return undefined
  }
}

export function loadReadingTypography(storage?: Pick<Storage, 'getItem'>): ReadingTypography {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    const raw = store?.getItem(READING_TYPOGRAPHY_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_READING_TYPOGRAPHY }
    return normalizeReadingTypography(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_READING_TYPOGRAPHY }
  }
}

export function saveReadingTypography(
  value: ReadingTypography,
  storage?: Pick<Storage, 'setItem'>
): ReadingTypography {
  const normalized = normalizeReadingTypography(value)
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    store?.setItem(READING_TYPOGRAPHY_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    /* 受限环境忽略 localStorage 写入失败 */
  }
  return normalized
}
