// 图形推理图片优先通道：版面聚类 + 选项绑定 + 置信度 + 门禁
import { describe, expect, it } from 'vitest'
import {
  extractGraphicQuestions,
  isGraphicCandidate,
  mergeGraphicQuestions
} from '../src/main/services/graphic-import'
import type { RegionBlock, StructuredRegions } from '../src/main/services/import-quality'

function text(page: number, y: number, content: string): RegionBlock {
  return { type: 'text', page, bbox: [20, y, 869, y + 46], imgPath: '', text: content }
}

function image(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  path: string
): RegionBlock {
  return { type: 'image', page, bbox: [x, y, x + w, y + h], imgPath: path, text: '' }
}

const STEMS = [
  '1.（25国考）从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
  '2.（24国考）从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：'
]

describe('isGraphicCandidate', () => {
  it('题号+图片页充足时判定为图形书', () => {
    const regions: RegionBlock[] = []
    for (let page = 0; page < 5; page += 1) {
      regions.push(text(page, 137, STEMS[0]!))
      regions.push(image(page, 180, 220, 810, 700, `images/q${page}.png`))
    }
    expect(isGraphicCandidate({ pages: 5, regions })).toBe(true)
  })

  it('纯文字书不会误判', () => {
    const regions: RegionBlock[] = [text(0, 137, STEMS[0]!), text(1, 137, STEMS[1]!)]
    expect(isGraphicCandidate({ pages: 2, regions })).toBe(false)
  })
})

describe('extractGraphicQuestions', () => {
  it('四张尺寸相近的图片按版面顺序绑定为 A-D', () => {
    const regions: RegionBlock[] = [
      text(0, 90, '图推700题—— 超格刘义恒'),
      text(0, 137, STEMS[0]!),
      image(0, 20, 300, 200, 200, 'images/a.png'),
      image(0, 260, 300, 200, 200, 'images/b.png'),
      image(0, 500, 300, 200, 200, 'images/c.png'),
      image(0, 740, 300, 200, 200, 'images/d.png')
    ]
    const result = extractGraphicQuestions({ pages: 1, regions })
    expect(result.questions).toHaveLength(1)
    expect(result.boundOptionGroups).toBe(1)
    const options = result.questions[0]!.options
    expect(options.map((option) => option.key)).toEqual(['A', 'B', 'C', 'D'])
    expect(options.map((option) => option.image)).toEqual([
      'images/a.png',
      'images/b.png',
      'images/c.png',
      'images/d.png'
    ])
    expect(result.notes[0]).toContain('4 个图片选项')
  })

  it('整图版式：单张大图时四选项各引用该图并标注见图', () => {
    const regions: RegionBlock[] = [
      text(0, 137, STEMS[0]!),
      image(0, 180, 220, 810, 700, 'images/whole.png')
    ]
    const result = extractGraphicQuestions({ pages: 1, regions })
    expect(result.singleFigureGroups).toBe(1)
    const options = result.questions[0]!.options
    expect(options).toHaveLength(4)
    expect(options.every((option) => option.image === 'images/whole.png')).toBe(true)
    expect(result.notes[0]).toContain('整图版式')
  })

  it('选项图片不足四张时不丢弃整题，标记人工审核', () => {
    const regions: RegionBlock[] = [
      text(0, 137, STEMS[0]!),
      image(0, 180, 220, 810, 700, 'images/whole.png'),
      image(0, 20, 950, 100, 40, 'images/extra.png')
    ]
    const result = extractGraphicQuestions({ pages: 1, regions })
    expect(result.questions).toHaveLength(1)
    expect(result.incompleteOptionQuestions).toBe(1)
    expect(result.notes[0]).toContain('选项图片不足')
  })

  it('页眉与 discarded 水印不进入题干（页眉需跨页重复，单次出现的正文不动）', () => {
    const regions: RegionBlock[] = []
    for (let page = 0; page < 3; page += 1) {
      regions.push(text(page, 90, '图推700题—— 超格刘义恒'))
      regions.push(text(page, 50, '超格'))
    }
    regions.push({
      type: 'discarded',
      page: 0,
      bbox: [816, 139, 899, 190],
      imgPath: '',
      text: 'G超格'
    })
    regions.push(text(1, 137, STEMS[0]!))
    regions.push(image(1, 180, 220, 810, 700, 'images/whole.png'))
    const result = extractGraphicQuestions({ pages: 3, regions })
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]!.stem).not.toContain('超格刘义恒')
    expect(result.questions[0]!.stem).not.toContain('G超格')
    expect(result.questions[0]!.stem).toContain('从所给的四个选项')
  })

  it('题干图片组保留，未绑定图片被计数', () => {
    const regions: RegionBlock[] = [
      text(0, 137, STEMS[0]!),
      image(0, 180, 220, 810, 700, 'images/q1.png'),
      text(1, 137, STEMS[1]!),
      image(1, 180, 220, 810, 700, 'images/q2.png'),
      image(9, 180, 220, 300, 200, 'images/orphan.png')
    ]
    const result = extractGraphicQuestions({ pages: 10, regions })
    expect(result.stemImageGroups).toBe(2)
    expect(result.unboundImages).toBe(1)
  })
})

describe('mergeGraphicQuestions', () => {
  const opts = {
    subject: 'xingce',
    category: '行测-直导题库',
    sourceFile: '图推.pdf',
    tags: [] as string[]
  }

  it('答案仍只来自解析册钥匙配对；未配到答案保留空答案并带警告', () => {
    const questions = [
      {
        set: 1,
        num: 1,
        stem: '题干一包含图片 ![](images/a.png)',
        options: [{ key: 'A', text: '', image: 'images/a.png' }]
      },
      {
        set: 1,
        num: 2,
        stem: '题干二包含图片 ![](images/b.png)',
        options: [{ key: 'A', text: '', image: 'images/b.png' }]
      }
    ]
    const solutions = new Map([['1-1', { answer: 'C' }]])
    const result = mergeGraphicQuestions(questions, solutions, opts, [
      '整图版式：选项 A-D 印在题干图内'
    ])
    expect(result.items).toHaveLength(2)
    expect(result.paired).toBe(1)
    expect(result.unpaired).toBe(1)
    expect(result.items[0]!.answer).toEqual(['C'])
    expect(result.items[1]!.answer).toEqual([])
    expect(result.itemWarnings[1]?.some((w) => w.includes('未配到参考答案'))).toBe(true)
    expect(result.itemWarnings[0]?.some((w) => w.includes('整图版式'))).toBe(true)
    expect(result.items[0]!.tags).toContain('图形推理')
  })
})
