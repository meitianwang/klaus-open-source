import { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { DreamStore } from '../main/services/dream-store';
import { object } from '../main/services/service-types';
import { deviceFixture, reply } from './mcp-device-fixture';
import { Harness, assert, assertEqual, waitFor } from './harness';

export async function testDeviceDreamApp(h: Harness, desktop: DesktopRuntime, invoke: (channel: string, payload?: Json) => Promise<unknown>, root: string, device: Awaited<ReturnType<typeof deviceFixture>>): Promise<void> {
  await h.test('device authorization uses real window IPC and installs only its confirmed token into engine MCP config', async () => {
    const id = 'gui-device';
    writeFileSync(join(root, 'mcp-market-catalog.json'), JSON.stringify({ items: [{ id, nameEn: 'Device fixture', auth: 'apikey',
      config: { type: 'http', url: device.origin + '/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, envKeys: [{ key: 'TOKEN', secret: true }],
      deviceAuth: { provider: 'github', defaultClientId: 'gui-public-client', tokenEnvKey: 'TOKEN' } }] }));
    const servers = async () => object(object(object(await desktop.sessions.request('config/read', {})).values).mcpServers);
    try {
      assertEqual(object(await invoke('mcp:device:client-id', { id })).clientId, 'gui-public-client', 'the catalog public client reaches the actual UI');
      const started = object(await invoke('mcp:device:start', { id }));
      assertEqual(started.ok, true, 'real loopback code request succeeded'); assertEqual(started.userCode, 'CODE-0001', 'user sees only the public authorization code');
      assert(!JSON.stringify(started).includes('fixture-device-1'), 'the private device code stays in its host owner');
      assertEqual(object(await invoke('mcp:device:wait', { id })).ok, true, 'actual poll and shared MCP write finished');
      const before = object((await servers())[id]); assertEqual(object(before.headers).Authorization, 'Bearer fixture-access-fixture-device-1', 'the single engine config owns the confirmed credential');
      let pending = false;
      device.token(request => { pending = true; reply(request, { error: 'authorization_pending' }); });
      assertEqual(object(await invoke('mcp:device:start', { id })).ok, true, 'another grant has independent ownership');
      const waiting = invoke('mcp:device:wait', { id }); await waitFor(() => pending, 5000, 'actual pending authorization poll');
      assertEqual(object(await invoke('mcp:device:cancel', { id })).ok, true, 'explicit cancellation acknowledged');
      assertEqual(object(await waiting).error, 'cancelled', 'the waiting invoke settles after cancellation');
      assertEqual(object(object((await servers())[id]).headers).Authorization, object(before.headers).Authorization, 'cancellation preserves the prior installed credential');
    } finally {
      await invoke('mcp:device:cancel', { id }); await invoke('mcp:remove', { name: id });
      writeFileSync(join(root, 'mcp-market-catalog.json'), '{"items":[]}');
    }
  });
  await h.test('the real dream facade refuses disabled work without inventing a run from its submission acknowledgement', async () => {
    const previous = await invoke('dream:current'); let id: string | undefined;
    try {
      assertEqual(object(await invoke('dream:trigger-now')).error, 'no-context', 'deleted fixture conversations do not remain available');
      assertEqual(object(await invoke('dream:config-set', { enabled: false })).enabled, false, 'engine confirms disabled configuration');
      id = String(object(await invoke('session:new', { workdir: root })).id);
      await invoke('chat:send', { sessionId: id, text: 'PLAIN FIXTURE disabled dream context' });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(row => row.id === id)?.isWorking, 20000, 'the actual context turn settles');
      const result = object(await invoke('dream:trigger-now'));
      assertEqual(result.ok, false, 'actual engine start outcome refuses work'); assertEqual(result.error, 'gate-closed', 'engine gate reason survives IPC');
      assertEqual(JSON.stringify(await invoke('dream:current')), JSON.stringify(previous), 'a facade ACK produced no history entry');
      assertEqual(await invoke('memory-snapshot:respond', { requestId: 'late-unowned-fixture-request', choice: 'replace' }), null, 'an unowned renderer response has no authority');
    } finally { if (id) await invoke('session:delete', { sessionId: id }); }
  });
  await h.test('manual dream runs inside the existing real engine and publishes its terminal history through renderer IPC', async () => {
    let id: string | undefined;
    await desktop.window.webContents.executeJavaScript('window.__dreamEvents = []; window.__dreamUnsubscribe = window.klaus.on.dreamEvent(value => window.__dreamEvents.push(value)); true');
    try {
      const config = object(await invoke('dream:config-set', { enabled: true, minHours: 24, minSessions: 5, skillEvolutionEnabled: false }));
      assertEqual(config.enabled, true, 'actual versioned config write');
      assertEqual(object(await invoke('dream:config-get')).enabled, true, 'actual engine config read');
      id = String(object(await invoke('session:new', { workdir: root })).id);
      await invoke('chat:send', { sessionId: id, text: 'PLAIN FIXTURE manual dream context' });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(row => row.id === id)?.isWorking, 20000, 'enabled context turn settles');
      const generation = desktop.sessions.engine()!.generation;
      const started = object(await invoke('dream:trigger-now')); assertEqual(started.ok, true, 'actual engine confirms start: ' + JSON.stringify(started));
      await waitFor(async () => ['completed', 'failed'].includes(String(object(await invoke('dream:current')).status)), 20000, 'actual engine consolidation terminal outcome');
      const current = object(await invoke('dream:current')); assertEqual(current.status, 'completed', 'the loopback model completes consolidation: ' + JSON.stringify(current));
      assertEqual(current.stoppable, false, 'the UI does not advertise an unsupported cancel');
      const detail = object(await invoke('dream:detail', { taskId: String(current.taskId) }));
      for (const key of ['taskId', 'status', 'phase', 'startedAt', 'endedAt', 'turnCount', 'filesTouched', 'turns']) assertEqual(JSON.stringify(detail[key]), JSON.stringify(current[key]), 'persisted lifecycle field: ' + key);
      assertEqual(detail.durationMs, Number(current.endedAt) - Number(current.startedAt), 'history stores the actual elapsed duration');
      assert((object(await invoke('dream:list')).runs as Json[]).some(value => object(value).taskId === current.taskId), 'the actual history list includes the completed run');
      await waitFor(() => desktop.window.webContents.executeJavaScript('window.__dreamEvents.some(value => value.status === "completed")'), 5000, 'the actual renderer receives the terminal event');
      assertEqual(desktop.sessions.engine()!.generation, generation, 'consolidation retains the same engine generation');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'no memory host child or second engine was created');
    } finally {
      if (id) await invoke('session:delete', { sessionId: id });
      await invoke('dream:config-set', { enabled: false });
      await desktop.window.webContents.executeJavaScript('window.__dreamUnsubscribe?.(); delete window.__dreamUnsubscribe; delete window.__dreamEvents; true');
    }
  });
  await h.test('the real Dream page exposes its release interactions without collapsing opened details', async () => {
    const taskId = 'dream-ui-fixture-' + Date.now();
    const startedAt = Date.now() - 2_000;
    const memoryDir = join(root, 'agent-memory');
    const memoryFile = join(memoryDir, 'user_dream_ui_fixture.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(memoryFile, '---\ndescription: A visible Dream page detail.\n---\n\nFixture memory body.\n');
    new DreamStore(root).save({
      taskId, startedAt, endedAt: startedAt + 800, status: 'completed', phase: 'updating',
      sessionsReviewing: 3, filesTouched: [memoryFile], turns: [], turnCount: 2,
      summary: 'A visible completed dream.',
      skillReview: { status: 'completed', summary: 'One skill was distilled.', distilled: [{ name: 'fixture-skill', action: 'create' }] },
    });
    const evaluate = <T = unknown>(expression: string): Promise<T> => desktop.window.webContents.executeJavaScript(expression) as Promise<T>;
    await evaluate("document.getElementById('btn-memory').click(); true");
    await waitFor(() => evaluate<boolean>(`document.getElementById('memory-view')?.classList.contains('active') === true
      && Array.from(document.querySelectorAll('[data-task-id]')).some(row => row.dataset.taskId === ${JSON.stringify(taskId)})`), 5_000, 'Dream page and persisted fixture row become visible');

    const surface = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === ${JSON.stringify(taskId)});
      return {
        title: document.querySelector('#memory-view h1')?.textContent,
        summary: row?.textContent,
        actions: ['memory-refresh', 'memory-reveal', 'memory-trigger-now'].every(id => Boolean(document.getElementById(id))),
        filter: document.querySelector('#memory-time-filter .kls-select-text')?.textContent,
        toggle: row?.querySelector('[data-memory-row-toggle]')?.getAttribute('aria-expanded'),
      };
    })()` ) as { title?: string; summary?: string; actions: boolean; filter?: string; toggle?: string };
    assertEqual(surface.title, 'Dream', 'release page title renders');
    assert(surface.actions, 'refresh, reveal and Dream now actions all render');
    assertEqual(surface.filter, 'All time', 'history starts with the release filter');
    assert(surface.summary?.includes('A visible completed dream.'), 'completed summary renders in history');
    assertEqual(surface.toggle, 'false', 'vivid history starts collapsed');

    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === ${JSON.stringify(taskId)});
      const toggle = row.querySelector('[data-memory-row-toggle]');
      toggle.focus();
      toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await waitFor(() => evaluate<boolean>(`(() => {
      const row = Array.from(document.querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === ${JSON.stringify(taskId)});
      return row?.classList.contains('expanded') && row.querySelector('[data-memory-history-detail]')?.textContent.includes('A visible Dream page detail.');
    })()`), 5_000, 'keyboard expansion loads the memory description');

    const detailState = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === ${JSON.stringify(taskId)});
      const detail = row.querySelector('[data-memory-history-detail]');
      detail.querySelector('span:last-child').click();
      const file = detail.querySelector('[data-rel-path]');
      return { expanded: row.classList.contains('expanded'), role: file?.getAttribute('role'), tabIndex: file?.tabIndex };
    })()` ) as { expanded: boolean; role?: string; tabIndex?: number };
    assert(detailState.expanded, 'clicking detail copy does not collapse the opened row');
    assertEqual(detailState.role, 'button', 'memory reference exposes button semantics');
    assertEqual(detailState.tabIndex, 0, 'memory reference is keyboard reachable');

    const windowIdsBefore = new Set(BrowserWindow.getAllWindows().map(window => window.id));
    await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === ${JSON.stringify(taskId)});
      const file = row.querySelector('[data-rel-path]');
      file.focus();
      file.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await waitFor(() => BrowserWindow.getAllWindows().some(window => !windowIdsBefore.has(window.id)), 5_000, 'keyboard activation opens the memory preview');
    const preview = BrowserWindow.getAllWindows().find(window => !windowIdsBefore.has(window.id) && !window.isDestroyed());
    assert(preview, 'memory preview window exists');
    await waitFor(() => !preview!.webContents.isLoading(), 5_000, 'memory preview finishes loading');
    await waitFor(() => preview!.webContents.executeJavaScript("document.getElementById('aw-body')?.textContent.includes('Fixture memory body.')"), 5_000, 'memory preview shows the selected file');
    preview!.close();

    await evaluate(`(() => {
      const select = document.getElementById('memory-time-filter');
      select.querySelector('.kls-select-trigger').click();
      select.querySelector('[data-value="today"]').click();
    })()`);
    await waitFor(() => evaluate<boolean>(`document.querySelector('#memory-time-filter .kls-select-text')?.textContent === 'Today'
      && Array.from(document.querySelectorAll('[data-task-id]')).some(row => row.dataset.taskId === ${JSON.stringify(taskId)})`), 5_000, 'Today filter reloads and keeps the current fixture');

    await evaluate("document.getElementById('memory-trigger-now').click(); true");
    await waitFor(() => evaluate<boolean>("document.querySelector('.klaus-dialog-message')?.textContent.includes('Send a message in the main chat first')"), 5_000, 'Dream now exposes its no-context guidance');
    await evaluate("document.querySelector('.klaus-dialog-confirm').click(); true");
  });
}
