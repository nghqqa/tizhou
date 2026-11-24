import type { LocalStorageCodec } from '../../hooks/useLocalStorageState'

// 下拉预览的优雅截断：压缩空白后在限长内回退到最近的句读，
// 没有句读可退时才硬切，始终以省略号提示有下文
export function stemPreview(stem: string, max = 60): string {
  const compact = stem.replace(/\s+/g, '')
  if (compact.length <= max) return compact
  const head = compact.slice(0, max)
  const boundary = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('、')
  )
  return (boundary > 20 ? head.slice(0, boundary + 1) : head) + '…'
}

export type ShenlunQualityFilter = 'all' | 'hide-incomplete' | 'verified'

export const QUALITY_FILTER_CODEC: LocalStorageCodec<ShenlunQualityFilter> = {
  parse: (raw) => (raw === 'hide-incomplete' || raw === 'verified' ? raw : 'all'),
  serialize: (value) => value
}

export const SHEET_MODE_CODEC: LocalStorageCodec<'sheet' | 'plain'> = {
  parse: (raw) => (raw === 'plain' ? 'plain' : 'sheet'),
  serialize: (value) => value
}
