import { dialog } from 'electron'
import type { IpcContext, IpcHandlerMap } from './types'

type VaultHandlerKeys =
  | 'bootstrap'
  | 'dashboard.get'
  | 'vault.choose'
  | 'vault.connect'
  | 'vault.reindex'
  | 'vault.list'
  | 'vault.active'
  | 'vault.switch'
  | 'vault.clearWarnings'
  | 'vault.snapshots'
  | 'vault.rollback'
  | 'vault.search'
  | 'vault.listSummary'
  | 'vault.question'
  | 'questions.update'
  | 'vault.normalizeRegions'
  | 'vault.categories'
  | 'vault.facets'
  | 'vault.asset'
  | 'documents.list'

export function createVaultHandlers(ctx: IpcContext): Pick<IpcHandlerMap, VaultHandlerKeys> {
  const { database, vaults, ai, knowledgeBuilder } = ctx
  return {
    bootstrap: () => ({
      dashboard: database.getDashboard(),
      settings: database.getAppSettings(),
      vault: database.getActiveVault()!,
      ai: ai.getConfig()
    }),
    'dashboard.get': () => database.getDashboard(),
    'vault.choose': async () => {
      const selected = await dialog.showOpenDialog(ctx.getMainWindow()!, {
        title: '选择 Markdown 知识库目录',
        properties: ['openDirectory']
      })
      return selected.canceled ? undefined : selected.filePaths[0]
    },
    'vault.connect': (params) => {
      const connected = vaults.connect(params.path)
      vaults.startWatching()
      return connected
    },
    'vault.reindex': () => vaults.reindex(),
    'vault.list': () => database.listVaults(),
    // 渲染层在窗口重新获得焦点时拉取，反映磁盘监听触发的自动重索引结果
    'vault.active': () => database.getActiveVault(),
    'vault.switch': (params) => {
      const switched = database.switchVault(params.id)
      vaults.startWatching()
      return switched
    },
    'vault.clearWarnings': () => {
      database.clearActiveVaultWarnings()
      return database.getActiveVault()
    },
    'vault.snapshots': (params) => database.listVaultSnapshots(params.vaultId),
    'vault.rollback': (params) => {
      const rolledBack = database.rollbackVaultSnapshot(params.snapshotId)
      vaults.startWatching()
      return rolledBack
    },
    'vault.search': (params) => database.listQuestions(params),
    'vault.listSummary': (params) => database.listQuestionSummaries(params),
    'vault.question': (params) => database.getQuestion(params.id),
    'questions.update': (params) => vaults.updateQuestion(params),
    'vault.normalizeRegions': () => database.normalizeActiveVaultRegions(),
    'vault.categories': (params) => database.listCategories(params?.subject),
    'vault.facets': (params) => database.getQuestionFacets(params?.subject, params?.region),
    'vault.asset': (params) => {
      try {
        return vaults.readAssetDataUrl(params.sourceFilePath, params.assetPath)
      } catch {
        // 暂存产物（任务 raw 目录）不在知识库内——回退到任务目录校验读取
        return knowledgeBuilder.readJobAssetDataUrl(params.sourceFilePath, params.assetPath)
      }
    },
    'documents.list': (params) => database.listDocuments(params)
  }
}
