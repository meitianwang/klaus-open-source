import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Json } from '../main/ipc/contract';
import type { JsonObject } from '../main/services/service-types';
import { object, string } from '../main/services/service-types';
import { GitService } from '../main/services/git';
import { WorktreeService } from '../main/services/worktrees';
import { WorkspaceStore } from '../main/services/workspaces';
import { sameOwner } from '../main/services/mobile/protocol';
import { Harness } from './harness';
import { mobileFixture } from './mobile-fixture';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-new-chat-vectors.json'), 'utf8')) as { features: JsonObject; contextFields: string[]; noProject: JsonObject; workspace: JsonObject; nonGit: JsonObject; emptyGit: JsonObject; branchConflict: JsonObject; promotion: JsonObject };
async function present(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function repositoryFixture() {
  const diagnostics: { event: string; fields: JsonObject }[] = [];
  const f = await mobileFixture({ log: (event, fields) => { if (diagnostics.length >= 100) diagnostics.shift(); diagnostics.push({ event, fields }); } }), project = join(f.root, 'project');
  await mkdir(project); await writeFile(join(project, 'tracked.txt'), 'base\n');
  const workspaces = new WorkspaceStore({ configRoot: join(f.root, 'host'), push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const git = new GitService({ workspaces, openPath: async () => {}, revealPath: () => {}, sideQuestion: async () => ({ response: '' }), push: () => {},
    processOptions: { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: f.root } } });
  const worktrees = new WorktreeService({ git, workspaces, openPath: async () => {}, beforeRemove: async () => {}, onRemoved: () => {} });
  let override: ((channel: string, payload: JsonObject) => Promise<Json | undefined>) | undefined;
  f.intercept(async (channel, payload, context) => {
    const intercepted = await override?.(channel, payload); if (intercepted !== undefined) return intercepted;
    switch (channel) {
      case 'projects:list': return { activeRoot: project, roots: [{ path: project, label: 'Fixture project' }] };
      case 'git:branches': return git.branches(payload);
      case 'git:uncommitted': return git.uncommitted(payload);
      case 'git:checkout': return git.checkout(payload);
      case 'git:commit-paths': return git.commitPaths(payload);
      case 'worktree:create-from-workdir': return worktrees.create(payload, () => {
        context.signal.throwIfAborted();
        if (!sameOwner(context.owner, f.owner())) throw new Error('fixture worktree owner changed');
      });
      case 'worktree:remove': return worktrees.remove(payload);
      case 'session:new':
        if (payload.workdir) workspaces.bindSession('s' + (f.sessions.length + 1), { workdir: string(payload.workdir), projectRoot: string(payload.projectRoot) });
        return undefined;
      case 'session:delete': workspaces.forgetSession(string(payload.sessionId)); return undefined;
      default: return undefined;
    }
  });
  const command = async (args: string[]) => {
    const result = await git.process.run(project, args);
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  const init = async (empty = false) => {
    await command(['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgSign', 'false']]) await command(['config', key!, value!]);
    if (!empty) { await command(['add', 'tracked.txt']); await command(['commit', '-m', 'Initial fixture']); }
  };
  await f.enable();
  return { f, project, git, worktrees, workspaces, command, init, diagnostics,
    intercept: (value: typeof override) => { override = value; },
    close: async () => { worktrees.close(); await git.close(); await f.close(); } };
}

export async function registerMobileNewChatTests(h: Harness): Promise<void> {
  await h.test('new-chat context pins no-project, workspace, non-Git, unborn and Git capabilities to committed vectors', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      assert.equal(object((await f.request('GET', '/api/mobile/bootstrap')).body.features).newChatContext, vectors.features!.newChatContext);
      const none = await f.request('POST', '/api/mobile/new-chat/context', {});
      assert.equal(none.status, 200); assert.deepEqual(none.body, vectors.noProject);
      const space = await f.request('POST', '/api/mobile/new-chat/context', { workspaceId: 'ws-fixture' });
      assert.equal(space.status, 200); assert.deepEqual(space.body, vectors.workspace);
      const plain = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.equal(plain.status, 200); assert.deepEqual(plain.body, vectors.nonGit);
      await fixture.init(true);
      const empty = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.equal(empty.status, 200); assert.deepEqual(empty.body, { ...vectors.emptyGit, gitRoot: project });
      const runProcess = fixture.git.process.run.bind(fixture.git.process);
      fixture.git.process.run = async (cwd, args, options) => args.includes('--abbrev-ref')
        ? { code: 128, stdout: '', stderr: 'fixture Git HEAD permission failure', truncated: false } : runProcess(cwd, args, options);
      const processFailure = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.equal(processFailure.status, 500); assert.equal(object(processFailure.body.error).type, 'fixture Git HEAD permission failure');
      fixture.git.process.run = runProcess;
      await fixture.command(['add', 'tracked.txt']); await fixture.command(['commit', '-m', 'First commit']);
      await writeFile(join(project, 'tracked.txt'), 'edited\n');
      const ready = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.deepEqual(Object.keys(ready.body).sort(), (vectors.contextFields as string[]).slice().sort());
      assert.equal(ready.body.isGit, true); assert.equal(ready.body.current, 'main'); assert.deepEqual(ready.body.branches, ['main']);
      assert.equal(ready.body.gitRoot, project); assert.equal(ready.body.dirty, true); assert.equal(ready.body.changes, 1);
      assert.equal(ready.body.worktreeEnabled, true); assert.equal(ready.body.worktreeDisabledReason, null);
      assert.equal((await f.request('POST', '/api/mobile/new-chat/context', { workdir: '/unknown' })).status, 403);
      assert.equal((await f.request('POST', '/api/mobile/new-chat/context', { workspaceId: 'unknown' })).status, 403);
      fixture.intercept(async channel => channel === 'git:branches' ? { ok: false, error: 'fixture_git_io_failure' } : undefined);
      const failed = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.equal(failed.status, 500); assert.equal(object(failed.body.error).type, 'fixture_git_io_failure');
    } finally { await fixture.close(); }
  });
  await h.test('new-chat branch switches the real project and commits only freshly computed conflict files after explicit confirmation', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init(); await fixture.command(['checkout', '-b', 'feature']);
      await writeFile(join(project, 'tracked.txt'), 'feature\n');
      await fixture.command(['add', 'tracked.txt']); await fixture.command(['commit', '-m', 'Feature fixture']); await fixture.command(['checkout', 'main']);
      await writeFile(join(project, 'tracked.txt'), 'edited\n'); await writeFile(join(project, 'unrelated.txt'), 'keep local\n');
      const blocked = await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'feature' });
      const { status, ...body } = vectors.branchConflict!; assert.equal(blocked.status, status); assert.deepEqual(blocked.body, body);
      assert.equal(await fixture.command(['branch', '--show-current']), 'main');
      assert(!f.calls.some(row => row.channel === 'git:checkout' || row.channel === 'git:commit-paths'));
      assert.equal((await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'feature', commitConflicts: true, commitMessage: 'Save conflict', files: ['unrelated.txt'] })).status, 400);
      const accepted = await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'feature', commitConflicts: true, commitMessage: 'Save conflict' });
      assert.equal(accepted.status, 200); assert.equal(accepted.body.ok, true); assert.equal(accepted.body.current, 'feature');
      assert.deepEqual((accepted.body.branches as string[]).slice().sort(), ['feature', 'main']);
      assert.deepEqual(f.calls.filter(row => row.channel === 'git:commit-paths').map(row => row.payload.paths), [['tracked.txt']]);
      assert.equal(await fixture.command(['show', 'main:tracked.txt']), 'edited');
      assert.equal(await readFile(join(project, 'unrelated.txt'), 'utf8'), 'keep local\n');
      assert((await fixture.command(['status', '--porcelain'])).includes('?? unrelated.txt'));
      const created = await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'fresh', create: true });
      assert.equal(created.body.ok, true); assert.equal(created.body.current, 'fresh');
      for (const branch of ['--detach', 'main\u0000bad', 'main~1', 'unknown']) {
        assert.equal((await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch })).status, 400);
      }
      assert.equal((await f.request('POST', '/api/mobile/new-chat/branch', { workdir: '/unknown', branch: 'main' })).status, 403);
    } finally { await fixture.close(); }
  });
  await h.test('confirmed local checkout recomputes conflicts instead of reusing files from an earlier phone sheet', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init(); await fixture.command(['checkout', '-b', 'feature']);
      await writeFile(join(project, 'tracked.txt'), 'feature\n'); await fixture.command(['add', 'tracked.txt']); await fixture.command(['commit', '-m', 'Feature']); await fixture.command(['checkout', 'main']);
      await writeFile(join(project, 'tracked.txt'), 'edited\n');
      assert.equal((await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'feature' })).body.needsCommit, true);
      await fixture.command(['restore', 'tracked.txt']);
      const accepted = await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'feature', commitConflicts: true, commitMessage: 'Old sheet' });
      assert.equal(accepted.body.ok, true); assert.equal(accepted.body.current, 'feature');
      assert(!f.calls.some(row => row.channel === 'git:commit-paths'));
    } finally { await fixture.close(); }
  });
  await h.test('worktree first-send promotion creates one isolated checkout with origin membership and carries edits without switching the original', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init(); await writeFile(join(project, 'tracked.txt'), 'local edit\n'); await writeFile(join(project, 'new.txt'), 'new content\n');
      const payload = { clientDraftId: 'worktree-same', workdir: project, runMode: 'worktree', baseRef: 'main', includeUncommitted: true, initialMessage: { text: 'First worktree turn', clientMessageId: 'same-message' } };
      const [one, two] = await Promise.all([f.request('POST', '/api/mobile/sessions', payload), f.request('POST', '/api/mobile/sessions', payload)]);
      assert.equal(one.status, 201); assert.deepEqual(one.body, two.body);
      assert.equal(one.body.projectRoot, project); assert.equal(one.body.workspaceId, null);
      const path = string(one.body.workdir); assert.notEqual(path, project); assert.equal(await readFile(join(path, 'tracked.txt'), 'utf8'), 'local edit\n');
      assert.equal(await readFile(join(path, 'new.txt'), 'utf8'), 'new content\n');
      assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'local edit\n');
      assert.equal(await fixture.command(['branch', '--show-current']), 'main');
      assert.equal(f.calls.filter(row => row.channel === 'worktree:create-from-workdir').length, 1);
      assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 1); assert.equal(f.sent.length, 1);
      assert.deepEqual(f.calls.find(row => row.channel === 'session:new')!.payload, { workdir: path, projectRoot: project });
      for (const changed of [{ ...payload, runMode: 'local', baseRef: null, includeUncommitted: false }, { ...payload, baseRef: null }, { ...payload, initialMessage: { text: 'Different turn' } }, { ...payload, workdir: '/unknown' }]) {
        const conflict = await f.request('POST', '/api/mobile/sessions', changed); assert.equal(conflict.status, vectors.promotion!.differentDraftStatus); assert.equal(object(conflict.body.error).type, vectors.promotion!.differentDraftCode);
      }
      assert.equal(f.sent.length, 1);
      fixture.workspaces.forgetSession(string(one.body.id));
      assert.equal(object(await fixture.worktrees.remove({ path })).ok, true);
    } finally { await fixture.close(); }
  });
  await h.test('failed worktree promotion removes its copied dirty checkout and owned session while preserving the original rejection and project', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init(); await writeFile(join(project, 'tracked.txt'), 'original edits\n'); await writeFile(join(project, 'new.txt'), 'original untracked\n');
      const before = await fixture.command(['status', '--porcelain']);
      for (const stage of ['session:new', 'chat:send']) {
        fixture.intercept(async channel => channel === stage ? { ok: false, error: 'fixture_' + stage.replace(':', '_') + '_failed' } : undefined);
        const response = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'fail-' + stage, workdir: project, runMode: 'worktree', includeUncommitted: true, initialMessage: { text: 'Rejected' } });
        assert.equal(response.status, 500); assert.equal(object(response.body.error).type, 'fixture_' + stage.replace(':', '_') + '_failed');
        const removal = f.calls.filter(row => row.channel === 'worktree:remove').at(-1)!;
        assert(removal); assert.notEqual(removal.payload.path, project); assert.equal(await present(string(removal.payload.path)), false);
        assert.equal(f.sessions.length, 2); assert.equal(await fixture.command(['status', '--porcelain']), before);
        assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'original edits\n');
        assert.equal(await readFile(join(project, 'new.txt'), 'utf8'), 'original untracked\n');
      }
      assert(f.calls.filter(row => row.channel === 'session:delete').every(row => row.payload.wipeWorkspace === vectors.promotion!.failedOwnedSessionWipe));
      assert.deepEqual(f.calls.filter(row => row.channel === 'session:new').length, 2, 'worktree failure never falls back to local session creation');
      fixture.intercept(async channel => channel === 'worktree:create-from-workdir' ? { ok: false, error: 'fixture_worktree_failed' } : undefined);
      const failed = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'worktree-failed', workdir: project, runMode: 'worktree', initialMessage: { text: 'Rejected' } });
      assert.equal(object(failed.body.error).type, 'fixture_worktree_failed'); assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 2);
    } finally { await fixture.close(); }
  });
  await h.test('a disconnected phone cannot cancel or duplicate its admitted worktree promotion', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    let release!: () => void, created!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { created = resolve; });
    try {
      await fixture.init();
      fixture.intercept(async (channel, payload) => {
        if (channel !== 'worktree:create-from-workdir') return undefined;
        const result = await fixture.worktrees.create(payload); created(); await gate; return result;
      });
      const payload = { clientDraftId: 'disconnected-promotion', workdir: project, runMode: 'worktree', initialMessage: { text: 'Exactly one accepted turn' } };
      const request = httpRequest({ hostname: '127.0.0.1', port: Number(f.status().port), method: 'POST', path: '/api/mobile/sessions', headers: { authorization: 'Bearer ' + f.status().token, 'content-type': 'application/json' } }, response => response.resume());
      request.on('error', () => {}); request.end(JSON.stringify(payload));
      await ready; request.destroy();
      const retry = f.request('POST', '/api/mobile/sessions', payload); release();
      const response = await retry; assert.equal(response.status, 201); assert.equal(response.body.accepted, true);
      assert.equal(f.calls.filter(row => row.channel === 'worktree:create-from-workdir').length, 1);
      assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 1); assert.equal(f.sent.length, 1);
      const path = string(response.body.workdir); fixture.workspaces.forgetSession(string(response.body.id));
      assert.equal(object(await fixture.worktrees.remove({ path })).ok, true);
    } finally { release(); await fixture.close(); }
  });
  await h.test('a failed draft retains its context identity while retrying the same content after repair', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      const payload = { clientDraftId: 'failed-identity', workdir: project, initialMessage: { text: 'Same first turn' } };
      fixture.intercept(async channel => channel === 'chat:send' ? { ok: false, error: 'fixture_send_rejected' } : undefined);
      assert.equal((await f.request('POST', '/api/mobile/sessions', payload)).status, 500);
      const changed = await f.request('POST', '/api/mobile/sessions', { ...payload, initialMessage: { text: 'Different first turn' } });
      assert.equal(changed.status, 409); assert.equal(object(changed.body.error).type, 'draft_context_mismatch');
      fixture.intercept(undefined);
      assert.equal((await f.request('POST', '/api/mobile/sessions', payload)).status, 201);
      assert.equal(f.sent.length, 1); assert.equal(f.sessions.length, 3);
    } finally { await fixture.close(); }
  });
  await h.test('an accepted draft cannot return a previous engine owner outcome through a replacement engine', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      const payload = { clientDraftId: 'owner-bound-draft', workdir: project, initialMessage: { text: 'Owner-bound first turn' } };
      assert.equal((await f.request('POST', '/api/mobile/sessions', payload)).status, 201);
      f.replaceOwner();
      const retry = await f.request('POST', '/api/mobile/sessions', payload);
      assert.equal(retry.status, 409); assert.equal(object(retry.body.error).type, 'engine_replaced');
      assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 1); assert.equal(f.sent.length, 1);
    } finally { await fixture.close(); }
  });
  await h.test('commit-and-switch remains admitted after the requesting phone disconnects', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    let release!: () => void, committed!: () => void, switched!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { committed = resolve; });
    const complete = new Promise<void>(resolve => { switched = resolve; });
    try {
      await fixture.init(); await fixture.command(['checkout', '-b', 'feature']);
      await writeFile(join(project, 'tracked.txt'), 'feature\n'); await fixture.command(['add', 'tracked.txt']); await fixture.command(['commit', '-m', 'Feature']); await fixture.command(['checkout', 'main']);
      await writeFile(join(project, 'tracked.txt'), 'save before switching\n');
      fixture.intercept(async (channel, payload) => {
        if (channel === 'git:commit-paths') { const result = await fixture.git.commitPaths(payload); committed(); await gate; return result; }
        if (channel === 'git:checkout') { const result = await fixture.git.checkout(payload); switched(); return result; }
        return undefined;
      });
      const payload = { workdir: project, branch: 'feature', commitConflicts: true, commitMessage: 'Save conflict' };
      const request = httpRequest({ hostname: '127.0.0.1', port: Number(f.status().port), method: 'POST', path: '/api/mobile/new-chat/branch', headers: { authorization: 'Bearer ' + f.status().token, 'content-type': 'application/json' } }, response => response.resume());
      request.on('error', () => {}); request.end(JSON.stringify(payload)); await ready; request.destroy(); release(); await complete;
      assert.equal(await fixture.command(['branch', '--show-current']), 'feature');
      assert.equal(await fixture.command(['show', 'main:tracked.txt']), 'save before switching');
      assert.equal(f.calls.filter(row => row.channel === 'git:commit-paths').length, 1); assert.equal(f.calls.filter(row => row.channel === 'git:checkout').length, 1);
    } finally { release(); await fixture.close(); }
  });
  await h.test('worktree creation fences remove copied edits when ownership or cancellation changes before returning its path', async () => {
    for (const change of ['owner', 'cancel']) {
      const fixture = await repositoryFixture(), { f, project } = fixture;
      const controller = new AbortController();
      let path = '';
      try {
        await fixture.init(); await writeFile(join(project, 'tracked.txt'), 'unchanged original edits\n');
        const before = await fixture.command(['status', '--porcelain']);
        const runProcess = fixture.git.process.run.bind(fixture.git.process);
        fixture.git.process.run = async (cwd, args, options) => {
          const result = await runProcess(cwd, args, options);
          if (args[0] === 'worktree' && args[1] === 'add') path = args[4]!;
          if (args[0] === 'stash' && args[1] === 'apply') {
            if (change === 'owner') f.replaceOwner(); else controller.abort();
          }
          return result;
        };
        if (change === 'owner') {
          const response = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'fenced-owner', workdir: project, runMode: 'worktree', includeUncommitted: true, initialMessage: { text: 'No stale creation' } });
          assert.equal(response.status, 409); assert.equal(object(response.body.error).type, 'engine_replaced');
        } else {
          const response = object(await fixture.worktrees.create({ workdir: project, includeUncommitted: true }, () => controller.signal.throwIfAborted()));
          assert.equal(response.ok, false);
        }
        assert(path); assert.notEqual(path, project); assert.equal(await present(path), false);
        assert.equal(await fixture.command(['status', '--porcelain']), before);
        assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'unchanged original edits\n');
        assert(!f.calls.some(row => ['session:new', 'chat:send'].includes(row.channel)));
      } finally { await fixture.close(); }
    }
  });
  await h.test('an unresolved owned cleanup remains diagnostic and cannot allocate another worktree on retry', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init();
      fixture.intercept(async channel => channel === 'chat:send' ? { ok: false, error: 'fixture_turn_rejected' }
        : channel === 'worktree:remove' ? { ok: false, error: 'fixture_cleanup_unavailable' } : undefined);
      const payload = { clientDraftId: 'owned-cleanup-pending', workdir: project, runMode: 'worktree', initialMessage: { text: 'Rejected first turn' } };
      const first = await f.request('POST', '/api/mobile/sessions', payload), retry = await f.request('POST', '/api/mobile/sessions', payload);
      assert.equal(object(first.body.error).type, 'fixture_turn_rejected'); assert.equal(object(retry.body.error).type, 'fixture_turn_rejected');
      assert.equal(f.calls.filter(row => row.channel === 'worktree:create-from-workdir').length, 1);
      assert.equal(f.calls.filter(row => row.channel === 'session:new').length, 1); assert.equal(f.sessions.length, 2);
      assert(fixture.diagnostics.some(row => row.event === 'mobile_draft_worktree_cleanup_failed' && row.fields.code === 'fixture_cleanup_unavailable'));
      const path = string(f.calls.find(row => row.channel === 'worktree:remove')!.payload.path);
      assert.equal(await present(path), true); assert.equal(object(await fixture.worktrees.remove({ path })).ok, true);
    } finally { await fixture.close(); }
  });
  await h.test('worktree promotion rejects workspace, projectless, non-Git and malformed options before creating any resources', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      for (const target of [{}, { workspaceId: 'ws-fixture' }, { workdir: project }] as JsonObject[]) {
        const response = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'invalid-' + JSON.stringify(target), ...target, runMode: 'worktree', initialMessage: { text: 'No creation' } });
        assert.equal(response.status, vectors.promotion!.unavailableWorktreeStatus); assert.equal(object(response.body.error).type, vectors.promotion!.unavailableWorktreeCode);
      }
      for (const fields of [{ runMode: 'unknown' }, { runMode: 'local', baseRef: 'main' }, { runMode: 'worktree', includeUncommitted: 'yes' }, { runMode: 'worktree', baseRef: '--detach' }] as JsonObject[]) {
        assert.equal((await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'invalid-options', workdir: project, ...fields, initialMessage: { text: 'No creation' } })).status, 400);
      }
      assert(!f.calls.some(row => ['session:new', 'worktree:create-from-workdir', 'chat:send'].includes(row.channel)));
      await fixture.init(true);
      const unborn = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'unborn', workdir: project, runMode: 'worktree', initialMessage: { text: 'No creation' } });
      assert.equal(object(unborn.body.error).type, 'worktree_unavailable');
      assert(!f.calls.some(row => ['session:new', 'worktree:create-from-workdir', 'chat:send'].includes(row.channel)));
    } finally { await fixture.close(); }
  });
  await h.test('new-chat context and branch operations retain authentication and pinned engine ownership', async () => {
    const fixture = await repositoryFixture(), { f, project } = fixture;
    try {
      await fixture.init();
      assert.equal((await f.request('POST', '/api/mobile/new-chat/context', { workdir: project }, {})).status, 401);
      assert.equal((await f.request('POST', '/api/mobile/new-chat/branch', { workdir: project, branch: 'main' }, {})).status, 401);
      fixture.intercept(async channel => { if (channel === 'git:branches') f.replaceOwner(); return undefined; });
      const response = await f.request('POST', '/api/mobile/new-chat/context', { workdir: project });
      assert.equal(response.status, 409); assert.equal(object(response.body.error).type, 'engine_replaced');
      assert(!f.calls.some(row => ['git:checkout', 'git:commit-paths', 'worktree:create-from-workdir', 'chat:send'].includes(row.channel)));
    } finally { await fixture.close(); }
  });
}
