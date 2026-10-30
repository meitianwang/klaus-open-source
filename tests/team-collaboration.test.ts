import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { CollaborationExecution, CollaborationRequest } from '../contracts/team-collaboration';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerTeamCollaborationHandlers, TEAM_COLLABORATION_CHANNELS } from '../main/ipc/handlers/team-collaboration';
import { TeamCollaborationService, parseProjectDraft } from '../main/services/team-collaboration';
import { CollaborationCloud, record } from '../main/services/team-collaboration/cloud';
import { CollaborationStore } from '../main/services/team-collaboration/store';
import type { CollaborationAccount, CollaborationUpdate, ExecuteOptions, TeamCollaborationDeps } from '../main/services/team-collaboration/types';
import { bindSessionWorkdir, readSessionModel, sessionWorkdir } from '../main/services/session-store';
import { bindCollaborationModel } from '../main/services/team-collaboration/model';
import { kvSet, kvGet } from '../main/services/settings';
import { WorkspaceStore } from '../main/services/workspaces';
import { querySideQuestion } from '../main/sessions/side-questions';
import type { EngineClientLike } from '../main/sessions/service';
import type { ClientEvent } from '../main/engine/protocol';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Json } from '../main/ipc/contract';
import { invitationUrl } from '../main/services/team-collaboration/cloud';
import { uploadBytes, COLLABORATION_FILE_LIMIT } from '../main/services/team-collaboration/files';
import { applySessionAgent, assertSessionAgent, bindSessionAgent, sessionAgent } from '../main/services/session-agent';
import { publicResponse } from '../main/services/team-collaboration/execution';
import { draftInstruction, parseIssueDraft } from '../main/services/team-collaboration/draft';
import { bmpToPng, prepareDraftInput, extractDraftDocument, DRAFT_ATTACHMENT_LIMIT } from '../main/services/team-collaboration/draft-attachments';
import { parseDeepLink, teamIssueDeepLink } from '../main/app/deep-links';
import { PNG_FIXTURE_BASE64, PDF_FIXTURE } from './fixtures/media';

const projectId = 'project-1', issueId = 'issue-1', agentId = 'agent-1';
const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/vectors/team-collaboration-vectors.json'), 'utf8')) as {
  draftFields: string[]; validRepositoryUrls: string[]; invalidRepositoryUrls: string[]; invalidInvitationLinks: string[]; rendererForbiddenOperations: string[]; fileMaximumBytes: number;
  draftAttachmentMaximumBytes: number; draftAttachmentMaximumCount: number; issueDraftFields: string[]; issueDeepLinkPrefix: string;
};
const draft = { patch: { name: 'Test project', description: 'Actual generated answer', repositoryUrl: 'https://github.com/example/project' }, explanation: 'Updated the project name and repository.' };
const waitFor = async (check: () => boolean, detail: string) => {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${detail}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function fixture(extra: Partial<TeamCollaborationDeps> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'klaus-collaboration-')));
  const directory = join(root, 'repository'); mkdirSync(directory);
  let account: CollaborationAccount | null = { id: 'alice', token: 'alice-secret' };
  let expired = 0, responseStatus = 200, foreignAgent = false, issueVersion = 1, discussionVersion = 1;
  const discussionId = 'discussion-1', messageId = 'message-1';
  const definition = { name: 'Engineer', description: 'Build carefully', prompt: 'Inspect the actual implementation and report actionable findings.', tools: ['read', 'grep'], disallowedTools: ['bash', 'write'] };
  const discussionReplies: string[] = [];
  let claimConflict = false, changeIssueOnCreate = false;
  let block: ReturnType<typeof deferred<void>> | undefined;
  const calls: Array<{ request: CollaborationRequest; authorization: string }> = [];
  const streams: Array<{ url: URL; response: ServerResponse; authorization: string }> = [];
  const executionRows = new Map<string, CollaborationExecution>();
  const fileId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const fileBytes = Buffer.from('Safe file contents');
  const fileMetadata = { id: fileId, scope: { projectId }, name: 'notes.txt', mediaType: 'text/plain', size: fileBytes.length,
    sha256: createHash('sha256').update(fileBytes).digest('hex'), createdBy: 'alice', createdAt: '', downloadPath: 'https://evil.test/credentials' };
  const fileFetches: Array<{ url: string; authorization: string }> = [];
  let joinPath = '/collaboration/join?token=abcdefghijklmnopqrstuvwxyz_1234567890';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (url.pathname === `/api/collaboration/files/${fileId}`) {
        fileFetches.push({ url: req.url!, authorization: req.headers.authorization ?? '' });
        res.writeHead(responseStatus, { 'content-type': 'text/plain' }); res.end(fileBytes); return;
      }
      if (url.pathname === '/api/collaboration/events') {
        if (responseStatus !== 200) {
          res.writeHead(responseStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_project_member', message: 'Membership was removed' } }));
          streams.push({ url, response: res, authorization: req.headers.authorization ?? '' }); return;
        }
        res.writeHead(responseStatus, { 'content-type': 'text/event-stream' });
        res.write(': connected\n\n');
        streams.push({ url, response: res, authorization: req.headers.authorization ?? '' }); return;
      }
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body) as CollaborationRequest;
      calls.push({ request, authorization: req.headers.authorization ?? '' });
      if (block) await block.promise;
      res.setHeader('content-type', 'application/json');
      if (responseStatus !== 200) { res.writeHead(responseStatus); res.end(JSON.stringify({ error: { code: responseStatus === 403 ? 'not_project_member' : 'not_authenticated', message: 'Denied' } })); return; }
      const who = req.headers.authorization === 'Bearer alice-secret' ? 'alice' : 'bob';
      let result: unknown = {};
      switch (request.type) {
        case 'projects.list': result = { items: [], nextCursor: null }; break;
        case 'projects.get': result = { id: request.projectId, name: 'Project', identifier: 'TST', archivedAt: null, role: 'member' }; break;
        case 'project-invitations.create': result = { id: 'invitation-1', projectId, token: 'private-invitation-token', joinPath }; break;
        case 'files.get': result = fileMetadata; break;
        case 'files.upload': result = { ...fileMetadata, name: request.name }; break;
        case 'issues.get': result = { id: issueId, projectId, identifier: 'TST-1', title: 'An issue', description: 'Implement it', version: issueVersion, archivedAt: null }; break;
        case 'project-members.list': result = [{ id: 'agent-member-1', kind: 'agent', agentId, userId: foreignAgent ? 'other-user' : who, agent: { id: agentId, ownerId: foreignAgent ? 'other-user' : who, name: 'Engineer', description: 'Build carefully', runtimeReference: 'local-agent:Engineer' } }]; break;
        case 'discussions.get': result = { id: discussionId, projectId: request.projectId ?? null, title: 'Discuss the feature', description: 'Review the implementation', version: discussionVersion, archivedAt: null }; break;
        case 'discussion-members.list': result = [{ memberId: 'agent-member-1', agentId, userId: foreignAgent ? 'other-user' : who, agent: { id: agentId, ownerId: foreignAgent ? 'other-user' : who, name: 'Engineer', runtimeReference: 'local-agent:Engineer' } }]; break;
        case 'discussion-messages.list': result = { items: [{ id: messageId, discussionId, source: 'human', authorId: who, mentionMemberIds: ['agent-member-1'], content: '@Engineer Please review this feature.' }], nextCursor: null }; break;
        case 'executions.create': {
          if (changeIssueOnCreate) issueVersion++;
          let row = [...executionRows.values()].find(row => row.idempotencyKey === request.idempotencyKey && row.ownerId === who);
          if (!row) {
            row = { id: `execution-${executionRows.size + 1}`, projectId: request.projectId ?? null, issueId: request.issueId ?? null,
              discussionId: request.discussionId ?? null, agentId: request.agentId, ownerId: who, requestedBy: who, prompt: request.prompt,
              status: 'pending', sessionId: null, turnId: null, error: null, result: null, version: 1, idempotencyKey: request.idempotencyKey,
              createdAt: '', updatedAt: '', startedAt: null, finishedAt: null };
            executionRows.set(row.id, row);
          }
          result = row; break;
        }
        case 'executions.update':
        case 'executions.complete':
        case 'executions.cancel': {
          const row = executionRows.get(request.executionId)!;
          if (claimConflict && request.type === 'executions.update' && request.status === 'running' && row.status === 'pending') {
            row.status = 'running'; row.sessionId = 'other-device-session'; row.version++;
            res.writeHead(409); res.end(JSON.stringify({ error: { code: 'version_conflict', message: 'Already claimed', currentVersion: row.version } })); return;
          }
          if (!row || row.ownerId !== who) { res.writeHead(403); res.end(JSON.stringify({ error: { code: 'not_owner', message: 'Not owner' } })); return; }
          if (request.version !== row.version) { res.writeHead(409); res.end(JSON.stringify({ error: { code: 'version_conflict', message: 'Changed', currentVersion: row.version } })); return; }
          Object.assign(row, request, { status: request.type === 'executions.cancel' ? 'cancelled' : request.type === 'executions.complete' ? 'completed' : request.status, version: row.version + 1 });
          if (request.type === 'executions.complete') {
            row.result = request.resultText;
            if (row.discussionId) discussionReplies.push(request.resultText);
          }
          result = row; break;
        }
        case 'executions.list': result = { items: [...executionRows.values()].filter(row => row.ownerId === who), nextCursor: null }; break;
      }
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const pushes: CollaborationUpdate[] = [], newSessions: unknown[] = [], questions: Array<{ id: string; prompt: string; input: Json; identity: unknown }> = [];
  const sent: Array<{ sessionId: string; payload: unknown; signal?: AbortSignal; outcome: ReturnType<typeof deferred<{ reply: string | null }>> }> = [];
  const cancelled: unknown[] = [], deleted: unknown[] = [], interrupts: Array<{ sessionId: string; expectedTurnId?: string; origin?: string }> = [];
  const savedFiles: Array<{ name: string; bytes: Uint8Array }> = [];
  let generated: ReturnType<typeof deferred<{ response: string }>> | undefined;
  let service!: TeamCollaborationService;
  const deps: TeamCollaborationDeps = {
    configRoot: root, serverUrl: `http://127.0.0.1:${address.port}`, account: () => account,
    authorizationExpired: async () => { expired++; account = null; service.refreshAccount(); },
    push: (_channel, data) => pushes.push(data as unknown as CollaborationUpdate),
    pickDirectory: async () => directory,
    saveFile: async (name, bytes, current) => { current(); savedFiles.push({ name, bytes }); return true; },
    modelOptions: async () => [{ value: 'codex:gpt-5-mini', label: 'GPT 5 mini' }],
    agentDefinitions: async () => [definition],
    rendererId: value => value,
    bindSessionDirectory: (id, path) => bindSessionWorkdir(id, path, root),
    configureSessionModel: (id, model) => bindCollaborationModel(root, id, model),
    log: () => {}, reconnectMs: 10, requestTimeoutMs: 1000, streamIdleMs: 1000,
    sessions: {
      newSession: async options => { newSessions.push(options); return { id: `session-${newSessions.length}` }; },
      sideQuestion: async (id, prompt, identity) => { questions.push({ id, prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt), input: prompt, identity }); return generated ? generated.promise : { response: JSON.stringify(draft) }; },
      cancelSideQuestion: async identity => { cancelled.push(identity); generated?.reject(new Error('cancelled')); return { ok: true, cancelled: true }; },
      deleteSession: async (id, wipe) => { deleted.push({ id, wipe }); return { ok: true }; },
      interrupt: async (sessionId, expectedTurnId, origin) => { interrupts.push({ sessionId, expectedTurnId, origin }); return { ok: true, accepted: true }; },
      sendAndWait: async (sessionId, payload, signal) => {
        const outcome = deferred<{ reply: string | null }>();
        sent.push({ sessionId, payload, signal, outcome });
        signal?.addEventListener('abort', () => outcome.reject(new Error('interrupted')), { once: true });
        service.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId, submissionId: `submission-${sessionId}`, detail: { turnId: `turn-${sessionId}` } } });
        return outcome.promise;
      },
    },
    ...extra,
  };
  service = new TeamCollaborationService(deps);
  const options: ExecuteOptions = { projectId, issueId, issueVersion: 1, agentId, idempotencyKey: 'run-1', localFolderConfirmed: true };
  return { root, directory, deps, service, calls, streams, pushes, sent, newSessions, questions, cancelled, deleted, executionRows, options,
    interrupts, savedFiles, fileId, fileBytes, fileMetadata, fileFetches, definition, discussionId, messageId, discussionReplies,
    setDiscussionVersion: (version: number) => { discussionVersion = version; }, setJoinPath: (value: string) => { joinPath = value; },
    expireCount: () => expired, account: () => account,
    setAccount: (value: CollaborationAccount | null) => { account = value; service.refreshAccount(); },
    setStatus: (value: number) => { responseStatus = value; },
    setForeign: () => { foreignAgent = true; }, setIssueVersion: (version: number) => { issueVersion = version; },
    setClaimConflict: () => { claimConflict = true; }, changeIssueOnCreate: () => { changeIssueOnCreate = true; },
    blockRequests: () => { block = deferred<void>(); return block; },
    blockDraft: () => { generated = deferred<{ response: string }>(); return generated; },
    close: async () => {
      block?.resolve(); generated?.reject(new Error('fixture closed'));
      try { await service.close(); }
      finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('cloud requests require a signed-in account, retain 403 auth, and expire only 401', async () => {
  const f = await fixture();
  try {
    await f.service.request({ type: 'projects.list' });
    assert.equal(f.calls[0]?.authorization, 'Bearer alice-secret');
    f.setStatus(403);
    await assert.rejects(f.service.request({ type: 'projects.list' }), { code: 'not_project_member' });
    assert.equal(f.expireCount(), 0); assert.equal(f.account()?.id, 'alice');
    f.setStatus(401);
    await assert.rejects(f.service.request({ type: 'projects.list' }), { code: 'not_authenticated' });
    assert.equal(f.expireCount(), 1);
    await assert.rejects(f.service.request({ type: 'projects.list' }), { code: 'NOT_AUTHENTICATED' });
    assert(!JSON.stringify(f.pushes).includes('secret'));
  } finally { await f.close(); }
});
test('account switching aborts late HTTP replies instead of publishing cross-account data', async () => {
  const f = await fixture();
  try {
    const gate = f.blockRequests();
    const pending = f.service.request({ type: 'projects.list' });
    const rejection = assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    await waitFor(() => f.calls.length === 1, 'request entered server');
    f.setAccount({ id: 'bob', token: 'bob-secret' }); gate.resolve();
    await rejection;
    assert.equal(f.pushes.at(-1)?.kind, 'account');
  } finally { await f.close(); }
});
test('transport allowlist rejects arbitrary URLs, IPC names, local paths and fabricated execution writes', async () => {
  const f = await fixture();
  try {
    for (const value of [{ type: 'session/start' }, { type: 'projects.list', url: 'https://evil.test' },
      { type: 'project-invitations.accept', token: 'invitation', headers: {} }, { type: 'projects.create', localFolder: '/secret' }]) {
      await assert.rejects(f.service.request(value as never), { code: 'BAD_REQUEST' });
    }
    await assert.rejects(f.service.request({ type: 'executions.update' } as never), { code: 'HOST_OWNED_OPERATION' });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('local folders are canonical, durable, account-scoped and do not register local projects', async () => {
  const f = await fixture();
  try {
    const link = join(f.root, 'alias'); symlinkSync(f.directory, link);
    assert.deepEqual(await f.service.setLocalBinding(projectId, link), { projectId, localFolder: f.directory });
    assert.equal(new CollaborationStore(f.root).binding('alice', projectId), f.directory);
    f.setAccount({ id: 'bob', token: 'bob-secret' });
    assert.deepEqual(await f.service.localBinding(projectId), { projectId, localFolder: null });
    await f.service.setLocalBinding(projectId, null);
    f.setAccount({ id: 'alice', token: 'alice-secret' });
    assert.equal((await f.service.localBinding(projectId)).localFolder, f.directory);
    const workspaces = new WorkspaceStore({ configRoot: f.root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
    assert.deepEqual(record(workspaces.projectsList()).roots, []);
    assert(!JSON.stringify(f.calls).includes(f.directory));
  } finally { await f.close(); }
});
test('invalid and unavailable directories are rejected, and a cancelled picker preserves its binding', async () => {
  const f = await fixture();
  try {
    for (const path of ['relative', 'ssh://host/repo', 'a\0b', join(f.root, 'missing')]) await assert.rejects(f.service.setLocalBinding(projectId, path));
    const file = join(f.root, 'file'); writeFileSync(file, 'not a directory');
    await assert.rejects(f.service.setLocalBinding(projectId, file), { code: 'DIRECTORY_UNAVAILABLE' });
    await f.service.setLocalBinding(projectId, f.directory);
    f.deps.pickDirectory = async () => null;
    assert.equal((await f.service.pickLocalFolder(projectId)).localFolder, f.directory);
  } finally { await f.close(); }
});
test('SSE resumes from a durable cursor, deduplicates replay, and isolates account changes', async () => {
  const f = await fixture();
  try {
    f.service.watch(projectId);
    await waitFor(() => f.streams.length === 1, 'first SSE connection');
    const event = { id: '7', projectId, actorId: 'alice', type: 'issues.update', entityId: issueId, createdAt: '', data: {} };
    f.streams[0]!.response.write(`id: 7\nevent: collaboration\ndata: ${JSON.stringify(event)}\n\n`);
    await waitFor(() => f.pushes.some(value => value.kind === 'event'), 'first event delivered');
    f.streams[0]!.response.end();
    await waitFor(() => f.streams.length >= 2, 'SSE reconnect');
    assert.equal(f.streams[1]!.url.searchParams.get('after'), '7');
    f.streams[1]!.response.write(`id: 7\ndata: ${JSON.stringify(event)}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.pushes.filter(value => value.kind === 'event').length, 1);
    f.setAccount({ id: 'bob', token: 'bob-secret' }); f.service.watch(projectId);
    await waitFor(() => f.streams.length >= 3, 'new account SSE');
    assert.equal(f.streams[2]!.url.searchParams.get('after'), null);
    assert.equal(f.streams[2]!.authorization, 'Bearer bob-secret');
    f.service.watch(null);
  } finally { await f.close(); }
});
test('real drafting uses a new scratch session and the named read-only side-question facade', async () => {
  const f = await fixture();
  try {
    const result = await f.service.draftProject('Build a compiler', { requestId: 'draft-1' }, 12);
    assert.equal(result.patch.name, draft.patch.name);
    assert.deepEqual(f.newSessions[0], { workdir: null, title: 'Team project draft', collaborationMode: 'plan' });
    assert(f.questions[0]!.prompt.includes('Build a compiler'));
    assert(f.questions[0]!.prompt.includes('Do not create projects, execute tasks, or write files.'));
    assert.deepEqual(f.questions[0]!.identity, { ownerId: 12, requestId: 'collaboration-draft:draft-1' });
    assert.deepEqual(f.deleted, [{ id: 'session-1', wipe: false }]);
    assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
    assert.throws(() => parseProjectDraft('a fixed template', 'draft'), { code: 'INVALID_DRAFT' });
    assert.throws(() => parseProjectDraft(JSON.stringify({ ...draft, patch: { name: '' } }), 'draft'), { code: 'INVALID_DRAFT' });
  } finally { await f.close(); }
});
test('draft cancellation interrupts only the owning window request and drains cleanup', async () => {
  const f = await fixture();
  try {
    f.blockDraft();
    const answer = f.service.draftProject('A project', { requestId: 'same-id' }, 5);
    const rejected = assert.rejects(answer);
    await waitFor(() => f.questions.length === 1, 'draft admitted');
    assert.deepEqual(await f.service.cancelDraft('same-id', 9), { cancelled: false });
    assert.deepEqual(await f.service.cancelDraft('same-id', 5), { cancelled: true });
    await rejected;
    assert.deepEqual(f.cancelled, [{ ownerId: 5, requestId: 'collaboration-draft:same-id' }]);
    assert.equal(f.deleted.length, 1);
  } finally { await f.close(); }
});
test('execution checks owner, issue version, local confirmation and binding before any session starts', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.execute({ ...f.options, localFolderConfirmed: false } as never), { code: 'CONFIRMATION_REQUIRED' });
    await assert.rejects(f.service.execute(f.options), { code: 'DIRECTORY_UNBOUND' });
    f.setIssueVersion(2);
    await assert.rejects(f.service.execute(f.options), { code: 'CONFLICT' });
    f.setIssueVersion(1); f.setForeign();
    await assert.rejects(f.service.execute(f.options), { code: 'AGENT_NOT_OWNED' });
    assert.equal(f.newSessions.length, 0); assert.equal(f.executionRows.size, 0);
  } finally { await f.close(); }
});
test('execution is cloud-idempotent, dispatches once, and records real session and turn without path disclosure', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    const [one, two] = await Promise.all([f.service.execute(f.options), f.service.execute(f.options)]);
    assert.equal(one.sessionId, two.sessionId); assert.equal(f.sent.length, 1);
    assert.equal(sessionWorkdir(one.sessionId!, f.root), f.directory);
    assert.equal(record(new WorkspaceStore({ configRoot: f.root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null }).projectsList()).activeRoot, null);
    f.sent[0]!.outcome.resolve({ reply: `Do not upload a secret path: ${f.directory}` });
    await waitFor(() => [...f.executionRows.values()][0]?.status === 'completed', 'cloud completion');
    const row = [...f.executionRows.values()][0]!;
    assert.equal(row.sessionId, one.sessionId); assert.equal(row.turnId, `turn-${one.sessionId}`);
    assert(!JSON.stringify(f.calls).includes(f.directory)); assert(!JSON.stringify(f.pushes).includes('secret'));
    const repeated = await f.service.execute(f.options);
    assert.equal(repeated.sessionId, one.sessionId); assert.equal(f.newSessions.length, 1);
    assert.throws(() => f.service.execute({ ...f.options, prompt: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await f.close(); }
});
test('concurrent same-key different input is rejected before startup, even while permission reads wait', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    const gate = f.blockRequests();
    const launch = f.service.execute(f.options);
    assert.throws(() => f.service.execute({ ...f.options, prompt: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
    gate.resolve(); await launch;
  } finally { await f.close(); }
});
test('cloud cancellation aborts the owned local turn and account switching never uploads with the next token', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    const first = await f.service.execute(f.options);
    const remote = [...f.executionRows.values()][0]!;
    await f.service.request({ type: 'executions.cancel', projectId, executionId: remote.id, version: remote.version });
    assert.equal(f.sent[0]!.signal!.aborted, true);
    assert.equal(f.executionRows.get(first.execution.id)!.status, 'cancelled');
    await f.service.execute({ ...f.options, idempotencyKey: 'run-2' });
    f.setAccount({ id: 'bob', token: 'bob-secret' });
    await waitFor(() => f.sent[1]!.signal!.aborted, 'account switch stops own run');
    assert(!f.calls.some(call => call.authorization === 'Bearer bob-secret' && call.request.type === 'executions.update'));
  } finally { await f.close(); }
});
test('execution failures are durable and never share raw engine errors or tokens with the cloud', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    await f.service.execute(f.options);
    f.sent[0]!.outcome.reject(new Error(`credential alice-secret in ${f.directory}`));
    await waitFor(() => [...f.executionRows.values()][0]?.status === 'failed', 'cloud failure');
    const row = [...f.executionRows.values()][0]!;
    assert(!row.error!.includes('secret')); assert(!row.error!.includes(f.directory));
  } finally { await f.close(); }
});
test('restart recovery marks an abandoned execution failed without dispatching it again', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    await f.service.execute(f.options);
    const journal = f.service.store.journal('alice', 'run-1')!;
    await f.service.close();
    journal.status = 'running'; journal.syncPending = true;
    const remote = f.executionRows.get(journal.execution!.id)!; remote.status = 'running';
    journal.execution = structuredClone(remote); f.service.store.save(journal);
    const restarted = new TeamCollaborationService(f.deps);
    restarted.start();
    await waitFor(() => f.executionRows.get(remote.id)!.status === 'failed', 'recovered terminal outcome');
    assert.equal(f.sent.length, 1);
    await restarted.close();
  } finally { await f.close(); }
});
test('IPC registration rejects external and secondary roles and exposes only explicit channels', async () => {
  const f = await fixture(), registry = new ChannelRegistry();
  const service = registerTeamCollaborationHandlers(registry, f.deps);
  try {
    assert.deepEqual(registry.channels(), [...TEAM_COLLABORATION_CHANNELS].sort());
    const handler = registry.lookup('collaboration:request')!;
    for (const role of ['canvas', 'artifact', 'mobile', 'browser']) {
      await assert.rejects(Promise.resolve().then(() => handler({ role, senderId: 1, channel: 'collaboration:request', args: [{ type: 'projects.list' }] })), { code: 'FORBIDDEN_CHANNEL' });
    }
    await handler({ role: 'main', senderId: 1, channel: 'collaboration:request', args: [{ type: 'projects.list' }] });
    assert.equal(f.calls.length, 1);
  } finally { await service.close(); await f.close(); }
});
test('HTTP deadlines abort disconnected requests, and insecure remote endpoints are rejected', async () => {
  const f = await fixture({ requestTimeoutMs: 30 });
  try {
    f.blockRequests();
    await assert.rejects(f.service.request({ type: 'projects.list' }), { code: 'REQUEST_TIMEOUT' });
    assert.throws(() => new CollaborationCloud({ ...f.deps, serverUrl: 'http://remote.example' }, f.service.store, () => {}), /requires HTTPS/);
  } finally { await f.close(); }
});
test('production side-question adapter sends session/sideQuestion and never raw Op or turn/start', async () => {
  const emitter = new EventEmitter(), calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), isClosed: () => false,
    requestWithTimeout: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const submissionId = record(params).submissionId;
      queueMicrotask(() => emitter.emit('event', { type: 'engineEvent', params: { submissionId, sideQuestion: { response: JSON.stringify(draft) } } } satisfies ClientEvent));
      return { submissionId };
    },
  } as unknown as EngineClientLike;
  const result = await querySideQuestion(client, 'draft-session', 'Return structured project JSON', new AbortController().signal, 1000);
  assert.equal(JSON.parse(result.response).patch.name, 'Test project');
  assert.equal(calls[0]!.method, 'session/sideQuestion');
  assert.equal(record(calls[0]!.params).sessionId, 'draft-session');
  assert.match(String(record(calls[0]!.params).submissionId), /^sq-/);
  assert.equal(calls.length, 1);
});
test('a collaboration model pick pins only its own session and never changes the user default or provider access', async () => {
  const f = await fixture();
  try {
    kvSet('auth_mode', 'codex', f.root); kvSet('composer.main_model', 'codex:gpt-5', f.root);
    readSessionModel('unrelated', f.root);
    bindCollaborationModel(f.root, 'execution-chat', 'codex:gpt-5-mini');
    assert.equal(readSessionModel('execution-chat', f.root).mode, 'codex:gpt-5-mini');
    assert.equal(readSessionModel('unrelated', f.root).mode, 'codex:gpt-5');
    assert.equal(kvGet('composer.main_model', f.root), 'codex:gpt-5');
    assert.equal(kvGet('auth_mode', f.root), 'codex');
  } finally { await f.close(); }
});
test('a competing device wins the cloud CAS without causing any local dispatch or terminal overwrite', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory); f.setClaimConflict();
    await assert.rejects(f.service.execute(f.options), { code: 'version_conflict' });
    assert.equal(f.newSessions.length, 0); assert.equal(f.sent.length, 0);
    await f.service.close();
    assert.equal([...f.executionRows.values()][0]!.status, 'running');
    assert.equal([...f.executionRows.values()][0]!.sessionId, 'other-device-session');
  } finally { await f.close(); }
});
test('an issue edited during the execution handshake does not dispatch a stale turn', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory); f.changeIssueOnCreate();
    await assert.rejects(f.service.execute(f.options), { code: 'CONFLICT' });
    await waitFor(() => [...f.executionRows.values()][0]!.status === 'failed', 'stale execution terminated');
    assert.equal(f.newSessions.length, 0); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});
test('SSE authorization loss stops retries without expiring the account and can be re-opened after permission returns', async () => {
  const f = await fixture();
  try {
    f.setStatus(403); f.service.watch(projectId);
    await waitFor(() => f.pushes.some(item => item.kind === 'connection' && item.state === 'forbidden'), 'SSE forbidden notice');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.streams.length, 1); assert.equal(f.expireCount(), 0);
    f.setStatus(200); f.service.watch(projectId);
    await waitFor(() => f.streams.length === 2, 'watch reopened after membership restored');
    assert.equal(f.account()?.id, 'alice');
  } finally { await f.close(); }
});
test('a late unauthorized response from a previous account cannot log out the newly signed-in account', async () => {
  const f = await fixture();
  try {
    const gate = f.blockRequests(), pending = f.service.request({ type: 'projects.list' });
    const rejected = assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
    await waitFor(() => f.calls.length === 1, 'old-account request accepted');
    f.setStatus(401); f.setAccount({ id: 'bob', token: 'bob-secret' }); gate.resolve();
    await rejected;
    assert.equal(f.expireCount(), 0); assert.equal(f.account()?.id, 'bob');
  } finally { await f.close(); }
});

test('invitation responses contain a same-origin canonical absolute link and no raw token field', async () => {
  const f = await fixture();
  try {
    const result = await f.service.request({ type: 'project-invitations.create', projectId });
    assert.equal(result.joinPath, f.deps.serverUrl + '/collaboration/join?token=abcdefghijklmnopqrstuvwxyz_1234567890');
    assert(!Object.hasOwn(result, 'token'));
    for (const path of vectors.invalidInvitationLinks) {
      f.setJoinPath(path);
      await assert.rejects(f.service.request({ type: 'project-invitations.create', projectId }), { code: 'INVALID_RESPONSE' });
    }
    assert.throws(() => invitationUrl('/collaboration\\join?token=abcdefghijklmnopqrstuvwxyz', f.deps.serverUrl), { code: 'INVALID_RESPONSE' });
  } finally { await f.close(); }
});
test('drafts retain conversation and file context, validate catalog models, and only return project patches', async () => {
  const f = await fixture();
  try {
    await f.service.draftProject('Update the repository', { requestId: 'followup', model: 'codex:gpt-5-mini',
      history: [{ role: 'user', content: 'Build a compiler' }, { role: 'assistant', content: 'I propose Compiler Lab.' }],
      files: [{ name: 'requirements.md', content: 'The repository is public.' }], current: { name: 'Compiler Lab' } }, 1);
    assert.match(f.questions[0]!.prompt, /requirements\.md/);
    assert.match(f.questions[0]!.prompt, /I propose Compiler Lab/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.draftProject('Project', { requestId: 'fake-model', model: 'codex:invented-model' }, 1), { code: 'INVALID_MODEL' });
    assert.equal(f.newSessions.length, 1);
    assert.throws(() => f.service.draftProject('Project', { requestId: 'path', files: [{ name: '/secret/key', content: 'secret' }] }, 1), { code: 'BAD_REQUEST' });
    const cover = parseProjectDraft(JSON.stringify({ patch: { coverId: 'blue', coverIconId: 'code' }, explanation: 'Use the blue code cover.' }), 'cover',
      { requestId: 'cover', allowedCoverIds: ['blue'], allowedCoverIconIds: ['code'] });
    assert.deepEqual(cover.patch, { coverId: 'blue', coverIconId: 'code' });
    const allFields = parseProjectDraft(JSON.stringify({ patch: { ...draft.patch, ...cover.patch }, explanation: draft.explanation }), 'all-fields',
      { requestId: 'all-fields', allowedCoverIds: ['blue'], allowedCoverIconIds: ['code'] });
    assert.deepEqual(Object.keys(allFields.patch).sort(), [...vectors.draftFields].sort());
    assert.throws(() => parseProjectDraft(JSON.stringify({ patch: { coverId: 'invented' }, explanation: 'Cover' }), 'bad'), { code: 'INVALID_DRAFT' });
    for (const repositoryUrl of vectors.validRepositoryUrls) assert.equal(parseProjectDraft(JSON.stringify({ patch: { repositoryUrl }, explanation: 'Repository updated' }), 'repo').patch.repositoryUrl, repositoryUrl);
    for (const repositoryUrl of vectors.invalidRepositoryUrls) assert.throws(() => parseProjectDraft(JSON.stringify({ patch: { repositoryUrl }, explanation: 'Repository updated' }), 'repo'), { code: 'INVALID_DRAFT' });
  } finally { await f.close(); }
});
test('production draft cancellation sends the named cancel request and waits for its own engine terminal event', async () => {
  const emitter = new EventEmitter(), calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let requestId = '', settled = false;
  const client = {
    on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), isClosed: () => false,
    requestWithTimeout: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session/sideQuestion') requestId = String(params.submissionId);
      return { submissionId: method === 'session/cancelRequest' ? 'cancel-ack' : requestId };
    },
  } as unknown as EngineClientLike;
  const controller = new AbortController();
  const outcome = querySideQuestion(client, 'private-draft-session', 'Draft only', controller.signal, 1000);
  const rejected = assert.rejects(outcome, { code: 'ABORTED' }).then(() => { settled = true; });
  controller.abort();
  await waitFor(() => calls.some(call => call.method === 'session/cancelRequest'), 'cancel request');
  assert.equal(settled, false);
  assert.deepEqual(calls[1], { method: 'session/cancelRequest', params: { sessionId: 'private-draft-session', requestId } });
  emitter.emit('event', { type: 'engineEvent', params: { submissionId: 'unrelated', sideQuestion: { response: 'Unrelated' } } });
  assert.equal(settled, false);
  emitter.emit('event', { type: 'engineEvent', params: { submissionId: requestId, sideQuestion: { response: 'Cancelled' } } });
  await rejected;
});
test('repository patches preserve encoded paths and enforce the 2048-character boundary without normalizing unsafe input', () => {
  const patch = (repositoryUrl: unknown) => parseProjectDraft(JSON.stringify({ patch: { repositoryUrl }, explanation: 'Repository updated' }), 'repo-boundary').patch.repositoryUrl;
  const prefix = 'https://example.test/', maximum = prefix + 'a'.repeat(2048 - prefix.length);
  assert.equal(patch(maximum), maximum);
  assert.throws(() => patch(maximum + 'a'), { code: 'INVALID_DRAFT' });
  assert.equal(patch(''), null); assert.equal(patch(null), null);
  for (const invalid of [false, 1, {}, [], 'https://example.test/repo\0.git']) assert.throws(() => patch(invalid), { code: 'INVALID_DRAFT' });
  for (const repositoryUrl of vectors.validRepositoryUrls.filter(value => value.includes('%'))) assert.equal(patch(repositoryUrl), repositoryUrl);
});
test('revoked execution access stops the exact engine turn and drops its durable sync queue', async () => {
  for (const status of [403, 404]) {
    const f = await fixture({ reconcileMs: 20 });
    try {
      await f.service.setLocalBinding(projectId, f.directory);
      const started = await f.service.execute(f.options);
      f.setStatus(status); f.service.start();
      await waitFor(() => f.interrupts.length > 0, 'revoked execution interrupted');
      assert.deepEqual(f.interrupts[0], { sessionId: started.sessionId, expectedTurnId: `turn-${started.sessionId}`, origin: 'targeted-turn' });
      await waitFor(() => f.service.store.journal('alice', 'run-1')?.syncPending === false, 'sync queue discarded');
      const journal = f.service.store.journal('alice', 'run-1')!;
      assert.equal(journal.syncBlocked, true); assert.equal(journal.status, 'cancelled');
      assert(f.pushes.some(push => push.kind === 'connection' && push.state === 'forbidden'));
    } finally { await f.close(); }
  }
});
test('offline reconciliation preserves the run, while account switching and shutdown interrupt only its owned turn', async () => {
  const f = await fixture({ reconcileMs: 20 });
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    const started = await f.service.execute(f.options);
    f.setStatus(503); f.service.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.interrupts.length, 0); assert.equal(f.sent[0]!.signal!.aborted, false);
    f.setAccount({ id: 'bob', token: 'bob-secret' });
    await waitFor(() => f.interrupts.length === 1, 'account cancellation');
    assert.deepEqual(f.interrupts[0], { sessionId: started.sessionId, expectedTurnId: `turn-${started.sessionId}`, origin: 'targeted-turn' });
    assert.equal(f.service.store.journal('alice', 'run-1')!.syncBlocked, true);
    f.setAccount({ id: 'alice', token: 'alice-secret' }); f.setStatus(200);
    const next = await f.service.execute({ ...f.options, idempotencyKey: 'shutdown' });
    await f.service.close();
    assert.deepEqual(f.interrupts.at(-1), { sessionId: next.sessionId, expectedTurnId: `turn-${next.sessionId}`, origin: 'targeted-turn' });
  } finally { await f.close(); }
});
test('file download and preview use authenticated canonical bytes and never a server-provided arbitrary URL', async () => {
  const f = await fixture();
  try {
    const preview = await f.service.files.preview({ projectId }, f.fileId);
    assert.deepEqual(preview, { name: 'notes.txt', mediaType: 'text/plain', size: f.fileBytes.length, kind: 'text', text: f.fileBytes.toString() });
    assert.deepEqual(await f.service.files.download({ projectId }, f.fileId), { saved: true, name: 'notes.txt' });
    assert.equal(f.savedFiles.length, 1); assert.deepEqual(Buffer.from(f.savedFiles[0]!.bytes), f.fileBytes);
    assert(f.fileFetches.every(row => row.url === `/api/collaboration/files/${f.fileId}` && row.authorization === 'Bearer alice-secret'));
    f.fileMetadata.sha256 = '0'.repeat(64);
    await assert.rejects(f.service.files.download({ projectId }, f.fileId), { code: 'INVALID_RESPONSE' });
    assert.equal(f.savedFiles.length, 1);
    f.setStatus(403);
    await assert.rejects(f.service.files.preview({ projectId }, f.fileId), { code: 'not_project_member' });
  } finally { await f.close(); }
});
test('file upload rejects paths, oversized content and malformed base64 before contacting the cloud', async () => {
  const f = await fixture();
  try {
    const request = { type: 'files.upload' as const, scope: { projectId }, name: 'notes.txt', mediaType: 'text/plain', dataBase64: Buffer.from('File').toString('base64') };
    for (const value of [{ ...request, name: '../secret.txt' }, { ...request, dataBase64: 'not base64?' }, { ...request, dataBase64: 'YR==' }]) {
      await assert.rejects(f.service.request(value), { code: 'BAD_REQUEST' });
    }
    assert.equal(f.calls.length, 0);
    assert.equal(COLLABORATION_FILE_LIMIT, vectors.fileMaximumBytes);
    assert.throws(() => uploadBytes(Buffer.alloc(COLLABORATION_FILE_LIMIT + 1).toString('base64')), { code: 'BAD_REQUEST' });
    await f.service.request(request);
    assert.equal(f.calls[0]!.request.type, 'files.upload');
    await assert.rejects(f.service.request({ type: 'discussion-messages.send', projectId, discussionId: 'discussion', content: 'Impersonate', clientMessageId: 'message', agentId: 'foreign' } as never), { code: 'HOST_OWNED_OPERATION' });
  } finally { await f.close(); }
});
test('discussion mentions execute the real local profile and atomically share only the final response', async () => {
  const f = await fixture();
  try {
    await f.service.setLocalBinding(projectId, f.directory);
    const options = { projectId, discussionId: f.discussionId, discussionVersion: 1, messageId: f.messageId,
      agentId, prompt: '@Engineer Please review this feature.', localFolderConfirmed: true as const, idempotencyKey: 'discussion-run' };
    const result = await f.service.execute(options);
    const created = record(f.newSessions[0]), profile = record(created.agentProfile);
    const createRequest = f.calls.find(call => call.request.type === 'executions.create')!.request;
    assert.equal('messageId' in createRequest, false);
    assert.equal(record(createRequest).discussionVersion, 1);
    assert.equal(profile.name, 'Engineer'); assert.deepEqual(profile.definition, f.definition);
    assert.equal(created.localWorkdir, f.directory);
    assert.equal(result.execution.discussionId, f.discussionId); assert.equal(result.execution.issueId, null);
    f.sent[0]!.outcome.resolve({ reply: `Review result: use version checks.\n<think>private deliberation</think>\n${f.directory}\nBearer alice-secret` });
    await waitFor(() => f.discussionReplies.length === 1, 'shared agent response');
    assert.match(f.discussionReplies[0]!, /Review result: use version checks/);
    assert(!f.discussionReplies[0]!.includes('private deliberation')); assert(!f.discussionReplies[0]!.includes(f.directory));
    assert(!f.discussionReplies[0]!.includes('alice-secret'));
    const completion = record(f.calls.find(call => call.request.type === 'executions.complete')!.request);
    assert.deepEqual(Object.keys(completion).sort(), ['executionId', 'projectId', 'resultText', 'type', 'version']);
    assert.equal(typeof completion.version, 'number');
    assert.match(String(completion.resultText), /Review result: use version checks/);
    await f.service.execute(options);
    assert.equal(f.sent.length, 1); assert.equal(f.discussionReplies.length, 1);
    await assert.rejects(f.service.execute({ ...options, idempotencyKey: 'spoof', prompt: 'Not the actual message' }), { code: 'INVALID_AGENT_MENTION' });
    f.setDiscussionVersion(2);
    await assert.rejects(f.service.execute({ ...options, idempotencyKey: 'stale' }), { code: 'CONFLICT' });
  } finally { await f.close(); }
});
test('detached discussions keep execution directories local and use independent discussion ACL', async () => {
  const f = await fixture();
  try {
    const options = { discussionId: f.discussionId, discussionVersion: 1, messageId: f.messageId,
      agentId, prompt: '@Engineer Please review this feature.', localFolderConfirmed: true as const, idempotencyKey: 'detached', workingDirectory: f.directory };
    await f.service.execute(options);
    assert(!f.calls.some(call => call.request.type === 'projects.get'));
    assert(!JSON.stringify(f.calls).includes(f.directory));
    f.sent[0]!.outcome.resolve({ reply: 'The detached discussion is still usable.' });
    await waitFor(() => f.discussionReplies.length === 1, 'detached final response');
  } finally { await f.close(); }
});
test('local agent references require a real discovered definition and survive session reinitialization', async () => {
  const f = await fixture();
  try {
    const catalog = await f.service.agents.list();
    assert(catalog.some(agent => agent.runtimeReference === 'local-agent:Engineer'));
    assert(catalog.some(agent => agent.runtimeReference === 'local-agent:general-purpose'));
    assert(!JSON.stringify(catalog).includes(f.definition.prompt));
    const resolved = await f.service.agents.resolve('local-agent:Engineer');
    bindSessionAgent(f.root, 'profile-chat', { name: resolved.name, definition: resolved.definition });
    const stored = sessionAgent(f.root, 'profile-chat')!;
    assert.deepEqual(stored.definition, f.definition);
    const init = { agents: [{ name: 'Engineer', prompt: 'new unrelated definition' }], developerInstructions: 'Host instructions' };
    applySessionAgent(init, stored);
    assert.deepEqual(record(init).agentDefinitionName, 'Engineer');
    assert.deepEqual(init.agents, [f.definition]);
    assert.throws(() => assertSessionAgent(init, { initialized: { accepted: true } }), { code: 'AGENT_RUNTIME_MISMATCH' });
    assert.doesNotThrow(() => assertSessionAgent(init, { initialized: { accepted: true, agentDefinitionName: 'Engineer' } }));
    f.deps.agentDefinitions = async () => [];
    await assert.rejects(f.service.agents.resolve('local-agent:Engineer'), { code: 'AGENT_UNAVAILABLE' });
    await f.service.setLocalBinding(projectId, f.directory);
    await assert.rejects(f.service.execute(f.options), { code: 'AGENT_UNAVAILABLE' });
    assert.equal(f.newSessions.length, 0);
  } finally { await f.close(); }
});
test('account event stream delivers other-project updates without treating the account cursor as a project', async () => {
  const f = await fixture();
  try {
    f.service.start();
    await waitFor(() => f.streams.some(stream => !stream.url.searchParams.has('projectId')), 'account stream');
    const stream = f.streams.find(stream => !stream.url.searchParams.has('projectId'))!;
    stream.response.write(`id: 18\ndata: ${JSON.stringify({ id: '18', projectId: 'another-project', type: 'projects.update', data: {}, actorId: 'alice' })}\n\n`);
    await waitFor(() => f.pushes.some(push => push.kind === 'event' && push.projectId === 'another-project'), 'account-wide event');
    assert.equal(f.service.store.cursor('alice', '@account'), '18');
    assert.equal(f.service.store.cursor('alice', 'another-project'), '');
    assert.equal(publicResponse('Useful output\n/Users/other/private/key\n<analysis>hidden</analysis>', []), 'Useful output\n[local path]');
  } finally { await f.close(); }
});
test('renderer calls cannot forge any execution phase and cancellation rejection stays visible', async () => {
  const f = await fixture();
  try {
    for (const type of vectors.rendererForbiddenOperations) await assert.rejects(f.service.request({ type } as never), { code: 'HOST_OWNED_OPERATION' });
    await f.service.setLocalBinding(projectId, f.directory);
    const execution = await f.service.execute(f.options);
    f.deps.sessions.interrupt = async () => ({ accepted: false, stale: true });
    await assert.rejects(f.service.request({ type: 'executions.cancel', projectId, executionId: execution.execution.id, version: execution.execution.version }), { code: 'CANCEL_FAILED' });
    assert(f.pushes.some(update => update.kind === 'connection' && update.error?.includes('did not confirm cancellation')));
    assert.equal(f.service.store.journal('alice', 'run-1')?.status, 'failed');
  } finally {
    try { await f.close(); } catch (error) { assert.equal(record(error).code, 'CANCEL_FAILED'); }
  }
});
test('shared final responses remove URL credentials, signed queries and platform-specific local paths', () => {
  const response = publicResponse([
    'https://user:password@example.test/download?sig=abcdef1234567890',
    'https://example.test/file?X-Amz-Signature=abcdef1234567890#private-fragment',
    '~/private/project-secret', '/opt/private/source', '\\\\server\\private\\share',
    'ghp_12345678901234567890', 'aws_secret_access_key="sensitive-value"', 'password=short',
    'Public documentation: https://example.test/docs',
  ].join('\n'), []);
  for (const privateValue of ['user:password@', 'abcdef1234567890', 'private-fragment', 'project-secret', '/opt/private', '\\\\server', '12345678901234567890', 'sensitive-value', '=short']) {
    assert(!response.includes(privateValue), privateValue);
  }
  assert.match(response, /https:\/\/example\.test\/docs/);
});
test('shared final responses redact bare service credentials, private keys and unfinished reasoning blocks', () => {
  // Token-shaped values are assembled at run time so the source holds no literal a secret scanner would block.
  const secrets = ['xoxb' + '-123456789012-abcdefghijklmnop', 'xapp' + '-123456789012-abcdefghijklmnop', 'AKIA1234567890ABCDEF', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl', 'C:/Users/fixture/private.txt'];
  const response = publicResponse(['Updated src/components/button.tsx.', ...secrets, '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-material\n-----END OPENSSH PRIVATE KEY-----', 'Public result.', '<analysis>unfinished-private-content'].join('\n'), []);
  for (const value of [...secrets, 'fixture-private-material', 'unfinished-private-content']) assert(!response.includes(value), value);
  assert.match(response, /Updated src\/components\/button\.tsx\./);
  assert.match(response, /Public result/);
});
test('empty and incomplete project snapshots remain useful context while generated patches stay strict', async () => {
  const f = await fixture();
  try {
    const result = await f.service.draftProject('Help complete this empty form', { requestId: 'empty-form', current: { name: '', repositoryUrl: 'git@', description: '' } }, 1);
    assert.equal(result.patch.name, draft.patch.name);
    assert.match(f.questions[0]!.prompt, /"name":""/); assert.match(f.questions[0]!.prompt, /"repositoryUrl":"git@"/);
    assert.match(draftInstruction('Repair this', { requestId: 'limits' }), /80 characters/);
    assert.throws(() => parseProjectDraft(JSON.stringify({ patch: { name: 'n'.repeat(81) }, explanation: 'Too long' }), 'limit'), { code: 'INVALID_DRAFT' });
    assert.throws(() => parseProjectDraft(JSON.stringify({ patch: { description: 'd'.repeat(151) }, explanation: 'Too long' }), 'limit'), { code: 'INVALID_DRAFT' });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('issue drafting uses the same real readonly session and cancellation jobs without writing cloud data', async () => {
  const f = await fixture();
  try {
    const response = f.blockDraft();
    const job = f.service.draftIssue('Investigate the login crash', { requestId: 'issue-draft', form: { title: '', description: '', status: 'backlog', priority: 'none' } }, 1);
    await waitFor(() => f.questions.length === 1, 'issue readonly query');
    assert.match(f.questions[0]!.prompt, /Investigate the login crash/);
    response.resolve({ response: JSON.stringify({ patch: { title: 'Investigate login crash', description: 'Reproduce and inspect the error', status: 'todo', priority: 'high' }, reply: 'I drafted a focused investigation issue.' }) });
    const result = await job;
    assert.deepEqual(Object.keys(result.patch).sort(), [...vectors.issueDraftFields].sort());
    assert.equal(result.patch.status, 'todo'); assert.equal(result.reply, 'I drafted a focused investigation issue.');
    assert.equal(record(f.newSessions[0]).title, 'Team issue draft'); assert.equal(record(f.newSessions[0]).collaborationMode, 'plan');
    assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
    f.blockDraft();
    const cancelled = f.service.draftIssue('Change the title', { requestId: 'cancel-issue', form: result.patch }, 1);
    const rejected = assert.rejects(cancelled, { code: 'ABORTED' });
    await waitFor(() => f.questions.length === 2, 'second issue draft');
    await f.service.cancelDraft('cancel-issue', 1); await rejected;
    assert.throws(() => parseIssueDraft('{"patch":{"status":"invented"},"reply":"No"}', 'invalid'), { code: 'INVALID_DRAFT' });
  } finally { await f.close(); }
});
test('current form snapshots preserve unfinished raw text and only enforce field types and context length', () => {
  const current = { name: '', description: '  Still editing\n', repositoryUrl: ' \tssh://git@host/repo? \n' };
  const instruction = draftInstruction('Repair this form', { requestId: 'raw-current', current });
  assert.deepEqual(JSON.parse(instruction.split('\n\n').at(-1)!).current, current);
  const maximum = 'x'.repeat(2048);
  assert.match(draftInstruction('Repair this', { requestId: 'maximum-current', current: { repositoryUrl: maximum } }), /"current":/);
  assert.throws(() => draftInstruction('Repair this', { requestId: 'too-long-current', current: { repositoryUrl: maximum + 'x' } }), { code: 'INVALID_DRAFT' });
  assert.throws(() => draftInstruction('Repair this', { requestId: 'invalid-current-type', current: { repositoryUrl: false } as never }), { code: 'INVALID_DRAFT' });
});
test('binary draft attachments reach sideQuestion as actual image/PDF blocks rather than decoded text or paths', async () => {
  const f = await fixture();
  try {
    const image = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
    await f.service.draftProject('Use these attached references', { requestId: 'binary-draft', attachments: [
      { id: 'image', name: 'reference.png', mimeType: 'image/png', size: image.length, base64: PNG_FIXTURE_BASE64 },
      { id: 'pdf', name: 'reference.pdf', mimeType: 'application/pdf', size: PDF_FIXTURE.length, base64: PDF_FIXTURE.toString('base64') },
    ] }, 1);
    const parts = f.questions[0]!.input;
    assert(Array.isArray(parts));
    assert.deepEqual(parts.find(part => record(part).type === 'image'), { type: 'image', mimeType: 'image/png', base64: PNG_FIXTURE_BASE64 });
    assert.deepEqual(parts.find(part => record(part).type === 'document'), { type: 'document', mimeType: 'application/pdf', base64: PDF_FIXTURE.toString('base64'), filename: 'reference.pdf' });
    assert(!f.questions[0]!.prompt.includes(f.root)); assert.equal(f.calls.length, 0);
    const sideClient = new EventEmitter() as EngineClientLike & EventEmitter;
    const calls: Array<Record<string, unknown>> = [];
    sideClient.isClosed = () => false;
    sideClient.requestWithTimeout = async <T>(_method: string, params: unknown) => {
      const request = record(params); calls.push(request);
      queueMicrotask(() => sideClient.emit('event', { type: 'engineEvent', params: { submissionId: request.submissionId, sideQuestion: { response: 'Read the actual bytes' } } }));
      return { submissionId: request.submissionId } as T;
    };
    await querySideQuestion(sideClient, 'readonly', parts, new AbortController().signal);
    assert.deepEqual(calls[0]!.question, parts);
  } finally { await f.close(); }
});
test('legacy and modern Office attachments are genuinely extracted offline in a bounded worker', async () => {
  const types = [
    ['doc', 'application/msword', /Sample Word Document/i],
    ['ppt', 'application/vnd.ms-powerpoint', /Sample Powerpoint Slide/i],
    ['xls', 'application/vnd.ms-excel', /Sample Excel Worksheet/i],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', /Sample Word Document/i],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', /Attachment Test[\s\S]*Watershed[\s\S]*Black Panther/i],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', /Sample Excel Worksheet/i],
  ] as const;
  for (const [extension, mimeType, expected] of types) {
    const bytes = readFileSync(resolve(__dirname, '../../tests/fixtures/team-draft', `sample.${extension}`));
    const content = await extractDraftDocument(bytes, mimeType, new AbortController().signal);
    assert.match(content, expected, extension);
    assert(!content.includes('PK\u0003\u0004'));
  }
  const content = await extractDraftDocument(Buffer.from('<h1>Offline context</h1><script>doNotExecute()</script><img src="http://127.0.0.1:1/private">'), 'text/html', new AbortController().signal);
  assert.match(content, /Offline context/); assert(!content.includes('doNotExecute'));
  const controller = new AbortController();
  const pending = extractDraftDocument(Buffer.from('cancel'), 'text/html', controller.signal);
  controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
});
test('attachment preparation enforces count, byte identity, types, cancellation and BMP conversion', async () => {
  assert.equal(DRAFT_ATTACHMENT_LIMIT, vectors.draftAttachmentMaximumBytes);
  assert.equal(vectors.draftAttachmentMaximumCount, 5);
  const controller = new AbortController(), bytes = Buffer.from('Actual UTF-8 text');
  const file = { id: 'text', name: 'context.txt', mimeType: 'text/plain', size: bytes.length, base64: bytes.toString('base64') };
  const input = await prepareDraftInput('Question', [file], controller.signal);
  assert(Array.isArray(input)); assert.match(String(record(input.at(-1)).text), /Actual UTF-8 text/);
  for (const attachments of [Array.from({ length: 6 }, () => file), [{ ...file, size: DRAFT_ATTACHMENT_LIMIT + 1 }],
    [{ ...file, size: file.size - 1 }], [{ ...file, name: '../context.txt' }], [{ ...file, mimeType: 'image/png' }], [file, file]]) {
    await assert.rejects(prepareDraftInput('Question', attachments, controller.signal));
  }
  const bmp = Buffer.alloc(58); bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp[56] = 255;
  const png = bmpToPng(bmp);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.deepEqual(inflateSync(png.subarray(41, 41 + png.readUInt32BE(33))), Buffer.from([0, 255, 0, 0]));
  const bitmap = await prepareDraftInput('Question', [{ id: 'bmp', name: 'pixel.bmp', mimeType: 'image/bmp', size: bmp.length, base64: bmp.toString('base64') }], controller.signal);
  assert(Array.isArray(bitmap)); assert.equal(record(bitmap.at(-1)).mimeType, 'image/png');
});
test('Issue deep links are cross-device canonical UUID routes without external redirects', () => {
  const project = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', issue = '11111111-2222-3333-4444-555555555555';
  const url = teamIssueDeepLink(project, issue);
  assert(url.startsWith(vectors.issueDeepLinkPrefix));
  assert.equal(url, `klaus://issue?projectId=${project.toLowerCase()}&issueId=${issue}`);
  assert.deepEqual(parseDeepLink(url), { kind: 'issue', projectId: project.toLowerCase(), issueId: issue });
  for (const invalid of [`${url}&next=https://evil.test`, `${url}#fragment`, `${url}&projectId=${project}`, url.replace('klaus:', 'https:'),
    url.replace('//issue?', '//issue/path?'), url.replace('//issue?', '//user@issue?'), url.replace(issue, '../secrets'), 'klaus://issue']) assert.equal(parseDeepLink(invalid), undefined);
  assert.throws(() => teamIssueDeepLink('project-1', issue));
});

// Server-controlled feature gate (src/feature-gates.ts). The host surface must
// refuse every collaboration channel while the gate is closed, hold no
// background SSE stream, and re-attach cleanly when the server opens it.
test('closed feature gate: every IPC channel refuses without touching the cloud', async () => {
  let gate = false;
  // requestTimeoutMs is raised so the gate-reopens recovery round-trip does not
  // race the node:test TAP reporter; the refusal assertions are the point here.
  const f = await fixture({ gateEnabled: () => gate, requestTimeoutMs: 8000 });
  const registry = new ChannelRegistry();
  const service = registerTeamCollaborationHandlers(registry, f.deps);
  try {
    for (const channel of TEAM_COLLABORATION_CHANNELS) {
      const handler = registry.lookup(channel)!;
      await assert.rejects(
        Promise.resolve().then(() => handler({ role: 'main', senderId: 1, channel, args: [{ projectId, issueId, requestId: 'r', prompt: 'p', scope: {}, fileId: 'f', localFolder: null }] })),
        { code: 'FEATURE_UNAVAILABLE' }, channel);
    }
    assert.equal(f.calls.length, 0, 'a refused channel never reaches the cloud');
    assert.equal(f.streams.length, 0, 'no background stream while gated off');
    gate = true;
    await handler0(registry, f);
  } finally { gate = true; await service.close(); await f.close(); }
});
async function handler0(registry: ChannelRegistry, f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  // The same registry recovers as soon as the gate opens: no re-registration.
  const handler = registry.lookup('collaboration:request')!;
  await handler({ role: 'main', senderId: 1, channel: 'collaboration:request', args: [{ type: 'projects.list' }] });
  assert.equal(f.calls.length, 1);
}

test('gate flip: closing suspends the account watch, opening re-attaches without a restart', async () => {
  let gate = true;
  const f = await fixture({ gateEnabled: () => gate });
  const service = new TeamCollaborationService(f.deps);
  try {
    service.start();
    await waitFor(() => f.streams.length >= 1, 'the account watch connects while the gate is open');
    gate = false;
    service.refreshGate();
    await waitFor(() => f.streams.every(stream => stream.response.writableEnded || stream.response.destroyed), 'closing the gate tears the SSE stream down');
    gate = true;
    service.refreshGate();
    await waitFor(() => f.streams.length >= 2, 'opening the gate re-attaches the watch');
  } finally { gate = true; await service.close(); await f.close(); }
});
