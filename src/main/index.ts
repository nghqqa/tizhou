import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, shell } from 'electron'
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, clampUiScale } from '../shared/defaults'
import { registerIpcHandlers } from './ipc'
import { AgentRuntime } from './services/agent-runtime'
import { AiService } from './services/ai'
import { DatabaseService, localDateKeyOf } from './services/database'
import { DiagnosticService } from './services/diagnostics'
import { IntegrationService } from './services/integrations'
import { KnowledgeBuilderService } from './services/knowledge-builder'
import { MigrationService } from './services/migration'
import { StudyService } from './services/study'
import { UpdateManager } from './services/updater'
import { VaultService } from './services/vault'
import { resolveTestRuntime } from './services/test-runtime'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let database: DatabaseService | undefined
let migration: MigrationService | undefined
let knowledgeBuilder: KnowledgeBuilderService | undefined

// 测试运行时判定（--smoke-test / WORKBENCH_E2E）：必须在 app.setPath 之前完成，
// 数据目录覆盖只允许在测试运行时（冒烟或 E2E）下生效——
// 正式包普通启动时单独设置 WORKBENCH_SMOKE_DATA_DIR 等环境变量不会改变任何行为
const testRuntime = resolveTestRuntime({
  isPackaged: app.isPackaged,
  argv: process.argv,
  env: process.env
})
const isSmokeTest = testRuntime.isSmokeTest
const isE2EMode = testRuntime.isE2EMode
const isTestRuntime = testRuntime.isTestRuntime

const updater = new UpdateManager({
  isE2EMode,
  e2eScenario: process.env.WORKBENCH_E2E_UPDATE_SCENARIO ?? 'none',
  getCurrentVersion: () => app.getVersion()
})

if (testRuntime.dataDirOverride) {
  app.setPath('userData', testRuntime.dataDirOverride)
}

function applyWindowZoom(uiScale: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.setZoomFactor(clampUiScale(uiScale) / 100)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: '#1B1917',
    title: '题舟',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 启动与每次页面加载完成时恢复持久化界面缩放
  const restoreSavedZoom = (): void => {
    if (!database) return
    applyWindowZoom(database.getAppSettings().uiScale)
  }
  mainWindow.webContents.on('did-finish-load', restoreSavedZoom)
  // 拦截 Ctrl/Cmd + / - / 0：直接走持久化 uiScale，避免与 Chromium 临时缩放失步
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !database) return
    if (input.key === 'F11' && !input.control && !input.meta && !input.alt) {
      event.preventDefault()
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
      return
    }
    if (input.alt || !(input.control || input.meta)) return
    let delta: number | 'reset' | undefined
    if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') delta = UI_SCALE_STEP
    else if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract')
      delta = -UI_SCALE_STEP
    else if (input.key === '0' || input.code === 'Numpad0') delta = 'reset'
    if (delta === undefined) return
    event.preventDefault()
    const current = clampUiScale(database.getAppSettings().uiScale)
    const next =
      delta === 'reset'
        ? 100
        : Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round((current + delta) / 5) * 5))
    const saved = database.saveAppSettings({ uiScale: next })
    applyWindowZoom(saved.uiScale)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workbench:settings-updated', saved)
    }
  })
  const sendFullscreen = (fullscreen: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workbench:fullscreen-changed', fullscreen)
    }
  }
  mainWindow.on('enter-full-screen', () => sendFullscreen(true))
  mainWindow.on('leave-full-screen', () => sendFullscreen(false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.once('ready-to-show', () => {
    restoreSavedZoom()
    mainWindow?.show()
  })
  // 截图/路由/滚动断言注入：仅测试运行时（冒烟或 E2E）生效
  if (isTestRuntime && process.env.WORKBENCH_SMOKE_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const capturePath = resolve(process.env.WORKBENCH_SMOKE_CAPTURE!)
        mkdirSync(dirname(capturePath), { recursive: true })
        try {
          const smokeRoute = process.env.WORKBENCH_SMOKE_ROUTE
          if (smokeRoute) {
            await mainWindow!.webContents.executeJavaScript(
              `window.location.hash = ${JSON.stringify(smokeRoute)}`
            )
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 4_500))
          }
          if (process.env.WORKBENCH_SMOKE_ASSERT_SCROLL === '1') {
            mainWindow!.show()
            mainWindow!.focus()
            mainWindow!.webContents.focus()
            const metrics = (await mainWindow!.webContents.executeJavaScript(`(() => {
              const workspace = document.querySelector('.workspace')
              if (!(workspace instanceof HTMLElement)) return { error: 'workspace missing' }
              workspace.scrollTop = 0
              const bounds = workspace.getBoundingClientRect()
              return {
                before: workspace.scrollTop,
                centerX: Math.round(bounds.left + bounds.width / 2),
                centerY: Math.round(bounds.top + bounds.height / 2),
                clientHeight: workspace.clientHeight,
                scrollHeight: workspace.scrollHeight,
                overflowY: getComputedStyle(workspace).overflowY
              }
            })()`)) as Record<string, unknown>
            if (!metrics.error) {
              mainWindow!.webContents.sendInputEvent({
                type: 'mouseMove',
                x: Number(metrics.centerX),
                y: Number(metrics.centerY)
              })
              for (let count = 0; count < 4; count += 1)
                mainWindow!.webContents.sendInputEvent({
                  type: 'mouseWheel',
                  x: Number(metrics.centerX),
                  y: Number(metrics.centerY),
                  deltaX: 0,
                  deltaY: -120,
                  canScroll: true
                })
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
              let after = Number(
                await mainWindow!.webContents.executeJavaScript(
                  `document.querySelector('.workspace')?.scrollTop ?? 0`
                )
              )
              if (after <= Number(metrics.before)) {
                const devtools = mainWindow!.webContents.debugger
                try {
                  if (!devtools.isAttached()) devtools.attach('1.3')
                  await devtools.sendCommand('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: Number(metrics.centerX),
                    y: Number(metrics.centerY)
                  })
                  await devtools.sendCommand('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: Number(metrics.centerX),
                    y: Number(metrics.centerY),
                    deltaX: 0,
                    deltaY: 480
                  })
                  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
                  after = Number(
                    await mainWindow!.webContents.executeJavaScript(
                      `document.querySelector('.workspace')?.scrollTop ?? 0`
                    )
                  )
                } finally {
                  if (devtools.isAttached()) devtools.detach()
                }
              }
              metrics.after = after
            }
            writeFileSync(`${capturePath}.scroll.json`, JSON.stringify(metrics, null, 2), 'utf8')
            if (
              metrics.error ||
              metrics.overflowY !== 'auto' ||
              Number(metrics.scrollHeight) <= Number(metrics.clientHeight) ||
              Number(metrics.after) <= Number(metrics.before)
            )
              throw new Error(`滚动冒烟检查失败：${JSON.stringify(metrics)}`)
          }
          const image = await mainWindow!.webContents.capturePage()
          writeFileSync(capturePath, image.toPNG())
          app.quit()
        } catch (error) {
          writeFileSync(
            `${capturePath}.error.txt`,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
            'utf8'
          )
          app.exit(1)
        }
      }, 1500)
    })
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const rendererUrl = pathToFileURL(join(currentDirectory, '../renderer/index.html'))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      try {
        if (new URL(url).origin === new URL(developmentUrl).origin) return
      } catch {
        /* 忽略非法 URL */
      }
    }
    try {
      const target = new URL(url)
      const normalizeForPlatform = (value: string): string =>
        process.platform === 'win32' ? value.toLowerCase() : value
      if (
        target.protocol === 'file:' &&
        normalizeForPlatform(target.host) === normalizeForPlatform(rendererUrl.host) &&
        normalizeForPlatform(decodeURIComponent(target.pathname)) ===
          normalizeForPlatform(decodeURIComponent(rendererUrl.pathname))
      ) {
        return
      }
    } catch {
      /* 忽略非法 URL */
    }
    event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else if (isE2EMode)
    void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'), {
      query: { e2e: '1' }
    })
  else void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
}

async function initialize(): Promise<void> {
  const dataDirectory = app.getPath('userData')
  const databasePath = join(dataDirectory, 'workbench.sqlite')
  const backupDirectory = join(dataDirectory, 'backups')
  // 迁移导入落盘的待换库文件：在打开数据库前完成替换（运行中的 sqlite 文件不可覆盖）
  const pendingImport = join(dataDirectory, 'pending-import.db')
  if (existsSync(pendingImport)) {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`
      if (existsSync(sidecar)) rmSync(sidecar)
    }
    if (existsSync(databasePath))
      renameSync(databasePath, join(dataDirectory, `workbench.pre-migration-${Date.now()}.sqlite`))
    renameSync(pendingImport, databasePath)
  }
  database = new DatabaseService(databasePath, dataDirectory, backupDirectory)
  migration = new MigrationService(database, dataDirectory)
  const vaults = new VaultService(database)
  const ai = new AiService(database)
  const integrations = new IntegrationService(database)
  const study = new StudyService(database, ai)
  const agent = new AgentRuntime(database, study, ai)
  const builder = new KnowledgeBuilderService(dataDirectory, process.resourcesPath, ai, vaults)
  knowledgeBuilder = builder
  const diagnostics = new DiagnosticService(database, ai, integrations, app.getVersion())
  vaults.ensureBuiltinVault()
  // 烟雾测试会立即退出，不必挂磁盘监听
  if (!isSmokeTest) vaults.startWatching()
  app.once('before-quit', () => {
    vaults.stopWatching()
    knowledgeBuilder?.dispose()
  })

  const settings = database.getAppSettings()
  if (settings.autoBackup) {
    // 当日去重按本地日期比对：备份 createdAt 是 UTC ISO（toISOString / 文件 birthtime），
    // 必须先转本地日期键再比较，否则北京时间 00:00~07:59 的启动每天都重复备份
    const today = localDateKeyOf(new Date())
    if (!database.listBackups().some((backup) => localDateKeyOf(backup.createdAt) === today)) {
      database.createBackup('automatic')
      database.pruneBackups(settings.backupRetention)
    }
  }

  registerIpcHandlers({
    database,
    migration,
    vaults,
    ai,
    integrations,
    study,
    agent,
    knowledgeBuilder: builder,
    diagnostics,
    updater,
    dataDirectory,
    isE2EMode,
    getMainWindow: () => mainWindow,
    applyWindowZoom,
    relaunchApp: () => {
      app.relaunch()
      app.quit()
    }
  })
}

// ── 启动烟雾测试：验证主进程可完整加载并初始化 ──
// （isSmokeTest 已在顶部测试运行时判定中定义）

if (isSmokeTest) {
  app.whenReady().then(async () => {
    try {
      await initialize()
      updater.setup()
      console.log('SMOKE_READY')
      app.exit(0)
    } catch (error) {
      console.error(`SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`)
      app.exit(1)
    }
  })
} else {
  app.whenReady().then(async () => {
    await initialize()
    createWindow()
    updater.setup()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => database?.close())
