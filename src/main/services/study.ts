import { randomUUID } from 'node:crypto'
import type {
  AiAskResult,
  AiMessage,
  ConstructedEvaluation,
  DiagnosisResult,
  LearningPlan,
  LearningPlanItem,
  PracticeSelection,
  Question,
  QuestionFilter
} from '../../shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '../../shared/prompts'
import {
  recommendShenlunMaterialIndices,
  splitShenlunMaterialBlocks,
  type ShenlunQuestionType
} from '../../shared/shenlun'
import {
  calibrateConstructedEvaluation,
  evaluateShenlunLocally,
  extractReferencePoints,
  inspectShenlunAnswerMetrics,
  parseShenlunStemRubric
} from '../../shared/shenlun-rubric'
import {
  XINGCE_MODULE_ORDER,
  expandCategoryAliases,
  normalizeXingceModule
} from '../../shared/study-constants'
import { AiService } from './ai'
import { DatabaseService } from './database'
import {
  parseConstructedEvaluationJson,
  parseConstructedEvaluationMarkdown
} from './shenlun-eval-parser'
import { clamp, now, sha256Hex } from '../utils/common'

function dateFromToday(days: number): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

function shuffled<T>(items: T[]): T[] {
  const output = [...items]
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(Math.random() * (index + 1))
    const value = output[index]
    output[index] = output[selected]!
    output[selected] = value!
  }
  return output
}

// ---- 组题抽题：资料分析 5 题套与判断推理「一拖五」材料组锁死整组连续，严禁拆散、打乱或跨模块混组 ----

export const DATA_ANALYSIS_GROUP_SIZE = 5
export const MAX_LOCKED_REASONING_GROUP_SIZE = 5
export const MAX_CLEAN_NON_DA_GROUP_SIZE = 6

export function isDataAnalysisCategory(category: string): boolean {
  return category === '资料分析' || category.startsWith('资料分析')
}

export function isDataAnalysisQuestion(question: Question): boolean {
  return isDataAnalysisCategory(question.category)
}

export function isLockedDataAnalysisUnit(unit: Question[]): boolean {
  return unit.length === DATA_ANALYSIS_GROUP_SIZE && unit.every(isDataAnalysisQuestion)
}

export function isReasoningCategory(category: string): boolean {
  return category === '判断推理' || category.startsWith('判断推理')
}

export function isReasoningQuestion(question: Question): boolean {
  return isReasoningCategory(question.category)
}

export function isLockedReasoningGroupUnit(unit: Question[]): boolean {
  return (
    unit.length >= 2 &&
    unit.length <= MAX_LOCKED_REASONING_GROUP_SIZE &&
    unit.every(isReasoningQuestion) &&
    unit.every((q) => Boolean(normalizeMaterialForGroup(q.material)))
  )
}

export function isLockedMaterialUnit(unit: Question[]): boolean {
  return isLockedDataAnalysisUnit(unit) || isLockedReasoningGroupUnit(unit)
}

const STEM_PREFIX_STRIP_RE = /^(?:[（(][^）)\n]{1,36}[）)]\s*)+/
const EXPL_REF_SHARED_COND_RE =
  /条件\s*[（(]?\s*[1-6一二三四五六①②③④⑤⑥]\s*[）)]?|(?:根据|结合|由|代入)(?:题干)?条件/
const SELF_CONTAINED_REASONING_STEM_RE =
  /!\[|①|。|[；;]|是指|指的是|指一种|是一种|根据上述定义|不属于.{1,16}的是|对于\s*[（(]|相当于|[:：].*[:：]|由此(?:可以|可)?推|由此可知|据此|根据以上论述|位置关系|已知|满足以下|条件如下|如下[:：]|（1）|\(1\)|某[地市省县村镇校厂院部组队会公司机构单位超市商场餐厅饭店学校医院高中小学大学科研]|(?:甲|乙|丙|丁).{0,10}(?:说|表示|预测|猜测|认为)/
const DANGLING_REASONING_STEM_RE =
  /(?:不可能排在第|可能排在第|中间最多可能隔|不能安排在第|不能排在第|安排在任意一天|不能开设两次|开设两次|哪一类商品|哪两类商品|按照从前[到完]后|以下哪项安排是不可能的|下列哪两个部门不可能|关于分管情况|分管的部门多于|符合上述(?:要求|条件))/

/** 识别缺少共用材料的「一拖五」孤题，避免脱离背景条件无法作答 */
export function isOrphanReasoningGroupQuestion(question: Question): boolean {
  if (question.subject !== 'xingce' || !isReasoningQuestion(question)) return false
  if (normalizeMaterialForGroup(question.material) || question.groupId?.trim()) return false
  const cleanStem = (question.stem ?? '').replace(STEM_PREFIX_STRIP_RE, '').trim()
  if (!cleanStem || cleanStem.length > 60) return false
  if (SELF_CONTAINED_REASONING_STEM_RE.test(cleanStem)) return false
  return (
    EXPL_REF_SHARED_COND_RE.test(question.explanation ?? '') ||
    DANGLING_REASONING_STEM_RE.test(cleanStem)
  )
}

function normalizeMaterialForGroup(material?: string): string {
  return (material ?? '').replace(/\r\n?/g, '\n').trim()
}

function extractQuestionOrder(question: Question): number {
  if (typeof question.groupOrder === 'number' && Number.isFinite(question.groupOrder)) {
    return question.groupOrder
  }
  if (Array.isArray(question.papers) && question.papers.length > 0) {
    const matched = question.paper
      ? question.papers.find(
          (entry) =>
            entry.paper === question.paper &&
            typeof entry.order === 'number' &&
            Number.isFinite(entry.order)
        )
      : undefined
    const fallbackPaper =
      matched ??
      question.papers.find(
        (entry) => typeof entry.order === 'number' && Number.isFinite(entry.order)
      )
    if (fallbackPaper) return fallbackPaper.order
  }
  const match = question.id.match(/(?:_q|-q|_)(\d+)$/i)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

export function buildQuestionUnits(pool: Question[]): Question[][] {
  const groups = new Map<string, Question[]>()
  const units: Question[][] = []
  for (const question of pool) {
    const normMat = normalizeMaterialForGroup(question.material)
    // 组键强制隔离 category + 完整材料哈希（避免历史导入 groupId 跨模块/跨材料碰撞）；
    // 无显式 groupId 时不再限制材料长度，确保纯图片材料也能准确聚组
    const groupKey = question.groupId
      ? normMat
        ? `grp:${question.category}\u0000${question.groupId}\u0000${sha256Hex(normMat)}`
        : `grp:${question.category}\u0000${question.groupId}`
      : normMat
        ? `mat:${question.category}\u0000${question.paper || question.source || ''}\u0000${sha256Hex(normMat)}`
        : ''
    if (groupKey) {
      let list = groups.get(groupKey)
      if (!list) {
        list = []
        groups.set(groupKey, list)
        units.push(list)
      }
      list.push(question)
    } else {
      units.push([question])
    }
  }
  for (const unit of units) {
    if (unit.length > 1) {
      unit.sort(
        (a, b) => extractQuestionOrder(a) - extractQuestionOrder(b) || a.id.localeCompare(b.id)
      )
    }
  }
  return units
}

export function normalizeDataAnalysisUnits(units: Question[][], strict = true): Question[][] {
  const normalized = units.map((unit) =>
    unit.length > DATA_ANALYSIS_GROUP_SIZE && unit.every(isDataAnalysisQuestion)
      ? unit.slice(0, DATA_ANALYSIS_GROUP_SIZE)
      : unit
  )
  if (!strict) return normalized
  const hasCompleteDataAnalysis = normalized.some(isLockedDataAnalysisUnit)
  // 真实题库下严禁抽出不足 5 题的资料分析残组或散题；仅当池内尚无任何完整 5 题套时才豁免内置示例单题（builtin-*），
  // 若纯资料分析池中连 1 套完整 5 题组都没有则保留兜底以免空库报错
  const filtered = normalized.filter(
    (unit) =>
      !unit.every(isDataAnalysisQuestion) ||
      unit.length === DATA_ANALYSIS_GROUP_SIZE ||
      (!hasCompleteDataAnalysis && unit.length === 1 && unit[0]!.id.startsWith('builtin-'))
  )
  return filtered.length > 0 ? filtered : normalized
}

export function normalizePracticeUnits(units: Question[][], strict = true): Question[][] {
  let result = normalizeDataAnalysisUnits(units, strict)
  if (!strict) return result
  const withoutOrphans = result.filter(
    (unit) => !(unit.length === 1 && isOrphanReasoningGroupQuestion(unit[0]!))
  )
  if (withoutOrphans.length > 0) result = withoutOrphans

  const withoutPolluted = result.filter(
    (unit) =>
      !(
        unit.length > MAX_CLEAN_NON_DA_GROUP_SIZE &&
        !unit.every(isDataAnalysisQuestion) &&
        unit.every((q) => Boolean(normalizeMaterialForGroup(q.material)))
      )
  )
  return withoutPolluted.length > 0 ? withoutPolluted : result
}

// 依次整组收取；锁定材料组（资料分析 5 题套 / 判断推理一拖五）严禁拆散或截断，放不下时先跳过再用其他单元回填
export function takeUnits(units: Question[][], count: number): Question[] {
  const picked: Question[] = []
  const skipped: Question[][] = []
  for (const unit of units) {
    if (picked.length >= count) break
    if (
      picked.length + unit.length <= count ||
      (picked.length === 0 && !isLockedMaterialUnit(unit))
    ) {
      picked.push(...unit)
    } else {
      skipped.push(unit)
    }
  }
  for (const unit of skipped) {
    if (picked.length >= count) break
    if (picked.length + unit.length <= count) picked.push(...unit)
  }
  if (picked.length === 0 && skipped.length > 0) {
    const lockedFallback = skipped.find(isLockedMaterialUnit)
    if (lockedFallback) return [...lockedFallback]
    return skipped[0]!.slice(0, count)
  }
  return picked.slice(0, count)
}

/** 按行测五大模块标准顺序对抽取后的题目重新连排，并保持材料组内 1→N 顺序连续 */
export function orderExamQuestionsByModule(questions: Question[]): Question[] {
  if (questions.length <= 1) return [...questions]
  const moduleRank = (category: string): number => {
    const idx = (XINGCE_MODULE_ORDER as readonly string[]).indexOf(normalizeXingceModule(category))
    return idx >= 0 ? idx : XINGCE_MODULE_ORDER.length
  }
  return buildQuestionUnits(questions)
    .map((unit, originalIndex) => ({
      unit,
      rank: moduleRank(unit[0]!.category),
      originalIndex
    }))
    .sort((a, b) => a.rank - b.rank || a.originalIndex - b.originalIndex)
    .flatMap((entry) => entry.unit)
}

const EXPLICIT_MATERIAL_REF_IN_STEM_RE =
  /(?:给定资料|给定材料|资料|材料)\s*[一二三四五六七八九十\d]+/
const FULL_MATERIAL_SCOPE_RE = /(?:全部|所有|整篇|各则|上述|以上)\s*(?:给定)?(?:资料|材料)/

function selectEvaluationMaterial(
  material: string,
  stem: string,
  explanation: string,
  questionType: ShenlunQuestionType,
  compactMode: boolean
): string {
  const trimmed = material.trim()
  if (!trimmed) return ''

  const blocks = splitShenlunMaterialBlocks(trimmed)
  if (!compactMode) {
    if (trimmed.length <= 8000 || questionType === '作文题') return trimmed
    if (
      blocks.length >= 2 &&
      EXPLICIT_MATERIAL_REF_IN_STEM_RE.test(stem) &&
      !FULL_MATERIAL_SCOPE_RE.test(stem)
    ) {
      const indices = recommendShenlunMaterialIndices(blocks, stem, explanation, questionType)
      if (indices.length > 0 && indices.length < blocks.length) {
        return indices.map((idx) => blocks[idx]!.raw).join('\n\n')
      }
    }
    return trimmed
  }

  let selected = trimmed
  if (blocks.length >= 2 && questionType !== '作文题') {
    const indices = recommendShenlunMaterialIndices(blocks, stem, explanation, questionType)
    if (indices.length > 0 && indices.length < blocks.length) {
      selected = indices.map((idx) => blocks[idx]!.raw).join('\n\n')
    }
  }
  const maxCompactChars = 5500
  if (selected.length <= maxCompactChars) return selected
  return `${selected.slice(0, maxCompactChars)}\n\n[注：原始给定资料过长已按精简模式截断，请仅依据上述已呈现材料要点评分]`
}

function isNonRetryableAiError(message: string): boolean {
  return /API Key|无法解密|\b401\b|\b403\b|invalid_api_key|authentication|unauthorized|forbidden|insufficient_quota|quota|余额不足|私有或保留地址|私有网络|有效 URL|必须使用 HTTPS/i.test(
    message
  )
}

function isContextLimitError(message: string): boolean {
  return /context_length|maximum context|too many tokens|token limit|input is too long|\b413\b|上下文长度|超出模型上下文/i.test(
    message
  )
}

function isStreamTransportError(message: string): boolean {
  return /空内容|terminated|premature|ECONNRESET|EPIPE|ETIMEDOUT|socket|fetch failed|SSE|stream|请求超时/i.test(
    message
  )
}

export class StudyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiService
  ) {}

  selectPractice(selection: PracticeSelection): Question[] {
    if (selection.questionIds?.length) {
      return this.database.getQuestionsByIds(selection.questionIds)
    }
    const count = clamp(Math.round(selection.count), 1, 100)
    if (selection.mode === 'review')
      return this.database.getDueReviews(count).map((item) => item.question)
    // 抽题池走专用查询：万题级题库全库采样不受列表查询的 5000 截断（旧题也要能抽到）
    let pool = this.database.listQuestionsForPool({ ...selection.filter })
    if (pool.length === 0 && selection.filter?.category && !selection.filter.categories?.length) {
      const aliases = expandCategoryAliases(selection.filter.category)
      if (aliases.length > 1) {
        pool = this.database.listQuestionsForPool({
          ...selection.filter,
          category: undefined,
          categories: aliases
        })
      }
      if (
        pool.length === 0 &&
        selection.filter.category.includes('-') &&
        !isDataAnalysisCategory(selection.filter.category)
      ) {
        const rawCategory = selection.filter.category.trim()
        const dashIdx = rawCategory.indexOf('-')
        const parent = rawCategory.slice(0, dashIdx).trim()
        const sub = rawCategory.slice(dashIdx + 1).trim()
        if (parent && sub) {
          const parentAliases = expandCategoryAliases(parent)
          const candidates = this.database.listQuestionsForPool({
            ...selection.filter,
            category: undefined,
            categories: parentAliases
          })
          pool = candidates.filter((question) =>
            question.tags.some(
              (tag) =>
                tag === sub ||
                tag === rawCategory ||
                tag.startsWith(`${rawCategory}-`) ||
                parentAliases.some(
                  (pa) => tag === `${pa}-${sub}` || tag.startsWith(`${pa}-${sub}-`)
                )
            )
          )
        }
      }
    }
    const strictDataAnalysis =
      !selection.filter?.onlyWrong &&
      !selection.filter?.onlyFavorite &&
      !selection.filter?.onlyUnattempted &&
      !selection.filter?.difficulty &&
      !selection.filter?.query?.trim()
    // 严禁在 buildQuestionUnits 之前对 pool 洗牌，确保组内 1→2→3→4→5 顺序不被打乱
    const units = normalizePracticeUnits(buildQuestionUnits(pool), strictDataAnalysis)
    if (selection.mode === 'sequence') return takeUnits(units, count)
    if (selection.mode === 'adaptive') {
      const diagnosis = this.getDiagnosis()
      const priority = new Map(
        diagnosis.weaknesses.map((item, index) => [
          item.category,
          diagnosis.weaknesses.length - index
        ])
      )
      const recent = new Set(this.database.getRecentAttemptQuestionIds(80))
      const attempted = this.database.getAttemptedQuestionIds()
      const wrong = this.database.listQuestions({ onlyWrong: true, limit: 500 })
      const wrongTags = new Set(wrong.flatMap((question) => question.tags))
      const wrongCategories = new Set(wrong.map((question) => question.category))
      const scoreOf = (question: Question): number =>
        (priority.get(question.category) ?? 0) * 20 +
        (wrongCategories.has(question.category) ? 12 : 0) +
        question.tags.filter((tag) => wrongTags.has(tag)).length * 3 +
        (attempted.has(question.id) ? 0 : 8) -
        (recent.has(question.id) ? 40 : 0)
      // 在单元粒度先随机打破同分，再按组最高分降序排序，整组抽取保持资料分析 5 题连续不乱序
      return takeUnits(
        shuffled(units)
          .map((unit) => ({ unit, score: Math.max(...unit.map(scoreOf)) }))
          .sort((a, b) => b.score - a.score)
          .map((item) => item.unit),
        count
      )
    }
    return takeUnits(shuffled(units), count)
  }

  /** 按模块配比组合模考试卷（如国考 130 / 省考 120 / 高频冲刺预设）；
   *  资料分析同样经 selectPractice 走整套 5 题连续锁死保护，并自动兼容不同题库模块别名 */
  selectExamByQuotas(
    quotas: Array<{ category: string; count: number }>,
    filter: QuestionFilter = {}
  ): Question[] {
    const picked: Question[] = []
    const seenIds = new Set<string>()
    for (const quota of quotas) {
      const want = clamp(Math.round(quota.count), 1, 100)
      const aliases = expandCategoryAliases(quota.category)
      const scopedFilter: QuestionFilter = {
        ...filter,
        subject: 'xingce',
        category: aliases.length === 1 ? aliases[0] : undefined,
        categories: aliases.length > 1 ? aliases : undefined
      }
      const chunk = this.selectPractice({
        mode: 'random',
        count: want,
        filter: scopedFilter
      })
      for (const q of chunk) {
        if (seenIds.has(q.id)) continue
        seenIds.add(q.id)
        picked.push(q)
      }
    }
    return picked
  }

  getDiagnosis(): DiagnosisResult {
    const report = this.database.getReport('all')
    const categories = report.categoryStats.filter((item) => item.attempts > 0)
    // 相对优势硬门槛：单模块有效作答 ≥3 题且正确率 ≥70% 才算真优势；
    // 只刷过 1 个模块且正确率不足时，两栏都不出现该模块（避免自相矛盾）
    const strengths = [...categories]
      .filter((item) => item.attempts >= 3 && item.accuracy >= 70)
      .sort((a, b) => b.accuracy - a.accuracy || b.attempts - a.attempts)
      .slice(0, 4)
      .map(({ category, accuracy, attempts }) => ({ category, accuracy, attempts }))
    // 优先补强：先排除已进入优势的模块（两栏严格互斥），再从剩余模块选正确率 <80% 的
    const strengthCategories = new Set(strengths.map((item) => item.category))
    const weaknesses = [...categories]
      .filter((item) => !strengthCategories.has(item.category) && item.accuracy < 80)
      .sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts)
      .slice(0, 4)
      .map(({ category, accuracy, attempts }) => ({ category, accuracy, attempts }))
    const recommendations: string[] = []
    if (report.totalAttempts === 0)
      recommendations.push('先完成一组 10 题摸底训练，系统会据此生成能力画像。')
    if (report.totalAttempts > 0 && report.accuracy < 60)
      recommendations.push('当前优先补齐基础方法，每组训练后逐题填写错因。')
    if (report.totalAttempts > 0 && report.accuracy >= 60 && report.accuracy < 80)
      recommendations.push('基础已经建立，建议采用弱项专项与间隔复习交替训练。')
    if (report.accuracy >= 80) recommendations.push('正确率较稳定，可增加限时模考并关注平均用时。')
    if (weaknesses[0])
      recommendations.push(
        `优先训练「${weaknesses[0].category}」，当前正确率为 ${weaknesses[0].accuracy}%。`
      )
    if (report.wrongCauses[0]?.cause && report.wrongCauses[0].cause !== '未标注')
      recommendations.push(
        `最常见错因是「${report.wrongCauses[0].cause}」，复盘时应设置针对性检查步骤。`
      )
    return {
      generatedAt: now(),
      totalAttempts: report.totalAttempts,
      accuracy: report.accuracy,
      averageDurationSeconds: report.totalAttempts
        ? Math.round((report.studyMinutes * 60) / report.totalAttempts)
        : 0,
      strengths,
      weaknesses,
      recommendations
    }
  }

  previewPlan(input: {
    durationDays: number
    dailyMinutes: number
    focus: string[]
  }): LearningPlan {
    const durationDays = clamp(Math.round(input.durationDays), 1, 30)
    const dailyMinutes = clamp(Math.round(input.dailyMinutes), 10, 300)
    const diagnosis = this.getDiagnosis()
    const focus = input.focus.length
      ? input.focus.slice(0, 6)
      : diagnosis.weaknesses.map((item) => item.category).slice(0, 3)
    if (focus.length === 0) focus.push('综合能力')
    const items: LearningPlanItem[] = []
    const practiceTarget = clamp(Math.round(dailyMinutes / 3), 5, 50)
    for (let day = 1; day <= durationDays; day += 1) {
      const category = focus[(day - 1) % focus.length]!
      items.push({
        id: randomUUID(),
        day,
        type: 'read_knowledge',
        title: `阅读：${category}核心方法`,
        category,
        target: Math.max(10, Math.round(dailyMinutes * 0.25)),
        completed: 0,
        done: false,
        route: /申论|公文|写作|概括|对策|贯彻/.test(category)
          ? '/thinking/shenlun'
          : '/thinking/xingce'
      })
      items.push({
        id: randomUUID(),
        day,
        type: 'official_practice',
        title: `专项训练：${category}`,
        category,
        target: practiceTarget,
        completed: 0,
        done: false,
        route:
          category === '综合能力'
            ? `/practice?mode=adaptive&count=${practiceTarget}`
            : /申论|公文|写作|概括|对策|贯彻/.test(category)
              ? `/practice?mode=adaptive&subject=shenlun&count=${practiceTarget}&category=${encodeURIComponent(category)}`
              : `/practice?mode=adaptive&count=${practiceTarget}&category=${encodeURIComponent(category)}`
      })
      items.push({
        id: randomUUID(),
        day,
        type: day % 3 === 0 ? 'ai_variant' : 'official_review',
        title: day % 3 === 0 ? `变式训练：${category}` : '到期错题复习',
        category: day % 3 === 0 ? category : undefined,
        target: day % 3 === 0 ? 3 : 5,
        completed: 0,
        done: false,
        route: day % 3 === 0 ? '/ai-training' : '/review'
      })
    }
    return {
      id: randomUUID(),
      title: `${durationDays} 天能力提升计划`,
      createdAt: now(),
      startDate: dateFromToday(0),
      durationDays,
      dailyMinutes,
      status: 'preview',
      focus,
      items
    }
  }

  async evaluateConstructed(
    input: {
      promptId: string
      title: string
      content: string
      requestId?: string
    },
    options?: { onChunk?: (delta: string) => void; onReset?: () => void }
  ): Promise<ConstructedEvaluation> {
    const content = input.content.trim()
    if (content.length < 20) throw new Error('作答内容过短，至少输入 20 个字符后再评估')
    const prompt = this.database.getQuestion(input.promptId)
    const config = this.ai.getConfig()
    const stemText = prompt?.stem ?? input.title
    const rubric = parseShenlunStemRubric(stemText, prompt?.category)
    const metrics = inspectShenlunAnswerMetrics(content, rubric, prompt?.material)
    const explanationText =
      prompt?.explanation && !prompt.explanation.startsWith('暂无参考答案')
        ? prompt.explanation
        : ''
    const referencePoints = extractReferencePoints(prompt?.answer ?? [], explanationText)
    let evaluation: ConstructedEvaluation | undefined
    let aiFailureReason = ''
    let streamAborted = false
    if (config.hasApiKey || config.provider === 'ollama' || config.provider === 'lmstudio') {
      const buildMessages = (compactMode: boolean, repairReminder: boolean): AiMessage[] => {
        const material = selectEvaluationMaterial(
          prompt?.material ?? '',
          stemText,
          explanationText,
          rubric.questionType,
          compactMode
        )
        const refExp =
          compactMode && explanationText.length > 2000
            ? `${explanationText.slice(0, 2000)}\n[注：参考解析过长已节选]`
            : explanationText
        const envelope = taskDataEnvelope('申论作答评估输入', {
          title: input.title,
          questionType: rubric.questionType,
          subType: rubric.subType,
          fullScore: rubric.fullScore ?? null,
          wordLimit: rubric.wordLimit?.label ?? null,
          docFormatRule: rubric.docFormatHint ?? null,
          requiredTitle: rubric.requiredTitle ?? null,
          requiresProblemBeforeMeasure: rubric.requiresProblemBeforeMeasure,
          actualWordCount: metrics.wordCount,
          sheetCellCount: metrics.sheetCellCount,
          objectiveChecks: {
            hasTitle: metrics.hasTitle,
            matchesRequiredTitle: metrics.matchesRequiredTitle,
            hasSalutation: metrics.hasSalutation,
            hasSignOff: metrics.hasSignOff,
            materialCopyRatio: metrics.materialCopyRatio,
            hardPenalties: metrics.hardPenalties
          },
          prompt: stemText,
          material,
          referencePoints,
          referenceExplanation: refExp,
          studentAnswer: content
        })
        const userContent = repairReminder
          ? `${envelope}\n\n【重要格式纠错提示】上一次返回内容未能解析为标准 JSON。本次请只输出一个合法 JSON 对象（以 { 开头、以 } 结尾），严禁输出 <think> 思考过程、Markdown 代码围栏或前后解释文字；字符串内引述原文请使用中文引号“”，换行请使用 \\n，并保持表述精炼以免触发输出长度截断。`
          : envelope
        return [
          {
            role: 'system',
            content: FEATURE_PROMPTS.constructedEvaluation
          },
          {
            role: 'user',
            content: userContent
          }
        ]
      }

      type FailureKind = 'none' | 'parse' | 'context' | 'truncated' | 'stream' | 'other'
      let lastFailureKind: FailureKind = 'none'
      let lastRawResult: AiAskResult | undefined

      for (let attempt = 0; attempt < 2 && !evaluation && !streamAborted; attempt += 1) {
        if (attempt > 0) options?.onReset?.()
        const compactMode =
          attempt > 0 && (lastFailureKind === 'context' || lastFailureKind === 'truncated')
        const repairReminder =
          attempt > 0 && (lastFailureKind === 'parse' || lastFailureKind === 'truncated')
        const attemptMessages = buildMessages(compactMode, repairReminder)
        const preferNonStream: boolean =
          attempt > 0 && lastFailureKind === 'stream' && typeof this.ai.ask === 'function'
        try {
          const result: AiAskResult =
            input.requestId && !preferNonStream
              ? await this.ai.askStream(
                  { purpose: 'evaluate', messages: attemptMessages, requestId: input.requestId },
                  { onChunk: options?.onChunk ?? (() => {}) },
                  150_000
                )
              : await this.ai.ask(
                  { purpose: 'evaluate', messages: attemptMessages, requestId: input.requestId },
                  150_000
                )
          if ('aborted' in result && result.aborted) {
            streamAborted = true
            break
          }
          lastRawResult = result
          const parsed = parseConstructedEvaluationJson(result.content)
          if (!parsed) {
            const finish = (result.finishReason ?? '').toLowerCase()
            lastFailureKind = finish === 'length' || finish === 'max_tokens' ? 'truncated' : 'parse'
            aiFailureReason =
              lastFailureKind === 'truncated'
                ? 'AI 返回内容触发最大长度截断，未能生成完整 JSON 评分结构'
                : 'AI 返回结果未能解析为有效 JSON 评分结构'
            continue
          }
          const calibrated = calibrateConstructedEvaluation(parsed, rubric, metrics)
          evaluation = {
            id: randomUUID(),
            promptId: input.promptId,
            score: calibrated.score,
            dimensions: calibrated.dimensions,
            summary: calibrated.summary,
            suggestions: calibrated.suggestions,
            createdAt: now(),
            provider: `${result.provider}/${result.model}`,
            rubricMeta: calibrated.rubricMeta
          }
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause || '未知错误')
          if (msg.includes('已停止')) {
            streamAborted = true
            break
          }
          aiFailureReason = msg
          evaluation = undefined
          if (isNonRetryableAiError(msg)) {
            break
          }
          if (isContextLimitError(msg)) {
            lastFailureKind = 'context'
          } else if (msg.includes('最大长度截断')) {
            lastFailureKind = 'truncated'
          } else if (isStreamTransportError(msg)) {
            lastFailureKind = 'stream'
          } else {
            lastFailureKind = 'other'
          }
        }
      }

      if (!evaluation && !streamAborted && lastRawResult) {
        const rescued = parseConstructedEvaluationMarkdown(lastRawResult.content)
        if (rescued) {
          const calibrated = calibrateConstructedEvaluation(rescued, rubric, metrics)
          evaluation = {
            id: randomUUID(),
            promptId: input.promptId,
            score: calibrated.score,
            dimensions: calibrated.dimensions,
            summary: calibrated.summary,
            suggestions: calibrated.suggestions,
            createdAt: now(),
            provider: `${lastRawResult.provider}/${lastRawResult.model}`,
            rubricMeta: calibrated.rubricMeta
          }
        }
      }
    }
    if (streamAborted) {
      throw new Error('已停止本次 AI 批改')
    }
    if (!evaluation) {
      evaluation = evaluateShenlunLocally(input.promptId, content, prompt, rubric, metrics, {
        id: randomUUID(),
        createdAt: now()
      })
      if (aiFailureReason) {
        evaluation.summary = `【AI 批改回退提示】本次 AI 评估未能完成（原因：${aiFailureReason}），已自动回退为本地规则评分。\n\n${evaluation.summary}`
      }
    }
    this.database.saveConstructedAttempt({
      id: evaluation.id,
      promptId: input.promptId,
      title: input.title,
      content,
      evaluation,
      createdAt: evaluation.createdAt
    })
    return evaluation
  }
}
