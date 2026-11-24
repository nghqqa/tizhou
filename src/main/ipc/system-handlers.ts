import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dialog, shell } from 'electron'
import { isWithin } from '../utils/common'
import type { IpcContext, IpcHandlerMap } from './types'

type SystemHandlerKeys =
  | 'migration.export'
  | 'migration.import'
  | 'app.update.status'
  | 'app.update.check'
  | 'app.update.download'
  | 'app.update.install'
  | 'folder.pick'
  | 'settings.get'
  | 'settings.save'
  | 'runtime.status'
  | 'integration.get'
  | 'integration.save'
  | 'integration.openObsidian'
  | 'obsidian.backups'
  | 'obsidian.backup'
  | 'obsidian.restore'
  | 'obsidian.safeMode'
  | 'backup.create'
  | 'backup.list'
  | 'backup.restore'
  | 'diagnostics.run'
  | 'diagnostics.export'
  | 'user.resetLearningData'
  | 'shell.openPath'
  | 'window.fullscreen.toggle'
  | 'window.fullscreen.get'

export function createSystemHandlers(ctx: IpcContext): Pick<IpcHandlerMap, SystemHandlerKeys> {
  const {
    database,
    migration,
    vaults,
    ai,
    integrations,
    diagnostics,
    updater,
    dataDirectory,
    applyWindowZoom,
    relaunchApp
  } = ctx

  return {
    'migration.export': (params) => migration.exportTo(params.targetPath),
    'migration.import': (params) => {
      const result = migration.importFrom(params.sourcePath, params.vaultTargetPath)
      // 响应送达渲染进程后自动重启完成换库
      setTimeout(() => relaunchApp(), 1500)
      return result
    },
    'app.update.status': () => updater.getStatus(),
    'app.update.check': () => updater.check(),
    'app.update.download': () => updater.download(),
    'app.update.install': () => updater.install(),
    'folder.pick': async (params) => {
      const selected = await dialog.showOpenDialog(ctx.getMainWindow()!, {
        title: params.title,
        properties: ['openDirectory']
      })
      return selected.canceled ? undefined : selected.filePaths[0]
    },
    'settings.get': () => database.getAppSettings(),
    'settings.save': (params) => {
      const saved = database.saveAppSettings(params)
      applyWindowZoom(saved.uiScale)
      return saved
    },
    'runtime.status': () => diagnostics.runtimeStatus(),
    'integration.get': () => integrations.getConfig(),
    'integration.save': (params) => integrations.saveConfig(params),
    'integration.openObsidian': () => integrations.openObsidian(),
    'obsidian.backups': () => integrations.listObsidianBackups(),
    'obsidian.backup': () => integrations.createObsidianBackup(),
    'obsidian.restore': (params) => integrations.restoreObsidianBackup(params.id),
    'obsidian.safeMode': () => integrations.enableObsidianSafeMode(),
    'backup.create': () => {
      const backup = database.createBackup('manual')
      database.pruneBackups(database.getAppSettings().backupRetention)
      return backup
    },
    'backup.list': () => database.listBackups(),
    'backup.restore': (params) => {
      database.restoreBackup(params.path)
      // 恢复的数据库可能指向另一个知识库目录：重新挂载磁盘监听，避免旧 watcher 失联
      vaults.startWatching()
      return {
        dashboard: database.getDashboard(),
        settings: database.getAppSettings(),
        vault: database.getActiveVault()!,
        ai: ai.getConfig()
      }
    },
    'diagnostics.run': () => diagnostics.run(),
    'diagnostics.export': async () => {
      const report = diagnostics.run()
      const selected = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: '导出诊断报告',
        defaultPath: `题舟诊断-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePath) return undefined
      writeFileSync(selected.filePath, JSON.stringify(report, null, 2), 'utf8')
      return selected.filePath
    },
    'user.resetLearningData': (params) => {
      if (params.confirmation !== '清空学习数据') throw new Error('确认文字不匹配')
      database.createBackup('pre-restore')
      database.resetLearningData()
      return database.getDashboard()
    },
    'shell.openPath': async (params) => {
      const requested = resolve(params.path)
      const activeVault = database.getActiveVault()
      const allowedRoots = [
        resolve(dataDirectory),
        ...(activeVault && !activeVault.isBuiltin ? [resolve(activeVault.path)] : [])
      ]
      if (!allowedRoots.some((root) => isWithin(root, requested)))
        throw new Error('该路径不在应用数据或活动知识库范围内')
      const error = await shell.openPath(requested)
      if (error) throw new Error(error)
      return true
    },
    'window.fullscreen.toggle': () => {
      const win = ctx.getMainWindow()
      if (!win || win.isDestroyed()) return false
      const next = !win.isFullScreen()
      win.setFullScreen(next)
      return next
    },
    'window.fullscreen.get': () => {
      const win = ctx.getMainWindow()
      return Boolean(win && !win.isDestroyed() && win.isFullScreen())
    }
  }
}
