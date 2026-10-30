import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Measure host stalls independently of RPC response time, without recording user content. */
export function monitorHostResponsiveness(log: Pick<DesktopLog, 'write'>, intervalMs = 10_000, thresholdMs = 250): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let cpu = process.cpuUsage(), sampledAt = performance.now();
  delay.enable();
  const timer = setInterval(() => {
    const elapsedMs = performance.now() - sampledAt;
    const maxDelayMs = Math.max(delay.max / 1e6, elapsedMs - intervalMs);
    const usage = process.cpuUsage(cpu);
    cpu = process.cpuUsage(); sampledAt = performance.now();
    if (maxDelayMs >= thresholdMs) {
      try { log.write('host-responsiveness', JSON.stringify({ maxDelayMs, meanDelayMs: delay.mean / 1e6,
        elapsedMs, cpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss })); }
      catch { /* Diagnostics cannot stall normal work. */ }
    }
    delay.reset();
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); delay.disable(); };
}

export interface DesktopLogOptions {
  maxSegmentBytes?: number;
  maxSegments?: number;
  maxBufferedBytes?: number;
  highWaterMarkBytes?: number;
}

/** Bounded asynchronous logging with runtime segment rotation and backpressure. */
export class DesktopLog {
  private stream: WriteStream;
  private readonly path: string;
  private readonly options: Required<DesktopLogOptions>;
  private pending: Array<{ text: string; bytes: number }> = [];
  private pendingBytes = 0;
  private writtenBytes: number;
  private dropped = 0;
  private draining = false;
  private rotating = false;
  private failed = false;
  private closing = false;
  private closed?: Promise<void>;
  private finishClose?: () => void;

  constructor(configRoot: string, filename: 'electron-host.log' | 'cursor-diagnostics.log' = 'electron-host.log', options: DesktopLogOptions = {}) {
    this.options = { maxSegmentBytes: 10 * 1024 * 1024, maxSegments: 5, maxBufferedBytes: 256 * 1024,
      highWaterMarkBytes: 64 * 1024, ...options };
    if (Object.values(this.options).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid diagnostic log budget');
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    this.path = join(configRoot, filename);
    this.writtenBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (this.writtenBytes > this.options.maxSegmentBytes) {
      rmSync(this.segment(this.options.maxSegments - 1), { force: true });
      for (let index = this.options.maxSegments - 1; index > 0; index--) {
        try { renameSync(this.segment(index - 1), this.segment(index)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.writtenBytes = 0;
    }
    this.stream = this.openStream();
  }

  private segment(index: number): string {
    return index === 0 ? this.path : `${this.path}.previous${index === 1 ? '' : `.${index}`}`;
  }

  private openStream(): WriteStream {
    const stream = createWriteStream(this.path, { flags: 'a', mode: 0o600, highWaterMark: this.options.highWaterMarkBytes });
    stream.on('error', error => this.fail(error));
    return stream;
  }

  private fail(error: Error): void {
    if (!this.failed) console.error(`[desktop] diagnostic log: ${error.message}`);
    this.failed = true;
    this.pending = []; this.pendingBytes = 0; this.draining = false;
    this.completeClose();
  }

  write(kind: string, detail: string): void {
    if (this.failed || this.closing) return;
    if (this.pendingBytes + this.stream.writableLength > this.options.maxBufferedBytes) { this.dropped++; return; }
    const text = `${JSON.stringify({ at: new Date().toISOString(), kind, detail, ...(this.dropped ? { dropped: this.dropped } : {}) })}\n`;
    this.dropped = 0;
    const bytes = Buffer.byteLength(text);
    this.pending.push({ text, bytes }); this.pendingBytes += bytes;
    this.flush();
  }

  private flush(): void {
    if (this.failed) { this.completeClose(); return; }
    if (this.draining || this.rotating) return;
    while (this.pending.length) {
      const row = this.pending[0]!;
      if (this.writtenBytes > 0 && this.writtenBytes + row.bytes > this.options.maxSegmentBytes) {
        this.rotating = true;
        void this.rotate().then(() => { this.rotating = false; this.flush(); }, error => {
          this.rotating = false; this.fail(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      this.pending.shift(); this.pendingBytes -= row.bytes;
      this.writtenBytes += row.bytes;
      if (!this.stream.write(row.text)) {
        this.draining = true;
        this.stream.once('drain', () => { this.draining = false; this.flush(); });
        return;
      }
    }
    this.completeClose();
  }

  private endStream(stream: WriteStream): Promise<void> {
    if (stream.closed) return Promise.resolve();
    return new Promise(resolve => {
      stream.once('close', resolve);
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    });
  }

  private async rotate(): Promise<void> {
    await this.endStream(this.stream);
    if (this.failed) return;
    await rm(this.segment(this.options.maxSegments - 1), { force: true });
    for (let index = this.options.maxSegments - 1; index > 0; index--) {
      try { await rename(this.segment(index - 1), this.segment(index)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.writtenBytes = 0;
    this.stream = this.openStream();
  }

  private completeClose(): void {
    if (!this.closing || this.rotating || this.draining || this.pending.length) return;
    void this.endStream(this.stream).then(() => this.finishClose?.());
  }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = new Promise(resolve => { this.finishClose = resolve; });
    this.flush();
    return this.closed;
  }
}
