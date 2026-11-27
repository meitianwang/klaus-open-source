// Isolated preload for the equity-research WebContentsView; never exposes the main desktop shim.
import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { createEquityResearchHostSurface } from '../frontend/bridge/equity-research-api';

const surface = createEquityResearchHostSurface(async (channel, args) => {
  const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, {
    command: 'ipc_invoke',
    args: { channel, args: [args] },
    role: 'equity-research',
  });
  if (reply?.ok) return reply.value;
  throw new Error(reply?.error?.message || 'The equity-research host did not answer.');
});

contextBridge.exposeInMainWorld('klausEquityResearchHost', surface);
