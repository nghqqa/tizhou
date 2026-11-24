import type { BrowserWindow } from 'electron'
import type { WorkbenchMethod, WorkbenchMethodMap } from '../../shared/contracts'
import type { AiService } from '../services/ai'
import type { DatabaseService } from '../services/database'
import type { DiagnosticService } from '../services/diagnostics'
import type { IntegrationService } from '../services/integrations'
import type { KnowledgeBuilderService } from '../services/knowledge-builder'
import type { MigrationService } from '../services/migration'
import type { StudyService } from '../services/study'
import type { UpdateManager } from '../services/updater'
import type { VaultService } from '../services/vault'

export interface IpcContext {
  database: DatabaseService
  migration: MigrationService
  vaults: VaultService
  ai: AiService
  integrations: IntegrationService
  study: StudyService
  knowledgeBuilder: KnowledgeBuilderService
  diagnostics: DiagnosticService
  updater: UpdateManager
  dataDirectory: string
  isE2EMode: boolean
  getMainWindow: () => BrowserWindow | null
  applyWindowZoom: (uiScale: number) => void
  relaunchApp: () => void
}

export type IpcHandler<M extends WorkbenchMethod> = (
  params: WorkbenchMethodMap[M]['params']
) => Promise<WorkbenchMethodMap[M]['result']> | WorkbenchMethodMap[M]['result']

export type IpcHandlerMap = { [M in WorkbenchMethod]: IpcHandler<M> }
