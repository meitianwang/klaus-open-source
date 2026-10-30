import { app } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { assert, assertEqual, Harness, waitFor } from './harness';
import { startQueueSteerProvider } from './fixtures/queue-steer-provider';

const profilePath = process.env.KLAUS_QUEUE_STEER_FIXTURE_PROFILE;
const logPath = process.env.KLAUS_QUEUE_STEER_FIXTURE_LOGS;
if (!profilePath || !logPath) throw Error('Run with scripts/run-queue-steer-app-test.mjs');
const root = profilePath;
const logs = logPath;
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
const directive = 'QUEUE_STEER_DIRECTIVE_7a049b: include this exact directive in the current task response.';
const progress = (message: string) => { process.stdout.write(`${message}\n`); appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`); };
const engineEvents: unknown[] = [];
const facadeCalls: Array<{ method: string; params: unknown }> = [];
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startQueueSteerProvider>> | undefined;
let sessionId = '';
const evaluate = <T = any>(script: string): Promise<T> => runtime!.window.webContents.executeJavaScript(script);
const invoke = (channel: string, value?: Json): Promise<any> => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', ${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
const records = (): Promise<Array<Record<string, any>>> => evaluate('window.__queueFixtureEvents.flatMap(row => row.channel === "chat:event:batch" ? row.value : [])');
async function draft(text: string) {
  await evaluate('window.setComposerText("")');
  await click('#input');
  await waitFor(() => evaluate('document.activeElement===document.getElementById("input") && document.hasFocus()'), 5000, 'trusted pointer focuses the composer before typing');
  await runtime!.window.webContents.insertText(text);
  await waitFor(() => evaluate(`(() => { const button=document.getElementById('send');
    return button?.disabled===false && (!window.isSessionRunning(window.currentSessionId) || button.classList.contains('running-submit')); })()`),
    5000, 'trusted composer input exposes submit instead of Stop');
}
async function click(selector: string) {
  runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus(); runtime!.window.webContents.focus();
  await waitFor(() => runtime!.window.isFocused(), 5000, 'native pointer window owns focus');
  const point = await evaluate<{ x: number; y: number }>(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) throw Error('Missing or disabled fixture control: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    let previous='',stable=0;
    const deadline=performance.now()+5000;
    while(performance.now()<deadline){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const rect=element.getBoundingClientRect();
      const key=JSON.stringify([rect.x,rect.y,rect.width,rect.height,innerWidth,innerHeight]);
      stable=key===previous?stable+1:0;previous=key;
      const point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      const hit=document.elementFromPoint(point.x,point.y);
      if(stable>=3&&rect.width>0&&rect.height>0&&!element.disabled&&(hit===element||element.contains(hit))){
        window.__queueFixtureClicks.push({selector:${JSON.stringify(selector)},point,rect:rect.toJSON(),viewport:{width:innerWidth,height:innerHeight},hit:hit.outerHTML.slice(0,500)});
        return point;
      }
    }
    throw Error('Fixture control did not settle as a visible pointer target: '+${JSON.stringify(selector)});
  })()`);
  runtime!.window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  runtime!.window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  runtime!.window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function diagnostics() {
  const page = runtime && !runtime.window.isDestroyed() ? await evaluate(`({events:window.__queueFixtureEvents,replies:window.__queueFixtureReplies,requests:window.__queueFixtureRequests,clicks:window.__queueFixtureClicks,current:window.currentSessionId,input:document.getElementById('input')?.value,send:document.getElementById('send')?.outerHTML,focus:document.activeElement?.outerHTML.slice(0,1000),stream:window.__klausChatStreamStore?.getState().sessions[${JSON.stringify(sessionId)}],body:document.body.innerText.slice(-12000)})`).catch(error => ({ error: String(error) })) : undefined;
  writeFileSync(join(logs, 'diagnostics.json'), JSON.stringify({ sessionId, facadeCalls, engineEvents, provider: provider?.requests, page }, null, 2));
  if (runtime && !runtime.window.isDestroyed()) writeFileSync(join(logs, 'workbench.png'), (await runtime.window.webContents.capturePage()).toPNG());
}

void (async () => {
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:queue-fixture', 'composer.thinking_level': 'off', follow_up_queue_mode: 'queue', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(key, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startQueueSteerProvider(directive);
    process.env.KLAUS_SERVER_URL = provider.url;
    progress('Starting production runtime with production native addon and local model endpoint');
    const externalImportHome = join(root, 'external-home');
    mkdirSync(externalImportHome, { recursive: true });
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome });
    runtime.window.setContentSize(1280, 820);
    runtime.engine.on('event', event => { engineEvents.push(event); });
    runtime.window.webContents.on('console-message', (_event, ...args) => process.stdout.write(`[renderer] ${args.map(String).join(' ')}\n`));
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.queue-fixture', mergeStrategy: 'replace', value: { name: 'Queue fixture', provider: 'anthropic', model: 'queue-fixture-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true } } }] });
    await runtime.sessions.request('model/credential/write', { id: 'queue-fixture', apiKey: 'local-fixture-key' });
    await waitFor(() => evaluate('Boolean(window.klaus?.chat && window.setComposerText && window.klausSwitchSession && window.__klausChatStreamStore)'), 20000, 'production composer and bridge loaded');
    await evaluate(`(() => {
      window.__queueFixtureEvents=[];window.__queueFixtureRequests=[];window.__queueFixtureReplies=[];window.__queueFixtureClicks=[];
      for (const channel of ['chat:event:batch','permission:request']) window.__KLAUS_DESKTOP__.event.listen('ipc:'+channel,event=>window.__queueFixtureEvents.push({channel,value:event.payload.args[0]}));
      const deliver=window.klaus.chat.clientQueueDeliver;
      window.klaus.chat.clientQueueDeliver=async(...args)=>{window.__queueFixtureRequests.push(args);const reply=await deliver(...args);window.__queueFixtureReplies.push(reply);return reply};
    })()`);
    const client = runtime.sessions.engine()!.client;
    const request = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params, timeoutMs) => { if (method === 'turn/submit' || method.startsWith('thread/queue/')) facadeCalls.push({ method, params }); return request(method, params, timeoutMs); };
    await h.test('queued steer accepts the visible running identity and reaches the same real engine turn exactly once', async () => {
      const row = await invoke('session:new', { workdir: root }); sessionId = String(row.id);
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions', sessionId });
      await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await draft('QUEUE_STEER_PARENT_FIXTURE');
      await click('#send');
      await waitFor(() => provider!.entered() === 1, 30000, 'real Bash tool entered the loopback HTTP barrier');
      const snapshot = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sessionId)})`);
      const facadeTurnId = snapshot.followUpTurnId;
      await waitFor(() => evaluate(`(() => {const id=window.__klausChatStreamStore.getState().sessions[${JSON.stringify(sessionId)}]?.activeTurnId;return typeof id==='string'&&id!==${JSON.stringify(facadeTurnId)}})()`), 10000, 'renderer consumed the distinct internal engine turn identity');
      const uiTurnId = await evaluate<string>(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(sessionId)}].activeTurnId`);
      assert(typeof uiTurnId === 'string' && typeof facadeTurnId === 'string' && uiTurnId !== facadeTurnId, `The actual engine produces distinct visible and facade turn identities: ${JSON.stringify({ uiTurnId, facadeTurnId })}`);
      assertEqual(provider!.waiting(), 1, 'The original foreground tool remains active during queue entry');
      progress(`Observed distinct turn identities ${JSON.stringify({ uiTurnId, facadeTurnId })}`);
      await draft(directive);
      await click('#send');
      await waitFor(() => evaluate('document.querySelectorAll("#follow-up-queue [data-follow-up-id]").length === 1'), 10000, 'production composer enqueued the directive');
      const queued = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sessionId)})`);
      assertEqual(queued.snapshot.items.length, 1, 'One durable queued request exists before steering');
      const queueId = queued.snapshot.items[0].id;
      assertEqual(queued.snapshot.items[0].item.displayText, directive, 'Composer preserves the queued directive');
      await click('#follow-up-queue [data-follow-up-action="send-now"]');
      await waitFor(() => evaluate('window.__queueFixtureReplies.length === 1'), 10000, 'real renderer bridge received the queued steer response');
      const requestArgs = await evaluate('window.__queueFixtureRequests[0]');
      const reply = await evaluate('window.__queueFixtureReplies[0]');
      assertEqual(requestArgs[2].expectedTurnId, uiTurnId, 'The real row action sends its displayed turn identity through IPC');
      assertEqual(reply.ok, true, `Host accepts the displayed turn before canonical facade admission: ${JSON.stringify(reply)}`);
      const steers = facadeCalls.filter(call => call.method === 'thread/queue/start' && (call.params as { mode: string }).mode === 'steer');
      assertEqual(steers.length, 1, 'Exactly one named steer reaches the actual Rust process');
      assertEqual((steers[0]!.params as { expectedTurnId: string }).expectedTurnId, facadeTurnId, 'Only the captured facade identity reaches the strict engine fence');
      assertEqual(provider!.waiting(), 1, 'Steer admission does not start a replacement turn or release the tool');
      progress('Steer admitted; releasing the original foreground tool boundary');
      provider!.release();
      await waitFor(async () => (await records()).some(event => event.sessionId === sessionId && event.type === 'follow_up_status' && event.state === 'applied'), 20000, 'engine confirmed follow-up application');
      await waitFor(async () => (await records()).some(event => event.sessionId === sessionId && event.type === 'done'), 20000, 'same foreground turn completed');
      const events = (await records()).filter(event => event.sessionId === sessionId);
      const final = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sessionId)})`);
      assertEqual(final.snapshot.items.length, 0, 'The client-owned queue drains after one confirmed steer');
      assertEqual(events.filter(event => event.type === 'queued_follow_up_dispatched' && event.id === queueId).length, 1, 'One dispatch bubble is published for the queued request');
      assertEqual(events.filter(event => event.type === 'follow_up_status' && event.state === 'applied').length, 1, 'The engine applies the queued request exactly once');
      assert(provider!.requests.some(body => JSON.stringify(body.messages).includes(directive)), 'A subsequent real provider request contains the complete steer directive');
      assert(events.filter(event => event.type === 'text_delta').map(event => event.text).join('').includes('QUEUE_STEER_APPLIED_FIXTURE'), 'The streamed response proves the local provider consumed the directive');
      assertEqual(facadeCalls.filter(call => call.method === 'turn/submit' && (call.params as { mode: string }).mode === 'start-if-idle').length, 1, 'Steering uses the original foreground turn rather than starting another');
      assert(events.filter(event => event.type === 'done').every(event => event.turnId === uiTurnId), 'Terminal events retain the original visible turn identity');
      assertEqual(runtime!.engine.liveProcessCount(), 1, 'The runtime owns exactly one real Rust engine child');
      progress('Real renderer-to-engine queue steer regression passed');
    });
  } catch (error) { await h.test('queue steer fixture setup', () => { throw error; }); }
  finally {
    provider?.release();
    await diagnostics().catch(error => { h.info('diagnostics', String(error)); });
    try { await runtime?.shutdown(); }
    catch (error) { await h.test('production runtime cleanup', () => { throw error; }); }
    try { await provider?.close(); }
    catch (error) { await h.test('local provider cleanup', () => { throw error; }); }
    const code = await h.finish(join(logs, 'results.json'), 'queue-steer-app');
    app.exit(code);
  }
})();
