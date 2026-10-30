const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, protocol, screen } = require('electron');
const { DesktopPetRuntime } = require('../dist/main/app/desktop-pet');
const { PetComposer, registerPetComposerHandlers } = require('../dist/main/pets/composer');
const { DesktopPetActivity } = require('../dist/main/pets/activity');
const { DesktopPetVoice, registerDesktopPetVoiceHandlers } = require('../dist/main/pets/voice');
const { createMainWindow, createPetWindow } = require('../dist/main/app/windows');
const { registerDesktopPetHandlers } = require('../dist/main/ipc/handlers/desktop-pet');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { RoleTable } = require('../dist/main/ipc/contract');
const { IpcRouter } = require('../dist/main/ipc/router');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const { registerAppScheme } = require('../dist/main/app/protocol');
const { BUILT_IN_PETS } = require('../dist/contracts/desktop-pet-builtins');

const logs = process.argv[2];
if (!logs || !path.isAbsolute(logs)) throw Error('An absolute companion test artifact directory is required');
const profile = fs.mkdtempSync(path.join(logs, 'isolated-profile-'));
const desktop = path.resolve(__dirname, '..');
app.setPath('userData', path.join(profile, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const trace = [], results = [], responses = [], submitted = [], messageSubmissions = [], opened = [], owned = new Map();
const progress = (event, detail) => { const row = { at: Date.now(), event, detail }; trace.push(row); fs.appendFileSync(path.join(logs, 'progress.jsonl'), `${JSON.stringify(row)}\n`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  throw Error(`Timed out: ${label}`);
}
async function test(name, action) {
  progress('test-start', name);
  try { await action(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }); console.error(`  FAIL ${name}\n${error.stack || error}`); }
  progress('test-end', results.at(-1));
}
let runtime, activity, composer, voice, settings, pet, latestMenu;
let voiceAvailable = false;
let voiceStartGate;
const voiceCaptures = [], voiceFrames = [], voiceCancels = [], voiceTurns = [], voiceSends = [], voiceInterrupts = [], voiceSpeech = [], voiceEvents = [];
function speechWav(seconds = 1.8) {
  const rate = 16000, count = Math.round(rate * seconds), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 1000), 44 + index * 2);
  return bytes;
}
const petJs = source => pet.webContents.executeJavaScript(source, true);
const settingsJs = source => settings.webContents.executeJavaScript(source, true);
const selector = id => `[data-request-id=${JSON.stringify(id)}]`;
const click = async (query, window = pet) => window.webContents.executeJavaScript(`(() => { const element=document.querySelector(${JSON.stringify(query)}); if(!element) throw Error('Missing element '+${JSON.stringify(query)}); element.click(); })()`, true);
async function change(query, value, window = pet) {
  await window.webContents.executeJavaScript(`(() => { const element=document.querySelector(${JSON.stringify(query)});if(!element)throw Error('Missing input');const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true})); })()`, true);
}
async function capture(name, window = pet) { await wait(120); fs.writeFileSync(path.join(logs, `${name}.png`), (await window.webContents.capturePage()).toPNG()); progress('capture', name); }
function start(id, title) { activity.remember({ id, title, cwd: '/fixture/project' }); activity.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId: id, submissionId: `${id}-submission`, detail: { turnId: `${id}-turn` } } }); }
async function expectRequest(id) {
  await until(() => petJs(`Boolean(document.querySelector(${JSON.stringify(selector(id))}))`), `inline request ${id}`);
  await until(() => petJs(`(() => {const element=document.querySelector(${JSON.stringify(selector(id)+' button.primary')});if(!element)return true;const rect=element.getBoundingClientRect();return rect.y>=0&&rect.bottom<=innerHeight;})()`), `inline request ${id} actions fit the renderer viewport`);
  await wait(120);
}
function emit(channel, value) {
  for (const [id, window] of owned) if (!window.isDestroyed() && RoleTable.load().mayListen(window === pet ? 'pet' : 'main', channel)) window.webContents.send(`ipc:${channel}`, { args: [value] });
}
const deadline = setTimeout(() => { progress('timeout', { results }); console.error('Desktop companion GUI fixture timed out'); app.exit(1); }, 140_000);
app.whenReady().then(async () => {
  const registry = new ChannelRegistry(), roles = new Map(), roleTable = RoleTable.load();
  const router = new IpcRouter({ registry, roles: roleTable, onRoute: event => progress('ipc', event) });
  let privilegedCalls = 0, shortcut = '', selectedFile = path.join(logs, 'pets/klaus.webp');
  registry.register('session:list', () => { privilegedCalls++; return []; }, 'fixture');
  registry.register('files:list', () => { privilegedCalls++; return []; }, 'fixture');
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => handleCoreInvoke({ roleOf: id => roles.get(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args));
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
  protocol.handle('klaus-app', request => {
    const url = new URL(request.url), filename = path.resolve(logs, `.${decodeURIComponent(url.pathname)}`), relative = path.relative(logs, filename);
    if (url.hostname !== 'app' || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('forbidden', { status: 403 });
    try { return new Response(fs.readFileSync(filename), { headers: { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' } }); }
    catch { return new Response('not found', { status: 404 }); }
  });
  protocol.handle('klaus-pet', async request => {
    try { const url = new URL(request.url); const asset = await runtime.asset(decodeURIComponent(url.pathname.slice(1))); return new Response(Buffer.from(asset.bytes), { headers: { 'Content-Type': asset.mime } }); }
    catch { return new Response('not found', { status: 404 }); }
  });
  const addonFile = path.join(desktop, 'native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`), addon = require(addonFile);
  const pointer = addon.pointerButtons?.(); progress('native-addon', { path: addonFile, pointer, configure: typeof addon.configurePetPanel, focus: typeof addon.focusPetPanel });
  activity = new DesktopPetActivity({ isPrivate: id => id === 'private', changed: tasks => runtime?.setTasks(tasks) });
  voice = new DesktopPetVoice({
    owns: ownerId => runtime?.ownsWebContents(ownerId) ?? false,
    visible: () => runtime?.snapshot().visible ?? false,
    available: async () => ({ available: voiceAvailable, ...(!voiceAvailable ? { reason: 'Realtime voice is not available until speech sources are configured.' } : {}) }),
    recognition: {
      start: async (ownerId, captureId, signal) => { assert.equal(signal.aborted, false); voiceCaptures.push({ ownerId, captureId }); progress('voice-capture-start', captureId); if (voiceStartGate) await voiceStartGate.promise; },
      audio: async (ownerId, captureId, frame) => { voiceFrames.push({ ownerId, captureId, seq: frame.seq }); },
      stop: async (ownerId, captureId) => { voiceTurns.push({ ownerId, captureId }); },
      cancel: async (ownerId, captureId) => { voiceCancels.push({ ownerId, captureId }); },
    },
    conversation: {
      create: async () => 'voice-session',
      send: async (sessionId, text, responseId, signal) => { assert.equal(signal.aborted, false); const value = { sessionId, text, responseId, turnId: `voice-turn-${voiceSends.length + 1}` }; voiceSends.push(value); return { turnId: value.turnId }; },
      interrupt: async (sessionId, turnId) => { voiceInterrupts.push({ sessionId, turnId }); },
    },
    speech: { synthesize: async (sessionId, text, signal) => { assert.equal(signal.aborted, false); voiceSpeech.push({ sessionId, text }); return { url: `data:audio/wav;base64,${speechWav().toString('base64')}` }; } },
    emit: (ownerId, event) => { voiceEvents.push(event); progress('voice-event', event.type === 'audio' ? { ...event, url: 'fixture-audio' } : event); owned.get(ownerId)?.webContents.send('ipc:desktop-pet:voice-event', { args: [event] }); },
    log: message => progress('voice-log', message),
  });
  runtime = new DesktopPetRuntime({ dataDirectory: path.join(profile, 'klaus'), pageUrl: 'klaus-app://app/pet.html',
    builtIns: BUILT_IN_PETS.map(value => ({ ...value, spritesheetUrl: `klaus-app://app${value.spritesheetUrl}` })),
    createWindow: () => {
      pet = createPetWindow();
      if (process.platform === 'darwin') assert.equal(addon.configurePetPanel(pet.getNativeWindowHandle()), true, 'native panel configuration');
      const original = pet.setIgnoreMouseEvents.bind(pet); pet.setIgnoreMouseEvents = (ignore, options) => { progress('pointer-mode', { ignore, options }); return original(ignore, options); };
      pet.webContents.on('console-message', (_event, ...args) => progress('pet-console', args));
      pet.webContents.on('render-process-gone', (_event, value) => progress('pet-renderer-exit', value));
      return pet;
    },
    focusWindow: (window, active) => {
      if (process.platform !== 'darwin') return false;
      window.setFocusable(active);
      assert.equal(addon.configurePetPanel(window.getNativeWindowHandle()), true, 'native panel reconfiguration');
      return addon.focusPetPanel(window.getNativeWindowHandle(), active);
    },
    registerOwner: window => { roles.set(window.webContents.id, 'pet'); owned.set(window.webContents.id, window); },
    unregisterOwner: id => { roles.delete(id); owned.delete(id); },
    broadcast: value => emit('desktop-pet:state', value), emit,
    readShortcut: () => shortcut, writeShortcut: async value => { shortcut = value; },
    openMain: () => settings.show(), openSettings: () => settings.show(), openTask: id => { opened.push(id); activity.acknowledge(id); },
    submit: async text => { submitted.push(text); }, pickFile: async () => selectedFile,
    openDirectory: async directory => progress('open-directory', directory), createPet: async directory => progress('create-pet', directory),
    acknowledgeTask: id => activity.acknowledge(id), dismissTask: id => activity.dismiss(id),
    voice,
    visibilityChanged: (ownerId, visible) => { if (!visible) void voice.release(ownerId); },
    respondTask: async (taskId, requestId, response) => {
      responses.push({ taskId, requestId, response: structuredClone(response) });
      activity.input(requestId === 'question' ? 'question:resolved' : requestId.startsWith('mcp') ? 'elicit:resolved' : 'permission:resolved', { sessionId: taskId, requestId, turnId: `${taskId}-turn`, state: 'answered' });
      return { ok: true };
    },
    log: value => progress('runtime', value),
  });
  registerDesktopPetHandlers(registry, runtime);
  registerDesktopPetVoiceHandlers(registry, voice);
  const attachmentFile = path.join(profile, 'release-note.txt'); fs.writeFileSync(attachmentFile, 'Release checks are ready for review.');
  composer = new PetComposer({ owns: id => runtime.ownsWebContents(id), visible: () => runtime.snapshot().visible, root: path.join(profile, 'klaus'),
    pickFiles: async () => [attachmentFile],
    screenshots: async () => [{ id: 'settings', name: 'Companion settings', previewUrl: (await settings.webContents.capturePage()).toDataURL() }],
    capture: async source => { assert.equal(source, 'settings'); return (await settings.webContents.capturePage()).toPNG(); },
    submit: async value => { submitted.push(value.text); messageSubmissions.push(value); },
  });
  registerPetComposerHandlers(registry, composer);
  settings = createMainWindow('Klaus companion settings test'); roles.set(settings.webContents.id, 'main'); owned.set(settings.webContents.id, settings);
  settings.webContents.on('console-message', (_event, ...args) => progress('settings-console', args));
  await runtime.initialize(); await settings.loadURL('klaus-app://app/settings.html');
  await until(() => settingsJs('document.querySelectorAll(".pet-settings-tile").length>=10'), 'actual settings tab mounted');
  await test('production settings tab loads nine decoded built-in sprite sheets', async () => {
    const state = await settingsJs('window.klausPet.getState()'); assert.equal(state.catalog.filter(value => value.builtIn).length, 9);
    const images = await settingsJs(`Promise.all((${JSON.stringify(state.catalog)}).filter(value=>value.builtIn).map(value=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({id:value.id,width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(Error(value.id));image.src=value.spritesheetUrl;})))`);
    assert.equal(images.length, 9); for (const value of images) assert.deepEqual([value.width, value.height], [1536, 2288]);
    progress('sprite-decode', images); settings.showInactive(); await wait(800);
    const sprite = await settingsJs(`(() => {const element=document.querySelector('.pet-preview .pet-sprite')||document.querySelector('.pet-sprite');const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},backgroundImage:style.backgroundImage,backgroundSize:style.backgroundSize,backgroundPosition:style.backgroundPosition,display:style.display,visibility:style.visibility,opacity:style.opacity}})()`);
    progress('sprite-style', sprite); await capture('settings-wide', settings);
    const sample = await settings.webContents.capturePage({ x: Math.floor(sprite.rect.x), y: Math.floor(sprite.rect.y), width: Math.floor(sprite.rect.width), height: Math.floor(sprite.rect.height) });
    const bitmap = sample.toBitmap(); let colored = 0;
    for (let offset=0;offset+3<bitmap.length;offset+=4) if (Math.max(bitmap[offset],bitmap[offset+1],bitmap[offset+2])-Math.min(bitmap[offset],bitmap[offset+1],bitmap[offset+2])>40 && bitmap[offset+3]>100) colored++;
    progress('sprite-painted-pixels', { colored, size: sample.getSize() }); assert.ok(colored>20, 'the decoded sprite is visibly painted in settings');
  });
  await runtime.show(); await until(() => pet && pet.isVisible(), 'pet renderer ready and layout accepted');
  await until(() => petJs('Boolean(document.querySelector(".pet-bar"))'), 'actual companion renderer');
  await test('role-scoped preload and router reject conversation and file privileges', async () => {
    assert.deepEqual(await petJs('({node:typeof require,bridge:Boolean(window.__KLAUS_DESKTOP__),windowBridge:Boolean(window.__KLAUS_DESKTOP__.window)})'), { node: 'undefined', bridge: true, windowBridge: false });
    for (const channel of ['session:list', 'files:list']) {
      const refused = await petJs(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',{channel:${JSON.stringify(channel)},args:[]}).then(()=>({allowed:true}),error=>({allowed:false,code:error.error?.code}))`);
      assert.equal(refused.allowed, false); assert.equal(refused.code, 'FORBIDDEN_CHANNEL');
    }
    assert.equal(privilegedCalls, 0);
  });
  await test('renderer layout, pointer regions and native panel focus use valid API envelopes', async () => {
    assert.ok(runtime.snapshot().layout.viewport.width > 100); assert.ok(trace.some(row => row.event === 'ipc' && row.detail.channel === 'desktop-pet:set-regions' && row.detail.result === 'null'));
    assert.equal(typeof pointer, 'number');
    await petJs('window.klausPet.setKeyboard(true)'); await until(() => pet.isFocused(), 'native companion accepts keyboard focus');
    await petJs('window.klausPet.setKeyboard(false)');
    const error = await settingsJs('window.klausPet.setRegions([]).then(()=>null,error=>error.message)'); assert.match(error, /own|owned/i);
    assert.equal(trace.find(row => row.event === 'pointer-mode')?.detail.ignore, true, 'the window starts with mouse passthrough until hit regions are published');
  });
  await test('settings controls show, hide, resize and select the bar-only option', async () => {
    await change('#pet-size', '152', settings); await until(() => runtime.snapshot().settings.size === 152, 'settings size persisted');
    await settingsJs(`Array.from(document.querySelectorAll('.pet-settings-tile')).find(button=>button.querySelector('strong')?.textContent==='None').click()`);
    await until(() => runtime.snapshot().settings.showPet === false, 'bar-only setting persisted');
    await until(() => petJs('!document.querySelector(".pet-sprite")'), 'bar-only renderer'); await capture('bar-only');
    const selectedPet = BUILT_IN_PETS[2]; assert.ok(selectedPet, 'third built-in companion exists');
    await settingsJs(`Array.from(document.querySelectorAll('.pet-settings-tile')).find(button=>button.querySelector('strong')?.textContent===${JSON.stringify(selectedPet.name)}).click()`);
    await until(() => runtime.snapshot().settings.selectedPetId === selectedPet.id && runtime.snapshot().settings.showPet, 'selected companion visible');
    await petJs('window.klausPet.hide()'); assert.equal(pet.isVisible(), false); await settingsJs('window.klausPet.show()'); await until(() => pet.isVisible(), 'pet shown from settings');
    await runtime.updateSettings({ size: 112 });
  });
  await test('running and completed task states retain titles and navigation', async () => {
    start('running', 'Inspect release checks'); await until(() => petJs('document.body.innerText.includes("Inspect release checks")'), 'running task');
    await capture('running'); activity.observeChat([{ type: 'done', sessionId: 'running', turnId: 'running-turn' }]);
    await until(() => petJs('Boolean(document.querySelector(".pet-task-completed"))'), 'completed state');
    await petJs('window.klausPet.openTask("running")'); assert.deepEqual(opened, ['running']);
    assert.equal(runtime.snapshot().tasks.some(task => task.id === 'running'), false);
  });
  await test('task notification actions mute later updates and restore the conversation from the native menu', async () => {
    start('muted-task', 'Review notification preferences'); await until(() => petJs('document.body.innerText.includes("Review notification preferences")'), 'task available for notification actions');
    await click('.pet-task-main');
    const build = Menu.buildFromTemplate; Menu.buildFromTemplate = function (template) { latestMenu = build.call(this, template); return latestMenu; };
    try {
      await click('.pet-task-detail button[aria-label="Notification actions"]'); await until(() => runtime.snapshot().menuOpen, 'task context menu opened');
      const mute = latestMenu.items.find(item => item.label === 'Mute notifications'); assert.ok(mute, 'task context exposes a notification preference'); mute.click(); latestMenu.closePopup(pet);
      await until(() => runtime.snapshot().mutedTaskIds.includes('muted-task'), 'muted conversation preference saved');
      activity.observeChat([{ type: 'done', sessionId: 'muted-task', turnId: 'muted-task-turn' }]);
      assert.equal(runtime.snapshot().tasks.some(task => task.id === 'muted-task'), false, 'later status updates remain muted');
      await petJs('window.klausPet.contextMenu()'); await until(() => runtime.snapshot().menuOpen, 'global notification recovery menu opened');
      const preferences = latestMenu.items.find(item => item.label === 'Muted notifications'); assert.ok(preferences);
      const task = preferences.submenu.items.find(item => item.label === 'Review notification preferences'); assert.ok(task); task.submenu.items.find(item => item.label === 'Unmute notifications').click(); latestMenu.closePopup(pet);
      await until(() => runtime.snapshot().tasks.some(task => task.id === 'muted-task' && task.status === 'completed'), 'unmute restores the current terminal notification');
      assert.equal(runtime.snapshot().mutedTaskIds.includes('muted-task'), false);
    } finally { Menu.buildFromTemplate = build; latestMenu?.closePopup(pet); activity.forget('muted-task'); }
  });
  await test('inline command approval responds through the owner-validated runtime', async () => {
    start('approval-task', 'Validate release build'); activity.input('permission:request', { sessionId: 'approval-task', requestId: 'approval', toolCallId: 'shell', toolName: 'Bash', message: 'Run the release validation?', toolInput: { command: 'npm run build', cwd: '/fixture/project' }, suggestions: [{ type: 'addRules', label: 'Always allow this validation', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }] }] });
    await expectRequest('approval'); assert.ok(await petJs('document.body.innerText.includes("npm run build")')); await capture('inline-approval');
    await click(`${selector('approval')} input[type=checkbox]`); await click(`${selector('approval')} button.primary`);
    await until(() => responses.some(row => row.requestId === 'approval'), 'approval response received');
    assert.deepEqual(responses.find(row => row.requestId === 'approval').response, { decision: 'allow', acceptedSuggestionIndices: [0] });
    const refused = await petJs('window.klausPet.respondTask({taskId:"approval-task",requestId:"stale",response:{decision:"allow"}}).then(()=>false,()=>true)'); assert.equal(refused, true);
    activity.forget('approval-task');
  });
  await test('large patch summaries use a real worker and retain exact counts and native approval interaction', async () => {
    const count = 20_000, oldText = Array.from({ length: count }, (_, index) => `before ${index}`).join('\n'), newText = Array.from({ length: count }, (_, index) => `after ${index}`).join('\n');
    await petJs(`(() => {const pulse={ticks:0,maxGap:0,at:performance.now(),stopped:false};window.__petVoiceFixture.pulse=pulse;function tick(){const now=performance.now();pulse.maxGap=Math.max(pulse.maxGap,now-pulse.at);pulse.at=now;pulse.ticks++;if(!pulse.stopped)requestAnimationFrame(tick)}requestAnimationFrame(tick)})()`);
    start('large-patch-task', 'Review the generated change');
    activity.input('permission:request', { sessionId: 'large-patch-task', requestId: 'large-patch', toolCallId: 'edit-large', toolName: 'Edit', message: 'Apply the generated file change?', toolInput: { file_path: '/fixture/project/large.ts', old_string: oldText, new_string: newText } });
    await expectRequest('large-patch');
    await until(() => petJs('document.querySelector(".pet-patch-additions")?.textContent==="+20000" && document.querySelector(".pet-patch-deletions")?.textContent==="−20000"'), 'exact large patch summary returned from the background worker');
    const workers = await petJs('window.__petVoiceFixture.workers'); assert.ok(workers.some(worker => worker.url.endsWith('/patch-summary.worker.ts') && worker.messages > 0), 'production approval creates and receives a real module worker');
    await wait(100); const pulse = await petJs('(() => {const value=window.__petVoiceFixture.pulse;value.stopped=true;return{ticks:value.ticks,maxGap:value.maxGap}})()'); progress('large-patch-responsiveness', pulse); assert.ok(pulse.ticks > 3); assert.ok(pulse.maxGap < 500, 'large file diff does not block renderer animation for half a second');
    await capture('inline-large-patch');
    const point = await petJs(`(() => {const element=document.querySelector(${JSON.stringify(selector('large-patch')+' button.primary')}),rect=element.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);return{x,y,hit:element.contains(document.elementFromPoint(x,y))}})()`); assert.equal(point.hit, true);
    pet.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 }); pet.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await until(() => responses.some(row => row.requestId === 'large-patch'), 'native primary action remains responsive after a large patch summary'); assert.equal(responses.find(row => row.requestId === 'large-patch').response.decision, 'allow'); activity.forget('large-patch-task');
  });
  await test('inline structured questions accept option and typed freeform answers', async () => {
    start('question-task', 'Choose release destination'); activity.input('question:requested', { sessionId: 'question-task', requestId: 'question', turnId: 'question-task-turn', toolCallId: 'ask', state: 'pending', answers: {}, toolInput: { questions: [{ question: 'Environment?', options: [{ label: 'Staging', description: 'Preview deployment' }, { label: 'Production' }], multiSelect: false }, { question: 'Release note?', options: [] }] } });
    await expectRequest('question'); await click(`${selector('question')} input[type=radio]`);
    const query = `${selector('question')} input[aria-label$="Release note?"]`;
    await petJs(`document.querySelector(${JSON.stringify(query)}).scrollIntoView({block:'nearest'})`); await wait(120);
    const point = await petJs(`(() => {const element=document.querySelector(${JSON.stringify(query)}),rect=element.getBoundingClientRect(),x=Math.round(rect.x+Math.min(20,rect.width/2)),y=Math.round(rect.y+rect.height/2);return{x,y,hit:document.elementFromPoint(x,y)===element,width:innerWidth,height:innerHeight}})()`);
    progress('inline-native-target', { point, window: pet.getBounds(), focused: pet.isFocused() }); assert.equal(point.hit, true, 'native pointer coordinates hit the current input');
    const coordinates = { x: point.x, y: point.y };
    pet.webContents.sendInputEvent({ type: 'mouseDown', ...coordinates, button: 'left', clickCount: 1 });
    pet.webContents.sendInputEvent({ type: 'mouseUp', ...coordinates, button: 'left', clickCount: 1 });
    await until(() => pet.isFocused(), 'inline question acquires native keyboard focus', 3_000);
    await until(() => petJs(`document.activeElement===document.querySelector(${JSON.stringify(query)})`), 'native key target is the inline question');
    pet.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R' }); pet.webContents.sendInputEvent({ type: 'char', keyCode: 'R' }); pet.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R' });
    await until(() => petJs(`document.querySelector(${JSON.stringify(query)}).value==='R'`), 'native typed character enters inline field');
    await change(query, 'Ready for review'); await capture('inline-question');
    await click(`${selector('question')} button.primary`); await until(() => responses.some(row => row.requestId === 'question'), 'question response received');
    assert.deepEqual(responses.find(row => row.requestId === 'question').response, { kind: 'answers', answers: { 'Environment?': 'Staging', 'Release note?': 'Ready for review' } }); activity.forget('question-task');
  });
  await test('inline MCP form preserves integer, boolean and enum values', async () => {
    start('mcp-task', 'Confirm calendar event'); activity.input('elicit:request', { sessionId: 'mcp-task', requestId: 'mcp-form', type: 'mcp-elicit', serverName: 'Calendar', message: 'Confirm the event', requestedSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', title: 'Guests', minimum: 1, maximum: 8, default: 2 }, confirmed: { type: 'boolean', default: false }, mode: { type: 'string', enum: ['draft', 'send'], default: 'draft' } } } });
    await expectRequest('mcp-form'); await change(`${selector('mcp-form')} input[type=number]`, '3'); await click(`${selector('mcp-form')} input[type=checkbox]`); await change(`${selector('mcp-form')} select`, 'send');
    await capture('inline-mcp-form'); await click(`${selector('mcp-form')} button.primary`); await until(() => responses.some(row => row.requestId === 'mcp-form'), 'form response received');
    assert.deepEqual(responses.find(row => row.requestId === 'mcp-form').response, { kind: 'accept', values: { count: 3, confirmed: true, mode: 'send' } }); activity.forget('mcp-task');
  });
  await test('quick input submission uses the production renderer bridge', async () => {
    await petJs(`Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='Ask Klaus anything…').click()`);
    await until(() => petJs('Boolean(document.querySelector(".pet-bar textarea"))'), 'composer opened');
    await change('.pet-bar textarea', 'Summarize the release checks'); await click('.pet-bar .pet-send');
    await until(() => submitted.length === 1, 'submitted to host callback'); assert.deepEqual(submitted, ['Summarize the release checks']);
  });
  await test('composer attachments and app snapshots use scoped opaque grants', async () => {
    const files = await petJs('window.klausPet.pickAttachments()');
    assert.equal(files.length, 1); assert.equal(files[0].name, 'release-note.txt'); assert.equal(files[0].kind, 'file'); assert.equal('path' in files[0], false);
    const sources = await petJs('window.klausPet.screenshotSources()'); assert.equal(sources.length, 1); assert.equal(sources[0].name, 'Companion settings');
    const image = await petJs(`window.klausPet.attachScreenshot(${JSON.stringify(sources[0].id)})`); assert.equal(image.kind, 'appshot'); assert.match(image.previewUrl, /^data:image\/png;base64,/);
    const wrongOwner = await settingsJs('window.klausPet.pickAttachments().then(()=>false,()=>true)'); assert.equal(wrongOwner, true);
    await petJs(`window.klausPet.submitMessage(${JSON.stringify({ text: 'Review the selected context', attachmentIds: [files[0].id, image.id], submissionId: 'with-context' })})`);
    const value = messageSubmissions.at(-1); assert.equal(value.text, 'Review the selected context'); assert.equal(value.files.length, 2); assert.ok(value.files.some(file => file.name === 'release-note.txt'));
    const stale = await petJs(`window.klausPet.submitMessage(${JSON.stringify({ text: 'Reuse old context', attachmentIds: [files[0].id], submissionId: 'stale-context' })}).then(()=>false,()=>true)`); assert.equal(stale, true);
  });
  await test('voice controls display the explicit unavailable capability notice', async () => {
    const state = await petJs('window.klausPet.voiceState()'); assert.equal(state.available, false); assert.equal(state.phase, 'inactive'); assert.ok(state.unavailableReason);
    await petJs(`Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='Voice chat').click()`);
    await until(() => petJs('Boolean(document.querySelector(".pet-voice-panel"))'), 'voice capability panel opened');
    await until(() => petJs('document.body.innerText.includes("Realtime voice is not available")'), 'unavailable reason displayed'); await capture('voice-capability');
    await click('.pet-voice-panel button[aria-label="Close"]');
  });
  await test('live voice controls stream owned PCM and manage microphone capture', async () => {
    voiceAvailable = true;
    await petJs(`Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='Voice chat').click()`);
    await until(() => petJs(`Boolean(document.querySelector(${JSON.stringify('.pet-voice-panel button[aria-label="Start voice chat"]:not(:disabled)')}))`), 'configured voice start control');
    await click('.pet-voice-panel button[aria-label="Start voice chat"]');
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voiceActivity==="listening"'), 'pushed active listening state');
    await until(() => voiceFrames.length > 2, 'actual AudioWorklet PCM crosses the renderer bridge');
    const initial = voiceCaptures.at(-1); assert.equal(initial.ownerId, pet.webContents.id);
    const sequence = voiceFrames.filter(frame => frame.captureId === initial.captureId).map(frame => frame.seq);
    assert.deepEqual(sequence, Array.from({ length: sequence.length }, (_, index) => index + 1));
    await click('.pet-voice-panel button[aria-label="Mute microphone"]');
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voiceActivity==="muted"'), 'pushed microphone muted state');
    await until(() => petJs('window.__petVoiceFixture.streams.every(value=>value.stopped)'), 'muting releases every renderer microphone track');
    assert.ok(voiceCancels.some(value => value.captureId === initial.captureId));
    await click('.pet-voice-panel button[aria-label="Unmute microphone"]');
    await until(() => voiceCaptures.length >= 2 && voiceCaptures.at(-1).captureId !== initial.captureId, 'unmute obtains a new capture lease');
    await until(() => voiceFrames.some(frame => frame.captureId === voiceCaptures.at(-1).captureId), 'new capture streams fresh PCM');
    await capture('voice-listening');
  });
  await test('live voice transcription and real audio callbacks drive speaking and completion', async () => {
    const captureId = voiceCaptures.at(-1).captureId;
    await petJs(`Array.from(document.querySelectorAll('.pet-voice-footer button')).find(button=>button.textContent.trim()==='Send spoken message').click()`);
    await until(() => voiceTurns.some(value => value.captureId === captureId), 'manual voice turn drains microphone audio');
    voice.receiveRecognition({ sessionId: captureId, type: 'partial', seq: 1, text: 'Read the release' });
    await until(() => petJs('document.querySelector(".pet-voice-transcript")?.innerText.includes("Read the release")'), 'partial transcript pushed into the actual renderer');
    voice.receiveRecognition({ sessionId: captureId, type: 'final', seq: 2, text: 'Read the release summary' });
    await until(() => voiceSends.length === 1, 'recognized utterance submitted to the owned conversation');
    assert.equal(voiceSends[0].text, 'Read the release summary'); assert.equal(voiceSends[0].sessionId, 'voice-session');
    const turnId = voiceSends[0].turnId;
    voice.observeChat([{ type: 'text_delta', sessionId: 'voice-session', turnId, phase: 'final_answer', text: 'The release checks are ready.' }, { type: 'done', sessionId: 'voice-session', turnId }]);
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voiceActivity==="speaking"'), 'real HTMLAudio started callback acknowledges speaking');
    assert.equal(voiceSpeech[0].text, 'The release checks are ready.');
    await until(() => petJs('document.querySelector(".pet-voice-transcript")?.innerText.includes("The release checks are ready.")'), 'assistant transcript pushed');
    await click('.pet-voice-panel button[aria-label="Mute audio"]');
    await until(() => petJs('window.__petVoiceFixture.outputs.at(-1).muted===true'), 'speaker control mutes the active HTMLAudio element');
    await click('.pet-voice-panel button[aria-label="Unmute audio"]');
    await until(() => petJs('window.__petVoiceFixture.outputs.at(-1).muted===false'), 'speaker control unmutes the active HTMLAudio element');
    await capture('voice-speaking');
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voiceActivity==="listening"'), 'real HTMLAudio ended callback restores listening');
    const callbacks = trace.filter(row => row.event === 'ipc' && row.detail.channel === 'desktop-pet:voice-playback');
    assert.ok(callbacks.length >= 2, 'actual started and ended acknowledgements cross the owned channel');
    assert.equal(await petJs('window.__petVoiceFixture.outputs.at(-1).getAttribute("src")'), null, 'completed audio releases its source');
    await petJs(`Array.from(document.querySelectorAll('.pet-voice-footer button')).find(button=>button.textContent.trim()==='Open conversation').click()`);
    await until(() => opened.includes('voice-session'), 'voice conversation navigates through the production runtime without an activity card');
  });
  await test('live voice interruption and stop release audio and capture resources', async () => {
    const captureId = voiceCaptures.at(-1).captureId;
    voice.receiveRecognition({ sessionId: captureId, type: 'final', seq: 1, text: 'Read another update' });
    await until(() => voiceSends.length === 2, 'second utterance submitted');
    const turnId = voiceSends[1].turnId;
    voice.observeChat([{ type: 'text_delta', sessionId: 'voice-session', turnId, phase: 'final_answer', text: 'The next update contains additional details.' }, { type: 'done', sessionId: 'voice-session', turnId }]);
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voiceActivity==="speaking"'), 'second audio playback began');
    await petJs(`Array.from(document.querySelectorAll('.pet-voice-footer button')).find(button=>button.textContent.trim()==='Interrupt').click()`);
    await until(() => voiceInterrupts.some(value => value.turnId === turnId), 'interrupt reaches the owned engine turn');
    await until(() => petJs('window.__petVoiceFixture.outputs.at(-1).paused && window.__petVoiceFixture.outputs.at(-1).getAttribute("src")===null'), 'interrupt closes active audio');
    const oldGeneration = (await voice.state()).generation;
    await click('.pet-voice-panel button[aria-label="End voice chat"]');
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voicePhase==="inactive"'), 'pushed stop state');
    await until(() => petJs('window.__petVoiceFixture.streams.every(value=>value.stopped)'), 'stop releases every capture stream');
    const state = await voice.state(); assert.ok(state.generation > oldGeneration); assert.equal(state.capture, undefined); assert.equal(state.responseId, undefined);
    const stale = await petJs(`window.klausPet.voiceInterrupt({generation:${oldGeneration},reason:'manual'}).then(()=>false,()=>true)`); assert.equal(stale, true, 'retired generation cannot interrupt another call');
    const wrongOwner = await settingsJs('window.klausPet.startVoice().then(()=>false,()=>true)'); assert.equal(wrongOwner, true, 'settings renderer cannot own voice capture');
    assert.equal(voiceEvents.some(event => event.type === 'error'), false);
    await capture('voice-stopped'); await click('.pet-voice-panel button[aria-label="Close"]');
  });
  await test('voice startup remains cancellable while recognition permission is pending', async () => {
    let resume; voiceStartGate = { promise: new Promise(resolve => { resume = resolve; }) };
    const oldCaptures = voiceCaptures.length, oldStreams = await petJs('window.__petVoiceFixture.streams.length');
    await petJs(`Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='Voice chat').click()`);
    await click('.pet-voice-panel button[aria-label="Start voice chat"]');
    await until(() => voiceCaptures.length > oldCaptures && petJs('document.querySelector(".pet-voice-panel")?.dataset.voicePhase==="connecting"'), 'recognition startup pending');
    const stop = '.pet-voice-panel button[aria-label="End voice chat"]';
    assert.equal(await petJs(`Boolean(document.querySelector(${JSON.stringify(stop)})&&!document.querySelector(${JSON.stringify(stop)}).disabled)`), true, 'stop remains available during startup');
    await click(stop);
    await until(() => petJs('document.querySelector(".pet-voice-panel")?.dataset.voicePhase==="inactive"'), 'pending startup cancelled immediately');
    resume(); voiceStartGate = undefined; await wait(200);
    assert.equal((await voice.state()).phase, 'inactive'); assert.equal(await petJs('window.__petVoiceFixture.streams.length'), oldStreams, 'late recognition start cannot create a microphone stream');
    assert.equal(await petJs('document.querySelector(".pet-voice-panel")?.dataset.voicePhase'), 'inactive', 'late start action cannot overwrite the stopped renderer');
    await capture('voice-cancelled-start'); await click('.pet-voice-panel button[aria-label="Close"]');
  });
  await test('dragging and resizing retain usable native viewport bounds at display edges', async () => {
    activity.clearCompleted(); const display = screen.getDisplayMatching(pet.getBounds()), area = display.workArea, layout = runtime.snapshot().layout, current = pet.getBounds();
    const initial = { screenX: current.x + layout.pet.x + layout.pet.width / 2, screenY: current.y + layout.pet.y + layout.pet.height / 2 };
    await petJs(`window.klausPet.dragStart(${JSON.stringify(initial)})`);
    await petJs(`window.klausPet.dragMove(${JSON.stringify({ screenX: area.x + area.width + 300, screenY: area.y + area.height + 300 })})`);
    await petJs(`window.klausPet.dragEnd(${JSON.stringify({ screenX: area.x + area.width + 300, screenY: area.y + area.height + 300 })})`); await wait(150);
    const bounds = pet.getBounds(); progress('edge-bounds', { bounds, area, layout: runtime.snapshot().layout });
    assert.ok(bounds.x >= area.x && bounds.y >= area.y, 'viewport begins inside work area');
    assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, 'viewport actions remain inside work area');
    await capture('edge-placement');
  });
  await test('custom pet file import loads through the dedicated asset scheme', async () => {
    await petJs('window.klausPet.importFile()'); const entry = runtime.snapshot().catalog.find(value => !value.builtIn); assert.ok(entry); assert.match(entry.spritesheetUrl, /^klaus-pet:\/\/local\//);
    assert.deepEqual(await petJs(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve([image.naturalWidth,image.naturalHeight]);image.onerror=()=>reject(Error('custom sprite'));image.src=${JSON.stringify(entry.spritesheetUrl)};})`), [1536, 2288]);
    await capture('custom-pet'); await petJs(`window.klausPet.deletePet(${JSON.stringify(entry.id)})`); assert.equal(runtime.snapshot().catalog.some(value => value.id === entry.id), false);
  });
  await test('native context menu opens and closes without losing the floating surface', async () => {
    const build = Menu.buildFromTemplate; Menu.buildFromTemplate = function (template) { latestMenu = build.call(this, template); return latestMenu; };
    try { await petJs('window.klausPet.contextMenu()'); await until(() => runtime.snapshot().menuOpen, 'native menu opened'); assert.ok(latestMenu.items.some(item => item.label === 'Settings')); latestMenu.closePopup(pet); await until(() => !runtime.snapshot().menuOpen, 'native menu closed'); }
    finally { Menu.buildFromTemplate = build; latestMenu?.closePopup(pet); }
    assert.equal(pet.isVisible(), true);
  });
  await test('settings screenshot adapts to a narrow window and customization dialog', async () => {
    settings.show(); settings.setContentSize(800, 900); await wait(150); await capture('settings-narrow', settings);
    await settingsJs(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Customize pet').click()`);
    await until(() => settingsJs('Boolean(document.querySelector("dialog[open]"))'), 'customization dialog opened'); await capture('settings-customize', settings);
  });
  await capture('final-pet');
  const errors = trace.filter(row => row.event === 'ipc' && row.detail.result?.startsWith('Err') && !['session:list', 'files:list'].includes(row.detail.channel));
  fs.writeFileSync(path.join(logs, 'results.json'), JSON.stringify({ passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length, results, responses, submitted, errors, native: { pointer, panel: typeof addon.configurePetPanel }, trace }, null, 2));
  const passed = results.filter(row => row.ok).length, failed = results.filter(row => !row.ok).length;
  console.log(`desktop-pet-electron: ${passed} passed, ${failed} failed`); progress('complete', { passed, failed });
  clearTimeout(deadline); activity.close(); composer.close(); await voice.close(); await runtime.shutdown(); settings.destroy(); app.exit(failed ? 1 : 0);
}).catch(async error => {
  progress('fatal', error.stack || String(error)); console.error(error);
  try { if (pet && !pet.isDestroyed()) await capture('failure'); } catch {}
  fs.writeFileSync(path.join(logs, 'fatal.json'), JSON.stringify({ error: error.stack || String(error), trace, results }, null, 2));
  clearTimeout(deadline); activity?.close(); composer?.close(); try { await runtime?.shutdown(); } catch {} app.exit(1);
});
