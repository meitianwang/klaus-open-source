// Isolated headless Chromium mode backed by the desktop application's own
// Electron runtime. Provides full H.264/AAC/VP9 media decoding and bridges
// browser-level CDP target and context commands so Puppeteer, Remotion and
// Playwright automation work without downloading an external browser binary.

import { app, BrowserWindow, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { HEADLESS_DEVTOOLS_PREFIX, normalizeHeadlessBrowserArgs } from './headless-browser-protocol';

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function readDevToolsActivePort(userDataDir: string, timeoutMs = 10_000): Promise<{ port: number; wsPath: string }> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        const port = Number(lines[0]);
        const wsPath = lines[1]?.trim();
        if (Number.isInteger(port) && port > 0 && wsPath && wsPath.startsWith('/')) {
          return { port, wsPath };
        }
      } catch {
        // Chromium may still be flushing DevToolsActivePort; retry briefly.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for DevToolsActivePort in ${userDataDir}`);
}

export function runHeadlessBrowser(argv: readonly string[] = process.argv): void {
  const normalized = normalizeHeadlessBrowserArgs(argv.slice(1));
  const ownedProfileDir = normalized.userDataDir ? undefined : mkdtempSync(join(tmpdir(), 'klaus-headless-browser-'));
  const userDataDir = normalized.userDataDir ?? ownedProfileDir!;

  let exited = false;
  const cleanExit = (code: number): void => {
    if (exited) return;
    exited = true;
    if (ownedProfileDir) {
      try { rmSync(ownedProfileDir, { recursive: true, force: true }); } catch { /* Best-effort scratch cleanup. */ }
    }
    app.exit(code);
  };

  if (app.dock) app.dock.hide();
  app.setPath('userData', userDataDir);
  if (!normalized.userDataDir) app.commandLine.appendSwitch('user-data-dir', userDataDir);
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-port', '0');
  }
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  // Exit immediately if the parent launcher dies (including SIGKILL), leaving no orphan process.
  process.stdin.resume();
  process.stdin.once('end', () => cleanExit(0));
  process.stdin.once('close', () => cleanExit(0));
  process.stdin.once('error', () => cleanExit(0));
  process.on('SIGTERM', () => cleanExit(0));
  process.on('SIGINT', () => cleanExit(0));

  // Headless automation frequently closes the initial blank tab before opening new targets.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(async () => {
    const { port: innerPort, wsPath } = await readDevToolsActivePort(userDataDir);
    const windowsByTarget = new Map<string, BrowserWindow>();
    const contextSessions = new Map<string, { sess: Session; seedWin: BrowserWindow }>();
    let targetChain: Promise<void> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
      const next = targetChain.then(task, task);
      targetChain = next.then(() => undefined, () => undefined);
      return next;
    };

    const initialWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { sandbox: false, backgroundThrottling: false },
    });
    await initialWin.loadURL('about:blank');

    const server = createServer((req, res) => {
      const outerPort = (server.address() as AddressInfo | null)?.port ?? innerPort;
      const upstreamReq = httpRequest(
        { hostname: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers: req.headers },
        upstreamRes => {
          const chunks: Buffer[] = [];
          upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          upstreamRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8').replaceAll(`127.0.0.1:${innerPort}`, `127.0.0.1:${outerPort}`);
            res.writeHead(upstreamRes.statusCode ?? 200, {
              ...upstreamRes.headers,
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
          });
        },
      );
      upstreamReq.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstreamReq);
    });

    const wss = new WebSocketServer({ server });
    wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${innerPort}${req.url ?? wsPath}`);
      let internalSeq = 1_000_000_000;
      const pendingInternal = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

      const sendInternal = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          if (upstream.readyState !== WebSocket.OPEN) {
            reject(new Error('Upstream DevTools socket is not open'));
            return;
          }
          const id = ++internalSeq;
          pendingInternal.set(id, { resolve, reject });
          upstream.send(JSON.stringify({ id, method, params }));
        });

      const upstreamReady = new Promise<void>((resolve, reject) => {
        upstream.once('open', () => resolve());
        upstream.once('error', reject);
      });

      const listPageTargets = async (): Promise<TargetInfo[]> => {
        const result = await sendInternal('Target.getTargets');
        const infos = Array.isArray(result.targetInfos) ? (result.targetInfos as TargetInfo[]) : [];
        return infos.filter(info => info.type === 'page');
      };

      void upstreamReady.then(async () => {
        for (const info of await listPageTargets()) {
          if (!windowsByTarget.has(info.targetId) && !initialWin.isDestroyed()) {
            windowsByTarget.set(info.targetId, initialWin);
            initialWin.once('closed', () => windowsByTarget.delete(info.targetId));
          }
        }
      }).catch(() => {});

      const spawnPageWindow = async (options: { url?: string; width?: number; height?: number; sess?: Session }): Promise<{ win: BrowserWindow; info: TargetInfo }> => {
        const known = new Set<string>([...windowsByTarget.keys(), ...(await listPageTargets()).map(t => t.targetId)]);
        const win = new BrowserWindow({
          show: false,
          width: typeof options.width === 'number' && options.width > 0 ? Math.round(options.width) : 1280,
          height: typeof options.height === 'number' && options.height > 0 ? Math.round(options.height) : 720,
          webPreferences: {
            sandbox: false,
            backgroundThrottling: false,
            ...(options.sess ? { session: options.sess } : {}),
          },
        });
        const requestedUrl = typeof options.url === 'string' && options.url.length > 0 ? options.url : 'about:blank';
        await win.loadURL('about:blank');
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const found = (await listPageTargets()).find(t => !known.has(t.targetId));
          if (found) {
            windowsByTarget.set(found.targetId, win);
            win.once('closed', () => windowsByTarget.delete(found.targetId));
            if (requestedUrl !== 'about:blank') {
              void win.loadURL(requestedUrl).catch(() => {});
            }
            return { win, info: found };
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!win.isDestroyed()) win.destroy();
        throw new Error('Failed to register new headless page target');
      };

      const sendClient = (payload: Record<string, unknown>, callback?: () => void): void => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify(payload), callback);
        } else {
          callback?.();
        }
      };

      upstream.on('message', data => {
        const text = data.toString('utf8');
        let parsed: CdpMessage;
        try { parsed = JSON.parse(text) as CdpMessage; } catch {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(text);
          return;
        }
        if (typeof parsed.id === 'number' && pendingInternal.has(parsed.id)) {
          const waiter = pendingInternal.get(parsed.id)!;
          pendingInternal.delete(parsed.id);
          if (parsed.error) waiter.reject(new Error(parsed.error.message ?? 'CDP error'));
          else waiter.resolve(parsed.result ?? {});
          return;
        }
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(text);
      });

      clientWs.on('message', async rawData => {
        try { await upstreamReady; } catch { return; }
        const text = rawData.toString('utf8');
        let msg: CdpMessage;
        try { msg = JSON.parse(text) as CdpMessage; } catch {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
          return;
        }

        if (!msg.sessionId && msg.method === 'Target.createBrowserContext') {
          await serialize(async () => {
            try {
              const sess = session.fromPartition(`headless-${randomUUID()}`);
              const { win: seedWin, info } = await spawnPageWindow({ url: 'about:blank', sess });
              const contextId = info.browserContextId ?? randomUUID();
              contextSessions.set(contextId, { sess, seedWin });
              sendClient({ id: msg.id, result: { browserContextId: contextId } });
            } catch (error) {
              sendClient({ id: msg.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
            }
          });
          return;
        }

        if (!msg.sessionId && msg.method === 'Target.disposeBrowserContext') {
          await serialize(async () => {
            const ctxId = typeof msg.params?.browserContextId === 'string' ? msg.params.browserContextId : '';
            const entry = contextSessions.get(ctxId);
            contextSessions.delete(ctxId);
            try {
              for (const info of await listPageTargets()) {
                if (info.browserContextId === ctxId) {
                  const win = windowsByTarget.get(info.targetId);
                  if (win && !win.isDestroyed()) win.destroy();
                  windowsByTarget.delete(info.targetId);
                }
              }
            } catch { /* Ignore teardown race when browser is closing. */ }
            if (entry?.seedWin && !entry.seedWin.isDestroyed()) entry.seedWin.destroy();
            sendClient({ id: msg.id, result: {} });
          });
          return;
        }

        if (!msg.sessionId && msg.method === 'Target.getBrowserContexts') {
          sendClient({ id: msg.id, result: { browserContextIds: [...contextSessions.keys()] } });
          return;
        }

        if (!msg.sessionId && msg.method === 'Target.createTarget') {
          await serialize(async () => {
            try {
              const ctxId = typeof msg.params?.browserContextId === 'string' ? msg.params.browserContextId : undefined;
              const ctxEntry = ctxId ? contextSessions.get(ctxId) : undefined;
              const { info } = await spawnPageWindow({
                url: typeof msg.params?.url === 'string' ? msg.params.url : undefined,
                width: typeof msg.params?.width === 'number' ? msg.params.width : undefined,
                height: typeof msg.params?.height === 'number' ? msg.params.height : undefined,
                sess: ctxEntry?.sess,
              });
              sendClient({ id: msg.id, result: { targetId: info.targetId } });
            } catch (error) {
              sendClient({ id: msg.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
            }
          });
          return;
        }

        if (!msg.sessionId && msg.method === 'Target.closeTarget') {
          await serialize(async () => {
            const targetId = typeof msg.params?.targetId === 'string' ? msg.params.targetId : '';
            const win = windowsByTarget.get(targetId);
            if (win && !win.isDestroyed()) win.destroy();
            windowsByTarget.delete(targetId);
            sendClient({ id: msg.id, result: { success: Boolean(win) } });
          });
          return;
        }

        if (!msg.sessionId && msg.method === 'Browser.setDownloadBehavior' && msg.params?.browserContextId) {
          const { browserContextId: _ignored, ...rest } = msg.params;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ ...msg, params: rest }));
          return;
        }

        if (msg.method === 'Browser.getWindowForTarget') {
          const targetId = typeof msg.params?.targetId === 'string' ? msg.params.targetId : undefined;
          const win = (targetId ? windowsByTarget.get(targetId) : undefined) ?? initialWin;
          const alive = win && !win.isDestroyed();
          const bounds = alive ? win.getBounds() : { x: 0, y: 0, width: 1280, height: 720 };
          sendClient({
            id: msg.id,
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            result: {
              windowId: alive ? win.id : 1,
              bounds: { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, windowState: 'normal' },
            },
          });
          return;
        }

        if (msg.method === 'Browser.setWindowBounds') {
          const rawBounds = (msg.params?.bounds && typeof msg.params.bounds === 'object') ? (msg.params.bounds as Record<string, unknown>) : {};
          for (const win of windowsByTarget.values()) {
            if (!win.isDestroyed() && win.id === msg.params?.windowId) {
              const current = win.getBounds();
              win.setBounds({
                x: typeof rawBounds.left === 'number' ? rawBounds.left : current.x,
                y: typeof rawBounds.top === 'number' ? rawBounds.top : current.y,
                width: typeof rawBounds.width === 'number' ? rawBounds.width : current.width,
                height: typeof rawBounds.height === 'number' ? rawBounds.height : current.height,
              });
            }
          }
          sendClient({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result: {} });
          return;
        }

        if (msg.method === 'Browser.close') {
          const fallback = setTimeout(() => cleanExit(0), 50);
          fallback.unref();
          sendClient({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result: {} }, () => {
            clientWs.close();
            cleanExit(0);
          });
          return;
        }

        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      });

      clientWs.on('close', () => {
        for (const waiter of pendingInternal.values()) waiter.reject(new Error('Client disconnected'));
        pendingInternal.clear();
        upstream.close();
      });
      upstream.on('close', () => clientWs.close());
      upstream.on('error', () => clientWs.close());
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const outerPort = (server.address() as AddressInfo).port;
    process.stderr.write(`\n${HEADLESS_DEVTOOLS_PREFIX}DevTools listening on ws://127.0.0.1:${outerPort}${wsPath}\n`);
  }).catch(error => {
    process.stderr.write(`headless browser startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    cleanExit(1);
  });
}
