import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RecordingRow } from './helper';

export interface RecordingState {
  id: string; sessionId: string; generation: number; pid: number; hostPid: number;
  state: 'starting' | 'recording' | 'ended' | 'discarded' | 'failed';
  startedAt: number; eventsPath: string; eventCount: number; suppressedEventCount: number;
  endedAt?: number; endReason?: string; error?: string;
}
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const alive = (value: unknown): boolean => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return false;
  try { process.kill(Number(value), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
async function readObject(path: string): Promise<RecordingRow | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('recording-state-invalid');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recording-state-invalid');
    return value as RecordingRow;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}

/** The app must hold its single-instance profile lease before constructing this store. */
export class RecordingStore {
  private root?: string;
  private directory?: string;
  private file?: FileHandle;
  private bytes = 0;
  constructor(readonly requestedRoot: string) {
    if (!isAbsolute(requestedRoot)) throw new Error('recordings-root-must-be-absolute');
  }
  private async initialize(): Promise<string> {
    if (this.root) return this.root;
    await mkdir(this.requestedRoot, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.requestedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('recordings-root-invalid');
    return this.root = await realpath(this.requestedRoot);
  }
  private async writeObject(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, 'wx', 0o600); await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync(); await file.close(); file = undefined;
      await rename(temporary, path);
      // Both platforms used for recording support directory fsync (recording is macOS-only).
      if (process.platform !== 'win32') {
        const parent = await open(dirname(path), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await file?.close(); await rm(temporary, { force: true }); }
  }
  async previous(): Promise<RecordingRow | null> {
    const root = await this.initialize(), value = await readObject(join(root, 'active.json'));
    if (value && (!safeId(value.id) || value.eventsPath !== join(root, value.id, 'events.jsonl')
      && value.eventsPath !== join(resolve(this.requestedRoot), value.id, 'events.jsonl'))) throw new Error('recording-active-path-invalid');
    return value;
  }
  async previousForSession(sessionId: string): Promise<RecordingState | undefined> {
    const value = await this.previous();
    if (!value || value.sessionId !== sessionId) return undefined;
    if (!['starting', 'recording', 'ended', 'discarded', 'failed'].includes(String(value.state))
      || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.eventCount)
      || !Number.isSafeInteger(value.suppressedEventCount)) throw new Error('recording-state-invalid');
    const state = value as unknown as RecordingState;
    if ((state.state === 'recording' || state.state === 'starting') && !alive(state.hostPid) && !alive(state.pid)) {
      return { ...state, state: 'failed', error: 'recording-interrupted', endReason: 'owner-exited' };
    }
    return { ...state };
  }
  async create(state: Omit<RecordingState, 'eventsPath'>): Promise<RecordingState> {
    const root = await this.initialize(), previous = await this.previous();
    if (previous && (previous.state === 'recording' || previous.state === 'starting')) {
      if (alive(previous.hostPid) || alive(previous.pid)) throw new Error('recording-owned-by-live-process');
      // Preserve an interrupted prefix. Never label a crashed recording successfully ended.
      await this.writeObject(join(root, 'active.json'), { ...previous, state: 'failed', endedAt: Date.now(), endReason: 'owner-exited', error: 'recording-interrupted' });
    }
    if (!safeId(state.id)) throw new Error('recording-id-invalid');
    this.directory = join(root, state.id);
    await mkdir(this.directory, { mode: 0o700 });
    const value = { ...state, eventsPath: join(this.directory, 'events.jsonl') };
    this.file = await open(value.eventsPath, 'wx', 0o600); this.bytes = 0;
    await this.persist(value); return value;
  }
  async persist(state: RecordingState): Promise<void> {
    if (!this.root || this.directory !== join(this.root, state.id) || state.eventsPath !== join(this.directory, 'events.jsonl')) throw new Error('recording-store-identity-invalid');
    if (await realpath(this.directory) !== this.directory || await realpath(this.root) !== this.root) throw new Error('recording-directory-changed');
    await this.writeObject(join(this.directory, 'metadata.json'), state);
    await this.writeObject(join(this.root, 'active.json'), state);
  }
  async append(event: RecordingRow): Promise<void> {
    if (!this.file) throw new Error('recording-file-closed');
    const data = Buffer.from(JSON.stringify(event) + '\n');
    if (data.length > 64 * 1024 || this.bytes + data.length > 32 * 1024 * 1024) throw new Error('recording-file-limit');
    await this.file.writeFile(data); this.bytes += data.length;
  }
  async control(): Promise<'stop' | 'discard' | null> {
    if (!this.directory) return null;
    const path = join(this.directory, 'control.json'), value = await readObject(path);
    if (!value) return null;
    if (value.action !== 'stop' && value.action !== 'discard') throw new Error('recording-control-invalid');
    await unlink(path); return value.action;
  }
  async flush(): Promise<void> {
    const file = this.file; this.file = undefined;
    if (file) { try { await file.sync(); } finally { await file.close(); } }
  }
  async discard(state: RecordingState): Promise<void> {
    if (this.file || !this.directory || !this.root || this.directory !== join(this.root, state.id)) throw new Error('recording-discard-not-drained');
    if ((await lstat(this.directory)).isSymbolicLink() || await realpath(this.directory) !== resolve(this.directory)) throw new Error('recording-directory-changed');
    await rm(this.directory, { recursive: true });
    await this.writeObject(join(this.root, 'active.json'), state);
  }
}
