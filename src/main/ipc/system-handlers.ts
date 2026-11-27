import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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
      const win = ctx.getMainWindow()
      const options = {
        title: params.title,
        properties: ['openDirectory'] as Array<'openDirectory'>
      }
      const selected = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
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
      // 恢复的数据库可能指向另一个知识库目录或不同的界面缩放：同步缩放、兜底内置库并重挂监听
      const settings = database.getAppSettings()
      applyWindowZoom(settings.uiScale)
      const vault = database.getActiveVault() ?? vaults.ensureBuiltinVault()
      vaults.startWatching()
      return {
        dashboard: database.getDashboard(),
        settings,
        vault,
        ai: ai.getConfig()
      }
    },
    'diagnostics.run': () => diagnostics.run(),
    'diagnostics.export': async () => {
      const report = diagnostics.run()
      const win = ctx.getMainWindow()
      const options = {
        title: '导出诊断报告',
        defaultPath: `题舟诊断-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const selected = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
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
      if (!existsSync(requested)) throw new Error('目标目录不存在')
      const realRequested = realpathSync(requested)
      const activeVault = database.getActiveVault()
      const allowedRoots = [
        realpathSync(resolve(dataDirectory)),
        ...(activeVault && !activeVault.isBuiltin && existsSync(activeVault.path)
          ? [realpathSync(resolve(activeVault.path))]
          : [])
      ]
      if (!allowedRoots.some((root) => isWithin(root, realRequested)))
        throw new Error('该路径不在应用数据或活动知识库范围内')
      if (!statSync(realRequested).isDirectory()) throw new Error('仅支持打开目录路径')
      const error = await shell.openPath(realRequested)
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
