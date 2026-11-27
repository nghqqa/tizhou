import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentStreamEvent,
  AiStreamEvent,
  AppSettings,
  WorkbenchAPI,
  WorkbenchRequest
} from '../shared/contracts'

const api: WorkbenchAPI = {
  platform: process.platform,
  invoke<T>(request: WorkbenchRequest): Promise<T> {
    return ipcRenderer.invoke('workbench:invoke', request) as Promise<T>
  },
  onSettingsUpdated(listener: (settings: AppSettings) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings): void => {
      listener(settings)
    }
    ipcRenderer.on('workbench:settings-updated', handler)
    return () => {
      ipcRenderer.removeListener('workbench:settings-updated', handler)
    }
  },
  onAiStream(listener: (event: AiStreamEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, event: AiStreamEvent): void => {
      listener(event)
    }
    ipcRenderer.on('workbench:ai-stream', handler)
    return () => {
      ipcRenderer.removeListener('workbench:ai-stream', handler)
    }
  },
  onAgentEvent(listener: (event: AgentStreamEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, event: AgentStreamEvent): void => {
      listener(event)
    }
    ipcRenderer.on('workbench:agent-event', handler)
    return () => {
      ipcRenderer.removeListener('workbench:agent-event', handler)
    }
  },
  onFullscreenChanged(listener: (fullscreen: boolean) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => {
      listener(fullscreen)
    }
    ipcRenderer.on('workbench:fullscreen-changed', handler)
    return () => {
      ipcRenderer.removeListener('workbench:fullscreen-changed', handler)
    }
  }
}

contextBridge.exposeInMainWorld('workbench', api)
