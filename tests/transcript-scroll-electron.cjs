const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_SCROLL_TEST_ROOT;
if (!root) throw new Error('KLAUS_SCROLL_TEST_ROOT is required');
app.setPath('userData', path.join(root, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const checks = [], browserErrors = [];
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const geometry = () => evaluate('scrollFixture.geometry()');
async function until(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const errors = await evaluate('window.scrollFixture?.errors || []');
    assert.deepEqual(errors, []);
    if (await evaluate(expression)) return;
    await wait(40);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function wheel(deltaY, count = 1, interval = 22) {
  const point = await evaluate('(()=>{const b=document.querySelector("#messages").getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()');
  for (let index = 0; index < count; index++) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await wait(interval);
  }
}
async function check(name, run) {
  await evaluate(`scrollFixture.phase(${JSON.stringify(name)})`);
  try {
    const evidence = await run();
    checks.push({ name, passed: true, evidence });
    console.log(JSON.stringify({ name, passed: true }));
  } catch (error) {
    checks.push({ name, passed: false, error: String(error.stack || error), geometry: await geometry() });
    throw error;
  } finally {
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(checks, null, 2));
  }
}
function anchorDrift(before, after) {
  assert(before.anchor && after.anchor, 'Both positions need a visible measured turn');
  assert.equal(after.anchor.key, before.anchor.key);
  return Math.abs(after.anchor.top - before.anchor.top);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, frame: false, show: true,
    title: 'Klaus transcript scrolling fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', event => { if (event.level === 'error') browserErrors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => browserErrors.push(JSON.stringify(details)));
  await win.loadFile(path.join(root, 'fixture/index.html'));
  win.webContents.debugger.attach('1.3');
  await until('window.fixtureReady === true');
  await evaluate('scrollFixture.startSamples()');
  await check('cold history opens at the latest content', async () => {
    const start = Date.now(), value = await evaluate('scrollFixture.open("history")');
    assert(value.renderedTurns > 0);
    assert(value.loadedTurns >= 5);
    assert(value.distance <= 1, `Initial distance: ${value.distance}`);
    assert(value.following);
    return { ...value, elapsedMs: Date.now() - start };
  });
  await check('upward paging keeps content visible and never reverses the reader', async () => {
    const before = await geometry();
    await wheel(-160, 65);
    await wait(450);
    const after = await geometry();
    const trace = await evaluate('scrollFixture.samples.filter(frame=>frame.phase==="upward paging keeps content visible and never reverses the reader")');
    const blanks = trace.filter(frame => frame.loadedTurns > 0 && !frame.covered);
    const reversals = trace.filter(frame => frame.trackedDelta != null && frame.trackedDelta < -3);
    assert(after.loadedTurns > before.loadedTurns, 'The gesture must cross an older-page boundary');
    assert(after.distance > before.distance + 500);
    assert(!after.following);
    assert.equal(blanks.length, 0, `Blank frames: ${blanks.length}`);
    assert.equal(reversals.length, 0, `Reverse displacement frames: ${JSON.stringify(reversals.slice(0, 3))}`);
    const inputs = await evaluate('scrollFixture.inputs');
    assert(inputs.length > 0 && inputs.every(input => input.trusted), 'Native wheel events are required');
    return { before, after, sampledFrames: trace.length, blankFrames: blanks.length, reverseFrames: reversals.length };
  });
  await check('switching restores the reading position before the first visible frame', async () => {
    await wheel(-120, 12);
    await wait(120);
    const before = await geometry();
    await evaluate('scrollFixture.open("other")');
    await evaluate('scrollFixture.phase("restoring-history")');
    const after = await evaluate('scrollFixture.open("history")');
    const first = await evaluate('scrollFixture.samples.find(frame=>frame.phase==="restoring-history"&&frame.sessionId==="history"&&frame.covered)');
    assert(first, 'Capture the first frame with restored content');
    assert(anchorDrift(before, first) <= 2, `First-frame drift: ${anchorDrift(before, first)}`);
    assert(anchorDrift(before, after) <= 2);
    assert(!after.following);
    return { before, first, after };
  });
  await check('a viewport width change preserves the reading anchor', async () => {
    const before = await geometry();
    win.setContentSize(880, 800);
    await evaluate('scrollFixture.frames(12)');
    const after = await geometry();
    assert(anchorDrift(before, after) <= 2);
    assert(!after.following);
    win.setContentSize(1100, 800);
    await evaluate('scrollFixture.frames(12)');
    return { before, after, restoredWidth: await geometry() };
  });
  await check('layout compensation cannot resume following', async () => {
    await evaluate('scrollFixture.bottom()');
    await wheel(-60, 3);
    await wait(100);
    const before = await geometry();
    assert(!before.following);
    const above = await evaluate('scrollFixture.grow("above",160)');
    assert(above.result, 'An overscanned older row must grow above the viewport');
    assert(!above.geometry.following);
    assert(anchorDrift(before, above.geometry) <= 2);
    const latest = await evaluate('scrollFixture.grow("latest",160)');
    assert(latest.result);
    assert(!latest.geometry.following);
    assert(latest.geometry.distance > 24);
    return { before, above, latest };
  });
  await check('a structured submission reserves response space and consumes it before following', async () => {
    await evaluate('scrollFixture.bottom()');
    const placed = await evaluate('scrollFixture.send()');
    const padding = await evaluate('parseFloat(getComputedStyle(document.querySelector("#messages")).getPropertyValue("--thread-scroll-padding-bottom")) || 0');
    const available = placed.viewport - padding;
    const expected = Math.max(0, Math.min(available * 2 / 3, available - 240));
    assert(placed.userTop != null, 'The structured user message must be rendered');
    assert(Math.abs(placed.spacer - expected) <= 2, `Response room ${placed.spacer}, expected ${expected}`);
    assert(placed.distance > 24, 'Placement must reserve room below the viewport');
    const small = await evaluate('scrollFixture.appendReply(2)');
    assert(small.spacer < placed.spacer && small.spacer > 0);
    assert(Math.abs(small.userTop - placed.userTop) <= 2, 'A short reply grows into the reserved space');
    const large = await evaluate('scrollFixture.appendReply(45)');
    assert(large.spacer <= 1);
    assert(large.distance <= 24, `Overflow reply distance: ${large.distance}`);
    return { placed, small, large, expectedSpacerPx: expected };
  });
  const errors = await evaluate('scrollFixture.errors');
  assert.deepEqual(errors, []);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: checks.length, failed: 0 }));
}).catch(async error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  process.exitCode = 1;
}).finally(async () => {
  if (win && !win.isDestroyed()) {
    await evaluate('scrollFixture.stopSamples()').catch(() => {});
    const trace = await evaluate('({frames:scrollFixture.samples,writes:scrollFixture.writes,calls:scrollFixture.calls,inputs:scrollFixture.inputs,errors:scrollFixture.errors})').catch(error => ({ error: String(error) }));
    fs.writeFileSync(path.join(root, 'frame-trace.json'), JSON.stringify({ command: 'npm run test:transcript-scroll', ...trace, browserErrors }, null, 2));
    win.destroy();
  }
  app.exit(process.exitCode || 0);
});
