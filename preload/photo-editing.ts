// Isolated preload for the photo-editing WebContentsView; never exposes the main desktop shim.
import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { createPhotoEditingHostSurface } from '../frontend/bridge/photo-editing-api';

const surface = createPhotoEditingHostSurface(async (channel, args) => {
  const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, {
    command: 'ipc_invoke',
    args: { channel, args: [args] },
    role: 'photo-editing',
  });
  if (reply?.ok) return reply.value;
  throw new Error(reply?.error?.message || 'The photo-editing host did not answer.');
});

contextBridge.exposeInMainWorld('klausPhotoEditingHost', surface);
