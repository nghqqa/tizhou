import { describe, expect, it } from 'vitest'
import type { Question } from '../src/shared/contracts'
import {
  calibrateConstructedEvaluation,
  computeShenlunTierLabel,
  convertToExamScore,
  evaluateShenlunLocally,
  inspectShenlunAnswerMetrics,
  parseShenlunStemRubric
} from '../src/shared/shenlun-rubric'

function makeEssayPrompt(partial: Partial<Question> = {}): Question {
  return {
    id: 'sl-test-1',
    subject: 'shenlun',
    category: '单一题',
    type: 'essay',
    stem: '请根据给定资料1，概括S省在帮扶“新农人”工作中的主要做法。（15分）要求：全面、准确、有条理，不超过200字。',
    options: [],
    answer: [],
    explanation: '暂无参考答案',
    difficulty: 3,
    source: '测试',
    tags: [],
    contentHash: 'sl-hash-1',
    ...partial
  }
}

describe('shenlun-rubric 真考评分细则解析与校准', () => {
  it('parseShenlunStemRubric 准确识别题型细分、题面满分、字数、指定标题与公文四级格式', () => {
    const summarize = parseShenlunStemRubric(
      '请根据给定资料1，概括S省帮扶新农人的主要做法。（15分）不超过200字。',
      '单一题'
    )
    expect(summarize.questionType).toBe('单一题')
    expect(summarize.subType).toBe('归纳概括')
    expect(summarize.fullScore).toBe(15)
    expect(summarize.wordLimit?.max).toBe(200)
    expect(summarize.requiresTitle).toBe(false)

    const measure = parseShenlunStemRubric(
      '请先概括当地基层治理存在的突出问题，再提出具体整改对策。（20分）不超过350字。',
      '单一题'
    )
    expect(measure.subType).toBe('提出对策')
    expect(measure.requiresProblemBeforeMeasure).toBe(true)

    const fullDoc = parseShenlunStemRubric(
      '请以D市市场监管局的名义，向全市网络直播从业人员撰写一份倡议书。（25分）篇幅400字左右。',
      '公文题'
    )
    expect(fullDoc.docFormatLevel).toBe('full')
    expect(fullDoc.fullScore).toBe(25)
    expect(fullDoc.requiresTitle).toBe(true)

    const semiDoc = parseShenlunStemRubric(
      '请根据给定资料撰写一份在全市经验交流会上的讲话稿。（25分）不超过500字。',
      '公文题'
    )
    expect(semiDoc.docFormatLevel).toBe('semi')

    const titleOnlyDoc = parseShenlunStemRubric(
      '请以“乡村运营激活山乡经济”为题，撰写一份发言提纲。（25分）不超过400字。',
      '公文题'
    )
    expect(titleOnlyDoc.docFormatLevel).toBe('title-only')
    expect(titleOnlyDoc.requiredTitle).toBe('乡村运营激活山乡经济')

    const exemptDoc = parseShenlunStemRubric(
      '请起草一份倡议书，不写抬头和落款，字数不超过300字。（20分）',
      '公文题'
    )
    expect(exemptDoc.docFormatLevel).toBe('none')
    expect(exemptDoc.requiresTitle).toBe(false)

    const essay = parseShenlunStemRubric(
      '请围绕“投入与反哺应该是聚力融合的一场双向奔赴”这一主题，自拟题目，写一篇文章。（40分）字数800-1000字。',
      '作文题'
    )
    expect(essay.questionType).toBe('作文题')
    expect(essay.subType).toBe('文章写作')
    expect(essay.fullScore).toBe(40)
    expect(essay.requiredTitle).toBeUndefined()
    expect(essay.requiresTitle).toBe(true)
  })

  it('inspectShenlunAnswerMetrics 核查实考占格、公文格式、指定标题与材料照搬度', () => {
    const fullDocRubric = parseShenlunStemRubric(
      '请撰写一份倡议书。（25分）不超过300字。',
      '公文题'
    )
    const missingDocMetrics = inspectShenlunAnswerMetrics(
      '1. 严守底线规范经营。2. 坚持诚信带货。',
      fullDocRubric
    )
    expect(missingDocMetrics.hasTitle).toBe(false)
    expect(missingDocMetrics.hasSalutation).toBe(false)
    expect(missingDocMetrics.hasSignOff).toBe(false)
    expect(missingDocMetrics.hardPenalties.some((p) => p.includes('标题'))).toBe(true)
    expect(missingDocMetrics.hardPenalties.some((p) => p.includes('称谓'))).toBe(true)
    expect(missingDocMetrics.hardPenalties.some((p) => p.includes('落款'))).toBe(true)

    const completeFullDoc = inspectShenlunAnswerMetrics(
      [
        '规范网络直播行为倡议书',
        '全市网络直播从业人员：',
        '一、坚持合法合规经营，严格履行资质审核义务。',
        '二、守牢食品安全底线，杜绝虚假宣传行为。',
        'D市市场监管局',
        '2026年11月28日'
      ].join('\n'),
      fullDocRubric
    )
    expect(completeFullDoc.hasTitle).toBe(true)
    expect(completeFullDoc.hasSalutation).toBe(true)
    expect(completeFullDoc.hasSignOff).toBe(true)
    expect(completeFullDoc.hardPenalties).toEqual([])

    const material =
      '近年来，某市持续深化基层网格化治理改革，推动公安交警、城管执法、市场监管力量下沉社区一线。' +
      '依托智慧城市运行管理中心，打通视频监控、工单派发、群众随手拍等十二类数据接口，实现问题五分钟内响应、两小时内处置。' +
      '同时建立“吹哨报到”考核机制与群众满意度评价台账，完善网格员激励补贴与社区微更新专项资金制度，引入社会组织和专业社工协同参与社区协商议事与矛盾调解，让群众真正参与到日常监督和共建共治中，显著提升了公共服务效能。'
    const copiedAnswer = '关于城市治理\n\n' + material + material
    const essayRubric = parseShenlunStemRubric(
      '结合给定资料，自拟题目，写一篇议论文。（40分）800-1000字。',
      '作文题'
    )
    const copiedMetrics = inspectShenlunAnswerMetrics(copiedAnswer, essayRubric, material)
    expect(copiedMetrics.materialCopyRatio).toBeGreaterThanOrEqual(0.65)
    expect(copiedMetrics.residualEssay).toBe(true)
    expect(copiedMetrics.hardPenalties.some((p) => p.includes('残文'))).toBe(true)
    expect(copiedMetrics.hardPenalties.some((p) => p.includes('照搬材料'))).toBe(true)
  })

  it('calibrateConstructedEvaluation 对残文与过度照搬硬封顶，折算题面分但不误伤单维度 mock', () => {
    const essayRubric = parseShenlunStemRubric(
      '结合给定资料，自拟题目写一篇文章。（40分）字数800-1000字。',
      '作文题'
    )
    const shortMetrics = inspectShenlunAnswerMetrics(
      '标题\n\n只写了寥寥三十余字作为残文示例内容。',
      essayRubric
    )
    const calibratedShort = calibrateConstructedEvaluation(
      {
        score: 82,
        dimensions: [
          { name: '要点覆盖', score: 80, comment: '有观点' },
          { name: '结构组织', score: 84, comment: '清晰' },
          { name: '表达规范', score: 82, comment: '通顺' }
        ],
        summary: '立意不错。',
        suggestions: ['补充论证']
      },
      essayRubric,
      shortMetrics
    )
    expect(calibratedShort.score).toBe(28)
    expect(calibratedShort.summary).toContain('封顶')
    expect(calibratedShort.summary).toContain('/40')
    expect(calibratedShort.rubricMeta.tierLabel).toBe('四类文')
    expect(calibratedShort.rubricMeta.convertedScore).toBe(convertToExamScore(28, 40))

    // 单维度短内容 mock 不被误校准或误封顶
    const simpleRubric = parseShenlunStemRubric('流式降级测试', undefined)
    const simpleMetrics = inspectShenlunAnswerMetrics(
      '这是一段超过二十个字的申论作答内容用于验证重试重置流式预览行为。',
      simpleRubric
    )
    const untouched = calibrateConstructedEvaluation(
      {
        score: 86,
        dimensions: [{ name: '要点覆盖', score: 86, comment: '完整' }],
        summary: '总体良好',
        suggestions: ['继续保持']
      },
      simpleRubric,
      simpleMetrics
    )
    expect(untouched.score).toBe(86)
    expect(untouched.summary).toBe('总体良好')
    expect(computeShenlunTierLabel(80, '作文题')).toBe('一类文')
  })

  it('evaluateShenlunLocally 支持 1000 字大作文不误扣且可从解析提取要点进行词元比对', () => {
    const essayPrompt = makeEssayPrompt({
      category: '作文题',
      stem: '结合给定资料，自拟题目，写一篇议论性文章。（40分）要求：观点明确，结构完整，字数800-1000字。',
      material:
        '推动高质量发展既要靠技术创新驱动产业升级，也要依托完善的人才培养机制、营商环境优化与公共服务均衡化协同发力，形成持久内生动力。' +
        '只有让基层治理更加精细、法治保障更加有力、社会参与更加广泛，发展的成果才能真正惠及人民群众。'.repeat(
          2
        )
    })
    const paragraph =
      '当前推动高质量发展正处在转型升级的关键阶段，必须坚持创新驱动与制度供给双轮协同，破除制约要素流动的体制障碍，激发各类经营主体的内生动力与创造活力。' +
      '一方面，要紧扣科技自立自强这一战略基点，完善产学研协同转化平台，让科研成果顺畅落地产业链一线；' +
      '另一方面，要把优化营商环境作为持久抓手，健全公平竞争与法治保障体系，增强企业长期投资的稳定预期，让群众在高质量发展中共享更加普惠均衡的公共服务成果。'
    const fullEssay = [
      '以系统思维筑牢高质量发展根基',
      paragraph,
      `首先，必须强化核心技术攻关与人才梯队支撑。${paragraph}`,
      `其次，必须持续深化政务服务改革与法治保障。${paragraph}`,
      `再次，必须着眼基层精细化治理与社会多元共治协同发力，完善公共服务均衡供给机制。${paragraph.slice(0, 140)}`,
      '综上所述，唯有统筹技术创新、制度改革与民生保障协同推进，方能筑牢高质量发展根基并实现行稳致远。'
    ].join('\n')

    const evalEssay = evaluateShenlunLocally('p-essay', fullEssay, essayPrompt)
    expect(evalEssay.provider).toBe('local-rubric')
    expect(evalEssay.rubricMeta?.wordCount).toBeGreaterThanOrEqual(750)
    expect(evalEssay.dimensions.find((d) => d.name === '表达规范')?.score).toBeGreaterThanOrEqual(
      80
    )
    expect(evalEssay.rubricMeta?.fullScore).toBe(40)

    const expPrompt = makeEssayPrompt({
      category: '单一题',
      stem: '根据给定资料1，概括该市推进数字治理的主要做法。（15分）不超过200字。',
      explanation: [
        '参考要点：',
        '1. 搭建智慧平台，打通多部门数据共享接口。',
        '2. 实行网格化管理，推动执法力量下沉社区。',
        '3. 建立考核评价机制，引入群众监督反馈。'
      ].join('\n')
    })
    const goodDraft =
      '1. 搭建智慧管理平台，打通多部门数据接口实现共享。\n2. 推进网格化服务，组织执法力量下沉社区一线。\n3. 健全考核台账，吸纳群众监督评价反馈。'
    const weakDraft = '我们要高度重视，不断加大力度，进一步推进相关工作，努力取得更好的发展成效。'
    const goodEval = evaluateShenlunLocally('p-exp', goodDraft, expPrompt)
    const weakEval = evaluateShenlunLocally('p-exp', weakDraft, expPrompt)
    expect(goodEval.score).toBeGreaterThan(weakEval.score + 15)
    expect(goodEval.dimensions[0]?.comment).toContain('等效命中')
  })
})
