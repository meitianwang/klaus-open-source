import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionAuthService, type SubscriptionAuthDeps } from '../main/services/subscription-auth';
import { rpcAdmission } from '../main/engine/request-scheduler';
import { object, type JsonObject } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { waitFor, type Harness } from './harness';

export function registerAntigravityLoginTests(h: Harness): void {
  const vector = () => readFile(join(__dirname, '../../contracts/vectors/antigravity-login-vectors.json'), 'utf8').then(raw => JSON.parse(raw));
  async function fixture(reply?: (method: string, params: JsonObject) => Promise<Json>, override: Partial<SubscriptionAuthDeps> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'klaus-antigravity-login-'));
    const data = await vector(), calls: Array<{ method: string; params: JsonObject }> = [], urls: string[] = [];
    let publications = 0;
    const service = new SubscriptionAuthService({ configRoot: root, homeDir: root,
      request: async (method, params) => {
        calls.push({ method, params: object(params) });
        if (reply) return reply(method, object(params));
        return method === 'antigravity/loginStart' ? data.start
          : method === 'antigravity/loginPoll' || method === 'antigravity/adoptCredential' ? data.complete : data.cancelled;
      }, openExternal: async url => { urls.push(url); }, onAuthChanged: () => { publications++; }, ...override,
    });
    return { root, data, calls, urls, service, publications: () => publications,
      close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
  }

  h.test('browser authorization uses named login methods and publishes only a completed account', async () => {
    const data = await vector(); let polls = 0;
    const f = await fixture(async method => method === 'antigravity/loginStart' ? data.start
      : method === 'antigravity/loginPoll' ? (++polls === 1 ? data.pending : data.complete) : data.cancelled);
    try {
      assert.deepEqual(await f.service.antigravityStart(), data.start);
      assert.deepEqual(f.urls, [data.start.authUrl]);
      assert.deepEqual(await f.service.antigravityPoll(data.start.flowId), data.pending);
      assert.equal(f.publications(), 0);
      assert.deepEqual(await f.service.antigravityPoll(data.start.flowId), data.complete);
      assert.equal(f.publications(), 1);
      await f.service.close();
      assert.deepEqual(f.calls.map(row => row.method), ['antigravity/loginStart', 'antigravity/loginPoll', 'antigravity/loginPoll']);
      assert.deepEqual(f.calls[1]!.params, { flow: { flowId: data.start.flowId } });
      assert.equal(rpcAdmission('antigravity/loginCancel', { flow: { flowId: data.start.flowId } }, 1000).priority, 'critical');
    } finally { await f.close(); }
  });

  h.test('an invalid authorization URL or failed browser handoff cancels only its own login', async () => {
    const data = await vector();
    for (const authUrl of ['not-a-url', 'https://example.invalid/o/oauth2/auth', 'https://accounts.google.com/other', 'https://name@accounts.google.com/o/oauth2/auth']) {
      const f = await fixture(async method => method === 'antigravity/loginStart' ? { ...data.start, authUrl } : data.cancelled);
      try {
        assert.deepEqual(await f.service.antigravityStart(), { ok: false, error: 'antigravity_login_url_invalid' });
        assert.equal(f.urls.length, 0);
        assert.deepEqual(f.calls.map(row => row.method), ['antigravity/loginStart', 'antigravity/loginCancel']);
      } finally { await f.close(); }
    }
    const f = await fixture(undefined, { openExternal: async () => { throw new Error('private platform detail'); } });
    try {
      assert.deepEqual(await f.service.antigravityStart(), { ok: false, error: 'antigravity_login_browser_failed' });
      assert.equal(f.calls.at(-1)!.method, 'antigravity/loginCancel');
    } finally { await f.close(); }
  });

  h.test('signing out while browser login starts prevents browser launch and stale success', async () => {
    const data = await vector(); let release!: (value: Json) => void;
    const started = new Promise<Json>(resolve => { release = resolve; });
    const f = await fixture(async method => method === 'antigravity/loginStart' ? started : data.cancelled);
    try {
      const start = f.service.antigravityStart();
      await waitFor(() => f.calls.length === 1, 1000, 'browser login starts');
      const logout = f.service.antigravityLogout();
      release(data.start);
      assert.deepEqual(await start, { ok: false, error: 'antigravity_login_cancelled' });
      await logout;
      assert.equal(f.urls.length, 0);
      assert.deepEqual(f.calls.map(row => row.method), ['antigravity/loginStart', 'antigravity/loginCancel', 'antigravity/logout']);
    } finally { release(data.start); await f.close(); }
  });

  h.test('a cancelled delayed poll cannot publish or remove a newer browser login', async () => {
    const data = await vector(); let starts = 0, release!: (value: Json) => void;
    const delayed = new Promise<Json>(resolve => { release = resolve; });
    const f = await fixture(async (method, params) => method === 'antigravity/loginStart'
      ? { ...data.start, flowId: ++starts === 1 ? 'old-flow' : 'new-flow' }
      : method === 'antigravity/loginPoll' ? object(params.flow).flowId === 'old-flow' ? delayed : data.complete : data.cancelled);
    try {
      await f.service.antigravityStart();
      const poll = f.service.antigravityPoll('old-flow');
      await waitFor(() => f.calls.some(row => row.method === 'antigravity/loginPoll'), 1000, 'the old login poll starts');
      await f.service.antigravityCancel('old-flow');
      const newer = f.service.antigravityStart();
      release(data.complete);
      assert.deepEqual(await poll, { ok: false, error: 'antigravity_login_cancelled' });
      assert.equal(object(await newer).flowId, 'new-flow');
      const before = f.calls.length;
      await f.service.antigravityCancel('old-flow');
      assert.equal(f.calls.length, before, 'a late cancellation cannot touch the new flow');
      assert.equal(object(await f.service.antigravityPoll('new-flow')).ok, true);
      assert.equal(f.publications(), 1);
      assert(!f.calls.some(row => row.method === 'antigravity/logout'));
    } finally { release(data.complete); await f.close(); }
  });

  h.test('cancellation during account publication uses flow ownership instead of signing out another account', async () => {
    const data = await vector(); let publishing = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(undefined, { onAuthChanged: async () => { publishing = true; await gate; } });
    try {
      await f.service.antigravityStart();
      const poll = f.service.antigravityPoll(data.start.flowId);
      await waitFor(() => publishing, 1000, 'account publication starts');
      await f.service.antigravityCancel(data.start.flowId); release();
      assert.deepEqual(await poll, { ok: false, error: 'antigravity_login_cancelled' });
      assert(f.calls.some(row => row.method === 'antigravity/loginCancel'));
      assert(!f.calls.some(row => row.method === 'antigravity/logout'));
    } finally { release(); await f.close(); }
  });

  h.test('local credential reuse cancels a pending browser flow and keeps the external credential unchanged', async () => {
    const f = await fixture();
    try {
      const file = join(f.root, '.gemini', 'jetski-standalone-oauth-token');
      await mkdir(join(f.root, '.gemini'));
      const raw = JSON.stringify({ auth_method: 'consumer', token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } });
      await writeFile(file, raw);
      await f.service.antigravityStart();
      assert.equal(object(await f.service.antigravityImportLocal()).loggedIn, true);
      assert.deepEqual(f.calls.map(row => row.method), ['antigravity/loginStart', 'antigravity/loginCancel', 'antigravity/adoptCredential']);
      assert.equal(await readFile(file, 'utf8'), raw);
      assert.equal(f.publications(), 1);
    } finally { await f.close(); }
  });

  h.test('closing the account service cancels its active browser flow and rejects later polls', async () => {
    const f = await fixture();
    try {
      await f.service.antigravityStart();
      await f.service.close();
      assert.deepEqual(f.calls.map(row => row.method), ['antigravity/loginStart', 'antigravity/loginCancel']);
      assert.deepEqual(await f.service.antigravityPoll(f.data.start.flowId), { ok: false, error: 'antigravity_login_cancelled' });
    } finally { await f.close(); }
  });

  h.test('closing a queued replacement cannot forget the previous native login flow', async () => {
    for (const action of ['start', 'reuse', 'logout'] as const) {
      const f = await fixture();
      try {
        await f.service.antigravityStart();
        const replacement = action === 'start' ? f.service.antigravityStart()
          : action === 'reuse' ? f.service.antigravityImportLocal() : f.service.antigravityLogout();
        const closing = f.service.close();
        assert.equal(object(await replacement).ok, false);
        await closing;
        assert.deepEqual(f.calls.filter(row => row.method === 'antigravity/loginCancel').map(row => row.params),
          [{ flow: { flowId: f.data.start.flowId } }]);
        assert.equal(f.calls.filter(row => row.method === 'antigravity/loginStart').length, 1);
        assert.equal(f.publications(), 0);
      } finally { await f.close(); }
    }
  });
}
