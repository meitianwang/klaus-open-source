const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.KLAUS_FILE_BROWSER_TEST_ROOT;
const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/vectors/workspace-file-browser-vectors.json'), 'utf8'));
app.setPath('userData', process.env.KLAUS_FILE_BROWSER_TEST_PROFILE);
const results = [];
let win;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function until(code) { for (let i = 0; i < 80; i++) { if (await evaluate(code)) return; await wait(25); } throw new Error('Timed out: ' + code); }
async function check(name, run) {
  const result = { name, ok: false };
  try { result.evidence = await run(); result.ok = true; console.log('PASS ' + name + ' ' + JSON.stringify(result.evidence)); }
  finally { results.push(result); fs.writeFileSync(path.join(root, 'native-results.json'), JSON.stringify(results, null, 2)); }
}
const rows = () => evaluate('fileBrowserFixture.rows()');
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1512, height: 949, useContentSize: true, show: true, title: 'Workspace file browser fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error('RENDERER ' + event.message); });
  win.webContents.on('render-process-gone', (_event, details) => console.error(details));
  await win.loadFile(path.join(root, 'fixture/index.html'));
  await until('!!document.querySelector("file-tree-container")?.shadowRoot?.querySelector("[role=treeitem]")');
  await wait(250);
  await check('file tree uses complete icons, roomy rows and virtualized rendering', async () => {
    const data = await rows();
    assert(data.some(row => row.path === '.git')); assert(data.some(row => row.path === 'node_modules'));
    assert(data.every(row => row.height === vector.rowHeight));
    const dom = await evaluate(`({ virtual: !!fileBrowserFixture.shadow().querySelector('[data-file-tree-virtualized-scroll]'), icons: fileBrowserFixture.shadow().querySelectorAll('symbol').length, folderIcons: fileBrowserFixture.shadow().querySelector('[data-item-path="apps/"]').querySelectorAll('svg').length, tooltip: !!document.querySelector('#artifacts-panel [title],#artifacts-panel [data-klaus-tip]') || !!fileBrowserFixture.shadow().querySelector('[title],[data-klaus-tip]') })`);
    assert(dom.virtual); assert(dom.icons > 20); assert.equal(dom.folderIcons, 1); assert.equal(dom.tooltip, false);
    const sizes = await evaluate(`({folder:fileBrowserFixture.shadow().querySelector('[data-item-type="folder"] svg').getBoundingClientRect().width,file:fileBrowserFixture.shadow().querySelector('[data-item-type="file"] svg').getBoundingClientRect().width})`);
    assert.equal(sizes.folder, vector.directoryChevronSize); assert.equal(sizes.file, vector.iconSize);
    const geometry = await evaluate(`(()=>{const v=document.querySelector('.workspace-tree-viewport'),s=fileBrowserFixture.shadow().querySelector('[data-file-tree-virtualized-scroll]'),r=fileBrowserFixture.shadow().querySelector('[role=treeitem]');return {viewport:v.getBoundingClientRect().toJSON(),scroller:s.getBoundingClientRect().toJSON(),row:r.getBoundingClientRect().toJSON(),color:getComputedStyle(r).color}})()`);
    console.log('GEOMETRY ' + JSON.stringify(geometry));
    assert(geometry.scroller.height > 300);
    fs.writeFileSync(path.join(root, 'files-light.png'), (await win.webContents.capturePage()).toPNG()); return { count: data.length, ...dom };
  });
  await check('empty viewer is centered with balanced type and a crisp icon', async () => {
    const data = await evaluate(`(() => {const empty=document.querySelector('#workspace-file-empty'),state=empty.firstElementChild,icon=state.firstElementChild,title=state.children[1],desc=state.children[2],r=empty.getBoundingClientRect(),s=state.getBoundingClientRect();return {text:state.textContent,icon:icon.clientWidth,titleSize:getComputedStyle(title).fontSize,descSize:getComputedStyle(desc).fontSize,centerError:Math.abs((r.left+r.width/2)-(s.left+s.width/2))}})()`);
    assert(data.text.includes('打开文件')); assert.equal(data.icon, 32); assert.equal(data.titleSize, '16px'); assert.equal(data.descSize, '14px'); assert(data.centerError < 1); return data;
  });
  await check('lazy expansion loads a directory and preserves focus through loading', async () => {
    await evaluate(`fileBrowserFixture.focus('apps');fileBrowserFixture.key('ArrowRight')`);
    await until(`fileBrowserFixture.rows().some(row=>row.path==='apps/nested.ts')`);
    const data = await evaluate(`({calls:fileBrowserFixture.calls.filter(x=>x.path==='/workspace/apps'),focus:fileBrowserFixture.shadow().activeElement?.dataset.itemPath,rows:fileBrowserFixture.rows().filter(x=>x.path.startsWith('apps/'))})`);
    assert.equal(data.calls.length, 1); assert.equal(data.focus, 'apps/'); return data;
  });
  await check('single click replaces preview while double click pins the file tab', async () => {
    await evaluate(`fileBrowserFixture.click('apps/nested.ts')`); await wait(100);
    await evaluate(`fileBrowserFixture.click('AGENTS.md')`); await wait(100);
    let paths = await evaluate(`[...document.querySelectorAll('#workspace-file-tabs [role=tab]')].map(x=>x.dataset.path)`);
    assert.deepEqual(paths, ['/workspace/AGENTS.md']);
    await evaluate(`fileBrowserFixture.doubleClick('AGENTS.md');fileBrowserFixture.click('dev.sh')`); await wait(100);
    paths = await evaluate(`[...document.querySelectorAll('#workspace-file-tabs [role=tab]')].map(x=>x.dataset.path)`);
    assert.deepEqual(paths, ['/workspace/AGENTS.md','/workspace/dev.sh']); return paths;
  });
  await check('filter searches the workspace and keeps directory ancestry', async () => {
    await evaluate(`fileBrowserFixture.filter('match')`);
    await until(`fileBrowserFixture.rows().some(row=>row.path.endsWith('match.ts'))`);
    const data = await rows(); assert(data.some(row => row.path.endsWith('match.ts'))); assert(!data.some(row=>row.path==='AGENTS.md'));
    fs.writeFileSync(path.join(root, 'files-filtered.png'), (await win.webContents.capturePage()).toPNG()); return data;
  });
  await check('filesystem roots extra roots and traversal keep their path identities', async () => {
    const cases = await evaluate('fileBrowserFixture.modelCases()');
    assert.equal(cases.filesystemRoot[0].name, 'usr');
    assert.equal(cases.extraRoot[0].path, '/other/empty');
    assert.equal(cases.traversal.length, 0); return cases;
  });
  await check('new queries and clearing reject stale search responses', async () => {
    await evaluate(`fileBrowserFixture.filter('slow')`); await wait(150);
    await evaluate(`fileBrowserFixture.filter('new')`); await wait(180);
    await evaluate(`document.querySelector('.workspace-tree-filter button').click()`); await wait(350);
    const data = await rows(); assert(data.some(row=>row.path==='apps/nested.ts')); assert(!data.some(row=>row.path.includes('stale'))); return { count: data.length };
  });
  await check('no-results and search errors remain visible and recover on clear', async () => {
    await evaluate(`fileBrowserFixture.filter('absent')`); await wait(200);
    assert((await evaluate(`document.querySelector('.workspace-tree-status').textContent`)).includes('没有匹配'));
    await evaluate(`fileBrowserFixture.setSearchError(true);fileBrowserFixture.filter('error')`); await wait(200);
    assert((await evaluate(`document.querySelector('.workspace-tree-status').textContent`)).includes('Search unavailable'));
    await evaluate(`fileBrowserFixture.setSearchError(false);fileBrowserFixture.filter('')`); await wait(80);
    return { recovered: (await rows()).length > 0 };
  });
  await check('context rename performs the host operation and refreshes the tree', async () => {
    await evaluate(`fileBrowserFixture.context('apps/nested.ts')`); await wait(40);
    const menu = await evaluate(`[...document.querySelectorAll('.workspace-context-menu button')].map(x=>x.textContent)`);
    assert(menu.some(x=>x.includes('重命名')));
    await evaluate(`[...document.querySelectorAll('.workspace-context-menu button')].find(x=>x.textContent.includes('重命名')).click()`); await wait(50);
    await until(`!!fileBrowserFixture.shadow().querySelector('input')`);
    await evaluate(`(()=>{const i=fileBrowserFixture.shadow().querySelector('input');i.value='renamed.ts';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
    await until(`fileBrowserFixture.calls.some(x=>x.kind==='rename')`);
    await until(`fileBrowserFixture.rows().some(x=>x.path==='apps/renamed.ts')`);
    return await evaluate(`fileBrowserFixture.calls.filter(x=>x.kind==='rename')`);
  });
  await check('directory failures expose retry and retry restores children', async () => {
    await evaluate(`fileBrowserFixture.setDirectoryError(true);fileBrowserFixture.click('docs')`); await wait(100);
    assert(await evaluate(`!!document.querySelector('.workspace-tree-status button')`));
    await evaluate(`fileBrowserFixture.setDirectoryError(false);document.querySelector('.workspace-tree-status button').click()`);
    await until(`fileBrowserFixture.rows().some(row=>row.path==='docs/renamed.ts')`); return { retry: true };
  });
  await check('editing a preview pins it before the next file opens', async () => {
    await evaluate(`fileBrowserFixture.click('dev.sh')`); await wait(80);
    const sourceInput = `(()=>{const walk=root=>[...root.querySelectorAll('*')].flatMap(el=>[el,...el.shadowRoot?walk(el.shadowRoot):[]]);return walk(document.querySelector('#workspace-file-body')).find(el=>el.getAttribute('contenteditable')==='true')})()`;
    await until(`!!${sourceInput}`);
    await evaluate(`${sourceInput}.focus()`);
    win.webContents.focus();
    await win.webContents.insertText('edited');
    await until(`document.querySelector('#workspace-file-tabs [data-path="/workspace/dev.sh"]').classList.contains('is-dirty')`);
    await evaluate(`fileBrowserFixture.click('dev.bat')`); await wait(80);
    const tabs = await evaluate(`[...document.querySelectorAll('#workspace-file-tabs [role=tab]')].map(x=>({path:x.dataset.path,dirty:x.classList.contains('is-dirty'),preview:x.classList.contains('is-preview')}))`);
    assert(tabs.some(tab=>tab.path==='/workspace/dev.sh'&&!tab.preview));
    assert(await evaluate(`fileBrowserFixture.calls.some(call=>call.kind==='write'&&call.path==='/workspace/dev.sh'&&call.query.includes('edited'))`)); return tabs;
  });
  await check('refresh during pending expansion cannot orphan child loading', async () => {
    await evaluate(`fileBrowserFixture.setDelay(120);fileBrowserFixture.click('engine')`); await wait(20);
    await evaluate(`fileBrowserFixture.load('files')`); await wait(300);
    await evaluate(`fileBrowserFixture.setDelay(0)`);
    await until(`fileBrowserFixture.rows().some(row=>row.path==='engine/renamed.ts')`); return { loaded: true };
  });
  await check('session switches discard stale directory and root results', async () => {
    await evaluate(`fileBrowserFixture.setDelay(150);fileBrowserFixture.click('scripts');fileBrowserFixture.load('files');fileBrowserFixture.setDelay(0);fileBrowserFixture.switch('other')`);
    await wait(250); assert.deepEqual((await rows()).map(row=>row.path), ['other.md']);
    await evaluate(`fileBrowserFixture.switch('files')`); await wait(200);
    assert((await rows()).some(row=>row.path==='apps/renamed.ts')); return { isolated: true };
  });
  await check('refresh preserves scroll through previously expanded directories', async () => {
    await evaluate(`fileBrowserFixture.shadow().querySelector('[data-file-tree-virtualized-scroll]').scrollTop=230`); await wait(150);
    const before = await evaluate(`fileBrowserFixture.shadow().querySelector('[data-file-tree-virtualized-scroll]').scrollTop`);
    await evaluate(`fileBrowserFixture.load('files')`); await wait(250);
    const after = await evaluate(`fileBrowserFixture.shadow().querySelector('[data-file-tree-virtualized-scroll]').scrollTop`);
    console.log('SCROLL ' + JSON.stringify({before,after}));
    assert(Math.abs(before-after)<2); return {before,after};
  });
  await check('same-name roots keep independent folders and context actions', async () => {
    await evaluate(`fileBrowserFixture.setDuplicateRoots(true);fileBrowserFixture.load('files')`); await wait(200);
    const data=await rows(); const sources=data.filter(row=>row.path.startsWith('src ('));
    assert.equal(sources.length,2);
    await evaluate(`fileBrowserFixture.click('src (workspace)')`); await wait(100);
    await evaluate(`fileBrowserFixture.click('src (other)')`); await wait(100);
    const calls=await evaluate(`fileBrowserFixture.calls.filter(call=>call.path==='/workspace/src'||call.path==='/other/src')`);
    assert(calls.some(call=>call.path==='/workspace/src')&&calls.some(call=>call.path==='/other/src'));
    await evaluate(`fileBrowserFixture.context('src (other)')`); await wait(50);
    assert(await evaluate(`!!document.querySelector('.workspace-context-menu')`));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));fileBrowserFixture.setDuplicateRoots(false);fileBrowserFixture.load('files')`); await wait(200);
    return {sources,calls};
  });
  await check('tree width supports keyboard resizing and preserves a usable narrow viewer', async () => {
    const value = await evaluate(`(()=>{const h=document.getElementById('workspace-tree-resizer');h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));return {now:+h.getAttribute('aria-valuenow'),max:+h.getAttribute('aria-valuemax')}})()`);
    assert.equal(value.now,260); assert(value.now<=value.max);
    await evaluate(`document.getElementById('artifacts-panel').style.width='300px'`); await wait(300);
    const narrow=await evaluate(`({tree:document.getElementById('monitor-section-workspace').clientWidth,viewer:document.getElementById('workspace-main-view').clientWidth,scroll:document.documentElement.scrollWidth,window:innerWidth})`);
    assert(narrow.tree<=180); assert(narrow.viewer>=115); assert.equal(narrow.scroll,narrow.window);
    fs.writeFileSync(path.join(root, 'files-narrow.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate(`document.getElementById('artifacts-panel').style.width='620px';document.getElementById('workspace-tree-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.documentElement.dataset.theme='dark'`); await wait(100);
    fs.writeFileSync(path.join(root, 'files-dark.png'),(await win.webContents.capturePage()).toPNG()); return {value,narrow};
  });
  await check('opening an external report authorizes its preview before reading', async () => {
    await evaluate(`fileBrowserFixture.open('/external/01-report.md')`);
    await until(`fileBrowserFixture.calls.some(call=>call.kind==='read-preview'&&call.path==='/external/01-report.md')`);
    const calls = await evaluate(`fileBrowserFixture.calls.filter(call=>call.path==='/external/01-report.md')`);
    assert.deepEqual(calls.map(call => call.kind), ['authorize-preview', 'read-preview']);
    assert(!(await evaluate(`document.getElementById('workspace-file-body').textContent`)).includes('path outside preview scope'));
    return calls;
  });
  await check('HTML aliases retain the canonical preview path after the initial read', async () => {
    await evaluate(`fileBrowserFixture.open('/external/report-alias.html')`);
    await until(`document.querySelector('#workspace-file-body iframe')?.src.startsWith('data:text/html,')`);
    const calls = await evaluate(`fileBrowserFixture.calls.filter(call=>call.path==='/canonical/report.html')`);
    assert.deepEqual(calls.map(call => call.kind), ['read-preview', 'preview-url']);
    return calls;
  });
  console.log(`${results.length} passed, 0 failed`);
  win.destroy(); app.quit();
}).catch(error => { console.error(error.stack || error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
