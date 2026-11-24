import { contextBridge, ipcRenderer } from 'electron'
import type {
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
