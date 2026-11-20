import { describe, expect, it } from 'vitest'
import {
  DEFAULT_READING_TYPOGRAPHY,
  READING_SCALE_MAX,
  READING_SCALE_MIN,
  clampReadingScale,
  loadReadingTypography,
  normalizeReadingTypography,
  resolveReadingFontFamily,
  sanitizeFontName,
  saveReadingTypography
} from '../src/renderer/src/services/reading-typography'

describe('reading-typography（练习页自由放缩与自定义字体）', () => {
  it('clampReadingScale 在 85%–160% 之间钳制并对非法值回退 100%', () => {
    expect(clampReadingScale(100)).toBe(100)
    expect(clampReadingScale(135)).toBe(135)
    expect(clampReadingScale(50)).toBe(READING_SCALE_MIN)
    expect(clampReadingScale(240)).toBe(READING_SCALE_MAX)
    expect(clampReadingScale(Number.NaN)).toBe(100)
    expect(clampReadingScale('abc')).toBe(100)
  })

  it('sanitizeFontName 剥离 CSS 注入字符并保留合法中英文字体名', () => {
    expect(sanitizeFontName('霞鹜文楷')).toBe('霞鹜文楷')
    expect(sanitizeFontName('  LXGW WenKai  ')).toBe('LXGW WenKai')
    expect(sanitizeFontName('FangSong"; color: red; /*')).toBe('FangSong color: red /*')
    expect(sanitizeFontName('A\nB\tC{}[]()')).toBe('A B C')
  })

  it('resolveReadingFontFamily 映射内置字体预设与安全引用自定义字体', () => {
    expect(resolveReadingFontFamily(DEFAULT_READING_TYPOGRAPHY)).toBeUndefined()
    expect(resolveReadingFontFamily({ scale: 110, font: 'serif', customFont: '' })).toBe(
      'var(--tz-font-display)'
    )
    expect(resolveReadingFontFamily({ scale: 110, font: 'fangsong', customFont: '' })).toBe(
      'var(--tz-font-official-body)'
    )
    expect(resolveReadingFontFamily({ scale: 110, font: 'kaiti', customFont: '' })).toBe(
      'var(--tz-font-official-h2)'
    )
    expect(resolveReadingFontFamily({ scale: 120, font: 'custom', customFont: '霞鹜文楷' })).toBe(
      '"霞鹜文楷", var(--tz-font-ui)'
    )
    expect(
      resolveReadingFontFamily({ scale: 120, font: 'custom', customFont: '   ' })
    ).toBeUndefined()
  })

  it('load/save 正常往返持久化，损坏 JSON 安全回退默认值', () => {
    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      }
    }
    const saved = saveReadingTypography(
      { scale: 135, font: 'custom', customFont: '思源宋体 CN' },
      mockStorage
    )
    expect(saved).toEqual({ scale: 135, font: 'custom', customFont: '思源宋体 CN' })
    expect(loadReadingTypography(mockStorage)).toEqual(saved)

    store.set('tizhou:reading-typography', '{broken')
    expect(loadReadingTypography(mockStorage)).toEqual(DEFAULT_READING_TYPOGRAPHY)
    expect(normalizeReadingTypography({ scale: 999, font: 'unknown' })).toEqual({
      scale: READING_SCALE_MAX,
      font: 'sans',
      customFont: ''
    })
  })
})
