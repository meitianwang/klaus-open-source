import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, createWriteStream, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ChromeSetup } from '../main/browser/chrome-setup';
import { ChromeBrowserService } from '../main/browser/chrome-browser';
import { discoverChrome } from '../main/browser/chrome-relay';
import { object, type BrowserObject } from '../main/browser/types';
import { Harness } from './harness';
import { registerFileUploadTests, serveFileUploadFixture } from './browser-file-upload-cases';

const executable = process.env.KLAUS_CHROME_TEST_EXECUTABLE;
const hostScript = process.env.KLAUS_UPLOAD_NATIVE_HOST_SCRIPT;
const desktopRoot = existsSync(resolve(__dirname,'../package.json')) ? resolve(__dirname,'..') : resolve(__dirname,'../..');
const extensionRoot = resolve(desktopRoot, 'resources/plugins-builtin/browser/chrome-extension');
const extensionId = JSON.parse(readFileSync(join(extensionRoot, 'extension-id.json'), 'utf8')).extensionId as string;

async function configureFileAccess(profile: string, allowed: boolean): Promise<void> {
  const port = readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const response = await fetch(`http://127.0.0.1:${port}/json/new?chrome://extensions/`,{method:'PUT'});
  const target = await response.json() as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen,reject)=>{socket.onopen=()=>resolveOpen();socket.onerror=()=>reject(new Error('Fixture settings CDP connection failed.'));});
  let sequence = 0;
  const command = (expression: string): Promise<BrowserObject> => new Promise((resolveCommand,reject)=>{
    const id = ++sequence;
    const timeout = setTimeout(()=>reject(new Error('Fixture extension settings timed out.')),5000);
    socket.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.id!==id)return;clearTimeout(timeout);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolveCommand(message.result);};
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
  });
  try {
    for(let attempt=0;attempt<50;attempt++){
      const ready=await command('typeof chrome.developerPrivate?.updateExtensionConfiguration');
      if(object(ready.result).value==='function')break;
      await new Promise(resolveWait=>setTimeout(resolveWait,100));
    }
    const developerMode = await command('new Promise((resolve,reject)=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))');
    if(developerMode.exceptionDetails)throw new Error(JSON.stringify(developerMode.exceptionDetails));
    const result = await command('new Promise((resolve,reject)=>chrome.developerPrivate.updateExtensionConfiguration('+JSON.stringify({extensionId,fileAccess:allowed})+',()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))');
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
    const info = await command('new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},items=>{const item=items.find(item=>item.id==='+JSON.stringify(extensionId)+');resolve(item?{state:item.state,fileAccess:item.fileAccess,disableReasons:item.disableReasons}:null)}))');
    process.stdout.write('Isolated extension setting: '+JSON.stringify(object(info.result).value)+'\n');
  } finally { socket.close(); }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveClose => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('close', () => { clearTimeout(timeout); resolveClose(); }); child.kill('SIGTERM');
  });
}

for (const allowed of [false, true]) test('native Chrome file upload with file URL access ' + (allowed ? 'allowed' : 'denied'), { timeout: 180_000 }, async () => {
  assert(executable && existsSync(executable), 'KLAUS_CHROME_TEST_EXECUTABLE must name an official Chrome for Testing cache.');
  assert(hostScript && existsSync(hostScript), 'KLAUS_UPLOAD_NATIVE_HOST_SCRIPT must name the compiled native host.');
  const directory = mkdtempSync(join(tmpdir(), 'klaus-upload-chrome-'));
  const discoveryDirectory = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'kup-'));
  const profile = join(directory, 'profile'); mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [extensionId]: { allow_file_access: allowed } } } }));
  const setup = new ChromeSetup({ configRoot: join(directory, 'config'), extensionRoot, browserDataRoots: [profile], browserExecutable: executable, executable: process.execPath, hostScript, enabled: () => true, discoveryDirectory });
  const installed = await setup.install(); assert.equal(installed.ok, true);
  let base = '';
  const server = createServer((request, response) => { if (!serveFileUploadFixture(request,response,base)) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  const logPath = join(directory,'chrome.log'), log = createWriteStream(logPath);
  const browser = spawn(executable, [`--user-data-dir=${profile}`, '--headless=new', '--site-per-process', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--remote-debugging-port=0', `--load-extension=${extensionRoot}`, 'about:blank'], { stdio: ['ignore','pipe','pipe'] });
  browser.stdout?.pipe(log); browser.stderr?.pipe(log);
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory, artifactDirectory: join(directory,'artifacts') });
  let success = false;
  try {
    const deadline = Date.now() + 30_000; let instance;
    for (;;) {
      instance = (await discoverChrome(discoveryDirectory)).browsers[0];
      if (instance) break;
      if (Date.now() >= deadline) throw new Error('Isolated extension did not connect: ' + readFileSync(logPath,'utf8').slice(-8000));
      await new Promise(resolveWait => setTimeout(resolveWait,100));
    }
    await configureFileAccess(profile,allowed);
    const settingDeadline=Date.now()+10000;
    for(;;){
      const current=(await discoverChrome(discoveryDirectory)).browsers[0];
      if(current&&object(current.info.metadata).fileSchemeAccessAllowed===allowed){instance=current;break;}
      if(Date.now()>=settingDeadline)throw new Error('The isolated extension file access setting did not change.');
      await new Promise(resolveWait=>setTimeout(resolveWait,100));
    }
    assert.equal(object(instance.info.metadata).fileSchemeAccessAllowed, allowed, 'the actual extension setting matches this isolated profile');
    process.stdout.write(`Chrome extension fileSchemeAccessAllowed=${String(object(instance.info.metadata).fileSchemeAccessAllowed)}\n`);
    const browserId = instance.id;
    const call = (kind: string, fields: BrowserObject = {}) => service.execute('upload-fixture', browserId, kind, fields, {});
    if (!allowed) {
      await call('new_tab',{url:base+'/advanced-upload'});
      const path = join(directory,'denied.txt'); writeFileSync(path,'denied');
      await assert.rejects(call('file_upload',{selector:'#hidden-file',files:[path]}), /Allow access to file URLs/);
      assert.equal(object((await call('eval',{expression:'document.querySelector("#hidden-file").files.length'})).structuredContent).value,0,'the denied selection did not deliver files');
    } else {
      const h = new Harness(); registerFileUploadTests(h,{call,base:()=>base,directory});
      assert.equal(await h.finish(join(directory,'upload-result.json'),'browser-file-upload-chrome'),0);
    }
    success = true;
  } finally {
    await service.shutdown(); await stop(browser);
    server.closeAllConnections(); await new Promise<void>(resolveClose=>server.close(()=>resolveClose())); log.end();
    rmSync(discoveryDirectory,{recursive:true,force:true});
    if (success) rmSync(directory,{recursive:true,force:true}); else process.stderr.write('Failed upload fixture retained at '+directory+'\n');
  }
});
