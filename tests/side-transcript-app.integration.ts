import { app } from 'electron';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import { startComposerLifecycleProvider } from './fixtures/composer-lifecycle-provider';
import { waitFor, assert } from './harness';

const root = process.env.KLAUS_SIDE_TRANSCRIPT_PROFILE!;
const logs = process.env.KLAUS_SIDE_TRANSCRIPT_LOGS!;
if (!root || !logs) throw Error('An isolated profile and evidence directory are required');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
app.setPath('userData', join(root, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const contract = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/session-transcript-surface-vectors.json'), 'utf8'));
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startComposerLifecycleProvider>> | undefined;
const sideIds: string[] = [];
let checks = 0;
const evaluate = <T = any>(script: string): Promise<T> => runtime!.window.webContents.executeJavaScript(script);
const invoke = (channel: string, payload: unknown) => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: [payload] })})`);
function record(file: string, value: unknown) { appendFileSync(join(logs, file), JSON.stringify(value) + '\n'); }
function check(ok: unknown, label: string) { assert(Boolean(ok), label); checks++; console.log('PASS ' + label); }
async function input(selector: string, text: string) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await runtime!.window.webContents.insertText(text);
}
async function enter(invert = false) {
  const modifiers: Array<'meta' | 'control'> = invert ? [process.platform === 'darwin' ? 'meta' : 'control'] : [];
  for (const type of ['keyDown', 'keyUp'] as const) runtime!.window.webContents.sendInputEvent({ type, keyCode: 'Return', modifiers });
  await pause();
}
async function running(id: string, prefix: string, pane: 'left' | 'right') {
  const value = await evaluate(`(()=>{const s=window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}];
    const b=document.getElementById('${prefix}send'),i=document.getElementById('${prefix}input');return {
      id:${JSON.stringify(id)},running:s?.running,terminal:s?.lastTerminalStatus,turn:s?.activeTurnId,
      bound:window.klausSideSurfaceSessionId(${JSON.stringify(pane)}),busy:b.classList.contains('busy'),
      disabled:b.disabled,empty:!i.value.trim(),stop:getComputedStyle(b.querySelector('.icon-stop')).display}})()`);
  record('runtime.jsonl', value);
  check(value.running && value.bound === id && value.empty && value.busy && !value.disabled && value.stop !== 'none', pane + ': a running turn owns an enabled Stop button');
}
async function visible(id: string, prefix: string, text: string) {
  const measure = () => evaluate(`(()=>{const slot=document.querySelector('[data-sideid="${id}"]');
    const v=document.getElementById('${prefix}messages'),vr=v.getBoundingClientRect();
    const rows=[...slot.querySelectorAll('.msg-group.user')].filter(e=>e.textContent.includes(${JSON.stringify(text)}));
    return {text:${JSON.stringify(text)},scrollTop:v.scrollTop,scrollHeight:v.scrollHeight,viewport:{top:vr.top,bottom:vr.bottom},
      rows:rows.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,visible:r.bottom>vr.top&&r.top<vr.bottom&&r.height>0}})}})()`);
  let value = await measure();
  try {
    await waitFor(async () => { value = await measure(); return value.rows.length === 1 && value.rows[0].visible; }, 2500, text + ': submitted bubble enters the viewport');
  } finally { record('geometry.jsonl', value); }
  check(value.rows.length === 1 && value.rows[0].visible, text + ': exactly one submitted bubble is visible before the held response finishes');
}
async function nearLatest(prefix: string) {
  await evaluate(`document.getElementById('${prefix}scroll-to-bottom').click()`);
  await pause(400);
  const distance = contract.presentation.newMessagePlacementMaxDistancePx - 20;
  const point = await evaluate(`(()=>{const r=document.getElementById('${prefix}messages').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  const debuggerApi = runtime!.window.webContents.debugger;
  debuggerApi.attach('1.3');
  try { await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -distance, deltaX: 0 }); }
  finally { debuggerApi.detach(); }
  await pause(200);
  const actual = await evaluate(`(()=>{const e=document.getElementById('${prefix}messages');return e.scrollHeight-e.clientHeight-e.scrollTop})()`);
  record('scroll.jsonl', { prefix, requested: distance, actual });
  check(actual > 24 && actual <= contract.presentation.newMessagePlacementMaxDistancePx, prefix + 'reader is near, but not pinned to, the latest content');
}

void (async () => {
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:queue-fixture', 'composer.thinking_level': 'off', follow_up_queue_mode: 'queue', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(key, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1');
    // Unique bounded paragraphs exercise a long real transcript without triggering repetition protection.
    const responseText = Array.from({ length: 32 }, (_, paragraph) => `Paragraph ${paragraph + 1}. ` + Array.from({ length: 40 }, (_, word) => createHash('sha256').update(`${paragraph}:${word}`).digest('hex').slice(0, 10)).join(' ')).join('\n\n');
    provider = await startComposerLifecycleProvider({ responseText });
    process.env.KLAUS_SERVER_URL = provider.url;
    mkdirSync(join(root, 'external-home'), { recursive: true });
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: join(root, 'external-home') });
    runtime.window.setContentSize(1400, 950);
    runtime.window.webContents.on('console-message', event => record('renderer.jsonl', { message: event.message }));
    runtime.engine.on('event', event => record('engine-events.jsonl', event));
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.queue-fixture', mergeStrategy: 'replace', value: { name: 'Local fixture', provider: 'anthropic', model: 'queue-fixture-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true } } }] });
    await runtime.sessions.request('model/credential/write', { id: 'queue-fixture', apiKey: 'local-fixture-key' });
    await waitFor(() => evaluate('Boolean(window.klaus?.chat&&window.klausSwitchSession&&window.__klausChatStreamStore)&&document.getElementById("boot-screen")?.style.display==="none"'), 30000, 'Production renderer boot');
    const parent = String((await invoke('session:new', { workdir: root })).id);
    await evaluate(`window.klausSwitchSession(${JSON.stringify(parent)})`);
    await input('#input', 'SIDE_TRANSCRIPT_PARENT');
    await evaluate('document.getElementById("send").click()');
    await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(parent)}]?.history?.some(r=>r.role==='assistant')&&!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(parent)}]?.running`), 30000, 'Parent turn complete');
    const other = String((await invoke('session:new', { workdir: root })).id);
    await evaluate(`window.klausSwitchSession(${JSON.stringify(other)})`);
    await input('#input', 'INDEPENDENT_MAIN_BASELINE');
    await evaluate('document.getElementById("send").click()');
    await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(other)}]?.history?.some(r=>r.role==='assistant')&&!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(other)}]?.running`), 30000, 'Independent main conversation initialized');
    await evaluate(`window.klausSwitchSession(${JSON.stringify(parent)})`);
    for (const pane of ['right', 'left'] as const) {
      const prefix = pane === 'right' ? 'side-' : 'left-side-';
      await evaluate(`window.KlausSideTasks.refresh(${JSON.stringify(parent)})`);
      await waitFor(() => evaluate('window.KlausSideTasks.canCreate()'), 15000, 'Side creation entry available');
      const id = await evaluate<string>('window.KlausSideTasks.create()');
      check(id, pane + ': production rail creates a real side conversation');
      sideIds.push(id);
      await evaluate(`window.KlausSideTasks.moveTo(${JSON.stringify(id)},${JSON.stringify(pane)})`);
      const first = `${pane.toUpperCase()}_FIRST_MESSAGE`, second = `${pane.toUpperCase()}_SECOND_MESSAGE`;
      let entered = provider.entered(); provider.holdNext(true);
      await input('#' + prefix + 'input', first); await enter();
      await waitFor(() => provider!.entered() === entered + 1, 30000, 'First side request reaches the held provider');
      await running(id, prefix, pane); await visible(id, prefix, first);
      provider.release();
      await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.lastTerminalStatus==='completed'&&!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.running`), 20000, 'Long answer completes normally');
      check(true, pane + ': the long answer completes without failure or interruption');
      await nearLatest(prefix);
      entered = provider.entered(); provider.holdNext(true);
      await input('#' + prefix + 'input', second); await enter();
      await waitFor(() => provider!.entered() === entered + 1, 15000, 'Second side turn reaches the held provider');
      await running(id, prefix, pane); await visible(id, prefix, second);
      await evaluate(`window.openArtifactsPanel('monitor')`);
      await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(id)})`);
      await running(id, prefix, pane); await visible(id, prefix, second);
      await evaluate(`window.klausSwitchSession(${JSON.stringify(other)})`);
      await evaluate(`window.klausSwitchSession(${JSON.stringify(parent)})`);
      await waitFor(() => evaluate(`window.klausSideSurfaceSessionId(${JSON.stringify(pane)})===${JSON.stringify(id)}`), 15000, 'Main navigation restores the side owner');
      await running(id, prefix, pane); await visible(id, prefix, second);
      const steer = `${pane.toUpperCase()}_RUNNING_STEER`;
      await input('#' + prefix + 'input', steer); await enter(true);
      await visible(id, prefix, steer); await running(id, prefix, pane);
      const queued = `${pane.toUpperCase()}_QUEUED_INPUT`;
      await input('#' + prefix + 'input', queued); await enter();
      await waitFor(() => evaluate(`document.getElementById('${prefix}follow-up-queue').textContent.includes(${JSON.stringify(queued)})`), 2500, 'Queued input appears immediately in its owning composer');
      await waitFor(() => evaluate(`Boolean(document.querySelector('#${prefix}follow-up-queue .follow-up-queue-slot[data-state="settled"]'))`), 2500, 'The queue entrance settles');
      await evaluate(`Promise.all(document.getElementById('${prefix}follow-up-queue').getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))`);
      const queue = await evaluate(`(()=>{const e=document.querySelector('#${prefix}follow-up-queue .follow-up-queue-preview'),r=e.getBoundingClientRect();
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),slot=e.closest('.follow-up-queue-slot');
        return {height:r.height,rect:r.toJSON(),display:getComputedStyle(e).display,text:e.textContent,
          hit:hit?.outerHTML.slice(0,250),unobscured:!!hit&&(hit===slot||slot.contains(hit))}})()`);
      record('queue.jsonl', { pane, ...queue });
      check(queue.height > 0 && queue.display !== 'none' && queue.unobscured, pane + ': queued input is visible and unobscured before completion');
      check(await evaluate(`![...document.querySelectorAll('[data-sideid="${id}"] .msg-group.user')].some(e=>e.textContent.includes(${JSON.stringify(queued)}))`), pane + ': undispatched queued input is not duplicated in the transcript');
      await running(id, prefix, pane);
      writeFileSync(join(logs, pane + '.png'), (await runtime.window.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById('${prefix}send').click()`);
      await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.lastTerminalStatus==='interrupted'`), 15000, 'Stop reaches the actual engine');
      provider.release();
      check(true, pane + ': Stop reaches the real engine terminal event');
    }
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(`Side transcript: ${checks} checks passed across both panes.`);
  } catch (error) {
    console.error(error);
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2));
    process.exitCode = 1;
  } finally {
    for (const sessionId of sideIds) if (runtime) await invoke('chat:interrupt', { sessionId }).catch(() => {});
    provider?.release();
    await runtime?.shutdown();
    await provider?.close();
    app.exit(Number(process.exitCode) || 0);
  }
})();
