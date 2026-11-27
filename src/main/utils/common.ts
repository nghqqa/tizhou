import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

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

/** 递归安全复制目录：避免 Node Windows cpSync 对中文路径崩溃，并拦截符号链接与过深嵌套 */
export function copyDirectorySafe(
  source: string,
  target: string,
  options?: { errorOnExist?: boolean; skipSymlinks?: boolean; maxDepth?: number }
): void {
  const maxDepth = options?.maxDepth ?? 64
  if (options?.errorOnExist && existsSync(target)) {
    throw new Error(`目标目录已存在：${target}`)
  }
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) {
    if (options?.skipSymlinks) return
    throw new Error(`源目录存在符号链接，已拒绝复制：${source}`)
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`源路径不是目录：${source}`)
  }
  const realRoot = realpathSync(source)
  const copyRecursive = (srcDir: string, dstDir: string, depth: number): void => {
    if (depth > maxDepth) {
      throw new Error(`目录嵌套超过最大深度（${maxDepth}）：${srcDir}`)
    }
    mkdirSync(dstDir, { recursive: true })
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name)
      const dstPath = join(dstDir, entry.name)
      const stat = lstatSync(srcPath)
      if (stat.isSymbolicLink()) {
        if (options?.skipSymlinks) continue
        throw new Error(`目录包含符号链接，已拒绝复制：${srcPath}`)
      }
      if (stat.isDirectory()) {
        const realSub = realpathSync(srcPath)
        if (!isWithin(realRoot, realSub)) {
          throw new Error(`目录存在符号链接逃逸，已拒绝复制：${srcPath}`)
        }
        copyRecursive(srcPath, dstPath, depth + 1)
      } else if (stat.isFile()) {
        copyFileSync(srcPath, dstPath)
      }
    }
  }
  copyRecursive(source, target, 0)
}
