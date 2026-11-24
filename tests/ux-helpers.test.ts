import { describe, expect, it } from 'vitest'
import {
  evaluateQuickCalc,
  extractLastCalcExpression
} from '../src/renderer/src/services/quick-calc'
import { getContextualShortcuts } from '../src/renderer/src/services/shortcuts'

describe('quick-calc', () => {
  it('evaluates data-analysis arithmetic with percentages, full-width symbols, and implicit multiplication', () => {
    const base = evaluateQuickCalc('4280/(1+14.3%)')
    expect(base.ok).toBe(true)
    if (base.ok) {
      expect(base.value).toBeCloseTo(3744.5319, 3)
      expect(base.percentHint).toBeUndefined()
    }

    const fullWidth = evaluateQuickCalc('（4,280＋720）÷50％×2')
    expect(fullWidth.ok).toBe(true)
    if (fullWidth.ok) expect(fullWidth.value).toBe(20000)

    const ratio = evaluateQuickCalc('120/800')
    expect(ratio.ok).toBe(true)
    if (ratio.ok) {
      expect(ratio.formatted).toBe('0.15')
      expect(ratio.percentHint).toBe('15%')
    }

    const implicit = evaluateQuickCalc('2(3+4) + (-5)^2')
    expect(implicit.ok).toBe(true)
    if (implicit.ok) expect(implicit.value).toBe(39)
  })

  it('safely rejects division by zero, incomplete expressions, and non-math input', () => {
    expect(evaluateQuickCalc('100/0')).toEqual({ ok: false })
    expect(evaluateQuickCalc('4280/(1+')).toEqual({ ok: false })
    expect(evaluateQuickCalc('process.exit(1)')).toEqual({ ok: false })
    expect(evaluateQuickCalc('')).toEqual({ ok: false })
  })

  it('extracts the last arithmetic formula line from note text while ignoring plain numbers', () => {
    expect(extractLastCalcExpression('第 3 题\n排除 B C')).toBeNull()
    const extracted = extractLastCalcExpression('基期估算：\n5420/(1+8.4%) = ?')
    expect(extracted?.expression).toBe('5420/(1+8.4%)')
    expect(extracted?.result.value).toBeCloseTo(5000, 2)

    const rhs = extractLastCalcExpression('基期 = 4280/(1+14.3%)')
    expect(rhs?.expression).toBe('4280/(1+14.3%)')
    expect(rhs?.result.value).toBeCloseTo(3744.5319, 3)

    const fwMul = extractLastCalcExpression('100＊2')
    expect(fwMul?.result.value).toBe(200)
    const fwDiv = extractLastCalcExpression('100／4')
    expect(fwDiv?.result.value).toBe(25)
  })
})

describe('getContextualShortcuts', () => {
  it('prioritizes matching shortcut group for practice, exam, shenlun, and ai routes', () => {
    expect(getContextualShortcuts('/practice', false).currentGroup?.id).toBe('practice')
    expect(getContextualShortcuts('/review', false).currentGroup?.id).toBe('practice')
    expect(getContextualShortcuts('/exam/run', false).currentGroup?.id).toBe('exam')
    expect(getContextualShortcuts('/shenlun-solution', false).currentGroup?.id).toBe('shenlun')
    expect(getContextualShortcuts('/ai', false).currentGroup?.id).toBe('ai')
    expect(getContextualShortcuts('/', false).currentGroup).toBeNull()
  })

  it('adapts shortcut key labels for macOS when requested', () => {
    const mac = getContextualShortcuts('/practice', true)
    const practiceKeys = mac.currentGroup?.items.flatMap((i) => i.keys) ?? []
    expect(practiceKeys).toContain('⌥D')
    const globalGroup = mac.otherGroups.find((g) => g.id === 'global')
    const globalKeys = globalGroup?.items.flatMap((i) => i.keys) ?? []
    expect(globalKeys).toContain('⌘')
    expect(globalKeys).toContain('⌥')
    expect(globalKeys).not.toContain('Ctrl')
  })
})
