import { describe, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { PetLiveVoiceState, PetRealtimeAnswer, PetRealtimeOffer } from '../../../contracts/desktop-pet-voice';
import { PetRealtimeClient, type RealtimeVoiceOptions } from './realtime-client';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = (patch: Partial<PetLiveVoiceState> = {}): PetLiveVoiceState => ({ transport: 'webrtc', protocol: 'public', transcriptSource: 'peer', available: true, phase: 'inactive', microphoneMuted: false, speakerMuted: false, generation: 0, activity: 'inactive', transcript: [], ...patch });
function fixture(patch: Partial<RealtimeVoiceOptions> = {}) {
  const calls = { offers: [] as PetRealtimeOffer[], ends: [] as Array<{ requestId: string; generation?: number }>, controls: [] as unknown[], states: [] as PetLiveVoiceState[], errors: [] as Error[], media: 0, stopped: 0, closed: 0, played: 0, sent: [] as string[] };
  let current = state();
  const track = { enabled: true, onended: null as (() => void) | null, stop: () => { calls.stopped++; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const channel = { readyState: 'connecting', onopen: null as (() => void) | null, onmessage: null as ((event: { data: string }) => void) | null, onclose: null as (() => void) | null, onerror: null as (() => void) | null, close() { this.readyState = 'closed'; }, send: (message: string) => calls.sent.push(message) };
  const sender = { replaceTrack: async (_track: unknown) => {} };
  const peer = { connectionState: 'new', onconnectionstatechange: null as (() => void) | null, ontrack: null as unknown, createDataChannel: () => channel, addTrack: () => sender, createOffer: async () => ({ type: 'offer', sdp: 'offer-sdp' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() { calls.closed++; this.connectionState = 'closed'; } };
  const audio = { autoplay: false, hidden: false, muted: false, srcObject: null, play: async () => { calls.played++; }, pause: () => {}, removeAttribute: () => {} };
  const options: RealtimeVoiceOptions = {
    transport: {
      state: async () => current,
      negotiate: async value => { calls.offers.push(value); current = state({ phase: 'connecting', generation: 1, sessionId: 'voice-thread' }); return { requestId: value.requestId, generation: 1, sessionId: 'voice-thread', answerSdp: 'answer-sdp' }; },
      end: async value => { calls.ends.push(value); current = { ...current, phase: 'inactive', generation: current.generation + 1, activity: 'inactive' }; return current; },
      control: async value => { calls.controls.push(value); current = { ...current, ...(value.action === 'connected' ? { phase: 'active' as const, activity: 'listening' as const } : {}), ...(value.action === 'microphone' ? { microphoneMuted: value.muted ?? false } : {}), ...(value.action === 'speaker' ? { speakerMuted: value.muted ?? false } : {}) }; return current; },
    },
    state: value => calls.states.push(value), error: value => calls.errors.push(value), media: async () => { calls.media++; return stream; }, peer: () => peer as unknown as RTCPeerConnection, audio: () => audio as unknown as HTMLAudioElement, id: () => 'request-one', ...patch,
  };
  const client = new PetRealtimeClient(options);
  const connect = async () => { peer.connectionState = 'connected'; peer.onconnectionstatechange?.(); channel.readyState = 'open'; channel.onopen?.(); await tick(); };
  return { client, options, calls, track, stream, peer, sender, channel, audio, connect, setState: (value: PetLiveVoiceState) => { current = value; } };
}

describe('realtime voice resource ownership', () => {
  test('a main conversation resolved by capability preflight is pinned into negotiation', async () => {
    const row = fixture(); row.setState(state({ targetSessionId: 'visible-main-conversation' }));
    await row.client.start();
    expect(row.calls.offers[0].targetSessionId).toBe('visible-main-conversation');
    await row.client.dispose();
  });
  test('holds input until peer and event channel are ready and host initialization is acknowledged', async () => {
    const row = fixture(); await row.client.start('selected-thread'); expect(row.track.enabled).toBe(false); expect(row.calls.offers[0].targetSessionId).toBe('selected-thread');
    row.peer.connectionState = 'connected'; row.peer.onconnectionstatechange?.(); await tick(); expect(row.track.enabled).toBe(false);
    row.channel.readyState = 'open'; row.channel.onopen?.(); await tick(); expect(row.track.enabled).toBe(true); expect(row.client.snapshot().phase).toBe('active');
    await row.client.dispose(); expect(row.track.enabled).toBe(false); expect(row.calls.stopped).toBe(1); expect(row.calls.closed).toBe(1); expect(row.calls.ends).toEqual([{ requestId: 'request-one', generation: 1 }]);
  });
  test('one concurrent start owns one microphone and one negotiated call', async () => {
    const row = fixture(); const first = row.client.start(), second = row.client.start(); expect(first).toBe(second); await first; expect(row.calls.media).toBe(1); expect(row.calls.offers).toHaveLength(1); await row.client.dispose();
  });
  test('starting an active call preserves its owner and continues processing events', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); await row.client.start();
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'active', delta: 'Still connected' }) }); await tick();
    expect(row.calls.media).toBe(1); expect(row.calls.offers.length).toBe(1); expect(row.client.snapshot().transcript[0].text).toBe('Still connected'); await row.client.dispose();
  });
  test('an active call cannot be retargeted by a different or empty text selection', async () => {
    const row = fixture(); await row.client.start('original-text-target'); await row.connect();
    await row.client.start('different-text-target'); await row.client.start(undefined);
    expect(row.calls.offers).toHaveLength(1); expect(row.calls.offers[0].targetSessionId).toBe('original-text-target');
    expect(row.client.snapshot().sessionId).toBe('voice-thread'); expect(row.calls.ends).toHaveLength(0);
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'owned', delta: 'Still in the voice conversation' }) });
    expect(row.client.snapshot().transcript[0].text).toBe('Still in the voice conversation'); await row.client.dispose();
  });
  test('stop while microphone permission is pending closes the late stream without negotiating', async () => {
    const media = deferred<MediaStream>(), row = fixture({ media: () => media.promise }); const starting = row.client.start(); await tick(); await row.client.stop(); media.resolve(row.stream); await starting;
    expect(row.calls.stopped).toBe(1); expect(row.calls.offers).toHaveLength(0); expect(row.client.snapshot().phase).toBe('inactive');
  });
  test('stop while SDP is pending closes local resources and retires the late server answer', async () => {
    const row = fixture(), pending = deferred<PetRealtimeAnswer>(); row.options.transport.negotiate = async value => { row.calls.offers.push(value); return pending.promise; };
    const starting = row.client.start(); await tick(); await row.client.stop(); pending.resolve({ requestId: 'request-one', generation: 1, sessionId: 'thread', answerSdp: 'answer' }); await starting;
    expect(row.calls.stopped).toBe(1); expect(row.calls.closed).toBe(1); expect(row.calls.ends).toEqual([{ requestId: 'request-one' }, { requestId: 'request-one', generation: 1 }]);
  });
  test('cancelling a pending microphone request allows an immediate independent retry', async () => {
    const pending = deferred<MediaStream>(), row = fixture();
    let acquisition = 0, staleStopped = 0;
    const stale = { getTracks: () => [{ stop: () => { staleStopped++; } }] } as unknown as MediaStream;
    row.options.media = () => ++acquisition === 1 ? pending.promise : Promise.resolve(row.stream);
    const first = row.client.start(); await tick(); await row.client.stop();
    const retry = row.client.start(); expect(retry).not.toBe(first); await retry; await row.connect();
    expect(acquisition).toBe(2); expect(row.client.snapshot().phase).toBe('active');
    pending.resolve(stale); await first;
    expect(staleStopped).toBe(1); expect(row.calls.offers).toHaveLength(1);
    expect(row.client.snapshot().phase).toBe('active'); await row.client.dispose();
  });
  test('a cancelled capability preflight cannot overwrite a restarted call', async () => {
    const pending = deferred<PetLiveVoiceState>(), row = fixture();
    const original = row.options.transport.state;
    let preflight = 0;
    row.options.transport.state = () => ++preflight === 1 ? pending.promise : original();
    const first = row.client.start(); await tick(); await row.client.stop();
    await row.client.start(); await row.connect();
    pending.resolve(state({ generation: 99, available: false })); await first;
    expect(row.client.snapshot().phase).toBe('active'); expect(row.client.snapshot().generation).toBe(1);
    expect(row.track.enabled).toBe(true); await row.client.dispose();
  });
  test('unsupported source refuses microphone access and does not invoke the speech loop', async () => {
    const row = fixture(); row.setState(state({ transport: undefined, available: false, unavailableReason: 'This source has no realtime voice API' })); await rejects(row.client.start(), /no realtime/); expect(row.calls.media).toBe(0); expect(row.calls.offers).toHaveLength(0); await row.client.dispose();
  });
  test('malformed session answer closes peer, channel and microphone', async () => {
    const row = fixture(); row.options.transport.negotiate = async () => ({ requestId: 'wrong', generation: 1, sessionId: 'thread', answerSdp: 'answer' }); await rejects(row.client.start(), /invalid session answer/); expect(row.calls.stopped).toBe(1); expect(row.calls.closed).toBe(1); expect(row.client.snapshot().phase).toBe('inactive');
  });
  test('microphone and speaker mute immediately affect local resources and retain host state', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); await row.client.microphone(true); expect(row.track.enabled).toBe(false); await row.client.speaker(true); expect(row.audio.muted).toBe(true); await row.client.microphone(false); expect(row.track.enabled).toBe(true); await row.client.dispose();
  });
  test('failed mute persistence restores the prior local mute value', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); row.options.transport.control = async () => { throw new Error('No active reservation'); }; await rejects(row.client.microphone(true), /No active/); expect(row.track.enabled).toBe(true); await row.client.dispose();
  });
  test('provider transcripts update one bubble and final content replaces partial text', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    for (const event of [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-one', transcript: 'Hello' }, { type: 'response.output_audio_transcript.delta', item_id: 'assistant-one', response_id: 'response-one', delta: 'Hi' }, { type: 'response.output_audio_transcript.delta', item_id: 'assistant-one', response_id: 'response-one', delta: ' there' }, { type: 'response.output_audio_transcript.done', item_id: 'assistant-one', transcript: 'Hi there!' }]) row.channel.onmessage?.({ data: JSON.stringify(event) });
    await tick(); expect(row.client.snapshot().transcript.map(item => [item.id, item.text, item.final])).toEqual([['user-one', 'Hello', true], ['assistant-one', 'Hi there!', true]]); await row.client.dispose();
  });
  test('provider tool frames stay on the engine sideband and interruption clears buffered audio before host cancellation', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-one', name: 'delegate_task', arguments: '{"prompt":"Help"}' }) }); await tick();
    expect(row.calls.sent).toHaveLength(0); await row.client.interrupt(); expect(JSON.parse(row.calls.sent[0]).type).toBe('output_audio_buffer.clear'); expect(row.calls.controls.at(-1)).toMatchObject({ action: 'interrupt' }); await row.client.dispose();
  });
  test('hosted interruption cancels only owned work and sends no invented playback frame', async () => {
    const row = fixture(); row.setState(state({ protocol: 'frameless', transcriptSource: 'engine', canInterrupt: true }));
    await row.client.start(); await row.connect(); row.client.applyState(state({ phase: 'active', generation: 1, sessionId: 'voice-thread', protocol: 'frameless', transcriptSource: 'engine', canInterrupt: true }));
    await row.client.interrupt(); expect(row.calls.sent).toEqual([]); expect(row.calls.controls.at(-1)).toEqual({ requestId: 'request-one', generation: 1, action: 'interrupt' });
    const count = row.calls.controls.length;
    row.client.applyState(state({ phase: 'active', generation: 1, sessionId: 'voice-thread', protocol: 'frameless', transcriptSource: 'engine', canInterrupt: false }));
    await row.client.interrupt(); expect(row.calls.controls.length).toBe(count); expect(row.calls.sent).toEqual([]); await row.client.dispose();
  });
  test('raw audio and unrelated events do not republish unchanged captions while visible deltas remain live', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); const before = row.calls.states.length;
    for (let index = 0; index < 1000; index++) row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_audio.delta', delta: String(index) }) });
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'rate_limits.updated', rate_limits: [] }) });
    expect(row.calls.states.length - before).toBe(1); expect(row.calls.sent).toHaveLength(0);
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'caption', delta: 'Live' }) });
    expect(row.calls.states.at(-1)?.transcript[0].text).toBe('Live');
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'caption', delta: ' caption' }) });
    expect(row.calls.states.at(-1)?.transcript[0].text).toBe('Live caption');
    const final = JSON.stringify({ type: 'response.output_text.done', item_id: 'caption', text: 'Live caption' }); row.channel.onmessage?.({ data: final }); const count = row.calls.states.length;
    row.channel.onmessage?.({ data: final }); expect(row.calls.states.length).toBe(count); expect(row.client.snapshot().transcript[0].final).toBe(true); await row.client.dispose();
  });
  test('event-channel closure terminates the owned peer and ignores late events', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); const receive = row.channel.onmessage; row.channel.onclose?.(); await tick(); receive?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'late', delta: 'Late' }) }); expect(row.calls.stopped).toBe(1); expect(row.client.snapshot().transcript).toEqual([]); expect(row.calls.errors[0].message).toContain('channel closed');
  });
  test('normal stop holds transport for transcript tail flush, then disposes after the host acknowledgement', async () => {
    const row = fixture(), pending = deferred<PetLiveVoiceState>(); await row.client.start(); await row.connect(); row.options.transport.end = () => pending.promise;
    const stopping = row.client.stop(); expect(row.track.enabled).toBe(false); expect(row.calls.closed).toBe(0); expect(row.calls.stopped).toBe(0);
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'tail', transcript: 'Final tail' }) }); await tick();
    expect(row.client.snapshot().transcript.at(-1)?.text).toBe('Final tail');
    pending.resolve(state({ generation: 2 })); await stopping; expect(row.calls.closed).toBe(1); expect(row.calls.stopped).toBe(1); expect(row.client.snapshot().transcript.at(-1)?.text).toBe('Final tail');
  });
  test('failed remote stop retains an end receipt and retries without reopening the microphone', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); const end = row.options.transport.end; let attempts = 0;
    row.options.transport.end = async value => { attempts++; if (attempts === 1) throw new Error('Remote hangup failed'); return end(value); };
    await rejects(row.client.stop(), /hangup failed/); expect(row.client.snapshot().phase).toBe('stopping'); expect(row.track.enabled).toBe(false); expect(row.calls.closed).toBe(1);
    await row.client.stop(); expect(attempts).toBe(2); expect(row.calls.media).toBe(1); expect(row.calls.stopped).toBe(1); expect(row.client.snapshot().phase).toBe('inactive');
  });
  test('microphone replacement keeps the live peer and honors the muted state', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); await row.client.microphone(true); let replaced = 0, stopped = 0;
    const track = { enabled: true, onended: null, stop: () => { stopped++; } };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    row.options.media = async () => stream; row.sender.replaceTrack = async next => { expect(next).toBe(track); replaced++; };
    row.track.onended?.(); await tick(); expect(replaced).toBe(1); expect(row.track.onended).toBe(null); expect(row.calls.stopped).toBe(1); expect(track.enabled).toBe(false); expect(row.calls.closed).toBe(0);
    await row.client.microphone(false); expect(track.enabled).toBe(true); await row.client.dispose(); expect(stopped).toBe(1);
  });
  test('microphone replacement failure retains the current input and reports the failure', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); let stopped = 0;
    const track = { enabled: true, stop: () => { stopped++; } }, stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    row.options.media = async () => stream; row.sender.replaceTrack = async () => { throw new Error('Input replacement failed'); };
    row.track.onended?.(); await tick(); expect(stopped).toBe(1); expect(row.calls.stopped).toBe(0); expect(row.calls.closed).toBe(0); expect(row.client.snapshot().error).toBe('Input replacement failed'); expect(row.track.enabled).toBe(true); await row.client.dispose();
  });
  test('a replacement microphone arriving after cancellation is stopped without replacing a closed peer', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); let stopped = 0, replaced = 0;
    const media = deferred<MediaStream>(), track = { enabled: true, stop: () => { stopped++; } }, stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    row.options.media = () => media.promise; row.sender.replaceTrack = async () => { replaced++; }; row.track.onended?.(); await tick(); await row.client.stop(); media.resolve(stream); await tick();
    expect(replaced).toBe(0); expect(stopped).toBe(1); expect(row.calls.closed).toBe(1);
  });
  test('simultaneous input refresh requests share one acquisition', async () => {
    const row = fixture(); await row.client.start(); await row.connect(); let acquired = 0;
    const media = deferred<MediaStream>(), track = { enabled: true, onended: null, stop: () => {} }, stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    row.options.media = () => { acquired++; return media.promise; }; row.track.onended?.(); row.track.onended?.(); expect(acquired).toBe(1); media.resolve(stream); await tick(); await row.client.dispose();
  });
  test('host-only transcript tail survives transport closure and replaces the partial caption by stable identity', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'shared', delta: 'Partial' }) });
    row.channel.readyState = 'closed'; row.options.transport.end = async () => state({ generation: 2, sessionId: 'voice-thread', transcript: [{ id: 'shared', role: 'assistant', text: 'Confirmed full answer', final: true }, { id: 'tail', role: 'assistant', text: 'Host-only final tail', final: true }] });
    await row.client.stop();
    expect(row.client.snapshot().transcript.map(item => [item.id, item.text, item.final])).toEqual([['shared', 'Confirmed full answer', true], ['tail', 'Host-only final tail', true]]);
    expect(row.calls.closed).toBe(1); expect(row.calls.stopped).toBe(1);
  });
  test('an authoritative host final wins over late data channel partials and finals while new captions remain live', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'shared', delta: 'Partial' }) });
    row.client.applyState(state({ phase: 'active', activity: 'listening', generation: 1, sessionId: 'voice-thread', transcript: [{ id: 'shared', role: 'assistant', text: 'Confirmed answer', final: true }] })); const count = row.calls.states.length;
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'shared', delta: ' late' }) });
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.done', item_id: 'shared', text: 'Stale conflicting final' }) });
    expect(row.client.snapshot().transcript.map(item => [item.id, item.text, item.final])).toEqual([['shared', 'Confirmed answer', true]]); expect(row.calls.states.length).toBe(count); expect(row.client.snapshot().activity).toBe('listening');
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'next', delta: 'Next live' }) });
    expect(row.client.snapshot().transcript.at(-1)?.text).toBe('Next live'); expect(row.client.snapshot().transcript.at(-1)?.final).toBe(false); await row.client.dispose();
  });
  test('host snapshots retain an advanced local caption until the authoritative final arrives', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'shared', delta: 'Live caption ahead' }) });
    row.client.applyState(state({ phase: 'active', generation: 1, sessionId: 'voice-thread', transcript: [{ id: 'shared', role: 'assistant', text: 'Live', final: false }] }));
    expect(row.client.snapshot().transcript[0].text).toBe('Live caption ahead'); expect(row.client.snapshot().transcript[0].final).toBe(false); await row.client.dispose();
  });
  test('the visible transcript stays bounded and an evicted finalized item cannot reappear as a late partial', async () => {
    const row = fixture(); await row.client.start(); await row.connect();
    row.client.applyState(state({ phase: 'active', generation: 1, sessionId: 'voice-thread', transcript: Array.from({ length: 350 }, (_, index) => ({ id: `item-${index}`, role: 'assistant' as const, text: `Answer ${index}`, final: true })) }));
    expect(row.client.snapshot().transcript.length).toBe(300); expect(row.client.snapshot().transcript[0].id).toBe('item-50');
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'item-0', delta: 'Late old partial' }) });
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'fresh', delta: 'Fresh caption' }) });
    expect(row.client.snapshot().transcript.length).toBe(300); expect(row.client.snapshot().transcript.some(item => item.id === 'item-0')).toBe(false); expect(row.client.snapshot().transcript.at(-1)?.id).toBe('fresh'); await row.client.dispose();
  });

  test('engine transcript mode uses authoritative streaming captions and ignores peer duplicates and activity', async () => {
    const row = fixture(); row.setState(state({ protocol: 'frameless', transcriptSource: 'engine', sourceId: 'subscription:codex' })); await row.client.start(); await row.connect(); const count = row.calls.states.length;
    for (const event of [{ type: 'input_audio_buffer.speech_started' }, { type: 'response.created', response: { id: 'peer-response' } }, { type: 'response.output_audio.delta', delta: 'audio' }, { type: 'response.output_text.delta', item_id: 'caption', delta: 'Untrusted peer caption' }, { type: 'response.output_text.done', item_id: 'caption', text: 'Untrusted peer final' }]) row.channel.onmessage?.({ data: JSON.stringify(event) });
    expect(row.calls.states.length).toBe(count); expect(row.client.snapshot().transcript).toEqual([]);
    row.client.applyState(state({ phase: 'active', activity: 'speaking', generation: 1, sessionId: 'voice-thread', protocol: 'frameless', transcriptSource: 'engine', transcript: [{ id: 'caption', role: 'assistant', text: 'I want', final: false }] })); expect(row.client.snapshot().transcript[0].text).toBe('I want');
    row.client.applyState(state({ phase: 'active', activity: 'speaking', generation: 1, sessionId: 'voice-thread', protocol: 'frameless', transcriptSource: 'engine', transcript: [{ id: 'caption', role: 'assistant', text: 'I will help', final: false }] })); expect(row.client.snapshot().transcript[0].text).toBe('I will help');
    row.client.applyState(state({ phase: 'active', activity: 'listening', generation: 1, sessionId: 'voice-thread', protocol: 'frameless', transcriptSource: 'engine', transcript: [{ id: 'caption', role: 'assistant', text: 'I will help.', final: true }] }));
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'caption', delta: ' duplicate' }) });
    expect(row.client.snapshot().transcript.map(item => [item.id, item.text, item.final])).toEqual([['caption', 'I will help.', true]]); expect(row.client.snapshot().activity).toBe('listening'); expect(row.track.enabled).toBe(true); await row.client.dispose();
  });
  test('the negotiated protocol receipt selects caption ownership before peer events arrive', async () => {
    const row = fixture(); row.options.transport.negotiate = async value => ({ requestId: value.requestId, generation: 1, sessionId: 'voice-thread', answerSdp: 'answer-sdp', protocol: 'v1', transcriptSource: 'engine' });
    await row.client.start(); await row.connect(); expect(row.client.snapshot().protocol).toBe('v1'); expect(row.client.snapshot().transcriptSource).toBe('engine');
    row.channel.onmessage?.({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'peer', transcript: 'Peer copy' }) }); expect(row.client.snapshot().transcript.length).toBe(0); await row.client.dispose();
  });

});

describe('engine-mediated websocket voice', () => {
  const websocketFixture = () => {
    const row = fixture();
    row.setState(state({ transport: 'websocket', protocol: 'qoder', transcriptSource: 'engine' }));
    row.options.transport.negotiate = async value => { row.calls.offers.push(value); return { requestId: value.requestId, generation: 1, sessionId: 'voice-thread' }; };
    return row;
  };
  test('a websocket line negotiates without SDP and stays active without a peer connection', async () => {
    const row = websocketFixture();
    const frames: unknown[] = [];
    row.options.transport.appendAudio = async value => { frames.push(value); return null; };
    await row.client.start('selected-thread');
    expect(row.calls.offers[0].offerSdp).toBe(undefined);
    expect(row.calls.offers[0].targetSessionId).toBe('selected-thread');
    expect(row.calls.closed).toBe(0);
    expect(row.client.snapshot().phase).toBe('active');
    expect(row.client.snapshot().transport).toBe('websocket');
    expect(row.calls.controls.some(control => (control as { action?: string }).action === 'connected')).toBe(true);
    expect(row.track.enabled).toBe(true);
    // The test environment has no AudioContext, so the capture pipeline stays idle.
    expect(frames.length).toBe(0);
    row.client.audio({ generation: 1, audio: 'AAA=' });
    row.client.audio({ generation: 2, audio: 'AAA=' });
    await row.client.dispose();
    expect(row.calls.stopped).toBe(1);
    expect(row.calls.ends).toEqual([{ requestId: 'request-one', generation: 1 }]);
  });
  test('a websocket line can interrupt without an owned task', async () => {
    const row = websocketFixture();
    await row.client.start();
    await row.client.interrupt();
    expect(row.calls.controls.some(control => (control as { action?: string }).action === 'interrupt')).toBe(true);
    await row.client.dispose();
  });
});
