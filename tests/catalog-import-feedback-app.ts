import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { STDIO_MCP_FIXTURE } from './fixtures/stdio-mcp';
import { Harness, assert, assertEqual, waitFor } from './harness';

export async function testCatalogImportFeedbackApp(h: Harness, desktop: DesktopRuntime, invoke: (channel: string, payload?: Json) => Promise<unknown>, root: string, home: string): Promise<void> {
  await h.test('catalog installation reaches the actual engine and cleanup removes its server without a second config store', async () => {
    const directory = join(root, 'catalog-fixture'); mkdirSync(directory);
    const server = join(directory, 'server.cjs'), calls = join(directory, 'calls'), pids = join(directory, 'pids');
    writeFileSync(server, STDIO_MCP_FIXTURE);
    writeFileSync(join(root, 'mcp-market-catalog.json'), JSON.stringify({ items: [{ id: 'gui-mcp', nameEn: 'GUI catalog fixture',
      config: { command: process.execPath, args: [server, pids, calls], env: { ELECTRON_RUN_AS_NODE: '1' }, alwaysLoad: true } }] }));
    let id: string | undefined;
    try {
      const listed = await invoke('mcp:builtin:list') as Array<{ id: string; installed: boolean }>;
      assert(listed.some(row => row.id === 'gui-mcp' && !row.installed), 'cached catalog survives unavailable market response');
      assertEqual(object(await invoke('mcp:builtin:install', { id: 'gui-mcp' })).ok, true, 'the real config writer confirmed installation');
      assert((await invoke('mcp:list') as Array<{ name: string }>).some(row => row.name === 'gui-mcp'), 'engine user config contains the installed entry');
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      id = String(object(await invoke('session:new', { workdir: directory })).id);
      const engineId = await desktop.sessions.resolveLiveSession(id);
      await waitFor(async () => {
        const reply = object(await desktop.sessions.request('session/mcpRuntime', { sessionId: engineId }));
        return (object(object(reply.mcpRuntime).runtime).servers as Array<{ name: string; state: string }>).some(row => row.name === 'gui-mcp' && row.state === 'ready');
      }, 15000, 'the real engine initializes the catalog server');
      await invoke('chat:send', { sessionId: id, text: 'MCP ECHO FIXTURE' });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(row => row.id === id)?.isWorking, 20000, 'catalog MCP model turn finishes');
      assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('MCP_ECHO_ACTUAL'), 'catalog tool output is persisted by the real engine');
      const diagnostic = object(await invoke('mcp:diagnose:bundle', { name: 'gui-mcp', lastError: 'fixture timeout' }));
      assertEqual(diagnostic.ok, true, 'diagnostic written through main IPC');
      assert(readFileSync(String(diagnostic.logPath), 'utf8').includes('lastErrorCategory: timeout'), 'saved diagnostic retains its category');
    } finally {
      if (id) await invoke('session:delete', { sessionId: id });
      await invoke('mcp:remove', { name: 'gui-mcp' }); await invoke('session:set-permission-mode', { mode: 'acceptEdits' });
      writeFileSync(join(root, 'mcp-market-catalog.json'), '{"items":[]}');
    }
  });
  await h.test('external history imported through actual IPC appears in the sidebar and continues on the one engine', async () => {
    const directory = join(home, '.claude/projects/gui'); mkdirSync(directory, { recursive: true });
    const source = join(directory, 'projectless.jsonl');
    writeFileSync(source, [
      { type: 'user', cwd: home, timestamp: new Date().toISOString(), message: { content: 'Original GUI imported question' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Original GUI imported answer' }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const before = new Set((await invoke('session:list') as Array<{ id: string }>).map(row => row.id)); let id: string | undefined;
    try {
      const detected = object(await invoke('external-agent-import:detect', { includeHome: true }));
      const items = Array.isArray(detected.items) ? detected.items.map(object) : [];
      const sources = items.filter(item => item.providerId === 'claude-code' && item.itemType === 'SESSIONS')
        .flatMap(item => { const sessions = object(item.details).sessions; return Array.isArray(sessions) ? sessions.map(object) : []; });
      assert(sources.some(session => session.path === realpathSync(source)), 'the recent source in the injected fixture home is detected: ' + JSON.stringify(detected));
      const payload = { items: [{ providerId: 'claude-code', itemType: 'SESSIONS', details: { sessions: [{ path: source }] } }] };
      const imported = object(await invoke('external-agent-import:import', payload));
      assertEqual(imported.ok, true, 'engine import confirmed: ' + JSON.stringify(imported)); assertEqual(object(imported.imported).SESSIONS, 1, 'one source persisted');
      const rows = (await invoke('session:list') as Array<{ id: string }>).filter(row => !before.has(row.id));
      assertEqual(rows.length, 1, 'the imported engine thread reaches the actual sidebar query'); id = rows[0]!.id;
      assert(JSON.stringify(await invoke('session:history', { sessionId: id })).includes('Original GUI imported answer'), 'imported assistant text loads through history IPC');
      assertEqual(object(await invoke('external-agent-import:status')).importedSessionCount, 1, 'host receipt follows actual persistence');
      assertEqual(object(await invoke('external-agent-import:import', payload)).changed, false, 'exact retry creates no duplicate');
      await invoke('chat:send', { sessionId: id, text: 'PLAIN FIXTURE continue imported history' });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(row => row.id === id)?.isWorking, 20000, 'imported conversation continues');
      const history = JSON.stringify(await invoke('session:history', { sessionId: id }));
      assert(history.includes('Original GUI imported answer') && history.includes('Fixture response complete.'), 'original and newly generated content share engine history');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'no importer engine or Rust host process');
    } finally { if (id) await invoke('session:delete', { sessionId: id }); }
  });
  await h.test('feedback IPC captures only its visible main window and persists an honest unauthenticated delivery result', async () => {
    const visible = desktop.window.isVisible();
    try {
      desktop.window.hide();
      assertEqual(object(await invoke('feedback:capture-screenshot')).ok, false, 'hidden main window asks to be shown');
      desktop.window.showInactive();
      const captured = object(await invoke('feedback:capture-screenshot')); assertEqual(captured.ok, true, 'real Electron content screenshot');
      const attachment = object(captured.attachment), bytes = readFileSync(String(attachment.path));
      assertEqual(bytes.subarray(1, 4).toString(), 'PNG', 'actual captured bytes are a PNG');
      const result = object(await invoke('feedback:suggestion-submit', { description: 'Only a local fixture suggestion', attachments: [attachment] }));
      assertEqual(result.ok, true, 'local report was written');
      const email = object(result.email); assertEqual(email.sent, false, 'no fixture report is claimed delivered'); assertEqual(email.skippedReason, 'not_authenticated', 'no SMTP fallback or real support request');
      const report = JSON.parse(readFileSync(String(result.filePath), 'utf8')) as { description: string; attachments: Array<{ path: string }> };
      assertEqual(report.description, 'Only a local fixture suggestion', 'saved report retains user text'); assertEqual(report.attachments[0]!.path, attachment.path, 'sender grant reaches the report');
      const forbidden = object(await invoke('feedback:suggestion-submit', { description: 'Unselected fixture path', attachments: [{ path: join(root, 'approval-target.txt') }] }));
      assertEqual(forbidden.ok, false, 'renderer cannot attach an unselected file');
    } finally { if (!visible) desktop.window.hide(); }
  });
}
