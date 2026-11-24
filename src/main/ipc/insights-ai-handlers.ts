import { writeFileSync } from 'node:fs'
import { dialog } from 'electron'
import type { LearningPlan } from '../../shared/contracts'
import { renderReportMarkdown, reportFileName } from '../services/report-markdown'
import type { IpcContext, IpcHandlerMap } from './types'

type InsightsAiHandlerKeys =
  | 'reports.get'
  | 'reports.exportMarkdown'
  | 'reports.exportObsidian'
  | 'diagnosis.get'
  | 'plan.preview'
  | 'plan.apply'
  | 'plan.active'
  | 'plan.item.complete'
  | 'plan.recordRead'
  | 'plan.cancel'
  | 'ai.config.get'
  | 'ai.config.save'
  | 'ai.config.clearCredential'
  | 'ai.vlmConfig.get'
  | 'ai.vlmConfig.save'
  | 'ai.vlmConfig.clearCredential'
  | 'ai.vlmConfig.test'
  | 'ai.providers'
  | 'ai.models.discover'
  | 'ai.test'
  | 'ai.ask'
  | 'ai.askStream'
  | 'ai.stream.cancel'
  | 'ai.conversations.list'
  | 'ai.conversations.save'
  | 'ai.conversations.delete'
  | 'aiTraining.record'
  | 'aiTraining.history'

export function createInsightsAiHandlers(
  ctx: IpcContext
): Pick<IpcHandlerMap, InsightsAiHandlerKeys> {
  const { database, study, integrations, ai } = ctx
  return {
    'reports.get': (params) => database.getReport(params.range),
    'reports.exportMarkdown': async (params) => {
      const report = database.getReport(params.range)
      const selected = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: '导出学习报告',
        defaultPath: reportFileName(params.range),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (selected.canceled || !selected.filePath) return undefined
      writeFileSync(selected.filePath, renderReportMarkdown(report), 'utf8')
      return selected.filePath
    },
    'reports.exportObsidian': (params) =>
      integrations.exportReportToVault(database.getReport(params.range)),
    'diagnosis.get': () => study.getDiagnosis(),
    'plan.preview': (params) => study.previewPlan(params),
    'plan.apply': (params) => {
      const plan: LearningPlan = {
        ...params.plan,
        status: 'active',
        startDate: new Date().toISOString()
      }
      return database.savePlan(plan)
    },
    'plan.active': () => database.getActivePlan(),
    'plan.item.complete': (params) =>
      database.completePlanItem(params.planId, params.itemId, params.completed),
    'plan.recordRead': (params) => database.recordPlanRead(params.category, params.minutes),
    'plan.cancel': (params) => database.cancelPlan(params.planId),
    'ai.config.get': () => ai.getConfig(),
    'ai.config.save': (params) => ai.saveConfig(params),
    'ai.config.clearCredential': () => ai.clearCredential(),
    'ai.vlmConfig.get': () => ai.getVlmConfig(),
    'ai.vlmConfig.save': (params) => ai.saveVlmConfig(params),
    'ai.vlmConfig.clearCredential': () => ai.clearVlmCredential(),
    'ai.vlmConfig.test': () => ai.testVlm(),
    'ai.providers': () => ai.providers(),
    'ai.models.discover': () => ai.discoverModels(),
    'ai.test': () => ai.test(),
    'ai.ask': (params) => ai.ask(params),
    'ai.askStream': async (params) => {
      const sendEvent = (payload: {
        requestId: string
        type: 'chunk' | 'done' | 'error' | 'aborted'
        delta?: string
        content?: string
        error?: string
      }): void => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) win.webContents.send('workbench:ai-stream', payload)
      }
      try {
        const result = await ai.askStream(params, {
          onChunk: (delta) => sendEvent({ requestId: params.requestId, type: 'chunk', delta })
        })
        sendEvent({
          requestId: params.requestId,
          type: result.aborted ? 'aborted' : 'done',
          content: result.content
        })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendEvent({ requestId: params.requestId, type: 'error', error: message })
        throw error
      }
    },
    'ai.stream.cancel': (params) => ai.cancelStream(params.requestId),
    'ai.conversations.list': (params) => database.listAiConversations(params?.limit),
    'ai.conversations.save': (params) => database.saveAiConversation(params),
    'ai.conversations.delete': (params) => {
      database.deleteAiConversation(params.id)
      return true
    },
    'aiTraining.record': (params) => database.saveAiTrainingRecord(params),
    'aiTraining.history': () => database.listAiTrainingRecords()
  }
}
