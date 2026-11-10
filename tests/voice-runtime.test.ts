import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { allowsTrustedFullscreen, allowsVoiceMedia, voiceModelAccess, voiceProviderError, type VoiceEngineConnection } from '../main/app/voice-runtime';
import { Harness, assert, assertEqual, assertRejects } from './harness';

const h = new Harness();
h.test('only an attached trusted main frame can request audio and camera remains denied', () => {
  const owner = { id: 7, isDestroyed: () => false, getURL: () => 'klaus-app://app/index.html' }, attached = new Set([7]);
  const details = { isMainFrame: true, requestingUrl: owner.getURL() };
  assert(allowsVoiceMedia(owner, attached, details, ['audio']), 'trusted audio');
  for (const media of [[], ['video'], ['audio', 'video'], ['unknown']]) assertEqual(allowsVoiceMedia(owner, attached, details, media), false, 'no non-audio grant');
  assertEqual(allowsVoiceMedia(owner, new Set(), details, ['audio']), false, 'retired owner');
  assertEqual(allowsVoiceMedia(owner, attached, { ...details, isMainFrame: false }, ['audio']), false, 'subframe');
  assertEqual(allowsVoiceMedia(owner, attached, { ...details, requestingUrl: 'https://example.com' }, ['audio']), false, 'remote requester');
  assertEqual(allowsVoiceMedia({ ...owner, getURL: () => 'https://example.com' }, attached, details, ['audio']), false, 'navigated owner');
  assert(allowsTrustedFullscreen(owner, details), 'trusted main frame can enter fullscreen');
  assert(allowsTrustedFullscreen(owner, { isMainFrame: true }, 'klaus-app://app/'), 'origin fallback for permission check');
  assertEqual(allowsTrustedFullscreen(owner, { ...details, isMainFrame: false }), false, 'subframe fullscreen denied');
  assertEqual(allowsTrustedFullscreen(owner, { ...details, requestingUrl: 'https://example.com' }), false, 'remote fullscreen denied');
  assertEqual(allowsTrustedFullscreen({ ...owner, getURL: () => 'https://example.com' }, details), false, 'navigated owner fullscreen denied');
  assertEqual(allowsTrustedFullscreen({ ...owner, isDestroyed: () => true }, details), false, 'destroyed owner fullscreen denied');
});
h.test('voice model access keeps source metadata and reads a key only through its named facade', async () => {
  const calls: string[] = [];
  const access = voiceModelAccess({ providers: async () => ({ first: { name: 'BYO', provider: 'openai', model: 'local', authType: 'api_key', authMode: 'custom', apiKey: 'must-not-project' },
    subscription: { name: 'Subscription', provider: 'openai', model: 'subscribed', authType: 'oauth', authMode: 'codex' } }) },
    async (method, params) => { calls.push(method + ':' + JSON.stringify(params)); return { apiKey: 'fixture-key' }; });
  const signal = new AbortController().signal, rows = await access.listModels(signal);
  const row = rows[0] as Record<string, Json>;
  assertEqual(row.authType, 'api_key', 'API-key identity preserved'); assertEqual(row.authMode, 'custom', 'custom source preserved');
  assertEqual(row.apiKey, undefined, 'metadata never copies credentials');
  await assertRejects(() => access.readModelCredential('subscription', signal), 'subscription does not expose a key to voice');
  assertEqual(await access.readModelCredential('first', signal), 'fixture-key', 'facade value');
  assertEqual(calls.join(), 'model/credential/read:{"id":"first"}', 'one named credential reader');
});
h.test('a provider changed before or during credential access cannot receive the old endpoint request', async () => {
  let url = 'https://first.example/v1', reads = 0, changeDuringRead = false;
  const access = voiceModelAccess({ providers: async () => ({ byo: { name: 'BYO', provider: 'openai', model: 'local', baseUrl: url } }) }, async () => {
    reads++; if (changeDuringRead) url = 'https://replacement.example/v1'; return { apiKey: 'fixture-key' };
  });
  const signal = new AbortController().signal;
  await access.listModels(signal); url = 'https://changed.example/v1';
  await assertRejects(() => access.readModelCredential('byo', signal), 'changed destination before read'); assertEqual(reads, 0, 'no credential read');
  await access.listModels(signal); changeDuringRead = true;
  await assertRejects(() => access.readModelCredential('byo', signal), 'changed destination during read'); assertEqual(reads, 1, 'late key not returned');
  const cancelled = new AbortController(); cancelled.abort();
  await assertRejects(() => access.listModels(cancelled.signal), 'cancelled discovery');
});
h.test('OAuth transcription uses named provider methods and a matching cancellation without reading custom credentials', async () => {
  for (const source of ['claude', 'codex', 'workbuddy', 'qoder', 'qoderwork', 'qwenwork'] as const) {
    const calls: Array<{ method: string; params: Json }> = [];
    let release!: (value: Json) => void;
    const pending = new Promise<Json>(resolve => { release = resolve; });
    const access = voiceModelAccess({ providers: async () => { throw new Error('custom provider metadata must not be read'); } }, async (method, params) => {
      calls.push({ method, params });
      if (method.endsWith('/transcribeAudio')) return pending;
      return { cancelled: true };
    });
    const controller = new AbortController(), operationId = 'capture-' + source;
    const task = access.transcribeAudio!(source, { audioBase64: 'AQID', mimeType: 'audio/wav', language: 'en', operationId }, controller.signal);
    assertEqual(calls[0]?.method, `${source}/transcribeAudio`, 'named source method');
    assertEqual(JSON.stringify(calls[0]?.params), JSON.stringify({ audioBase64: 'AQID', mimeType: 'audio/wav', language: 'en', operationId }), 'typed audio request');
    controller.abort(); release({ text: 'late result' });
    await assertRejects(() => task, 'late transcript is cancelled');
    assertEqual(calls[1]?.method, source === 'workbuddy' ? 'workbuddy/cancelOperation' : `${source}/cancelTranscription`, 'provider cancellation');
    assertEqual(JSON.stringify(calls[1]?.params), JSON.stringify({ operationId }), 'same operation identity');
    assertEqual(calls.length, 2, 'only transcription and cancellation');
  }
});
h.test('dictation admission requires actual capability metadata, independent of a successful login', async () => {
  let enabled = false; const calls: string[] = [];
  const access = voiceModelAccess({ providers: async () => ({}) }, async (method): Promise<Json> => {
    calls.push(method); return method.endsWith('/status') ? { loggedIn: true } : { transcription: { available: enabled } };
  });
  assertEqual(await access.transcriptionAvailable!('workbuddy', new AbortController().signal), false, 'login is not capability admission');
  enabled = true;
  assertEqual(await access.transcriptionAvailable!('workbuddy', new AbortController().signal), true, 'admitted account');
  assertEqual(calls.join(','), 'workbuddy/status,workbuddy/capabilities,workbuddy/status,workbuddy/capabilities', 'actual named account metadata');
});
h.test('capability reads carry cancellation and cannot publish metadata from a replaced engine generation', async () => {
  let release!: (value: Json) => void, readSignal: AbortSignal | undefined;
  const gate = new Promise<Json>(resolve => { release = resolve; });
  const client: VoiceEngineConnection['client'] = { isClosed: () => false,
    requestWithTimeout: async (method, _params, _timeout, options) => {
      readSignal = options?.signal;
      return method.endsWith('/status') ? { loggedIn: true } : gate;
    } };
  let current: VoiceEngineConnection = { generation: 1, client };
  const access = voiceModelAccess({ providers: async () => ({}) }, async () => { throw new Error('unbound request'); }, undefined, () => current);
  const controller = new AbortController();
  const pending = access.transcriptionAvailable!('workbuddy', controller.signal);
  assertEqual(readSignal, controller.signal, 'engine reads receive the capture cancellation signal');
  current = { generation: 2, client }; release({ transcription: { available: true } });
  await assertRejects(() => pending, 'old generation metadata is rejected');
  const cancelled = new AbortController(); cancelled.abort();
  await assertRejects(() => access.transcriptionAvailable!('workbuddy', cancelled.signal), 'pre-cancelled discovery');
});
h.test('native transcription cancellation stays on its original engine after replacement', async () => {
  let release!: (value: Json) => void; const gate = new Promise<Json>(resolve => { release = resolve; });
  const oldCalls: string[] = [], newCalls: string[] = [];
  const original: VoiceEngineConnection = { generation: 1, client: { isClosed: () => false, requestWithTimeout: async method => {
    oldCalls.push(method); return method.endsWith('/transcribeAudio') ? gate : { cancelled: true };
  } } };
  let current = original;
  const access = voiceModelAccess({ providers: async () => ({}) }, async () => { throw new Error('unbound request'); }, undefined, () => current);
  const controller = new AbortController();
  const pending = access.transcribeAudio!('workbuddy', { audioBase64: 'AQID', mimeType: 'audio/webm', operationId: 'original-engine' }, controller.signal);
  current = { generation: 2, client: { isClosed: () => false, requestWithTimeout: async method => { newCalls.push(method); return {}; } } };
  controller.abort(); release({ text: 'late result' }); await assertRejects(() => pending, 'old engine transcript');
  assertEqual(oldCalls.join(','), 'workbuddy/transcribeAudio,workbuddy/cancelOperation', 'cancel is bound to original engine');
  assertEqual(newCalls.length, 0, 'replacement receives no stale operation');
});
h.test('native transcript validation and safe error projection reject transport details', async () => {
  const access = voiceModelAccess({ providers: async () => ({}) }, async () => ({ text: 'x'.repeat(12001) }));
  await assertRejects(() => access.transcribeAudio!('claude', { audioBase64: 'AQID', mimeType: 'audio/wav', operationId: 'bounded' }, new AbortController().signal), 'oversized transcript');
  assertEqual(voiceProviderError('claude', { kind: 'server', message: 'claude_transcription_authentication_required' }), 'claude_transcription_authentication_required', 'plain RPC error is projected safely');
  assertEqual(voiceProviderError('claude', new Error('ENGINE_ERROR: claude_transcription_authentication_required')), 'claude_transcription_authentication_required', 'stable engine error');
  assertEqual(voiceProviderError('codex', { message: 'codex_transcription_rate_limited' }), 'codex_transcription_rate_limited', 'provider limit stays actionable');
  assertEqual(voiceProviderError('codex', { message: 'codex_transcription_network_challenge' }), 'codex_transcription_network_challenge', 'network challenge remains distinct from account admission');
  assertEqual(voiceProviderError('codex', { message: 'codex_transcription_permission_denied' }), 'codex_transcription_permission_denied', 'account admission retains its safe code');
  for (const source of ['qoder', 'qoderwork', 'qwenwork'] as const) {
    for (const suffix of ['signed_out', 'not_signed_in', 'transcription_login_expired', 'transcription_authentication_failed']) {
      assertEqual(voiceProviderError(source, { message: `${source}_${suffix}` }), `${source}_transcription_authentication_required`, 'account recovery keeps the selected source');
    }
    assertEqual(voiceProviderError(source, { message: 'codex_transcription_login_expired' }), 'voice-provider-failed', 'unrelated account codes are not attributed to this source');
  }
  assertEqual(voiceProviderError('claude', { message: 'provider_transcription_audio_invalid' }), 'provider_transcription_audio_invalid', 'safe common validation code');
  assertEqual(voiceProviderError('claude', new Error('HTTP provider payload with private text')), 'voice-provider-failed', 'private transport content removed');
});
h.test('paced native transcription receives a request deadline beyond its bounded operation budget', async () => {
  const requests: Array<{ method: string; timeout: number }> = [];
  const connection: VoiceEngineConnection = { generation: 1, client: { isClosed: () => false,
    requestWithTimeout: async (method, _params, timeout) => { requests.push({ method, timeout }); return { text: 'Complete transcript.' }; } } };
  const access = voiceModelAccess({ providers: async () => ({}) }, async () => { throw new Error('unbound request'); }, undefined, () => connection);
  for (const source of ['qwenwork', 'codex'] as const) await access.transcribeAudio!(source,
    { audioBase64: 'AQID', mimeType: 'audio/wav', operationId: source }, new AbortController().signal);
  assertEqual(requests[0]?.timeout, 480_000, 'paced recording RPC outlives the 450-second operation deadline');
  assertEqual(requests[1]?.timeout, 90_000, 'other native request budgets are preserved');
});

void h.finish(join(__dirname, 'voice-runtime-result.json'), 'voice-runtime').then(code => { process.exitCode = code; });
