import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, WorkbenchAPI, WorkbenchRequest } from '../shared/contracts'

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
  }
}

contextBridge.exposeInMainWorld('workbench', api)
