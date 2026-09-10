import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backfillPapersTo,
  findContainedZiliao,
  htmlToMarkdown,
  kaogongExplanation,
  kaogongOptions,
  loadPrimaryIndex,
  looseSignature,
  questionMarkdown,
  questionSignature,
  referencedMaterialOnly,
  regionFromPaperTitle,
  stripPunct
} from '../tools/lib/import-core.mjs'

describe('去重签名', () => {
  it('stripPunct 保留中文与数字、去掉空白/标点/下划线（JS \\w 不含中文的坑）', () => {
    expect(
      stripPunct('很多短视频不会提供更多的、有助于消除不确定性的信息，标题几乎就是其内容的全部。')
    ).toBe('很多短视频不会提供更多的有助于消除不确定性的信息标题几乎就是其内容的全部')
    expect(stripPunct('增长率为 12.5%，填入________处')).toBe('增长率为125填入处')
    expect(stripPunct(null)).toBe('')
  })

  it('官方签名对空白不敏感、对标点敏感；宽松签名两者都不敏感', () => {
    const options = [{ key: 'A', text: '昭然若揭' }]
    const base = questionSignature('甲和乙两个图书室共有5000本藏书，其中甲多3x本。', options, '')
    expect(
      questionSignature('甲和乙两个图书室共有 5000 本藏书，其中甲多 3x 本。', options, '')
    ).toBe(base)
    expect(questionSignature('甲和乙两个图书室共有5000本藏书，其中甲多3x本', options, '')).not.toBe(
      base
    )
    expect(looseSignature('甲和乙两个图书室共有5000本藏书，其中甲多3x本。', '', '昭然若揭')).toBe(
      looseSignature('甲和乙两个图书室共有5000本藏书,其中甲多3x本', '', '昭然若揭')
    )
  })

  it('官方签名包含材料段并把首选项截到 50 字', () => {
    const longOption = [{ key: 'A', text: 'x'.repeat(80) }]
    const signature = questionSignature('题干', longOption, '材料')
    expect(signature).toBe(`题干|材料|${'x'.repeat(50)}`)
    expect(questionSignature('题干', [], undefined)).toBe('题干||')
  })

  it('资料分析题干包含匹配：只认非空 needle，找不到返回 undefined', () => {
    const stems = new Map([
      ['2020年第二季度J省除风力发电之外的发电量在以下哪个范围内', 'oe-ziliao-1.md'],
      ['', 'oe-empty.md']
    ])
    expect(
      findContainedZiliao(
        '（2022国考）2020年第二季度，J省除风力发电之外的发电量在以下哪个范围内？',
        stems
      )
    ).toBe('oe-ziliao-1.md')
    expect(findContainedZiliao('完全无关的题干文本', stems)).toBeUndefined()
  })
})

describe('kaogong 字段解析', () => {
  it('选项对象按字母序转数组并丢弃空文本', () => {
    expect(kaogongOptions('{"C":"丙","A":"甲","B":"","D":" 丁 "}')).toEqual([
      { key: 'A', text: '甲' },
      { key: 'C', text: '丙' },
      { key: 'D', text: '丁' }
    ])
    expect(kaogongOptions('not json')).toEqual([])
    expect(kaogongOptions(null)).toEqual([])
  })

  it('三套讲解按存在与否拼接，全空时给兜底文案', () => {
    expect(
      kaogongExplanation({ explanation: '标准', hs_explanation: '', xp_explanation: '小P' })
    ).toBe('【标准解析】\n标准\n\n【小P排除法】\n小P')
    expect(kaogongExplanation({})).toBe('该题暂未提供解析。')
  })

  it('卷名解析地区：省考取地区，国考不设地区，非标题为空', () => {
    expect(regionFromPaperTitle('2023年上海公务员录用考试《行测》A类')).toBe('上海')
    expect(regionFromPaperTitle('2022年国家公务员录用考试《行测》（副省级）')).toBeUndefined()
    expect(regionFromPaperTitle('随便一个名字')).toBeUndefined()
  })
})

describe('申论材料定位', () => {
  const material = [
    '材料1',
    '',
    '第一段内容。',
    '',
    '材料2',
    '',
    '第二段内容。',
    '',
    '材料3',
    '',
    '第三段内容。'
  ].join('\n')

  it('题干引用单个材料时只保留该段', () => {
    expect(referencedMaterialOnly(material, '请根据材料2，概括……')).toBe('材料2\n\n第二段内容。')
  })

  it('“给定资料N”写法与多材料引用按编号升序合并', () => {
    expect(referencedMaterialOnly(material, '结合给定资料3和材料1，谈谈……')).toBe(
      '材料1\n\n第一段内容。\n\n材料3\n\n第三段内容。'
    )
  })

  it('无数字引用、引用超范围、材料头前有前言时回退全文', () => {
    expect(referencedMaterialOnly(material, '结合全部给定资料，自拟题目写一篇文章')).toBe(material)
    expect(referencedMaterialOnly(material, '请根据材料9作答')).toBe(material)
    const withPreamble = `总说明\n${material}`
    expect(referencedMaterialOnly(withPreamble, '请根据材料2作答')).toBe(withPreamble)
  })
})

describe('HTML 与 Markdown 契约', () => {
  it('题图引用改写为 assets 相对路径并登记到 sink，其余标签与实体被清理', () => {
    const sink = new Set<string>()
    const html =
      '<p>截至2023年末<br>登记 &amp; 发证</p><img src="openexam-asset://question-assets/0123456789abcdef0123456789abcdef01234567.webp">'
    const markdown = htmlToMarkdown(html, sink)
    expect(markdown).toContain('![](assets/0123456789abcdef0123456789abcdef01234567.webp)')
    expect(markdown).toContain('截至2023年末\n登记 & 发证')
    expect(markdown).not.toContain('<')
    expect([...sink]).toEqual(['0123456789abcdef0123456789abcdef01234567.webp'])
  })

  it('questionMarkdown 生成的 frontmatter 可被 gray-matter 原样读回', () => {
    const markdown = questionMarkdown({
      id: 'kg-1',
      subject: 'xingce',
      category: '资料分析',
      tags: ['资料分析', '基期'],
      source: '本地资料/test',
      sourceFile: '2022年国考',
      year: 2022,
      region: '国考',
      questionType: 'single',
      difficulty: 3,
      material: '材料1\n\n数据表',
      stem: '基期量约为多少？',
      options: [
        { key: 'A', text: '100' },
        { key: 'B', text: '200' }
      ],
      answer: ['B'],
      explanation: '现期÷(1+r)',
      papers: [{ paper: '2022年国考', order: 116 }]
    })
    const { data } = matter(markdown)
    expect(data.id).toBe('kg-1')
    expect(data.stem).toBe('基期量约为多少？')
    expect(data.material).toBe('材料1\n\n数据表')
    expect(data.options).toEqual([
      { key: 'A', text: '100' },
      { key: 'B', text: '200' }
    ])
    expect(data.answer).toEqual(['B'])
    expect(data.papers).toEqual([{ paper: '2022年国考', order: 116 }])
    expect(data.year).toBe(2022)
  })
})

describe('主库索引与 papers 回填', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-import-core-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function write(name: string, overrides: Record<string, unknown>): string {
    const path = join(directory, name)
    writeFileSync(
      path,
      questionMarkdown({
        id: name.replace(/\.md$/, ''),
        subject: 'xingce',
        category: '言语理解与表达',
        tags: [],
        source: 's',
        sourceFile: 'f',
        questionType: 'single',
        difficulty: 2,
        stem: '默认题干',
        options: [{ key: 'A', text: '甲' }],
        answer: ['A'],
        explanation: '解析',
        papers: [{ paper: '旧卷', order: 1 }],
        ...overrides
      }),
      'utf8'
    )
    return path
  }

  it('loadPrimaryIndex 建立三级索引，资料题干过短的不进包含匹配样本', () => {
    write('a.md', { stem: '言语题干甲乙丙丁', options: [{ key: 'A', text: '甲' }] })
    write('b.md', {
      category: '资料分析-基期',
      stem: '2020年第二季度J省除风力发电之外的发电量在以下哪个范围内',
      material: '材料'
    })
    write('c.md', { category: '资料分析', stem: '短题干' })
    const index = loadPrimaryIndex(directory)
    expect(
      index.strict.get(questionSignature('言语题干甲乙丙丁', [{ key: 'A', text: '甲' }], ''))
    ).toBe('a.md')
    expect(index.loose.get(looseSignature('言语题干甲乙丙丁', '', '甲'))).toBe('a.md')
    expect([...index.ziliaoStems.values()]).toEqual(['b.md'])
  })

  it('backfillPapersTo 只追加缺失归属，重复调用返回 0 且不改动其他内容', () => {
    const path = write('q.md', {})
    const before = matter(readFileSync(path, 'utf8'))
    expect(
      backfillPapersTo(path, [
        { paper: '新卷', order: 7 },
        { paper: '旧卷', order: 1 }
      ])
    ).toBe(1)
    const after = matter(readFileSync(path, 'utf8'))
    expect(after.data.papers).toEqual([
      { paper: '旧卷', order: 1 },
      { paper: '新卷', order: 7 }
    ])
    expect(after.data.stem).toBe(before.data.stem)
    expect(after.content).toBe(before.content)
    expect(backfillPapersTo(path, [{ paper: '新卷', order: 7 }])).toBe(0)
  })
})
