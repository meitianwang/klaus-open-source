// Only the owning Design Canvas shell receives this isolated transport.
import { contextBridge, ipcRenderer } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { installDesignTransport } from './design-transport';
import { installDesignHost } from './design-host';
import { installDesignSave } from './design-save';
import { createDesignTransportHost } from '../frontend/bridge/design-api';

declare const window: {
  location: { protocol: string; host: string; pathname: string; origin: string };
  addEventListener(name: string, callback: (event: { source: unknown; origin: string; data: { __klausDesignChat?: boolean; payload?: unknown; __frame_transport?: boolean; kind?: string; v?: number; __klausDesignSave?: boolean; filename?: string; bytes?: ArrayBuffer; request?: string; tool?: string; __frame_chrome_state?: boolean; state?: string; uuid?: string; senderActivated?: boolean; deliver?: string; id?: string; data?: unknown } }) => void): void;
  postMessage(value: unknown, origin: string, ports: unknown[]): void;
};
const location = window.location;
const owned = () => process.isMainFrame && location.protocol === 'klaus-app:' && location.host === 'app' && /^\/code\/artifact\/[0-9a-f-]{36}$/.test(location.pathname);
if (owned()) {
  const host = createDesignTransportHost(async (channel, args) => {
    const reply = await ipcRenderer.invoke(HOST_CHANNELS.coreInvoke, { command: 'ipc_invoke', args: { channel, args: [args] }, role: 'design' });
    if (reply?.ok && (channel === 'design:save-file' || reply.value?.ok !== false)) return reply.value;
    throw new Error(reply?.value?.error || reply?.error?.message || 'The Design Canvas host did not accept the request.');
  });
  contextBridge.exposeInMainWorld('claudeDesktopArtifactPane', { platform: 'desktop', hostcaps: 'host-transport' });
  window.addEventListener('message', event => {
    if (!owned() || event.source !== window || event.origin !== location.origin) return;
    const value = event.data;
    if (value?.__klausDesignSave === true && typeof value.id === 'string') {
      const id = value.id;
      void (async () => {
        try {
          if (!(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength < 1 || value.bytes.byteLength > 200 * 1024 * 1024) {
            throw new Error('Invalid design file bytes.');
          }
          const result = await host.saveFile({ filename: value.filename, bytes: { __klausBinary: Buffer.from(value.bytes).toString('base64') }, request: value.request, tool: value.tool }) as { ok?: boolean; error?: string; cancelled?: boolean };
          window.postMessage({ __klausDesignSaved: true, id, result }, location.origin, []);
        } catch (error) {
          window.postMessage({ __klausDesignSaved: true, id, result: { ok: false, error: error instanceof Error ? error.message : String(error) } }, location.origin, []);
        }
      })();
    }
    if (value?.__klausDesignChat === true && typeof value.id === 'string') {
      const id = value.id;
      void host.chatRequest(value.payload).then(result => {
        window.postMessage({ __klausDesignChatResult: true, id, result }, location.origin, []);
      }, error => {
        window.postMessage({ __klausDesignChatResult: true, id, result: { ok: false, error: error instanceof Error ? error.message : String(error) } }, location.origin, []);
      });
    }
    if (value?.__frame_transport === true && value.kind === 'hello' && value.v === 1) {
      void host.ready().catch(error => console.error('Design Canvas transport failed:', error));
    }
  });
  ipcRenderer.on(HOST_CHANNELS.designTransportPort, event => {
    const port = event.ports[0];
    if (!owned()) { port?.close(); return; }
    window.postMessage({ __frame_transport: true, kind: port ? 'port' : 'gone', v: 1 }, location.origin, port ? [port] : []);
  });
  contextBridge.executeInMainWorld({ func: installDesignHost, args: [] });
  contextBridge.executeInMainWorld({ func: installDesignSave, args: [] });
  contextBridge.executeInMainWorld({ func: installDesignTransport, args: [false] });
}
