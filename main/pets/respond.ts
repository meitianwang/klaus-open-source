import { requireInterruptConfirmation } from '../sessions/turn-interrupt';
import { randomUUID } from 'node:crypto';
import type { PetAttention } from '../../contracts/desktop-pet-attention';
import type { PetTask } from '../../contracts/desktop-pet';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import type { HostState, PendingReverse } from '../services/host-state';
import type { SessionEventPump } from '../sessions/events';
import type { SessionService } from '../sessions/service';

export interface DesktopPetResponderDependencies {
  state: Pick<HostState, 'peekPending' | 'runningTurnId'>;
  events: Pick<SessionEventPump, 'respond'>;
  sessions: Pick<SessionService, 'pendingQuestions' | 'answerQuestion' | 'interrupt'>;
  activity: { snapshot(): PetTask[]; input(channel: string, payload: unknown): void };
  openUrl(url: string): void | Promise<void>;
  rememberComputerUseApp?(application: string): unknown | Promise<unknown>;
  dismissOptionalQuestion?(taskId: string, requestId: string): void | Promise<void>;
  resolved?(channel: string, payload: Record<string, Json>): void;
  clientResponseId?(): string;
  resolveAttachments?(groups: Record<string, string[]>): Promise<Record<string, Json>>;
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function bad(message: string): never { throw new IpcHandlerError('BAD_REQUEST', message); }
function strings(value: unknown, message: string): Record<string, string> {
  const record = object(value); if (!record || Object.values(record).some(value => typeof value !== 'string')) bad(message);
  return record as Record<string, string>;
}
function attachments(value: unknown, answers: Record<string, string>): Record<string, string[]> | undefined {
  if (value === undefined) return;
  const groups = object(value);
  if (!groups || Object.entries(groups).some(([key, files]) => !Object.hasOwn(answers, key) || !Array.isArray(files) || files.some(file => typeof file !== 'string'))) bad('Attachments must belong to answered questions');
  return groups as Record<string, string[]>;
}
function jsonObject(value: unknown): Record<string, Json> {
  const row = object(value); if (!row) bad('An object is required');
  const validate = (value: unknown): value is Json => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(validate) || !!object(value) && Object.values(value as object).every(validate);
  if (!validate(row)) bad('A JSON response is required');
  return row as Record<string, Json>;
}

/** Routes task controls through the same owned requests used by the conversation. */
export class DesktopPetResponder {
  private readonly retries = new Map<string, { payload: string; id: string }>();
  private readonly sending = new Set<string>();
  constructor(private readonly deps: DesktopPetResponderDependencies) {}
  private current(taskId: string, requestId: string): { task: PetTask; attention: PetAttention; sessionId: string } {
    const task = this.deps.activity.snapshot().find(task => task.id === taskId);
    if (!task || task.status !== 'waiting' || task.attention?.id !== requestId) throw new IpcHandlerError('UNKNOWN_REQUEST', 'The task request is no longer active');
    return { task, attention: task.attention, sessionId: task.sessionId || task.id };
  }
  private parked(taskId: string, requestId: string, expected?: PendingReverse): PendingReverse {
    const { sessionId } = this.current(taskId, requestId), entry = this.deps.state.peekPending(requestId);
    if (!entry || entry.sessionId !== sessionId || !entry.request.outstanding || expected && entry !== expected) throw new IpcHandlerError('UNKNOWN_REQUEST', 'No matching owned request is pending');
    return entry;
  }
  private resolved(channel: string, sessionId: string, requestId: string, detail: Record<string, Json> = {}): void {
    const value = { sessionId, requestId, ...detail }; this.deps.activity.input(channel, value); this.deps.resolved?.(channel, value);
  }
  async respond(taskId: string, requestId: string, value: unknown): Promise<Json> {
    const { attention, sessionId } = this.current(taskId, requestId), response = object(value);
    if (attention.kind === 'review') bad('Review this request in the conversation');
    if (!response) bad('A task response is required');
    const key = `${taskId}\0${requestId}`;
    if (this.sending.has(key)) throw new IpcHandlerError('REQUEST_IN_PROGRESS', 'A response to this request is already in progress');
    this.sending.add(key);
    try {
      if (attention.kind === 'question' && attention.responseChannel === 'async-question') return await this.asyncQuestion(taskId, requestId, sessionId, attention, response);
      const entry = this.parked(taskId, requestId), card = object(entry.card) ?? {};
      if (response.kind === 'open') {
        if (attention.kind !== 'mcp-url' || entry.isApproval) bad('Only a URL request can be opened');
        const value = typeof card.url === 'string' ? card.url : undefined;
        if (!value) bad('The pending request has no URL');
        let url: URL; try { url = new URL(value); } catch { bad('The pending request URL is invalid'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) bad('The pending request URL must use HTTP or HTTPS');
        this.parked(taskId, requestId, entry); await this.deps.openUrl(url.toString()); return { ok: true, pending: true };
      }
      if (entry.isApproval) {
        if (attention.kind !== 'approval' && !(attention.kind === 'question' && attention.responseChannel === 'permission')) bad('The request response channel changed');
        let payload: Record<string, Json>;
        if (attention.kind === 'question') {
          if (response.kind === 'decline' || response.kind === 'cancel') payload = { requestId, decision: 'deny' };
          else {
            if (response.kind !== 'answers') bad('Question answers are required');
            const answers = this.questionAnswers(attention, response.answers), files = await this.resolveAttachments(attachments(response.attachments, answers));
            payload = { requestId, decision: 'allow', updatedInput: { ...jsonObject(card.toolInput ?? {}), answers, ...(files && Object.keys(files).length ? { attachments: files } : {}) } };
          }
        } else {
          if (response.decision !== 'allow' && response.decision !== 'deny') bad('A permission decision is required');
          payload = { requestId, decision: response.decision };
          if (response.acceptedSuggestionIndices !== undefined) {
            if (!Array.isArray(response.acceptedSuggestionIndices) || response.acceptedSuggestionIndices.some(index => typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= (entry.suggestions?.length ?? 0))) bad('Invalid permission suggestion indices');
            payload.acceptedSuggestionIndices = response.acceptedSuggestionIndices;
          }
        }
        this.parked(taskId, requestId, entry); const reply = await this.deps.events.respond(payload, true);
        this.resolved('permission:resolved', sessionId, requestId); return reply;
      }
      if (attention.kind === 'question' && attention.responseChannel !== 'elicit') bad('The request response channel changed');
      if (attention.kind === 'question' && (response.kind === 'decline' || response.kind === 'cancel')) {
        const turnId = attention.turnId || this.deps.state.runningTurnId(sessionId);
        if (!turnId) throw new IpcHandlerError('QUESTION_EXPIRED', 'The question turn is no longer active');
        this.parked(taskId, requestId, entry);
        const reply = await this.deps.sessions.interrupt(sessionId, turnId, 'targeted-turn');
        requireInterruptConfirmation(reply);
        if (object(reply)?.accepted !== true) throw new IpcHandlerError('QUESTION_EXPIRED', 'The question turn did not accept interruption');
        this.resolved('elicit:resolved', sessionId, requestId); return reply;
      }
      let answer: Record<string, Json>;
      if (response.kind === 'decline' || response.kind === 'cancel') answer = { kind: 'decline' };
      else if (attention.kind === 'question' && attention.responseMode !== 'values') {
        if (response.kind !== 'answers') bad('Question answers are required');
        const answers = this.questionAnswers(attention, response.answers), files = await this.resolveAttachments(attachments(response.attachments, answers));
        answer = { kind: 'answers', answers, ...(files && Object.keys(files).length ? { attachments: files } : {}) };
      } else {
        if (response.kind !== 'accept') bad('An elicitation answer is required');
        if (attention.kind === 'mcp-form') {
          const values = jsonObject(response.values);
          if (Object.values(values).some(value => !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value) && value.every(item => typeof item === 'string')))) bad('Invalid form field values');
          answer = { kind: 'accept', values };
          if (response.persistApp === true) {
            const app = typeof card.computerUseApp === 'string' ? card.computerUseApp.trim() : '';
            if (!app || !this.deps.rememberComputerUseApp) bad('Application permission persistence is unavailable');
            const saved = await this.deps.rememberComputerUseApp(app);
            if (object(saved)?.ok === false || object(saved)?.error) throw new IpcHandlerError('POLICY_WRITE_FAILED', 'Application permission could not be saved');
            this.parked(taskId, requestId, entry);
          }
        } else {
          if (!Array.isArray(response.values) || response.values.some(value => typeof value !== 'string')) bad('Elicitation values must contain strings');
          answer = { kind: 'accept', values: response.values };
        }
      }
      this.parked(taskId, requestId, entry); const reply = await this.deps.events.respond({ requestId, response: answer }, false);
      this.resolved('elicit:resolved', sessionId, requestId); return reply;
    } finally { this.sending.delete(key); }
  }
  private async resolveAttachments(groups: Record<string, string[]> | undefined): Promise<Record<string, Json> | undefined> {
    if (!groups || !Object.values(groups).some(files => files.length)) return;
    if (!this.deps.resolveAttachments) throw new IpcHandlerError('UNSUPPORTED_ATTACHMENT', 'Question attachment delivery is unavailable');
    return jsonObject(await this.deps.resolveAttachments(groups));
  }
  private questionAnswers(attention: Extract<PetAttention, { kind: 'question' }>, value: unknown): Record<string, string> {
    const answers = strings(value, 'Question answers must contain strings');
    const known = new Set(attention.questions.map(question => question.question));
    if (!Object.keys(answers).length || Object.keys(answers).some(question => !known.has(question))) bad('Answers must belong to this question request');
    return answers;
  }
  private async asyncQuestion(taskId: string, requestId: string, sessionId: string, attention: Extract<PetAttention, { kind: 'question' }>, response: Record<string, unknown>): Promise<Json> {
    if (!attention.turnId) throw new IpcHandlerError('QUESTION_EXPIRED', 'The question has no active turn identity');
    const pending = await this.deps.sessions.pendingQuestions(sessionId);
    this.current(taskId, requestId);
    const request = Array.isArray(pending) ? pending.find(value => object(value)?.requestId === requestId && object(value)?.turnId === attention.turnId && object(value)?.sessionId === sessionId) : undefined;
    if (!request) throw new IpcHandlerError('QUESTION_EXPIRED', 'The question is no longer pending in this turn');
    if (response.kind === 'decline' || response.kind === 'cancel') {
      await this.deps.dismissOptionalQuestion?.(taskId, requestId);
      this.resolved('question:resolved', sessionId, requestId, { turnId: attention.turnId, state: 'cancelled', localOnly: true });
      return { ok: true, skipped: true };
    }
    if (response.kind !== 'answers') bad('Question answers are required');
    const answers = this.questionAnswers(attention, response.answers), files = await this.resolveAttachments(attachments(response.attachments, answers));
    const payload = JSON.stringify({ answers, attachments: attachments(response.attachments, answers) ?? {} }), retryKey = `${sessionId}\0${requestId}\0${attention.turnId}`;
    let retry = this.retries.get(retryKey);
    if (retry?.payload !== payload) { retry = { payload, id: (this.deps.clientResponseId ?? randomUUID)() }; this.retries.set(retryKey, retry); }
    if (this.retries.size > 64) this.retries.delete(this.retries.keys().next().value!);
    this.current(taskId, requestId);
    if (files) {
      const latest = await this.deps.sessions.pendingQuestions(sessionId); this.current(taskId, requestId);
      if (!Array.isArray(latest) || !latest.some(value => object(value)?.requestId === requestId && object(value)?.turnId === attention.turnId && object(value)?.sessionId === sessionId)) throw new IpcHandlerError('QUESTION_EXPIRED', 'The question is no longer pending in this turn');
    }
    const reply = await this.deps.sessions.answerQuestion(sessionId, { requestId, turnId: attention.turnId, clientResponseId: retry.id, answers, ...(files && Object.keys(files).length ? { attachments: files } : {}) });
    const result = object(reply) ?? {};
    this.resolved('question:resolved', sessionId, requestId, { turnId: attention.turnId, state: typeof result.state === 'string' ? result.state : 'answered', answers });
    return reply;
  }
}
