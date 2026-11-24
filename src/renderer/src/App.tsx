import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  Button,
  FluentProvider,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  ProgressBar,
  Spinner
} from '@fluentui/react-components'
import {
  ArrowClockwiseIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BrainIcon,
  BookOpenTextIcon,
  BooksIcon,
  ChartLineUpIcon,
  CheckSquareOffsetIcon,
  ClipboardTextIcon,
  CompassIcon,
  ExamIcon,
  GearIcon,
  HouseIcon,
  LightbulbFilamentIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  NotePencilIcon,
  QuestionIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SquaresFourIcon,
  StethoscopeIcon,
  SunIcon,
  TargetIcon
} from '@phosphor-icons/react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { AppUpdateStatus } from '@shared/contracts'
import { darkTheme, lightTheme } from './theme'
import { useAppStore } from './store'
import { invoke } from './api'
import { hasOpenModal, isEditableTarget, isMacPlatform } from './services/shortcuts'
import { LoadingState } from './components/ui'
import { CommandPalette } from './components/CommandPalette'
import { MarkdownContent } from './components/MarkdownContent'
import { RouteErrorBoundary } from './components/RouteErrorBoundary'
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog'

const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage }))
)
const PracticePage = lazy(() =>
  import('./pages/practice/PracticePage').then((module) => ({ default: module.PracticePage }))
)
const ReviewPage = lazy(() =>
  import('./pages/practice/ReviewPage').then((module) => ({ default: module.ReviewPage }))
)
const ExamHomePage = lazy(() =>
  import('./pages/exam/ExamHomePage').then((module) => ({ default: module.ExamHomePage }))
)
const ExamRunPage = lazy(() =>
  import('./pages/exam/ExamRunPage').then((module) => ({ default: module.ExamRunPage }))
)
const ExamResultPage = lazy(() =>
  import('./pages/ExamResultPage').then((module) => ({ default: module.ExamResultPage }))
)
const KnowledgePage = lazy(() =>
  import('./pages/KnowledgePages').then((module) => ({ default: module.KnowledgePage }))
)
const KnowledgeBuilderPage = lazy(() =>
  import('./pages/knowledge-builder/KnowledgeBuilderPage').then((module) => ({
    default: module.KnowledgeBuilderPage
  }))
)
const PatternsPage = lazy(() =>
  import('./pages/KnowledgePages').then((module) => ({ default: module.PatternsPage }))
)
const ShenlunSolutionPage = lazy(() =>
  import('./pages/shenlun/ShenlunSolutionPage').then((module) => ({
    default: module.ShenlunSolutionPage
  }))
)
const ReportsPage = lazy(() =>
  import('./pages/insights/ReportsPage').then((module) => ({ default: module.ReportsPage }))
)
const DiagnosisPage = lazy(() =>
  import('./pages/insights/DiagnosisPage').then((module) => ({ default: module.DiagnosisPage }))
)
const AiPage = lazy(() =>
  import('./pages/ai/AiAssistantPage').then((module) => ({ default: module.AiPage }))
)
const AiTrainingPage = lazy(() =>
  import('./pages/ai/AiTrainingPage').then((module) => ({ default: module.AiTrainingPage }))
)
const ModelSettingsPage = lazy(() =>
  import('./pages/ai/ModelSettingsPage').then((module) => ({ default: module.ModelSettingsPage }))
)
const EnvironmentPage = lazy(() =>
  import('./pages/settings/EnvironmentPage').then((module) => ({ default: module.EnvironmentPage }))
)
const SettingsPage = lazy(() =>
  import('./pages/settings/SettingsPage').then((module) => ({ default: module.SettingsPage }))
)

type IconComponent = ComponentType<{
  size?: number
  weight?: 'regular' | 'fill' | 'bold'
  'aria-hidden'?: boolean
}>

interface NavItem {
  label: string
  path: string
  icon: IconComponent
}

const groups: Array<{ label: string; items: NavItem[] }> = [
  { label: '总览', items: [{ label: '今日工作台', path: '/', icon: HouseIcon }] },
  {
    label: '训练',
    items: [
      { label: '专项练习', path: '/practice', icon: TargetIcon },
      { label: '错题复习', path: '/review', icon: CheckSquareOffsetIcon },
      { label: '模拟考试', path: '/exam', icon: ExamIcon }
    ]
  },
  {
    label: '知识',
    items: [
      { label: '知识库工坊', path: '/knowledge-builder', icon: BookOpenTextIcon },
      { label: '行测知识', path: '/knowledge/xingce', icon: BooksIcon },
      { label: '行测方法', path: '/thinking/xingce', icon: LightbulbFilamentIcon },
      { label: '申论知识', path: '/knowledge/shenlun', icon: ClipboardTextIcon },
      { label: '申论方法', path: '/thinking/shenlun', icon: BrainIcon },
      { label: '规律中心', path: '/patterns', icon: SquaresFourIcon }
    ]
  },
  {
    label: '提升',
    items: [
      { label: '申论作答', path: '/shenlun-solution', icon: NotePencilIcon },
      { label: '学习报告', path: '/reports', icon: ChartLineUpIcon },
      { label: 'AI 助教', path: '/ai', icon: RobotIcon },
      { label: 'AI 变式训练', path: '/ai-training', icon: SparkleIcon },
      { label: '能力诊断', path: '/diagnosis', icon: StethoscopeIcon }
    ]
  },
  {
    label: '系统',
    items: [
      { label: '学习环境', path: '/environment', icon: CompassIcon },
      { label: '模型设置', path: '/model-settings', icon: SlidersHorizontalIcon },
      { label: '应用设置', path: '/settings', icon: GearIcon }
    ]
  }
]

function AppShell(): React.JSX.Element {
  const {
    data,
    loading,
    error,
    toast,
    zenMode,
    isFullscreen,
    initialize,
    refreshVault,
    clearError,
    clearToast,
    updateSettings,
    toggleZenMode,
    setZenMode,
    setFullscreen
  } = useAppStore()
  const location = useLocation()
  const navigate = useNavigate()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [updateDialog, setUpdateDialog] = useState<AppUpdateStatus & { open: boolean }>({
    open: false,
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    currentVersion: ''
  })
  const isMac = isMacPlatform()
  const isDark =
    data?.settings.theme === 'light'
      ? false
      : data?.settings.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : true

  const toggleTheme = (): void => {
    void updateSettings({ theme: isDark ? 'light' : 'dark' })
  }

  useEffect(() => {
    void invoke<boolean>({ method: 'window.fullscreen.get' })
      .then((fullscreen) => setFullscreen(fullscreen))
      .catch(() => {})
    return window.workbench?.onFullscreenChanged?.((fullscreen) => {
      setFullscreen(fullscreen)
      setZenMode(fullscreen)
    })
  }, [setFullscreen, setZenMode])

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShortcutHelpOpen(false)
        setPaletteOpen((value) => !value)
        return
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'z' &&
        !hasOpenModal()
      ) {
        event.preventDefault()
        toggleZenMode()
        return
      }
      if (
        event.key === '?' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isEditableTarget(event.target) &&
        !paletteOpen &&
        !updateDialog.open &&
        (!hasOpenModal() || shortcutHelpOpen)
      ) {
        event.preventDefault()
        setShortcutHelpOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [paletteOpen, shortcutHelpOpen, toggleZenMode, updateDialog.open])

  const updateBusyRef = useRef(false)

  const checkForUpdates = async (): Promise<void> => {
    if (updateBusyRef.current) return
    updateBusyRef.current = true
    setUpdateDialog((prev) => ({ ...prev, open: true, checking: true, error: undefined }))
    try {
      const result = await invoke({ method: 'app.update.check' })
      setUpdateDialog({
        open: true,
        checking: false,
        available: result.available,
        downloading: result.downloading,
        downloaded: result.downloaded,
        progress: result.progress,
        version: result.version,
        currentVersion: result.currentVersion,
        releaseNotes: result.releaseNotes,
        source: result.source,
        error: result.error
      })
    } catch (cause) {
      setUpdateDialog((prev) => ({
        ...prev,
        open: true,
        checking: false,
        error: cause instanceof Error ? cause.message : '未知错误'
      }))
    } finally {
      updateBusyRef.current = false
    }
  }

  const startUpdateDownload = async (): Promise<void> => {
    setUpdateDialog((prev) => ({ ...prev, downloading: true, progress: 0, error: undefined }))
    const poll = window.setInterval(() => {
      void invoke({ method: 'app.update.status' })
        .then((status) => {
          setUpdateDialog((prev) => ({
            ...prev,
            downloading: status.downloading,
            downloaded: status.downloaded,
            progress: status.progress,
            error: status.error
          }))
        })
        .catch(() => {})
    }, 350)
    try {
      const dlResult = await invoke({ method: 'app.update.download' })
      setUpdateDialog((prev) => ({
        ...prev,
        downloading: dlResult.downloading,
        downloaded: dlResult.downloaded,
        progress: dlResult.progress ?? (dlResult.downloaded ? 100 : prev.progress),
        error: dlResult.error
      }))
    } catch (cause) {
      setUpdateDialog((prev) => ({
        ...prev,
        downloading: false,
        error: cause instanceof Error ? cause.message : '下载失败'
      }))
    } finally {
      window.clearInterval(poll)
    }
  }

  useEffect(() => {
    void initialize()
  }, [initialize])
  // 外部编辑器改题/导入脚本落盘后主进程会自动增量重索引；用户切回窗口时对齐侧栏计数
  useEffect(() => {
    const onFocus = (): void => void refreshVault()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshVault])
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 })
    // Fluent UI Dialog 在确认并立即触发路由卸载时可能残留 #root[aria-hidden="true"]，切页时兜底清理
    if (!document.querySelector('[role="dialog"]')) {
      document.getElementById('root')?.removeAttribute('aria-hidden')
    }
  }, [location.pathname])

  if (loading && !data) {
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <ListChecksIcon size={30} weight="bold" />
        </div>
        <Spinner size="large" label="正在准备本地工作台" />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="boot-screen">
        <MessageBar intent="error">
          <MessageBarBody>{error ?? '应用初始化失败'}</MessageBarBody>
          <MessageBarActions>
            <Button onClick={() => void initialize()}>重试</Button>
          </MessageBarActions>
        </MessageBar>
      </div>
    )
  }

  return (
    <div className={`app-shell${zenMode ? ' is-zen' : ''}`}>
      <aside className="sidebar" aria-hidden={zenMode || undefined}>
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            题
          </div>
          <div>
            <strong>题舟</strong>
            <span>题海行舟 · 终将上岸</span>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-search-btn"
          title="全局快捷检索（Ctrl+K）"
          onClick={() => setPaletteOpen(true)}
        >
          <MagnifyingGlassIcon size={14} aria-hidden />
          <span>快捷检索</span>
          <kbd className="command-kbd">{isMac ? '⌘K' : 'Ctrl+K'}</kbd>
        </button>
        <nav className="main-nav" aria-label="主导航">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  >
                    <Icon size={18} aria-hidden />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <Button
            appearance="subtle"
            size="small"
            icon={isDark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
            title={isDark ? '切换到浅色模式（白天）' : '切换到深色模式（夜间）'}
            onClick={toggleTheme}
          >
            <span className="sidebar-footer-label">{isDark ? '浅色' : '深色'}</span>
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwiseIcon size={16} />}
            aria-label="检查更新"
            title="检查更新"
            onClick={() => void checkForUpdates()}
          >
            <span className="sidebar-footer-label">更新</span>
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<QuestionIcon size={16} />}
            aria-label="快捷键速查"
            title="快捷键与操作速查 (?)"
            onClick={() => setShortcutHelpOpen(true)}
          />
        </div>
        <div className="vault-summary">
          <StatusIndicator builtin={data.vault.isBuiltin} />
          <div>
            <span>{data.vault.name}</span>
            <small>
              {data.vault.questionCount} 题 · {data.vault.documentCount} 文档
            </small>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<GearIcon />}
            aria-label="知识库设置"
            title="知识库设置"
            onClick={() => navigate('/settings')}
          />
        </div>
      </aside>
      {zenMode && (
        <div className="zen-topbar" role="toolbar" aria-label="沉浸专注控制">
          <span className="zen-topbar-label">沉浸专注模式</span>
          <div className="zen-topbar-actions">
            <button
              type="button"
              className="zen-chip-btn"
              title={isFullscreen ? '退出系统全屏 (F11)' : '切换系统全屏 (F11)'}
              onClick={() => void invoke({ method: 'window.fullscreen.toggle' })}
            >
              <ArrowsOutSimpleIcon size={13} aria-hidden />
              <span>{isFullscreen ? '退出全屏' : '全屏 F11'}</span>
            </button>
            <button
              type="button"
              className="zen-chip-btn"
              title={`展开左侧导航栏 (${isMac ? '⌥Z' : 'Alt+Z'})`}
              onClick={() => setZenMode(false)}
            >
              <ArrowsInSimpleIcon size={13} aria-hidden />
              <span>退出专注 ({isMac ? '⌥Z' : 'Alt+Z'})</span>
            </button>
          </div>
        </div>
      )}
      <main className="workspace" id="main-content">
        {error && (
          <div className="global-message">
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
              <MessageBarActions>
                <Button onClick={clearError}>关闭</Button>
              </MessageBarActions>
            </MessageBar>
          </div>
        )}
        <Suspense fallback={<LoadingState label="正在打开页面" />}>
          <RouteErrorBoundary key={location.pathname}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/practice" element={<PracticePage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/exam" element={<ExamHomePage />} />
              <Route path="/exam/run" element={<ExamRunPage />} />
              <Route path="/exam/result/:id" element={<ExamResultPage />} />
              <Route path="/knowledge-builder" element={<KnowledgeBuilderPage />} />
              <Route
                path="/knowledge/xingce"
                element={<KnowledgePage subject="xingce" kind="knowledge" />}
              />
              <Route
                path="/thinking/xingce"
                element={<KnowledgePage subject="xingce" kind="method" />}
              />
              <Route
                path="/knowledge/shenlun"
                element={<KnowledgePage subject="shenlun" kind="knowledge" />}
              />
              <Route
                path="/thinking/shenlun"
                element={<KnowledgePage subject="shenlun" kind="method" />}
              />
              <Route path="/patterns" element={<PatternsPage />} />
              <Route path="/shenlun-solution" element={<ShenlunSolutionPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/ai" element={<AiPage />} />
              <Route path="/ai-training" element={<AiTrainingPage />} />
              <Route path="/diagnosis" element={<DiagnosisPage />} />
              <Route path="/environment" element={<EnvironmentPage />} />
              <Route path="/model-settings" element={<ModelSettingsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteErrorBoundary>
        </Suspense>
        {toast && (
          <div className="global-toast" role="status" aria-live="polite" onClick={clearToast}>
            {toast}
          </div>
        )}
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleTheme={toggleTheme}
        onToggleZen={toggleZenMode}
        onOpenShortcuts={() => setShortcutHelpOpen(true)}
      />
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      {updateDialog.open && (
        <div
          className="update-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !updateDialog.downloading) {
              setUpdateDialog((prev) => ({ ...prev, open: false }))
            }
          }}
        >
          <div
            className="update-dialog-surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-dialog-title"
          >
            <h2 id="update-dialog-title" className="update-dialog-title">
              {updateDialog.checking
                ? '正在检查更新'
                : updateDialog.error
                  ? '检查更新失败'
                  : updateDialog.downloaded
                    ? '更新已下载完成'
                    : updateDialog.available && updateDialog.version
                      ? `发现新版本 ${updateDialog.version}`
                      : '检查更新'}
            </h2>
            <div className="update-dialog-body">
              {updateDialog.checking ? (
                <Spinner label="正在探测更新源并比对版本…" />
              ) : (
                <>
                  <div className="update-dialog-meta">
                    {updateDialog.currentVersion && (
                      <span className="pill">当前版本 {updateDialog.currentVersion}</span>
                    )}
                    {updateDialog.version && updateDialog.available && (
                      <span className="pill">最新版本 {updateDialog.version}</span>
                    )}
                    <span className="pill">
                      {updateDialog.source === 'cnb'
                        ? '更新源：国内镜像（cnb.cool）'
                        : '更新源：GitHub'}
                    </span>
                  </div>
                  {updateDialog.error ? (
                    <p className="warning" style={{ margin: 0 }}>
                      {updateDialog.error}
                    </p>
                  ) : updateDialog.downloaded ? (
                    <p style={{ margin: 0 }}>
                      新版本安装包已就绪，点击「立即安装并重启」即可完成升级，学习数据与题库不受影响。
                    </p>
                  ) : updateDialog.available ? (
                    <>
                      <div className="update-dialog-notes">
                        <MarkdownContent
                          content={
                            updateDialog.releaseNotes ??
                            '本次更新包含功能改进与稳定性修复。点击下方按钮开始下载更新。'
                          }
                        />
                      </div>
                      {updateDialog.downloading && (
                        <div className="update-dialog-progress">
                          <span className="muted" style={{ fontSize: 12 }}>
                            正在下载更新… {updateDialog.progress ?? 0}%
                          </span>
                          <ProgressBar
                            value={
                              updateDialog.progress !== undefined
                                ? updateDialog.progress / 100
                                : undefined
                            }
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <p style={{ margin: 0 }}>当前已是最新版本（{updateDialog.currentVersion}）。</p>
                  )}
                </>
              )}
            </div>
            <div className="update-dialog-actions">
              {!updateDialog.checking && !updateDialog.downloading && (
                <Button
                  appearance="secondary"
                  onClick={() => setUpdateDialog((prev) => ({ ...prev, open: false }))}
                >
                  关闭
                </Button>
              )}
              {updateDialog.downloaded ? (
                <Button
                  appearance="primary"
                  onClick={() => void invoke({ method: 'app.update.install' })}
                >
                  立即安装并重启
                </Button>
              ) : (
                updateDialog.available &&
                !updateDialog.error && (
                  <Button
                    appearance="primary"
                    disabled={updateDialog.downloading}
                    onClick={() => void startUpdateDownload()}
                  >
                    {updateDialog.downloading ? '正在下载…' : '立即下载'}
                  </Button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusIndicator({ builtin }: { builtin: boolean }): React.JSX.Element {
  return (
    <span
      className={`vault-indicator ${builtin ? 'builtin' : 'connected'}`}
      aria-label={builtin ? '内置题库' : '用户知识库已连接'}
    />
  )
}

export function App(): React.JSX.Element {
  const settings = useAppStore((state) => state.data?.settings)
  const syncSettings = useAppStore((state) => state.syncSettings)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    return window.workbench?.onSettingsUpdated?.(syncSettings)
  }, [syncSettings])
  const isDark =
    settings?.theme === 'light' ? false : settings?.theme === 'system' ? systemDark : true
  const theme = useMemo(() => (isDark ? darkTheme : lightTheme), [isDark])
  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
    document.documentElement.dataset.reduceMotion = settings?.reduceMotion ? 'true' : 'false'
  }, [isDark, settings?.reduceMotion])
  return (
    <FluentProvider theme={theme} className="app-provider">
      <AppShell />
    </FluentProvider>
  )
}
