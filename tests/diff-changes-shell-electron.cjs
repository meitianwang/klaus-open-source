const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { navigation } = require('../contracts/vectors/changes-review.json');

const output = process.env.KLAUS_DIFF_TEST_ROOT;
if (!output) throw new Error('Missing isolated Changes shell output directory');
mkdirSync(output, { recursive: true });
app.setPath('userData', join(output, 'profile'));
const checks = [], errors = [];
let window;
const evaluate = source => window.webContents.executeJavaScript(source, true);
const geometry = () => evaluate('changesShellFixture.geometry()');
async function check(name, action) {
  try { checks.push({ name, passed: true, evidence: await action() }); }
  catch (error) { checks.push({ name, passed: false, error: error.stack, geometry: await geometry() }); writeFileSync(join(output, name.split(' ')[0] + '-failure.png'), (await window.webContents.capturePage()).toPNG()); }
  writeFileSync(join(output, 'native-results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify(checks.at(-1)));
}
function stableShell(value, open) {
  assert.equal(value.app.top, navigation.applicationTop, 'The application must remain at the viewport origin');
  assert.equal(value.app.bottom, value.viewport.height, 'The application must fill the viewport without a bottom strip');
  assert.equal(value.sidebar.top, 0, 'File navigation must not scroll the conversation sidebar');
  assert(value.ancestors.every(node => node.top === navigation.ancestorScrollTop && node.left === 0), 'Only the review list may scroll');
  if (open) {
    assert.equal(value.collapseVisible, navigation.collapseVisibleWhileOpen, 'The panel collapse control must remain visible and reachable');
    assert(value.tabLabels.length >= 2, 'Panel navigation tabs must remain visible and reachable');
  } else assert.equal(value.railVisible, navigation.railVisibleAfterCollapse, 'The Changes side-rail entry must return after collapse');
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, show: true, title: 'Changes navigation fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await window.loadFile(join(output, 'fixture/index.html'));
  for (let index = 0; index < 120; index++) {
    if (await evaluate('Boolean(window.changesShellFixture)')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await evaluate('changesFixture.settled()');
  for (const outerRange of [false, true]) for (const entry of ['side-rail', 'capsule']) await check(entry + (outerRange ? ' with outer scroll range' : '') + ' navigation preserves the surrounding shell', async () => {
    await evaluate(`changesShellFixture.outerScrollRange(${outerRange}); changesFixture.reset('navigation')`);
    await evaluate('hideDiffView(); changesShellFixture.resetScroll(); changesFixture.frames(20)');
    const before = await geometry(); stableShell(before, false);
    await evaluate(entry === 'side-rail' ? 'document.getElementById("btn-diff").click(); changesFixture.settled()' : 'document.querySelector("#changes-capsule-fixture button").click(); changesFixture.settled()');
    const opened = await geometry();
    writeFileSync(join(output, entry + (outerRange ? '-outer-range' : '') + '-opened.png'), (await window.webContents.capturePage()).toPNG());
    stableShell(opened, true);
    await evaluate(`changesFixture.selectRow(${entry === 'side-rail' ? 1 : 0})`);
    const selected = await geometry(); stableShell(selected, true);
    if (entry === 'side-rail') assert(selected.reviewScroll > 0, 'Selecting a later file must still scroll its review list');
    await evaluate('document.getElementById("artifacts-panel-toggle-inner").click(); changesFixture.frames(20)');
    const closed = await geometry(); stableShell(closed, false);
    writeFileSync(join(output, entry + '-closed.png'), (await window.webContents.capturePage()).toPNG());
    return { before, opened, selected, closed };
  });
  assert.deepEqual(errors, []);
  const failed = checks.some(row => !row.passed);
  console.log(JSON.stringify({ passed: !failed, checks: checks.length, errors }));
  app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error.stack); app.exit(1); });
