import { app } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';
import { startComposerLifecycleProvider } from './fixtures/composer-lifecycle-provider';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';

const profile = process.env.KLAUS_COMPOSER_LIFECYCLE_PROFILE;
const logDirectory = process.env.KLAUS_COMPOSER_LIFECYCLE_LOGS;
if (!profile || !logDirectory) throw Error('Run with scripts/run-composer-lifecycle-test.mjs');
const root = profile, logs = logDirectory;
const phase = process.env.KLAUS_COMPOSER_LIFECYCLE_PHASE || 'seed';
if (phase !== 'seed' && phase !== 'restore') throw Error('Unknown composer lifecycle phase');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
class FixtureBail extends Error {}
const facadeCalls: Array<{ method: string; params: unknown }> = [];
const engineEvents: unknown[] = [];
const mediaAdmissionTrace: Array<{ id: string; readable: boolean; at: number }> = [];
const retain = <T>(values: T[], value: T) => { values.push(value); if (values.length > 500) values.splice(0, values.length - 500); };
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startComposerLifecycleProvider>> | undefined;
let sessionId = '', otherId = '';
let firstMetadata: any, attachmentMetadata: any, uploadedPath = '';
let clickToken = 0;
let archivedId = '', archivedMetadata: any;
let queueId = '', queueSnapshot: any;
const quote = 'LIFECYCLE_QUOTE\nselected content with exact whitespace  ';
const pasted = 'LIFECYCLE_PASTED_TEXT\n' + 'preserved pasted content '.repeat(240);
const evaluate = <T = any>(script: string): Promise<T> => runtime!.window.webContents.executeJavaScript(script);
const invoke = (channel: string, value?: Json): Promise<any> => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
const progress = (message: string) => { process.stdout.write(message + '\n'); appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`); };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const history = (id = sessionId): Promise<any> => invoke('session:history', { sessionId: id });
const userMessages = async (id = sessionId): Promise<any[]> => (await history(id)).messages.filter((row: any) => row.role === 'user');
const calls = (name: string): Promise<any[]> => evaluate(`window.__composerFixtureCalls.filter(row=>row.name===${JSON.stringify(name)})`);
async function installRecorder() {
  await waitFor(() => evaluate('Boolean(window.klaus?.chat&&window.setComposerText&&window.klausSwitchSession&&window.__klausChatStreamStore)&&document.getElementById("boot-screen")?.style.display==="none"'), 25000, 'production composer boot completed');
  await evaluate(`(()=>{
    window.__composerFixtureCalls=[];window.__composerFixtureClicks=[];
    const retain=(array,row)=>{array.push(row);if(array.length>300)array.splice(0,array.length-300)};
    for(const name of ['send','editPrepare','editMessage','uploadFile','pastedTextCreate','pastedTextRead','pastedTextRemove','clientQueueAdd']){
      const original=window.klaus.chat[name];if(typeof original!=='function')continue;
      window.klaus.chat[name]=async(...args)=>{const row={name,args:structuredClone(args),started:performance.now()};retain(window.__composerFixtureCalls,row);
        try{row.reply=await original(...args);return row.reply}catch(error){row.error=String(error);throw error}finally{row.finished=performance.now()}};
    }
  })()`);
}
async function focus() {
  await waitFor(async () => {
    runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus(); runtime!.window.webContents.focus();
    return runtime!.window.isFocused() && await evaluate<boolean>('document.hasFocus()');
  }, 5000, 'native input focus');
}
async function click(selector: string, cardAction = false) {
  await focus();
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`);
  let last = '', stable = 0;
  let point: { x: number; y: number } | undefined;
  await waitFor(async () => {
    const sample = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)return null;
      const r=element.getBoundingClientRect(),point={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},hit=document.elementFromPoint(point.x,point.y),owner=${cardAction} ? element.closest('.kls-paste-card') : element;
      return {key:JSON.stringify([r.x,r.y,r.width,r.height]),point,valid:r.width>0&&r.height>0&&(hit===owner||owner.contains(hit)),hit:hit?.outerHTML.slice(0,300)}})()`);
    if (!sample) return false;
    if (!sample.valid) runtime!.window.webContents.sendInputEvent({ type: 'mouseMove', ...sample.point });
    stable = last === sample.key ? stable + 1 : 0; last = sample.key;
    if (!sample.valid || stable < 3) { await pause(30); return false; }
    point = sample.point;
    await evaluate(`(()=>{const a=window.__composerFixtureClicks;a.push(${JSON.stringify({ selector, ...sample })});if(a.length>100)a.shift()})()`);
    return true;
  }, 5000, 'visible native pointer target: ' + selector);
  const token = ++clickToken;
  await evaluate(`document.addEventListener('click',event=>{let root=document.querySelector(${JSON.stringify(selector)});if(${cardAction})root=root.closest('.kls-paste-card');
    window.__composerFixtureNativeClick={token:${token},trusted:event.isTrusted,owned:Boolean(root&&(event.target===root||root.contains(event.target)))};
  },{once:true,capture:true})`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) runtime!.window.webContents.sendInputEvent({ type, ...point!, button: 'left', clickCount: 1 });
  await waitFor(() => evaluate(`window.__composerFixtureNativeClick?.token===${token}`), 5000, 'native pointer event completed: ' + selector);
  assertDeepEqual(await evaluate('window.__composerFixtureNativeClick'), { token, trusted: true, owned: true }, 'The actual click belongs to its intended target');
}
async function key(keyCode: string, modifiers: Array<'meta' | 'shift' | 'control' | 'alt'> = []) {
  await focus();
  runtime!.window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  runtime!.window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
}
async function draft(value: unknown) {
  await evaluate(`window.setComposerText(${JSON.stringify(typeof value === 'string' ? '' : value)})`);
  await click('#input');
  await evaluate(`(()=>{const el=document.getElementById('input');el.setSelectionRange(el.value.length,el.value.length)})()`);
  if (typeof value === 'string' && value) await runtime!.window.webContents.insertText(value);
  else {
    await runtime!.window.webContents.insertText(' ');
    await key('Backspace');
  }
}
async function nativeDrop(selector: string, files: string[]) {
  await click(selector);
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  await evaluate(`(()=>{window.__nativeDragTrace=[];window.__nativeDropTrace=[];
    for(const type of ['dragenter','dragover','dragleave','drop'])document.addEventListener(type,event=>{
      window.__nativeDragTrace.push({type,trusted:event.isTrusted,types:Array.from(event.dataTransfer?.types||[]),target:event.target?.id});
      if(window.__nativeDragTrace.length>30)window.__nativeDragTrace.shift();
    },{capture:true});document.addEventListener('drop',event=>{
    window.__nativeDropTrace.push({trusted:event.isTrusted,files:Array.from(event.dataTransfer.items).filter(item=>item.kind==='file').map(item=>{
      const file=item.getAsFile(),entry=item.webkitGetAsEntry?.();return{name:file?.name,directory:entry?.isDirectory,path:file?window.klaus.chat.localFilePath(file):''};})});
  },{once:true,capture:true})})()`);
  const debuggerApi = runtime!.window.webContents.debugger;
  debuggerApi.attach('1.3');
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      const eventType = type.toLowerCase(), before = await evaluate<number>(`window.__nativeDragTrace.filter(row=>row.type===${JSON.stringify(eventType)}).length`);
      await debuggerApi.sendCommand('Input.dispatchDragEvent', { type, ...point,
        data: { items: [{ mimeType: 'text/uri-list', data: files.map(path => pathToFileURL(path).href).join('\r\n') }], files, dragOperationsMask: 1 } });
      await waitFor(() => evaluate(`window.__nativeDragTrace.filter(row=>row.type===${JSON.stringify(eventType)}).length>${before}`), 5000, 'Browser drag stage: ' + type);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
  } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
  await waitFor(() => evaluate('window.__nativeDropTrace.length===1'), 5000, 'The browser delivers the queued drop event');
  const trace = await evaluate('window.__nativeDropTrace');
  assertEqual(trace.length, 1, 'One browser drop reaches the production document');
  assertEqual(trace[0].trusted, true, 'Chromium dispatches a trusted drop');
  assertDeepEqual(trace[0].files.map((file: any) => file.path), files, 'Native File paths cross the isolated preload without changing their spelling');
  writeFileSync(join(logs, 'native-drop-' + selector.replace(/[^a-z0-9]/gi, '') + '.json'), JSON.stringify(trace, null, 2));
}
async function switchTo(id: string) {
  await evaluate(`window.klausSwitchSession(${JSON.stringify(id)})`);
  await waitFor(() => evaluate(`window.currentSessionId===${JSON.stringify(id)}`), 10000, 'owning chat selected');
}
async function finished(expectedUsers: number, id = sessionId) {
  await waitFor(async () => (await userMessages(id)).length === expectedUsers
    && await evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.running===false`), 30000, 'real completed turn and persisted user history');
}
async function diagnostics(name: string) {
  const page = runtime && !runtime.window.isDestroyed() ? await evaluate(`({calls:window.__composerFixtureCalls,clicks:window.__composerFixtureClicks,current:window.currentSessionId,
    draft:document.getElementById('input')?.value,sideDraft:document.getElementById('side-input')?.value,side:window.klausSideSurfaceSessionId?.(),composition:window.__compositionTrace,nativeDrag:window.__nativeDragTrace,nativeDrop:window.__nativeDropTrace,edit:document.querySelector('.inline-user-edit')?.outerHTML.slice(0,16000),
    history:window.__klausChatStreamStore?.getState().sessions[${JSON.stringify(sessionId)}]?.history,body:document.body.innerText.slice(-16000),
    local:Object.fromEntries(Object.entries(localStorage).filter(([key])=>/draft|histor/.test(key)))})`).catch(error => ({ error: String(error) })) : null;
  writeFileSync(join(logs, name + '.json'), JSON.stringify({ sessionId, otherId, facadeCalls, engineEvents, mediaAdmissionTrace, requests: provider?.requests, page }, null, 2));
  if (runtime && !runtime.window.isDestroyed()) {
    for (let attempt = 0; ; attempt++) {
      try { writeFileSync(join(logs, name + '.png'), (await runtime.window.webContents.capturePage()).toPNG()); break; }
      catch (error) {
        if (attempt >= 2) throw error;
        progress(`Capture ${name} retry ${attempt + 1}: ${String(error)}`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await pause(100);
      }
    }
  }
}
async function scenario(name: string, run: () => Promise<void>) {
  progress('Starting ' + name);
  await h.test(name, run);
  await diagnostics('case-' + h.results.length);
  if (h.results.some(row => row.ok === false)) throw new FixtureBail();
}
function authoredDocument() {
  const reference = (kind: string, name: string, id: string) => {
    const value = `[${name}](klaus:${kind}/${id})`;
    return { type: 'composer_token', attrs: { value, label: name, data: { kind, name, id, value } } };
  };
  return { version: 1, content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'LIFECYCLE_FIRST ' }, { type: 'text', text: 'bold content', marks: [{ type: 'strong' }] }] },
    { type: 'paragraph', content: [reference('plugin', 'Tool source', 'lifecycle-plugin'), { type: 'text', text: ' then ' }, reference('mcp', 'Tool source', 'lifecycle-mcp')] },
  ] } };
}
async function inputState(selector: string) {
  return evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),start=el.selectionStart,end=el.selectionEnd,data=new DataTransfer();
    el.setSelectionRange(0,el.value.length);el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));el.setSelectionRange(start,end);
    const copied=new DOMParser().parseFromString(data.getData('text/html'),'text/html');return {text:el.value,
    tokens:Array.from(copied.querySelectorAll('[data-klaus-document-token]')).map(node=>JSON.parse(node.getAttribute('data-klaus-document-token'))),
    bold:Array.from(el.querySelectorAll('strong')).map(node=>node.textContent)}})()`);
}
async function addStoredPaste(side: boolean) {
  const count = (await calls('pastedTextCreate')).length;
  await evaluate(side ? `(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pasted)});
    document.getElementById('side-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()`
    : `window.klausPastedTextAddToChat(${JSON.stringify(pasted)})`);
  await waitFor(async () => { const rows = await calls('pastedTextCreate'); return rows.length === count + 1 && rows.at(-1)?.finished && rows.at(-1)?.reply?.path; }, 10000, 'The actual pasted file is stored');
  return (await calls('pastedTextCreate')).at(-1).reply.path as string;
}
async function cardActions(side: boolean) {
  const input = side ? '#side-input' : '#input', previews = side ? '#side-previews' : '#previews';
  const before = await inputState(input);
  await evaluate(`(()=>{const original=window.klaus.chat.pastedTextCreate;window.__pasteCreateGate={finished:false,release:null,restore:()=>{window.klaus.chat.pastedTextCreate=original}};
    window.klaus.chat.pastedTextCreate=async(...args)=>{const result=await original(...args);await new Promise(done=>window.__pasteCreateGate.release=done);
      window.__pasteCreateGate.finished=true;return result}})()`);
  let path: string;
  try {
    path = await addStoredPaste(side);
    const sends = (await calls('send')).length;
    await click(input); await key('Return');
    await click(previews + ' .kls-paste-card-remove');
    await evaluate('window.__pasteCreateGate.release()');
    await waitFor(() => evaluate('window.__pasteCreateGate.finished'), 5000, 'The removed pending card settles in its retained history owner');
    await key('Z', ['meta']);
    await waitFor(() => evaluate(`Boolean(document.querySelector('${previews} .kls-paste-card-restore'))`), 5000, 'Undo restores the settled pending card');
    assertEqual((await calls('send')).length, sends, 'Removing the pending card cancels its parked submit');
  } finally { await evaluate('window.__pasteCreateGate.release?.();window.__pasteCreateGate.restore()'); }
  await waitFor(() => evaluate(`document.querySelectorAll('${previews} .kls-paste-card-restore').length===1`), 5000, 'The stored card exposes Restore');
  await click(input);
  await click(previews + ' .kls-paste-card-remove');
  assertEqual(await evaluate('document.activeElement.id'), side ? 'side-input' : 'input', 'Mouse removal retains editor focus');
  await key('Z', ['meta']);
  await waitFor(() => evaluate(`document.querySelector('${previews} .kls-paste-card')?.dataset.pastePath===${JSON.stringify(path)}`), 5000, 'Undo restores the exact card identity');
  await key('Z', ['meta', 'shift']);
  await waitFor(() => evaluate(`!document.querySelector('${previews} .kls-paste-card')`), 5000, 'Redo removes the card');
  await key('Z', ['meta']);
  assertDeepEqual(await inputState(input), before, 'Attachment history leaves the rich input unchanged');
  assertEqual(readFileSync(path, 'utf8'), pasted, 'Undoable removal keeps the stored bytes');
  await focus();
  await evaluate(`document.querySelector('${previews} .kls-paste-card-remove').focus()`);
  assertEqual(await evaluate('document.activeElement.className'), 'kls-paste-card-remove', 'The native keyboard target is the removal button');
  runtime!.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  runtime!.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  runtime!.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(() => evaluate(`!document.querySelector('${previews} .kls-paste-card')`), 5000, 'Native keyboard activation removes the last card');
  assertEqual(await evaluate('document.activeElement.id'), side ? 'side-input' : 'input', 'Keyboard removal returns focus to the editor');
  await key('Z', ['meta']);
  await waitFor(() => evaluate(`Boolean(document.querySelector('${previews} .kls-paste-card-restore'))`), 5000, 'Keyboard removal is undoable');
  await evaluate(`(()=>{const original=window.klaus.chat.pastedTextRead;window.__pasteReadGate={entered:false,release:null,restore:()=>{window.klaus.chat.pastedTextRead=original}};
    window.klaus.chat.pastedTextRead=async(...args)=>{const result=await original(...args);window.__pasteReadGate.entered=true;
      await new Promise(done=>window.__pasteReadGate.release=done);return result}})()`);
  try {
    await click(previews + ' .kls-paste-card-restore', true);
    await waitFor(() => evaluate('window.__pasteReadGate.entered'), 5000, 'Restore awaits the real host read');
    await click(input);
    await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(input)});el.setSelectionRange(el.value.length,el.value.length)})()`);
    await runtime!.window.webContents.insertText(' later');
    // This scenario tests completion-time ownership, so establish its selection
    // through the editor control rather than an asynchronous DOM-only range.
    const selectionSetup = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(input)}),quotes=el.querySelectorAll('.kls-inline-quote');
      const quote=quotes[0],text=el.value,offset=text.indexOf('\\uFFFC');
      const focused=document.hasFocus()&&document.activeElement===el,uniqueAtom=offset>=0&&text.lastIndexOf('\\uFFFC')===offset;
      if(focused&&quotes.length===1&&quote.isConnected&&uniqueAtom)el.setSelectionRange(offset,offset+1);
      const selection=window.getSelection(),quoteBounds=document.createRange();if(quote)quoteBounds.selectNode(quote);
      const range=selection?.rangeCount?selection.getRangeAt(0):null;return {focused,quotes:quotes.length,connected:Boolean(quote?.isConnected),uniqueAtom,
        domOwnsQuote:Boolean(quote&&range&&!selection.isCollapsed&&el.contains(selection.anchorNode)&&el.contains(selection.focusNode)&&range.compareBoundaryPoints(Range.START_TO_START,quoteBounds)<=0&&range.compareBoundaryPoints(Range.END_TO_END,quoteBounds)>=0)}})()`);
    assert(selectionSetup.focused, 'The completion-time selection is prepared in the focused owning editor');
    assertEqual(selectionSetup.quotes, 1, 'The completion-time selection targets one existing quote');
    assert(selectionSetup.connected && selectionSetup.uniqueAtom, 'The quote identity and authored atom remain available');
    assert(selectionSetup.domOwnsQuote, 'The authoritative completion-time selection also selects the rendered quote');
    await pause(50);
    const selected = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(input)});return {start:el.selectionStart,end:el.selectionEnd,text:el.value}})()`);
    assert(selected.end > selected.start, 'The completion-time selection owns the existing quote atom');
    await evaluate('window.__pasteReadGate.release()');
    await waitFor(() => evaluate(`!document.querySelector('${previews} .kls-paste-card')`), 5000, 'Restore consumes its own card');
    const restored = await inputState(input);
    assertEqual(restored.text, selected.text.slice(0, selected.start) + pasted + selected.text.slice(selected.end), 'Restore inserts literal text at the completion-time selection');
    assertDeepEqual(restored.tokens, before.tokens.filter((token: any) => token.data.kind !== 'selected-text'), 'Restore retains resource identities without recreating the selected quote');
    assertDeepEqual(restored.bold, before.bold, 'Restore preserves neighboring marks');
    await key('Z', ['meta']);
    assertEqual((await inputState(input)).text, selected.text, 'Native Undo restores the prior document');
    assertDeepEqual((await inputState(input)).tokens, before.tokens, 'Native Undo restores exact quote and resource identities');
    assertEqual(await evaluate(`document.querySelectorAll('${previews} .kls-paste-card').length`), 0, 'Text Undo does not recreate a consumed card');
    await key('Z', ['meta', 'shift']);
    assertDeepEqual(await inputState(input), restored, 'Native Redo restores the literal result');
    await waitFor(async () => { try { readFileSync(path); return false; } catch { return true; } }, 5000, 'Consumed draft-owned file is retired');
    await key('Escape');
    assertEqual(await evaluate('document.activeElement.id'), '', 'Idle Escape leaves the owning editor');
    await key('Escape');
    assertEqual(await evaluate('document.activeElement.id'), side ? 'side-input' : 'input', 'Outside Escape recovers the remembered available composer');
  } finally { await evaluate('window.__pasteReadGate.restore()'); }
}
async function restartScenarios() {
  const expected = JSON.parse(readFileSync(join(root, 'composer-restart-expectations.json'), 'utf8'));
  sessionId = expected.sessionId; otherId = expected.otherId; archivedId = expected.archivedId;
  await scenario('a new process restores exact welcome and main documents without runtime trays', async () => {
    assert(process.pid !== expected.processId, 'A distinct Electron process owns the restored document');
    assertEqual(runtime!.engine.liveProcessCount(), 1, 'The new process owns one real engine');
    const engines = runtime!.engine.inspect();
    assert(engines[0]?.pid && engines[0].pid !== expected.enginePid, 'The restored app owns a distinct engine process');
    assertEqual(await evaluate('window.currentSessionId'), null, 'Startup retains the virtual welcome scope');
    assertEqual(await evaluate('document.getElementById("input").value'), expected.welcome.text, 'The welcome draft preserves exact authored text');
    assertDeepEqual(await evaluate('JSON.parse(localStorage.getItem("klaus_welcome_draft_document"))'), expected.welcome.document, 'The welcome document retains marks and inline identities');
    assertEqual(await evaluate('document.querySelectorAll("#previews .kls-attach-item,#previews .kls-paste-card").length'), 0, 'Runtime tray membership is not resurrected after restart');
    await switchTo(sessionId);
    assertEqual(await evaluate('document.getElementById("input").value'), expected.mainVisibleText, 'The main draft retains its exact visible whitespace and references');
    assertDeepEqual(await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`), expected.main, 'The main authored document is restored from durable storage');
    assertDeepEqual(await evaluate(`JSON.parse(localStorage.getItem('klaus_session_histories'))[${JSON.stringify(sessionId)}]`), expected.recallHistory, 'The owning recall history survives the process boundary exactly');
    assertEqual(await evaluate('document.querySelectorAll("#previews .kls-attach-chip,#previews .kls-paste-card").length'), 0, 'Unsent ordinary attachment trays remain runtime state');
    assertDeepEqual((await userMessages()).map(row => row.localRender), expected.mainMessages, 'Every submitted document and attachment envelope survives a cold start');
    for (const entry of expected.pastedCards) {
      const stored = await evaluate(`window.klaus.chat.pastedTextRead(${JSON.stringify(entry.path)})`);
      assertEqual(stored.text, pasted, 'Submitted pasted-text bytes survive a process restart');
    }
    assertEqual(readFileSync(expected.imagePath).toString('base64'), PNG_FIXTURE_BASE64, 'The durable image pool retains exact original bytes');
    assertEqual(facadeCalls.filter(row => row.method === 'turn/submit' && (row.params as { mode: string }).mode === 'start-if-idle').length, 0, 'Restore never submits a saved draft');
    writeFileSync(join(logs, 'restart-process-proof.json'), JSON.stringify({ seedPid: expected.processId, restoredPid: process.pid, seedEnginePid: expected.enginePid, restoredEngines: engines }, null, 2));
  });
  await scenario('cold-start recall restores the submitted document in its original owner', async () => {
    await draft(''); await click('#input'); await key('Up');
    await waitFor(() => evaluate('document.getElementById("input").value.includes("DIRECTORY_DROP_MAIN")'), 5000, 'Recall selects the owning recorded input');
    const restored = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`);
    assertDeepEqual(restored.document, expected.recallHistory.at(-1).document, 'Recall after a cold start retains the full recorded document');
    await switchTo(otherId); await draft(''); await key('Up');
    assertEqual(await evaluate('document.getElementById("input").value'), '', 'Another empty chat cannot recall the original input');
  });
  await scenario('a paused queue restores and explicitly replays its exact durable input once', async () => {
    queueId = expected.queueId;
    const snapshot = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`);
    assertDeepEqual(snapshot.snapshot, expected.queueSnapshot, 'The paused queue retains its exact ID, order, metadata and attachments');
    assert(snapshot.snapshot.interrupted, 'Restart does not resume interrupted input automatically');
    await switchTo(queueId);
    const rowId = expected.queueSnapshot.items[0].id, row = `[data-follow-up-id="${rowId}"]`;
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(row)}))`), 10000, 'The paused row renders in its owning chat');
    try {
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(row + ' img')})).some(image=>image.complete&&image.naturalWidth>0)`), 10000, 'The restored row loads its durable image thumbnail');
    } catch (error) {
      const images = await evaluate(`Promise.all(Array.from(document.querySelectorAll(${JSON.stringify(row + ' img')})).map(async image=>{
        const response=await fetch(image.src);return{src:image.src,complete:image.complete,width:image.naturalWidth,status:response.status,bytes:(await response.arrayBuffer()).byteLength};}))`);
      writeFileSync(join(logs, 'queue-thumbnail-probe.json'), JSON.stringify({ queueId, images, readableNow: runtime!.sessions.canReadSessionMedia(queueId), mediaAdmissionTrace }, null, 2));
      throw error;
    }
    const before = facadeCalls.filter(call => call.method === 'thread/queue/start' && (call.params as { mode: string }).mode === 'start-if-idle').length;
    await click('[data-follow-up-action="resume-queue"]'); await finished(2, queueId);
    await waitFor(async () => (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot.items.length === 0, 10000, 'The host acknowledges durable queue consumption');
    const after = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`);
    assertEqual(after.snapshot.items.length, 0, 'Acknowledged replay consumes the single queue row');
    const submitted = (await userMessages(queueId)).at(-1), item = expected.queueSnapshot.items[0].item;
    assertDeepEqual(submitted.localRender, item.displayMetadata, 'Replay persists the exact authored document, references, quote and attachment envelope');
    assertEqual(facadeCalls.filter(call => call.method === 'thread/queue/start' && (call.params as { mode: string }).mode === 'start-if-idle').length, before + 1, 'One explicit replay starts exactly one real turn');
    assert(submitted.text.includes(item.displayText), 'Replay delivers the complete authored request body');
    assert(submitted.text.includes(quote.trimEnd()), 'Replay delivers its selected-text context');
    assert(submitted.text.includes(item.pastedCards[0].path), 'Replay delivers its stored pasted-text reference');
    assert(submitted.text.includes(item.liveAttachments.find((file: any) => file.type === 'file').path), 'Replay delivers its directory reference');
    const prepared = await evaluate(`window.klaus.chat.editPrepare(${JSON.stringify(queueId)},${JSON.stringify(submitted.uuid)},${JSON.stringify(submitted.turnId)})`);
    assert(prepared.attachments.some((entry: any) => entry.path === item.liveAttachments.find((file: any) => file.type === 'file').path), 'Replay retains the queued directory identity');
    const image = prepared.attachments.find((entry: any) => entry.mimeType === 'image/png');
    assert(image, 'Replay retains its image as image media');
    assertEqual(readFileSync(image.path).toString('base64'), PNG_FIXTURE_BASE64, 'Replayed image bytes remain exact');
    const stored = await evaluate(`window.klaus.chat.pastedTextRead(${JSON.stringify(item.pastedCards[0].path)})`);
    assertEqual(stored.text, pasted, 'Replay retains all pasted-text bytes');
  });
  await scenario('cold archived content stays read-only and supports an independent edit after restoration', async () => {
    const archived = await evaluate('window.listArchivedSessions()');
    assert(archived.some((entry: any) => entry.id === archivedId), 'The archived chat survives process restart');
    await switchTo(archivedId);
    await waitFor(() => evaluate('!document.getElementById("archived-session-banner").hidden&&document.getElementById("input-wrapper").hidden'), 10000, 'Archived input is read-only');
    assertDeepEqual((await userMessages(archivedId))[0].localRender, expected.archivedMetadata, 'Archive retains the exact submitted authored document');
    assertEqual(await evaluate('document.querySelectorAll(".msg-group.user [data-action=edit]:not(:disabled)").length'), 0, 'Archived user rows cannot enter Edit');
    const result = await evaluate(`window.klaus.session.unarchive(${JSON.stringify(archivedId)})`);
    assertEqual(result.ok, true, 'The real host restores the archived chat');
    await evaluate('window.listArchivedSessions()'); await evaluate('window.updateSessionInList()');
    await switchTo(archivedId); await draft('INDEPENDENT_AFTER_RESTART');
    await waitFor(() => evaluate('Boolean(document.querySelector(".msg-group.user[data-editable=true] [data-action=edit]"))'), 10000, 'Restored history exposes its own Edit action');
    await click('.msg-group.user[data-editable=true] [data-action=edit]');
    await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-input"))'), 10000, 'Cold history prepares its independent message editor');
    await click('.inline-user-edit-input');
    await evaluate('(()=>{const input=document.querySelector(".inline-user-edit-input");input.setSelectionRange(input.value.length,input.value.length)})()');
    await runtime!.window.webContents.insertText(' RESTART_ARCHIVE_EDIT');
    await click('.inline-user-edit button[type=submit]');
    await waitFor(() => evaluate('!document.querySelector(".inline-user-edit")'), 10000, 'The restored chat acknowledges its edit');
    await finished(1, archivedId);
    const edited = (await calls('editMessage')).at(-1);
    assert(edited.args[3].displayText.endsWith(' RESTART_ARCHIVE_EDIT'), 'The cold edit delivers the new authored wording');
    assertDeepEqual(edited.args[3].composerReferences, expected.archivedMetadata.composerReferences, 'Cold editing retains both independent reference identities');
    assertDeepEqual((await userMessages(archivedId))[0].localRender, edited.args[3], 'Cold editing persists its replacement document');
    assertEqual(await evaluate('document.getElementById("input").value'), 'INDEPENDENT_AFTER_RESTART', 'Editing restored history preserves the unrelated ordinary draft');
  });
}
void (async () => {
  try {
    await app.whenReady();
    for (const [name, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:queue-fixture', 'composer.thinking_level': 'off', follow_up_queue_mode: 'queue', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(name, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startComposerLifecycleProvider(); process.env.KLAUS_SERVER_URL = provider.url;
    const externalImportHome = join(root, 'external-home'); mkdirSync(externalImportHome, { recursive: true });
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome });
    const canReadMedia = runtime.sessions.canReadSessionMedia.bind(runtime.sessions);
    runtime.sessions.canReadSessionMedia = id => { const readable = canReadMedia(id); retain(mediaAdmissionTrace, { id, readable, at: Date.now() }); return readable; };
    runtime.window.setContentSize(1280, 900);
    runtime.engine.on('event', event => retain(engineEvents, event));
    runtime.window.webContents.on('console-message', event => appendFileSync(join(logs, 'renderer.log'), event.message.slice(0, 8192) + '\n'));
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.queue-fixture', mergeStrategy: 'replace', value: {
      name: 'Local fixture', provider: 'anthropic', model: 'queue-fixture-model', baseUrl: provider.url,
      maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true },
    } }] });
    await runtime.sessions.request('model/credential/write', { id: 'queue-fixture', apiKey: 'local-fixture-key' });
    await installRecorder();
    const client = runtime.sessions.engine()!.client, request = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (...args) => {
      const [method, params] = args;
      if (['turn/submit', 'thread/queue/start', 'session/truncate', 'session/startSideTask'].includes(method)) retain(facadeCalls, { method, params });
      return request(...args);
    };
    if (phase === 'restore') await restartScenarios();
    else {
    await scenario('first send promotes one virtual chat and persists the authored document', async () => {
      await click('#btn-new-chat');
      assertEqual(await evaluate('window.currentSessionId'), null, 'New chat has no persisted identity before input');
      await draft({ text: '', document: authoredDocument() });
      await evaluate(`(()=>{const el=document.getElementById('input');el.setSelectionRange(el.value.length,el.value.length);window.klausQuoteAddToChat(${JSON.stringify(quote)})})()`);
      const authored = await evaluate('JSON.parse(localStorage.getItem("klaus_welcome_draft_document"))');
      assertDeepEqual(authored.content.content[0], authoredDocument().content.content[0], 'Original bold paragraph is still authored');
      assertDeepEqual(authored.content.content[1].content.slice(0, 3), authoredDocument().content.content[1]!.content, 'Original ordered references are still authored');
      assertEqual(await evaluate('window.currentSessionId'), null, 'Text and quote editing retain the virtual chat');
      await click('#send');
      await waitFor(() => evaluate('Boolean(window.currentSessionId)'), 10000, 'first send creates a chat');
      sessionId = await evaluate('window.currentSessionId');
      await finished(1);
      const sent = await calls('send'); assertEqual(sent.length, 1, 'Exactly one real renderer send');
      firstMetadata = sent[0].args[3];
      assertDeepEqual(firstMetadata.composerDocument, authored, 'Submission preserves the authored document');
      assertDeepEqual(firstMetadata.composerReferences.map((row: any) => [row.kind, row.id]), [['plugin', 'lifecycle-plugin'], ['mcp', 'lifecycle-mcp']], 'Same-label references retain separate identities');
      assertEqual(firstMetadata.selectedTextAttachments[0].text, quote, 'Exact selected text survives');
      assertDeepEqual((await userMessages())[0].localRender, firstMetadata, 'Real engine history retains all display metadata');
      assertEqual(facadeCalls.filter(row => row.method === 'turn/submit' && (row.params as { mode: string }).mode === 'start-if-idle').length, 1, 'Exactly one real facade turn');
      assertEqual(runtime!.engine.liveProcessCount(), 1, 'Exactly one Rust engine child');
    });
    await scenario('switch and renderer reload preserve submitted identities and an independent draft', async () => {
      const other = await invoke('session:new', { workdir: root }); otherId = String(other.id);
      await switchTo(otherId); await draft('INDEPENDENT_DRAFT');
      await switchTo(sessionId);
      assertDeepEqual((await userMessages())[0].localRender, firstMetadata, 'Switch retains the stored document');
      await runtime!.window.webContents.loadURL(runtime!.window.webContents.getURL());
      await installRecorder(); await switchTo(sessionId);
      await waitFor(() => evaluate('Boolean(document.querySelector(".msg-group.user[data-editable=true]"))'), 10000, 'Reload renders the persisted user message');
      assertDeepEqual((await userMessages())[0].localRender, firstMetadata, 'Reload retains references, quote and rich structure');
      await switchTo(otherId);
      assertEqual(await evaluate('document.getElementById("input").value'), 'INDEPENDENT_DRAFT', 'Independent draft survives renderer reload');
      await switchTo(sessionId);
    });
    await scenario('native recall restores the complete document in its owning chat', async () => {
      await draft(''); await click('#input'); await key('Up');
      await waitFor(() => evaluate('document.getElementById("input").value.includes("LIFECYCLE_FIRST")'), 5000, 'Native Up recalls the owning history');
      const restored = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`);
      assertDeepEqual(restored.document, firstMetadata.composerDocument, 'Recall restores exact rich content and quote identity');
      await switchTo(otherId); await draft(''); await click('#input'); await key('Up');
      assertEqual(await evaluate('document.getElementById("input").value'), '', 'Another chat cannot recall the first chat input');
      await draft('INDEPENDENT_DRAFT'); await switchTo(sessionId); await draft('');
    });
    await scenario('uploaded image and pasted text survive real send and history reload', async () => {
      await draft({ text: '', document: authoredDocument() });
      await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PNG_FIXTURE_BASE64)}),c=>c.charCodeAt(0))],'lifecycle-image.png',{type:'image/png'}));const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));window.klausPastedTextAddToChat(${JSON.stringify(pasted)})})()`);
      await waitFor(async () => (await calls('uploadFile')).some(row => row.finished && row.reply?.path), 15000, 'Real image upload completed');
      uploadedPath = (await calls('uploadFile')).find(row => row.reply?.path).reply.path;
      assert(resolve(uploadedPath).startsWith(resolve(root) + sep), 'Upload belongs to the isolated fixture profile');
      await click('#send'); await finished(2);
      attachmentMetadata = (await calls('send')).at(-1).args[3];
      assertEqual(attachmentMetadata.pastedCards.length, 1, 'One pasted card is retained');
      const storedPaste = await evaluate(`window.klaus.chat.pastedTextRead(${JSON.stringify(attachmentMetadata.pastedCards[0].path)})`);
      assertEqual(storedPaste.text, pasted, 'Stored pasted content retains every authored byte');
      assertDeepEqual((await userMessages()).at(-1).localRender, attachmentMetadata, 'Real history retains pasted card and document metadata');
      await switchTo(otherId); await switchTo(sessionId);
      const row = (await userMessages()).at(-1);
      const rowSelector = `.msg-group.user[data-uuid=${JSON.stringify(row.uuid)}]`;
      await waitFor(() => evaluate(`(()=>{const image=document.querySelector(${JSON.stringify(rowSelector + ' img')});return image?.complete&&image.naturalWidth>0})()`), 10000, 'Owning sent row renders a decoded image');
      const prepared = await invoke('chat:edit-prepare', { sessionId, messageUuid: row.uuid, turnId: row.turnId });
      assertEqual(prepared.ok, true, 'Real host prepares the sent message');
      assertDeepEqual(prepared.displayMetadata, attachmentMetadata, 'Preparation retains exact metadata');
      assert(prepared.attachments.some((file: any) => file.mimeType === 'image/png' && file.path), 'Image is recovered as an existing pool file');
      uploadedPath = prepared.attachments.find((file: any) => file.mimeType === 'image/png').path;
      assert(resolve(uploadedPath).startsWith(resolve(root) + sep), 'Prepared pool file belongs to the fixture');
      assertEqual(readFileSync(uploadedPath).toString('base64'), PNG_FIXTURE_BASE64, 'Prepared image retains its original exact bytes');
    });
    await scenario('inline edit cancellation preserves the ordinary composer draft', async () => {
      await draft('UNSENT_MAIN_DRAFT');
      await click('.msg-group.user[data-editable=true] [data-action=edit]');
      await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-input"))'), 10000, 'Real inline edit preparation mounted');
      assertEqual(await evaluate('document.getElementById("input").value'), 'UNSENT_MAIN_DRAFT', 'Inline editing does not refill the ordinary composer');
      await click('.inline-user-edit button[type=button]');
      await waitFor(() => evaluate('!document.querySelector(".inline-user-edit")'), 5000, 'Cancel closes only the inline editor');
      assertEqual(await evaluate('document.getElementById("input").value'), 'UNSENT_MAIN_DRAFT', 'Cancel retains the ordinary draft');
      assertDeepEqual((await userMessages()).at(-1).localRender, attachmentMetadata, 'Cancel leaves persisted history intact');
    });
    await scenario('inline edit refusal retains the edit for retry and persists fixed attachments', async () => {
      await click('.msg-group.user[data-editable=true] [data-action=edit]');
      await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-input"))'), 10000, 'Inline editor mounted for retry');
      await click('.inline-user-edit-input');
      await evaluate(`(()=>{const el=document.querySelector('.inline-user-edit-input');el.setSelectionRange(el.value.length,el.value.length)})()`);
      await runtime!.window.webContents.insertText(' RETRY_EDIT');
      const hidden = uploadedPath + '.fixture-held';
      renameSync(uploadedPath, hidden);
      try {
        await click('.inline-user-edit button[type=submit]');
        await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-error"))'), 10000, 'Real host refuses a missing retained attachment');
        assert(await evaluate('document.querySelector(".inline-user-edit-input").value.endsWith(" RETRY_EDIT")'), 'Failed edit retains its wording');
        assertDeepEqual((await userMessages()).at(-1).localRender, attachmentMetadata, 'Preparation failure leaves history intact');
        assertEqual(await evaluate('document.getElementById("input").value'), 'UNSENT_MAIN_DRAFT', 'Refusal preserves the ordinary draft');
      } finally { renameSync(hidden, uploadedPath); }
      await click('.inline-user-edit button[type=submit]');
      await waitFor(() => evaluate('!document.querySelector(".inline-user-edit")'), 10000, 'Retry is acknowledged by the real host');
      await finished(2);
      const edited = (await calls('editMessage')).at(-1);
      assertEqual(edited.reply.ok, true, 'Real edit retry succeeds');
      const metadata = edited.args[3];
      assert(edited.args[2].includes(' RETRY_EDIT'), 'Replacement request contains the new edit');
      assert(JSON.stringify(metadata.composerDocument).includes(' RETRY_EDIT'), 'Persisted document contains the new edit');
      const preparations = await calls('editPrepare');
      assertEqual(edited.args[1], preparations.at(-1).args[1], 'Retry replaces the prepared user message');
      assertDeepEqual(metadata.composerReferences, attachmentMetadata.composerReferences, 'Edit retains both reference identities');
      assertDeepEqual(metadata.pastedCards, attachmentMetadata.pastedCards, 'Edit retains fixed pasted cards');
      assertDeepEqual((await userMessages()).at(-1).localRender, metadata, 'Edited authored document persists');
      await runtime!.window.webContents.loadURL(runtime!.window.webContents.getURL());
      await installRecorder(); await switchTo(sessionId);
      assertDeepEqual((await userMessages()).at(-1).localRender, metadata, 'Edited metadata survives renderer reload');
      assertEqual(await evaluate('document.getElementById("input").value'), 'UNSENT_MAIN_DRAFT', 'Reload retains the independent unsent draft');
    });
    await scenario('delayed send preflight cannot consume another running chat draft', async () => {
      const running = await invoke('session:new', { workdir: root });
      const runningId = String(running.id);
      await switchTo(runningId); await draft('COMPOSER_HOLD_RESPONSE'); provider!.holdNext(); await click('#send');
      await waitFor(() => provider!.entered() === 1, 30000, 'Other chat holds a real streaming response');
      await switchTo(sessionId); await draft('ORIGIN_PREFLIGHT_DRAFT');
      await evaluate(`(()=>{
        const options=window.klaus.session.getMainModelOptions,model=window.klaus.session.getMainModel;
        window.__composerGate={entered:0,finished:0,reads:0,pending:0,configured:0,errors:[],release:null,restore:()=>{window.klaus.session.getMainModelOptions=options;window.klaus.session.getMainModel=model}};
        const gate=new Promise(resolve=>{window.__composerGate.release=resolve});
        window.klaus.session.getMainModelOptions=async(...args)=>{window.__composerGate.entered++;await gate;try{const reply=await options(...args);if(reply.options?.some(row=>row.value==='custom:queue-fixture'))window.__composerGate.configured++;return reply}catch(error){window.__composerGate.errors.push(String(error));throw error}finally{window.__composerGate.finished++}};
        window.klaus.session.getMainModel=async(...args)=>{if(args[0]===${JSON.stringify(sessionId)}&&args[1]?.resolve===false)window.__composerGate.reads++;window.__composerGate.pending++;try{return await model(...args)}catch(error){window.__composerGate.errors.push(String(error));throw error}finally{window.__composerGate.pending--}};
        window.dispatchEvent(new Event('klaus:models-changed'));
      })()`);
      try {
        await waitFor(() => evaluate('window.__composerGate.entered>0'), 5000, 'Cold production catalog entered the fixture barrier');
        const reads = await evaluate<number>('window.__composerGate.reads');
        await click('#input'); await key('Return');
        await waitFor(() => evaluate(`window.__composerGate.reads>${reads}`), 5000, 'Native submit entered real model readiness');
        await switchTo(runningId); await draft('PRESERVE_RUNNING_CHAT_DRAFT');
        const before = facadeCalls.filter(row => row.method === 'turn/submit' && (row.params as { mode: string }).mode === 'start-if-idle').length;
        await evaluate('window.__composerGate.release()');
        await waitFor(() => evaluate('window.__composerGate.finished===window.__composerGate.entered&&window.__composerGate.pending===0&&window.__composerGate.configured>0'), 10000, 'Real configured catalog and source IPC calls completed');
        assertDeepEqual(await evaluate('window.__composerGate.errors'), [], 'Readiness RPCs succeeded');
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          assertEqual(await evaluate('window.currentSessionId'), runningId, 'Observation retains the other visible chat');
          assertEqual(await evaluate('document.getElementById("input").value'), 'PRESERVE_RUNNING_CHAT_DRAFT', 'Unrelated draft remains intact throughout observation');
          assertEqual((await calls('clientQueueAdd')).length, 0, 'No retired intent reaches queue admission during observation');
          await pause(25);
        }
        const snapshot = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(runningId)})`);
        assertEqual(snapshot.snapshot.items.length, 0, 'Origin submit cannot enqueue the current chat input');
        assertEqual(await evaluate('document.getElementById("input").value'), 'PRESERVE_RUNNING_CHAT_DRAFT', 'Current chat retains its own draft');
        assertEqual(facadeCalls.filter(row => row.method === 'turn/submit' && (row.params as { mode: string }).mode === 'start-if-idle').length, before, 'No replacement turn starts during observation');
        assert(!(await calls('clientQueueAdd')).length, 'No retired intent enters the other queue');
        assert(!provider!.requests.some(row => /ORIGIN_PREFLIGHT_DRAFT|PRESERVE_RUNNING_CHAT_DRAFT/.test(JSON.stringify(row.messages))), 'Neither retired nor unrelated draft reaches inference');
      } finally {
        await evaluate('window.__composerGate.release();window.__composerGate.restore()');
        provider!.release();
      }
      await switchTo(sessionId);
      assertEqual(await evaluate('document.getElementById("input").value'), 'ORIGIN_PREFLIGHT_DRAFT', 'Origin retains the complete input for an intentional retry');
      progress('Observed real chat ownership for 2000ms after configured catalog IPC; deterministic continuation ordering is covered by submission-owner tests.');
    });
    await scenario('Chromium composition commits persist without a later keystroke', async () => {
      await draft('IME_PREFIX ');
      await evaluate(`(()=>{window.__compositionTrace=[];for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown'])document.addEventListener(type,event=>{if(event.target.id!=='input')return;const rows=window.__compositionTrace;rows.push({type,trusted:event.isTrusted,composing:event.isComposing,inputType:event.inputType,data:event.data,key:event.key,at:performance.now(),value:event.target.value});if(rows.length>100)rows.shift()},true)})()`);
      const debuggerApi = runtime!.window.webContents.debugger;
      debuggerApi.attach('1.3');
      try {
        writeFileSync(join(logs, 'composition-browser.json'), JSON.stringify(await debuggerApi.sendCommand('Browser.getVersion'), null, 2));
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
        await waitFor(() => evaluate('document.getElementById("input").value==="IME_PREFIX zhongwen"'), 5000, 'Chromium marked text reaches the real editor document');
        const provisional = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`);
        assertEqual(provisional.text, 'IME_PREFIX ', 'Uncommitted candidate text is not persisted');
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
        await debuggerApi.sendCommand('Input.insertText', { text: '中文' });
        await waitFor(() => evaluate('window.__compositionTrace.some(row=>row.type==="compositionend")'), 5000, 'Chromium input-method API completes composition');
        assert(await evaluate('window.__compositionTrace.some(row=>row.type==="compositionstart"&&row.trusted)&&window.__compositionTrace.some(row=>row.type==="input"&&row.trusted&&row.composing)'), 'The real browser generated composing input before the API commit');
        await waitFor(() => evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]?.text==="IME_PREFIX 中文"`), 5000, 'Final committed text persists without another input');
        const saved = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`);
        assertEqual(saved.document.content.content[0].content[0].text, 'IME_PREFIX 中文', 'Committed document persists with exact text');
        writeFileSync(join(logs, 'composition-main-trace.json'), JSON.stringify(await evaluate('window.__compositionTrace'), null, 2));
        await runtime!.window.webContents.loadURL(runtime!.window.webContents.getURL());
        await installRecorder(); await switchTo(sessionId);
        assertEqual(await evaluate('document.getElementById("input").value'), 'IME_PREFIX 中文', 'Committed composition survives renderer reload');
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
    });
    await scenario('composing keys retain their main and inline editor owners', async () => {
      const debuggerApi = runtime!.window.webContents.debugger;
      debuggerApi.attach('1.3');
      try {
        await draft('IME_ENTER ');
        const beforeSends = (await calls('send')).length;
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
        await key('Return');
        assertEqual((await calls('send')).length, beforeSends, 'Composition Enter does not send');
        assertEqual(await evaluate('document.activeElement.id'), 'input', 'Composition Enter retains main focus');
        await debuggerApi.sendCommand('Input.insertText', { text: '中' });
        await draft('IME_ESCAPE ');
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '文', selectionStart: 1, selectionEnd: 1 });
        await key('Escape');
        assertEqual(await evaluate('document.activeElement.id'), 'input', 'Composition Escape does not blur the main input');
        await debuggerApi.sendCommand('Input.insertText', { text: '文' });
        await draft('');
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '/', selectionStart: 1, selectionEnd: 1 });
        await debuggerApi.sendCommand('Input.insertText', { text: '/' });
        await waitFor(() => evaluate('!document.getElementById("slash-menu").classList.contains("hidden")'), 5000, 'Committed query refreshes discovery without another key');
        await draft('MAIN_IME_DRAFT');
        await click('.msg-group.user[data-editable=true] [data-action=edit]');
        await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-input"))'), 10000, 'Inline editor is prepared');
        await click('.inline-user-edit-input');
        await evaluate(`(()=>{const el=document.querySelector('.inline-user-edit-input');el.setSelectionRange(el.value.length,el.value.length)})()`);
        const beforeEdits = (await calls('editMessage')).length;
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '编', selectionStart: 1, selectionEnd: 1 });
        await key('Return');
        assertEqual((await calls('editMessage')).length, beforeEdits, 'Composition Enter does not resend an edit');
        assert(await evaluate('Boolean(document.querySelector(".inline-user-edit"))'), 'Composition Enter retains the inline form');
        await debuggerApi.sendCommand('Input.insertText', { text: '编' });
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '辑', selectionStart: 1, selectionEnd: 1 });
        await key('Escape');
        assert(await evaluate('Boolean(document.querySelector(".inline-user-edit"))'), 'Composition Escape does not cancel the inline form');
        await debuggerApi.sendCommand('Input.insertText', { text: '辑' });
        assertEqual(await evaluate('document.getElementById("input").value'), 'MAIN_IME_DRAFT', 'Inline composition preserves the ordinary draft');
        await click('.inline-user-edit button[type=button]');
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
    });
    await scenario('retired document restoration rejects a late composition notification', async () => {
      await draft('COMPOSITION_OWNER ');
      const debuggerApi = runtime!.window.webContents.debugger;
      debuggerApi.attach('1.3');
      try {
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '旧', selectionStart: 1, selectionEnd: 1 });
        await waitFor(() => evaluate('document.getElementById("input").value.endsWith("旧")'), 5000, 'Old owner has marked text');
        await evaluate(`(()=>{const root=document.getElementById('input');window.__lateCompositionInputs=[];
          root.addEventListener('compositionend',()=>window.setComposerText('REPLACEMENT_DOCUMENT'),{once:true,capture:true});
          root.addEventListener('input',event=>{if(!event.isComposing)window.__lateCompositionInputs.push({value:root.value,type:event.inputType})});
        })()`);
        await debuggerApi.sendCommand('Input.insertText', { text: '旧' });
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assertEqual(await evaluate('document.getElementById("input").value'), 'REPLACEMENT_DOCUMENT', 'Replacement document retains its own content');
        assertDeepEqual(await evaluate('window.__lateCompositionInputs'), [], 'Retired composition cannot publish input for the replacement document');
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
    });
    await scenario('side composition retains its committed draft across real side chat switches', async () => {
      await draft('MAIN_SIDE_IME_DRAFT');
      await evaluate('window.KlausSideTasks.openFromRail()');
      await waitFor(() => evaluate('Boolean(window.klausSideSurfaceSessionId?.())'), 20000, 'Real side chat creation resolves');
      const firstSide = await evaluate<string>('window.klausSideSurfaceSessionId()');
      await click('#side-input');
      await runtime!.window.webContents.insertText('SIDE_IME_PREFIX ');
      const debuggerApi = runtime!.window.webContents.debugger;
      debuggerApi.attach('1.3');
      try {
        const sends = (await calls('send')).length, queues = (await calls('clientQueueAdd')).length;
        await debuggerApi.sendCommand('Input.imeSetComposition', { text: '侧', selectionStart: 1, selectionEnd: 1 });
        await key('Return');
        assertEqual((await calls('send')).length, sends, 'Side composition Enter does not start a turn');
        assertEqual((await calls('clientQueueAdd')).length, queues, 'Side composition Enter does not queue content');
        assertEqual(await evaluate('document.activeElement.id'), 'side-input', 'Side composition retains focus');
        await debuggerApi.sendCommand('Input.insertText', { text: '侧' });
        await waitFor(() => evaluate('document.getElementById("side-input").value==="SIDE_IME_PREFIX 侧"'), 5000, 'Side committed text reaches its own document');
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
      await evaluate('window.KlausSideTasks.create()');
      await waitFor(() => evaluate(`Boolean(window.klausSideSurfaceSessionId?.())&&window.klausSideSurfaceSessionId()!==${JSON.stringify(firstSide)}`), 20000, 'A distinct real side chat is active');
      const secondSide = await evaluate<string>('window.klausSideSurfaceSessionId()');
      await click('#side-input'); await runtime!.window.webContents.insertText('SECOND_SIDE_DRAFT');
      await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(firstSide)})`);
      assertEqual(await evaluate('document.getElementById("side-input").value'), 'SIDE_IME_PREFIX 侧', 'First side retains exact committed composition');
      await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(secondSide)})`);
      assertEqual(await evaluate('document.getElementById("side-input").value'), 'SECOND_SIDE_DRAFT', 'Second side keeps its independent draft');
      assertEqual(await evaluate('document.getElementById("input").value'), 'MAIN_SIDE_IME_DRAFT', 'Side composition and switching preserve main input');
      const created = facadeCalls.filter(row => row.method === 'session/startSideTask');
      assertEqual(created.length, 2, 'Two named side-task starts reach the real facade');
      assertDeepEqual(created.map(row => (row.params as any).init.threadId).sort(), [firstSide, secondSide].sort(), 'Side drafts bind to their exact engine thread identities');
    });
    await scenario('native directory and same-name image survive send reload and inline editing', async () => {
      const folder = join(root, 'drop-directories', 'images.png'), image = join(root, 'drop-files', 'images.png');
      mkdirSync(folder, { recursive: true }); mkdirSync(join(root, 'drop-files'), { recursive: true });
      writeFileSync(join(folder, 'retained.txt'), 'Folder contents stay on disk.');
      writeFileSync(image, Buffer.from(PNG_FIXTURE_BASE64, 'base64'));
      const folderReference = folder + '/';
      await draft('DIRECTORY_DROP_MAIN');
      assertEqual(await evaluate('window.klaus.chat.localFilePath(new File(["synthetic"],"images.png"))'), '', 'Synthetic Files do not gain a native path');
      const uploads = (await calls('uploadFile')).length;
      await nativeDrop('#input', [folder, image]);
      await waitFor(() => evaluate('document.querySelectorAll("#previews .kls-attach-chip:not(:disabled)").length===1&&document.querySelectorAll("#previews .kls-attach-thumb img").length===1'), 10000, 'Directory chip and same-name image are both ready');
      assertEqual((await calls('uploadFile')).length, uploads + 1, 'Only the ordinary image is uploaded');
      await click('#input'); await key('Return'); await finished(3);
      const sent = (await calls('send')).at(-1);
      assertEqual(sent.args[3].displayText, 'DIRECTORY_DROP_MAIN', 'Native URI companions never replace or extend authored prose');
      assert(sent.args[1].includes('Attached:\n- ' + folderReference), 'The model receives the exact directory reference');
      assertEqual(sent.args[2].length, 1, 'A directory with an image extension never enters inline media');
      const uploaded = (await calls('uploadFile')).at(-1).reply.path;
      assertEqual(sent.args[2][0].path, uploaded, 'The same-name ordinary image retains its own uploaded identity');
      assertEqual(readFileSync(uploaded).toString('base64'), PNG_FIXTURE_BASE64, 'The ordinary image retains exact bytes');
      assertDeepEqual(sent.args[3].attachments, [{ type: 'file', name: 'images.png', path: folderReference }], 'Saved display metadata retains the directory discriminator');
      assertDeepEqual((await userMessages()).at(-1).localRender, sent.args[3], 'The real engine retains the directory display envelope');
      await runtime!.window.webContents.loadURL(runtime!.window.webContents.getURL());
      await installRecorder(); await switchTo(sessionId);
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll('[data-user-file]')).some(el=>el.dataset.userFile===${JSON.stringify(folderReference)})`), 10000, 'History reload renders the exact directory card');
      const editUploads = (await calls('uploadFile')).length;
      await click('.msg-group.user[data-editable=true] [data-action=edit]');
      await waitFor(() => evaluate('Boolean(document.querySelector(".inline-user-edit-input"))'), 10000, 'Directory message prepares for inline editing');
      const prepared = (await calls('editPrepare')).at(-1).reply;
      assert(prepared.attachments.some((entry: any) => entry.path === folderReference), 'Edit preparation retains the complete directory path');
      const preparedImage = prepared.attachments.find((entry: any) => entry.mimeType === 'image/png');
      assert(preparedImage, 'History preparation retains the ordinary image as image media');
      await click('.inline-user-edit-input');
      await evaluate(`(()=>{const el=document.querySelector('.inline-user-edit-input');el.setSelectionRange(el.value.length,el.value.length)})()`);
      await runtime!.window.webContents.insertText(' DIRECTORY_EDIT');
      await click('.inline-user-edit button[type=submit]');
      await waitFor(() => evaluate('!document.querySelector(".inline-user-edit")'), 10000, 'The real host accepts the directory edit');
      await finished(3);
      const edited = (await calls('editMessage')).at(-1);
      assertEqual(edited.args[3].displayText, 'DIRECTORY_DROP_MAIN DIRECTORY_EDIT', 'The replacement retains the authored edit');
      assert(edited.args[2].includes('Attached:\n- ' + folderReference), 'The edited request retains the directory path');
      assertEqual(edited.args[4].length, 1, 'Edit recovery keeps the directory out of image media');
      assertEqual(edited.args[4][0].path, preparedImage.path, 'Editing retains the exact history-prepared image path');
      assertEqual(readFileSync(preparedImage.path).toString('base64'), PNG_FIXTURE_BASE64, 'The history pool retains the exact ordinary image bytes');
      assertEqual((await calls('uploadFile')).length, editUploads, 'Editing never reuploads retained images or directory contents');
      assertDeepEqual(edited.args[3].attachments, sent.args[3].attachments, 'The directory attachment survives editing without an upload');
      assertDeepEqual((await userMessages()).at(-1).localRender, edited.args[3], 'Edited directory metadata persists in real history');
      assertEqual(readFileSync(join(folder, 'retained.txt'), 'utf8'), 'Folder contents stay on disk.', 'Directory contents are untouched');
    });
    await scenario('native directory drop and first send stay owned by the active side chat', async () => {
      const folder = join(root, 'side-drop', 'images.png'); mkdirSync(folder, { recursive: true });
      await draft('INDEPENDENT_DIRECTORY_MAIN');
      await evaluate('window.KlausSideTasks.openFromRail()');
      await waitFor(() => evaluate('Boolean(window.klausSideSurfaceSessionId?.())'), 20000, 'The real side chat is active');
      const sideId = await evaluate<string>('window.klausSideSurfaceSessionId()');
      await click('#side-input');
      await evaluate('(()=>{const el=document.getElementById("side-input");el.setSelectionRange(0,el.value.length)})()');
      await runtime!.window.webContents.insertText('DIRECTORY_DROP_SIDE');
      const uploads = (await calls('uploadFile')).length;
      await nativeDrop('#side-input', [folder]);
      await waitFor(() => evaluate('document.querySelectorAll("#side-previews .kls-attach-chip:not(:disabled)").length===1'), 10000, 'Side directory is ready without upload');
      assertEqual(await evaluate('document.querySelectorAll("#previews .kls-attach-item").length'), 0, 'Side drop never attaches to the main composer');
      await click('#side-input'); await key('Return'); await finished(1, sideId);
      const sent = (await calls('send')).filter(row => row.args[0] === sideId).at(-1);
      assert(sent, 'Side input reaches its own real chat send');
      assertEqual(sent.args[3].displayText, 'DIRECTORY_DROP_SIDE', 'The side request retains authored prose without URI companions');
      assert(sent.args[1].includes('Attached:\n- ' + folder + '/'), 'The side request retains the native directory');
      assertEqual((sent.args[2] || []).length, 0, 'The side directory is never inline image media');
      assertEqual((await calls('uploadFile')).length, uploads, 'The side directory sends without uploading its contents');
      assertEqual((await userMessages(sideId)).at(-1).localRender.attachments[0].path, folder + '/', 'Side history retains its exact directory');
      assertEqual(await evaluate('document.getElementById("input").value'), 'INDEPENDENT_DIRECTORY_MAIN', 'Side first send preserves the ordinary main draft');
    });
    await scenario('archiving the current chat cannot transfer its live tray into the welcome draft', async () => {
      const created = await invoke('session:new', { workdir: root }); archivedId = String(created.id);
      await switchTo(archivedId); await draft({ text: '', document: authoredDocument() });
      await click('#send'); await finished(1, archivedId);
      archivedMetadata = (await userMessages(archivedId))[0].localRender;
      await click('#btn-new-chat'); await draft('WELCOME_ARCHIVE_OWNER');
      const welcomeFolder = join(root, 'welcome-owned'), archivedFolder = join(root, 'archived-owned');
      mkdirSync(welcomeFolder, { recursive: true }); mkdirSync(archivedFolder, { recursive: true });
      await nativeDrop('#input', [welcomeFolder]);
      assertEqual(await evaluate('window.currentSessionId'), null, 'The welcome attachment keeps its virtual draft owner');
      await switchTo(archivedId); await draft('ARCHIVED_OWNER_DRAFT');
      await nativeDrop('#input', [archivedFolder]);
      const pasteCalls = (await calls('pastedTextCreate')).length;
      await evaluate(`window.klausPastedTextAddToChat(${JSON.stringify(pasted)})`);
      await waitFor(async () => { const rows = await calls('pastedTextCreate'); return rows.length === pasteCalls + 1 && rows.at(-1)?.finished && rows.at(-1)?.reply?.path; }, 10000, 'The archived owner has its own settled pasted card');
      await evaluate('window.klausKeybindingActions.archiveThread()');
      await waitFor(() => evaluate('Boolean(document.querySelector("#klaus-dialog-root .klaus-dialog-confirm"))'), 5000, 'The real archive confirmation is mounted');
      await click('#klaus-dialog-root .klaus-dialog-confirm');
      await waitFor(() => evaluate('window.currentSessionId===null&&!document.querySelector("#klaus-dialog-root .klaus-dialog-confirm")'), 15000, 'Successful archive returns to the virtual welcome draft');
      assertEqual(await evaluate('document.getElementById("input").value'), 'WELCOME_ARCHIVE_OWNER', 'Archive restores the independent welcome prose');
      assertDeepEqual(await evaluate('Array.from(document.querySelectorAll("#previews .kls-attach-chip-name")).map(el=>el.textContent)'), ['welcome-owned'], 'Only the original welcome attachment is restored');
      assertEqual(await evaluate('document.querySelectorAll("#previews .kls-paste-card").length'), 0, 'The archived pasted card never follows the welcome owner');
      const saved = await evaluate('JSON.parse(localStorage.getItem("klaus_session_drafts"))');
      assert(!saved[archivedId], 'Archive retires the archived draft instead of recreating it during navigation');
      assertDeepEqual((await userMessages(archivedId))[0].localRender, archivedMetadata, 'Archive leaves submitted authored content intact');
      await switchTo(sessionId);
    });
    await scenario('pasted card actions preserve rich main and side input with native history', async () => {
      const created = await invoke('session:new', { workdir: root }), owner = String(created.id);
      await switchTo(owner); await draft({ text: '', document: authoredDocument() });
      await evaluate(`window.klausQuoteAddToChat(${JSON.stringify(quote)})`);
      await switchTo(sessionId); await switchTo(owner);
      await cardActions(false);
      await switchTo(sessionId); await draft({ text: '', document: authoredDocument() });
      await evaluate(`(()=>{const el=document.getElementById('input');el.setSelectionRange(0,el.value.length);
        const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));
        window.__richInputCopy={text:data.getData('text/plain'),html:data.getData('text/html')}})()`);
      const previousSide = await evaluate<string>('window.klausSideSurfaceSessionId()');
      await evaluate('window.KlausSideTasks.create()');
      const sideId = await evaluate<string>('window.klausSideSurfaceSessionId()');
      assert(sideId && sideId !== previousSide, 'Card actions use an independent real side chat');
      await click('#side-input');
      await evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',window.__richInputCopy.text);data.setData('text/html',window.__richInputCopy.html);
        document.getElementById('side-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
        window.klausSideComposerAddSelection(${JSON.stringify(quote)})})()`);
      await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(previousSide)})`);
      await evaluate(`window.KlausSideTasks.activateById(${JSON.stringify(sideId)})`);
      await cardActions(true);
      await switchTo(sessionId);
    });
    await scenario('pending side input promotes once and queued editing preserves its real host owner', async () => {
      await switchTo(sessionId); await draft({ text: '', document: authoredDocument() });
      await evaluate(`(()=>{const el=document.getElementById('input');el.setSelectionRange(0,el.value.length);const data=new DataTransfer();
        el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));window.__richInputCopy={text:data.getData('text/plain'),html:data.getData('text/html')};
        const original=window.klaus.session.createSideTask;window.__sideCreationGate={ready:false,release:null,restore:()=>{window.klaus.session.createSideTask=original}};
        window.klaus.session.createSideTask=async(...args)=>{const result=await original(...args);window.__sideCreationGate.ready=true;
          await new Promise(done=>window.__sideCreationGate.release=done);return result};void window.KlausSideTasks.create()})()`);
      try {
        await waitFor(() => evaluate('window.__sideCreationGate.ready'), 10000, 'The real side fork waits before promotion');
        await click('#side-input');
        await evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',window.__richInputCopy.text);data.setData('text/html',window.__richInputCopy.html);
          document.getElementById('side-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
          window.klausSideComposerAddSelection(${JSON.stringify(quote)})})()`);
        const path = await addStoredPaste(true), before = await inputState('#side-input');
        assertEqual(before.tokens.length, 3, 'Pending input owns both resource identities and its quote');
        const sends = (await calls('send')).length;
        await click('#side-input'); await key('Return');
        assertEqual((await calls('send')).length, sends, 'An unresolved side owner cannot send');
        await evaluate('window.__sideCreationGate.release()');
        await waitFor(() => evaluate('Boolean(window.klausSideSurfaceSessionId())&&!document.getElementById("side-send").disabled'), 15000, 'Promotion establishes the real side input owner');
        const sideId = await evaluate<string>('window.klausSideSurfaceSessionId()');
        assertDeepEqual(await inputState('#side-input'), before, 'Promotion preserves the exact pending document');
        assertEqual(await evaluate('document.querySelector("#side-previews .kls-paste-card").dataset.pastePath'), path, 'Promotion preserves the pending stored card');
        const entered = provider!.entered(); provider!.holdNext();
        try {
          await click('#side-input'); await key('Return');
          await waitFor(() => provider!.entered() === entered + 1, 30000, 'The promoted side request reaches the actual provider');
          await runtime!.window.webContents.insertText('SIDE_QUEUE_EDIT');
          await evaluate(`window.klausSideComposerAddSelection(${JSON.stringify(quote)})`);
          const queuedPath = await addStoredPaste(true);
          const queuedInput = await inputState('#side-input');
          await click('#side-input'); await key('Return');
          await waitFor(async () => (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sideId)})`)).snapshot.items.length === 1, 10000, 'The side request is durably queued');
          const original = (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sideId)})`)).snapshot.items[0].item;
          await click('#side-input'); await key('Up');
          await waitFor(() => evaluate('document.getElementById("side-input").value.startsWith("SIDE_QUEUE_EDIT")'), 10000, 'Empty Up edits the owning side queue row');
          assertDeepEqual(await inputState('#side-input'), queuedInput, 'Queued Edit preserves its document and quote identity');
          assertEqual(await evaluate('document.querySelector("#side-previews .kls-paste-card").dataset.pastePath'), queuedPath, 'Queued Edit preserves its durable stored card');
          await click('#side-input'); await key('Return');
          await waitFor(async () => (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sideId)})`)).snapshot.items.length === 1, 10000, 'Edited side input returns to its own queue');
          const resent = (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(sideId)})`)).snapshot.items[0].item;
          assertDeepEqual({ ...resent, id: null, createdAt: null }, { ...original, id: null, createdAt: null }, 'Side Edit and resend preserve queued content while renewing its admission identity');
          assertEqual(readFileSync(queuedPath, 'utf8'), pasted, 'Queued side bytes remain readable');
          await click('#side-send');
          await waitFor(() => evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(sideId)}]?.running===false`), 15000, 'The side turn stops in its own owner');
          const sent = (await calls('send')).filter(row => row.args[0] === sideId)[0];
          assertEqual(sent.args[3].selectedTextAttachments[0].text, quote, 'The promoted send retains exact selected text');
          assertEqual(sent.args[3].pastedCards[0].path, path, 'The promoted send retains its pending pasted file');
        } finally { provider!.release(); }
      } finally { await evaluate('window.__sideCreationGate.release?.();window.__sideCreationGate.restore()'); }
      await switchTo(sessionId);
    });
    await scenario('interrupted queued input remains complete before process shutdown', async () => {
      const created = await invoke('session:new', { workdir: root }); queueId = String(created.id);
      await switchTo(queueId); await draft('QUEUE_RESTART_HOLD');
      const entered = provider!.entered(); provider!.holdNext();
      try {
        await click('#send'); await waitFor(() => provider!.entered() === entered + 1, 30000, 'Queue owner holds a real response');
        const document = authoredDocument(); document.content.content[0]!.content[0] = { type: 'text', text: 'RESTART_QUEUE  ' };
        await draft({ text: '', document });
        await evaluate(`window.klausQuoteAddToChat(${JSON.stringify(quote)})`);
        const pasteCalls = (await calls('pastedTextCreate')).length;
        await evaluate(`window.klausPastedTextAddToChat(${JSON.stringify(pasted)})`);
        await waitFor(async () => { const rows = await calls('pastedTextCreate'); return rows.length === pasteCalls + 1 && rows.at(-1)?.finished && rows.at(-1)?.reply?.path; }, 10000, 'Queued pasted card is settled');
        const uploads = (await calls('uploadFile')).length;
        await nativeDrop('#input', [join(root, 'drop-directories', 'images.png'), join(root, 'drop-files', 'images.png')]);
        await waitFor(async () => { const rows = await calls('uploadFile'); return rows.length === uploads + 1 && rows.at(-1)?.finished && rows.at(-1)?.reply?.path; }, 10000, 'Queued image upload is settled');
        const queuedInput = await inputState('#input');
        await click('#input'); await key('Return');
        await waitFor(async () => (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot.items.length === 1, 10000, 'Real running input reaches durable queue admission');
        await waitFor(() => evaluate('document.getElementById("input").value===""'), 5000, 'Accepted queue input leaves an empty owning composer');
        const beforeEdit = (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot.items[0].item;
        await click('#input'); await key('Up');
        await waitFor(() => evaluate('document.getElementById("input").value.startsWith("RESTART_QUEUE")'), 10000, 'Empty Up restores the actual owning queued input');
        assertDeepEqual(await inputState('#input'), queuedInput, 'Main queued Edit restores its rich text, marks and exact inline identities');
        assertEqual(await evaluate('document.querySelector("#previews .kls-paste-card").dataset.pastePath'), beforeEdit.pastedCards[0].path, 'Main queued Edit restores its durable pasted path');
        await click('#input'); await key('Return');
        await waitFor(async () => (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot.items.length === 1, 10000, 'Edited main input returns to its owning queue');
        const afterEdit = (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot.items[0].item;
        assertDeepEqual({ ...afterEdit, id: null, createdAt: null, liveAttachments: afterEdit.liveAttachments.map(({ src, ...file }: any) => file) },
          { ...beforeEdit, id: null, createdAt: null, liveAttachments: beforeEdit.liveAttachments.map(({ src, ...file }: any) => file) }, 'Main queue Edit and resend preserve queued content and attachment identities');
        await click('#send');
        await waitFor(async () => {
          const current = await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`);
          return current.snapshot.interrupted && await evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(queueId)}]?.running===false`);
        }, 15000, 'User Stop pauses the complete row and stops its active turn');
        queueSnapshot = (await evaluate(`window.klaus.chat.clientQueueSnapshot(${JSON.stringify(queueId)})`)).snapshot;
        assertEqual(queueSnapshot.items.length, 1, 'One paused row retains its durable identity');
        const item = queueSnapshot.items[0].item;
        assert(item.displayText.startsWith('RESTART_QUEUE  '), 'Queued authored whitespace is retained');
        assertEqual(item.selectedTextAttachments[0].text, quote, 'Queued selected-text content remains exact');
        assertEqual(item.pastedCards.length, 1, 'Queued input retains its pasted-text reference');
        assertEqual(item.media.length, 1, 'Queued input retains one ordinary image');
        assert(item.liveAttachments.some((entry: any) => entry.path === join(root, 'drop-directories', 'images.png') + '/'), 'Queued input retains its directory path');
      } finally { provider!.release(); }
      await switchTo(sessionId);
    });
    await scenario('normal shutdown checkpoints independent durable drafts without recreating their input', async () => {
      const mainDocument = authoredDocument(); mainDocument.content.content[0]!.content[0] = { type: 'text', text: 'RESTART_MAIN  ' };
      await draft({ text: '', document: mainDocument });
      await evaluate(`window.klausQuoteAddToChat(${JSON.stringify(quote)})`);
      await nativeDrop('#input', [join(root, 'archived-owned')]);
      const main = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_drafts'))[${JSON.stringify(sessionId)}]`);
      const mainVisibleText = await evaluate('document.getElementById("input").value');
      const recallHistory = await evaluate(`JSON.parse(localStorage.getItem('klaus_session_histories'))[${JSON.stringify(sessionId)}]`);
      await click('#btn-new-chat');
      const welcomeDocument = authoredDocument(); welcomeDocument.content.content[0]!.content[0] = { type: 'text', text: 'RESTART_WELCOME  ' };
      await draft({ text: '', document: welcomeDocument });
      const welcome = await evaluate('({text:document.getElementById("input").value,document:JSON.parse(localStorage.getItem("klaus_welcome_draft_document"))})');
      assertEqual(await evaluate('Array.from(document.querySelectorAll("#previews .kls-attach-chip-name")).map(el=>el.textContent).join()'), 'welcome-owned', 'The independent runtime welcome tray remains intact before shutdown');
      const messages = await userMessages();
      const last = messages.at(-1), prepared = await evaluate(`window.klaus.chat.editPrepare(${JSON.stringify(sessionId)},${JSON.stringify(last.uuid)},${JSON.stringify(last.turnId)})`);
      const expected = { processId: process.pid, enginePid: runtime!.engine.inspect()[0]?.pid, sessionId, otherId, archivedId, archivedMetadata,
        main, mainVisibleText, recallHistory, welcome, mainMessages: messages.map(row => row.localRender), queueId, queueSnapshot,
        pastedCards: messages.flatMap(row => row.localRender?.pastedCards || []), imagePath: prepared.attachments.find((entry: any) => entry.mimeType === 'image/png').path };
      assert(expected.enginePid, 'The first process owns an identified engine child');
      writeFileSync(join(root, 'composer-restart-expectations.json'), JSON.stringify(expected, null, 2));
      writeFileSync(join(logs, 'restart-expectations.json'), JSON.stringify(expected, null, 2));
      runtime!.window.webContents.session.flushStorageData();
    });
    }
  } catch (error) {
    if (!(error instanceof FixtureBail)) await h.test('composer lifecycle setup', () => { throw error; });
  } finally {
    provider?.release();
    await diagnostics('final').catch(error => { process.stderr.write('Diagnostics: ' + String(error) + '\n'); });
    try { await runtime?.shutdown(); } catch (error) { await h.test('runtime cleanup', () => { throw error; }); }
    try { await provider?.close(); } catch (error) { await h.test('provider cleanup', () => { throw error; }); }
    app.exit(await h.finish(join(logs, 'results.json'), phase === 'restore' ? 'composer-lifecycle-restart' : 'composer-lifecycle-app'));
  }
})();
