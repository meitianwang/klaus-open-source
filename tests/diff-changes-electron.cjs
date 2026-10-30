const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const contract = require('../contracts/vectors/changes-review.json');
const output = process.env.KLAUS_DIFF_TEST_ROOT;
if (!output) throw new Error('Missing isolated Changes fixture output directory');
mkdirSync(output, { recursive: true }); app.setPath('userData', join(output, 'profile'));
let window;
const checks = [], rendererErrors = [];
const evaluate = expression => window.webContents.executeJavaScript(expression, true);
const snapshot = () => evaluate('changesFixture.snapshot()');
const reset = scenario => evaluate(`changesFixture.reset(${JSON.stringify(scenario ?? 'normal')})`);
const select = (label, value) => evaluate(`changesFixture.selectControl(${JSON.stringify(label)},${JSON.stringify(value)})`);
const menu = (label, item) => evaluate(`changesFixture.menu(${JSON.stringify(label)},${JSON.stringify(item)})`);
const click = label => evaluate(`changesFixture.click(${JSON.stringify(label)})`);
const input = (label, value) => evaluate(`changesFixture.input(${JSON.stringify(label)},${JSON.stringify(value)})`);
const settled = () => evaluate('changesFixture.settled()');
async function check(name, action) {
  try { const evidence = await action(); checks.push({ name, passed: true, evidence }); console.log(JSON.stringify({ name, passed: true })); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); writeFileSync(join(output, 'failure-state.json'), JSON.stringify(await snapshot(),null,2)); writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()); throw error; }
  finally { writeFileSync(join(output, 'native-results.json'), JSON.stringify(checks, null, 2)); }
}
const scopedRequests = state => state.requests.filter(request => request.sessionId === state.reviewSessionId);
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1000, height: 850, useContentSize: true, show: true, title: 'Klaus Changes fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith('file:') && !request.url.startsWith('data:') && !request.url.startsWith('blob:') && !request.url.startsWith('chrome-extension:') && !request.url.startsWith('chrome:') }));
  window.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error(event.message); } });
  await window.loadFile(join(output, 'fixture/index.html')); await settled();
  await check('branch uses automatic remote base and preserves qualified local and remote selections', async () => {
    const initial = await reset(); assert.equal(initial.source, contract.entries.checkout.source); assert.equal(initial.baseBranch, null); assert.deepEqual(initial.preferences, contract.defaults);
    assert(scopedRequests(initial).filter(row => row.operation === 'summary' && row.options.source === 'branch').every(row => row.options.baseBranch === null));
    const remote = await select('Base branch', 'refs/remotes/origin/main'); assert.equal(remote.baseBranch, 'refs/remotes/origin/main');
    const local = await select('Base branch', 'origin/main'); assert.equal(local.baseBranch, 'origin/main');
    const automatic = await select('Base branch', ''); assert.equal(automatic.baseBranch, null);
    const custom = await evaluate('changesFixture.customBase("release/v2^{commit}")'); assert.equal(custom.baseBranch, 'release/v2^{commit}');
    return { initial, remote: remote.baseBranch, local: local.baseBranch, custom: custom.baseBranch };
  });
  await check('all comparison scopes and repository selection retain their own request identities', async () => {
    await reset(); const states = [];
    for (const source of ['unstaged', 'staged', 'commit', 'uncommitted', 'last-turn', 'branch']) {
      const state = await select('Scope', source); assert.equal(state.source, source);
      assert.equal(scopedRequests(state).filter(row => row.operation === 'summary').at(-1).options.source, source); states.push({ source, repository: state.repositoryRoot });
    }
    const all = await select('Scope', 'last-turn'); assert.equal(all.repositoryRoot, null);
    const repo = await select('Repository', '/fixture/worktrees/topic/project'); assert.equal(repo.source, 'uncommitted'); assert.equal(repo.repositoryRoot, '/fixture/worktrees/topic/project');
    return { states, last: repo };
  });
  await check('file navigation scrolls a continuous diff list and duplicate repository paths stay distinct', async () => {
    const initial = await reset(); assert.equal(initial.fileStates.length, 4); assert.equal(initial.rows.length, 4);
    await evaluate('changesFixture.button("new.txt", document.querySelector("[role=tree]")).click()');
    let state = await settled(); assert(state.selectedPath.includes('new.txt')); assert.equal(state.fileStates.length, 4);
    state = await select('Scope', 'last-turn'); assert.equal(state.rows.length, 2);
    const first = state.rows[0].key, second = state.rows[1].key; assert.notEqual(first, second);
    await evaluate('changesFixture.selectRow(1)'); state = await settled(); assert.equal(state.selectedPath, second);
    assert.equal(state.hunkCacheKeys.length, 2);
    const focused = await evaluate('changesFixture.showTurn("older-turn", "/fixture/worktrees/topic/project/shared.ts")');
    assert.equal(focused.turnId, 'older-turn'); assert(focused.selectedPath.includes('/fixture/worktrees/topic/project'));
    return { initialFiles: initial.fileStates.length, focused };
  });
  await check('filter clear, tree collapse, jump selection and tree visibility are functional', async () => {
    await reset(); await input('Filter files…', 'review.ts'); let state = await snapshot(); assert.equal(state.rows.length, 1); assert.equal(state.fileStates.length, 1);
    await click('Clear'); state = await snapshot(); assert.equal(state.rows.length, 4);
    await evaluate('document.querySelector("[role=treeitem][data-directory=true]").click()');
    state = await snapshot(); assert(state.rows.length < 4);
    await click('File tree'); assert.equal(await evaluate('document.querySelector("[role=tree]") === null'), true);
    await menu('Jump to file', 'new.txt'); state = await snapshot(); assert(state.selectedPath.includes('new.txt'));
    await click('File tree'); return settled();
  });
  await check('view controls close on selection and alter native wrapping and layout without changing totals', async () => {
    const initial = await reset(); await menu('Review options', 'Word wrap');
    assert.equal(await evaluate('document.querySelector("[role=menu]") === null'), true);
    let state = await snapshot(); assert.equal(state.preferences.wordWrap, true);
    assert(await evaluate('document.querySelector("diffs-container").shadowRoot.querySelector("pre").getAttribute("data-overflow") === "wrap"'));
    await menu('Review options', 'Diff layout · Auto'); state = await snapshot(); assert.equal(state.preferences.layout, 'unified');
    await menu('Review options', 'Diff layout · Unified'); state = await snapshot(); assert.equal(state.preferences.layout, 'split');
    assert(await evaluate('document.querySelector("diffs-container").shadowRoot.querySelector("pre").getAttribute("data-diff-type") === "split"'));
    await menu('Review options', 'Collapse all diffs'); state = await snapshot(); assert(state.fileStates.every(file => file.collapsed === 'true'));
    await menu('Review options', 'Expand all diffs'); state = await settled(); assert(state.fileStates.every(file => file.collapsed === 'false'));
    assert.equal(state.rows.length, initial.rows.length); return state;
  });
  await check('keyboard menus, tree navigation, resizing and alternate collapse preserve their targets', async () => {
    await reset(); await menu('Scope');
    await evaluate(`document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
    assert.equal(await evaluate('document.activeElement.tagName'), 'SUMMARY');
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    assert(await evaluate('document.querySelector("details").open'));
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Scope');
    await evaluate(`(() => { const row = document.querySelector('[role=treeitem]'); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); })()`);
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'picture.bin');
    const before = await evaluate('document.querySelector("aside").getBoundingClientRect().width');
    await evaluate(`document.querySelector('[role=separator][tabindex]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
    assert(await evaluate(`document.querySelector('aside').getBoundingClientRect().width > ${before}`));
    await evaluate(`document.querySelector('[data-file-key] header button').dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))`);
    assert((await snapshot()).fileStates.every(file => file.collapsed === 'true'));
    return settled();
  });
  await check('context expansion loads exact full sides and keeps the requested 20-line expansion', async () => {
    await reset(); const before = await evaluate('document.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]").length');
    await evaluate('document.querySelector("diffs-container").shadowRoot.querySelector("[data-expand-down]").click()');
    const state = await settled(); const after = await evaluate('document.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]").length');
    assert(after > before); assert(after < 100); assert(scopedRequests(state).some(row => row.operation === 'hunks' && row.options.includeContents));
    await menu('Review options', 'Load full files'); const full = await settled();
    assert.equal(full.preferences.fullFiles, true); assert(await evaluate('document.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]").length < 100'));
    return { before, after, state: full };
  });
  await check('viewed revisions collapse, unview expands, and a changed snapshot reopens the file', async () => {
    await reset(); await click('Mark as viewed'); let state = await snapshot(); assert.equal(state.fileStates[0].viewed, 'true'); assert.equal(state.fileStates[0].collapsed, 'true');
    await click('Mark as unviewed'); state = await snapshot(); assert.equal(state.fileStates[0].collapsed, 'false');
    await click('Mark as viewed'); state = await evaluate('changesFixture.refreshRevision()');
    assert.equal(state.fileStates[0].viewed, 'false'); assert.equal(state.fileStates[0].collapsed, 'false');
    assert(state.hunkCacheKeys.length >= 2); return state;
  });
  await check('line-range comments retain their original context through refresh and move to the owning draft', async () => {
    await reset();
    const bounds = await evaluate(`(() => {
      const shadow = document.querySelector('diffs-container').shadowRoot;
      const start = shadow.querySelector('[data-column-number="127"][data-line-type="change-addition"]').getBoundingClientRect();
      const end = shadow.querySelector('[data-column-number="128"]').getBoundingClientRect();
      return { x: Math.round(start.x + start.width / 2), y: Math.round(start.y + start.height / 2), endY: Math.round(end.y + end.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x, y: bounds.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x, y: bounds.endY, button: 'left' });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x, y: bounds.endY, button: 'left', clickCount: 1 });
    await settled(); await click('Add comment');
    await input('Leave feedback on these lines…', 'Keep this behavior.');
    await evaluate('changesFixture.refreshRevision()');
    assert.equal(await evaluate('document.querySelector("textarea").value'), 'Keep this behavior.');
    await evaluate('document.querySelector("textarea").closest("form").requestSubmit()'); await settled();
    await select('Scope', 'last-turn');
    assert((await snapshot()).text.includes('1 comments'));
    await click('Add feedback to chat'); const state = await snapshot();
    assert(state.composer.includes('Keep this behavior.')); assert(state.composer.includes('updated0'));
    assert(!state.composer.includes('updated1')); return state;
  });
  await check('copy/open/reveal actions preserve the selected file and apply command quoting', async () => {
    await reset(); await menu('File actions', 'Copy path'); let state = await snapshot(); assert.equal(state.clipboard, '/fixture/project/apps/desktop/contracts/vectors/runtime-settings.json');
    await click('Open file'); state = await snapshot(); assert(state.requests.some(row => row.operation === 'internal-open' && row.path.endsWith('runtime-settings.json')));
    await menu('File actions', 'Open in editor'); await menu('File actions', 'Reveal in folder');
    await menu('Review options', 'Copy git apply command'); state = await snapshot();
    assert(state.clipboard.startsWith("git -C '/fixture/project' apply -p1 <<'KLAUS_REVIEW_PATCH'")); assert(state.clipboard.includes('runtime-settings.json'));
    assert(state.requests.some(row => row.operation === 'open')); assert(state.requests.some(row => row.operation === 'reveal')); return state;
  });
  await check('file and aggregate mutations carry exact snapshots and revert requires confirmation', async () => {
    await reset(); await menu('File actions', 'Stage'); let state = await snapshot(); let action = state.requests.filter(row => row.operation === 'mutation').at(-1);
    assert.equal(action.action, 'stage'); assert(action.options.filePath.endsWith('runtime-settings.json')); assert(action.options.expectedSnapshotId);
    await click('Revert all'); assert(await evaluate('Boolean(document.querySelector("[role=dialog]"))'));
    const count = state.requests.filter(row => row.operation === 'mutation').length; await click('Cancel');
    state = await snapshot(); assert.equal(state.requests.filter(row => row.operation === 'mutation').length, count);
    await click('Revert all'); await evaluate('changesFixture.refreshSame()'); await click('Confirm'); state = await settled(); action = state.requests.filter(row => row.operation === 'mutation').at(-1);
    assert.equal(action.action, 'revert'); assert.equal(action.options.filePath, undefined); assert(action.options.expectedSnapshotId.startsWith('all:'));
    const beforeStale = state.requests.filter(row => row.operation === 'mutation').length;
    await click('Revert all'); await evaluate('changesFixture.refreshRevision()'); await click('Confirm'); state = await settled();
    assert.equal(state.requests.filter(row => row.operation === 'mutation').length, beforeStale);
    assert(state.text.includes('comparison changed'));
    await select('Scope', 'staged'); assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Revert all")'), false);
    await click('Unstage all'); state = await settled(); assert.equal(state.requests.filter(row => row.operation === 'mutation').at(-1).action, 'unstage'); return state;
  });
  await check('inline hunk actions select the displayed hunk and copied patches retain repository ownership', async () => {
    await reset(); await click('Stage · 1'); let state = await settled();
    const action = state.requests.filter(row => row.operation === 'mutation').at(-1);
    assert.equal(action.options.hunkIndex, 0); assert(action.options.filePath.endsWith('runtime-settings.json'));
    await select('Scope', 'last-turn'); await menu('Review options', 'Copy git apply command'); state = await settled();
    assert(state.clipboard.includes("git -C '/fixture/project' apply -p1"));
    assert(state.clipboard.includes("git -C '/fixture/worktrees/topic/project' apply -p1"));
    assert.equal(state.clipboard.split('KLAUS_REVIEW_PATCH').length - 1, 4); return state;
  });
  await check('copied embedded pointers explicitly target the index without implying a nested checkout', async () => {
    await reset('gitlink'); await menu('Review options', 'Copy git apply command'); const state = await snapshot();
    assert(state.clipboard.includes("apply -p1 --cached <<'KLAUS_REVIEW_PATCH'"));
    assert(state.clipboard.includes('nested working files are unchanged'));
    assert(state.clipboard.includes('160000')); return state;
  });
  await check('capsule pins the active turn while checkout entry opens its own branch without switching chat', async () => {
    const initial = await reset(); await evaluate('document.documentElement.dataset.surface="capsule"');
    const capsuleLabel = await evaluate('document.querySelector("#changes-capsule-fixture button").getAttribute("aria-label")');
    await evaluate(`document.querySelector('#changes-capsule-fixture > span').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await settled();
    assert((await evaluate('document.querySelector("#changes-capsule-fixture").innerText')).includes('new.txt'));
    writeFileSync(join(output, 'changes-capsule.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector("#changes-capsule-fixture [role=region] button").click()');
    let state = await settled(); assert(state.selectedPath.includes('new.txt'));
    state = await click(capsuleLabel); assert.equal(state.source, 'last-turn'); assert.equal(state.turnId, 'active-turn');
    assert.equal(state.reviewSessionId, initial.sessionId); assert.equal(state.rows.length, 1); assert(state.rows[0].text.includes('+2'));
    await evaluate('document.documentElement.dataset.surface="entry"');
    await evaluate('document.querySelector("#changes-entry-fixture button").click()'); state = await settled();
    assert.equal(state.source, 'branch'); assert.equal(state.reviewSessionId, 'child-session'); assert.equal(state.sessionId, initial.sessionId);
    writeFileSync(join(output, 'changes-entry.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('delete document.documentElement.dataset.surface'); return state;
  });
  await check('authoritative empty turn changes hide the capsule while unavailable records retain an explicit notice', async () => {
    await reset('capsule-net-zero'); assert.equal(await evaluate('document.querySelector("#changes-capsule-fixture button") === null'), true);
    await reset('capsule-summary-error'); await evaluate('document.documentElement.dataset.surface="capsule"');
    await evaluate(`document.querySelector('#changes-capsule-fixture > span').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await settled(); assert((await evaluate('document.querySelector("#changes-capsule-fixture").innerText')).includes('Recorded changes unavailable'));
    await evaluate('delete document.documentElement.dataset.surface'); return snapshot();
  });
  await check('recorded image and PDF sides render from snapshot bytes', async () => {
    await reset('media'); await settled();
    for (let index = 0; index < 60; index++) {
      if (await evaluate('Array.from(document.querySelectorAll("img")).every(image => image.complete && image.naturalWidth > 0)')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate('document.querySelectorAll("img").length'), 2);
    assert(await evaluate('Array.from(document.querySelectorAll("img")).every(image => image.naturalWidth === 1 && image.src.startsWith("data:image/png;base64,"))'));
    assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2);
    assert(await evaluate('Array.from(document.querySelectorAll("iframe")).every(frame => frame.src.startsWith("blob:") && !frame.hasAttribute("sandbox"))'));
    await new Promise(resolve => setTimeout(resolve, 2500));
    const pdfFrames = window.webContents.mainFrame.framesInSubtree.filter(frame => frame.url.startsWith('chrome-extension:'));
    assert.equal(pdfFrames.length, 2);
    const pdfStates = await Promise.all(pdfFrames.map(frame => frame.executeJavaScript(`(() => { const viewer = document.querySelector('pdf-viewer'); return { viewer: Boolean(viewer), progress: viewer?.loadProgress, loaded: viewer?.documentLoaded, keys: viewer ? Object.keys(viewer).filter(key => /load|progress/i.test(key)) : [] }; })()`)));
    writeFileSync(join(output, 'media-frames.json'), JSON.stringify(pdfStates, null, 2));
    assert(pdfStates.every(state => state.viewer));
    const pdfBounds = await evaluate(`(() => { const box = document.querySelector('iframe').getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }; })()`);
    const bitmap = (await window.webContents.capturePage(pdfBounds)).toBitmap();
    let white = 0;
    for (let index = 0; index < bitmap.length; index += 4) if (bitmap[index] > 245 && bitmap[index + 1] > 245 && bitmap[index + 2] > 245) white++;
    const whiteRatio = white / (bitmap.length / 4);
    assert(whiteRatio > 0.08 && whiteRatio < 0.9, 'PDF page must paint inside its loaded viewer');
    writeFileSync(join(output, 'media-paint.json'), JSON.stringify({ pdfStates, whiteRatio }, null, 2));
    writeFileSync(join(output, 'changes-media.png'), (await window.webContents.capturePage()).toPNG());
    return snapshot();
  });
  await check('summary, file, empty, remote, transient and unavailable states remain explicit', async () => {
    const results = [];
    for (const [scenario, expected] of [['summary-error', 'Fixture summary failed'], ['empty', 'No changes'], ['plain', 'not inside a Git'], ['remote', 'another computer'], ['transient', 'middle of a merge'], ['unavailable', 'No cumulative'], ['no-base', 'No remote default'], ['hunk-error', 'Fixture patch failed'], ['rename', 'renamed.txt']]) {
      const state = await reset(scenario); assert(state.text.includes(expected), `${scenario}: ${state.text.slice(0,500)}`); results.push({ scenario, text: state.text.slice(0,500) });
      if (scenario === 'summary-error') { const retry = await click('Retry'); assert(!retry.text.includes('Fixture summary failed')); }
    }
    return results;
  });
  await check('late summaries cannot replace the currently selected conversation', async () => {
    await reset(); const state = await evaluate('changesFixture.race()'); assert.equal(state.reviewSessionId, 'current-session'); assert.equal(state.sessionId, 'current-session'); return state;
  });
  await check('syntax-aware import filtering retains normal changes and full context remains available', async () => {
    await reset(); await menu('Review options', 'Hide imports'); await new Promise(resolve => setTimeout(resolve, 200)); const state = await settled();
    assert(state.text.includes('No visible changes with the current filters.')); assert(state.text.includes('setting125'));
    const markdown = await reset('markdown'); assert(markdown.text.includes('A changed paragraph.')); assert(markdown.text.includes('After'));
    await menu('Review options', 'Rich preview'); const code = await settled(); assert(code.nativeDiffs.length > 0); return { state, markdown, code };
  });
  await check('generated-file filtering removes both its tree row and diff section', async () => {
    const initial = await reset('generated'); assert.equal(initial.rows.length, 5);
    await evaluate('document.querySelector("aside input[type=checkbox]").click()'); const state = await settled();
    assert.equal(state.rows.length, 4); assert.equal(state.fileStates.length, 4); return state;
  });
  await check('review remains contained at narrow and wide sizes in both themes without panel tooltips', async () => {
    await reset(); const states = [];
    for (const width of [430, 617, 1000]) {
      window.setContentSize(width, 850);
      for (const theme of ['light', 'dark']) {
        await evaluate(`changesFixture.theme(${JSON.stringify(theme)})`); const state = await settled();
        assert.equal(state.viewport.width, width); assert.deepEqual(state.forbiddenAttributes, []); assert.equal(state.bodyOverflow, false);
        writeFileSync(join(output, `changes-${width}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        states.push({ width, theme, files: state.fileStates.length });
      }
    }
    return states;
  });
  assert.deepEqual(rendererErrors, [], 'Renderer errors: ' + rendererErrors.join('\n'));
  console.log(JSON.stringify({ passed: checks.length, failed: 0 })); app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
