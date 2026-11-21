// Integration test for the desktop client's bundled headless Chromium browser
// exposed through KLAUS_BROWSER_EXECUTABLE: exercises both `--remote-debugging-port`
// (Puppeteer / Remotion wire) and `--remote-debugging-pipe` (Playwright wire),
// isolated context/target creation, H.264/AAC codec availability, and clean teardown.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { desktopEngineEnvironment } from '../main/services/desktop-edition';

const { assertElectronGuiAvailable } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

async function verifyPortTransport(browserShim: string): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'klaus-headless-port-test-'));
  const child = spawn(browserShim, ['--headless=old', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for DevTools endpoint: ${stderr}`)), 15_000);
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Headless browser exited prematurely with code ${code}: ${stderr}`));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    let seq = 0;
    const pending = new Map<number, { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }>();
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString('utf8')) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const waiter = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? 'CDP error'));
        else waiter.resolve(msg.result ?? {});
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const { browserContextId } = await send('Target.createBrowserContext') as { browserContextId: string };
    assert.ok(browserContextId.length > 0, 'Target.createBrowserContext returns a context id');

    const { targetId } = await send('Target.createTarget', { url: 'about:blank', width: 640, height: 360, browserContextId }) as { targetId: string };
    assert.ok(targetId.length > 0, 'Target.createTarget creates an isolated page target');

    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: 'data:text/html,<!doctype html><h1>Headless OK</h1>' }, sessionId);

    const evalRes = await send('Runtime.evaluate', {
      expression: `({
        h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
        vp9: document.createElement('video').canPlayType('video/webm; codecs="vp9"'),
      })`,
      returnByValue: true,
    }, sessionId) as { result?: { value?: { h264?: string; vp9?: string } } };
    assert.equal(evalRes.result?.value?.h264, 'probably', 'Bundled Electron Chromium supports H.264 + AAC');
    assert.equal(evalRes.result?.value?.vp9, 'probably', 'Bundled Electron Chromium supports VP9');

    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data?: string };
    assert.ok(typeof shot.data === 'string' && shot.data.length > 100, 'Page.captureScreenshot returns PNG bytes');

    await send('Target.closeTarget', { targetId });
    await send('Target.disposeBrowserContext', { browserContextId });

    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    await send('Browser.close');
    const code = await exited;
    assert.equal(code, 0, 'Browser.close exits cleanly with status 0');
  } finally {
    child.kill('SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function verifyPipeTransport(browserShim: string): Promise<void> {
  if (process.platform === 'win32') return;
  const child = spawn(browserShim, ['--remote-debugging-pipe', '--headless'], {
    stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const pipeWrite = child.stdio[3] as Duplex;
  const pipeRead = child.stdio[4] as Duplex;

  try {
    let buffer = '';
    const replyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out on --remote-debugging-pipe roundtrip')), 15_000);
      pipeRead.setEncoding('utf8');
      pipeRead.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\0');
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (frame) {
            const parsed = JSON.parse(frame) as { id?: number; result?: Record<string, unknown> };
            if (parsed.id === 1) {
              clearTimeout(timer);
              resolve(parsed.result ?? {});
              return;
            }
          }
          idx = buffer.indexOf('\0');
        }
      });
    });

    pipeWrite.write(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} }) + '\0');
    const version = await replyPromise;
    assert.ok(typeof version.product === 'string' && version.product.length > 0, 'Pipe transport returns Browser.getVersion');

    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    pipeWrite.write(JSON.stringify({ id: 2, method: 'Browser.close', params: {} }) + '\0');
    const code = await exited;
    assert.equal(code, 0, 'Pipe transport exits cleanly on Browser.close without hanging descriptors');
  } finally {
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  assertElectronGuiAvailable();
  const electronBinary = require('electron') as string;
  const profile = mkdtempSync(join(tmpdir(), 'klaus-headless-suite-'));
  try {
    const envEntries = Object.fromEntries(desktopEngineEnvironment(profile, { PATH: '/usr/bin:/bin' }, electronBinary));
    const browserShim = envEntries.KLAUS_BROWSER_EXECUTABLE;
    assert.ok(browserShim, 'desktopEngineEnvironment exports KLAUS_BROWSER_EXECUTABLE');
    await verifyPortTransport(browserShim);
    await verifyPipeTransport(browserShim);
    process.stdout.write('headless-browser-electron: PASS (port + pipe + codecs)\n');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
