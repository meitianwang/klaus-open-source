import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ComputerUseHelperCommand } from '../../native/computer-use';
import { isComputerHistoryFrame, type ComputerHistoryFrame } from './types';

export const COMPUTER_HISTORY_STARTED_MARKER = 'klaus-history-watch-started';

export interface ComputerHistoryWatcherDeps {
  command?: ComputerUseHelperCommand;
  log(message: string): void;
  onFrame(frame: ComputerHistoryFrame): void;
  /** The watch child ended; `unexpected` is true when the host did not stop it. */
  onExit(unexpected: boolean): void;
  /** The native side armed its observation loop. */
  onStarted?(): void;
}

interface Active {
  child: ChildProcessWithoutNullStreams;
  settled: boolean;
  started: boolean;
  stopping: boolean;
  finished: Promise<void>;
  startTimer?: NodeJS.Timeout;
  arm: { promise: Promise<ComputerHistoryArmResult>; resolve: (value: ComputerHistoryArmResult) => void };
}

/** How the watch child settled its arming: live loop, degraded, or gone. */
export type ComputerHistoryArmResult = 'started' | 'unavailable' | 'exited';

/**
 * One long-lived native observation child. Frames arrive as JSON lines on
 * stdout; the stop request is a framed line on stdin, with a kill fallback.
 * Best-effort by design: a missing permission or refused spawn degrades to
 * "no observation" through frames and exit reports, never a thrown error.
 */
export class ComputerHistoryWatcher {
  private active?: Active;
  private closing = false;
  constructor(private readonly deps: ComputerHistoryWatcherDeps) {}

  get running(): boolean {
    const active = this.active;
    return !!active && !active.settled;
  }

  /** Spawn the observation child. Returns false when it cannot start at all. */
  start(): boolean {
    if (this.closing || this.active) return false;
    const command = this.deps.command;
    if (!command) return false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.executable, command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: command.env ?? process.env });
    } catch (error) {
      this.deps.log(`history watcher failed to spawn: ${String(error)}`);
      return false;
    }
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    let resolveArm!: (value: ComputerHistoryArmResult) => void;
    const armPromise = new Promise<ComputerHistoryArmResult>(resolve => { resolveArm = resolve; });
    const current: Active = { child, settled: false, started: false, stopping: false, finished, arm: { promise: armPromise, resolve: resolveArm } };
    this.active = current;
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.length > 256 * 1024) { stdout = ''; child.kill('SIGKILL'); return; }
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        try {
          const frame: unknown = JSON.parse(line);
          if (isComputerHistoryFrame(frame)) {
            this.deps.onFrame(frame);
            if (frame.event === 'unavailable') current.arm.resolve('unavailable');
          }
        } catch { /* a malformed frame line is dropped */ }
      }
    });
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep draining so a chatty child never blocks, and retain a bounded tail
      // because the started marker can straddle chunks.
      if (stderrTail.length < 64 * 1024) stderrTail += String(chunk);
      if (!current.started && stderrTail.includes(COMPUTER_HISTORY_STARTED_MARKER)) {
        current.started = true;
        if (current.startTimer) { clearTimeout(current.startTimer); current.startTimer = undefined; }
        this.deps.onStarted?.();
        current.arm.resolve('started');
      }
    });
    child.once('error', () => { /* close settles the watcher */ });
    child.once('close', () => {
      current.settled = true;
      if (current.startTimer) clearTimeout(current.startTimer);
      if (this.active === current) this.active = undefined;
      current.arm.resolve('exited');
      resolveFinished();
      this.deps.onExit(!current.stopping && !this.closing);
    });
    // A watcher that cannot arm must degrade, not strand a child.
    current.startTimer = setTimeout(() => {
      if (!current.started && !current.settled) { this.deps.log('history watcher did not arm in time'); child.kill('SIGKILL'); }
    }, 15_000);
    current.startTimer.unref?.();
    child.stdin.on('error', () => { /* a broken pipe settles through close */ });
    child.stdin.write(JSON.stringify({ resourceId: 'computer-history', operationId: randomUUID(), generation: 1, sequence: 1,
      method: 'watchHistory', args: {} }) + '\n');
    return true;
  }

  /** Wait for the current child to settle its arming; 'timeout' when it never does. */
  armResult(deadlineMs = 10_000): Promise<ComputerHistoryArmResult | 'timeout'> {
    const active = this.active;
    if (!active) return Promise.resolve('exited');
    return Promise.race([active.arm.promise,
      new Promise<'timeout'>(resolve => { const timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineMs)); timer.unref?.(); })]);
  }

  /** Graceful framed stop; the child is killed when it does not settle. */
  async stop(deadlineMs = 5000): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.settled) { if (this.active === active) this.active = undefined; return; }
    active.stopping = true;
    if (active.startTimer) { clearTimeout(active.startTimer); active.startTimer = undefined; }
    if (active.child.stdin.writable) active.child.stdin.write('{"stop":true}\n');
    const settled = await Promise.race([active.finished.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), Math.max(0, deadlineMs)).unref?.())]);
    if (!settled) active.child.kill('SIGKILL');
    await active.finished.catch(() => {});
    if (this.active === active) this.active = undefined;
  }

  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    await this.stop(deadlineMs);
    return { complete: !this.active };
  }
}
