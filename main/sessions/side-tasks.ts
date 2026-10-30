import { randomUUID } from 'node:crypto';
import { IpcHandlerError } from '../ipc/registry';

export const SIDE_TASK_IDLE_MS = 60 * 60 * 1000;
export const MAX_SIDE_TASKS = 8;
export interface SideTask {
  id: string; parentSessionId: string; title: string; createdAt: number; updatedAt: number; expiresAt: number;
  phase: 'starting' | 'active' | 'closing' | 'failed'; working: boolean; error?: string;
  initialTitleIndex: number | null; firstTurnAccepted: boolean;
}

/** Reservations and closing tasks keep their slot until their engine resources are gone. */
export class SideTaskRegistry {
  private readonly tasks = new Map<string, SideTask>();
  constructor(private readonly now: () => number = Date.now) {}
  reserve(parentSessionId: string, initialTitleIndex?: number): SideTask {
    const family = [...this.tasks.values()].filter(task => task.parentSessionId === parentSessionId);
    if (family.length >= MAX_SIDE_TASKS) throw new IpcHandlerError('SIDE_TASK_LIMIT_REACHED', 'This conversation already has eight side tasks');
    const ordinal = initialTitleIndex ?? family.length + 1;
    const time = this.now(), task: SideTask = { id: randomUUID(), parentSessionId, title: ordinal === 1 ? 'Side task' : `Side task ${ordinal}`,
      initialTitleIndex: ordinal, firstTurnAccepted: false,
      createdAt: time, updatedAt: time, expiresAt: time + SIDE_TASK_IDLE_MS, phase: 'starting', working: false };
    this.tasks.set(task.id, task); return { ...task };
  }
  get(id: string): SideTask | undefined { const task = this.tasks.get(id); return task ? { ...task } : undefined; }
  all(): SideTask[] { return [...this.tasks.values()].map(task => ({ ...task })); }
  activate(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.phase !== 'starting') throw new IpcHandlerError('SIDE_TASK_UNAVAILABLE', 'The side-task reservation was lost');
    task.phase = 'active'; this.renew(task);
  }
  private renew(task: SideTask): void { task.updatedAt = this.now(); task.expiresAt = task.updatedAt + SIDE_TASK_IDLE_MS; }
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
    task.title = title.trim(); task.initialTitleIndex = null; this.renew(task); return true;
  }
  /** Only the first accepted turn can derive a label, even if its request is empty. */
  acceptTurn(id: string, title?: string | null): boolean {
    const task = this.tasks.get(id);
    if (!task || task.phase !== 'active' || task.firstTurnAccepted) return false;
    task.firstTurnAccepted = true;
    if (title == null) return false;
    task.title = title; task.initialTitleIndex = null;
    return true;
  }
  expired(): SideTask[] { const now = this.now(); return this.all().filter(task => task.phase === 'active' && !task.working && task.expiresAt <= now); }
  beginClosing(id: string): void { const task = this.tasks.get(id); if (task) task.phase = 'closing'; }
  closeFailed(id: string): void { const task = this.tasks.get(id); if (task?.phase === 'closing') task.phase = 'active'; }
  failed(id: string, error: string): void { const task = this.tasks.get(id); if (task) { task.phase = 'failed'; task.error = error; } }
  remove(id: string): void { this.tasks.delete(id); }
  clear(): SideTask[] { const tasks = this.all(); this.tasks.clear(); return tasks; }
}
