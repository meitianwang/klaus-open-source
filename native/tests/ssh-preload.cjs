const { contextBridge, ipcRenderer } = require('electron');
let callback = async () => {};
ipcRenderer.on('ssh-fixture-prompt', (_event, payload) => {
  Promise.resolve(callback(payload)).then(() => ipcRenderer.send('ssh-fixture-ack', payload.requestId));
});
contextBridge.exposeInMainWorld('sshFixture', {
  invoke: (channel, payload) => ipcRenderer.invoke('ssh-fixture-invoke', channel, payload),
  onPrompt: listener => { callback = listener; },
});
