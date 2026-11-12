import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { ChromeFrameDecoder, chromeFrame, MAX_CHROME_FRAME, MAX_NATIVE_OUTBOUND } from './chrome-wire';
import { BrowserError, type BrowserObject } from './types';
import { currentDesktopEdition, getDesktopEdition } from '../services/desktop-edition';
import type { DesktopEditionId } from '../../shared/desktop-edition';

export function chromeDiscoveryDirectory(edition: DesktopEditionId = currentDesktopEdition().id): string {
  const name = getDesktopEdition(edition).chromeDiscoveryName;
  return process.platform === 'win32' ? join(process.env.LOCALAPPDATA || process.env.TEMP || '', name) : join('/tmp', name);
}

/** How often the host confirms its own discovery endpoint still exists. */
const ENDPOINT_WATCH_MS = 5_000;
/** Consecutive inspection failures tolerated before the host gives up on itself. */
const ENDPOINT_WATCH_FAILURE_LIMIT = 3;

interface HostOptions {
  directory?: string;
  input?: Readable;
  output?: Writable;
  transport?: 'unix' | 'tcp';
  parentExecutable?: string | null;
  onClosed?: (error?: Error) => void;
  endpointWatchMs?: number;
}
interface Pending { client: Socket; originalId: number; timer: ReturnType<typeof setTimeout> }
/** Filesystem identity of the published endpoint, used to tell "gone" from "replaced". */
interface EndpointIdentity { dev: number; ino: number }

function endpointIdentityOf(path: string): EndpointIdentity | null {
  try {
    const stat = lstatSync(path);
    // A filesystem that reports no device and inode number (some Windows
    // volumes) cannot support an identity comparison: every check would read as
    // "replaced" and tear down a working relay. Falling back to null keeps the
    // endpoint published and simply skips the watch, since existence alone still
    // covers the deletion this defends against.
    if (!stat.dev && !stat.ino) return null;
    return { dev: stat.dev, ino: stat.ino };
  }
  catch { return null; }
}

function sameEndpoint(path: string, identity: EndpointIdentity): boolean {
  const current = endpointIdentityOf(path);
  return current !== null && current.dev === identity.dev && current.ino === identity.ino;
}

/** A browser-owned stdio relay. It neither starts nor owns a Chrome process. */
export class ChromeNativeHost {
  endpoint = '';
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly clients = new Set<Socket>();
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Map<number, Pending>();
  private readonly pendingFromBrowser = new Map<number, { originalId: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly token = randomBytes(32).toString('hex');
  private readonly server: Server;
  private nextId = 1;
  private closed = false;
  private endpointIdentity: EndpointIdentity | null = null;
  /** Whether this host published the endpoint, so shutdown may reclaim it. */
  private endpointPublished = false;
  private endpointWatch: ReturnType<typeof setInterval> | null = null;
  private endpointWatchFailures = 0;
  private inspecting = false;
  /** Where the successor file waits while this host's server closes. */
  private parkedSuccessor: { parked: string; endpoint: string } | null = null;

  constructor(private readonly options: HostOptions = {}) {
    this.input = options.input ?? process.stdin; this.output = options.output ?? process.stdout;
    this.server = createServer(client => this.accept(client));
  }

  async start(): Promise<void> {
    const directory = this.options.directory ?? chromeDiscoveryDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new BrowserError('refused_by_policy', 'The Chrome relay directory is not owned by this user.');
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    const tcp = (this.options.transport ?? (process.platform === 'win32' ? 'tcp' : 'unix')) === 'tcp';
    this.endpoint = join(directory, `klaus-${randomUUID()}${tcp ? '.port' : '.sock'}`);
    if (!tcp && Buffer.byteLength(this.endpoint) > 103) throw new BrowserError('invalid_request', 'The Chrome Unix socket pathname exceeds the platform limit.');
    await new Promise<void>((resolveListen, reject) => {
      const fail = (error: Error): void => { this.server.removeListener('listening', ready); reject(error); };
      const ready = (): void => { this.server.removeListener('error', fail); resolveListen(); };
      this.server.once('error', fail); this.server.once('listening', ready);
      if (tcp) this.server.listen(0, '127.0.0.1'); else this.server.listen(this.endpoint);
    });
    if (tcp) {
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new BrowserError('host_error', 'Chrome relay failed to bind.');
      writeFileSync(this.endpoint, JSON.stringify({ addr: `127.0.0.1:${address.port}`, token: this.token }), { mode: 0o600, flag: 'wx' });
    } else chmodSync(this.endpoint, 0o600);
    this.endpointPublished = true;
    this.endpointIdentity = endpointIdentityOf(this.endpoint);
    // The watch needs an identity to compare against. Where the filesystem
    // reports none, existence-only checking would be the weaker guarantee, and
    // publishing already succeeded — so the endpoint simply goes unwatched.
    if (this.endpointIdentity) this.startEndpointWatch();
    const decoder = new ChromeFrameDecoder(true);
    this.input.on('data', (chunk: Buffer) => {
      try { for (const message of decoder.push(chunk)) this.fromBrowser(message); }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
    this.input.once('end', () => this.close());
    this.input.once('error', error => this.close(error));
    this.output.once('error', error => this.close(error));
    this.server.on('error', error => this.close(error));
  }

  private sendClient(client: Socket, message: BrowserObject): void {
    if (client.destroyed) return;
    try {
      const frame = chromeFrame(message);
      if (client.writableLength + frame.length > MAX_CHROME_FRAME * 2) { client.destroy(); return; }
      client.write(frame);
    } catch { client.destroy(); }
  }

  private sendBrowser(message: BrowserObject): void {
    if (this.closed) throw new BrowserError('unavailable', 'Chrome native messaging has closed.');
    const frame = chromeFrame(message, true, MAX_NATIVE_OUTBOUND);
    if (this.output.writableLength + frame.length > MAX_CHROME_FRAME * 2) throw new BrowserError('unavailable', 'Chrome native messaging is not consuming messages.');
    this.output.write(frame);
  }

  private fromBrowser(message: BrowserObject): void {
    if (typeof message.id === 'number' && message.method === 'ping') {
      // The extension's liveness heartbeat must reach the controlling app:
      // answering it locally would keep debuggers attached after the app dies.
      if (this.clients.size === 0) { this.sendBrowser({ jsonrpc: '2.0', id: message.id, error: { code: 1, message: 'No Klaus client is connected to the Chrome relay.' } }); return; }
      if (this.pendingFromBrowser.size >= 1024) { this.sendBrowser({ jsonrpc: '2.0', id: message.id, error: { code: 1, message: 'Chrome relay has too many pending browser requests.' } }); return; }
      const id = this.nextId++;
      const originalId = message.id;
      this.pendingFromBrowser.set(id, { originalId, timer: setTimeout(() => {
        if (!this.pendingFromBrowser.delete(id)) return;
        this.sendBrowser({ jsonrpc: '2.0', id: originalId, error: { code: 1, message: 'Chrome relay liveness ping timed out.' } });
      }, 5_000) });
      for (const client of this.clients) this.sendClient(client, { ...message, id });
      return;
    }
    if (typeof message.id === 'number' && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      this.sendClient(pending.client, { ...message, id: pending.originalId }); return;
    }
    for (const client of this.clients) this.sendClient(client, message);
  }

  private accept(client: Socket): void {
    if (this.closed) { client.destroy(); return; }
    this.sockets.add(client);
    let authenticated = (this.options.transport ?? (process.platform === 'win32' ? 'tcp' : 'unix')) === 'unix';
    const decoder = new ChromeFrameDecoder();
    const timer = setTimeout(() => { if (!authenticated) client.destroy(); }, 5000);
    client.once('close', () => {
      clearTimeout(timer); this.clients.delete(client); this.sockets.delete(client);
      for (const [id, pending] of this.pending) if (pending.client === client) { clearTimeout(pending.timer); this.pending.delete(id); }
    });
    client.on('error', () => client.destroy());
    if (authenticated) this.clients.add(client);
    client.on('data', chunk => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!authenticated) {
            const candidate = typeof message.klausToken === 'string' ? Buffer.from(message.klausToken) : Buffer.alloc(0);
            const expected = Buffer.from(this.token);
            if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) { client.destroy(); return; }
            authenticated = true; clearTimeout(timer); this.clients.add(client); continue;
          }
          this.fromClient(client, message);
        }
      } catch { client.destroy(); }
    });
  }

  private fromClient(client: Socket, message: BrowserObject): void {
    if (typeof message.id === 'number' && message.method === undefined) {
      const browserPending = this.pendingFromBrowser.get(message.id);
      if (browserPending) {
        clearTimeout(browserPending.timer); this.pendingFromBrowser.delete(message.id);
        this.sendBrowser({ ...message, id: browserPending.originalId });
        return;
      }
    }
    if (typeof message.method !== 'string') return;
    if (message.method === 'host/browser') {
      if (typeof message.id === 'number') this.sendClient(client, { jsonrpc: '2.0', id: message.id, result: { executable: this.options.parentExecutable ?? null, pid: process.pid } });
      return;
    }
    if (message.id === undefined) { this.sendBrowser(message); return; }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) throw new BrowserError('invalid_request', 'Chrome relay request ids must be integers.');
    if (this.pending.size >= 1024) { this.sendClient(client, { jsonrpc: '2.0', id: message.id, error: { code: 1, message: 'Chrome relay has too many pending requests.' } }); return; }
    const id = this.nextId++;
    const fail = (reason: string): void => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      this.sendClient(client, { jsonrpc: '2.0', id: pending.originalId, error: { code: 1, message: reason } });
    };
    this.pending.set(id, { client, originalId: message.id, timer: setTimeout(() => fail('Chrome relay request timed out.'), 65_000) });
    try { this.sendBrowser({ ...message, id }); } catch (error) { fail(String(error)); }
  }

  /**
   * Confirm the published endpoint is still this host's own endpoint.
   *
   * The discovery directory lives in a world-writable temporary location, so
   * the operating system or a cleanup tool can remove the socket or port file
   * while this process keeps running. The browser side still believes it is
   * connected — its stdio pipe is intact — so it never reconnects, and Klaus
   * silently loses Chrome until someone restarts the browser. Detecting the
   * loss here and exiting is what lets the extension's own reconnect path
   * republish a reachable endpoint.
   *
   * Identity is the device and inode pair rather than mere existence: a path
   * that was deleted and replaced by another host's endpoint is a different
   * file, and treating it as ours would make shutdown unlink someone else's.
   */
  private inspectEndpoint(): void {
    if (this.closed || !this.endpoint || !this.endpointIdentity) return;
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(this.endpoint); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A definite ENOENT is the endpoint being gone; anything else may be a
      // transient permission or I/O fault, so retry a bounded number of times
      // rather than tearing down a working relay.
      if (code !== 'ENOENT') {
        if (++this.endpointWatchFailures >= ENDPOINT_WATCH_FAILURE_LIMIT) {
          this.close(new BrowserError('host_error', `The Chrome relay endpoint could not be inspected (${code ?? 'unknown error'}).`));
        }
        return;
      }
      // The endpoint is gone, so there is nothing left that this host owns and
      // nothing for shutdown to reclaim.
      this.endpointIdentity = null;
      this.endpointPublished = false;
      this.close(new BrowserError('host_error', 'The Chrome relay endpoint was removed from its discovery directory.'));
      return;
    }
    this.endpointWatchFailures = 0;
    if (stat.dev !== this.endpointIdentity.dev || stat.ino !== this.endpointIdentity.ino) {
      // Replaced, not removed: a different file now occupies this pathname, so
      // this relay's listen is no longer what discovery finds. The identity is
      // kept so shutdown can tell that file apart from its own and spare it.
      this.close(new BrowserError('host_error', 'The Chrome relay endpoint was replaced by another file.'));
    }
  }

  private startEndpointWatch(): void {
    if (this.endpointWatch || this.closed) return;
    const interval = this.options.endpointWatchMs ?? ENDPOINT_WATCH_MS;
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.endpointWatch = setInterval(() => {
      if (this.inspecting) return;
      this.inspecting = true;
      try { this.inspectEndpoint(); } finally { this.inspecting = false; }
    }, interval);
    // A relay whose only job is waiting on the browser must never hold the
    // process open by itself.
    this.endpointWatch.unref?.();
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.endpointWatch) { clearInterval(this.endpointWatch); this.endpointWatch = null; }
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    for (const client of this.sockets) client.destroy();
    this.clients.clear(); this.sockets.clear();
    // Closing the server reclaims its bound pathname before it returns, and it
    // does so by path rather than by identity. When an unrelated file has taken
    // over this endpoint, that reclaim would destroy a file this relay does not
    // own, so the successor is parked aside first and put back afterwards. This
    // is decided from the pathname here rather than from what the endpoint watch
    // happened to observe, because a close can also come from the browser's pipe
    // ending in the same instant the file was replaced.
    this.parkSuccessor();
    this.server.close();
    this.restoreSuccessor();
    // The unlink below is then only for transports whose endpoint libuv does not
    // reclaim — a TCP port file — and only for a file this host published. Where
    // the filesystem gave no identity to compare against, the published flag is
    // the only evidence available and is enough: this host wrote that path.
    if (this.endpointPublished && this.endpoint &&
        (!this.endpointIdentity || sameEndpoint(this.endpoint, this.endpointIdentity))) {
      try { unlinkSync(this.endpoint); } catch { /* Unix close may already remove the socket. */ }
    }
    this.endpointIdentity = null;
    this.endpointPublished = false;
    this.options.onClosed?.(error);
  }

  /**
   * Move a foreign file out of the way of the server's own close, if any.
   *
   * Only a file that is verifiably NOT this host's endpoint is parked: an
   * endpoint this host still owns must stay where it is so the close can reclaim
   * it, and an absent one needs nothing done.
   */
  private parkSuccessor(): void {
    this.parkedSuccessor = null;
    if (!this.endpoint || !this.endpointIdentity) return;
    if (sameEndpoint(this.endpoint, this.endpointIdentity)) return;
    const parked = `${this.endpoint}.klaus-parked-${randomUUID()}`;
    try { renameSync(this.endpoint, parked); this.parkedSuccessor = { parked, endpoint: this.endpoint }; }
    catch { /* Already gone, or already moved: nothing left to protect. */ }
  }

  private restoreSuccessor(): void {
    const parked = this.parkedSuccessor;
    this.parkedSuccessor = null;
    if (!parked) return;
    try { renameSync(parked.parked, parked.endpoint); }
    catch { try { unlinkSync(parked.parked); } catch { /* Leave no litter behind. */ } }
  }
}

if (require.main === module) {
  let parentExecutable: string | null = null;
  if (process.platform !== 'win32') {
    try { parentExecutable = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1500 }).trim() || null; } catch { /* The browser label is optional. */ }
  }
  const index = process.argv.indexOf('--discovery-directory');
  const directory = index === -1 ? undefined : process.argv[index + 1];
  if (index !== -1 && (!directory || !isAbsolute(directory))) { process.stderr.write('Chrome relay discovery directory must be an absolute path.\n'); process.exit(1); }
  const host = new ChromeNativeHost({ directory, parentExecutable, onClosed: error => {
    if (error) process.stderr.write(`[klaus-chrome-host] ${error.message}\n`);
    process.exit(error ? 1 : 0);
  } });
  process.once('SIGTERM', () => host.close()); process.once('SIGINT', () => host.close());
  void host.start().catch(error => { process.stderr.write(`[klaus-chrome-host] ${String(error)}\n`); host.close(error instanceof Error ? error : new Error(String(error))); });
}
