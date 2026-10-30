// The editor can only send document lifecycle actions to its owning service.
// Do not install the generic desktop shim on this surface.
import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { createPrototypeHostSurface } from '../frontend/bridge/prototype-api';

const surface = createPrototypeHostSurface(async (channel, args) => {
  const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, {
    command: 'ipc_invoke', args: { channel, args: [args] }, role: 'prototype',
  });
  if (reply?.ok) return reply.value;
  throw new Error(reply?.error?.message || 'The prototype host did not answer.');
});

contextBridge.exposeInMainWorld('klausPrototypeHost', surface);
