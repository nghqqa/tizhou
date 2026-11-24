import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

export function now(): string {
  return new Date().toISOString()
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel))
  )
}

export function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** UTC ISO 时间或 Date → 本地日期键 `YYYY-MM-DD`（跨北京时间零点去重时避免日期偏移） */
export function localDateKeyOf(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return localDateString(date)
}

/** 安全 YAML 字符串字面量转义（剔除控制字符后走 JSON 引号序列化） */
export function yamlQuote(value: unknown): string {
  return JSON.stringify(
    String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  )
}
