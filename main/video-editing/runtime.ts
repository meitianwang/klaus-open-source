import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { message, record, type Data } from '../visuals/data';

interface Pending { resolve(value: Data): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** The desktop owns the complete media runtime's lifetime; it is not a second agent. */
export class VideoEditingRuntime {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped = false;
  constructor(private readonly pluginRoot: string, readonly data: string) {}
  private start(): void {
    if (this.process) return;
    if (this.stopped) throw new Error('The video runtime has closed.');
    mkdirSync(this.data, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [join(this.pluginRoot, 'runtime', 'host', 'worker.mjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIDEO_EDITING_DATA: this.data },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.process = child;
    child.stderr.on('data', bytes => appendFileSync(join(this.data, 'runtime.log'), bytes));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let packet: Data;
      try { packet = record(JSON.parse(line)); } catch { return; }
      const id = Number(packet.id), request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id); clearTimeout(request.timer);
      if (packet.error) request.reject(new Error(typeof packet.error === 'string' ? packet.error : String(record(packet.error).message ?? 'Video runtime request failed.')));
      else request.resolve(Array.isArray(packet.result) ? { jobs: packet.result } : record(packet.result));
    });
    const ended = (error: Error) => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      if (this.process === child) this.process = undefined;
    };
    child.once('error', error => ended(error));
    child.once('exit', (code, signal) => ended(new Error(`The video runtime stopped (${code ?? signal}). Its project files were preserved.`)));
  }
  request(method: string, params: Data = {}, timeoutMs = 120_000): Promise<Data> {
    this.start();
    const child = this.process!, id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The video runtime did not finish ${method}. Inspect its job state before retrying a write.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        this.pending.delete(id); clearTimeout(timer); reject(new Error(message(error)));
      });
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    const child = this.process;
    if (!child) { this.stopped = true; return; }
    await this.request('close', {}, 30_000);
    this.stopped = true;
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); reject(new Error('The video runtime did not finish shutting down.')); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
