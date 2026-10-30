import { spawn, type ChildProcess } from 'node:child_process';
import { IpcHandlerError } from '../ipc/registry';

export interface GitResult { code: number; stdout: string; stderr: string; truncated: boolean; stdoutBytes?: Buffer }
export interface GitProcessOptions { executable?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
interface PendingGit { child: ChildProcess; stop(message: string): void; done: Promise<GitResult> }

/** Bounded one-shot git commands. No shell command text or engine ownership. */
export class GitProcess {
  private closed = false;
  private readonly pending = new Set<PendingGit>();
  constructor(private readonly options: GitProcessOptions = {}) {}
  run(cwd: string, args: string[], options: { maxBytes?: number; timeoutMs?: number; stdin?: Buffer | string; rawStdout?: boolean } = {}): Promise<GitResult> {
    if (this.closed) return Promise.reject(new IpcHandlerError('SERVICE_CLOSED', 'The git service is closed'));
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    // A launcher's repository-local variables must not redirect an explicit cwd.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
    const child = spawn(this.options.executable ?? 'git', ['--literal-pathspecs', '-c', 'color.ui=false', ...args], {
      cwd, env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const limit = options.maxBytes ?? 8 * 1024 * 1024;
    let reason = '', truncated = false, stdoutSize = 0, stderrSize = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, signal); } catch { /* It may already have exited. */ }
      }
    };
    const stop = (message: string) => {
      if (reason) return; reason = message; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500); killTimer.unref();
    };
    child.stdin?.on('error', error => {
      // A command that rejects its arguments can close stdin before its result.
      // Preserve that command's stderr and exit code instead of replacing them.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop('git stdin failed: ' + error.message);
    });
    const done = new Promise<GitResult>(resolve => {
      child.stdout?.on('data', (data: Buffer) => {
        const remaining = Math.max(0, limit - stdoutSize);
        if (remaining) stdout.push(data.subarray(0, remaining)); stdoutSize += data.length;
        if (stdoutSize > limit) { truncated = true; stop('git output exceeded its size limit'); }
      });
      child.stderr?.on('data', (data: Buffer) => {
        const remaining = Math.max(0, 32 * 1024 - stderrSize);
        if (remaining) stderr.push(data.subarray(0, remaining)); stderrSize += data.length;
      });
      child.on('error', error => { reason ||= error.message; });
      child.on('close', code => {
        if (deadline) clearTimeout(deadline);
        // Finish killing the command group even if git exits before its hook.
        if (reason) kill('SIGKILL');
        if (killTimer) clearTimeout(killTimer);
        const bytes = Buffer.concat(stdout);
        resolve({ code: reason ? -1 : code ?? -1, stdout: bytes.toString('utf8'), ...(options.rawStdout ? { stdoutBytes: bytes } : {}),
          stderr: reason || Buffer.concat(stderr).toString('utf8'), truncated });
      });
      deadline = setTimeout(() => stop('git command timed out'), options.timeoutMs ?? this.options.timeoutMs ?? 60_000);
      deadline.unref();
    });
    const pending = { child, stop, done }; this.pending.add(pending);
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    return done.finally(() => { this.pending.delete(pending); });
  }
  activeCount(): number { return this.pending.size; }
  async close(): Promise<void> {
    this.closed = true; const active = [...this.pending];
    active.forEach(item => item.stop('git command cancelled'));
    await Promise.all(active.map(item => item.done));
  }
}

export function gitError(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}
