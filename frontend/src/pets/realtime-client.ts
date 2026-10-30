import type { PetLiveVoiceState, PetRealtimeAnswer, PetRealtimeAudioFrame, PetRealtimeControl, PetRealtimeOffer, PetVoiceTranscript } from '../../../contracts/desktop-pet-voice';

export interface RealtimeVoiceTransport {
  state(): Promise<PetLiveVoiceState>;
  negotiate(value: PetRealtimeOffer): Promise<PetRealtimeAnswer>;
  end(value: { requestId: string; generation?: number }): Promise<PetLiveVoiceState>;
  control(value: PetRealtimeControl): Promise<PetLiveVoiceState>;
  /** Engine-mediated websocket lines only: one base64 PCM16 microphone frame. */
  appendAudio?(value: PetRealtimeAudioFrame): Promise<unknown>;
}
export interface RealtimeVoiceOptions {
  transport: RealtimeVoiceTransport;
  state(value: PetLiveVoiceState): void;
  error(error: Error): void;
  level?(value: number): void;
  outputLevel?(value: number): void;
  outputBands?(value: number[]): void;
  prepare?(requestId: string, targetSessionId?: string): Promise<void>;
  resumeOnStopFailure?: boolean;
  media?(): Promise<MediaStream>;
  peer?(): RTCPeerConnection;
  audio?(): HTMLAudioElement;
  id?(): string;
  timeoutMs?: number;
  devices?: Pick<MediaDevices, 'addEventListener' | 'removeEventListener' | 'enumerateDevices'>;
}
interface Call {
  requestId: string;
  revision: number;
  generation?: number;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  sender?: RTCRtpSender;
  channel?: RTCDataChannel;
  output?: HTMLAudioElement;
  context?: AudioContext;
  outputContext?: AudioContext;
  outputFrame?: number;
  frame?: number;
  timer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  peerReady: boolean;
  channelReady: boolean;
  released: boolean;
  disposed?: boolean;
  refreshingInput?: Promise<void>;
  detachDevices?: () => void;
  deviceSignature?: string;
  capture?: AudioContext;
  captureNode?: AudioWorkletNode;
  captureSource?: MediaStreamAudioSourceNode;
  captureSink?: GainNode;
  playback?: AudioContext;
  playbackGain?: GainNode;
  playbackAnalyser?: AnalyserNode;
  playbackTime?: number;
  playbackSources?: Set<AudioBufferSourceNode>;
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function error(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

/** The engine-mediated voice line carries 16 kHz mono PCM up and 24 kHz down. */
const CAPTURE_RATE = 16000;
const PLAYBACK_RATE = 24000;
const CAPTURE_FRAME = 1600;
const CAPTURE_WORKLET = `class KlausLiveVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Float32Array(${CAPTURE_FRAME}); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index++) {
      this.frame[this.offset++] = channel[index];
      if (this.offset === this.frame.length) {
        this.port.postMessage({ samples: this.frame }, [this.frame.buffer]);
        this.frame = new Float32Array(${CAPTURE_FRAME});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('klaus-live-voice-capture', KlausLiveVoiceCapture);`;
let workletObjectUrl: string | undefined;
function captureWorkletUrl(): string {
  workletObjectUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
  return workletObjectUrl;
}

/** Owns microphone, peer, data channel and remote audio as one cancellable call. */
export class PetRealtimeClient {
  private value: PetLiveVoiceState = { transport: 'webrtc', available: false, phase: 'inactive', generation: 0, microphoneMuted: false, speakerMuted: false, activity: 'inactive', transcript: [] };
  private call: Call | undefined;
  private draining: Call | undefined;
  private revision = 0;
  private disposed = false;
  private stopping: Promise<PetLiveVoiceState> | undefined;
  private starting: Promise<PetLiveVoiceState> | undefined;
  private pendingEnd: { requestId: string; generation?: number } | undefined;
  private readonly finalizedTranscriptIds = new Set<string>();
  private readonly authoritativeTranscriptIds = new Set<string>();
  constructor(private readonly options: RealtimeVoiceOptions) {}
  snapshot(): PetLiveVoiceState { return structuredClone(this.value); }
  private publish(): void { if (!this.disposed) this.options.state(this.snapshot()); }
  private current(call: Call): boolean { return !this.disposed && this.call === call && call.revision === this.revision; }
  private owned(call: Call): boolean { return !this.disposed && (this.current(call) || this.draining === call); }
  applyState(value: PetLiveVoiceState): void {
    if (this.disposed || value.generation < this.value.generation) return;
    if (this.pendingEnd && value.phase === 'inactive' && value.generation > (this.pendingEnd.generation ?? -1)) this.pendingEnd = undefined;
    const active = this.call;
    if (active && active.generation !== undefined && value.generation > active.generation && value.phase === 'inactive') { this.call = undefined; this.revision++; this.release(active); }
    if (this.value.sessionId && value.sessionId && this.value.sessionId !== value.sessionId) {
      this.value.transcript = []; this.finalizedTranscriptIds.clear(); this.authoritativeTranscriptIds.clear();
    }
    for (const item of value.transcript) this.transcript(item, true, value.transcriptSource === 'engine');
    const transcript = this.value.transcript;
    if (this.draining && value.phase === 'inactive' && value.generation > (this.draining.generation ?? -1)) this.release(this.draining);
    this.value = { ...value, transcript };
    if (this.call) this.applyMute(this.call);
    this.publish();
  }
  async refresh(): Promise<PetLiveVoiceState> { const value = await this.options.transport.state(); this.applyState(value); return this.snapshot(); }
  start(targetSessionId?: string, preflight?: PetLiveVoiceState): Promise<PetLiveVoiceState> {
    if (this.starting) return this.starting;
    if (this.call) return Promise.resolve(this.snapshot());
    const revision = ++this.revision;
    const starting = this.begin(targetSessionId, revision, preflight).finally(() => { if (this.starting === starting) this.starting = undefined; });
    this.starting = starting; return starting;
  }
  private async begin(targetSessionId: string | undefined, revision: number, preflight?: PetLiveVoiceState): Promise<PetLiveVoiceState> {
    if (this.disposed) throw new Error('The voice client is closed');
    if (this.call) return this.snapshot();
    await this.stopping;
    if (this.pendingEnd) await this.stop();
    if (this.disposed || this.revision !== revision) return this.snapshot();
    const available = preflight ?? await this.options.transport.state();
    if (this.disposed || this.revision !== revision) return this.snapshot();
    this.applyState(available);
    targetSessionId ??= available.targetSessionId;
    if (!available.available || available.transport !== 'webrtc' && available.transport !== 'websocket') throw new Error(available.unavailableReason || 'The selected source does not support realtime voice');
    const call: Call = { requestId: this.options.id?.() ?? crypto.randomUUID(), revision, peerReady: false, channelReady: false, released: false };
    this.call = call; this.finalizedTranscriptIds.clear(); this.authoritativeTranscriptIds.clear();
    this.value = { ...available, phase: 'connecting', activity: 'inactive', transcript: [] }; delete this.value.error; this.publish();
    call.timer = setTimeout(() => this.fail(call, new Error('The voice connection timed out')), this.options.timeoutMs ?? 30_000);
    let prepared = !this.options.prepare;
    try {
      await this.options.prepare?.(call.requestId, targetSessionId);
      prepared = true;
      if (!this.current(call)) return this.snapshot();
      const stream = await (this.options.media?.() ?? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
      if (!this.current(call)) { stream.getTracks().forEach(track => track.stop()); return this.snapshot(); }
      call.stream = stream; stream.getAudioTracks().forEach(track => { track.enabled = false; track.onended = () => { void this.refreshInput(call).catch(failure => this.inputFailure(call, error(failure))); }; });
      if (available.transport === 'websocket') {
        stream.getAudioTracks().forEach(track => { track.onended = () => { void this.refreshCapture(call).catch(failure => this.inputFailure(call, error(failure))); }; });
        const answer = await this.options.transport.negotiate({ requestId: call.requestId, ...(targetSessionId ? { targetSessionId } : {}), microphoneMuted: this.value.microphoneMuted, speakerMuted: this.value.speakerMuted });
        if (!this.current(call)) { await this.options.transport.end({ requestId: call.requestId, generation: answer.generation }).catch(() => {}); return this.snapshot(); }
        if (answer.requestId !== call.requestId || !answer.sessionId || !Number.isSafeInteger(answer.generation)) throw new Error('The voice source returned an invalid session answer');
        call.generation = answer.generation; this.value.generation = answer.generation; this.value.sessionId = answer.sessionId;
        if (answer.protocol) this.value.protocol = answer.protocol;
        if (answer.transcriptSource) this.value.transcriptSource = answer.transcriptSource;
        const devices = this.options.devices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
        if (devices?.addEventListener) {
          const signature = async () => (await devices.enumerateDevices()).filter(device => device.kind === 'audioinput').map(device => `${device.deviceId}:${device.groupId}:${device.label}`).sort().join('\0');
          void signature().then(value => { if (this.current(call)) call.deviceSignature = value; }).catch(() => {});
          const changed = () => { void signature().then(async value => { if (!this.current(call) || call.deviceSignature === value) return; call.deviceSignature = value; await this.refreshCapture(call); }).catch(failure => this.inputFailure(call, error(failure))); };
          devices.addEventListener('devicechange', changed); call.detachDevices = () => devices.removeEventListener('devicechange', changed);
        }
        await this.startCapture(call);
        if (!this.current(call)) return this.snapshot();
        this.startPlayback(call);
        this.meter(call);
        await this.connectedNow(call);
        this.publish(); return this.snapshot();
      }
      const peer = this.options.peer?.() ?? new RTCPeerConnection(); call.peer = peer;
      const output = this.options.audio?.() ?? document.createElement('audio'); call.output = output; output.autoplay = true; output.hidden = true; output.muted = this.value.speakerMuted;
      const channel = peer.createDataChannel('oai-events'); call.channel = channel;
      channel.onopen = () => { call.channelReady = true; void this.connected(call); };
      channel.onclose = () => { if (this.current(call)) this.fail(call, new Error('The voice event channel closed')); };
      channel.onerror = () => this.fail(call, new Error('The voice event channel failed'));
      channel.onmessage = event => {
        if (!this.owned(call) || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
        let value: unknown; try { value = JSON.parse(event.data); } catch { this.fail(call, new Error('The voice source sent an invalid event')); return; }
        this.receive(call, object(value));
      };
      peer.ontrack = event => {
        if (!this.current(call)) return;
        const remote = event.streams[0] ?? new MediaStream([event.track]); output.srcObject = remote;
        this.outputMeter(call, remote);
        void output.play().catch(failure => this.fail(call, error(failure)));
      };
      peer.onconnectionstatechange = () => {
        if (!this.current(call)) return;
        if (peer.connectionState === 'connected') { clearTimeout(call.disconnectTimer); call.peerReady = true; void this.connected(call); }
        else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.fail(call, new Error('The voice connection failed'));
        else if (peer.connectionState === 'disconnected' && !call.disconnectTimer) call.disconnectTimer = setTimeout(() => this.fail(call, new Error('The voice connection was lost')), 5000);
      };
      for (const track of stream.getAudioTracks()) call.sender = peer.addTrack(track, stream);
      const devices = this.options.devices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
      if (devices?.addEventListener) {
        const signature = async () => (await devices.enumerateDevices()).filter(device => device.kind === 'audioinput').map(device => `${device.deviceId}:${device.groupId}:${device.label}`).sort().join('\0');
        void signature().then(value => { if (this.current(call)) call.deviceSignature = value; }).catch(() => {});
        const changed = () => { void signature().then(async value => { if (!this.current(call) || call.deviceSignature === value) return; call.deviceSignature = value; await this.refreshInput(call); }).catch(failure => this.inputFailure(call, error(failure))); };
        devices.addEventListener('devicechange', changed); call.detachDevices = () => devices.removeEventListener('devicechange', changed);
      }
      const offer = await peer.createOffer(); if (!this.current(call)) return this.snapshot();
      if (!offer.sdp) throw new Error('The voice connection produced no offer');
      await peer.setLocalDescription(offer); if (!this.current(call)) return this.snapshot();
      const answer = await this.options.transport.negotiate({ requestId: call.requestId, offerSdp: offer.sdp, ...(targetSessionId ? { targetSessionId } : {}), microphoneMuted: this.value.microphoneMuted, speakerMuted: this.value.speakerMuted });
      if (!this.current(call)) { await this.options.transport.end({ requestId: call.requestId, generation: answer.generation }).catch(() => {}); return this.snapshot(); }
      if (answer.requestId !== call.requestId || !answer.sessionId || !answer.answerSdp || !Number.isSafeInteger(answer.generation)) throw new Error('The voice source returned an invalid session answer');
      call.generation = answer.generation; this.value.generation = answer.generation; this.value.sessionId = answer.sessionId;
      if (answer.protocol) this.value.protocol = answer.protocol;
      if (answer.transcriptSource) this.value.transcriptSource = answer.transcriptSource;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp }); if (!this.current(call)) return this.snapshot();
      this.meter(call); await this.connected(call); this.publish(); return this.snapshot();
    } catch (failure) {
      if (this.current(call)) {
        if (prepared) await this.stop();
        else { this.call = undefined; this.revision++; this.release(call); this.value.phase = 'inactive'; this.value.activity = 'inactive'; }
        this.value.error = error(failure).message; this.publish(); throw failure;
      }
      return this.snapshot();
    }
  }
  private async connected(call: Call): Promise<void> {
    if (!this.current(call) || !call.peerReady || !call.channelReady || call.generation === undefined || call.released) return;
    call.released = true; clearTimeout(call.timer);
    try {
      await this.options.transport.control({ requestId: call.requestId, generation: call.generation, action: 'connected' });
      if (!this.current(call)) return;
      this.value.phase = 'active'; this.value.activity = this.value.microphoneMuted ? 'muted' : 'listening'; this.applyMute(call); this.publish();
    } catch (failure) { this.fail(call, error(failure)); }
  }
  private applyMute(call: Call): void { call.stream?.getAudioTracks().forEach(track => { track.enabled = call.released && this.value.phase === 'active' && !this.value.microphoneMuted; }); if (call.output) call.output.muted = this.value.speakerMuted; if (call.playbackGain) call.playbackGain.gain.value = this.value.speakerMuted ? 0 : 1; }
  /** Websocket-line counterpart of `connected`: no peer or data channel gate. */
  private async connectedNow(call: Call): Promise<void> {
    if (!this.current(call) || call.generation === undefined || call.released) return;
    call.released = true; clearTimeout(call.timer);
    try {
      await this.options.transport.control({ requestId: call.requestId, generation: call.generation, action: 'connected' });
      if (!this.current(call)) return;
      this.value.phase = 'active'; this.value.activity = this.value.microphoneMuted ? 'muted' : 'listening'; this.applyMute(call); this.publish();
    } catch (failure) { this.fail(call, error(failure)); }
  }
  private async startCapture(call: Call): Promise<void> {
    const append = this.options.transport.appendAudio;
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined' || !append || !call.stream) return;
    const context = new AudioContext({ sampleRate: CAPTURE_RATE });
    call.capture = context;
    await context.audioWorklet.addModule(captureWorkletUrl());
    if (!this.current(call)) { void context.close(); call.capture = undefined; return; }
    const node = new AudioWorkletNode(context, 'klaus-live-voice-capture');
    call.captureNode = node;
    node.port.onmessage = (event: MessageEvent) => {
      const samples = (event.data as { samples?: Float32Array } | undefined)?.samples;
      const generation = call.generation;
      if (!samples || generation === undefined || !this.current(call) || !call.released || this.value.phase !== 'active' || this.value.microphoneMuted) return;
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index++) {
        const value = Math.max(-1, Math.min(1, samples[index]!));
        pcm[index] = value < 0 ? value * 32768 : value * 32767;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      void append({ requestId: call.requestId, generation, audio: btoa(binary) }).catch(() => {});
    };
    const sink = context.createGain();
    sink.gain.value = 0;
    call.captureSink = sink;
    node.connect(sink);
    sink.connect(context.destination);
    const source = context.createMediaStreamSource(call.stream);
    call.captureSource = source;
    source.connect(node);
    if (context.state === 'suspended') await context.resume();
  }
  private startPlayback(call: Call): void {
    if (typeof AudioContext === 'undefined') return;
    const context = new AudioContext({ sampleRate: PLAYBACK_RATE });
    call.playback = context;
    const gain = context.createGain();
    gain.gain.value = this.value.speakerMuted ? 0 : 1;
    call.playbackGain = gain;
    gain.connect(context.destination);
    call.playbackTime = context.currentTime;
    call.playbackSources = new Set();
    if (this.options.outputLevel || this.options.outputBands) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(analyser);
      call.playbackAnalyser = analyser;
      const bytes = new Uint8Array(analyser.fftSize), frequencies = new Uint8Array(analyser.frequencyBinCount);
      const frame = () => {
        if (!this.current(call)) return;
        analyser.getByteTimeDomainData(bytes);
        let square = 0;
        for (const byte of bytes) square += ((byte - 128) / 128) ** 2;
        const overall = this.value.speakerMuted ? 0 : Math.sqrt(square / bytes.length);
        this.options.outputLevel?.(overall);
        if (this.options.outputBands) {
          analyser.getByteFrequencyData(frequencies);
          const band = (from: number, to: number) => { let sum = 0, count = 0; for (let index = from; index < Math.min(to, frequencies.length); index++) { sum += frequencies[index]! / 255; count++; } return this.value.speakerMuted ? 0 : count ? sum / count : 0; };
          this.options.outputBands([band(1, 3), band(3, 12), band(12, frequencies.length), overall]);
        }
        call.outputFrame = requestAnimationFrame(frame);
      };
      call.outputFrame = requestAnimationFrame(frame);
    }
    if (context.state === 'suspended') void context.resume();
  }
  /** Play one base64 PCM16 frame the engine relayed for a websocket call. */
  audio(event: { generation: number; audio: string }): void {
    const call = this.call;
    if (!call || this.disposed || this.draining === call || call.generation !== event.generation || !call.playback || !call.playbackGain) return;
    let binary: string;
    try { binary = atob(event.audio); } catch { return; }
    const frames = Math.floor(binary.length / 2);
    if (frames < 1) return;
    const buffer = call.playback.createBuffer(1, frames, PLAYBACK_RATE);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frames; index++) {
      let sample = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
      if (sample >= 32768) sample -= 65536;
      channel[index] = sample / 32768;
    }
    const source = call.playback.createBufferSource();
    source.buffer = buffer;
    source.connect(call.playbackGain);
    const startAt = Math.max(call.playback.currentTime + 0.02, call.playbackTime ?? call.playback.currentTime);
    source.start(startAt);
    call.playbackTime = startAt + buffer.duration;
    call.playbackSources?.add(source);
    source.onended = () => { call.playbackSources?.delete(source); };
  }
  private flushPlayback(call: Call): void {
    for (const source of call.playbackSources ?? []) { try { source.onended = null; source.stop(); } catch { /* the source already finished */ } }
    call.playbackSources?.clear();
    if (call.playback) call.playbackTime = call.playback.currentTime;
  }
  private refreshCapture(call: Call): Promise<void> {
    if (!this.current(call) || !call.capture) return Promise.resolve();
    if (call.refreshingInput) return call.refreshingInput;
    const refreshing = (async () => {
      const stream = await (this.options.media?.() ?? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
      const track = stream.getAudioTracks()[0];
      stream.getTracks().forEach(item => { item.enabled = false; });
      if (!this.current(call) || !call.capture || !call.captureNode) { stream.getTracks().forEach(item => item.stop()); return; }
      if (!track) { stream.getTracks().forEach(item => item.stop()); throw new Error('The microphone is unavailable'); }
      const previous = call.stream;
      call.stream = stream;
      track.onended = () => { void this.refreshCapture(call).catch(failure => this.inputFailure(call, error(failure))); };
      previous?.getTracks().forEach(item => { item.onended = null; item.stop(); });
      call.captureSource?.disconnect();
      const source = call.capture.createMediaStreamSource(stream);
      call.captureSource = source;
      source.connect(call.captureNode);
      if (call.frame !== undefined) cancelAnimationFrame(call.frame);
      await call.context?.close(); call.context = undefined;
      delete this.value.error; this.applyMute(call); this.meter(call); this.publish();
    })().finally(() => { if (call.refreshingInput === refreshing) call.refreshingInput = undefined; });
    call.refreshingInput = refreshing; return refreshing;
  }
  private inputFailure(call: Call, failure: Error): void { if (!this.current(call)) return; this.value.error = failure.message; this.publish(); this.options.error(failure); }
  private refreshInput(call: Call): Promise<void> {
    if (!this.current(call) || !call.sender) return Promise.resolve();
    if (call.refreshingInput) return call.refreshingInput;
    const refreshing = (async () => {
      const stream = await (this.options.media?.() ?? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
      const track = stream.getAudioTracks()[0]; stream.getTracks().forEach(track => { track.enabled = false; });
      if (!this.current(call)) { stream.getTracks().forEach(track => track.stop()); return; }
      if (!track) { stream.getTracks().forEach(track => track.stop()); throw new Error('The microphone is unavailable'); }
      try { await call.sender!.replaceTrack(track); } catch (failure) { stream.getTracks().forEach(track => track.stop()); throw failure; }
      if (!this.current(call)) { stream.getTracks().forEach(track => track.stop()); return; }
      const previous = call.stream; call.stream = stream; track.onended = () => { void this.refreshInput(call).catch(failure => this.inputFailure(call, error(failure))); };
      previous?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      if (call.frame !== undefined) cancelAnimationFrame(call.frame); await call.context?.close(); call.context = undefined;
      delete this.value.error; this.applyMute(call); this.meter(call); this.publish();
    })().finally(() => { if (call.refreshingInput === refreshing) call.refreshingInput = undefined; });
    call.refreshingInput = refreshing; return refreshing;
  }
  private meter(call: Call): void {
    if (!call.stream || typeof AudioContext === 'undefined' || !this.options.level) return;
    const context = new AudioContext(), analyser = context.createAnalyser(); call.context = context; analyser.fftSize = 256; context.createMediaStreamSource(call.stream).connect(analyser);
    const bytes = new Uint8Array(analyser.fftSize);
    const frame = () => {
      if (!this.current(call)) return;
      analyser.getByteTimeDomainData(bytes); let square = 0; for (const byte of bytes) square += ((byte - 128) / 128) ** 2;
      this.options.level?.(this.value.microphoneMuted ? 0 : Math.sqrt(square / bytes.length)); call.frame = requestAnimationFrame(frame);
    }; frame();
  }
  private outputMeter(call: Call, stream: MediaStream): void {
    if (typeof AudioContext === 'undefined' || !this.options.outputLevel) return;
    if (call.outputFrame !== undefined) cancelAnimationFrame(call.outputFrame);
    void call.outputContext?.close();
    const context = new AudioContext(), analyser = context.createAnalyser(); call.outputContext = context;
    analyser.fftSize = 256; context.createMediaStreamSource(stream).connect(analyser);
    const bytes = new Uint8Array(analyser.fftSize), frequencies = new Uint8Array(analyser.frequencyBinCount);
    const frame = () => {
      if (!this.current(call)) return;
      analyser.getByteTimeDomainData(bytes); let square = 0;
      for (const byte of bytes) square += ((byte - 128) / 128) ** 2;
      const overall = this.value.speakerMuted ? 0 : Math.sqrt(square / bytes.length);
      this.options.outputLevel?.(overall);
      if (this.options.outputBands) {
        analyser.getByteFrequencyData(frequencies);
        const band = (from: number, to: number) => { let sum = 0, count = 0; for (let index = from; index < Math.min(to, frequencies.length); index++) { sum += frequencies[index]! / 255; count++; } return this.value.speakerMuted ? 0 : count ? sum / count : 0; };
        this.options.outputBands([band(1, 3), band(3, 12), band(12, frequencies.length), overall]);
      }
      call.outputFrame = requestAnimationFrame(frame);
    }; frame();
  }
  private transcript(item: PetVoiceTranscript, authoritative = false, engineOwned = false): boolean {
    const index = this.value.transcript.findIndex(previous => previous.id === item.id), previous = this.value.transcript[index];
    if (this.finalizedTranscriptIds.has(item.id) && (!item.final || !previous)) return false;
    if (!authoritative && this.authoritativeTranscriptIds.has(item.id)) return false;
    if (authoritative && !item.final && previous && !engineOwned && !item.text.startsWith(previous.text)) return false;
    if (item.final) this.finalizedTranscriptIds.add(item.id);
    if (authoritative && item.final) this.authoritativeTranscriptIds.add(item.id);
    const merged = { ...previous, ...item };
    if (previous && previous.role === merged.role && previous.text === merged.text && previous.final === merged.final && previous.responseId === merged.responseId && previous.turnId === merged.turnId) return false;
    if (index < 0) this.value.transcript.push(merged); else this.value.transcript[index] = merged;
    if (this.value.transcript.length > 300) this.value.transcript.splice(0, this.value.transcript.length - 300);
    return true;
  }
  private receive(call: Call, event: Record<string, unknown>): void {
    if (!this.owned(call) || this.value.transcriptSource === 'engine') return;
    const type = text(event.type), response = object(event.response), item = object(event.item);
    const previousActivity = this.value.activity, previousResponse = this.value.responseId, previousError = this.value.error;
    let changed = false;
    if (type === 'input_audio_buffer.speech_started') this.value.activity = 'listening';
    else if (type === 'input_audio_buffer.speech_stopped') this.value.activity = 'recognizing';
    else if (type === 'response.created') { this.value.activity = 'thinking'; this.value.responseId = text(response.id); }
    else if (['response.audio.delta', 'response.output_audio.delta'].includes(type)) this.value.activity = 'speaking';
    else if (type === 'response.done') this.value.activity = this.value.microphoneMuted ? 'muted' : 'listening';
    const userDelta = type === 'conversation.item.input_audio_transcription.delta', userFinal = type === 'conversation.item.input_audio_transcription.completed';
    const assistantDelta = ['response.audio_transcript.delta', 'response.output_audio_transcript.delta', 'response.text.delta', 'response.output_text.delta'].includes(type);
    const assistantFinal = ['response.audio_transcript.done', 'response.output_audio_transcript.done', 'response.text.done', 'response.output_text.done'].includes(type);
    if (userDelta || userFinal || assistantDelta || assistantFinal) {
      const id = text(event.item_id) || text(item.id) || text(event.response_id) || this.value.responseId || '';
      if (id) { const previous = this.value.transcript.find(row => row.id === id), final = userFinal || assistantFinal; const content = final ? text(event.transcript) || text(event.text) || previous?.text || '' : (previous?.text ?? '') + text(event.delta); changed = this.transcript({ id, role: userDelta || userFinal ? 'user' : 'assistant', text: content, final, ...(text(event.response_id) ? { responseId: text(event.response_id) } : {}) }); }
      if (assistantDelta && changed) this.value.activity = 'speaking';
    }
    if (type === 'error') { const failure = object(event.error); if (failure.code !== 'response_cancel_not_active') this.value.error = text(failure.message) || 'The voice source reported an error'; }
    if (this.draining === call) this.value.activity = 'inactive';
    if (changed || previousActivity !== this.value.activity || previousResponse !== this.value.responseId || previousError !== this.value.error) this.publish();
  }
  async microphone(muted: boolean): Promise<PetLiveVoiceState> {
    const call = this.call; if (!call || call.generation === undefined) throw new Error('No realtime voice session is active');
    const previous = this.value.microphoneMuted; this.value.microphoneMuted = muted; this.applyMute(call); this.publish();
    try { const state = await this.options.transport.control({ requestId: call.requestId, generation: call.generation, action: 'microphone', muted }); if (this.current(call)) this.applyState(state); }
    catch (failure) { if (this.current(call)) { this.value.microphoneMuted = previous; this.applyMute(call); this.publish(); } throw failure; }
    return this.snapshot();
  }
  async speaker(muted: boolean): Promise<PetLiveVoiceState> {
    const call = this.call; if (!call || call.generation === undefined) throw new Error('No realtime voice session is active');
    const previous = this.value.speakerMuted; this.value.speakerMuted = muted; this.applyMute(call); this.publish();
    try { const state = await this.options.transport.control({ requestId: call.requestId, generation: call.generation, action: 'speaker', muted }); if (this.current(call)) this.applyState(state); }
    catch (failure) { if (this.current(call)) { this.value.speakerMuted = previous; this.applyMute(call); this.publish(); } throw failure; }
    return this.snapshot();
  }
  async interrupt(): Promise<void> {
    const call = this.call; if (!call || call.generation === undefined) return;
    if (this.value.protocol !== 'public' && this.value.protocol !== 'qoder' && !this.value.canInterrupt) return;
    if (this.value.protocol === 'public' && call.channel?.readyState === 'open') call.channel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
    if (this.value.protocol === 'qoder') this.flushPlayback(call);
    await this.options.transport.control({ requestId: call.requestId, generation: call.generation, action: 'interrupt' });
  }
  private release(call: Call): void {
    if (call.disposed) return; call.disposed = true;
    call.detachDevices?.(); call.detachDevices = undefined;
    clearTimeout(call.timer); clearTimeout(call.disconnectTimer); if (call.frame !== undefined) cancelAnimationFrame(call.frame);
    if (call.outputFrame !== undefined) cancelAnimationFrame(call.outputFrame);
    void call.outputContext?.close(); this.options.outputLevel?.(0);
    if (call.captureNode) { call.captureNode.port.onmessage = null; try { call.captureNode.disconnect(); } catch { /* already detached */ } call.captureNode = undefined; }
    call.captureSource?.disconnect(); call.captureSource = undefined;
    call.captureSink?.disconnect(); call.captureSink = undefined;
    void call.capture?.close(); call.capture = undefined;
    for (const source of call.playbackSources ?? []) { try { source.onended = null; source.stop(); } catch { /* the source already finished */ } }
    call.playbackSources?.clear();
    call.playbackGain?.disconnect(); call.playbackGain = undefined;
    call.playbackAnalyser?.disconnect(); call.playbackAnalyser = undefined;
    void call.playback?.close(); call.playback = undefined;
    if (call.channel) { call.channel.onopen = null; call.channel.onclose = null; call.channel.onerror = null; call.channel.onmessage = null; call.channel.close(); }
    if (call.peer) { call.peer.ontrack = null; call.peer.onconnectionstatechange = null; call.peer.close(); }
    if (call.output) { call.output.pause(); call.output.srcObject = null; call.output.removeAttribute('src'); }
    call.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); void call.context?.close(); this.options.level?.(0);
  }
  private fail(call: Call, failure: Error): void { if (!this.current(call)) return; void this.stop(true).catch(() => {}).then(() => { this.value.error = failure.message; this.publish(); this.options.error(failure); }); }
  stop(terminate = false): Promise<PetLiveVoiceState> {
    if (this.stopping) { if (terminate && this.draining) this.release(this.draining); return this.stopping; }
    this.starting = undefined;
    const call = this.call;
    const request = call ? { requestId: call.requestId, ...(call.generation !== undefined ? { generation: call.generation } : {}) } : this.pendingEnd;
    if (!request) { this.revision++; return Promise.resolve(this.snapshot()); }
    const previousPhase = this.value.phase, previousActivity = this.value.activity;
    let resumed = false;
    this.pendingEnd = request; this.call = undefined; this.revision++; this.draining = call; this.value.phase = 'stopping'; this.value.activity = 'inactive'; delete this.value.error;
    if (call) {
      call.stream?.getAudioTracks().forEach(track => { track.enabled = false; }); if (call.output) call.output.muted = true;
      if (call.playbackGain) call.playbackGain.gain.value = 0;
      this.flushPlayback(call);
      clearTimeout(call.timer); clearTimeout(call.disconnectTimer);
      if (terminate) this.release(call);
    }
    this.publish();
    let timer: ReturnType<typeof setTimeout>;
    const ended = Promise.resolve().then(() => this.options.transport.end(request));
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The voice session did not finish closing')), 10_000); });
    const stopping = Promise.race([ended, deadline]).then(state => {
      if (state.phase !== 'inactive') throw new Error(state.error || 'The voice session did not finish closing');
      if (this.pendingEnd === request) this.pendingEnd = undefined;
      if (!this.call) this.applyState(state); return this.snapshot();
    }).catch(failure => {
      if (this.options.resumeOnStopFailure && !terminate && call?.released && !call.disposed) {
        resumed = true; this.call = call; call.revision = this.revision; this.pendingEnd = undefined;
        this.value.phase = 'active'; this.value.activity = previousPhase === 'active' ? previousActivity : this.value.microphoneMuted ? 'muted' : 'listening'; this.applyMute(call);
      } else this.value.phase = 'stopping';
      this.value.error = error(failure).message; this.publish(); throw failure;
    }).finally(() => { clearTimeout(timer); if (call && !resumed) this.release(call); if (this.draining === call) this.draining = undefined; if (this.stopping === stopping) this.stopping = undefined; });
    this.stopping = stopping; return stopping;
  }
  async dispose(): Promise<void> { if (this.disposed) return; try { await this.stop(true); } finally { this.disposed = true; } }
}
