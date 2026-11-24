import { randomUUID } from 'node:crypto'
import type {
  ConstructedEvaluation,
  DiagnosisResult,
  LearningPlan,
  LearningPlanItem,
  PracticeSelection,
  Question,
  QuestionFilter
} from '../../shared/contracts'
import { FEATURE_PROMPTS, taskDataEnvelope } from '../../shared/prompts'
import { classifyShenlunType } from '../../shared/shenlun'
import { expandCategoryAliases } from '../../shared/study-constants'
import { AiService } from './ai'
import { DatabaseService } from './database'
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

// ---- 组题抽题：资料分析锁死为整套材料 5 题连续（1→2→3→4→5），严禁拆散、打乱或跨模块混组 ----

export const DATA_ANALYSIS_GROUP_SIZE = 5

export function isDataAnalysisQuestion(question: Question): boolean {
  return question.category === '资料分析' || question.category.startsWith('资料分析')
}

export function isLockedDataAnalysisUnit(unit: Question[]): boolean {
  return unit.length === DATA_ANALYSIS_GROUP_SIZE && unit.every(isDataAnalysisQuestion)
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

// 依次整组收取；锁定 5 题资料分析组严禁拆散或截断，放不下时先跳过再用其他单元回填
export function takeUnits(units: Question[][], count: number): Question[] {
  const picked: Question[] = []
  const skipped: Question[][] = []
  for (const unit of units) {
    if (picked.length >= count) break
    if (
      picked.length + unit.length <= count ||
      (picked.length === 0 && !isLockedDataAnalysisUnit(unit))
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
    const lockedFallback = skipped.find(isLockedDataAnalysisUnit)
    if (lockedFallback) return [...lockedFallback]
    return skipped[0]!.slice(0, count)
  }
  return picked.slice(0, count)
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const codeBlock = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value
  try {
    const parsed = JSON.parse(codeBlock.trim())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
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
    const pool = this.database.listQuestionsForPool({ ...selection.filter })
    const strictDataAnalysis =
      !selection.filter?.onlyWrong &&
      !selection.filter?.onlyFavorite &&
      !selection.filter?.query?.trim()
    // 严禁在 buildQuestionUnits 之前对 pool 洗牌，确保组内 1→2→3→4→5 顺序不被打乱
    const units = normalizeDataAnalysisUnits(buildQuestionUnits(pool), strictDataAnalysis)
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
    let evaluation: ConstructedEvaluation | undefined
    let aiFailureReason = ''
    let streamAborted = false
    if (config.hasApiKey || config.provider === 'ollama' || config.provider === 'lmstudio') {
      const stemText = prompt?.stem ?? input.title
      const questionType = classifyShenlunType(prompt?.category, stemText)
      const actualWordCount = content.replace(/\s/g, '').length
      const explanationText =
        prompt?.explanation && !prompt.explanation.startsWith('暂无参考答案')
          ? prompt.explanation
          : ''
      const messages = [
        {
          role: 'system' as const,
          content: FEATURE_PROMPTS.constructedEvaluation
        },
        {
          role: 'user' as const,
          content: taskDataEnvelope('申论作答评估输入', {
            title: input.title,
            questionType,
            actualWordCount,
            prompt: stemText,
            material: prompt?.material ?? '',
            referencePoints: prompt?.answer ?? [],
            referenceExplanation: explanationText,
            studentAnswer: content
          })
        }
      ]
      for (let attempt = 0; attempt < 2 && !evaluation && !streamAborted; attempt += 1) {
        if (attempt > 0) options?.onReset?.()
        try {
          const result = input.requestId
            ? await this.ai.askStream(
                { purpose: 'evaluate', messages, requestId: input.requestId },
                { onChunk: options?.onChunk ?? (() => {}) },
                90_000
              )
            : await this.ai.ask({ purpose: 'evaluate', messages }, 90_000)
          if ('aborted' in result && result.aborted) {
            streamAborted = true
            break
          }
          const parsed = parseJsonObject(result.content)
          if (!parsed) {
            aiFailureReason = 'AI 返回结果未包含合法 JSON 结构'
            continue
          }
          const dimensionsRaw = Array.isArray(parsed.dimensions) ? parsed.dimensions : []
          evaluation = {
            id: randomUUID(),
            promptId: input.promptId,
            score: clamp(Number(parsed.score) || 0, 0, 100),
            dimensions: dimensionsRaw.flatMap((item) => {
              if (!item || typeof item !== 'object') return []
              const record = item as Record<string, unknown>
              return [
                {
                  name: String(record.name ?? '综合'),
                  score: clamp(Number(record.score) || 0, 0, 100),
                  comment: String(record.comment ?? '')
                }
              ]
            }),
            summary: String(parsed.summary ?? '评估完成'),
            suggestions: Array.isArray(parsed.suggestions)
              ? parsed.suggestions.map(String).slice(0, 8)
              : [],
            createdAt: now(),
            provider: `${result.provider}/${result.model}`
          }
        } catch (cause) {
          aiFailureReason = cause instanceof Error ? cause.message : String(cause || '未知错误')
          evaluation = undefined
        }
      }
    }
    if (streamAborted) {
      throw new Error('已停止本次 AI 批改')
    }
    if (!evaluation) {
      evaluation = this.localEvaluation(input.promptId, content, prompt)
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

  private localEvaluation(
    promptId: string,
    content: string,
    prompt?: Question
  ): ConstructedEvaluation {
    const keywords = prompt?.answer ?? []
    const matched = keywords.filter((keyword) => content.includes(keyword)).length
    const coverage = keywords.length ? matched / keywords.length : 0.55
    const paragraphs = content.split(/\n+/).filter((item) => item.trim()).length
    const structure = clamp(
      (paragraphs >= 2 ? 72 : 55) + (/[一二三四]|首先|其次|最后|一是|二是/.test(content) ? 15 : 0),
      0,
      100
    )
    const lengthScore =
      content.length >= 100 && content.length <= 500 ? 88 : content.length >= 60 ? 72 : 55
    const accuracy = Math.round(45 + coverage * 50)
    const score = Math.round(accuracy * 0.5 + structure * 0.3 + lengthScore * 0.2)
    return {
      id: randomUUID(),
      promptId,
      score,
      dimensions: [
        {
          name: '要点覆盖',
          score: accuracy,
          comment: keywords.length
            ? `命中 ${matched}/${keywords.length} 个参考要点。`
            : '当前题目没有结构化参考要点，按表达完整度估算。'
        },
        {
          name: '结构组织',
          score: structure,
          comment: paragraphs >= 2 ? '答案具备分层表达。' : '建议按并列或因果关系分层组织。'
        },
        {
          name: '表达规范',
          score: lengthScore,
          comment: '请继续压缩重复表述，优先使用主体加措施加效果的句式。'
        }
      ],
      summary:
        '这是本地规则评分，用于快速自检，不替代人工阅卷。配置 AI 后可获得语义层面的进一步反馈。',
      suggestions: [
        matched < keywords.length
          ? '对照材料补齐尚未覆盖的核心做法。'
          : '要点覆盖较完整，可继续优化排序和概括层级。',
        structure < 75 ? '用序号或分号明确拆分要点。' : '保持当前分层结构，并减少空泛修饰。',
        '每个要点先写结论词，再补充材料依据。'
      ],
      createdAt: now(),
      provider: 'local-rubric'
    }
  }
}
