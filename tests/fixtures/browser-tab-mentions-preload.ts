import { contextBridge, ipcRenderer } from 'electron';

// This fixture exposes only the production mention channel and its state push.
contextBridge.exposeInMainWorld('klaus', {
  browserUse: { mentionTabs: (request: unknown) => ipcRenderer.invoke('browser-use:mention-tabs', request) },
  on: { browserUseState: (handler: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => handler(state);
    ipcRenderer.on('browser-use:state', listener);
    return () => ipcRenderer.removeListener('browser-use:state', listener);
  } },
});
