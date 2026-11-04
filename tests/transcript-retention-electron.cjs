const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_RETENTION_TEST_ROOT;
if (!root) throw new Error('KLAUS_RETENTION_TEST_ROOT is required');
app.setPath('userData', path.join(root, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], browserErrors = [];
let win;
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
async function until(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    assert.deepEqual(await evaluate('window.retentionFixture?.errors || []'), []);
    if (await evaluate(expression)) return;
    await wait(40);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function wheel(deltaY, count = 1) {
  const point = await evaluate('(()=>{const r=document.querySelector("#messages").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
  for (let index = 0; index < count; index++) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await wait(25);
  }
}
async function check(name, run) {
  await evaluate(`retentionFixture.phase(${JSON.stringify(name)})`);
  try {
    const evidence = await run();
    checks.push({ name, passed: true, evidence });
    console.log(JSON.stringify({ name, passed: true }));
  } catch (error) {
    checks.push({ name, passed: false, error: String(error.stack || error), state: await evaluate('retentionFixture.snapshot()') });
    throw error;
  } finally {
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(checks, null, 2));
  }
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, frame: false, show: true,
    title: 'Klaus history retention fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  win.webContents.on('console-message', event => { if (event.level === 'error') browserErrors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => browserErrors.push(JSON.stringify(details)));
  await win.loadFile(path.join(root, 'fixture/index.html'));
  win.webContents.debugger.attach('1.3');
  await until('window.fixtureReady === true');
  await check('a newly mounted bottom reader releases only the safe item prefix', async () => {
    const state = await evaluate('retentionFixture.open(false)');
    assert.equal(state.items, 500);
    assert.equal(state.unique, 500);
    assert.deepEqual(state.unknown, []);
    assert.equal(state.shells.length, 5);
    assert.equal(state.shells[0].count, 0);
    assert.equal(state.shells[1].count, 0);
    assert.equal(state.shells[2].count, 20);
    assert.equal(state.shells[2].pager.olderItemId, 'retention-t2-tool-219');
    assert(state.primary.distance <= 1);
    assert.deepEqual(state.errors, []);
    return state;
  });
  await evaluate('retentionFixture.start()');
  await check('native upward scrolling restores every evicted prompt and item without expanding process', async () => {
    const before = await evaluate('retentionFixture.snapshot()');
    await wheel(-180, 100);
    await until('retentionFixture.snapshot().items === 1200');
    const after = await evaluate('retentionFixture.snapshot()');
    assert.equal(after.unique, 1200);
    assert.deepEqual(after.unknown, []);
    const expected = await evaluate('retentionFixture.sourceIds()');
    const actual = await evaluate('retentionFixture.historyIds()');
    assert.deepEqual(actual, expected, 'Every original source item must be restored once and in order');
    assert.equal((await evaluate('retentionFixture.recoveredPrompts()')).length, 5);
    assert(after.shells.every(turn => turn.pager.hasLoadedOldest && !turn.pager.evicted));
    const calls = await evaluate('retentionFixture.calls.filter(call=>call.method==="historyItems")');
    assert(calls.some(call => call.options.beforeItemId === 'retention-t2-tool-219'), 'The partially evicted turn must use its retained item anchor');
    const frames = await evaluate('retentionFixture.samples.filter(frame=>frame.phase==="native upward scrolling restores every evicted prompt and item without expanding process")');
    assert(frames.length > 0);
    assert.equal(frames.filter(frame => !frame.primary.visibleCoverage).length, 0, 'No sampled viewport may be blank while restoring history');
    assert.equal(frames.flatMap(frame => frame.primary.inflatedEmpty).filter(row => row.visible).length, 0, 'An empty turn cannot leave a visible estimated-height hole');
    assert(await evaluate('document.querySelector("#messages [data-uuid=retention-t0-user]") != null'), 'The oldest prompt must appear through ordinary scrolling');
    const inputs = await evaluate('retentionFixture.inputs');
    assert(inputs.length > 0 && inputs.every(input => input.trusted));
    return { before, after, itemRequests: calls.map(call => call.options), sampledFrames: frames.length };
  });
  await check('an off-bottom second surface protects shared history until both readers return', async () => {
    const before = await evaluate('retentionFixture.open(true)');
    assert(before.secondary.distance > 24);
    assert.equal(before.items, 1200);
    await wait(300);
    const protectedState = await evaluate('retentionFixture.snapshot()');
    assert.equal(protectedState.items, 1200);
    const after = await evaluate('retentionFixture.bottomSecondary()');
    assert(after.secondary.distance <= 1);
    assert(after.primary.distance <= 1);
    assert.equal(after.items, 500);
    assert.equal(after.shells.length, 5);
    return { before, protectedState, after };
  });
  assert.deepEqual(await evaluate('retentionFixture.errors'), []);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: checks.length, failed: 0 }));
}).catch(async error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  process.exitCode = 1;
}).finally(async () => {
  if (win && !win.isDestroyed()) {
    await evaluate('retentionFixture.stop()').catch(() => {});
    const trace = await evaluate('({frames:retentionFixture.samples,calls:retentionFixture.calls,inputs:retentionFixture.inputs,errors:retentionFixture.errors})').catch(error => ({ error: String(error) }));
    fs.writeFileSync(path.join(root, 'frame-trace.json'), JSON.stringify({ command: 'node scripts/run-transcript-retention-test.mjs', ...trace, browserErrors }, null, 2));
    win.destroy();
  }
  app.exit(process.exitCode || 0);
});
