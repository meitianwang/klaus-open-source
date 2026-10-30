const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, protocol, screen } = require('electron');
const { DesktopShortcuts } = require('../dist/main/app/shortcuts');
const { DesktopPetRuntime } = require('../dist/main/app/desktop-pet');
const { createMainWindow, createPetWindow } = require('../dist/main/app/windows');
const { beginNativePetWindowDrag, observeNativePetOutsideClicks } = require('../dist/main/app/pet-pointer');
const { registerDesktopPetHandlers } = require('../dist/main/ipc/handlers/desktop-pet');
const { PetComposer, registerPetComposerHandlers } = require('../dist/main/pets/composer');
const { DesktopPetRealtime, registerPetRealtimeHandlers } = require('../dist/main/pets/realtime');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { RoleTable } = require('../dist/main/ipc/contract');
const { IpcRouter } = require('../dist/main/ipc/router');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const { registerAppScheme } = require('../dist/main/app/protocol');
const { BUILT_IN_PETS } = require('../dist/contracts/desktop-pet-builtins');
const vector = require('../contracts/vectors/desktop-pet-window-vectors.json');

const logs = process.argv[2];
assert(logs && path.isAbsolute(logs));
const profile = path.join(logs, 'profile');
app.setPath('userData', path.join(profile, 'electron'));
registerAppScheme(); app.on('window-all-closed', () => {});
const trace = (event, detail) => fs.appendFileSync(path.join(logs, 'presentation.jsonl'), `${JSON.stringify({ event, detail })}\n`);
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
  trace(event, error?.stack || String(error)); console.error(error); app.exit(1);
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  throw Error(`Timed out: ${label}`);
}
let pet, main, runtime, composer, realtime, shortcuts, foreign, expectedBounds, passed = 0, shortcutCalls = 0, mainOpens = 0, outsideClicks = 0;
const foreignEvents = [];
app.on('will-quit', () => { shortcuts?.close(); foreign?.kill(); });
process.on('exit', () => foreign?.kill());
const calls = [], errors = [], roles = new Map(), submissions = [], menus = [];
let releaseSubmission, rejectSubmission, holdSubmission = false;
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => { menus.push(template.map(item => ({label:item.label,type:item.type}))); trace('menu',menus.at(-1)); return buildMenu(template); };
const conversationMessages = [{ id: 'selected-user', role: 'user', text: 'Hello from the selected conversation' }, { id: 'selected-assistant', role: 'assistant', text: 'Reply from the selected conversation' }];
const evaluate = source => pet.webContents.executeJavaScript(source, true);
function pass(name) { passed++; console.log(`PASS: ${name}`); trace('pass', name); }
function emit(channel, value) { if (pet && !pet.isDestroyed()) pet.webContents.send(`ipc:${channel}`, { args: [value] }); }
async function input(mode, points = [], foregroundPid = process.pid, focusMain = true) {
  // Only this fixture's own foreground process may receive the native mouse input.
  if (foregroundPid === process.pid && focusMain) {
    app.focus({ steal: true }); main.focus();
    await until(() => main.isFocused(), 'fixture foreground');
  }
  const result = await new Promise((resolve, reject) => execFile(path.join(logs, 'pet-window-input'), [String(foregroundPid), mode, ...points.flatMap(p => [String(p.x), String(p.y)])], (error, stdout, stderr) => error ? reject(Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr })));
  trace('native-input', { mode, points, ...result });
}
async function rectangle(selector) {
  const rect = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const bounds = pet.getContentBounds();
  return { x: bounds.x + rect.x, y: bounds.y + rect.y, width: rect.width, height: rect.height };
}
async function visibleContent(label) {
  await until(() => pet.isVisible(), label);
  await wait(100);
  const bar = await rectangle('.pet-bar'), area = screen.getDisplayNearestPoint(bar).workArea, bounds = pet.getBounds();
  trace('visible-content', { label, bar, area, bounds, expectedBounds, state: runtime.snapshot().layout });
  assert.deepEqual(bounds, expectedBounds, 'Showing or focusing preserves the requested transparent drawing origin');
  const margin = vector.draw.accessoryMargin;
  assert(bar.x >= area.x + margin - 1 && bar.x + bar.width <= area.x + area.width - margin + 1);
  assert(bar.y >= area.y + margin - 1 && bar.y + bar.height <= area.y + area.height - margin + 1);
  return bar;
}
async function dragButton(selector, delta) {
  const before = await rectangle('.pet-bar'), button = await rectangle(selector);
  const start = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
  const starts = calls.filter(name => name === 'desktop-pet:drag-start').length;
  await input('drag', [start, { x: start.x + delta.x, y: start.y + delta.y }]);
  await until(() => calls.filter(name => name === 'desktop-pet:drag-start').length > starts, 'button starts host drag');
  await until(() => runtime.snapshot().visible && !runtime.snapshot().menuOpen, 'drag leaves no action menu');
  await wait(250);
  const after = await visibleContent('after native button drag');
  assert(Math.hypot(after.x - before.x, after.y - before.y) > 12, 'Native mouse movement moves the production toolbar');
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-voice-panel"))'), false);
}
const deadline = setTimeout(() => { console.error('Presentation fixture timed out'); app.exit(1); }, 100_000);
app.whenReady().then(async () => {
  const addon = require(path.join(__dirname, '../native/artifacts/klaus-native-darwin-arm64.node'));
  const registry = new ChannelRegistry(), router = new IpcRouter({ registry, roles: RoleTable.load(), onRoute: event => { calls.push(event.channel); trace('ipc', event); } });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => handleCoreInvoke({ roleOf: id => roles.get(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args));
  protocol.handle('klaus-app', request => {
    const url = new URL(request.url), filename = path.resolve(logs, `.${decodeURIComponent(url.pathname)}`);
    if (url.hostname !== 'app' || path.relative(logs, filename).startsWith('..')) return new Response('Forbidden', { status: 403 });
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };
    try { return new Response(fs.readFileSync(filename), { headers: { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  const display = screen.getPrimaryDisplay(), area = display.workArea;
  const data = path.join(profile, 'klaus'); fs.mkdirSync(data, { recursive: true });
  const savedAnchor = { x: area.x + area.width / 2, y: area.y + area.height - 240 };
  fs.writeFileSync(path.join(data, 'desktop-pet.json'), JSON.stringify({ settings: { enabled: true, showPet: false, showActivity: false, visibility: 'always-visible' }, position: { ...savedAnchor, displayId: display.id, displayBounds: display.bounds } }));
  main = createMainWindow('Companion presentation fixture');
  await main.loadURL('data:text/html,<body style="background:white">Companion presentation fixture</body>');
  main.show(); app.focus({ steal: true }); main.focus();
  runtime = new DesktopPetRuntime({
    dataDirectory: data, pageUrl: 'klaus-app://app/pet.html',
    builtIns: BUILT_IN_PETS.map(p => ({ ...p, spritesheetUrl: `klaus-app://app${p.spritesheetUrl}` })),
    createWindow: () => {
      pet = createPetWindow(); assert(addon.configurePetPanel(pet.getNativeWindowHandle()));
      const setBounds = pet.setBounds.bind(pet); pet.setBounds = bounds => { expectedBounds = { ...bounds }; setBounds(bounds); };
      pet.webContents.on('console-message', (_event, ...args) => { if (args[0] === 3) errors.push(args); trace('console', args); });
      return pet;
    },
    focusWindow: (window, active) => { window.setFocusable(active); addon.configurePetPanel(window.getNativeWindowHandle()); return addon.focusPetPanel(window.getNativeWindowHandle(), active); },
    activateApplication: () => app.focus({ steal: true }),
    captureActiveApplication: () => addon.captureActiveApplication(),
    restoreActiveApplication: token => addon.restoreActiveApplication(token),
    observeOutsideClicks: (listener, owner) => observeNativePetOutsideClicks(addon, owner.getNativeWindowHandle(), () => screen.getCursorScreenPoint(), point => { outsideClicks++; trace('outside-click', point); listener(point); }, message => errors.push(message), windowNumber => BrowserWindow.getAllWindows().some(window => !window.isDestroyed() && addon.petWindowNumber(window.getNativeWindowHandle()) === windowNumber)),
    startNativeDrag: (window, point, listener, bounds) => beginNativePetWindowDrag(addon, window.getNativeWindowHandle(), point, event => {
      trace('native-drag', event);
      expectedBounds = { ...window.getBounds(), x: Math.round(event.windowX), y: Math.round(event.windowY) };
      listener(event);
    }, message => errors.push(message), bounds),
    registerOwner: window => roles.set(window.webContents.id, 'pet'), unregisterOwner: id => roles.delete(id),
    emit, broadcast: state => emit('desktop-pet:state', state), readShortcut: () => '',
    openMain() { mainOpens++; main.focus(); }, openSettings() {}, openTask() {}, log: message => trace('host', message),
  });
  registerDesktopPetHandlers(registry, runtime);
  composer = new PetComposer({ owns: id => runtime.ownsWebContents(id), visible: () => runtime.snapshot().visible, root: data,
    pickFiles: async () => [], screenshots: async () => [], capture: async () => { throw Error('Capture must not run'); }, submit: async value => { assert.equal(value.targetTaskId, 'presentation-selected'); submissions.push(value); trace('submission', value); if (holdSubmission) await new Promise((resolve,reject)=>{releaseSubmission=resolve;rejectSubmission=reject;}); return { sessionId: value.targetTaskId }; },
    conversation: { history: async () => ({ messages: conversationMessages }), stop: async () => {}, changed: (_id, value) => emit('desktop-pet:conversation', value) },
  }); registerPetComposerHandlers(registry, composer);
  realtime = new DesktopPetRealtime({ owns: id => runtime.ownsWebContents(id), visible: () => runtime.snapshot().visible,
    availability: async () => ({ available: false, reason: 'Speech is not configured in this fixture.' }), prepare: async () => { throw Error('Voice must not start'); }, request: async () => { throw Error('Network must not run'); }, emit: (_id, value) => emit('desktop-pet:voice-event', value),
  }); registerPetRealtimeHandlers(registry, realtime);
  await runtime.initialize(); await until(async () => pet && !pet.webContents.isLoading() && await evaluate('Boolean(document.querySelector(".pet-compose-button"))'), 'production Mini renders');
  await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width, 'compact reveal transition settles');
  let compact = await rectangle('.pet-bar'); assert.equal(compact.width, vector.toolbar.compact.width); assert.equal(compact.height, vector.toolbar.compact.height);
  assert.equal(await evaluate('document.querySelectorAll(".pet-bar button").length'), 2);
  assert.equal(await evaluate('document.querySelector(".pet-bar").textContent.trim()'), '');
  pass('Mini without a pet exposes only the compose and voice controls at 80 by 40 pixels');
  await visibleContent('first show without pet'); pass('Production Mini stays above the Dock when first shown without a pet');
  const mascot = await rectangle('.pet-mascot-slot');
  assert.deepEqual({ x: mascot.x, y: mascot.y }, savedAnchor);
  pass('The first measured layout preserves the saved logical anchor');
  await dragButton('.pet-compose-button', { x: -140, y: -180 });
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false); pass('Dragging the collapsed ask button moves Mini without opening the editor');
  let r = await rectangle('.pet-compose-button'); await input('click', [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
  await until(() => evaluate('Boolean(document.querySelector("textarea"))'), 'plain click opens editor'); pass('A plain ask-button click still opens the editor once');
  await until(() => evaluate('document.activeElement === document.querySelector("textarea")'), 'editor ready for selected conversation');
  await input('text', [], process.pid, false);
  await composer.selectConversation(pet.webContents.id, 'presentation-selected', 'Mini conversation');
  await until(() => evaluate('document.querySelector(".pet-conversation header strong")?.textContent === "Mini conversation"'), 'selected conversation history renders');
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-reply-target"))'), vector.toolbar.automaticConversationReplyCard);
  assert.equal(await evaluate('document.querySelector(".pet-window").textContent.split("Mini conversation").length - 1'), 1);
  fs.writeFileSync(path.join(logs, 'selected-conversation.png'), (await pet.webContents.capturePage()).toPNG());
  pass('The selected conversation renders one title without an automatic conversation reply card');
  let control = await rectangle('.pet-conversation header button:last-child');
  await input('click', [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }], process.pid, false);
  await until(() => evaluate('Boolean(document.querySelector(".pet-conversation-reopen"))'), 'closing history retains its reopen control');
  assert.equal(await evaluate('document.querySelector(".pet-conversation-reopen").textContent'), 'Mini conversation');
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-reply-target"))'), vector.toolbar.automaticConversationReplyCard);
  assert.equal(composer.conversationState(pet.webContents.id).sessionId, 'presentation-selected');
  control = await rectangle('.pet-conversation-reopen');
  await input('click', [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }], process.pid, false);
  await until(() => evaluate('Boolean(document.querySelector(".pet-conversation"))'), 'history reopens in the same conversation');
  pass('Closing and reopening history retains its destination without adding a second context card');
  control = await rectangle('[data-message-id="selected-assistant"] footer button:first-child');
  await input('click', [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }], process.pid, false);
  await until(() => evaluate('document.querySelector(".pet-message-reply")?.textContent.includes("Reply from the selected conversation")'), 'explicit message reply shows its quotation');
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-message-reply"))'), vector.toolbar.explicitMessageReplyPreserved);
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-reply-target"))'), false);
  pass('Replying to a specific message retains its quotation without a conversation-title reply card');
  await until(()=>evaluate('document.activeElement === document.querySelector(".pet-editor-controls textarea")'),'quoted reply editor owns actual focus before send');
  await evaluate(`(()=>{window.__submitDebug=[];const record=event=>window.__submitDebug.push({event:event.type,active:document.activeElement?.outerHTML.slice(0,250),bar:document.querySelector('.pet-bar')?.dataset.presentation,editor:!!document.querySelector('.pet-editor-controls'),at:performance.now()});for(const name of ['focus','blur'])window.addEventListener(name,record);for(const name of ['focusin','focusout'])document.addEventListener(name,record);new MutationObserver(()=>record({type:'mutation'})).observe(document.querySelector('.pet-accessories'),{childList:true,subtree:true,attributes:true,attributeFilter:['class','inert','disabled']});})()`);
  holdSubmission = true;
  control = await rectangle('.pet-send');
  await input('click', [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }], process.pid, false);
  await until(() => submissions.length === 1, 'native send reaches the selected conversation');
  assert.equal(submissions[0].targetTaskId === 'presentation-selected', vector.toolbar.selectedConversationDestinationPreserved);
  assert.equal(submissions[0].replyTo.id, 'selected-assistant');
  assert.equal(submissions[0].text, 'pet-fixture');
  await until(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "controls" && document.activeElement === document.querySelector(".pet-editor-controls textarea")'), 'submission compacts before its acknowledgement and retains focus');
  fs.writeFileSync(path.join(logs, 'submitted.png'), (await pet.webContents.capturePage()).toPNG());
  pass('Submitting compacts immediately while retaining actual keyboard focus before acknowledgement');
  await input('text', [], process.pid, false);
  await until(()=>evaluate('document.querySelector(".pet-bar").dataset.presentation === "editor" && document.querySelector(".pet-editor-controls textarea").value === "pet-fixture"'),'typing reopens the retained editor');
  holdSubmission = false; releaseSubmission();
  await wait(150); assert.equal(await evaluate('document.querySelector(".pet-editor-controls textarea").value'),'pet-fixture');
  pass('Further native typing reopens the editor and a delayed acknowledgement preserves the new draft');
  await evaluate(`(()=>{const input=document.querySelector('.pet-editor-controls textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => composer.draft(pet.webContents.id).text === '' && !composer.draft(pet.webContents.id).replyTo, 'successful submission clears only the sent draft');
  pass('Removing the redundant card preserves the selected submission destination and quoted message');
  await composer.selectConversation(pet.webContents.id, null);
  await until(() => evaluate('!document.querySelector(".pet-conversation") && !document.querySelector(".pet-message-reply")'), 'new draft removes only the previous conversation context');
  await runtime.focusInput();
  await until(() => evaluate('document.activeElement === document.querySelector("textarea")'), 'fresh editor ready for remaining presentation checks');
  await evaluate(`(() => {const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'selection fixture');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(100);
  r = await rectangle('textarea');
  const dragStarts = calls.filter(name => name === 'desktop-pet:drag-start').length;
  await input('drag', [{ x: r.x + 20, y: r.y + r.height / 2 }, { x: r.x + 95, y: r.y + r.height / 2 }]);
  assert.equal(calls.filter(name => name === 'desktop-pet:drag-start').length, dragStarts);
  assert.equal(await evaluate('document.querySelector("textarea").selectionEnd > document.querySelector("textarea").selectionStart'), true);
  pass('Dragging within the text field selects text and does not move Mini');
  await dragButton('.pet-voice', { x: 120, y: -80 });
  assert.equal(await evaluate('document.querySelector(".pet-voice").getAttribute("aria-expanded")'), 'false'); pass('Dragging an editor action moves Mini without opening that action');
  r = await rectangle('.pet-attachment-add'); await input('click', [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
  await until(() => evaluate('document.querySelector(".pet-attachment-add").getAttribute("aria-expanded")==="true"'), 'attachment button toggles once'); pass('A plain action-button click preserves its existing action');
  await evaluate('document.querySelector(".pet-attachment-add").click()');
  // An unfocused draft remains an editor; clearing the draft allows the hover affordance to return.
  await input('move', [{ x: area.x + 15, y: area.y + 15 }]);
  await wait(400);
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), true);
  pass('An unfocused nonempty draft remains visible');
  await evaluate(`(() => {const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();})()`);
  await runtime.updateSettings({ showPet: true });
  await until(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "handle"'), 'idle handle after leaving');
  await wait(100);
  const handle = await rectangle('.pet-bar'), petRect = await rectangle('.pet-mascot-slot');
  assert.equal(handle.width, 23.5); assert.equal(handle.height, 6);
  assert(handle.y >= petRect.y + petRect.height, 'The idle handle is below the pet');
  assert.equal(await evaluate('document.querySelector(".pet-bar-controls").inert'), true);
  fs.writeFileSync(path.join(logs, 'idle.png'), (await pet.webContents.capturePage()).toPNG());
  pass('Leaving the pet restores a 23.5 by 6 pixel inert handle below it');
  await input('move', [{ x: petRect.x + petRect.width / 2, y: petRect.y + petRect.height / 2 }]);
  await until(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "controls"'), 'native hover reveals controls');
  await wait(250);
  compact = await rectangle('.pet-bar'); assert.equal(compact.width, 80); assert.equal(compact.height, 40);
  const composeControl = await rectangle('.pet-compose-button'), voiceControl = await rectangle('.pet-voice');
  assert.equal(composeControl.width, 40); assert.equal(voiceControl.width, 40);
  assert.equal(composeControl.x - compact.x, 0); assert.equal(voiceControl.x - compact.x, 40);
  assert.equal(compact.y - petRect.y - petRect.height, vector.toolbar.petControlGap);
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
  fs.writeFileSync(path.join(logs, 'hover.png'), (await pet.webContents.capturePage()).toPNG());
  pass('Hover reveals the compose and waveform toolbar without focusing or opening an editor');
  await input('click', [{ x: petRect.x + petRect.width / 2, y: petRect.y + petRect.height / 2 }]);
  await until(() => mainOpens === 1, 'pet body opens main');
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
  pass('Clicking the pet body opens the main window without toggling Mini editing');
  await input('move', [{ x: area.x + 15, y: area.y + 15 }]);
  await wait(100); assert.equal(await evaluate('document.querySelector(".pet-bar").dataset.presentation'), 'controls');
  await until(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "handle"'), 'delayed dismissal');
  pass('Leaving controls delays dismissal rather than flickering while crossing the gap');
  await runtime.updateSettings({ showActivity: true });
  runtime.setTasks([{ id: 'local-activity', title: 'Local activity', status: 'completed', updatedAt: Date.now(), unread: true }]);
  await input('move', [{ x: petRect.x + petRect.width / 2, y: petRect.y + petRect.height / 2 }]);
  await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.withActivity.width, 'activity control appears');
  assert.equal(await evaluate('document.querySelectorAll(".pet-bar button").length'), vector.toolbar.withActivity.controlCount);
  await until(() => evaluate('Boolean(document.querySelector(".pet-activity"))'), 'new task automatically opens its notification');
  let card = await rectangle('.pet-task'), currentPet = await rectangle('.pet-mascot-slot');
  assert.equal(card.width, vector.submission.notificationWidth);
  assert(Math.abs(card.x+card.width/2-currentPet.x-currentPet.width/2)<2,'Notification centers above the pet when the work area permits');
  assert(card.height >= vector.submission.notificationMinimumHeight);
  assert(Math.abs(currentPet.y - card.y - card.height - vector.submission.preferredPetGap) < 2, 'Notification floats above the pet with the intended gap');
  fs.writeFileSync(path.join(logs, 'completed-notification.png'), (await pet.webContents.capturePage()).toPNG());
  const originalPet = currentPet;
  await input('alt-drag',[{x:currentPet.x+currentPet.width/2,y:currentPet.y+currentPet.height/2},{x:area.x+area.width-currentPet.width/2-4,y:area.y+area.height-currentPet.height/2-4}]);
  await wait(400);
  let edgePet = await rectangle('.pet-mascot-slot'), edgeBar = await rectangle('.pet-bar'), edgeCard = await rectangle('.pet-task');
  trace('edge-layout',{pet:edgePet,bar:edgeBar,card:edgeCard,area,layout:runtime.snapshot().layout,bounds:pet.getBounds(),contentBounds:pet.getContentBounds(),browser:await evaluate('({x:window.screenX,y:window.screenY,outerWidth:window.outerWidth,innerWidth:window.innerWidth})')});
  const edgeArea = runtime.snapshot().layout.workArea;
  const centeredLeft=edgePet.x+(edgePet.width-edgeBar.width)/2, expectedLeft=Math.min(edgeArea.x+edgeArea.width-16-edgeBar.width,Math.max(edgeArea.x+16,centeredLeft));
  assert(Math.abs(edgeBar.x-expectedLeft)<2,'Controls center on the pet with only their own edge clamp');
  assert(Math.abs(edgeBar.y-edgePet.y-edgePet.height-vector.toolbar.petControlGap)<2,'The bottom edge preserves the controls gap without overlap');
  assert(edgeBar.y+edgeBar.height<=edgeArea.y+edgeArea.height-vector.draw.accessoryMargin+1);
  assert(edgeCard.x>=edgeArea.x+15&&edgeCard.x+edgeCard.width<=edgeArea.x+edgeArea.width-15);
  fs.writeFileSync(path.join(logs,'edge-notification.png'),(await pet.webContents.capturePage()).toPNG());
  await input('alt-drag',[{x:edgePet.x+edgePet.width/2,y:edgePet.y+edgePet.height/2},{x:area.x+area.width/2,y:area.y+edgePet.height/2+4}]);
  await until(()=>evaluate('document.querySelector(".pet-notification-slot").classList.contains("pet-notification-below")'),'top edge moves its notification below controls');
  await wait(300);edgePet=await rectangle('.pet-mascot-slot');edgeBar=await rectangle('.pet-bar');edgeCard=await rectangle('.pet-task');
  assert(edgeCard.y>=edgeBar.y+edgeBar.height+10,'Below placement reserves the controls');
  await input('alt-drag',[{x:edgePet.x+edgePet.width/2,y:edgePet.y+edgePet.height/2},{x:originalPet.x+originalPet.width/2,y:originalPet.y+originalPet.height/2}]);
  await wait(400);card=await rectangle('.pet-task');currentPet=await rectangle('.pet-mascot-slot');
  pass('Edge notifications fit independently while controls remain centered below the pet');

  await input('right-click', [{x:currentPet.x+currentPet.width/2,y:currentPet.y+currentPet.height/2}]);
  await until(()=>runtime.snapshot().menuOpen,'body native menu opens');
  assert.deepEqual(menus.at(-1).map(item=>item.label),vector.menus.pet);
  await input('escape',[],process.pid,false); await until(()=>!runtime.snapshot().menuOpen,'body native menu closes');
  await input('right-click', [{x:card.x+20,y:card.y+card.height/2}]);
  await until(()=>runtime.snapshot().menuOpen,'notification native menu opens');
  assert.deepEqual(menus.at(-1).map(item=>item.label),vector.menus.notification);
  await input('menu-first',[],process.pid,false);
  await until(()=>runtime.snapshot().mutedTaskIds.includes('local-activity'),'native menu selection mutes only this task');
  assert.equal(runtime.snapshot().visible,true);
  await runtime.setTaskMuted('local-activity',false);
  await until(()=>evaluate('Boolean(document.querySelector(".pet-task"))'),'unmuted task returns');
  await evaluate('document.querySelector(".pet-task-reply-button").click()');
  await until(()=>evaluate('document.activeElement === document.querySelector(".pet-task-reply textarea")'),'inline reply receives focus');
  assert.equal(await evaluate('Boolean(document.querySelector(".pet-conversation"))'),false);
  await input('text',[],process.pid,false);
  await evaluate('document.querySelector(".pet-task-reply textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until(()=>evaluate('!document.querySelector(".pet-task-reply")'),'inline reply closes without hiding pet');
  assert.equal(runtime.snapshot().visible,true);
  pass('Native pet and notification menus expose separate actions, and follow-up stays inside its bubble');
  r = await rectangle('.pet-activity-button'); await input('click', [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
  await until(()=>evaluate('!document.querySelector(".pet-activity")'),'activity control collapses notifications');
  r = await rectangle('.pet-activity-button'); await input('click', [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
  await until(() => evaluate('Boolean(document.querySelector(".pet-activity"))'), 'activity control reopens actual cards');
  pass('New activity shows automatically and the third control toggles its notification tray');
  runtime.setTasks([]); await runtime.updateSettings({ showActivity: false });
  await runtime.updateSettings({ showPet: false });
  await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width && await evaluate('document.querySelector(".pet-bar").dataset.presentation === "controls"'), 'pet-free toolbar settles');
  const voiceStates = calls.filter(channel => channel === 'desktop-pet:realtime-state').length;
  r = await rectangle('.pet-voice'); await input('click', [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
  await until(() => evaluate('Boolean(document.querySelector(".pet-voice-panel"))'), 'voice action opens voice surface');
  await until(() => calls.filter(channel => channel === 'desktop-pet:realtime-state').length > voiceStates, 'voice checks real availability');
  assert.equal(calls.some(channel => channel === 'desktop-pet:realtime-negotiate'), false);
  pass('The waveform invokes the voice client and reports unavailable speech without a network request');
  await evaluate('document.querySelector(".pet-voice-heading button").click()');
  await until(() => evaluate('!document.querySelector(".pet-error")'), 'voice notice expires before testing idle dismissal', 7000);
  shortcuts = new DesktopShortcuts({ shortcuts: globalShortcut, read: () => undefined, toggleMain() {}, toggleQuickInput() {}, toggleDesktopPet: async () => { shortcutCalls++; await runtime.toggleFromShortcut(); }, log: message => trace('shortcut', message) });
  const registration = shortcuts.apply('desktopPet'); trace('registration', registration);
  assert.equal(registration.effective, 'Alt+Space'); assert.equal(registration.active, 'Alt+Space'); assert.equal(registration.error, undefined);
  foreign = spawn(path.join(logs, 'pet-window-input'), ['window'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let foreignBuffer = '';
  foreign.stdout.on('data', data => {
    foreignBuffer += String(data);
    let end;
    while ((end = foreignBuffer.indexOf('\n')) >= 0) {
      const line = foreignBuffer.slice(0, end); foreignBuffer = foreignBuffer.slice(end + 1);
      if (line.startsWith('ready:')) continue;
      const event = JSON.parse(line);
      foreignEvents.push(event); trace('foreign-window', event);
    }
  });
  foreign.stderr.on('data', data => trace('foreign-stderr', String(data)));
  await until(() => foreignEvents.some(event => event.event === 'ready'), 'separate foreground window ready');
  const foreignWindow = foreignEvents.find(event => event.event === 'ready'); assert.equal(foreignWindow.pid, foreign.pid);
  const outsidePoint = { x: foreignWindow.x + 80, y: foreignWindow.y + 80 };
  await wait(300); await input('check', [], foreign.pid);
  await runtime.updateSettings({ showPet: true }); await runtime.hide();
  async function shortcut(visible) {
    const before = shortcutCalls;
    await input('option-space', [], foreign.pid);
    await until(() => shortcutCalls === before + 1 && pet.isVisible() === visible, `Option+Space ${visible ? 'shows' : 'hides'} the companion`);
    await wait(100); assert.equal(shortcutCalls, before + 1);
    await input('check', [], foreign.pid);
  }
  async function outside(fromEditor = false) {
    const clicks = foreignEvents.filter(event => event.event === 'click').length;
    await input('click', [outsidePoint], fromEditor ? process.pid : foreign.pid, false);
    await until(() => foreignEvents.filter(event => event.event === 'click').length > clicks, 'outside application receives the click');
    await wait(450); assert.equal(pet.isVisible(), true);
    await input('check', [], foreign.pid);
  }
  for (const visibility of ['always-visible', 'on-demand']) {
    await runtime.updateSettings({ visibility }); await runtime.hide();
    await shortcut(true);
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    assert.equal(pet.isFocused(), false);
    pass(`Exact Option+Space summons a collapsed companion from another foreground application (${visibility})`);
    await outside();
    const mascot = await rectangle('.pet-mascot-slot');
    await input('move', [{ x: mascot.x + mascot.width / 2, y: mascot.y + mascot.height / 2 }], foreign.pid);
    await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width, 'hover controls settle');
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    await input('move', [outsidePoint], foreign.pid);
    await until(() => evaluate('document.querySelector(".pet-bar").dataset.presentation === "handle"'), 'leaving the pet restores the handle');
    assert.equal(pet.isVisible(), true);
    pass(`Outside clicks and hover exit preserve the companion (${visibility})`);
    await input('move', [{ x: mascot.x + mascot.width / 2, y: mascot.y + mascot.height / 2 }], foreign.pid);
    await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width, 'pen control settles');
    const pen = await rectangle('.pet-compose-button');
    await input('click', [{ x: pen.x + pen.width / 2, y: pen.y + pen.height / 2 }], foreign.pid);
    await until(() => evaluate('document.activeElement === document.querySelector("textarea")'), 'explicit pen enters measured editor');
    await outside(true);
    if (visibility === 'on-demand') assert(outsideClicks > 0, 'production native outside-click observer receives real input');
    await shortcut(false); await shortcut(true);
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    await input('move', [{ x: mascot.x + mascot.width / 2, y: mascot.y + mascot.height / 2 }], foreign.pid);
    await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width, 'pen control settles after reopen');
    const editorPen = await rectangle('.pet-compose-button');
    await input('click', [{ x: editorPen.x + editorPen.width / 2, y: editorPen.y + editorPen.height / 2 }], foreign.pid);
    await until(() => evaluate('document.activeElement === document.querySelector("textarea")'), 'explicit editor refocus');
    await input('text', [], process.pid, false);
    await until(() => evaluate('document.querySelector("textarea")?.value === "pet-fixture"'), 'native typing reaches the pen editor');
    await outside(true); await shortcut(false); await shortcut(true);
    assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
    await input('move', [{ x: mascot.x + mascot.width / 2, y: mascot.y + mascot.height / 2 }], foreign.pid);
    await until(async () => (await rectangle('.pet-bar')).width === vector.toolbar.compact.width, 'draft stays collapsed on summon');
    await pet.webContents.capturePage().then(image => fs.writeFileSync(path.join(logs, `collapsed-${visibility}.png`), image.toPNG()));
    const restorePen = await rectangle('.pet-compose-button');
    await input('click', [{ x: restorePen.x + restorePen.width / 2, y: restorePen.y + restorePen.height / 2 }], foreign.pid);
    await until(() => evaluate('document.querySelector("textarea")?.value === "pet-fixture"'), 'pen restores the retained draft');
    await evaluate('(() => {const t=document.querySelector("textarea");const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;setter.call(t, "");t.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await outside(true); await shortcut(false);
    pass(`Pen focus, external blur, hide/reopen and retained draft all work (${visibility})`);
  }
  await Promise.all([runtime.focusInput(), runtime.hide()]);
  await shortcut(true);
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
  pass('Cancelling a hidden pending input request cannot reopen the editor on the next shortcut');
  await shortcut(false);
  await runtime.show(); await runtime.focusInput();
  await until(() => evaluate('document.activeElement === document.querySelector("textarea")'), 'editor ready before rapid toggle');
  const fadingHide = runtime.hide(); await runtime.show(); await fadingHide;
  await wait(200);
  assert.equal(pet.isVisible(), true);
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
  pass('Reopening during the hide animation retracts the previous editor presentation');
  await Promise.all([runtime.focusInput(), runtime.show()]);
  await wait(200);
  assert.equal(pet.isVisible(), true); assert.equal(pet.isFocused(), false);
  assert.equal(await evaluate('Boolean(document.querySelector("textarea"))'), false);
  pass('Cancelling an unmeasured focus request while visible cannot reacquire keyboard input');
  assert.equal(foreignEvents.some(event => event.event === 'key' && event.code === 49), false, 'registered Space never leaks to the foreground window');
  shortcuts.close(); foreign.kill(); foreign = null;
  await runtime.show();
  await runtime.updateSettings({ visibility: 'always-visible' });
  for (const showPet of [true, false]) {
    await runtime.updateSettings({ showPet }); await visibleContent(`pet ${showPet}`);
    await runtime.hide(); await runtime.show(); await visibleContent(`reopen pet ${showPet}`);
    await runtime.focusInput(); await until(() => pet.isFocused(), 'native focus after measured request'); await visibleContent(`focused pet ${showPet}`);
  }
  pass('Pet selection, hide/reopen and measured input focus retain visible content bounds');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await runtime.shutdown(); assert.equal(addon.petInputObserverCount(), 0); composer.close(); await realtime.close(); main.destroy();
  pass('Closing the focused production panel releases native observers without late owner errors');
  fs.writeFileSync(path.join(logs, 'results.json'), JSON.stringify({ passed, failed: 0, profile, errors }, null, 2));
  clearTimeout(deadline); console.log(`pet-presentation: ${passed} passed, 0 failed`); app.exit(0);
}).catch(async error => { trace('failure', error.stack || String(error)); if (pet && !pet.isDestroyed()) { trace('submit-debug',await evaluate('window.__submitDebug').catch(String)); trace('failure-dom', await evaluate('document.body.innerHTML').catch(String)); await pet.webContents.capturePage().then(image => fs.writeFileSync(path.join(logs, 'failure.png'), image.toPNG())).catch(() => {}); } console.error(error); clearTimeout(deadline); app.exit(1); });
