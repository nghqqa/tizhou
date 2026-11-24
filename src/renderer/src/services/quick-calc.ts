export interface QuickCalcResult {
  value: number
  formatted: string
  percentHint?: string
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; op: '+' | '-' | '*' | '/' | '^' | '%' }
  | { type: 'paren'; value: '(' | ')' }

function normalizeExpression(raw: string): string {
  return raw
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/[×✕＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/[＋]/g, '+')
    .replace(/[－—–]/g, '-')
    .replace(/[％]/g, '%')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim()
}

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch })
      i += 1
      continue
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^' || ch === '%') {
      tokens.push({ type: 'op', op: ch })
      i += 1
      continue
    }
    if (/\d/.test(ch) || (ch === '.' && i + 1 < expr.length && /\d/.test(expr[i + 1]!))) {
      let end = i
      let seenDot = false
      while (end < expr.length) {
        const c = expr[end]!
        if (/\d/.test(c)) {
          end += 1
        } else if (c === '.' && !seenDot) {
          seenDot = true
          end += 1
        } else {
          break
        }
      }
      const num = Number(expr.slice(i, end))
      if (!Number.isFinite(num)) return null
      tokens.push({ type: 'num', value: num })
      i = end
      continue
    }
    return null
  }
  return tokens
}

function formatCalcNumber(value: number): QuickCalcResult {
  const clean = Math.abs(value) < 1e-12 ? 0 : value
  const rounded = Number(clean.toFixed(6))
  const formatted = Number.isInteger(rounded)
    ? String(rounded)
    : Number(rounded.toFixed(4)).toString()
  let percentHint: string | undefined
  if (clean !== 0 && Math.abs(clean) <= 10) {
    const pct = Number((clean * 100).toFixed(2))
    if (Number.isFinite(pct)) percentHint = `${pct}%`
  }
  return { value: rounded, formatted, percentHint }
}

/** 零 eval 的四则/括号/乘方/百分号递归下降求值器（适用于行测资料分析速算公式） */
export function evaluateQuickCalc(raw: string): ({ ok: true } & QuickCalcResult) | { ok: false } {
  const normalized = normalizeExpression(raw)
  if (!normalized || normalized.length > 240) return { ok: false }
  const tokens = tokenize(normalized)
  if (!tokens || tokens.length === 0) return { ok: false }

  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const consume = (): Token | undefined => {
    const t = tokens[pos]
    pos += 1
    return t
  }

  const parsePrimary = (): number | null => {
    const token = peek()
    if (!token) return null
    if (token.type === 'num') {
      consume()
      return token.value
    }
    if (token.type === 'paren' && token.value === '(') {
      consume()
      const inner = parseExpr()
      const close = peek()
      if (inner === null || !close || close.type !== 'paren' || close.value !== ')') return null
      consume()
      return inner
    }
    return null
  }

  const parsePostfix = (): number | null => {
    let val = parsePrimary()
    if (val === null) return null
    while (peek()?.type === 'op' && (peek() as { type: 'op'; op: string }).op === '%') {
      consume()
      val /= 100
    }
    return val
  }

  const parseUnary = (): number | null => {
    const token = peek()
    if (token?.type === 'op' && (token.op === '+' || token.op === '-')) {
      consume()
      const operand = parseUnary()
      if (operand === null) return null
      return token.op === '-' ? -operand : operand
    }
    return parsePostfix()
  }

  const parsePower = (): number | null => {
    const base = parseUnary()
    if (base === null) return null
    if (peek()?.type === 'op' && (peek() as { type: 'op'; op: string }).op === '^') {
      consume()
      const exp = parsePower()
      if (exp === null || Math.abs(exp) > 100) return null
      const result = Math.pow(base, exp)
      return Number.isFinite(result) ? result : null
    }
    return base
  }

  const parseTerm = (): number | null => {
    let left = parsePower()
    if (left === null) return null
    while (true) {
      const next = peek()
      if (next?.type === 'op' && (next.op === '*' || next.op === '/')) {
        consume()
        const right = parsePower()
        if (right === null) return null
        if (next.op === '*') {
          left *= right
        } else {
          if (right === 0) return null
          left /= right
        }
      } else if (next?.type === 'paren' && next.value === '(') {
        const right = parsePower()
        if (right === null) return null
        left *= right
      } else {
        break
      }
      if (!Number.isFinite(left)) return null
    }
    return left
  }

  const parseExpr = (): number | null => {
    let left = parseTerm()
    if (left === null) return null
    while (peek()?.type === 'op') {
      const op = (peek() as { type: 'op'; op: string }).op
      if (op !== '+' && op !== '-') break
      consume()
      const right = parseTerm()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
      if (!Number.isFinite(left)) return null
    }
    return left
  }

  const value = parseExpr()
  if (value === null || pos !== tokens.length || !Number.isFinite(value)) {
    return { ok: false }
  }
  return { ok: true, ...formatCalcNumber(value) }
}

/** 从速算便签多行草稿中识别最后一条有效算式并实时求值 */
export function extractLastCalcExpression(
  note: string
): { expression: string; result: QuickCalcResult } | null {
  const lines = note.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const rawLine = lines[i]!.trim()
    if (!rawLine) continue
    const segments = rawLine.split('=')
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const seg = segments[s]!.trim()
      if (!seg) continue
      const match = seg.match(/([+\-×✕＊÷／*/^()%（）＋－—–％\d.,\s]+)$/)
      const candidate = match?.[1]?.trim() ?? ''
      if (!candidate || !/[+\-×✕＊÷／*/^%％＋－—–]/.test(candidate)) continue
      const evaluated = evaluateQuickCalc(candidate)
      if (evaluated.ok) {
        return {
          expression: candidate,
          result: {
            value: evaluated.value,
            formatted: evaluated.formatted,
            percentHint: evaluated.percentHint
          }
        }
      }
    }
  }
  return null
}
