import { ipcMain } from 'electron'
import type { WorkbenchRequest } from '../../shared/contracts'
import { createBuilderHandlers } from './builder-handlers'
import { createExamHandlers } from './exam-handlers'
import { createInsightsAiHandlers } from './insights-ai-handlers'
import { createStudyHandlers } from './study-handlers'
import { createSystemHandlers } from './system-handlers'
import type { IpcContext, IpcHandlerMap } from './types'
import { createVaultHandlers } from './vault-handlers'

export type { IpcContext, IpcHandler, IpcHandlerMap } from './types'

export function registerIpcHandlers(ctx: IpcContext): void {
  const handlers: IpcHandlerMap = {
    ...createVaultHandlers(ctx),
    ...createBuilderHandlers(ctx),
    ...createStudyHandlers(ctx),
    ...createExamHandlers(ctx),
    ...createInsightsAiHandlers(ctx),
    ...createSystemHandlers(ctx)
  }

  ipcMain.handle('workbench:invoke', async (event, request: WorkbenchRequest) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
      throw new Error('拒绝来自子框架的请求')
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.method !== 'string' ||
      !Object.hasOwn(handlers, request.method)
    ) {
      throw new Error(`未知或不支持的 IPC 方法：${String(request?.method ?? '')}`)
    }
    const handler = handlers[request.method] as (params: unknown) => unknown
    return handler('params' in request ? request.params : undefined)
  })
}
