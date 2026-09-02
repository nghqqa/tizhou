// 能力边界收敛：能力分类、图推默认关闭、发布门禁
import { describe, expect, it } from 'vitest'
import { CAPABILITY_LABELS, classifyFileCapability } from '../src/main/services/import-quality'
import { GRAPHIC_AUTO_STRUCTURE } from '../src/main/services/graphic-import'
import { partitionByPublishGate } from '../src/main/services/knowledge-builder'
import type { ImportCapability } from '../src/shared/contracts'

describe('classifyFileCapability', () => {
  const base = {
    structured: false,
    questionCount: 20,
    completeCount: 18,
    tableCount: 0,
    numericAnomalies: 0,
    graphicCandidate: false,
    figureImages: 0,
    solutionMarks: 5
  }

  it('普通文字题 → text-supported', () => {
    expect(classifyFileCapability(base)).toBe<ImportCapability>('text-supported')
  })

  it('检测到表格 → table-review', () => {
    expect(classifyFileCapability({ ...base, tableCount: 3 })).toBe<ImportCapability>(
      'table-review'
    )
  })

  it('数字异常偏多 → table-review（人工抽查）', () => {
    expect(classifyFileCapability({ ...base, numericAnomalies: 12 })).toBe<ImportCapability>(
      'table-review'
    )
  })

  it('图形推理候选 → graphic-review（优先于其他分类）', () => {
    expect(
      classifyFileCapability({ ...base, graphicCandidate: true, tableCount: 2 })
    ).toBe<ImportCapability>('graphic-review')
  })

  it('无题目但图片充足（结构解析）→ image-only-review', () => {
    expect(
      classifyFileCapability({
        ...base,
        questionCount: 0,
        structured: true,
        figureImages: 30
      })
    ).toBe<ImportCapability>('image-only-review')
  })

  it('无题目且无图片 → unsupported-auto-structure', () => {
    expect(classifyFileCapability({ ...base, questionCount: 0 })).toBe<ImportCapability>(
      'unsupported-auto-structure'
    )
  })

  it('每种能力都有用户可读标签', () => {
    const capabilities: ImportCapability[] = [
      'text-supported',
      'table-review',
      'image-only-review',
      'graphic-review',
      'unsupported-auto-structure'
    ]
    for (const capability of capabilities)
      expect(CAPABILITY_LABELS[capability].length).toBeGreaterThan(0)
  })
})

describe('实验性图推绑定开关', () => {
  it('默认关闭：图形规律与图片选项不做自动判定', () => {
    expect(GRAPHIC_AUTO_STRUCTURE.enabled).toBe(false)
  })
})

describe('发布门禁', () => {
  function artifact(fields: {
    capability?: ImportCapability
    humanConfirmed?: boolean
    pairingPending?: boolean
  }) {
    return {
      capability: fields.capability,
      humanConfirmed: fields.humanConfirmed,
      warnings: fields.pairingPending ? ['配对待确认：答案需人工核对'] : []
    }
  }

  it('text-supported 正常放行', () => {
    const { allowed, blocked } = partitionByPublishGate([
      artifact({ capability: 'text-supported' })
    ])
    expect(allowed).toHaveLength(1)
    expect(blocked).toHaveLength(0)
  })

  it('图推/图片题未人工确认时被拦下', () => {
    const { allowed, blocked } = partitionByPublishGate([
      artifact({ capability: 'graphic-review' }),
      artifact({ capability: 'image-only-review' }),
      artifact({ capability: 'table-review' })
    ])
    expect(allowed).toHaveLength(0)
    expect(blocked).toHaveLength(3)
  })

  it('人工确认后解除限制', () => {
    const { allowed, blocked } = partitionByPublishGate([
      artifact({ capability: 'graphic-review', humanConfirmed: true })
    ])
    expect(allowed).toHaveLength(1)
    expect(blocked).toHaveLength(0)
  })

  it('配对待确认未确认时被拦下；无 capability 但有配对待确认警告同样拦截', () => {
    const { allowed, blocked } = partitionByPublishGate([artifact({ pairingPending: true })])
    expect(allowed).toHaveLength(0)
    expect(blocked).toHaveLength(1)
  })

  it('无 capability 的普通产物不受门禁影响', () => {
    const { allowed, blocked } = partitionByPublishGate([artifact({})])
    expect(allowed).toHaveLength(1)
    expect(blocked).toHaveLength(0)
  })
})
