import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineSpeech } from '../main/services/voice/engine-speech';
import { RetainedSpeech } from '../main/services/voice/retained-speech';
import { VoiceService } from '../main/services/voice/service';
import { voiceModelAccess, voiceProviderError } from '../main/app/voice-runtime';
import { kvSet } from '../main/services/settings';
import { object, type Row } from '../main/services/voice/store';
import { Harness, sleep, waitFor } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-live-dictation-'));

class Peer extends EventEmitter {
  calls: Array<{ method: string; params: Row }> = [];
  closed = false;
  drained = true;
  isClosed() { return this.closed; }
  async requestWithTimeout(method: string, params: unknown) {
    const value = params as Row;
    this.calls.push({ method, params: value });
    if (method === 'engine/dictationEnd') return { complete: this.drained };
    return {};
  }
  event(operationId: string, seq: number, type: string, text = '') {
    this.emit('event', { type: 'productEvent', method: 'engine/dictationEvent', params: { operationId, seq, type, text } });
  }
}

h.test('native dictation streams frames through named methods and receives text before finish', async () => {
  const peer = new Peer(), events: Row[] = [];
  let backend!: EngineSpeech;
  backend = new EngineSpeech({ operationId: 'capture', source: 'qwenwork', client: peer,
    refinement: { messages: [{ role: 'user', content: 'Vocabulary: Klaus' }] },
    current() {}, errorCode: () => 'speech-failed', onEvent: async event => { events.push(event); if (event.type === 'final') backend.close(); },
    onFailure: async code => { throw new Error(code); } });
  await backend.ready;
  assert.deepEqual(peer.calls[0], { method: 'engine/dictationStart', params: { operationId: 'capture', source: 'qwenwork', refinement: { messages: [{ role: 'user', content: 'Vocabulary: Klaus' }] } } });
  await backend.audio(new Uint8Array([1, 0]), 1);
  peer.event('another-owner', 1, 'partial', 'wrong');
  peer.event('capture', 1, 'partial', 'hello');
  await waitFor(() => events.length === 1, 1000, 'live partial');
  assert.equal(events[0]?.text, 'hello');
  assert.equal(peer.calls.some(call => call.method === 'engine/dictationEnd'), false);
  assert.deepEqual(peer.calls[1], { method: 'engine/dictationAppendAudio', params: { operationId: 'capture', seq: 1, audioBase64: 'AQA=' } });
  await backend.stop();
  peer.event('capture', 2, 'final', 'hello world');
  await backend.done;
  assert.deepEqual(events.map(event => event.type), ['partial', 'final']);
  assert.equal(peer.listenerCount('event'), 0);
});

h.test('incomplete transport cancellation keeps the lease pending until acknowledged', async () => {
  const peer = new Peer(); peer.drained = false;
  const backend = new EngineSpeech({ operationId: 'pending', source: 'antigravity', client: peer, current() {}, errorCode: () => 'speech-failed', onEvent: async () => {}, onFailure: async () => {} });
  await backend.ready;
  let finished = false; void backend.done.then(() => { finished = true; });
  backend.close(); await sleep(30);
  assert.equal(finished, false);
  peer.drained = true;
  await backend.done; assert.equal(finished, true);
});

h.test('realtime dictation preserves the selected source and never substitutes another provider', async () => {
  let onEvent!: (event: Row) => Promise<void>, release!: () => void;
  const frames: number[] = [], events: Row[] = [];
  const done = new Promise<void>(resolve => { release = resolve; });
  let fileCalls = 0;
  const service = new VoiceService({ configRoot: root, platform: 'win32',
    listModels: async () => [], readModelCredential: async () => null,
    transcribeAudio: async () => { fileCalls++; return 'Recorded transcript.'; }, transcriptionAvailable: async () => true,
    micPermission: async () => ({ ok: true }), deliver: async (_id, _channel, event) => { events.push(event as Row); },
    streaming: { available: async source => source === 'qwenwork', create: (_id, source, _signal, publish) => {
      assert.equal(source, 'qwenwork'); onEvent = publish;
      return { ready: Promise.resolve(), done, audio: async data => { frames.push(data.length); }, stop: async () => { await onEvent({ type: 'final', text: 'Live sentence.' }); }, close: release };
    } },
  });
  service.attachOwner(1);
  kvSet('voice.input.source', 'codex', root); kvSet('voice.polish.enabled', 'off', root);
  try {
    const config = await service.config(1, { includeAvailability: true });
    assert.equal(config.source, 'codex'); assert.equal(config.streaming, false); assert.equal(config.nativeStreaming, false);
    assert.equal(config.sourceAvailable, false); assert.equal(object(config.availability).codex, true);
    assert.equal(object(config.availability).claude, true); assert.equal(object(config.availability).custom, true);
    assert.equal(object(config.availability).qoder, true, 'an unavailable streaming route never hides the recording-upload route');
    assert.deepEqual(await service.transcribe(1, { source: 'codex', data: [1, 2], mimeType: 'audio/webm' }),
      { ok: false, error: 'voice-source-unavailable' });
    assert.equal(fileCalls, 0, 'unavailable realtime capture never starts file transcription');
    kvSet('voice.input.experience', 'compatibility', root);
    assert.deepEqual(await service.transcribe(1, { source: 'codex', data: [1, 2], mimeType: 'audio/webm' }),
      { ok: true, text: 'Recorded transcript.', rawText: 'Recorded transcript.', polished: false });
    assert.equal(fileCalls, 1, 'file transcription requires explicit compatibility');
    kvSet('voice.input.experience', 'realtime', root);
    service.store.clearHistory();
    assert.equal((await service.start(1, { operationId: 'unsupported', source: 'codex' })).ok, false, 'an unavailable selected native route is rejected without substitution');
    kvSet('voice.input.source', 'qwenwork', root);
    const selected = await service.config(1);
    assert.equal(selected.source, 'qwenwork'); assert.equal(selected.streaming, true);
    const started = await service.start(1, { operationId: 'native', source: 'qwenwork' });
    assert.equal(started.ok, true);
    await service.audio(1, { sessionId: 'native', data: [1, 0], seq: 1 });
    await onEvent({ type: 'partial', text: 'Live' });
    assert.equal(events[0]?.type, 'partial'); assert.equal(service.store.history(1).length, 0);
    await service.stop(1, { sessionId: 'native' });
    assert.deepEqual(frames, [2]); assert.equal(fileCalls, 1, 'the native session never falls back to file transcription');
    assert.equal(events.at(-1)?.text, 'Live sentence.');
    assert.equal(object(service.store.history(1)[0]).engine, 'qwenwork');
    kvSet('voice.input.experience', 'compatibility', root);
    const compatibility = await service.config(1);
    assert.equal(compatibility.source, 'qwenwork'); assert.equal(compatibility.streaming, false);
  } finally { await service.shutdown(); }
});

for (const scenario of ['unavailable', 'probe-failed', 'file-only'] as const) h.test(`realtime admission never starts a file fallback: ${scenario}`, async () => {
  let fileCalls = 0, captures = 0;
  const service = new VoiceService({ configRoot: root, platform: 'win32', listModels: async () => [], readModelCredential: async () => null,
    transcribeAudio: async () => { fileCalls++; return 'Unexpected file result'; },
    micPermission: async () => { captures++; return { ok: true }; }, deliver: async () => {},
    streaming: { available: async () => { if (scenario === 'probe-failed') throw new Error('probe failed'); return false; }, create: () => { captures++; throw new Error('Unexpected capture'); } } });
  service.attachOwner(1);
  kvSet('voice.input.experience', 'realtime', root); kvSet('voice.input.source', scenario === 'file-only' ? 'custom' : 'codex', root);
  try {
    const config = await service.config(1);
    assert.equal(config.source, scenario === 'file-only' ? 'custom' : 'codex');
    assert.equal(config.sourceAvailable, false); assert.equal(config.streaming, false);
    assert.equal((await service.start(1, { operationId: 'unavailable-live' })).ok, false);
    assert.equal((await service.transcribe(1, { data: [1, 0], mimeType: 'audio/wav' })).ok, false);
    assert.equal(fileCalls, 0); assert.equal(captures, 0);
  } finally { await service.shutdown(); }
});

for (const source of ['claude', 'codex', 'workbuddy', 'antigravity', 'trae', 'qoder', 'qoderwork', 'qwenwork'] as const) h.test(`selected native dictation publishes PCM previews before stop without file requests: ${source}`, async () => {
  const peer = new Peer(), events: Row[] = [];
  let fileCalls = 0, accountReads = 0;
  peer.requestWithTimeout = async (method, params) => {
    peer.calls.push({ method, params: params as Row });
    if (method === `${source}/status`) return { loggedIn: true };
    if (method === `${source}/capabilities`) return { transcription: { available: true, streaming: true } };
    if (method === 'engine/dictationStart') return { credentialGeneration: 'selected-account' };
    if (method === 'engine/dictationAppendAudio') return {};
    if (method === 'engine/dictationEnd') return { complete: true };
    if (method.endsWith('/transcribeAudio')) { fileCalls++; throw new Error('Unexpected file transcription'); }
    throw new Error(`Unexpected request: ${method}`);
  };
  const models = voiceModelAccess({ providers: async () => { throw new Error('Unexpected custom model read'); } },
    async () => { throw new Error('Unexpected unbound request'); }, root, () => ({ generation: 1, client: peer }),
    () => { accountReads++; return { loggedIn: true }; });
  const service = new VoiceService({ ...models, configRoot: root, platform: 'win32', micPermission: async () => ({ ok: true }),
    deliver: async (_id, _channel, event) => { events.push(event as Row); } });
  service.attachOwner(1);
  kvSet('voice.input.source', source, root); kvSet('voice.input.experience', 'realtime', root); kvSet('voice.polish.enabled', 'off', root);
  service.store.clearHistory();
  try {
    const config = await service.config(1);
    assert.equal(config.source, source); assert.equal(config.streaming, true); assert.equal(config.nativeStreaming, true);
    assert.equal((await service.start(1, { operationId: 'native-source' })).ok, true);
    assert.equal((await service.audio(1, { sessionId: 'native-source', data: [1, 0], seq: 1 })).ok, true);
    peer.event('native-source', 1, 'partial', 'Live words');
    await waitFor(() => events.some(event => event.type === 'partial'), 1000, 'native source preview');
    assert.equal(peer.calls.some(call => call.method === 'engine/dictationEnd'), false);
    assert.equal(service.store.history(1).length, 0);
    await service.stop(1, { sessionId: 'native-source' });
    peer.event('native-source', 2, 'final', 'Complete live sentence.');
    await waitFor(() => events.some(event => event.type === 'final'), 1000, 'native source completion');
    const startParams = peer.calls.find(call => call.method === 'engine/dictationStart')?.params;
    assert.equal(startParams?.operationId, 'native-source'); assert.equal(startParams?.source, source);
    if (['qoder', 'qoderwork', 'qwenwork'].includes(source)) assert.deepEqual(object(startParams?.refinement).messages, []);
    else assert.equal(startParams?.refinement, undefined);
    assert.deepEqual(peer.calls.find(call => call.method === 'engine/dictationAppendAudio')?.params,
      { operationId: 'native-source', seq: 1, audioBase64: 'AQA=' });
    assert.equal(fileCalls, 0);
    assert.equal(events.filter(event => event.type === 'final').length, 1);
    assert.equal(object(service.store.history(1)[0]).engine, source);
    assert.equal(peer.calls.some(call => call.method.startsWith(source === 'codex' ? 'trae/' : 'codex/')), false);
    assert.equal(accountReads > 0, source === 'codex' || source === 'claude');
    kvSet('voice.input.experience', 'compatibility', root);
    const compatibility = await service.config(1);
    assert.equal(compatibility.source, source); assert.equal(compatibility.streaming, false);
  } finally { await service.shutdown(); }
});

h.test('Codex native readiness uses the selected account status without a provider RPC or custom credentials', async () => {
  const peer = new Peer();
  let status: Row = { loggedIn: false };
  const access = voiceModelAccess({ providers: async () => { throw new Error('Unexpected credential read'); } },
    async () => { throw new Error('Unexpected unbound request'); }, root, () => ({ generation: 1, client: peer }), () => status);
  for (const candidate of [{ loggedIn: false }, { loggedIn: true, needsLogin: true }, { loggedIn: true, needsReimport: true }] as Row[]) {
    status = candidate;
    assert.equal(await access.streaming!.available('codex', new AbortController().signal), false);
  }
  status = { loggedIn: true };
  assert.equal(await access.streaming!.available('codex', new AbortController().signal), true);
  assert.equal(await access.streaming!.available('custom', new AbortController().signal), false);
  const noAccountReader = voiceModelAccess({ providers: async () => ({}) }, async () => ({}), root, () => ({ generation: 1, client: peer }));
  assert.equal(await noAccountReader.streaming!.available('codex', new AbortController().signal), false);
  assert.equal(peer.calls.length, 0);
});

h.test('Codex native account readiness is fenced by cancellation and engine generation', async () => {
  for (const scenario of ['cancelled', 'engine-replaced'] as const) {
    const peer = new Peer(); let generation = 1, release!: (value: Row) => void;
    const pending = new Promise<Row>(resolve => { release = resolve; });
    const controller = new AbortController();
    const access = voiceModelAccess({ providers: async () => ({}) }, async () => ({}), root,
      () => ({ generation, client: peer }), () => pending);
    const readiness = access.streaming!.available('codex', controller.signal);
    if (scenario === 'cancelled') controller.abort(); else generation++;
    release({ loggedIn: true });
    await assert.rejects(() => readiness);
    assert.equal(peer.calls.length, 0);
  }
});

h.test('end acknowledgment never commits a preview and one whole-recording result replaces it', async () => {
  let publish!: (event: Row) => Promise<void>, release!: () => void;
  const events: Row[] = [], done = new Promise<void>(resolve => { release = resolve; });
  const service = new VoiceService({ configRoot: root, platform: 'win32',
    listModels: async () => [], readModelCredential: async () => null,
    transcribeAudio: async () => { throw new Error('Unexpected file transcription'); },
    micPermission: async () => ({ ok: true }), deliver: async (_id, _channel, event) => { events.push(event as Row); },
    streaming: { available: async () => true, create: (_id, _source, _signal, onEvent) => {
      publish = onEvent;
      return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close: release };
    } },
  });
  service.attachOwner(1); kvSet('voice.input.source', 'qwenwork', root); kvSet('voice.input.experience', 'realtime', root);
  service.store.clearHistory();
  try {
    assert.equal((await service.start(1, { operationId: 'whole-recording' })).ok, true);
    await publish({ type: 'partial', text: 'We saw a cat.' });
    await publish({ type: 'partial', text: 'We saw a cat. Keep the tail.' });
    assert.equal(service.store.history(10).length, 0);
    assert.equal((await service.stop(1, { sessionId: 'whole-recording' })).ok, true);
    assert.equal(events.some(event => event.type === 'final'), false);
    assert.equal(service.store.history(10).length, 0);
    const complete = 'We saw a cap. Keep the tail.';
    await publish({ type: 'final', text: complete });
    await publish({ type: 'partial', text: 'stale preview' });
    await publish({ type: 'final', text: 'Keep the tail.' });
    assert.deepEqual(events.map(event => [event.type, event.text]), [
      ['partial', 'We saw a cat.'], ['partial', 'We saw a cat. Keep the tail.'], ['final', complete],
    ]);
    const history = service.store.history(10);
    assert.equal(history.length, 1);
    assert.equal(object(history[0]).rawText, complete); assert.equal(object(history[0]).finalText, complete);
  } finally { await service.shutdown(); }
});

for (const changed of [true, false]) h.test(`native recording refinement commits the full result without a second text request: changed=${changed}`, async () => {
  let publish!: (event: Row) => Promise<void>, release!: () => void, receivedOptions: unknown;
  const events: Row[] = [], done = new Promise<void>(resolve => { release = resolve; });
  let modelReads = 0;
  const service = new VoiceService({ configRoot: root, platform: 'win32',
    listModels: async () => [], completeText: async () => { modelReads++; throw new Error('Native refinement must not be repeated'); }, readModelCredential: async () => null,
    transcribeAudio: async () => { throw new Error('Unexpected file transcription'); },
    micPermission: async () => ({ ok: true }), deliver: async (_id, _channel, event) => { events.push(event as Row); },
    streaming: { available: async () => true, create: (_id, _source, _signal, onEvent, _onFailure, options) => {
      publish = onEvent; receivedOptions = options;
      return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close: release };
    } },
  });
  service.attachOwner(1); kvSet('voice.input.source', 'qwenwork', root); kvSet('voice.input.experience', 'realtime', root);
  kvSet('voice.learning.enabled', 'off', root);
  service.store.addHotword('Klaus'); service.store.mergeMemory('Do not send this disabled style preference'); service.store.clearHistory();
  try {
    assert.equal((await service.start(1, { operationId: 'native-refined', context: 'Recent conversation fixture.' })).ok, true);
    const context = JSON.stringify(receivedOptions);
    assert.ok(context.includes('Klaus')); assert.ok(context.includes('Recent conversation fixture.'));
    assert.equal(context.includes('disabled style preference'), false);
    await service.stop(1, { sessionId: 'native-refined' });
    const raw = `Send the notes to ${changed ? 'Klaws' : 'Klaus'}. Keep the final sentence.`;
    const final = 'Send the notes to Klaus. Keep the final sentence.';
    await publish({ type: 'final', text: final, rawText: raw, polished: changed, refinementComplete: true });
    assert.equal(modelReads, 0);
    assert.equal(events.at(-1)?.text, final); assert.equal(events.at(-1)?.rawText, raw);
    assert.equal(events.at(-1)?.polished, changed); assert.equal(events.at(-1)?.refinementComplete, true);
    const history = service.store.history(10);
    assert.equal(history.length, 1); assert.equal(object(history[0]).rawText, raw); assert.equal(object(history[0]).finalText, final);
  } finally { await service.shutdown(); }
});

h.test('complete raw recognition survives primary closure until full backup refinement is delivered once', async () => {
  let publish!: (event: Row) => Promise<void>, release!: () => void;
  const events: Row[] = [], done = new Promise<void>(resolve => { release = resolve; });
  const raw = 'First sentence. Keep the final tail.', refined = 'First sentence. Please keep the final tail.';
  let calls = 0;
  const service = new VoiceService({ configRoot: root, platform: 'win32',
    listModels: async () => [], readModelCredential: async () => null, completeText: async () => { calls++; return refined; },
    transcribeAudio: async () => { throw new Error('Unexpected file transcription'); },
    micPermission: async () => ({ ok: true }), deliver: async (_id, _channel, event) => { events.push(event as Row); },
    streaming: { available: async () => true, create: (_id, _source, _signal, onEvent) => {
      publish = onEvent;
      return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close: release };
    } },
  });
  service.attachOwner(1); kvSet('voice.input.source', 'qwenwork', root); kvSet('voice.input.experience', 'realtime', root); service.store.clearHistory();
  try {
    assert.equal((await service.start(1, { operationId: 'refinement-backup' })).ok, true);
    await service.stop(1, { sessionId: 'refinement-backup' });
    await publish({ type: 'recognized', text: raw });
    assert.equal(events.length, 0); assert.equal(service.store.history(10).length, 0);
    await publish({ type: 'error', code: 'qwenwork_transcription_refinement_timed_out' }); release();
    await waitFor(() => events.some(event => event.type === 'final'), 2000, 'complete backup result');
    await publish({ type: 'final', text: 'stale', refinementComplete: true });
    assert.equal(calls, 1); assert.equal(events.length, 1);
    assert.equal(events[0]?.text, refined); assert.equal(events[0]?.rawText, raw);
    assert.equal(events[0]?.refinementComplete, true); assert.equal(events[0]?.refinementSource, 'text-model');
    assert.equal(service.store.history(10).length, 1);
  } finally { await service.shutdown(); }
});

h.test('transport failure after complete recognition does not retransmit the audio', async () => {
  let publish!: (event: Row) => Promise<void>, fail!: (code: string) => Promise<void>, close!: () => void;
  const done = new Promise<void>(resolve => { close = resolve; });
  let fallbackCalls = 0;
  const failures: string[] = [];
  const backend = new RetainedSpeech({ signal: new AbortController().signal, onEvent: async () => {}, onFailure: async code => { failures.push(code); }, errorCode: () => 'voice-provider-failed',
    primary: (event, failure) => { publish = event; fail = failure; return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close }; },
    fallback: async () => { fallbackCalls++; return 'must not run'; },
  });
  await backend.ready; await backend.audio(new Uint8Array([1, 0]), 1); await backend.stop();
  await publish({ type: 'recognized', text: 'The complete recording.' });
  await fail('qwenwork_transport_failed'); await backend.done;
  assert.equal(fallbackCalls, 0); assert.deepEqual(failures, ['qwenwork_transport_failed']);
});

h.test('transient transport failure retains every PCM frame and recovers with the same source after stop', async () => {
  const events: Row[] = [], failures: string[] = [];
  let publishFailure!: (code: string) => Promise<void>, closePrimary!: () => void;
  const physical = new Promise<void>(resolve => { closePrimary = resolve; });
  let liveFrames = 0, fallbackCalls = 0;
  const backend = new RetainedSpeech({ signal: new AbortController().signal,
    onEvent: async event => { events.push(event); }, onFailure: async code => { failures.push(code); }, errorCode: error => error instanceof Error ? error.message : 'voice-provider-failed',
    primary: (_event, failure) => { publishFailure = failure; return { ready: Promise.resolve(), done: physical, audio: async () => { liveFrames++; }, stop: async () => {}, close: closePrimary }; },
    fallback: async audio => {
      fallbackCalls++;
      const header = new DataView(audio); assert.equal(header.getUint32(40, true), 4);
      assert.deepEqual([...new Uint8Array(audio).slice(44)], [1, 0, 2, 0]);
      return 'Recovered complete speech.';
    },
  });
  await backend.ready; await backend.audio(new Uint8Array([1, 0]), 1);
  await publishFailure('voice-provider-failed');
  await backend.audio(new Uint8Array([2, 0]), 2);
  assert.equal(liveFrames, 1); assert.equal(fallbackCalls, 0);
  assert.equal(events[0]?.type, 'status');
  await backend.stop(); await backend.done;
  assert.equal(fallbackCalls, 1); assert.deepEqual(failures, []);
  assert.equal(events.at(-1)?.text, 'Recovered complete speech.');
  assert.equal(events.filter(event => event.type === 'final').length, 1);
});

for (const code of ['antigravity_transcription_authentication_required', 'qwenwork_transcription_refinement_timed_out']) h.test(`terminal speech failure never silently retransmits the recording: ${code}`, async () => {
  let fail!: (code: string) => Promise<void>, close!: () => void;
  const done = new Promise<void>(resolve => { close = resolve; });
  const failures: string[] = []; let fallbackCalls = 0;
  const backend = new RetainedSpeech({ signal: new AbortController().signal, onEvent: async () => {}, onFailure: async code => { failures.push(code); }, errorCode: () => 'voice-provider-failed',
    primary: (_event, failure) => { fail = failure; return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close }; },
    fallback: async () => { fallbackCalls++; return 'must not run'; },
  });
  await backend.ready; await backend.audio(new Uint8Array([1, 0]), 1);
  await fail(code); await backend.done;
  assert.equal(fallbackCalls, 0); assert.deepEqual(failures, [code]);
  if (code.startsWith('qwenwork')) assert.equal(voiceProviderError('qwenwork', new Error(code)), code);
});

for (const locale of ['zh-CN', 'en-US']) h.test(`native speech captures the current language hint: ${locale}`, async () => {
  const peer = new Peer();
  const access = voiceModelAccess({ providers: async () => ({}) }, async () => ({}), undefined,
    () => ({ generation: 1, client: peer }), undefined, () => locale);
  for (const source of ['claude', 'codex', 'trae']) {
    const backend = access.streaming!.create('language-' + source, source, new AbortController().signal, async () => {}, async () => {});
    await backend.ready;
    assert.equal(peer.calls.filter(call => call.method === 'engine/dictationStart').at(-1)?.params.language, source === 'claude' ? locale.slice(0, 2) : undefined);
    backend.close(); await backend.done;
  }
});

for (const source of ['claude', 'codex', 'workbuddy', 'antigravity', 'trae', 'qoder', 'qoderwork', 'qwenwork']) for (const scenario of ['same-account', 'changed-account', 'missing-generation']) {
  h.test(`retained audio recovery preserves the original account generation: ${source}, ${scenario}`, async () => {
    const peer = new Peer(), events: Row[] = [], failures: string[] = [];
    const recoveryRequests: Row[] = [];
    let locale = 'zh-CN';
    peer.requestWithTimeout = async (method, params) => {
      const value = params as Row; peer.calls.push({ method, params: value });
      if (method === 'engine/dictationStart') return scenario === 'missing-generation' ? {} : { credentialGeneration: 'original-account' };
      if (method === 'engine/dictationEnd') return { complete: true };
      if (method === `${source}/transcribeAudio`) {
        recoveryRequests.push(value);
        assert.equal(value.expectedCredentialGeneration, 'original-account');
        assert.equal(value.language, source === 'claude' ? 'zh' : undefined);
        if (scenario === 'changed-account') throw new Error(`${source}_credential_changed`);
        return { text: 'Complete recovered sentence.' };
      }
      return {};
    };
    const access = voiceModelAccess({ providers: async () => ({}) }, async () => { throw new Error('unbound request'); }, undefined, () => ({ generation: 1, client: peer }), undefined, () => locale);
    const backend = access.streaming!.create('retained-account', source, new AbortController().signal,
      async event => { events.push(event); }, async code => { failures.push(code); });
    await backend.ready; await backend.audio(new Uint8Array([1, 0]), 1);
    locale = 'en-US';
    peer.emit('event', { type: 'productEvent', method: 'engine/dictationEvent', params: { operationId: 'retained-account', seq: 1, type: 'error', code: `${source}_transport_failed` } });
    await waitFor(() => events.some(event => event.type === 'status'), 1000, 'degraded recording');
    await backend.stop(); await backend.done;
    assert.equal(recoveryRequests.length, scenario === 'missing-generation' ? 0 : 1);
    if (scenario === 'same-account') {
      assert.deepEqual(failures, []); assert.equal(events.at(-1)?.type, 'final');
    } else {
      assert.deepEqual(failures, [`${source}_credential_changed`]);
      assert.equal(events.some(event => event.type === 'final'), false);
    }
  });
}

void h.finish(join(root, 'result.json'), 'voice-streaming').then(code => { if (!code) rmSync(root, { recursive: true, force: true }); process.exitCode = code; });
