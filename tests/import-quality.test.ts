// 导入质量模型：数字异常/表格一致性/切分完整度/结构噪声/解析清洗
import { describe, expect, it } from 'vitest'
import {
  cleanExplanation,
  isNumberStreamLine,
  quarantineNumberStreamLine,
  questionCompleteness,
  scanNumericAnomalies,
  scanTableQuality,
  stripStructuralNoise
} from '../src/main/services/import-quality'

describe('数字异常扫描', () => {
  it('坐标轴数字流被标记，正常统计数据不误报', () => {
    const lines = [
      '14000 40 27.6 38.3 30 12000 20 8.2 8.9 9.8 10000 4.9 10 8000 7.4 7.7',
      '2021年全国发电量8.5万亿千瓦时，同比增长3.4%',
      '固定数据及互联网业务实现收入2601亿元，比上年增长9.8%'
    ]
    const result = scanNumericAnomalies(lines)
    expect(result.numberStreamLines).toBe(1)
    expect(result.count).toBe(1)
    expect(result.samples[0]).toContain('数字流')
  })

  it('多小数点与全角数字产生告警', () => {
    const result = scanNumericAnomalies(['收入为3.4.5亿元', '数值０８年数据'])
    expect(result.count).toBe(2)
  })

  it('负号、小数、百分号、千分位逗号是合法数字形态，不产生告警', () => {
    const result = scanNumericAnomalies([
      '同比下降-29.5%，约为-87元',
      '2021年为1,234.5亿元，占比12.3%'
    ])
    expect(result.count).toBe(0)
  })

  it('数字流行隔离：替换为占位标记而非静默删除', () => {
    const stream = '3488 3793 4000 4350 5210 6110 7210 8310'
    expect(isNumberStreamLine(stream)).toBe(true)
    expect(quarantineNumberStreamLine(stream)).toContain('建议对照原图核对数字')
    expect(quarantineNumberStreamLine('正常解析内容')).toBe('正常解析内容')
  })
})

describe('表格结构一致性', () => {
  it('列数一致的表格置信度为 1', () => {
    const md = '| 项目 | 2021 | 2022 |\n|---|---:|---:|\n| 财产性收入 | 2090 | 3016 |'
    const result = scanTableQuality(md)
    expect(result.tables).toBe(1)
    expect(result.ragged).toBe(0)
    expect(result.confidence).toBe(1)
  })

  it('列数不一致的表格计入残缺并拉低置信度', () => {
    const md =
      '| 项目 | 2021 | 2022 |\n|---|---:|---:|\n| 财产性收入 | 2090 |\n| 转移性收入 | 8217 | 10106 |'
    const result = scanTableQuality(md)
    expect(result.tables).toBe(1)
    expect(result.ragged).toBe(1)
    expect(result.confidence).toBeLessThan(1)
  })

  it('无表格时不发布误导性置信度', () => {
    const result = scanTableQuality('普通正文，没有表格。')
    expect(result.tables).toBe(0)
    expect(result.confidence).toBeUndefined()
  })
})

describe('题目切分完整度', () => {
  it('完整题占比即置信度', () => {
    const result = questionCompleteness([
      { stem: '完整的题干内容超过八个字符', options: [{ key: 'A' }, { key: 'B' }] },
      { stem: '短', options: [] }
    ])
    expect(result.total).toBe(2)
    expect(result.complete).toBe(1)
    expect(result.confidence).toBe(0.5)
  })
})

describe('结构噪声行过滤', () => {
  it('「请回答1～5题」被过滤，题干与材料行保留', () => {
    const result = stripStructuralNoise([
      '请回答1～5题',
      '（第6-10题）',
      '1. 2021年7月份，全国发电量大约是多少亿千瓦时：',
      '一、根据所给材料回答问题。'
    ])
    expect(result.removed).toBe(2)
    expect(result.lines).toEqual([
      '1. 2021年7月份，全国发电量大约是多少亿千瓦时：',
      '一、根据所给材料回答问题。'
    ])
  })
})

describe('HTML 表格一致性（RapidDoc 还原形态）', () => {
  it('统计 HTML 表格数量并检测单元格残缺', () => {
    const md =
      '<table><tr><td>项目</td><td>2021</td></tr><tr><td>财产性收入</td><td>2090</td></tr></table>' +
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'
    const result = scanTableQuality(md)
    expect(result.tables).toBe(2)
    expect(result.ragged).toBe(1)
    expect(result.confidence).toBe(0.5)
  })
})

describe('cleanExplanation（解析清洗阶段）', () => {
  it('行内水印只移除宣传片段，正文与数值原样保留', () => {
    const result = cleanExplanation(
      '则春节假期旅游收入占比≈9%，答案为 A 选项。公考最新资料、更新进度微信SKA674'
    )
    expect(result.cleaned).not.toContain('公考最新资料')
    expect(result.cleaned).not.toContain('微信SKA674')
    expect(result.cleaned).toContain('则春节假期旅游收入占比≈9%，答案为 A 选项。')
    expect(result.removedWatermarks.length).toBeGreaterThan(0)
  })

  it('句中的①②③保留为步骤编号，孤立圆圈标记移入审计块', () => {
    const withSteps = cleanExplanation('①先确定同比变化方向；②再比较基期和现期；③得出结论。')
    expect(withSteps.cleaned).toContain('①先确定同比变化方向')
    expect(withSteps.cleaned).not.toContain('原始图表标记')
    const isolated = cleanExplanation('解析正文一句话。\n①②\n更多解析。')
    expect(isolated.cleaned).toContain('[原始图表标记：①②]')
  })

  it('公式、百分比、金额、年份、负数原样保留', () => {
    const raw =
      '2022年收入6397 亿元，同比下降17.7%；占比33.5%，为25.30 亿。6390-5980≈410，比值1.24÷2.07，区间2017～2022 年，比为6:1，减少-29.5%。'
    const result = cleanExplanation(raw)
    for (const token of [
      '6397 亿元',
      '17.7%',
      '33.5%',
      '25.30 亿',
      '6390-5980≈410',
      '2017～2022 年',
      '1.24÷2.07',
      '6:1',
      '-29.5%'
    ]) {
      expect(result.cleaned).toContain(token)
    }
  })

  it('短行段落重建：中文行相接不加空格，步骤行保持独立', () => {
    const result = cleanExplanation(
      '定位文字材料第一段，\n2018年收入为1.3\n万亿元，则倍数约1.2。\n①先看基期；\n②再看现期。'
    )
    expect(result.cleaned).toContain('定位文字材料第一段，2018年收入为1.3万亿元，则倍数约1.2。')
    expect(result.cleaned).toContain('①先看基期；')
  })

  it('虚词结尾的断行被标记为疑似断句', () => {
    const result = cleanExplanation('定位文字材料第二段，只给出了该')
    expect(result.readabilityWarnings.some((w) => w.includes('疑似 OCR 断句'))).toBe(true)
  })

  it('解析只剩数字或符号时告警', () => {
    const result = cleanExplanation('3488 3793 4000')
    expect(result.readabilityWarnings.some((w) => w.includes('只剩数字或符号'))).toBe(true)
  })
})
