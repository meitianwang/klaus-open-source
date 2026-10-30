const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vector = require('../contracts/vectors/desktop-pet-window-vectors.json');
module.exports = async (check, { DesktopPetRuntime, Window, screen, powerMonitor, directory, display, setFocused }) => {
  const { restorePetPosition, canStashPet, snapPet, PET_MOTION } = require('../dist/main/pets/geometry');
  const create = (name, extra = {}) => {
    let window; const events = [];
    const runtime = new DesktopPetRuntime({ createWindow: () => window = new Window(), pageUrl: 'http://localhost/pet', dataDirectory: path.join(directory, name), builtIns: [], broadcast() {}, emit: (channel, value) => { if (channel === 'desktop-pet:focus') events.push(value); }, openMain() {}, openSettings() {}, openTask() {}, ...extra });
    return { runtime, events, get window() { return window; }, async ready() { await runtime.show(); runtime.rendererReady(42); runtime.setLayout(42, { width: 384, height: 280, pet: { x: 140, y: 16, width: 112, height: 121 } }); } };
  };
  await check('native keyboard focus follows presentation and survives measured layout refreshes', async () => {
    const actions = [];
    const f = create('native-focus-order', { focusWindow: (window, active) => { actions.push(active ? 'focus' : 'release'); setFocused(active ? window : null); return true; } });
    try {
      await f.ready();
      const show = f.window.showInactive.bind(f.window);
      f.window.showInactive = () => { actions.push('present'); show(); };
      f.runtime.setKeyboard(42, true);
      assert.deepEqual(actions, ['present', 'focus']);
      actions.length = 0;
      f.runtime.setLayout(42, { width: 384, height: 300, pet: { x: 140, y: 16, width: 112, height: 121 } });
      assert.deepEqual(actions, []);
      assert.equal(f.window.isFocused(), true);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('late native visibility events do not reenter caller validation after shutdown', async () => {
    const f = create('shutdown-native-events');
    await f.ready();
    const window = f.window;
    await f.runtime.shutdown();
    assert.doesNotThrow(() => window.emit('blur'));
    assert.doesNotThrow(() => window.emit('hide'));
    assert.throws(() => f.runtime.setKeyboard(42, true), /does not own/);
  });
  await check('a replacement native owner waits for its own layout before positioning', async () => {
    const f = create('replacement-owner-layout');
    try {
      await f.ready();
      const retired = f.window;
      retired.destroy();
      await f.runtime.show();
      const replacement = f.window;
      assert.notEqual(replacement, retired);
      assert.deepEqual(replacement.getBounds(), new Window().getBounds());
      assert.doesNotThrow(() => retired.emit('blur'));
      assert.doesNotThrow(() => retired.emit('hide'));
      assert.equal(replacement.visible, false);
      f.runtime.rendererReady(42);
      f.runtime.setLayout(42, { width: 384, height: 280, pet: { x: 140, y: 16, width: 112, height: 121 } });
      assert.equal(replacement.visible, true);
    } finally { await f.runtime.shutdown(); }
  });
  await check('enabling after a disabled locale update reconciles the configured visibility', async () => {
    const f = create('enable-after-locale');
    try { await f.runtime.updateSettings({ language: 'zh' }); assert.equal(f.window, undefined);
      await f.runtime.updateSettings({ enabled: true }); assert(f.window); f.runtime.setLayout(42, { width: 384, height: 280, pet: { x: 140, y: 16, width: 112, height: 121 } }); f.runtime.rendererReady(42); assert.equal(f.window.visible, true);
      await f.runtime.updateSettings({ enabled: false, visibility: 'on-demand' }); await f.runtime.updateSettings({ enabled: true }); assert.equal(f.window.visible, false);
      await f.runtime.show(); assert.equal(f.window.visible, true);
    } finally { await f.runtime.shutdown(); }
  });
  await check('keyboard focus accepts only the current measured visibility request', async () => {
    const f = create('focus-contract');
    try {
      await f.ready(); await f.runtime.hide(); await f.runtime.focusInput();
      const request = f.events.findLast(event => event.type === 'focus-input');
      assert(request && request.wasHidden); assert.equal(f.window.visible, false);
      const first = f.runtime.setLayout(42, { width: 384, height: 320, pet: { x: 140, y: 16, width: 112, height: 121 }, focusRequestId: request.requestId });
      const next = f.runtime.setLayout(42, { width: 384, height: 321, pet: { x: 140, y: 16, width: 112, height: 121 }, focusRequestId: request.requestId });
      assert.equal(f.runtime.completeFocus(42, request.requestId, first.layout.revision), vector.focus.staleLayoutAccepted);
      assert.equal(f.runtime.completeFocus(42, request.requestId, next.layout.revision), vector.focus.currentLayoutAccepted);
      await f.runtime.hide(); assert.equal(f.runtime.completeFocus(42, request.requestId, next.layout.revision), vector.focus.staleVisibilityAccepted);
      assert.equal(f.window.visible, false);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('a visibility shortcut cancels a pending explicit measured focus request', async () => {
    const f = create('pending-on-demand-shortcut');
    try {
      await f.ready(); await f.runtime.updateSettings({ visibility: 'on-demand' }); await f.runtime.hide();
      await f.runtime.focusInput();
      const request = f.events.findLast(event => event.type === 'focus-input'); assert(request);
      await f.runtime.toggleFromShortcut();
      assert(f.events.some(event => event.type === 'cancel-focus' && event.requestId === request.requestId));
      const state = f.runtime.setLayout(42, { width: 384, height: 320, pet: { x: 140, y: 16, width: 112, height: 121 }, focusRequestId: request.requestId });
      assert.equal(f.runtime.completeFocus(42, request.requestId, state.layout.revision), false);
      assert.equal(f.window.visible, false);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('visibility shortcuts never request input and outside interaction keeps the pet visible', async () => {
    for (const visibility of ['always-visible', 'on-demand']) {
      let outside;
      const f = create(`latched-${visibility}`, { observeOutsideClicks: listener => { outside = listener; return () => {}; } });
      try {
        await f.ready(); await f.runtime.updateSettings({ visibility }); await f.runtime.hide();
        await f.runtime.toggleFromShortcut();
        assert.equal(f.window.visible, true); assert.equal(f.window.focusable, false);
        assert.equal(f.events.some(event => event.type === 'focus-input' || event.type === 'toggle-input'), vector.visibility.shortcutOpensEditor);
        f.runtime.setKeyboard(42, true); setFocused(null); f.window.emit('blur');
        assert.equal(!f.window.visible, vector.visibility.blurHides);
        if (outside) { outside({ x: -10000, y: -10000 }); assert.equal(!f.window.visible, vector.visibility.outsideClickHides); }
        await f.runtime.toggleFromShortcut(); assert.equal(f.window.visible, false);
        await f.runtime.toggleFromShortcut(); assert.equal(f.window.visible, true); assert.equal(f.window.focusable, false);
      } finally { await f.runtime.shutdown(); setFocused(null); }
    }
  });
  await check('a reserved interaction leaves shortcut visibility and editor focus unchanged', async () => {
    const f = create('reserved-shortcut', { isSessionReserved: () => true });
    try { await f.ready(); await f.runtime.toggleFromShortcut(); assert.equal(f.events.length, 0); assert.equal(f.window.visible, true); }
    finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('explicit input focus opens a fresh measured request even while the panel already has focus', async () => {
    const f = create('explicit-focus-contract');
    try { await f.ready(); f.runtime.setKeyboard(42, true); await f.runtime.focusInput();
      const request = f.events.findLast(event => event.type === 'focus-input'); assert(request); assert.equal(request.wasHidden, false);
      const state = f.runtime.setLayout(42, { width: 384, height: 280, pet: { x: 140, y: 16, width: 112, height: 121 }, focusRequestId: request.requestId });
      assert.equal(f.runtime.completeFocus(42, request.requestId, state.layout.revision), true);
      assert.equal(f.events.some(event => event.type === 'toggle-input'), false);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('composer digit shortcuts bypass menus only for the exact focused modifier chord', async () => {
    const f = create('composer-menu-contract', { platform: 'darwin' });
    try { await f.ready(); const calls = []; f.window.webContents.setIgnoreMenuShortcuts = value => calls.push(value);
      f.runtime.setKeyboard(42, true); f.runtime.setComposerFocused(42, true);
      const input = { meta: true, control: false, alt: false, shift: false, code: 'Digit1', key: '1' };
      f.window.webContents.emit('before-input-event', {}, input); assert.equal(calls.at(-1), true);
      for (const change of [{ alt: true }, { shift: true }, { control: true }, { code: 'KeyA', key: 'a' }]) { f.window.webContents.emit('before-input-event', {}, { ...input, ...change }); assert.equal(calls.at(-1), false); }
      f.runtime.setComposerFocused(42, false); f.window.webContents.emit('before-input-event', {}, input); assert.equal(calls.at(-1), false);
      f.runtime.setComposerFocused(42, true); f.runtime.setKeyboard(42, false); assert.equal(calls.at(-1), false);
      assert.throws(() => f.runtime.setComposerFocused(99, true));
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('native input shapes preserve transparent pass-through independently of keyboard input', async () => {
    const f = create('shape-contract');
    try { await f.ready(); const calls = []; f.window.setInputShape = rects => { calls.push(rects); return true; }; f.window.setIgnoreMouseEvents = (ignore, options) => { f.window.ignore = ignore; calls.push({ ignore, options }); };
      f.runtime.setRegions(42, [{ x: 10, y: 10, width: 20, height: 20 }]); f.runtime.setKeyboard(42, true); assert.equal(f.window.ignore, false);
      await f.runtime.hide(); assert.deepEqual(calls.at(-1), { ignore: true, options: { forward: false } });
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('external foreground restoration occurs on explicit release and never after another window takes focus', async () => {
    let restored = 0; const f = create('external-focus', { captureActiveApplication: () => 'foreground-token', restoreActiveApplication: token => { assert.equal(token, 'foreground-token'); restored++; return true; }, focusWindow: (window, active) => { window.setFocusable(active); setFocused(active ? window : null); return true; } });
    try { await f.ready(); setFocused(null); f.runtime.setKeyboard(42, true); f.runtime.setKeyboard(42, false); assert.equal(restored, 1);
      setFocused(null); f.runtime.setKeyboard(42, true); setFocused(new Window()); f.window.emit('blur'); assert.equal(restored, 1);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('owned window input refreshes the capture source without claiming external restoration', async () => {
    let external = '9001', captured, captures = 0, externalRestores = 0, ownedRestores = 0;
    const f = create('capture-focus-source-contract', {
      captureActiveApplication: () => { captures++; captured = external ?? String(process.pid); return external; },
      restoreActiveApplication: token => { assert.equal(token, '9001'); externalRestores++; return true; },
      focusWindow: (window, active) => { window.setFocusable(active); setFocused(active ? window : null); return true; },
    });
    try {
      await f.ready(); setFocused(null); f.runtime.setKeyboard(42, true); assert.equal(captured, '9001');
      f.runtime.setKeyboard(42, false); assert.equal(externalRestores, 1);
      const previous = new Window(); previous.focus = () => { ownedRestores++; setFocused(previous); };
      external = undefined; setFocused(previous); f.runtime.setKeyboard(42, true);
      assert.equal(captures, 2); assert.equal(captured, String(process.pid));
      f.runtime.setKeyboard(42, false); assert.equal(ownedRestores, 1); assert.equal(externalRestores, 1);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('outside-click observation follows visible on-demand lifetime and modal reservations', async () => {
    let starts = 0, stops = 0; const f = create('outside-contract', { observeOutsideClicks: () => { starts++; return () => { stops++; }; } });
    try { await f.ready(); assert.equal(starts, 0); await f.runtime.updateSettings({ visibility: 'on-demand' }); await f.runtime.show(); assert.equal(starts, 1);
      f.runtime.setLayout(42, { width: 384, height: 280, pet: { x: 140, y: 16, width: 112, height: 121 } }); assert.equal(starts, 1);
      await f.runtime.withInteraction(42, async () => { assert.equal(stops, 1); }); assert.equal(starts, 2);
      await f.runtime.hide(); assert.equal(stops, 2);
    } finally { await f.runtime.shutdown(); }
  });
  await check('display restoration translates saved coordinates and avoids occupied stash edges', () => {
    const bounds = { width: 1440, height: 900 }, v = vector.display;
    assert.deepEqual(restorePetPosition({ ...v.point, displayBounds: { ...v.origin, ...bounds } }, { ...v.restoredOrigin, ...bounds }), v.expectedPoint);
    assert.equal(canStashPet('left', display.bounds, { ...display.workArea, x: 70, width: display.workArea.width - 70 }), false);
    assert.equal(canStashPet('right', display.bounds, { ...display.workArea, width: display.workArea.width - 70 }), false);
    assert.deepEqual(snapPet({ x: 664, y: 40 }, { width: 112, height: 121 }, display.workArea), { x: 664, y: 41 });
    for (const [key, value] of Object.entries(vector.motion)) assert.equal(PET_MOTION[key], value);
  });
  await check('native drawing keeps edge mascots independent while accessories remain inside the work area', () => {
    const { layoutPetWindow, petWindowOriginBounds } = require('../dist/main/pets/geometry');
    const area = { x: -1440, y: 25, width: 1440, height: 850 }, pet = { x: 136, y: 16, width: 112, height: 121 }, accessories = { x: 22, y: 145, width: 340, height: 190 }, viewport = { width: 384, height: 355 };
    let envelope;
    for (const anchor of [{ x: area.x, y: area.y }, { x: area.x + area.width - pet.width, y: area.y + area.height - pet.height }, { x: -720, y: 450 }]) {
      const draw = layoutPetWindow(anchor, pet, viewport, area, null, false, accessories); assert.deepEqual(draw.anchor, anchor);
      assert.equal(draw.bounds.x + draw.pet.x, anchor.x); assert.equal(draw.bounds.y + draw.pet.y, anchor.y);
      const x = draw.bounds.x + draw.contentOffset.x + accessories.x + draw.accessoryOffset.x, y = draw.bounds.y + draw.contentOffset.y + accessories.y + draw.accessoryOffset.y;
      assert(x >= area.x + 16 && x + accessories.width <= area.x + area.width - 16); assert(y >= area.y + 16 && y + accessories.height <= area.y + area.height - 16);
      const dimensions = { width: draw.bounds.width, height: draw.bounds.height }; if (envelope) assert.deepEqual(dimensions, envelope); else envelope = dimensions;
      const limits = petWindowOriginBounds(draw.pet, area); assert.equal(limits.x + draw.pet.x, area.x); assert.equal(limits.y + draw.pet.y, area.y);
    }
  });
  await check('a native placement reversal preserves the mascot draw location while accessories reflow', () => {
    const { layoutPetWindow } = require('../dist/main/pets/geometry'), area = display.workArea, viewport = { width: 384, height: 355 }, anchor = { x: 10, y: area.y + area.height - 121 };
    const top = layoutPetWindow(anchor, { x: 136, y: 16, width: 112, height: 121 }, viewport, area, null, false, { x: 22, y: 145, width: 340, height: 190 });
    const bottom = layoutPetWindow(anchor, { x: 136, y: 214, width: 112, height: 121 }, viewport, area, null, false, { x: 22, y: 16, width: 340, height: 190 });
    assert.deepEqual(top.pet, bottom.pet); assert.deepEqual(top.bounds, bottom.bounds); assert(top.bounds.y < area.y);
  });
  await check('display removal and return restore the original screen-relative anchor without stale drag ownership', async () => {
    const f = create('display-return-contract'), originalAll = screen.getAllDisplays, originalNearest = screen.getDisplayNearestPoint;
    const other = { id: 2, bounds: { x: 1440, y: -100, width: 1280, height: 800 }, workArea: { x: 1440, y: -75, width: 1280, height: 750 } }; let displays = [display];
    screen.getAllDisplays = () => displays; screen.getDisplayNearestPoint = () => displays[0];
    try { await f.ready(); const before = { ...f.window.getBounds() }; displays = [other]; screen.emit('display-removed'); assert(f.window.getBounds().x >= other.workArea.x);
      displays = [display, other]; screen.emit('display-added'); assert.equal(f.window.getBounds().x, before.x); assert.equal(f.window.getBounds().y, before.y);
    } finally { await f.runtime.shutdown(); screen.getAllDisplays = originalAll; screen.getDisplayNearestPoint = originalNearest; }
  });
  await check('suspend and lock stop native drag while resume and unlock restore the measured presentation', async () => {
    let stops = 0; const f = create('power-resume-contract', { platform: 'darwin', startNativeDrag: () => () => { stops++; } });
    try { await f.ready(); const bounds = f.window.getBounds(); f.runtime.startDrag(42, { x: 10, y: 10, screenX: bounds.x + 150, screenY: bounds.y + 26 }); f.runtime.moveDrag(42, { x: 30, y: 30, screenX: bounds.x + 170, screenY: bounds.y + 46 });
      powerMonitor.emit('suspend'); f.window.emit('hide'); assert.equal(stops, 1); assert.equal(f.window.visible, false); powerMonitor.emit('resume'); assert.equal(f.window.visible, true);
      powerMonitor.emit('lock-screen'); f.window.emit('hide'); assert.equal(f.window.visible, false); powerMonitor.emit('unlock-screen'); assert.equal(f.window.visible, true);
    } finally { await f.runtime.shutdown(); }
  });
  await check('stashing releases keyboard input and persists the visible restore position', async () => {
    const f = create('stash-contract');
    try { await f.ready(); f.runtime.setKeyboard(42, true); const edge = f.runtime.snapshot().layout.placement.endsWith('start') ? 'left' : 'right';
      const before = f.window.getBounds().x + f.runtime.snapshot().layout.pet.x; f.runtime.stash(42, edge); assert.equal(f.runtime.snapshot().stashedEdge, edge); assert.equal(f.window.focusable, false);
      await f.runtime.updateSettings({ showActivity: false }); const saved = JSON.parse(await fs.readFile(path.join(directory, 'stash-contract/desktop-pet.json'), 'utf8')); assert.equal(saved.position.x, before);
      f.runtime.stash(42, null); assert.equal(f.runtime.snapshot().stashedEdge, null);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('a shortcut restores either stashed edge without requesting editor focus', async () => {
    for (const visibility of ['always-visible', 'on-demand']) for (const edge of ['left', 'right']) for (const hidden of [false, true]) {
      const name = `stash-shortcut-${visibility}-${edge}-${hidden}`, f = create(name, { observeOutsideClicks: () => () => {} });
      try {
        await fs.mkdir(path.join(directory, name), { recursive: true });
        await fs.writeFile(path.join(directory, name, 'desktop-pet.json'), JSON.stringify({ position: { x: edge === 'left' ? 200 : 1100, y: 250, displayId: display.id, displayBounds: display.bounds } }));
        await f.ready(); await f.runtime.updateSettings({ visibility }); await f.runtime.show();
        const initial = f.runtime.snapshot(), bounds = f.window.getBounds(), anchor = { x: bounds.x + initial.layout.pet.x, y: bounds.y + initial.layout.pet.y };
        f.runtime.stash(42, edge); assert.equal(f.runtime.snapshot().stashedEdge, edge);
        await new Promise(resolve => setTimeout(resolve, 1050));
        if (hidden) await f.runtime.hide();
        setFocused(null); await f.runtime.toggleFromShortcut();
        const state = f.runtime.snapshot();
        assert.equal(state.stashedEdge === null, vector.focus.restoresStashedPetOnSummon, name);
        assert.equal(f.events.some(event => event.type === 'focus-input'), vector.visibility.shortcutOpensEditor, name);
        assert.equal(state.settings.enabled, true, name);
        assert.equal(f.window.focusable, false, name);
        const restored = f.window.getBounds(), mascot = state.layout.pet;
        assert.deepEqual({ x: restored.x + mascot.x, y: restored.y + mascot.y }, anchor, name);
        assert.equal(f.window.visible, true, name);
        await f.runtime.toggleFromShortcut(); assert.equal(f.window.visible, false, name);
      } finally { await f.runtime.shutdown(); setFocused(null); }
    }
  });
  await check('explicit show restores a stashed visible anchor without acquiring keyboard focus', async () => {
    for (const visibility of ['always-visible', 'on-demand']) for (const edge of ['left', 'right']) for (const hidden of [false, true]) {
      const name = `stash-show-${visibility}-${edge}-${hidden}`, f = create(name, { observeOutsideClicks: () => () => {} });
      try {
        await fs.mkdir(path.join(directory, name), { recursive: true });
        await fs.writeFile(path.join(directory, name, 'desktop-pet.json'), JSON.stringify({ position: { x: edge === 'left' ? 200 : 1100, y: 250, displayId: display.id, displayBounds: display.bounds } }));
        await f.ready(); await f.runtime.updateSettings({ visibility }); await f.runtime.show();
        const initial = f.runtime.snapshot(), bounds = f.window.getBounds(), anchor = { x: bounds.x + initial.layout.pet.x, y: bounds.y + initial.layout.pet.y };
        f.runtime.stash(42, edge); assert.equal(f.runtime.snapshot().stashedEdge, edge);
        if (hidden) await f.runtime.hide();
        const state = await f.runtime.show(), restored = f.window.getBounds();
        assert.equal(state.stashedEdge === null, vector.visibility.showRestoresStashedPet, name);
        assert.deepEqual({ x: restored.x + state.layout.pet.x, y: restored.y + state.layout.pet.y }, anchor, name);
        assert.equal(state.settings.enabled, true, name); assert.equal(f.window.visible, true, name); assert.equal(f.window.focusable, false, name);
        assert.equal(f.events.some(event => event.type === 'focus-input'), false, name);
      } finally { await f.runtime.shutdown(); setFocused(null); }
    }
  });
  await check('native outside delivery drops already-queued callbacks after disposal', () => {
    const { observeNativePetOutsideClicks } = require('../dist/main/app/pet-pointer'); let callback, delivered = 0, stopped = 0;
    const close = observeNativePetOutsideClicks({ observePetOutsideClicks: (_handle, next) => { callback = next; return 9; }, stopPetOutsideClicks: token => { assert.equal(token, 9); stopped++; } }, Buffer.alloc(8), () => ({ x: 1, y: 2 }), () => delivered++, message => { throw Error(message); });
    callback(); close(); callback(); close(); assert.equal(delivered, 1); assert.equal(stopped, 1);
  });
  await check('native outside delivery ignores local transient windows while retaining global events', () => {
    const { observeNativePetOutsideClicks } = require('../dist/main/app/pet-pointer'); let callback, delivered = 0;
    const close = observeNativePetOutsideClicks({ observePetOutsideClicks: (_handle, next) => { callback = next; return 1; }, stopPetOutsideClicks() {} }, Buffer.alloc(8), () => ({ x: 1, y: 2 }), () => delivered++, message => { throw Error(message); }, windowNumber => windowNumber === 7);
    callback(8); assert.equal(delivered, 0); callback(7); callback(0); assert.equal(delivered, 2); close(); callback(7); assert.equal(delivered, 2);
  });
  await check('native drag handoff defers renderer layout and suppresses a duplicate release throw', async () => {
    let callback, stops = 0, starts = 0;
    const f = create('native-drag-contract', { platform: 'darwin', startNativeDrag: (_window, _point, listener) => { callback = listener; starts++; return () => { stops++; }; } });
    try { await f.ready(); const bounds = { ...f.window.getBounds() };
      f.runtime.startDrag(42, { x: 10, y: 10, screenX: bounds.x + 150, screenY: bounds.y + 26 });
      f.runtime.moveDrag(42, { x: 30, y: 30, screenX: bounds.x + 170, screenY: bounds.y + 46 }); assert.equal(starts, 1);
      f.window.bounds = { ...bounds, x: bounds.x + 20, y: bounds.y + 20 };
      callback({ windowX: f.window.bounds.x, windowY: f.window.bounds.y, ended: false, altKey: false });
      const nativeBounds = { ...f.window.getBounds() }; f.runtime.setLayout(42, { width: 384, height: 281, pet: { x: 140, y: 16, width: 112, height: 121 } }); assert.deepEqual(f.window.getBounds(), nativeBounds);
      f.runtime.endDrag(42, undefined, false); assert.equal(stops, 1); const released = { ...f.window.getBounds() };
      f.runtime.throw(42, -1500, 0, false); await new Promise(resolve => setTimeout(resolve, 60)); assert.deepEqual(f.window.getBounds(), released);
    } finally { await f.runtime.shutdown(); }
  });
  await check('unexpected native window destruction releases drag observers and keyboard ownership before recreation', async () => {
    let stops = 0, captures = 0; const f = create('destroy-native-contract', { platform: 'darwin', captureActiveApplication: () => { captures++; return 'prior'; }, focusWindow: (window, active) => { window.setFocusable(active); setFocused(active ? window : null); return true; }, startNativeDrag: () => () => { stops++; } });
    try { await f.ready(); setFocused(null); f.runtime.setKeyboard(42, true); const bounds = f.window.getBounds();
      f.runtime.startDrag(42, { x: 10, y: 10, screenX: bounds.x + 150, screenY: bounds.y + 26 }); f.runtime.moveDrag(42, { x: 30, y: 30, screenX: bounds.x + 170, screenY: bounds.y + 46 });
      f.window.destroy(); assert.equal(stops, 1); setFocused(null); await f.ready(); f.runtime.setKeyboard(42, true); assert.equal(captures, 2);
    } finally { await f.runtime.shutdown(); setFocused(null); }
  });
  await check('release without a movement event cannot start an orphaned native drag', async () => {
    let starts = 0; const f = create('release-only-native-contract', { platform: 'darwin', startNativeDrag: () => { starts++; return () => {}; } });
    try { await f.ready(); const bounds = f.window.getBounds();
      f.runtime.startDrag(42, { x: 10, y: 10, screenX: bounds.x + 150, screenY: bounds.y + 26 });
      f.runtime.endDrag(42, { x: 40, y: 40, screenX: bounds.x + 180, screenY: bounds.y + 56 });
      assert.equal(starts, 0);
    } finally { await f.runtime.shutdown(); }
  });
  await check('edge stash and restore move continuously and settle on the visible handle', async () => {
    const f = create('stash-motion-contract');
    try { await f.ready(); const original = { ...f.window.getBounds() }, edge = f.runtime.snapshot().layout.placement.endsWith('start') ? 'left' : 'right';
      f.runtime.stash(42, edge); assert.deepEqual(f.window.getBounds(), original); await new Promise(resolve => setTimeout(resolve, 1100));
      const layout = f.runtime.snapshot().layout, bounds = f.window.getBounds(), exposed = Math.min(bounds.x + layout.pet.x + layout.pet.width, display.workArea.x + display.workArea.width) - Math.max(bounds.x + layout.pet.x, display.workArea.x); assert.equal(exposed, 24);
      f.runtime.stash(42, null); await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(f.window.getBounds().x, original.x); assert.equal(f.window.getBounds().y, original.y);
    } finally { await f.runtime.shutdown(); }
  });
  await check('streaming layout updates cannot invalidate an explicit hide fade', async () => {
    const f = create('hide-stream-layout-contract');
    try {
      await f.ready(); let opacity = 1, started;
      const fading = new Promise(resolve => { started = resolve; });
      f.window.getOpacity = () => opacity;
      f.window.setOpacity = value => { opacity = value; if (value < 1) started(); };
      f.window.hide = () => { f.window.visible = false; f.window.emit('hide'); };
      const hiding = f.runtime.hide(); await fading;
      assert.equal(f.window.visible, true);
      for (const height of [281, 282, 283]) f.runtime.setLayout(42, { width: 384, height, pet: { x: 140, y: 16, width: 112, height: 121 } });
      await f.runtime.updateSettings({ language: 'zh' }); await hiding;
      assert.equal(f.runtime.snapshot().settings.enabled, false);
      assert.equal(f.window.visible, vector.visibility.visibleAfterHideWithLayoutUpdates);
      f.runtime.setLayout(42, { width: 384, height: 284, pet: { x: 140, y: 16, width: 112, height: 121 } });
      assert.equal(f.window.visible, vector.visibility.visibleAfterHideWithLayoutUpdates);
      await f.runtime.show(); assert.equal(f.window.visible, vector.visibility.visibleAfterExplicitReopen);
    } finally { await f.runtime.shutdown(); }
  });
  await check('reopening cancels an in-flight fade without a stale hide completion', async () => {
    const f = create('fade-contract');
    try { await f.ready(); let opacity = 1; f.window.getOpacity = () => opacity; f.window.setOpacity = value => { opacity = value; };
      const hiding = f.runtime.hide(); await new Promise(resolve => setTimeout(resolve, 20)); await f.runtime.show(); await hiding; assert.equal(f.window.visible, true);
      await f.runtime.hide(); assert.equal(f.window.visible, false); await f.runtime.show(); assert.equal(f.window.visible, true); assert(opacity >= 0.01 && opacity <= 1);
      await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(opacity, 1);
    } finally { await f.runtime.shutdown(); }
  });

  await check('hiding an already-forwarding surface explicitly disables mouse forwarding', async () => {
    const f = create('hidden-forwarding-contract');
    try { await f.ready(); const calls = []; f.window.setIgnoreMouseEvents = (ignore, options) => calls.push({ ignore, options });
      f.runtime.setRegions(42, []); f.runtime.setKeyboard(42, false); await f.runtime.hide();
      assert.deepEqual(calls.at(-1), { ignore: true, options: { forward: false } });
    } finally { await f.runtime.shutdown(); }
  });

};
