const { contextBridge, ipcRenderer } = require('electron');
const received = [];
ipcRenderer.on('native-test:event', (_event, message) => {
  received.push({ channel: message.channel, payload: message.payload });
  ipcRenderer.send('native-test:ack', message.deliveryId);
});
contextBridge.exposeInMainWorld('nativeTest', {
  invoke: (channel, payload) => ipcRenderer.invoke('native-test:invoke', channel, payload),
  received: () => received,
});
