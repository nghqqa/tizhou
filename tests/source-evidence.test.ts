// 来源页证据：页映射纯函数（页码/bbox/分类/去重/兼容/容量）
import { describe, expect, it } from 'vitest'
import {
  buildLinePageMap,
  buildSourceEvidence,
  collectEvidencePageKeys,
  computeTraceCoverage,
  EVIDENCE_PAGE_LIMIT,
  evidenceAssetId,
  isValidNormalizedBbox,
  isValidPageNumber,
  manifestFromRegions,
  pageKey,
  parsePageManifest,
  traceCoverageMessage
} from '../src/main/services/source-evidence'

const MANIFEST = {
  pages: [
    { pageNumber: 1, source: 'ocr', lines: ['练习题01套', '1. 第一题题干：'] },
    { pageNumber: 2, source: 'ocr', lines: ['A. 选项甲', 'B. 选项乙', '2. 第二题题干：'] },
    { pageNumber: 3, source: 'ocr', lines: ['A. 选项丙', 'B. 选项丁'] }
  ]
}

describe('parsePageManifest', () => {
  it('正常解析；页码统一 1-based（0/负数/非整数页被拒）', () => {
    const manifest = parsePageManifest(JSON.stringify(MANIFEST))
    expect(manifest?.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3])
  })

  it('损坏 JSON / 缺字段 / 空页列表返回 undefined（不抛错）', () => {
    expect(parsePageManifest('{bad')).toBeUndefined()
    expect(parsePageManifest('{"x":1}')).toBeUndefined()
    expect(parsePageManifest('{"pages":[]}')).toBeUndefined()
    expect(parsePageManifest(undefined)).toBeUndefined()
  })

  it('manifestFromRegions：region page（0-based）派生 1-based 页清单', () => {
    const manifest = manifestFromRegions([
      { type: 'text', page: 0, bbox: [], imgPath: '', text: 'a' },
      { type: 'text', page: 2, bbox: [], imgPath: '', text: 'c' }
    ])
    expect(manifest.pages.map((page) => page.pageNumber)).toEqual([1, 3])
  })
})

describe('buildLinePageMap', () => {
  it('行 → 页映射与页清单行序对齐；空行跳过不消耗标签', () => {
    const raw = ['练习题01套', '1. 第一题题干：', '', 'A. 选项甲', 'B. 选项乙']
    const map = buildLinePageMap(raw, parsePageManifest(JSON.stringify(MANIFEST)))
    // 空行被跳过后：3 行非空 → 标签依序 1,1,2（manifest 非空行序）
    expect(map.slice(0, 5)).toEqual([1, 1, undefined, 2, 2])
  })

  it('无页清单时全部 undefined', () => {
    expect(buildLinePageMap(['a', 'b'], undefined)).toEqual([undefined, undefined])
  })
})

describe('isValidNormalizedBbox / isValidPageNumber', () => {
  it('bbox [0,1] 归一化校验：拒绝越界/乱序/NaN', () => {
    expect(isValidNormalizedBbox([0, 0, 1, 1])).toBe(true)
    expect(isValidNormalizedBbox([0.1, 0.2, 0.8, 0.9])).toBe(true)
    expect(isValidNormalizedBbox([0, 0, 1.5, 1])).toBe(false)
    expect(isValidNormalizedBbox([0.5, 0.5, 0.2, 0.9])).toBe(false)
    expect(isValidNormalizedBbox([NaN, 0, 1, 1])).toBe(false)
    expect(isValidNormalizedBbox([0, 0])).toBe(false)
  })

  it('页码 1-based 正整数', () => {
    expect(isValidPageNumber(1)).toBe(true)
    expect(isValidPageNumber(0)).toBe(false)
    expect(isValidPageNumber(-1)).toBe(false)
    expect(isValidPageNumber(1.5)).toBe(false)
    expect(isValidPageNumber('3')).toBe(false)
  })
})

describe('buildSourceEvidence', () => {
  it('LocatedLine（行标签平行生成）→ exact；region 页 → exact；多页去重升序', () => {
    const linePageMap = [1, 1, 2, 2, 3]
    const evidence = buildSourceEvidence({
      references: [
        {
          role: 'question',
          sourceId: 's1',
          relativePath: '题本.pdf',
          lineStart: 2,
          linePageMap,
          exactPages: [3, 3, 2]
        }
      ]
    })
    expect(evidence.status).toBe('available')
    const pages = evidence.references[0]!.pages
    expect(pages.map((page) => `${page.pageNumber}:${page.mapping}`)).toEqual([
      '2:exact',
      '3:exact'
    ])
  })

  it('无行号无 region → unavailable（不猜页码）', () => {
    const evidence = buildSourceEvidence({
      references: [{ role: 'question', sourceId: 's', relativePath: 'a.pdf', linePageMap: [] }]
    })
    expect(evidence.status).toBe('unavailable')
    expect(evidence.references).toHaveLength(0)
  })

  it('引用页超容量上限 → partial 并带原因', () => {
    const evidence = buildSourceEvidence({
      references: [
        {
          role: 'preserved-page',
          sourceId: 's',
          relativePath: 'a.pdf',
          exactPages: Array.from({ length: EVIDENCE_PAGE_LIMIT + 1 }, (_, i) => i + 1)
        }
      ]
    })
    expect(evidence.status).toBe('partial')
    expect(evidence.partialReason).toContain('超过任务证据上限')
  })

  it('材料行区间跨页 → 区间内全部页 exact（共享材料传递）', () => {
    const linePageMap = [1, 1, 2, 3]
    const evidence = buildSourceEvidence({
      references: [
        {
          role: 'material',
          sourceId: 's',
          relativePath: 'a.pdf',
          linePageMap,
          lineRange: { start: 0, end: 3 }
        }
      ]
    })
    expect(evidence.references[0]!.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3])
  })
})

describe('证据资产与指标', () => {
  it('assetId 稳定且页键去重', () => {
    expect(evidenceAssetId('s1', 3)).toBe(evidenceAssetId('s1', 3))
    expect(evidenceAssetId('s1', 3)).not.toBe(evidenceAssetId('s2', 3))
    expect(pageKey('s1', 3)).toBe('s1#p3')
  })

  it('collectEvidencePageKeys 跨产物去重（sourceId+pageNumber）', () => {
    const artifacts = [
      {
        sourceEvidence: buildSourceEvidence({
          references: [
            { role: 'question', sourceId: 's1', relativePath: 'a', lineStart: 0, linePageMap: [2] }
          ]
        })
      },
      {
        sourceEvidence: buildSourceEvidence({
          references: [
            { role: 'solution', sourceId: 's1', relativePath: 'a', lineStart: 0, linePageMap: [2] }
          ]
        })
      }
    ]
    expect(collectEvidencePageKeys(artifacts)).toEqual(new Set(['s1#p2']))
  })

  it('computeTraceCoverage：available/unavailable/exact 计数 + 消息', () => {
    const withEvidence = buildSourceEvidence({
      references: [
        { role: 'question', sourceId: 's', relativePath: 'a', lineStart: 0, linePageMap: [5] }
      ]
    })
    const coverage = computeTraceCoverage(
      [
        { sourceEvidence: withEvidence },
        {},
        { sourceEvidence: { status: 'unavailable', references: [] } }
      ],
      1
    )
    expect(coverage.available).toBe(1)
    expect(coverage.unavailable).toBe(2)
    expect(coverage.exactPages).toBe(1)
    expect(traceCoverageMessage(coverage)).toContain('来源证据可用 1')
    expect(traceCoverageMessage(coverage)).toContain('已存证据页 1')
  })

  it('历史产物无 sourceEvidence 字段：兼容（计 unavailable，不抛错）', () => {
    const coverage = computeTraceCoverage([{}, {}], 0)
    expect(coverage.unavailable).toBe(2)
  })
})

describe('finalizeSourceEvidenceStatus（资产可用性与页码来源分离）', () => {
  const base = (assetIds: Array<string | undefined>) => ({
    status: 'available' as const,
    references: [
      {
        role: 'question' as const,
        sourceId: 's',
        relativePath: 'a.pdf',
        pages: assetIds.map((evidenceAssetId, index) => ({
          pageNumber: index + 1,
          mapping: 'exact' as const,
          ...(evidenceAssetId ? { evidenceAssetId } : {})
        }))
      }
    ]
  })

  it('全部页有 assetId → available', async () => {
    const { finalizeSourceEvidenceStatus } = await import('../src/main/services/source-evidence')
    const evidence = base(['ev-1', 'ev-2'])
    finalizeSourceEvidenceStatus(evidence)
    expect(evidence.status).toBe('available')
    expect(evidence.partialReason).toBeUndefined()
  })

  it('部分页有 assetId → partial 并写原因', async () => {
    const { finalizeSourceEvidenceStatus } = await import('../src/main/services/source-evidence')
    const evidence = base(['ev-1', undefined, 'ev-3'])
    finalizeSourceEvidenceStatus(evidence)
    expect(evidence.status).toBe('partial')
    expect(evidence.partialReason).toContain('2/3')
  })

  it('全部无 assetId → unavailable 并写原因（页码映射保留）', async () => {
    const { finalizeSourceEvidenceStatus } = await import('../src/main/services/source-evidence')
    const evidence = base([undefined, undefined])
    finalizeSourceEvidenceStatus(evidence)
    expect(evidence.status).toBe('unavailable')
    expect(evidence.partialReason).toContain('0/2')
    // 页码映射不受证据资产可用性影响
    expect(evidence.references[0]!.pages[0]!.mapping).toBe('exact')
  })

  it('无引用页 → unavailable', async () => {
    const { finalizeSourceEvidenceStatus } = await import('../src/main/services/source-evidence')
    const evidence = { status: 'available' as const, references: [] }
    finalizeSourceEvidenceStatus(evidence)
    expect(evidence.status).toBe('unavailable')
  })
})
