import { strict as assert } from 'node:assert';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { Harness, waitFor, sleep } from './harness';
import { VoiceService, type VoiceOptions } from '../main/services/voice/service';
import { VoiceStore, memorySimilarity, object, type Row } from '../main/services/voice/store';
import { parseLearning, polish, polishOutput, recordingRefinement, transcribe } from '../main/services/voice/network';
import { microphonePermission } from '../main/services/voice/permission';
import { kvSet } from '../main/services/settings';
import { registerVoiceHandlers } from '../main/ipc/handlers/voice';
import { ChannelRegistry } from '../main/ipc/registry';

const root = mkdtempSync(join(tmpdir(), 'klaus-voice-gate-'));
const h = new Harness(); let serial = 0;
const services = new Set<VoiceService>();
const make = (mode = 'normal', overrides: Partial<VoiceOptions> = {}) => {
  const events: Row[] = [], configRoot = join(root, String(++serial));
  const service = new VoiceService({ configRoot, transcriptionAvailable: async () => true, listModels: async () => [], readModelCredential: async () => null,
    micPermission: async () => ({ ok: true, status: 'granted' }),
    deliver: async (_id, _channel, event) => { events.push(object(event)); },
    speechCommand: { executable: process.execPath, args: [resolve('tests/fixtures/speech-helper.cjs')],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPEECH_FIXTURE_MODE: mode } }, ...overrides });
  services.add(service); service.attachOwner(1); service.attachOwner(2);
  return { service, events, configRoot };
};
const close = async (service: VoiceService) => { assert.equal((await service.shutdown()).complete, true); services.delete(service); };
const pcm = (data: Uint8Array) => ({ __klausBinary: Buffer.from(data).toString('base64') });

h.test('dictionary preserves stable ids, source and all words without silently evicting old entries', () => {
  const store = new VoiceStore(join(root, 'store'));
  const first = store.addHotword('  Klaus Native ', 'manual', 1), id = object(first.hotword).id;
  assert.equal(store.addHotword('Klaus Native', 'learned', 2).created, false);
  assert.equal(store.hotwords()[0]?.source, 'manual');
  assert.deepEqual(store.toggleHotword(String(id), false), { ok: true });
  assert.equal(store.hotwords()[0]?.enabled, false);
  assert.equal(store.addHotword('😀'.repeat(80)).error, 'voice-dictionary-term-too-long');
  for (let i = 0; i < 55; i++) store.addHotword(`word-${i}`, 'manual', 100 + i);
  assert.equal(store.hotwords().length, 56); assert.equal(store.hotwords().some(row => row.text === 'word-0'), true);
  assert.deepEqual(store.deleteHotword(store.hotwords()[0]!.id), { ok: true });
});
h.test('dictionary editing preserves identity and source and validates the full term before writing', () => {
  const store = new VoiceStore(join(root, 'dictionary-edit'));
  const first = object(store.addHotword('Original', 'learned').hotword), id = String(first.id);
  const edited = store.addHotword('Corrected', 'manual', 10, id);
  assert.equal(edited.ok, true); assert.equal(object(edited.hotword).id, id); assert.equal(object(edited.hotword).source, 'learned');
  store.addHotword('Another');
  assert.equal(store.addHotword('Another', 'manual', 11, id).error, 'voice-dictionary-term-exists');
  assert.equal(store.addHotword('😀'.repeat(51), 'manual', 12, id).ok, false);
  assert.equal(store.hotwords().find(word => word.id === id)!.text, 'Corrected');
  assert.equal(store.addHotword('😀'.repeat(50)).ok, true);
  assert.equal(store.addHotword('Corrected', 'manual', 13, 'missing').ok, false);
});
h.test('existing SQLite voice rows survive startup and malformed JSON cannot be silently replaced', () => {
  const configRoot = join(root, 'legacy');
  kvSet('voice.hotwords', JSON.stringify([{ text: 'legacy name', enabled: false }]), configRoot);
  const store = new VoiceStore(configRoot), id = store.hotwords()[0]!.id;
  assert.equal(store.hotwords()[0]!.id, id); assert.deepEqual(store.deleteHotword(id), { ok: true });
  kvSet('voice.hotwords', '{corrupt', configRoot);
  assert.throws(() => store.addHotword('new name'));
  assert.equal(store.setting('voice.hotwords'), '{corrupt');
});
h.test('history retention and memory similarity use the existing schema and bare row arrays', () => {
  const store = new VoiceStore(join(root, 'history'));
  store.addHistory({ id: 'old', createdAt: 1, rawText: 'raw', finalText: 'final', durationMs: 23, engine: 'system' });
  store.addHistory({ id: 'now', createdAt: Date.now(), rawText: 'new', finalText: 'new', durationMs: 3, engine: 'system' });
  store.prune(); assert.equal(store.history(500).length, 1); assert.equal(object(store.history(0)[0]).id, 'now');
  assert.deepEqual(store.clearHistory(), { removed: 1 });
  assert.equal(memorySimilarity('prefer brief direct replies', 'brief direct replies'), 1);
  store.mergeMemory('prefer concise voice input'); store.mergeMemory('prefer concise voice input in chat');
  assert.equal(store.memories().length, 1);
});
h.test('the sixteen owned handlers register once and another window cannot write or cancel a session', async () => {
  const { service } = make(), registry = new ChannelRegistry(); registerVoiceHandlers(registry, service);
  assert.equal(registry.size(), 16); assert.throws(() => registerVoiceHandlers(registry, service));
  const started = await service.start(1, { operationId: 'owned-session' }); assert.equal(started.ok, true);
  assert.equal((await service.audio(2, { sessionId: String(started.sessionId), data: [1, 2], seq: 1 })).ok, false);
  await service.cancel(2, { sessionId: String(started.sessionId) });
  assert.equal((await service.audio(1, { sessionId: String(started.sessionId), data: [1, 2], seq: 1 })).ok, true);
  await close(service);
});
h.test('real helper pipes drain exact PCM including a short tail, stderr, and ordered final events', async () => {
  const { service, events } = make();
  const started = await service.start(1, {}); assert.equal(started.ok, true);
  const data = Uint8Array.from({ length: 3346 }, (_, i) => i % 256);
  assert.equal((await service.audio(1, { sessionId: String(started.sessionId), data: pcm(data.subarray(0, 3200)), seq: 1 })).ok, true);
  assert.equal((await service.audio(1, { sessionId: String(started.sessionId), data: pcm(data.subarray(3200)), seq: 2 })).ok, true);
  assert.equal((await service.stop(1, { sessionId: String(started.sessionId) })).ok, true);
  await waitFor(() => events.some(event => event.type === 'final'), 4000, 'final delivery');
  const final = events.find(event => event.type === 'final')!;
  assert.equal(final.text, `pcm:${data.length}:${createHash('sha256').update(data).digest('hex')}`);
  assert.deepEqual(events.map(row => row.seq), [1, 2]); assert.equal(service.store.history(100).length, 1);
  await close(service);
});
h.test('invalid PCM and sequence gaps fail explicitly without writing history', async () => {
  for (const data of [[1], [300, 0]]) {
    const { service, events } = make(), started = await service.start(1, {});
    assert.equal((await service.audio(1, { sessionId: String(started.sessionId), data, seq: 1 })).ok, false);
    assert.equal(events[0]?.type, 'error'); assert.equal(service.store.history(100).length, 0); await close(service);
  }
  const { service, events } = make(), started = await service.start(1, {});
  assert.equal((await service.audio(1, { sessionId: String(started.sessionId), data: [1, 2], seq: 2 })).ok, false);
  assert.equal(events[0]?.code, 'speech-audio-sequence'); await close(service);
});
h.test('spawn failure, malformed protocol and a missing ready handshake release the operation for retry', async () => {
  for (const mode of ['early-exit', 'protocol-error', 'ready-hang']) {
    const { service } = make(mode, { helperReadyTimeoutMs: 150 });
    assert.equal((await service.start(1, {})).ok, false); await close(service);
  }
  const { service } = make('normal', { speechCommand: { executable: join(root, 'does-not-exist') } });
  assert.equal((await service.start(1, {})).ok, false); await close(service);
});
h.test('cancel before helper readiness rejects the late start and reaps the physical child', async () => {
  const { service } = make('ready-hang');
  const start = service.start(1, { operationId: 'pending-start' });
  assert.deepEqual(await service.cancel(1, { sessionId: 'pending-start' }), { ok: true, complete: true });
  assert.equal((await start).ok, false); await close(service);
});
h.test('a stalled PCM reader has bounded admission and complete close waits for physical process exit', async () => {
  const pidFile = join(root, 'stubborn.pid');
  const { service, events } = make('stubborn', { speechCommand: { executable: process.execPath, args: [resolve('tests/fixtures/speech-helper.cjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPEECH_FIXTURE_MODE: 'stubborn', SPEECH_FIXTURE_PID: pidFile } } });
  const started = await service.start(1, {});
  const requests = Array.from({ length: 8 }, (_, i) => service.audio(1, { sessionId: String(started.sessionId), data: pcm(new Uint8Array(32 * 1024)), seq: i + 1 }));
  assert.equal((await requests[7])?.ok, false);
  const report = await service.cancel(1, { sessionId: String(started.sessionId) }, 20);
  // Windows may terminate the child immediately; Unix first waits for SIGTERM.
  if (process.platform !== 'win32') assert.equal(report.complete, false);
  await Promise.all(requests); await close(service);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0));
  const count = events.length; await sleep(30); assert.equal(events.length, count);
});
h.test('microphone cancellation retains the real pending permission operation until its late answer settles', async () => {
  let release!: (value: Row) => void, entered = false;
  const gate = new Promise<Row>(resolve => { release = resolve; });
  const { service } = make('normal', { micPermission: async () => { entered = true; return gate; } });
  const permission = service.microphone(1, { operationId: 'permission-request' });
  await waitFor(() => entered, 500, 'pending OS permission');
  assert.equal((await service.cancel(1, { operationId: 'permission-request' }, 10)).complete, false);
  release({ ok: true, status: 'granted' }); assert.equal((await permission).ok, false); await close(service);
});
h.test('a pending renderer delivery makes close incomplete and blocks owner reuse until it actually settles', async () => {
  let delivered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service } = make('normal', { deliver: async () => { delivered = true; await gate; } });
  const started = await service.start(1, {});
  await service.audio(1, { sessionId: String(started.sessionId), data: [0, 0], seq: 1 });
  await waitFor(() => delivered, 1000, 'pending renderer delivery');
  assert.equal((await service.detachOwner(1, 20)).complete, false);
  assert.throws(() => service.attachOwner(1), /still-closing/);
  release(); await sleep(50); assert.equal((await service.detachOwner(1)).complete, true);
  service.attachOwner(1); await close(service);
});
h.test('cancel during model resolution suppresses late polish, history and final callbacks', async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service, events } = make('normal', { completeText: async () => { entered = true; await gate; return 'Late result'; } });
  const started = await service.start(1, {});
  await service.audio(1, { sessionId: String(started.sessionId), data: [0, 0], seq: 1 });
  await service.stop(1, { sessionId: String(started.sessionId) });
  await waitFor(() => entered, 1000, 'pending polish');
  assert.equal((await service.cancel(1, { sessionId: String(started.sessionId) }, 20)).complete, false);
  release(); await close(service);
  assert.equal(events.some(event => event.type === 'final'), false); assert.equal(service.store.history(100).length, 0);
});
h.test('complete refinement survives slow engine inference without an early raw-text result', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0, settled = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  const raw = 'First sentence. Second sentence. Keep the final tail.';
  const refined = 'First sentence. Second sentence. Please keep the final tail.';
  try {
    const result = polish(new VoiceStore(join(root, 'deadline-engine')), {
      listModels: async () => { throw new Error('Text inference must not discover API keys'); },
      readModelCredential: async () => { throw new Error('Text inference must not read API keys'); },
      completeText: async () => { requests++; entered(); await gate; return refined; },
    }, raw, '', new AbortController().signal).then(value => { settled = true; return value; });
    await ready;
    mock.timers.tick(2000);
    for (let step = 0; step < 4; step++) await Promise.resolve();
    assert.equal(settled, false);
    release();
    assert.deepEqual(await result, { text: refined, polished: true });
    assert.equal(requests, 1);
  } finally { release(); mock.timers.reset(); }
});

h.test('truncated model output cannot count as complete refinement and long recordings receive output headroom', async () => {
  const raw = 'A sentence with its final tail. '.repeat(100);
  const store = new VoiceStore(join(root, 'incomplete-refinement'));
  let budget = 0, failed = true;
  const deps = { listModels: async () => [], readModelCredential: async () => null,
    completeText: async (input: { maxOutputTokens: number }) => {
      budget = input.maxOutputTokens;
      if (failed) throw new Error('text_completion_incomplete');
      return raw;
    } };
  assert.deepEqual(await polish(store, deps, raw, '', new AbortController().signal), { text: raw, polished: false });
  assert.ok(budget > 1024);
  failed = false;
  assert.deepEqual(await polish(store, deps, raw, '', new AbortController().signal), { text: raw.trim(), polished: true });
});

h.test('native refinement context preserves Unicode within per-message and total wire bounds', () => {
  const store = new VoiceStore(join(root, 'native-context'));
  store.addHotword('Klaus'); store.mergeMemory('Prefer concise phrasing.');
  const messages = recordingRefinement(store, 'Leading\0context ' + '🙂'.repeat(4000) + ' final context marker').messages;
  assert.ok(messages.length <= 40);
  assert.ok(messages.every(message => ['user', 'assistant'].includes(message.role) && Buffer.byteLength(message.content, 'utf8') <= 8192));
  assert.ok(messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content, 'utf8'), 0) <= 32768);
  const content = messages.map(message => message.content).join('');
  assert.ok(content.includes('Klaus')); assert.ok(content.includes('Prefer concise phrasing.'));
  assert.ok(content.includes('final context marker')); assert.equal(content.includes('\0'), false);
});

h.test('microphone consent is real on macOS and Windows denial is never reported as granted', async () => {
  let prompts = 0;
  const preferences = { getMediaAccessStatus: () => 'not-determined' as const, askForMediaAccess: async () => { prompts++; return false; } };
  assert.deepEqual(await microphonePermission(preferences, new AbortController().signal, 'darwin'), { ok: false, status: 'denied' });
  assert.deepEqual(await microphonePermission(preferences, new AbortController().signal, 'win32'), { ok: false, status: 'not-determined' });
  assert.equal(prompts, 1);
});
h.test('microphone consent cancellation settles before the system prompt and ignores its late grant', async () => {
  let grant!: (value: boolean) => void, prompts = 0;
  const pending = new Promise<boolean>(resolve => { grant = resolve; });
  const preferences = { getMediaAccessStatus: () => 'not-determined' as const, askForMediaAccess: async () => { prompts++; return prompts === 1 ? pending : false; } };
  const abort = new AbortController(), request = microphonePermission(preferences, abort.signal, 'darwin');
  await waitFor(() => prompts === 1, 500, 'system microphone prompt');
  abort.abort(new Error('permission-cancelled'));
  await assert.rejects(Promise.race([request, sleep(250).then(() => { throw new Error('permission-did-not-cancel'); })]), /permission-cancelled/);
  assert.deepEqual(await microphonePermission(preferences, new AbortController().signal, 'darwin'), { ok: false, status: 'denied' });
  grant(true); await sleep(0); assert.equal(prompts, 2);
});
h.test('cancelling microphone consent before the native prompt is queued never asks the system', async () => {
  let prompts = 0;
  const preferences = { getMediaAccessStatus: () => 'not-determined' as const, askForMediaAccess: async () => { prompts++; return true; } };
  const abort = new AbortController(), request = microphonePermission(preferences, abort.signal, 'darwin');
  abort.abort(new Error('cancel-before-prompt')); await assert.rejects(request, /cancel-before-prompt/); await sleep(0); assert.equal(prompts, 0);
});
h.test('service permission cancellation drains a cancelled OS request before its late completion', async () => {
  let grant!: (value: boolean) => void, entered = false;
  const pending = new Promise<boolean>(resolve => { grant = resolve; });
  const preferences = { getMediaAccessStatus: () => 'not-determined' as const, askForMediaAccess: async () => { entered = true; return pending; } };
  const { service } = make('normal', { micPermission: (_owner, signal) => microphonePermission(preferences, signal, 'darwin') });
  const permission = service.microphone(1, { operationId: 'abortable-permission' });
  await waitFor(() => entered, 500, 'pending system microphone consent');
  assert.equal((await service.cancel(1, { operationId: 'abortable-permission' }, 100)).complete, true);
  assert.equal((await permission).ok, false); grant(true); await close(service);
});
h.test('learning JSON gates reject low confidence and preserve fenced responses and punctuation', () => {
  const result = parseLearning('```json\n{"hotwords":[{"text":"  Klaus ","confidence":null},{"text":"Native","confidence":"0.9"}],"memories":[]}\n```');
  assert.deepEqual(result?.hotwords, [['Klaus', 0], ['Native', 0.9]]);
  assert.equal(parseLearning('not JSON'), null); assert.equal(polishOutput('```text\n“Hello.”\n```'), 'Hello.');
});
h.test('custom audio HTTP keeps its credentials while text refinement and learning use the engine completion boundary', async () => {
  const requests: Array<{ url: string; auth: string; body: string }> = [];
  const textRequests: Array<{ system: string; prompt: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', data => chunks.push(data));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString(); requests.push({ url: request.url!, auth: request.headers.authorization!, body });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ text: 'cloud fixture' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const { service, events, configRoot } = make('normal', { listModels: async () => [{ id: 'byo', provider: 'openai', authType: 'api_key', model: 'fixture', baseUrl }], readModelCredential: async () => 'isolated-fixture-key',
    completeText: async input => { textRequests.push(input); return input.system.includes('learning extractor')
      ? '{"hotwords":[{"text":"ReusableName","confidence":0.9},{"text":"Rejected","confidence":0.2}],"memories":[{"content":"Prefer brief voice input","confidence":0.9}]}'
      : 'Polished fixture.'; } });
  try {
    kvSet('voice.polish.enabled', 'off', configRoot); kvSet('voice.realtime.polish.enabled', 'off', configRoot); kvSet('voice.locale', 'en-US', configRoot);
    assert.deepEqual(await service.transcribe(1, { data: [1, 2, 3], mimeType: 'audio/webm' }), { ok: true, text: 'Polished fixture.', rawText: 'cloud fixture', polished: true });
    assert.equal(requests[0]!.body.includes('name="language"'), false);
    const started = await service.start(1, {}); await service.audio(1, { sessionId: String(started.sessionId), data: [0, 0], seq: 1 }); await service.stop(1, { sessionId: String(started.sessionId) });
    await waitFor(() => events.some(event => event.type === 'final'), 2000, 'polished result');
    assert.equal(events.find(event => event.type === 'final')?.text, 'Polished fixture.');
    await waitFor(() => !service.busy(), 2000, 'native helper closed before the next transcription');
    const learned = await service.learn(1, { insertedText: 'old name', finalText: 'ReusableName' });
    assert.equal(learned.ok, true); assert.equal((learned.addedHotwords as Row[]).length, 1);
    assert.equal(object((learned.addedHotwords as Row[])[0]).id, service.store.hotwords()[0]!.id);
    await waitFor(() => service.store.hotwords().length === 1, 2000, 'learning write');
    assert.equal(service.store.memories().length, 1);
    kvSet('voice.learning.enabled', 'off', configRoot);
    service.store.deleteHotword(service.store.hotwords()[0]!.id);
    const genericLearning = await service.learn(1, { insertedText: 'wrong name', finalText: 'ReusableName' });
    assert.equal((genericLearning.addedHotwords as Row[]).length, 1);
    assert.equal(service.store.memories().length, 1);
    await service.transcribe(1, { data: [1, 2, 3], mimeType: 'audio/webm' });
    assert.ok(textRequests.at(-1)!.system.includes('ReusableName'));
    assert.equal(textRequests.at(-1)!.system.includes('User voice-input preferences'), false);
    assert.ok(requests.every(request => request.url === '/v1/audio/transcriptions'));
    assert.ok(requests.every(request => request.auth === 'Bearer isolated-fixture-key'));
    assert.ok(requests[0]!.body.includes('name="file"')); assert.ok(requests[0]!.body.includes('whisper-1'));
  } finally { await close(service); await new Promise<void>(resolve => server.close(() => resolve())); }
});
h.test('subscription models cannot become an implicit cloud-transcription API key', async () => {
  let reads = 0;
  const { service } = make('normal', { listModels: async () => [{ id: 'subscription', provider: 'openai', authType: 'oauth', model: 'fixture' }], readModelCredential: async () => { reads++; return 'must-not-read'; } });
  assert.deepEqual(await service.transcribe(1, { data: [1, 2] }), { ok: false, error: 'no-credentials' }); assert.equal(reads, 0); await close(service);
});
h.test('closing aborts real cloud HTTP and pending learning without reviving a result or writing preferences', async () => {
  let entered = false, aborted = false;
  const server = createServer((request, response) => { request.resume(); entered = true; response.once('close', () => { aborted = true; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { service, configRoot } = make();
  kvSet('voice.transcribe.apiKey', 'synthetic-key', configRoot); kvSet('voice.transcribe.baseUrl', `http://127.0.0.1:${address.port}/v1`, configRoot);
  try {
    const request = service.transcribe(1, { operationId: 'cloud-request', data: [1, 2, 3] });
    await waitFor(() => entered, 1000, 'HTTP request');
    assert.equal((await service.cancel(1, { operationId: 'cloud-request' })).complete, true);
    assert.equal((await request).ok, false); await waitFor(() => aborted, 1000, 'HTTP socket closed'); await close(service);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  let resolveModels!: () => void, learning = false;
  const gate = new Promise<void>(resolve => { resolveModels = resolve; });
  const value = make('normal', { completeText: async () => { learning = true; await gate; return '{"hotwords":[],"memories":[]}'; } });
  value.service.learn(1, { insertedText: 'old', finalText: 'new' }); await waitFor(() => learning, 500, 'learning request');
  assert.equal((await value.service.detachOwner(1, 10)).complete, false); resolveModels(); await close(value.service);
  assert.equal(value.service.store.hotwords().length, 0); assert.equal(value.service.store.memories().length, 0);
});
h.test('Windows advertises cloud transcription without claiming an unavailable system-ASR helper', async () => {
  const service = new VoiceService({ configRoot: join(root, 'windows-capability'), platform: 'win32', helperPath: process.execPath,
    listModels: async () => [], readModelCredential: async () => null, micPermission: async () => ({ ok: false, status: 'denied' }), deliver: async () => {} });
  services.add(service); service.attachOwner(1);
  assert.equal((await service.config(1)).systemAsr, false); assert.deepEqual(await service.start(1, {}), { ok: false, error: 'system-asr-unavailable' });
  await close(service);
});
h.test('system and custom capture configuration never waits for an unrelated provider capability read', async () => {
  let reads = 0;
  const { service, configRoot } = make('normal', { transcriptionAvailable: async () => { reads++; throw new Error('unrelated provider failed'); } });
  assert.equal((await service.config(1)).sourceAvailable, true); assert.equal(reads, 0);
  kvSet('voice.input.source', 'custom', configRoot);
  assert.equal((await service.config(1)).sourceAvailable, true); assert.equal(reads, 0);
  const settings = await service.config(1, { includeAvailability: true });
  assert.equal(settings.sourceAvailable, true); assert.equal(object(settings.availability).workbuddy, false);
  // A full availability request probes every gated account source; each fails independently here.
  assert.equal(object(settings.availability).antigravity, false);
  assert.equal(object(settings.availability).trae, false); assert.equal(reads, 3);
  await close(service);
});
h.test('disabled dictation capability remains selected, reports unavailable and never starts any transcription route', async () => {
  let native = 0, custom = 0;
  const { service, configRoot } = make('normal', { transcriptionAvailable: async () => false,
    transcribeAudio: async () => { native++; return 'must not start'; }, listModels: async () => { custom++; return []; } });
  kvSet('voice.input.source', 'workbuddy', configRoot);
  const config = await service.config(1);
  assert.equal(config.source, 'workbuddy'); assert.equal(config.sourceAvailable, false); assert.equal(object(config.availability).workbuddy, false);
  assert.deepEqual(await service.transcribe(1, { source: 'workbuddy', data: [1, 2] }), { ok: false, error: 'voice-source-unavailable' });
  assert.equal(native, 0); assert.equal(custom, 0); assert.equal(service.store.setting('voice.input.source'), 'workbuddy');
  assert.equal(service.store.history(100).length, 0); await close(service);
});
h.test('capability discovery uses the capture operation id and cannot publish a late configuration after cancellation', async () => {
  let entered = false, aborted = false, release!: (value: boolean) => void;
  const gate = new Promise<boolean>(resolve => { release = resolve; });
  const { service, configRoot } = make('normal', { transcriptionAvailable: async (_source, signal) => {
    entered = true; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); return gate;
  } });
  kvSet('voice.input.source', 'workbuddy', configRoot);
  const pending = service.config(1, { operationId: 'capability-read' });
  await waitFor(() => entered, 500, 'capability discovery');
  assert.equal((await service.cancel(1, { operationId: 'capability-read' }, 10)).complete, false); assert.equal(aborted, true);
  release(true); const result = await pending; assert.equal(result.ok, false); assert.equal(result.sourceAvailable, undefined);
  assert.equal(service.store.setting('voice.input.source'), 'workbuddy'); await close(service);
});
h.test('OAuth sources use their selected engine credentials without custom key resolution and retain voice history', async () => {
  for (const source of ['claude', 'codex', 'workbuddy', 'qoder', 'qwenwork'] as const) {
    let calls = 0, reads = 0;
    const { service, configRoot } = make('normal', { listModels: async () => { reads++; return []; },
      transcribeAudio: async (actual, audio, signal) => {
        calls++; assert.equal(actual, source); assert.equal(audio.audioBase64, 'AQID');
        assert.equal(audio.mimeType, 'audio/wav'); assert.equal(audio.language, undefined); assert.equal(audio.operationId, 'oauth-capture');
        signal.throwIfAborted(); return 'Native transcript.';
      } });
    kvSet('voice.input.source', source, configRoot); kvSet('voice.locale', 'en-US', configRoot); kvSet('voice.polish.enabled', 'off', configRoot);
    assert.equal((await service.config(1)).source, source); assert.equal((await service.config(1)).sourceAvailable, true);
    const result = await service.transcribe(1, { source, data: [1, 2, 3], mimeType: 'audio/wav', operationId: 'oauth-capture', durationMs: 123 });
    assert.deepEqual(result, { ok: true, text: 'Native transcript.', rawText: 'Native transcript.', polished: false });
    assert.equal(reads, 0); assert.equal(calls, 1);
    const history = object(service.store.history(1)[0]); assert.equal(history.engine, source); assert.equal(history.durationMs, 123);
    assert.deepEqual(await service.start(1, {}), { ok: false, error: 'voice-source-changed' });
    await close(service);
  }
});
h.test('an unavailable or failed explicit voice source never starts a custom endpoint or changes its saved selection', async () => {
  let reads = 0;
  const { service, configRoot } = make('normal', { listModels: async () => { reads++; return []; },
    transcribeAudio: async () => { throw new Error('claude_transcription_authentication_required'); } });
  kvSet('voice.input.source', 'claude', configRoot);
  assert.deepEqual(await service.transcribe(1, { source: 'claude', data: [1, 2] }), { ok: false, error: 'claude_transcription_authentication_required' });
  assert.deepEqual(await service.transcribe(1, { source: 'custom', data: [1, 2] }), { ok: false, error: 'voice-source-changed' });
  assert.equal(service.store.setting('voice.input.source'), 'claude'); assert.equal(reads, 0); assert.equal(service.store.history(100).length, 0);
  kvSet('voice.input.source', 'unknown-saved-source', configRoot);
  assert.equal((await service.config(1)).source, 'unknown-saved-source'); assert.equal((await service.config(1)).sourceAvailable, false);
  assert.deepEqual(await service.transcribe(1, { data: [1, 2] }), { ok: false, error: 'voice-source-unavailable' });
  assert.equal(reads, 0); await close(service);
});
h.test('a selected voice source changed during transcription cannot publish a late transcript or history', async () => {
  let entered = false, release!: (text: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const { service, configRoot } = make('normal', { transcribeAudio: async () => { entered = true; return gate; } });
  kvSet('voice.input.source', 'codex', configRoot);
  const request = service.transcribe(1, { source: 'codex', data: [1, 2], operationId: 'source-change' });
  await waitFor(() => entered, 500, 'native transcription'); kvSet('voice.input.source', 'custom', configRoot); release('Late transcript');
  assert.deepEqual(await request, { ok: false, error: 'voice-source-changed' }); assert.equal(service.store.history(100).length, 0); await close(service);
});
h.test('native transcription cancellation stays owned until the provider settles and suppresses every late write', async () => {
  let entered = false, aborted = false, release!: (text: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const { service, configRoot } = make('normal', { transcribeAudio: async (_source, _audio, signal) => {
    entered = true; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); return gate;
  } });
  kvSet('voice.input.source', 'workbuddy', configRoot);
  const request = service.transcribe(1, { source: 'workbuddy', data: [1, 2], operationId: 'native-pending' });
  await waitFor(() => entered, 500, 'native request');
  assert.equal((await service.detachOwner(1, 10)).complete, false); assert.equal(aborted, true);
  assert.throws(() => service.attachOwner(1), /still-closing/);
  release('Must not publish'); assert.equal((await request).ok, false); assert.equal(service.store.history(100).length, 0);
  assert.equal((await service.detachOwner(1)).complete, true); service.attachOwner(1); await close(service);
});
h.test('worklet resampling preserves one-second sample counts and flushes a short tail; credit exhaustion is explicit', () => {
  const source = readFileSync(resolve('frontend/public/js/voice-capture-worklet.js'), 'utf8');
  for (const rate of [48000, 44100, 16000]) {
    const events: Array<{ type: string; data?: ArrayBuffer; seq?: number }> = []; let Constructor: any;
    class Base { port = { onmessage: (_event: unknown) => {}, postMessage: (value: any) => { events.push(value); if (value.type === 'audio') instance.port.onmessage({ data: { type: 'ack', seq: value.seq } }); } }; }
    runInNewContext(source, { sampleRate: rate, AudioWorkletProcessor: Base, registerProcessor: (_name: string, value: unknown) => { Constructor = value; } });
    const instance = new Constructor();
    const count = rate + 37;
    for (let start = 0; start < count; start += 128) instance.process([[new Float32Array(Math.min(128, count - start)).fill(0.5)]]);
    instance.port.onmessage({ data: { type: 'stop' } });
    const samples = events.filter(event => event.type === 'audio').reduce((sum, event) => sum + event.data!.byteLength / 2, 0);
    assert.equal(samples, Math.ceil(count * 16000 / rate)); assert.equal(events.at(-1)?.type, 'stopped');
  }
  const events: Row[] = []; let Constructor: any;
  runInNewContext(source, { sampleRate: 16000, AudioWorkletProcessor: class { port = { postMessage: (value: Row) => events.push(value) }; }, registerProcessor: (_name: string, value: unknown) => { Constructor = value; } });
  const instance = new Constructor(); instance.process([[new Float32Array(1600 * 5)]]);
  assert.equal(events.filter(event => event.type === 'audio').length, 4); assert.equal(events.at(-1)?.code, 'speech-audio-overflow');
});

h.test('paced dictation survives a minute and still has a bounded cancellation deadline', async () => {
  const { service } = make();
  const controller = new AbortController();
  const deps = {
    listModels: async () => [], readModelCredential: async () => null,
    transcribeAudio: async (_source: string, _audio: unknown, signal: AbortSignal): Promise<string> => {
      await new Promise<void>(resolve => setTimeout(resolve, 61_000));
      signal.throwIfAborted(); return 'Complete paced transcript.';
    },
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const result = transcribe(service.store, deps, new Uint8Array([1, 2]), 'audio/wav', controller.signal,
      { source: 'qwenwork', operationId: 'long-recording' });
    mock.timers.tick(61_000);
    assert.equal((await result).text, 'Complete paced transcript.');
    let active: AbortSignal | undefined;
    const pending = transcribe(service.store, { ...deps, transcribeAudio: async (_source, _audio, signal) => {
      active = signal;
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, new Uint8Array([1, 2]), 'audio/wav', controller.signal, { source: 'qwenwork', operationId: 'bounded-recording' });
    const rejected = assert.rejects(pending, /VOICE_TIMEOUT/);
    mock.timers.tick(450_000);
    await rejected;
    assert.equal(active?.aborted, true);
  } finally { mock.timers.reset(); await close(service); }
});

h.test('rolling segment probes skip polish and history, admit one at a time, and yield to the full-audio pass', async () => {
  let polishEntered = false, p1Entered = false, p2Entered = false, p2Aborted = false, p3Entered = false, p3Aborted = false;
  let releaseP1!: (text: string) => void, releaseP2!: (text: string) => void, releaseP3!: (text: string) => void;
  const gateP1 = new Promise<string>(resolve => { releaseP1 = resolve; });
  const gateP2 = new Promise<string>(resolve => { releaseP2 = resolve; });
  const gateP3 = new Promise<string>(resolve => { releaseP3 = resolve; });
  const { service, configRoot } = make('normal', {
    listModels: async () => [], completeText: async () => { polishEntered = true; return 'Full transcript.'; },
    transcribeAudio: async (_source, audio, signal) => {
      const operation = String(audio.operationId);
      if (operation.endsWith('-p1')) { p1Entered = true; signal.throwIfAborted(); return gateP1; }
      if (operation.endsWith('-p2')) { p2Entered = true; signal.addEventListener('abort', () => { p2Aborted = true; }, { once: true }); return gateP2; }
      if (operation.endsWith('-p3')) { p3Entered = true; signal.addEventListener('abort', () => { p3Aborted = true; }, { once: true }); return gateP3; }
      signal.throwIfAborted(); return 'Full transcript.';
    } });
  kvSet('voice.input.source', 'claude', configRoot); kvSet('voice.locale', 'en-US', configRoot);
  try {
    const first = service.transcribe(1, { source: 'claude', data: [1, 2, 3], mimeType: 'audio/wav', partial: true, operationId: 'seg-p1' });
    await waitFor(() => p1Entered, 500, 'first segment probe');
    assert.equal(polishEntered, false);
    assert.deepEqual(await service.transcribe(1, { source: 'claude', data: [1, 2], mimeType: 'audio/wav', partial: true, operationId: 'seg-concurrent' }), { ok: false, error: 'voice-partial-busy' });
    releaseP1('Raw segment text.');
    assert.deepEqual(await first, { ok: true, text: 'Raw segment text.', partial: true });
    assert.equal(polishEntered, false);
    assert.equal(service.store.history(100).length, 0);
    const second = service.transcribe(1, { source: 'claude', data: [1, 2], mimeType: 'audio/wav', partial: true, operationId: 'seg-p2' });
    await waitFor(() => p2Entered, 500, 'second segment probe');
    const full = service.transcribe(1, { source: 'claude', data: [1, 2, 3, 4], mimeType: 'audio/wav', operationId: 'seg-final' });
    await waitFor(() => p2Aborted, 500, 'the full-audio admission evicts the in-flight probe');
    assert.deepEqual(await full, { ok: true, text: 'Full transcript.', rawText: 'Full transcript.', polished: true });
    assert.equal(polishEntered, true);
    releaseP2('Ignored late segment.');
    assert.deepEqual(await second, { ok: false, error: 'voice-cancelled' });
    assert.equal(service.store.history(100).length, 1);
    const third = service.transcribe(1, { source: 'claude', data: [1, 2], mimeType: 'audio/wav', partial: true, operationId: 'seg-p3' });
    await waitFor(() => p3Entered, 500, 'third segment probe');
    const report = service.cancel(1, { operationId: 'seg-p3' });
    await waitFor(() => p3Aborted, 500, 'explicit cancellation aborts the probe');
    releaseP3('Ignored.');
    assert.deepEqual(await report, { ok: true, complete: true });
    assert.equal((await third).ok, false);
    assert.equal(service.store.history(100).length, 1);
  } finally { await close(service); }
});

h.test('recovery accepts only complete source-matched owner receipts and commits history once', async () => {
  let calls = 0;
  const { service, configRoot } = make('normal', { transcribeAudio: async () => ++calls === 1 ? 'First sentence.' : 'Last sentence.' });
  kvSet('voice.input.source', 'codex', configRoot); kvSet('voice.polish.enabled', 'off', configRoot);
  const request = { source: 'codex', data: [1, 2], mimeType: 'audio/wav' };
  try {
    await service.transcribe(1, { ...request, partial: true, operationId: 'record-p1', durationMs: 2000 });
    await service.transcribe(1, { ...request, partial: true, operationId: 'record-r2', durationMs: 500 });
    const recovery = { ...request, operationId: 'record-recovered', segmentIds: ['record-p1', 'record-r2'], durationMs: 2500 };
    assert.deepEqual(await service.transcribe(2, recovery), { ok: false, error: 'voice-segments-invalid' });
    assert.deepEqual(await service.transcribe(1, { ...recovery, durationMs: 3000 }), { ok: false, error: 'voice-segments-incomplete' });
    assert.equal(service.store.history(100).length, 0);
    assert.deepEqual(await service.transcribe(1, recovery), { ok: true, text: 'First sentence. Last sentence.', rawText: 'First sentence. Last sentence.', polished: false });
    assert.equal(calls, 2); assert.equal(service.store.history(100).length, 1);
    assert.deepEqual(await service.transcribe(1, recovery), { ok: false, error: 'voice-segments-invalid' });
    assert.equal(service.store.history(100).length, 1);
  } finally { await close(service); }
});

h.test('segment receipts survive a long recording and provider timeout until recovery consumes them', async () => {
  const { service, configRoot } = make('normal', { transcribeAudio: async () => 'Complete sentence.' });
  kvSet('voice.input.source', 'antigravity', configRoot); kvSet('voice.polish.enabled', 'off', configRoot);
  const request = { source: 'antigravity', data: [1, 2], mimeType: 'audio/wav', durationMs: 300_000 };
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    assert.equal((await service.transcribe(1, { ...request, partial: true, operationId: 'long-p1' })).ok, true);
    // Recording, final provider timeout and a tail probe may outlive a short cache TTL.
    now += 300_000 + 450_000 + 20_000;
    const recovery = { ...request, operationId: 'long-recovered', segmentIds: ['long-p1'] };
    assert.deepEqual(await service.transcribe(1, recovery), { ok: true, text: 'Complete sentence.', rawText: 'Complete sentence.', polished: false });
    assert.equal(service.store.history(100).length, 1);
    assert.deepEqual(await service.transcribe(1, recovery), { ok: false, error: 'voice-segments-invalid' });
  } finally { clock.mock.restore(); await close(service); }
});

void h.finish(join(root, 'result.json'), 'voice').then(async code => {
  for (const service of services) await service.shutdown(5000);
  if (!code) rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
