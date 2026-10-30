import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComposerPredictions, COMPOSER_PREDICTIONS_ENABLED_KEY, PREDICTIONS_CONFIG_URL, PREDICTION_RESPONSE_SCHEMA,
  PREDICTION_PROMPT, PREDICTION_PROMPT_VERSION, PREDICTION_EFFORT, SUBSCRIPTION_PREDICTION_PLAN,
  parsePredictionConfig, predictionPrompt, subscriptionPlanOf,
  type ComposerPredictionsDeps, type PredictionContext, type PredictionCredentials,
} from '../main/services/composer-predictions';
import { kvSet } from '../main/services/settings';
import { Harness } from './harness';

const h = new Harness();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
/** A stored credential whose token records the subscription tier the plan gate reads. */
function token(userId = 'user-a', suffix = 'signature', plan: string | null = SUBSCRIPTION_PREDICTION_PLAN): string {
  const auth = plan === null ? { chatgpt_user_id: userId } : { chatgpt_user_id: userId, chatgpt_plan_type: plan };
  return `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': auth })).toString('base64url')}.${suffix}`;
}
interface Call { sessionId: string; turnId: string; prompt: string; effort: string | null; signal: AbortSignal }
function fixture(overrides: Partial<ComposerPredictionsDeps> = {}) {
  const state = {
    enabled: true, now: 0,
    credentials: { accessToken: token(), accountId: 'account-a' } as PredictionCredentials | null,
    config: { is_enabled: true, prompt: 'Server prompt.', prompt_version: 'v1', prediction_reasoning_effort: '' },
    context: { turnId: 'turn-a', model: 'model-a', provider: 'openai', source: 'codex', planMode: false, running: false } as PredictionContext,
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const calls: Call[] = [];
  const service = new ComposerPredictions({
    enabled: () => state.enabled, now: () => state.now, context: () => ({ ...state.context }),
    codexAccessToken: () => state.credentials,
    fetch: (async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify(state.config)); }) as typeof fetch,
    random: () => 0,
    run: async (sessionId, turnId, prompt, effort, signal) => { calls.push({ sessionId, turnId, prompt, effort, signal }); return { suggestion: '  Continue with the next step.  ' }; },
    ...overrides,
  });
  return {
    service, state, calls, requests,
    predict: (owner = 1, trigger: 'live' | 'catch_up' = 'live', session = 'session-a') => service.predict(session, state.context.turnId, trigger, owner),
  };
}
/** The app-shipped prompt path: no stored credential, so no remote configuration. */
function bundled(overrides: Partial<ComposerPredictionsDeps> = {}) {
  return fixture({ codexAccessToken: () => null, ...overrides });
}
/** A credential stored on a tier other than the one that covers these calls. */
function uncovered(plan: string | null): ComposerPredictionsDeps['codexAccessToken'] {
  return () => ({ accessToken: token('user-a', 'signature', plan), accountId: 'account-a' });
}
const schemaSuffix = `\n\nReturn only JSON matching this schema: ${JSON.stringify(PREDICTION_RESPONSE_SCHEMA)}.`;
const serverPromptOf = (config: { prompt: string }) => `${config.prompt}${schemaSuffix}`;

void (async () => {
  await h.test('the plan gate reads the stored token tier locally, and an opaque token takes the bundled path', () => {
    assert.equal(subscriptionPlanOf({ accessToken: token('u', 's', 'pro'), accountId: 'a' }), 'pro');
    assert.equal(subscriptionPlanOf({ accessToken: token('u', 's', 'plus'), accountId: 'a' }), 'plus');
    assert.equal(subscriptionPlanOf({ accessToken: token('u', 's', null), accountId: 'a' }), '');
    assert.equal(subscriptionPlanOf({ accessToken: 'opaque-token', accountId: 'a' }), '');
    assert.equal(subscriptionPlanOf({ accessToken: 'a.b.c', accountId: 'a' }), '');
    assert.equal(SUBSCRIPTION_PREDICTION_PLAN, 'pro');
  });
  await h.test('the bundled prompt ships with the app and carries the nullable response schema', () => {
    assert.equal(typeof PREDICTION_PROMPT_VERSION, 'string');
    assert.match(PREDICTION_PROMPT, /suggested next user message/);
    assert.match(PREDICTION_PROMPT, /at most 240 characters, or null/);
    assert.equal(predictionPrompt(), `${PREDICTION_PROMPT}${schemaSuffix}`);
  });
  await h.test('a covered subscription runs the provider prompt on ANY model source', async () => {
    // The plan gate turns on the stored credential and its tier alone. The model
    // source this conversation happens to use must not decide which prompt runs.
    for (const [provider, source] of [
      ['openai', 'codex'], ['openai', 'api_key'], ['anthropic', 'subscription'],
      ['gemini', 'api_key'], ['custom', 'custom'], ['deepseek', 'api_key'],
    ] as const) {
      const f = fixture();
      Object.assign(f.state.context, { provider, source });
      assert.deepEqual(await f.predict(), { suggestion: 'Continue with the next step.' }, `${provider}/${source}`);
      assert.equal(f.requests[0]?.url, PREDICTIONS_CONFIG_URL, `${provider} reads provider configuration`);
      assert.equal(f.calls[0]?.prompt, serverPromptOf(f.state.config), provider);
      assert.notEqual(f.calls[0]?.prompt, predictionPrompt(), `${provider} must not use the bundled prompt`);
      await f.service.close();
    }
  });
  await h.test('without a stored credential the app runs its own prompt on any model source, with no network', async () => {
    for (const [provider, source] of [
      ['openai', 'api_key'], ['anthropic', 'subscription'], ['gemini', 'api_key'], ['custom', 'custom'],
    ] as const) {
      const f = bundled();
      Object.assign(f.state.context, { provider, source });
      assert.deepEqual(await f.predict(), { suggestion: 'Continue with the next step.' }, `${provider}/${source} is eligible`);
      assert.equal(f.calls[0]?.prompt, predictionPrompt());
      assert.equal(f.calls[0]?.effort, PREDICTION_EFFORT);
      assert.equal(f.requests.length, 0, 'the bundled path performs no configuration request');
      await f.service.close();
    }
  });
  await h.test('a stored credential on another tier also takes the bundled path', async () => {
    for (const plan of ['plus', 'business', 'enterprise', 'team', null]) {
      const f = fixture({ codexAccessToken: uncovered(plan) });
      assert.deepEqual(await f.predict(), { suggestion: 'Continue with the next step.' }, String(plan));
      assert.equal(f.calls[0]?.prompt, predictionPrompt()); assert.equal(f.calls[0]?.effort, PREDICTION_EFFORT);
      assert.equal(f.requests.length, 0, `${plan ?? 'no tier claim'} performs no configuration request`);
      await f.service.close();
    }
  });
  await h.test('a covered subscription keeps the provider-configured prompt, effort and endpoint', async () => {
    const f = fixture();
    Object.assign(f.state.config, { prompt: 'Server-side prompt text.', prediction_reasoning_effort: 'medium' });
    assert.deepEqual(await f.predict(), { suggestion: 'Continue with the next step.' });
    assert.equal(f.requests[0]?.url, PREDICTIONS_CONFIG_URL);
    assert.equal(f.requests[0]?.init?.method, 'GET');
    assert.deepEqual(f.requests[0]?.init?.headers, { Authorization: `Bearer ${f.state.credentials!.accessToken}`, 'ChatGPT-Account-Id': 'account-a' });
    assert.equal(f.calls[0]?.prompt, serverPromptOf(f.state.config));
    assert.equal(f.calls[0]?.effort, 'medium');
    assert.notEqual(f.calls[0]?.prompt, predictionPrompt(), 'the bundled prompt must not replace provider configuration');
    await f.service.close();
  });
  await h.test('a covered subscription keeps the server kill switch and its model blacklist', async () => {
    const disabled = fixture(); disabled.state.config.is_enabled = false;
    assert.equal((await disabled.predict()).reason, 'disabled'); assert.equal(disabled.calls.length, 0);
    await disabled.service.close();
    const blocked = fixture(); Object.assign(blocked.state.config, { unsupported_models: ['model-a'] });
    assert.equal((await blocked.predict()).reason, 'unsupported_model'); assert.equal(blocked.calls.length, 0);
    await blocked.service.close();
    // The blacklist is the provider's own list, so it keys on the model, never on
    // which source this conversation selected.
    const otherModel = fixture(); Object.assign(otherModel.state.config, { unsupported_models: ['model-z'] });
    otherModel.state.context.provider = 'anthropic';
    assert.equal((await otherModel.predict()).suggestion, 'Continue with the next step.');
    await otherModel.service.close();
  });
  await h.test('a covered subscription never falls back to the bundled prompt when configuration fails', async () => {
    let fetches = 0;
    const f = fixture({ fetch: (async () => { fetches++; throw new Error('private configuration diagnostic'); }) as typeof fetch });
    assert.equal((await f.predict()).reason, 'configuration_unavailable');
    assert.equal((await f.predict()).reason, 'configuration_unavailable');
    assert.equal(f.calls.length, 0, 'no inference may run without provider configuration');
    assert.equal(fetches, 1, 'a failure is cached until the entry expires');
    assert(!JSON.stringify(await f.predict()).includes('private'), 'the cause must not leak');
    await f.service.close();
    const malformed = fixture({ fetch: (async () => new Response('{}')) as typeof fetch });
    assert.equal((await malformed.predict()).reason, 'configuration_unavailable');
    assert.equal(malformed.calls.length, 0, 'a malformed configuration must not fall back either');
    await malformed.service.close();
  });
  await h.test('a covered subscription keeps provider sampling and caches suppression without resampling', async () => {
    const f = fixture({ random: () => 0.5 });
    Object.assign(f.state.config, { sample_rate: 0.6, live_sample_rate: 0.4, catch_up_sample_rate: 0.9 });
    assert.equal((await f.predict()).reason, 'sampled_out');
    assert.equal((await f.predict(1, 'catch_up')).reason, 'sampled_out');
    assert.equal(f.calls.length, 0);
    f.state.context.turnId = 'turn-b'; await f.service.invalidateSession('session-a');
    assert.equal((await f.predict(1, 'catch_up')).suggestion, 'Continue with the next step.');
    await f.service.close();
    const shared = fixture({ random: () => 0.5 }); Object.assign(shared.state.config, { sample_rate: 0.4 });
    assert.equal((await shared.predict()).reason, 'sampled_out'); await shared.service.close();
    const never = fixture({ random: () => 0.5 }); Object.assign(never.state.config, { live_sample_rate: 0, catch_up_sample_rate: 1 });
    assert.equal((await never.predict()).reason, 'sampled_out');
    // The suppression is cached per turn, so the catch-up rate needs a fresh turn.
    never.state.context.turnId = 'turn-b'; await never.service.invalidateSession('session-a');
    assert.equal((await never.predict(1, 'catch_up')).suggestion, 'Continue with the next step.');
    await never.service.close();
  });
  await h.test('the bundled path is never sampled out', async () => {
    const f = bundled({ random: () => 0.99 });
    assert.equal((await f.predict()).suggestion, 'Continue with the next step.');
    assert.equal(f.requests.length, 0);
    await f.service.close();
  });
  await h.test('configuration is scoped to the account and user, cached for five minutes, and survives a token refresh', async () => {
    const f = fixture(); await f.predict();
    f.state.credentials = { accessToken: token('user-a', 'refreshed'), accountId: 'account-a' };
    f.state.context.turnId = 'turn-b'; await f.service.invalidateSession('session-a'); await f.predict();
    assert.equal(f.requests.length, 1, 'a refreshed token keeps the same principal');
    f.state.now = 300_000; f.state.context.turnId = 'turn-c'; await f.service.invalidateSession('session-a'); await f.predict();
    assert.equal(f.requests.length, 2, 'the entry expires after its TTL');
    f.state.credentials = { accessToken: token('user-b'), accountId: 'account-a' };
    f.state.context.turnId = 'turn-d'; await f.service.invalidateSession('session-a'); await f.predict();
    assert.equal(f.requests.length, 3, 'another user is another principal');
    f.state.credentials = { accessToken: token('user-b'), accountId: 'account-b' };
    f.state.context.turnId = 'turn-e'; await f.service.invalidateSession('session-a'); await f.predict();
    assert.equal(f.requests.length, 4, 'another account is another principal');
    await f.service.close();
  });
  await h.test('configuration is single flight across sessions while turn results stay cached', async () => {
    const fetchGate = deferred<Response>(); let fetches = 0;
    const f = fixture({ fetch: (async () => { fetches++; return fetchGate.promise; }) as typeof fetch });
    const one = f.predict(), two = f.predict(2), other = f.predict(3, 'catch_up', 'session-b');
    await flush(); assert.equal(fetches, 1);
    fetchGate.resolve(new Response(JSON.stringify(f.state.config)));
    await Promise.all([one, two, other]); assert.equal(f.calls.length, 2);
    f.state.now = 1_000_000_000;
    assert.deepEqual(await f.predict(), { suggestion: 'Continue with the next step.' });
    assert.equal(f.calls.length, 2); assert.equal(fetches, 1);
    await f.service.close();
  });
  await h.test('configuration validates required fields and bounded independent sample rates', () => {
    const base = { is_enabled: true, prompt: 'server prompt', prompt_version: 'v1', prediction_reasoning_effort: '' };
    assert.equal(parsePredictionConfig(base)?.prediction_reasoning_effort, null);
    assert.equal(parsePredictionConfig({ ...base, prediction_reasoning_effort: 'high' })?.prediction_reasoning_effort, 'high');
    for (const value of [null, {}, { ...base, is_enabled: 'yes' }, { ...base, prompt: null }, { ...base, prompt_version: 1 }, { ...base, prediction_reasoning_effort: null }, { ...base, unsupported_models: [1] }]) assert.equal(parsePredictionConfig(value), null);
    for (const key of ['sample_rate', 'live_sample_rate', 'catch_up_sample_rate']) {
      for (const rate of [-1, 1.01, NaN, Infinity, '0.5']) assert.equal(parsePredictionConfig({ ...base, [key]: rate }), null);
      assert.equal(parsePredictionConfig({ ...base, [key]: 0 })?.[key as 'sample_rate'], 0);
    }
  });
  await h.test('the persisted editor preference is the only switch and gates both paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'composer-predictions-'));
    try {
      const covered = fixture({ configRoot: root, enabled: undefined });
      assert.equal((await covered.predict()).suggestion, 'Continue with the next step.');
      assert.equal(covered.requests.length, 1);
      kvSet(COMPOSER_PREDICTIONS_ENABLED_KEY, 'off', root);
      assert.equal((await covered.predict()).reason, 'disabled');
      assert.equal(covered.calls.length, 1, 'a disabled preference prevents new inference');
      await covered.service.close();
      const shipped = fixture({ configRoot: root, enabled: undefined, codexAccessToken: () => null });
      assert.equal((await shipped.predict()).reason, 'disabled');
      kvSet(COMPOSER_PREDICTIONS_ENABLED_KEY, 'on', root);
      assert.equal((await shipped.predict()).suggestion, 'Continue with the next step.');
      assert.equal(shipped.requests.length, 0);
      await shipped.service.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('turn-state gates apply to both paths and never invoke the model', async () => {
    for (const [name, build] of [['subscription', fixture], ['bundled', bundled]] as const) {
      const f = build();
      for (const [change, reason] of [
        [{ running: true }, 'running'], [{ planMode: true }, 'plan_mode'], [{ model: '' }, 'unavailable'],
      ] as const) {
        const previous = { ...f.state.context }; Object.assign(f.state.context, change);
        assert.equal((await f.predict()).reason, reason, `${name} ${reason}`);
        f.state.context = previous;
      }
      assert.equal((await f.service.predict('session-a', 'other-turn', 'live', 1)).reason, 'stale_turn');
      assert.equal(f.calls.length, 0); await f.service.close();
    }
  });
  await h.test('a missing runtime capability remains visible as unavailability on both paths', async () => {
    for (const build of [fixture, bundled]) {
      const f = build({ supported: () => false });
      assert.deepEqual(await f.service.availability(), { available: false, reason: 'engine_unavailable' });
      assert.equal((await f.predict()).reason, 'engine_unavailable');
      assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
      await f.service.close();
    }
  });
  await h.test('availability reports provider readiness only for a covered subscription', async () => {
    const shipped = bundled({ context: () => { throw new Error('availability must not read conversation context'); } });
    assert.deepEqual(await shipped.service.availability(), { available: true });
    assert.equal(shipped.requests.length, 0); await shipped.service.close();
    const plus = fixture({ codexAccessToken: uncovered('plus') });
    assert.deepEqual(await plus.service.availability(), { available: true });
    assert.equal(plus.requests.length, 0, 'an uncovered tier must not read provider configuration');
    await plus.service.close();
    const covered = fixture();
    assert.deepEqual(await covered.service.availability(), { available: true });
    assert.equal(covered.requests[0]?.url, PREDICTIONS_CONFIG_URL);
    await covered.service.close();
    const off = fixture({ fetch: (async () => new Response(JSON.stringify({ is_enabled: false, prompt: 'p', prompt_version: 'v', prediction_reasoning_effort: '' }))) as typeof fetch });
    assert.deepEqual(await off.service.availability(), { available: false, reason: 'configuration_disabled' }); await off.service.close();
    const unreachable = fixture({ fetch: (async () => new Response('{}')) as typeof fetch });
    assert.deepEqual(await unreachable.service.availability(), { available: false, reason: 'configuration_unavailable' }); await unreachable.service.close();
    const switched = fixture({ enabled: () => false });
    assert.deepEqual(await switched.service.availability(), { available: false, reason: 'disabled' }); await switched.service.close();
  });
  await h.test('source lookup resolves the turn without reading credentials or generating a message', async () => {
    for (const [name, build] of [['subscription', fixture], ['bundled', bundled]] as const) {
      let credentialReads = 0;
      const f = build({
        run: async () => { throw new Error('Source selection must not generate a message'); },
        codexAccessToken: () => { credentialReads++; return name === 'bundled' ? null : { accessToken: token(), accountId: 'account-a' }; },
      });
      f.state.context.turnId = 'authoritative-empty-terminal';
      assert.deepEqual(await f.service.source('session-a', 1), { turnId: 'authoritative-empty-terminal' });
      assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
      assert.equal(credentialReads, 0, `${name}: a source lookup must not refresh credentials`);
      f.state.context.running = true;
      assert.deepEqual(await f.service.source('session-a', 1), { turnId: null, reason: 'running' });
      await f.service.close();
      assert.deepEqual(await f.service.source('session-a', 1), { turnId: null, reason: 'closed' });
    }
  });
  await h.test('every lifecycle fence cancels and drains source reads before a delayed context returns', async () => {
    for (const action of ['cancel', 'detach', 'session', 'all', 'close'] as const) {
      const gate = deferred<PredictionContext | null>(); let signal: AbortSignal | undefined;
      const f = fixture({ context: (_id, received) => { signal = received; return gate.promise; } });
      const source = f.service.source('session-a', 1); await flush();
      assert.equal(signal?.aborted, false, action);
      if (action === 'cancel') await f.service.cancel('session-a', 1);
      else if (action === 'detach') await f.service.detachOwner(1);
      else if (action === 'session') await f.service.invalidateSession('session-a');
      else if (action === 'all') await f.service.invalidateAll();
      else await f.service.close();
      assert.equal(signal?.aborted, true, action);
      assert.deepEqual(await source, { turnId: null, reason: action === 'close' ? 'closed' : 'cancelled' });
      gate.resolve(f.state.context); await flush();
      assert.equal(f.calls.length, 0); await f.service.close();
    }
  });
  await h.test('cancelling one source reader leaves another renderer eligible', async () => {
    const gates = [deferred<PredictionContext | null>(), deferred<PredictionContext | null>()];
    const signals: Array<AbortSignal | undefined> = [];
    const f = fixture({ context: (_id, signal) => { const index = signals.length; signals.push(signal); return gates[index]!.promise; } });
    const first = f.service.source('session-a', 1), second = f.service.source('session-a', 2); await flush();
    await f.service.cancel('session-a', 1);
    assert.equal(signals[0]?.aborted, true); assert.equal(signals[1]?.aborted, false);
    assert.deepEqual(await first, { turnId: null, reason: 'cancelled' });
    gates[1]!.resolve(f.state.context); assert.deepEqual(await second, { turnId: 'turn-a' });
    gates[0]!.resolve(f.state.context); await f.service.close();
  });
  await h.test('a cancelled final source read cannot deliver a completed suggestion', async () => {
    const gate = deferred<PredictionContext | null>(); let reads = 0, finalSignal: AbortSignal | undefined;
    const f = bundled({ context: (_id, signal) => { reads++; if (reads === 3) { finalSignal = signal; return gate.promise; } return { turnId: 'turn-a', model: 'model-a', provider: 'openai', source: 'codex', planMode: false, running: false }; } });
    const prediction = f.predict(); await flush();
    assert.equal(reads, 3); assert.equal(f.calls.length, 1);
    await f.service.cancel('session-a', 1); assert.equal(finalSignal?.aborted, true);
    assert.equal((await prediction).reason, 'cancelled'); gate.resolve(f.state.context); await f.service.close();
  });
  await h.test('inference is single flight per turn across owners and results stay cached on both paths', async () => {
    let runs = 0;
    const runGate = deferred<{ suggestion: string | null }>();
    const shared = bundled({ run: async () => { runs++; return runGate.promise; } });
    const one = shared.predict(), two = shared.predict(2); await flush();
    assert.equal(runs, 1, 'two owners of one turn share a single run');
    runGate.resolve({ suggestion: 'Shared result.' });
    assert.equal((await one).suggestion, 'Shared result.'); assert.equal((await two).suggestion, 'Shared result.');
    assert.deepEqual(await shared.predict(), { suggestion: 'Shared result.' });
    assert.equal(runs, 1, 'a settled turn is never regenerated');
    await shared.service.close();
    const covered = fixture(); await covered.predict();
    assert.equal(covered.calls.length, 1);
    assert.deepEqual(await covered.predict(), { suggestion: 'Continue with the next step.' });
    assert.equal(covered.calls.length, 1); assert.equal(covered.requests.length, 1);
    await covered.service.close();
  });
  await h.test('model failures, null and whitespace suggestions are cached until explicit invalidation', async () => {
    let runs = 0;
    const f = bundled({ run: async () => { runs++; throw new Error('private provider diagnostic'); } });
    assert.equal((await f.predict()).reason, 'prediction_failed'); assert.equal((await f.predict()).reason, 'prediction_failed'); assert.equal(runs, 1);
    assert(!JSON.stringify(await f.predict()).includes('private'));
    await f.service.invalidateSession('session-a'); await f.predict(); assert.equal(runs, 2); await f.service.close();
    let nullRuns = 0; const none = bundled({ run: async () => { nullRuns++; return { suggestion: null }; } });
    assert.deepEqual(await none.predict(), { suggestion: null }); assert.deepEqual(await none.predict(), { suggestion: null }); assert.equal(nullRuns, 1); await none.service.close();
    const whitespace = bundled({ run: async () => ({ suggestion: '  \n  ' }) });
    assert.deepEqual(await whitespace.predict(), { suggestion: null }); await whitespace.service.close();
  });
  await h.test('an invalid engine suggestion is reported and cached without retry', async () => {
    let runs = 0;
    const f = bundled({ run: async () => { runs++; return { suggestion: 42 as unknown as string }; } });
    assert.equal((await f.predict()).reason, 'invalid_response');
    assert.equal((await f.predict()).reason, 'invalid_response'); assert.equal(runs, 1);
    await f.service.close();
  });
  await h.test('cancelling one renderer retains another renderer sharing the same request', async () => {
    const gate = deferred<{ suggestion: string | null }>(); let signal!: AbortSignal;
    const f = bundled({ run: async (_session, _turn, _prompt, _effort, received) => { signal = received; return gate.promise; } });
    const one = f.predict(1), two = f.predict(2); await flush();
    await f.service.cancel('session-a', 1); assert.equal(signal.aborted, false);
    gate.resolve({ suggestion: 'shared result' });
    assert.equal((await one).reason, 'cancelled'); assert.deepEqual(await two, { suggestion: 'shared result' }); await f.service.close();
  });
  await h.test('session invalidation cancels and drains inference before allowing its old result to return', async () => {
    const gate = deferred<{ suggestion: string | null }>(); let signal!: AbortSignal;
    const f = bundled({ run: async (_session, _turn, _prompt, _effort, received) => { signal = received; return gate.promise; } });
    const prediction = f.predict(); await flush(); let drained = false;
    const invalidation = f.service.invalidateSession('session-a').then(() => { drained = true; });
    await flush(); assert.equal(signal.aborted, true); assert.equal(drained, false);
    gate.resolve({ suggestion: 'late result' }); await invalidation;
    assert.equal((await prediction).reason, 'cancelled'); await f.service.close();
  });
  await h.test('cancellation and owner detachment also fence requests awaiting their initial source read', async () => {
    for (const detach of [false, true]) {
      const gate = deferred<PredictionContext | null>(); const f = fixture({ context: () => gate.promise });
      const prediction = f.predict(); await flush();
      if (detach) await f.service.detachOwner(1); else await f.service.cancel('session-a', 1);
      gate.resolve(f.state.context); assert.equal((await prediction).reason, 'cancelled'); assert.equal(f.calls.length, 0); await f.service.close();
    }
  });
  await h.test('a model or source change during inference suppresses the result and a later request gets a fresh run', async () => {
    for (const change of [{ model: 'model-b' }, { source: 'custom' }, { provider: 'anthropic' }] as const) {
      const gate = deferred<{ suggestion: string | null }>(); let runs = 0;
      const f = bundled({ run: async () => { runs++; return runs === 1 ? gate.promise : { suggestion: 'current source' }; } });
      const prediction = f.predict(); await flush(); Object.assign(f.state.context, change);
      gate.resolve({ suggestion: 'old source' });
      assert.equal((await prediction).reason, 'stale_turn');
      assert.deepEqual(await f.predict(), { suggestion: 'current source' }); assert.equal(runs, 2); await f.service.close();
    }
  });
  await h.test('signing a covered subscription in mid-flight retires the bundled request instead of landing it', async () => {
    const gate = deferred<{ suggestion: string | null }>(); let runs = 0;
    let credentials: PredictionCredentials | null = null;
    const f = fixture({ codexAccessToken: () => credentials, run: async () => { runs++; return runs === 1 ? gate.promise : { suggestion: 'covered path' }; } });
    const prediction = f.predict(); await flush();
    credentials = { accessToken: token(), accountId: 'account-a' };
    gate.resolve({ suggestion: 'bundled result' });
    assert.equal((await prediction).reason, 'stale_turn', 'the resolved plan changed, so the fingerprint changed');
    assert.deepEqual(await f.predict(), { suggestion: 'covered path' });
    assert.equal(f.requests.length, 1, 'the second run reads provider configuration');
    await f.service.close();
  });
  await h.test('a source change while configuration loads prevents stale inference admission', async () => {
    const gate = deferred<Response>(); const f = fixture({ fetch: (async () => gate.promise) as typeof fetch });
    const prediction = f.predict(); await flush(); f.state.context.model = 'model-b';
    gate.resolve(new Response(JSON.stringify(f.state.config)));
    assert.equal((await prediction).reason, 'stale_turn'); assert.equal(f.calls.length, 0); await f.service.close();
  });
  await h.test('an inference timeout waits for cancellation settlement and is cached without retries', async () => {
    const f = bundled({ timeoutMs: 5, run: async (_session, _turn, _prompt, _effort, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('cancelled');
    } });
    assert.equal((await f.predict()).reason, 'timeout'); assert.equal((await f.predict()).reason, 'timeout'); await f.service.close();
  });
  await h.test('global invalidation clears configuration, retires settled work, and close drains', async () => {
    const f = fixture(); await f.predict(); await f.service.invalidateAll(); await f.predict();
    assert.equal(f.requests.length, 2); assert.equal(f.calls.length, 2); await f.service.close();
    const gate = deferred<{ suggestion: string | null }>(); let signal!: AbortSignal;
    const pending = bundled({ run: async (_session, _turn, _prompt, _effort, received) => { signal = received; return gate.promise; } });
    const prediction = pending.predict(); await flush(); let drained = false;
    const closing = pending.service.close().then(() => { drained = true; }); await flush(); assert(signal.aborted); assert.equal(drained, false);
    gate.resolve({ suggestion: 'late result' }); await closing; assert.equal((await prediction).reason, 'closed'); assert.equal((await pending.predict()).reason, 'closed');
  });
  await h.test('closing availability aborts a pending configuration read and prevents later requests', async () => {
    const fetchGate = deferred<Response>(); let fetchSignal!: AbortSignal;
    const f = fixture({ fetch: (async (_url, init) => { fetchSignal = init?.signal as AbortSignal; return fetchGate.promise; }) as typeof fetch });
    const availability = f.service.availability(); await flush(); let drained = false;
    const closing = f.service.close().then(() => { drained = true; }); await flush(); assert(fetchSignal.aborted); assert.equal(drained, false);
    fetchGate.resolve(new Response(JSON.stringify(f.state.config))); await closing; assert.deepEqual(await availability, { available: false, reason: 'closed' });
    const credentials = deferred<PredictionCredentials | null>(); const pending = fixture({ codexAccessToken: () => credentials.promise });
    const status = pending.service.availability(); await flush(); await pending.service.close(); credentials.resolve(pending.state.credentials);
    assert.deepEqual(await status, { available: false, reason: 'closed' }); assert.equal(pending.requests.length, 0);
  });
  await h.test('closing while a capability read is pending resolves as closed and prevents later requests', async () => {
    const gate = deferred<boolean>(); let started = false;
    const f = bundled({ supported: async () => { started = true; return gate.promise; } });
    const availability = f.service.availability(); await flush();
    assert.equal(started, true);
    await f.service.close();
    gate.resolve(true);
    assert.deepEqual(await availability, { available: false, reason: 'closed' });
    assert.deepEqual(await f.service.availability(), { available: false, reason: 'closed' });
  });
  await h.test('session cancellation drains a prediction waiting on shared configuration without cancelling it', async () => {
    const gate = deferred<Response>(); let signal!: AbortSignal;
    const f = fixture({ fetch: (async (_url, init) => { signal = init?.signal as AbortSignal; return gate.promise; }) as typeof fetch });
    const prediction = f.predict(); await flush();
    await f.service.invalidateSession('session-a');
    assert.equal((await prediction).reason, 'cancelled'); assert.equal(signal.aborted, false); assert.equal(f.calls.length, 0);
    gate.resolve(new Response(JSON.stringify(f.state.config))); await f.service.close();
  });
  await h.test('session cancellation drains a prediction whose preflight context read awaits a session mutation', async () => {
    const gate = deferred<PredictionContext | null>(); let reads = 0;
    const f = bundled({ context: () => ++reads === 1 ? { ...f.state.context } : gate.promise });
    const prediction = f.predict(); await flush(); assert.equal(reads, 2);
    await f.service.invalidateSession('session-a'); assert.equal((await prediction).reason, 'cancelled'); assert.equal(f.calls.length, 0);
    gate.resolve(f.state.context); await flush(); assert.equal(f.calls.length, 0); await f.service.close();
  });
  await h.test('a credential read can be invalidated by the mutation that is draining it', async () => {
    let reads = 0, invalidation!: Promise<void>;
    const f = fixture({ codexAccessToken: async () => {
      if (++reads === 2) { invalidation = f.service.invalidateAll(); await invalidation; }
      return f.state.credentials;
    } });
    const prediction = f.predict(); await flush();
    await invalidation; assert.equal((await prediction).reason, 'cancelled'); assert.equal(f.calls.length, 0); await f.service.close();
  });
  await h.test('a capability read can be invalidated by the mutation that is draining it', async () => {
    let reads = 0, invalidation!: Promise<void>;
    const f = bundled({ supported: async () => {
      if (++reads === 2) { invalidation = f.service.invalidateAll(); await invalidation; }
      return true;
    } });
    const prediction = f.predict(); await flush();
    await invalidation; assert.equal((await prediction).reason, 'cancelled'); assert.equal(f.calls.length, 0); await f.service.close();
  });
  await h.test('a source lookup failure returns structured unavailability without leaking the cause', async () => {
    const f = bundled({ context: async () => { throw new Error('private source state'); } });
    const result = await f.predict();
    assert.deepEqual(result, { suggestion: null, reason: 'unavailable' });
    assert(!JSON.stringify(result).includes('private')); await f.service.close();
  });
  process.exitCode = await h.finish(join(__dirname, 'composer-predictions-result.json'), 'composer-predictions');
})();
