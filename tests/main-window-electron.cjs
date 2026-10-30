const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { HOST_CHANNELS } = require('../dist/main/ipc/binding');
const { strict: assert } = require('node:assert');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const windowContract = require('../contracts/vectors/native-menu-vectors.json').windowLifecycle;
const root = process.env.KLAUS_MAIN_WINDOW_PROFILE || mkdtempSync(join(tmpdir(), 'klaus-main-windows-'));
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
process.env.SHELL = '/bin/sh';
process.env.KLAUS_SERVER_URL = 'http://127.0.0.1:9';
app.setPath('userData', join(root, 'electron'));
const { registerAppScheme } = require('../dist/main/app/protocol');
const { createDesktopRuntime } = require('../dist/main/app/runtime');
const { kvSet } = require('../dist/main/services/settings');
registerAppScheme();
app.on('window-all-closed', () => {});
const output = join(__dirname, '../dist/multiwindow-logs');
mkdirSync(output, { recursive: true });
const trace = (event, fields = {}) => {
  const row = { event, ...fields };
  require('node:fs').appendFileSync(join(output, 'trace.jsonl'), JSON.stringify(row) + '\n');
  process.stdout.write(JSON.stringify(row) + '\n');
};
async function until(read, description, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + description);
}
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);
(async () => {
  let runtime, second, third, server;
  let models = 0;
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({ auth_mode: 'custom', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(key, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    server = createServer((request, response) => {
      if (/messages|chat\/completions|responses/.test(request.url || '')) { models++; response.writeHead(500); response.end('No model request is allowed in this fixture'); return; }
      response.setHeader('Content-Type', 'text/html'); response.end('<title>Owned fixture page</title><p>Local browser content</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    let chosenWorkdir = null, directoryPicks = 0;
    runtime = await createDesktopRuntime(app, { chooseWorkdir: async () => { directoryPicks++; return chosenWorkdir; }, tray: false, show: true, externalImportHome: root, externalAuthHomeDir: root, notificationFixture: { show() {}, focused: () => true } });
    const first = runtime.window;
    const focus = async owner => { app.focus({ steal: true }); owner.show(); owner.focus(); await until(() => owner.isFocused(), 'owned fixture focus'); };
    const ready = owner => until(() => evaluate(owner, 'Boolean(window.klausKeybindingActions && typeof window.currentSessionId !== "undefined" && !document.getElementById("boot-splash")?.classList.contains("active"))'), 'main renderer boot');
    await ready(first);
    await evaluate(first, `document.getElementById('input').textContent = 'Primary draft'; document.getElementById('input').dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Primary draft' }));`);
    second = await runtime.openMainWindow(); await ready(second);
    assert.equal(await evaluate(second, 'window.currentSessionId'), null);
    assert.equal(await evaluate(second, "document.getElementById('input').textContent"), '');
    await evaluate(second, `document.getElementById('input').textContent = 'Secondary draft'; document.getElementById('input').dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Secondary draft' }));`);
    assert.equal(await evaluate(first, "document.getElementById('input').textContent"), 'Primary draft');
    const primaryStorage = await evaluate(first, "localStorage.getItem('klaus_welcome_draft')");
    assert.equal(primaryStorage, 'Primary draft');
    assert.equal(await evaluate(second, `localStorage.getItem('klaus.window.' + new URLSearchParams(location.search).get('windowId') + '.klaus_welcome_draft')`), 'Secondary draft');
    assert.equal(runtime.engine.inspect().filter(row => row.pid).length, windowContract.engineCount);
    trace('independent-windows', { first: first.webContents.id, second: second.webContents.id, engines: runtime.engine.inspect().length });

    await focus(second);
    await until(() => runtime.focusedMainWindow() === second, 'project command window');
    await until(() => Menu.getApplicationMenu().getMenuItemById('newProject')?.enabled, 'project menu availability');
    Menu.getApplicationMenu().getMenuItemById('newProject').click();
    await until(() => directoryPicks === 1, 'project picker cancellation');
    assert.equal(await evaluate(second, "document.getElementById('input').textContent"), 'Secondary draft');
    chosenWorkdir = join(root, 'Project With Spaces'); mkdirSync(chosenWorkdir);
    Menu.getApplicationMenu().getMenuItemById('newProject').click();
    await until(() => evaluate(second, `window.klaus.projects.list().then(state => state.activeRoot === ${JSON.stringify(chosenWorkdir)})`), 'project created and selected');
    assert.equal(await evaluate(second, 'window.currentSessionId'), null);
    assert.equal(await evaluate(first, "document.getElementById('input').textContent"), 'Primary draft');
    await evaluate(second, "window.klaus.settings.kv.set('language', 'zh')");
    await until(() => Menu.getApplicationMenu().items[1].label === '文件', 'Chinese application menus');
    assert.deepEqual(Menu.getApplicationMenu().items.slice(1).map(item => item.label), ['文件', '编辑', '视图', '窗口', '帮助']);
    await evaluate(second, "window.klaus.settings.kv.set('language', 'en')");
    await until(() => Menu.getApplicationMenu().items[1].label === 'File', 'English application menus');
    trace('project-and-localized-menus', { directoryPicks });

    for (const owner of [first, second]) await evaluate(owner, `window.__menuCalls = []; window.klausKeybindingActions.newChat = () => window.__menuCalls.push('newChat'); window.__editCalls = []; window.klausComposerEditCommand = command => { window.__editCalls.push(command); return true }; window.__zoomCalls = []; window.klausImageZoomCommand = command => { window.__zoomCalls.push(command); return true }; true;`);
    await focus(second); await until(() => runtime.focusedMainWindow() === second, 'secondary focus');
    Menu.getApplicationMenu().getMenuItemById('newChat').click();
    await until(() => evaluate(second, 'window.__menuCalls.length === 1'), 'focused menu command');
    assert.deepEqual(await evaluate(first, 'window.__menuCalls'), []);
    await evaluate(second, 'window.klaus.app.reportComposerFocus(true)');
    second.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    second.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await until(() => evaluate(second, 'window.__editCalls.includes("undo")'), 'secondary composer undo');
    assert.deepEqual(await evaluate(first, 'window.__editCalls'), []);
    second.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    second.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await until(() => evaluate(second, 'window.__zoomCalls.includes("in")'), 'secondary image zoom');
    assert.deepEqual(await evaluate(first, 'window.__zoomCalls'), []);
    trace('focused-command-edit-zoom', { target: second.webContents.id });

    const quickTargets = [];
    const originalSends = new Map();
    for (const owner of [first, second]) {
      const original = owner.webContents.send.bind(owner.webContents); originalSends.set(owner, original);
      owner.webContents.send = (channel, ...args) => {
        const packet = args[0];
        if (channel === HOST_CHANNELS.delivery && packet?.event === 'ipc:quick-input:submit') {
          quickTargets.push(owner.webContents.id);
          first.focus();
          ipcMain.emit(HOST_CHANNELS.deliveryAck, { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, { deliveryId: packet.deliveryId, ok: true });
          return;
        }
        return original(channel, ...args);
      };
    }
    try {
      await focus(second);
      assert.equal((await runtime.showQuickInput()).ok, true);
      const quick = BrowserWindow.getAllWindows().find(owner => !owner.isDestroyed() && owner.webContents.getURL().includes('quick-input.html'));
      assert(quick);
      await until(() => evaluate(quick, 'Boolean(window.klausQuickInput)'), 'quick input bridge');
      const reply = await evaluate(quick, 'window.klausQuickInput.submit("Route this fixture without a model request")');
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual(quickTargets, [second.webContents.id], 'quick input retains its captured main target even when focus changes before acknowledgement');
      trace('quick-input-target', { target: quickTargets[0], modelRequests: models });
      await focus(second);
      await runtime.registry.lookup('desktop-pet:show')({ senderId: second.webContents.id, role: 'main', channel: 'desktop-pet:show', args: [] });
      await until(() => BrowserWindow.getAllWindows().some(owner => !owner.isDestroyed() && owner.webContents.getURL().includes('pet.html')), 'companion renderer navigation');
      const pet = BrowserWindow.getAllWindows().find(owner => !owner.isDestroyed() && owner.webContents.getURL().includes('pet.html'));
      assert(pet, 'the companion window is registered');
      await runtime.registry.lookup('desktop-pet:submit')({ senderId: pet.webContents.id, role: 'pet', channel: 'desktop-pet:submit', args: [{ text: 'Route companion input without a model request' }] });
      assert.deepEqual(quickTargets, [second.webContents.id, second.webContents.id]);
      await runtime.registry.lookup('desktop-pet:hide')({ senderId: second.webContents.id, role: 'main', channel: 'desktop-pet:hide', args: [] });
      trace('companion-input-target', { target: quickTargets[1], modelRequests: models });
    } finally { for (const [owner, send] of originalSends) owner.webContents.send = send; }
    await focus(second);


    const invoke = async (owner, channel, fields) => runtime.registry.lookup(channel)({ senderId: owner.webContents.id, role: 'main', channel, args: fields === undefined ? [] : [fields] });
    const pipState = await invoke(second, 'computer-use-pip:get-state');
    assert.equal(typeof pipState.supported, 'boolean');
    const pipLayout = await invoke(second, 'computer-use-pip:set-host-layout', {
      hostId: 'klaus-main-thread', sessionId: 'secondary-fixture', visible: true, animated: false, devicePixelRatio: 1,
      anchorRect: { x: 1, y: 2, width: 600, height: 400 }, containerRect: null, anchors: null, anchorRects: null,
      isCodexHomeAvailable: false, presentationScope: 'thread',
    });
    assert.equal(pipLayout.ok, true, JSON.stringify(pipLayout));
    trace('secondary-pip-state-layout', { supported: pipState.supported, layout: pipLayout.ok });
    const browserSettings = await invoke(second, 'settings:browser-use:set-enabled', { enabled: true });
    assert.equal(browserSettings.ok, true, JSON.stringify(browserSettings));
    await invoke(second, 'browser-use:set-conversation', { conversationId: 'window-two-browser' });
    const navigation = await invoke(second, 'browser-use:navigate', { url: `http://127.0.0.1:${address.port}/owned` });
    assert.equal(navigation.ok, true, JSON.stringify(navigation));
    const page = runtime.browser.listPages('window-two-browser')[0]; assert(page);
    await evaluate(second, `window.currentSessionId = 'window-two-browser'; document.getElementById('browser-panel-toggle').click(); true;`);
    const show = await invoke(second, 'browser-use:show', { bounds: { x: 20, y: 20, width: 300, height: 200 } });
    assert.equal(show.ok, true, JSON.stringify(show));
    assert(second.contentView.children.includes(page.view));
    await invoke(first, 'browser-use:set-bounds', { bounds: { x: 1, y: 1, width: 100, height: 100 } });
    assert(second.contentView.children.includes(page.view), 'inactive window bounds cannot steal browser view');
    await focus(first); await until(() => runtime.browser.windowId === first.webContents.id, 'browser ownership transfers on focus');
    await focus(second); await until(() => runtime.browser.windowId === second.webContents.id, 'browser ownership returns');
    assert(second.contentView.children.includes(page.view), 'returning focus restores secondary browser intent');
    const found = await invoke(second, 'app:content-find', { action: 'find', query: 'Local browser content', options: {} });
    assert.equal(found.matches, 1);
    await assert.rejects(() => invoke(first, 'app:content-find', { action: 'find', query: 'Local browser content', options: {} }), /unavailable/);
    await invoke(second, 'app:content-find', { action: 'stop' });
    trace('content-find-owner', { target: second.webContents.id, matches: found.matches });
    const refused = await runtime.registry.lookup('browser-use:state')({ senderId: 987654, role: 'main', channel: 'browser-use:state', args: [] });
    assert.equal(refused.ok, false);
    const terminal = await invoke(second, 'terminal:start', { id: 'secondary-fixture', cwd: root, cols: 80, rows: 20 });
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    await assert.rejects(() => invoke(first, 'terminal:write', { id: 'secondary-fixture', data: 'echo denied\n' }), /another caller/);
    assert.equal((await invoke(second, 'terminal:kill', { id: 'secondary-fixture' })).ok, true);
    const canvasFile = join(runtime.canvas.store.canvases, 'window-fixture.canvas.tsx');
    writeFileSync(canvasFile, 'export default function Fixture() { return <div>Owned canvas</div> }');
    const canvasShow = await invoke(second, 'canvas:panel-show', { filePath: canvasFile, bounds: { x: 350, y: 20, width: 300, height: 200 } });
    assert.equal(canvasShow.ok, true, JSON.stringify(canvasShow));
    assert(second.contentView.children.length >= 2, 'secondary owns its browser and Canvas child views');
    trace('native-resource-ownership', { browserOwner: runtime.browser.windowId, secondaryChildren: second.contentView.children.length, refused: refused.ok });
    const pid = runtime.engine.inspect()[0].pid;
    await evaluate(second, 'setTimeout(() => window.__KLAUS_DESKTOP__.window.getCurrentWindow().close(), 0); true;');
    await until(() => second.isDestroyed(), 'secondary renderer close destroys only its own window');
    assert.equal(runtime.engine.inspect()[0].pid, pid, 'closing one window preserves the shared engine');
    assert(require('electron').webContents.fromId(page.contentsId), 'closing browser presentation owner preserves its task tab');
    third = await runtime.openMainWindow(); await ready(third);
    assert.equal(await evaluate(third, "document.getElementById('input').textContent"), '');
    first.close(); assert.equal(first.isDestroyed(), false); assert.equal(first.isVisible(), false);
    assert.equal(runtime.engine.inspect()[0].pid, pid);
    assert.equal(models, 0, 'no model requests');
    trace('close-reopen', { enginePid: pid, modelRequests: models });
    await runtime.shutdown(); runtime = undefined;
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    trace('passed', { modelRequests: models });
    app.exit(0);
  } catch (error) {
    trace('failed', { error: String(error.stack || error), profile: root });
    if (runtime) try { await runtime.shutdown(); } catch (shutdown) { trace('shutdown-error', { error: String(shutdown) }); }
    app.exit(1);
  } finally { server?.close(); }
})();
