const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_PROCESSING_TEST_ROOT;
app.setPath('userData', path.join(root, 'profile'));
let win;
const checks = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
const snapshot = () => evaluate('processingFixture.snapshot()');
async function check(name, run) {
  try { checks.push({ name, passed: true, evidence: await run() }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); throw error; }
  finally { fs.writeFileSync(path.join(root, 'dom-results.json'), JSON.stringify(checks, null, 2)); }
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 900, height: 650, show: true, title: 'Turn processing fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(path.join(root, 'fixture/index.html'));
  await check('provisional submission renders and ticks before any host identity, then preserves its clock on promotion', async () => {
    await evaluate('processingFixture.mountPending()'); await wait(60); const initial = await snapshot();
    assert.match(initial.text, /A submitted request waiting for its session/); assert.equal(initial.workLabels, 1); assert.equal(initial.hostLookups, 0);
    await wait(1100); const pending = await snapshot(); assert.match(pending.label, /^Working for [1-9]\d*s$/); assert.equal(pending.hostLookups, 0);
    fs.writeFileSync(path.join(root, 'pending.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate('processingFixture.promotePending()'); await wait(60); const promoted = await snapshot();
    assert.equal(promoted.label, pending.label); assert.equal(promoted.clockStart, pending.clockStart); assert.equal(promoted.workLabels, 1);
    assert.equal((promoted.text.match(/A submitted request waiting for its session/g) || []).length, 1);
    return { initial, pending, promoted };
  });
  await check('the mounted initial clock advances without streamed events', async () => {
    await evaluate('processingFixture.mount()'); const initial = await snapshot();
    assert.equal(initial.label, 'Working'); assert.equal(initial.workLabels, 1); assert.equal(initial.placeholderRows, 1);
    await wait(1150); const tick = await snapshot(); assert.match(tick.label, /^Working for [1-9]\d*s$/);
    return { initial, tick };
  });
  await check('one header precedes the expanded process and survives final streaming', async () => {
    await evaluate('processingFixture.addWork()'); await wait(60); const working = await snapshot();
    assert.equal(working.disclosureHeaders, 1); assert.equal(working.workLabels, 1); assert.equal(working.placeholderRows, 0);
    assert.equal(working.expanded, 'true'); assert.equal(working.processVisible, true); assert.equal(working.headerBeforeProcess, true);
    fs.writeFileSync(path.join(root, 'running.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate('processingFixture.startFinal()'); const final = await snapshot();
    assert.match(final.label, /^Worked for /); assert.equal(final.expanded, 'true'); assert.equal(final.finalVisible, true);
    await wait(1150); const frozen = await snapshot(); assert.equal(frozen.label, final.label);
    return { working, final, frozen };
  });
  await check('terminal completion collapses only the process and retains its header', async () => {
    const before = await snapshot(); await evaluate('processingFixture.complete()'); await wait(200); const after = await snapshot();
    assert.equal(after.expanded, 'false'); assert.equal(after.processVisible, false); assert.equal(after.finalVisible, true);
    assert.equal(after.label, before.label); assert.equal(after.workLabels, 1);
    fs.writeFileSync(path.join(root, 'completed.png'), (await win.webContents.capturePage()).toPNG());
    return { before, after };
  });
  await check('local work times preserve the label across saved-history handoff', async () => {
    const before = await snapshot(); await evaluate('processingFixture.handoffHistory()'); await wait(200); const after = await snapshot();
    assert.equal(after.label, before.label); assert.equal(after.workLabels, 1); assert.equal(after.expanded, 'false'); assert.equal(after.finalVisible, true);
    return { before, after };
  });
  await check('manual collapse and expansion remain authoritative through completion', async () => {
    await evaluate('processingFixture.mount("side", 2500); processingFixture.addWork()');
    await evaluate('processingFixture.toggle()'); await wait(200); const collapsed = await snapshot(); assert.equal(collapsed.expanded, 'false');
    await evaluate('processingFixture.startFinal()'); const streaming = await snapshot(); assert.equal(streaming.expanded, 'false'); assert.equal(streaming.finalVisible, true);
    await evaluate('processingFixture.toggle()'); await wait(60); const expanded = await snapshot(); assert.equal(expanded.expanded, 'true');
    await evaluate('processingFixture.complete()'); await wait(60); const completed = await snapshot(); assert.equal(completed.expanded, 'true'); assert.equal(completed.processVisible, true);
    return { collapsed, streaming, expanded, completed };
  });
  await check('child live views share the running disclosure and terminal behavior', async () => {
    await evaluate('processingFixture.mount("subagent", 2500); processingFixture.addWork()'); await wait(60);
    const active = await snapshot(); assert.equal(active.expanded, 'true'); assert.equal(active.processVisible, true);
    await evaluate('processingFixture.startFinal(); processingFixture.complete()'); await wait(200);
    const complete = await snapshot(); assert.equal(complete.expanded, 'false'); assert.equal(complete.finalVisible, true);
    return { active, complete };
  });
  await check('a terminal turn can collapse its process without a final message', async () => {
    await evaluate('processingFixture.mount("main", 2500); processingFixture.addWork(); processingFixture.complete()'); await wait(200);
    const value = await snapshot(); assert.equal(value.expanded, 'false'); assert.equal(value.processVisible, false); assert.match(value.label, /^Worked for /);
    return value;
  });
  await check('read-only saved views keep the same header and manual choice', async () => {
    await evaluate('processingFixture.mountStatic(true)'); await wait(60); const active = await snapshot();
    assert.equal(active.expanded, 'true'); assert.equal(active.headerBeforeProcess, true); assert.equal(active.label, 'Worked for 2s');
    await evaluate('processingFixture.toggle()'); await wait(200); const collapsed = await snapshot(); assert.equal(collapsed.expanded, 'false'); assert.equal(collapsed.finalVisible, true);
    await evaluate('processingFixture.mountStatic(false)'); await wait(60); const completed = await snapshot(); assert.equal(completed.expanded, 'false'); assert.equal(completed.finalVisible, true);
    return { active, collapsed, completed };
  });
  await check('a failed provisional conversation exposes a working recovery button', async () => {
    await evaluate('processingFixture.mountPending(); processingFixture.failPending()'); await wait(60); const failed = await snapshot();
    assert.equal(failed.recoveryAction, 'back'); assert.match(failed.text, /Go back/); assert.match(failed.text, /could not be created/);
    await evaluate('processingFixture.recoverPending()'); const recovered = await snapshot();
    assert.equal(recovered.recoveryClicks, failed.recoveryClicks + 1); assert.equal(recovered.recoveryAction, null);
    assert.doesNotMatch(recovered.text, /A submitted request waiting for its session/);
    return { failed, recovered };
  });
  await check('localized working and completed labels share the same elapsed value', async () => {
    await evaluate('processingFixture.locale("zh"); processingFixture.mount("main", 65000); processingFixture.addWork()'); await wait(60); const active = await snapshot();
    assert.match(active.label, /^已处理 1分钟 5秒$/);
    await evaluate('processingFixture.startFinal()'); const final = await snapshot(); assert.match(final.label, /^用时 1分钟 5秒$/);
    await evaluate('processingFixture.complete()'); await wait(200); const completed = await snapshot(); assert.equal(completed.label, final.label); assert.equal(completed.expanded, 'false');
    await evaluate('processingFixture.locale("en")'); return { active, final, completed };
  });
  await check('saved and streamed placeholders become one process header through final streaming and completion', async () => {
    await evaluate('processingFixture.mountMixedHistory()'); await wait(60); const initial = await snapshot();
    assert.equal(initial.workLabels, 1); assert.equal(initial.placeholderRows, 1); assert.equal(initial.userMessages, 1);
    await evaluate('processingFixture.addWork()'); await wait(60); const working = await snapshot();
    assert.equal(working.workLabels, 1); assert.equal(working.placeholderRows, 0); assert.equal(working.disclosureHeaders, 1);
    assert.equal(working.expanded, 'true'); assert.equal(working.processVisible, true); assert.equal(working.headerBeforeProcess, true);
    fs.writeFileSync(path.join(root, 'mixed-history-running.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate('processingFixture.toggle()'); await wait(200); const collapsed = await snapshot();
    assert.equal(collapsed.workLabels, 1); assert.equal(collapsed.expanded, 'false'); assert.equal(collapsed.processVisible, false);
    await evaluate('processingFixture.startFinal()'); const final = await snapshot();
    assert.equal(final.workLabels, 1); assert.equal(final.expanded, 'false'); assert.equal(final.finalVisible, true);
    await evaluate('processingFixture.complete()'); await wait(200); const completed = await snapshot();
    assert.equal(completed.workLabels, 1); assert.equal(completed.label, final.label); assert.equal(completed.finalVisible, true);
    return { initial, working, collapsed, final, completed };
  });
  await check('saved process supersedes a streamed placeholder and shares the header with streamed process', async () => {
    const states = [];
    for (const mode of ['saved-process', 'live-process', 'both-process']) {
      await evaluate(`processingFixture.mountMixedHistory(${JSON.stringify(mode)})`); await wait(60); const value = await snapshot();
      assert.equal(value.workLabels, 1); assert.equal(value.placeholderRows, 0); assert.equal(value.disclosureHeaders, 1);
      assert.equal(value.userMessages, 1); assert.equal(value.expanded, 'true');
      if (mode !== 'live-process') assert.match(value.text, /Saved process\./);
      if (mode !== 'saved-process') assert.match(value.text, /Inspecting the saved changes\./);
      states.push({ mode, ...value });
    }
    return states;
  });
  await check('sent content, images and selection survive acknowledgements and action state updates', async () => {
    const transitions = await evaluate('processingFixture.userMessageStability()');
    assert.equal(transitions.length, 7);
    for (const row of transitions) assert.equal(row.passed, true, JSON.stringify(row));
    fs.writeFileSync(path.join(root, 'sent-message-stability.png'), (await win.webContents.capturePage()).toPNG());
    return transitions;
  });
  await check('submitted messages retain their nodes through promotion, saved history and durable image loading', async () => {
    const transitions = await evaluate('processingFixture.userMessageContinuity()');
    assert.equal(transitions.length, 12);
    for (const row of transitions) assert.equal(row.passed, true, JSON.stringify(row));
    return transitions;
  });
  await check('question answers retain their arrival position and completed-turn disclosure across ownership changes', async () => {
    const transitions = await evaluate('processingFixture.questionAnswerPlacement()');
    assert.equal(transitions.length, 22);
    for (const row of transitions) assert.equal(row.passed, true, JSON.stringify(row));
    return transitions;
  });
  console.log(`turn-processing DOM fixture: ${checks.length} passed, 0 failed`);
  win.destroy(); app.quit();
}).catch(error => { console.error(error.stack); win?.destroy(); app.exit(1); });
