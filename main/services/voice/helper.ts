import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Row } from './store';

export interface SpeechCommand { executable: string; args?: string[]; env?: NodeJS.ProcessEnv }
export interface HelperOptions {
  command: SpeechCommand;
  locale: string;
  hotwords: string[];
  onEvent(event: Row): Promise<void>;
  onFailure(code: string): Promise<void>;
  readyTimeoutMs?: number;
}

/** Raw PCM transport only. Ownership, learning and final-result policy stay in TS. */
export class SpeechHelper {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySeen = false;
  private terminal = false;
  private closing = false;
  private ended = false;
  private writeTail = Promise.resolve();
  private writes = 0;
  private bytes = 0;
  private nextAudioSeq = 1;
  private inputFailure: Error | undefined;
  private readonly closed: Promise<void>;
  private readonly readyTimer: NodeJS.Timeout;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HelperOptions) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    const args = [...(options.command.args ?? []), '--locale', options.locale, '--hotwords', JSON.stringify(options.hotwords), '--prefer-on-device'];
    this.child = spawn(options.command.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: options.command.env ?? process.env });
    this.child.stdin.on('error', error => { this.inputFailure = error; });
    // stderr is diagnostic only and must never block the recognizer or retain transcripts.
    this.child.stderr.resume();
    this.closed = new Promise(resolve => {
      this.child.once('error', error => { this.rejectReady(error); this.inputFailure = error; });
      this.child.once('close', () => { if (this.killTimer) clearTimeout(this.killTimer); resolve(); });
    });
    this.readyTimer = setTimeout(() => {
      this.rejectReady(new Error('speech-ready-timeout')); this.close();
    }, options.readyTimeoutMs ?? 65_000);
    this.done = this.read().catch(async error => {
      this.rejectReady(error instanceof Error ? error : new Error('speech-protocol-error'));
      if (!this.closing && !this.terminal) {
        this.terminal = true;
        await options.onFailure(error instanceof Error ? error.message : 'speech-protocol-error');
      }
    }).finally(async () => {
      try {
        clearTimeout(this.readyTimer);
        this.rejectReady(new Error('speech-helper-exited'));
        if (!this.closing && !this.terminal) { this.terminal = true; await options.onFailure('speech-helper-exited'); }
      } finally { this.close(); await this.closed; await this.writeTail; }
    });
    void this.done.catch(() => {});
  }
  private async read(): Promise<void> {
    let pending = Buffer.alloc(0);
    for await (const value of this.child.stdout) {
      if (this.closing) return;
      pending = Buffer.concat([pending, Buffer.from(value as Uint8Array)]);
      for (;;) {
        const index = pending.indexOf(10);
        if (index < 0) break;
        if (index > 64 * 1024) throw new Error('speech-event-too-large');
        const line = pending.subarray(0, index); pending = pending.subarray(index + 1);
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { throw new Error('speech-protocol-error'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('speech-protocol-error');
        const event = parsed as Row;
        if (event.type === 'ready') {
          if (this.readySeen || this.terminal) throw new Error('speech-protocol-error');
          this.readySeen = true; clearTimeout(this.readyTimer); this.resolveReady(); continue;
        }
        if (!['partial', 'final', 'error'].includes(String(event.type)) || this.terminal
          || event.type !== 'error' && (!this.readySeen || typeof event.text !== 'string')) throw new Error('speech-protocol-error');
        if (event.type === 'final' || event.type === 'error') this.terminal = true;
        await this.options.onEvent(event);
        if (this.closing) return;
      }
      if (pending.length > 64 * 1024) throw new Error('speech-event-too-large');
    }
    if (pending.length) throw new Error('speech-protocol-truncated');
  }
  /** Resolves only when Node has flushed this chunk into the helper's pipe. */
  audio(bytes: Uint8Array, seq?: number): Promise<void> {
    if (this.closing || this.ended || this.terminal || !this.readySeen) return Promise.reject(new Error('speech-session-closed'));
    if (!bytes.length || bytes.length > 32 * 1024 || bytes.length % 2) return Promise.reject(new Error('speech-audio-invalid'));
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq !== this.nextAudioSeq)) return Promise.reject(new Error('speech-audio-sequence'));
    if (this.writes >= 4 || this.bytes + bytes.length > 16_000 * 2 * 5 * 60) return Promise.reject(new Error('speech-audio-overflow'));
    this.nextAudioSeq += 1; this.writes += 1; this.bytes += bytes.length;
    const data = Buffer.from(bytes);
    const task = this.writeTail.then(async () => {
      if (this.closing || this.inputFailure) throw this.inputFailure ?? new Error('speech-session-closed');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.inputFailure = new Error('speech-write-timeout'); this.close(); }, 5000);
        this.child.stdin.write(data, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
      });
    }).finally(() => { this.writes -= 1; });
    this.writeTail = task.catch(error => { this.inputFailure = error instanceof Error ? error : new Error('speech-write-failed'); });
    return task;
  }
  async stop(): Promise<void> {
    if (this.ended) return;
    this.ended = true; await this.writeTail;
    if (this.inputFailure) throw this.inputFailure;
    if (this.closing) return;
    await new Promise<void>((resolve, reject) => this.child.stdin.end((error?: Error | null) => error ? reject(error) : resolve()));
  }
  close(): void {
    if (this.closing) return;
    this.closing = true; clearTimeout(this.readyTimer);
    this.rejectReady(new Error('speech-session-cancelled'));
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    this.killTimer.unref();
  }
}
