import { createRequire } from 'node:module'
import type { AppUpdateStatus } from '../../shared/contracts'
import { fetchReleaseNotes, resolveUpdateFeed } from './update-feed'

// electron-updater 是 CommonJS 包，用 createRequire 兼容 ESM 主进程
const nodeRequire = createRequire(import.meta.url)

// E2E 场景驱动的 mock 更新器：WORKBENCH_E2E=1 时替换真实 autoUpdater，
// IPC 行为保持一致（check/download/install 事件流），由场景变量驱动结果。
export function createE2EMockUpdater(scenario: string) {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>()
  const on = (event: string, cb: (payload?: unknown) => void): void => {
    const list = listeners.get(event) ?? []
    list.push(cb)
    listeners.set(event, list)
  }
  const emit = (event: string, payload?: unknown): void => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    on,
    async checkForUpdates() {
      emit('checking-for-update')
      if (scenario === 'error') {
        const error = new Error('模拟更新服务不可用')
        emit('error', error)
        throw error
      }
      if (scenario === 'available') emit('update-available', { version: '9.9.9' })
      else emit('update-not-available')
      return null
    },
    async downloadUpdate() {
      if (scenario !== 'available') {
        emit('update-not-available')
        return null
      }
      emit('download-progress', { percent: 42 })
      emit('download-progress', { percent: 100 })
      emit('update-downloaded')
      return null
    },
    quitAndInstall() {
      // E2E 不做真实安装；downloaded 状态保留供断言
    }
  }
}

type AutoUpdaterInstance = typeof import('electron-updater').autoUpdater

export interface UpdateManagerOptions {
  isE2EMode: boolean
  e2eScenario: string
  getCurrentVersion: () => string
}

/** 自动更新器封装：E2E 模式使用可控 mock，正式包使用 electron-updater 并自动探测国内镜像/GitHub。 */
export class UpdateManager {
  private readonly autoUpdater: AutoUpdaterInstance
  private updateStatus: Omit<AppUpdateStatus, 'currentVersion'> = {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false
  }

  constructor(private readonly options: UpdateManagerOptions) {
    const electronUpdater = nodeRequire('electron-updater') as typeof import('electron-updater')
    // mock 更新器只在 isE2EMode 下启用；正式包始终使用真实 electron-updater
    this.autoUpdater = options.isE2EMode
      ? (createE2EMockUpdater(options.e2eScenario) as unknown as AutoUpdaterInstance)
      : electronUpdater.autoUpdater
  }

  setup(): void {
    this.autoUpdater.autoDownload = false
    this.autoUpdater.autoInstallOnAppQuit = true
    this.autoUpdater.logger = null

    this.autoUpdater.on('checking-for-update', () => {
      this.updateStatus = { ...this.updateStatus, checking: true, error: undefined }
    })
    this.autoUpdater.on('update-available', (info) => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        available: true,
        version: info.version,
        error: undefined
      }
    })
    this.autoUpdater.on('update-not-available', () => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        available: false,
        error: undefined
      }
    })
    this.autoUpdater.on('download-progress', (progress) => {
      this.updateStatus = {
        ...this.updateStatus,
        downloading: true,
        progress: Math.round(progress.percent)
      }
    })
    this.autoUpdater.on('update-downloaded', () => {
      this.updateStatus = {
        ...this.updateStatus,
        downloading: false,
        downloaded: true,
        progress: 100
      }
    })
    this.autoUpdater.on('error', (error) => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        downloading: false,
        error: error.message
      }
    })
  }

  getStatus(): AppUpdateStatus {
    return { ...this.updateStatus, currentVersion: this.options.getCurrentVersion() }
  }

  async check(): Promise<AppUpdateStatus> {
    try {
      // 防重入：检查进行中直接返回当前状态（渲染层与主进程双保险）
      if (this.updateStatus.checking) return this.getStatus()
      // 网络自动探测：cnb 可达且版本不落后 → 从国内镜像检查；否则回退 GitHub
      // （E2E 模式下跳过真实探测：检查结果由 mock updater 决定）
      const feed = await resolveUpdateFeed(fetch, { probeDisabled: this.options.isE2EMode })
      if (feed.provider === 'generic' && feed.url) {
        this.autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
      }
      this.updateStatus = {
        ...this.updateStatus,
        checking: true,
        source: feed.source,
        releaseNotes: undefined
      }
      await this.autoUpdater.checkForUpdates()
      if (this.updateStatus.available && this.updateStatus.version) {
        const notes = await fetchReleaseNotes(this.updateStatus.version, feed.source, fetch, {
          probeDisabled: this.options.isE2EMode
        })
        if (notes) this.updateStatus = { ...this.updateStatus, releaseNotes: notes }
      }
      return this.getStatus()
    } catch (error) {
      this.updateStatus = { ...this.updateStatus, checking: false }
      return {
        ...this.getStatus(),
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  async download(): Promise<AppUpdateStatus> {
    try {
      // 防重入：仅在「发现更新且未在下载、未下载完成」时允许发起下载
      if (
        !this.updateStatus.available ||
        this.updateStatus.downloading ||
        this.updateStatus.downloaded
      )
        return this.getStatus()
      this.updateStatus = { ...this.updateStatus, downloading: true }
      await this.autoUpdater.downloadUpdate()
      return this.getStatus()
    } catch (error) {
      this.updateStatus = { ...this.updateStatus, downloading: false }
      return {
        ...this.getStatus(),
        error: error instanceof Error ? error.message : '下载更新失败'
      }
    }
  }

  install(): AppUpdateStatus {
    // 未下载完成不允许安装（安装失败不会卡状态：error 事件会把 downloaded 复位）
    if (!this.updateStatus.downloaded) return this.getStatus()
    this.autoUpdater.quitAndInstall()
    return { ...this.updateStatus, currentVersion: this.options.getCurrentVersion() }
  }
}
