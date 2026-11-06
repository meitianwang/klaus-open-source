import { app, BrowserWindow, session } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BrowserAutofillCandidate,
  BrowserAutofillChoice,
  BrowserAutofillFieldKind,
  BrowserAutofillFrame,
  BrowserAutofillSaveCandidate,
  BrowserAutofillSubmission,
  BrowserSecretCipher,
} from '../contracts/browser-credentials';
import { BrowserAutofillBridge } from '../main/browser/autofill-bridge';
import { BrowserCredentialsStore } from '../main/browser/credentials-store';
import { assert, assertEqual, Harness, waitFor } from './harness';

const profile = process.env.KLAUS_BROWSER_CREDENTIALS_PROFILE;
if (!profile) throw new Error('This fixture requires KLAUS_BROWSER_CREDENTIALS_PROFILE.');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

function testCipher(): BrowserSecretCipher {
  const mask = 0x5a;
  return {
    available: () => true,
    encrypt: (plaintext: string) => Buffer.from([...Buffer.from(plaintext, 'utf8')].map(byte => byte ^ mask)),
    decrypt: (ciphertext: Buffer) => Buffer.from([...Buffer.from(ciphertext)].map(byte => byte ^ mask)).toString('utf8'),
  };
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge fixture</title>
<style>body{margin:0;font:14px sans-serif}form{margin:24px;padding:16px;border:1px solid #ccc;width:280px}input{display:block;width:240px;height:28px;margin:6px 0}#submit{width:100px;height:32px}</style>
</head><body>
<form id="login" method="post" action="/login">
<input id="user" name="username" autocomplete="username" placeholder="username">
<input id="pass" name="password" type="password" placeholder="password">
<button id="submit" type="submit">Sign in</button>
</form>
<script>window.__ready = true;</script>
</body></html>`;

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  let posted = false;
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/login') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      posted = body.includes('username=alice') && body.includes('password=secret');
      response.writeHead(302, { Location: '/after' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/after' ? '<!doctype html><title>after</title><h1>after login</h1>' : page);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string', 'fixture server has a port');
  const origin = `http://127.0.0.1:${address.port}`;

  const tempSession = session.fromPartition(`browser-credentials-bridge-${randomUUID()}`);
  const store = new BrowserCredentialsStore({
    databasePath: join(profile!, 'credentials.db'),
    cipher: testCipher(),
  });
  await store.savePassword({ originUrl: origin, username: 'alice', password: 'secret' });

  let chooseCalls = 0;
  let confirmCalls = 0;
  const confirmResolvers: Array<(value: boolean) => void> = [];
  let markConfirmCalled!: () => void;
  const confirmCalled = new Promise<void>(resolve => { markConfirmCalled = resolve; });
  let capturedSubmission: BrowserAutofillSubmission | null = null;
  const labels = {
    chooseCredential: 'Choose a saved password',
    cancel: 'Cancel',
    savePasswordTitle: 'Save password?',
    savePasswordMessage: (url: string, username: string) => `Save password for ${username} at ${url}?`,
    save: 'Save',
    dontSave: 'Not now',
  };

  const bridge = new BrowserAutofillBridge({
    session: tempSession,
    store,
    isManagedContents: contents => contents === window.webContents,
    isPresented: () => true,
    windowForContents: () => window,
    labels,
    preloadDirectory: join(profile!, 'preload'),
    ackTimeoutMs: 1_000,
    chooseCredential: async (
      candidates: BrowserAutofillCandidate[],
      _context: { frame: BrowserAutofillFrame; kind: BrowserAutofillFieldKind; intentId: string },
    ): Promise<BrowserAutofillChoice | null> => {
      chooseCalls += 1;
      return candidates[0] ? { candidateId: candidates[0].id } : null;
    },
    confirmSave: async (
      _candidate: BrowserAutofillSaveCandidate,
      submission: BrowserAutofillSubmission,
    ): Promise<boolean> => {
      confirmCalls += 1;
      capturedSubmission = submission;
      if (confirmCalls === 1) markConfirmCalled();
      return new Promise<boolean>(resolve => { confirmResolvers.push(resolve); });
    },
  });
  const started = await bridge.start();
  assertEqual(statSync(join(profile!, 'preload')).mode & 0o777, 0o700, 'preload directory is private');
  assertEqual(statSync(started.preloadPath).mode & 0o777, 0o600, 'preload file is private');

  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      session: tempSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadURL(`${origin}/`);
  await waitFor(
    () => window.webContents.executeJavaScript('window.__ready === true').then(value => value === true),
    5_000,
    'page ready',
  );
  window.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 250));

  const rect = async (selector: string) => {
    const value = await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`) as { x: number; y: number } | null;
    assert(value, `${selector} has a box`);
    return value;
  };
  const click = async (selector: string) => {
    const point = await rect(selector);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const valueOf = (selector: string) => window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.value ?? null`,
  ) as Promise<string | null>;

  h.test('script focus does not open the chooser, a real pointer does', async () => {
    await window.webContents.executeJavaScript("document.querySelector('#user').focus(); true");
    await new Promise(resolve => setTimeout(resolve, 150));
    assertEqual(chooseCalls, 0, 'programmatic focus did not open a chooser');
    await click('#user');
    await waitFor(() => chooseCalls === 1, 5_000, 'pointer opened the chooser');
    await waitFor(async () => await valueOf('#user') === 'alice' && await valueOf('#pass') === 'secret', 5_000, 'fill landed through directed frame and ack');
  });

  h.test('submit freezes origin and credentials before the POST redirect', async () => {
    await click('#submit');
    await waitFor(() => posted, 5_000, 'HTTP POST observed');
    await waitFor(() => window.webContents.getURL().endsWith('/after'), 5_000, 'POST redirect completed');
    await waitFor(() => confirmCalls === 1, 5_000, 'trusted save confirmation opened');
    assert(capturedSubmission, 'submission was frozen');
    assertEqual(capturedSubmission!.originUrl, origin, 'submission keeps the original exact origin');
    assertEqual(capturedSubmission!.username, 'alice', 'submission keeps the original username');
    assertEqual(capturedSubmission!.password, 'secret', 'submission keeps the original password');
    await window.webContents.executeJavaScript("document.title = 'new document'; true");
    confirmResolvers[0]!(true);
    await waitFor(async () => (await store.listPasswords(origin)).some(item => item.username === 'alice'), 5_000, 'redirected login saved under original origin');
    const saved = await store.listPasswords(origin);
    assertEqual(saved.length, 1, 'only the original account was saved');
    assertEqual(await store.readPassword(saved[0]!.id, 'display', () => true), 'secret', 'saved value is the captured value');
  });

  h.test('closing the window cancels a pending save', async () => {
    await window.loadURL(`${origin}/`);
    await waitFor(
      () => window.webContents.executeJavaScript('window.__ready === true').then(value => value === true),
      5_000,
      'second page ready',
    );
    await window.webContents.executeJavaScript("document.querySelector('#user').value='close-user'; document.querySelector('#pass').value='close-secret'; true");
    await click('#submit');
    await waitFor(() => confirmCalls === 2, 5_000, 'second confirmation opened');
    window.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    confirmResolvers[1]!(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    const saved = await store.listPasswords(origin);
    assertEqual(saved.some(item => item.username === 'close-user'), false, 'closed window did not persist the pending save');
  });

  const code = await h.finish(join(__dirname, 'browser-credentials-bridge-electron-result.json'), 'browser-credentials-bridge-electron');
  bridge.dispose();
  if (!window.isDestroyed()) window.destroy();
  server.close();
  app.quit();
  return code;
}

void main().then(code => {
  process.exitCode = code;
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
  app.quit();
});
