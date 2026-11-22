/** 未标注地区的筛选哨兵值（前后端约定） */
export const UNLABELED_REGION_FILTER = '__NONE__'

const PROVINCE_NAMES = [
  '黑龙江',
  '内蒙古',
  '北京',
  '天津',
  '上海',
  '重庆',
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '广西',
  '海南',
  '四川',
  '贵州',
  '云南',
  '西藏',
  '陕西',
  '甘肃',
  '青海',
  '宁夏',
  '新疆',
  '深圳',
  '广州',
  '联考'
] as const

const PROVINCE_RE = new RegExp(`(${PROVINCE_NAMES.join('|')})(?:省|市|自治区)?`)
const NATIONAL_RE = /国考|国家公务员|中央机关/

/** 规范化地区名称，避免「江苏」与「江苏省」在筛选列表重复出现 */
export function normalizeRegionName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (NATIONAL_RE.test(trimmed)) return '国考'
  const match = trimmed.match(new RegExp(`^(${PROVINCE_NAMES.join('|')})(?:省|市|自治区)$`))
  if (match?.[1]) return match[1]
  return trimmed
}

/** 从试卷名、来源标注、标题或路径中提取规范化地区 */
export function extractRegionFromText(...inputs: Array<string | undefined>): string | undefined {
  for (const input of inputs) {
    if (!input) continue
    const text = input.trim()
    if (!text) continue
    if (NATIONAL_RE.test(text)) return '国考'
    const matched = text.match(PROVINCE_RE)
    if (matched?.[1]) return matched[1]
  }
  return undefined
}

const MUNICIPALITIES = new Set(['北京', '天津', '上海', '重庆'])
const AUTONOMOUS = new Set(['内蒙古', '广西', '西藏', '宁夏', '新疆'])

/** 展开规范化地区的历史同义写法，兼容旧库未重索引前的「北京市/江苏省」记录 */
export function expandRegionAliases(region: string): string[] {
  const trimmed = region.trim()
  if (!trimmed) return []
  const normalized = normalizeRegionName(trimmed)
  const aliases = new Set<string>([trimmed, normalized])
  if (normalized === '国考') {
    aliases.add('国家公务员')
    aliases.add('中央机关')
  } else if (MUNICIPALITIES.has(normalized)) {
    aliases.add(`${normalized}市`)
  } else if (AUTONOMOUS.has(normalized)) {
    aliases.add(`${normalized}自治区`)
  } else if (normalized !== '联考' && normalized !== '深圳' && normalized !== '广州') {
    aliases.add(`${normalized}省`)
  } else if (normalized === '深圳' || normalized === '广州') {
    aliases.add(`${normalized}市`)
  }
  return [...aliases]
}
