import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deadline, string } from './types';
import type { ComputerUseHelperCommand } from '../../native/computer-use';

export interface LockedUseWatchDependencies {
  command?: ComputerUseHelperCommand;
  available(): boolean;
  log(message: string): void;
  /**
   * Physical input arrived while the watch was armed. The native side already
   * re-locked (or tried to); `relocked` reports whether the lock was verified.
   */
  onPhysicalInput(sessionId: string, turnId: string, relocked: boolean): void;
  /** The idle fallback fired; the attributed session's in-use surface should hide. */
  onIdleStop?(sessionId: string): void;
}
const STARTED_MARKER = 'klaus-locked-use-watch-started';
/** Fallback stop when a turn-end event never arrives. */
const IDLE_STOP_MS = 15 * 60 * 1000;

interface Active {
  sessionId: string; turnId: string; child: ChildProcessWithoutNullStreams;
  settled: boolean; started: boolean; idle?: NodeJS.Timeout; startTimer?: NodeJS.Timeout;
  finished: Promise<void>;
}

/**
 * One host-owned watcher child guards a screen this helper family unlocked
 * itself: any physical (unmarked) keyboard or mouse input makes the native side
 * re-lock immediately and report one framed event, and the host then pauses the
 * attributed turn. The watch is armed only after an action actually auto-unlocked
 * the screen, so an ordinary session never runs it. Best-effort by design: a
 * missing permission or a refused tap degrades to "no re-lock monitor" with a log
 * line and never blocks ordinary computer-use work. Attribution is read at
 * delivery time, so the report pauses the turn that is in flight now.
 */
export class ComputerUseLockedUseWatcher {
  private active?: Active;
  private closing = false;
  constructor(private readonly deps: LockedUseWatchDependencies) {}

  get watching(): boolean {
    const active = this.active;
    return !!active && !active.settled;
  }

  /** Start, re-attribute or touch the watch for one session turn. Never throws. */
  ensure(sessionId: string, turnId: string): void {
    try { string(sessionId, 'sessionId'); string(turnId, 'turnId'); } catch { return; }
    if (this.closing) return;
    const active = this.active;
    if (active && !active.settled) { active.sessionId = sessionId; active.turnId = turnId; this.armIdle(active); return; }
    const command = this.deps.command;
    if (!this.deps.available() || !command) return;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command.executable, command.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: command.env ?? process.env }); }
    catch (error) { this.deps.log(`locked-use watcher failed to spawn: ${String(error)}`); return; }
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const current: Active = { sessionId, turnId, child, settled: false, started: false, finished };
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
        if (line) this.frame(current, line);
      }
    });
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep draining so a chatty child never blocks on a full stderr pipe, and
      // retain a bounded tail because the started marker can straddle chunks.
      if (stderrTail.length < 64 * 1024) stderrTail += String(chunk);
      if (!current.started && stderrTail.includes(STARTED_MARKER)) {
        current.started = true;
        if (current.startTimer) { clearTimeout(current.startTimer); current.startTimer = undefined; }
      }
    });
    child.once('error', () => { /* close settles the watcher */ });
    child.once('close', () => {
      current.settled = true;
      if (current.idle) clearTimeout(current.idle);
      if (current.startTimer) clearTimeout(current.startTimer);
      if (this.active === current) this.active = undefined;
      resolveFinished();
    });
    // A watcher that cannot arm must degrade to no-watch, not strand a child.
    current.startTimer = setTimeout(() => {
      if (!current.started && !current.settled) { this.deps.log('locked-use watcher did not arm in time'); child.kill('SIGKILL'); }
    }, 10_000);
    current.startTimer.unref?.();
    child.stdin.on('error', () => { /* a broken pipe settles through close */ });
    child.stdin.write(JSON.stringify({ resourceId: randomUUID(), operationId: randomUUID(), generation: 1, sequence: 1,
      method: 'watchLockedUse', args: {} }) + '\n');
    this.armIdle(current);
  }

  /** Graceful framed stop; the child is killed when it does not settle. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.idle) { clearTimeout(active.idle); active.idle = undefined; }
    if (active.settled) { if (this.active === active) this.active = undefined; return; }
    if (active.child.stdin.writable) active.child.stdin.write('{"stop":true}\n');
    const settled = await deadline(active.finished, 5000);
    if (!settled) active.child.kill('SIGKILL');
    if (this.active === active) this.active = undefined;
  }

  /** Stop only when the watch belongs to this session; reports whether it did. */
  stopFor(sessionId: string): boolean {
    const active = this.active;
    if (!active || active.settled || active.sessionId !== sessionId) return false;
    void this.stop();
    return true;
  }

  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    await this.stop();
    const active = this.active;
    return { complete: !active || active.settled || deadlineMs <= 0 };
  }

  private armIdle(active: Active): void {
    if (active.idle) clearTimeout(active.idle);
    active.idle = setTimeout(() => {
      this.deps.log('locked-use watcher idle stop');
      this.deps.onIdleStop?.(active.sessionId);
      void this.stop();
    }, IDLE_STOP_MS);
    active.idle.unref?.();
  }

  private frame(active: Active, line: string): void {
    let frame: { event?: unknown; reason?: unknown; relocked?: unknown };
    try {
      const value: unknown = JSON.parse(line);
      frame = value && typeof value === 'object' && !Array.isArray(value) ? value as { event?: unknown; reason?: unknown; relocked?: unknown } : {};
    } catch { this.deps.log(`locked-use watcher sent a malformed frame: ${line.slice(0, 200)}`); return; }
    const reason = typeof frame.reason === 'string' && frame.reason ? `: ${frame.reason.slice(0, 512)}` : '';
    switch (frame.event) {
      case 'physicalInput':
        // A missing or non-true flag never claims the re-lock succeeded; the
        // host wording then asks the person to lock the machine manually.
        if (this.active === active && !active.settled) this.deps.onPhysicalInput(active.sessionId, active.turnId, frame.relocked === true);
        break;
      case 'tapDisabled':
        this.deps.log(`locked-use watch input tap was re-armed${reason}`);
        break;
      case 'unavailable':
        // The helper exits by itself; close settles the watcher and the turn
        // continues without a re-lock monitor.
        this.deps.log(`locked-use watch is unavailable${reason}`);
        break;
      case 'stopped':
        break;
      default:
        this.deps.log(`locked-use watcher sent an unknown frame: ${String(frame.event).slice(0, 64)}`);
    }
  }
}
