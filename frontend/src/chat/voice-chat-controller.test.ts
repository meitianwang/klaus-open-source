import { describe, expect, test } from 'bun:test';
import type { VoiceChatEvent, VoiceChatState } from '../../../contracts/voice-chat';
import { VoiceChatController, type VoiceChatTransport } from './voice-chat-controller';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const state = (patch: Partial<VoiceChatState> = {}): VoiceChatState => ({ transport: 'webrtc', protocol: 'public', transcriptSource: 'peer', available: true, phase: 'inactive', generation: 0, microphoneMuted: false, speakerMuted: false, activity: 'inactive', transcript: [], ...patch });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let current = state(), sessionId: string | null = 'thread-one', event!: (value: VoiceChatEvent) => void;
  let ensured = 0;
  const offers: unknown[] = [], ends: unknown[] = [], controls: unknown[] = [], queries: unknown[] = [];
  let stopped = 0;
  const track = { enabled: false, stop() { stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const channel = { readyState: 'open', onopen: null as (() => void) | null, close() {}, send() {} };
  const peer = { connectionState: 'new', onconnectionstatechange: null as (() => void) | null, createDataChannel: () => channel, addTrack: () => ({}), createOffer: async () => ({ sdp: 'v=0' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const transport: VoiceChatTransport = {
    onEvent: listener => { event = listener; return () => {}; },
    state: async id => { queries.push(id); return current; },
    negotiate: async offer => { offers.push(offer); current = state({ phase: 'connecting', generation: 1, sessionId: offer.targetSessionId }); return { requestId: offer.requestId, answerSdp: 'v=0', sessionId: offer.targetSessionId!, generation: 1 }; },
    end: async value => { ends.push(value); current = state({ generation: 2 }); return current; },
    control: async value => { controls.push(value); current = { ...current, ...(value.action === 'connected' ? { phase: 'active' as const, activity: 'listening' as const } : {}), ...(value.action === 'microphone' ? { microphoneMuted: value.muted! } : {}), ...(value.action === 'speaker' ? { speakerMuted: value.muted! } : {}) }; return current; },
  };
  const controller = new VoiceChatController({ transport, currentSession: () => sessionId, ensureSession: async () => { ensured++; return sessionId; }, client: { media: async () => stream, peer: () => peer as unknown as RTCPeerConnection, audio: () => ({ pause() {}, removeAttribute() {} }) as unknown as HTMLAudioElement, id: () => 'test-request' } });
  return { controller, transport, offers, ends, controls, queries, track, stopped: () => stopped, ensured: () => ensured, stream, select: (id: string | null) => { sessionId = id; }, emit: (value: VoiceChatState) => { current = value; event({ type: 'state', generation: value.generation, state: value }); }, connect: async () => { peer.connectionState = 'connected'; peer.onconnectionstatechange?.(); channel.onopen?.(); await tick(); } };
}

describe('main voice conversation lifecycle', () => {
  test('an explicit side target shares the call without borrowing the main conversation', async () => {
    const f = fixture();
    await f.controller.start('side-thread'); await f.connect();
    expect(f.controller.snapshot().targetSessionId).toBe('side-thread');
    expect(f.queries).toEqual(['side-thread']); expect(f.ensured()).toBe(0);
    await f.controller.start('thread-one'); expect(f.offers).toHaveLength(1);
    await f.controller.stopForSession('thread-one');
    expect(f.ends).toHaveLength(0); expect(f.controller.snapshot().open).toBe(true);
    await f.controller.stopForSession('side-thread');
    expect(f.ends).toHaveLength(1); expect(f.controller.snapshot().open).toBe(false);
    await f.controller.dispose();
  });
  test('a failed call end prevents its conversation from being closed', async () => {
    const f = fixture();
    await f.controller.start('side-thread'); await f.connect();
    f.transport.end = async () => { throw new Error('Temporary disconnect'); };
    const failure = await f.controller.stopForSession('side-thread').then(() => null, error => error);
    expect(String(failure)).toContain('Unable to stop voice chat');
    expect(f.controller.snapshot().open).toBe(true); expect(f.track.enabled).toBe(true);
    f.transport.end = async () => state({ generation: 2 });
    await f.controller.dispose();
  });
  test('an active call keeps its conversation when the visible text conversation changes', async () => {
    const f = fixture(); await f.controller.start(); await f.connect(); f.select('thread-two'); await f.controller.refresh();
    expect(f.controller.snapshot().targetSessionId).toBe('thread-one'); expect(f.ends).toHaveLength(0); expect(f.queries).toEqual(['thread-one']);
    await f.controller.stop(); expect(f.stopped()).toBe(1); await f.controller.dispose();
  });
  test('cancel during capability lookup never acquires a late microphone', async () => {
    const f = fixture(), pending = deferred<VoiceChatState>(); f.transport.state = () => pending.promise;
    const starting = f.controller.start(); await tick(); await f.controller.stop(); pending.resolve(state()); await starting;
    expect(f.offers).toHaveLength(0); expect(f.controller.snapshot().open).toBe(false); await f.controller.dispose();
  });
  test('repeated start creates one call and independent controls retain both mute states', async () => {
    const f = fixture(); const first = f.controller.start(); await f.controller.start(); await first; await f.connect();
    expect(f.offers).toHaveLength(1); await f.controller.microphone(); expect(f.track.enabled).toBe(false);
    await f.controller.speaker(); expect(f.controller.snapshot().state?.microphoneMuted).toBe(true); expect(f.controller.snapshot().state?.speakerMuted).toBe(true);
    await f.controller.microphone(); expect(f.track.enabled).toBe(true); expect(f.controller.snapshot().state?.speakerMuted).toBe(true); await f.controller.dispose();
  });
  test('failed finalization restores the live call and allows another end attempt', async () => {
    const f = fixture(); await f.controller.start(); await f.connect(); const end = f.transport.end;
    f.transport.end = async () => { throw new Error('Temporary disconnect'); }; await f.controller.stop();
    expect(f.controller.snapshot().phase).toBe('active'); expect(f.controller.snapshot().open).toBe(true); expect(f.track.enabled).toBe(true); expect(f.controller.snapshot().notifyError).toBe(true);
    f.transport.end = end; await f.controller.stop(); expect(f.controller.snapshot().open).toBe(false); await f.controller.dispose();
  });
  test('startup denial preserves a reviewable failure and retry uses the current voice target', async () => {
    const f = fixture(); f.transport.state = async () => { throw new Error('Authentication required'); }; await f.controller.start();
    expect(f.controller.snapshot().phase).toBe('error'); expect(f.controller.snapshot().open).toBe(true); expect(f.offers).toHaveLength(0);
    f.transport.state = async () => state(); await f.controller.start(); await f.connect(); expect(f.controller.snapshot().phase).toBe('active'); await f.controller.dispose();
  });
  test('an unavailable source fails before creating a conversation', async () => {
    const f = fixture();
    f.select(null);
    f.transport.state = async () => state({ available: false, unavailableReason: 'realtime-source-not-configured' });
    await f.controller.start();
    expect(f.controller.snapshot().phase).toBe('error'); expect(f.controller.snapshot().open).toBe(true);
    expect(f.ensured()).toBe(0); expect(f.offers).toHaveLength(0);
    expect((f.controller.snapshot().error as Error).message).toBe('realtime-source-not-configured');
    await f.controller.dispose();
  });
  test('saving a usable voice source clears an obsolete configuration failure without starting audio', async () => {
    const f = fixture();
    f.transport.state = async () => state({ available: false, unavailableReason: 'realtime-source-not-configured' });
    await f.controller.start();
    expect(f.controller.snapshot().phase).toBe('error');
    await f.controller.refresh();
    expect(f.controller.snapshot().open).toBe(true);
    f.transport.state = async () => state({ sourceId: 'subscription:codex' });
    await f.controller.refresh();
    expect(f.controller.snapshot().open).toBe(false);
    expect(f.controller.snapshot().phase).toBe('inactive');
    expect(f.controller.snapshot().error).toBeNull();
    expect(f.offers).toHaveLength(0); expect(f.ensured()).toBe(0);
    await f.controller.dispose();
  });
  test('a settings refresh preserves a transport startup failure for review', async () => {
    const f = fixture();
    f.transport.negotiate = async () => { throw new Error('Call negotiation refused'); };
    await f.controller.start(); await f.controller.refresh();
    expect(f.controller.snapshot().phase).toBe('error');
    expect(f.controller.snapshot().open).toBe(true);
    expect(String(f.controller.snapshot().error)).toContain('Call negotiation refused');
    await f.controller.dispose();
  });
  test('source-driven call end returns the composer to its idle state', async () => {
    const f = fixture(); await f.controller.start(); await f.connect(); f.emit(state({ generation: 2 }));
    expect(f.controller.snapshot().open).toBe(false); expect(f.stopped()).toBe(1); await f.controller.dispose();
  });
  test('an old preflight cannot replace a newly selected conversation capability', async () => {
    const f = fixture(), pending = deferred<VoiceChatState>(); f.transport.state = () => pending.promise; const previous = f.controller.refresh();
    f.select('thread-two'); f.transport.state = async () => state({ available: false }); await f.controller.refresh(); pending.resolve(state({ available: true })); await previous;
    expect(f.controller.snapshot().state?.available).toBe(false); await f.controller.dispose();
  });
  test('an established call disconnects back to the composer and preserves its retry target', async () => {
    const f = fixture(); await f.controller.start(); await f.connect(); f.select('other-thread');
    f.emit(state({ generation: 2, error: 'The conversation engine disconnected' }));
    expect(f.controller.snapshot().open).toBe(false); expect(f.controller.snapshot().notifyError).toBe(true); expect(f.controller.snapshot().targetSessionId).toBe('thread-one'); await f.controller.dispose();
  });
});
