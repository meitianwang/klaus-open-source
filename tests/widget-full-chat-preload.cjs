const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__KLAUS_DESKTOP__', {
  core: { invoke: (method, payload) => ipcRenderer.invoke('widget-full-chat-invoke', method, payload) },
  event: { listen: async () => () => {} },
  window: { getCurrentWindow: () => ({ isFullscreen: async () => false, onResized: async () => () => {}, close: async () => {} }) },
})
