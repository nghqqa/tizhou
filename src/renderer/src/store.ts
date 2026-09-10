import { create } from 'zustand'
import type { AppSettings, BootstrapData } from '@shared/contracts'
import { invoke } from './api'

interface AppState {
  data?: BootstrapData
  loading: boolean
  error?: string
  initialize: () => Promise<void>
  refreshDashboard: () => Promise<void>
  refreshVault: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  clearError: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  loading: true,
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
    const current = get().data
    if (!current) return get().initialize()
    try {
      const dashboard = await invoke<BootstrapData['dashboard']>({ method: 'dashboard.get' })
      set({ data: { ...current, dashboard } })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '刷新失败' })
    }
  },
  // 磁盘监听在主进程自动重索引后不推送事件，窗口重新获得焦点时拉一次活动库状态即可对齐计数
  async refreshVault() {
    const current = get().data
    if (!current) return
    try {
      const vault = await invoke<BootstrapData['vault'] | undefined>({ method: 'vault.active' })
      if (vault && vault.lastIndexedAt !== current.vault.lastIndexedAt)
        set({ data: { ...current, vault } })
    } catch {
      // 焦点刷新失败不打扰用户，下次焦点再试
    }
  },
  async updateSettings(patch) {
    const current = get().data
    if (!current) return
    try {
      const settings = await invoke<AppSettings>({ method: 'settings.save', params: patch })
      set({ data: { ...current, settings } })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '设置保存失败' })
    }
  },
  clearError() {
    set({ error: undefined })
  }
}))
