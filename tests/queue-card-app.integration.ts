import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvGet, kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { INTERRUPTED_QUEUE_REASON } from '../main/sessions/client-queue';
import { assert, assertEqual, assertDeepEqual, Harness, waitFor } from './harness';
import { startQueueCardProvider } from './fixtures/queue-card-provider';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';

const profile = process.env.KLAUS_QUEUE_CARD_FIXTURE_PROFILE;
const logDirectory = process.env.KLAUS_QUEUE_CARD_FIXTURE_LOGS;
if (!profile || !logDirectory) throw Error('Run with scripts/run-queue-card-app-test.mjs');
const root = profile, logs = logDirectory;
process.env.KLAUS_CONFIG_DIR = root; process.env.KLAUS_TEST = '1'; process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron')); registerAppScheme(); app.on('window-all-closed', () => {});
const h = new Harness();
class FixtureBail extends Error {}
const facadeCalls: Array<{ method: string; params: unknown; started: number; finished?: number }> = [], engineEvents: unknown[] = [];
let runtime: DesktopRuntime | undefined, provider: Awaited<ReturnType<typeof startQueueCardProvider>> | undefined;
let sessionId = '', sequence = 0, injectQueueFenceFailure = false;
const evaluate = <T = any>(script: string): Promise<T> => runtime!.window.webContents.executeJavaScript(script);
const invoke = (channel: string, value?: Json): Promise<any> => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
const progress = (message: string) => { process.stdout.write(`${message}\n`); appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`); };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const queueSelector = (side = false) => side ? '#side-follow-up-queue' : '#follow-up-queue';
const rowSelector = (id: string, side = false) => `${queueSelector(side)} [data-follow-up-id=${JSON.stringify(id)}]`;
const snapshot = (id = sessionId): Promise<any> => evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(id)})`);
const rows = async (id = sessionId): Promise<any[]> => (await snapshot(id)).snapshot.items;
async function waitRows(count: number, id = sessionId) { await waitFor(async () => (await rows(id)).length === count, 10000, `${count} authoritative queued rows for ${id}`); }
async function installRecorder() {
  await waitFor(() => evaluate('Boolean(window.klaus?.chat && window.setComposerText && window.klausSwitchSession && window.__klausChatStreamStore)&&document.getElementById("boot-screen")?.style.display==="none"'), 20000, 'production composer initialization and boot overlay completed');
  await evaluate(`(() => {
    window.__queueFixtureEvents=[];window.__queueFixtureCalls=[];window.__queueFixtureClicks=[];window.__queueFixtureTransitions=[];window.__queueFixturePointer=[];
    for(const name of ['pointerover','pointerout','pointermove','pointerdown','pointerup','click'])document.addEventListener(name,event=>window.__queueFixturePointer.push({name,trusted:event.isTrusted,x:event.clientX,y:event.clientY,at:performance.now(),target:event.target.outerHTML?.slice(0,200)}),true);
    for(const channel of ['chat:event:batch','permission:request'])window.__KLAUS_DESKTOP__.event.listen('ipc:'+channel,event=>window.__queueFixtureEvents.push({channel,value:event.payload.args[0]}));
    for(const name of ['clientQueueAdd','clientQueueRemove','clientQueueRestore','clientQueueReorder','clientQueueDeliver','clientQueueResume']){
      const original=window.klaus.chat[name];window.klaus.chat[name]=async(...args)=>{const call={name,args,started:performance.now()};window.__queueFixtureCalls.push(call);try{call.reply=await original(...args);return call.reply}finally{call.finished=performance.now()}};
    }
    new MutationObserver(()=>{for(const row of document.querySelectorAll('[data-follow-up-id]')){const buttons=[...row.querySelectorAll('button')].map(button=>({action:button.dataset.followUpAction,disabled:button.disabled}));if(buttons.some(button=>button.disabled))window.__queueFixtureTransitions.push({id:row.dataset.followUpId,buttons,at:performance.now()})}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
  })()`);
}
async function reloadRenderer() {
  let loaded = false;
  runtime!.window.webContents.once('did-finish-load', () => { loaded = true; });
  runtime!.window.reload();
  await waitFor(() => loaded, 20000, 'the replacement renderer document finishes loading');
  await installRecorder();
}
async function focusWindow() {
  await waitFor(async () => {
    runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus(); runtime!.window.webContents.focus();
    return runtime!.window.isFocused() && await evaluate<boolean>('document.hasFocus()');
  }, 5000, 'native input window and document own focus');
}
async function point(selector: string) {
  await focusWindow();
  await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw Error('Missing or disabled fixture control: '+${JSON.stringify(selector)});element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})})()`);
  let previous = '', stable = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await focusWindow();
    const sample = await evaluate<{ key: string; valid: boolean; point: { x: number; y: number }; evidence: unknown }>(`(()=>{
      const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw Error('Missing or disabled fixture control: '+${JSON.stringify(selector)});
      const rect=element.getBoundingClientRect();const point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};const hit=document.elementFromPoint(point.x,point.y);
      return {key:JSON.stringify([rect.x,rect.y,rect.width,rect.height,innerWidth,innerHeight]),valid:document.hasFocus()&&rect.width>0&&rect.height>0&&!element.disabled&&(hit===element||element.contains(hit)),point,
        evidence:{selector:${JSON.stringify(selector)},point,rect:rect.toJSON(),control:element.outerHTML.slice(0,1800),documentHasFocus:document.hasFocus(),hit:hit?.outerHTML.slice(0,500)}};
    })()`);
    stable = sample.key === previous ? stable + 1 : 0; previous = sample.key;
    if (stable >= 3 && sample.valid) { await evaluate(`window.__queueFixtureClicks.push(${JSON.stringify(sample.evidence)})`); return sample.point; }
    await pause(30);
  }
  throw Error('Fixture control did not settle as a focused native pointer target: ' + selector);
}
function pointerClick(p: { x: number; y: number }) {
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) runtime!.window.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
}
async function click(selector: string) { pointerClick(await point(selector)); }
async function key(value: string) { await focusWindow(); const keyCode = ({ ArrowDown: 'Down', ArrowUp: 'Up' } as Record<string, string>)[value] || value; runtime!.window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); runtime!.window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(30); }
async function draft(text: string, side = false) {
  await evaluate(side ? 'document.getElementById("side-input").value=""' : 'window.setComposerText("")');
  await click(side ? '#side-input' : '#input');
  await waitFor(() => evaluate(`document.activeElement===document.getElementById(${JSON.stringify(side ? 'side-input' : 'input')}) && document.hasFocus()`), 5000, 'trusted pointer focuses the composer before typing');
  await runtime!.window.webContents.insertText(text);
  await waitFor(() => evaluate(`(() => {const button=document.getElementById(${JSON.stringify(side ? 'side-send' : 'send')});
    const id=${side ? 'window.klausSideSurfaceSessionId()' : 'window.currentSessionId'};
    return button?.disabled===false && (!window.isSessionRunning(id) || button.classList.contains('running-submit'));})()`),
    5000, 'trusted composer input exposes submit instead of Stop');
}
async function attach(side = false) {
  await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PNG_FIXTURE_BASE64)}),c=>c.charCodeAt(0))],'queue-card.png',{type:'image/png'}));const input=document.getElementById(${JSON.stringify(side ? 'side-file-input' : 'file-input')});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(side ? '#side-previews img' : '#previews img')}))`), 10000, 'real attachment upload preview');
}
async function enqueue(text: string, side = false, attachment = false, cards = false): Promise<any> {
  const id = side ? await evaluate<string>('window.klausSideSurfaceSessionId()') : sessionId;
  const before = (await rows(id)).map(row => row.id);
  await draft(text, side);
  if (cards) await evaluate(`window.klausQuoteAddToChat('QUEUE_CARD_SELECTED_TEXT');window.klausPastedTextAddToChat('QUEUE_CARD_PASTED_TEXT')`);
  if (attachment) await attach(side); await click(side ? '#side-send' : '#send');
  await waitFor(async () => (await rows(id)).some(row => !before.includes(row.id)), 10000, 'real composer durable admission');
  return (await rows(id)).find(row => !before.includes(row.id));
}
async function newHeld(label: string) {
  provider!.release();
  const row = await invoke('session:new', { workdir: root }); sessionId = String(row.id);
  await invoke('session:set-permission-mode', { mode: 'bypassPermissions', sessionId });
  await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
  const barrier = `QUEUE_CARD_HOLD_${label}_${++sequence}`;
  await draft(barrier); await click('#send');
  await waitFor(() => provider!.entered(barrier) === 1, 30000, 'real tool entered the loopback barrier');
  return barrier;
}
async function openMenu(id: string, side = false) { await click(`${rowSelector(id, side)} [data-follow-up-action="more"]`); await waitFor(() => evaluate('Boolean(document.querySelector(".follow-up-menu-panel"))'), 5000, 'row menu opens'); }
async function drag(from: string, target: string, side = false) {
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`${rowSelector(from, side)} [data-follow-up-grip]`)}))&&Boolean(document.querySelector(${JSON.stringify(`${rowSelector(target, side)} [data-follow-up-grip]`)}))`), 5000, 'completed queue mutations restore native sortable handles');
  const a = await point(`${rowSelector(from, side)} [data-follow-up-grip]`), b = await point(`${rowSelector(target, side)} [data-follow-up-grip]`);
  const input = runtime!.window.webContents;
  input.sendInputEvent({ type: 'mouseMove', ...a }); input.sendInputEvent({ type: 'mouseDown', ...a, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 12; step++) { input.sendInputEvent({ type: 'mouseMove', x: a.x, y: Math.round(a.y + (b.y - a.y) * step / 12), button: 'left', modifiers: ['leftbuttondown'] }); await pause(20); }
  input.sendInputEvent({ type: 'mouseUp', x: a.x, y: b.y, button: 'left', clickCount: 1 });
  await pause(220);
}
async function diagnostics(name = 'diagnostics') {
  const page = runtime && !runtime.window.isDestroyed() ? await evaluate(`({events:window.__queueFixtureEvents,calls:window.__queueFixtureCalls,clicks:window.__queueFixtureClicks,transitions:window.__queueFixtureTransitions,pointer:window.__queueFixturePointer,hover:[...document.querySelectorAll(':hover')].map(el=>el.outerHTML.slice(0,160)),focus:{document:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,1500)},send:document.getElementById('send')?.outerHTML,input:document.getElementById('input')?.value,current:window.currentSessionId,side:window.klausSideSurfaceSessionId?.(),stream:window.__klausChatStreamStore?.getState(),body:document.body.innerText.slice(-16000)})`).catch(error => ({ error: String(error) })) : undefined;
  writeFileSync(join(logs, `${name}.json`), JSON.stringify({ sessionId, facadeCalls, engineEvents, provider: provider?.requests, page }, null, 2));
  if (runtime && !runtime.window.isDestroyed()) writeFileSync(join(logs, name === 'diagnostics' ? 'workbench.png' : `${name}.png`), (await runtime.window.webContents.capturePage()).toPNG());
}
async function scenario(name: string, test: () => Promise<void>) {
  progress(`Starting ${name}`); await h.test(name, test); await diagnostics(`case-${h.results.length}`); provider?.release();
  if (process.env.KLAUS_QUEUE_CARD_BAIL === '1' && h.results.some(result => result.ok === false)) throw new FixtureBail('Stopped after the first failed interaction');
}

void (async () => {
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:queue-fixture', 'composer.thinking_level': 'off', follow_up_queue_mode: 'queue', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(key, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startQueueCardProvider(); process.env.KLAUS_SERVER_URL = provider.url;
    const externalImportHome = join(root, 'external-home'); mkdirSync(externalImportHome, { recursive: true });
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome }); runtime.window.setContentSize(1280, 900);
    runtime.engine.on('event', event => engineEvents.push(event));
    runtime.window.webContents.on('console-message', (_event, ...args) => process.stdout.write(`[renderer] ${args.map(String).join(' ')}\n`));
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.queue-fixture', mergeStrategy: 'replace', value: { name: 'Queue fixture', provider: 'anthropic', model: 'queue-fixture-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true } } }] });
    await runtime.sessions.request('model/credential/write', { id: 'queue-fixture', apiKey: 'local-fixture-key' });
    await installRecorder();
    const client = runtime.sessions.engine()!.client, request = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params, timeout) => {
      if (injectQueueFenceFailure && method === 'thread/queue/start' && (params as { mode?: string }).mode === 'steer') {
        injectQueueFenceFailure = false;
        params = { ...(params as Record<string, Json>), expectedTurnId: 'fixture-retired-turn' };
      }
      const call = /^(turn\/|thread\/queue\/|session\/(steer|removeQueued|queueSnapshot|fork|updateTitle))/.test(method) ? { method, params, started: Date.now(), finished: undefined as number | undefined } : undefined;
      if (call) facadeCalls.push(call);
      try { return await request(method, params, timeout); }
      finally { if (call) call.finished = Date.now(); }
    };

    await scenario('raw previews, native keyboard menus, outside dismissal and session navigation', async () => {
      await newHeld('POPOVERS');
      const raw = '**Raw heading**\n\n' + 'Long selectable queue text with `literal markdown` and [literal link](https://invalid.example). '.repeat(8).trimEnd();
      const row = await enqueue(raw), selector = `${rowSelector(row.id)} [data-follow-up-preview]`;
      await click('#input'); runtime!.window.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 }); await pause(50);
      const hoverPoint = await point(selector); runtime!.window.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
      await pause(400); assertEqual(await evaluate('Boolean(document.querySelector(".follow-up-full-preview"))'), false, 'Hover does not open before its delay');
      await waitFor(async () => { runtime!.window.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint }); return evaluate('Boolean(document.querySelector(".follow-up-full-preview"))'); }, 10000, 'delayed raw preview after uninterrupted native hover');
      assertEqual(await evaluate('document.querySelector(".follow-up-full-preview-text").textContent'), raw, 'Preview retains full raw multiline text');
      assertEqual(await evaluate('document.querySelector(".follow-up-full-preview-text").querySelectorAll("strong,a,code").length'), 0, 'Preview does not reinterpret markdown');
      assertEqual(await evaluate(`(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.follow-up-full-preview-text'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const text=selection.toString();selection.removeAllRanges();return text})()`), raw, 'Full preview remains browser-selectable');
      await key('Escape');
      await waitFor(() => evaluate('!document.querySelector(".follow-up-full-preview")'), 3000, 'Escape closes preview');
      assertEqual(await evaluate('document.activeElement.hasAttribute("data-follow-up-preview")'), true, 'Escape restores preview trigger focus');
      await click('#input'); await focusWindow(); await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await waitFor(() => evaluate('Boolean(document.querySelector(".follow-up-full-preview"))'), 500, 'focus opens immediately');
      await key('Tab'); assertEqual(await evaluate('document.activeElement.classList.contains("follow-up-full-preview")'), true, 'Native Tab enters selectable preview'); await key('Escape');
      await click(selector); await waitFor(() => evaluate('Boolean(document.querySelector(".follow-up-full-preview"))'), 500, 'native click opens full preview'); await key('Escape');
      await openMenu(row.id); await key('End'); assertEqual(await evaluate('document.activeElement.dataset.followUpAction'), 'toggle-queueing', 'End selects last menu item');
      await key('ArrowDown'); assertEqual(await evaluate('document.activeElement.dataset.followUpAction'), 'edit', 'ArrowDown wraps');
      await key('ArrowUp'); assertEqual(await evaluate('document.activeElement.dataset.followUpAction'), 'toggle-queueing', 'ArrowUp wraps');
      await key('Home'); assertEqual(await evaluate('document.activeElement.dataset.followUpAction'), 'edit', 'Home selects first menu item');
      await key('Escape'); assertEqual(await evaluate('document.activeElement.dataset.followUpAction'), 'more', 'Escape restores menu trigger focus');
      await openMenu(row.id); await click('#input'); await waitFor(() => evaluate('!document.querySelector(".follow-up-menu-panel")'), 3000, 'outside pointer dismisses menu');
      await openMenu(row.id); const other = await invoke('session:new', { workdir: root }); await evaluate(`window.klausSwitchSession(${JSON.stringify(other.id)})`);
      await waitFor(() => evaluate('!document.querySelector(".follow-up-menu-panel")&&!document.querySelector(".follow-up-full-preview")'), 3000, 'session navigation closes portals');
      await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`); await waitRows(1);
    });

    await scenario('edit and undo restore the prior draft, attachment and original queue position', async () => {
      await newHeld('EDIT'); const first = await enqueue('EDIT_FIRST'), original = await enqueue('EDIT_IMAGE', false, true, true), last = await enqueue('EDIT_LAST');
      assertEqual(original.item.media.length, 1, 'Real image upload is in the queued payload');
      await reloadRenderer(); await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`${rowSelector(original.id)} img`)}))&&document.querySelector(${JSON.stringify(`${rowSelector(original.id)} img`)}).complete&&document.querySelector(${JSON.stringify(`${rowSelector(original.id)} img`)}).naturalWidth>0`), 10000, 'renderer reload resolves the durable queued image');
      await waitFor(() => evaluate(`window.isSessionRunning(${JSON.stringify(sessionId)})`), 5000, 'reload restores the running composer state');
      await draft('UNRELATED_UNSENT_DRAFT'); await openMenu(original.id); await click('.follow-up-menu-panel [data-follow-up-action="edit"]'); await waitRows(2);
      assert(await evaluate('document.getElementById("input").value.includes("EDIT_IMAGE")'), 'Edit restores queued request with its inline cards');
      assertEqual(original.item.selectedTextAttachments.length, 1, 'Selected text is stored alongside the upload'); assertEqual(original.item.pastedCards.length, 1, 'Pasted text is stored alongside the upload');
      await waitFor(() => evaluate('Boolean(document.querySelector("#previews img"))'), 5000, 'edit restores durable image preview');
      await click('.toast-root[style*="cursor: pointer"]:last-child'); await waitRows(3);
      assertEqual(await evaluate('document.getElementById("input").value'), 'UNRELATED_UNSENT_DRAFT', 'Edit undo restores unrelated draft');
      assertDeepEqual((await rows()).map(row => row.id), [first.id, original.id, last.id], 'Edit undo restores original position');
      assertDeepEqual((await rows())[1].item, original.item, 'Edit undo preserves complete attachment payload');
      await openMenu(original.id); await click('.follow-up-menu-panel [data-follow-up-action="edit"]'); await waitRows(2); await click('#send'); await waitRows(3);
      const edited = (await rows())[1]; assertEqual(edited.item.displayText, original.item.displayText, 'Requeued edit uses former anchors');
      assertDeepEqual(edited.item.media, original.item.media, 'Requeued edit reuses uploaded attachment');
      assertDeepEqual(edited.item.selectedTextAttachments.map((card: any) => card.text), original.item.selectedTextAttachments.map((card: any) => card.text), 'Requeued edit preserves selected text');
      assertDeepEqual(edited.item.pastedCards.map((card: any) => card.text), original.item.pastedCards.map((card: any) => card.text), 'Requeued edit preserves pasted text');
      assertEqual((await rows())[2].id, last.id, 'Later requests remain later after editing');
    });

    await scenario('native drag reorder and delete undo remain durable across renderer reload', async () => {
      await newHeld('REORDER'); const first = await enqueue('ORDER_FIRST'), second = await enqueue('ORDER_SECOND'), third = await enqueue('ORDER_THIRD');
      await drag(first.id, third.id); await waitFor(async () => (await rows()).map(row => row.id).join() === [second.id, third.id, first.id].join(), 5000, 'native sortable reorder reaches the host');
      await click(`${rowSelector(third.id)} [data-follow-up-action="delete"]`); await waitRows(2); await click('.toast-root[style*="cursor: pointer"]:last-child'); await waitRows(3);
      assertDeepEqual((await rows()).map(row => row.id), [second.id, third.id, first.id], 'Delete undo restores both neighbor anchors');
      await reloadRenderer(); await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await waitFor(() => evaluate('document.querySelectorAll("#follow-up-queue [data-follow-up-id]").length===3'), 10000, 'renderer recovers durable rows');
      assertDeepEqual((await rows()).map(row => row.id), [second.id, third.id, first.id], 'Reload preserves exact order');
    });

    await scenario('side transfer owns the full payload, side sorting unlocks and real refused delivery can retry', async () => {
      await newHeld('SIDE_PARENT'); const source = await enqueue('SIDE_TRANSFER_IMAGE', false, true, true), untouched = await enqueue('MAIN_STAYS_QUEUED');
      await openMenu(source.id); await click('.follow-up-menu-panel [data-follow-up-action="side-chat"]');
      await waitFor(() => evaluate('Boolean(window.klausSideSurfaceSessionId?.())'), 20000, 'real fresh side conversation is active');
      const sideId = await evaluate<string>('window.klausSideSurfaceSessionId()'); assert(sideId !== sessionId, 'Transfer creates distinct session ownership');
      await waitFor(async () => (await rows()).length === 1 && (await rows(sideId)).length === 0, 20000, 'transfer is delivered from target queue');
      assertEqual((await rows())[0].id, untouched.id, 'Main queue retains only its own other request');
      const transferred = await evaluate<any[]>(`window.__queueFixtureCalls.filter(call=>call.name==='clientQueueAdd'&&call.args[0]===${JSON.stringify(sideId)}&&call.args[1]===${JSON.stringify(source.id)})`);
      assertEqual(transferred.length, 1, 'Transfer adds one durable target copy'); assertDeepEqual(transferred[0]!.args[2], source.item, 'Transfer preserves every original payload field');
      await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('SIDE_TRANSFER_IMAGE') && JSON.stringify(body.messages).includes(PNG_FIXTURE_BASE64)), 15000, 'real provider receives transferred image and text');
      await waitFor(() => evaluate(`!window.isSessionRunning(${JSON.stringify(sideId)})`), 15000, 'transferred side turn completes');
      await invoke('session:set-permission-mode', { mode: 'bypassPermissions', sessionId: sideId });
      const barrier = `QUEUE_CARD_HOLD_SIDE_${++sequence}`; await draft(barrier, true); await click('#side-send'); await waitFor(() => provider!.entered(barrier) === 1, 20000, 'side tool barrier is active');
      const bad = await enqueue('SIDE_RECOVERABLE_IMAGE', true, true), peer = await enqueue('SIDE_OTHER_ROW', true);
      await drag(bad.id, peer.id, true); await waitFor(async () => (await rows(sideId))[0]?.id === peer.id, 5000, 'side native reorder reaches host');
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(`${rowSelector(bad.id, true)} [data-follow-up-action="more"]`)}).disabled`), 5000, 'side controls unlock after reorder');
      await openMenu(bad.id, true); assertEqual(await evaluate('document.querySelectorAll(".follow-up-menu-panel [data-follow-up-action=side-chat]").length'), 0, 'Side rows cannot create nested side transfers'); await key('Escape');
      const file = String(bad.item.media[0].path); assert(resolve(file).startsWith(resolve(root, 'uploads') + sep), 'Portable input probe moves only a fixture-owned uploaded file');
      const parked = file + '.fixture-parked'; renameSync(file, parked);
      injectQueueFenceFailure = true;
      try {
        await click(`${rowSelector(bad.id, true)} [data-follow-up-action="send-now"]`);
        await waitFor(async () => Boolean((await rows(sideId)).find(row => row.id === bad.id)?.pausedReason), 10000, 'the actual engine refuses a retired turn fence and pauses the row');
        assertEqual(injectQueueFenceFailure, false, 'the real atomic queue RPC consumed the one-shot invalid fence');
        await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`${rowSelector(bad.id, true)} [data-follow-up-action="retry"]`)}))&&!document.querySelector(${JSON.stringify(`${rowSelector(bad.id, true)} [data-follow-up-action="more"]`)}).disabled`), 5000, 'side controls unlock after failed delivery');
        await click(`${rowSelector(bad.id, true)} [data-follow-up-action="retry"]`);
        await waitFor(async () => !(await rows(sideId)).some(row => row.id === bad.id), 10000, 'actual Retry admits saved image bytes while the original file is unavailable');
      } finally { injectQueueFenceFailure = false; renameSync(parked, file); }
      assertEqual((await rows())[0].id, untouched.id, 'Side retry cannot mutate main ownership');
      provider!.release(barrier);
      await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('SIDE_RECOVERABLE_IMAGE') && JSON.stringify(body.messages).includes(PNG_FIXTURE_BASE64)), 20000, 'the real provider consumes the portable queued image and directive');
    });

    await scenario('stop then delete undo preserves interruption until explicit resume and drains once', async () => {
      const barrier = await newHeld('STOP_UNDO'), first = await enqueue('STOP_QUEUE_FIRST'), second = await enqueue('STOP_QUEUE_SECOND');
      await click('#send');
      await waitFor(() => evaluate('Boolean(document.querySelector("#follow-up-queue [data-follow-up-action=resume-queue]"))'), 10000, 'Stop exposes interrupted queue banner');
      await click(`${rowSelector(first.id)} [data-follow-up-action="delete"]`); await waitRows(1); await click('.toast-root[style*="cursor: pointer"]:last-child'); await waitRows(2);
      assertEqual(await evaluate('Boolean(document.querySelector("#follow-up-queue [data-follow-up-action=resume-queue]"))'), true, 'Delete undo retains interruption banner');
      const durable = await runtime!.sessions.request('thread/queue/list', { threadId: sessionId }) as { data: Array<{ pausedReason?: string }> };
      assertEqual(durable.data.length, 2, 'the engine retains both stopped rows');
      assert(durable.data.every(row => row.pausedReason === INTERRUPTED_QUEUE_REASON), 'Delete undo retains every engine-owned interruption mark');
      await pause(400); assertEqual((await rows()).length, 2, 'Interrupted restored rows do not automatically dispatch');
      provider!.release(barrier); await click('#follow-up-queue [data-follow-up-action="resume-queue"]'); await waitRows(0);
      await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('STOP_QUEUE_SECOND')), 20000, 'resumed automatic queue reaches final row');
      const calls = await evaluate<any[]>('window.__queueFixtureCalls');
      assertEqual(calls.filter(call => call.name === 'clientQueueResume' && call.args[0] === sessionId).length, 1, 'One native Resume request is issued');
      assertDeepEqual([first.item.displayText, second.item.displayText], ['STOP_QUEUE_FIRST', 'STOP_QUEUE_SECOND'], 'Both original requests were retained');
    });

    await scenario('mixed engine and interrupted client requests resume together without losing queue ownership', async () => {
      const barrier = await newHeld('MIXED_RESUME');
      const engine = await enqueue('MIXED_ENGINE_DIRECTIVE');
      await click(`${rowSelector(engine.id)} [data-follow-up-action="send-now"]`); await waitRows(0);
      await enqueue('MIXED_CLIENT_AFTER_ENGINE'); await click('#send');
      await waitFor(() => evaluate(`!window.isSessionRunning(${JSON.stringify(sessionId)})`), 15000, 'Stop finishes the active mixed-queue turn');
      await reloadRenderer(); await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await waitFor(() => evaluate('Boolean(document.querySelector("#follow-up-queue [data-follow-up-id^=\\\"engine:\\\"]"))&&Boolean(document.querySelector("#follow-up-queue [data-follow-up-action=resume-queue]"))'), 10000, 'both queue owners are visible after interrupted recovery');
      provider!.release(barrier); await click('#follow-up-queue [data-follow-up-action="resume-queue"]');
      await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('MIXED_ENGINE_DIRECTIVE')), 20000, 'resumed engine queue is consumed');
      await waitRows(0); await waitFor(() => provider!.requests.some(body => JSON.stringify(body.messages).includes('MIXED_CLIENT_AFTER_ENGINE')), 20000, 'resumed client queue automatically follows engine-owned request');
      const durable = await runtime!.sessions.request('thread/queue/list', { threadId: sessionId }) as { data: unknown[] };
      assertEqual(durable.data.length, 0, 'No interrupted engine queue row remains stranded');
    });

    await scenario('queue preference menu persists across renderer reload', async () => {
      await newHeld('PREFERENCE'); const row = await enqueue('PREFERENCE_ROW');
      await openMenu(row.id); await click('.follow-up-menu-panel [data-follow-up-action="toggle-queueing"]');
      await waitFor(() => kvGet('follow_up_queue_mode', root) === 'steer', 5000, 'menu persists immediate-delivery preference');
      await reloadRenderer(); await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await waitFor(() => evaluate('Boolean(document.querySelector("#follow-up-queue [data-follow-up-action=more]"))'), 10000, 'queue recovers after preference reload');
      await openMenu(row.id); const enable = await evaluate<string>('document.querySelector(".follow-up-menu-panel [data-follow-up-action=toggle-queueing]").textContent');
      await click('.follow-up-menu-panel [data-follow-up-action="toggle-queueing"]'); await waitFor(() => kvGet('follow_up_queue_mode', root) === 'queue', 5000, 'menu persists queue preference');
      await openMenu(row.id); const disable = await evaluate<string>('document.querySelector(".follow-up-menu-panel [data-follow-up-action=toggle-queueing]").textContent');
      assert(enable !== disable, 'Reloaded menu label reflects persisted mode'); await key('Escape');
    });

    await scenario('native duplicate steer admits once and engine-owned recovered row can be removed', async () => {
      const barrier = await newHeld('ENGINE'), row = await enqueue('ENGINE_RECOVERY_DIRECTIVE');
      const before = facadeCalls.filter(call => call.method === 'thread/queue/start' && (call.params as { mode: string }).mode === 'steer').length;
      const p = await point(`${rowSelector(row.id)} [data-follow-up-action="send-now"]`); pointerClick(p); pointerClick(p);
      await waitFor(async () => !(await rows()).some(candidate => candidate.id === row.id), 10000, 'one steer admission drains client row');
      assertEqual(facadeCalls.filter(call => call.method === 'thread/queue/start' && (call.params as { mode: string }).mode === 'steer').length - before, 1, 'Native duplicate activation cannot admit a second steer');
      const calls = await evaluate<any[]>('window.__queueFixtureCalls'); assertEqual(calls.filter(call => call.name === 'clientQueueDeliver' && call.args[1] === row.id).length, 1, 'Renderer sends one real delivery request');
      await reloadRenderer(); await evaluate(`window.klausSwitchSession(${JSON.stringify(sessionId)})`);
      await waitFor(() => evaluate('Boolean(document.querySelector("#follow-up-queue [data-follow-up-id^=\\\"engine:\\\"]"))'), 10000, 'real engine queue recovers into read-only card');
      const engineRow = await evaluate<string>('document.querySelector("#follow-up-queue [data-follow-up-id^=\\\"engine:\\\"]").dataset.followUpId');
      assertEqual(await evaluate(`document.querySelectorAll(${JSON.stringify(`${rowSelector(engineRow)} [data-follow-up-action="more"],${rowSelector(engineRow)} [data-follow-up-action="send-now"],${rowSelector(engineRow)} [data-follow-up-grip]`)}).length`), 0, 'Engine-owned row exposes only supported controls');
      await click(`${rowSelector(engineRow)} [data-follow-up-action="delete"]`);
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(rowSelector(engineRow))})`), 10000, 'native Delete removes queued engine-owned item');
      provider!.release(barrier);
      await waitFor(() => evaluate(`!window.isSessionRunning(${JSON.stringify(sessionId)})`), 20000, 'original turn completes after engine queue removal');
      assert(!provider!.requests.some(body => JSON.stringify(body.messages).includes('ENGINE_RECOVERY_DIRECTIVE')), 'Removed pending directive never reaches the next model request');
    });
  } catch (error) { if (!(error instanceof FixtureBail)) await h.test('queue card fixture setup', () => { throw error; }); }
  finally {
    provider?.release(); await diagnostics().catch(error => h.info('diagnostics', String(error)));
    try { await runtime?.shutdown(); } catch (error) { await h.test('production runtime cleanup', () => { throw error; }); }
    try { await provider?.close(); } catch (error) { await h.test('local provider cleanup', () => { throw error; }); }
    app.exit(await h.finish(join(logs, 'results.json'), 'queue-card-app'));
  }
})();
