// 导入质量模型：把「一个 OCR 平均置信度」拆成可核对的维度。
// 原则：能算的才算（不做假的版面分）；异常只告警不静默修正；无法确认的标记人工审核。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RegionBlock {
  type: string
  page: number
  bbox: number[]
  imgPath: string
  text: string
}

export interface StructuredRegions {
  pages: number
  regions: RegionBlock[]
  removedNoise?: number
}

/** 读取结构解析产出的版面块清单（images/_regions.json，随图片归档走缓存） */
export function loadStructuredRegions(imagesDirectory: string): StructuredRegions | undefined {
  try {
    const path = join(imagesDirectory, '_regions.json')
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StructuredRegions>
    if (!parsed || !Array.isArray(parsed.regions)) return undefined
    return {
      pages: Number(parsed.pages) || 0,
      regions: parsed.regions.filter(
        (block): block is RegionBlock =>
          Boolean(block) && typeof block.type === 'string' && Array.isArray(block.bbox)
      ),
      removedNoise: Number(parsed.removedNoise) || 0
    }
  } catch {
    return undefined
  }
}

export interface NumericAnomalies {
  count: number
  samples: string[]
  /** 数字流行数：坐标轴/表格残渣被拼成正文的主要形态 */
  numberStreamLines: number
}

const NUMERIC_TOKEN = /^[-+]?[\d,，]+(?:\.\d+)?[%％]?$/

/** 数字流行判定：≥6 个纯数字 token 且占比 ≥60%，且不含中文散文——
 *  含中文的混排行走行内数字串隔离（保留散文、隔离数字串） */
export function isNumberStreamLine(line: string): boolean {
  if (/[\u4e00-\u9fff]/.test(line)) return false
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length < 6) return false
  const numeric = tokens.filter((token) => NUMERIC_TOKEN.test(token)).length
  return numeric / tokens.length >= 0.6
}

/** 解析文本行隔离：整行数字流替换为占位标记；行内 ≥3 个连续裸数字 token 的
 * 串以审计块保留原数字（不静默删除、不猜测语义）。公式与带单位数字不受影响
 * （「6390- 5980 410 ≈100亿元」「已知1.24 = 2.07」等含运算符/单位的不命中）。 */
export function quarantineNumberStreamLine(line: string): string {
  if (isNumberStreamLine(line)) return '> [图表数据区已隔离，建议对照原图核对数字]'
  return line.replace(
    /(?:[-+]?\d[\d,.]*%?[（(]?\s+){2,}[-+]?\d[\d,.]*%?[）)]?/g,
    (match) => `\n> [图表数字串，OCR 无法确认语义，请对照原图]\n> ${match.trim()}\n`
  )
}

const WATERMARK_PATTERNS = [
  /公考最新资料[、，]?\s*更新进度微信\S*/g,
  /微信SKA\d+/g,
  /公众号[：:]\S+/g,
  /超格学员专用/g,
  /资料分析600[贴折]/g
] as const

/** 行内水印剥离：只删命中的机构宣传片段，题目出处/年份/地区/资料来源不动 */
export function stripWatermarkFragments(lines: string[]): {
  lines: string[]
  removedFragments: number
} {
  let removedFragments = 0
  const cleaned = lines.map((line) => {
    let result = line
    for (const pattern of WATERMARK_PATTERNS) {
      result = result.replace(pattern, () => {
        removedFragments += 1
        return ''
      })
    }
    return result.replace(/\s{2,}/g, ' ').trim()
  })
  return { lines: cleaned.filter(Boolean), removedFragments }
}

// 资料分析专用数字异常扫描：
// 1) 数字流行——统计图坐标标签混入正文
// 2) 多小数点（1.2.3）——小数点/分隔符识别错误
// 3) 全角数字（０-９）——未规范化
// 只产生告警与计数，不静默改写数字内容。
export function scanNumericAnomalies(lines: string[]): NumericAnomalies {
  let count = 0
  let numberStreamLines = 0
  const samples: string[] = []
  const note = (kind: string, line: string): void => {
    count += 1
    if (samples.length < 5) samples.push(`[${kind}] ${line.slice(0, 60)}`)
  }
  for (const line of lines) {
    if (isNumberStreamLine(line)) {
      numberStreamLines += 1
      note('数字流', line)
      continue
    }
    if (/\d\.\d+\.\d/.test(line)) note('多小数点', line)
    else if (/[０-９]/.test(line)) note('全角数字', line)
  }
  return { count, samples, numberStreamLines }
}

export interface TableQuality {
  /** markdown 表格数量 */
  tables: number
  /** 列数不一致（单元格残缺）的表格数 */
  ragged: number
  /** 表格结构置信度：1 - 残缺占比；无表格时缺省不发布误导数值 */
  confidence?: number
}

// 表格结构一致性：识别 markdown 管道表格与 HTML 表格（RapidDoc 还原输出形态），
// 列/单元格数不一致说明单元格识别残缺——不强行补齐，按数量产生告警。
export function scanTableQuality(markdown: string): TableQuality {
  let tables = 0
  let ragged = 0
  // markdown 管道表格：连续 | 行，各行列数需一致
  let current: number[] | undefined
  const close = (): void => {
    if (!current) return
    tables += 1
    if (current.some((cells) => cells !== current![0])) ragged += 1
    current = undefined
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split('|').length - 2
      if (!current) current = [cells]
      else current.push(cells)
    } else {
      close()
    }
  }
  close()
  // HTML 表格：逐表比较各行 td/th 单元格数
  const htmlTables = markdown.match(/<table[\s\S]*?<\/table>/gi) ?? []
  for (const table of htmlTables) {
    tables += 1
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const counts = rows.map((row) => (row.match(/<t[dh][\s>]/gi) ?? []).length)
    if (counts.some((cells) => cells !== counts[0])) ragged += 1
  }
  return {
    tables,
    ragged,
    ...(tables > 0 ? { confidence: Math.round((1 - ragged / tables) * 100) / 100 } : {})
  }
}

export interface Completeness {
  total: number
  complete: number
  /** 题目切分置信度：题干与选项结构完整的题目占比 */
  confidence: number
}

export function questionCompleteness(
  questions: Array<{ stem?: string; options: Array<{ key: string }> }>
): Completeness {
  const total = questions.length
  const complete = questions.filter(
    (question) => (question.stem?.length ?? 0) >= 8 && question.options.length >= 2
  ).length
  return {
    total,
    complete,
    confidence: total ? Math.round((complete / total) * 100) / 100 : 0
  }
}

// 结构性噪声行：单独成行的「请回答1～5题」「（第1~5题）」等组题指引，
// 不是题干也不是材料——过滤而非并入材料/题干（不允许当普通题干）。
export const STRUCTURAL_NOISE_LINE =
  /^[（(]?\s*(?:请回答|请根据.*回答)?\s*第?\s*\d{1,3}\s*[～～~-]\s*\d{1,3}\s*题\s*[)）]?$/

export function stripStructuralNoise(lines: string[]): { lines: string[]; removed: number } {
  const kept = lines.filter((line) => !STRUCTURAL_NOISE_LINE.test(line))
  return { lines: kept, removed: lines.length - kept.length }
}
