import { DesktopPetRealtime, type PetRealtimeDependencies } from '../main/pets/realtime';
import type { PetRealtimeOffer, PetVoiceEvent } from '../contracts/desktop-pet-voice';
import type { Json } from '../main/ipc/contract';
import { Harness, assert, assertEqual, waitFor } from './harness';
import { modelEntry, modelRow } from '../main/services/engine-settings';
import { projectEngineEvent } from '../main/ipc/project';

const h = new Harness();
h.test('confirmed spoken user messages use the ordinary attributed conversation envelope', () => {
  const events = projectEngineEvent({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'session', item: { id: 'realtime:request:item', type: 'user_message', status: 'completed', text: 'Confirmed spoken request' } } });
  assertEqual(events.length, 1, 'One confirmed transcript becomes one conversation item');
  const event = events[0] as any;
  assertEqual(event.type, 'user_message', 'Existing renderer message path receives the transcript');
  assertEqual(event.message.uuid, 'realtime:request:item', 'Provider-backed identity survives the projection');
  assertEqual(event.message.message.content[0].text, 'Confirmed spoken request', 'Spoken text retains the canonical nested envelope');
  for (const status of ['failed', 'cancelled', 'in_progress']) assertEqual(projectEngineEvent({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'session', item: { id: 'realtime:request:item', type: 'user_message', status, text: 'Unconfirmed speech' } } }).length, 0, 'Unconfirmed speech never becomes a durable visible user message');
});
h.test('realtime model settings retain explicit source configuration without guessing an audio model', async () => {
  const payload = { provider: 'openai', model: 'text-model', realtime: { model: 'explicit-audio-model', voice: 'chosen-voice', transcriptionModel: 'chosen-transcriber' } };
  const row = modelRow('source', modelEntry(payload));
  assertEqual(JSON.stringify(row.realtime), JSON.stringify(payload.realtime), 'Model round trip retains the configured audio fields');
  assertEqual(modelEntry({ provider: 'openai', model: 'text-model' }).realtime, undefined, 'Text models never infer audio capability');
  for (const realtime of [{ model: 'audio', transcriptionModel: 'asr', protocol: 'unknown' }, {}, { model: '' }, { model: 'audio' }, { model: 'audio', transcriptionModel: '' }, { model: 'bad\nmodel', transcriptionModel: 'asr' }, { model: 'audio', transcriptionModel: 'asr', endpoint: 'unreviewed' }] as Json[]) await rejected(() => modelEntry({ provider: 'openai', realtime }));
  assertEqual((modelRow('source', modelEntry({ provider: 'openai', realtime: { model: 'audio', transcriptionModel: 'asr', protocol: 'frameless' } })).realtime as Record<string, Json>).protocol, 'frameless', 'Explicit source protocol survives a settings round trip');
  await rejected(() => modelEntry({ provider: 'anthropic', realtime: { model: 'audio' } }));
});
const offer: PetRealtimeOffer = { requestId: 'request-one', offerSdp: 'v=0\r\ns=audio\r\n', microphoneMuted: false, speakerMuted: false };
function fixture() {
  const calls: Array<{ method: string; params: Record<string, Json> }> = [], events: PetVoiceEvent[] = [], availabilityRequests: Array<string | undefined> = [];
  let owned = true, visible = true, available = true;
  let start: (() => Promise<Json>) | undefined, stop: (() => Promise<Json>) | undefined;
  const deps: PetRealtimeDependencies = {
    owns: id => id === 7 && owned, visible: () => visible,
    availability: async (_ownerId, sessionId) => { availabilityRequests.push(sessionId); return { available, ...(!available ? { reason: 'The configured model does not support realtime audio.' } : {}) }; },
    prepare: async () => ({ sessionId: 'public-session', engineId: 'engine-session', modelProviderId: 'configured-source' }),
    request: async (method, params): Promise<Json> => { calls.push({ method, params }); return method === 'session/realtimeStart' ? start ? start() : { answerSdp: 'v=0\r\ns=answer\r\n', callId: 'rtc_actual' } : method === 'session/realtimeStop' ? stop ? stop() : {} : {}; },
    emit: (_id, event) => events.push(event),
  };
  return { host: new DesktopPetRealtime(deps), deps, calls, events, availabilityRequests, own: (value: boolean) => { owned = value; }, show: (value: boolean) => { visible = value; }, available: (value: boolean) => { available = value; }, start: (value: () => Promise<Json>) => { start = value; }, stop: (value: () => Promise<Json>) => { stop = value; } };
}
async function rejected(task: () => unknown | Promise<unknown>): Promise<void> { let failed = false; try { await task(); } catch { failed = true; } assert(failed, 'Operation must reject'); }

h.test('realtime availability comes from the selected source and never opens a substitute audio loop', async () => {
  const f = fixture(); f.available(false);
  assertEqual((await f.host.state(7)).available, false, 'Unsupported source is explicit');
  await rejected(() => f.host.negotiate(7, offer));
  assertEqual(f.calls.length, 0, 'No network or engine call starts when capability is missing');
  assertEqual(f.host.snapshot().phase, 'inactive', 'Failed negotiation releases its reservation');
  await f.host.close();
});
h.test('a completed voice call never pins availability to its previous conversation', async () => {
  const f = fixture();
  await f.host.state(7);
  const answer = await f.host.negotiate(7, { ...offer, targetSessionId: 'first-target' });
  await f.host.end(7, { requestId: offer.requestId, generation: answer.generation });
  await f.host.refreshAvailability();
  assertEqual(JSON.stringify(f.availabilityRequests), JSON.stringify([undefined, 'first-target', undefined]), 'Idle availability resolves the current composer target instead of retaining the ended call target');
  await f.host.close();
});
h.test('realtime ownership and offer validation precede every engine operation', async () => {
  const f = fixture();
  await rejected(() => f.host.negotiate(8, offer));
  await rejected(() => f.host.negotiate(7, { ...offer, offerSdp: 'not an SDP' }));
  f.show(false); await rejected(() => f.host.negotiate(7, offer));
  assertEqual(f.calls.length, 0, 'Invalid callers never create a session');
  await f.host.close();
});
h.test('negotiation awaits the engine sideband before releasing the input handshake', async () => {
  const f = fixture();
  let answer!: (value: Json) => void;
  f.start(() => new Promise(resolve => { answer = resolve; }));
  const pending = f.host.negotiate(7, offer);
  await waitFor(() => f.calls.length === 1, 1000, 'Actual named facade start was issued');
  assertEqual(f.host.snapshot().phase, 'connecting', 'Engine startup retains the connecting reservation');
  await rejected(() => f.host.control(7, { requestId: offer.requestId, generation: 1, action: 'connected' }));
  assertEqual(f.host.negotiate(7, offer), pending, 'Identical negotiation retries share one operation');
  await rejected(() => f.host.negotiate(7, { ...offer, offerSdp: 'v=0\r\ns=changed' }));
  answer({ answerSdp: 'v=0\r\ns=answer', callId: 'rtc_valid' });
  const result = await pending;
  assertEqual(result.sessionId, 'public-session', 'Renderer sees the public conversation identity');
  assertEqual(f.calls[0]!.params.sessionId, 'engine-session', 'Engine sees its own owned identity');
  const connecting = f.host.control(7, { requestId: offer.requestId, generation: result.generation, action: 'connected' });
  assertEqual(f.host.snapshot().phase, 'connecting', 'A peer alone cannot release the microphone');
  f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event: { type: 'started', callId: 'rtc_valid' } } });
  await connecting;
  assertEqual(f.host.snapshot().phase, 'active', 'Input opens only after engine and peer readiness');
  await f.host.close();
});
h.test('stop drains authoritative transcript tails before ending the owned call', async () => {
  const f = fixture(), result = await f.host.negotiate(7, offer);
  let finish!: () => void;
  f.stop(() => new Promise(resolve => { finish = () => resolve({}); }));
  const pending = f.host.end(7, { requestId: offer.requestId, generation: result.generation });
  assertEqual(f.host.snapshot().phase, 'stopping', 'Call stays reserved while finalization drains');
  f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event: { type: 'response.output_audio_transcript.done', item_id: 'spoken-one', transcript: 'The final spoken sentence.' } } });
  assertEqual(f.host.snapshot().transcript[0]!.text, 'The final spoken sentence.', 'Final engine sideband tail remains attributable during stop');
  finish(); await pending;
  assertEqual(f.host.snapshot().phase, 'inactive', 'Finalization releases the call');
  assert(f.host.snapshot().generation > result.generation, 'Terminal generation invalidates late renderer events');
  await rejected(() => f.host.control(7, { requestId: offer.requestId, generation: result.generation, action: 'microphone', muted: false }));
  await f.host.close();
});
h.test('late negotiation is stopped after cancellation without reviving a hidden owner', async () => {
  const f = fixture(); let answer!: (value: Json) => void;
  f.start(() => new Promise(resolve => { answer = resolve; }));
  const pending = f.host.negotiate(7, offer); const observed = pending.catch(() => null);
  await waitFor(() => f.calls.length === 1, 1000, 'Engine began negotiation');
  f.show(false); await f.host.release(7);
  answer({ answerSdp: 'v=0\r\ns=late', callId: 'rtc_late' });
  assertEqual(await observed, null, 'Cancelled negotiation rejects its late answer');
  assertEqual(f.host.snapshot().phase, 'inactive', 'Late answer never reopens the call');
  assert(f.calls.filter(value => value.method === 'session/realtimeStop').length >= 1, 'Engine cleanup is requested');
  await f.host.close();
});
h.test('failed provider finalization retains a retryable owned call instead of reporting success', async () => {
  const f = fixture(), result = await f.host.negotiate(7, offer);
  let attempts = 0; f.stop(async () => { if (++attempts === 1) throw new Error('The provider did not confirm hangup'); return {}; });
  await rejected(() => f.host.end(7, { requestId: offer.requestId, generation: result.generation }));
  assertEqual(f.host.snapshot().phase, 'stopping', 'A failed hangup never reports inactive success');
  assert(f.host.reserved(), 'Unfinalized call blocks overlapping audio ownership');
  await f.host.end(7, { requestId: offer.requestId, generation: result.generation });
  assertEqual(attempts, 2, 'Retry uses the retained provider call identity');
  assertEqual(f.host.snapshot().phase, 'inactive', 'Confirmed finalization releases ownership');
  await f.host.close();
});
h.test('owned engine captions ignore unrelated sessions and raw audio does not broadcast unchanged state', async () => {
  const f = fixture(), result = await f.host.negotiate(7, offer);
  const send = (id: string) => f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event: { type: 'response.output_audio.delta', delta: id } } });
  send('first'); const count = f.events.length;
  for (let index = 0; index < 1000; index++) send(String(index));
  assertEqual(f.events.length, count, 'Repeated audio fragments perform no state publications');
  f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'other-engine-session', requestId: offer.requestId, event: { type: 'response.output_text.done', item_id: 'wrong', text: 'Wrong session' } } });
  assertEqual(f.host.snapshot().transcript.length, 0, 'Unrelated engine sessions cannot mutate this call');
  await f.host.close();
});
h.test('manual interruption uses its named audio control and retains user mute preferences across calls', async () => {
  const f = fixture(), result = await f.host.negotiate(7, offer);
  await f.host.control(7, { requestId: offer.requestId, generation: result.generation, action: 'microphone', muted: true });
  await f.host.control(7, { requestId: offer.requestId, generation: result.generation, action: 'speaker', muted: true });
  await f.host.control(7, { requestId: offer.requestId, generation: result.generation, action: 'interrupt' });
  assert(f.calls.some(value => value.method === 'session/realtimeInterrupt'), 'Manual interrupt reaches its dedicated facade method');
  await f.host.end(7, { requestId: offer.requestId, generation: result.generation });
  assert(f.host.snapshot().microphoneMuted && f.host.snapshot().speakerMuted, 'Stop retains mute preferences');
  await f.host.close();
});

h.test('source capabilities bind protocol, voice and engine-owned captions to one call', async () => {
  const f = fixture();
  f.deps.availability = async () => ({ available: true, sourceId: 'subscription:codex', protocol: 'v1', transcriptSource: 'engine', voices: ['cove', 'ember'], defaultVoice: 'cove', voice: 'ember' });
  f.deps.prepare = async (_owner, _target, _signal, source) => ({ sessionId: 'public-session', engineId: 'engine-session', authMode: 'codex', protocol: source.protocol, transcriptSource: source.transcriptSource, voice: source.voice });
  f.start(async () => ({ answerSdp: 'v=0\r\ns=answer', callId: 'rtc_hosted', protocol: 'v1', transcriptSource: 'engine' }));
  const result = await f.host.negotiate(7, offer);
  const params = f.calls[0]!.params;
  assertEqual(params.authMode, 'codex', 'Subscription uses its named authentication source');
  assertEqual(params.modelProviderId, undefined, 'A same-named custom provider cannot shadow subscription authentication');
  assertEqual(params.voice, 'ember', 'Selected advertised voice reaches the engine');
  assertEqual(params.protocol, 'v1', 'Source protocol reaches the engine');
  assertEqual(result.transcriptSource, 'engine', 'The media client receives authoritative caption ownership');
  const emit = (event: Json): void => f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event } });
  emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken', delta: 'Hello' });
  emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken', delta: ' there' });
  assertEqual(f.host.snapshot().transcript[0]!.text, 'Hello there', 'Canonical source deltas accumulate by item identity');
  emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'spoken', transcript: 'Hello, there.' });
  emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken', delta: ' stale' });
  assertEqual(f.host.snapshot().transcript[0]!.text, 'Hello, there.', 'Final source correction retires partial updates');
  for (let i = 0; i < 301; i++) emit({ type: 'response.output_audio_transcript.done', item_id: 'answer-' + i, transcript: 'Answer ' + i });
  emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken', delta: ' late' });
  assertEqual(f.host.snapshot().transcript.length, 300, 'Text retention stays bounded');
  assert(!f.host.snapshot().transcript.some(item => item.id === 'spoken'), 'Evicted final identities cannot reopen from late partial packets');
  await f.host.close();
});
h.test('an older availability result cannot overwrite a newly selected source', async () => {
  const f = fixture();
  let first!: (value: { available: boolean; sourceId: string }) => void;
  f.deps.availability = async () => new Promise(resolve => { first = resolve; });
  const previous = f.host.state(7);
  f.deps.availability = async () => ({ available: true, sourceId: 'new-source', protocol: 'public', transcriptSource: 'peer' });
  await f.host.state(7);
  first({ available: false, sourceId: 'old-source' }); await previous;
  assertEqual(f.host.snapshot().sourceId, 'new-source', 'Latest source receipt owns idle state');
  assertEqual(f.host.snapshot().available, true, 'Older unsupported source cannot disable the newer source');
  await f.host.close();
});

h.test('owned queued tasks keep interruption available until their matching terminal result', async () => {
  const f = fixture(); await f.host.negotiate(7, offer);
  const emit = (event: Json): void => f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event } });
  emit({ type: 'task.queued', handoffId: 'a', turnId: 'turn-a', owned: true });
  emit({ type: 'task.started', handoffId: 'b', turnId: 'turn-b', owned: false });
  emit({ type: 'response.done' });
  assertEqual(f.host.snapshot().activity, 'thinking', 'Provider audio completion cannot conceal an admitted ordinary task');
  emit({ type: 'input_audio_buffer.speech_started' });
  assertEqual(f.host.snapshot().activity, 'thinking', 'New speech leaves the active task interruption control available');
  emit({ type: 'task.event', handoffId: 'a', turnId: 'stale-turn', event: { result: { status: 'completed' } } });
  emit({ type: 'task.event', handoffId: 'b', turnId: 'turn-b', event: { result: { status: 'completed' } } });
  assertEqual(f.host.snapshot().activity, 'thinking', 'A stale receipt cannot retire another active task');
  emit({ type: 'task.event', handoffId: 'a', turnId: 'turn-a', event: { result: { status: 'completed' } } });
  assertEqual(f.host.snapshot().activity, 'listening', 'The last matching terminal result restores input activity');
  await f.host.close();
});

h.test('hosted task interruption cannot act on a borrowed foreground task', async () => {
  const f = fixture();
  f.start(async () => ({ answerSdp: 'v=0\r\ns=answer', callId: 'rtc_hosted', protocol: 'v1', transcriptSource: 'engine' }));
  const answer = await f.host.negotiate(7, offer);
  const emit = (event: Json): void => f.host.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine-session', requestId: offer.requestId, event } });
  emit({ type: 'task.started', handoffId: 'borrowed', turnId: 'typed-turn', owned: false });
  assertEqual(f.host.snapshot().canInterrupt, false, 'Typed work remains outside voice cancellation ownership');
  await rejected(() => f.host.control(7, { requestId: offer.requestId, generation: answer.generation, action: 'interrupt' }));
  assert(!f.calls.some(call => call.method === 'session/realtimeInterrupt'), 'Unavailable action never reaches the cancellation facade');
  const publications = f.events.length;
  emit({ type: 'task.queued', handoffId: 'owned', turnId: 'voice-turn', owned: true });
  assertEqual(f.host.snapshot().canInterrupt, true, 'Actual admitted voice work enables task cancellation');
  assert(f.events.length > publications, 'Ownership changes publish even while activity remains thinking');
  await f.host.control(7, { requestId: offer.requestId, generation: answer.generation, action: 'interrupt' });
  assert(f.calls.some(call => call.method === 'session/realtimeInterrupt'), 'Owned cancellation uses its real named facade');
  emit({ type: 'task.superseded', handoffId: 'owned', turnId: 'voice-turn', replacementHandoffId: 'borrowed' });
  assertEqual(f.host.snapshot().canInterrupt, false, 'Superseding a handoff retires only its cancellation ownership');
  assertEqual(f.host.snapshot().activity, 'thinking', 'Borrowed work continues with truthful task activity');
  await f.host.close();
});
void h.finish('result.json', 'desktop-pet-realtime').then(code => { process.exitCode = code; });
