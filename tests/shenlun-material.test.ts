import { describe, expect, it } from 'vitest'
import {
  CJK_RADICAL_SUPPLEMENT_MAP,
  buildShenlunSheetGrid,
  formatShenlunMaterialParagraphs,
  inspectShenlunMaterialQuality,
  normalizeShenlunText,
  recommendShenlunMaterialIndices,
  splitShenlunMaterialBlocks
} from '../src/shared/shenlun'
import {
  analyzeShenlunBatch,
  runShenlunPreImportGate,
  stitchCrossPaperMaterials
} from '../tools/lib/shenlun-repair.mjs'

const SAMPLE_MATERIAL = [
  '### 材料1\n\n党的十八大以来，我国生态文明建设取得历史性成就，绿色发展是高质量发展的底色。',
  '### 材料2\n\n2012年2月，广东坚持节约资源和保护环境的基本国策，推进绿色低碳发展。',
  '### 材料3\n\n走进位于D县的智能耳机生产企业H电子，办公楼绿植环绕。董事长陈先生建造“绿色工厂”，种植5000多株树木，充分利用植物光合作用吸收二氧化碳。',
  '### 材料4\n\n广东工业绿色发展成效显著，截至2025年6月累计培育国家级绿色工厂490家。',
  '### 材料5\n\n零碳园区是指通过规划、设计、技术、管理等方式，使园区内生产生活活动产生的二氧化碳排放降至“近零”水平。S市在零碳园区建设中面临标准不统一、资金投入大等问题。'
].join('\n\n')

describe('shenlun material splitting & recommendation', () => {
  it('splits 材料1..N headings into blocks', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    expect(blocks).toHaveLength(5)
    expect(blocks[0]?.title).toBe('材料1')
    expect(blocks[0]?.index).toBe(1)
    expect(blocks[2]?.title).toBe('材料3')
    expect(blocks[4]?.index).toBe(5)
  })

  it('matches explicit 给定资料N / 材料N references', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const idx = recommendShenlunMaterialIndices(
      blocks,
      '请根据给定资料2、5，梳理相关做法。',
      undefined,
      '单一题'
    )
    expect(idx).toEqual([1, 4])
  })

  it('matches keyword-relevant blocks when no number is given', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const greenFactory = recommendShenlunMaterialIndices(
      blocks,
      '请根据材料，谈谈“绿色工厂”的“绿”体现在哪些方面。（20分）',
      undefined,
      '单一题'
    )
    expect(greenFactory).toContain(2)

    const zeroCarbon = recommendShenlunMaterialIndices(
      blocks,
      '假如你是S市发展和改革局工作人员，请根据材料，梳理S市零碳园区建设遇到的问题。',
      undefined,
      '单一题'
    )
    expect(zeroCarbon).toEqual([4])
  })

  it('keeps all blocks for 作文题', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const essay = recommendShenlunMaterialIndices(
      blocks,
      '请结合给定材料，围绕“绿色发展是高质量发展的底色”写一篇议论文。',
      undefined,
      '作文题'
    )
    expect(essay).toEqual([])
  })

  it('splits long unformatted material walls into readable paragraphs', () => {
    const sentence =
      '“免陪照护服务呼应了不少患者群体的需求，但要真正达到预期效果，还需要多方合力，有很长的路要走。”记者在走访中也了解到，部分医院对推广免陪照护服务持审慎态度。'
    const wall = sentence.repeat(8)
    const formatted = formatShenlunMaterialParagraphs(wall)
    const paragraphs = formatted.split('\n\n')
    expect(paragraphs.length).toBeGreaterThanOrEqual(3)
    expect(paragraphs.every((p) => p.length >= 100)).toBe(true)
  })

  it('maps text to 25-column answer sheet grid with 100-char marks & newline jumps', () => {
    const grid = buildShenlunSheetGrid('第一行\n第二行', 200, 4)
    expect(grid.rows.length).toBeGreaterThanOrEqual(10)
    expect(grid.rows[0]?.cells[0]?.char).toBe('第')
    expect(grid.rows[0]?.cells[2]?.char).toBe('行')
    expect(grid.rows[0]?.cells[3]?.char).toBe('')
    expect(grid.rows[1]?.cells[0]?.char).toBe('第')
    expect(grid.rows[3]?.hundredMark).toBe('100字')
    expect(grid.rows[7]?.hundredMark).toBe('200字')
    expect(grid.rows[7]?.cells[24]?.isLimitBoundary).toBe(true)
    expect(grid.caretRow).toBe(1)
    expect(grid.caretCol).toBe(0)
  })

  it('follows official Shenlun sheet cell rules for numbers, decimals, percents, letters & line-start punctuation', () => {
    // 1) 数字、小数点、百分号、年份、英文字母与序号占格
    const sample = '655.2万、18%、100%、2025年、12.5%、1.问题、GDP与5G'
    const grid = buildShenlunSheetGrid(sample, 200, 1)
    const nonEmptyCells = grid.rows[0]!.cells.filter((cell) => cell.char)
    expect(nonEmptyCells.map((c) => c.char)).toEqual([
      '65',
      '5.',
      '2',
      '万',
      '、',
      '18%',
      '、',
      '10',
      '0%',
      '、',
      '20',
      '25',
      '年',
      '、',
      '12.',
      '5%',
      '、',
      '1.',
      '问',
      '题',
      '、',
      'GD',
      'P',
      '与',
      '5G'
    ])
    expect(grid.filledCellCount).toBe(25)
    expect(grid.lastFilledCellNumber).toBe(25)
    // 光标停在 "65" 的 '6' 与 '5' 之间时 subOffset 为 0.5
    expect(grid.caretRow).toBe(0)
    expect(grid.caretCol).toBe(0)
    expect(grid.caretSubOffset).toBe(0.5)

    // 2) 行首避头点：第 26 个字符为句号时挤入上一行第 25 格，不占新行首格
    const squeezedGrid = buildShenlunSheetGrid(`${'字'.repeat(25)}。下一行`, 200, 26)
    expect(squeezedGrid.rows[0]?.cells[24]?.char).toBe('字')
    expect(squeezedGrid.rows[0]?.cells[24]?.squeezedPunct).toBe('。')
    expect(squeezedGrid.rows[0]?.cells[24]?.charEndIndex).toBe(26)
    expect(squeezedGrid.rows[1]?.cells[0]?.char).toBe('下')
    expect(squeezedGrid.rows[1]?.cells[0]?.charIndex).toBe(26)
    expect(squeezedGrid.caretRow).toBe(1)
    expect(squeezedGrid.caretCol).toBe(0)

    // 3) 破折号/省略号在行末第 25 格不断行，整体移到下一行前两格
    const dashGrid = buildShenlunSheetGrid(`${'字'.repeat(24)}——继续`, 200, 0)
    expect(dashGrid.rows[0]?.cells[24]?.char).toBe('')
    expect(dashGrid.rows[1]?.cells[0]?.char).toBe('—')
    expect(dashGrid.rows[1]?.cells[1]?.char).toBe('—')
    expect(dashGrid.rows[1]?.cells[2]?.char).toBe('继')

    // 4) 18% 不跨行拆分且整块占 1 格
    const percentWrapGrid = buildShenlunSheetGrid(`${'字'.repeat(24)}18%下`, 200, 0)
    expect(percentWrapGrid.rows[0]?.cells[24]?.char).toBe('18%')
    expect(percentWrapGrid.rows[1]?.cells[0]?.char).toBe('下')
  })
})

describe('shenlun normalization, quality inspection & cross-paper stitching', () => {
  it('normalizes Kangxi & CJK supplement radicals while preserving fullwidth Chinese punctuation', () => {
    const raw = '外来务⼯⼈员⽼程，来到⻘⼭镇：为什么？因为“⻢路⻔前⻓满⻘草”！第10页,共15页'
    const normalized = normalizeShenlunText(raw)
    expect(normalized).toBe('外来务工人员老程，来到青山镇：为什么？因为“马路门前长满青草”！')
    expect(/[\u2e80-\u2fdf]/.test(normalized)).toBe(false)
    expect(Object.keys(CJK_RADICAL_SUPPLEMENT_MAP).length).toBeGreaterThanOrEqual(31)
    expect(normalizeShenlunText('２０２３年ＡＢＣ')).toBe('2023年ABC')
  })

  it('detects incomplete vs verified materials without false positives on valid quotes or dates', () => {
    const trunc = inspectShenlunMaterialQuality(
      '### 材料1\n\n2022年11月17日，建筑工人老程一行来到J市M县诉源治理中心，投诉电力公司拖欠他们13万元工资。青山镇政法委员老黄得知后，立即组织多部门联合调解。经调查了解，该项目存在转包现象，承包人吴某又因故无法及时返回青山镇，最终由电力公司先行垫'
    )
    expect(trunc.level).toBe('incomplete')
    expect(trunc.issues).toContain('段尾腰斩')

    const brokenQuote = inspectShenlunMaterialQuality(
      '### 材料1\n\n何检察官说：“我们准备帮助杨大爷申请司法救助金。“种子法庭”是J市人民法院探索的工作模式，成效显著。'
    )
    expect(brokenQuote.level).toBe('incomplete')
    expect(brokenQuote.issues).toContain('引号残缺')

    const validFull = inspectShenlunMaterialQuality(
      '### 材料1\n\n“我们准备帮助杨大爷申请司法救助金。”何检察官说，本着“事都捋一捋、理都摆一摆、法都讲一讲”的工作思路，J市检察机关持续开展简易听证和上门听证，努力把信访问题在第一时间、第一地点解决到位，切实把矛盾纠纷化解在基层、解决在当地。“种子法庭”是J市H区人民法院2022年探索推行的工作模式，近年来通过组建专门合议庭并遴选“专家型”人民陪审员，有效提升了涉种纠纷调解成功率与审理质效，获得了当地群众与种企的一致好评，推动实现涉种案件办理专业化、专门化。',
      { explanation: '1. 推进基层调解；2. 推行“种子法庭”专业审理。' }
    )
    expect(validFull.level).toBe('verified')
    expect(validFull.issues).toEqual([])

    const validMultiParaQuote = inspectShenlunMaterialQuality(
      '### 材料1\n\n代表在发言中指出：“第一，要推进数字赋能基层治理，建立多部门联动平台，提高响应速度，切实打破部门之间的信息壁垒与数据孤岛，让基层群众少跑腿、好办事，进一步提升基层政务服务的精准化与便利化水平。\n“第二，要坚持源头治理，不断完善人民调解与行政调解衔接机制，组织各方力量深入一线面对面听取诉求、释法说理，把各类矛盾纠纷化解在基层、解决在当地，做到小事不出村、大事不出镇、矛盾不上交，真正筑牢基层和谐稳定的第一道防线。”',
      { explanation: '暂无参考答案' }
    )
    expect(validMultiParaQuote.level).toBe('normal')
    expect(validMultiParaQuote.issues).toEqual([])
  })

  it('stitches dropped lines and truncated tails across shared exam papers safely', () => {
    const hainanBlock = {
      paperId: 215523,
      paperName: '2023年海南C卷',
      idx: 1,
      title: '材料1',
      titleNum: 1,
      text: '外来务工人员小勇居住在J市东江街道鸣山社区，多次发生纠纷。2022年11月17日，建筑工人老程一行来到J市M县诉源治理中心，投诉电力公司拖欠他们13万元工资。青山镇政法委员老黄得知后，立即组织公安、司法、供电等部门对双方涉及的单位、人员进行联合调解。经调查了解，该项目存在转包现象，当时项目款确实还未到账，承包人吴某又因故无法及时返回青山镇。经调解，由电力公司先行垫“种子法庭”是J市H区人民法院2022年探索推行的服务种业的工作模式。H区人民法院荣院长说，今后全区涉种案件也将逐步向该法庭归并，推动实现涉种案件办理专业化、专门化。'
    }
    const ningxiaBlock1 = {
      paperId: 6782129,
      paperName: '2023年宁夏C卷',
      idx: 1,
      title: '材料1',
      titleNum: 1,
      text: '外来务工人员小勇居住在J市东江街道鸣山社区，多次发生纠纷。2022年11月17日，建筑工人老程一行来到J市M县诉源治理中心，投诉电力公司拖欠他们13万元工资。青山镇政目存在转包现象，当时项目款确实还未到账，承包人吴某又因故无法及时返回青山镇。经调解，由电力公司先行垫付老程等人的工资13万元。双方签订调解协议，政府、法庭、司法、公安监督跟进。“种子法庭”是J市H区人民法院2022年探索推行的服务种业的工作模式。H区人民法院荣院长说，今后全区涉种案件也将逐步向该法庭归并，推动实现涉种案件办理专业化、专门化。'
    }
    const ningxiaBlock4 = {
      paperId: 6782129,
      paperName: '2023年宁夏C卷',
      idx: 4,
      title: '材料4',
      titleNum: 4,
      text: '日前，S市表决通过了新修订的《市容环境卫生管理条例》。摆摊不能“一禁了之”，但也绝非“一放了之”。此番对设摊经营的立法疏导，对管理者也提出了更高的要求。比如哪里可以设摊？与居民区的距离多少为好？公共市政设施是否完备？消费纠纷如何调处？辐射人群是否匹'
    }
    const hainanBlock2 = {
      paperId: 215523,
      paperName: '2023年海南C卷',
      idx: 2,
      title: '材料2',
      titleNum: 2,
      text: '日前，S市表决通过了新修订的《市容环境卫生管理条例》。摆摊不能“一禁了之”，但也绝非“一放了之”。此番对设摊经营的立法疏导，对管理者也提出了更高的要求。比如哪里可以设摊？与居民区的距离多少为好？公共市政设施是否完备？消费纠纷如何调处？辐射人群是否匹配？……这都需更精细的管理体系作为支撑。'
    }
    // 负例：完整句末之间的合法省份删节不应被误填
    const abbrevTarget = {
      paperId: 1001,
      paperName: '甲省联考',
      idx: 1,
      title: '材料1',
      titleNum: 1,
      text: '2024年春天，L市高新区大力推动科技成果转化，建设了十余个中试基地。很多科研人员带着专利走向生产线，在本地实现了产业化落地。与此同时，高新区还推出了多项金融支持政策，助力初创企业顺利渡过早期研发关口。'
    }
    const abbrevDonor = {
      paperId: 1002,
      paperName: '乙省联考',
      idx: 1,
      title: '材料1',
      titleNum: 1,
      text: '2024年春天，L市高新区大力推动科技成果转化，建设了十余个中试基地。很多科研人员带着专利走向生产线，在本地实现了产业化落地。其中，张教授团队的环保新材料项目当年就实现了产值突破三千万元。与此同时，高新区还推出了多项金融支持政策，助力初创企业顺利渡过早期研发关口。'
    }

    const res = stitchCrossPaperMaterials([
      hainanBlock,
      ningxiaBlock1,
      ningxiaBlock4,
      hainanBlock2,
      abbrevTarget,
      abbrevDonor
    ])
    const patchedHainan = res.blocks[0]!.text
    const patchedNingxia1 = res.blocks[1]!.text
    const patchedNingxia4 = res.blocks[2]!.text
    const untouchedAbbrev = res.blocks[4]!.text

    expect(patchedHainan).toContain(
      '由电力公司先行垫付老程等人的工资13万元。双方签订调解协议，政府、法庭、司法、公安监督跟进。“种子法庭”'
    )
    expect(patchedNingxia1).toContain('青山镇政法委员老黄得知后')
    expect(patchedNingxia4.endsWith('……这都需更精细的管理体系作为支撑。')).toBe(true)
    expect(untouchedAbbrev).not.toContain('张教授团队')
  })

  it('analyzes batch quality and enforces pre-import gate modes properly', () => {
    const goodQ = {
      id: 'q-good-1',
      paper: '2025年国考',
      material:
        '### 材料1\n\n近年来，各地坚持以人民为中心的发展思想，大力推进基层治理现代化，构建共建共治共享的社会治理格局，通过网格化管理、精细化服务和信息化支撑，及时把矛盾纠纷化解在基层、化解在萌芽状态，不断提升群众的获得感、幸福感和安全感，为经济社会高质量发展提供了坚实保障。同时，各地积极引导社会组织、志愿者、社区居民广泛参与社区议事协商，形成齐抓共管的良好氛围，真正把服务送到群众家门口，让基层治理既有力度又有温度，切实增强群众对社区大家庭的归属感和满意度。',
      explanation: '1. 坚持以人民为中心；2. 推进网格化、精细化与信息化基层治理。'
    }
    const normalQ = {
      id: 'q-normal-1',
      paper: '2025年联考',
      material:
        '### 材料1\n\n随着城市更新步伐加快，不少老旧小区加装了电梯，改造了管网，增设了社区食堂与嵌入式托育服务点，让“一老一小”在家门口就能享受到普惠优质的公共服务，居民对社区的认同感和归属感持续增强，邻里关系也变得越来越融洽和睦。此外，街道还盘活闲置空间建设口袋公园和邻里书屋，丰富了居民业余文化生活，切实增强了老旧小区的宜居性与凝聚力，赢得了辖区居民的普遍赞誉与积极参与，使老旧小区焕发出新的生机与活力，也让城市治理更有温度、更加精细。',
      explanation: '暂无参考答案；可在「申论作答」页配合 AI 批改练习。'
    }
    const badQ = {
      id: 'q-bad-1',
      paper: '2024年联考',
      material:
        '### 材料1\n\n经多方协调，有关部门表示将持续跟踪落实相关举措，但在具体执行环节中仍然存在职责交叉、协同不够顺畅的问题，因此还需要进一步厘清权责边界、健全跨部门协作机制、打通数据共享壁垒，推动各项工作形成工作合力，确保各项改革举措真正落地见效，不断完善考核',
      explanation: '暂无参考答案'
    }

    const report = analyzeShenlunBatch([goodQ, normalQ, badQ])
    expect(report.total).toBe(3)
    expect(report.verified).toBe(1)
    expect(report.normal).toBe(1)
    expect(report.incomplete).toBe(1)
    expect(report.issueCounts.段尾腰斩).toBe(1)

    const logs: string[] = []
    const blocked = runShenlunPreImportGate([goodQ, badQ], {
      maxIncompleteRate: 0.15,
      log: (msg: string) => logs.push(msg)
    })
    expect(blocked.blocked).toBe(true)
    expect(blocked.allowWrite).toBe(false)

    const allowed = runShenlunPreImportGate([goodQ, normalQ], {
      maxIncompleteRate: 0.15,
      log: () => {}
    })
    expect(allowed.blocked).toBe(false)
    expect(allowed.allowWrite).toBe(true)
    expect(allowed.filtered).toHaveLength(2)

    const dryRun = runShenlunPreImportGate([goodQ, badQ], {
      dryRun: true,
      log: () => {}
    })
    expect(dryRun.blocked).toBe(false)
    expect(dryRun.allowWrite).toBe(false)

    const skipped = runShenlunPreImportGate([goodQ, normalQ, badQ], {
      skipIncomplete: true,
      log: () => {}
    })
    expect(skipped.blocked).toBe(false)
    expect(skipped.allowWrite).toBe(true)
    expect(skipped.skippedIncomplete).toBe(1)
    expect(skipped.filtered.map((q: { id: string }) => q.id)).toEqual(['q-good-1', 'q-normal-1'])

    const forced = runShenlunPreImportGate([goodQ, badQ], {
      force: true,
      log: () => {}
    })
    expect(forced.blocked).toBe(false)
    expect(forced.allowWrite).toBe(true)
    expect(forced.filtered).toHaveLength(2)
  })

  it('buildShenlunSheetGrid does not add a ghost blank row after full-row newline and handles surrogate pairs', () => {
    const fullRow = '一'.repeat(25)
    const grid = buildShenlunSheetGrid(`${fullRow}\n二`, 100, 27)
    // 第一行占 25 格，紧接换行不应多出第 2 行空白，故“二”应直接落在第 2 行第 1 格（第 26 格）
    expect(grid.rows[1]?.cells[0]?.char).toBe('二')
    expect(grid.lastFilledCellNumber).toBe(26)

    // 连续两个换行才构成真正的段落空行
    const withBlankLine = buildShenlunSheetGrid(`${fullRow}\n\n二`, 100, 28)
    expect(withBlankLine.rows[1]?.cells[0]?.char).toBe('')
    expect(withBlankLine.rows[2]?.cells[0]?.char).toBe('二')

    // 代理对字符（UTF-16 length=2 但单字形）不应触发 compactLevel=2
    const surrogateGrid = buildShenlunSheetGrid('𠮷字', 100, 3)
    expect(surrogateGrid.rows[0]?.cells[0]?.char).toBe('𠮷')
    expect(surrogateGrid.rows[0]?.cells[0]?.compactLevel).toBe(0)
  })
})
