// Crash-safe ledger of sessions that had an unsettled turn.
//
// The engine persists everything a recovery needs (durable queue, background
// process records, subagent lifecycle) inside the thread rollout, and resuming
// the thread restores all of it. What the engine deliberately does NOT do is
// restart work on its own: a resumed rollout marks nonterminal background
// processes and subagents `interrupted`, and a queued continuation waits for
// the host to ask. Restarting the app therefore loses the "this was running"
// bit — HostState is per-process by design.
//
// This ledger keeps exactly that bit on disk. While a session has a running
// turn its renderer id is recorded; when the turn settles it is removed. On the
// next startup the host reads the file, re-opens each recorded thread (the
// implicit-resume history read) and continues the unsettled tail turn, which
// walks the engine's durable queue forward — background processes and subagents
// are rebuilt by the recovered turn through its normal tool flow.
//
// New turns write immediately; removals are debounced and flushed on shutdown.
// Recovery keeps the previous run's ids separate so a new turn cannot overwrite unfinished
// recovery; only confirmed continuations and settled turns remove their ids.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;
const FILE_NAME = 'resume-ledger.json';
/** A non-paginated active catalog is bounded by real usage, but cap the file. */
const MAX_IDS = 200;

export interface ResumeLedgerSnapshot { version: typeof SCHEMA_VERSION; sessionIds: string[] }

export class ResumeLedger {
  private readonly pending = new Set<string>();
  private readonly recoveryPending = new Set<string>();
  private write?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private initialized = false;
  private recoveryStarted = false;
  private frozen = false;
  private startupIds: string[] = [];

  constructor(private readonly filePath: string, private readonly log: (message: string) => void = () => {}) {}

  static path(configRoot: string): string {
    return join(configRoot, 'electron', FILE_NAME);
  }

  /** Capture the previous run before this process starts writing its own turns. */
  async initialize(): Promise<string[]> {
    if (!this.initialized) {
      this.startupIds = await this.load();
      for (const id of this.startupIds) this.recoveryPending.add(id);
      this.initialized = true;
    }
    return [...this.startupIds];
  }

  /** Hand the startup snapshot to recovery only once. */
  async takeStartupIds(): Promise<string[]> {
    await this.initialize();
    if (this.recoveryStarted) return [];
    this.recoveryStarted = true;
    return [...this.startupIds];
  }

  /** Replace only the current process's running turns; unresolved old turns remain. */
  set(sessionIds: Iterable<string>): void {
    if (this.frozen) return;
    const next = [...new Set(sessionIds)].filter(id => id.length > 0).sort().slice(0, MAX_IDS);
    const current = [...this.pending];
    if (next.length === current.length && next.every((id, index) => current[index] === id)) return;
    const started = next.some(id => !this.pending.has(id) && !this.recoveryPending.has(id));
    this.pending.clear();
    for (const id of next) this.pending.add(id);
    if (started) void this.flush();
    else this.schedule();
  }

  /** Remove a previous turn only after it is continued or proven settled. */
  async completeRecovery(sessionId: string): Promise<void> {
    if (!this.recoveryPending.delete(sessionId)) return;
    await this.flush();
  }

  /** Best-effort read of the previous run's tracked sessions. */
  async load(): Promise<string[]> {
    try {
      const bytes = await readFile(this.filePath, 'utf8');
      const value = JSON.parse(bytes) as ResumeLedgerSnapshot;
      const ids = Array.isArray(value?.sessionIds) ? value.sessionIds : [];
      return [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))].slice(0, MAX_IDS);
    } catch {
      return [];
    }
  }

  /**
   * Preserve the ledger for the next process instead of recording the shutdown.
   *
   * Update and restart shutdowns interrupt live turns before the engine exits.
   * Those interruptions are host initiated, so treating them as settled would
   * erase the very sessions startup recovery is meant to continue. Flush the
   * last running-turn snapshot first, then ignore every later change.
   */
  async freeze(): Promise<void> {
    if (this.frozen) return;
    await this.flush();
    this.frozen = true;
  }

  /** Synchronous-ish flush: the pending state is on disk when this resolves. */
  flush(): Promise<void> {
    if (this.frozen) return Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.write = (this.write ?? Promise.resolve()).then(() => this.writeNow());
    return this.write;
  }

  private schedule(): void {
    if (this.timer) return;
    // Terminal flags can be chatty; defer removals while new turns write immediately.
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1_000);
    this.timer.unref();
  }

  private async writeNow(): Promise<void> {
    const ids = [...this.pending].sort();
    for (const id of [...this.recoveryPending].sort()) {
      if (ids.length >= MAX_IDS) break;
      if (!this.pending.has(id)) ids.push(id);
    }
    try {
      if (ids.length === 0) { await rm(this.filePath, { force: true }); return; }
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      const payload = JSON.stringify({ version: SCHEMA_VERSION, sessionIds: ids } satisfies ResumeLedgerSnapshot);
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.filePath);
    } catch (error) {
      this.log(`resume-ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Track a running-turn set on a host state that exposes isWorking over ids. */
export function collectRunningSessionIds(state: { isWorking(id: string): boolean }, ids: Iterable<string>): string[] {
  return [...ids].filter(id => state.isWorking(id));
}
