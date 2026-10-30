import { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';

type Row = Record<string, Json>;
interface Dependencies {
  h: Harness; desktop: DesktopRuntime; root: string;
  invoke(channel: string, value?: Json): Promise<unknown>;
  records(): Promise<Array<{ channel: string; value: Json }>>;
}

/** Exercise the shipped reverse MCP transport and UI approval against disposable targets. */
export async function testComputerUseApp({ h, desktop, invoke, records, root }: Dependencies): Promise<void> {
  if (process.platform !== 'darwin') { h.info('Computer Use and recording application roundtrip', 'The macOS native target and recording fixture require macOS; Windows has its separate native gate.'); return; }
  const tracePath = join(root, 'recording-trace.jsonl');
  const engine: unknown[] = [];
  const observe = (event: unknown) => { engine.push(event); if (engine.length > 300) engine.shift(); };
  desktop.engine.on('event', observe);
  const trace = (): Row[] => existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row) : [];
  const doneCount = async (id: string): Promise<number> => (await records()).filter(row => row.channel === 'chat:event:batch'
    && (row.value as Row[]).some(event => event.sessionId === id && event.type === 'done')).length;
  const waitDone = async (id: string, count: number) => waitFor(async () => await doneCount(id) > count, 20000, 'the real engine completed the Computer Use tool turn');
  const question = async (id: string): Promise<Row> => {
    await waitFor(async () => (await records()).some(row => row.channel === 'elicit:request' && (row.value as Row).sessionId === id), 15000, 'the real engine forwarded the host MCP elicitation');
    return (await records()).filter(row => row.channel === 'elicit:request' && (row.value as Row).sessionId === id).at(-1)!.value as Row;
  };
  const respond = (card: Row, accept: boolean) => invoke('elicit:respond', { requestId: card.requestId!, response: accept ? { kind: 'accept', values: {} } : { kind: 'decline' } });
  const panel = () => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && new URL(window.webContents.getURL() || 'about:blank').pathname === '/recorder.html');
  const debug = async (id: string, error: unknown) => writeFileSync(join(__dirname, 'computer-use-app-debug.json'), JSON.stringify({ sessionId: id, error: String(error), renderer: await records(),
    hostLog: existsSync(join(root, 'electron-host.log')) ? readFileSync(join(root, 'electron-host.log'), 'utf8') : '', trace: trace(), engine }, null, 2));

  await h.test('actual engine Computer Use asks the UI before reading only its synthetic native window', async () => {
    const synthetic = process.env.KLAUS_COMPUTER_USE_SYNTHETIC_APP;
    assert(synthetic, 'the test parent built an isolated native target');
    const row = await invoke('session:new') as { id: string };
    const executable = join(synthetic, 'Contents/MacOS/fixture');
    const child = spawn(executable, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError: Error | undefined;
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    const exited = new Promise<void>(resolve => {
      child.once('error', error => { launchError = error; });
      child.once('close', () => resolve());
    });
    try {
      try {
        await waitFor(() => {
          if (launchError) throw launchError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('The disposable native app exited before startup');
          return existsSync(join(dirname(synthetic), 'target.plist'));
        }, 5000, 'only the disposable native app started');
      } catch (error) {
        throw new Error(`${String(error)}; native target ${JSON.stringify({ executable, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, stderr })}`);
      }
      const settings = await invoke('settings:computer-use:get') as { enabled: boolean; availableOnThisPlatform: boolean };
      assert(settings.enabled && settings.availableOnThisPlatform, 'availability comes from the actual staged native helper');
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      await invoke('chat:send', { sessionId: row.id, text: 'COMPUTER USE FIXTURE ' + synthetic });
      const card = await question(row.id);
      assert(JSON.stringify(card).includes(synthetic), 'approval identifies the specific disposable app');
      assertEqual(await doneCount(row.id), 0, 'the unanswered host approval keeps the engine tool pending');
      await respond(card, true);
      await waitDone(row.id, 0);
      const history = JSON.stringify(await invoke('session:history', { sessionId: row.id }));
      assert(history.includes('Only synthetic fixture content'), 'actual AX contents crossed native helper, host MCP, engine and persisted tool history');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'the tool uses the one existing engine child');
    } catch (error) { await debug(row.id, error); throw error; }
    finally {
      try {
        await invoke('session:delete', { sessionId: row.id });
        await invoke('session:set-permission-mode', { mode: 'acceptEdits' });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }
    }
  });

  await h.test('approved recording uses the real recorder role and Stop resumes its original engine conversation', async () => {
    const row = await invoke('session:new') as { id: string };
    try {
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
      await desktop.window.webContents.executeJavaScript(`window.klausSwitchSession(${JSON.stringify(row.id)})`);
      await desktop.window.webContents.executeJavaScript('window.updateSessionInList()');
      const starts = trace().filter(row => row.type === 'start').length;
      await invoke('chat:send', { sessionId: row.id, text: 'RECORDING START FIXTURE' });
      const card = await question(row.id);
      assert(/Record your actions/.test(JSON.stringify(card)), 'the explicit recording consent reached the UI');
      assertEqual(trace().filter(row => row.type === 'start').length, starts, 'capture never starts before approval');
      assertEqual(panel(), undefined, 'an unanswered request creates no recording panel');
      await respond(card, true);
      await waitDone(row.id, 0);
      await waitFor(() => !!panel(), 5000, 'the actual recorder window loaded');
      const recorder = panel()!;
      const status = await recorder.webContents.executeJavaScript("window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',{channel:'computer-use:record:status',args:[]})") as { recording: boolean; sessionId: string };
      assert(status.recording && status.sessionId === row.id, 'recorder status belongs to the creating engine conversation');
      await assertRejects(() => invoke('computer-use:record:stop'), 'the main renderer cannot impersonate the recorder');
      const before = await doneCount(row.id);
      await recorder.webContents.executeJavaScript("document.getElementById('rec-stop').click()");
      await waitFor(() => recorder.isDestroyed(), 10000, 'Stop drains and closes the actual recording owner');
      await waitDone(row.id, before);
      const stored = JSON.parse(readFileSync(join(root, 'computer-use-recordings/active.json'), 'utf8')) as { state: string; sessionId: string; eventsPath: string; pid: number };
      assertEqual(stored.state, 'ended', 'disk state is complete before the follow-up turn');
      assertEqual(stored.sessionId, row.id, 'the evidence retains its original owner');
      const events = readFileSync(stored.eventsPath, 'utf8');
      assert(events.includes('fixture demonstration') && events.includes('session.ended'), 'synthetic input and the terminal native event are durable');
      assert(trace().some(row => row.type === 'stop'), 'the panel caused a real helper stop command');
      let alive = true; try { process.kill(stored.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
      assertEqual(alive, false, 'the recording helper has exited before completion');
      const history = JSON.stringify(await invoke('session:history', { sessionId: row.id }));
      assert(history.includes('Replay Steps') && history.includes('recorded event stream'), 'the engine received the evidence path and skill drafting instructions');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'the follow-up reused the same engine child');
    } catch (error) { await debug(row.id, error); throw error; }
    finally { await invoke('session:delete', { sessionId: row.id }); await invoke('session:set-permission-mode', { mode: 'acceptEdits' }); }
  });

  await h.test('declined and closing recording approvals release the host operation without starting capture', async () => {
    await invoke('session:set-permission-mode', { mode: 'bypassPermissions' });
    const starts = trace().filter(row => row.type === 'start').length;
    const rows: string[] = [];
    try {
      const first = await invoke('session:new') as { id: string }; rows.push(first.id);
      await invoke('chat:send', { sessionId: first.id, text: 'RECORDING START FIXTURE' });
      await respond(await question(first.id), false); await waitDone(first.id, 0);
      const history = JSON.stringify(await invoke('session:history', { sessionId: first.id }));
      assert(history.includes('approval was not granted'), 'a declined approval is an explicit engine tool error');
      const second = await invoke('session:new') as { id: string }; rows.push(second.id);
      await invoke('chat:send', { sessionId: second.id, text: 'RECORDING START FIXTURE' });
      const card = await question(second.id);
      await invoke('session:delete', { sessionId: second.id }); rows.pop();
      await assertRejects(() => respond(card, true), 'a deleted conversation cannot later accept its old recording approval');
      assertEqual(trace().filter(row => row.type === 'start').length, starts, 'neither declined nor cancelled operations started capture');
      assertEqual(panel(), undefined, 'no orphan recorder remains');
    } catch (error) { await debug(rows.at(-1) ?? 'closed', error); throw error; }
    finally { for (const id of rows) await invoke('session:delete', { sessionId: id }); await invoke('session:set-permission-mode', { mode: 'acceptEdits' }); }
  });
  desktop.engine.removeListener('event', observe);
}
