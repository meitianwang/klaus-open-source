import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ComputerUseBackend, NativeRequest } from '../services/computer-use/types';
import { deadline, object } from '../services/computer-use/types';
import type { ComputerUsePasswordStore } from '../services/computer-use/policy';

export interface ComputerUseHelperCommand { executable: string; args?: string[]; env?: NodeJS.ProcessEnv }
interface Queued {
  request: NativeRequest | (Omit<NativeRequest, 'method'> & { method: 'capabilities' | 'loginPasswordPresence' | 'promptLoginPassword' | 'deleteLoginPassword' }); signal: AbortSignal;
  resolve(value: unknown): void; reject(error: Error): void; abort(): void;
}

/** Each child performs one bounded OS operation and owns no client/session state. */
export class NativeComputerUse implements ComputerUseBackend {
  private readonly queue: Queued[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private active?: { child: ChildProcessWithoutNullStreams; cancel(reason: Error): void };
  private initialized?: Promise<void>;
  private supported = false;
  private error = 'Computer Use native backend has not been initialized';
  private closing = false;
  private lastOwnInputAt = 0;
  private cooldownUntil = 0;
  private passwordSupported = false;
  private passwordSequence = 0;
  private readonly passwordResource = randomUUID();
  constructor(private readonly options: { command?: ComputerUseHelperCommand; platform?: NodeJS.Platform; timeoutMs?: number; autoUnlockEnabled?(): boolean }) {}
  readonly loginPassword: ComputerUsePasswordStore = {
    available: () => this.passwordSupported && !this.closing,
    hasPassword: async signal => {
      const result = object(await this.passwordRequest('loginPasswordPresence', signal));
      if (typeof result.hasLoginPassword !== 'boolean') throw new Error('Invalid native login password presence');
      return result.hasLoginPassword;
    },
    prompt: async signal => {
      const operationId = randomUUID(), value = await this.passwordRequest('promptLoginPassword', signal, operationId);
      let result: Record<string, unknown>;
      try {
        result = object(value);
        if (typeof result.cancelled !== 'boolean' || typeof result.stored !== 'boolean' || typeof result.hasLoginPassword !== 'boolean'
          || (result.cancelled && result.stored) || (!result.cancelled && !result.hasLoginPassword)) throw new Error('Invalid native password prompt result');
      } catch {
        if (!await this.discardPassword(operationId)) throw new Error('Invalid password prompt result; removal of any newly saved credential could not be confirmed');
        throw new Error('Invalid native password prompt result');
      }
      return { cancelled: result.cancelled === true, created: result.stored === true, discard: async () => {
        if (result.stored && !await this.discardPassword(operationId)) throw new Error('Removal of the new login password could not be confirmed');
      } };
    },
    remove: async signal => {
      const result = object(await this.passwordRequest('deleteLoginPassword', signal));
      if (result.deleted !== true) throw new Error('Login password deletion was not confirmed');
    },
  };
  private passwordRequest(method: 'loginPasswordPresence' | 'promptLoginPassword' | 'deleteLoginPassword', signal: AbortSignal, operationId = randomUUID()) {
    if (!this.loginPassword.available()) return Promise.reject(new Error('Lock-screen auto-unlock is macOS-only and requires the current native helper'));
    return this.enqueue({ resourceId: this.passwordResource, operationId, generation: 1, sequence: ++this.passwordSequence, method, args: {} }, signal);
  }
  /** Cancellation cleanup is limited to the new item tagged by this operation, including during shutdown. */
  private discardPassword(owner: string): Promise<boolean> {
    const command = this.options.command; if (!command) return Promise.resolve(false);
    const task = new Promise<boolean>(resolve => {
      const operationId = randomUUID(), sequence = ++this.passwordSequence;
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(command.executable, command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: command.env ?? process.env }); }
      catch { resolve(false); return; }
      let output = '', failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5000);
      child.on('error', () => { failed = true; }); child.stdin.on('error', () => { failed = true; }); child.stderr.resume();
      child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 4096) { failed = true; child.kill('SIGKILL'); } });
      child.once('close', code => {
        clearTimeout(timer);
        try { const reply = object(JSON.parse(output)); resolve(!failed && code === 0 && reply.ok === true && reply.operationId === operationId
          && reply.resourceId === this.passwordResource && reply.generation === 1 && reply.sequence === sequence && object(reply.result).deleted === true); }
        catch { resolve(false); }
      });
      child.stdin.end(JSON.stringify({ resourceId: this.passwordResource, operationId, generation: 1, sequence,
        method: 'discardLoginPassword', args: { owner } }));
    });
    this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
  }
  availability() { return { available: this.supported && !this.closing, ...(this.error ? { error: this.error } : {}) }; }
  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Computer Use native backend is closed'));
    return this.initialized ??= (async () => {
      const platform = this.options.platform ?? process.platform;
      if (platform !== 'darwin' && platform !== 'win32') { this.error = `Computer Use native backend is not installed for ${platform}`; return; }
      if (!this.options.command) { this.error = 'Computer Use helper is missing'; return; }
      try {
        const response = object(await this.enqueue({ resourceId: randomUUID(), operationId: randomUUID(), generation: 1, sequence: 1,
          method: 'capabilities', args: {} }, this.controller.signal));
        if (response.version !== 1 || response.supported !== true) throw new Error('Computer Use helper protocol is unavailable');
        this.passwordSupported = platform === 'darwin' && response.autoUnlock === true;
        this.supported = true; this.error = '';
      } catch (error) { this.error = error instanceof Error ? error.message : 'Computer Use helper failed'; }
    })();
  }
  request(request: NativeRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.supported) return Promise.reject(new Error(this.error));
    return this.enqueue(request, signal);
  }
  private enqueue(request: Queued['request'], signal: AbortSignal): Promise<unknown> {
    if (this.closing || signal.aborted) return Promise.reject(new Error('Computer Use native operation was cancelled'));
    if (this.queue.length >= 32) return Promise.reject(new Error('Computer Use native operation queue is full'));
    let item!: Queued;
    const task = new Promise<unknown>((resolve, reject) => {
      item = { request, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) { this.queue.splice(index, 1); signal.removeEventListener('abort', item.abort); reject(new Error('Computer Use queued operation was cancelled')); }
      } };
      this.queue.push(item); signal.addEventListener('abort', item.abort, { once: true });
    });
    this.pending.add(task); void task.finally(() => this.pending.delete(task)).catch(() => {});
    this.pump(); return task;
  }
  private pump(): void {
    if (this.active || this.closing) return;
    const item = this.queue.shift(); if (!item) return;
    item.signal.removeEventListener('abort', item.abort);
    if (item.signal.aborted) { item.reject(new Error('Computer Use operation was cancelled')); this.pump(); return; }
    const command = this.options.command;
    if (!command) { item.reject(new Error('Computer Use helper is missing')); this.pump(); return; }
    const input = item.request.method === 'action' || (item.request.method === 'activate' && item.request.args.inputAction === true);
    if (input && Date.now() < this.cooldownUntil) {
      const app = object(item.request.args.app), label = typeof app.name === 'string' ? app.name : typeof app.input === 'string' ? app.input : 'this app';
      item.reject(new Error(`The user is still interacting with ${label}. Wait 2 seconds and retry.`)); this.pump(); return;
    }
    let payload: string;
    try { payload = JSON.stringify({ ...item.request, args: { ...item.request.args, lastOwnInputAt: this.lastOwnInputAt,
      cooldownUntil: this.cooldownUntil, autoUnlock: input && this.options.autoUnlockEnabled?.() === true } }); }
    catch (error) { item.reject(error instanceof Error ? error : new Error('Computer Use settings could not be read')); this.pump(); return; }
    if (Buffer.byteLength(payload) > 256 * 1024) { item.reject(new Error('Computer Use native input exceeds its byte limit')); this.pump(); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command.executable, command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: command.env ?? process.env }); }
    catch (error) { item.reject(error instanceof Error ? error : new Error('Computer Use helper failed to spawn')); this.pump(); return; }
    let broken: Error | undefined, chunks: Buffer[] = [], size = 0, stderrBytes = 0, killTimer: NodeJS.Timeout | undefined;
    const framed = (this.options.platform ?? process.platform) === 'win32';
    const cancel = (reason: Error) => {
      broken ??= reason;
      if (killTimer) return;
      killTimer = setTimeout(() => child.kill('SIGKILL'), item.request.method === 'promptLoginPassword' ? 5000 : 500);
      // Windows SIGTERM kills immediately. Give the helper a private control
      // frame first so an entered drag can release its own button before exit.
      if (framed && !child.stdin.destroyed && child.stdin.writable) child.stdin.end('{"cancel":true}\n');
      else child.kill('SIGTERM');
    };
    this.active = { child, cancel };
    const abort = () => cancel(new Error('Computer Use native operation was cancelled'));
    item.signal.addEventListener('abort', abort, { once: true });
    const held = item.request.method === 'action' && typeof item.request.args.duration === 'number'
      ? Math.max(0, Math.min(30, item.request.args.duration)) * 1000
        * (item.request.args.name === 'click' && typeof item.request.args.click_count === 'number' ? Math.max(1, Math.min(5, item.request.args.click_count)) : 1) : 0;
    const budget = item.request.method === 'promptLoginPassword' ? 185_000 : Math.max(120_000, 15_000 + held);
    const timer = setTimeout(() => cancel(new Error('Computer Use native operation timed out')),
      Math.max(1, Math.min(185_000, this.options.timeoutMs ?? budget)));
    child.once('error', error => { broken ??= error; });
    child.stdin.on('error', error => { if (!broken) cancel(error); });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) { chunks = []; cancel(new Error('Computer Use native output exceeds its byte limit')); }
      else chunks.push(chunk);
    });
    // Native diagnostics are drained without forwarding application text to logs.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) cancel(new Error('Computer Use native diagnostic output exceeds its byte limit'));
    });
    child.once('close', async (code, exitSignal) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); item.signal.removeEventListener('abort', abort);
      // The entered operation still owns its cleanup, but this process has already exited.
      if (this.active) this.active.cancel = reason => { broken ??= reason; };
      try {
        if (code !== 0 || exitSignal) throw broken ?? new Error('Computer Use helper exited before completing the operation');
        const response = object(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'native response');
        for (const key of ['resourceId', 'operationId', 'generation', 'sequence'] as const) if (response[key] !== item.request[key]) throw new Error('Computer Use native response identity mismatch');
        if (typeof response.postedAt === 'number' && Number.isFinite(response.postedAt) && response.postedAt > this.lastOwnInputAt
          && response.postedAt <= Date.now() + 1000) this.lastOwnInputAt = response.postedAt;
        if ((this.options.platform ?? process.platform) === 'darwin' && typeof response.cooldownUntil === 'number'
          && Number.isFinite(response.cooldownUntil) && response.cooldownUntil > this.cooldownUntil
          && response.cooldownUntil <= Date.now() + 2100) this.cooldownUntil = response.cooldownUntil;
        // A cancelled helper can still report the input it released during
        // cleanup. Preserve that ownership without accepting its cancelled work.
        if (broken) throw broken;
        if (response.ok !== true) {
          const error = new Error(typeof response.error === 'string' ? response.error.slice(0, 2048) : 'Computer Use native operation failed');
          if (item.request.method === 'action' && typeof response.actionStarted === 'boolean') Object.assign(error, { computerUseActionStarted: response.actionStarted });
          throw error;
        }
        item.resolve(response.result);
      } catch (error) {
        if (item.request.method === 'promptLoginPassword' && !await this.discardPassword(item.request.operationId)) {
          item.reject(new Error('The password operation ended before confirmation; removal of any newly saved credential could not be confirmed'));
        } else item.reject(broken ?? (error instanceof Error ? error : new Error('Computer Use native result is invalid')));
      }
      this.active = undefined;
      this.pump();
    });
    if (item.signal.aborted || this.closing) abort(); else if (framed) child.stdin.write(payload + '\n'); else child.stdin.end(payload);
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true; this.supported = false; this.controller.abort();
    for (const item of this.queue.splice(0)) { item.signal.removeEventListener('abort', item.abort); item.reject(new Error('Computer Use native backend is closed')); }
    this.active?.cancel(new Error('Computer Use native backend is closed'));
    const complete = await deadline(Promise.allSettled([...this.pending]), deadlineMs);
    return { complete: complete && !this.active && !this.pending.size };
  }
}
