import { contextBridge, ipcRenderer } from 'electron';

// This isolated prompt window can only read and answer its own dialog.
contextBridge.exposeInMainWorld('klausBrowserPrompt', {
  read: () => ipcRenderer.invoke('klaus:browser:dialog:read'),
  answer: (value: unknown) => ipcRenderer.invoke('klaus:browser:dialog:answer', value),
});
