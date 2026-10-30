import { contextBridge, ipcRenderer } from 'electron';

// Keep this preload self-contained: the sandbox allows Electron, not local
// CommonJS modules. No IPC object or arbitrary channel reaches the page.
type RequestDialog = (type: string, message: string, defaultValue: string) => { accepted?: boolean; value?: string };
contextBridge.executeInMainWorld({
  func: (request: RequestDialog) => {
    const page = globalThis as unknown as Record<string, unknown>;
    page.prompt = (message: unknown = '', defaultValue: unknown = ''): string | null => {
      const result = request('prompt', String(message), String(defaultValue));
      return result?.accepted === true ? String(result.value ?? '') : null;
    };
    page.confirm = (message: unknown = ''): boolean => request('confirm', String(message), '').accepted === true;
    page.alert = (message: unknown = ''): void => { request('alert', String(message), ''); };
  },
  args: [(type: string, message: string, defaultValue: string) => ipcRenderer.sendSync('klaus:browser:dialog', { type, message, defaultValue, sandboxed: process.sandboxed, contextIsolated: process.contextIsolated })],
});
