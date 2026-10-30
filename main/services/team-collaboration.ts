import { requireInterruptConfirmation } from '../sessions/turn-interrupt';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CollaborationExecution, CollaborationRequest } from '../../contracts/team-collaboration';
import type { ClientEvent } from '../engine/protocol';
import { IpcHandlerError } from '../ipc/registry';
import { CollaborationCloud, CollaborationHttpError, id, invitationUrl, record, validateRequest, type AccountScope } from './team-collaboration/cloud';
import { CollaborationStore, type ExecutionJournal } from './team-collaboration/store';
import { CollaborationFiles, safeFileName, uploadBytes } from './team-collaboration/files';
import { executionContext, publicResponse } from './team-collaboration/execution';
import { CollaborationAgents } from './team-collaboration/agents';
import type { DesktopCollaborationResponse, DraftOptions, ExecuteOptions, ExecutionReply, IssueDraft, IssueDraftOptions, LocalBinding, ProjectDraft, TeamCollaborationDeps } from './team-collaboration/types';
import { prepareDraftInput } from './team-collaboration/draft-attachments';
export type { DraftOptions, ExecuteOptions, ExecutionReply, LocalBinding, ProjectDraft, TeamCollaborationDeps } from './team-collaboration/types';

const terminal = (status: CollaborationExecution['status']) => ['completed', 'failed', 'cancelled'].includes(status);
const safeFailure = 'The local execution failed or was interrupted. Open its chat on the originating device for details.';
interface DraftJob {
  ownerId: number;
  requestId: string;
  controller: AbortController;
  started: boolean;
  done: Promise<ProjectDraft | IssueDraft>;
}
interface ExecutionJob {
  row: ExecutionJournal;
  scope: AccountScope;
  controller: AbortController;
  ready: Promise<ExecutionReply>;
  done: Promise<void>;
  result?: CollaborationExecution['status'];
  submissionId?: string;
  interruption?: Promise<void>;
  interruptTurnId?: string;
  settled?: boolean;
}

import { draftInstruction, issueDraftInstruction, parseIssueDraft, parseProjectDraft } from './team-collaboration/draft';
import { modelSource } from './session-store';
export { parseProjectDraft } from './team-collaboration/draft';

/** Cloud collaboration and device-local execution meet here, never in the renderer. */
export class TeamCollaborationService {
  readonly store: CollaborationStore;
  readonly cloud: CollaborationCloud;
  readonly files: CollaborationFiles;
  readonly agents: CollaborationAgents;
  private readonly drafts = new Map<string, DraftJob>();
  private readonly executions = new Map<string, ExecutionJob>();
  private readonly synchronizing = new Map<string, Promise<void>>();
  private readonly launches = new Map<string, Promise<ExecutionReply>>();
  private readonly launchFingerprints = new Map<string, string>();
  private closed = false;
  private started = false;
  private timer?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly deps: TeamCollaborationDeps) {
    this.store = new CollaborationStore(deps.configRoot);
    this.cloud = new CollaborationCloud(deps, this.store, () => this.accountChanged(), projectId => {
      for (const job of this.executions.values()) if (projectId === null || job.row.projectId === projectId) this.stopExecution(job, true);
    });
    this.files = new CollaborationFiles(this.cloud, deps);
    this.agents = new CollaborationAgents(deps);
  }
  start(): void {
    this.cloud.updateAccount();
    this.started = true;
    if (!this.gateEnabled()) return; // gated off: no background watch/reconcile
    try { this.cloud.watchAccount(); } catch {}
    this.timer ??= setInterval(() => { void this.reconcile().catch(error => this.deps.log(`Reconciliation failed: ${record(error).code ?? 'network'}`)); }, this.deps.reconcileMs ?? 5000);
    this.timer.unref();
    void this.recover().catch(() => {});
  }
  accountChanged(): void {
    for (const job of this.drafts.values()) job.controller.abort();
    for (const job of this.executions.values()) this.stopExecution(job, true);
    if (!this.closed) queueMicrotask(() => {
      if (this.started && this.gateEnabled()) try { this.cloud.watchAccount(); } catch {}
      if (this.gateEnabled()) void this.recover().catch(() => {});
    });
  }
  refreshAccount(): void { this.cloud.updateAccount(); }
  /** The server resolved a new gate value. Opening (re)attaches the background
   *  watch; closing tears it down so a gated-off account holds no SSE stream and
   *  publishes no spurious 'forbidden' state. The IPC surface refuses on the
   *  gate independently, so this only governs background traffic. */
  refreshGate(): void {
    if (this.closed || !this.started) return;
    if (this.gateEnabled()) {
      try { this.cloud.watchAccount(); } catch {}
      if (!this.timer) {
        this.timer = setInterval(() => { void this.reconcile().catch(error => this.deps.log(`Reconciliation failed: ${record(error).code ?? 'network'}`)); }, this.deps.reconcileMs ?? 5000);
        this.timer.unref();
      }
      void this.recover().catch(() => {});
    } else {
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      // Tear down background SSE only; running local executions are left to
      // finish on their own. A mid-session flag flip must not kill agent turns
      // — the IPC surface already refuses NEW operations, and the server's own
      // gate rejects their next sync.
      this.cloud.suspendWatches();
    }
  }
  private gateEnabled(): boolean { return this.deps.gateEnabled?.() ?? true; }
  private key(accountId: string, key: string): string { return JSON.stringify([accountId, key]); }
  private stopExecution(job: ExecutionJob, blockSync = false): void {
    job.result = 'cancelled';
    if (blockSync) {
      job.row.syncBlocked = true; job.row.syncPending = false; job.row.status = 'cancelled';
      delete job.row.finalResponse; this.store.save(job.row);
    }
    job.controller.abort();
    void this.interruptOwned(job).catch(error => this.deps.log(`Execution cancellation failed: ${record(error).code ?? 'CANCEL_FAILED'}`));
  }
  private interruptOwned(job: ExecutionJob): Promise<void> {
    if (job.settled || !job.row.sessionId || !job.row.turnId) return Promise.resolve();
    if (job.interruptTurnId === job.row.turnId) return job.interruption ?? Promise.resolve();
    job.interruptTurnId = job.row.turnId;
    job.interruption = this.deps.sessions.interrupt(job.row.sessionId, job.row.turnId, 'targeted-turn').then(result => {
      requireInterruptConfirmation(result);
      if (record(result).accepted === false && !job.settled) throw new IpcHandlerError('CANCEL_FAILED', 'The engine refused the exact collaboration turn interruption');
    });
    return job.interruption;
  }
  private accessLost(error: unknown): boolean {
    return error instanceof CollaborationHttpError && [401, 403, 404].includes(error.status)
      || error instanceof IpcHandlerError && ['ACCOUNT_CHANGED', 'NOT_AUTHENTICATED', 'FORBIDDEN', 'EXECUTION_NOT_LOCAL'].includes(error.code);
  }
  private blockSync(row: ExecutionJournal, error: unknown): void {
    if (!this.accessLost(error)) return;
    row.syncBlocked = true; row.syncPending = false; delete row.finalResponse; this.store.save(row);
    const job = this.executions.get(this.key(row.accountId, row.key));
    if (job) this.stopExecution(job, true);
  }

  async request<R extends CollaborationRequest>(input: R): Promise<DesktopCollaborationResponse<R['type']>> {
    const request = validateRequest(input);
    if (request.type === 'agents.register' && request.runtimeReference) await this.agents.resolve(request.runtimeReference);
    if (request.type === 'agents.update' && request.patch.runtimeReference) await this.agents.resolve(request.patch.runtimeReference);
    if (request.type === 'files.upload') { safeFileName(request.name); uploadBytes(request.dataBase64); }
    if (request.type === 'discussion-messages.send' && ['agentId', 'executionId', 'authorId', 'authorMemberId', 'source'].some(key => Object.hasOwn(request, key))) {
      throw new IpcHandlerError('HOST_OWNED_OPERATION', 'Agent replies must originate from a verified local execution');
    }
    if (request.type === 'executions.create' || request.type === 'executions.update' || request.type === 'executions.complete') {
      throw new IpcHandlerError('HOST_OWNED_OPERATION', 'Use execute to start a real local agent; execution records are maintained by the host');
    }
    if (request.type === 'executions.cancel') return await this.cancelExecution(request) as DesktopCollaborationResponse<R['type']>;
    const scope = this.cloud.scope();
    const result = await this.cloud.request(input, scope);
    scope.current();
    if (request.type === 'project-invitations.create') {
      const { token: _token, ...invitation } = record(result);
      return { ...invitation, joinPath: invitationUrl(invitation.joinPath, this.cloud.baseUrl) } as DesktopCollaborationResponse<R['type']>;
    }
    if (request.type === 'projects.get') this.cloud.watch(request.projectId);
    return result as DesktopCollaborationResponse<R['type']>;
  }
  watch(projectId: string | null): { watching: string | null } {
    this.cloud.watch(projectId); return { watching: projectId };
  }
  async localBinding(projectId: string): Promise<LocalBinding> {
    id(projectId, 'projectId');
    const scope = this.cloud.scope();
    await this.cloud.request({ type: 'projects.get', projectId }, scope);
    scope.current();
    return { projectId, localFolder: this.store.binding(scope.account.id, projectId) };
  }
  private async directory(folder: unknown): Promise<string> {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0') || folder.startsWith('ssh://')) throw new IpcHandlerError('INVALID_DIRECTORY', 'Choose an absolute directory on this device');
    try {
      const path = await realpath(folder);
      if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      return path;
    } catch { throw new IpcHandlerError('DIRECTORY_UNAVAILABLE', 'The selected local directory is missing or inaccessible'); }
  }
  async setLocalBinding(projectId: string, localFolder: string | null): Promise<LocalBinding> {
    id(projectId, 'projectId');
    const scope = this.cloud.scope();
    await this.cloud.request({ type: 'projects.get', projectId }, scope);
    const folder = localFolder === null ? null : await this.directory(localFolder);
    scope.current();
    this.store.bind(scope.account.id, projectId, folder);
    return { projectId, localFolder: folder };
  }
  async pickLocalFolder(projectId: string): Promise<LocalBinding> {
    const scope = this.cloud.scope();
    const previous = await this.localBinding(projectId);
    const folder = await this.deps.pickDirectory();
    scope.current();
    return folder === null ? previous : this.setLocalBinding(projectId, folder);
  }
  draftProject(prompt: string, options: DraftOptions, ownerId: number): Promise<ProjectDraft> {
    return this.draft(prompt, options, ownerId, 'Team project draft', draftInstruction(prompt, options), response => parseProjectDraft(response, options.requestId, options));
  }
  draftIssue(prompt: string, options: IssueDraftOptions, ownerId: number): Promise<IssueDraft> {
    return this.draft(prompt, options, ownerId, 'Team issue draft', issueDraftInstruction(prompt, options), response => parseIssueDraft(response, options.requestId));
  }
  private draft<T extends ProjectDraft | IssueDraft>(prompt: string, options: DraftOptions | IssueDraftOptions, ownerId: number, title: string, instruction: string, parse: (response: string) => T): Promise<T> {
    const scope = this.cloud.scope();
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50_000) throw new IpcHandlerError('BAD_REQUEST', 'Describe the draft in 1–50000 characters');
    const requestId = id(options.requestId, 'requestId');
    if ((options.context !== undefined && (typeof options.context !== 'string' || options.context.length > 50_000))
      || (options.model !== undefined && (typeof options.model !== 'string' || options.model.length > 256))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid draft context or model');
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new IpcHandlerError('BAD_REQUEST', 'A draft must belong to its window');
    const key = this.key(String(ownerId), requestId);
    if (this.drafts.has(key) || this.drafts.size >= 8) throw new IpcHandlerError('DRAFT_BUSY', 'This draft is already running or too many drafts are active');
    const job: DraftJob = { ownerId, requestId, controller: new AbortController(), started: false, done: Promise.resolve(null as unknown as ProjectDraft) };
    this.drafts.set(key, job);
    const identity = { ownerId, requestId: `collaboration-draft:${requestId}` };
    job.done = (async () => {
      let sessionId: string | undefined;
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => { if (job.started) cancellation ??= this.deps.sessions.cancelSideQuestion(identity); void cancellation?.catch(() => {}); };
      const signal = AbortSignal.any([scope.signal, job.controller.signal]);
      signal.addEventListener('abort', cancel);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, this.deps.draftTimeoutMs ?? 180_000);
      try {
        await this.validateModel(options.model);
        scope.current(); signal.throwIfAborted();
        const question = await prepareDraftInput(instruction, options.attachments, signal);
        scope.current(); signal.throwIfAborted();
        const row = record(await this.deps.sessions.newSession({ workdir: null, title, collaborationMode: 'plan',
          ...(options.model && options.model !== 'auto' ? { modelOverride: options.model } : {}) }));
        sessionId = id(row.id, 'draft session');
        scope.current(); signal.throwIfAborted();
        if (options.model && options.model !== 'auto') await this.deps.configureSessionModel(sessionId, options.model);
        scope.current(); signal.throwIfAborted();
        job.started = true;
        const answer = await this.deps.sessions.sideQuestion(sessionId, question, identity);
        scope.current(); signal.throwIfAborted();
        return parse(answer.response);
      } catch (error) {
        if (signal.aborted && !(error instanceof IpcHandlerError && ['CANCEL_FAILED', 'ACCOUNT_CHANGED'].includes(error.code))) {
          throw new IpcHandlerError(timedOut ? 'REQUEST_TIMEOUT' : 'ABORTED', timedOut ? 'Draft generation timed out' : 'Draft generation was cancelled');
        }
        throw error;
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        try { if (cancellation) await cancellation; }
        finally {
          try { if (sessionId) await this.deps.sessions.deleteSession(sessionId, false); }
          finally { this.drafts.delete(key); }
        }
      }
    })();
    void job.done.catch(() => {});
    return job.done as Promise<T>;
  }
  async cancelDraft(requestId: string, ownerId: number): Promise<{ cancelled: boolean }> {
    const job = this.drafts.get(this.key(String(ownerId), id(requestId, 'requestId')));
    if (!job) return { cancelled: false };
    job.controller.abort();
    try { await job.done; } catch (error) {
      if (error instanceof IpcHandlerError && error.code === 'CANCEL_FAILED') throw error;
    }
    return { cancelled: true };
  }
  async detachOwner(ownerId: number): Promise<void> {
    await Promise.all([...this.drafts.values()].filter(job => job.ownerId === ownerId).map(job => this.cancelDraft(job.requestId, ownerId)));
  }

  private async validateModel(model?: string): Promise<void> {
    if (!model || model === 'auto') return;
    const source = modelSource(model);
    if (!source || !(await this.deps.modelOptions(source)).some(option => record(option).value === model)) {
      throw new IpcHandlerError('INVALID_MODEL', 'Choose an available model from the model catalog');
    }
  }

  execute(input: ExecuteOptions): Promise<ExecutionReply> {
    if (this.closed) throw new IpcHandlerError('HOST_CLOSED', 'Team collaboration is closing');
    const scope = this.cloud.scope();
    if (input.projectId != null) id(input.projectId, 'projectId');
    if (input.issueId) id(input.issueId, 'issueId');
    if (input.discussionId) { id(input.discussionId, 'discussionId'); id(input.messageId, 'messageId'); }
    id(input.agentId, 'agentId'); id(input.idempotencyKey, 'idempotencyKey');
    if (!input.issueId && !input.discussionId || input.issueId && !input.projectId) throw new IpcHandlerError('BAD_REQUEST', 'Choose an issue or discussion for this execution');
    if (input.localFolderConfirmed !== true || input.issueId && (!Number.isSafeInteger(input.issueVersion) || input.issueVersion! < 1)
      || input.discussionVersion !== undefined && (!Number.isSafeInteger(input.discussionVersion) || input.discussionVersion < 1)) {
      throw new IpcHandlerError('CONFIRMATION_REQUIRED', 'Confirm this device’s directory and the current collaboration context before running an agent');
    }
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 20_000)) throw new IpcHandlerError('BAD_REQUEST', 'Execution prompt is too long');
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 256)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid execution model');
    const key = this.key(scope.account.id, input.idempotencyKey);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.projectId, input.issueId, input.issueVersion, input.discussionId, input.discussionVersion,
      input.messageId, input.agentId, input.prompt ?? '', input.model ?? '', input.workingDirectory ?? ''])).digest('hex');
    const saved = this.store.journal(scope.account.id, input.idempotencyKey);
    if (saved && saved.fingerprint !== fingerprint) throw new IpcHandlerError('IDEMPOTENCY_CONFLICT', 'The execution key was already used for different input');
    const launch = this.launches.get(key);
    if (launch) {
      if (this.launchFingerprints.get(key) !== fingerprint) throw new IpcHandlerError('IDEMPOTENCY_CONFLICT', 'The execution key is already being used for different input');
      return launch;
    }
    const promise = this.launch(input, scope, fingerprint, key);
    this.launches.set(key, promise);
    this.launchFingerprints.set(key, fingerprint);
    void promise.finally(() => { if (this.launches.get(key) === promise) { this.launches.delete(key); this.launchFingerprints.delete(key); } }).catch(() => {});
    return promise;
  }
  private async launch(input: ExecuteOptions, scope: AccountScope, fingerprint: string, key: string): Promise<ExecutionReply> {
    const context = await executionContext(this.cloud, input, scope);
    const { project, issue, discussion, prompt } = context;
    scope.current();
    if (this.closed) throw new IpcHandlerError('HOST_CLOSED', 'Team collaboration is closing');
    const agent = await this.agents.resolve(context.member.agent!.runtimeReference);
    const model = input.model && input.model !== 'auto' ? input.model
      : typeof agent.definition?.model === 'string' && modelSource(agent.definition.model) ? agent.definition.model : undefined;
    await this.validateModel(model);
    let row = this.store.journal(scope.account.id, input.idempotencyKey);
    if (row) {
      if (row.fingerprint !== fingerprint) throw new IpcHandlerError('IDEMPOTENCY_CONFLICT', 'The execution key was already used');
      const running = this.executions.get(key);
      if (running) return running.ready;
      if (!terminal(row.status)) { row.status = 'failed'; row.syncPending = true; this.store.save(row); }
      await this.sync(row, scope);
      if (!row.execution) throw new IpcHandlerError('EXECUTION_UNAVAILABLE', 'The previous execution could not be recovered');
      return this.reply(row);
    }
    const folder = input.projectId ? this.store.binding(scope.account.id, input.projectId) : input.workingDirectory;
    if (!folder) throw new IpcHandlerError('DIRECTORY_UNBOUND', 'Bind and confirm a local project directory before running an agent');
    if (input.projectId && input.workingDirectory && folder !== input.workingDirectory) throw new IpcHandlerError('DIRECTORY_CHANGED', 'The confirmed directory no longer matches this project');
    const directory = await this.directory(folder);
    scope.current();
    if (directory !== folder) throw new IpcHandlerError('DIRECTORY_CHANGED', 'The local directory changed. Bind it again before running an agent');
    row = { accountId: scope.account.id, key: input.idempotencyKey, projectId: input.projectId ?? null, fingerprint,
      createRequest: { type: 'executions.create', projectId: input.projectId, issueId: input.issueId, discussionId: input.discussionId,
        discussionVersion: input.discussionVersion, agentId: input.agentId,
        prompt: publicResponse(prompt, [directory, this.deps.configRoot, scope.account.token]), idempotencyKey: input.idempotencyKey, ownerConfirmed: true },
      execution: null, sessionId: null, turnId: null, status: 'pending', syncPending: true };
    this.store.save(row);
    const execution = await this.cloud.request(row.createRequest, scope);
    scope.current();
    if (execution.ownerId !== scope.account.id || execution.requestedBy !== scope.account.id || execution.agentId !== input.agentId) throw new IpcHandlerError('AGENT_NOT_OWNED', 'The server refused local ownership of this execution');
    row.execution = execution;
    this.store.save(row);
    // A cloud record already started elsewhere is never replayed on this device.
    if (execution.status !== 'pending' || execution.sessionId) {
      row.status = execution.status; row.syncPending = false; this.store.save(row);
      return this.reply(row);
    }
    // Claim with optimistic concurrency before creating a session. A second device
    // with the same idempotency key must lose this CAS and must never dispatch a turn.
    try {
      row.execution = await this.cloud.request({ type: 'executions.update', projectId: row.projectId,
        executionId: execution.id, version: execution.version, status: 'running' }, scope);
      row.status = 'running'; row.syncPending = false; this.store.save(row);
    } catch (error) {
      row.status = 'failed';
      row.syncPending = !(error instanceof CollaborationHttpError && [403, 404, 409].includes(error.status));
      this.store.save(row);
      throw error;
    }
    let readyResolve!: (reply: ExecutionReply) => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<ExecutionReply>((yes, no) => { readyResolve = yes; readyReject = no; });
    void ready.catch(() => {});
    const job: ExecutionJob = { row, scope, controller: new AbortController(), ready, done: Promise.resolve() };
    if (this.closed) job.controller.abort();
    this.executions.set(key, job);
    job.done = (async () => {
      const signal = AbortSignal.any([scope.signal, job.controller.signal]);
      try {
        const latest = await executionContext(this.cloud, input, scope);
        scope.current(); signal.throwIfAborted();
        if (latest.prompt !== context.prompt) throw new IpcHandlerError('CONFLICT', 'The collaboration message changed while starting; review it again');
        const latestAgent = await this.agents.resolve(latest.member.agent!.runtimeReference);
        if (latestAgent.runtimeReference !== agent.runtimeReference || latestAgent.definitionHash !== agent.definitionHash) throw new IpcHandlerError('CONFLICT', 'The selected local agent changed while starting; review it again');
        const agentProfile = { name: agent.name, ...(agent.definition ? { definition: model ? { ...agent.definition, model: 'inherit' } : agent.definition } : {}) };
        const session = record(await this.deps.sessions.newSession({ workdir: null, localWorkdir: directory, title: context.title.slice(0, 300),
          agentProfile, ...(model ? { modelOverride: model } : {}),
          hostMetadata: { collaboration: { projectId: project?.id ?? null, issueId: issue?.id ?? null, discussionId: discussion?.id ?? null, executionId: execution.id, accountId: scope.account.id } } }));
        row!.sessionId = id(session.id, 'sessionId'); this.store.save(row!);
        scope.current(); signal.throwIfAborted();
        await this.directory(directory); scope.current(); signal.throwIfAborted();
        this.deps.bindSessionDirectory(row!.sessionId, directory);
        if (model) await this.deps.configureSessionModel(row!.sessionId, model);
        scope.current(); signal.throwIfAborted();
        row!.status = 'running'; row!.syncPending = true; this.store.save(row!);
        await this.sync(row!, scope);
        scope.current(); signal.throwIfAborted();
        if (row!.execution?.status !== 'running') throw new IpcHandlerError('EXECUTION_CANCELLED', 'The cloud execution is no longer running');
        const answer = this.deps.sessions.sendAndWait(row!.sessionId, { text: prompt }, signal);
        void answer.catch(() => {});
        readyResolve(this.reply(row!));
        const result = await answer;
        job.settled = true;
        row!.status = job.result ?? (signal.aborted ? 'cancelled' : 'completed');
        if (row!.status === 'completed') row!.finalResponse = publicResponse(result.reply, [directory, this.deps.configRoot, scope.account.token]);
      } catch (error) {
        row!.status = signal.aborted || job.result === 'cancelled' ? 'cancelled' : 'failed';
        readyReject(error);
        this.deps.log(`Execution ${execution.id} ended locally (${row!.status})`);
      } finally {
        try {
          if (signal.aborted) await this.interruptOwned(job);
        } catch (error) {
          row!.status = 'failed';
          row!.cancellationFailed = true;
          this.deps.log('The local collaboration turn did not confirm cancellation');
          try { scope.current(); this.cloud.publish({ kind: 'connection', accountId: row!.accountId, projectId: row!.projectId, state: 'reconnecting',
            error: 'The local agent did not confirm cancellation. Open its execution chat to check its status.' }); } catch {}
          throw error;
        } finally {
          row!.syncPending = !row!.syncBlocked; this.store.save(row!);
          try { if (row!.syncPending) await this.sync(row!, scope); } catch (error) { this.blockSync(row!, error); }
          this.publish(row!, scope);
          this.executions.delete(key);
        }
      }
    })();
    void job.done.catch(() => {});
    return ready;
  }
  private reply(row: ExecutionJournal): ExecutionReply {
    if (!row.execution) throw new IpcHandlerError('EXECUTION_UNAVAILABLE', 'The execution has not been acknowledged by the server');
    return { execution: row.execution, sessionId: row.sessionId, turnId: row.turnId };
  }
  private publish(row: ExecutionJournal, scope: AccountScope): void {
    try {
      scope.current();
      this.cloud.publish({ kind: 'execution', accountId: row.accountId, projectId: row.projectId, executionId: row.execution!.id,
        sessionId: row.sessionId, turnId: row.turnId, status: row.status, syncPending: row.syncPending });
    } catch { /* An old account must not publish into the new account's window. */ }
  }
  private sync(row: ExecutionJournal, scope: AccountScope): Promise<void> {
    const key = this.key(row.accountId, row.key), existing = this.synchronizing.get(key);
    if (existing) return existing.then(() => row.syncPending ? this.sync(row, scope) : undefined);
    const promise = this.syncNow(row, scope).finally(() => { this.synchronizing.delete(key); });
    this.synchronizing.set(key, promise);
    return promise;
  }
  private async syncNow(row: ExecutionJournal, scope: AccountScope): Promise<void> {
    if (row.syncBlocked) return;
    scope.current();
    if (scope.account.id !== row.accountId) throw new IpcHandlerError('ACCOUNT_CHANGED', 'Execution belongs to a different account');
    if (!row.execution) row.execution = await this.cloud.request(row.createRequest, scope);
    let current = row.execution;
    if (current.ownerId !== row.accountId || current.requestedBy !== row.accountId) throw new IpcHandlerError('FORBIDDEN', 'Execution is not owned by this account');
    if (current.sessionId && current.sessionId !== row.sessionId) {
      row.syncPending = false; this.store.save(row);
      throw new IpcHandlerError('EXECUTION_NOT_LOCAL', 'This execution belongs to another local chat or device');
    }
    if (terminal(current.status)) {
      row.status = row.cancellationFailed ? 'failed' : current.status; row.syncPending = false; this.store.save(row);
      const job = this.executions.get(this.key(row.accountId, row.key));
      if (job && !job.settled) this.stopExecution(job);
      return;
    }
    if (!row.syncPending) return;
    const status = row.status;
    if (status === 'pending') return;
    try {
      if (status === 'completed' && (current.sessionId !== row.sessionId || current.turnId !== row.turnId)) {
        current = await this.cloud.request({ type: 'executions.update', projectId: row.projectId, executionId: current.id, version: current.version,
          status: 'running', ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.turnId ? { turnId: row.turnId } : {}) }, scope);
        row.execution = current; this.store.save(row);
      }
      current = status === 'cancelled'
        ? await this.cloud.request({ type: 'executions.cancel', projectId: row.projectId, executionId: current.id, version: current.version }, scope)
        : status === 'completed'
        ? await this.cloud.request({ type: 'executions.complete', projectId: row.projectId, executionId: current.id, version: current.version, resultText: row.finalResponse ?? '' }, scope)
        : await this.cloud.request({ type: 'executions.update', projectId: row.projectId, executionId: current.id, version: current.version, status,
          ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.turnId ? { turnId: row.turnId } : {}),
          ...(status === 'failed' ? { error: safeFailure } : {}),
        }, scope);
    } catch (error) {
      if (error instanceof CollaborationHttpError && error.status === 409) {
        const page = await this.cloud.request({ type: 'executions.list', projectId: row.projectId, issueId: row.createRequest.issueId, discussionId: row.createRequest.discussionId, agentId: row.createRequest.agentId, limit: 100 }, scope);
        const latest = page.items.find(item => item.id === current.id);
        if (latest) { row.execution = latest; this.store.save(row); }
      }
      throw error;
    }
    row.execution = current;
    row.syncPending = row.status !== status;
    this.store.save(row);
    this.publish(row, scope);
  }
  private recover(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.recovery ??= (async () => {
      const scope = this.cloud.scope();
      for (const row of this.store.journals(scope.account.id)) {
        if (this.executions.has(this.key(row.accountId, row.key)) || this.launches.has(this.key(row.accountId, row.key))) continue;
        if (row.syncBlocked) continue;
        if (!terminal(row.status)) { row.status = 'failed'; row.syncPending = true; this.store.save(row); }
        if (row.syncPending) try { await this.sync(row, scope); } catch (error) { this.blockSync(row, error); }
      }
    })().finally(() => { this.recovery = undefined; });
  }
  private async reconcile(): Promise<void> {
    if (this.closed || !this.gateEnabled()) return;
    this.cloud.updateAccount();
    await this.recover();
    for (const job of this.executions.values()) {
      try {
        job.scope.current();
        const page = await this.cloud.request({ type: 'executions.list', projectId: job.row.projectId, issueId: job.row.createRequest.issueId, discussionId: job.row.createRequest.discussionId, agentId: job.row.createRequest.agentId, limit: 100 }, job.scope);
        const current = page.items.find(item => item.id === job.row.execution?.id);
        if (current) {
          job.row.execution = current;
          if (terminal(current.status)) this.stopExecution(job);
          else if (job.row.syncPending) await this.sync(job.row, job.scope);
        }
      } catch (error) {
        if (this.accessLost(error)) {
          this.stopExecution(job, true);
          this.publish(job.row, job.scope);
          try { job.scope.current(); this.cloud.publish({ kind: 'connection', accountId: job.row.accountId, projectId: job.row.projectId, state: 'forbidden', error: 'Access to this execution was revoked; the local turn was stopped.' }); } catch {}
        }
      }
    }
  }
  private async cancelExecution(input: Extract<CollaborationRequest, { type: 'executions.cancel' }>): Promise<CollaborationExecution> {
    const scope = this.cloud.scope();
    const result = await this.cloud.request(input, scope);
    scope.current();
    const job = [...this.executions.values()].find(item => item.row.accountId === scope.account.id && item.row.execution?.id === result.id);
    if (job) {
      job.row.execution = result; this.stopExecution(job); await job.done;
      await job.interruption;
    }
    return result;
  }
  observeEngine(event: ClientEvent): void {
    if (event.type !== 'productEvent' && event.type !== 'turnCompleted') return;
    const params = record(event.params), rendererId = this.deps.rendererId(String(params.sessionId ?? ''));
    const job = [...this.executions.values()].find(item => item.row.sessionId === rendererId && rendererId);
    if (!job) return;
    const detail = record(params.detail);
    if (event.type === 'productEvent' && event.method === 'turn/started' && typeof params.submissionId === 'string') job.submissionId = params.submissionId;
    const turnId = event.type === 'productEvent' && event.method === 'turn/started' ? detail.turnId ?? params.turnId ?? params.submissionId : params.turnId ?? params.submissionId;
    if (typeof turnId === 'string' && !job.row.turnId) {
      job.row.turnId = turnId; job.row.syncPending = !job.row.syncBlocked; this.store.save(job.row);
      this.publish(job.row, job.scope);
      if (job.controller.signal.aborted || job.scope.signal.aborted) void this.interruptOwned(job).catch(() => {});
    }
    if (turnId !== job.row.turnId && turnId !== job.submissionId) return;
    if (event.type === 'turnCompleted') {
      job.settled = true;
      const result = record(params.result);
      if (result.stopReason === 'aborted' || result.stopReason === 'cancelled') job.result = 'cancelled';
      else if (result.error != null) job.result = 'failed';
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; if (this.timer) clearInterval(this.timer);
      for (const job of this.drafts.values()) job.controller.abort();
      for (const job of this.executions.values()) this.stopExecution(job);
      await Promise.allSettled([...this.launches.values()]);
      await Promise.allSettled([...this.drafts.values()].map(job => job.done));
      const outcomes = await Promise.allSettled([...this.executions.values()].flatMap(job => [job.done, job.interruption ?? Promise.resolve()]));
      await this.cloud.close();
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw new IpcHandlerError('CANCEL_FAILED', 'A collaboration execution did not confirm its cancellation');
    })();
  }
}
