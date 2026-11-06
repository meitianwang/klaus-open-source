import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { claudeUsageCacheKey, UsageService, type UsageDeps } from '../main/services/usage';
import { assert, assertDeepEqual, assertEqual, type Harness } from './harness';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
function allowance(id = 'account-one', usedPercent = 10): Json {
  return { signedIn: true, accounts: [{ id, label: id, state: 'ok', windows: [{ id: 'five_hour', usedPercent }] }] };
}
function snapshot(value: Json): Record<string, Json> { return object(object(value).snapshot); }
function provider(value: Json): Record<string, Json> { return object(snapshot(value).provider); }
function service(deps: Partial<UsageDeps> = {}): UsageService {
  return new UsageService({ authMode: () => 'subscription', models: () => [], codexAccessToken: async () => undefined,
    request: async () => allowance(), keepAliveEnabled: false, ...deps });
}

export function registerUsageCacheTests(h: Harness): void {
  h.test('Claude usage combines concurrent reads across chats and retains the original fetch time until expiry', async () => {
    let now = 1_000, calls = 0;
    const started = deferred<void>(), reply = deferred<Json>();
    const usage = service({ now: () => now, claudeCacheKey: () => 'generation-one', request: async () => {
      calls++; started.resolve(); return calls === 1 ? reply.promise : allowance();
    } });
    try {
      const first = usage.query('chat-one');
      await started.promise;
      const second = usage.query('chat-two');
      reply.resolve(allowance());
      const [a, b] = await Promise.all([first, second]);
      assertEqual(calls, 1, 'concurrent chats share one upstream read');
      assertDeepEqual(a, b, 'coalesced replies agree');
      now += 29_999;
      const cached = await usage.query('chat-three');
      assertEqual(calls, 1, 'fresh allowance is reused');
      assertEqual(snapshot(cached).fetchedAt, 1_000, 'a cache hit does not claim a new upstream fetch');
      object((provider(cached).accounts as Json[])[0]).label = 'caller-mutation';
      assertEqual(object((provider(await usage.query()).accounts as Json[])[0]).label, 'account-one', 'callers cannot modify the cached value');
      now++;
      await usage.query();
      assertEqual(calls, 2, 'the successful response expires after thirty seconds');
    } finally { await usage.close(); }
  });

  h.test('Claude usage respects a cooldown for a rate-limited account and preserves healthy account windows', async () => {
    let now = 5_000, calls = 0;
    const usage = service({ now: () => now, request: async () => {
      calls++;
      return calls === 1 ? { signedIn: true, accounts: [
        { id: 'limited', label: 'limited', state: 'error', error: 'Usage request failed (HTTP 429)' },
        { id: 'healthy', label: 'healthy', state: 'ok', windows: [{ id: 'seven_day', usedPercent: 18 }] },
      ] } : allowance('healthy');
    } });
    try {
      const first = await usage.query();
      assertEqual(provider(first).error, 'Usage request failed (HTTP 429)', 'the upstream limit remains visible');
      const accounts = provider(first).accounts as Json[];
      assertDeepEqual(object(accounts[1]).windows, [{ id: 'seven_day', usedPercent: 18 }], 'other accounts retain their allowance');
      now += 59_999;
      assertDeepEqual(await usage.query(), first, 'manual refreshes reuse the result during cooldown');
      assertEqual(calls, 1, 'a refresh does not hit the limited endpoint again');
      now++;
      assertEqual(provider(await usage.query()).state, 'ok', 'a later read can recover');
      assertEqual(calls, 2, 'the cooldown ends after sixty seconds');
    } finally { await usage.close(); }
  });

  h.test('a facade-level Claude 429 also cools down while other errors remain briefly retryable', async () => {
    let now = 0, calls = 0;
    const usage = service({ now: () => now, request: async () => {
      calls++;
      if (calls === 1) throw new Error('Usage request failed (HTTP 429)');
      if (calls === 2) throw new Error('Network temporarily unavailable');
      return allowance();
    } });
    try {
      assertEqual(provider(await usage.query()).error, 'Usage request failed (HTTP 429)', 'facade failures preserve the HTTP status');
      now = 59_999; await usage.query();
      assertEqual(calls, 1, 'the facade error is subject to cooldown');
      now = 60_000; await usage.query();
      assertEqual(calls, 2, 'the rate-limit cooldown expires');
      now += 4_999; await usage.query();
      assertEqual(calls, 2, 'a short-lived transport failure does not trigger a click storm');
      now++;
      assertEqual(provider(await usage.query()).state, 'ok', 'transient failures retry after five seconds');
      assertEqual(calls, 3, 'a failed response is not cached as a successful long-lived result');
    } finally { await usage.close(); }
  });

  h.test('Claude account order and login generation invalidate cached allowance immediately', async () => {
    let key = 'first-login', calls = 0;
    const usage = service({ claudeCacheKey: () => key, request: async () => { calls++; return allowance('account-' + calls); } });
    try {
      await usage.query();
      key = 'second-login';
      assertEqual(provider(await usage.query()).id, 'account-2', 'a new login does not reuse the previous allowance');
      key = 'rotated-queue';
      assertEqual(provider(await usage.query()).id, 'account-3', 'an engine queue rotation refreshes the current account');
      usage.invalidateClaude();
      assertEqual(provider(await usage.query()).id, 'account-4', 'the authentication callback invalidates even an unchanged key');
      assertEqual(calls, 4, 'each identity transition reads exactly once');
    } finally { await usage.close(); }
  });

  h.test('an authentication change during an allowance read never returns or recaches the old account result', async () => {
    const started = deferred<void>(), oldReply = deferred<Json>();
    let calls = 0;
    const usage = service({ request: async () => {
      calls++;
      if (calls === 1) { started.resolve(); return oldReply.promise; }
      return allowance('new-account');
    } });
    try {
      const oldRead = usage.query();
      await started.promise;
      usage.invalidateClaude();
      assertEqual(provider(await usage.query()).id, 'new-account', 'the new login reads independently of the old pending request');
      oldReply.resolve(allowance('old-account'));
      assertEqual(provider(await oldRead).id, 'new-account', 'a stale completion converges to the current result');
      assertEqual(provider(await usage.query()).id, 'new-account', 'a stale completion cannot replace the new cache');
      assertEqual(calls, 2, 'the stale caller reuses the current result');
    } finally { await usage.close(); }
  });

  h.test('an engine queue change during an allowance read is detected without a host authentication callback', async () => {
    const started = deferred<void>(), oldReply = deferred<Json>();
    let key = 'queue-one', calls = 0;
    const usage = service({ claudeCacheKey: () => key, request: async () => {
      calls++;
      if (calls === 1) { started.resolve(); return oldReply.promise; }
      return allowance('queue-two');
    } });
    try {
      const first = usage.query(); await started.promise;
      key = 'queue-two';
      oldReply.resolve(allowance('queue-one'));
      assertEqual(provider(await first).id, 'queue-two', 'the in-flight caller rechecks the local queue before returning');
      assertEqual(calls, 2, 'a changed queue reads the new identity once');
    } finally { await usage.close(); }
  });

  h.test('Claude usage caching leaves other source reads and source-switch ownership intact', async () => {
    let mode = 'subscription', claudeCalls = 0, otherCalls = 0;
    const keyRead = deferred<string>();
    const usage = service({ authMode: () => mode, claudeCacheKey: () => keyRead.promise, request: async method => {
      if (method === 'claude/usage') { claudeCalls++; return allowance(); }
      otherCalls++; return { signedIn: true, quota: {} };
    } });
    try {
      const first = usage.query('same-chat');
      mode = 'qoder';
      assertEqual(snapshot(await usage.query('same-chat')).mode, 'qoder', 'switching sources does not consume a Claude cache');
      await usage.query('same-chat');
      assertEqual(otherCalls, 2, 'other providers keep their existing refresh behavior');
      keyRead.resolve('login');
      assertEqual(snapshot(await first).mode, 'subscription', 'the delayed read retains the source selected when it started');
      mode = 'subscription'; await usage.query();
      assertEqual(claudeCalls, 1, 'returning to the same Claude login reuses its cache');
    } finally { await usage.close(); }
  });

  h.test('closing usage cancels a coalesced read and prevents reads of a completed cache', async () => {
    const started = deferred<void>();
    const usage = service({ request: async (_method, _params, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      started.resolve();
    }) });
    const first = usage.query(), second = usage.query();
    const settled = Promise.allSettled([first, second]);
    await started.promise;
    await usage.close();
    const outcomes = await settled;
    assert(outcomes.every(outcome => outcome.status === 'rejected'), 'shutdown rejects every waiting caller');
    const after = await Promise.allSettled([usage.query()]);
    assertEqual(after[0]!.status, 'rejected', 'a closed service never returns cached allowance');
  });

  h.test('the Claude cache identity tracks account order and login generation without containing credentials', () => {
    const first = { id: 'account-one', tokens: { refreshToken: 'synthetic-first-login', accessToken: 'synthetic-first-access' } };
    const second = { id: 'account-two', tokens: { refreshToken: 'synthetic-second-login' } };
    const initial = claudeUsageCacheKey([first, second]);
    assertEqual(initial.length, 64, 'the cache key is a fixed-length digest');
    assert(!initial.includes('synthetic'), 'the cache key never embeds a token');
    assert(initial !== claudeUsageCacheKey([second, first]), 'queue order changes the key');
    assert(initial !== claudeUsageCacheKey([{ ...first, tokens: { refreshToken: 'synthetic-new-login' } }, second]), 'a renewed login changes the key');
    assertEqual(initial, claudeUsageCacheKey([{ ...first, tokens: { ...first.tokens, accessToken: 'synthetic-refreshed-access' } }, second]), 'an access refresh within the login lineage does not change its identity');
  });

  h.test('QwenWork quota read rereads the official store after a dead copied session and retries once', async () => {
    let reads = 0, recovers = 0;
    const quota: Json = { signedIn: true, account: 'fixture', quota: { userType: 'enterprise', userQuota: { total: 100, used: 25, remaining: 75, unit: 'credits' } } };
    const usage = service({ authMode: () => 'qwenwork', qwenworkRecover: async () => { recovers++; return true; },
      request: async method => {
        assertEqual(method, 'qwenwork/usage', 'the quota read targets the QwenWork facade method');
        reads++;
        if (reads === 1) throw new Error('qwenwork_refresh_failed');
        return quota;
      } });
    try {
      const row = provider(await usage.query());
      assertEqual(row.state, 'ok', 'the adopted session answers the retry');
      assertEqual(reads, 2, 'one refused read plus one retry');
      assertEqual(recovers, 1, 'the reread runs once');
      assertEqual(object(row.credits).remaining, 75, 'the retry quota is projected');
    } finally { await usage.close(); }
  });

  h.test('QwenWork quota read keeps the refresh failure when the reread finds nothing', async () => {
    let reads = 0, recovers = 0;
    const usage = service({ authMode: () => 'qwenwork', qwenworkRecover: async () => { recovers++; return false; },
      request: async () => { reads++; throw new Error('qwenwork_refresh_failed'); } });
    try {
      const row = provider(await usage.query());
      assertEqual(row.state, 'error', 'an unrecovered dead session surfaces as an error');
      assertEqual(row.error, 'qwenwork_refresh_failed', 'the stable code reaches the quota panel');
      assertEqual(reads, 1, 'no retry behind a failed reread');
      assertEqual(recovers, 1, 'the reread was attempted');
    } finally { await usage.close(); }
  });

  h.test('QwenWork quota read leaves unrelated failures to the caller without a reread', async () => {
    let recovers = 0;
    const usage = service({ authMode: () => 'qwenwork', qwenworkRecover: async () => { recovers++; return true; },
      request: async () => { throw new Error('Usage request failed (HTTP 500)'); } });
    try {
      const row = provider(await usage.query());
      assertEqual(row.state, 'error', 'a transport failure still surfaces as an error');
      assertEqual(row.error, 'Usage request failed (HTTP 500)', 'the transport failure keeps its wording');
      assertEqual(recovers, 0, 'a non-auth failure does not touch the official store');
    } finally { await usage.close(); }
  });
}
