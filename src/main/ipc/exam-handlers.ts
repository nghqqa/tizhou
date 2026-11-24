import type { IpcContext, IpcHandlerMap } from './types'

type ExamHandlerKeys =
  | 'exam.create'
  | 'exam.active'
  | 'exam.save'
  | 'exam.finish'
  | 'exam.history'
  | 'exam.get'
  | 'exam.papers'
  | 'exam.createPaper'
  | 'exam.shenlunPapers'
  | 'exam.createShenlunPaper'
  | 'exam.paperMatrix'

export function createExamHandlers(ctx: IpcContext): Pick<IpcHandlerMap, ExamHandlerKeys> {
  const { database, study, isE2EMode } = ctx
  // E2E 注入点：WORKBENCH_E2E_FAIL_SAVE=once 时第一次 exam.save 抛错（验证交卷阻止与重试）
  let e2eExamSaveFailedOnce = false

  return {
    'exam.create': (params) => {
      const questions = params.categoryQuotas?.length
        ? study.selectExamByQuotas(params.categoryQuotas, {
            ...params.filter,
            subject: params.subject
          })
        : study.selectPractice({
            mode: 'random',
            count: params.questionCount,
            filter: { ...params.filter, subject: params.subject }
          })
      return database.createExam(params, questions)
    },
    'exam.active': () => database.getActiveExam(),
    'exam.save': (params) => {
      // E2E 注入点：首次保存失败，验证「保存失败阻止交卷 → 重试后放行」。
      // 由 isE2EMode（非打包 + 显式环境变量）双重门控，正式包永不触发
      if (isE2EMode && process.env.WORKBENCH_E2E_FAIL_SAVE === 'once' && !e2eExamSaveFailedOnce) {
        e2eExamSaveFailedOnce = true
        throw new Error('E2E：模拟答案保存失败')
      }
      return database.saveExamAnswer(params.examId, params.answer)
    },
    'exam.finish': (params) => database.finishExam(params.examId, params.uncertainIds),
    'exam.history': () => database.listExams(),
    'exam.get': (params) => database.getExamById(params.examId) ?? null,
    'exam.papers': () => database.listPapers(),
    'exam.createPaper': (params) => {
      // 原卷模考：按 papers 复现记录取题、按卷内题号排序，整卷限时作答。
      // 专用查询不经 listQuestions 的 5000 截断——大题库的旧年份真题卷不能被截掉
      const ordered = database.listQuestionsByPaper(params.paper)
      if (ordered.length < 30)
        throw new Error('该试卷在当前知识库中可用题目不足（联考去重后残余过少），无法整卷组卷')
      return database.createExam(
        {
          title: params.paper,
          subject: 'xingce',
          durationMinutes: 120,
          questionCount: ordered.length
        },
        ordered
      )
    },
    'exam.shenlunPapers': () => database.listShenlunPapers(),
    'exam.createShenlunPaper': (params) => {
      const ordered = database.listShenlunQuestionsByPaper(params.paper)
      if (ordered.length < 2) {
        throw new Error('该申论试卷可用大题不足 2 题，无法整卷连作')
      }
      const duration = Math.max(60, Math.min(240, Math.round(params.durationMinutes ?? 150)))
      return database.createExam(
        {
          title: params.paper,
          subject: 'shenlun',
          durationMinutes: duration,
          questionCount: ordered.length
        },
        ordered
      )
    },
    'exam.paperMatrix': (params) => database.listPaperProgressMatrix(params?.subject)
  }
}
