import { SerialMutations } from '../service-types';
import type { WorkspaceStore } from '../workspaces';

/** Tracks scope resolution and queued writes before admission, through their final callbacks. */
export class DirectoryMutations {
  private readonly serial = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly workspaces: WorkspaceStore) {}
  run<T>(operation: () => Promise<T>, roots: () => Promise<string[]> = async () => [this.workspaces.configRoot]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Extension writes are closed'));
    let admit!: () => void, refuse!: (reason: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => { admit = resolve; refuse = reject; });
    void admission.catch(() => undefined);
    // Reserve mutation order synchronously, even if this operation resolves its scope slowly.
    const ordered = this.serial.run(async () => {
      await admission;
      if (this.closed) throw new Error('Extension writes are closed'); return operation();
    });
    void ordered.catch(() => undefined);
    const pending = this.workspaces.withDirectoryOperation(roots, () => { admit(); return ordered; })
      .catch(error => { refuse(error); throw error; });
    this.pending.add(pending); return pending.finally(() => { this.pending.delete(pending); });
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.pending]); await this.serial.run(async () => {}); }
}
