import { create } from 'zustand'
import type { AppSettings, BootstrapData } from '@shared/contracts'
import { invoke } from './api'

interface AppState {
  data?: BootstrapData
  loading: boolean
  error?: string
  toast?: string
  zenMode: boolean
  isFullscreen: boolean
  initialize: () => Promise<void>
  refreshDashboard: () => Promise<void>
  refreshVault: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  syncSettings: (settings: AppSettings) => void
  toggleZenMode: () => void
  setZenMode: (value: boolean) => void
  setFullscreen: (value: boolean) => void
  clearError: () => void
  showToast: (message: string) => void
  clearToast: () => void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useAppStore = create<AppState>((set, get) => ({
  loading: true,
  zenMode: false,
  isFullscreen: false,
  async initialize() {
    set({ loading: true, error: undefined })
    try {
      const data = await invoke<BootstrapData>({ method: 'bootstrap' })
      set({ data, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '应用初始化失败', loading: false })
    }
  },
  async refreshDashboard() {
    if (!get().data) return get().initialize()
    try {
      const dashboard = await invoke<BootstrapData['dashboard']>({ method: 'dashboard.get' })
      set((state) => (state.data ? { data: { ...state.data, dashboard } } : state))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '刷新失败' })
    }
  },
  // 磁盘监听在主进程自动重索引后不推送事件，窗口重新获得焦点时拉一次活动库状态即可对齐计数
  async refreshVault() {
    if (!get().data) return
    try {
      const vault = await invoke<BootstrapData['vault'] | undefined>({ method: 'vault.active' })
      if (!vault) return
      set((state) =>
        state.data && vault.lastIndexedAt !== state.data.vault.lastIndexedAt
          ? { data: { ...state.data, vault } }
          : state
      )
    } catch {
      // 焦点刷新失败不打扰用户，下次焦点再试
    }
  },
  async updateSettings(patch) {
    if (!get().data) return
    try {
      const settings = await invoke<AppSettings>({ method: 'settings.save', params: patch })
      set((state) => (state.data ? { data: { ...state.data, settings } } : state))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '设置保存失败' })
    }
  },
  syncSettings(settings) {
    set((state) => (state.data ? { data: { ...state.data, settings } } : state))
  },
  toggleZenMode() {
    set((state) => ({ zenMode: !state.zenMode }))
  },
  setZenMode(value) {
    set({ zenMode: value })
  },
  setFullscreen(value) {
    set({ isFullscreen: value })
  },
  clearError() {
    set({ error: undefined })
  },
  showToast(message) {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: message })
    toastTimer = setTimeout(() => {
      set({ toast: undefined })
      toastTimer = undefined
    }, 3600)
  },
  clearToast() {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = undefined
    set({ toast: undefined })
  }
}))
