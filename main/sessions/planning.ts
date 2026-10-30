import type { PlanningSnapshot, ProposedPlan } from '../../contracts/planning-goals';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { object, string, type JsonObject } from '../services/service-types';
import type { HostState } from '../services/host-state';
import { sessionSpecMode } from '../services/session-store';
import { planningSnapshot } from './workflow-snapshots';
import type { SessionService } from './service';

/** Plan actions serialize per conversation while unrelated conversations remain independent. */
export class SessionPlanning {
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(private readonly sessions: SessionService, private readonly state: HostState, private readonly configRoot?: string) {}
  private async request(id: string, method: string, params: JsonObject = {}, recovery = false): Promise<JsonObject> {
    let reply: JsonObject;
    if (recovery) {
      if (method !== 'session/plans' && method !== 'session/settlePlanImplementation') throw new IpcHandlerError('BAD_REQUEST', 'Unsupported planning recovery operation');
      reply = await this.sessions.requestPlanningRecovery(id, method, params);
    } else reply = ['session/collaborationMode', 'session/plans', 'session/readPlanDocument', 'session/setCollaborationMode', 'session/cancelPlanImplementation', 'session/settlePlanImplementation'].includes(method)
      ? await this.sessions.requestThreadWorkflow(id, method, params)
      : await this.sessions.requestSession(id, method, params);
    const snapshot = planningSnapshot(reply.planning);
    if (!snapshot) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid planning snapshot');
    if (this.configRoot && ['session/collaborationMode', 'session/plans'].includes(method) && snapshot.revision === 0 && sessionSpecMode(id, this.configRoot).enabled) {
      return this.serialize(id, async () => {
        const current = this.state.workflows.mode(id);
        if (current && current.revision > 0) return { ...reply, planning: current as unknown as Json };
        try { return await this.request(id, 'session/setCollaborationMode', { mode: 'plan', expectedRevision: 0 }); }
        catch (error) {
          // Another client may establish authoritative mode while the migration waits.
          const observed = await this.sessions.requestThreadWorkflow(id, method, params), latest = planningSnapshot(observed.planning);
          if (!latest || latest.revision === 0) throw error;
          return { ...observed, planning: this.state.workflows.installPlanning(id, latest) as unknown as Json };
        }
      });
    }
    return { ...reply, planning: this.state.workflows.installPlanning(id, snapshot) as unknown as Json };
  }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.mutations.set(id, result);
    void result.finally(() => { if (this.mutations.get(id) === result) this.mutations.delete(id); }).catch(() => {});
    return result;
  }
  get(id: string): Promise<JsonObject> { return this.request(id, 'session/collaborationMode'); }
  setMode(id: string, value: JsonObject): Promise<JsonObject> {
    if (value.mode !== 'default' && value.mode !== 'plan') throw new IpcHandlerError('BAD_REQUEST', 'mode must be default or plan');
    const mode = value.mode, expectedRevision = revision(value.expectedRevision, false);
    return this.serialize(id, () => this.request(id, 'session/setCollaborationMode', { mode,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}) }));
  }
  plans(id: string): Promise<JsonObject> { return this.request(id, 'session/plans'); }
  async readDocument(id: string, value: JsonObject): Promise<JsonObject> {
    const reply = await this.request(id, 'session/readPlanDocument', identity(value));
    const document = object(reply.document), plans = object(reply.planning).plans;
    const current = Array.isArray(plans) ? plans.map(object).find(plan => plan.id === value.planId) : undefined;
    if (!document || typeof document.content !== 'string' || typeof document.path !== 'string' || document.planId !== value.planId
      || typeof document.revision !== 'number' || !current || current.revision !== document.revision) {
      throw new IpcHandlerError('PLAN_DOCUMENT_STALE', 'The plan changed while its document was opening. Open the latest revision again.');
    }
    return reply;
  }
  saveDocument(id: string, value: JsonObject): Promise<JsonObject> {
    const params: JsonObject = { ...identity(value), content: content(value.content) };
    if (value.expectedContent !== undefined) {
      if (typeof value.expectedContent !== 'string' || Buffer.byteLength(value.expectedContent) > 8 * 1024 * 1024) throw new IpcHandlerError('BAD_REQUEST', 'Invalid plan editor baseline');
      params.expectedContent = value.expectedContent;
    }
    return this.serialize(id, () => this.request(id, 'session/savePlanDocument', params));
  }
  cancel(id: string, value: JsonObject): Promise<JsonObject> {
    const params = identity(value);
    return this.serialize(id, () => this.request(id, 'session/cancelPlanImplementation', params));
  }
  action(id: string, value: JsonObject, kind: 'implementation' | 'feedback', assertCurrent?: () => void): Promise<JsonObject> {
    const params: JsonObject = { ...identity(value), clientRequestId: required(value.clientRequestId, 'clientRequestId') };
    if (kind === 'implementation' && value.content !== undefined) params.content = content(value.content);
    if (kind === 'feedback') params.feedback = content(value.feedback);
    return this.serialize(id, async () => {
      assertCurrent?.();
      const reply = await this.request(id, kind === 'implementation' ? 'session/acceptPlan' : 'session/planFeedback', params);
      const implementation = object(object(reply.planning).implementation);
      const admission = string(reply.admission) || string(implementation.admission);
      const prompt = string(kind === 'implementation' ? reply.implementationInput : reply.feedbackInput);
      const pending = reply.accepted === true || admission === 'pending' || admission === 'failed' || admission === 'cancelled';
      if (!pending || !prompt || admission === 'started') return reply;
      const submissionId = string(reply.implementationId) || string(implementation.implementationId) || `plan-${kind}-${params.clientRequestId}`;
      let outcome: 'started' | 'failed' | 'cancelled' = 'failed';
      try {
        assertCurrent?.();
        await this.sessions.submitPlanningTurn(id, prompt, submissionId, kind === 'implementation' ? 'plan_implementation' : 'plan_feedback');
        outcome = 'started';
      } catch (error) {
        if (error instanceof IpcHandlerError && ['STALE_REQUEST', 'ABORTED', 'SESSION_UNAVAILABLE'].includes(error.code)) outcome = 'cancelled';
        try {
          const current = await this.request(id, 'session/plans', {}, true), receipt = object(object(current.planning).implementation);
          if (receipt.clientRequestId !== params.clientRequestId || receipt.planId !== params.planId || receipt.revision !== params.revision) {
            throw new IpcHandlerError('PLAN_ADMISSION_UNCONFIRMED', 'The plan action admission could not be reconciled');
          }
          // The engine claims this receipt before execution. A lost transport reply
          // must never downgrade that durable claim or admit another implementation.
          if (receipt.admission === 'started') return { ...reply, ...current, accepted: true, admission: 'started' };
          if (!['pending', 'failed', 'cancelled'].includes(String(receipt.admission))) throw new IpcHandlerError('PLAN_ADMISSION_UNCONFIRMED', 'The plan action admission is unavailable');
          await this.settle(id, params, outcome, true);
        } catch (settlementError) {
          throw new AggregateError([error, settlementError], 'The plan action could not start and its admission outcome remains unconfirmed');
        }
        throw error;
      }
      const settled = await this.settle(id, params, outcome);
      return { ...reply, ...settled, accepted: true, admission: outcome };
    });
  }
  private settle(id: string, params: JsonObject, outcome: 'started' | 'failed' | 'cancelled', recovery = false): Promise<JsonObject> {
    return this.request(id, 'session/settlePlanImplementation', { planId: params.planId!, revision: params.revision!,
      clientRequestId: params.clientRequestId!, outcome }, recovery);
  }
}
function required(value: Json | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new IpcHandlerError('BAD_REQUEST', `${name} is required and must be at most 256 characters`);
  return value;
}
function revision(value: Json | undefined, required = true): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new IpcHandlerError('BAD_REQUEST', 'revision must be a nonnegative safe integer');
  return value;
}
function identity(value: JsonObject): JsonObject { return { planId: required(value.planId, 'planId'), revision: revision(value.revision)! }; }
function content(value: Json | undefined): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8 * 1024 * 1024) throw new IpcHandlerError('BAD_REQUEST', 'Plan content must contain text of at most 8 MiB');
  return value;
}


type RecordValue = Record<string, Json>;
const record = (value: Json | undefined): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];

/** Raw model context remains unchanged; only renderer-bound captures need this join. */
export function historyHasPlanMarkup(value: Json): boolean {
  const outer = record(value), source = record(outer.snapshot ?? value);
  return array(source.history ?? source.messages).some(value => {
    const row = record(value);
    if (row.type !== 'assistant' && row.role !== 'assistant') return false;
    return array(row.content ?? row.contentBlocks).map(value => {
      const block = record(value);
      return block.type === 'text' && block.phase !== 'commentary' && typeof block.text === 'string' ? block.text : '';
    }).join('').includes('<proposed_plan>');
  });
}

/** The immutable planning state must span the actual history or ordered follow cut. */
export async function coherentPlanningCapture<T extends Json>(initial: T, read: () => Promise<T>, plans: () => Promise<PlanningSnapshot>, current: () => void): Promise<{ value: T; planning?: PlanningSnapshot }> {
  if (!historyHasPlanMarkup(initial)) return { value: initial };
  for (let attempt = 0; attempt < 3; attempt++) {
    current();
    const before = await plans(); current();
    const value = await read(); current();
    const after = await plans(); current();
    if (before.revision === after.revision && JSON.stringify(before.plans) === JSON.stringify(after.plans)) return { value, planning: before };
  }
  throw new IpcHandlerError('PLAN_HISTORY_CHANGED', 'The plan changed while its history was loading. Retry the history read.');
}

interface Group { row: number; start: number; end: number; text: string; template: RecordValue; output: Json[] }

/** Restore ordered presentation from engine-owned artifact identities, never from a guessed plan. */
export function projectPlanningHistory(value: Json, sessionId: string, planning?: PlanningSnapshot): Json {
  if (!planning) return value;
  const source = record(value), messages = array(source.messages);
  const plans = new Map<string, ProposedPlan | null>();
  for (const plan of planning.plans) {
    if (plan.threadId !== sessionId) continue;
    plans.set(plan.turnId, plans.has(plan.turnId) ? null : plan);
  }
  const replacements = new Map<number, Group[]>();
  for (const [turnId, plan] of plans) {
    if (!plan) continue;
    const groups: Group[] = [];
    messages.forEach((value, rowIndex) => {
      const row = record(value);
      if (row.role !== 'assistant' || row.turnId !== turnId) return;
      const blocks = array(row.contentBlocks);
      for (let index = 0; index < blocks.length;) {
        const first = record(blocks[index]);
        if (first.type !== 'text' || first.phase === 'commentary' || typeof first.text !== 'string') { index++; continue; }
        const start = index, chunks: string[] = [], identity = JSON.stringify([first.messageId, first.phase]);
        while (index < blocks.length) {
          const block = record(blocks[index]);
          if (block.type !== 'text' || typeof block.text !== 'string' || JSON.stringify([block.messageId, block.phase]) !== identity) break;
          chunks.push(block.text); index++;
        }
        groups.push({ row: rowIndex, start, end: index, text: chunks.join(''), template: first, output: [] });
      }
    });
    let mode: 'text' | 'plan' | 'rejected' = 'text', started = false, malformed = false, inserted = false;
    for (const group of groups) {
      let pendingBreak = '';
      const emit = (text: string) => {
        if (!text) return;
        const last = record(group.output.at(-1));
        if (last.type === 'text' && typeof last.text === 'string') last.text += text;
        else group.output.push({ ...group.template, text });
      };
      for (let offset = 0; offset < group.text.length;) {
        const newline = group.text.indexOf('\n', offset), end = newline < 0 ? group.text.length : newline;
        const contentEnd = newline >= 0 && end > offset && group.text[end - 1] === '\r' ? end - 1 : end;
        const line = group.text.slice(offset, contentEnd), lineBreak = newline < 0 ? '' : group.text.slice(contentEnd, end + 1);
        if (line === '<proposed_plan>') {
          if (mode !== 'plan') emit(pendingBreak);
          pendingBreak = '';
          if (mode === 'text' && !started && !malformed) {
            group.output.push({ type: 'proposed_plan', plan: { ...plan } as unknown as Json });
            started = inserted = true; mode = 'plan';
          } else { malformed = true; if (mode === 'text') mode = 'rejected'; }
        } else if (line === '</proposed_plan>') {
          pendingBreak = '';
          if (mode === 'text') malformed = true;
          mode = 'text';
        } else if (mode === 'text') emit(line + lineBreak);
        else if (mode === 'rejected') { emit(pendingBreak + line); pendingBreak = lineBreak; }
        offset = newline < 0 ? group.text.length : end + 1;
      }
      if (mode === 'rejected') emit(pendingBreak);
      if (mode !== 'text') malformed = true;
    }
    if (!inserted) continue;
    for (const group of groups) {
      const owned = replacements.get(group.row) ?? [];
      owned.push(group); replacements.set(group.row, owned);
    }
  }
  if (!replacements.size) return value;
  const projected = messages.flatMap((value, index) => {
    const groups = replacements.get(index);
    if (!groups) return [value];
    const row = record(value), blocks = [...array(row.contentBlocks)];
    for (const group of [...groups].reverse()) blocks.splice(group.start, group.end - group.start, ...group.output);
    if (!blocks.length) return [];
    const text = blocks.map(value => { const block = record(value); return block.type === 'text' ? block.text : block.type === 'proposed_plan' ? record(block.plan).content : ''; }).filter(value => typeof value === 'string').join('');
    return [{ ...row, text, contentBlocks: blocks }];
  });
  return { ...source, messages: projected };
}
