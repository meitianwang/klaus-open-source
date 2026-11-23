// Isolated preload for the motion-graphics WebContentsView; never exposes the main desktop shim.
import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { createMotionGraphicsHostSurface } from '../frontend/bridge/motion-graphics-api';

const surface = createMotionGraphicsHostSurface(async (channel, args) => {
  const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, {
    command: 'ipc_invoke',
    args: { channel, args: [args] },
    role: 'motion-graphics',
  });
  if (reply?.ok) return reply.value;
  throw new Error(reply?.error?.message || 'The motion-graphics host did not answer.');
});

contextBridge.exposeInMainWorld('klausMotionGraphicsHost', surface);
