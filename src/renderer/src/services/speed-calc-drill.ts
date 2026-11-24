export type SpeedCalcCategory = 'all' | 'fraction' | 'division' | 'growth' | 'square'

export interface SpeedCalcQuestion {
  id: string
  category: Exclude<SpeedCalcCategory, 'all'>
  categoryLabel: string
  prompt: string
  options: Array<{ key: 'A' | 'B' | 'C' | 'D'; text: string }>
  answerKey: 'A' | 'B' | 'C' | 'D'
  explanation: string
}

const BAIDUAN_PAIRS: ReadonlyArray<[number, string, string]> = [
  [2, '50%', '1/2'],
  [3, '33.3%', '1/3'],
  [4, '25%', '1/4'],
  [5, '20%', '1/5'],
  [6, '16.7%', '1/6'],
  [7, '14.3%', '1/7'],
  [8, '12.5%', '1/8'],
  [9, '11.1%', '1/9'],
  [11, '9.1%', '1/11'],
  [12, '8.3%', '1/12'],
  [13, '7.7%', '1/13'],
  [14, '7.1%', '1/14'],
  [15, '6.7%', '1/15'],
  [16, '6.25%', '1/16'],
  [17, '5.9%', '1/17'],
  [18, '5.6%', '1/18'],
  [19, '5.3%', '1/19']
]

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

function shuffleArray<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

function buildOptions(
  correctText: string,
  distractors: string[]
): {
  options: Array<{ key: 'A' | 'B' | 'C' | 'D'; text: string }>
  answerKey: 'A' | 'B' | 'C' | 'D'
} {
  const uniqueDistractors: string[] = []
  for (const candidate of distractors) {
    if (candidate !== correctText && !uniqueDistractors.includes(candidate)) {
      uniqueDistractors.push(candidate)
    }
    if (uniqueDistractors.length >= 3) break
  }
  while (uniqueDistractors.length < 3) {
    const pad = `${Number.parseFloat(correctText) + uniqueDistractors.length + 1}`
    if (!uniqueDistractors.includes(pad) && pad !== correctText) uniqueDistractors.push(pad)
    else uniqueDistractors.push(`${correctText}（误差${uniqueDistractors.length + 1}）`)
  }
  const combined = shuffleArray([
    { text: correctText, isCorrect: true },
    ...uniqueDistractors.map((text) => ({ text, isCorrect: false }))
  ])
  const keys = ['A', 'B', 'C', 'D'] as const
  let answerKey: 'A' | 'B' | 'C' | 'D' = 'A'
  const options = combined.map((entry, idx) => {
    const key = keys[idx]!
    if (entry.isCorrect) answerKey = key
    return { key, text: entry.text }
  })
  return { options, answerKey }
}

function makeFractionQuestion(index: number): SpeedCalcQuestion {
  const toFraction = Math.random() >= 0.4
  const idx = Math.floor(Math.random() * BAIDUAN_PAIRS.length)
  const [n, pct, frac] = BAIDUAN_PAIRS[idx]!
  const neighbors = BAIDUAN_PAIRS.filter((_, i) => i !== idx)
    .sort((a, b) => Math.abs(a[0] - n) - Math.abs(b[0] - n))
    .slice(0, 5)
  if (toFraction) {
    const distractors = shuffleArray(neighbors).map((item) => item[2])
    const { options, answerKey } = buildOptions(frac, distractors)
    return {
      id: `sc-frac-${index}-${Date.now()}`,
      category: 'fraction',
      categoryLabel: '百化分互转',
      prompt: `百分数 **${pct}** 最接近下列哪个分数？`,
      options,
      answerKey,
      explanation: `常用百化分记忆：\`1/${n} ≈ ${pct}\`（反推 \`100 ÷ ${n} = ${(100 / n).toFixed(2)}\`）。`
    }
  }
  const distractors = shuffleArray(neighbors).map((item) => item[1])
  const { options, answerKey } = buildOptions(pct, distractors)
  return {
    id: `sc-frac-${index}-${Date.now()}`,
    category: 'fraction',
    categoryLabel: '百化分互转',
    prompt: `分数 **${frac}** 对应的百分数约为多少？`,
    options,
    answerKey,
    explanation: `\`${frac} = 100% ÷ ${n} ≈ ${pct}\`。`
  }
}

function makeDivisionQuestion(index: number): SpeedCalcQuestion {
  // 截位直除：保留三位有效数字估算量级与首两位差距，锻炼快速估商
  const baseDivisors = [114, 123, 136, 148, 162, 175, 189, 214, 243, 278, 316, 425]
  const divisor = pickRandom(baseDivisors) + Math.floor(Math.random() * 5)
  const trueRatio = 12 + Math.floor(Math.random() * 72)
  const dividend = Math.round(divisor * trueRatio * (0.94 + Math.random() * 0.12))
  const exact = dividend / divisor
  const rounded = Math.round(exact * 10) / 10
  const span = Math.max(1.5, Math.round(rounded * 0.08 * 10) / 10)
  const distractors = [
    (Math.round((rounded - span) * 10) / 10).toFixed(1),
    (Math.round((rounded + span) * 10) / 10).toFixed(1),
    (Math.round((rounded + span * 2) * 10) / 10).toFixed(1)
  ]
  const correctText = rounded.toFixed(1)
  const { options, answerKey } = buildOptions(correctText, distractors)
  const truncDivisor = Math.round(divisor / 10) * 10
  return {
    id: `sc-div-${index}-${Date.now()}`,
    category: 'division',
    categoryLabel: '截位直除',
    prompt: `直除速算：**${dividend} ÷ ${divisor}** 最接近以下哪一项？`,
    options,
    answerKey,
    explanation: `分母截两位视作 \`${Math.round(divisor / 10)}\`（即按 \`${truncDivisor}\` 估算），\`${dividend} ÷ ${divisor} ≈ ${exact.toFixed(2)}\`，最接近 **${correctText}**。`
  }
}

function makeGrowthQuestion(index: number): SpeedCalcQuestion {
  // 增长量秒杀：现期 / (1 + 1/n) * (1/n) = 现期 / (n + 1)
  const subPairs = BAIDUAN_PAIRS.filter(([n]) => n >= 4 && n <= 16)
  const [n, pct] = pickRandom(subPairs)
  const current = (n + 1) * (18 + Math.floor(Math.random() * 65))
  const exact = current / (n + 1)
  const wrongWithN = Math.round(current / n)
  const wrongWithNPlus2 = Math.round(current / (n + 2))
  const wrongMinus = Math.max(10, Math.round(exact * 0.84))
  const correctText = `${Math.round(exact)}`
  const { options, answerKey } = buildOptions(correctText, [
    `${wrongWithN}`,
    `${wrongWithNPlus2}`,
    `${wrongMinus}`
  ])
  return {
    id: `sc-grow-${index}-${Date.now()}`,
    category: 'growth',
    categoryLabel: '增长量秒杀',
    prompt: `现期值为 **${current}**，同比增长率为 **${pct}**，则增长量约为多少？`,
    options,
    answerKey,
    explanation: `\`${pct} ≈ 1/${n}\`，根据增长量特征公式「现期 ÷ (n + 1)」，得 \`${current} ÷ (${n} + 1) = ${exact.toFixed(1)}\` ≈ **${correctText}**。`
  }
}

function makeSquareQuestion(index: number): SpeedCalcQuestion {
  const n = 12 + Math.floor(Math.random() * 18) // 12 ~ 29
  const sq = n * n
  const { options, answerKey } = buildOptions(`${sq}`, [
    `${sq - 10}`,
    `${sq + 10}`,
    `${sq + (n % 2 === 0 ? 12 : -12)}`
  ])
  return {
    id: `sc-sq-${index}-${Date.now()}`,
    category: 'square',
    categoryLabel: '平方记忆',
    prompt: `常用平方速查：**${n}²** 等于多少？`,
    options,
    answerKey,
    explanation: `常见平方：\`${n} × ${n} = ${sq}\`，在两年期/复利及面积类题目高频出现。`
  }
}

/** 生成一组资料分析速算热身题目（纯本地生成、不依赖题库或联网） */
export function generateSpeedCalcDeck(
  category: SpeedCalcCategory = 'all',
  count = 15
): SpeedCalcQuestion[] {
  const generators: Record<Exclude<SpeedCalcCategory, 'all'>, (i: number) => SpeedCalcQuestion> = {
    fraction: makeFractionQuestion,
    division: makeDivisionQuestion,
    growth: makeGrowthQuestion,
    square: makeSquareQuestion
  }
  const pool: Array<Exclude<SpeedCalcCategory, 'all'>> =
    category === 'all' ? ['fraction', 'growth', 'division', 'square'] : [category]
  const total = Math.max(1, Math.min(40, Math.round(count)))
  const items: SpeedCalcQuestion[] = []
  for (let i = 0; i < total; i += 1) {
    const kind = pool[i % pool.length]!
    items.push(generators[kind](i + 1))
  }
  return items
}
