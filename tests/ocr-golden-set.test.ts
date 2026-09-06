// 阶段二：Golden Set 与人工真值标注产物校验。
// 诚实边界：OCR 预填永远 pending，confirmed 数即人工确认数（当前应为 0）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BENCH = join(__dirname, '..', 'docs', 'ocr-benchmark')
const GOLDEN = join(BENCH, 'golden-set.json')
const ANNOT_DIR = join(BENCH, 'golden', 'annotations')
const FORBIDDEN_KEYS = ['createdAt', 'updatedAt', 'timestamp', 'annotatedAt']

describe('golden-set 集合隔离', () => {
  const data = JSON.parse(readFileSync(GOLDEN, 'utf8'))

  it('30 页 = 18/6/6，五类各 6 页', () => {
    expect(data.pageCount).toBe(30)
    expect(data.sets.tuning.length).toBe(18)
    expect(data.sets.validation.length).toBe(6)
    expect(data.sets.heldout.length).toBe(6)
    for (const pageType of ['普通文字', '资料分析表格', '资料分析统计图', '解析册', '图形推理']) {
      expect(data.pages.filter((p: any) => p.pageType === pageType).length).toBe(6)
    }
  })

  it('同一 PDF 不跨集合（相邻页泄漏防护）', () => {
    const pdfSets = new Map<string, Set<string>>()
    for (const page of data.pages) {
      const set = pdfSets.get(page.relPath) ?? new Set<string>()
      set.add(page.set)
      pdfSets.set(page.relPath, set)
    }
    for (const [pdf, sets] of pdfSets) {
      expect(sets.size, pdf).toBe(1)
    }
  })

  it('来源多样性：≥5 个 PDF，单源 ≤4 页', () => {
    expect(data.distinctPdfs).toBeGreaterThanOrEqual(5)
    const perPdf = new Map<string, number>()
    for (const page of data.pages) {
      perPdf.set(page.relPath, (perPdf.get(page.relPath) ?? 0) + 1)
    }
    for (const [pdf, count] of perPdf) {
      expect(count, pdf).toBeLessThanOrEqual(4)
    }
  })

  it('清单不含时间戳字段（可 diff）', () => {
    const text = readFileSync(GOLDEN, 'utf8')
    for (const key of FORBIDDEN_KEYS) {
      expect(text.includes(key), key).toBe(false)
    }
  })
})

describe('人工真值标注', () => {
  it('30 页预填全部 pending 且通过基础校验', () => {
    const files = readdirSync(ANNOT_DIR).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(30)
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    const validIds = new Set(golden.pages.map((p: any) => p.pageId))
    let confirmed = 0
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(ANNOT_DIR, file), 'utf8'))
      expect(data.schemaVersion).toBe(1)
      expect(validIds.has(data.pageId), file).toBe(true)
      expect(['pending', 'confirmed']).toContain(data.setStatus)
      if (data.setStatus === 'confirmed') {
        confirmed += 1
        // 人工确认必须有非预填标注人
        expect(data.annotator.startsWith('ocr-prefill'), file).toBe(false)
      } else {
        expect(data.annotator.startsWith('ocr-prefill'), file).toBe(true)
      }
      const text = readFileSync(join(ANNOT_DIR, file), 'utf8')
      for (const key of FORBIDDEN_KEYS) {
        expect(text.includes(key), `${file}:${key}`).toBe(false)
      }
    }
    // 本轮无人工介入：确认数必须如实为 0（有人工确认后此断言由人更新）
    expect(confirmed).toBe(0)
  })
})

describe('真实指标产物', () => {
  it('阶段二报告存在且声明未确认页数', () => {
    const report = readFileSync(join(BENCH, 'phase2-report.md'), 'utf8')
    expect(report).toContain('已人工确认')
    expect(report).toContain('不接入生产')
  })
})

describe('阶段二仓库交付完整性', () => {
  const required = [
    'docs/ocr-benchmark/golden-set.json',
    'docs/ocr-benchmark/phase2-report.md',
    'tests/ocr-golden-set.test.ts',
    'tools/experimental/ablation.py',
    'tools/experimental/annotator.html',
    'tools/experimental/annotator_server.py',
    'tools/experimental/eval_real.py',
    'tools/experimental/exp_worker2.py',
    'tools/experimental/golden_set.py',
    'tools/experimental/gt_schema.py',
    'tools/experimental/prefill_golden.py',
    'tools/experimental/tests/test_phase2.py'
  ]

  it('必需文件存在；Git checkout 中必须被跟踪', () => {
    const root = join(__dirname, '..')
    for (const path of required) {
      expect(existsSync(join(root, path)), path).toBe(true)
    }

    if (!existsSync(join(root, '.git'))) return
    const tracked = new Set(
      execFileSync('git', ['ls-files', ...required], { cwd: root, encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)
    )
    for (const path of required) {
      expect(tracked.has(path), `${path} 未被 Git 跟踪`).toBe(true)
    }
  })

  it('真实 PDF、模型和实验运行目录没有进入 Git', () => {
    const root = join(__dirname, '..')
    if (!existsSync(join(root, '.git'))) return
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(
      /\r?\n/
    )
    expect(tracked.some((path) => path.toLowerCase().endsWith('.pdf'))).toBe(false)
    expect(tracked.some((path) => /(^|\/)(models?|runs?|renders?|crops?)(\/|$)/i.test(path))).toBe(
      false
    )
  })
})
