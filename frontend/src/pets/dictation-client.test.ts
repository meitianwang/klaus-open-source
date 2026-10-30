import { describe, expect, test } from 'bun:test';
import { PetDictationClient, type DictationEvent, type DictationOptions, type DictationReply, type DictationTransport } from './dictation-client';
import type { DictationMetrics, PipelineOptions } from '../chat/voice-pipeline';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const metrics = (): DictationMetrics => ({ pressToStreamMs: null, pressToFirstFrameMs: null, stopToFinalMs: null, segments: 0, partialCalls: 0, partialFailures: 0, partialBytes: 0, downgraded: false, container: 'wav', wavFallbacks: 0, via: null });
interface PipelineStub {
  options: PipelineOptions;
  started: number; stopped: number; cancelled: number;
  deliverOnStop: boolean; hangStop: boolean; text: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  final(text?: string): void;
  segments(text?: string): void;
  partial(text: string): void;
  empty(): void;
  failWith(code: string): void;
}
function makePipelineStub(options: PipelineOptions): PipelineStub {
  const stub: PipelineStub = {
    options,
    started: 0, stopped: 0, cancelled: 0,
    deliverOnStop: true,
    hangStop: false,
    text: '  Recognized draft  ',
    start: async () => { stub.started++; },
    stop: async () => { stub.stopped++; if (stub.deliverOnStop && !stub.hangStop) options.hooks.final({ text: stub.text, via: 'final' as const, metrics: metrics() }); },
    cancel: async () => { stub.cancelled++; },
    final: (text = stub.text) => options.hooks.final({ text, via: 'final' as const, metrics: metrics() }),
    segments: (text = stub.text) => options.hooks.final({ text, via: 'segments' as const, metrics: metrics() }),
    partial: (text: string) => options.hooks.partial?.(text),
    empty: () => options.hooks.empty?.(metrics()),
    failWith: (code: string) => options.hooks.error(code, metrics()),
  };
  return stub;
}
function fixture(source = 'qwenwork', patch: Partial<DictationOptions> = {}) {
  const calls = {
    configs: [] as string[], texts: [] as string[], partials: [] as string[], errors: [] as string[], states: [] as string[],
    cancels: [] as string[], transcribes: [] as Array<{ data: ArrayBuffer; mimeType: string; id: string; source: string; context?: string; durationMs?: number; partial?: boolean }>,
    audio: [] as number[], stopped: 0, starts: [] as string[], stops: [] as string[], unsubscribed: 0, pipelines: [] as PipelineStub[],
  };
  const stream = { getTracks: () => [{ stop: () => { calls.stopped++; } }] } as unknown as MediaStream;
  let listener: (event: DictationEvent) => void = () => {};
  const pcm = { start: async () => {}, stop: async () => {}, close: async () => {} };
  let sendPcm!: (data: ArrayBuffer, seq: number) => Promise<void>;
  const transport: DictationTransport = {
    voiceConfig: async id => { calls.configs.push(id!); return { source, sourceAvailable: true }; },
    micPermission: async () => ({ ok: true }),
    transcribe: async (data, mimeType, id, options) => { calls.transcribes.push({ data, mimeType, id, ...options }); return { ok: true, text: '  Recognized draft  ' }; },
    sessionStart: async options => { calls.starts.push(options.operationId); return { ok: true, sessionId: options.operationId }; },
    sessionAudio: async (_id, _data, seq) => { calls.audio.push(seq); return { ok: true }; },
    sessionStop: async id => { calls.stops.push(id); return { ok: true }; },
    sessionCancel: async id => { calls.cancels.push(id); return { ok: true, complete: true }; },
    onSessionEvent: callback => { listener = callback; return () => { calls.unsubscribed++; }; },
  };
  const options: DictationOptions = {
    transport, text: value => calls.texts.push(value), error: value => calls.errors.push(value.message), state: value => calls.states.push(value),
    partial: value => calls.partials.push(value),
    id: () => `capture-${calls.configs.length + 1}`, context: () => 'Existing draft', media: async () => stream,
    pipeline: opts => { const stub = makePipelineStub(opts); calls.pipelines.push(stub); return stub; },
    pcm: (_stream, send) => { sendPcm = send; return pcm; }, ...patch,
  };
  const client = new PetDictationClient(options);
  return { calls, options, transport, client, stream, pcm, event: (value: DictationEvent) => listener(value), sendPcm: (data: ArrayBuffer, seq: number) => sendPcm(data, seq) };
}

describe('companion voice input ownership', () => {
  test('uses the saved account source and the streaming pipeline to insert one editable draft', async () => {
    const row = fixture(); await row.client.start();
    expect(row.client.snapshot()).toBe('recording'); expect(row.calls.starts).toEqual([]);
    const pipeline = row.calls.pipelines[0];
    expect(pipeline.options.source).toBe('qwenwork');
    expect(pipeline.options.operationId).toBe('capture-1');
    expect(pipeline.options.context).toBe('Existing draft');
    expect(pipeline.started).toBe(1);
    // The pipeline transport forwards the partial flag and per-call fields untouched.
    await pipeline.options.transport.transcribe(new ArrayBuffer(4), 'audio/wav', 'capture-1-p1', { source: 'qwenwork', durationMs: 100, partial: true });
    expect(row.calls.transcribes[0]).toMatchObject({ mimeType: 'audio/wav', id: 'capture-1-p1', source: 'qwenwork', durationMs: 100, partial: true });
    await row.client.stop();
    expect(pipeline.stopped).toBe(1); await tick();
    expect(row.calls.texts).toEqual(['Recognized draft']); expect(row.calls.errors).toEqual([]);
    expect(row.client.snapshot()).toBe('idle'); expect(row.calls.cancels).toEqual([]);
    await row.client.dispose();
  });
  test('one start owns the microphone while a second start is ignored', async () => {
    const pending = deferred<{ source: string }>(), row = fixture(); row.transport.voiceConfig = async () => pending.promise;
    const first = row.client.start(); await row.client.start(); pending.resolve({ source: 'codex' }); await first;
    expect(row.client.snapshot()).toBe('recording'); await row.client.dispose();
    expect(row.calls.stopped).toBe(1); expect(row.calls.cancels).toEqual(['capture-1']);
  });
  test('unavailable source fails before microphone permission and never falls back', async () => {
    let media = 0, permission = 0;
    const row = fixture('retired', { media: async () => { media++; throw new Error('must not open'); } });
    row.transport.micPermission = async () => { permission++; return { ok: true }; };
    await row.client.start(); await tick();
    expect(row.calls.errors).toEqual(['voice-source-unavailable']); expect(media).toBe(0); expect(permission).toBe(0);
    expect(row.calls.transcribes).toEqual([]); expect(row.calls.starts).toEqual([]); expect(row.calls.pipelines).toEqual([]); await row.client.dispose();
  });
  test('cancel during microphone permission prevents the later microphone request', async () => {
    const permission = deferred<DictationReply>(), row = fixture(); let media = 0;
    row.options.media = async () => { media++; return row.stream; }; row.transport.micPermission = () => permission.promise;
    const starting = row.client.start(); await tick(); await row.client.cancel(); permission.resolve({ ok: true }); await starting;
    expect(media).toBe(0); expect(row.calls.texts).toEqual([]); expect(row.calls.errors).toEqual([]); await row.client.dispose();
  });
  test('hide while the microphone request is pending stops the late stream', async () => {
    const media = deferred<MediaStream>(), row = fixture('qwenwork', { media: () => media.promise });
    const starting = row.client.start(); await tick(); await row.client.cancel(false); media.resolve(row.stream); await starting;
    expect(row.calls.stopped).toBe(1); expect(row.client.snapshot()).toBe('idle'); expect(row.calls.transcribes).toEqual([]); await row.client.dispose();
  });
  test('a late pipeline result cannot append text to another draft after cancellation', async () => {
    const row = fixture(); await row.client.start();
    const pipeline = row.calls.pipelines[0]; pipeline.hangStop = true;
    await row.client.stop(); await tick();
    expect(pipeline.stopped).toBe(1);
    await row.client.cancel(false);
    pipeline.final('Late result'); await tick();
    expect(pipeline.cancelled).toBe(1);
    expect(row.calls.texts).toEqual([]); expect(row.calls.errors).toEqual([]); await row.client.dispose();
  });
  test('live segment text reaches the optional partial callback and joined fallback text completes the draft', async () => {
    const row = fixture(); await row.client.start();
    const pipeline = row.calls.pipelines[0];
    pipeline.partial('hello'); pipeline.partial('hello world');
    expect(row.calls.partials).toEqual(['hello', 'hello world']);
    pipeline.deliverOnStop = false;
    await row.client.stop();
    pipeline.segments('hello world'); await tick();
    expect(row.calls.texts).toEqual(['hello world']); expect(row.client.snapshot()).toBe('idle');
    await row.client.dispose();
  });
  test('an empty cloud recording surfaces the empty transcript once', async () => {
    const row = fixture(); await row.client.start();
    const pipeline = row.calls.pipelines[0]; pipeline.deliverOnStop = false;
    await row.client.stop(); pipeline.empty(); await tick();
    expect(row.calls.errors).toEqual(['empty-transcript']); expect(row.calls.texts).toEqual([]);
    await row.client.dispose();
  });
  test('system recognition streams sequenced audio and inserts the final event once', async () => {
    const row = fixture('system'); await row.client.start();
    await row.sendPcm(new ArrayBuffer(4), 1); expect(row.calls.audio).toEqual([1]);
    row.event({ sessionId: 'other-capture', seq: 1, type: 'final', text: 'Wrong owner' });
    row.event({ sessionId: 'capture-1', seq: 1, type: 'partial', text: 'Partial words' });
    expect(row.calls.texts).toEqual([]); await row.client.stop();
    expect(row.calls.stops).toEqual(['capture-1']);
    row.event({ sessionId: 'capture-1', seq: 2, type: 'final', text: '  Final words  ' });
    row.event({ sessionId: 'capture-1', seq: 2, type: 'final', text: 'Duplicate final' });
    expect(row.calls.texts).toEqual(['Final words']); expect(row.calls.transcribes).toEqual([]); await row.client.dispose();
  });
  test('system event gaps fail once and ignore subsequent provider errors', async () => {
    const row = fixture('system'); await row.client.start();
    row.event({ sessionId: 'capture-1', seq: 2, type: 'partial', text: 'Missing event' });
    row.event({ sessionId: 'capture-1', seq: 3, type: 'error', code: 'speech-failed' }); await tick();
    expect(row.calls.errors).toEqual(['speech-event-sequence']); expect(row.calls.cancels).toEqual(['capture-1']); await row.client.dispose();
  });
  test('a system session started after cancellation is cancelled again by its returned identity', async () => {
    const started = deferred<DictationReply>(), row = fixture('system'); row.transport.sessionStart = () => started.promise;
    const starting = row.client.start(); await tick(); await row.client.cancel(false);
    started.resolve({ ok: true, sessionId: 'late-system-session' }); await starting; await tick();
    expect(row.calls.cancels).toEqual(['capture-1', 'late-system-session']);
    row.event({ sessionId: 'late-system-session', seq: 1, type: 'final', text: 'Late words' });
    expect(row.calls.texts).toEqual([]); await row.client.dispose();
  });
  test('recording limits stop oversized audio before transcription', async () => {
    const row = fixture(); await row.client.start();
    row.calls.pipelines[0].failWith('audio-too-large'); await tick();
    expect(row.calls.errors).toEqual(['audio-too-large']); expect(row.calls.transcribes).toEqual([]);
    expect(row.calls.stopped).toBe(1); expect(row.client.snapshot()).toBe('idle'); await row.client.dispose();
  });
  test('the recording deadline finishes an account recording and releases its microphone', async () => {
    const row = fixture('codex', { maxDurationMs: 5 }); await row.client.start();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(row.calls.pipelines[0].stopped).toBe(1);
    expect(row.calls.texts).toEqual(['Recognized draft']); expect(row.calls.stopped).toBe(1); expect(row.client.snapshot()).toBe('idle'); await row.client.dispose();
  });
  test('provider error codes are preserved while raw transport messages stay out of user errors', async () => {
    const row = fixture(); await row.client.start();
    row.calls.pipelines[0].failWith('qwenwork_transcription_authentication_required'); await tick();
    expect(row.calls.errors).toEqual(['qwenwork_transcription_authentication_required']); await row.client.dispose();
    const failed = fixture(); failed.options.media = async () => { throw new Error('Access failed at https://service.invalid/private'); };
    await failed.client.start(); await tick(); expect(failed.calls.errors).toEqual(['voice-start-failed']); await failed.client.dispose();
  });
  test('unmount cancels the operation and unregisters its event listener once', async () => {
    const row = fixture(); await row.client.start(); await row.client.dispose(); await row.client.dispose();
    expect(row.calls.cancels).toEqual(['capture-1']); expect(row.calls.unsubscribed).toBe(1); expect(row.calls.texts).toEqual([]); expect(row.calls.errors).toEqual([]);
    expect(row.calls.pipelines[0].cancelled).toBe(1);
  });
  test('a completed system recording drains its local capture before another recording can start', async () => {
    const closed = deferred<void>(), row = fixture('system'); row.pcm.close = () => closed.promise;
    await row.client.start(); row.event({ sessionId: 'capture-1', seq: 1, type: 'final', text: 'Completed' });
    expect(row.calls.texts).toEqual(['Completed']); expect(row.client.snapshot()).toBe('transcribing');
    await row.client.start(); expect(row.calls.configs).toEqual(['capture-1']);
    closed.resolve(); await tick(); expect(row.client.snapshot()).toBe('idle'); await row.client.dispose();
  });
  test('incomplete host cancellation is reported once and never inserts a transcript', async () => {
    const row = fixture(); row.transport.sessionCancel = async () => ({ ok: true, complete: false });
    await row.client.start(); await row.client.cancel();
    expect(row.calls.errors).toEqual(['voice-cancel-incomplete']); expect(row.calls.texts).toEqual([]); await row.client.dispose();
  });
});
