// 脏乱题本 PDF 高精度导入专项：benchmark 与基线产物完整性测试。
// docs/ocr-benchmark/ 的产物由 tools/experimental/*.py 确定性生成（固定种子、
// 无时间戳），重跑不产生 diff；真实样本不在本机时跳过样本目录相关断言。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BENCH = join(__dirname, '..', 'docs', 'ocr-benchmark')
const SAMPLE_DIR = 'E:/BaiduNetdiskDownload/考公刷题本答案'

function readJson(name: string): any {
  return JSON.parse(readFileSync(join(BENCH, name), 'utf8'))
}

describe('ocr-benchmark 产物', () => {
  it('清单记录了真实样本规模且扫描页占绝对多数', () => {
    const inventory = readJson('inventory.json')
    expect(inventory.pdfCount).toBeGreaterThanOrEqual(40)
    expect(inventory.totalPages).toBeGreaterThan(3000)
    // 「脏题本」前提：绝大多数页面没有可用文字层
    expect(inventory.scanPageRatioOverall).toBeGreaterThan(0.85)
  })

  it('benchmark 页面清单确定性且覆盖各页面类型', () => {
    const manifest = readJson('benchmark-pages.json')
    expect(manifest.seed).toBe(20260906)
    expect(manifest.pageCount).toBeGreaterThanOrEqual(90)
    expect(manifest.pageCount).toBeLessThanOrEqual(100)
    const ids = new Set(manifest.pages.map((p: any) => p.pageId))
    expect(ids.size).toBe(manifest.pages.length)
    const types = new Set(manifest.pages.map((p: any) => p.autoType))
    for (const expected of ['普通文字', '资料分析', '图形推理候选', '解析']) {
      expect(types.has(expected)).toBe(true)
    }
    if (existsSync(SAMPLE_DIR)) {
      for (const page of manifest.pages) {
        expect(existsSync(page.relPath)).toBe(true)
      }
    }
  })

  it('人工标注模板包含必填列', () => {
    const csv = readFileSync(join(BENCH, 'annotation-template.csv'), 'utf8')
    for (const column of [
      'page_id',
      'expected_qnos(人工必填)',
      'numbers_to_verify(人工:抄3-5个原书数字)'
    ]) {
      expect(csv).toContain(column)
    }
  })

  it('各引擎指标文件齐全且诚实标记了待人工指标', () => {
    const required = [
      'metrics-engineA-200dpi.json',
      'metrics-engineA-structured.json',
      'metrics-expworker-300dpi.json'
    ]
    for (const name of required) {
      const metrics = readJson(name)
      expect(metrics.engine).toBeTruthy()
      // 静默丢题等真实指标必须显式声明「待人工标注」，不允许假装已自动化
      expect(metrics.pendingHumanMetrics.length).toBeGreaterThan(0)
    }
    const workerMetrics = readJson('metrics-expworker-300dpi.json')
    // 回归门：实验 worker 在真实样本上必须给出图推人工审核数与数字交叉一致性
    expect(workerMetrics.graphicBindProxy).toBeTruthy()
    expect(workerMetrics.digitConsistencyVsA.meanJaccard).toBeGreaterThan(0.5)
  })

  it('调研报告与基线说明落盘', () => {
    expect(existsSync(join(BENCH, 'README.md'))).toBe(true)
    expect(existsSync(join(BENCH, 'baseline.md'))).toBe(true)
    expect(existsSync(join(BENCH, 'research-report.md'))).toBe(true)
  })
})
