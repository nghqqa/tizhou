import { writeFileSync } from 'node:fs'
import { dialog } from 'electron'
import {
  libraryExportFileName,
  renderQuestionLibraryHtml,
  renderQuestionLibraryMarkdown
} from '../services/library-export'
import type { IpcContext, IpcHandlerMap } from './types'

type StudyHandlerKeys =
  | 'questions.get'
  | 'questions.userMeta'
  | 'wrongQuestion.setCause'
  | 'questions.library'
  | 'questions.library.export'
  | 'practice.select'
  | 'practice.session.start'
  | 'practice.session.active'
  | 'practice.session.results'
  | 'practice.session.update'
  | 'practice.session.complete'
  | 'questions.similar'
  | 'attempt.submit'
  | 'favorite.set'
  | 'favorite.get'
  | 'note.save'
  | 'note.get'
  | 'review.due'
  | 'review.rate'
  | 'review.enqueue'
  | 'snippets.list'
  | 'snippets.save'
  | 'snippets.delete'
  | 'draft.save'
  | 'draft.get'
  | 'constructed.evaluate'
  | 'constructed.saveSelfCheck'
  | 'constructed.history'

export function createStudyHandlers(ctx: IpcContext): Pick<IpcHandlerMap, StudyHandlerKeys> {
  const { database, study } = ctx
  return {
    'questions.get': (params) => database.getQuestion(params.id),
    'questions.userMeta': (params) => database.getQuestionsUserMeta(params.questionIds),
    'wrongQuestion.setCause': (params) => {
      database.setWrongQuestionCause(params.questionId, params.wrongCause)
      return true
    },
    'questions.library': (params) => database.listQuestionLibrary(params),
    'questions.library.export': async (params) => {
      const items = database.listQuestionLibrary({
        tab: params.tab,
        category: params.category,
        wrongCause: params.wrongCause,
        query: params.query,
        limit: 500
      })
      if (!items.length) throw new Error('当前筛选下没有可导出的题目')
      const isHtml = params.format === 'html'
      const selected = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: isHtml ? '导出可打印题单 (HTML)' : '导出题单 (Markdown)',
        defaultPath: libraryExportFileName(params),
        filters: isHtml
          ? [{ name: 'HTML 打印版', extensions: ['html'] }]
          : [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (selected.canceled || !selected.filePath) return undefined
      const output = isHtml
        ? renderQuestionLibraryHtml(items, params)
        : renderQuestionLibraryMarkdown(items, params)
      writeFileSync(selected.filePath, output, 'utf8')
      return selected.filePath
    },
    'practice.select': (params) => study.selectPractice(params),
    'practice.session.start': (params) => {
      const questions = study.selectPractice(params)
      return database.createPracticeSession(params, questions)
    },
    'practice.session.active': (params) => database.getActivePracticeSession(params.mode),
    'practice.session.results': (params) => database.getSessionAttempts(params.id),
    'practice.session.update': (params) => database.updatePracticeSession(params.id, params),
    'practice.session.complete': (params) =>
      database.completePracticeSession(params.id, params.abandoned),
    'questions.similar': (params) => database.findSimilarQuestions(params.id, params.limit),
    'attempt.submit': (params) => database.submitAttempt(params),
    'favorite.set': (params) => database.setFavorite(params.questionId, params.favorite),
    'favorite.get': (params) => database.isFavorite(params.questionId),
    'note.save': (params) => database.saveNote(params.questionId, params.content),
    'note.get': (params) => database.getNote(params.questionId),
    'review.due': (params) => database.getDueReviews(params?.limit),
    'review.rate': (params) => database.rateReviewAttempt(params),
    'review.enqueue': (params) =>
      database.enqueueReviewQuestions(params.questionIds, params.reason),
    'snippets.list': (params) => database.listStudySnippets(params),
    'snippets.save': (params) => database.saveStudySnippet(params),
    'snippets.delete': (params) => database.deleteStudySnippet(params.id),
    'draft.save': (params) => database.saveDraft(params),
    'draft.get': (params) => database.getDraft(params.id),
    'constructed.evaluate': (params) =>
      study.evaluateConstructed(
        params,
        params.requestId
          ? {
              onChunk: (delta) => {
                const win = ctx.getMainWindow()
                if (win && !win.isDestroyed()) {
                  win.webContents.send('workbench:ai-stream', {
                    requestId: params.requestId!,
                    type: 'chunk',
                    delta
                  })
                }
              },
              onReset: () => {
                const win = ctx.getMainWindow()
                if (win && !win.isDestroyed()) {
                  win.webContents.send('workbench:ai-stream', {
                    requestId: params.requestId!,
                    type: 'reset'
                  })
                }
              }
            }
          : undefined
      ),
    'constructed.saveSelfCheck': (params) => database.saveSelfCheckConstructed(params),
    'constructed.history': (params) => database.listConstructedAttempts(params)
  }
}
