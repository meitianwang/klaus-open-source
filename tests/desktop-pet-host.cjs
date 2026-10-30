const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { PetCatalog, validatePetSpritesheet } = require('../dist/main/pets/catalog.js');
const { normalizePetSettings } = require('../dist/main/pets/settings.js');
const { clampPet, snapPet, petPlacement, layoutPetWindow } = require('../dist/main/pets/geometry.js');
function image(version = 2) { const b = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b); b.write('IHDR', 12); b.writeUInt32BE(1536, 16); b.writeUInt32BE(version === 2 ? 2288 : 1872, 20); return b; }
let count = 0;
async function check(name, run) { await run(); console.log(`PASS ${++count}: ${name}`); }
(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klaus-pet-fixtures-'));
    try {
        const catalog = new PetCatalog(directory, [{ id: 'klaus', name: 'Klaus', spriteVersion: 2, spritesheetUrl: 'builtin.png', builtIn: true }]);
        await check('dimensions recognize both sprite versions and reject malformed dimensions', () => { assert.equal(validatePetSpritesheet(image(1)).version, 1); assert.equal(validatePetSpritesheet(image(2)).version, 2); const bad = image(); bad.writeUInt32BE(100, 16); assert.throws(() => validatePetSpritesheet(bad)); });
        await check('local import preserves manifest and creates collision-safe catalog IDs', async () => { const file = path.join(directory, 'sheet.png'); await fs.writeFile(file, image()); const a = await catalog.importFile(file, 'My Pet'), b = await catalog.importFile(file, 'My Pet'); assert.equal(a.id, 'custom:my-pet'); assert.equal(b.id, 'custom:my-pet-2'); const rows = await catalog.list(); assert.equal(rows.length, 3); assert.equal(rows[0].id, 'klaus'); assert.match(rows[1].spritesheetUrl, /^klaus-pet:\/\/local\/custom%3A/); assert.equal((await catalog.asset(rows[1].id)).bytes.length, 24); });
        await check('malformed and traversing manifests do not enter catalog', async () => { const d = path.join(directory, 'pets', 'bad'); await fs.mkdir(d); await fs.writeFile(path.join(d, 'pet.json'), JSON.stringify({ spritesheetPath: '../../sheet.png', spriteVersionNumber: 2 })); assert.equal((await catalog.list()).length, 3); await assert.rejects(catalog.delete('custom:../sheet.png')); await assert.rejects(catalog.delete('klaus')); });
        await check('custom delete removes catalog entry and keeps other pets', async () => { await catalog.delete('custom:my-pet'); assert.deepEqual((await catalog.list()).map(x => x.id).sort(), ['custom:my-pet-2', 'klaus']); });
        await check('URL redirects and untrusted URL schemes are rejected before install', async () => { const remote = new PetCatalog(directory, [], async () => new Response(null, { status: 302, headers: { location: 'https://example.com/a.png' } })); await assert.rejects(remote.previewUrl({ name: 'Pet', imageUrl: 'https://example.com/a.png' }), /redirect/); await assert.rejects(remote.previewUrl({ name: 'Pet', imageUrl: 'file:///etc/passwd' }), /HTTPS/); });
        await check('URL import validates response type and installs supported sprite', async () => { const remote = new PetCatalog(directory, [], async () => new Response(image(), { headers: { 'content-type': 'image/png' } })); const preview = await remote.previewUrl({ name: 'Remote', imageUrl: 'https://example.com/a.png' }); assert.equal(preview.spriteVersion, 2); assert.equal((await remote.importUrl({ name: 'Remote', imageUrl: 'https://example.com/a.png' })).id, 'custom:remote'); });
        await check('settings clamp size, retain known values and support bar-only selection', () => { assert.equal(normalizePetSettings({ size: 999 }).size, 224); assert.equal(normalizePetSettings({ size: 1 }).size, 80); assert.equal(normalizePetSettings({ selectedPetId: null }).showPet, false); assert.equal(normalizePetSettings({ visibility: 'invalid' }).visibility, 'always-visible'); });
        await check('geometry supports negative-coordinate displays and four corner snapping', () => { const area = { x: -1440, y: 0, width: 1440, height: 900 }; assert.deepEqual(clampPet({ x: -1600, y: 999 }, { width: 112, height: 120 }, area), { x: -1440, y: 780 }); assert.deepEqual(snapPet({ x: -100, y: 800 }, { width: 112, height: 120 }, area), { x: -128, y: 764 }); assert.equal(petPlacement({ x: -100, y: 800 }, area), 'bottom-end'); });
        const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 850 } };
        let pointer = { x: 1100, y: 700 };
        const screen = new EventEmitter();
        screen.getCursorScreenPoint = () => pointer;
        screen.getDisplayNearestPoint = () => display;
        screen.getAllDisplays = () => [display];
        const powerMonitor = new EventEmitter();
        let focused = null, menuTemplate;
        class Window extends EventEmitter {
            constructor() { super(); this.bounds = { x: 0, y: 0, width: 440, height: 440 }; this.visible = false; this.dead = false; this.webContents = new EventEmitter(); this.webContents.id = 42; this.webContents.send = (...args) => this.sent.push(args); this.webContents.setBackgroundThrottling = () => { }; this.webContents.focus = () => { }; this.sent = []; }
            isDestroyed() { return this.dead; }
            isVisible() { return this.visible; }
            isFocused() { return focused === this; }
            setAlwaysOnTop() { }
            setMenuBarVisibility() { }
            setVisibleOnAllWorkspaces() { }
            setFocusable(v) { this.focusable = v; }
            getBounds() { return this.bounds; }
            setBounds(v) { this.bounds = v; }
            setIgnoreMouseEvents(v) { this.ignore = v; }
            showInactive() { this.visible = true; }
            show() { this.visible = true; }
            hide() { this.visible = false; }
            focus() { focused = this; }
            loadURL() { this.webContents.emit('did-start-loading'); return Promise.resolve(); }
            destroy() { this.dead = true; this.emit('closed'); }
        }
        const original = Module._load;
        Module._load = function (name, ...args) { if (name === 'electron')
            return { BrowserWindow: { getFocusedWindow: () => focused }, Menu: { buildFromTemplate: template => { menuTemplate = template; return ({ popup: ({ callback }) => callback() }); } }, globalShortcut: { register: () => true, unregister() { } }, powerMonitor, screen, shell: { openPath: async () => '' } }; return original.call(this, name, ...args); };
        const { DesktopPetRuntime } = require('../dist/main/app/desktop-pet.js');
        Module._load = original;
        let window, opened, responseSent, outsideClick;
        const states = [], focusEvents = [];
        const runtime = new DesktopPetRuntime({ createWindow: () => window = new Window(), pageUrl: 'http://localhost/pet', dataDirectory: directory, builtIns: [{ id: 'klaus', name: 'Klaus', spriteVersion: 2, spritesheetUrl: 'builtin.png', builtIn: true }], broadcast: s => states.push(s), emit: (channel, value) => { if (channel === 'desktop-pet:focus') focusEvents.push(value); }, openMain() { }, openSettings() { }, openTask: id => { opened = id; }, observeOutsideClicks: listener => { outsideClick = listener; return () => { outsideClick = undefined; }; }, registerShortcut: () => () => { }, respondTask: async (...args) => { responseSent = args; return { ok: true }; }, platform: 'darwin' });
        await check('window waits for renderer and layout readiness before becoming visible', async () => { await runtime.initialize(); await runtime.focusInput(); assert.equal(window.visible, false); runtime.rendererReady(42); assert.equal(window.visible, false); const focusRequest = focusEvents.findLast(event => event.type === 'focus-input'); const layout = runtime.setLayout(42, { width: 440, height: 300, pet: { x: 164, y: 16, width: 112, height: 121 }, focusRequestId: focusRequest.requestId }); assert.equal(window.visible, false); assert.equal(runtime.completeFocus(42, focusRequest.requestId, layout.layout.revision), true); assert.equal(window.visible, true); runtime.setKeyboard(42, false); focused = null; assert.throws(() => runtime.startDrag(99, { x: 0, y: 0 })); });
        await check('pointer passthrough changes only over declared interactive regions', () => { runtime.setRegions(42, [{ x: 0, y: 0, width: 20, height: 20 }]); assert.equal(window.ignore, true); pointer = { x: window.bounds.x + 2, y: window.bounds.y + 2 }; runtime.setRegions(42, [{ x: 0, y: 0, width: 20, height: 20 }]); assert.equal(window.ignore, false); });
        const interaction = require('../contracts/vectors/desktop-pet-presentation-vectors.json').windowInteraction;
        await check('transparent space passes mouse input through while the companion has keyboard focus', () => {
            for (const value of interaction.pointerCases) {
                pointer = { x: window.bounds.x + value.point.x, y: window.bounds.y + value.point.y };
                runtime.setKeyboard(42, value.keyboard);
                runtime.setRegions(42, [{ x: 0, y: 0, width: 20, height: 20 }]);
                assert.equal(window.ignore, value.ignore);
            }
        });
        await check('native focus release restores the prior window and preserves a window selected by the user', async () => {
            let nativeWindow;
            const calls = [], previous = new Window(), other = new Window();
            const nativeRuntime = new DesktopPetRuntime({
                createWindow: () => nativeWindow = new Window(), pageUrl: 'http://localhost/pet',
                dataDirectory: path.join(directory, 'native-focus'), builtIns: [], broadcast() {}, openMain() {}, openSettings() {}, openTask() {},
                focusWindow: (owner, active) => { calls.push(active); owner.setFocusable(active); if (active) owner.focus(); else if (focused === owner) focused = null; return true; },
            });
            try {
                await nativeRuntime.show(); nativeRuntime.rendererReady(42);
                nativeRuntime.setLayout(42, { width: 440, height: 300, pet: { x: 164, y: 16, width: 112, height: 121 } });
                focused = previous;
                nativeRuntime.setKeyboard(42, false);
                assert.equal(calls.length, interaction.initialReleaseCalls);
                nativeRuntime.setKeyboard(42, true); assert.equal(nativeWindow.isFocused(), true);
                nativeRuntime.setKeyboard(42, false);
                assert.equal(previous.isFocused(), interaction.restorePreviousWindowOnInputClose);
                nativeRuntime.setKeyboard(42, true);
                focused = other; nativeWindow.emit('blur');
                assert.equal(other.isFocused(), interaction.preserveNewWindowOnBlur);
                assert.equal(nativeWindow.focusable, false);
                assert.deepEqual(calls, [true, false, true, false]);
            } finally { await nativeRuntime.shutdown(); focused = null; }
        });
        await check('drag retains pointer anchor and persists clamped placement', async () => { const start = { x: window.bounds.x + 164 + 10, y: window.bounds.y + 16 + 10 }; runtime.startDrag(42, { x: 10, y: 10, screenX: start.x, screenY: start.y }); runtime.moveDrag(42, { x: 10, y: 10, screenX: 200, screenY: 200 }); runtime.endDrag(42, { x: 10, y: 10, screenX: 200, screenY: 200 }); await runtime.updateSettings({ showActivity: false }); const saved = JSON.parse(await fs.readFile(path.join(directory, 'desktop-pet.json'))); assert.equal(saved.position.x, 190); assert.equal(saved.position.y, 190); });
        await check('task click validates ownership in snapshot and routes real task ID', async () => { runtime.setTasks([{ id: 'task-1', title: 'Build', status: 'running', updatedAt: 1 }]); await runtime.openTask('task-1'); assert.equal(opened, 'task-1'); await assert.rejects(runtime.openTask('not-there')); });
        await check('on-demand blur keeps the explicitly shown presentation visible', async () => { await runtime.updateSettings({ visibility: 'on-demand' }); await runtime.show(); focused = null; window.emit('blur'); assert.equal(window.visible, true); assert.equal(runtime.snapshot().settings.enabled, true); await runtime.show(); assert.equal(window.visible, true); });
        await check('realtime voice reports explicit unavailable capability without starting a fake session', async () => { const state = await runtime.voiceAction(42, 'start'); assert.equal(state.available, false); assert.equal(state.phase, 'inactive'); assert.match(state.unavailableReason, /not available/); await assert.rejects(runtime.voiceAction(99, 'start'), /own/); });
        await check('task response validates live request identity and rejects unrelated URL actions', async () => { runtime.setTasks([{id:'waiting',title:'Permission',status:'waiting',updatedAt:2,attention:{id:'request-1',kind:'approval',toolName:'read',category:'filesystem'}}]); await assert.rejects(runtime.respondTask(42,{taskId:'waiting',requestId:'old',response:{decision:'allow'}}), /no longer active/); await assert.rejects(runtime.respondTask(99,{taskId:'waiting',requestId:'request-1',response:{decision:'allow'}}), /own/); await assert.rejects(runtime.respondTask(42,{taskId:'waiting',requestId:'request-1',response:{kind:'open'}}), /Only a URL/); await runtime.respondTask(42,{taskId:'waiting',requestId:'request-1',response:{decision:'allow'}}); assert.deepEqual(responseSent,['waiting','request-1',{decision:'allow'}]); });
        await check('power suspend hides and resume restores presentation', () => { powerMonitor.emit('suspend'); assert.equal(window.visible, false); powerMonitor.emit('resume'); assert.equal(window.visible, true); });
        await check('IPC registry exposes every declared channel and rejects foreign owner mutation', async () => { const { ChannelRegistry } = require('../dist/main/ipc/registry.js'); const { registerDesktopPetHandlers, DESKTOP_PET_CHANNELS } = require('../dist/main/ipc/handlers/desktop-pet.js'); const registry = new ChannelRegistry(); registerDesktopPetHandlers(registry, runtime); assert.equal(registry.size(), DESKTOP_PET_CHANNELS.length); await assert.rejects(Promise.resolve().then(() => registry.lookup('desktop-pet:drag-start')({ role: 'pet', senderId: 99, args: [{ x: 1, y: 1 }], channel: 'desktop-pet:drag-start' })), /owned/); });
        await check('recurring state contains URL references rather than embedded custom image bytes', async () => { await runtime.refreshCatalog(); assert(runtime.snapshot().catalog.filter(p => !p.builtIn).every(p => p.spritesheetUrl.startsWith('klaus-pet://local/'))); });
        await check('full companion viewport stays inside every work-area corner and a stash exposes its restore control', () => { const area={x:-1512,y:33,width:1512,height:868};for(const vertical of ['top','bottom'])for(const horizontal of ['start','end']){const pet={x:horizontal==='start'?16:250,y:vertical==='top'?16:384,width:112,height:121},anchor={x:horizontal==='start'?area.x:area.x+area.width-pet.width,y:vertical==='top'?area.y:area.y+area.height-pet.height};const {bounds}=layoutPetWindow(anchor,pet,{width:384,height:521},area);assert(bounds.x>=area.x&&bounds.y>=area.y&&bounds.x+bounds.width<=area.x+area.width&&bounds.y+bounds.height<=area.y+area.height);}for(const edge of ['left','right']){const pet={x:10,y:10,width:60,height:48},{bounds,anchor}=layoutPetWindow({x:0,y:800},pet,{width:88,height:68},area,edge);const exposed=Math.min(anchor.x+pet.width,area.x+area.width)-Math.max(anchor.x,area.x);assert.equal(exposed,24);assert(bounds.y>=area.y&&bounds.y+bounds.height<=area.y+area.height);} });
        await check('dragging to a lower corner keeps the complete frame visible through the renderer layout flip', () => {runtime.setLayout(42,{width:384,height:521,pet:{x:250,y:16,width:112,height:121}});let bounds=window.getBounds();runtime.startDrag(42,{x:10,y:10,screenX:bounds.x+260,screenY:bounds.y+26});runtime.moveDrag(42,{x:10,y:10,screenX:1430,screenY:865});assert.equal(runtime.snapshot().layout.placement,'bottom-end');runtime.setLayout(42,{width:384,height:521,pet:{x:250,y:384,width:112,height:121}});runtime.endDrag(42,{x:10,y:10,screenX:1430,screenY:865},true);bounds=window.getBounds();assert(bounds.x>=0&&bounds.y>=25&&bounds.x+bounds.width<=1440&&bounds.y+bounds.height<=875);assert.equal(runtime.snapshot().layout.placement,'bottom-end');});
        await check('native interaction reservations release cleanly without implicit outside-click dismissal', async () => {await runtime.updateSettings({visibility:'on-demand'});await runtime.show();await runtime.withInteraction(42,async()=>{await runtime.withInteraction(42,async()=>{focused=null;window.emit('blur');outsideClick?.({x:-1000,y:-1000});assert.equal(window.visible,true);});outsideClick?.({x:-1000,y:-1000});assert.equal(window.visible,true);});outsideClick?.({x:-1000,y:-1000});assert.equal(window.visible,true);await runtime.show();await assert.rejects(runtime.withInteraction(42,async()=>{throw new Error('picker cancelled');}),/picker cancelled/);outsideClick?.({x:-1000,y:-1000});assert.equal(window.visible,true);await runtime.show();await runtime.withInteraction(42,async()=>{await runtime.hide();});assert.equal(window.visible,false);await runtime.show();});
        await check('notification menu mutes one conversation and the body menu exposes only settings and hide', async () => {
            runtime.setTasks([{id:'mute-session',title:'Selected conversation',status:'running',updatedAt:1}]);runtime.contextMenu(42,'mute-session');assert.deepEqual(menuTemplate.map(item=>item.label),['Mute chat']);assert(menuTemplate.every(item=>!item.type&&!item.submenu));await runtime.setTaskMuted('mute-session',true);assert.equal(runtime.snapshot().tasks.length,0);assert.deepEqual(runtime.snapshot().mutedTaskIds,['mute-session']);
            runtime.setTasks([{id:'mute-session',title:'Updated conversation',status:'completed',updatedAt:2,unread:true}]);assert.equal(runtime.snapshot().tasks.length,0);await runtime.openTask('mute-session');assert.equal(opened,'mute-session');runtime.contextMenu(42);assert.deepEqual(menuTemplate.map(item=>item.label),['Settings','Hide Mini']);assert(menuTemplate.every(item=>!item.type&&!item.submenu));await runtime.setTaskMuted('mute-session',false);assert.equal(runtime.snapshot().tasks[0].status,'completed');assert.equal(runtime.snapshot().tasks[0].unread,false);assert.equal(runtime.snapshot().mutedTaskIds.length,0);await assert.rejects(runtime.setTaskMuted('unknown-session',true),/unavailable/);assert.throws(()=>runtime.contextMenu(42,'unknown-session'),/unavailable/);
            const {ChannelRegistry}=require('../dist/main/ipc/registry.js'),{registerDesktopPetHandlers}=require('../dist/main/ipc/handlers/desktop-pet.js'),registry=new ChannelRegistry();registerDesktopPetHandlers(registry,runtime);await assert.rejects(registry.lookup('desktop-pet:set-task-muted')({role:'pet',senderId:99,args:[{id:'mute-session',muted:true}],channel:'desktop-pet:set-task-muted'}),/owned/);
        });
        await check('notification mute survives restart and can be removed after a completed card expires', async () => {
            const dataDirectory=path.join(directory,'muted-restart'),deps={createWindow:()=>new Window(),pageUrl:'http://localhost/pet',dataDirectory,builtIns:[],broadcast(){},openMain(){},openSettings(){},openTask(){}};
            let current=new DesktopPetRuntime(deps);await current.initialize();current.setTasks([{id:'saved-muted',title:'Saved title',status:'running',updatedAt:1}]);await current.setTaskMuted('saved-muted',true);await current.shutdown();current=new DesktopPetRuntime(deps);await current.initialize();assert.deepEqual(current.snapshot().mutedTaskIds,['saved-muted']);current.setTasks([{id:'saved-muted',title:'Saved title',status:'completed',updatedAt:2}]);assert.equal(current.snapshot().tasks.length,0);current.setTasks([]);await current.setTaskMuted('saved-muted',false);await current.shutdown();current=new DesktopPetRuntime(deps);await current.initialize();assert.deepEqual(current.snapshot().mutedTaskIds,[]);await current.shutdown();
        });
        await check('stored companion selection migrates before catalog reconciliation and survives restart', async () => {
            const { BUILT_IN_PETS } = require('../dist/contracts/desktop-pet-builtins.js');
            const dataDirectory = path.join(directory, 'selection-migration');
            const preferences = { enabled: false, selectedPetId: 'fireball', showPet: true, showActivity: false, size: 168, visibility: 'on-demand', shortcut: 'Control+Shift+P', language: 'zh' };
            await fs.mkdir(dataDirectory, { recursive: true });
            await fs.writeFile(path.join(dataDirectory, 'desktop-pet.json'), JSON.stringify({ settings: preferences }));
            const deps = { createWindow: () => new Window(), pageUrl: 'http://localhost/pet', dataDirectory, builtIns: BUILT_IN_PETS, broadcast() {}, openMain() {}, openSettings() {}, openTask() {} };
            let current = new DesktopPetRuntime(deps);
            try { await current.initialize(); assert.deepEqual(current.snapshot().settings, { ...preferences, selectedPetId: 'wick' }); }
            finally { await current.shutdown(); }
            current = new DesktopPetRuntime(deps);
            try { await current.initialize(); assert.deepEqual(current.snapshot().settings, { ...preferences, selectedPetId: 'wick' }); }
            finally { await current.shutdown(); }
        });
        await require('./desktop-pet-window-contract.cjs')(check, { DesktopPetRuntime, Window, screen, powerMonitor, directory, display, setFocused: value => { focused = value; } });
        await check('shutdown drains persistence and removes lifetime listeners', async () => { await runtime.shutdown(); assert.equal(window.dead, true); assert.equal(screen.listenerCount('display-added'), 0); assert.equal(powerMonitor.listenerCount('suspend'), 0); });
        await check('shutdown during pending initialization leaves no display or power observers', async () => { const closing = new DesktopPetRuntime({createWindow:()=>new Window(),pageUrl:'http://localhost/pet',dataDirectory:path.join(directory,'closing'),builtIns:[],broadcast(){},openMain(){},openSettings(){},openTask(){}}); const initializing = closing.initialize(); await closing.shutdown(); await initializing; assert.equal(screen.listenerCount('display-added'),0); assert.equal(powerMonitor.listenerCount('suspend'),0); });
        await check('a bound voice conversation opens without an activity card and remains accessible after stopping', async () => {
            let voiceWindow, voicePhase = 'active', navigated;
            const voiceRuntime = new DesktopPetRuntime({createWindow:()=>voiceWindow=new Window(),pageUrl:'http://localhost/pet',dataDirectory:path.join(directory,'voice-navigation'),builtIns:[],broadcast(){},openMain(){},openSettings(){},openTask:id=>{navigated=id;},voice:{state:async ownerId=>{assert.equal(ownerId,42);return{available:true,phase:voicePhase,microphoneMuted:false,speakerMuted:false,sessionId:'bound-voice'};}}});
            try {await voiceRuntime.show();voiceRuntime.rendererReady(42);voiceRuntime.setLayout(42,{width:384,height:240,pet:{x:16,y:16,width:112,height:121}});await voiceRuntime.openTask('bound-voice');assert.equal(navigated,'bound-voice');voicePhase='inactive';await voiceRuntime.openTask('bound-voice');await assert.rejects(voiceRuntime.openTask('arbitrary-session'),/unavailable/);assert.equal(navigated,'bound-voice');}
            finally {await voiceRuntime.shutdown();}
            await assert.rejects(voiceRuntime.openTask('bound-voice'),/unavailable/);
        });
        await check('voice navigation rechecks the window owner after awaiting the bound conversation', async () => {
            let voiceWindow, resolveState, navigated=false;
            const voiceRuntime = new DesktopPetRuntime({createWindow:()=>voiceWindow=new Window(),pageUrl:'http://localhost/pet',dataDirectory:path.join(directory,'voice-navigation-stale'),builtIns:[],broadcast(){},openMain(){},openSettings(){},openTask:()=>{navigated=true;},voice:{state:()=>new Promise(resolve=>{resolveState=resolve;})}});
            try {await voiceRuntime.show();const opening=voiceRuntime.openTask('bound-voice');await voiceRuntime.shutdown();resolveState({available:true,phase:'inactive',microphoneMuted:false,speakerMuted:false,sessionId:'bound-voice'});await assert.rejects(opening,/unavailable/);assert.equal(navigated,false);}
            finally {await voiceRuntime.shutdown();}
        });
        await require('./desktop-pet-responder.cjs')(check);
        await require('./desktop-pet-composer.cjs')(check);
        await require('./desktop-pet-conversation.cjs')(check);
        console.log(`desktop-pet-host: ${count} passed, 0 failed, 0 info`);
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
    process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
