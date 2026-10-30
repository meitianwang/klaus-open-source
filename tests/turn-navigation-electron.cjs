const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_NAV_TEST_ROOT;
const vectors = require('../contracts/vectors/turn-navigation.json');
app.setPath('userData', path.join(root, 'profile'));
let win;
const checks = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const command = (name, value) => win.webContents.debugger.sendCommand(name, value);
async function mouse(type, point, button = 'none', buttons = 0) {
  await command('Input.dispatchMouseEvent', { type, ...point, button, buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });
}
async function key(value) {
  const codes = { ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Enter: 13, Escape: 27, ' ': 32 };
  const code = value === ' ' ? 'Space' : value;
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: codes[value] });
}
async function reset(count = 20, gutter = 80, nested = false) {
  await mouse('mouseMoved', { x: 1100, y: 400 });
  return evaluate(`navFixture.reset(${count},${gutter},${nested})`);
}
const snapshot = () => evaluate('navFixture.snapshot()');
const point = index => evaluate(`navFixture.point(${index})`);
async function check(name, test) {
  try { const evidence = await test(); checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ name, passed: true })); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); fs.writeFileSync(path.join(root, 'native-results.json'), JSON.stringify(checks, null, 2)); throw error; }
  fs.writeFileSync(path.join(root, 'native-results.json'), JSON.stringify(checks, null, 2));
}
async function startDrag(count = 20, indices = vectors.dragIndices) {
  await reset(count);
  const start = await point(indices[0]);
  await mouse('mouseMoved', start);
  await mouse('mousePressed', start, 'left', 1);
  for (const index of indices.slice(1)) await mouse('mouseMoved', await point(index), 'left', 1);
  return point(indices.at(-1));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1280, height: 900, frame: false, useContentSize: true, show: true,
    title: 'Klaus navigation regression fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(path.join(root, 'fixture/index.html'));
  win.webContents.debugger.attach('1.3');
  await check('count and clearance thresholds', async () => {
    const values = [];
    const min = vectors.minimumTurns;
    for (const [count, gutter, hidden] of [[min - 1, 80, true], [min, 47, true], [min, 48, false], [min, 49, false]]) {
      const value = await reset(count, gutter); assert.equal(value.hidden, hidden); values.push(value);
    }
    return values;
  });
  await check('native click waits for release and navigates once', async () => {
    await reset(); const p = await point(8); await mouse('mouseMoved', p); await mouse('mousePressed', p, 'left', 1);
    const down = await snapshot(); assert.equal(down.navigations.length, 0);
    await mouse('mouseReleased', p, 'left'); await wait(850);
    const up = await snapshot(); assert.deepEqual(up.navigations, [{ index: 8, behavior: 'smooth' }]);
    assert(up.top > 0); assert(up.inputs.every(input => input.trusted)); return { down, up };
  });
  await check('secondary buttons do not navigate or capture', async () => {
    const values = [];
    for (const [button, buttons] of [['right', 2], ['middle', 4]]) {
      await reset(); const p = await point(8); await mouse('mouseMoved', p); await mouse('mousePressed', p, button, buttons); await mouse('mouseReleased', p, button);
      const value = await snapshot(); assert(value.top < 4); assert.equal(value.navigations.length, 0); assert.deepEqual(value.captures, []); values.push(value);
    }
    return values;
  });
  await check('drag release and free hover remain stable across six repetitions', async () => {
    const values = [];
    for (let rep = 0; rep < vectors.dragRepetitions; rep += 1) {
      const p = await startDrag(); const dragging = await snapshot(); assert.deepEqual(dragging.captures, [0]); assert(dragging.scrubbing);
      assert(dragging.navigations.every(item => item.behavior === 'auto'));
      await mouse('mouseReleased', p, 'left'); await wait(40); const released = await snapshot();
      await mouse('mouseMoved', await point(vectors.freeHoverIndex)); await wait(180); const free = await snapshot();
      assert(!released.scrubbing); assert.deepEqual(released.captures, []); assert.equal(free.top, released.top); assert.deepEqual(free.navigations, released.navigations);
      assert(free.inputs.every(input => input.trusted)); values.push({ dragging, released, free });
    }
    return values;
  });
  await check('outside release and lost capture clear gestures', async () => {
    const values = [];
    for (const action of ['outside', 'lost']) {
      const p = await startDrag();
      if (action === 'outside') { await mouse('mouseMoved', { x: 400, y: 400 }, 'left', 1); await mouse('mouseReleased', { x: 400, y: 400 }, 'left'); }
      else { await evaluate('navFixture.releaseCapture()'); await wait(30); await mouse('mouseReleased', p, 'left'); }
      const value = await snapshot(); assert(!value.scrubbing); assert.deepEqual(value.captures, []); values.push(value);
    }
    return values;
  });
  await check('pointer cancel, blur and suspension clear gestures', async () => {
    const values = [];
    for (const action of ['cancel', 'blur', 'suspend']) {
      const p = await startDrag();
      if (action === 'cancel') await evaluate('document.querySelector("button[data-turn-index=\\"0\\"]").dispatchEvent(new PointerEvent("pointercancel",{pointerId:1,bubbles:true}))');
      else if (action === 'blur') { win.blur(); await wait(80); win.focus(); await wait(80); }
      else { await evaluate('navFixture.suspend();navFixture.frames(8)'); }
      const value = await snapshot(); assert(!value.scrubbing); assert.deepEqual(value.captures, []); assert(!value.tooltip); values.push(value); await mouse('mouseReleased', p, 'left');
    }
    return values;
  });
  await check('hover delay and Escape dismiss pending and open previews', async () => {
    await reset(8); let p = await point(2); await mouse('mouseMoved', p); await wait(80); assert(!(await snapshot()).tooltip);
    await key('Escape'); await wait(200); assert(!(await snapshot()).tooltip);
    await reset(8); p = await point(2); await mouse('mouseMoved', p); await wait(200); const open = await snapshot(); assert(open.tooltip);
    assert(open.text.includes('Prompt 3')); assert(open.text.includes('Final answer 3')); assert(!open.text.includes('Final answer 4')); assert(!open.text.includes('Never preview'));
    await key('Escape'); const closed = await snapshot(); assert(!closed.tooltip); return { open, closed };
  });
  await check('keyboard roving and activation survive group boundaries', async () => {
    await reset(140); await evaluate('navFixture.focus(63)'); await key('ArrowDown'); assert.equal((await snapshot()).focus, 64);
    await key('End'); assert.equal((await snapshot()).focus, 139); await key('Home'); assert.equal((await snapshot()).focus, 0);
    await key('ArrowDown'); await key(' '); await wait(850); const value = await snapshot(); assert.equal(value.focus, 1); assert.equal(value.tabStops, 1);
    assert.deepEqual(value.navigations, [{ index: 1, behavior: 'smooth' }]); return value;
  });
  await check('focused markers retain one tab stop across append and earlier removal', async () => {
    await reset(130); await evaluate('navFixture.focus(64);navFixture.append();navFixture.frames(12)');
    const appended = await snapshot(); assert.equal(appended.focus, 64); assert.equal(appended.tabStops, 1);
    await evaluate('navFixture.removeFirst();navFixture.frames(12)'); const removed = await snapshot();
    assert.equal(removed.focus, 63); assert.equal(removed.tabStops, 1); return { appended, removed };
  });
  await check('preview Escape takes priority over composer shortcuts only while needed', async () => {
    await reset(8); await evaluate('navFixture.composerFocus()'); await mouse('mouseMoved', await point(2)); await wait(200);
    await key('Escape'); const dismissed = await snapshot(); assert(!dismissed.tooltip); assert.equal(dismissed.composerActions, 0);
    await key('Escape'); const passedThrough = await snapshot(); assert.equal(passedThrough.composerActions, 1); return { dismissed, passedThrough };
  });
  await check('same-height streaming text refreshes an open preview', async () => {
    await reset(8); await mouse('mouseMoved', await point(0)); await wait(200); const before = await snapshot();
    await evaluate('navFixture.updateAnswer();navFixture.frames(8)'); const after = await snapshot();
    assert(before.text.includes('Final answer 1')); assert(after.text.includes('Fresh answer 1')); assert(!after.text.includes('Final answer 1')); return { before, after };
  });
  await check('group-edge line geometry and neighbors match the pinned design', async () => {
    await reset(140); const p = await point(64); await mouse('mouseMoved', p); await wait(240);
    const lines = await evaluate('[61,62,63,64,65,66,67].map(index=>navFixture.line(index))');
    const expected = [10, 14, 20, 26, 20, 14, 10]; lines.forEach((line, index) => assert(Math.abs(line.width - expected[index]) < 0.03));
    assert.equal(lines[3].hitWidth, vectors.geometry.hitWidth); assert.equal(lines[3].x, vectors.geometry.lineLeft); assert.equal(lines[3].radius, '0px');
    fs.writeFileSync(path.join(root, 'group-boundary.png'), (await win.webContents.capturePage()).toPNG()); return lines;
  });
  await check('tail growth updates the reading line without remeasuring anchor tops', async () => {
    await reset(); await evaluate('navFixture.scroll(100000);navFixture.frames(8)'); await evaluate('navFixture.readReset()'); const before = await snapshot();
    await evaluate('navFixture.resizeLast();navFixture.frames(12)'); const after = await snapshot();
    assert.equal(after.top, before.top); assert.equal(after.height - before.height, 600); assert.equal(after.rectReads, 0);
    const expected = Math.floor((after.top + after.viewport * 0.25) / 248); assert.deepEqual(after.current, [expected]); return { before, after };
  });
  await check('middle and simultaneous growth update cached geometry with bounded anchor reads', async () => {
    const values = [];
    for (const wrapped of [false, true]) {
      await evaluate(`(async()=>{await navFixture.reset(140,80,false,${wrapped});navFixture.scroll(6000);await navFixture.frames(8);navFixture.readReset()})()`);
      await evaluate('navFixture.resizeAt(5,784);navFixture.resizeAt(15,484);navFixture.frames(12)'); const value = await snapshot();
      assert(value.rectReads <= 3); assert.deepEqual(value.current, [await evaluate('navFixture.expectedCurrent()')]); values.push(value);
    }
    return values;
  });
  await check('visible range and marker identity survive append and removal', async () => {
    await reset(130); const before = await snapshot(); assert.deepEqual(before.visible, [0, 1, 2, 3]);
    await evaluate('navFixture.identity();navFixture.append();navFixture.frames(12)'); assert(await evaluate('navFixture.identityKept()'));
    assert.equal((await snapshot()).count, 131); await evaluate('navFixture.removeLast();navFixture.frames(12)'); const after = await snapshot();
    assert.equal(after.count, 130); assert.equal(after.tabStops, 1); return { before, after };
  });
  await check('nested live DOM is navigable and hidden anchors are excluded', async () => {
    await reset(4, 80, true); assert.equal((await snapshot()).count, 4); const p = await point(3);
    await mouse('mouseMoved', p); await mouse('mousePressed', p, 'left', 1); await mouse('mouseReleased', p, 'left'); await wait(850);
    assert.equal((await snapshot()).navigations[0].index, 3); await evaluate('navFixture.hideLast();navFixture.frames(12)'); const hidden = await snapshot(); assert.equal(hidden.count, 3); assert(!hidden.hidden); await evaluate('navFixture.hideAllButFirst();navFixture.frames(12)'); const below = await snapshot(); assert.equal(below.count, 1); assert(below.hidden); return below;
  });
  await check('real React history plus live fourth prompt and handoff do not lose or duplicate markers', async () => {
    const live = await evaluate('(async()=>{await navFixture.realLive();navFixture.saveContent();return navFixture.snapshot()})()'); assert(live.contentWrapper); assert.equal(live.count, 4); assert.equal(live.turnWrappers, 4); assert(!live.hidden);
    const history = await evaluate('navFixture.handoff()'); assert.equal(history.count, 4); assert.equal(history.turnWrappers, 4); assert(history.contentKept); return { live, history };
  });
  await check('steered user messages share a turn wrapper and remain individually navigable', async () => {
    const state = await evaluate('navFixture.steeredHistory()'); assert.equal(state.count, 5); assert.equal(state.turnWrappers, 4); assert.equal(state.firstTurnAnchors, 2);
    await mouse('mouseMoved', await point(1)); await wait(200); const preview = await snapshot(); assert(preview.text.includes('Steering in the same turn')); assert(preview.text.includes('Legacy final 1')); return { state, preview };
  });
  await check('late content mounting and height-only growth update the outer scrollbar', async () => {
    const before = await evaluate('navFixture.realLive(true)'); assert.equal(parseFloat(before.proxyRange), before.height);
    await evaluate('navFixture.enlargeReactAnswer();navFixture.frames(15)'); const grown = await snapshot(); assert.equal(parseFloat(grown.proxyRange), grown.height); assert(grown.height > before.height);
    return { before, grown };
  });
  await check('main, none, static and unmount retain a single React owner', async () => {
    await evaluate('(async()=>{await navFixture.realLive();await navFixture.handoff()})()'); const states = [];
    for (const mode of ['none', 'static', 'main', 'unmount']) {
      const value = await evaluate(`navFixture.mode(${JSON.stringify(mode)})`); assert.equal(value.contentWrapper, mode === 'main'); assert.equal(value.count, mode === 'unmount' ? 0 : 4); states.push(value);
    }
    return states;
  });
  await check('real legacy final answers remain visible and explicit late commentary stays out of previews', async () => {
    await evaluate('navFixture.legacyHistory()'); await mouse('mouseMoved', await point(0)); await wait(200); const legacy = await snapshot(); assert(legacy.text.includes('Legacy final 1'));
    await mouse('mouseMoved', { x: 1100, y: 400 }); await evaluate('navFixture.finalWithCommentary()'); await mouse('mouseMoved', await point(0)); await wait(200);
    const final = await snapshot(); assert(final.text.includes('Legacy final 1')); assert(!final.text.includes('Late commentary')); return { legacy, final };
  });
  await check('final preview excludes later commentary and reduced motion disables transitions', async () => {
    await reset(8); await evaluate('navFixture.addCommentary()'); await mouse('mouseMoved', await point(0)); await wait(200);
    assert(!(await snapshot()).text.includes('Commentary')); await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await reset(8); const p = await point(3); await mouse('mouseMoved', p); await mouse('mousePressed', p, 'left', 1); await mouse('mouseReleased', p, 'left'); await wait(60);
    const value = await snapshot(); assert.equal(value.navigations[0].behavior, 'auto'); assert.equal((await evaluate('navFixture.line(3)')).transition, '0s');
    return value;
  });
  console.log(JSON.stringify({ passed: checks.length, failed: 0, viewport: await evaluate('({width:innerWidth,height:innerHeight,devicePixelRatio})') }));
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
