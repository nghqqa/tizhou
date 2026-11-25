export interface ScratchpadPosition {
  left: number
  top: number
}

export type ScratchpadDockPreset = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const SCRATCHPAD_POS_STORAGE_KEY = 'tizhou.scratchpad.position.v1'

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
