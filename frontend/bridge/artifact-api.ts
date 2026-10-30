// Preview windows receive only file viewing, appearance reads, and external links.
import './webview-integration.js'
import { call, expose, subscribe } from './ipc.js'

expose('klaus', {
  media: {
    readImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:read-image', source),
    saveImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:save-image', source),
    copyImage: (source: { sessionId: string; filePath?: string; data?: string; mimeType?: string; name?: string }) => call('media:copy-image', source),
    revealImage: (source: { sessionId: string; filePath: string }) => call('media:reveal-image', source),
  },
  clipboard: {
    writeText: (text: string) => call('clipboard:write-text', { text }),
  },
  artifacts: {
    read: (sessionId: string, filePath: string) => call('artifacts:read', { sessionId, filePath }),
    fileUrl: (sessionId: string, filePath: string) => call('artifacts:file-url', { sessionId, filePath }),
    reveal: (filePath: string) => call('artifacts:reveal', { filePath }),
    openWorkspace: (sessionId: string) => call('artifacts:open-workspace', { sessionId }),
    openWindow: (sessionId: string, filePath: string) => call('artifacts:open-window', { sessionId, filePath }),
  },
  memory: {
    readFile: (filePath: string) => call('memory:read-file', { filePath }),
    openWindow: (filePath: string) => call('memory:open-window', { filePath }),
  },
  skills: { readFile: (filePath: string) => call('skills:read-file', { filePath }) },
  settings: { kv: { get: (key: string) => call('settings:kv:get', { key }) } },
  window: { setTitleBarColors: (color: string, symbolColor: string) => call('window:setTitleBarColors', { color, symbolColor }) },
  app: { openExternal: (url: string) => call('app:openExternal', { url }) },
  on: { appPreferencesChanged: (cb: (payload: { key: string }) => void) => subscribe('app:preferences-changed', cb) },
})
