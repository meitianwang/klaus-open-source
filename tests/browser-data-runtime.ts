import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app, WebContentsView } from 'electron';
import type { DesktopRuntime } from '../main/app/runtime';
import { waitFor } from './harness';

/** Synthetic source, never a real browser profile or credential database. */
export function seedBrowserImportFixture(root: string): string {
  const directory = join(root, 'browser-source');
  const profile = join(directory, 'Default');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(directory, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Synthetic profile' } } } }));
  const history = new DatabaseSync(join(profile, 'History'));
  history.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);
    INSERT INTO urls VALUES(1,'https://import.example.test/one','Imported synthetic visit');
    INSERT INTO visits VALUES(1,1,13380000000000000);`);
  history.close();
  const cookies = new DatabaseSync(join(profile, 'Cookies'));
  cookies.exec(`CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,has_expires INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT,has_cross_site_ancestor INTEGER);
    INSERT INTO cookies VALUES('.fixture.example.test','ordinary','synthetic-value',X'','/',0,0,1,1,1,'',0);
    INSERT INTO cookies VALUES('.fixture.example.test','partitioned','synthetic-partition',X'','/',0,0,1,1,0,'https://top-level.test',1);`);
  cookies.close();
  return directory;
}

export async function assertBrowserDataRuntime(runtime: DesktopRuntime): Promise<void> {
  const contents = runtime.window.webContents;
  const evaluate = (script: string): Promise<any> => contents.executeJavaScript(script);
  const click = async (selector: string): Promise<void> => {
    const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing fixture control'); node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`);
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  await evaluate('window.openSettings("browser")');
  await waitFor(() => evaluate('!!document.querySelector("#browser-import-open")'), 5000, 'the import entry uses the production settings page');
  await click('#browser-import-open');
  await waitFor(() => evaluate('!!document.querySelector("[data-import-category=history]")'), 5000, 'the real discovery finds the synthetic profile');
  assert.equal(await evaluate('document.querySelector("[role=dialog]").textContent.includes("Synthetic profile")'), true);
  if (!await evaluate('document.querySelector("[data-import-category=history]").checked')) await click('[data-import-category=history]');
  await click('[role=dialog] button:last-child');
  await waitFor(() => evaluate('document.querySelectorAll("[data-category][data-state=complete]").length === 2'), 5000, 'cookies and history are confirmed by their real targets');
  const history = await evaluate('window.settingsApi.browserUse.history({query:"Imported synthetic visit"})');
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].isActorVisit, false);
  const view = new WebContentsView({ webPreferences: { session: runtime.browser.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    view.webContents.debugger.attach('1.3');
    const target = await view.webContents.debugger.sendCommand('Target.getTargetInfo') as {targetInfo: {browserContextId?: string}};
    const result = await view.webContents.debugger.sendCommand('Network.getAllCookies') as { cookies: Array<{name:string;value:string;partitionKey?:{topLevelSite:string;hasCrossSiteAncestor:boolean}}> };
    const ordinary = await runtime.browser.browserSession.cookies.get({name:'ordinary'});
    console.log('Synthetic cookie readback:', JSON.stringify({target:target.targetInfo, sessionCookies:ordinary, cdpCookies:result.cookies}));
    assert.equal(ordinary[0]?.value, 'synthetic-value');
    assert.equal(result.cookies.find(row => row.name === 'ordinary')?.value, 'synthetic-value');
    assert.deepEqual(result.cookies.find(row => row.name === 'partitioned')?.partitionKey, { topLevelSite: 'https://top-level.test', hasCrossSiteAncestor: true });
  } finally { view.webContents.debugger.detach(); view.webContents.close(); }
  await click('[role=dialog] button:last-child');
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), 5000, 'the import dialog has finished closing before navigation');
  await click('#browser-passwords-manage');
  // The manager toolbar (search + add) renders unconditionally; the password
  // entry form itself sits behind the add toggle.
  await waitFor(() => evaluate('!!document.querySelector("#settings-content input[type=search]")'), 5000, 'password management renders through the production bridge').catch(async error => {
    console.error('Browser data page diagnostic:',await evaluate('({text:document.getElementById("settings-content")?.textContent,credentials:typeof window.settingsApi.browserUse.credentials, extensions:typeof window.settingsApi.browserUse.extensions,dialog:document.querySelector("[role=dialog]")?.textContent})'));
    const logs=join(__dirname,'../browser-settings-logs');mkdirSync(logs,{recursive:true});writeFileSync(join(logs,'browser-data-page-failure.png'),(await contents.capturePage()).toPNG());throw error;
  });
  const saved = await evaluate('window.settingsApi.browserUse.credentials.savePassword({originUrl:"https://credential.example.test",username:"synthetic-user",password:"synthetic-password"})');
  assert.equal(typeof saved.id, 'string');
  const listed = await evaluate('window.settingsApi.browserUse.credentials.listPasswords()');
  assert.equal(listed.length, 1);
  assert.equal('password' in listed[0], false);
  await evaluate(`window.settingsApi.browserUse.credentials.deletePassword(${JSON.stringify(saved.id)})`);
  assert.equal((await evaluate('window.settingsApi.browserUse.credentials.listPasswords()')).length, 0);
  await evaluate('window.openSettings("browser")');
  console.log('Browser data runtime: actual discovery, UI job progress, persisted history, partitioned cookies, settings credentials CRUD and secret-free lists passed');
  const cpu = () => app.getAppMetrics().find(metric => metric.pid === contents.getOSProcessId())?.cpu;
  const samples: Array<Record<string, unknown>> = [];
  for (const animated of [false, true]) {
    if (animated) await evaluate('(() => { const host=document.createElement("div"); host.id="browser-performance-loading"; host.style.cssText="position:fixed;left:50%;top:50%;z-index:1500"; host.innerHTML=window.klsLoading.render(); document.body.appendChild(host); })()');
    const before = cpu(), started = performance.now();
    const frames = await evaluate('new Promise(resolve => { const times=[]; let handle=0; const tick=t=>{times.push(t);handle=requestAnimationFrame(tick)}; handle=requestAnimationFrame(tick); setTimeout(()=>{cancelAnimationFrame(handle);resolve({count:times.length,maxGap:times.length>1?Math.max(...times.slice(1).map((t,i)=>t-times[i])):0})},2000) })');
    const elapsed = (performance.now()-started)/1000, after = cpu();
    const cpuPercent = before?.cumulativeCPUUsage !== undefined && after?.cumulativeCPUUsage !== undefined ? (after.cumulativeCPUUsage-before.cumulativeCPUUsage)/elapsed*100 : after?.percentCPUUsage;
    samples.push({animated,elapsed,frames,before,after,cpuPercent});
    if (animated) await evaluate('document.getElementById("browser-performance-loading")?.remove()');
    assert.equal(typeof cpuPercent, 'number');
    assert(cpuPercent! < 80, 'the main renderer remains below the previous saturated-CPU failure range');
  }
  const logs=join(__dirname,'../browser-settings-logs'); mkdirSync(logs,{recursive:true});
  writeFileSync(join(logs,'browser-performance.json'),JSON.stringify({electron:process.versions.electron,chrome:process.versions.chrome,samples},null,2));
  console.log('Browser renderer performance:',JSON.stringify(samples.map(sample=>({animated:sample.animated,cpuPercent:sample.cpuPercent,frames:sample.frames}))));
}
