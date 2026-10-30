import { app, BrowserWindow } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import { loadNativeAddon } from '../main/native/binding';
import type { Json } from '../main/ipc/contract';
import type { PetState, PetTask } from '../contracts/desktop-pet';
import type { PetConversationState } from '../contracts/desktop-pet-composer';
import { assert, assertEqual, Harness, waitFor } from './harness';
import { startDesktopPetProvider } from './fixtures/desktop-pet-provider';
import { startDesktopPetRealtimeProvider } from './fixtures/desktop-pet-realtime-provider';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';

const root = process.env.KLAUS_PET_APP_PROFILE!;
const logs = process.env.KLAUS_PET_APP_LOGS!;
const restarting = process.env.KLAUS_PET_APP_RESTART === '1';
if (!root || !logs) throw Error('Run with scripts/run-desktop-pet-app-test.mjs');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startDesktopPetProvider>> | undefined;
let pet: BrowserWindow | undefined;
let voicePeer: BrowserWindow | undefined;
let voiceProvider: Awaited<ReturnType<typeof startDesktopPetRealtimeProvider>> | undefined;
const retained: string[] = [], events: unknown[] = [], metrics: Record<string, unknown> = {};
const progress = (value: string) => { process.stdout.write(value + '\n'); appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${value}\n`); };
const rendererEvents: Array<Record<string, unknown>> = [];
function rendererEvent(value: Record<string, unknown>) {
  const row = { at: new Date().toISOString(), ...value };
  rendererEvents.push(row);
  if (rendererEvents.length > 2000) rendererEvents.shift();
  appendFileSync(join(logs, 'renderer-events.jsonl'), JSON.stringify(row) + '\n');
}
app.on('web-contents-created', (_event, contents) => {
  const identity = () => ({ webContentsId: contents.id, url: contents.isDestroyed() ? '' : contents.getURL() });
  contents.on('console-message', event => rendererEvent({ type: 'console-message', ...identity(), level: event.level, message: event.message, lineNumber: event.lineNumber, sourceId: event.sourceId }));
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => rendererEvent({ type: 'did-fail-load', ...identity(), errorCode, errorDescription, validatedURL, isMainFrame }));
  contents.on('render-process-gone', (_event, details) => rendererEvent({ type: 'render-process-gone', ...identity(), reason: details.reason, exitCode: details.exitCode }));
  contents.on('preload-error', (_event, preloadPath, error) => rendererEvent({ type: 'preload-error', ...identity(), preloadPath, message: error.message, stack: error.stack }));
});
async function evaluate<T = any>(script: string, owner = runtime!.window, userGesture = false): Promise<T> {
  const result = await owner.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (\n${script}\n)}}catch(error){return {ok:false,error:{name:error?.name||'RendererError',message:error?.message||JSON.stringify(error)||String(error),stack:error?.stack||''}}}})()`, userGesture) as { ok: boolean; value?: T; error?: { name: string; message: string; stack: string } };
  if (!result.ok) {
    rendererEvent({ type: 'evaluation-error', webContentsId: owner.webContents.id, url: owner.webContents.getURL(), script: script.slice(0, 2000), ...result.error });
    throw new Error(`${result.error?.name}: ${result.error?.message}\n${result.error?.stack || ''}`);
  }
  return result.value as T;
}
const invoke = (channel: string, value?: unknown, owner = runtime!.window): Promise<any> => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`, owner);
const state = (): Promise<PetState> => invoke('desktop-pet:get-state');
const conversation = (): Promise<PetConversationState> => invoke('desktop-pet:conversation-state', undefined, pet!);
async function task(id: string): Promise<PetTask | undefined> { return (await state()).tasks.find(value => value.id === id); }
async function send(key: string, options: { permission?: string } = {}): Promise<string> {
  const row = await invoke('session:new', { workdir: root });
  await invoke('session:set-permission-mode', { sessionId: row.id, mode: options.permission || 'bypassPermissions' });
  await invoke('chat:send', { sessionId: row.id, text: key });
  return String(row.id);
}
async function completed(id: string) {
  await waitFor(async () => (await task(id))?.status === 'completed', 30000, 'real task completed');
}
async function click(selector: string, owner = pet!) {
  let previous = '', stable = 0;
  let point: { x: number; y: number } | undefined;
  await waitFor(async () => {
    const candidate = await evaluate<{ x: number; y: number; hit: boolean }>(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Control unavailable: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);return{x,y,hit:hit===el||el.contains(hit)}})()`, owner);
    const signature = JSON.stringify(candidate);
    stable = candidate.hit && signature === previous ? stable + 1 : 0;
    previous = signature; point = candidate;
    return stable >= 2;
  }, 5000, 'The actual control settles under its pointer: ' + selector);
  if (!point) throw Error('Control has no pointer position: ' + selector);
  rendererEvent({ type: 'fixture-pointer', selector, point, webContentsId: owner.webContents.id });
  await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});window.__petInputCounter=(window.__petInputCounter||0);target.addEventListener('click',()=>window.__petInputCounter++,{once:true});})()`,owner);
  const beforeClick = await evaluate<number>('window.__petInputCounter',owner);
  owner.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  owner.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  owner.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await waitFor(()=>evaluate(`window.__petInputCounter > ${beforeClick}`,owner),1500,'The actual control receives its pointer click: '+selector);
}

async function ensureVoiceActive(label: string) {
  await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'active' || await evaluate('Boolean(document.querySelector(".pet-voice-actions button.primary:not(:disabled)"))', pet!), 15000, label + ' exposes media or an available start control');
  if ((await invoke('desktop-pet:realtime-state', undefined, pet!)).phase !== 'active') {
    if (await evaluate('Boolean(document.querySelector(".pet-voice-actions button.primary:not(:disabled)"))', pet!)) await click('.pet-voice-actions button.primary');
  }
  await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'active', 20000, label);
}

async function focusMainForSystemInput() {
  const addon = loadNativeAddon(resolve(__dirname, '../../native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`));
  const captureExternalApplication = addon.captureActiveApplication;
  if (!captureExternalApplication) throw Error('Native foreground observation is unavailable');
  runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus();
  const nativeInput = join(logs,'native-input');
  const target = await evaluate<{x:number;y:number}>('(()=>{const rect=document.getElementById("input").getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()');
  const contentBounds = runtime!.window.getContentBounds();
  const focused = await systemInput(nativeInput,'click',[{x:contentBounds.x+target.x,y:contentBounds.y+target.y}],'focus-input.log');
  assertEqual(focused.status,0,'Owned main window receives an actual foreground activation click');
  try { await waitFor(() => runtime!.window.isFocused() && captureExternalApplication() === null, 5000, 'The actual system foreground belongs to the input target'); }
  catch (error) {
    const binary = join(logs,'native-input');
    const probe = spawnSync(binary,[String(process.pid),'check'],{encoding:'utf8',timeout:3000});
    rendererEvent({type:'focus-precondition-failure',mainFocused:runtime!.window.isFocused(),miniFocused:pet?.isFocused(),capturedExternal: captureExternalApplication(),stdout:probe.stdout,stderr:probe.stderr});
    throw error;
  }
  rendererEvent({ type: 'system-input-precondition', targetPid: process.pid, mainFocused: runtime!.window.isFocused(), externalForegroundApplication: captureExternalApplication() });
}
async function systemInput(binary: string, mode: string, points: Array<{ x: number; y: number }>, logName: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const args = [String(process.pid), mode, ...points.flatMap(point => [String(point.x), String(point.y)])];
  const startedAt = Date.now();
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000 });
  appendFileSync(join(logs, logName), `COMMAND:${JSON.stringify([binary,...args])}\n${result.stdout}${result.stderr}\nRESULT:${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, elapsedMs: Date.now() - startedAt })}\n`);
  return result;
}

async function setupVoiceProvider(protocol: 'public' | 'v1' | 'frameless') {
  await voiceProvider?.close(); voiceProvider = undefined;
  if (voicePeer && !voicePeer.isDestroyed()) voicePeer.destroy();
  voicePeer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await voicePeer.loadURL('about:blank');
  await evaluate(`(()=>{window.__voicePeer={pending:[],received:[]};window.__answerVoice=async offer=>{const f=window.__voicePeer,p=new RTCPeerConnection();f.peer=p;const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain(),output=context.createMediaStreamDestination();gain.gain.value=0;oscillator.connect(gain);gain.connect(output);oscillator.start();await context.resume();f.context=context;f.stream=output.stream;for(const track of output.stream.getTracks())p.addTrack(track,output.stream);p.ondatachannel=e=>{f.channel=e.channel;e.channel.onopen=()=>{for(const value of f.pending.splice(0))e.channel.send(JSON.stringify(value))};e.channel.onmessage=e=>f.received.push(JSON.parse(e.data))};await p.setRemoteDescription({type:'offer',sdp:offer});await p.setLocalDescription(await p.createAnswer());if(p.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Peer ICE timeout')),5000);p.addEventListener('icegatheringstatechange',()=>{if(p.iceGatheringState==='complete'){clearTimeout(timer);resolve()} })});return p.localDescription.sdp};window.__voiceEvent=value=>{const f=window.__voicePeer;if(f.channel?.readyState==='open')f.channel.send(JSON.stringify(value));else f.pending.push(value)}})()`, voicePeer);
  const prepared = await startDesktopPetRealtimeProvider({ answer: offer => evaluate<string>(`window.__answerVoice(${JSON.stringify(offer)})`, voicePeer!, true), event: value => evaluate(`window.__voiceEvent(${JSON.stringify(value)})`, voicePeer!) }, protocol);
  voiceProvider = prepared; return prepared;
}
async function diagnostics(label = 'diagnostics', failure?: unknown) {
  const inspect = async (owner: BrowserWindow | undefined) => !owner || owner.isDestroyed() ? null : evaluate(`(()=>{const selectors=['#root','.pet-window','.pet-task','.pet-conversation','.pet-conversation-messages','.pet-bar textarea','.pet-send','.pet-voice','.pet-voice-panel','.pet-voice-actions button.primary','.pet-voice-actions button.danger','.pet-composer-accessories'];return {url:location.href,body:document.body.innerText.slice(-20000),html:document.getElementById('root')?.outerHTML.slice(-40000),current:window.currentSessionId,activeElement:document.activeElement?.outerHTML,capabilities:{secure:isSecureContext,peer:typeof RTCPeerConnection,mediaDevices:typeof navigator.mediaDevices,getUserMedia:typeof navigator.mediaDevices?.getUserMedia},controls:selectors.map(selector=>({selector,count:document.querySelectorAll(selector).length,elements:Array.from(document.querySelectorAll(selector)).slice(0,4).map(element=>{const r=element.getBoundingClientRect();return {text:element.textContent?.slice(0,300),disabled:element.disabled,value:element.value,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})})),media:window.__voiceMedia?{peers:window.__voiceMedia.peers.map(peer=>({connectionState:peer.connectionState,iceConnectionState:peer.iceConnectionState,signalingState:peer.signalingState})),tracks:window.__voiceMedia.streams.flatMap(stream=>stream.getTracks().map(track=>({kind:track.kind,enabled:track.enabled,readyState:track.readyState})))}:null}})()`, owner).catch(String);
  const page = await inspect(runtime?.window), mini = await inspect(pet), peer = await inspect(voicePeer);
  const currentState = runtime ? await state().catch(String) : null;
  const selectedConversation = pet && !pet.isDestroyed() ? await conversation().catch(String) : null;
  const liveVoice = pet && !pet.isDestroyed() ? await invoke('desktop-pet:realtime-state', undefined, pet).catch(String) : null;
  writeFileSync(join(logs, label + '.json'), JSON.stringify({ root, failure: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure, events, metrics, retained, provider: provider?.requests, realtime: voiceProvider ? { requests: voiceProvider.requests, messages: voiceProvider.messages } : null, rendererEvents, currentState, selectedConversation, liveVoice, page, mini, peer }, null, 2));
  for (const [name, owner] of [['main', runtime?.window], ['companion', pet], ['voice-peer', voicePeer]] as const) if (owner && !owner.isDestroyed()) writeFileSync(join(logs, (label === 'diagnostics' ? name : label + '-' + name) + '.png'), (await owner.webContents.capturePage()).toPNG());
}
let failureSequence = 0;
async function scenario(name: string, action: () => void | Promise<void>) {
  return h.test(name, async () => {
    try { await action(); }
    catch (error) {
      await diagnostics('failure-' + String(++failureSequence).padStart(2, '0'), error).catch(diagnosticError => rendererEvent({ type: 'diagnostics-error', message: String(diagnosticError) }));
      throw error;
    }
  });
}

void (async () => {
  try {
    await app.whenReady();
    if (!restarting) for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:pet-fixture', 'composer.thinking_level': 'off', global_shortcut: 'off', quick_input_shortcut: 'off', desktop_pet_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0', language: 'en' })) kvSet(key, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startDesktopPetProvider();
    process.env.KLAUS_SERVER_URL = provider.url;
    mkdirSync(join(root, 'external-home'), { recursive: true });
    progress('Starting production runtime, native addon, preload, renderer and Rust engine');
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: join(root, 'external-home') });
    runtime.window.setContentSize(1280, 820);
    runtime.engine.on('event', event => { events.push(event); });
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.pet-fixture', mergeStrategy: 'replace', value: { name: 'Companion fixture', provider: 'anthropic', model: 'pet-fixture-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true } } }] });
    await runtime.sessions.request('model/credential/write', { id: 'pet-fixture', apiKey: 'local-fixture-key' });
    await waitFor(() => evaluate('Boolean(window.klaus?.desktopPet && window.klaus.chat && document.getElementById("input"))'), 20000, 'production main renderer loaded');
    if (restarting) {
      await scenario('a fresh application process restores terminal activity and preferences without reviving live resources', async () => {
        await waitFor(async () => (await state()).tasks.length >= 16, 15000, 'Persisted terminal cards rehydrate in a fresh process');
        const restored = await state();
        assertEqual(restored.settings.language, 'zh', 'Locale survives an actual process restart');
        assertEqual(restored.settings.size, 128, 'Companion preferences survive an actual process restart');
        assert(restored.tasks.every(row => ['completed', 'failed'].includes(row.status) && !row.attention), 'Fresh process never restores running work or approval ownership');
        pet = BrowserWindow.getAllWindows().find(owner => /\/pet\.html(?:[?#]|$)/.test(owner.webContents.getURL()));
        assert(pet, 'Enabled companion is created from the saved preference');
        await waitFor(() => evaluate('Boolean(document.querySelector(".pet-window"))', pet!), 10000, 'Restarted companion renderer is ready');
        assertEqual((await invoke('desktop-pet:realtime-state', undefined, pet!)).phase, 'inactive', 'Fresh process never restores audio ownership');
        const engine = runtime!.engine;
        assertEqual(engine.liveProcessCount(), 1, 'Restart owns exactly one engine child');
        await diagnostics(); await runtime!.shutdown(); runtime = undefined;
        assertEqual(engine.liveProcessCount(), 0, 'Shutdown drains the restarted engine child');
      });
      return;
    }

    await scenario('enabling the production companion preserves the main document styles and native input', async () => {
      const css = 'JSON.stringify([document.body,document.documentElement,document.getElementById("input")].map(el=>{const s=getComputedStyle(el);return [s.position,s.display,s.width,s.height,s.backgroundColor,s.fontFamily,s.pointerEvents,s.overflow]}))';
      const before = await evaluate<string>(`(async()=>{let previous='',since=performance.now();while(performance.now()-since<750){const current=${css};if(current!==previous){previous=current;since=performance.now()}await new Promise(resolve=>setTimeout(resolve,30))}return previous})()`);
      await invoke('desktop-pet:update-settings', { enabled: true });
      await waitFor(() => { pet = BrowserWindow.getAllWindows().find(owner => /\/pet\.html(?:[?#]|$)/.test(owner.webContents.getURL())); return Boolean(pet); }, 10000, 'actual companion window created');
      await waitFor(() => evaluate('Boolean(window.__KLAUS_DESKTOP__?.core && document.querySelector(".pet-window"))', pet!), 15000, 'production pet renderer loaded');
      assertEqual(await evaluate<string>(css), before, 'Companion styles do not alter the main document');
      runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus();
      await evaluate('(()=>{window.__petNativeClicks=0;document.getElementById("input").addEventListener("pointerdown",()=>window.__petNativeClicks++)})()');
      const source = resolve(__dirname, '../../tests/fixtures/recording-input.m'), binary = join(logs, 'native-input');
      const build = spawnSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'Carbon', source, '-o', binary], { encoding: 'utf8' });
      appendFileSync(join(logs, 'native-input.log'), `COMMAND: xcrun clang ${source}\n${build.stdout}${build.stderr}\nEXIT:${build.status}\n`);
      assertEqual(build.status, 0, 'Native input fixture compiles');
      const signing = spawnSync('codesign', ['--force', '--sign', '-', '--timestamp=none', binary], { encoding: 'utf8' });
      appendFileSync(join(logs, 'native-input.log'), `COMMAND:codesign --force --sign - --timestamp=none ${binary}\n${signing.stdout}${signing.stderr}\nEXIT:${signing.status}\n`);
      assertEqual(signing.status, 0, 'Native input fixture receives its local build signature');
      await focusMainForSystemInput();
      const point = await evaluate<{ x: number; y: number }>('(()=>{const r=document.getElementById("input").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      const bounds = runtime!.window.getContentBounds();
      const input = await systemInput(binary, 'click', [{ x: bounds.x + point.x, y: bounds.y + point.y }], 'native-input.log');
      assertEqual(input.status, 0, 'Native pointer event delivered');
      await waitFor(() => evaluate('window.__petNativeClicks > 0'), 5000, 'main input accepts actual OS pointer while companion is enabled');
    });

    await scenario('retained activity, genuine summary tool and live Mini transcript remain responsive while the real model streams', async () => {
      const client = await runtime!.sessions.client(), request = client.requestWithTimeout;
      const observedRequests: Record<string, number> = {};
      client.requestWithTimeout = function(method, ...args) {
        observedRequests[method] = (observedRequests[method] || 0) + 1;
        return request.call(this, method, ...args);
      };
      const observation = setInterval(() => progress(`Retained task request counts: ${JSON.stringify(observedRequests)}`), 10000);
      try {
        for (let index = 0; index < 16; index++) {
          progress(`Preparing retained task ${index + 1} of 16`);
          const id = await send(`PET_CASE_RETAIN_${index}`); await completed(id); retained.push(id);
          progress(`Completed retained task ${index + 1} of 16`);
        }
      } finally { client.requestWithTimeout = request; clearInterval(observation); }
      assert((await state()).tasks.filter(row => row.status === 'completed').length >= 16, 'Terminal cards exist from actual engine tasks');
      provider!.pause('PET_CASE_STREAM_HOLD');
      const id = await send('PET_CASE_STREAM_HOLD');
      metrics.streamSessionId = id;
      try {
        await waitFor(() => provider!.phase('PET_CASE_STREAM_HOLD') === 'streaming', 20000, 'real dynamic summary tool completed before text streaming');
        await waitFor(async () => (await task(id))?.summary === 'Checking companion runtime', 5000, 'successful summary tool updates activity');
        await click('.pet-task:first-child .pet-task-main');
        await waitFor(() => evaluate('document.querySelector(".pet-activity")?.classList.contains("pet-activity-expanded") === true', pet!), 5000, 'a collapsed pile expands before opening a task');
        await click('.pet-task:first-child .pet-task-main');
        await waitFor(() => evaluate(`window.currentSessionId === ${JSON.stringify(id)}`), 5000, 'notification body opens its actual task in the main window');
        await invoke('desktop-pet:select-conversation', { sessionId: id }, pet!);
        if (await evaluate('Boolean(document.querySelector(".pet-compose-button"))', pet!)) await click('.pet-compose-button');
        await waitFor(async () => (await conversation()).sessionId === id, 5000, 'Mini selects the running conversation');
        assertEqual(await evaluate('Boolean(document.querySelector(".pet-notification-slot"))',pet!),false,'Expanded history excludes task notifications');
        const settings = require('../main/services/settings') as typeof import('../main/services/settings');
        const original = settings.kvGet;
        let languageReads = 0, maximumLag = 0, previous = performance.now();
        const languageReadStacks: string[] = [];
        const timer = setInterval(() => { const now = performance.now(); maximumLag = Math.max(maximumLag, now - previous - 20); previous = now; }, 20);
        settings.kvGet = ((key: string, ...args: any[]) => { if (key === 'language') { languageReads++; languageReadStacks.push(new Error('Measured language read').stack || ''); } return (original as any)(key, ...args); }) as typeof original;
        try {
          provider!.resume('PET_CASE_STREAM_HOLD');
          await waitFor(async () => (await conversation()).messages.some(message => message.role === 'assistant' && message.text.includes('fragment-767')), 10000, 'production Mini follows actual streamed text');
          await waitFor(() => evaluate('document.querySelector(".pet-conversation-messages")?.textContent.includes("fragment-767") === true', pet!), 5000, 'actual Mini renderer paints the live response');
        } finally { settings.kvGet = original; clearInterval(timer); provider!.release('PET_CASE_STREAM_HOLD'); }
        metrics.streaming = { terminalCards: retained.length, modelDeltas: 768, languageReads, languageReadStacks, maximumLagMs: maximumLag };
        assertEqual(languageReads, 0, 'Continuous model output never reads SQLite locale settings');
        assert(maximumLag < 500, `Host remains responsive during streaming: ${maximumLag}ms`);
        const current = await conversation(), content = current.messages.filter(row => row.role === 'assistant').map(row => row.text).join('');
        for (let index = 0; index < 768; index++) assertEqual([...content.matchAll(new RegExp(`fragment-${index} `, 'g'))].length, 1, `Fragment ${index} survives snapshot/live reconciliation exactly once`);
        provider!.release('PET_CASE_STREAM_HOLD'); await completed(id);
        await waitFor(async () => !(await conversation()).running, 5000, 'Mini consumes terminal state');
        assertEqual((await conversation()).sessionId, id, 'Mini keeps the selected conversation after completion');
        await evaluate('document.querySelector(".pet-editor-controls:not(.pet-editor-submitted) textarea")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',pet!);
        assert(provider!.requests.some(body => JSON.stringify(body.tools).includes('update_running_summary')), 'Actual Rust provider request exposes the host summary tool');
        metrics.streamSessionId = id;
        progress(`Measured production stream: ${JSON.stringify(metrics.streaming)}`);
      } finally { provider!.release('PET_CASE_STREAM_HOLD'); }
    });

    await scenario('companion approval and structured question resolve genuine engine-owned requests', async () => {
      const id = await send('PET_CASE_APPROVAL', { permission: 'default' });
      await waitFor(async () => (await task(id))?.attention?.kind === 'approval', 20000, 'actual command approval reaches companion');
      const attention = (await task(id))!.attention!;
      assert(!existsSync(join(root, 'companion-approval.txt')), 'The pending approval has not executed its command');
      await invoke('desktop-pet:respond-task', { taskId: id, requestId: attention.id, response: { decision: 'allow' } }, pet!);
      await completed(id);
      assertEqual(readFileSync(join(root, 'companion-approval.txt'), 'utf8'), 'companion-approval', 'Real engine command executes only after companion approval');
      let staleRejected = false;
      try { await invoke('desktop-pet:respond-task', { taskId: id, requestId: attention.id, response: { decision: 'allow' } }, pet!); } catch { staleRejected = true; }
      assert(staleRejected, 'Resolved approval identities cannot be reused');
      const questionId = await send('PET_CASE_QUESTION');
      await waitFor(async () => (await task(questionId))?.attention?.kind === 'question', 20000, 'actual async question reaches companion');
      const question = (await task(questionId))!.attention!;
      assert(question.kind === 'question', 'Question contract remains structured');
      await invoke('desktop-pet:respond-task', { taskId: questionId, requestId: question.id, response: { kind: 'answers', answers: { [question.questions[0]!.question]: 'Local' } } }, pet!);
      await completed(questionId);
      const request = (events as any[]).find(event => event.type === 'reverseRequest' && `${event.generation}:elicit:${event.request?.params?.elicitation?.requestId}` === question.id)?.request.params;
      assert(request, 'The companion response resolves the genuine engine request identity');
      const completedQuestion = (events as any[]).find(event => event.method === 'item/completed' && event.params?.sessionId === request.sessionId && event.params?.submissionId === request.submissionId && event.params?.item?.toolName === 'ask_user')?.params.item;
      assert(typeof completedQuestion?.id === 'string' && completedQuestion.result?.answers?.target === 'Local', 'The exact engine-owned question turn completes with the selected answer');
      assert(provider!.requests.some(body => (body.messages as any[]).some(message => Array.isArray(message.content) && message.content.some((block: any) => {
        if (block.type !== 'tool_result' || block.tool_use_id !== completedQuestion.id || block.is_error) return false;
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : '';
        try { return JSON.parse(text).answers?.target === 'Local'; } catch { return false; }
      }))), 'The real model receives the successful answer for the exact question tool call');
    });

    await scenario('Mini submission preserves its conversation, uploaded attachment and actual interruption', async () => {
      await invoke('desktop-pet:select-conversation', { sessionId: null }, pet!);
      if (await evaluate('Boolean(document.querySelector(".pet-compose-button"))', pet!)) await click('.pet-compose-button');
      await waitFor(() => evaluate('Boolean(document.querySelector("textarea"))', pet!), 5000, 'Mini input is mounted');
      await click('textarea');
      await evaluate(`(()=>{const data=new DataTransfer(),png=Uint8Array.from(atob(${JSON.stringify(PNG_FIXTURE_BASE64)}),character=>character.charCodeAt(0));data.items.add(new File(['attachment validation'],'companion-note.txt',{type:'text/plain'}));data.items.add(new File([png],'companion-image.png',{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}))})()`, pet!);
      await waitFor(() => evaluate('document.querySelector(".pet-composer-accessories")?.textContent.includes("companion-note.txt") === true', pet!), 5000, 'Actual Mini paste handler imports and displays the attachment');
      await waitFor(() => evaluate('Array.from(document.querySelectorAll(".pet-composer-accessories img")).some(image=>image.complete&&image.naturalWidth>0)', pet!), 5000, 'The pasted image decodes in the actual Mini draft');
      await pet!.webContents.insertText('PET_CASE_MINI_HOLD');
      await waitFor(() => evaluate('document.querySelector("textarea")?.value === "PET_CASE_MINI_HOLD" && !document.querySelector(".pet-send").disabled', pet!), 5000, 'Actual composer input accepts the message');
      await click('.pet-send');
      await waitFor(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "controls" && !document.querySelector(".pet-conversation")', pet!), 5000, 'Actual submit compacts the input and hides full history');
      await waitFor(async () => Boolean((await conversation()).sessionId), 10000, 'Actual send control binds its conversation');
      const result = { sessionId: (await conversation()).sessionId! };
      assert(typeof result?.sessionId === 'string', 'Mini send returns actual session identity');
      metrics.miniSessionId = result.sessionId;
      await waitFor(() => evaluate(`Boolean(document.querySelector('[data-task-id="${result.sessionId}"]'))`, pet!), 10000, 'New submission appears as an activity notification');
      assertEqual((await state()).settings.showActivity, true, 'A new Mini chat enables task notifications');
      writeFileSync(join(logs, 'mini-submitted.png'), (await pet!.webContents.capturePage()).toPNG());
      await waitFor(async () => (await conversation()).messages.some(message => message.role === 'assistant' && message.text.includes('fragment-')), 20000, 'Mini consumes its own live response');
      assertEqual((await conversation()).sessionId, result.sessionId, 'Sending keeps the Mini target');
      const history = await runtime!.sessions.history(result.sessionId) as any;
      const user = history.messages.find((row: any) => row.role === 'user' && row.localRender?.attachments?.some((file: any) => file.name === 'companion-note.txt'));
      assert(user, 'The real durable user message retains the original attachment name');
      const uploadedPath = user.localRender.attachments.find((file: any) => file.name === 'companion-note.txt').path;
      assertEqual(readFileSync(uploadedPath, 'utf8'), 'attachment validation', 'Uploaded bytes survive the actual file transaction');
      const savedImage = user.localRender.attachments.find((file: any) => file.name === 'companion-image.png');
      assert(savedImage && typeof savedImage.path === 'string', 'Durable user history retains the real uploaded image path');
      assert(readFileSync(savedImage.path).equals(Buffer.from(PNG_FIXTURE_BASE64, 'base64')), 'Historical image bytes retain the exact pasted PNG');
      assert(provider!.requests.some(body => JSON.stringify(body.messages).includes(uploadedPath)), 'The real uploaded path reaches the model request');
      await invoke('desktop-pet:stop-conversation', undefined, pet!);
      await waitFor(async () => !(await conversation()).running, 10000, 'Mini stop reaches actual engine turn');
      await waitFor(() => provider!.phase('PET_CASE_MINI_HOLD') === 'cancelled', 5000, 'provider observes the confirmed engine interruption');
      assertEqual(provider!.phase('PET_CASE_MINI_HOLD'), 'cancelled', 'Provider stream is cancelled by engine interruption');
      await invoke('desktop-pet:refresh-conversation', undefined, pet!);
      assert((await conversation()).messages.some(message => message.role === 'user' && message.text.includes('PET_CASE_MINI_HOLD')), 'Mini history reload retains the sent message');
      if (await evaluate('Boolean(document.querySelector(".pet-compose-button"))', pet!)) await click('.pet-compose-button');
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.pet-conversation-attachment img')).some(image=>image.complete&&image.naturalWidth>0&&image.src.startsWith('klaus-media:')&&new URL(image.src).searchParams.get('s')===${JSON.stringify(result.sessionId)})`, pet!), 5000, 'The actual reloaded Mini history decodes its session-scoped local image under its content policy');
      metrics.miniHistoricalImage = await evaluate(`Array.from(document.querySelectorAll('.pet-conversation-attachment img')).filter(image=>image.src.startsWith('klaus-media:')).map(image=>({src:image.src,width:image.naturalWidth,height:image.naturalHeight,complete:image.complete}))`, pet!);
      let reclaimedFocus = 0;
      const onReclaimedFocus = () => { reclaimedFocus++; };
      pet!.on('focus', onReclaimedFocus);
      try {
        await focusMainForSystemInput();
        await new Promise(resolve => setTimeout(resolve, 500));
        metrics.mainFocusAfterMini = { observationMs: 500, reclaimedFocus, mainFocused: runtime!.window.isFocused(), miniFocused: pet!.isFocused() };
        assertEqual(reclaimedFocus, 0, 'An open Mini editor never reclaims focus after the user returns to the main window');
        assert(runtime!.window.isFocused() && !pet!.isFocused(), 'Main input keeps native focus while the Mini editor stays open');
      } finally {
        pet!.removeListener('focus', onReclaimedFocus);
      }
    });

    await scenario('notification follow-up reaches the same real conversation and returns to a compact completed summary', async () => {
      await invoke('desktop-pet:update-settings', { enabled: true });
      const id = String(metrics.streamSessionId), selector = `[data-task-id="${id}"]`;
      await evaluate('document.querySelector(".pet-editor-controls:not(.pet-editor-submitted) textarea")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))', pet!);
      if (await evaluate('document.querySelector(".pet-stack-toggle")?.getAttribute("aria-expanded") === "false"', pet!)) await click('.pet-stack-toggle');
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, pet!), 5000, 'The actual conversation notification is retained');
      await evaluate(`document.querySelector(${JSON.stringify(selector+' .pet-task-reply-button')}).click()`, pet!);
      await waitFor(() => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector+' .pet-task-reply textarea')})`, pet!), 5000, 'Notification follow-up owns keyboard input');
      await pet!.webContents.insertText('PET_CASE_INLINE_REPLY');
      await click(selector+' .pet-task-reply-send');
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(selector+' .pet-task-reply')})`, pet!), 10000, 'Accepted follow-up closes its own field');
      await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('PET_CASE_INLINE_REPLY')), 20000, 'Actual provider receives inline follow-up');
      await completed(id);
      await waitFor(async () => Boolean((await task(id))?.summary?.startsWith('fragment-0 fragment-1')), 10000, 'Completed notification contains the actual response preview');
      assertEqual((await conversation()).sessionId,id,'Follow-up keeps the same conversation');
      assertEqual(await evaluate('Boolean(document.querySelector(".pet-conversation"))',pet!),false,'Follow-up does not open full history');
      writeFileSync(join(logs,'inline-completed.png'),(await pet!.webContents.capturePage()).toPNG());
    });

    await scenario('native capture chord delivers a real application screenshot to the main draft and Mini with verified context', async () => {
      const source = resolve(__dirname, '../../tests/fixtures/pet-window-input.m'), binary = join(logs, 'capture-input');
      for (const [command, args] of [['xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'Carbon', source, '-o', binary]], ['codesign', ['--force', '--sign', '-', '--timestamp=none', binary]]] as const) {
        const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 30000 });
        appendFileSync(join(logs, 'capture-input.log'), `COMMAND:${JSON.stringify([command,...args])}\n${result.stdout}${result.stderr}\nEXIT:${result.status}\n`);
        assertEqual(result.status, 0, 'Owned capture input fixture builds and signs');
      }
      await evaluate('(()=>{window.__petCaptures=[];window.__petCaptureStop=window.klaus.on.desktopPetMainCapture(value=>window.__petCaptures.push(value))})()');
      await evaluate('(async()=>{window.__petCaptures=[];window.__petCaptureStop=await window.__KLAUS_DESKTOP__.event.listen("ipc:desktop-pet:capture-event",event=>window.__petCaptures.push(event.payload.args[0]))})()', pet!);
      const chord = async () => {
        await focusMainForSystemInput();
        const result = await systemInput(binary, 'chord', [], 'capture-input.log');
        assertEqual(result.status, 0, 'Actual native capture chord is posted to the owned foreground');
      };
      const configured = await invoke('desktop-pet:update-appshot-settings', { shortcut: 'DoubleCommand', soundEnabled: false, alwaysSendToMini: false, destination: 'new-chat' });
      assert(configured.active, 'Production native shortcut monitor is registered');
      await chord();
      await waitFor(() => evaluate('window.__petCaptures.length > 0'), 15000, 'Real native capture reaches the main renderer');
      const mainCapture = await evaluate<any>('window.__petCaptures.at(-1)');
      assertEqual(mainCapture.attachment.context.pid, process.pid, 'Native screenshot context identifies only the owned foreground application');
      assert(mainCapture.attachment.context.windowId > 0, 'Native screenshot retains its real window identity');
      assertEqual(Buffer.from(readFileSync(mainCapture.attachment.path).subarray(0, 8)).toString('hex'), '89504e470d0a1a0a', 'Captured bytes are a real PNG');
      await waitFor(() => evaluate('Boolean(document.querySelector(".kls-attach-item img"))'), 5000, 'Main draft visibly receives its screenshot attachment');
      assertEqual(await evaluate('document.getElementById("input").value || document.getElementById("input").textContent'), '', 'Capture never sends or fabricates draft text');
      await invoke('desktop-pet:update-appshot-settings', { alwaysSendToMini: true, destination: 'new-chat' });
      await chord();
      await waitFor(() => evaluate('window.__petCaptures.some(event=>event.type==="completed")', pet!), 15000, 'Real global capture reaches the Mini receiver');
      const miniCapture = await evaluate<any>('window.__petCaptures.find(event=>event.type==="completed").attachment', pet!);
      assertEqual(miniCapture.context.pid, process.pid, 'Mini uses the original foreground identity before focus changes');
      assert(miniCapture.context.windowId > 0, 'Mini retains real captured window identity');
      await waitFor(() => evaluate('Boolean(document.querySelector(".pet-composer-accessories img"))', pet!), 5000, 'Actual Mini renders its screenshot attachment');
      await invoke('desktop-pet:remove-attachment', { id: miniCapture.id }, pet!);
      metrics.appshot = { mainWindowId: mainCapture.attachment.context.windowId, miniWindowId: miniCapture.context.windowId, pngBytes: mainCapture.attachment.size, observationChanged: miniCapture.context.observationChanged ?? false };
      await invoke('desktop-pet:update-appshot-settings', { alwaysSendToMini: false, destination: 'automatic', shortcut: null });
    });

    await scenario('actual WebRTC media and data channels delegate a spoken task through the real engine and finalize transcripts', async () => {
      const realtimeProvider = await setupVoiceProvider('public');
      await invoke('settings:models:upsert', { id: 'voice-fixture', name: 'Local audio fixture', provider: 'openai', model: 'fixture-text-model', baseUrl: realtimeProvider.url + '/v1', apiKey: 'local-realtime-fixture-key', realtime: { model: 'fixture-realtime-model', transcriptionModel: 'fixture-transcription-model' }, maxContextTokens: 200000, isDefault: false });
      await invoke('settings:kv:set', { key: 'desktop_pet.realtime_provider', value: 'voice-fixture' });
      await invoke('desktop-pet:select-conversation', { sessionId: null }, pet!);
      await evaluate(`(()=>{window.__voiceMedia={peers:[],streams:[]};const Peer=window.RTCPeerConnection;window.RTCPeerConnection=class extends Peer{constructor(...args){super(...args);window.__voiceMedia.peers.push(this)}};const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await media(constraints);window.__voiceMedia.streams.push(stream);return stream}})()`, pet!);
      await click('.pet-voice');
      await ensureVoiceActive('Real peer, data channel and engine sideband are ready');
      const active = await invoke('desktop-pet:realtime-state', undefined, pet!);
      assertEqual(active.transport, 'webrtc', 'Production UI uses the negotiated media transport');
      await invoke('desktop-pet:select-conversation', { sessionId: null }, pet!);
      await waitFor(() => evaluate('Boolean(document.querySelector(".pet-voice-target-notice [data-voice-return]"))', pet!), 5000, 'A new text draft exposes the retained voice destination');
      assertEqual((await invoke('desktop-pet:realtime-state', undefined, pet!)).sessionId, active.sessionId, 'Changing the text target never retargets the live voice session');
      await click('[data-voice-return]');
      await waitFor(async () => (await conversation()).sessionId === active.sessionId, 5000, 'Return action selects the actual owned voice conversation');
      await waitFor(() => evaluate('!document.querySelector(".pet-voice-target-notice")', pet!), 5000, 'Matching text and voice targets remove the destination notice');

      await waitFor(() => evaluate('window.__voiceMedia.peers.some(peer=>peer.connectionState==="connected") && window.__voiceMedia.streams.some(stream=>stream.getAudioTracks().some(track=>track.enabled&&track.readyState==="live"))', pet!), 10000, 'actual browser audio track opens only after the handshake');
      await realtimeProvider.emit({ type: 'input_audio_buffer.speech_started', item_id: 'spoken-user' });
      await realtimeProvider.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'spoken-user' });
      await realtimeProvider.emit({ type: 'input_audio_buffer.committed', item_id: 'spoken-user' });
      await realtimeProvider.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'spoken-user', transcript: 'PET_CASE_VOICE_TASK' });
      await waitFor(() => realtimeProvider.messages.some(value => value.type === 'response.create'), 10000, 'engine owns the spoken response generation');
      const command = [...realtimeProvider.messages].reverse().find(value => value.type === 'response.create')!;
      const metadata = command.response?.metadata;
      await realtimeProvider.emit({ type: 'response.created', response: { id: 'spoken-response', metadata } });
      await realtimeProvider.emit({ type: 'response.done', response: { id: 'spoken-response', status: 'completed', metadata, output: [{ type: 'function_call', status: 'completed', id: 'delegated-item', call_id: 'delegated-call', name: 'delegate_task', arguments: JSON.stringify({ prompt: 'PET_CASE_VOICE_TASK' }) }] } });
      await waitFor(() => realtimeProvider.messages.some(value => value.type === 'conversation.item.create' && value.item?.type === 'function_call_output' && value.item.call_id === 'delegated-call'), 30000, 'actual normal engine task returns its function result');
      const result = realtimeProvider.messages.find(value => value.type === 'conversation.item.create' && value.item?.call_id === 'delegated-call')!;
      assert(String(result.item.output).includes('COMPANION_RESPONSE_COMPLETE'), 'The spoken tool result contains the real delegated task response');
      await realtimeProvider.emit({ type: 'response.output_audio_transcript.done', item_id: 'spoken-assistant', transcript: 'The requested task completed.' });
      await waitFor(() => evaluate('document.querySelector(".pet-voice-transcript")?.textContent.includes("The requested task completed.") === true', pet!), 10000, 'actual data channel captions render in the voice panel');
      await waitFor(() => evaluate('(async()=>{for(const peer of window.__voiceMedia.peers.filter(peer=>peer.connectionState==="connected"))for(const value of (await peer.getStats()).values())if(value.type==="inbound-rtp"&&value.packetsReceived>0)return true;return false})()', pet!), 10000, 'Actual incoming RTP is observed before sampling');
      const stats = await evaluate<any>(`(async()=>{const rows=[];for(const peer of window.__voiceMedia.peers){for(const value of (await peer.getStats()).values())if(value.type==='inbound-rtp'||value.type==='outbound-rtp')rows.push({type:value.type,kind:value.kind,packetsReceived:value.packetsReceived,packetsSent:value.packetsSent})}return rows})()`, pet!);
      assert(stats.some((row: any) => row.type === 'inbound-rtp' && row.packetsReceived > 0), 'A real incoming media track carries RTP packets');
      metrics.realtime = { sessionId: active.sessionId, media: stats, providerMessages: realtimeProvider.messages.length, virtualMicrophone: true };
      await click('.pet-voice-actions button.danger');
      await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'inactive', 15000, 'voice finalization reaches the actual provider');
      assert(realtimeProvider.ended(), 'The engine explicitly hangs up its provider call');
      await waitFor(() => evaluate('document.querySelector(".pet-voice-transcript")?.textContent.includes("The final spoken tail was preserved.") === true', pet!), 5000, 'The host-only final transcript tail remains visible after browser transport shutdown');
      await waitFor(() => evaluate('window.__voiceMedia.peers.every(peer=>peer.connectionState==="closed") && window.__voiceMedia.streams.every(stream=>stream.getTracks().every(track=>track.readyState==="ended"))', pet!), 5000, 'All browser media and peer resources close');
      const history = JSON.stringify(await runtime!.sessions.history(active.sessionId));
      assert(history.includes('PET_CASE_VOICE_TASK') && history.includes('The final spoken tail was preserved.'), 'Confirmed speech and final transcript tail persist through the real session facade');
      progress('Real WebRTC + owned engine task + provider hangup regression passed');
    });

    for (const protocol of ['v1', 'frameless'] as const) await scenario(`configured ${protocol} media calls retain backend sessions, owned handoffs and streamed host captions`, async () => {
      const realtimeProvider = await setupVoiceProvider(protocol);
      const sourceId = 'voice-fixture-' + protocol, prompt = 'PET_CASE_VOICE_' + protocol.toUpperCase() + '_TASK';
      await invoke('settings:models:upsert', { id: sourceId, name: 'Local ' + protocol + ' audio fixture', provider: 'openai', model: 'fixture-text-model', baseUrl: realtimeProvider.url + realtimeProvider.basePath, apiKey: 'local-realtime-fixture-key', realtime: { protocol, model: 'fixture-' + protocol + '-model', voice: 'cove', transcriptionModel: 'fixture-transcription-model' }, maxContextTokens: 200000, isDefault: false });
      await invoke('settings:kv:set', { key: 'desktop_pet.realtime_provider', value: sourceId });
      const contextPrompt = 'PET_CASE_SELECTED_' + protocol.toUpperCase(), contextSessionId = await send(contextPrompt);
      await completed(contextSessionId);
      await invoke('desktop-pet:select-conversation', { sessionId: contextSessionId }, pet!);
      if (await evaluate('Boolean(document.querySelector(".pet-compose-button"))', pet!)) await click('.pet-compose-button');
      if (await evaluate('Boolean(document.querySelector(".pet-conversation-reopen"))', pet!)) await click('.pet-conversation-reopen');
      const options = await invoke('desktop-pet:realtime-options', { sourceId });
      assert(options.available && options.protocol === protocol && options.transcriptSource === 'engine', 'Configured protocol exposes authoritative engine captions');
      if (!await evaluate('Boolean(document.querySelector(".pet-voice-panel"))', pet!)) await click('.pet-voice');
      await ensureVoiceActive('Existing media call sideband attaches without reconfiguring the session');
      const active = await invoke('desktop-pet:realtime-state', undefined, pet!);
      assertEqual(active.protocol, protocol, 'Production state retains the negotiated protocol');
      assertEqual(active.transcriptSource, 'engine', 'Production captions belong to the engine sideband');
      assertEqual(active.sessionId, contextSessionId, 'The live voice transport retains the freshly selected confirmed conversation');
      const transcriptLayout = await evaluate<any>(`(()=>{const container=document.querySelector('.pet-conversation'),messages=container?.querySelector('.pet-conversation-messages'),voice=document.querySelector('.pet-voice-panel');if(!container||!messages||!voice)throw Error('The actual combined conversation and voice surfaces must be mounted');const parent=container.getBoundingClientRect(),viewport=messages.getBoundingClientRect();messages.scrollTop=0;messages.scrollTop=messages.scrollHeight;return {parent:{top:parent.top,bottom:parent.bottom,height:parent.height},viewport:{top:viewport.top,bottom:viewport.bottom,height:viewport.height},clientHeight:messages.clientHeight,scrollHeight:messages.scrollHeight,scrollTop:messages.scrollTop,display:getComputedStyle(container).display,overflow:getComputedStyle(messages).overflowY}})()`, pet!);
      assert(transcriptLayout.viewport.height > 0 && transcriptLayout.viewport.top >= transcriptLayout.parent.top - 1 && transcriptLayout.viewport.bottom <= transcriptLayout.parent.bottom + 1, 'Combined voice and history keep the visible transcript viewport inside its own panel');
      assert(transcriptLayout.scrollHeight > transcriptLayout.clientHeight && transcriptLayout.scrollTop > 0, 'Long conversation content remains reachable by scrolling inside the bounded panel');
      assert(['auto', 'scroll'].includes(transcriptLayout.overflow), 'The constrained transcript has an actual scrolling viewport');
      metrics['combined_transcript_layout_' + protocol] = transcriptLayout;

      const created = realtimeProvider.messages.find(value => value.type === 'fixture.sdp')!;
      assertEqual(created.session.model, 'fixture-' + protocol + '-model', 'The explicitly configured audio model reaches call creation');
      assertEqual(created.session.audio.output.voice, 'cove', 'The configured voice reaches the initial media session');
      assert(!realtimeProvider.messages.some(value => value.type === 'session.update'), 'Existing media sideband never overwrites its already configured session');
      assert(realtimeProvider.requests.some(value => value.method === 'POST' && value.path.includes('intent=quicksilver') && value.path.includes('architecture=avas')), 'Backend call creation sends its actual transport query');
      assert(realtimeProvider.requests.some(value => value.method === 'GET' && value.sessionId && value.path.includes(protocol === 'v1' ? '/realtime?' : '/live/')), 'Sideband attaches with the owned session header');
      assert(realtimeProvider.requests.every(value => value.sessionId && value.alpha === (protocol === 'v1' ? 'quicksilver=v1' : 'quicksilver=v2')), 'Call creation and sideband retain the selected protocol headers');
      const initialContextExports = () => {
        const prefix = 'Current conversation context (reference data):\n';
        const instructions = typeof created.session?.instructions === 'string' ? created.session.instructions : '';
        const sideband = realtimeProvider.messages.flatMap(value => protocol === 'v1'
          ? value.type === 'conversation.item.create' && value.item?.role === 'developer' ? value.item.content || [] : []
          : value.type === 'session.context.append' ? value.content || [] : [])
          .flatMap((part: any) => part.type === 'input_text' && typeof part.text === 'string' ? [part.text] : []).join('');
        return [instructions, sideband].flatMap(text => { const offset = text.indexOf(prefix); return offset < 0 ? [] : [text.slice(offset)]; });
      };
      await waitFor(() => initialContextExports().some(text => text.includes(contextPrompt)), 5000, 'The selected confirmed task context reaches the actual configured media call');
      const initialContext = initialContextExports().find(text => text.includes(contextPrompt))!;
      assert(Buffer.byteLength(initialContext, 'utf8') <= 16 * 1024, 'The selected context export retains its actual UTF-8 byte bound');
      for (const foreign of ['PET_CASE_STREAM_HOLD', 'PET_CASE_RETAIN_', 'PET_CASE_APPROVAL', 'PET_CASE_QUESTION', 'PET_CASE_MINI_HOLD', 'PET_CASE_VOICE_TASK', 'PET_CASE_SELECTED_' + (protocol === 'v1' ? 'FRAMELESS' : 'V1')]) assert(!initialContext.includes(foreign), 'Initial voice context excludes other conversations: ' + foreign);
      if (protocol === 'frameless') assert(realtimeProvider.messages.filter(value => value.type === 'session.context.append').every(value => value.content.every((part: any) => part.type === 'input_text' && Buffer.byteLength(part.text, 'utf8') <= 500)), 'Frameless initial context preserves bounded text chunks');
      await evaluate(`window.__voiceEvent({type:'response.output_audio_transcript.delta',item_id:'peer-decoy',delta:'UNTRUSTED_PEER_CAPTION'})`, voicePeer!);
      if (protocol === 'v1') {
        await realtimeProvider.emit({ type: 'conversation.input_transcript.delta', item_id: 'hosted-user-v1', delta: prompt }, false);
        await realtimeProvider.emit({ type: 'conversation.input_transcript.turn_marked', item_id: 'hosted-user-v1', transcript: prompt }, false);
        await realtimeProvider.emit({ type: 'conversation.handoff.requested', handoff_id: 'hosted-handoff-v1', item_id: 'hosted-user-v1', input_transcript: prompt }, false);
      } else {
        await realtimeProvider.emit({ type: 'input_transcript.added', item: { id: 'hosted-user-frameless', text: prompt } }, false);
        await realtimeProvider.emit({ type: 'turn.done', turn: { id: 'hosted-user-frameless', role: 'user', transcript: prompt } }, false);
        await realtimeProvider.emit({ type: 'delegation.created', item: { id: 'hosted-handoff-frameless', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: prompt }] } }, false);
      }
      await waitFor(() => evaluate('Boolean(document.querySelector("[data-voice-interrupt=task]"))', pet!), 5000, 'Only actual voice-owned work exposes the task stop control');
      const resultText = (value: Record<string, any>) => protocol === 'v1' && value.type === 'conversation.handoff.append' && value.handoff_id === 'hosted-handoff-v1' ? value.output_text : protocol === 'frameless' && value.type === 'delegation.context.append' && value.delegation_item_id === 'hosted-handoff-frameless' ? value.content?.map((part: any) => part.text || '').join('') : '';
      await waitFor(() => realtimeProvider.messages.some(value => String(resultText(value)).includes('COMPANION_RESPONSE_COMPLETE')), 30000, 'Protocol handoff returns an actual verified task result');
      await waitFor(() => evaluate('!document.querySelector("[data-voice-interrupt=task]")', pet!), 5000, 'Completed owned work removes its task stop action');
      const stopPrompt = prompt.replace(/_TASK$/u, '_HOLD');
      if (protocol === 'v1') {
        await realtimeProvider.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hosted-user-v1-stop', transcript: stopPrompt }, false);
        await realtimeProvider.emit({ type: 'conversation.handoff.requested', handoff_id: 'hosted-handoff-v1-stop', item_id: 'hosted-user-v1-stop', input_transcript: stopPrompt }, false);
      } else {
        await realtimeProvider.emit({ type: 'turn.done', turn: { id: 'hosted-user-frameless-stop', role: 'user', transcript: stopPrompt } }, false);
        await realtimeProvider.emit({ type: 'delegation.created', item: { id: 'hosted-handoff-frameless-stop', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: stopPrompt }] } }, false);
      }
      await waitFor(() => provider!.phase(stopPrompt) === 'streaming', 20000, 'The owned task reaches the actual model stream before interruption');
      await waitFor(() => evaluate('Boolean(document.querySelector("[data-voice-interrupt=task]"))', pet!), 5000, 'The held voice-owned task exposes its real cancellation action');
      await click('[data-voice-interrupt=task]');
      await waitFor(() => provider!.phase(stopPrompt) === 'cancelled', 10000, 'Task stop cancels the real owned model stream');
      await waitFor(() => evaluate('!document.querySelector("[data-voice-interrupt=task]")', pet!), 5000, 'A confirmed cancellation retires only the matching task action');
      const continuing = await invoke('desktop-pet:realtime-state', undefined, pet!);
      assertEqual(continuing.phase, 'active', 'Stopping owned work preserves the live audio call');
      assertEqual(continuing.sessionId, active.sessionId, 'Task cancellation never retargets the voice conversation');
      assert(!realtimeProvider.messages.some(value => value.type === 'response.cancel'), 'Hosted task cancellation sends no unsupported source control frame');
      assert(!await evaluate('window.__voicePeer.received.some(value=>value.type==="output_audio_buffer.clear")', voicePeer!), 'Hosted task stop never advertises an unsupported audio cancellation wire');
      const prefix = 'The hosted task is ', final = prefix + 'complete.';
      await realtimeProvider.emit(protocol === 'v1' ? { type: 'conversation.output_transcript.delta', item_id: 'hosted-assistant-v1', delta: prefix } : { type: 'output_transcript.added', item: { id: 'hosted-assistant-frameless', text: prefix } }, false);
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.pet-voice-message.partial p')).some(node=>node.textContent===${JSON.stringify(prefix)})`, pet!), 5000, 'Host-owned partial captions render while speech is still streaming');
      await realtimeProvider.emit(protocol === 'v1' ? { type: 'response.output_audio_transcript.done', item_id: 'hosted-assistant-v1', transcript: final } : { type: 'turn.done', turn: { id: 'hosted-assistant-frameless', role: 'assistant', transcript: final } }, false);
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.pet-voice-message.final p')).filter(node=>node.textContent===${JSON.stringify(final)}).length===1`, pet!), 5000, 'The host final replaces the live caption exactly once');
      assert(!await evaluate('document.querySelector(".pet-voice-transcript").textContent.includes("UNTRUSTED_PEER_CAPTION")', pet!), 'Peer data cannot duplicate or overwrite engine-owned captions');
      await waitFor(() => evaluate('(async()=>{for(const peer of window.__voiceMedia.peers.filter(peer=>peer.connectionState==="connected"))for(const value of (await peer.getStats()).values())if(value.type==="inbound-rtp"&&value.packetsReceived>0)return true;return false})()', pet!), 10000, 'Configured hosted protocol still carries actual RTP media');
      if (protocol === 'v1') await realtimeProvider.emit({ type: 'response.output_audio_transcript.delta', item_id: 'hosted-tail-v1', delta: 'The final hosted tail was preserved.' }, false);
      await click('.pet-voice-actions button.danger');
      await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'inactive', 15000, 'Hosted shutdown drains its actual sideband');
      await waitFor(() => realtimeProvider.ended(), 5000, 'Hosted provider sideband closes');
      assert(!realtimeProvider.requests.some(value => value.path.endsWith('/hangup')), 'Hosted shutdown never invents an HTTP hangup endpoint');
      if (protocol === 'frameless') assert(realtimeProvider.messages.some(value => value.type === 'session.close'), 'Frameless shutdown sends its explicit session close');
      await waitFor(() => evaluate('document.querySelector(".pet-voice-transcript")?.textContent.includes("The final hosted tail was preserved.") === true', pet!), 5000, 'Host transcript tail remains visible after shutdown');
      await waitFor(() => evaluate('window.__voiceMedia.peers.every(peer=>peer.connectionState==="closed") && window.__voiceMedia.streams.every(stream=>stream.getTracks().every(track=>track.readyState==="ended"))', pet!), 5000, 'Hosted browser media and peer resources close');
      const history = JSON.stringify(await runtime!.sessions.history(active.sessionId));
      assert(history.includes(prompt) && history.includes(final) && history.includes('The final hosted tail was preserved.'), 'Confirmed hosted speech and the final tail are durable through the real facade');
      assert(!realtimeProvider.messages.some(value => value.type === 'fixture.error'), 'The strict protocol endpoint accepted the complete call lifecycle');
      metrics['realtime_' + protocol] = { sessionId: active.sessionId, protocol, providerMessages: realtimeProvider.messages.length, requests: realtimeProvider.requests.map(({ authorization: _authorization, ...value }) => value), virtualMicrophone: true };
    });

    for (const protocol of ['v1', 'frameless'] as const) await scenario(`${protocol} spoken handoff steers the same typed turn and ending voice leaves that borrowed task running`, async () => {
      const realtimeProvider = await setupVoiceProvider(protocol), sourceId = 'voice-borrowed-' + protocol;
      await invoke('settings:models:upsert', { id: sourceId, name: 'Local borrowed task ' + protocol, provider: 'openai', model: 'fixture-text-model', baseUrl: realtimeProvider.url + realtimeProvider.basePath, apiKey: 'local-realtime-fixture-key', realtime: { protocol, model: 'fixture-' + protocol + '-model', voice: 'cove', transcriptionModel: 'fixture-transcription-model' }, maxContextTokens: 200000, isDefault: false });
      await invoke('settings:kv:set', { key: 'desktop_pet.realtime_provider', value: sourceId });
      const eventCut = events.length, typedPrompt = 'PET_CASE_TYPED_' + protocol.toUpperCase() + '_HOLD', sessionId = await send(typedPrompt);
      await waitFor(() => provider!.phase(typedPrompt) === 'streaming', 20000, 'A genuine typed task reaches its held model stream');
      await waitFor(async () => (await task(sessionId))?.status === 'running', 5000, 'The typed foreground is actually running before voice attaches');
      await invoke('desktop-pet:select-conversation', { sessionId }, pet!);
      await waitFor(async () => (await conversation()).sessionId === sessionId && (await conversation()).running, 5000, 'Mini selects the same running typed conversation');
      if (!await evaluate('Boolean(document.querySelector(".pet-voice-panel"))', pet!)) await click('.pet-voice');
      await waitFor(() => evaluate('Boolean(document.querySelector(".pet-voice-actions button.primary:not(:disabled)"))', pet!), 10000, 'The selected typed conversation can start its real voice transport');
      await click('.pet-voice-actions button.primary');
      await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'active', 20000, 'Actual voice media attaches to the existing typed conversation');
      const active = await invoke('desktop-pet:realtime-state', undefined, pet!);
      assertEqual(active.sessionId, sessionId, 'Voice is scoped to the selected typed conversation');
      const products = (method: string): Array<Record<string, any>> => events.slice(eventCut).flatMap((raw: any) => raw?.type === 'productEvent' && raw.method === method && raw.params && typeof raw.params === 'object' ? [raw.params] : []);
      const callId = realtimeProvider.messages.find(value => value.type === 'fixture.sdp')?.callId;
      assert(typeof callId === 'string', 'The real media negotiation provides its call identity');
      const started = products('session/realtimeEvent').find(value => value.event?.type === 'started' && value.event.callId === callId);
      assert(started && typeof started.sessionId === 'string' && typeof started.requestId === 'string', 'The real engine confirms this exact negotiated call');
      const admissions = () => products('turn/started').filter(value => value.sessionId === started.sessionId).map(value => value.submissionId).filter((value): value is string => typeof value === 'string');
      const originalAdmissions = [...new Set(admissions())];
      assertEqual(originalAdmissions.length, 1, 'Exactly one logical typed turn was admitted before the spoken handoff');
      const originalTurnId = originalAdmissions[0]!, handoffId = 'borrowed-handoff-' + protocol;
      const originalCoreTurnId = products('turn/started').find(value => value.sessionId === started.sessionId && value.submissionId === originalTurnId)?.detail?.turnId;
      assert(typeof originalCoreTurnId === 'string' && originalCoreTurnId.length > 0, 'The original typed admission identifies its exact active core turn');
      const voiceNote = 'For ' + typedPrompt + ', retain this spoken context: voice-note-' + protocol;
      if (protocol === 'v1') {
        await realtimeProvider.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'borrowed-user-v1', transcript: voiceNote }, false);
        await realtimeProvider.emit({ type: 'conversation.handoff.requested', handoff_id: handoffId, item_id: 'borrowed-user-v1', input_transcript: voiceNote }, false);
      } else {
        await realtimeProvider.emit({ type: 'turn.done', turn: { id: 'borrowed-user-frameless', role: 'user', transcript: voiceNote } }, false);
        await realtimeProvider.emit({ type: 'delegation.created', item: { id: handoffId, type: 'delegation', target: 'client', content: [{ type: 'input_text', text: voiceNote }] } }, false);
      }
      const queued = () => products('session/realtimeEvent').filter(value => value.sessionId === started.sessionId && value.requestId === started.requestId).map(value => value.event).find(value => value?.type === 'task.queued' && value.handoffId === handoffId);
      await waitFor(() => Boolean(queued()), 10000, 'The actual engine accepts the spoken context into its authoritative queue');
      const rawEnvelopes = (): Array<Record<string, any>> => events.slice(eventCut).flatMap((raw: any) => raw?.type === 'rawSessionEvent' && raw.params?.sessionId === started.sessionId && raw.params.event && typeof raw.params.event === 'object' ? [raw.params.event] : []);
      const acceptedContext = rawEnvelopes().flatMap(value => value.queueSnapshot?.items || []).find((value: any) => value.state === 'pending' && value.message?.displayMetadata?.source === 'realtime' && value.message.displayMetadata.requestId === started.requestId && value.message.displayMetadata.callId === handoffId && value.message.displayMetadata.expectedTurnId === originalTurnId)?.message;
      assert(typeof acceptedContext?.uuid === 'string', 'The authoritative queued context identifies this exact call and original typed admission');
      assertEqual(queued().owned, false, 'Voice borrows the typed task instead of taking cancellation ownership');
      assertEqual(queued().turnId, originalTurnId, 'The spoken handoff keeps the exact original typed turn admission');
      assertEqual([...new Set(admissions())].length, 1, 'Steering creates no second logical task admission');
      assertEqual((await invoke('desktop-pet:realtime-state', undefined, pet!)).canInterrupt, false, 'The host does not advertise cancellation of borrowed work');
      assert(!await evaluate('Boolean(document.querySelector("[data-voice-interrupt=task]"))', pet!), 'The UI never offers stopping the independently owned typed task');
      let rejected = false;
      try { await invoke('desktop-pet:realtime-control', { requestId: started.requestId, generation: active.generation, action: 'interrupt' }, pet!); } catch { rejected = true; }
      assert(rejected, 'Even a stale direct companion control cannot cancel borrowed typed work');
      await click('.pet-voice-actions button.danger');
      await waitFor(async () => (await invoke('desktop-pet:realtime-state', undefined, pet!)).phase === 'inactive', 15000, 'Voice finalization detaches its media and context waiters');
      await waitFor(() => realtimeProvider.ended(), 5000, 'The hosted sideband closes without owning the typed foreground');
      assertEqual((await task(sessionId))?.status, 'running', 'Ending voice leaves the original typed task running');
      const pending = await runtime!.sessions.followHistory(sessionId) as any;
      metrics['realtime_borrowed_pending_' + protocol] = { originalTurnId, originalCoreTurnId, turnStatuses: pending.turnStatuses };
      assertEqual(pending.turnStatuses?.[originalCoreTurnId], 'running', 'The real facade still reports the exact original core turn running after voice ends');
      assertEqual([...new Set(admissions())].length, 1, 'Voice teardown admits no replacement ordinary task');
      assertEqual(provider!.phase(typedPrompt), 'streaming', 'The controlled typed model stream remains live after voice teardown');
      provider!.release(typedPrompt);
      await completed(sessionId);
      const finalHistory = await runtime!.sessions.followHistory(sessionId) as any;
      const history = JSON.stringify(finalHistory);
      assert(history.includes(typedPrompt) && history.includes(voiceNote) && history.includes('COMPANION_RESPONSE_COMPLETE'), 'Original typed input, confirmed voice context and normal completion remain durable');
      assert(provider!.requests.some(body => JSON.stringify(body.messages).includes(voiceNote)), 'The actual ordinary model request receives the spoken context');
      const continuations = [...new Set(admissions())].filter(id => id !== originalTurnId);
      const resumed = new Set(rawEnvelopes().filter(value => value.pendingResume?.started === true && typeof value.submissionId === 'string').map(value => value.submissionId));
      assert(continuations.length <= 1, 'One queued spoken input admits at most one ordinary continuation after the typed owner completes');
      assert(continuations.every(id => resumed.has(id)) && resumed.size === continuations.length, 'Every later admission has its actual ordinary pending-resume receipt');
      const applied = rawEnvelopes().filter(value => value.steered?.applied === true && typeof value.submissionId === 'string' && value.submissionId.startsWith('realtime-context:'));
      assertEqual(applied.length, 1, 'The queued spoken context is consumed exactly once');
      const queueSnapshots = rawEnvelopes().map(value => value.queueSnapshot).filter(value => value?.status === 'authoritative');
      assertEqual(queueSnapshots.at(-1)?.items?.length, 0, 'The authoritative engine queue is drained after the spoken context is consumed');
      if (continuations.length) {
        const continuedCoreTurn = products('turn/started').find(value => value.sessionId === started.sessionId && value.submissionId === continuations[0])?.detail?.turnId;
        assert(typeof continuedCoreTurn === 'string' && continuedCoreTurn.length > 0, 'The ordinary pending-resume receipt identifies its actual core turn');
        const delivered = finalHistory.messages?.filter((value: any) => value.uuid === acceptedContext.uuid) || [];
        assertEqual(delivered.length, 1, 'The ordinary continuation preserves the exact accepted queue message identity');
        assertEqual(delivered[0].turnId, continuedCoreTurn, 'The accepted original-owner context belongs to the acknowledged continuation core turn');
      }
      assert(!realtimeProvider.messages.some(value => value.type === 'fixture.error' || value.type === 'response.cancel'), 'Borrowed teardown uses no unsupported hosted cancellation frame');
      await waitFor(() => evaluate('window.__voiceMedia.peers.every(peer=>peer.connectionState==="closed") && window.__voiceMedia.streams.every(stream=>stream.getTracks().every(track=>track.readyState==="ended"))', pet!), 5000, 'Borrowed task teardown closes only the browser call resources');
      metrics['realtime_borrowed_' + protocol] = { sessionId, originalTurnId, handoffId, owned: queued().owned, voiceEndedBeforeTypedCompletion: true };
    });

    await scenario('locale updates refresh existing cards once and shutdown persists terminal activity without live requests', async () => {
      await invoke('settings:kv:set', { key: 'language', value: 'zh' });
      assertEqual((await state()).settings.language, 'zh', 'Companion language follows the actual settings mutation');
      await invoke('desktop-pet:update-settings', { size: 128 });
      await invoke('desktop-pet:hide');
      await waitFor(() => !pet!.isVisible(), 5000, 'Hidden overlay releases native visibility');
      await invoke('desktop-pet:show');
      await waitFor(() => pet!.isVisible(), 5000, 'Companion reopens after hide');
      await waitFor(() => pet!.getOpacity() === 1, 5000, 'Reopened companion finishes its presentation before capture');
      assertEqual(runtime!.engine.liveProcessCount(), 1, 'Exactly one Rust child owns all production interactions');
      await diagnostics();
      const engine = runtime!.engine;
      await runtime!.shutdown(); runtime = undefined;
      assertEqual(engine.liveProcessCount(), 0, 'Shutdown drains the production engine child');
      const persisted = JSON.parse(readFileSync(join(root, 'pet-activity.json'), 'utf8'));
      assert(persisted.length >= 16 && persisted.every((row: any) => ['completed', 'failed'].includes(row.status) && !row.attention), 'Only validated terminal notifications survive shutdown');
      const settings = JSON.parse(readFileSync(join(root, 'desktop-pet.json'), 'utf8'));
      metrics.persistedSettings = settings;
      assert(existsSync(join(root, 'pet-activity.json')), 'Terminal activity has durable evidence');
    });
  } catch (error) { await scenario('production companion fixture setup', () => { throw error; }); }
  finally {
    provider?.release();
    await diagnostics('final').catch(error => h.info('diagnostics', String(error)));
    try { await runtime?.shutdown(); } catch (error) { await scenario('production runtime shutdown', () => { throw error; }); }
    await provider?.close();
    await voiceProvider?.close();
    if (voicePeer && !voicePeer.isDestroyed()) voicePeer.destroy();
    writeFileSync(join(logs, 'metrics.json'), JSON.stringify(metrics, null, 2));
    const exit = await h.finish(join(logs, 'results.json'), 'desktop-pet-app');
    app.exit(exit);
  }
})();
