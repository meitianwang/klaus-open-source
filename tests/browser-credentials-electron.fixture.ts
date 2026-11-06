import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOFILL_PRELOAD_SOURCE } from '../main/browser/autofill-preload';
import { assert, assertEqual, Harness, waitFor } from './harness';

const profile = process.env.KLAUS_BROWSER_CREDENTIALS_PROFILE;
if (!profile) throw new Error('This fixture requires KLAUS_BROWSER_CREDENTIALS_PROFILE.');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>credential autofill fixture</title>
<style>body{margin:0;font:14px sans-serif}form{display:flex;gap:8px;margin:24px;padding:16px;border:1px solid #ccc}input{width:180px;height:28px}</style>
</head><body>
<form id="form-one"><input id="u1" autocomplete="username" placeholder="user one"><input id="p1" type="password" placeholder="pass one"></form>
<form id="form-two"><input id="u2" autocomplete="username" placeholder="user two"><input id="p2" type="password" placeholder="pass two"></form>
<script>window.__fixtureReady = true;</script>
</body></html>`;

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string', 'fixture server has a port');
  const base = `http://127.0.0.1:${address.port}`;

  const preloadPath = join(profile!, 'autofill-preload.cjs');
  writeFileSync(preloadPath, AUTOFILL_PRELOAD_SOURCE);
  let documentRequests = 0;
  let documentId = '';
  let intents: Array<{ intentId: string; kind: string }> = [];
  let acks: Array<{ intentId: string; filled: boolean }> = [];
  ipcMain.on('browser-autofill:document-request', (event) => {
    documentRequests += 1;
    documentId = `document-${documentRequests}`;
    event.sender.send('browser-autofill:document', { documentId });
  });
  ipcMain.on('browser-autofill:input', (_event, payload: { intentId?: string; kind?: string }) => {
    if (payload?.intentId && payload.kind) intents.push({ intentId: payload.intentId, kind: payload.kind });
  });
  ipcMain.on('browser-autofill:ack', (_event, ack: { intentId?: string; filled?: boolean }) => {
    if (ack?.intentId) acks.push({ intentId: ack.intentId, filled: ack.filled === true });
  });

  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  await window.loadURL(`${base}/`);
  await waitFor(() => documentRequests === 1 && documentId === 'document-1', 5_000, 'preload document handshake');
  window.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 150));

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
  const pointerDown = async (selector: string) => {
    const point = await rect(selector);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const valueOf = (selector: string) => window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.value ?? null`,
  ) as Promise<string | null>;
  const sendFill = (intentId: string, document: string, username: string, password: string) => {
    window.webContents.send('browser-autofill:fill', {
      type: 'browser-autofill:fill',
      documentId: document,
      frameId: 'fixture-frame',
      intentId,
      kind: 'password',
      values: { username, password },
    });
  };

  h.test('script focus does not open a credential chooser', async () => {
    await window.webContents.executeJavaScript("document.querySelector('#u1').focus(); true");
    await new Promise(resolve => setTimeout(resolve, 150));
    assertEqual(intents.length, 0, 'programmatic focus produced no intent');
  });

  h.test('a real pointer gesture opens one intent and two forms keep separate targets', async () => {
    await pointerDown('#u1');
    await waitFor(() => intents.length === 1, 5_000, 'first pointer intent');
    await pointerDown('#u2');
    await waitFor(() => intents.length === 2, 5_000, 'second pointer intent');
    assert(intents[0]!.intentId !== intents[1]!.intentId, 'each gesture has a non-reusable intent id');
    assertEqual(intents[0]!.kind, 'username', 'first intent is bound to the username field');
    assertEqual(intents[1]!.kind, 'username', 'second intent is bound to the username field');
  });

  h.test('a late result for the previous form is ignored and the active form fills with an ack', async () => {
    const firstIntent = intents[0]!.intentId;
    const secondIntent = intents[1]!.intentId;
    sendFill(firstIntent, documentId, 'first-user', 'first-secret');
    await new Promise(resolve => setTimeout(resolve, 200));
    assertEqual(await valueOf('#u1'), '', 'stale result did not fill the first form');
    assertEqual(await valueOf('#p1'), '', 'stale result did not fill the first password');
    assertEqual(acks.length, 0, 'stale result produced no ack');

    sendFill(secondIntent, documentId, 'second-user', 'second-secret');
    await waitFor(() => acks.some(item => item.intentId === secondIntent && item.filled), 5_000, 'active form ack');
    assertEqual(await valueOf('#u2'), 'second-user', 'active form username filled');
    assertEqual(await valueOf('#p2'), 'second-secret', 'active form password filled');
    assertEqual(await valueOf('#u1'), '', 'first form still untouched');
  });

  h.test('navigation makes an earlier intent stale even before a late fill arrives', async () => {
    await pointerDown('#u1');
    await waitFor(() => intents.length === 3, 5_000, 'intent before navigation');
    const staleIntent = intents[2]!.intentId;
    await window.loadURL(`${base}/next`);
    await waitFor(() => documentRequests === 2 && documentId === 'document-2', 5_000, 'new document handshake');
    await new Promise(resolve => setTimeout(resolve, 150));
    sendFill(staleIntent, 'document-1', 'stale-user', 'stale-secret');
    await new Promise(resolve => setTimeout(resolve, 250));
    assertEqual(acks.some(item => item.intentId === staleIntent), false, 'late navigation fill produced no ack');
    assertEqual(await valueOf('#u1'), '', 'new document remains empty');
  });

  const code = await h.finish(join(__dirname, 'browser-credentials-electron-result.json'), 'browser-credentials-electron');
  window.destroy();
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
