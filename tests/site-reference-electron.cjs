const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_SITE_TEST_ROOT;
// The harness feeds the page the same official artwork the host resolves in
// production, read through the host's own icon code.
const siteOpen = require(path.join(__dirname, '..', 'dist', 'main', 'browser', 'site-open.js'));
app.setPath('userData', path.join(root, 'profile'));
let win;
const results = [];
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, test) {
  try { results.push({ name, passed: true, evidence: await test() }); console.log(`${name}: passed`); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); throw error; }
  finally { fs.writeFileSync(path.join(root, 'native-results.json'), JSON.stringify(results, null, 2)); }
}
async function openMenu() {
  await evaluate('document.querySelector("[aria-haspopup=menu]").click()');
  await wait(80);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1080, height: 650, useContentSize: true, show: true, title: 'Website resource fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  const realChromeIcon = siteOpen.icnsIconDataUrl(siteOpen.chromeBundleIconPath(siteOpen.findInstalledChrome()));
  let realDefaultIcon;
  try {
    const info = await app.getApplicationInfoForProtocol('https://example.com/');
    realDefaultIcon = siteOpen.icnsIconDataUrl(siteOpen.bundleIconPathFromRoot(info.path)) || (info.icon.isEmpty() ? undefined : info.icon.toDataURL());
  } catch { realDefaultIcon = undefined; }
  console.log('real icons:', JSON.stringify({ chrome: !!realChromeIcon, chromeBytes: realChromeIcon ? realChromeIcon.length : 0, default: !!realDefaultIcon, defaultBytes: realDefaultIcon ? realDefaultIcon.length : 0 }));
  await win.loadFile(path.join(root, 'fixture/index.html'));
  await evaluate(`siteFixture.chromeIcon = ${JSON.stringify(realChromeIcon ?? null)}; siteFixture.defaultIcon = ${JSON.stringify(realDefaultIcon ?? null)}`);
  await evaluate('siteFixture.frames()');
  await check('saved assistant content creates a stateless card before actions without navigation', async () => {
    const value = await evaluate(`(() => { const group=document.querySelector('#message .msg-group');return { children:[...group.children].map(x=>x.className), text:group.textContent, cards:group.querySelectorAll('[data-site-reference]').length, calls:siteFixture.calls.length, tooltip:!!group.querySelector('[title],[data-klaus-tip]') } })()`);
    assert.equal(value.cards, 1); assert.equal(value.calls, 0); assert.equal(value.tooltip, false);
    assert(value.text.includes('网页预览')); assert(value.text.includes('网站'));
    assert.equal(value.children.length, 3); assert.equal(value.children[2], 'msg-actions');
    fs.writeFileSync(path.join(root, 'card-desktop.png'), (await win.webContents.capturePage()).toPNG());
    return value;
  });
  await check('loading menu Escape works before target discovery finishes', async () => {
    await evaluate('siteFixture.delay=500;document.querySelector("[aria-haspopup=menu]").click()');
    await wait(30);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert(!await evaluate('document.querySelector("[role=menu]")'));
    await evaluate('siteFixture.delay=0'); return { dismissed: true };
  });
  await check('all three surfaces use the same website reference', async () => {
    await evaluate('siteFixture.mountNavigation();siteFixture.frames()');
    const value = await evaluate(`({cards:document.querySelectorAll('[data-site-reference]').length, rows:document.querySelectorAll('#monitor-artifacts-body [data-kind=website]').length, markers:document.querySelectorAll('[data-turn-output=website]').length, count:document.getElementById('monitor-artifacts-count').textContent, panelTooltips:document.querySelectorAll('#artifacts [title],#artifacts [data-klaus-tip]').length})`);
    assert.equal(value.rows, 1); assert.equal(value.markers, 1); assert.equal(value.panelTooltips, 0);
    return value;
  });
  await check('menu loading is separate from the card and all opening options work', async () => {
    await evaluate('siteFixture.delay=250;document.querySelector("[aria-haspopup=menu]").click()');
    await wait(40); assert(await evaluate('!!document.querySelector("[role=menu] [role=status]")'));
    assert(!await evaluate('document.querySelector("[data-site-reference]").textContent.includes("正在加载")'));
    await wait(280);
    const options = await evaluate('[...document.querySelectorAll("[role=menuitem]")].map(x=>x.textContent)');
    assert.equal(options.length, 4); assert(options.some(text => text.includes('Google Chrome')));
    await wait(80);
    const icons = await evaluate('[...document.querySelectorAll("[role=menuitem] img")].map(x=>({ src: x.getAttribute("src").slice(0, 22), len: x.getAttribute("src").length, loaded: x.naturalWidth > 0 }))');
    assert(icons[0].src.startsWith('logo.png') && icons[0].loaded);
    if (realChromeIcon && realDefaultIcon) {
      // Official bundle artwork is a full-size PNG, never a hand-made tile.
      assert.equal(icons.length, 3);
      assert(icons[1].src.startsWith('data:image/png;base64,') && icons[1].loaded && icons[1].len > 20000);
      assert(icons[2].src.startsWith('data:image/png;base64,') && icons[2].loaded && icons[2].len > 20000);
    } else {
      assert(icons.every(icon => icon.loaded));
    }
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'menu-desktop.png'), shot.toPNG());
    const dpr = await evaluate('devicePixelRatio');
    const box = await evaluate('(() => { const m = document.querySelector("[role=menu]").getBoundingClientRect(); return { x: m.left - 10, y: m.top - 10, width: m.width + 20, height: m.height + 20 }; })()');
    fs.writeFileSync(path.join(root, 'menu-icons.png'), shot.crop({ x: Math.round(box.x * dpr), y: Math.round(box.y * dpr), width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) }).toPNG());
    await evaluate('document.querySelectorAll("[role=menuitem]")[1].click();siteFixture.delay=0');
    await wait(30);
    assert.equal(await evaluate('siteFixture.preferred'), 'chrome');
    await evaluate('document.querySelector("[data-site-reference] > button").click()');
    await wait(30);
    const call = await evaluate('siteFixture.calls.at(-1)'); assert.equal(call.sessionId, 'saved-session'); assert.equal(call.target, undefined);
    await openMenu(); await evaluate('document.querySelectorAll("[role=menuitem]")[2].click()');
    await wait(30); assert.equal(await evaluate('siteFixture.preferred'), 'system-default');
    await openMenu(); await evaluate('document.querySelectorAll("[role=menuitem]")[0].click()');
    await wait(30); assert.equal(await evaluate('siteFixture.preferred'), 'in-app');
    return { options, call, icons };
  });
  await check('copy keeps preference and keyboard dismissal restores focus', async () => {
    await openMenu(); await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.click()`);
    await wait(30); assert.equal(await evaluate('siteFixture.preferred'), 'in-app');
    assert.equal((await evaluate('siteFixture.calls.at(-1)')).copy, 'http://localhost:3000/');
    await openMenu(); await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    assert((await evaluate('document.activeElement.textContent')).includes('Google Chrome'));
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert(!await evaluate('document.querySelector("[role=menu]")'));
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-haspopup")'), 'menu');
    return await evaluate('siteFixture.toasts');
  });
  await check('opening and copy failures notify without changing card state', async () => {
    await evaluate('siteFixture.failOpen=true;document.querySelector("[data-site-reference] > button").click()');
    await wait(30); assert((await evaluate('siteFixture.toasts.at(-1)')).includes('launch refused'));
    await evaluate('siteFixture.failOpen=false;siteFixture.failCopy=true'); await openMenu();
    await evaluate('document.querySelectorAll("[role=menuitem]")[3].click()'); await wait(30);
    assert((await evaluate('siteFixture.toasts.at(-1)')).includes('无法复制'));
    assert(!await evaluate('document.querySelector("[data-site-reference]").hasAttribute("data-run-preview-status")'));
    await evaluate('siteFixture.failCopy=false;siteFixture.failTargets=true');await openMenu();
    assert((await evaluate('document.querySelector("[role=menu]").textContent')).includes('无法加载'));
    await evaluate('document.querySelector("[role=menuitem]").click();siteFixture.failTargets=false');
    return await evaluate('siteFixture.toasts');
  });
  await check('narrow layout and menu fit the viewport', async () => {
    win.setContentSize(360, 650); await wait(100); await openMenu();
    const value=await evaluate(`(() => {const card=document.querySelector('[data-site-reference]').getBoundingClientRect(),menu=document.querySelector('[role=menu]').getBoundingClientRect();return {card:{left:card.left,right:card.right},menu:{left:menu.left,right:menu.right},width:innerWidth,scroll:document.documentElement.scrollWidth}})()`);
    assert(value.card.left>=0 && value.card.right<=value.width); assert(value.menu.left>=0 && value.menu.right<=value.width); assert.equal(value.scroll,value.width);
    fs.writeFileSync(path.join(root, 'card-mobile.png'), (await win.webContents.capturePage()).toPNG()); return value;
  });
  await check('live turn tail retains earlier assistant website references', async () => {
    await evaluate('siteFixture.renderLive();siteFixture.frames()');
    const value = await evaluate(`({cards:document.querySelectorAll('#live-regression [data-site-reference]').length, urls:[...document.querySelectorAll('#live-regression [data-site-reference]')].map(x=>x.dataset.siteUrl)})`);
    assert.equal(value.cards, 1); assert.deepEqual(value.urls, ['http://localhost:3000/']); return value;
  });
  await check('read-only child transcript cannot replace the parent resource projection', async () => {
    await evaluate('siteFixture.renderChild();siteFixture.frames()');
    const value = await evaluate(`({urls:[...document.querySelectorAll('#monitor-artifacts-body [data-kind=website]')].map(x=>x.dataset.siteUrl),cards:document.querySelectorAll('#child-regression [data-site-reference]').length})`);
    assert.deepEqual(value.urls, ['http://localhost:3000/']); assert.equal(value.cards, 1); return value;
  });
  console.log(`${results.length} passed, 0 failed`);
  win.destroy(); app.quit();
}).catch(error => { console.error(error.stack || error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
