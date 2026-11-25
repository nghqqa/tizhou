import { afterEach, describe, expect, it } from 'vitest'
import {
  SCRATCHPAD_POS_STORAGE_KEY,
  clampScratchpadPosition,
  computeDefaultScratchpadPosition,
  computeDockPosition,
  loadSavedScratchpadPosition,
  saveScratchpadPosition
} from '../src/renderer/src/services/scratchpad-position'

describe('scratchpad-position', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('在充足视口内将坐标钳制在边距以内并四舍五入取整', () => {
    expect(clampScratchpadPosition({ left: 100.6, top: 80.4 }, 440, 340, 1280, 800)).toEqual({
      left: 101,
      top: 80
    })

    // 左上越界
    expect(clampScratchpadPosition({ left: -50, top: -12 }, 440, 340, 1280, 800)).toEqual({
      left: 8,
      top: 8
    })

    // 右下越界
    expect(clampScratchpadPosition({ left: 1200, top: 900 }, 440, 340, 1280, 800)).toEqual({
      left: 1280 - 440 - 8,
      top: 800 - 340 - 8
    })
  })

  it('窄小视口下安全退化到 0 边界而不出现负数', () => {
    expect(clampScratchpadPosition({ left: -20, top: -10 }, 440, 340, 420, 320)).toEqual({
      left: 0,
      top: 0
    })
    expect(clampScratchpadPosition({ left: 500, top: 500 }, 440, 340, 450, 350)).toEqual({
      left: 10,
      top: 10
    })
  })

  it('正确计算默认右下角与四角停靠位置', () => {
    expect(computeDefaultScratchpadPosition(440, 340, 1440, 900)).toEqual({
      left: 1440 - 440 - 24,
      top: 900 - 340 - 24
    })

    expect(computeDockPosition('top-left', 440, 340, 1440, 900)).toEqual({
      left: 24,
      top: 24
    })
    expect(computeDockPosition('top-right', 440, 340, 1440, 900)).toEqual({
      left: 976,
      top: 24
    })
    expect(computeDockPosition('bottom-left', 440, 340, 1440, 900)).toEqual({
      left: 24,
      top: 536
    })
    expect(computeDockPosition('bottom-right', 440, 340, 1440, 900)).toEqual({
      left: 976,
      top: 536
    })
  })

  it('无 window 环境安全降级，有 localStorage 时正确持久化与校验', () => {
    expect(loadSavedScratchpadPosition()).toBeNull()
    expect(() => saveScratchpadPosition({ left: 10, top: 20 })).not.toThrow()

    const store = new Map<string, string>()
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => {
          store.set(key, val)
        }
      }
    }

    saveScratchpadPosition({ left: 120.4, top: 64.6 })
    expect(loadSavedScratchpadPosition()).toEqual({ left: 120, top: 65 })

    store.set(SCRATCHPAD_POS_STORAGE_KEY, '{broken json')
    expect(loadSavedScratchpadPosition()).toBeNull()

    store.set(SCRATCHPAD_POS_STORAGE_KEY, JSON.stringify({ left: 'NaN', top: 10 }))
    expect(loadSavedScratchpadPosition()).toBeNull()
  })
})
