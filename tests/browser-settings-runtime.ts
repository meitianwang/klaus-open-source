import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { nativeImage } from 'electron';
import { join } from 'node:path';
import type { DesktopRuntime } from '../main/app/runtime';
import { waitFor } from './harness';

/** Plugin writes must update the mounted page without replacing its live controls. */
export async function assertBrowserSettingsToggleRuntime(runtime: DesktopRuntime): Promise<void> {
  const contents = runtime.window.webContents;
  const evaluate = (script: string): Promise<any> => contents.executeJavaScript(script);
  let switches = 0;
  for (const enabled of [true, false, true]) {
    await waitFor(() => evaluate('Boolean(document.querySelector("#browser-settings-enabled:not(:disabled)"))'), 5000, 'the browser switch is ready');
    if (await evaluate(`document.getElementById('browser-settings-enabled').checked === ${enabled}`)) continue;
    const point = await evaluate(`(() => {
      const input = document.getElementById('browser-settings-enabled');
      const label = input.closest('label');
      label.scrollIntoView({ block: 'center' });
      const row = label.parentElement.parentElement;
      const copy = row.querySelector('[class*="browser-capability-copy"]');
      window.__browserToggleNodes = [document.getElementById('settings-content'), input, row, copy, copy.firstChild.firstChild];
      const rect = label.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await waitFor(() => evaluate(`(async () => (await window.settingsApi.browserUse.get()).enabled === ${enabled}
      && Boolean(document.querySelector('#browser-settings-enabled:not(:disabled)'))
      && document.getElementById('browser-settings-enabled').checked === ${enabled})()`), 10_000, 'the browser switch persists');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate(`window.__browserToggleNodes.every(node => node.isConnected)
      && document.getElementById('settings-content') === window.__browserToggleNodes[0]
      && document.getElementById('browser-settings-enabled') === window.__browserToggleNodes[1]`), true,
    'plugin enablement retains the settings container, switch, row and text nodes');
    switches++;
  }
  assert(switches >= 2, 'both switch directions are exercised');
  console.log('Browser settings toggle integration: both directions retain the mounted controls and text');
}

/** Exercise the production renderer, bridge, engine plugin switch and browser profile. */
export async function assertBrowserSettingsRuntime(runtime: DesktopRuntime, profile: string): Promise<void> {
  const window = runtime.window, contents = window.webContents;
  const logs = join(__dirname, '../browser-settings-logs'); mkdirSync(logs, { recursive: true });
  const evaluate = async (script: string): Promise<any> => {
    try { return await contents.executeJavaScript(script); }
    catch (error) { console.error('Browser settings fixture renderer script failed:', script); throw error; }
  };
  const click = async (selector: string): Promise<void> => {
    const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'center' }); const rect = node.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  await evaluate('window.openSettings("browser")');
  await waitFor(() => evaluate('Boolean(document.querySelector("#browser-settings-enabled"))'), 10_000, 'browser settings renders through IPC');
  await assertBrowserSettingsToggleRuntime(runtime);
  await waitFor(() => evaluate('Boolean(document.querySelector("#browser-settings-enabled:checked:not(:disabled)"))'), 10_000, 'the browser plugin is enabled through the engine');
  await click('label:has(#browser-show-full-url)');
  await waitFor(() => evaluate('(async () => (await window.settingsApi.browserUse.get()).showFullUrl === true)()'), 5000, 'full URL preference persists');
  await evaluate(`window.settingsApi.browserUse.setPreferences({ downloadDirectory: ${JSON.stringify(join(profile, 'browser-downloads'))}, localUrlTarget: 'system-default' })`);
  await waitFor(() => evaluate('document.getElementById("browser-local-target").value === "system-default"'), 5000, 'preference pushes update the live page');
  await evaluate('window.closeSettings(); window.openSettings("browser")');
  await waitFor(() => evaluate('Boolean(document.querySelector("#browser-show-full-url:checked")) && document.getElementById("browser-local-target").value === "system-default"'), 5000, 'reopening restores browser preferences');
  await evaluate('document.querySelector(".settings-main").scrollTop = 0');
  writeFileSync(join(logs, 'browser-settings-page.png'), (await contents.capturePage()).toPNG());

  const site = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html'); response.end('<title>Browser settings visit</title><h1>Browser settings visit</h1><p>A synthetic page for browser annotations.</p>');
  });
  await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
  try {
    const address = site.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/fixture`;
    const page = await runtime.browser.createTab('manual', url);
    await waitFor(async () => (await evaluate('window.settingsApi.browserUse.history({ query: "Browser settings visit" })')).items.length === 1, 5000, 'real browser navigation appears in persistent history');
    await click('#browser-history-manage');
    await waitFor(() => evaluate('document.getElementById("settings-content").textContent.includes("Browser settings visit")'), 5000, 'history management renders the real visit');
    writeFileSync(join(logs, 'browser-history-page.png'), (await contents.capturePage()).toPNG());
    await evaluate(`window.settingsApi.browserUse.setSitePermission({ origin: ${JSON.stringify(new URL(url).origin)}, permission: 'geolocation', setting: 'denied' })`);
    assert.equal(await page.cdp.evaluate('(async () => (await navigator.permissions.query({name:"geolocation"})).state)()'), 'denied');
    await evaluate('window.openSettings("browser")');
    await waitFor(() => evaluate('Boolean(document.querySelector("#browser-clear-data:not(:disabled)"))'), 5000, 'browser settings returns from history');
    await click('#browser-clear-data');
    await waitFor(async () => (await evaluate('window.settingsApi.browserUse.history({ query: "Browser settings visit" })')).items.length === 0, 5000, 'clear history stays empty after reload');
    await evaluate('window.closeSettings()');
    runtime.browser.setConversation('manual');
    // Native child views are presented only while their owning window is visible.
    window.show(); window.focus();
    await evaluate('window.showBrowserPanel()');
    await waitFor(async () => !page.native.getState().loading, 5000, 'the reloaded page finishes navigation before annotation');
    await page.cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await waitFor(() => evaluate('Boolean(document.querySelector("#browser-annotate:not(:disabled)"))'), 5000, 'the native browser annotation entry is enabled');
    await evaluate(`window.__annotationClicks = 0; window.__annotationToasts = []; document.getElementById('browser-annotate').addEventListener('click', () => window.__annotationClicks++); new MutationObserver(() => { const text = document.getElementById('settings-toast-viewport')?.textContent; if (text) window.__annotationToasts.push(text); }).observe(document.body, {childList:true,subtree:true});`);
    await click('#browser-annotate');
    await waitFor(() => evaluate('Boolean(document.querySelector("[data-browser-annotation-stage] img")?.naturalWidth)'), 5000, 'the frozen annotation image is ready for selection').catch(async error => {
      writeFileSync(join(logs, 'browser-annotation-failure.png'), (await contents.capturePage()).toPNG());
      writeFileSync(join(logs, 'browser-annotation-failure.json'), JSON.stringify(await evaluate('({ clicks: window.__annotationClicks, toasts: window.__annotationToasts, overlay: document.querySelector("[data-browser-annotation-overlay]")?.textContent, image: (() => {const i=document.querySelector("[data-browser-annotation-stage] img");return i && {src:i.getAttribute("src").slice(0,100),complete:i.complete,width:i.naturalWidth,height:i.naturalHeight}})(), text: document.body.innerText.slice(-2500) })'), null, 2));
      throw error;
    });
    await evaluate(`window.__annotationPointers = []; for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, event => window.__annotationPointers.push({ type, x: event.clientX, y: event.clientY, buttons: event.buttons, target: event.target?.tagName }), true);`);
    const rect = await evaluate('(() => { const r = document.querySelector("[data-browser-annotation-stage] img").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()');
    const start = { x: Math.round(rect.x + 20), y: Math.round(rect.y + 20) };
    const end = { x: Math.round(rect.x + Math.min(rect.width - 20, 180)), y: Math.round(rect.y + Math.min(rect.height - 20, 100)) };
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    contents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftbuttondown'], ...end });
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end });
    await evaluate('document.querySelector("[data-browser-annotation-overlay] textarea").focus()');
    await contents.insertText('Explain this synthetic region.');
    await waitFor(() => evaluate('Boolean(document.querySelector("[data-browser-annotation-overlay] button:last-child:not(:disabled)"))'), 5000, 'the annotation region is selected').catch(async error => {
      writeFileSync(join(logs, 'browser-annotation-selection-failure.png'), (await contents.capturePage()).toPNG());
      writeFileSync(join(logs, 'browser-annotation-selection-failure.json'), JSON.stringify({ rect, start, end, browser: runtime.browser.state(), renderer: await evaluate('({ pointers: window.__annotationPointers, overlay: document.querySelector("[data-browser-annotation-overlay]")?.innerText, note: document.querySelector("[data-browser-annotation-overlay] textarea")?.value, focus: document.activeElement?.tagName })') }, null, 2));
      throw error;
    });
    await click('[data-browser-annotation-overlay] button:last-child');
    try {
      await waitFor(() => evaluate('!document.querySelector("[data-browser-annotation-overlay]") && document.body.textContent.includes("Explain this synthetic region.")'), 5000, 'the annotation reaches the composer draft without sending');
    } catch (error) {
      writeFileSync(join(logs, 'browser-annotation-failure.png'), (await contents.capturePage()).toPNG());
      writeFileSync(join(logs, 'browser-annotation-failure.json'), JSON.stringify(await evaluate('({ clicks: window.__annotationClicks, toasts: window.__annotationToasts, overlay: document.querySelector("[data-browser-annotation-overlay]")?.textContent, note: document.querySelector("[data-browser-annotation-overlay] textarea")?.value, composer: document.querySelector(".ProseMirror")?.textContent, toast: document.querySelector("#toast")?.textContent, text: document.body.innerText.slice(-2500) })'), null, 2));
      throw error;
    }
    await waitFor(() => runtime.browser.state().visible === true, 5000, 'closing annotation restores the retained native page');
    const saved = readdirSync(join(profile, 'uploads')).filter(name => name.endsWith('.png'));
    assert.equal(saved.length, 1, 'the accepted draft retains exactly one screenshot attachment');
    const image = nativeImage.createFromPath(join(profile, 'uploads', saved[0]!));
    const pixels = image.toBitmap();
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! < 160 && pixels[index + 1]! < 160 && pixels[index + 2]! < 160 && pixels[index + 3]! > 200) ink++;
    assert(ink > 100, 'the frozen attachment contains rendered page text rather than an empty surface');
    writeFileSync(join(logs, 'browser-annotation-draft.png'), (await contents.capturePage()).toPNG());
    await evaluate('window.settingsApi.browserUse.setEnabled(false)');
    runtime.browser.releaseConversation('manual');
  } finally {
    site.closeAllConnections(); await new Promise<void>(done => site.close(() => done()));
  }
  console.log('Browser settings runtime integration: plugin enablement, preference persistence, live updates, history, site denial, clearing and annotation draft passed');
}
