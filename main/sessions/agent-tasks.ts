import type { ClientEvent } from '../engine/protocol';
import { object, string, type JsonObject } from '../services/service-types';
import type { Json } from '../ipc/contract';

interface Terminal { status: string; error?: string }
interface Tracked { row: JsonObject; terminal?: Terminal }
interface SessionTasks {
  tasks: Map<string, Tracked>;
  pending: Map<string, JsonObject>;
  denied: Set<string>;
  terminals: Map<string, Terminal>;
  turns: Map<string, string>;
  revision: number;
}

/** Stateful presentation of task calls; raw child events remain on the normal stream. */
export class AgentTaskTracker {
  onChanged?: () => void;
  private readonly sessions = new Map<string, SessionTasks>();
  private revision = 0;
  reset(): void { this.sessions.clear(); this.revision++; this.onChanged?.(); }
  forget(id: string): void { this.sessions.delete(id); this.revision++; this.onChanged?.(); }
  activeConversations(): Array<{ parentId: string; id: string }> {
    return [...this.sessions].flatMap(([parentId, state]) => [...state.tasks.values()].flatMap(({ row }) => {
      const id = string(row.agentId);
      return id && row.status === 'running' && row.isIdle !== true ? [{ parentId, id }] : [];
    }));
  }
  reconcile(id: string, rows: JsonObject): void {
    const state = this.state(id);
    if (JSON.stringify(this.presentation(id).tasks) === JSON.stringify(rows)) return;
    const previousTasks = new Map(state.tasks);
    state.tasks.clear();
    for (const [key, value] of Object.entries(rows)) {
      const row = object(value), previous = previousTasks.get(key);
      state.tasks.set(key, { ...previous, row, terminal: row.status === 'running' ? undefined : { status: string(row.status) } });
    }
    this.emit(id);
  }
  presentation(id: string): { tasks: JsonObject; revision: number } {
    const entry = this.sessions.get(id);
    return { tasks: Object.fromEntries([...(entry?.tasks ?? [])].map(([id, task]) => [id, { ...task.row }])), revision: entry?.revision ?? this.revision };
  }
  private state(id: string): SessionTasks {
    let entry = this.sessions.get(id);
    if (!entry) { entry = { tasks: new Map(), pending: new Map(), denied: new Set(), terminals: new Map(), turns: new Map(), revision: ++this.revision }; this.sessions.set(id, entry); }
    return entry;
  }
  private emit(id: string): JsonObject {
    const state = this.state(id); state.revision = ++this.revision;
    this.onChanged?.();
    return { type: 'tasks_changed', sessionId: id, tasks: this.presentation(id).tasks };
  }
  approve(sessionId: string, taskId: string): JsonObject[] {
    const state = this.sessions.get(sessionId), pending = state?.pending.get(taskId);
    if (!state || state.denied.has(taskId) || !pending) return [];
    state.pending.delete(taskId); return this.call(sessionId, pending, true);
  }
  deny(sessionId: string, taskId: string): void {
    const state = this.sessions.get(sessionId); if (!state) return;
    state.pending.delete(taskId); state.denied.add(taskId);
  }
  observe(event: ClientEvent, rendererId: (engineId: string) => string | undefined): JsonObject[] {
    if (!['productEvent', 'rawSessionEvent', 'sessionEvent', 'engineEvent'].includes(event.type)) return [];
    const params = object((event as { params?: Json }).params), id = rendererId(string(params.sessionId));
    if (!id) return [];
    if (event.type === 'productEvent') {
      if (!['item/started', 'item/updated', 'item/completed'].includes(event.method)) return [];
      const item = object(params.item);
      return item.type === 'tool_call' && item.toolName === 'task' ? this.call(id, item) : [];
    }
    const envelope = object(params.event ?? params), child = object(envelope.subagentEvent);
    if (Object.keys(child).length) {
      const event = object(child.event), item = object(event.item);
      if (['item.started', 'item.updated', 'item.completed'].includes(string(event.type)) && item.type === 'tool_call' && item.toolName === 'task') {
        return this.call(id, item, false, string(child.agentId));
      }
      return this.child(id, string(child.agentId), event);
    }
    const inner = object(envelope.event), progress = object(inner.event);
    if (inner.type !== 'tool.event' || progress.type !== 'agent_progress') return [];
    const agentId = string(progress.agentId), label = string(progress.label), taskId = label ? agentId : string(inner.toolUseId);
    if (!agentId || !taskId) return [];
    const state = this.state(id); if (state.denied.has(taskId)) return [];
    const pending = state.pending.get(taskId);
    if (pending) { state.pending.delete(taskId); this.call(id, pending, true); }
    const previous = state.tasks.get(taskId), row: JsonObject = { ...previous?.row, id: taskId, agentId,
      status: previous?.row.status ?? 'running', ...(label ? { description: label, agentName: label, agentType: 'workflow', isBackground: true } : {}),
    };
    state.tasks.set(taskId, { ...previous, row });
    const terminal = this.child(id, agentId, object(progress.event));
    return terminal.length ? terminal : [this.emit(id)];
  }
  private call(id: string, item: JsonObject, confirmed = false, parentAgentId?: string): JsonObject[] {
    const taskId = string(item.id); if (!taskId) return [];
    const state = this.state(id); if (state.denied.has(taskId)) return [];
    const previous = state.tasks.get(taskId), status = string(item.status), result = object(item.result);
    if (!previous && !confirmed && (status !== 'completed' || result.ok === false)) {
      if (status === 'failed' || status === 'completed') state.pending.delete(taskId);
      else state.pending.set(taskId, item);
      return [];
    }
    state.pending.delete(taskId);
    const args = object(item.arguments), agentId = string(result.agentId) || string(previous?.row.agentId), persistent = args.persistent === true;
    const detached = !!string(result.outputFile), background = persistent || detached || args.run_in_background === true;
    const terminal = previous?.terminal ?? (agentId ? state.terminals.get(agentId) : undefined);
    if (agentId) state.terminals.delete(agentId);
    const row: JsonObject = { ...previous?.row, id: taskId,
      status: terminal ? persistent ? 'running' : terminal.status : (status === 'failed' || result.ok === false ? 'failed' : status === 'completed' && !background ? 'completed' : 'running'),
      type: persistent ? 'in_process_teammate' : 'foreground', isBackground: background,
      ...(agentId ? { agentId } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
      ...(persistent && terminal ? { isIdle: true } : {}),
    };
    const error = terminal?.error || string(result.error) || string(object(result.error).message) || string(object(item.error).message);
    if (error) row.error = error;
    else if (terminal) delete row.error;
    for (const [field, value] of [['agentType', args.subagent_type ?? args.agentType], ['agentName', args.peer], ['description', args.description], ['objective', args.prompt], ['outputFile', result.outputFile]] as const) {
      if (typeof value === 'string' && value) row[field] = value;
    }
    if (previous && JSON.stringify(previous.row) === JSON.stringify(row) && JSON.stringify(previous.terminal) === JSON.stringify(terminal)) return [];
    state.tasks.set(taskId, { row, terminal: persistent ? undefined : terminal }); return [this.emit(id)];
  }
  private child(id: string, agentId: string, event: JsonObject): JsonObject[] {
    if (!agentId) return [];
    const state = this.state(id), entry = [...state.tasks.values()].find(task => task.row.agentId === agentId);
    const kind = string(event.type);
    // A budget ceiling (turn or spend) is a planned stop, not a crash: the
    // child's partial text is its answer, so the row keeps a distinct status.
    const budgetLimited = kind === 'turn.completed' && ['turn_limit_exhausted', 'spend_limit_exhausted'].includes(string(event.stopReason));
    const status = kind === 'turn.failed' ? object(event.error).code === 'aborted' ? 'stopped' : 'failed'
      : kind === 'turn.completed' ? budgetLimited ? 'budget_limited'
        : event.stopReason === 'aborted' ? 'stopped' : !event.stopReason || event.stopReason === 'completed' ? 'completed' : 'failed' : undefined;
    const error = string(object(event.error).message) || string(event.error);
    const terminal = status ? { status, ...(error ? { error } : {}) } : undefined;
    const turnId = string(event.turnId), activeTurnId = state.turns.get(agentId);
    if (terminal && turnId && activeTurnId && turnId !== activeTurnId) return [];
    if (kind === 'turn.started' && turnId) state.turns.set(agentId, turnId);
    if (!entry) {
      if (terminal) { state.terminals.set(agentId, terminal); if (state.terminals.size > 1024) state.terminals.delete(state.terminals.keys().next().value!); }
      else if (kind === 'turn.started') state.terminals.delete(agentId);
      return [];
    }
    const persistent = entry.row.type === 'in_process_teammate';
    if (!terminal && kind !== 'turn.started') return [];
    const row: JsonObject = { ...entry.row, status: persistent || !terminal ? 'running' : terminal.status, isIdle: persistent && !!terminal };
    if (terminal?.error) row.error = terminal.error;
    else delete row.error;
    if (persistent || !terminal) delete row.completedAtMs;
    if (!persistent && terminal) entry.terminal = terminal;
    else entry.terminal = undefined;
    if (JSON.stringify(entry.row) === JSON.stringify(row)) return [];
    entry.row = row; return [this.emit(id)];
  }
}
