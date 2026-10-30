import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { createVideoEditingHostSurface } from '../frontend/bridge/video-editing-api';

// Only the trusted wrapper receives this capability; native scene frames receive none.
const surface = createVideoEditingHostSurface(async (channel, args) => {
  const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, {
    command: 'ipc_invoke', args: { channel, args: [args] }, role: 'video-editing',
  });
  if (reply?.ok) return reply.value;
  throw new Error(reply?.error?.message || 'The video host did not answer.');
});
contextBridge.exposeInMainWorld('klausVideoHost', surface);
