import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface MacOsCommand {
  resourceId: string; operationId: string; generation: number; sequence: number;
  executable: string; args: string[]; stdin?: string; timeoutMs?: number;
}
export interface MacOsCommands {
  available(executables: readonly string[]): Promise<boolean>;
  run(request: MacOsCommand, signal: AbortSignal): Promise<string>;
  close(deadlineMs?: number): Promise<{ complete: boolean }>;
}
type Launch = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface Operation { done: Promise<void>; cancel(): void }
const commands = new Set(['/usr/bin/osascript', '/usr/bin/open', '/usr/bin/xattr', '/usr/bin/plutil', '/usr/bin/shortcuts',
  '/usr/bin/pbpaste', '/usr/bin/pbcopy', '/usr/bin/mdfind', '/usr/sbin/screencapture', '/usr/bin/sqlite3']);
const maxBuffer = 8 * 1024 * 1024, maxInput = 1024 * 1024;
const failure = (error: unknown): Error => error instanceof Error ? error : new Error('The macOS command failed');

/** Only trusted main-process modules construct requests; no shell or renderer command endpoint exists. */
export class MacOsCommandRunner implements MacOsCommands {
  private readonly operations = new Map<string, Operation>();
  private closing = false;
  constructor(private readonly options: { platform?: NodeJS.Platform; launch?: Launch } = {}) {}
  async available(executables: readonly string[]): Promise<boolean> {
    if (this.closing || (this.options.platform ?? process.platform) !== 'darwin') return false;
    try { await Promise.all(executables.map(async file => {
      if (!commands.has(file)) throw new Error('Unsupported macOS command'); await access(file, constants.X_OK);
    })); return !this.closing; } catch { return false; }
  }
  async run(request: MacOsCommand, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.closing) throw new Error('The macOS command runner is closed');
    if ((this.options.platform ?? process.platform) !== 'darwin') throw new Error('This connector requires macOS');
    if (!commands.has(request.executable)) throw new Error('Unsupported macOS command');
    if (![request.resourceId, request.operationId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
      || ![request.generation, request.sequence].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid macOS command identity');
    const key = request.resourceId + ':' + request.operationId;
    if (this.operations.has(key) || this.operations.size >= 32) throw new Error('The macOS command capacity is exhausted');
    const timeoutMs = request.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error('Invalid macOS command timeout');
    if (!Array.isArray(request.args) || request.args.length > 128 || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || Buffer.byteLength(request.args.join('')) > maxInput || (request.stdin !== undefined && (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin) > maxInput))) throw new Error('The macOS command input exceeds its limit');
    let finish!: () => void, cancel: () => void = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const operation: Operation = { done, cancel: () => cancel() };
    this.operations.set(key, operation);
    try {
      return await new Promise<string>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = (this.options.launch ?? spawn)(request.executable, request.args, { detached: true, stdio: 'pipe', shell: false, windowsHide: true }); }
        catch (error) { reject(failure(error)); return; }
        const output: Buffer[] = [], diagnostics: Buffer[] = [];
        let outBytes = 0, errBytes = 0, ended = false, reason: Error | undefined;
        let killTimer: NodeJS.Timeout | undefined, pipeTimer: NodeJS.Timeout | undefined;
        const kill = (kind: NodeJS.Signals) => {
          if (!child.pid) return;
          try { process.kill(-child.pid, kind); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              reason ??= new Error('Could not stop the macOS command process group');
              try { child.kill(kind); } catch { /* The close event remains authoritative. */ }
            }
          }
        };
        const stop = (error: Error) => {
          reason ??= error;
          if (ended || killTimer) return;
          child.stdin.destroy(); kill('SIGTERM');
          killTimer = setTimeout(() => {
            killTimer = undefined;
            kill('SIGKILL');
            // XPC services may inherit a pipe after the direct child exits.
            // Closing our pipe endpoints prevents a stale service from retaining callbacks.
            if (child.exitCode !== null || child.signalCode !== null) { child.stdout.destroy(); child.stderr.destroy(); }
          }, 500);
        };
        cancel = () => stop(new Error('The macOS command was cancelled; its effects may already have occurred'));
        const onAbort = () => cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => stop(new Error('The macOS command timed out; its effects may already have occurred')), timeoutMs);
        const collect = (stream: 'stdout' | 'stderr', data: Buffer) => {
          if (stream === 'stdout') outBytes += data.length; else errBytes += data.length;
          if ((stream === 'stdout' ? outBytes : errBytes) > maxBuffer) { stop(new Error(stream + ' maxBuffer length exceeded')); return; }
          (stream === 'stdout' ? output : diagnostics).push(data);
        };
        child.stdout.on('data', data => collect('stdout', Buffer.from(data)));
        child.stderr.on('data', data => collect('stderr', Buffer.from(data)));
        child.stdout.on('error', error => stop(failure(error)));
        child.stderr.on('error', error => stop(failure(error)));
        child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(failure(error)); });
        child.once('error', error => { reason ??= failure(error); });
        child.once('exit', code => {
          pipeTimer = setTimeout(() => stop(reason ?? new Error(code !== 0
            ? Buffer.concat(diagnostics).toString('utf8').trim() || 'Command failed: ' + request.executable
            : 'The macOS command exited without closing its output streams')), 250);
        });
        child.once('close', code => {
          ended = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(pipeTimer); signal.removeEventListener('abort', onAbort);
          if (reason) reject(reason);
          else if (code !== 0) reject(new Error(Buffer.concat(diagnostics).toString('utf8').trim() || 'Command failed: ' + request.executable));
          else resolve(Buffer.concat(output).toString('utf8'));
        });
        if (signal.aborted || this.closing) cancel();
        else child.stdin.end(request.stdin ?? '');
      });
    } finally { this.operations.delete(key); finish(); }
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 60_000) throw new Error('Invalid macOS command close deadline');
    this.closing = true;
    for (const operation of this.operations.values()) operation.cancel();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.all([...this.operations.values()].map(operation => operation.done)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); })]); }
    finally { clearTimeout(timer); }
    return { complete: this.operations.size === 0 };
  }
}
