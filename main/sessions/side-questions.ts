import { randomUUID } from 'node:crypto';
import { IpcHandlerError } from '../ipc/registry';
import { object } from '../ipc/arguments';
import { requestAcknowledged } from '../engine/acknowledged';
import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import type { EngineClientLike } from './service';

export interface SideQuestionIdentity { ownerId: number; requestId: string }
export type SideQuestionInput = string | Json[];
interface Question {
  sessionId: string;
  ownerId?: number;
  controller: AbortController;
  done: Promise<{ response: string }>;
}
const cancelled = (): IpcHandlerError => new IpcHandlerError('ABORTED', 'The side question was cancelled');

/** Keep cancellation scoped to its caller and retain work until its engine outcome settles. */
export class SideQuestions {
  private readonly jobs = new Map<string, Question>();
  private readonly running = new Set<Question>();
  private readonly retiring = new Map<string, number>();
  private readonly retiringOwners = new Map<number, number>();
  private generation = 0;
  private closed = false;

  constructor(private readonly run: (sessionId: string, question: SideQuestionInput, signal: AbortSignal) => Promise<{ response: string }>) {}

  ask(sessionId: string, question: SideQuestionInput, identity?: SideQuestionIdentity): Promise<{ response: string }> {
    if (this.closed || this.retiring.has(sessionId) || (identity && this.retiringOwners.has(identity.ownerId))) throw new IpcHandlerError('SESSION_CLOSING', 'The conversation or its window is closing');
    const inputText = typeof question === 'string' ? question : Array.isArray(question)
      ? question.map(part => object(part)?.type === 'text' ? object(part)?.text : '').filter(value => typeof value === 'string').join('\n') : '';
    if (!inputText.trim() || Buffer.byteLength(inputText) > 1024 * 1024 || Array.isArray(question) && (question.length > 16 || Buffer.byteLength(JSON.stringify(question)) > 72 * 1024 * 1024)) {
      throw new IpcHandlerError('BAD_REQUEST', 'A side question needs 1–1048576 text bytes and at most 16 content parts within 72 MiB');
    }
    if (identity && (!Number.isSafeInteger(identity.ownerId) || identity.ownerId < 1 || !identity.requestId.trim() || identity.requestId.length > 4096)) throw new IpcHandlerError('BAD_REQUEST', 'The side-question identity is invalid');
    const key = JSON.stringify([identity?.ownerId ?? 'host', identity?.requestId ?? randomUUID()]);
    const previous = this.jobs.get(key);
    if (this.running.size >= 64 || [...this.running].filter(job => job.sessionId === sessionId).length >= 8) throw new IpcHandlerError('TOO_MANY_REQUESTS', 'Too many side questions are still running');
    const job: Question = { sessionId, ownerId:identity?.ownerId, controller: new AbortController(), done: Promise.resolve({ response: '' }) };
    this.jobs.set(key, job); this.running.add(job);
    previous?.controller.abort();
    job.done = Promise.resolve().then(async () => {
      if (previous) await this.drain([previous]);
      if (job.controller.signal.aborted) throw cancelled();
      return this.run(sessionId, typeof question === 'string' ? question.trim() : question, job.controller.signal);
    }).finally(() => {
      this.running.delete(job);
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    });
    void job.done.catch(() => {});
    return job.done;
  }

  async cancel(identity: SideQuestionIdentity): Promise<boolean> {
    const job = this.jobs.get(JSON.stringify([identity.ownerId, identity.requestId]));
    if (!job) return false;
    job.controller.abort(); await this.drain([job]); return true;
  }
  sessionIds(): string[] { return [...new Set([...this.running].map(job => job.sessionId))]; }
  async detachOwner(ownerId: number): Promise<void> {
    const generation=this.generation;
    this.retiringOwners.set(ownerId,(this.retiringOwners.get(ownerId)??0)+1);
    const jobs=[...this.running].filter(job=>job.ownerId===ownerId);for(const job of jobs)job.controller.abort();
    await this.drain(jobs);
    if(generation!==this.generation)return;
    const count=this.retiringOwners.get(ownerId)??0;if(count<=1)this.retiringOwners.delete(ownerId);else this.retiringOwners.set(ownerId,count-1);
  }
  private async drain(jobs: Question[]): Promise<void> {
    const results = await Promise.allSettled(jobs.map(job => job.done));
    for (const result of results) if (result.status === 'rejected' && result.reason instanceof IpcHandlerError && result.reason.code === 'CANCEL_FAILED') throw result.reason;
  }
  async beginClosing(sessionId: string): Promise<() => void> {
    this.retiring.set(sessionId, (this.retiring.get(sessionId) ?? 0) + 1);
    const release = (): void => { const count = this.retiring.get(sessionId) ?? 0; if (count <= 1) this.retiring.delete(sessionId); else this.retiring.set(sessionId, count - 1); };
    const jobs = [...this.running].filter(job => job.sessionId === sessionId);
    for (const job of jobs) job.controller.abort();
    try { await this.drain(jobs); return release; } catch (error) { release(); throw error; }
  }
  invalidate(): void { this.generation++; for (const job of this.running) job.controller.abort(); this.retiringOwners.clear(); }
  async close(): Promise<void> { this.closed = true; this.invalidate(); await this.drain([...this.running]); }
}

/** The cancellation ACK only admits cancellation; the original terminal outcome proves it settled. */
export async function querySideQuestion(client: EngineClientLike, sessionId: string, question: SideQuestionInput, signal: AbortSignal, timeoutMs = 120_000): Promise<{ response: string }> {
  if (signal.aborted) throw cancelled();
  const submissionId = `sq-${randomUUID()}`;
  let cancellation: Promise<void> | undefined, timedOut = false, terminal = false;
  const cancel = (): Promise<void> => cancellation ??= (async () => {
    if (client.isClosed()) return;
    const ack = object(await client.requestWithTimeout('session/cancelRequest', { sessionId, requestId: submissionId }, 15_000));
    if (typeof ack?.submissionId !== 'string' || !ack.submissionId || ack.error != null) throw new Error('The engine did not acknowledge side-question cancellation');
  })().catch(() => { if (!client.isClosed()) throw new IpcHandlerError('CANCEL_FAILED', 'The engine could not confirm side-question cancellation'); });
  const receive = (event: ClientEvent): void => {
    if (event.type === 'streamClosed') { terminal = true; return; }
    if (event.type !== 'engineEvent' && event.type !== 'rawSessionEvent') return;
    const outer = object(event.params), envelope = object(outer?.event) ?? outer;
    if ((envelope?.submissionId ?? envelope?.id) === submissionId && (typeof envelope?.error === 'string' || envelope?.sideQuestion != null)) terminal = true;
  };
  client.on('event', receive);
  // Submit first: cancellation must follow registration in the facade's FIFO.
  const observed = {
    on:client.on.bind(client),off:client.off.bind(client),
    requestWithTimeout:async (method:string,params:Json,timeout:number):Promise<unknown> => {
      try {
        const reply=await client.requestWithTimeout(method,params,timeout);
        if(object(reply)?.error != null)terminal=true;
        return reply;
      } catch(error) { if(object(error)?.kind==='server')terminal=true;throw error; }
    },
  };
  const answer = requestAcknowledged(observed, 'session/sideQuestion', { sessionId, question, submissionId }, 'sideQuestion', timeoutMs + 15_000);
  const abort = (): void => { void cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    let value: unknown;
    try { value = await answer; terminal = true; }
    catch (error) {
      terminal ||= client.isClosed();
      if (cancellation) await cancellation;
      if (signal.aborted && terminal) throw cancelled();
      if (timedOut && terminal) throw new IpcHandlerError('REQUEST_TIMEOUT', 'The side question timed out and was cancelled');
      throw error;
    }
    if (cancellation) await cancellation;
    if (signal.aborted) throw cancelled();
    if (timedOut) throw new IpcHandlerError('REQUEST_TIMEOUT', 'The side question timed out and was cancelled');
    const response = object(value)?.response;
    if (typeof response !== 'string') throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no side-question response');
    return { response };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); client.off('event', receive);
    if (!terminal && !client.isClosed()) { await cancel(); throw new IpcHandlerError('CANCEL_FAILED', 'The engine did not finish the cancelled side question'); }
  }
}
