import { createConnection, type Socket } from 'node:net';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ChromeFrameDecoder, chromeFrame } from './chrome-wire';
import { chromeDiscoveryDirectory } from './chrome-native-host';
import { BrowserError, object, type BrowserObject } from './types';
import type { Json } from '../ipc/contract';

interface Request { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export interface ChromeInstance { endpoint: string; id: string; info: BrowserObject; executable: string | null }

export function chromeBrowserName(instance: Pick<ChromeInstance, 'executable' | 'info'>): string {
  const executable = instance.executable?.toLowerCase() ?? '';
  for (const [needle, name] of [['microsoft edge', 'Edge'], ['brave browser', 'Brave'], ['vivaldi', 'Vivaldi'], ['opera', 'Opera'], ['chromium', 'Chromium'], ['google chrome', 'Chrome']]) {
    if (executable.includes(needle!)) return name!;
  }
  return typeof instance.info.name === 'string' && instance.info.name.trim() ? instance.info.name : 'Chrome';
}

/** One persistent socket consumes replies and events exactly once. */
export class ChromeRelay extends EventEmitter {
  private readonly requests = new Map<number, Request>();
  private nextId = 1;
  private readonly decoder = new ChromeFrameDecoder();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    super();
    socket.on('data', chunk => {
      try {
        for (const message of this.decoder.push(chunk)) {
          if (typeof message.id === 'number' && message.method === undefined) {
            const pending = this.requests.get(message.id);
            if (!pending) continue;
            this.requests.delete(message.id); clearTimeout(pending.timer);
            if (message.error !== undefined) pending.reject(new BrowserError('chrome_error', typeof message.error === 'string' ? message.error : String(object(message.error).message ?? 'Chrome request failed.')));
            else pending.resolve(message.result ?? null);
          } else if (typeof message.method === 'string') this.emit('notification', message);
        }
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once('close', () => this.close()); socket.once('error', error => this.close(error));
  }

  static async connect(endpoint: string, timeout = 1500): Promise<ChromeRelay> {
    const stat = await lstat(endpoint);
    if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new BrowserError('refused_by_policy', 'Chrome relay endpoint permissions are not private to this user.');
    let token: string | undefined;
    let socket: Socket;
    if (endpoint.endsWith('.port')) {
      if (!stat.isFile()) throw new BrowserError('refused_by_policy', 'Chrome loopback metadata must be a regular file.');
      const record = object(JSON.parse(await readFile(endpoint, 'utf8')));
      const match = typeof record.addr === 'string' ? /^127\.0\.0\.1:(\d+)$/u.exec(record.addr) : null;
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || typeof record.token !== 'string' || record.token.length < 16) throw new BrowserError('refused_by_policy', 'Invalid Chrome loopback endpoint.');
      token = record.token; socket = createConnection({ host: '127.0.0.1', port: Number(match[1]) });
    } else {
      if (!stat.isSocket()) throw new BrowserError('refused_by_policy', 'Chrome relay endpoint is not a socket.');
      socket = createConnection(endpoint);
    }
    await new Promise<void>((resolveConnect, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new BrowserError('timeout', 'Chrome relay connection timed out.')); }, timeout);
      const error = (reason: Error): void => { clearTimeout(timer); reject(reason); };
      socket.once('error', error);
      socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', error); resolveConnect(); });
    });
    const relay = new ChromeRelay(socket);
    if (token) socket.write(chromeFrame({ klausToken: token }));
    return relay;
  }

  request(method: string, params: BrowserObject = {}, timeout = 30_000): Promise<Json> {
    if (this.closed) return Promise.reject(new BrowserError('unavailable', 'The Chrome relay disconnected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new BrowserError('timeout', `Chrome ${method} timed out.`)); }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      try { this.socket.write(chromeFrame({ jsonrpc: '2.0', id, method, params })); }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }

  close(error: Error = new BrowserError('unavailable', 'The Chrome relay disconnected.')): void {
    if (this.closed) return;
    this.closed = true; this.socket.destroy();
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear(); this.emit('closed', error);
  }
}

export async function discoverChrome(directory = chromeDiscoveryDirectory()): Promise<{ browsers: ChromeInstance[]; candidatePipeCount: number; failures: string[] }> {
  let files: string[];
  try { files = (await readdir(directory)).filter(name => /^klaus-[\w-]+\.(sock|port)$/u.test(name)).slice(0, 64); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { browsers: [], candidatePipeCount: 0, failures: [] }; throw error; }
  const results = await Promise.all(files.map(async file => {
    const endpoint = join(directory, file);
    let relay: ChromeRelay | undefined;
    try {
      relay = await ChromeRelay.connect(endpoint);
      const info = object(await relay.request('getInfo', { session_id: 'klaus-discovery', turn_id: 'discovery' }, 1500));
      const instance = object(info.metadata).extensionInstanceId;
      if (typeof instance !== 'string' || !instance) throw new BrowserError('unavailable', 'Chrome did not return a stable extension instance id.');
      let executable: string | null = null;
      try { const host = object(await relay.request('host/browser', {}, 1500)); executable = typeof host.executable === 'string' ? host.executable : null; } catch { /* Older hosts still relay browser commands. */ }
      return { endpoint, id: `chrome:${instance}`, info, executable };
    } catch (error) { return `${endpoint}: ${String(error)}`; }
    finally { relay?.close(); }
  }));
  return { browsers: results.filter((entry): entry is ChromeInstance => typeof entry !== 'string'), candidatePipeCount: files.length, failures: results.filter((entry): entry is string => typeof entry === 'string').slice(0, 8) };
}
