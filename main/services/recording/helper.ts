import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type RecordingRow = Record<string, unknown>;
export interface RecordingCommand { executable: string; args?: string[]; env?: NodeJS.ProcessEnv }
export interface RecordingPolicy { blockedApps: string[]; allowedProcessIds?: number[] }
export interface RecordingEnd { mode: 'stop' | 'discard' | 'error'; reason: string; suppressedEventCount: number }
export interface RecordingCapabilities { supported: boolean; permissions?: { accessibility: boolean; inputMonitoring: boolean }; error?: string }
export async function recordingCapabilities(command: RecordingCommand | undefined, platform: NodeJS.Platform = process.platform): Promise<RecordingCapabilities> {
  if (platform !== 'darwin') return { supported: false, error: 'Record & Replay is macOS-only for now.' };
  if (!command) return { supported: false, error: 'recording-helper-unavailable' };
  try {
    const output = await new Promise<string>((resolve, reject) => execFile(command.executable, [...(command.args ?? []), '--capabilities'],
      { env: command.env ?? process.env, timeout: 5000, maxBuffer: 8192, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const value = row(JSON.parse(output)), permissions = row(value.permissions);
    if (value.version !== 1 || value.supported !== true || typeof permissions.accessibility !== 'boolean' || typeof permissions.inputMonitoring !== 'boolean') throw new Error('recording-capabilities-invalid');
    return { supported: true, permissions: { accessibility: permissions.accessibility, inputMonitoring: permissions.inputMonitoring } };
  } catch { return { supported: false, error: 'recording-helper-unavailable' }; }
}
export interface RecordingHelperOptions extends RecordingPolicy {
  command: RecordingCommand;
  recordingId: string;
  generation: number;
  maxDurationMs?: number;
  readyTimeoutMs?: number;
  onReady(): Promise<void>;
  onEvent(event: RecordingRow): Promise<void>;
}
function row(value: unknown): RecordingRow { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordingRow : {}; }
function failure(value: unknown): Error { return value instanceof Error ? value : new Error('recording-helper-failed'); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
export async function recordingDeadline(task: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([task.then(() => true, () => true), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(1, Math.min(60_000, milliseconds)));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One native capture per process. Disk writes finish before acknowledging each event. */
export class RecordingHelper {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  readonly completed: Promise<RecordingEnd>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly readiness = deferred<void>();
  private readonly ending = deferred<RecordingEnd>();
  private readonly policies = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly closed: Promise<void>;
  private readonly timer: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private closing = false;
  private readySeen = false;
  private terminal = false;
  private nextSequence = 1;
  private writes = 0;
  private writeTail = Promise.resolve();
  private broken?: Error;
  private stopping?: Promise<RecordingEnd>;
  private stderr = '';

  constructor(private readonly options: RecordingHelperOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.recordingId) || !Number.isSafeInteger(options.generation) || options.generation < 1) throw new Error('recording-helper-identity-invalid');
    this.ready = this.readiness.promise; this.completed = this.ending.promise;
    this.child = spawn(options.command.executable, options.command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: options.command.env ?? process.env });
    this.child.stdin.on('error', error => { this.broken ??= error; this.terminate(error); });
    // The native helper only emits bounded diagnostic codes on stderr, never event data.
    this.child.stderr.on('data', value => { if (this.stderr.length < 512) this.stderr += String(value).slice(0, 512 - this.stderr.length); });
    this.closed = new Promise(resolve => {
      this.child.once('error', error => { this.broken = error; this.readiness.reject(error); this.ending.reject(error); });
      this.child.once('close', (code, signal) => {
        if (code !== 0 || signal) this.broken ??= new Error(this.stderr.trim() || 'recording-helper-exit-failed');
        if (this.killTimer) clearTimeout(this.killTimer); resolve();
      });
    });
    this.timer = setTimeout(() => this.terminate(new Error('recording-helper-ready-timeout')), options.readyTimeoutMs ?? 10_000);
    this.done = this.read().catch(error => this.terminate(failure(error))).finally(async () => {
      clearTimeout(this.timer);
      if (!this.terminal && !this.closing) this.terminate(new Error(this.stderr.trim() || 'recording-helper-exited-before-end'));
      await this.closed; await this.writeTail;
      const error = this.broken ?? new Error('recording-helper-closed');
      this.readiness.reject(error);
      if (!this.terminal) this.ending.reject(error);
      for (const pending of this.policies.values()) pending.reject(error);
      this.policies.clear(); this.closing = true;
      if (this.broken) throw this.broken;
    });
    void this.done.catch(() => {});
    void this.write({ type: 'start', blockedApps: options.blockedApps, allowedProcessIds: options.allowedProcessIds ?? [],
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }) }).catch(error => this.terminate(failure(error)));
  }
  get pid(): number | undefined { return this.child.pid; }
  private async read(): Promise<void> {
    let pending = Buffer.alloc(0);
    for await (const value of this.child.stdout) {
      if (this.closing) return;
      const chunk = Buffer.from(value as Uint8Array);
      if (pending.length + chunk.length > 2 * 64 * 1024 + 2) throw new Error('recording-helper-frame-limit');
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10); if (newline < 0) break;
        if (newline > 64 * 1024) throw new Error('recording-helper-frame-limit');
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        const frame = row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
        if (this.terminal || frame.recordingId !== this.options.recordingId || frame.generation !== this.options.generation || frame.seq !== this.nextSequence++) throw new Error('recording-helper-sequence-invalid');
        if (frame.type === 'ready') {
          if (this.readySeen) throw new Error('recording-helper-ready-duplicate');
          this.readySeen = true; await this.options.onReady();
          if (this.closing) return;
          clearTimeout(this.timer); this.readiness.resolve();
        } else if (frame.type === 'event') {
          const event = row(frame.event);
          if (!this.readySeen || typeof event.type !== 'string' || !Number.isSafeInteger(event.ts) || Number(event.ts) < 0) throw new Error('recording-helper-event-invalid');
          await this.options.onEvent(event);
          if (this.closing) return;
        } else if (frame.type === 'policy') {
          const identifier = String(frame.operationId ?? ''), request = this.policies.get(identifier);
          if (!request || !this.readySeen) throw new Error('recording-helper-policy-invalid');
          this.policies.delete(identifier); request.resolve();
        } else if (frame.type === 'ended') {
          if (!['stop', 'discard', 'error'].includes(String(frame.mode)) || typeof frame.reason !== 'string'
            || !Number.isSafeInteger(frame.suppressedEventCount) || Number(frame.suppressedEventCount) < 0 || !this.readySeen && frame.mode !== 'error') throw new Error('recording-helper-end-invalid');
          this.terminal = true; clearTimeout(this.timer);
          this.killTimer = setTimeout(() => this.terminate(new Error('recording-helper-exit-timeout')), 5000);
          const end = { mode: frame.mode, reason: frame.reason, suppressedEventCount: frame.suppressedEventCount } as RecordingEnd;
          if (!this.readySeen) this.readiness.reject(new Error(end.reason));
          this.ending.resolve(end);
        } else throw new Error('recording-helper-message-invalid');
        await this.write({ type: 'ack', seq: frame.seq });
      }
      if (pending.length > 64 * 1024) throw new Error('recording-helper-frame-limit');
    }
    if (pending.length) throw new Error('recording-helper-truncated-event');
  }
  private write(command: RecordingRow): Promise<void> {
    if (this.closing || this.broken) return Promise.reject(this.broken ?? new Error('recording-helper-closed'));
    const data = Buffer.from(JSON.stringify({ ...command, recordingId: this.options.recordingId, generation: this.options.generation }) + '\n');
    if (data.length > 64 * 1024 || this.writes >= 8) return Promise.reject(new Error('recording-helper-command-limit'));
    this.writes++;
    const task = this.writeTail.then(async () => {
      if (this.closing || this.broken) throw this.broken ?? new Error('recording-helper-closed');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.terminate(new Error('recording-helper-write-timeout')), 5000);
        this.child.stdin.write(data, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
      });
    }).finally(() => { this.writes--; });
    this.writeTail = task.catch(error => { this.broken ??= failure(error); }); return task;
  }
  stop(mode: 'stop' | 'discard', reason: string): Promise<RecordingEnd> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.terminal) await this.write({ type: 'stop', mode, reason });
      const end = await this.completed; await this.done; return end;
    })();
    return this.stopping;
  }
  async updatePolicy(policy: RecordingPolicy): Promise<void> {
    if (this.closing || this.terminal || !this.readySeen || this.policies.size >= 4) throw new Error('recording-policy-unavailable');
    const id = randomUUID(), request = deferred<void>(); this.policies.set(id, request);
    try {
      await this.write({ type: 'policy', operationId: id, blockedApps: policy.blockedApps, allowedProcessIds: policy.allowedProcessIds });
      if (!await recordingDeadline(request.promise, 5000)) { this.terminate(new Error('recording-policy-timeout')); throw new Error('recording-policy-timeout'); }
      await request.promise;
    } finally { this.policies.delete(id); }
  }
  private terminate(error: Error): void {
    this.broken ??= error; this.readiness.reject(this.broken); this.ending.reject(this.broken);
    if (this.closing) return;
    this.closing = true; clearTimeout(this.timer); if (this.killTimer) clearTimeout(this.killTimer); this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000); this.killTimer.unref();
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.terminate(new Error('recording-helper-cancelled'));
    return { complete: await recordingDeadline(this.done, deadlineMs) };
  }
}
