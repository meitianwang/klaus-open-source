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
let checks = 0, mechanismChecks = 0;
const mechanismStages = new Set<string>();
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
    const v=slot,vr=v.getBoundingClientRect();
    const rows=[...slot.querySelectorAll('.msg-group.user')].filter(e=>e.textContent.includes(${JSON.stringify(text)}));
    return {text:${JSON.stringify(text)},scrollTop:v.scrollTop,scrollHeight:v.scrollHeight,viewport:{top:vr.top,bottom:vr.bottom},
      rows:rows.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,visible:r.bottom>vr.top&&r.top<vr.bottom&&r.height>0}})}})()`);
  let value = await measure();
  try {
    await waitFor(async () => { value = await measure(); return value.rows.length === 1 && value.rows[0].visible; }, 2500, text + ': submitted bubble enters the viewport');
  } finally { record('geometry.jsonl', value); }
  check(value.rows.length === 1 && value.rows[0].visible, text + ': exactly one submitted bubble is visible before the held response finishes');
}
async function nearLatest(id: string, prefix: string) {
  await evaluate(`document.getElementById('${prefix}scroll-to-bottom').click()`);
  await pause(400);
  const distance = contract.presentation.newMessagePlacementMaxDistancePx - 20;
  const point = await evaluate(`(()=>{const r=document.querySelector('[data-sideid="${id}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  const debuggerApi = runtime!.window.webContents.debugger;
  debuggerApi.attach('1.3');
  try { await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -distance, deltaX: 0 }); }
  finally { debuggerApi.detach(); }
  await pause(200);
  const actual = await evaluate(`(()=>{const e=document.querySelector('[data-sideid="${id}"]');return e.scrollHeight-e.clientHeight-e.scrollTop})()`);
  record('scroll.jsonl', { prefix, requested: distance, actual });
  check(actual > 24 && actual <= contract.presentation.newMessagePlacementMaxDistancePx, prefix + 'reader is near, but not pinned to, the latest content');
}

function mechanism(ok: unknown, label: string) {
  assert(Boolean(ok), label);
  mechanismChecks++;
  console.log('PASS mechanism: ' + label);
}

type Pane = 'left' | 'right';
const panePrefix = (pane: Pane) => pane === 'left' ? 'left-side-' : 'side-';

/** Capture real store data and real DOM identities, without reconstructing UI state. */
async function mechanismSnapshot(id: string, pane: Pane, text: string, stage: string) {
  const prefix = panePrefix(pane);
  const value = await evaluate(`(()=>{
    const id=${JSON.stringify(id)},text=${JSON.stringify(text)},prefix=${JSON.stringify(prefix)};
    const input=document.getElementById(prefix+'input'),button=document.getElementById(prefix+'send');
    const slot=document.querySelector('[data-sideid="'+id+'"]');
    const outer=document.getElementById(prefix+'messages');
    const state=window.__klausChatStreamStore.getState().sessions[id];
    const probes=window.__sideMechanismProbes ||= {};
    const probe=probes[id] ||= {input,root:input.closest('[data-side-pane]'),slot,rows:new Map()};
    const users=[...(state?.history||[]),...(state?.liveUnits||[]).filter(u=>u.type==='live-user').map(u=>u.msg)];
    const identity=message=>message?.clientMessageId||message?.localRender?.clientMessageId||message?.uuid;
    const identities=new Map(users.map(message=>[message.uuid,identity(message)]));
    const rows=[...slot.querySelectorAll('.msg-group.user')].filter(row=>row.textContent.includes(text)).map(row=>{
      const rect=row.getBoundingClientRect(),viewport=slot.getBoundingClientRect();
      const key=identities.get(row.dataset.uuid)||row.dataset.uuid;
      const sameNode=!probe.rows.has(key)||probe.rows.get(key)===row;
      if(!probe.rows.has(key))probe.rows.set(key,row);
      return {uuid:row.dataset.uuid,identity:key,sameNode,rect:rect.toJSON(),
        visible:rect.height>0&&rect.bottom>viewport.top&&rect.top<viewport.bottom};
    });
    return {stage:${JSON.stringify(stage)},id,pane:${JSON.stringify(pane)},text,
      bound:window.klausSideSurfaceSessionId(${JSON.stringify(pane)}),
      input:{value:input.value,start:input.selectionStart,end:input.selectionEnd,
        sameNode:input===probe.input,sameRoot:input.closest('[data-side-pane]')===probe.root},
      button:{label:button.getAttribute('aria-label'),busy:button.classList.contains('busy'),
        runningSubmit:button.classList.contains('running-submit'),disabled:button.disabled,
        stopDisplay:getComputedStyle(button.querySelector('.icon-stop')).display},
      surface:{sameNode:slot===probe.slot,overflowY:getComputedStyle(slot).overflowY,
        overflowX:getComputedStyle(slot).overflowX,outerOverflow:getComputedStyle(outer).overflow,
        clientHeight:slot.clientHeight,scrollHeight:slot.scrollHeight,scrollTop:slot.scrollTop},
      rows,users:users.filter(message=>(message?.localRender?.displayText||message?.text||'')===text)
        .map(message=>({uuid:message.uuid,clientMessageId:identity(message),turnId:message.turnId})),
      runtime:JSON.parse(JSON.stringify(state||{})),
      admission:window.__sideAdmission?{entered:window.__sideAdmission.entered,forwarded:window.__sideAdmission.forwarded,
        hostReplied:window.__sideAdmission.hostReplied}:null};
  })()`);
  record('mechanism-state.jsonl', value);
  return value;
}

function ownedRunning(value: any, count: number, stage: string) {
  mechanism(value.bound === value.id && value.runtime.running === true, stage + ': runtime belongs to the displayed conversation');
  mechanism(value.input.value === '' && value.button.busy && !value.button.disabled
    && !value.button.runningSubmit && value.button.stopDisplay !== 'none', stage + ': empty input exposes enabled Stop');
  mechanism(value.rows.length === count && value.rows.at(-1).visible, stage + ': newest submitted input is present exactly once and visible');
  mechanism(value.input.sameNode && value.input.sameRoot && value.surface.sameNode
    && value.rows.every((row: any) => row.sameNode), stage + ': renderer retains original editor, surface and user rows');
  mechanism(value.surface.overflowY === 'auto' && value.surface.overflowX === 'hidden'
    && value.surface.outerOverflow === 'hidden' && value.surface.clientHeight > 0, stage + ': the per-session slot owns vertical scrolling');
}

/** Hold a real send at transport entry and acknowledgement independently. */
async function holdAdmission(id: string) {
  await evaluate(`(()=>{
    if(window.__sideAdmission)throw Error('A previous admission barrier was not restored');
    const chat=window.klaus.chat,send=chat.send;
    let forward,ack,rejectForward;
    const forwardGate=new Promise((resolve,reject)=>{forward=resolve;rejectForward=reject}),ackGate=new Promise(resolve=>ack=resolve);
    const barrier={entered:false,forwarded:false,hostReplied:false,forward,ack,
      restore(){chat.send=send;delete window.__sideAdmission},
      cancel(){if(this.entered&&!this.forwarded)rejectForward(Error('Fixture admission cancelled during cleanup'));else forward();ack();this.restore()}};
    window.__sideAdmission=barrier;
    chat.send=async function(...args){
      if(args[0]!==${JSON.stringify(id)})return send.apply(chat,args);
      barrier.entered=true;
      await forwardGate;barrier.forwarded=true;
      const reply=await send.apply(chat,args);barrier.hostReplied=true;
      await ackGate;return reply;
    };
  })()`);
}

async function restoreAdmission(cancel = false) {
  await evaluate(`(()=>{
    const barrier=window.__sideAdmission;
    if(barrier){if(${cancel})barrier.cancel();else{barrier.forward();barrier.ack();barrier.restore()}}
  })()`);
}

async function mechanismConversation(parent: string, other: string, pane: Pane) {
  const prefix = panePrefix(pane), text = `${pane.toUpperCase()}_IDENTICAL_MECHANISM_INPUT`;
  await evaluate(`window.KlausSideTasks.refresh(${JSON.stringify(parent)})`);
  const id = await evaluate<string>('window.KlausSideTasks.create()');
  mechanism(Boolean(id), pane + ': mechanism fixture creates an actual side conversation');
  sideIds.push(id);
  await evaluate(`window.KlausSideTasks.moveTo(${JSON.stringify(id)},${JSON.stringify(pane)})`);
  await input('#' + prefix + 'input', text);
  let state = await mechanismSnapshot(id, pane, text, pane + ':before-send');
  mechanism(state.input.value === text && state.rows.length === 0 && !state.button.busy
    && !state.button.disabled, pane + ': unsent input remains editable and is not yet a transcript row');
  mechanismStages.add(pane + ':before-send');
  await holdAdmission(id);
  const entered = provider!.entered();
  provider!.holdNext(true);
  await enter();
  await waitFor(() => evaluate('window.__sideAdmission?.entered===true'), 15000, 'Real send reaches the admission barrier');
  state = await mechanismSnapshot(id, pane, text, pane + ':ack-pending');
  ownedRunning(state, 1, pane + ':ack-pending');
  mechanism(state.admission.forwarded === false && provider!.entered() === entered, pane + ': admission is held before any provider response');
  mechanismStages.add(pane + ':ack-pending');
  const pendingIdentity = state.rows[0].identity;
  mechanism(Boolean(pendingIdentity), pane + ': optimistic input already has a message identity');

  // Deliver the normalized native snapshot through the real renderer IPC subscription.
  const snapshot = { type: 'session_runtime_status', source: 'session', sessionId: id, status: 'idle' };
  record('injected-runtime.jsonl', snapshot);
  await runtime!.deliver(runtime!.window.webContents.id, 'chat:event:batch', [snapshot]);
  await pause(250);
  state = await mechanismSnapshot(id, pane, text, pane + ':runtime-snapshot-pending');
  ownedRunning(state, 1, pane + ':runtime-snapshot-pending');
  mechanism(state.rows[0].identity === pendingIdentity, pane + ': an idle snapshot cannot consume or replace pending input');
  mechanismStages.add(pane + ':runtime-snapshot-pending');

  await evaluate('window.__sideAdmission.forward()');
  await waitFor(() => provider!.entered() === entered + 1, 30000, 'The admitted request reaches the real held provider');
  await waitFor(() => evaluate('window.__sideAdmission?.hostReplied===true'), 15000, 'Actual host send reply is held at the acknowledgement boundary');
  state = await mechanismSnapshot(id, pane, text, pane + ':held-before-first-token');
  ownedRunning(state, 1, pane + ':held-before-first-token');
  mechanism(!JSON.stringify(state.runtime.liveUnits).includes('Paragraph 1.'), pane + ': the held provider has emitted no assistant token');
  mechanismStages.add(pane + ':held-before-first-token');
  await restoreAdmission();
  provider!.streamHeldText();
  await waitFor(() => evaluate(`JSON.stringify(window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.liveUnits).includes('Paragraph 1.')`), 15000, 'Held stream emits text without completing');
  state = await mechanismSnapshot(id, pane, text, pane + ':streaming');
  ownedRunning(state, 1, pane + ':streaming');
  mechanismStages.add(pane + ':streaming');
  writeFileSync(join(logs, pane + '-mechanism-streaming.png'), (await runtime!.window.webContents.capturePage()).toPNG());
  provider!.release();
  await waitFor(() => evaluate(`!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.running&&window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.lastTerminalStatus==='completed'`), 20000, 'Mechanism turn completes');
  state = await mechanismSnapshot(id, pane, text, pane + ':completed');
  mechanism(state.rows.length === 1 && state.rows[0].identity === pendingIdentity
    && state.rows[0].sameNode && !state.button.busy && state.input.sameNode, pane + ': completion hands history the same user identity and DOM');
  mechanismStages.add(pane + ':completed');

  // The reader asks to see the latest output before resubmitting: the float
  // button is the product's own scroll-to-latest affordance. A send from far
  // above the bottom keeps the reading position by contract, so the resubmit
  // stage starts from the bottom exactly like the baseline near-latest flow.
  await evaluate(`document.getElementById('${prefix}scroll-to-bottom').click()`);
  await pause(400);

  provider!.holdNext(true);
  const again = provider!.entered();
  await input('#' + prefix + 'input', text);
  await enter();
  await waitFor(() => provider!.entered() === again + 1, 20000, 'Identical later input starts a distinct real turn');
  state = await mechanismSnapshot(id, pane, text, pane + ':same-text-resubmit');
  ownedRunning(state, 2, pane + ':same-text-resubmit');
  mechanism(state.rows.every((row: any) => Boolean(row.identity))
    && new Set(state.rows.map((row: any) => row.identity)).size === 2
    && state.rows[0].identity === pendingIdentity, pane + ': same text never merges distinct message identities');
  mechanismStages.add(pane + ':same-text-resubmit');

  const spare = await evaluate<string>('window.KlausSideTasks.create()');
  sideIds.push(spare);
  await evaluate(`window.KlausSideTasks.moveTo(${JSON.stringify(spare)},${JSON.stringify(pane)})`);
  mechanism(await evaluate(`window.__sideMechanismProbes[${JSON.stringify(id)}].root.isConnected&&window.__sideMechanismProbes[${JSON.stringify(id)}].root.hidden`),
    pane + ': switching tabs hides the original editor without detaching it');
  await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(id)})`);
  state = await mechanismSnapshot(id, pane, text, pane + ':tab-away-back');
  ownedRunning(state, 2, pane + ':tab-away-back');
  mechanismStages.add(pane + ':tab-away-back');

  await evaluate(`window.klausSwitchSession(${JSON.stringify(other)})`);
  await evaluate(`window.klausSwitchSession(${JSON.stringify(parent)})`);
  await waitFor(() => evaluate(`window.klausSideSurfaceSessionId(${JSON.stringify(pane)})===${JSON.stringify(id)}`), 15000, 'Main navigation restores the mechanism owner');
  state = await mechanismSnapshot(id, pane, text, pane + ':main-away-back');
  ownedRunning(state, 2, pane + ':main-away-back');
  mechanismStages.add(pane + ':main-away-back');
  provider!.release();
  await waitFor(() => evaluate(`!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.running`), 20000, 'Repeated-input turn completes before dual-pane checks');
  return { id, pane, text };
}

async function dualPaneMechanism(owners: Array<{ id: string; pane: Pane; text: string }>) {
  for (const owner of owners) {
    const prefix = panePrefix(owner.pane), text = owner.pane.toUpperCase() + '_DUAL_RUNNING_INPUT';
    await evaluate(`window.KlausSideTasks.moveTo(${JSON.stringify(owner.id)},${JSON.stringify(owner.pane)})`);
    // The previous response ended far below the placed reading position, and a
    // far send keeps that position by contract. Return to the latest content
    // through the product's own float button, exactly like the baseline
    // near-latest flow, so the dual-running send starts from the bottom.
    await evaluate(`document.getElementById('${prefix}scroll-to-bottom').click()`);
    await pause(400);
    const entered = provider!.entered();
    provider!.holdNext(true);
    await input('#' + prefix + 'input', text);
    await enter();
    await waitFor(() => provider!.entered() === entered + 1, 20000, 'Both panes reach independent held provider responses');
    const state = await mechanismSnapshot(owner.id, owner.pane, text, owner.pane + ':dual-running');
    ownedRunning(state, 1, owner.pane + ':dual-running');
    mechanismStages.add(owner.pane + ':dual-running');
  }
  const right = owners.find(owner => owner.pane === 'right')!, left = owners.find(owner => owner.pane === 'left')!;
  mechanism(await evaluate(`(()=>{
    const probes=window.__sideMechanismProbes;
    return probes[${JSON.stringify(left.id)}].input!==probes[${JSON.stringify(right.id)}].input
      &&probes[${JSON.stringify(left.id)}].slot!==probes[${JSON.stringify(right.id)}].slot
      &&window.klausSideSurfaceSessionId('left')===${JSON.stringify(left.id)}
      &&window.klausSideSurfaceSessionId('right')===${JSON.stringify(right.id)};
  })()`), 'dual-pane sessions own independent editor roots and scroll containers');
  await evaluate('document.getElementById("side-send").click()');
  await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(right.id)}]?.lastTerminalStatus==='interrupted'`), 15000, 'Right Stop reaches its real engine turn');
  let state = await mechanismSnapshot(left.id, 'left', 'LEFT_DUAL_RUNNING_INPUT', 'dual:stop-isolation');
  ownedRunning(state, 1, 'dual:stop-isolation');
  mechanismStages.add('dual:stop-isolation');
  await evaluate('document.getElementById("left-side-send").click()');
  await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(left.id)}]?.lastTerminalStatus==='interrupted'`), 15000, 'Left Stop reaches its own real engine turn');
  provider!.release();
  for (const owner of owners) {
    await waitFor(() => evaluate(`!document.getElementById('${panePrefix(owner.pane)}send').classList.contains('busy')`), 5000, 'Stopped owner leaves the running submit affordance');
    state = await mechanismSnapshot(owner.id, owner.pane, owner.pane.toUpperCase() + '_DUAL_RUNNING_INPUT', owner.pane + ':stopped');
    mechanism(!state.runtime.running && state.runtime.lastTerminalStatus === 'interrupted'
      && !state.button.busy && state.input.sameNode, owner.pane + ': stopped state preserves editor identity without a stale Stop face');
    mechanismStages.add(owner.pane + ':stopped');
  }
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
      await nearLatest(id, prefix);
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
    const owners = [];
    for (const pane of ['right', 'left'] as const) owners.push(await mechanismConversation(parent, other, pane));
    await dualPaneMechanism(owners);
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ passed: true, checks, mechanismChecks, mechanismStages: [...mechanismStages] }, null, 2));
    console.log(`Side transcript: ${checks} baseline checks and ${mechanismChecks} mechanism checks passed across both panes.`);
  } catch (error) {
    console.error(error);
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ passed: false, checks, mechanismChecks, mechanismStages: [...mechanismStages], error: String(error) }, null, 2));
    process.exitCode = 1;
  } finally {
    await restoreAdmission(true).catch(error => record('cleanup.jsonl', { admissionRestoreError: String(error) }));
    for (const sessionId of sideIds) if (runtime) await invoke('chat:interrupt', { sessionId }).catch(() => {});
    provider?.release();
    await runtime?.shutdown();
    await provider?.close();
    app.exit(Number(process.exitCode) || 0);
  }
})();
