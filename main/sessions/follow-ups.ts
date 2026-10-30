import { parseDelegationEnvelope } from '../../contracts/thread-delegation';
import type { AcknowledgedClient } from '../engine/acknowledged';
import { submitTurnInput, type TurnInputRequest, type TurnInputAccepted } from '../engine/turn-input';
import type { ClientEvent } from '../engine/protocol';
import { object } from '../ipc/arguments';
import type { Json } from '../ipc/contract';

export type FollowUpReply = { ok: true; messageId: string } | { ok: false; error: string; unconfirmed?: boolean; removed?: boolean; messageId?: string };
export interface FollowUpRequest {
  client: AcknowledgedClient;
  sessionId: string;
  engineSessionId: string;
  messageId: string;
  targetTurnId: string;
  text: string;
  /**
   * What the user should see in the queue card, when it differs from `text`.
   * A cross-conversation delivery wraps the prompt in a delegation envelope for
   * the recipient MODEL, but the queue belongs to the recipient's owner, who
   * wrote none of that markup. Absent means "the text is already user-facing".
   */
  displayText?: string;
  displayMetadata?: Json;
  mobileAttachments?: Json;
  input: Json;
  /**
   * How the engine must persist this steer once applied. A human follow-up
   * (`user`) lands as its own user message so the transcript keeps a durable
   * bubble for it after the turn folds; a cross-conversation delivery
   * (`delegation`) keeps the tool-result shape its envelope renderer expects.
   * Absent means `delegation`, matching engines that predate the field.
   */
  delivery?: 'user' | 'delegation';
  /** Check the captured engine generation and live binding, including after the ACK. */
  assertCurrent(): void;
  /** Queued input transfers ownership through the persistent queue admission. */
  submitInput?(request: TurnInputRequest, onIssue: () => void): Promise<TurnInputAccepted>;
}
export type FollowUpState = 'engine_queued' | 'pending' | 'unconfirmed' | 'applied' | 'failed' | 'removed';
interface PendingFollowUp {
  request: FollowUpRequest;
  admitted: boolean;
  issued: boolean;
  resolve(reply: FollowUpReply): void;
  early?: Record<string, unknown>;
  terminalReason?: string;
  admissionUnconfirmed?: boolean;
  timer?: NodeJS.Timeout;
}

export function followUpStatusEvent(request: Pick<FollowUpRequest, 'sessionId' | 'messageId' | 'text' | 'displayText' | 'delivery' | 'displayMetadata' | 'mobileAttachments'>, state: FollowUpState, error?: string, reason?: string): Record<string, Json> {
  return { type: 'follow_up_status', sessionId: request.sessionId, messageId: request.messageId, text: request.displayText ?? request.text, state,
    ...(error === undefined ? {} : { error }), ...(reason === undefined ? {} : { reason }),
    ...(request.displayMetadata === undefined ? {} : { displayMetadata: request.displayMetadata }), ...(request.mobileAttachments === undefined ? {} : { mobileAttachments: request.mobileAttachments }) };
}

/**
 * The envelope a delegated steer lands with, for the recipient's live layer.
 *
 * The engine appends a cross-conversation envelope to the turn's last tool
 * result when it drains the queue, which is AFTER that call's terminal event
 * already reached the renderer: the live tool card can therefore never see the
 * envelope, and without this field the recipient's running transcript shows
 * nothing until history reloads at turn end. The `applied` verdict is the host's
 * own observation of the drain, so it is the one place that knows both that the
 * message landed and what it says; the renderer inserts a delegation bubble at
 * the tail of the live stream from it. Human follow-ups (`user` delivery) carry
 * no envelope and get no field.
 */
export function followUpDelegationPayload(request: Pick<FollowUpRequest, 'delivery' | 'text'>): Json | undefined {
  if (request.delivery !== 'delegation') return undefined;
  const envelope = parseDelegationEnvelope(request.text);
  if (!envelope) return undefined;
  return { input: envelope.input, sourceThreadId: envelope.sourceThreadId, ...(envelope.sourceHostId ? { sourceHostId: envelope.sourceHostId } : {}) };
}

/** One bounded observer per engine connection; uncertainty never discards a late receipt. */
export class FollowUps {
  private readonly pending = new Map<string, PendingFollowUp>();
  private readonly listeners = new Map<AcknowledgedClient, (event: ClientEvent) => void>();
  private closed = false;

  constructor(private readonly publish: (events: Json[]) => void, private readonly deliveryTimeoutMs = 30 * 60_000) {}

  pendingCount(): number { return this.pending.size; }

  submit(request: FollowUpRequest): Promise<FollowUpReply> {
    const refused = (error: string): Promise<FollowUpReply> => Promise.resolve({ ok: false, error });
    if (this.closed) return refused('The application is closing');
    if (!request.sessionId || !request.engineSessionId || !request.messageId || !request.targetTurnId) return refused('A conversation, running turn and follow-up identity are required');
    if (request.text.trimStart().startsWith('/')) return refused('Slash commands can only be queued for the next turn');
    const key = this.key(request);
    if (this.pending.has(key)) return refused('This follow-up is already awaiting delivery');
    if (this.pending.size >= 128) return refused('Too many follow-ups are awaiting delivery');
    let resolve!: (reply: FollowUpReply) => void;
    const reply = new Promise<FollowUpReply>(yes => { resolve = yes; });
    const job: PendingFollowUp = { request, admitted: false, issued: false, resolve };
    this.pending.set(key, job);
    this.listen(request.client);
    const submissionId = `steer-${request.messageId}`;
    void Promise.resolve().then(async () => {
      if (!this.current(job)) return;
      request.assertCurrent();
      const prepared: TurnInputRequest = {
        sessionId: request.engineSessionId, mode: 'steer', input: request.input, submissionId,
        expectedTurnId: request.targetTurnId, queueMessageId: request.messageId,
        ...(request.delivery ? { delivery: request.delivery } : {}),
        ...(request.displayMetadata ? { displayMetadata: request.displayMetadata } : {}),
      };
      if (request.submitInput) await request.submitInput(prepared, () => { job.issued = true; });
      else { job.issued = true; await submitTurnInput(request.client, prepared, 30_000); }
      if (!this.current(job)) return;
      try { request.assertCurrent(); }
      catch { this.retire(job, 'binding_retired'); return; }
      if (typeof job.early?.error === 'string') {
        resolve({ ok: false, error: job.early.error });
        this.finish(job);
        return;
      }
      job.admitted = true;
      this.status(job, 'engine_queued');
      resolve({ ok: true, messageId: request.messageId });
      job.timer = setTimeout(() => {
        if (this.current(job)) this.status(job, 'unconfirmed', undefined, 'confirmation_timeout');
      }, this.deliveryTimeoutMs);
      if (job.early) this.outcome(job, job.early);
      // Admission never substitutes for the later correlated application receipt.
      if (this.current(job) && job.terminalReason) void this.turnEnded(request.client, request.engineSessionId, request.targetTurnId, job.terminalReason);
    }).catch(error => {
      if (!this.current(job)) return;
      if (typeof job.early?.error === 'string') {
        resolve({ ok: false, error: job.early.error }); this.finish(job); return;
      }
      const message = failureMessage(error);
      const kind = object(error)?.kind;
      const uncertain = job.issued && kind !== 'server';
      if (uncertain) {
        job.admissionUnconfirmed = true;
        this.status(job, 'unconfirmed', undefined, kind === 'closed' || kind === 'io' ? 'connection_closed' : kind === 'invalid_ack' ? 'invalid_ack' : 'admission_timeout');
        resolve({ ok: false, unconfirmed: true, messageId: request.messageId,
          error: 'Follow-up admission was not confirmed. Check queued messages before sending it again.' });
        if (job.early) this.outcome(job, job.early);
        if (this.current(job) && job.terminalReason) void this.turnEnded(request.client, request.engineSessionId, request.targetTurnId, job.terminalReason);
      } else { resolve({ ok: false, error: message }); this.finish(job); }
    });
    return reply;
  }

  /** Successful turns continue normally. Stopped/failed turns retain input until an explicit resume. */
  async turnEnded(client: AcknowledgedClient, engineSessionId: string, turnId: string, reason: string, reconcileSession = false): Promise<void> {
    const jobs = [...this.pending.values()].filter(job => job.request.client === client
      && job.request.engineSessionId === engineSessionId && (reconcileSession || job.request.targetTurnId === turnId));
    if (!jobs.length) return;
    for (const job of jobs) {
      job.terminalReason = reason;
      if (job.timer) clearTimeout(job.timer);
      job.timer = undefined;
    }
    try {
      const reply = object(await client.requestWithTimeout('session/queueSnapshot', { sessionId: engineSessionId }, 30_000));
      const snapshot = object(reply?.queueSnapshot);
      const currentJob = jobs.find(job => this.current(job));
      if (currentJob && snapshot) {
        currentJob.request.assertCurrent();
        this.publish([{ type: 'queue_snapshot', sessionId: currentJob.request.sessionId, ...snapshot }]);
      }
      for (const job of jobs) {
        if (!this.current(job) || (!job.admitted && !job.admissionUnconfirmed)) continue;
        job.request.assertCurrent();
        const row = snapshot?.status === 'authoritative' && Array.isArray(snapshot.items)
          ? snapshot.items.map(object).find(item => object(item?.message)?.uuid === job.request.messageId) : undefined;
        this.status(job, row?.state === 'pending' ? 'pending' : 'unconfirmed', undefined, reason);
      }
    } catch {
      for (const job of jobs) if (this.current(job) && (job.admitted || job.admissionUnconfirmed)) this.status(job, 'unconfirmed', undefined, reason);
    }
  }

  private key(request: Pick<FollowUpRequest, 'sessionId' | 'messageId'>): string { return `${request.sessionId}\0${request.messageId}`; }
  private current(job: PendingFollowUp): boolean { return this.pending.get(this.key(job.request)) === job; }

  private listen(client: AcknowledgedClient): void {
    if (this.listeners.has(client)) return;
    const receive = (event: ClientEvent): void => {
      if (event.type === 'streamClosed') {
        for (const job of [...this.pending.values()]) if (job.request.client === client) this.retire(job, 'connection_closed');
        return;
      }
      if (event.type !== 'rawSessionEvent' && event.type !== 'sessionEvent' && event.type !== 'engineEvent') return;
      const params = object(event.params), envelope = object(params?.event) ?? params;
      const submissionId = envelope?.submissionId ?? envelope?.id;
      if (typeof submissionId !== 'string' || !submissionId.startsWith('steer-')) return;
      const job = [...this.pending.values()].find(item => item.request.client === client
        && item.request.engineSessionId === params?.sessionId && `steer-${item.request.messageId}` === submissionId);
      if (!job || !envelope || (!('steered' in envelope) && typeof envelope.error !== 'string')) return;
      try { job.request.assertCurrent(); }
      catch { this.retire(job, 'binding_retired'); return; }
      if (!job.admitted && !job.admissionUnconfirmed) { job.early = envelope; return; }
      this.outcome(job, envelope);
    };
    this.listeners.set(client, receive);
    client.on('event', receive);
  }

  private outcome(job: PendingFollowUp, envelope: Record<string, unknown>): void {
    if (typeof envelope.error === 'string') {
      this.status(job, 'failed', envelope.error);
      this.finish(job);
      return;
    }
    const applied = object(envelope.steered)?.applied;
    if (applied !== true) {
      // A malformed/negative receipt alone cannot establish that durable input was rejected.
      this.status(job, 'unconfirmed', undefined, 'invalid_receipt');
      return;
    }
    const delegation = followUpDelegationPayload(job.request);
    this.publish([{ ...followUpStatusEvent(job.request, 'applied'), ...(delegation ? { delegation } : {}) }]);
    this.finish(job);
  }

  private status(job: PendingFollowUp, state: FollowUpState, error?: string, reason?: string): void {
    this.publish([followUpStatusEvent(job.request, state, error, reason)]);
  }

  private finish(job: PendingFollowUp): void {
    if (job.timer) clearTimeout(job.timer);
    this.pending.delete(this.key(job.request));
    const client = job.request.client;
    if (![...this.pending.values()].some(item => item.request.client === client)) {
      const listener = this.listeners.get(client);
      if (listener) client.off('event', listener);
      this.listeners.delete(client);
    }
  }

  private retire(job: PendingFollowUp, reason: string): void {
    if (job.issued) {
      this.status(job, 'unconfirmed', undefined, reason);
      job.resolve({ ok: false, unconfirmed: true, messageId: job.request.messageId,
        error: 'Follow-up admission was not confirmed. Check queued messages before sending it again.' });
    } else job.resolve({ ok: false, error: 'The conversation closed before the follow-up was submitted' });
    this.finish(job);
  }

  /** Only an acknowledged queue removal can cancel the delivery observation. */
  removed(sessionId: string, messageId: string): void {
    const job = this.pending.get(this.key({ sessionId, messageId }));
    this.publish([followUpStatusEvent(job?.request ?? { sessionId, messageId, text: '' }, 'removed')]);
    if (job) {
      job.resolve({ ok: false, removed: true, messageId, error: 'The queued input was removed' });
      this.finish(job);
    }
  }

  retireSession(sessionId: string): void {
    for (const job of [...this.pending.values()]) if (job.request.sessionId === sessionId) this.retire(job, 'binding_retired');
  }
  invalidate(): void {
    for (const job of [...this.pending.values()]) this.retire(job, 'connection_closed');
  }
  async close(): Promise<void> { this.closed = true; this.invalidate(); }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof object(error)?.message === 'string'
    ? String(object(error)!.message) : 'Follow-up admission could not be confirmed';
}
