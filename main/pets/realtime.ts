import type { PetLiveVoiceState, PetRealtimeAnswer, PetRealtimeAudioFrame, PetRealtimeControl, PetRealtimeOffer, PetRealtimeOptions, PetRealtimeProtocol, PetTranscriptSource, PetVoiceEvent, PetVoiceTranscript } from '../../contracts/desktop-pet-voice';
import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../ipc/registry';
import { setTimeout as delay } from 'node:timers/promises';

export type PetRealtimeAvailability = Pick<PetRealtimeOptions, 'available' | 'reason'> & Partial<PetRealtimeOptions> & { voice?: string };
export interface PreparedPetRealtime {
  sessionId: string; engineId: string; modelProviderId?: string; authMode?: string;
  protocol?: PetRealtimeProtocol; transcriptSource?: PetTranscriptSource; voice?: string;
}
export interface PetRealtimeDependencies {
  owns(ownerId: number): boolean;
  visible(ownerId: number): boolean;
  beforeStart?(ownerId: number): void;
  resumeOnStopFailure?: boolean;
  availability(ownerId: number, sessionId?: string): Promise<PetRealtimeAvailability>;
  prepare(ownerId: number, targetSessionId: string | undefined, signal: AbortSignal, availability: PetRealtimeAvailability): Promise<PreparedPetRealtime>;
  request(method: string, params: Record<string, Json>, signal?: AbortSignal): Promise<Json>;
  emit(ownerId: number, event: PetVoiceEvent): void;
  log?(message: string): void;
}
interface Call {
  ownerId: number; requestId: string; generation: number; abort: AbortController;
  offerSignature: string;
  finalTranscriptIds: Set<string>;
  tasks: Map<string, { turnId: string; owned: boolean }>;
  sessionId?: string; engineId?: string; ready: boolean; engineReady: boolean; websocket: boolean; starting?: Promise<PetRealtimeAnswer>;
}
const channels = ['desktop-pet:realtime-state', 'desktop-pet:negotiate-realtime', 'desktop-pet:end-realtime', 'desktop-pet:realtime-control', 'desktop-pet:realtime-audio'] as const;
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function failure(value: unknown): string { return value instanceof Error ? value.message : String(value); }

/** Window-owned audio lifecycle; the engine owns transport, transcripts and task delegation. */
export class DesktopPetRealtime {
  private value: PetLiveVoiceState = { transport: 'webrtc', available: false, phase: 'inactive', generation: 0, microphoneMuted: false, speakerMuted: false, activity: 'inactive', transcript: [] };
  private call: Call | undefined;
  private lastOwner: number | undefined;
  private stopping: Promise<void> | undefined;
  private availabilityRevision = 0;
  private closed = false;
  constructor(private readonly deps: PetRealtimeDependencies) {}
  snapshot(): PetLiveVoiceState { return structuredClone(this.value); }
  reserved(): boolean { return this.value.phase !== 'inactive'; }
  private owner(id: number, visible = true): void {
    if (this.closed || !this.deps.owns(id) || visible && !this.deps.visible(id) || this.call && this.call.ownerId !== id) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'The caller does not own this voice session');
  }
  private current(call: Call): void {
    this.owner(call.ownerId);
    if (this.call !== call || call.abort.signal.aborted) throw new IpcHandlerError('VOICE_EXPIRED', 'The realtime call changed');
  }
  private publish(): void {
    if (this.lastOwner !== undefined && this.deps.owns(this.lastOwner)) this.deps.emit(this.lastOwner, { type: 'state', generation: this.value.generation, state: this.snapshot() });
  }
  private applyAvailability(value: PetRealtimeAvailability): void {
    this.value.available = value.available; this.value.unavailableReason = value.reason;
    this.value.sourceId = value.sourceId; this.value.protocol = value.protocol;
    this.value.transport = value.protocol === 'qoder' ? 'websocket' : 'webrtc';
    this.value.transcriptSource = value.transcriptSource; this.value.voices = value.voices;
    this.value.defaultVoice = value.defaultVoice; this.value.voice = value.voice;
    this.value.targetSessionId = value.targetSessionId;
  }
  async state(ownerId: number, sessionId?: string): Promise<PetLiveVoiceState> {
    this.owner(ownerId, false);
    this.lastOwner = ownerId;
    if (!this.call) {
      const revision = ++this.availabilityRevision;
      const availability = await this.deps.availability(ownerId, sessionId); this.owner(ownerId, false);
      if (!this.call && revision === this.availabilityRevision) this.applyAvailability(availability);
    }
    return this.snapshot();
  }
  async refreshAvailability(): Promise<void> {
    if (this.lastOwner === undefined || !this.deps.owns(this.lastOwner) || this.closed) return;
    await this.state(this.lastOwner); this.publish();
  }
  negotiate(ownerId: number, offer: PetRealtimeOffer): Promise<PetRealtimeAnswer> {
    this.owner(ownerId);
    if (!offer || !/^[\w-]{1,128}$/u.test(offer.requestId) || offer.offerSdp !== undefined && (typeof offer.offerSdp !== 'string' || offer.offerSdp.length > 128 * 1024 || !offer.offerSdp.startsWith('v=0')) || offer.targetSessionId !== undefined && (typeof offer.targetSessionId !== 'string' || !offer.targetSessionId || offer.targetSessionId.length > 512) || typeof offer.microphoneMuted !== 'boolean' || typeof offer.speakerMuted !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'Invalid realtime offer');
    if (this.call) {
      if (this.call.requestId === offer.requestId && this.call.offerSignature === JSON.stringify(offer) && this.call.starting) return this.call.starting;
      throw new IpcHandlerError('VOICE_BUSY', 'A realtime call is already active');
    }
    this.deps.beforeStart?.(ownerId);
    const call: Call = { ownerId, requestId: offer.requestId, offerSignature: JSON.stringify(offer), generation: this.value.generation + 1, abort: new AbortController(), finalTranscriptIds: new Set(), tasks: new Map(), ready: false, engineReady: false, websocket: false };
    this.call = call; this.lastOwner = ownerId; this.availabilityRevision++;
    this.value = { ...this.value, transport: this.value.transport ?? 'webrtc', generation: call.generation, phase: 'connecting', microphoneMuted: offer.microphoneMuted, speakerMuted: offer.speakerMuted, activity: 'inactive', canInterrupt: false, transcript: [] }; delete this.value.error; this.publish();
    const starting = this.begin(call, offer); call.starting = starting; return starting;
  }
  private async begin(call: Call, offer: PetRealtimeOffer): Promise<PetRealtimeAnswer> {
    try {
      await this.stopping; this.current(call);
      const availability = await this.deps.availability(call.ownerId, offer.targetSessionId); this.current(call);
      this.applyAvailability(availability);
      if (!availability.available) { this.value.available = false; this.value.unavailableReason = availability.reason; throw new IpcHandlerError('REALTIME_UNAVAILABLE', availability.reason || 'The configured source does not support realtime voice'); }
      const prepared = await this.deps.prepare(call.ownerId, offer.targetSessionId, call.abort.signal, availability); this.current(call);
      call.sessionId = prepared.sessionId; call.engineId = prepared.engineId; this.value.sessionId = call.sessionId;
      const websocket = availability.protocol === 'qoder';
      call.websocket = websocket; this.value.transport = websocket ? 'websocket' : 'webrtc';
      if (!websocket && !offer.offerSdp) throw new IpcHandlerError('BAD_REQUEST', 'The selected realtime source requires a WebRTC offer');
      const result = object(await this.deps.request('session/realtimeStart', { sessionId: call.engineId, requestId: call.requestId, ...(websocket ? {} : { offerSdp: offer.offerSdp! }), flushTranscriptTailOnSessionEnd: true, ...(prepared.modelProviderId ? { modelProviderId: prepared.modelProviderId } : {}), ...(prepared.authMode ? { authMode: prepared.authMode } : {}), ...(prepared.protocol ? { protocol: prepared.protocol } : {}), ...(prepared.voice ? { voice: prepared.voice } : {}) }, call.abort.signal));
      if (this.call !== call || call.abort.signal.aborted) {
        await this.deps.request('session/realtimeStop', { sessionId: call.engineId, requestId: call.requestId }).catch(error => this.deps.log?.(failure(error)));
        throw new IpcHandlerError('VOICE_EXPIRED', 'The realtime call was cancelled during negotiation');
      }
      this.current(call);
      if (!text(result.callId) || !websocket && !text(result.answerSdp).startsWith('v=0')) throw new Error('The engine returned an invalid realtime answer');
      this.value.protocol = ['v1', 'frameless', 'public', 'qoder'].includes(text(result.protocol)) ? result.protocol as PetRealtimeProtocol : prepared.protocol ?? availability.protocol ?? 'public';
      this.value.transcriptSource = ['engine', 'peer'].includes(text(result.transcriptSource)) ? result.transcriptSource as PetTranscriptSource : prepared.transcriptSource ?? availability.transcriptSource ?? 'peer';
      call.ready = true; this.value.available = true; delete this.value.unavailableReason; this.publish();
      return { requestId: call.requestId, sessionId: call.sessionId!, ...(websocket ? {} : { answerSdp: text(result.answerSdp) }), generation: call.generation, protocol: this.value.protocol, transcriptSource: this.value.transcriptSource };
    } catch (error) {
      if (this.call === call) { this.value.error = failure(error); await this.stopInternal(call); }
      throw error;
    }
  }
  private active(ownerId: number, requestId: string, generation: number): Call {
    this.owner(ownerId);
    const call = this.call;
    if (!call || call.requestId !== requestId || call.generation !== generation || !call.ready) throw new IpcHandlerError('VOICE_EXPIRED', 'The realtime call generation changed');
    return call;
  }
  async control(ownerId: number, value: PetRealtimeControl): Promise<PetLiveVoiceState> {
    const call = this.active(ownerId, value.requestId, value.generation);
    if (value.action === 'connected') {
      try {
        const deadline = Date.now() + 15_000;
        while (!call.engineReady) {
          this.current(call);
          if (Date.now() >= deadline) throw new Error('The engine did not confirm the realtime task connection.');
          await delay(20, undefined, { signal: call.abort.signal });
        }
        this.current(call); this.value.phase = 'active'; this.value.activity = call.tasks.size ? 'thinking' : this.value.microphoneMuted ? 'muted' : 'listening';
      } catch (error) { if (this.call === call) { this.value.error = failure(error); await this.stopInternal(call); } throw error; }
    }
    else if (value.action === 'microphone' || value.action === 'speaker') {
      if (typeof value.muted !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'A mute state is required');
      if (value.action === 'microphone') { this.value.microphoneMuted = value.muted; this.value.activity = call.tasks.size ? 'thinking' : value.muted ? 'muted' : 'listening'; }
      else this.value.speakerMuted = value.muted;
    } else if (value.action === 'interrupt') {
      if (this.value.protocol !== 'public' && this.value.protocol !== 'qoder' && ![...call.tasks.values()].some(task => task.owned)) throw new IpcHandlerError('VOICE_TASK_UNAVAILABLE', 'No task owned by this voice call is available to stop');
      await this.deps.request('session/realtimeInterrupt', { sessionId: call.engineId!, requestId: call.requestId }); this.current(call);
    } else throw new IpcHandlerError('BAD_REQUEST', 'Unknown realtime control');
    this.publish(); return this.snapshot();
  }
  /** One encoded microphone frame from the window on an engine-mediated call. */
  async audio(ownerId: number, value: PetRealtimeAudioFrame): Promise<null> {
    const call = this.active(ownerId, value.requestId, value.generation);
    if (!call.websocket) throw new IpcHandlerError('BAD_REQUEST', 'The realtime transport does not accept window audio');
    if (typeof value.audio !== 'string' || !value.audio || value.audio.length > 256 * 1024) throw new IpcHandlerError('BAD_REQUEST', 'Invalid realtime audio frame');
    await this.deps.request('session/realtimeAppendAudio', { sessionId: call.engineId!, requestId: call.requestId, audioBase64: value.audio });
    return null;
  }
  private transcript(item: PetVoiceTranscript): boolean {
    const index = this.value.transcript.findIndex(previous => previous.id === item.id);
    if (index < 0 && this.call?.finalTranscriptIds.has(item.id)) return false;
    if (index >= 0 && this.value.transcript[index]!.final && !item.final) return false;
    if (index >= 0 && JSON.stringify(this.value.transcript[index]) === JSON.stringify(item)) return false;
    if (index < 0) this.value.transcript.push(item); else this.value.transcript[index] = item;
    if (item.final) this.call?.finalTranscriptIds.add(item.id);
    if (this.value.transcript.length > 300) this.value.transcript.splice(0, this.value.transcript.length - 300);
    return true;
  }
  observeEngine(event: ClientEvent): void {
    const call = this.call;
    if (!call) return;
    if (event.type === 'streamClosed') { this.value.error = 'The conversation engine disconnected'; void this.stopInternal(call).catch(error => this.deps.log?.(failure(error))); return; }
    if (event.type !== 'productEvent' || event.method !== 'session/realtimeEvent') return;
    const envelope = object(event.params);
    if (envelope.sessionId !== call.engineId || envelope.requestId !== call.requestId) return;
    const data = object(envelope.event), kind = text(data.type), item = object(data.item), previousActivity = this.value.activity, previousCanInterrupt = this.value.canInterrupt;
    if (kind === 'started') { call.engineReady = true; return; }
    let changed = false;
    if (kind === 'input_audio_buffer.speech_started') this.value.activity = 'listening';
    else if (kind === 'input_audio_buffer.speech_stopped') this.value.activity = 'recognizing';
    else if (kind === 'response.created') this.value.activity = 'thinking';
    else if (['response.audio.delta', 'response.output_audio.delta', 'conversation.output_audio.delta', 'output_audio.delta'].includes(kind)) this.value.activity = 'speaking';
    else if (kind === 'response.done') this.value.activity = call.tasks.size ? 'thinking' : this.value.microphoneMuted ? 'muted' : 'listening';
    if (call.websocket && kind === 'response.audio.delta') {
      const audio = text(data.delta);
      if (audio) this.deps.emit(call.ownerId, { type: 'audio', generation: call.generation, audio, ...(text(data.response_id) ? { responseId: text(data.response_id) } : {}) });
    }
    if (kind === 'task.queued' || kind === 'task.started') {
      const handoffId = text(data.handoffId), turnId = text(data.turnId);
      if (handoffId && turnId) { call.tasks.set(handoffId, { turnId, owned: data.owned === true }); this.value.activity = 'thinking'; }
    } else if (kind === 'task.superseded') {
      const handoffId = text(data.handoffId), turnId = text(data.turnId);
      if (handoffId && call.tasks.get(handoffId)?.turnId === turnId) {
        call.tasks.delete(handoffId);
        this.value.activity = call.tasks.size ? 'thinking' : this.value.microphoneMuted ? 'muted' : 'listening';
      }
    } else if (kind === 'task.event') {
      const handoffId = text(data.handoffId), turnId = text(data.turnId), task = object(data.event);
      if (handoffId && call.tasks.get(handoffId)?.turnId === turnId && (task.result !== undefined || task.error !== undefined)) {
        call.tasks.delete(handoffId);
        this.value.activity = call.tasks.size ? 'thinking' : this.value.microphoneMuted ? 'muted' : 'listening';
      }
    }
    this.value.canInterrupt = [...call.tasks.values()].some(task => task.owned);
    if (call.tasks.size && ['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped'].includes(kind)) this.value.activity = 'thinking';
    const userFinal = kind === 'conversation.item.input_audio_transcription.completed';
    const assistantFinal = ['response.audio_transcript.done', 'response.output_audio_transcript.done', 'response.text.done', 'response.output_text.done'].includes(kind);
    const userDelta = kind === 'conversation.item.input_audio_transcription.delta';
    const assistantDelta = ['response.audio_transcript.delta', 'response.output_audio_transcript.delta', 'response.text.delta', 'response.output_text.delta'].includes(kind);
    if (this.value.transcriptSource === 'engine' && (userDelta || assistantDelta)) {
      const id = text(data.item_id) || text(item.id), delta = text(data.delta);
      const previous = this.value.transcript.find(entry => entry.id === id);
      if (id && delta && !previous?.final) changed = this.transcript({ id, role: userDelta ? 'user' : 'assistant', text: (previous?.text ?? '') + delta, final: false });
    }
    if (userFinal || assistantFinal) {
      const id = text(data.item_id) || text(item.id), content = text(data.transcript) || text(data.text);
      if (id && content) changed = this.transcript({ id, role: userFinal ? 'user' : 'assistant', text: content, final: true });
    }
    if (kind === 'error') { const message = text(object(data.error).message) || 'The realtime source reported an error'; changed ||= this.value.error !== message; this.value.error = message; }
    if (kind === 'session.closed' || kind === 'closed') { void this.stopInternal(call).catch(error => this.deps.log?.(failure(error))); return; }
    if (changed || previousActivity !== this.value.activity || previousCanInterrupt !== this.value.canInterrupt) this.publish();
  }
  async action(ownerId: number, action: 'stop' | 'microphone' | 'speaker', muted = false): Promise<PetLiveVoiceState> {
    this.owner(ownerId, false);
    const call = this.call; if (!call) return this.state(ownerId);
    if (action === 'stop') return this.end(ownerId, { requestId: call.requestId, generation: call.generation });
    return this.control(ownerId, { requestId: call.requestId, generation: call.generation, action, muted });
  }
  async end(ownerId: number, value: { requestId: string; generation?: number }): Promise<PetLiveVoiceState> {
    this.owner(ownerId, false);
    const call = this.call;
    if (call && (value.requestId !== call.requestId || value.generation !== undefined && value.generation !== call.generation)) throw new IpcHandlerError('VOICE_EXPIRED', 'The realtime call generation changed');
    if (call) await this.stopInternal(call, true); else await this.stopping;
    return this.snapshot();
  }
  private stopInternal(call: Call, allowResume = false): Promise<void> {
    if (this.call !== call) return this.stopping ?? Promise.resolve();
    if (this.stopping) return this.stopping;
    const previousPhase = this.value.phase, previousActivity = this.value.activity;
    const resumable = allowResume && this.deps.resumeOnStopFailure && previousPhase === 'active';
    if (!resumable) call.abort.abort();
    this.value.phase = 'stopping'; this.value.activity = 'inactive'; this.publish();
    const stopping = (async () => {
      try {
        if (call.engineId) await this.deps.request('session/realtimeStop', { sessionId: call.engineId, requestId: call.requestId });
        if (this.call === call) { call.abort.abort(); this.call = undefined; this.value.phase = 'inactive'; this.value.generation = Math.max(this.value.generation, call.generation + 1); this.publish(); }
      } catch (error) {
        if (this.call === call) { if (resumable) { this.value.phase = previousPhase; this.value.activity = previousActivity; } this.value.error = 'The realtime call did not finish closing: ' + failure(error); this.publish(); }
        throw error;
      }
    })().finally(() => { if (this.stopping === stopping) this.stopping = undefined; });
    this.stopping = stopping; return stopping;
  }
  async release(ownerId: number): Promise<void> { const call = this.call; if (call?.ownerId === ownerId) await this.stopInternal(call); else await this.stopping; }
  async releaseSession(sessionId: string): Promise<void> { const call = this.call; if (call?.sessionId === sessionId) await this.stopInternal(call); }
  async close(): Promise<void> { if (this.closed) return; const call = this.call; if (call) await this.stopInternal(call); else await this.stopping; this.closed = true; }
}

export function registerPetRealtimeHandlers(registry: ChannelRegistry, realtime: DesktopPetRealtime): void {
  for (const channel of channels) registry.register(channel, async context => {
    const value = object(context.args[0]);
    switch (channel) {
      case 'desktop-pet:realtime-state': return await realtime.state(context.senderId) as unknown as Json;
      case 'desktop-pet:negotiate-realtime': return await realtime.negotiate(context.senderId, value as unknown as PetRealtimeOffer) as unknown as Json;
      case 'desktop-pet:end-realtime': return await realtime.end(context.senderId, value as unknown as { requestId: string; generation?: number }) as unknown as Json;
      case 'desktop-pet:realtime-control': return await realtime.control(context.senderId, value as unknown as PetRealtimeControl) as unknown as Json;
      case 'desktop-pet:realtime-audio': return await realtime.audio(context.senderId, value as unknown as PetRealtimeAudioFrame) as unknown as Json;
    }
  }, 'desktop-pet-realtime');
}
