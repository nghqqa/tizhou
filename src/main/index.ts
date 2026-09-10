import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { LearningPlan, WorkbenchRequest } from '../shared/contracts'
import { AiService } from './services/ai'
import { DatabaseService } from './services/database'
import { DiagnosticService } from './services/diagnostics'
import { IntegrationService } from './services/integrations'
import { KnowledgeBuilderService } from './services/knowledge-builder'
import { MigrationService } from './services/migration'
import { renderReportMarkdown, reportFileName } from './services/report-markdown'
import { StudyService } from './services/study'
import { VaultService } from './services/vault'
import { resolveTestRuntime } from './services/test-runtime'
import { resolveUpdateFeed } from './services/update-feed'

// electron-updater 是 CommonJS 包，用 createRequire 兼容 ESM 主进程
const nodeRequire = createRequire(import.meta.url)

// E2E 场景驱动的 mock 更新器：WORKBENCH_E2E=1 时替换真实 autoUpdater，
// IPC 行为保持一致（check/download/install 事件流），由场景变量驱动结果。
function createE2EMockUpdater(scenario: string) {
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

const electronUpdater = nodeRequire('electron-updater') as typeof import('electron-updater')

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let database: DatabaseService | undefined
let migration: MigrationService | undefined

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return (
    path === '' ||
    (path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path))
  )
}

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

// mock 更新器只在 isE2EMode 下启用；正式包始终使用真实 electron-updater
const autoUpdater = isE2EMode
  ? (createE2EMockUpdater(
      process.env.WORKBENCH_E2E_UPDATE_SCENARIO ?? 'none'
    ) as unknown as typeof electronUpdater.autoUpdater)
  : electronUpdater.autoUpdater
// E2E 注入点：WORKBENCH_E2E_FAIL_SAVE=once 时第一次 exam.save 抛错（验证交卷阻止与重试）
let e2eExamSaveFailedOnce = false

if (testRuntime.dataDirOverride) {
  app.setPath('userData', testRuntime.dataDirOverride)
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if ((developmentUrl && url.startsWith(developmentUrl)) || url.startsWith('file://')) return
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
  const knowledgeBuilder = new KnowledgeBuilderService(
    dataDirectory,
    process.resourcesPath,
    ai,
    vaults
  )
  const diagnostics = new DiagnosticService(database, ai, integrations, app.getVersion())
  vaults.ensureBuiltinVault()
  // 烟雾测试会立即退出，不必挂磁盘监听
  if (!isSmokeTest) vaults.startWatching()
  app.once('before-quit', () => vaults.stopWatching())

  const settings = database.getAppSettings()
  if (settings.autoBackup) {
    const today = new Date().toISOString().slice(0, 10)
    if (!database.listBackups().some((backup) => backup.createdAt.startsWith(today))) {
      database.createBackup('automatic')
      database.pruneBackups(settings.backupRetention)
    }
  }

  ipcMain.handle('workbench:invoke', async (event, request: WorkbenchRequest) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
      throw new Error('拒绝来自子框架的请求')
    switch (request.method) {
      case 'bootstrap':
        return {
          dashboard: database!.getDashboard(),
          settings: database!.getAppSettings(),
          vault: database!.getActiveVault(),
          ai: ai.getConfig()
        }
      case 'dashboard.get':
        return database!.getDashboard()
      case 'vault.choose': {
        const selected = await dialog.showOpenDialog(mainWindow!, {
          title: '选择 Markdown 知识库目录',
          properties: ['openDirectory']
        })
        return selected.canceled ? undefined : selected.filePaths[0]
      }
      case 'vault.connect': {
        const connected = vaults.connect(request.params.path)
        vaults.startWatching()
        return connected
      }
      case 'vault.reindex':
        return vaults.reindex()
      case 'vault.list':
        return database!.listVaults()
      case 'vault.active':
        // 渲染层在窗口重新获得焦点时拉取，反映磁盘监听触发的自动重索引结果
        return database!.getActiveVault()
      case 'vault.switch': {
        const switched = database!.switchVault(request.params.id)
        vaults.startWatching()
        return switched
      }
      case 'vault.clearWarnings':
        database!.clearActiveVaultWarnings()
        return database!.getActiveVault()
      case 'vault.snapshots':
        return database!.listVaultSnapshots(request.params.vaultId)
      case 'vault.rollback': {
        const rolledBack = database!.rollbackVaultSnapshot(request.params.snapshotId)
        vaults.startWatching()
        return rolledBack
      }
      case 'vault.search':
        return database!.listQuestions(request.params)
      case 'vault.categories':
        return database!.listCategories(request.params?.subject)
      case 'vault.facets':
        return database!.getQuestionFacets(request.params?.subject)
      case 'vault.asset': {
        try {
          return vaults.readAssetDataUrl(request.params.sourceFilePath, request.params.assetPath)
        } catch {
          // 暂存产物（任务 raw 目录）不在知识库内——回退到任务目录校验读取
          return knowledgeBuilder.readJobAssetDataUrl(
            request.params.sourceFilePath,
            request.params.assetPath
          )
        }
      }
      case 'knowledgeBuilder.source.choose': {
        const selected = await dialog.showOpenDialog(mainWindow!, {
          title: '选择未整理的知识库原料目录',
          properties: ['openDirectory']
        })
        return selected.canceled ? undefined : selected.filePaths[0]
      }
      case 'knowledgeBuilder.source.scan':
        return knowledgeBuilder.scan(request.params.path)
      case 'knowledgeBuilder.engine.status':
        return knowledgeBuilder.engineStatus()
      case 'knowledgeBuilder.engine.install':
        return knowledgeBuilder.installEngine()
      case 'knowledgeBuilder.engine.gpu.install':
        return knowledgeBuilder.installGpuAccelerator()
      case 'knowledgeBuilder.engine.gpu.remove':
        return knowledgeBuilder.removeGpuAccelerator()
      case 'knowledgeBuilder.engine.mirror.set':
        await knowledgeBuilder.setPipMirror(request.params.id)
        return knowledgeBuilder.engineStatus()
      case 'knowledgeBuilder.job.start':
        return knowledgeBuilder.startJob(request.params)
      case 'knowledgeBuilder.job.latest':
        return knowledgeBuilder.latestJob()
      case 'knowledgeBuilder.job.get':
        return knowledgeBuilder.getJob(request.params.id)
      case 'knowledgeBuilder.job.cancel':
        return knowledgeBuilder.cancelJob(request.params.id)
      case 'knowledgeBuilder.job.retry':
        return knowledgeBuilder.retryJob(request.params.id, request.params.sourceIds)
      case 'knowledgeBuilder.job.revert':
        return knowledgeBuilder.revertImport(request.params.id)
      case 'knowledgeBuilder.artifact.get':
        return knowledgeBuilder.getArtifact(request.params.jobId, request.params.artifactId)
      case 'knowledgeBuilder.artifact.review':
        return knowledgeBuilder.reviewArtifact(
          request.params.jobId,
          request.params.artifactId,
          request.params.status,
          request.params.confirmHumanReview
        )
      case 'knowledgeBuilder.artifacts.reviewMany':
        return knowledgeBuilder.reviewArtifacts(
          request.params.jobId,
          request.params.artifactIds,
          request.params.status
        )
      case 'knowledgeBuilder.evidence.get':
        return knowledgeBuilder.readEvidenceAsset(request.params.jobId, request.params.assetId)
      case 'knowledgeBuilder.cache.stats':
        return knowledgeBuilder.cacheStats()
      case 'knowledgeBuilder.cache.clear':
        return knowledgeBuilder.clearConversionCache(request.params.sourceName)
      case 'knowledgeBuilder.publish':
        return knowledgeBuilder.publish(request.params.jobId)
      case 'documents.list':
        return database!.listDocuments(request.params)
      case 'questions.get':
        return database!.getQuestion(request.params.id)
      case 'practice.select':
        return study.selectPractice(request.params)
      case 'practice.session.start': {
        const questions = study.selectPractice(request.params)
        return database!.createPracticeSession(request.params, questions)
      }
      case 'practice.session.active':
        return database!.getActivePracticeSession(request.params.mode)
      case 'practice.session.update':
        return database!.updatePracticeSession(request.params.id, request.params)
      case 'practice.session.complete':
        return database!.completePracticeSession(request.params.id, request.params.abandoned)
      case 'questions.similar':
        return database!.findSimilarQuestions(request.params.id, request.params.limit)
      case 'attempt.submit':
        return database!.submitAttempt(request.params)
      case 'favorite.set':
        return database!.setFavorite(request.params.questionId, request.params.favorite)
      case 'note.save':
        return database!.saveNote(request.params.questionId, request.params.content)
      case 'note.get':
        return database!.getNote(request.params.questionId)
      case 'review.due':
        return database!.getDueReviews(request.params?.limit)
      case 'exam.create': {
        const questions = study.selectPractice({
          mode: 'random',
          count: request.params.questionCount,
          filter: { ...request.params.filter, subject: request.params.subject }
        })
        return database!.createExam(request.params, questions)
      }
      case 'exam.active':
        return database!.getActiveExam()
      case 'exam.save':
        // E2E 注入点：首次保存失败，验证「保存失败阻止交卷 → 重试后放行」。
        // 由 isE2EMode（非打包 + 显式环境变量）双重门控，正式包永不触发
        if (isE2EMode && process.env.WORKBENCH_E2E_FAIL_SAVE === 'once' && !e2eExamSaveFailedOnce) {
          e2eExamSaveFailedOnce = true
          throw new Error('E2E：模拟答案保存失败')
        }
        return database!.saveExamAnswer(request.params.examId, request.params.answer)
      case 'exam.finish':
        return database!.finishExam(request.params.examId)
      case 'exam.history':
        return database!.listExams()
      case 'exam.get':
        return database!.getExamById(request.params.examId) ?? null
      case 'exam.papers':
        return database!.listPapers()
      case 'exam.createPaper': {
        // 原卷模考：按 papers 复现记录取题、按卷内题号排序，整卷限时作答
        const paper = request.params.paper
        const ordered = database!
          .listQuestions({ subject: 'xingce', limit: 5000 })
          .flatMap((question) => {
            const ref = question.papers?.find((item) => item.paper === paper)
            return ref ? [{ question, order: ref.order }] : []
          })
          .sort((a, b) => a.order - b.order)
          .map((item) => item.question)
        if (ordered.length < 30)
          throw new Error('该试卷在当前知识库中可用题目不足（联考去重后残余过少），无法整卷组卷')
        return database!.createExam(
          {
            title: paper,
            subject: 'xingce',
            durationMinutes: 120,
            questionCount: ordered.length
          },
          ordered
        )
      }
      case 'migration.export':
        return migration!.exportTo(request.params.targetPath)
      case 'migration.import': {
        const result = migration!.importFrom(
          request.params.sourcePath,
          request.params.vaultTargetPath
        )
        // 响应送达渲染进程后自动重启完成换库
        setTimeout(() => {
          app.relaunch()
          app.quit()
        }, 1500)
        return result
      }
      case 'app.update.status':
        return getUpdateStatus()
      case 'app.update.check':
        try {
          // 防重入：检查进行中直接返回当前状态（渲染层与主进程双保险）
          if (updateStatus.checking) return getUpdateStatus()
          // 网络自动探测：cnb 可达且版本不落后 → 从国内镜像检查；否则回退 GitHub
          // （E2E 模式下跳过真实探测：检查结果由 mock updater 决定）
          const feed = await resolveUpdateFeed(fetch, { probeDisabled: isE2EMode })
          if (feed.provider === 'generic' && feed.url) {
            autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
          }
          updateStatus = { ...updateStatus, checking: true, source: feed.source }
          await autoUpdater.checkForUpdates()
          return getUpdateStatus()
        } catch (error) {
          updateStatus = { ...updateStatus, checking: false }
          return {
            ...getUpdateStatus(),
            error: error instanceof Error ? error.message : '检查更新失败'
          }
        }
      case 'app.update.download':
        try {
          // 防重入：仅在「发现更新且未在下载、未下载完成」时允许发起下载
          if (!updateStatus.available || updateStatus.downloading || updateStatus.downloaded)
            return getUpdateStatus()
          updateStatus = { ...updateStatus, downloading: true }
          await autoUpdater.downloadUpdate()
          return getUpdateStatus()
        } catch (error) {
          updateStatus = { ...updateStatus, downloading: false }
          return {
            ...getUpdateStatus(),
            error: error instanceof Error ? error.message : '下载更新失败'
          }
        }
      case 'app.update.install':
        // 未下载完成不允许安装（安装失败不会卡状态：error 事件会把 downloaded 复位）
        if (!updateStatus.downloaded) return getUpdateStatus()
        autoUpdater.quitAndInstall()
        return { ...getUpdateStatus() }
      case 'folder.pick': {
        const selected = await dialog.showOpenDialog(mainWindow!, {
          title: request.params.title,
          properties: ['openDirectory']
        })
        return selected.canceled ? undefined : selected.filePaths[0]
      }
      case 'draft.save':
        return database!.saveDraft(request.params)
      case 'draft.get':
        return database!.getDraft(request.params.id)
      case 'constructed.evaluate':
        return study.evaluateConstructed(request.params)
      case 'reports.get':
        return database!.getReport(request.params.range)
      case 'reports.exportMarkdown': {
        const report = database!.getReport(request.params.range)
        const selected = await dialog.showSaveDialog(mainWindow!, {
          title: '导出学习报告',
          defaultPath: reportFileName(request.params.range),
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
        if (selected.canceled || !selected.filePath) return undefined
        writeFileSync(selected.filePath, renderReportMarkdown(report), 'utf8')
        return selected.filePath
      }
      case 'reports.exportObsidian':
        return integrations.exportReportToVault(database!.getReport(request.params.range))
      case 'diagnosis.get':
        return study.getDiagnosis()
      case 'plan.preview':
        return study.previewPlan(request.params)
      case 'plan.apply': {
        const plan: LearningPlan = {
          ...request.params.plan,
          status: 'active',
          startDate: new Date().toISOString()
        }
        return database!.savePlan(plan)
      }
      case 'plan.active':
        return database!.getActivePlan()
      case 'plan.item.complete':
        return database!.completePlanItem(
          request.params.planId,
          request.params.itemId,
          request.params.completed
        )
      case 'plan.cancel':
        return database!.cancelPlan(request.params.planId)
      case 'ai.config.get':
        return ai.getConfig()
      case 'ai.config.save':
        return ai.saveConfig(request.params)
      case 'ai.config.clearCredential':
        return ai.clearCredential()
      case 'ai.providers':
        return ai.providers()
      case 'ai.models.discover':
        return ai.discoverModels()
      case 'ai.test':
        return ai.test()
      case 'ai.ask':
        return ai.ask(request.params)
      case 'aiTraining.record':
        return database!.saveAiTrainingRecord(request.params)
      case 'aiTraining.history':
        return database!.listAiTrainingRecords()
      case 'settings.get':
        return database!.getAppSettings()
      case 'settings.save':
        return database!.saveAppSettings(request.params)
      case 'runtime.status':
        return diagnostics.runtimeStatus()
      case 'integration.get':
        return integrations.getConfig()
      case 'integration.save':
        return integrations.saveConfig(request.params)
      case 'integration.openObsidian':
        return integrations.openObsidian()
      case 'obsidian.backups':
        return integrations.listObsidianBackups()
      case 'obsidian.backup':
        return integrations.createObsidianBackup()
      case 'obsidian.restore':
        return integrations.restoreObsidianBackup(request.params.id)
      case 'obsidian.safeMode':
        return integrations.enableObsidianSafeMode()
      case 'backup.create': {
        const backup = database!.createBackup('manual')
        database!.pruneBackups(database!.getAppSettings().backupRetention)
        return backup
      }
      case 'backup.list':
        return database!.listBackups()
      case 'backup.restore': {
        database!.restoreBackup(request.params.path)
        return {
          dashboard: database!.getDashboard(),
          settings: database!.getAppSettings(),
          vault: database!.getActiveVault(),
          ai: ai.getConfig()
        }
      }
      case 'diagnostics.run':
        return diagnostics.run()
      case 'diagnostics.export': {
        const report = diagnostics.run()
        const selected = await dialog.showSaveDialog(mainWindow!, {
          title: '导出诊断报告',
          defaultPath: `题舟诊断-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (selected.canceled || !selected.filePath) return undefined
        writeFileSync(selected.filePath, JSON.stringify(report, null, 2), 'utf8')
        return selected.filePath
      }
      case 'user.resetLearningData': {
        if (request.params.confirmation !== '清空学习数据') throw new Error('确认文字不匹配')
        database!.createBackup('pre-restore')
        database!.resetLearningData()
        return database!.getDashboard()
      }
      case 'shell.openPath': {
        const requested = resolve(request.params.path)
        const activeVault = database!.getActiveVault()
        const allowedRoots = [
          resolve(dataDirectory),
          ...(activeVault && !activeVault.isBuiltin ? [resolve(activeVault.path)] : [])
        ]
        if (!allowedRoots.some((root) => isWithin(root, requested)))
          throw new Error('该路径不在应用数据或活动知识库范围内')
        const error = await shell.openPath(requested)
        if (error) throw new Error(error)
        return true
      }
    }
  })
}

// ── 自动更新（electron-updater：启动/检查时自动探测网络，优先国内 cnb，回退 GitHub）──
let updateStatus: {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  progress?: number
  version?: string
  error?: string
  source?: 'cnb' | 'github'
} = { checking: false, available: false, downloading: false, downloaded: false }

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => {
    updateStatus = { ...updateStatus, checking: true, error: undefined }
  })
  autoUpdater.on('update-available', (info) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      available: true,
      version: info.version,
      error: undefined
    }
  })
  autoUpdater.on('update-not-available', () => {
    updateStatus = { ...updateStatus, checking: false, available: false, error: undefined }
  })
  autoUpdater.on('download-progress', (progress) => {
    updateStatus = {
      ...updateStatus,
      downloading: true,
      progress: Math.round(progress.percent)
    }
  })
  autoUpdater.on('update-downloaded', () => {
    updateStatus = { ...updateStatus, downloading: false, downloaded: true, progress: 100 }
  })
  autoUpdater.on('error', (error) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      downloading: false,
      error: error.message
    }
  })
}

function getUpdateStatus() {
  return { ...updateStatus, currentVersion: app.getVersion() }
}

// ── 启动烟雾测试：验证主进程可完整加载并初始化 ──
// （isSmokeTest 已在顶部测试运行时判定中定义）

if (isSmokeTest) {
  app.whenReady().then(async () => {
    try {
      await initialize()
      setupAutoUpdater()
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
    setupAutoUpdater()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => database?.close())
