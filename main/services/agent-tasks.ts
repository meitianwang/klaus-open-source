import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { managedPath } from './extensions/file-store';
import { object, SerialMutations, string, type JsonObject } from './service-types';
import { isInternalMemoryMaintenance } from './internal-memory-maintenance';
import { lifecycleIsOlder, lifecycleVersion } from '../../contracts/agent-lifecycle';

const LIMIT = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function taskMap(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, row]) => !key || key.length > 512 || key.includes('\0') || !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new IpcHandlerError('AGENT_TASKS_INVALID', 'The saved agent tasks are invalid');
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, row]) => !isInternalMemoryMaintenance(object(row))),
  );
}

/** Overlay authoritative liveness while retaining the UI's task-call identity and history. */
export function reconcileTaskSnapshot(cached: JsonObject, agents: JsonObject[]): JsonObject {
  const normalized = new Map(Object.entries(cached).map(([key, value]) => [key, object(value)]));
  // A lifecycle query can arrive before the task call result. Once its call key
  // is known, fold the earlier agent-id row into that key without losing its UI data.
  for (const [key, row] of normalized) {
    const id = string(row.agentId), alias = normalized.get(id);
    if (id && key !== id && alias && (!string(alias.agentId) || alias.agentId === id)) {
      normalized.set(key, { ...alias, ...row }); normalized.delete(id);
    }
  }
  const rows = [...normalized], live = new Map(agents.map(agent => [string(agent.id), agent]));
  const result = Object.fromEntries(rows.map(([key, value]) => {
    const row = object(value), agent = live.get(string(row.agentId) || key);
    if (agent) live.delete(string(agent.id));
    if (!agent) return [key, ['running', 'pending'].includes(string(row.status))
      ? { ...row, status: 'stopped', isIdle: false } : row];
    return [key, taskFromAgent(agent, row)];
  }));
  for (const [id, agent] of live) {
    if (Object.hasOwn(result, id)) throw new IpcHandlerError('AGENT_TASK_ID_CONFLICT', 'The agent identity conflicts with a saved task');
    Object.defineProperty(result, id, { value: taskFromAgent(agent), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function taskFromAgent(agent: JsonObject, previous: JsonObject = {}): JsonObject {
  if (lifecycleIsOlder(previous, agent)) return { ...previous };
  const times = Object.fromEntries(['startedAtMs', 'updatedAtMs', 'completedAtMs'].filter(key => typeof agent[key] === 'number' && Number.isFinite(agent[key])).map(key => [key, agent[key]!]));
  const discovered = Object.keys(previous).length === 0;
  const task: JsonObject = {
    ...previous, agentId: agent.id!, status: agent.status!, isIdle: agent.idle === true,
    isBackground: ['background', 'persistent', 'workflow'].includes(string(agent.kind)),
    ...(discovered ? { description: agent.description! } : {}),
    ...(discovered && agent.teammate === true ? { type: 'in_process_teammate' } : {}),
    ...(discovered && string(agent.agentType) ? { agentType: agent.agentType! } : {}),
    ...(discovered && string(agent.transcript) ? { transcript: agent.transcript! } : {}),
    ...(discovered && string(agent.outputFile) ? { outputFile: agent.outputFile! } : {}),
    // The model the child run actually resolved to is an engine fact, not
    // cached presentation: a row saved before the field existed still gains
    // it from the live lifecycle row.
    ...(string(agent.model) ? { model: agent.model! } : {}),
    ...(string(agent.modelSource) ? { modelSource: agent.modelSource! } : {}), ...times, ...lifecycleVersion(agent),
    ...(string(agent.parentAgentId) ? { parentAgentId: agent.parentAgentId! } : {}),
    ...(string(agent.spawnTurnId) && (!string(previous.spawnTurnId) || previous.parentAgentId !== agent.parentAgentId) ? { spawnTurnId: agent.spawnTurnId! } : {}),
    ...(typeof agent.depth === 'number' ? { depth: agent.depth } : {}),
  };
  if (agent.completedAtMs === null) delete task.completedAtMs;
  if (string(agent.error)) task.error = agent.error!;
  else delete task.error;
  return task;
}

/** Renderer presentation cache; the engine alone supplies live sub-agent state. */
export class AgentTaskService {
  private readonly root: string;
  private readonly files = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly queuedSaves = new Map<string, { content: string; done: Promise<Json> }>();
  private readonly metrics = { writes: 0, unchanged: 0, coalesced: 0, readAllocationBytes: 0 };
  private readonly pending = new Set<Promise<unknown>>();
  private readonly deleted = new Set<string>();
  private closed = false;
  constructor(private readonly options: {
    configRoot: string;
    agents(id: string): Promise<JsonObject>;
    presentation?(id: string): { tasks: JsonObject; revision: number };
    onSnapshot?(id: string, tasks: JsonObject): void;
    withFiles<T>(work: () => Promise<T>): Promise<T>;
  }) { this.root = resolve(options.configRoot); }
  private identity(id: string): void {
    if (!UUID.test(id)) throw new IpcHandlerError('BAD_REQUEST', 'A conversation UUID is required');
    if (this.deleted.has(id)) throw new IpcHandlerError('SESSION_NOT_FOUND', 'The conversation was deleted');
  }
  private track<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    if (this.closed && !cleanup) return Promise.reject(new IpcHandlerError('SERVICE_CLOSED', 'Agent task operations are closing'));
    const action = Promise.resolve().then(work);
    this.pending.add(action); void action.finally(() => this.pending.delete(action)).catch(() => {}); return action;
  }
  private async path(id: string, create = false): Promise<string> {
    const path = await managedPath(this.root, `agent-tasks/${id}.json`, create);
    try {
      if (await realpath(dirname(path)) !== join(await realpath(this.root), 'agent-tasks')) throw new Error('Agent task directory must not be a symlink');
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Agent task file must not be a symlink');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return path;
  }
  private runFile<T>(id: string, work: () => Promise<T>): Promise<T> {
    let entry = this.files.get(id);
    if (!entry) { entry = { queue: new SerialMutations(), pending: 0 }; this.files.set(id, entry); }
    entry.pending++;
    const result = entry.queue.run(work), owned = entry;
    void result.finally(() => {
      if (--owned.pending === 0 && this.files.get(id) === owned) this.files.delete(id);
    }).catch(() => {});
    return result;
  }

  private async read(id: string): Promise<{ tasks: JsonObject; content?: string }> {
    const path = await this.path(id); let file;
    try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: {} }; throw error; }
    try {
      const before = await file.stat(); if (!before.isFile() || before.size > LIMIT) throw new Error('Invalid or oversized agent task file');
      // One extra byte detects growth without allocating the maximum for a tiny sidecar.
      const bytes = Buffer.alloc(before.size + 1); let size = 0;
      this.metrics.readAllocationBytes += bytes.length;
      while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      const after = await file.stat();
      if (size > LIMIT || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('The saved agent tasks changed while reading');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      return { tasks: taskMap(JSON.parse(content)), content };
    } finally { await file.close(); }
  }
  load(id: string): Promise<JsonObject> {
    // A read seals the pending batch so later saves cannot pass this barrier.
    this.queuedSaves.delete(id);
    return this.track(() => this.runFile(id, () => this.options.withFiles(async () => {
      this.identity(id); const { tasks } = await this.read(id); this.identity(id); return { tasks };
    })));
  }
  save(id: string, value: Json | undefined): Promise<Json> {
    let content: string;
    try {
      if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'Agent task operations are closing');
      this.identity(id); content = JSON.stringify(taskMap(value));
      if (Buffer.byteLength(content) > LIMIT) throw new Error('Agent task cache exceeds the 8 MiB limit');
    } catch (error) { return Promise.reject(error); }
    const queued = this.queuedSaves.get(id);
    if (queued) { queued.content = content; this.metrics.coalesced++; return queued.done; }
    const batch = { content, done: undefined! as Promise<Json> };
    this.queuedSaves.set(id, batch);
    batch.done = this.track(() => this.runFile(id, async () => {
      if (this.queuedSaves.get(id) === batch) this.queuedSaves.delete(id);
      const content = batch.content;
      return this.options.withFiles(async () => {
        this.identity(id);
        const previous = await this.read(id);
        this.identity(id);
        if (previous.content === content) {
          await this.path(id);
          this.metrics.unchanged++;
          return null;
        }
        const path = await this.path(id, true), temporary = join(dirname(path), `.klaus-agent-tasks-${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
          this.identity(id); await this.path(id); await rename(temporary, path);
          this.metrics.writes++;
          return null;
        } finally { await rm(temporary, { force: true }); }
      });
    }));
    return batch.done;
  }
  diagnostics(): { writes: number; unchanged: number; coalesced: number; readAllocationBytes: number; fileQueues: number; queuedSaves: number } {
    return { ...this.metrics, fileQueues: this.files.size, queuedSaves: this.queuedSaves.size };
  }
  snapshot(id: string): Promise<JsonObject> {
    return this.track(async () => {
      this.identity(id);
      // Do not hold the file queue while resolving a session: deletion holds that session's gate.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = this.options.presentation?.(id).revision;
        const reply = await this.options.agents(id); this.identity(id);
        if (!Array.isArray(reply.agents)) throw new IpcHandlerError('AGENT_SNAPSHOT_INVALID', 'The engine returned an invalid sub-agent snapshot');
        this.queuedSaves.delete(id);
        const { tasks: cached } = await this.runFile(id, () => this.options.withFiles(async () => { this.identity(id); return this.read(id); }));
        this.identity(id);
        const current = this.options.presentation?.(id);
        if (before !== current?.revision) continue;
        const combined = { ...cached };
        for (const [key, row] of Object.entries(current?.tasks ?? {})) Object.defineProperty(combined, key, {value:{...object(cached[key]),...object(row)},enumerable:true,configurable:true,writable:true});
        const tasks = reconcileTaskSnapshot(combined, reply.agents.map(object));
        this.options.onSnapshot?.(id, tasks);
        return { tasks };
      }
      throw new IpcHandlerError('AGENT_SNAPSHOT_CHANGED', 'The sub-agent state changed during refresh. Try again.');
    });
  }
  remove(id: string): Promise<void> {
    if (!UUID.test(id)) return Promise.reject(new IpcHandlerError('BAD_REQUEST', 'A conversation UUID is required'));
    this.deleted.add(id);
    this.queuedSaves.delete(id);
    return this.track(() => this.runFile(id, () => this.options.withFiles(async () => { await rm(await this.path(id), { force: true }); })), true);
  }
  async close(deadlineMs = 5000): Promise<void> {
    this.closed = true; let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([
      (async () => { while (this.pending.size) await Promise.allSettled([...this.pending]); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Agent task operations did not finish before the shutdown deadline')), deadlineMs); }),
    ]); } finally { if (timer) clearTimeout(timer); }
  }
}
