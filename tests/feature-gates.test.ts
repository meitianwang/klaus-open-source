// FeatureGatesService — the desktop host side of the server-controlled gates.
//
// The server owns eligibility (src/feature-gates.ts); this suite pins the host
// contract around it: fail-closed boot, cache bound to the account that
// fetched it, refresh keeping the last good value on failure, change-only
// pushes, and the onChanged hook that suspends/resumes gated background work.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { CLIENT_DEFAULTS, FeatureGatesService, type FeatureGatesDeps } from '../main/services/feature-gates';
import { registerFeatureGateHandlers } from '../main/ipc/handlers/feature-gates';
import { Harness } from './harness';

function fixture(config?: { features?: Record<string, boolean> | null; ok?: boolean }) {
  const configRoot = mkdtempSync(join(tmpdir(), 'klaus-feature-gates-'));
  let accountId: string | null = 'alice';
  const pushes: Record<string, boolean>[] = [];
  const changed: Record<string, boolean>[] = [];
  const logs: string[] = [];
  let next: Json = config?.ok === false
    ? { ok: false, error: 'config_unavailable' }
    : { ok: true, config: { features: config?.features ?? { teamCollaboration: true } } };
  const deps: FeatureGatesDeps = {
    configRoot,
    clientConfig: async () => next,
    accountId: () => accountId,
    push: features => pushes.push(features),
    onChanged: features => changed.push(features),
    log: message => logs.push(message),
  };
  const service = new FeatureGatesService(deps);
  return {
    configRoot, service, pushes, changed, logs, deps,
    setAccount: (value: string | null) => { accountId = value; },
    setResponse: (value: Json) => { next = value; },
    cacheFile: () => join(configRoot, 'feature-gates.json'),
    readCache: () => JSON.parse(readFileSync(join(configRoot, 'feature-gates.json'), 'utf8')) as { features: Record<string, boolean>; accountId: string | null; fetchedAt: number },
    close: () => service.close(),
  };
}

const h = new Harness(), deadline = setTimeout(() => { process.stderr.write('Feature gates fixture exceeded 30 seconds\n'); process.exit(1); }, 30_000);

void (async () => {
  await h.test('gated features are fail-closed until the server resolves them', () => {
    const f = fixture();
    try {
      assert.equal(CLIENT_DEFAULTS.teamCollaboration, false);
      assert.deepEqual(f.service.snapshot(), { features: { teamCollaboration: false, adaptiveThreadTitles: false } });
      assert.equal(f.service.enabled('teamCollaboration'), false);
      // An unknown key with no server value is closed too.
      assert.equal(f.service.enabled('someOtherGatedFeature'), false);
    } finally { f.close(); }
  });

  await h.test('a successful refresh adopts server values, caches them bound to the account, and pushes once', async () => {
    const f = fixture({ features: { teamCollaboration: true, futureFeature: false } });
    try {
      await f.service.refresh();
      assert.deepEqual(f.service.snapshot().features, { teamCollaboration: true, futureFeature: false, adaptiveThreadTitles: false });
      const cache = f.readCache();
      assert.deepEqual(cache.features, { teamCollaboration: true, futureFeature: false });
      assert.equal(cache.accountId, 'alice');
      assert.equal(typeof cache.fetchedAt, 'number');
      assert.equal(f.pushes.length, 1, 'one change from the closed default to the server answer');
      assert.equal(f.changed.length, 1);
      // A second identical refresh is silent: no push, no onChanged.
      await f.service.refresh();
      assert.equal(f.pushes.length, 1);
      assert.equal(f.changed.length, 1);
    } finally { f.close(); }
  });

  await h.test('boot adopts a matching-account cache synchronously and ignores another account\u2019s gates', async () => {
    const first = fixture({ features: { teamCollaboration: true } });
    await first.service.refresh();
    const configRoot = first.configRoot;
    first.close();

    // Same account: the cache answers the very first snapshot, no flash of closed.
    const sameAccount = new FeatureGatesService({
      configRoot, clientConfig: async () => ({ ok: false }), accountId: () => 'alice',
      push: () => {}, log: () => {},
    });
    assert.equal(sameAccount.enabled('teamCollaboration'), true, 'cached gates apply at construction');
    sameAccount.close();

    // Different account on the same machine: cached gates must NOT apply.
    const otherAccount = new FeatureGatesService({
      configRoot, clientConfig: async () => ({ ok: false }), accountId: () => 'bob',
      push: () => {}, log: () => {},
    });
    assert.equal(otherAccount.enabled('teamCollaboration'), false, 'another user\u2019s rollout must not leak');
    otherAccount.close();

    // Guest (null account) never inherits a signed-in cache either.
    const guest = new FeatureGatesService({
      configRoot, clientConfig: async () => ({ ok: false }), accountId: () => null,
      push: () => {}, log: () => {},
    });
    assert.equal(guest.enabled('teamCollaboration'), false);
    guest.close();
  });

  await h.test('refresh failure keeps the last known gates instead of flipping features off', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    try {
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), true);
      // Control plane goes away: {ok:false} or a config with no feature map.
      // Neither is a revocation, so the cached answer is held.
      f.setResponse({ ok: false, error: 'config_unavailable' });
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), true, 'unreachable server keeps the cached answer');
      f.setResponse({ ok: true, config: {} });
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), true, 'a config with no feature map is not a revocation');
      assert.equal(f.pushes.length, 1, 'no spurious change pushes while holding the last good value');
    } finally { f.close(); }
  });

  await h.test('a corrupt per-key value falls back to the fail-closed default, not the stale open value', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    try {
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), true);
      // A well-formed response whose value is garbage: dropping the key must
      // fail CLOSED (false), which is safer than keeping the prior open value.
      f.setResponse({ ok: true, config: { features: { teamCollaboration: 'yes' } } });
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), false, 'non-boolean value is dropped to the closed default');
    } finally { f.close(); }
  });

  await h.test('an explicit server revocation flips the gate off and notifies consumers', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    try {
      await f.service.refresh();
      f.setResponse({ ok: true, config: { features: { teamCollaboration: false } } });
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), false);
      assert.equal(f.pushes.length, 2);
      assert.equal(f.changed.length, 2);
      assert.equal(f.changed[1]!.teamCollaboration, false);
    } finally { f.close(); }
  });

  await h.test('account change drops the previous user\u2019s gates synchronously and re-pulls their own', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    try {
      await f.service.refresh();
      assert.equal(f.service.enabled('teamCollaboration'), true);
      // bob is not in the rollout: server answers false for him. Before the
      // response lands, alice's open gate must already be gone.
      f.setAccount('bob');
      let slow!: (value: Json) => void;
      f.deps.clientConfig = () => new Promise<Json>(resolve => { slow = resolve; });
      const pending = f.service.accountChanged();
      assert.equal(f.service.enabled('teamCollaboration'), false, 'fail-closed the moment the account changes');
      f.setResponse({ ok: true, config: { features: { teamCollaboration: false } } });
      slow({ ok: true, config: { features: { teamCollaboration: false } } });
      await pending;
      assert.equal(f.service.enabled('teamCollaboration'), false);
      assert.equal(f.readCache().accountId, 'bob');
    } finally { f.close(); }
  });

  await h.test('a response resolving for a superseded account is discarded', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    try {
      let release!: (value: Json) => void;
      const pending = new Promise<Json>(resolve => { release = resolve; });
      f.setResponse({ ok: true, config: { features: { teamCollaboration: true } } });
      const original = f.deps.clientConfig;
      f.deps.clientConfig = () => pending;
      const inflight = f.service.refresh();
      // The account logs out mid-flight; the late answer must not land.
      f.setAccount(null);
      release({ ok: true, config: { features: { teamCollaboration: true } } });
      await inflight;
      assert.equal(f.service.enabled('teamCollaboration'), false, 'stale-account response discarded');
      f.deps.clientConfig = original;
    } finally { f.close(); }
  });

  await h.test('the snapshot IPC channel answers the resolved map to the renderer', async () => {
    const f = fixture({ features: { teamCollaboration: true } });
    const registry = new ChannelRegistry();
    registerFeatureGateHandlers(registry, f.service);
    try {
      await f.service.refresh();
      const handler = registry.lookup('featureGates:snapshot')!;
      const result = await handler({ role: 'main', senderId: 1, channel: 'featureGates:snapshot', args: [] });
      assert.deepEqual(result, { features: { teamCollaboration: true, adaptiveThreadTitles: false } });
    } finally { f.close(); }
  });

  await h.test('a corrupt cache file is ignored, never fatal', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'klaus-feature-gates-'));
    writeFileSync(join(configRoot, 'feature-gates.json'), '{ not json');
    const service = new FeatureGatesService({
      configRoot, clientConfig: async () => ({ ok: false }), accountId: () => 'alice',
      push: () => {}, log: () => {},
    });
    try {
      assert.deepEqual(service.snapshot(), { features: { teamCollaboration: false, adaptiveThreadTitles: false } });
    } finally { service.close(); }
  });

  process.exitCode = await h.finish(join(__dirname, 'feature-gates-result.json'), 'feature-gates');
  clearTimeout(deadline);
})().catch(error => { clearTimeout(deadline); process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
