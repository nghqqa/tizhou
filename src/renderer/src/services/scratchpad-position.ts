export interface ScratchpadPosition {
  left: number
  top: number
}

export interface ScratchpadSize {
  width: number
  height: number
}

export type ScratchpadDockPreset = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type ScratchpadClearPolicy = 'keep' | 'per-material'

export const SCRATCHPAD_POS_STORAGE_KEY = 'tizhou.scratchpad.position.v1'
export const SCRATCHPAD_SIZE_STORAGE_KEY = 'tizhou.scratchpad.size.v1'
export const SCRATCHPAD_CLEAR_POLICY_KEY = 'tizhou.scratchpad.clearPolicy.v1'

export const SCRATCHPAD_DEFAULT_SIZE: ScratchpadSize = { width: 440, height: 340 }
export const SCRATCHPAD_MIN_SIZE: ScratchpadSize = { width: 320, height: 240 }
export const SCRATCHPAD_MAX_SIZE: ScratchpadSize = { width: 820, height: 680 }

/**
 * 将草稿纸浮层坐标约束在当前视口可见范围内。
 */
export function clampScratchpadPosition(
  pos: ScratchpadPosition,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8
): ScratchpadPosition {
  const safeW = Math.max(0, panelWidth)
  const safeH = Math.max(0, panelHeight)
  const minLeft = viewportWidth >= safeW + margin * 2 ? margin : 0
  const maxLeft = Math.max(
    minLeft,
    viewportWidth >= safeW + margin * 2 ? viewportWidth - safeW - margin : viewportWidth - safeW
  )
  const minTop = viewportHeight >= safeH + margin * 2 ? margin : 0
  const maxTop = Math.max(
    minTop,
    viewportHeight >= safeH + margin * 2 ? viewportHeight - safeH - margin : viewportHeight - safeH
  )

  const rawLeft = Number.isFinite(pos.left) ? pos.left : minLeft
  const rawTop = Number.isFinite(pos.top) ? pos.top : minTop

  return {
    left: Math.round(Math.min(maxLeft, Math.max(minLeft, rawLeft))),
    top: Math.round(Math.min(maxTop, Math.max(minTop, rawTop)))
  }
}

/**
 * 将草稿纸浮层尺寸限制在最小/最大阈值及当前视口安全区间内。
 */
export function clampScratchpadSize(
  size: ScratchpadSize,
  viewportWidth: number,
  viewportHeight: number,
  margin = 16
): ScratchpadSize {
  const maxAllowedW = Math.max(
    180,
    Math.min(SCRATCHPAD_MAX_SIZE.width, Math.round(viewportWidth - margin * 2))
  )
  const maxAllowedH = Math.max(
    180,
    Math.min(SCRATCHPAD_MAX_SIZE.height, Math.round(viewportHeight - margin * 2))
  )
  const minAllowedW = Math.min(SCRATCHPAD_MIN_SIZE.width, maxAllowedW)
  const minAllowedH = Math.min(SCRATCHPAD_MIN_SIZE.height, maxAllowedH)

  const rawW = Number.isFinite(size.width) ? size.width : SCRATCHPAD_DEFAULT_SIZE.width
  const rawH = Number.isFinite(size.height) ? size.height : SCRATCHPAD_DEFAULT_SIZE.height

  return {
    width: Math.round(Math.min(maxAllowedW, Math.max(minAllowedW, rawW))),
    height: Math.round(Math.min(maxAllowedH, Math.max(minAllowedH, rawH)))
  }
}

/**
 * 计算默认右下角定位（与初始 CSS right/bottom 留白一致）。
 */
export function computeDefaultScratchpadPosition(
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  inset = 24
): ScratchpadPosition {
  return clampScratchpadPosition(
    {
      left: viewportWidth - panelWidth - inset,
      top: viewportHeight - panelHeight - inset
    },
    panelWidth,
    panelHeight,
    viewportWidth,
    viewportHeight
  )
}

/**
 * 计算四角快速停靠坐标，并经由统一边界函数约束。
 */
export function computeDockPosition(
  preset: ScratchpadDockPreset,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  inset = 24
): ScratchpadPosition {
  const raw: ScratchpadPosition =
    preset === 'top-left'
      ? { left: inset, top: inset }
      : preset === 'top-right'
        ? { left: viewportWidth - panelWidth - inset, top: inset }
        : preset === 'bottom-left'
          ? { left: inset, top: viewportHeight - panelHeight - inset }
          : { left: viewportWidth - panelWidth - inset, top: viewportHeight - panelHeight - inset }

  return clampScratchpadPosition(raw, panelWidth, panelHeight, viewportWidth, viewportHeight)
}

export function loadSavedScratchpadPosition(): ScratchpadPosition | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SCRATCHPAD_POS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ScratchpadPosition> | null
    if (
      parsed &&
      typeof parsed.left === 'number' &&
      Number.isFinite(parsed.left) &&
      typeof parsed.top === 'number' &&
      Number.isFinite(parsed.top)
    ) {
      return { left: Math.round(parsed.left), top: Math.round(parsed.top) }
    }
    return null
  } catch {
    return null
  }
}

export function saveScratchpadPosition(pos: ScratchpadPosition): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SCRATCHPAD_POS_STORAGE_KEY,
      JSON.stringify({ left: Math.round(pos.left), top: Math.round(pos.top) })
    )
  } catch {
    /* 忽略受限环境存储写入失败 */
  }
}

export function loadSavedScratchpadSize(): ScratchpadSize {
  if (typeof window === 'undefined') return { ...SCRATCHPAD_DEFAULT_SIZE }
  try {
    const raw = window.localStorage.getItem(SCRATCHPAD_SIZE_STORAGE_KEY)
    if (!raw) return { ...SCRATCHPAD_DEFAULT_SIZE }
    const parsed = JSON.parse(raw) as Partial<ScratchpadSize> | null
    if (
      parsed &&
      typeof parsed.width === 'number' &&
      Number.isFinite(parsed.width) &&
      typeof parsed.height === 'number' &&
      Number.isFinite(parsed.height)
    ) {
      return clampScratchpadSize(
        { width: parsed.width, height: parsed.height },
        window.innerWidth,
        window.innerHeight
      )
    }
    return { ...SCRATCHPAD_DEFAULT_SIZE }
  } catch {
    return { ...SCRATCHPAD_DEFAULT_SIZE }
  }
}

export function saveScratchpadSize(size: ScratchpadSize): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SCRATCHPAD_SIZE_STORAGE_KEY,
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) })
    )
  } catch {
    /* 忽略受限环境存储写入失败 */
  }
}

export function loadScratchpadClearPolicy(): ScratchpadClearPolicy {
  if (typeof window === 'undefined') return 'keep'
  try {
    const raw = window.localStorage.getItem(SCRATCHPAD_CLEAR_POLICY_KEY)
    return raw === 'per-material' ? 'per-material' : 'keep'
  } catch {
    return 'keep'
  }
}

export function saveScratchpadClearPolicy(policy: ScratchpadClearPolicy): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCRATCHPAD_CLEAR_POLICY_KEY, policy)
  } catch {
    /* 忽略受限环境存储写入失败 */
  }
}
