// 图形推理图片优先通道：版面聚类 + 选项绑定 + 置信度 + 门禁
import { describe, expect, it } from 'vitest'
import {
  bindGraphicOptionsByGeometry,
  extractGraphicQuestions,
  isGraphicCandidate,
  mergeGraphicQuestions
} from '../src/main/services/graphic-import'
import type { RegionBlock, StructuredRegions } from '../src/main/services/import-quality'
import type { ParsedQuestion } from '../src/main/services/question-import'

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

describe('bindGraphicOptionsByGeometry（混合卷图推小题几何绑定）', () => {
  function paperRegions(withLabels = true): StructuredRegions {
    const blocks: RegionBlock[] = [
      text(0, 100, '77.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：'),
      // 题干图形序列（一行 5 张小图）
      ...[0, 1, 2, 3, 4].map((i) => image(0, 60 + i * 150, 170, 120, 100, `images/stem-${i}.png`)),
      // 2×2 选项网格，标签印在图下方
      image(0, 100, 300, 150, 150, 'images/opt-a.png'),
      image(0, 400, 300, 150, 150, 'images/opt-b.png'),
      image(0, 100, 520, 150, 150, 'images/opt-c.png'),
      image(0, 400, 520, 150, 150, 'images/opt-d.png'),
      text(0, 760, '78.下列关于货币的说法正确的是：'),
      text(0, 810, 'A.货币是一般等价物')
    ]
    if (withLabels) {
      blocks.push(
        { type: 'text', page: 0, bbox: [165, 460, 185, 480], imgPath: '', text: 'A' },
        { type: 'text', page: 0, bbox: [465, 460, 485, 480], imgPath: '', text: 'B' },
        { type: 'text', page: 0, bbox: [165, 680, 185, 700], imgPath: '', text: 'C' },
        { type: 'text', page: 0, bbox: [465, 680, 485, 700], imgPath: '', text: 'D' }
      )
    }
    return { pages: 1, regions: blocks }
  }

  function questions(): ParsedQuestion[] {
    return [
      {
        set: 1,
        num: 77,
        stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：\n![](images/stem-0.png)',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' }
        ]
      },
      {
        set: 1,
        num: 78,
        stem: '下列关于货币的说法正确的是：',
        options: [{ key: 'A', text: '货币是一般等价物' }]
      }
    ]
  }

  it('按标签正上方最近的图片块绑定 A-D，题干图重排、非图推题不动', () => {
    const list = questions()
    const summary = bindGraphicOptionsByGeometry(list, paperRegions())
    expect(summary.bound).toBe(1)
    expect(summary.skipped).toBe(0)
    expect(list[0]!.options.map((option) => option.image)).toEqual([
      'images/opt-a.png',
      'images/opt-b.png',
      'images/opt-c.png',
      'images/opt-d.png'
    ])
    expect(list[0]!.options.every((option) => option.text === '')).toBe(true)
    expect(list[0]!.stem.match(/images\/stem-\d\.png/g)).toHaveLength(5)
    expect(list[0]!.stem).not.toContain('opt-')
    expect(summary.notes.get('1-77')?.[0]).toContain('几何匹配')
    expect(list[1]!.options).toEqual([{ key: 'A', text: '货币是一般等价物' }])
  })

  it('无标签块时按顺序取末 4 张尺寸相近的图作选项并降低置信度', () => {
    const list = questions()
    const summary = bindGraphicOptionsByGeometry(list, paperRegions(false))
    expect(summary.partial).toBe(1)
    expect(list[0]!.options).toHaveLength(4)
    expect(summary.notes.get('1-77')?.[0]).toContain('置信度较低')
  })

  it('题号在版面块中找不到时跳过并留提示', () => {
    const list = questions()
    const summary = bindGraphicOptionsByGeometry(list, { pages: 1, regions: [] })
    expect(summary.skipped).toBe(1)
    expect(list[0]!.options).toHaveLength(2)
  })

  it('同文件多套题库：notes 按 set-num 键控，第二套绑到第二处版面而非覆盖第一套', () => {
    // 两套各一道 num=77 图推题：若只按 num 索引，第二套会映射回第一套的版面位置
    const regions: RegionBlock[] = []
    for (const page of [0, 1]) {
      regions.push(
        text(page, 100, '77.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：')
      )
      for (let i = 0; i < 5; i += 1)
        regions.push(image(page, 60 + i * 150, 170, 120, 100, `images/p${page}-stem-${i}.png`))
      regions.push(image(page, 100, 300, 150, 150, `images/p${page}-opt-a.png`))
      regions.push(image(page, 400, 300, 150, 150, `images/p${page}-opt-b.png`))
      regions.push(image(page, 100, 520, 150, 150, `images/p${page}-opt-c.png`))
      regions.push(image(page, 400, 520, 150, 150, `images/p${page}-opt-d.png`))
      regions.push({ type: 'text', page, bbox: [165, 460, 185, 480], imgPath: '', text: 'A' })
      regions.push({ type: 'text', page, bbox: [465, 460, 485, 480], imgPath: '', text: 'B' })
      regions.push({ type: 'text', page, bbox: [165, 680, 185, 700], imgPath: '', text: 'C' })
      regions.push({ type: 'text', page, bbox: [465, 680, 485, 700], imgPath: '', text: 'D' })
      regions.push(text(page, 780, '78.普通文字题的题干'))
    }
    const list: ParsedQuestion[] = [1, 2].flatMap((set) => [
      {
        set,
        num: 77,
        stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' }
        ]
      },
      { set, num: 78, stem: '普通文字题的题干', options: [{ key: 'A', text: '文字选项' }] }
    ])
    const summary = bindGraphicOptionsByGeometry(list, { pages: 2, regions })
    expect(summary.bound).toBe(2)
    expect(list[0]!.options.map((option) => option.image)).toEqual([
      'images/p0-opt-a.png',
      'images/p0-opt-b.png',
      'images/p0-opt-c.png',
      'images/p0-opt-d.png'
    ])
    expect(list[2]!.options.map((option) => option.image)).toEqual([
      'images/p1-opt-a.png',
      'images/p1-opt-b.png',
      'images/p1-opt-c.png',
      'images/p1-opt-d.png'
    ])
    expect(summary.notes.get('1-77')?.[0]).toContain('几何匹配')
    expect(summary.notes.get('2-77')?.[0]).toContain('几何匹配')
  })

  it('漂移题号兜底：行首无题号时按块内漂移题号定位，上一题终止边界正确', () => {
    // 版面引擎把第二题题号挤进上一段行尾后，regions 文本块行首没有 "2."：
    // 漂移块（行中含 "2."）之后才是第二题的选项图
    const regions: RegionBlock[] = [
      text(0, 100, '1.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：'),
      ...[0, 1, 2, 3, 4].map((i) => image(0, 60 + i * 150, 170, 120, 100, `images/s-${i}.png`)),
      image(0, 100, 340, 150, 150, 'images/q1-a.png'),
      image(0, 400, 340, 150, 150, 'images/q1-b.png'),
      image(0, 100, 560, 150, 150, 'images/q1-c.png'),
      image(0, 400, 560, 150, 150, 'images/q1-d.png'),
      { type: 'text', page: 0, bbox: [165, 500, 185, 520], imgPath: '', text: 'A' },
      { type: 'text', page: 0, bbox: [465, 500, 485, 520], imgPath: '', text: 'B' },
      { type: 'text', page: 0, bbox: [165, 720, 185, 740], imgPath: '', text: 'C' },
      { type: 'text', page: 0, bbox: [465, 720, 485, 740], imgPath: '', text: 'D' },
      // 题号漂移块：行首是上一段文字，"2." 出现在行中，其后是第二题题干开头
      text(0, 800, '上一题解析收尾。2.从所给图形中选出最合适的一项：'),
      image(0, 100, 860, 150, 150, 'images/q2-a.png'),
      image(0, 400, 860, 150, 150, 'images/q2-b.png'),
      image(0, 100, 1080, 150, 150, 'images/q2-c.png'),
      image(0, 400, 1080, 150, 150, 'images/q2-d.png'),
      { type: 'text', page: 0, bbox: [165, 1020, 185, 1040], imgPath: '', text: 'A' },
      { type: 'text', page: 0, bbox: [465, 1020, 485, 1040], imgPath: '', text: 'B' },
      { type: 'text', page: 0, bbox: [165, 1240, 185, 1260], imgPath: '', text: 'C' },
      { type: 'text', page: 0, bbox: [465, 1240, 485, 1260], imgPath: '', text: 'D' },
      text(1, 100, '3.普通文字题')
    ]
    const list: ParsedQuestion[] = [
      {
        set: 1,
        num: 1,
        stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' }
        ]
      },
      {
        set: 1,
        num: 2,
        stem: '从所给图形中选出最合适的一项：',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' }
        ]
      },
      { set: 1, num: 3, stem: '普通文字题', options: [{ key: 'A', text: '文字选项' }] }
    ]
    const summary = bindGraphicOptionsByGeometry(list, { pages: 2, regions })
    // 第一题的跨度在漂移块处终止：只绑定自己的 q1 图，不再吞掉第二题的 q2 图
    expect(summary.bound).toBe(2)
    expect(list[0]!.options.map((option) => option.image)).toEqual([
      'images/q1-a.png',
      'images/q1-b.png',
      'images/q1-c.png',
      'images/q1-d.png'
    ])
    expect(list[1]!.options.map((option) => option.image)).toEqual([
      'images/q2-a.png',
      'images/q2-b.png',
      'images/q2-c.png',
      'images/q2-d.png'
    ])
    // 第一题题干保留 5 张题干图
    expect(list[0]!.stem.match(/images\/s-\d\.png/g)).toHaveLength(5)
    expect(list[0]!.stem).not.toContain('q2-')
  })

  it('小数开头的行（1.5亿元）不构成题号锚点', () => {
    const regions: RegionBlock[] = [
      // 小数行在真锚点之前：若被当成 num=1 锚点，第一题的跨度会前移吞掉诱饵图
      text(0, 100, '1.5亿元的项目投资需要严格审计，从所给的四个选项中选择正确的一项：'),
      image(0, 60, 170, 150, 150, 'images/decoy.png'),
      text(0, 400, '1.真正的图推题干，从所给的四个选项中，使之呈现一定的规律性：'),
      image(0, 100, 560, 150, 150, 'images/fig-a.png'),
      image(0, 400, 560, 150, 150, 'images/fig-b.png'),
      image(0, 100, 780, 150, 150, 'images/fig-c.png'),
      image(0, 400, 780, 150, 150, 'images/fig-d.png'),
      { type: 'text', page: 0, bbox: [165, 720, 185, 740], imgPath: '', text: 'A' },
      { type: 'text', page: 0, bbox: [465, 720, 485, 740], imgPath: '', text: 'B' },
      { type: 'text', page: 0, bbox: [165, 940, 185, 960], imgPath: '', text: 'C' },
      { type: 'text', page: 0, bbox: [465, 940, 485, 960], imgPath: '', text: 'D' }
    ]
    const list: ParsedQuestion[] = [
      {
        set: 1,
        num: 1,
        stem: '真正的图推题干，从所给的四个选项中，使之呈现一定的规律性：',
        options: [
          { key: 'A', text: 'A' },
          { key: 'B', text: 'B' }
        ]
      }
    ]
    const summary = bindGraphicOptionsByGeometry(list, { pages: 1, regions })
    expect(summary.bound).toBe(1)
    expect(list[0]!.options.map((option) => option.image)).toEqual([
      'images/fig-a.png',
      'images/fig-b.png',
      'images/fig-c.png',
      'images/fig-d.png'
    ])
    expect(list[0]!.stem).not.toContain('decoy')
  })

  it('双栏版面按"左栏→右栏"排序，右栏题号的图片不被左栏锚点吞掉', () => {
    // 左栏：题 77；右栏：题 78（栏内窄锚点块，页宽 900、中线 450）；
    // 选项图纵排、标签印在图下方（与单栏网格版式的区别：锚点块分落两栏）
    const regions: RegionBlock[] = [
      {
        type: 'text',
        page: 0,
        bbox: [40, 100, 400, 146],
        imgPath: '',
        text: '77.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：'
      },
      image(0, 60, 170, 150, 150, 'images/left-stem.png'),
      image(0, 60, 340, 150, 150, 'images/left-a.png'),
      image(0, 60, 560, 150, 150, 'images/left-b.png'),
      image(0, 60, 780, 150, 150, 'images/left-c.png'),
      image(0, 60, 1000, 150, 150, 'images/left-d.png'),
      { type: 'text', page: 0, bbox: [125, 505, 145, 525], imgPath: '', text: 'A' },
      { type: 'text', page: 0, bbox: [125, 725, 145, 745], imgPath: '', text: 'B' },
      { type: 'text', page: 0, bbox: [125, 945, 145, 965], imgPath: '', text: 'C' },
      { type: 'text', page: 0, bbox: [125, 1165, 145, 1185], imgPath: '', text: 'D' },
      // 右栏题 78 的 y 坐标与左栏题号相同：无分栏排序时 78 锚点与 77 交错，跨度边界错乱
      {
        type: 'text',
        page: 0,
        bbox: [470, 100, 830, 146],
        imgPath: '',
        text: '78.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：'
      },
      image(0, 480, 170, 150, 150, 'images/right-stem.png'),
      image(0, 480, 340, 150, 150, 'images/right-a.png'),
      image(0, 480, 560, 150, 150, 'images/right-b.png'),
      image(0, 480, 780, 150, 150, 'images/right-c.png'),
      image(0, 480, 1000, 150, 150, 'images/right-d.png'),
      { type: 'text', page: 0, bbox: [545, 505, 565, 525], imgPath: '', text: 'A' },
      { type: 'text', page: 0, bbox: [545, 725, 565, 745], imgPath: '', text: 'B' },
      { type: 'text', page: 0, bbox: [545, 945, 565, 965], imgPath: '', text: 'C' },
      { type: 'text', page: 0, bbox: [545, 1165, 565, 1185], imgPath: '', text: 'D' }
    ]
    const list: ParsedQuestion[] = [77, 78].map((num) => ({
      set: 1,
      num,
      stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
      options: [
        { key: 'A', text: 'A' },
        { key: 'B', text: 'B' }
      ]
    }))
    const summary = bindGraphicOptionsByGeometry(list, { pages: 1, regions })
    expect(summary.bound).toBe(2)
    expect(list[0]!.options.map((option) => option.image)).toEqual([
      'images/left-a.png',
      'images/left-b.png',
      'images/left-c.png',
      'images/left-d.png'
    ])
    expect(list[1]!.options.map((option) => option.image)).toEqual([
      'images/right-a.png',
      'images/right-b.png',
      'images/right-c.png',
      'images/right-d.png'
    ])
  })
})
