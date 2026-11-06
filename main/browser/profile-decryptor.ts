/**
 * Browser-profile decryption adapters.
 *
 * The adapter owns one private helper process for an import. The helper keeps
 * the browser Safe Storage key in its own address space; this module only sends
 * encrypted values and receives base64 plaintext over NDJSON stdio.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  BrowserImportDecryptError,
  type BrowserPasswordDecryptor,
  type BrowserSecretContext,
} from '../../contracts/browser-import';
import type { ManagedDecryptor } from '../../contracts/browser-import-jobs';

export interface MacBrowserProfileDecryptorOptions {
  /** Absolute path to the signed helper. */
  helperPath: string;
  family: 'chrome' | 'chromium' | 'edge';
  timeoutMs?: number;
  closeTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxLineBytes?: number;
  signal?: AbortSignal;
  /** Test seam: environment for the synthetic test helper. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: ask the synthetic helper to delay its response. */
  testDelayMs?: number;
  /** Test seam: make the synthetic helper return a malformed value. */
  testResponseMode?: 'invalid-base64' | 'invalid-utf8';
  /** Test seam: make the synthetic helper ignore shutdown. */
  testIgnoreShutdown?: boolean;
  /** Extra non-secret fields sent with the helper's init request. */
  initExtra?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ControlWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelperMessage {
  id?: unknown;
  ok?: unknown;
  op?: unknown;
  value?: unknown;
  code?: unknown;
  message?: unknown;
}

type State = 'idle' | 'starting' | 'ready' | 'closing' | 'closed';

function helperError(code: string, message: string): BrowserImportDecryptError {
  return new BrowserImportDecryptError(code, message);
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class MacBrowserProfileDecryptor implements BrowserPasswordDecryptor {
  private readonly timeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxLineBytes: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private exitPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private state: State = 'idle';
  private aborted = false;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly control = new Map<string, ControlWaiter>();
  private readonly abortListener: (() => void) | undefined;

  constructor(readonly options: MacBrowserProfileDecryptorOptions) {
    if (!isAbsolute(options.helperPath)) {
      throw helperError('invalid_helper_path', 'The browser decryption helper path must be absolute.');
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 512 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    if (options.signal) {
      this.abortListener = () => {
        this.aborted = true;
        this.fail('cancelled', 'The browser import was cancelled.');
      };
      if (options.signal.aborted) this.abortListener();
      else options.signal.addEventListener('abort', this.abortListener, { once: true });
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.aborted) throw helperError('cancelled', 'The browser import was cancelled.');
    if (this.state === 'closed') throw helperError('helper_closed', 'The browser decryption helper is closed.');
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnAndInitialize();
    return this.startPromise;
  }

  async decrypt(input: Uint8Array, context: BrowserSecretContext): Promise<string> {
    const run = this.serial.then(() => this.performDecrypt(input, context));
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    if (this.state !== 'idle') throw helperError('helper_closed', 'The browser decryption helper cannot be started.');
    this.state = 'starting';
    const child = spawn(this.options.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: this.options.env ?? process.env,
    });
    this.child = child;
    this.exitPromise = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
    });
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 8 * 1024) {
        this.fail('helper_stderr_limit', 'The browser decryption helper wrote too much diagnostic output.');
      }
    });
    child.on('error', () => {
      this.fail('helper_spawn_failed', 'The browser decryption helper could not be started.');
    });
    child.on('exit', () => {
      if (this.state === 'closing') {
        this.finishClose();
        return;
      }
      if (this.state !== 'closed') {
        this.fail('helper_exited', 'The browser decryption helper exited unexpectedly.');
      }
    });

    const ready = this.waitForControl('init');
    try {
      await this.writeLine(JSON.stringify({
        op: 'init',
        family: this.options.family,
        ...(this.options.initExtra ?? {}),
        ...(this.options.testIgnoreShutdown ? { ignoreShutdown: true } : {}),
      }));
      await ready;
      this.state = 'ready';
    } catch (error) {
      this.fail('helper_init_failed', 'The browser decryption helper did not initialize.');
      throw error;
    }
  }

  private async performDecrypt(input: Uint8Array, context: BrowserSecretContext): Promise<string> {
    if (this.aborted) throw helperError('cancelled', 'The browser import was cancelled.');
    await this.start();
    if (this.aborted) throw helperError('cancelled', 'The browser import was cancelled.');
    if (this.state !== 'ready') throw helperError('helper_closed', 'The browser decryption helper is not available.');

    const id = this.nextId++;
    const request: Record<string, unknown> = {
      op: 'decrypt',
      id,
      kind: context.kind,
      data: Buffer.from(input).toString('base64'),
    };
    if (context.host) request.host = context.host;
    if (context.database?.version !== undefined) request.databaseVersion = context.database.version;
    if (this.options.testDelayMs !== undefined) request.delayMs = this.options.testDelayMs;
    if (this.options.testResponseMode !== undefined) request.responseMode = this.options.testResponseMode;
    const line = JSON.stringify(request);
    if (Buffer.byteLength(line, 'utf8') > this.maxRequestBytes) {
      throw helperError('request_too_large', 'The encrypted value exceeds the request size limit.');
    }

    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail('helper_timeout', 'The browser decryption helper timed out.');
        reject(helperError('helper_timeout', 'The browser decryption helper timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    // A write failure settles the deferred below without awaiting it; keep the
    // rejection observed so it never becomes an unhandled promise rejection.
    void response.catch(() => undefined);

    try {
      await this.writeLine(line);
      return await response;
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error('The browser decryption helper request failed.'));
      }
      throw error;
    }
  }

  private waitForControl(
    operation: 'init' | 'shutdown',
    timeoutMs = this.timeoutMs,
    failOnTimeout = true,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.control.delete(operation);
        if (failOnTimeout) this.fail('helper_timeout', 'The browser decryption helper timed out.');
        reject(helperError('helper_timeout', 'The browser decryption helper timed out.'));
      }, Math.max(1, timeoutMs));
      this.control.set(operation, { resolve, reject, timer });
    });
  }

  private async writeLine(line: string): Promise<void> {
    const child = this.child;
    if (!child || this.state === 'closed' || child.stdin.destroyed) {
      throw helperError('helper_closed', 'The browser decryption helper is not available.');
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${line}\n`, error => {
        if (error) reject(helperError('helper_write_failed', 'The browser decryption helper request could not be sent.'));
        else resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    if (this.state === 'closed') return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > this.maxLineBytes * 2) {
      this.fail('response_too_large', 'The browser decryption helper response is too large.');
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length > this.maxLineBytes) {
        this.fail('response_too_large', 'The browser decryption helper response is too large.');
        return;
      }
      this.handleLine(line.toString('utf8'));
    }
  }

  private handleLine(line: string): void {
    let message: HelperMessage;
    try {
      message = JSON.parse(line) as HelperMessage;
    } catch {
      this.fail('invalid_helper_response', 'The browser decryption helper returned an invalid response.');
      return;
    }
    if (typeof message.op === 'string' && message.id === undefined) {
      const waiter = this.control.get(message.op);
      if (!waiter) return;
      this.control.delete(message.op);
      clearTimeout(waiter.timer);
      if (message.ok === true) waiter.resolve();
      else waiter.reject(this.messageError(message));
      return;
    }
    if (typeof message.id !== 'number') {
      this.fail('invalid_helper_response', 'The browser decryption helper response has no request id.');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok !== true) {
      pending.reject(this.messageError(message));
      return;
    }
    if (typeof message.value !== 'string') {
      pending.reject(helperError('invalid_helper_response', 'The browser decryption helper returned no value.'));
      return;
    }
    let buffer: Buffer;
    if (message.value.length % 4 !== 0 || !STRICT_BASE64.test(message.value)) {
      pending.reject(helperError('invalid_helper_response', 'The browser decryption helper returned invalid base64.'));
      return;
    }
    buffer = Buffer.from(message.value, 'base64');
    if (buffer.length > this.maxResponseBytes) {
      pending.reject(helperError('response_too_large', 'The decrypted value exceeds the response size limit.'));
      return;
    }
    try {
      pending.resolve(utf8Decoder.decode(buffer));
    } catch {
      pending.reject(helperError('invalid_utf8', 'The decrypted value is not valid UTF-8.'));
    }
  }

  private messageError(message: HelperMessage): BrowserImportDecryptError {
    const code = typeof message.code === 'string' && /^[a-z0-9_]+$/u.test(message.code)
      ? message.code
      : 'helper_error';
    return helperError(code, 'The browser decryption helper rejected the request.');
  }

  private async performClose(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.finishClose();
      return;
    }
    const deadline = Date.now() + Math.max(1, this.closeTimeoutMs);
    if (this.state !== 'closed') {
      this.state = 'closing';
      try {
        const shutdown = this.waitForControl('shutdown', Math.max(1, deadline - Date.now()), false);
        await this.writeLine(JSON.stringify({ op: 'shutdown' }));
        await shutdown;
      } catch {
        /* The close deadline below still bounds ack and exit. */
      }
    }
    let exited = await this.waitForExit(Math.max(1, deadline - Date.now()));
    if (!exited) {
      child.kill('SIGKILL');
      exited = await this.waitForExit(Math.max(250, this.closeTimeoutMs));
    }
    this.finishClose();
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.exitPromise) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, Math.max(1, timeoutMs));
      void this.exitPromise!.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private finishClose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.stdoutBuffer = Buffer.alloc(0);
    this.clearPending(helperError('helper_closed', 'The browser decryption helper is closed.'));
    if (this.abortListener && this.options.signal) {
      this.options.signal.removeEventListener('abort', this.abortListener);
    }
  }

  private fail(code: string, message: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.child?.kill('SIGKILL');
    this.stdoutBuffer = Buffer.alloc(0);
    this.clearPending(helperError(code, message));
    if (this.abortListener && this.options.signal) {
      this.options.signal.removeEventListener('abort', this.abortListener);
    }
  }

  private clearPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.control.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.control.clear();
  }
}

/**
 * Encrypted Chromium profile values are platform-specific. The macOS helper is
 * a separate stdio process and is never required on other platforms; callers
 * receive a structured unsupported result instead of silently importing
 * plaintext-only rows.
 */
export class UnsupportedBrowserProfileDecryptor implements ManagedDecryptor {
  constructor(readonly platform: NodeJS.Platform = process.platform) {}

  async decrypt(_input: Uint8Array, _context: BrowserSecretContext): Promise<string> {
    throw helperError(
      'unsupported_platform_encryption',
      `Encrypted browser profile values are not supported on ${this.platform}.`,
    );
  }

  async close(): Promise<void> {}
}

export interface WindowsBrowserProfileDecryptorOptions extends Omit<
  MacBrowserProfileDecryptorOptions,
  'env' | 'testDelayMs' | 'testResponseMode' | 'testIgnoreShutdown' | 'initExtra'
> {
  /** Chromium-family root that contains Local State and profile directories. */
  userDataDir: string;
}

/**
 * Windows helper adapter. The helper reads the source profile's Local State,
 * unprotects os_crypt.encrypted_key with user-scope DPAPI, and keeps the AES key
 * in its own process. The host only sends encrypted values and receives base64
 * plaintext over the same NDJSON protocol as the macOS helper.
 */
export class WindowsBrowserProfileDecryptor extends MacBrowserProfileDecryptor {
  constructor(options: WindowsBrowserProfileDecryptorOptions) {
    if (!isAbsolute(options.userDataDir)) {
      throw helperError('invalid_source_path', 'The Windows source profile root must be absolute.');
    }
    super({ ...options, initExtra: { userDataDir: options.userDataDir } });
  }
}

export interface BrowserProfileDecryptorOptions extends MacBrowserProfileDecryptorOptions {
  platform?: NodeJS.Platform;
  userDataDir?: string;
}

/**
 * Create the platform adapter lazily at the first encrypted value. Windows
 * cookie/password encryption has no implementation here, so it fails with a
 * structured code rather than making the macOS helper a startup requirement.
 */
export function createBrowserProfileDecryptor(options: BrowserProfileDecryptorOptions): ManagedDecryptor {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    if (!options.helperPath) {
      throw helperError('helper_unavailable', 'The Windows browser decryption helper is not configured.');
    }
    if (!options.userDataDir) {
      throw helperError('invalid_source_path', 'The Windows source profile root is required.');
    }
    return new WindowsBrowserProfileDecryptor({
      ...options,
      helperPath: options.helperPath,
      userDataDir: options.userDataDir,
    });
  }
  if (platform !== 'darwin') return new UnsupportedBrowserProfileDecryptor(platform);
  if (!options.helperPath) {
    throw helperError('helper_unavailable', 'The macOS browser decryption helper is not configured.');
  }
  return new MacBrowserProfileDecryptor({ ...options, helperPath: options.helperPath });
}
