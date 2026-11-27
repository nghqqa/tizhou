import { randomUUID } from 'node:crypto'
import type {
  AgentActionExecuteResult,
  AgentActionProposal,
  LearningPlan,
  PracticeSelection,
  Question
} from '../../shared/contracts'
import {
  XINGCE_PACE_SECONDS_PER_QUESTION,
  expandCategoryAliases,
  isAnswerCorrect,
  normalizeXingceModule
} from '../../shared/study-constants'
import type { AgentToolDefinition } from './ai'
import type { DatabaseService } from './database'
import type { StudyService } from './study'

export interface AgentToolMeta {
  definition: AgentToolDefinition
  label: string
  mode: 'read' | 'write'
}

export interface AgentToolRunOutcome {
  ok: boolean
  outputJson: string
  summary: string
  proposal?: AgentActionProposal
}

function previewText(raw: string, maxLen = 64): string {
  const plain = raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[图]')
    .replace(/[`*_#>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return '（无文字内容）'
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
}

export const AGENT_TOOLS: AgentToolMeta[] = [
  {
    label: '读取备考总览与学情诊断',
    mode: 'read',
    definition: {
      name: 'get_study_overview',
      description:
        '读取考生当前工作台进度、目标考试倒计时、近 N 天刷题正确率、模块强弱项诊断、错因分布与当前学习计划。',
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['7d', '30d', 'all'],
            description: '统计区间，默认 30d'
          }
        }
      }
    }
  },
  {
    label: '检索错题本与高频错因',
    mode: 'read',
    definition: {
      name: 'query_wrong_questions',
      description: '按专项模块、错因标签、顽固次数或关键词检索用户错题本。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '专项模块名称，如 资料分析、图形推理' },
          wrongCause: { type: 'string', description: '错因标签筛选' },
          minWrongCount: { type: 'number', description: '最少错误次数，如 2 表示顽固错题' },
          query: { type: 'string', description: '题干或笔记关键词' },
          limit: { type: 'number', description: '返回条数上限（1~12），默认 8' }
        }
      }
    }
  },
  {
    label: '分析最近模考耗时与沉没成本',
    mode: 'read',
    definition: {
      name: 'get_exam_sunk_cost',
      description:
        '读取最近已完成的模拟考试成绩、各模块耗时与超时错题（沉没成本黑洞题），用于定位考场配速问题。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多检查最近几场已完成模考（1~3），默认 1' }
        }
      }
    }
  },
  {
    label: '搜索本地题库原题',
    mode: 'read',
    definition: {
      name: 'search_vault_questions',
      description: '按关键词、专项模块、科目、错题或未做条件检索当前活动题库中的题目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          subject: { type: 'string', enum: ['xingce', 'shenlun'], description: '科目筛选' },
          category: { type: 'string', description: '专项模块名称' },
          onlyWrong: { type: 'boolean', description: '仅查错题' },
          onlyUnattempted: { type: 'boolean', description: '仅查未做新题' },
          limit: { type: 'number', description: '返回数量（1~10），默认 8' }
        }
      }
    }
  },
  {
    label: '检索知识文档、笔记与规范词',
    mode: 'read',
    definition: {
      name: 'search_knowledge_and_notes',
      description: '检索用户知识中心的方法论/知识点文档、个人做题笔记及申论规范词素材。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          scope: {
            type: 'string',
            enum: ['all', 'documents', 'notes', 'snippets'],
            description: '搜索范围，默认 all'
          }
        },
        required: ['query']
      }
    }
  },
  {
    label: '读取个人长期学习记忆',
    mode: 'read',
    definition: {
      name: 'list_learner_memories',
      description: '读取已保存在本地的考生长期错因与薄弱点记忆。',
      parameters: {
        type: 'object',
        properties: {
          onlyEnabled: { type: 'boolean', description: '是否仅返回当前启用的记忆，默认 false' }
        }
      }
    }
  },
  {
    label: '生成专项训练提案（待确认）',
    mode: 'write',
    definition: {
      name: 'propose_practice_session',
      description:
        '按指定筛选条件校验题库可用题目后，生成「发起专项训练」待用户审批的提案卡片（不会直接改库）。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['adaptive', 'random', 'sequence', 'review'],
            description: '选题策略，默认 adaptive'
          },
          count: { type: 'number', description: '建议题数（1~30），默认 10' },
          subject: { type: 'string', enum: ['xingce', 'shenlun', ''], description: '科目' },
          category: { type: 'string', description: '专项模块名称' },
          onlyWrong: { type: 'boolean', description: '是否只练错题' },
          onlyUnattempted: { type: 'boolean', description: '是否只练未做题' },
          questionIds: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：直接指定题目 ID 列表'
          },
          title: { type: 'string', description: '提案卡片标题' },
          reason: { type: 'string', description: '推荐该组训练的诊断依据' }
        },
        required: ['reason']
      }
    }
  },
  {
    label: '生成加入间隔复习提案（待确认）',
    mode: 'write',
    definition: {
      name: 'propose_enqueue_review',
      description: '把指定题目加入待复习队列，生成待用户审批的提案卡片。',
      parameters: {
        type: 'object',
        properties: {
          questionIds: {
            type: 'array',
            items: { type: 'string' },
            description: '要加入复习的题目 ID 列表（必须来自查询结果）'
          },
          reason: { type: 'string', description: '入队原因或标注' },
          summary: { type: 'string', description: '提案简要说明' }
        },
        required: ['questionIds', 'reason']
      }
    }
  },
  {
    label: '生成保存题目笔记提案（待确认）',
    mode: 'write',
    definition: {
      name: 'propose_save_note',
      description: '把解题口诀或复盘总结写入指定题目笔记，生成待用户审批的提案卡片。',
      parameters: {
        type: 'object',
        properties: {
          questionId: { type: 'string', description: '目标题目 ID' },
          content: { type: 'string', description: '建议保存的笔记正文' },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description: '追加到已有笔记或覆盖，默认 append'
          },
          reason: { type: 'string', description: '提炼该笔记的依据' }
        },
        required: ['questionId', 'content']
      }
    }
  },
  {
    label: '生成长期学习记忆提案（待确认）',
    mode: 'write',
    definition: {
      name: 'propose_save_memory',
      description:
        '提炼一条跨会话可复用的考生高频错因或薄弱规律，生成「写入学习记忆」待用户审批卡片。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: '所属模块或维度，如 资料分析、申论概括、作答节奏'
          },
          content: { type: 'string', description: '简洁明确的个人规律或避坑提示（<= 200 字）' },
          evidence: { type: 'string', description: '支撑该记忆的数据或题目依据' },
          reason: { type: 'string', description: '为何建议长期记住该点' }
        },
        required: ['category', 'content']
      }
    }
  },
  {
    label: '生成学习计划调整提案（待确认）',
    mode: 'write',
    definition: {
      name: 'propose_learning_plan',
      description: '根据诊断弱项生成多日学习计划预览，并提交待用户审批的「应用新计划」卡片。',
      parameters: {
        type: 'object',
        properties: {
          durationDays: { type: 'number', description: '计划天数（1~30），默认 7' },
          dailyMinutes: { type: 'number', description: '每日投入分钟数（15~240），默认 60' },
          focus: {
            type: 'array',
            items: { type: 'string' },
            description: '重点突破模块列表，如 ["资料分析", "判断推理"]'
          },
          title: { type: 'string', description: '计划名称' },
          reason: { type: 'string', description: '生成该计划的诊断原因' }
        },
        required: ['focus', 'reason']
      }
    }
  }
]

const TOOL_META_MAP = new Map(AGENT_TOOLS.map((item) => [item.definition.name, item]))

export function getAgentToolMeta(name: string): AgentToolMeta | undefined {
  return TOOL_META_MAP.get(name)
}

export function summarizeToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(
    ([, val]) => val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)
  )
  if (!entries.length) return '无参数'
  const text = entries
    .slice(0, 4)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}=[${v.length}项]`
      if (typeof v === 'string') return `${k}=${v.length > 22 ? `${v.slice(0, 22)}…` : v}`
      return `${k}=${String(v)}`
    })
    .join(' · ')
  return entries.length > 4 ? `${text} …` : text
}

export function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { database: DatabaseService; study: StudyService }
): AgentToolRunOutcome {
  const { database, study } = ctx
  try {
    switch (toolName) {
      case 'get_study_overview': {
        const range =
          args.range === '7d' || args.range === '30d' || args.range === 'all' ? args.range : '30d'
        const settings = database.getAppSettings()
        const dashboard = database.getDashboard()
        const report = database.getReport(range)
        const diagnosis = study.getDiagnosis()
        const activePlan = database.getActivePlan()
        const data = {
          examGoal: settings.examGoalName
            ? { name: settings.examGoalName, date: settings.examGoalDate || undefined }
            : undefined,
          dashboard: {
            todayAttempts: dashboard.todayAttempts,
            dailyTarget: dashboard.dailyTarget,
            todayMinutes: dashboard.todayMinutes,
            overallAccuracy: dashboard.accuracy,
            studyStreak: dashboard.studyStreak,
            dueReviews: dashboard.dueReviews,
            wrongQuestions: dashboard.wrongQuestions,
            masteredQuestions: dashboard.masteredQuestions,
            totalQuestions: dashboard.totalQuestions,
            subjectMastery: dashboard.subjectMastery
          },
          reportRange: range,
          reportSummary: {
            totalAttempts: report.totalAttempts,
            accuracy: report.accuracy,
            studyMinutes: report.studyMinutes,
            categoryStats: report.categoryStats.slice(0, 12),
            wrongCauses: report.wrongCauses.slice(0, 8),
            essaySummary: report.essaySummary
          },
          diagnosis,
          activePlan: activePlan
            ? {
                id: activePlan.id,
                title: activePlan.title,
                durationDays: activePlan.durationDays,
                dailyMinutes: activePlan.dailyMinutes,
                focus: activePlan.focus,
                completedCount: activePlan.items.filter((i) => i.done).length,
                totalItems: activePlan.items.length
              }
            : undefined
        }
        return {
          ok: true,
          outputJson: JSON.stringify(data),
          summary: `总作答 ${dashboard.totalQuestions ? report.totalAttempts : 0} 次 · 正确率 ${report.accuracy}% · 待复习 ${dashboard.dueReviews} 题`
        }
      }

      case 'query_wrong_questions': {
        const limit = clampInt(args.limit, 8, 1, 12)
        const rawCategory = typeof args.category === 'string' ? args.category.trim() : ''
        const categories = rawCategory ? expandCategoryAliases(rawCategory) : undefined
        const items = database.listQuestionLibrary({
          tab: 'wrong',
          ...(categories?.length ? { categories } : {}),
          wrongCause:
            typeof args.wrongCause === 'string' ? args.wrongCause.trim() || undefined : undefined,
          minWrongCount:
            args.minWrongCount !== undefined ? clampInt(args.minWrongCount, 1, 1, 20) : undefined,
          query: typeof args.query === 'string' ? args.query.trim() || undefined : undefined,
          limit
        })
        const simplified = items.map((item) => ({
          id: item.question.id,
          category: item.question.category,
          difficulty: item.question.difficulty,
          wrongCount: item.wrongCount,
          lastWrongCause: item.lastWrongCause || '未标注',
          dueAt: item.dueAt,
          answer: item.question.answer,
          stemPreview: previewText(item.question.stem, 72),
          note: item.note ? previewText(item.note, 60) : undefined
        }))
        return {
          ok: true,
          outputJson: JSON.stringify({ count: simplified.length, items: simplified }),
          summary: `命中 ${simplified.length} 道错题`
        }
      }

      case 'get_exam_sunk_cost': {
        const limit = clampInt(args.limit, 1, 1, 3)
        const completed = database
          .listExams()
          .filter((e) => e.status === 'finished' && e.subject !== 'shenlun')
          .slice(0, limit)
        if (!completed.length) {
          return {
            ok: true,
            outputJson: JSON.stringify({ exams: [], message: '暂无已完成的行测模拟考试记录' }),
            summary: '暂无已完成行测模考记录'
          }
        }
        const exams = completed.flatMap((summary) => {
          const exam = database.getExamById(summary.id)
          if (!exam) return []
          const byModule = new Map<
            string,
            { module: string; count: number; correct: number; totalSeconds: number }
          >()
          const sunkCostItems: Array<{
            index: number
            questionId: string
            category: string
            durationSeconds: number
            suggestedSeconds: number
            answered: boolean
            stemPreview: string
          }> = []
          exam.questionIds.forEach((qid, idx) => {
            const snap = exam.questionSnapshots[qid]
            if (!snap || snap.type === 'essay') return
            const ans = exam.answers[qid]
            const answered = Boolean(ans?.answer?.some((v) => v.trim().length > 0))
            const correct = isAnswerCorrect(snap.answer, ans?.answer ?? [], {
              requireNonEmpty: true
            })
            const dur = Math.max(0, Math.round(ans?.durationSeconds ?? 0))
            const mod = normalizeXingceModule(snap.category)
            const bucket = byModule.get(mod) ?? {
              module: mod,
              count: 0,
              correct: 0,
              totalSeconds: 0
            }
            bucket.count += 1
            if (correct) bucket.correct += 1
            bucket.totalSeconds += dur
            byModule.set(mod, bucket)

            const suggested =
              XINGCE_PACE_SECONDS_PER_QUESTION[snap.category] ??
              XINGCE_PACE_SECONDS_PER_QUESTION[mod] ??
              55
            const threshold = Math.min(120, Math.max(90, Math.round(suggested * 1.5)))
            if (!correct && dur >= threshold) {
              sunkCostItems.push({
                index: idx + 1,
                questionId: qid,
                category: snap.category,
                durationSeconds: dur,
                suggestedSeconds: suggested,
                answered,
                stemPreview: previewText(snap.stem, 58)
              })
            }
          })
          sunkCostItems.sort((a, b) => b.durationSeconds - a.durationSeconds)
          return [
            {
              id: exam.id,
              title: exam.title,
              finishedAt: exam.finishedAt,
              score: exam.score,
              correctCount: exam.correctCount,
              totalQuestions: exam.questionIds.length,
              moduleStats: [...byModule.values()],
              sunkCostItems: sunkCostItems.slice(0, 8)
            }
          ]
        })
        const totalSunk = exams.reduce((sum, item) => sum + item.sunkCostItems.length, 0)
        return {
          ok: true,
          outputJson: JSON.stringify({ exams }),
          summary: `分析 ${exams.length} 场模考 · 发现 ${totalSunk} 道超时错题`
        }
      }

      case 'search_vault_questions': {
        const limit = clampInt(args.limit, 8, 1, 10)
        const rawCategory = typeof args.category === 'string' ? args.category.trim() : ''
        const categories = rawCategory ? expandCategoryAliases(rawCategory) : undefined
        const rows = database.listQuestions({
          query: typeof args.query === 'string' ? args.query.trim() || undefined : undefined,
          subject:
            args.subject === 'xingce' || args.subject === 'shenlun' ? args.subject : undefined,
          ...(categories?.length ? { categories } : {}),
          onlyWrong: Boolean(args.onlyWrong),
          onlyUnattempted: Boolean(args.onlyUnattempted),
          limit
        })
        const simplified = rows.map((q) => ({
          id: q.id,
          subject: q.subject,
          category: q.category,
          type: q.type,
          difficulty: q.difficulty,
          year: q.year,
          region: q.region,
          tags: q.tags,
          hasMaterial: Boolean(q.material),
          stemPreview: previewText(q.stem, 80)
        }))
        return {
          ok: true,
          outputJson: JSON.stringify({ count: simplified.length, questions: simplified }),
          summary: `检索到 ${simplified.length} 道原题`
        }
      }

      case 'search_knowledge_and_notes': {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const scope =
          args.scope === 'documents' || args.scope === 'notes' || args.scope === 'snippets'
            ? args.scope
            : 'all'
        const result: Record<string, unknown> = {}
        let total = 0
        if (scope === 'all' || scope === 'documents') {
          const docs = database.listDocuments({ query: query || undefined }).slice(0, 5)
          result.documents = docs.map((d) => ({
            id: d.id,
            title: d.title,
            subject: d.subject,
            kind: d.kind,
            summary: d.summary,
            excerpt: previewText(d.content, 160)
          }))
          total += docs.length
        }
        if (scope === 'all' || scope === 'notes') {
          const notes = database
            .listQuestionLibrary({ tab: 'notes', query: query || undefined, limit: 5 })
            .map((item) => ({
              questionId: item.question.id,
              category: item.question.category,
              stemPreview: previewText(item.question.stem, 60),
              note: item.note
            }))
          result.notes = notes
          total += notes.length
        }
        if (scope === 'all' || scope === 'snippets') {
          const snippets = database.listStudySnippets({ query: query || undefined }).slice(0, 5)
          result.snippets = snippets.map((s) => ({
            id: s.id,
            kind: s.kind,
            title: s.title,
            content: previewText(s.content, 100)
          }))
          total += snippets.length
        }
        return {
          ok: true,
          outputJson: JSON.stringify(result),
          summary: `匹配知识/笔记/素材共 ${total} 条`
        }
      }

      case 'list_learner_memories': {
        const memories = database.listLearnerMemories(Boolean(args.onlyEnabled))
        return {
          ok: true,
          outputJson: JSON.stringify({ count: memories.length, memories }),
          summary: `共 ${memories.length} 条学习记忆`
        }
      }

      case 'propose_practice_session': {
        const mode: PracticeSelection['mode'] =
          args.mode === 'random' || args.mode === 'sequence' || args.mode === 'review'
            ? args.mode
            : 'adaptive'
        const count = clampInt(args.count, 10, 1, 30)
        const questionIds = asStringArray(args.questionIds)
        const subject =
          args.subject === 'xingce' || args.subject === 'shenlun' ? args.subject : undefined
        const category =
          typeof args.category === 'string' && args.category.trim()
            ? args.category.trim()
            : undefined
        const categories = category ? expandCategoryAliases(category) : undefined
        const selection: PracticeSelection = {
          mode,
          count,
          feedbackMode: 'immediate',
          ...(questionIds.length ? { questionIds } : {}),
          filter: {
            ...(subject ? { subject } : {}),
            ...(categories?.length ? { categories } : {}),
            ...(args.onlyWrong ? { onlyWrong: true } : {}),
            ...(args.onlyUnattempted ? { onlyUnattempted: true } : {})
          }
        }
        const matched = study.selectPractice(selection)
        if (!matched.length) {
          return {
            ok: false,
            outputJson: JSON.stringify({
              proposed: false,
              error:
                '当前筛选条件下题库匹配 0 道题，请放宽条件（例如去掉地区/年份限制或改用自适应选题）后再试。'
            }),
            summary: '题库匹配 0 题（未生成空提案）'
          }
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '根据当前学情薄弱项推荐专项练习'
        const title =
          typeof args.title === 'string' && args.title.trim()
            ? args.title.trim()
            : `开启专项练习：${category || (args.onlyWrong ? '错题强化' : '薄弱项自适应')}（${matched.length} 题）`
        const proposal: AgentActionProposal = {
          id: randomUUID(),
          kind: 'start_practice',
          title,
          summary: `共匹配 ${matched.length} 道题（${mode === 'adaptive' ? '自适应优先' : mode === 'review' ? '到期复习' : mode === 'sequence' ? '顺序训练' : '随机抽题'}，即时解析模式）`,
          reason,
          previewItems: matched
            .slice(0, 3)
            .map((q, i) => `${i + 1}. [${q.category}] ${previewText(q.stem, 48)}`),
          payload: {
            selection: {
              ...selection,
              count: matched.length,
              questionIds: matched.map((q) => q.id)
            }
          },
          status: 'pending'
        }
        return {
          ok: true,
          outputJson: JSON.stringify({
            proposed: true,
            proposalId: proposal.id,
            matchedCount: matched.length,
            note: '提案卡片已发送至界面等待用户确认，尚未创建会话。'
          }),
          summary: `已生成训练提案（${matched.length} 题，待确认）`,
          proposal
        }
      }

      case 'propose_enqueue_review': {
        const requestedIds = asStringArray(args.questionIds).slice(0, 20)
        const questions = database.getQuestionsByIds(requestedIds)
        if (!questions.length) {
          return {
            ok: false,
            outputJson: JSON.stringify({
              proposed: false,
              error: '提供的 questionIds 在当前题库中均不存在，请先查询真实题目 ID。'
            }),
            summary: '题目 ID 无效'
          }
        }
        const queuedSet = database.getActiveReviewQueueIds(questions.map((q) => q.id))
        const pendingQuestions = questions.filter((q) => !queuedSet.has(q.id))
        const skippedCount = questions.length - pendingQuestions.length
        if (!pendingQuestions.length) {
          return {
            ok: true,
            outputJson: JSON.stringify({
              proposed: false,
              alreadyQueuedCount: skippedCount,
              note: '所选题目均已在间隔复习队列中，无需重复加入。'
            }),
            summary: '所选题目均已在复习队列中（无需重复入队）'
          }
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '重点错题纳入间隔复习'
        const summary =
          typeof args.summary === 'string' && args.summary.trim()
            ? args.summary.trim()
            : `将 ${pendingQuestions.length} 道题目加入明日待复习队列${skippedCount > 0 ? `（另有 ${skippedCount} 题已在队列中已跳过）` : ''}`
        const proposal: AgentActionProposal = {
          id: randomUUID(),
          kind: 'enqueue_review',
          title: `加入间隔复习队列（${pendingQuestions.length} 题）`,
          summary,
          reason,
          previewItems: pendingQuestions
            .slice(0, 4)
            .map((q, i) => `${i + 1}. [${q.category}] ${previewText(q.stem, 48)}`),
          payload: {
            questionIds: pendingQuestions.map((q) => q.id),
            reason
          },
          status: 'pending'
        }
        return {
          ok: true,
          outputJson: JSON.stringify({
            proposed: true,
            proposalId: proposal.id,
            count: pendingQuestions.length,
            alreadyQueuedCount: skippedCount,
            note: '复习入队提案已提交至界面，等待用户点击确认。'
          }),
          summary: `已生成复习提案（${pendingQuestions.length} 题，待确认）`,
          proposal
        }
      }

      case 'propose_save_note': {
        const questionId = typeof args.questionId === 'string' ? args.questionId.trim() : ''
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (!questionId || !content) {
          return {
            ok: false,
            outputJson: JSON.stringify({
              proposed: false,
              error: 'questionId 与 content 均不能为空'
            }),
            summary: '参数不完整'
          }
        }
        const q = database.getQuestion(questionId)
        if (!q) {
          return {
            ok: false,
            outputJson: JSON.stringify({ proposed: false, error: `未找到题目 ${questionId}` }),
            summary: '目标题目不存在'
          }
        }
        const mode = args.mode === 'replace' ? 'replace' : 'append'
        const existingNote = database.getNote(questionId).trim()
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '提炼解题思路与避坑要点供后续复盘'
        const proposal: AgentActionProposal = {
          id: randomUUID(),
          kind: 'save_note',
          title: `写入题目笔记 · ${q.category}`,
          summary: `${mode === 'append' && existingNote ? '追加到原笔记' : '保存为题目笔记'}（${content.length} 字）`,
          reason,
          previewItems: [`原题：${previewText(q.stem, 52)}`, `拟写入：${previewText(content, 72)}`],
          payload: { questionId, content, mode },
          status: 'pending'
        }
        return {
          ok: true,
          outputJson: JSON.stringify({
            proposed: true,
            proposalId: proposal.id,
            note: '笔记写入提案已发送至界面，等待用户确认。'
          }),
          summary: '已生成笔记提案（待确认）',
          proposal
        }
      }

      case 'propose_save_memory': {
        const category =
          typeof args.category === 'string' && args.category.trim()
            ? args.category.trim().slice(0, 30)
            : '综合规律'
        const content = typeof args.content === 'string' ? args.content.trim().slice(0, 220) : ''
        if (!content) {
          return {
            ok: false,
            outputJson: JSON.stringify({ proposed: false, error: '学习记忆 content 不能为空' }),
            summary: '记忆内容为空'
          }
        }
        const evidence = typeof args.evidence === 'string' ? args.evidence.trim().slice(0, 220) : ''
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '记录高频薄弱规律，后续对话将自动参考'
        const proposal: AgentActionProposal = {
          id: randomUUID(),
          kind: 'save_memory',
          title: `记住这条学习规律 · ${category}`,
          summary: content,
          reason,
          previewItems: evidence ? [`依据：${evidence}`] : undefined,
          payload: { category, content, evidence },
          status: 'pending'
        }
        return {
          ok: true,
          outputJson: JSON.stringify({
            proposed: true,
            proposalId: proposal.id,
            note: '学习记忆提案已发送至界面，用户确认后将写入本机 SQLite。'
          }),
          summary: `已生成学习记忆提案（${category}，待确认）`,
          proposal
        }
      }

      case 'propose_learning_plan': {
        const durationDays = clampInt(args.durationDays, 7, 1, 30)
        const dailyMinutes = clampInt(args.dailyMinutes, 60, 15, 240)
        const focus = asStringArray(args.focus).slice(0, 4)
        const preview: LearningPlan = study.previewPlan({
          durationDays,
          dailyMinutes,
          focus
        })
        if (typeof args.title === 'string' && args.title.trim()) {
          preview.title = args.title.trim().slice(0, 40)
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '基于当前能力诊断与薄弱模块重排阶段计划'
        const proposal: AgentActionProposal = {
          id: randomUUID(),
          kind: 'apply_plan',
          title: `应用新学习计划：${preview.title}`,
          summary: `${preview.durationDays} 天 · 每日约 ${preview.dailyMinutes} 分钟 · 聚焦 ${preview.focus.join('、') || '综合巩固'}`,
          reason,
          previewItems: preview.items.slice(0, 4).map((item) => `第 ${item.day} 天：${item.title}`),
          payload: { plan: preview },
          status: 'pending'
        }
        return {
          ok: true,
          outputJson: JSON.stringify({
            proposed: true,
            proposalId: proposal.id,
            itemCount: preview.items.length,
            note: '计划提案已生成，等待用户点击确认后激活生效。'
          }),
          summary: `已生成 ${preview.durationDays} 天学习计划提案（待确认）`,
          proposal
        }
      }

      default:
        return {
          ok: false,
          outputJson: JSON.stringify({ error: `未知工具：${toolName}` }),
          summary: `未知工具 ${toolName}`
        }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      outputJson: JSON.stringify({ error: msg }),
      summary: `执行出错：${msg}`
    }
  }
}

export function executeApprovedAction(
  proposal: AgentActionProposal,
  ctx: { database: DatabaseService; study: StudyService }
): AgentActionExecuteResult {
  const { database, study } = ctx
  const payload = proposal.payload ?? {}

  switch (proposal.kind) {
    case 'start_practice': {
      const rawSelection = payload.selection as PracticeSelection | undefined
      if (!rawSelection || typeof rawSelection !== 'object') {
        throw new Error('缺少训练配置载荷')
      }
      const resolved: Question[] = study.selectPractice(rawSelection)
      if (!resolved.length) {
        throw new Error('当前题库中已无匹配的题目可开启训练')
      }
      const session = database.createPracticeSession(rawSelection, resolved)
      const isReview = rawSelection.mode === 'review'
      return {
        ok: true,
        message: `已创建 ${session.questionIds.length} 题${isReview ? '复习' : '专项训练'}，可立即前往开刷。`,
        navigateTo: isReview ? '/review' : '/practice?resumeActive=1'
      }
    }

    case 'enqueue_review': {
      const questionIds = asStringArray(payload.questionIds)
      if (!questionIds.length) throw new Error('缺少待入队题目 ID')
      const reason = typeof payload.reason === 'string' ? payload.reason : 'AI 教练建议复习'
      const res = database.enqueueReviewQuestions(questionIds, reason)
      return {
        ok: true,
        message: `已将 ${res.added} 道题加入明日间隔复习队列${res.skipped > 0 ? `（另有 ${res.skipped} 题已在队列中）` : ''}。`,
        navigateTo: '/review'
      }
    }

    case 'save_note': {
      const questionId = typeof payload.questionId === 'string' ? payload.questionId.trim() : ''
      const content = typeof payload.content === 'string' ? payload.content.trim() : ''
      const mode = payload.mode === 'replace' ? 'replace' : 'append'
      if (!questionId || !content) throw new Error('笔记参数不完整')
      const existing = database.getNote(questionId).trim()
      const finalText =
        mode === 'append' && existing
          ? existing.includes(content)
            ? existing
            : `${existing}\n\n${content}`
          : content
      database.saveNote(questionId, finalText)
      return {
        ok: true,
        message: '已保存到该题的个人笔记。',
        navigateTo: '/review?tab=notes'
      }
    }

    case 'save_memory': {
      const category = typeof payload.category === 'string' ? payload.category : '综合规律'
      const content = typeof payload.content === 'string' ? payload.content : ''
      const evidence = typeof payload.evidence === 'string' ? payload.evidence : ''
      const saved = database.saveLearnerMemory({
        category,
        content,
        evidence,
        source: 'agent'
      })
      return {
        ok: true,
        message: `已记住：「${saved.category} · ${saved.content}」`,
        savedMemory: saved
      }
    }

    case 'apply_plan': {
      const rawPlan = payload.plan as LearningPlan | undefined
      if (!rawPlan || !Array.isArray(rawPlan.items)) throw new Error('缺少学习计划载荷')
      const saved = database.savePlan({
        ...rawPlan,
        status: 'active',
        startDate: new Date().toISOString()
      })
      return {
        ok: true,
        message: `已激活学习计划「${saved.title}」（共 ${saved.items.length} 项任务）。`,
        navigateTo: '/diagnosis'
      }
    }

    default:
      throw new Error('不支持的行动类型')
  }
}
