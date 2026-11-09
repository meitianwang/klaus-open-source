import { randomUUID } from 'node:crypto';
import { IpcHandlerError } from '../ipc/registry';

export interface SideTask {
  id: string; parentSessionId: string; title: string; createdAt: number; updatedAt: number;
  phase: 'starting' | 'active' | 'closing' | 'failed'; working: boolean; error?: string;
  initialTitleIndex: number | null; firstTurnAccepted: boolean;
  archived: boolean; sidebarPinnedAt: number | null;
}

/** The durable shape of a side task: everything a host restart needs to rematerialize it. */
export interface PersistedSideTask {
  id: string; parentSessionId: string; title: string; createdAt: number; updatedAt: number;
  phase: 'active' | 'failed'; initialTitleIndex: number | null; error?: string;
  archived: boolean; sidebarPinnedAt: number | null;
}

export const SIDE_TASK_REGISTRY_KEY = 'klaus.sideTasks.registry';

export function persistableSideTask(task: SideTask): PersistedSideTask {
  return {
    id: task.id, parentSessionId: task.parentSessionId, title: task.title,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    phase: task.phase === 'failed' ? 'failed' : 'active',
    initialTitleIndex: task.initialTitleIndex, archived: task.archived, sidebarPinnedAt: task.sidebarPinnedAt,
    ...(task.error ? { error: task.error } : {}),
  };
}

/** Rows a restart may adopt: only settled phases, never a half-started or half-closed task. */
export function loadPersistedSideTasks(raw: string | null): SideTask[] {
  if (!raw) return [];
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const tasks: SideTask[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.parentSessionId !== 'string'
      || typeof candidate.title !== 'string' || typeof candidate.createdAt !== 'number'
      || typeof candidate.updatedAt !== 'number'
      || !(candidate.initialTitleIndex === null || typeof candidate.initialTitleIndex === 'number')) continue;
    const phase = candidate.phase;
    if (phase !== 'active' && phase !== 'failed') continue;
    tasks.push({
      id: candidate.id, parentSessionId: candidate.parentSessionId, title: candidate.title,
      createdAt: candidate.createdAt, updatedAt: candidate.updatedAt, phase,
      working: false, error: typeof candidate.error === 'string' ? candidate.error : undefined,
      initialTitleIndex: candidate.initialTitleIndex as number | null, firstTurnAccepted: true,
      archived: candidate.archived === true, sidebarPinnedAt: typeof candidate.sidebarPinnedAt === 'number' ? candidate.sidebarPinnedAt : null,
    });
  }
  return tasks;
}

/** Reservations and closing tasks keep their slot until their engine resources are gone. */
export class SideTaskRegistry {
  private readonly tasks = new Map<string, SideTask>();
  constructor(private readonly now: () => number = Date.now,
    seed: readonly SideTask[] = [],
    private readonly onPersist?: (rows: SideTask[]) => void) {
    for (const task of seed) this.tasks.set(task.id, { ...task });
  }
  private persist(): void { this.onPersist?.(this.all()); }
  reserve(parentSessionId: string, initialTitleIndex?: number): SideTask {
    const family = [...this.tasks.values()].filter(task => task.parentSessionId === parentSessionId);
    const ordinal = initialTitleIndex ?? family.length + 1;
    const time = this.now(), task: SideTask = { id: randomUUID(), parentSessionId, title: ordinal === 1 ? 'Side task' : `Side task ${ordinal}`,
      initialTitleIndex: ordinal, firstTurnAccepted: false, archived: false, sidebarPinnedAt: null,
      createdAt: time, updatedAt: time, phase: 'starting', working: false };
    this.tasks.set(task.id, task); return { ...task };
  }
  get(id: string): SideTask | undefined { const task = this.tasks.get(id); return task ? { ...task } : undefined; }
  all(): SideTask[] { return [...this.tasks.values()].map(task => ({ ...task })); }
  activate(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.phase !== 'starting') throw new IpcHandlerError('SIDE_TASK_UNAVAILABLE', 'The side-task reservation was lost');
    task.phase = 'active'; this.renew(task); this.persist();
  }
  private renew(task: SideTask): void { task.updatedAt = this.now(); }
  touch(id: string): boolean {
    const task = this.tasks.get(id); if (!task || task.phase !== 'active') return false;
    this.renew(task); return true;
  }
  working(id: string, running: boolean): void {
    const task = this.tasks.get(id); if (!task || task.phase !== 'active' || task.working === running) return;
    task.working = running; this.renew(task);
  }
  rename(id: string, title: string): boolean {
    const task = this.tasks.get(id); if (!task || task.phase !== 'active') return false;
    if (!title.trim() || Buffer.byteLength(title) > 4096) throw new IpcHandlerError('BAD_REQUEST', 'A title must contain between 1 and 4096 bytes');
    task.title = title.trim(); task.initialTitleIndex = null; this.renew(task); this.persist(); return true;
  }
  /** Only the first accepted turn can derive a label, even if its request is empty. */
  acceptTurn(id: string, title?: string | null): boolean {
    const task = this.tasks.get(id);
    if (!task || task.phase !== 'active' || task.firstTurnAccepted) return false;
    task.firstTurnAccepted = true;
    if (title == null) return false;
    task.title = title; task.initialTitleIndex = null;
    this.persist();
    return true;
  }
  beginClosing(id: string): void { const task = this.tasks.get(id); if (task) task.phase = 'closing'; }
  setArchived(id: string, archived: boolean): boolean {
    const task = this.tasks.get(id);
    if (!task || task.phase === 'starting' || task.phase === 'closing') return false;
    if (task.archived === archived) return true;
    task.archived = archived; this.renew(task); this.persist(); return true;
  }
  setPinnedAt(id: string, pinnedAt: number | null): boolean {
    const task = this.tasks.get(id);
    if (!task || task.phase === 'starting' || task.phase === 'closing') return false;
    task.sidebarPinnedAt = pinnedAt; this.renew(task); this.persist(); return true;
  }
  closeFailed(id: string): void { const task = this.tasks.get(id); if (task?.phase === 'closing') task.phase = 'active'; }
  failed(id: string, error: string): void { const task = this.tasks.get(id); if (task) { task.phase = 'failed'; task.error = error; this.persist(); } }
  remove(id: string): void { this.tasks.delete(id); this.persist(); }
  clear(): SideTask[] { const tasks = this.all(); this.tasks.clear(); this.persist(); return tasks; }
}
