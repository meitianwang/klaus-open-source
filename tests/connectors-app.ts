import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertEqual, waitFor } from './harness';

export async function testConnectorsApp(h: Harness, desktop: DesktopRuntime, invoke: (channel: string, payload?: Json) => Promise<unknown>, root: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  await h.test('macOS connector settings load actual engine tools and disabling preserves the same conversation', async () => {
    const folder = join(root, 'owned-connector-folder'); await mkdir(folder); await writeFile(join(folder, 'connector-owned.txt'), 'own connector fixture');
    const previous = await desktop.window.webContents.executeJavaScript('window.currentSessionId ?? null');
    const permission = object(await invoke('session:get-permission-mode')); let id = '';
    try {
      const rows = await invoke('connectors:list') as JsonObject[];
      assertEqual(rows.find(row => row.id === 'macos-finder')?.runtimeAvailable, true, 'settings reflect the actual native implementation');
      assertEqual(object(await invoke('connectors:preflight', { id: 'macos-finder' })).ok, true, 'the read-only capability check succeeds');
      assertEqual(object(await invoke('connectors:toggle', { id: 'macos-finder', enabled: true })).ok, true, 'connector preference is saved through renderer IPC');
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      id = string(object(await invoke('session:new')).id); const engineId = await desktop.sessions.resolveLiveSession(id);
      await desktop.window.webContents.executeJavaScript(`window.currentSessionId = ${JSON.stringify(id)}; window.__connectorDone = false; window.__connectorUnsubscribe = window.klaus.on.chatEvent(event => { if (event.sessionId === ${JSON.stringify(id)} && event.type === 'done') window.__connectorDone = true; }); true`);
      const runtime = async () => object(object(object(await desktop.sessions.request('session/mcpRuntime', { sessionId: engineId })).mcpRuntime).runtime).servers as JsonObject[];
      await waitFor(async () => (await runtime()).some(row => row.name === 'klaus-macos-finder' && row.state === 'ready'), 15_000, 'the engine connected to the managed Finder server');
      const status = await invoke('connectors:status') as JsonObject[];
      assert(status.some(row => row.name === 'klaus-macos-finder' && Number(row.toolCount) > 0 && row.status !== 'failed'), 'connected status comes from the real engine tool catalog');
      await invoke('chat:send', { sessionId: id, text: 'FINDER CONNECTOR FIXTURE ' + folder });
      await waitFor(() => desktop.window.webContents.executeJavaScript('window.__connectorDone'), 25_000, 'the engine completed the real Foundation directory read');
      assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('connector-owned.txt'), 'the real MCP tool result is present in persisted conversation history');
      assertEqual(object(await invoke('connectors:setToolEnabled', { id: 'macos-finder', toolName: 'list_folder', enabled: false })).ok, true, 'the tool setting reloads the live capability');
      assertEqual(await desktop.sessions.resolveLiveSession(id), engineId, 'tool preferences preserve the same engine session');
      assertEqual(object(await invoke('connectors:toggle', { id: 'macos-finder', enabled: false })).ok, true, 'disabling drains and removes the connector');
      await waitFor(async () => !(await runtime()).some(row => row.name === 'klaus-macos-finder'), 10_000, 'the disabled server is absent from the actual engine runtime');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'native app tooling uses the existing single engine');
    } finally {
      await invoke('connectors:toggle', { id: 'macos-finder', enabled: false });
      await invoke('connectors:setToolEnabled', { id: 'macos-finder', toolName: 'list_folder', enabled: true });
      await desktop.window.webContents.executeJavaScript(`window.__connectorUnsubscribe?.(); delete window.__connectorUnsubscribe; delete window.__connectorDone; window.currentSessionId = ${JSON.stringify(previous)}; true`);
      if (id) await invoke('session:delete', { sessionId: id });
      await invoke('session:set-permission-mode', { mode: string(permission.mode) || 'default' }); await rm(folder, { recursive: true, force: true });
    }
  });
}
